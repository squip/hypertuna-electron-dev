import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import AutobaseKeyEscrowStore from './AutobaseKeyEscrowStore.mjs';
import AutobaseKeyEscrowPolicyEngine from './AutobaseKeyEscrowPolicyEngine.mjs';
import AutobaseKeyEscrowAuditLog from './AutobaseKeyEscrowAuditLog.mjs';
import {
  openPayload,
  sealPayload,
  encodeKey,
  decodeKey,
  generateKeyPair,
  zeroize,
  hashSecret
} from '../../../shared/escrow/AutobaseKeyEscrowCrypto.mjs';

class AutobaseKeyEscrowService {
  constructor({ config, logger = console } = {}) {
    if (!config) throw new Error('AutobaseKeyEscrowService requires a config');
    if (!config.sharedSecret) {
      throw new Error('Escrow service requires a shared secret for request authentication');
    }
    this.config = config;
    this.logger = logger;
    this.store = new AutobaseKeyEscrowStore({
      persistPath: resolve(config.storageDir, 'escrow-records.json')
    });
    this.policyEngine = new AutobaseKeyEscrowPolicyEngine(config.policy, { logger });
    this.auditLog = new AutobaseKeyEscrowAuditLog({
      storageDir: config.auditDir,
      namespace: 'autobase-escrow-audit',
      logger
    });
    this.keyPair = null;
    this.leases = new Map();
    this.cleanupTimer = null;
  }

  async init() {
    await this.store.init();
    await this.auditLog.init();
    await this.#ensureKeyPair();
    this.#startCleanup();
  }

