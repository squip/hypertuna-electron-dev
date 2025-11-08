import { EventEmitter } from 'node:events';

let jobSequence = 0;
let rotationSequence = 0;

function nextJobId() {
  jobSequence += 1;
  return `pending-write-${jobSequence}`;
}

function nextRotationId() {
  rotationSequence += 1;
  return `rotation-${rotationSequence}`;
}

function cloneLease(lease = null) {
  if (!lease || typeof lease !== 'object') return null;
  return {
    leaseId: lease.leaseId || null,
    escrowId: lease.escrowId || null,
    expiresAt: lease.expiresAt || null,
    issuedAt: lease.issuedAt || null,
    releasedAt: lease.releasedAt || null,
    releasedReason: lease.releasedReason || null,
    status: lease.status || null,
    version: Number.isFinite(lease.version) ? lease.version : lease.version ?? null
  };
}

export default class PendingWriteCoordinator extends EventEmitter {
  constructor({ logger = console } = {}) {
    super();
    this.logger = logger || console;
    this.entries = new Map(); // relayKey -> state object
    this.queue = [];
    this.inflight = new Map(); // jobId -> job
    this.lastUpdatedAt = null;
    this.rotations = [];
    this.rotationByRelay = new Map();
  }

  handleGatewayNotification(record = {}) {
    const relayKey = record?.relayKey;
    if (!relayKey) return;

    const entry = this.entries.get(relayKey) || {
      relayKey,
      status: 'idle',
      totalNotifications: 0,
      pendingSince: null,
      history: []
    };

    entry.totalNotifications += 1;
    entry.reason = record.reason || entry.reason || 'replica-write';
    entry.types = Array.isArray(record.types) ? record.types : [];
    entry.driveIdentifier = record.driveIdentifier || entry.driveIdentifier || relayKey;
    entry.driveVersion = Number.isFinite(record.driveVersion) ? record.driveVersion : entry.driveVersion ?? null;
    entry.lease = cloneLease(record.lease);
    entry.leaseVersion = Number.isFinite(record.leaseVersion)
      ? record.leaseVersion
      : entry.leaseVersion ?? null;
    if (typeof record.leaseActive === 'boolean') {
      entry.leaseActive = record.leaseActive;
    } else if (entry.leaseActive === undefined) {
      entry.leaseActive = null;
    }
    entry.lastUpdatedAt = Date.now();
    entry.lastNotification = record;
    entry.pendingSince = entry.pendingSince || record.pendingSince || entry.lastUpdatedAt;
    entry.history.push({
      state: record.state || 'pending',
      receivedAt: entry.lastUpdatedAt
    });

    if (record.state === 'cleared') {
      entry.status = 'cleared';
      entry.pendingSince = null;
      entry.clearedAt = entry.lastUpdatedAt;
      this.#removeJobsForRelay(relayKey);
    } else {
      const existingJob = this.queue.find((job) => job.relayKey === relayKey)
        || Array.from(this.inflight.values()).find((job) => job.relayKey === relayKey);
      if (!existingJob) {
        const jobId = nextJobId();
        const job = {
          jobId,
          relayKey,
          enqueuedAt: Date.now(),
          state: 'queued',
          notification: record
        };
        this.queue.push(job);
        entry.lastJobId = jobId;
      }
      if (entry.status === 'in-progress') {
        // keep current status until resync loop updates it
      } else {
        entry.status = 'queued';
      }
    }

    this.entries.set(relayKey, entry);
    this.lastUpdatedAt = Date.now();
    this.emit('state-changed', this.getSnapshot());
  }

  dequeueNextJob() {
    if (!this.queue.length) return null;
    const job = this.queue.shift();
    job.state = 'in-progress';
    job.startedAt = Date.now();
    this.inflight.set(job.jobId, job);
    const entry = this.entries.get(job.relayKey);
    if (entry) {
      entry.status = 'in-progress';
      entry.lastUpdatedAt = Date.now();
      this.entries.set(job.relayKey, entry);
    }
    this.emit('state-changed', this.getSnapshot());
    return job;
  }

