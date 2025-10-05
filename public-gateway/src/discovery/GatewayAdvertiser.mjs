import { URL } from 'node:url';
import Hyperswarm from 'hyperswarm';

import {
  DISCOVERY_TOPIC,
  computeSecretHash,
  encodeAnnouncement,
  deriveKeyPair,
  signAnnouncement
} from '../../../shared/public-gateway/GatewayDiscovery.mjs';

const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

class GatewayAdvertiser {
  constructor({
    logger,
    discoveryConfig,
    getSharedSecret,
    getSharedSecretVersion,
    publicUrl,
    wsUrl
  }) {
    this.logger = logger || console;
    this.config = discoveryConfig || {};
    this.getSharedSecret = typeof getSharedSecret === 'function' ? getSharedSecret : async () => null;
    this.getSharedSecretVersion = typeof getSharedSecretVersion === 'function'
      ? getSharedSecretVersion
      : async () => null;
    this.publicUrl = publicUrl || null;
    this.wsUrl = wsUrl || null;
    this.keyPair = null;
    this.gatewayId = null;
    this.swarm = null;
    this.discovery = null;
    this.running = false;
    this.secretUrl = this.#resolveSecretUrl(this.config.secretPath);
    this.ttl = Number.isFinite(this.config.ttlSeconds) && this.config.ttlSeconds > 0
      ? Math.round(this.config.ttlSeconds)
      : DEFAULT_TTL_SECONDS;
    this.refreshInterval = Number.isFinite(this.config.refreshIntervalMs) && this.config.refreshIntervalMs > 0
      ? this.config.refreshIntervalMs
      : DEFAULT_REFRESH_INTERVAL_MS;
    this.refreshTimer = null;
    this.cachedAnnouncement = null;
    this.cachedBuffer = null;
    this.cachedAt = 0;
    this.logger?.debug?.('[GatewayAdvertiser] Initialized discovery advertiser', {
      enabled: !!this.config.enabled,
      openAccess: !!this.config.openAccess,
      secretUrl: this.secretUrl,
      ttl: this.ttl,
      refreshInterval: this.refreshInterval
    });
  }

  isEnabled() {
    return !!(this.config.enabled && this.config.openAccess);
  }

  async start() {
    if (!this.isEnabled()) {
      this.logger?.info?.('[GatewayAdvertiser] Discovery disabled or gateway not open access');
      return;
    }
    if (this.running) return;

    try {
      this.keyPair = deriveKeyPair(this.config.keySeed || null);
      this.gatewayId = Buffer.from(this.keyPair.publicKey).toString('hex');
      this.swarm = new Hyperswarm({ keyPair: this.keyPair });
      this.swarm.on('connection', (socket) => {
        this.#handleConnection(socket).catch((error) => {
          this.logger?.warn?.('[GatewayAdvertiser] Failed to handle discovery connection', {
            error: error?.message || error
          });
        });
      });
      this.swarm.on('error', (error) => {
        this.logger?.error?.('[GatewayAdvertiser] Hyperswarm error', {
          error: error?.message || error
        });
      });
      this.discovery = this.swarm.join(DISCOVERY_TOPIC, { server: true, client: false });
      await this.discovery.flushed();
      this.logger?.info?.('[GatewayAdvertiser] Discovery topic joined', {
        topic: Buffer.from(DISCOVERY_TOPIC).toString('hex')
      });
      this.running = true;
      await this.#refreshAnnouncement();
      this.refreshTimer = setInterval(() => {
        this.#refreshAnnouncement().catch((error) => {
          this.logger?.warn?.('[GatewayAdvertiser] Failed to refresh announcement', {
            error: error?.message || error
          });
        });
      }, this.refreshInterval).unref();
    } catch (error) {
      this.logger?.error?.('[GatewayAdvertiser] Failed to start discovery advertiser', {
        error: error?.message || error
      });
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.discovery) {
      try {
        await this.discovery.destroy?.();
      } catch (error) {
        this.logger?.debug?.('[GatewayAdvertiser] Failed to destroy discovery handle', {
          error: error?.message || error
        });
      }
      this.discovery = null;
    }
    if (this.swarm) {
      try {
        await this.swarm.destroy();
      } catch (error) {
        this.logger?.debug?.('[GatewayAdvertiser] Failed to destroy hyperswarm', {
          error: error?.message || error
        });
      }
      this.swarm = null;
    }
    this.running = false;
    this.cachedAnnouncement = null;
    this.cachedBuffer = null;
    this.cachedAt = 0;
  }

  async #handleConnection(socket) {
    socket.once('error', () => socket.destroy());
    try {
      const buffer = await this.#getAnnouncementBuffer();
      if (buffer) {
        socket.write(buffer);
      }
    } finally {
      socket.end();
    }
  }

  async #getAnnouncementBuffer() {
    const now = Date.now();
    if (!this.cachedBuffer || (now - this.cachedAt) > this.refreshInterval / 2) {
      await this.#refreshAnnouncement();
    }
    return this.cachedBuffer;
  }

  async #refreshAnnouncement() {
    const announcement = await this.#buildAnnouncement();
    this.cachedAnnouncement = announcement;
    this.cachedBuffer = encodeAnnouncement(announcement);
    this.cachedAt = Date.now();
  }

  async #buildAnnouncement() {
    const sharedSecret = await this.getSharedSecret();
    const sharedSecretVersion = await this.getSharedSecretVersion();
    const timestamp = Date.now();
    const displayName = this.config.displayName || null;
    const region = this.config.region || null;
    const protocolVersion = Number.isFinite(this.config.protocolVersion)
      ? Math.round(this.config.protocolVersion)
      : 1;

    const payload = {
      gatewayId: this.gatewayId,
      timestamp,
      ttl: this.ttl,
      publicUrl: this.publicUrl || '',
      wsUrl: this.wsUrl || '',
      secretUrl: this.secretUrl || '',
      secretHash: computeSecretHash(sharedSecret || ''),
      openAccess: true,
      sharedSecretVersion: sharedSecretVersion || '',
      displayName: displayName || '',
      region: region || '',
      protocolVersion,
      signatureKey: Buffer.from(this.keyPair.publicKey).toString('hex')
    };

    payload.signature = signAnnouncement(payload, this.keyPair.secretKey);
    return payload;
  }

  #resolveSecretUrl(secretPath) {
    if (!secretPath) {
      return this.publicUrl ? new URL('/.well-known/hypertuna-gateway-secret', this.publicUrl).toString() : '';
    }
    if (!this.publicUrl) return secretPath;
    try {
      if (secretPath.startsWith('http://') || secretPath.startsWith('https://')) {
        return secretPath;
      }
      const normalizedPath = secretPath.startsWith('/') ? secretPath : `/${secretPath}`;
      return new URL(normalizedPath, this.publicUrl).toString();
    } catch (error) {
      this.logger?.warn?.('[GatewayAdvertiser] Failed to resolve secret URL', {
        secretPath,
        error: error?.message || error
      });
      return '';
    }
  }
}

export default GatewayAdvertiser;

