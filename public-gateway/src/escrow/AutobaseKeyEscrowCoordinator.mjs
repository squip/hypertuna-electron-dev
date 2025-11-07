import { EventEmitter } from 'node:events';

import AutobaseKeyEscrowClient from '../../../shared/escrow/AutobaseKeyEscrowClient.mjs';
import {
  generateKeyPair,
  encodeKey,
  openPayload,
  zeroize
} from '../../../shared/escrow/AutobaseKeyEscrowCrypto.mjs';

class AutobaseKeyEscrowCoordinator extends EventEmitter {
  constructor({ config = {}, logger = console, metrics = {}, replicaManager = null } = {}) {
    super();
    this.config = config;
    this.logger = logger;
    this.metrics = {
      recordUnlock: metrics.recordUnlock || (() => {}),
      setLeaseState: metrics.setLeaseState || (() => {})
    };
    this.replicaManager = replicaManager;
    this.client = null;
    this.leases = new Map(); // relayKey => lease
  }

  isEnabled() {
    return Boolean(this.config?.enabled && this.config?.baseUrl && this.config?.sharedSecret);
  }

  async initialize() {
    if (!this.isEnabled()) {
      this.logger?.info?.('[EscrowCoordinator] Disabled (missing configuration)');
      return;
    }
    this.client = new AutobaseKeyEscrowClient({
      baseUrl: this.config.baseUrl,
      sharedSecret: this.config.sharedSecret,
      clientId: this.config.clientId || 'public-gateway',
      fetchImpl: globalThis.fetch?.bind(globalThis)
    });
    this.logger?.info?.('[EscrowCoordinator] Initialized', {
      escrowBaseUrl: this.config.baseUrl
    });
  }

  async stop() {
    for (const lease of this.leases.values()) {
      this.#clearLease(lease.relayKey, 'shutdown');
    }
    this.leases.clear();
  }

  setReplicaManager(replicaManager) {
    this.replicaManager = replicaManager;
  }

  getLeaseSummaries() {
    return Array.from(this.leases.values()).map((lease) => ({
      relayKey: lease.relayKey,
      leaseId: lease.leaseId,
      escrowId: lease.escrowId,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      ownerPeerKey: lease.writerPackage?.ownerPeerKey || null
    }));
  }

  getLease(relayKey) {
    return relayKey ? (this.leases.get(relayKey) || null) : null;
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
      this.metrics.recordUnlock('error');
      throw error;
    }

    let decrypted = null;
    try {
      decrypted = openPayload({
        cipherText: response.sealedLease?.cipherText,
        nonce: response.sealedLease?.nonce,
        senderPublicKey: response.sealedLease?.publicKey,
        recipientSecretKey: sessionPair.secretKey
      });
    } finally {
      zeroize(sessionPair.secretKey);
    }

    let writerPackage = null;
    try {
      writerPackage = JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
      throw new Error('lease-payload-invalid');
    } finally {
      zeroize(decrypted);
    }

    const lease = {
      relayKey,
      leaseId: response.leaseId,
      escrowId: response.escrowId,
      issuedAt: Date.now(),
      expiresAt: response.expiresAt || null,
      writerPackage,
      evidence
    };

    this.#trackLease(relayKey, lease);
    this.metrics.recordUnlock('success');
    this.emit('lease-issued', lease);
    return {
      relayKey,
      leaseId: lease.leaseId,
      escrowId: lease.escrowId,
      expiresAt: lease.expiresAt
    };
  }

  releaseLease(relayKey, reason = 'manual-release') {
    return this.#clearLease(relayKey, reason);
  }

  #trackLease(relayKey, lease) {
    if (!relayKey || !lease) return;
    this.#clearLease(relayKey, 'superseded');
    this.leases.set(relayKey, lease);
    this.metrics.setLeaseState(relayKey, true);
    this.replicaManager?.setWriterLeaseState?.(relayKey, lease.writerPackage?.ownerPeerKey, lease);
  }

  #clearLease(relayKey, reason = 'expired') {
    if (!relayKey) return false;
    const existing = this.leases.get(relayKey);
    if (!existing) return false;
    if (existing.writerPackage) {
      zeroize(existing.writerPackage.writerKey);
    }
    this.leases.delete(relayKey);
    this.metrics.setLeaseState(relayKey, false);
    this.replicaManager?.setWriterLeaseState?.(relayKey, existing.writerPackage?.ownerPeerKey, null);
    this.emit('lease-released', { relayKey, leaseId: existing.leaseId, reason });
    return true;
  }
}

export default AutobaseKeyEscrowCoordinator;