  markJobComplete(relayKey, { result = 'completed' } = {}) {
    if (!relayKey) return;
    const entry = this.entries.get(relayKey);
    if (entry) {
      entry.status = result === 'failed' ? 'error' : result === 'skipped' ? 'queued' : 'completed';
      entry.lastUpdatedAt = Date.now();
      entry.lastResult = result;
      this.entries.set(relayKey, entry);
      if (result === 'completed') {
        const baseTimestamp = entry.lastNotification?.lease?.issuedAt
          || entry.pendingSince
          || entry.lastUpdatedAt;
        if (Number.isFinite(baseTimestamp)) {
          const lagMs = Math.max(0, Date.now() - baseTimestamp);
          this.emit('lease-lag', {
            relayKey,
            lagMs,
            leaseVersion: entry.leaseVersion ?? entry.lease?.version ?? null
          });
        }
      }
    }
    for (const [jobId, job] of this.inflight.entries()) {
      if (job.relayKey === relayKey) {
        this.inflight.delete(jobId);
      }
    }
    if (result === 'completed') {
      this.#removeJobsForRelay(relayKey);
    }
    this.emit('state-changed', this.getSnapshot());
  }

  reset() {
    this.entries.clear();
    this.queue = [];
    this.inflight.clear();
    this.lastUpdatedAt = null;
    this.rotations = [];
    this.rotationByRelay.clear();
    this.emit('state-changed', this.getSnapshot());
  }

  getSnapshot() {
    const relays = Array.from(this.entries.values())
      .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0))
      .map((entry) => ({
        relayKey: entry.relayKey,
        status: entry.status,
        reason: entry.reason,
        types: entry.types,
        driveIdentifier: entry.driveIdentifier,
        driveVersion: entry.driveVersion,
        lease: entry.lease,
        leaseVersion: entry.leaseVersion ?? null,
        leaseActive: entry.leaseActive ?? null,
        pendingSince: entry.pendingSince,
        lastUpdatedAt: entry.lastUpdatedAt,
        totalNotifications: entry.totalNotifications,
        lastJobId: entry.lastJobId,
        clearedAt: entry.clearedAt || null
      }));

    return {
      updatedAt: this.lastUpdatedAt,
      queueSize: this.queue.length,
      inflightSize: this.inflight.size,
      relays,
      rotations: this.rotations.slice()
    };
  }

  #removeJobsForRelay(relayKey) {
    this.queue = this.queue.filter((job) => job.relayKey !== relayKey);
    for (const [jobId, job] of this.inflight.entries()) {
      if (job.relayKey === relayKey) {
        this.inflight.delete(jobId);
      }
    }
  }

  getNotificationRecords() {
    const records = [];
    for (const entry of this.entries.values()) {
      if (entry.lastNotification) {
        records.push({ ...entry.lastNotification });
      }
    }
    return records;
  }

  restoreNotifications(records = []) {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (record && record.relayKey) {
        this.handleGatewayNotification(record);
      }
    }
  }

  recordRotation(rotation = {}) {
    if (!rotation?.relayKey) return;
    const entry = {
      rotationId: rotation.rotationId || nextRotationId(),
      relayKey: rotation.relayKey,
      reason: rotation.reason || 'unknown',
      status: rotation.status || 'pending',
      attempts: rotation.attempts ?? (this.rotationByRelay.get(rotation.relayKey)?.attempts || 0) + 1,
      previousEscrowId: rotation.previousEscrowId || null,
      startedAt: rotation.startedAt || Date.now(),
      completedAt: rotation.completedAt || null,
      error: rotation.error || null
    };
    this.rotationByRelay.set(rotation.relayKey, entry);
    this.rotations = [entry, ...this.rotations].slice(0, 50);
    this.emit('state-changed', this.getSnapshot());
  }

  getRotationRecords() {
    return this.rotations.slice();
  }

  restoreRotations(records = []) {
    if (!Array.isArray(records)) return;
    this.rotations = [];
    this.rotationByRelay.clear();
    for (const record of records) {
      if (!record?.relayKey) continue;
      this.rotations.push(record);
      this.rotationByRelay.set(record.relayKey, record);
    }
    this.emit('state-changed', this.getSnapshot());
  }
}
