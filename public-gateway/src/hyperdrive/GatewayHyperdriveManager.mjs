import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import Corestore from 'corestore';
import Hyperdrive from 'hyperdrive';

const DEFAULT_STORAGE_SUBDIR = 'gateway-drives';
const KIND_RELAY = 'relay';
const KIND_PFP = 'pfp';

function normalizeIdentifier(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return /^[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  return String(value);
}

function sanitizeSegment(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/^[./\\]+/, '')
    .replace(/\.\./g, '')
    .replace(/[^a-zA-Z0-9._:-]/g, '_');
}

export default class GatewayHyperdriveManager {
  constructor({ storageDir, blindPeerService = null, logger = console } = {}) {
    this.storageDir = storageDir || resolve(process.cwd(), DEFAULT_STORAGE_SUBDIR);
    this.blindPeerService = blindPeerService;
    this.logger = logger || console;
    this.corestore = null;
    this.drives = new Map();
  }

  async initialize() {
    await mkdir(this.storageDir, { recursive: true });
    this.corestore = new Corestore(this.storageDir);
    await this.corestore.ready();
    this.logger?.info?.('[GatewayHyperdriveManager] Initialized', {
      storageDir: this.storageDir
    });
  }

  async stop() {
    const driveStops = Array.from(this.drives.values()).map(async ({ drive }) => {
      try {
        await drive.close();
      } catch (error) {
        this.logger?.debug?.('[GatewayHyperdriveManager] Drive close failed', {
          error: error?.message || error
        });
      }
    });
    await Promise.allSettled(driveStops);
    this.drives.clear();
    if (this.corestore) {
      try {
        await this.corestore.close();
      } catch (error) {
        this.logger?.debug?.('[GatewayHyperdriveManager] Corestore close failed', {
          error: error?.message || error
        });
      }
      this.corestore = null;
    }
  }

  async readRelayFile(identifier, fileName) {
    const drive = await this.#ensureDrive({ identifier, kind: KIND_RELAY });
    if (!drive) return null;
    const path = this.#buildRelayPath(identifier, fileName);
    return this.#safeGet(drive, path);
  }

  async writeRelayFile(identifier, fileName, data, { metadata = {}, owner = null } = {}) {
    const drive = await this.#ensureDrive({ identifier, kind: KIND_RELAY, writable: true });
    if (!drive) throw new Error('drive-not-initialized');
    const normalizedIdentifier = normalizeIdentifier(identifier);
    const path = this.#buildRelayPath(identifier, fileName);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    await drive.put(path, buffer, { metadata });
    const stats = await this.#collectDriveStats(drive);
    await this.#mirrorDrive(drive, { kind: KIND_RELAY, identifier: normalizedIdentifier, owner });
    return {
      identifier: normalizedIdentifier,
      key: drive.key?.toString('hex') || null,
      bytesWritten: buffer.length,
      path,
      version: stats.version,
      discoveryKey: stats.discoveryKey,
      coreLength: stats.coreLength,
      coreContiguousLength: stats.coreContiguousLength,
      blobLength: stats.blobLength,
      blobContiguousLength: stats.blobContiguousLength
    };
  }

  async readPfpFile(owner, fileName) {
    const drive = await this.#ensureDrive({ identifier: KIND_PFP, kind: KIND_PFP });
    if (!drive) return null;
    const path = this.#buildPfpPath(owner, fileName);
    return this.#safeGet(drive, path);
  }

  async writePfpFile(owner, fileName, data, { metadata = {} } = {}) {
    const drive = await this.#ensureDrive({ identifier: KIND_PFP, kind: KIND_PFP, writable: true });
    if (!drive) throw new Error('pfp-drive-not-initialized');
    const path = this.#buildPfpPath(owner, fileName);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    await drive.put(path, buffer, { metadata });
    const stats = await this.#collectDriveStats(drive);
    await this.#mirrorDrive(drive, { kind: KIND_PFP, identifier: KIND_PFP, owner });
    return {
      identifier: KIND_PFP,
      key: drive.key?.toString('hex') || null,
      bytesWritten: buffer.length,
      path,
      version: stats.version,
      discoveryKey: stats.discoveryKey,
      coreLength: stats.coreLength,
      coreContiguousLength: stats.coreContiguousLength,
      blobLength: stats.blobLength,
      blobContiguousLength: stats.blobContiguousLength
    };
  }

