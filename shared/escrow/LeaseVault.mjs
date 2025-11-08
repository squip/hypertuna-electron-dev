import { hashSecret, toSecureBuffer, zeroize } from './AutobaseKeyEscrowCrypto.mjs';

const DEFAULT_SIGNALS = ['SIGINT', 'SIGTERM', 'beforeExit'];

class LeaseVault {
  constructor({
    logger = console,
    label = 'lease-vault',
    handleProcessSignals = true,
    signals = DEFAULT_SIGNALS
  } = {}) {
    this.logger = logger || console;
    this.label = label;
    this.entries = new Map(); // leaseId => entry
    this.relayToLease = new Map();
    this.signalHandlers = [];
    if (handleProcessSignals) {
      this.#registerSignalHandlers(signals);
    }
  }

  track(lease = {}, { includeSecret = true } = {}) {
    if (!lease?.relayKey) return null;
    const entry = this.#normalizeLease(lease);
    this.#storeEntry(entry);
    return this.#cloneEntry(entry, { includeSecret });
  }

  get(relayKey, { includeSecret = false } = {}) {
    if (!relayKey) return null;
    const leaseId = this.relayToLease.get(relayKey);
    if (!leaseId) return null;
    const entry = this.entries.get(leaseId);
    if (!entry) return null;
    return this.#cloneEntry(entry, { includeSecret });
  }

  list({ includeSecret = false } = {}) {
    return Array.from(this.entries.values()).map((entry) => this.#cloneEntry(entry, { includeSecret }));
  }

  release(relayKey, reason = 'manual-release') {
    if (!relayKey) return null;
    const leaseId = this.relayToLease.get(relayKey);
    if (!leaseId) return null;
    const entry = this.entries.get(leaseId);
    if (!entry) {
      this.relayToLease.delete(relayKey);
      return null;
    }
    this.entries.delete(leaseId);
    this.relayToLease.delete(relayKey);
    const clone = this.#cloneEntry(entry, { includeSecret: false });
    clone.releasedAt = Date.now();
    this.#zeroizeEntry(entry);
    this.logger?.debug?.('[LeaseVault] Released lease', {
      relayKey,
      leaseId,
      reason,
      vault: this.label
    });
    return clone;
  }

  releaseByEscrowId(escrowId, reason = 'escrow-revoked') {
    if (!escrowId) return [];
    return this.#releaseMatching((entry) => entry.escrowId === escrowId, reason);
  }

  releaseExpired(now = Date.now(), reason = 'lease-expired') {
    return this.#releaseMatching(
      (entry) => entry.expiresAt && entry.expiresAt < now,
      reason
    );
  }

  clearAll(reason = 'flush') {
    for (const entry of this.entries.values()) {
      this.#zeroizeEntry(entry);
    }
    this.entries.clear();
    this.relayToLease.clear();
    if (reason) {
      this.logger?.debug?.('[LeaseVault] Cleared all leases', {
        reason,
        vault: this.label
      });
    }
  }

  destroy(reason = 'shutdown') {
    this.clearAll(reason);
    for (const { signal, handler } of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers = [];
  }

  count() {
    return this.entries.size;
  }

  #storeEntry(entry) {
    const existingLeaseId = this.relayToLease.get(entry.relayKey);
    if (existingLeaseId && this.entries.has(existingLeaseId)) {
      const existing = this.entries.get(existingLeaseId);
      this.entries.delete(existingLeaseId);
      this.#zeroizeEntry(existing);
    }
    this.entries.set(entry.leaseId, entry);
    this.relayToLease.set(entry.relayKey, entry.leaseId);
  }

  #normalizeLease(lease) {
    const writerPackage = this.#normalizeWriterPackage(lease.writerPackage);
    const payloadDigest = lease.payloadDigest
      || writerPackage?.writerKeyDigest
      || hashSecret(writerPackage?.writerKey || lease.leaseId || lease.relayKey || Date.now());

    return {
      relayKey: lease.relayKey,
      leaseId: lease.leaseId || `lease_${Date.now()}`,
      escrowId: lease.escrowId || null,
      requesterId: lease.requesterId || null,
      ownerPeerKey: lease.ownerPeerKey || writerPackage?.ownerPeerKey || null,
      issuedAt: lease.issuedAt || Date.now(),
      expiresAt: lease.expiresAt || null,
      evidence: lease.evidence ? { ...lease.evidence } : null,
      reasons: Array.isArray(lease.reasons) ? [...lease.reasons] : [],
      writerPackage,
      payloadDigest
    };
  }

  #normalizeWriterPackage(pkg) {
    if (!pkg || typeof pkg !== 'object') return null;
    const normalized = { ...pkg };
    if (pkg.writerKey != null) {
      const buffer = toSecureBuffer(pkg.writerKey, { encodings: ['hex', 'base64'] });
      normalized.writerKey = buffer || null;
      normalized.writerKeyDigest = pkg.writerKeyDigest || (buffer ? hashSecret(buffer) : null);
    }
    return normalized;
  }

  #cloneEntry(entry, { includeSecret = false } = {}) {
    if (!entry) return null;
    const clone = {
      relayKey: entry.relayKey,
      leaseId: entry.leaseId,
      escrowId: entry.escrowId,
      requesterId: entry.requesterId || null,
      ownerPeerKey: entry.ownerPeerKey || entry.writerPackage?.ownerPeerKey || null,
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
      evidence: entry.evidence ? { ...entry.evidence } : null,
      reasons: entry.reasons ? [...entry.reasons] : [],
      payloadDigest: entry.payloadDigest
    };
    if (entry.writerPackage) {
      clone.writerPackage = {
        ...entry.writerPackage,
        writerKey: includeSecret && entry.writerPackage.writerKey
          ? Buffer.from(entry.writerPackage.writerKey)
          : undefined
      };
      if (!includeSecret && clone.writerPackage) {
        delete clone.writerPackage.writerKey;
      }
    }
    return clone;
  }

  #zeroizeEntry(entry) {
    if (!entry) return;
    if (entry.writerPackage?.writerKey) {
      zeroize(entry.writerPackage.writerKey);
      entry.writerPackage.writerKey = null;
    }
  }

  #releaseMatching(predicate, reason = 'filtered-release') {
    if (typeof predicate !== 'function') return [];
    const released = [];
    for (const entry of Array.from(this.entries.values())) {
      if (!predicate(entry)) continue;
      this.entries.delete(entry.leaseId);
      this.relayToLease.delete(entry.relayKey);
      const clone = this.#cloneEntry(entry, { includeSecret: false });
      clone.releasedAt = Date.now();
      released.push(clone);
      this.#zeroizeEntry(entry);
    }
    if (released.length && reason) {
      this.logger?.debug?.('[LeaseVault] Released batch', {
        reason,
        count: released.length,
        vault: this.label
      });
    }
    return released;
  }

  #registerSignalHandlers(signals = DEFAULT_SIGNALS) {
    const uniqueSignals = Array.isArray(signals) && signals.length ? signals : DEFAULT_SIGNALS;
    for (const signal of uniqueSignals) {
      if (typeof signal !== 'string') continue;
      const handler = () => {
        this.logger?.warn?.('[LeaseVault] Detected process signal, clearing leases', {
          signal,
          vault: this.label,
        });
        this.clearAll(`signal:${signal}`);
      };
      process.on(signal, handler);
      this.signalHandlers.push({ signal, handler });
    }
  }
}

export default LeaseVault;
