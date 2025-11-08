import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import AutobaseKeyEscrowStore from './AutobaseKeyEscrowStore.mjs';
import AutobaseKeyEscrowPgStore from './AutobaseKeyEscrowPgStore.mjs';
import AutobaseKeyEscrowPolicyEngine from './AutobaseKeyEscrowPolicyEngine.mjs';
import AutobaseKeyEscrowAuditLog from './AutobaseKeyEscrowAuditLog.mjs';
import AutobaseKeyEscrowPgAuditLog from './AutobaseKeyEscrowPgAuditLog.mjs';
import AutobaseKeyEscrowPgLeaseHistory from './AutobaseKeyEscrowPgLeaseHistory.mjs';
import {
  openPayload,
  sealPayload,
  encodeKey,
  decodeKey,
  generateKeyPair,
  zeroize,
  hashSecret,
  withZeroizedBuffer
} from '../../../shared/escrow/AutobaseKeyEscrowCrypto.mjs';
import LeaseVault from '../../../shared/escrow/LeaseVault.mjs';

class AutobaseKeyEscrowService {
  constructor({ config, logger = console, dbPool = null, metrics = {} } = {}) {
    if (!config) throw new Error('AutobaseKeyEscrowService requires a config');
    if (!config.sharedSecret) {
      throw new Error('Escrow service requires a shared secret for request authentication');
    }
    this.config = config;
    this.logger = logger;
    this.dbPool = dbPool;
    this.useDbBackend = Boolean(dbPool && config?.db?.enabled);
    if (this.useDbBackend) {
      this.store = new AutobaseKeyEscrowPgStore({ pool: dbPool, logger });
      this.auditLog = new AutobaseKeyEscrowPgAuditLog({ pool: dbPool, logger });
      this.leaseHistory = new AutobaseKeyEscrowPgLeaseHistory({ pool: dbPool, logger });
    } else {
      this.store = new AutobaseKeyEscrowStore({
        persistPath: resolve(config.storageDir, 'escrow-records.json')
      });
      this.auditLog = new AutobaseKeyEscrowAuditLog({
        storageDir: config.auditDir,
        namespace: 'autobase-escrow-audit',
        logger
      });
      this.leaseHistory = null;
    }
    this.policyEngine = new AutobaseKeyEscrowPolicyEngine(config.policy, { logger });
    this.keyPair = null;
    this.leaseVault = new LeaseVault({
      logger,
      label: 'autobase-escrow-service'
    });
    this.cleanupTimer = null;
    this.metrics = {
      recordUnlock: metrics.recordUnlock || (() => {}),
      recordPolicyRejection: metrics.recordPolicyRejection || (() => {}),
      setActiveLeases: metrics.setActiveLeases || (() => {}),
      observeUnlockDuration: metrics.observeUnlockDuration || (() => {})
    };
  }

  async init() {
    await this.store.init();
    await this.auditLog.init();
    await this.leaseHistory?.init?.();
    await this.#ensureKeyPair();
    this.#startCleanup();
    this.#refreshActiveLeaseCount();
  }