  async #safeGet(drive, path) {
    try {
      return await drive.get(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #ensureDrive({ identifier, kind = KIND_RELAY, writable = false }) {
    const normalized = kind === KIND_PFP ? KIND_PFP : normalizeIdentifier(identifier);
    if (!normalized) return null;
    const cacheKey = `${kind}:${normalized}`;
    const cached = this.drives.get(cacheKey);
    if (cached) return cached.drive;

    if (!this.corestore) {
      await this.initialize();
    }
    const namespace = this.corestore.namespace(`gw-${kind}:${normalized}`);
    const drive = new Hyperdrive(namespace);
    await drive.ready();
    this.drives.set(cacheKey, { drive, kind, identifier: normalized });
    if (writable) {
      await this.#mirrorDrive(drive, { kind, identifier: normalized });
    }
    return drive;
  }

  #buildRelayPath(identifier, fileName) {
    const normalizedId = normalizeIdentifier(identifier) || 'unknown';
    const sanitized = this.#sanitizeSubpath(fileName);
    return `/${normalizedId}/${sanitized}`;
  }

  #buildPfpPath(owner, fileName) {
    const normalizedOwner = sanitizeSegment(owner || 'global') || 'global';
    const sanitized = this.#sanitizeSubpath(fileName);
    return `/${normalizedOwner}/${sanitized}`;
  }

  #sanitizeSubpath(value) {
    if (!value || typeof value !== 'string') {
      return 'blob';
    }
    const cleaned = value.split('/').map(sanitizeSegment).filter(Boolean).join('/');
    return cleaned || 'blob';
  }

  async #mirrorDrive(drive, { kind, identifier, owner = null } = {}) {
    if (!this.blindPeerService?.mirrorCore) return;
    try {
      await this.blindPeerService.mirrorCore(drive.core, {
        announce: true,
        priority: kind === KIND_PFP ? 0 : 1,
        metadata: {
          type: kind === KIND_PFP ? 'pfp-drive' : 'drive',
          identifier,
          owner: owner || null
        }
      });
    } catch (error) {
      this.logger?.debug?.('[GatewayHyperdriveManager] Failed to mirror drive core', {
        identifier,
        kind,
        error: error?.message || error
      });
    }
  }

  async #collectDriveStats(drive) {
    const stats = {
      version: Number.isFinite(drive?.version) ? drive.version : null,
      discoveryKey: drive?.core?.discoveryKey ? Buffer.from(drive.core.discoveryKey).toString('hex') : null,
      coreLength: null,
      coreContiguousLength: null,
      blobLength: null,
      blobContiguousLength: null
    };

    if (typeof drive?.core?.info === 'function') {
      try {
        const info = await drive.core.info();
        if (Number.isFinite(info?.length)) {
          stats.coreLength = info.length;
        }
        if (Number.isFinite(info?.contiguousLength)) {
          stats.coreContiguousLength = info.contiguousLength;
        }
      } catch (error) {
        this.logger?.debug?.('[GatewayHyperdriveManager] Failed to fetch drive core info', {
          error: error?.message || error
        });
      }
    }

    const blobsCore = drive?.blobs?.core;
    if (typeof blobsCore?.info === 'function') {
      try {
        const info = await blobsCore.info();
        if (Number.isFinite(info?.length)) {
          stats.blobLength = info.length;
        }
        if (Number.isFinite(info?.contiguousLength)) {
          stats.blobContiguousLength = info.contiguousLength;
        }
      } catch (error) {
        this.logger?.debug?.('[GatewayHyperdriveManager] Failed to fetch drive blob info', {
          error: error?.message || error
        });
      }
    }

    return stats;
  }
}