  async stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.auditLog.close();
    this.leases.clear();
  }

  getSharedSecret() {
    return this.config.sharedSecret;
  }

  getPolicySnapshot() {
    const policy = this.policyEngine.getPolicyMetadata();
    return {
      policy,
      publicKey: encodeKey(this.keyPair?.publicKey),
      leaseTtlMs: policy.leaseTtlMs,
      depositTtlMs: policy.maxDepositTtlMs
    };
  }

  listLeases() {
    return Array.from(this.leases.values()).map((lease) => ({
      leaseId: lease.leaseId,
      relayKey: lease.relayKey,
      escrowId: lease.escrowId,
      requesterId: lease.requesterId,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      evidence: lease.evidence,
      reasons: lease.reasons || []
    }));
  }

  getLeaseByRelay(relayKey) {
    if (!relayKey) return null;
    for (const lease of this.leases.values()) {
      if (lease.relayKey === relayKey) return lease;
    }
    return null;
  }

  async createDeposit({
    relayKey,
    ownerPeerKey,
    encryptedPackage,
    policyVersion,
    unlockConditions,
    expiresAt,
    metadata = {}
  } = {}) {
    if (!relayKey || !ownerPeerKey) {
      throw new Error('relayKey and ownerPeerKey are required for escrow deposits');
    }
    if (!encryptedPackage?.cipherText || !encryptedPackage?.nonce || !encryptedPackage?.publicKey) {
      throw new Error('Encrypted package missing required fields');
    }

    const now = Date.now();
    const policy = this.policyEngine.getPolicyMetadata();
    const maxExpiry = now + (policy.maxDepositTtlMs || 24 * 60 * 60 * 1000);
    const normalizedExpires = Math.min(
      Number(expiresAt) || maxExpiry,
      maxExpiry
    );
    const escrowId = `escrow_${randomUUID()}`;

    const record = {
      id: escrowId,
      relayKey,
      ownerPeerKey,
      metadata: {
        ...metadata,
        unlockConditions: unlockConditions || null
      },
      encryptedPackage,
      policyVersion: policyVersion || policy.version,
      createdAt: now,
      expiresAt: normalizedExpires,
      updatedAt: now,
      revokedAt: null
    };

    await this.store.put(record);
    await this.auditLog.append({
      type: 'deposit',
      escrowId,
      relayKey,
      ownerPeerKey,
      metadata: record.metadata
    });

    this.logger?.info?.('[EscrowService] Deposit recorded', {
      relayKey,
      escrowId,
      expiresAt: normalizedExpires
    });

    return {
      escrowId,
      relayKey,
      expiresAt: normalizedExpires,
      leaseTtlMs: policy.leaseTtlMs,
      policyVersion: record.policyVersion
    };
  }

  async unlock({
    relayKey,
    requesterId,
    sessionPublicKey,
    evidence = {}
  } = {}) {
    if (!relayKey || !sessionPublicKey) {
      throw new Error('relayKey and sessionPublicKey are required to request unlock');
    }
    const record = this.store.getByRelayKey(relayKey);
    if (!record) {
      throw new Error('escrow-record-not-found');
    }

    const evaluation = this.policyEngine.evaluateUnlock(record, evidence);
    if (!evaluation.allow) {
      await this.auditLog.append({
        type: 'unlock-rejected',
        relayKey,
        escrowId: record.id,
        requesterId,
        evidence,
        reasons: evaluation.reasons
      });
      const error = new Error(`unlock-rejected:${evaluation.reasons.join(',')}`);
      error.statusCode = 412;
      error.reasons = evaluation.reasons;
      throw error;
    }

    const decrypted = this.#decryptPackage(record.encryptedPackage);
    let writerPayload = null;
    try {
      writerPayload = JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
      zeroize(decrypted);
      throw new Error('encrypted-writer-payload-invalid');
    } finally {
      zeroize(decrypted);
    }

    if (writerPayload?.relayKey && writerPayload.relayKey !== relayKey) {
      throw new Error('relay-mismatch');
    }

    const leaseId = `lease_${randomUUID()}`;
    const now = Date.now();
    const policy = this.policyEngine.getPolicyMetadata();
    const expiresAt = now + policy.leaseTtlMs;

    const sealedLease = sealPayload({
      payload: writerPayload,
      recipientPublicKey: sessionPublicKey,
      senderSecretKey: this.keyPair.secretKey,
      senderPublicKey: this.keyPair.publicKey
    });

    const lease = {
      leaseId,
      escrowId: record.id,
      relayKey,
      requesterId: requesterId || null,
      issuedAt: now,
      expiresAt,
      evidence,
      reasons: evaluation.reasons || [],
      payloadDigest: hashSecret(writerPayload.writerKey || writerPayload.secret || record.id)
    };
    this.leases.set(leaseId, lease);

    await this.auditLog.append({
      type: 'unlock-issued',
      leaseId,
      escrowId: record.id,
      relayKey,
      requesterId,
      expiresAt,
      evidence
    });

    return {
      leaseId,
      escrowId: record.id,
      relayKey,
      expiresAt,
      sealedLease
    };
  }

  async revoke({
    relayKey,
    escrowId,
    actor = 'unknown',
    reason = 'unspecified'
  } = {}) {
    const record = escrowId
      ? this.store.getById(escrowId)
      : this.store.getByRelayKey(relayKey);
    if (!record) return false;
    if (record.revokedAt) return true;
    await this.store.update(record.id, {
      revokedAt: Date.now(),
      revokedBy: actor,
      revokedReason: reason
    });
    for (const lease of this.leases.values()) {
      if (lease.escrowId === record.id) {
        this.leases.delete(lease.leaseId);
      }
    }
    await this.auditLog.append({
      type: 'deposit-revoked',
      escrowId: record.id,
      relayKey: record.relayKey,
      actor,
      reason
    });
    this.logger?.info?.('[EscrowService] Deposit revoked', {
      relayKey: record.relayKey,
      escrowId: record.id,
      reason
    });
    return true;
  }

  #decryptPackage(encryptedPackage) {
    return openPayload({
      cipherText: encryptedPackage.cipherText,
      nonce: encryptedPackage.nonce,
      senderPublicKey: encryptedPackage.publicKey,
      recipientSecretKey: this.keyPair.secretKey
    });
  }

  async #ensureKeyPair() {
    if (this.keyPair?.publicKey && this.keyPair?.secretKey) return;
    const keyPath = resolve(this.config.keyPath);
    try {
      const data = await readFile(keyPath, 'utf8');
      const parsed = JSON.parse(data);
      if (!parsed.publicKey || !parsed.secretKey) {
        throw new Error('stored keypair missing fields');
      }
      this.keyPair = {
        publicKey: decodeKey(parsed.publicKey),
        secretKey: decodeKey(parsed.secretKey)
      };
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn?.('[EscrowService] Failed to read escrow keypair; generating new one', {
          error: error?.message || error
        });
      }
    }

    const pair = generateKeyPair();
    this.keyPair = {
      publicKey: decodeKey(encodeKey(pair.publicKey)),
      secretKey: decodeKey(encodeKey(pair.secretKey))
    };
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, JSON.stringify({
      publicKey: encodeKey(pair.publicKey),
      secretKey: encodeKey(pair.secretKey)
    }, null, 2));
    this.logger?.info?.('[EscrowService] Generated new keypair and persisted to disk', {
      path: keyPath
    });
  }

  #startCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [leaseId, lease] of this.leases.entries()) {
        if (lease.expiresAt && lease.expiresAt < now) {
          this.leases.delete(leaseId);
        }
      }
    }, 30_000).unref();
  }
}

export default AutobaseKeyEscrowService;
