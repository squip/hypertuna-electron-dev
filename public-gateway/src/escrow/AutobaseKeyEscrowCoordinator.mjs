import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import AutobaseKeyEscrowClient from '../../../shared/escrow/AutobaseKeyEscrowClient.mjs';
import LeaseVault from '../../../shared/escrow/LeaseVault.mjs';
import {
  generateKeyPair,
  encodeKey,
  openPayload,
  zeroize,
  withZeroizedBuffer,
  toSecureBuffer,
  hashSecret
} from '../../../shared/escrow/AutobaseKeyEscrowCrypto.mjs';

class AutobaseKeyEscrowCoordinator extends EventEmitter {
  constructor({ config = {}, logger = console, metrics = {}, replicaManager = null } = {}) {
    super();
    this.config = config;
    this.logger = logger;
    this.metrics = {
      recordUnlock: metrics.recordUnlock || (() => {}),
      setLeaseState: metrics.setLeaseState || (() => {}),
      recordPolicyRejection: metrics.recordPolicyRejection || (() => {})
    };
    this.replicaManager = replicaManager;
    this.client = null;
    this.leaseVault = new LeaseVault({
      logger,
      label: 'public-gateway-coordinator'
    });
  }

  isEnabled() {
    return Boolean(this.config?.enabled && this.config?.baseUrl && this.config?.sharedSecret);
  }

  async initialize() {
    if (!this.isEnabled()) {
      this.logger?.info?.('[EscrowCoordinator] Disabled (missing configuration)');
      return;
    }
    const tls = await this.#loadTlsMaterials();
    this.client = new AutobaseKeyEscrowClient({
      baseUrl: this.config.baseUrl,
      sharedSecret: this.config.sharedSecret,
      clientId: this.config.clientId || 'public-gateway',
      fetchImpl: globalThis.fetch?.bind(globalThis),
      tls
    });
    this.logger?.info?.('[EscrowCoordinator] Initialized', {
      escrowBaseUrl: this.config.baseUrl
    });
  }

  async stop() {
    this.leaseVault?.destroy?.('escrow-coordinator-stop');
  }

  setReplicaManager(replicaManager) {
    this.replicaManager = replicaManager;
  }

  getLeaseSummaries() {
    return this.leaseVault.list().map((lease) => ({
      relayKey: lease.relayKey,
      leaseId: lease.leaseId,
      escrowId: lease.escrowId,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      ownerPeerKey: lease.ownerPeerKey || lease.writerPackage?.ownerPeerKey || null,
      payloadDigest: lease.payloadDigest || lease.writerPackage?.writerKeyDigest || null
    }));
  }

  getLease(relayKey) {
    return this.leaseVault.get(relayKey, { includeSecret: true });
  }

  async requestLease({ relayKey, evidence = {}, requesterId = 'public-gateway' } = {}) {
    if (!this.client || !this.isEnabled()) {
      throw new Error('escrow-disabled');
    }
    if (!relayKey) {
      throw new Error('relayKey-required');
    }

    const sessionPair = generateKeyPair();
    const sessionPublicKey = encodeKey(sessionPair.publicKey);

    let response;
    try {
      response = await this.client.unlock({
        relayKey,
        requesterId,
        sessionPublicKey,
        evidence
      });
    } catch (error) {
      if (error?.statusCode === 412) {
        this.metrics.recordPolicyRejection(error?.reasons || ['unknown']);
        this.metrics.recordUnlock('policy-rejection');
      } else {
        this.metrics.recordUnlock('error');
      }
      throw error;
    }

    const writerPackage = await withZeroizedBuffer(
      () => openPayload({
        cipherText: response.sealedLease?.cipherText,
        nonce: response.sealedLease?.nonce,
        senderPublicKey: response.sealedLease?.publicKey,
        recipientSecretKey: sessionPair.secretKey
      }),
      (buffer) => {
        if (!buffer) {
          throw new Error('lease-payload-empty');
        }
        return JSON.parse(Buffer.from(buffer).toString('utf8'));
      }
    );
    zeroize(sessionPair.secretKey);

    if (!writerPackage || typeof writerPackage !== 'object') {
      throw new Error('lease-payload-invalid');
    }

    if (writerPackage?.relayKey && writerPackage.relayKey !== relayKey) {
      throw new Error('relay-mismatch');
    }

    const writerKeyBuffer = toSecureBuffer(writerPackage.writerKey || writerPackage.secret, { encodings: ['hex'] });
    if (!writerKeyBuffer) {
      throw new Error('writer-key-missing');
    }
    writerPackage.writerKey = writerKeyBuffer;
    writerPackage.writerKeyDigest = writerPackage.writerKeyDigest || hashSecret(writerKeyBuffer);

    const lease = {
      relayKey,
      leaseId: response.leaseId,
      escrowId: response.escrowId,
      issuedAt: Date.now(),
      expiresAt: response.expiresAt || null,
      writerPackage,
      evidence
    };

    const trackedLease = this.#trackLease(relayKey, lease);
    this.metrics.recordUnlock('success');
    this.emit('lease-issued', trackedLease);
    return {
      relayKey,
      leaseId: trackedLease?.leaseId,
      escrowId: trackedLease?.escrowId,
      expiresAt: trackedLease?.expiresAt
    };
  }

  releaseLease(relayKey, reason = 'manual-release') {
    const released = this.leaseVault.release(relayKey, reason);
    if (!released) return false;
    this.metrics.setLeaseState(relayKey, false);
    this.replicaManager?.setWriterLeaseState?.(
      relayKey,
      released.ownerPeerKey || released.writerPackage?.ownerPeerKey || null,
      null
    );
    this.emit('lease-released', { relayKey, leaseId: released.leaseId, reason });
    return true;
  }

  #trackLease(relayKey, lease) {
    if (!relayKey || !lease) return null;
    const trackedLease = this.leaseVault.track({
      ...lease,
      ownerPeerKey: lease.writerPackage?.ownerPeerKey || lease.ownerPeerKey || null
    });
    if (!trackedLease) return null;
    this.metrics.setLeaseState(relayKey, true);
    this.replicaManager?.setWriterLeaseState?.(
      relayKey,
      trackedLease.ownerPeerKey || trackedLease.writerPackage?.ownerPeerKey || null,
      trackedLease
    );
    return trackedLease;
  }

  async #loadTlsMaterials() {
    const tlsConfig = this.config?.tls;
    if (!tlsConfig) return null;
    const [ca, cert, key] = await Promise.all([
      this.#readMaybe(tlsConfig.caPath || tlsConfig.clientCaPath),
      this.#readMaybe(tlsConfig.clientCertPath),
      this.#readMaybe(tlsConfig.clientKeyPath)
    ]);
    if (!ca && !cert && !key) {
      if (tlsConfig.rejectUnauthorized === false) {
        return { rejectUnauthorized: false };
      }
      return null;
    }
    return {
      ca: ca || undefined,
      cert: cert || undefined,
      key: key || undefined,
      rejectUnauthorized: tlsConfig.rejectUnauthorized !== false
    };
  }

  async #readMaybe(path) {
    if (!path) return null;
    try {
      return await readFile(path);
    } catch (error) {
      this.logger?.warn?.('[EscrowCoordinator] Failed to read TLS material', {
        path,
        error: error?.message || error
      });
      throw error;
    }
  }
}

export default AutobaseKeyEscrowCoordinator;