  async stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.auditLog.close();
    this.leaseVault?.destroy?.('autobase-escrow-service-stop');
    this.metrics.setActiveLeases?.(0);
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
    return this.leaseVault.list().map((lease) => ({
      leaseId: lease.leaseId,
      relayKey: lease.relayKey,
      escrowId: lease.escrowId,
      requesterId: lease.requesterId,
      ownerPeerKey: lease.ownerPeerKey || lease.writerPackage?.ownerPeerKey || null,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      evidence: lease.evidence,
      reasons: lease.reasons || [],
      payloadDigest: lease.payloadDigest || lease.writerPackage?.writerKeyDigest || null
    }));
  }

  getLeaseByRelay(relayKey) {
    if (!relayKey) return null;
    return this.leaseVault.get(relayKey, { includeSecret: true });
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
    const record = await this.store.getByRelayKey(relayKey);
    if (!record) {
      throw new Error('escrow-record-not-found');
    }

    const stopTimer = this.#startUnlockTimer();
    try {
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
        this.metrics.recordPolicyRejection(evaluation.reasons || ['unknown']);
        this.metrics.recordUnlock('policy-rejection');
        const error = new Error(`unlock-rejected:${evaluation.reasons.join(',')}`);
        error.statusCode = 412;
        error.reasons = evaluation.reasons;
        throw error;
      }

      const writerPayload = await withZeroizedBuffer(
        () => this.#decryptPackage(record.encryptedPackage),
        (buffer) => {
          if (!buffer) {
            throw new Error('encrypted-writer-payload-empty');
          }
          return JSON.parse(Buffer.from(buffer).toString('utf8'));
        }
      );

      if (writerPayload?.relayKey && writerPayload.relayKey !== relayKey) {
        throw new Error('relay-mismatch');
      }

      const leaseId = `lease_${randomUUID()}`;
      const now = Date.now();
      const policy = this.policyEngine.getPolicyMetadata();
      const expiresAt = now + policy.leaseTtlMs;
      const payloadDigest = hashSecret(writerPayload.writerKey || writerPayload.secret || record.id);

      const sealedLease = sealPayload({
        payload: writerPayload,
        recipientPublicKey: sessionPublicKey,
        senderSecretKey: this.keyPair.secretKey,
        senderPublicKey: this.keyPair.publicKey
      });

      const ownerPeerKey = writerPayload.ownerPeerKey || null;
      const lease = {
        leaseId,
        escrowId: record.id,
        relayKey,
        requesterId: requesterId || null,
        issuedAt: now,
        expiresAt,
        evidence,
        reasons: evaluation.reasons || [],
        ownerPeerKey,
        payloadDigest,
        writerPackage: {
          ownerPeerKey,
          writerKeyDigest: payloadDigest
        }
      };
      const trackedLease = this.leaseVault.track(lease, { includeSecret: false });
      this.#refreshActiveLeaseCount();
      await this.#recordLeaseIssued(trackedLease || lease);

      if (writerPayload.writerKey) {
        writerPayload.writerKey = null;
      }
      if (writerPayload.secret) {
        writerPayload.secret = null;
      }

      await this.auditLog.append({
        type: 'unlock-issued',
        leaseId,
        escrowId: record.id,
        relayKey,
        requesterId,
        expiresAt,
        evidence
      });

      this.metrics.recordUnlock('success');

      return {
        leaseId,
        escrowId: record.id,
        relayKey,
        expiresAt,
        sealedLease
      };
    } catch (error) {
      if (error?.statusCode !== 412) {
        this.metrics.recordUnlock('error');
      }
      throw error;
    } finally {
      stopTimer();
    }
  }

  async revoke({
    relayKey,
    escrowId,
    actor = 'unknown',
    reason = 'unspecified'
  } = {}) {
    const record = escrowId
      ? await this.store.getById(escrowId)
      : await this.store.getByRelayKey(relayKey);
    if (!record) return false;
    if (record.revokedAt) return true;
    await this.store.update(record.id, {
      revokedAt: Date.now(),
      revokedBy: actor,
      revokedReason: reason
    });
    const released = this.leaseVault.releaseByEscrowId(record.id, `revoke:${reason}`);
    this.#refreshActiveLeaseCount();
    await this.#recordLeaseReleased(released, `revoke:${reason}`);
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
      try {
        const released = this.leaseVault.releaseExpired(Date.now());
        if (released?.length) {
          this.#refreshActiveLeaseCount();
          this.#recordLeaseReleased(released, 'expired').catch((error) => {
            this.logger?.warn?.('[EscrowService] Failed to record expired lease cleanup', {
              error: error?.message || error
            });
          });
        }
      } catch (error) {
        this.logger?.warn?.('[EscrowService] Lease cleanup failed', {
          error: error?.message || error
        });
      }
    }, 30_000).unref();
  }

  async #recordLeaseIssued(lease) {
    if (!this.leaseHistory || !lease) return;
    await this.leaseHistory.recordIssued({
      leaseId: lease.leaseId,
      escrowId: lease.escrowId,
      relayKey: lease.relayKey,
      requesterId: lease.requesterId,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      evidence: lease.evidence,
      reasons: lease.reasons,
      payloadDigest: lease.payloadDigest
    });
  }

  async #recordLeaseReleased(released = [], reason = null) {
    if (!this.leaseHistory || !Array.isArray(released) || !released.length) return;
    const releasedAt = Date.now();
    await Promise.allSettled(released.map((lease) => this.leaseHistory.recordReleased(lease.leaseId, {
      releasedAt: lease.releasedAt || releasedAt,
      reason
    })));
    await Promise.allSettled(released.map((lease) => this.auditLog.append({
      type: 'lease-released',
      leaseId: lease.leaseId,
      escrowId: lease.escrowId,
      relayKey: lease.relayKey,
      actor: 'lease-vault',
      metadata: {
        reason,
        releasedAt: lease.releasedAt || releasedAt
      }
    })));
  }

  #refreshActiveLeaseCount() {
    const count = this.leaseVault?.count?.()
      ?? (typeof this.leaseVault?.list === 'function' ? this.leaseVault.list().length : 0);
    this.metrics.setActiveLeases?.(count);
  }

  #startUnlockTimer() {
    const hasHrtime = typeof process?.hrtime?.bigint === 'function';
    if (hasHrtime) {
      const start = process.hrtime.bigint();
      return () => {
        const diff = Number(process.hrtime.bigint() - start) / 1e9;
        this.metrics.observeUnlockDuration?.(diff);
      };
    }
    const startMs = Date.now();
    return () => {
      const diff = (Date.now() - startMs) / 1000;
      this.metrics.observeUnlockDuration?.(diff);
    };
  }
}

export default AutobaseKeyEscrowService;
