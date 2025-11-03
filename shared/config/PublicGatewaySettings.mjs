const VALID_SELECTION_MODES = new Set(['default', 'discovered', 'manual']);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  selectionMode: 'default',
  selectedGatewayId: null,
  preferredBaseUrl: 'https://hypertuna.com',
  baseUrl: 'https://hypertuna.com',
  sharedSecret: '',
  delegateReqToPeers: false,
  blindPeerEnabled: false,
  blindPeerKeys: [],
  blindPeerEncryptionKey: null,
  blindPeerReplicationTopic: null,
  blindPeerMaxBytes: null,
  defaultTokenTtl: 3600,
  tokenRefreshWindowSeconds: 300,
  dispatcherMaxConcurrent: 3,
  dispatcherInFlightWeight: 25,
  dispatcherLatencyWeight: 1,
  dispatcherFailureWeight: 500,
  dispatcherReassignLagBlocks: 500,
  dispatcherCircuitBreakerThreshold: 5,
  dispatcherCircuitBreakerTimeoutMs: 60_000,
  resolvedGatewayId: null,
  resolvedSecretVersion: null,
  resolvedAt: null,
  resolvedSharedSecretHash: null,
  resolvedDisplayName: null,
  resolvedRegion: null,
  resolvedWsUrl: null,
  resolvedGatewayRelay: null,
  resolvedDefaultTokenTtl: null,
  resolvedTokenRefreshWindowSeconds: null,
  resolvedDispatcher: null
});

const LOCAL_STORAGE_KEY = 'hypertuna_public_gateway_settings';
const SETTINGS_FILENAME = 'public-gateway-settings.json';

let cachedSettings = null;
let nodeFsModule = null;
let nodePathModule = null;
let nodeSettingsPath = null;

function isRenderer() {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

function isNodeProcess() {
  return typeof process !== 'undefined' && !!process.versions?.node && !isRenderer();
}

function normalizeSettings(raw = {}) {
  const normalized = {};

  if (typeof raw.enabled === 'boolean') {
    normalized.enabled = raw.enabled;
  }

  if (typeof raw.selectionMode === 'string') {
    const mode = raw.selectionMode.trim().toLowerCase();
    if (VALID_SELECTION_MODES.has(mode)) {
      normalized.selectionMode = mode;
    }
  }

  if (typeof raw.selectedGatewayId === 'string') {
    const value = raw.selectedGatewayId.trim();
    normalized.selectedGatewayId = value || null;
  }

  if (typeof raw.baseUrl === 'string') {
    normalized.baseUrl = raw.baseUrl.trim();
  }

  if (typeof raw.preferredBaseUrl === 'string') {
    const value = raw.preferredBaseUrl.trim();
    normalized.preferredBaseUrl = value || null;
  }

  if (typeof raw.sharedSecret === 'string') {
    normalized.sharedSecret = raw.sharedSecret.trim();
  }

  if (typeof raw.delegateReqToPeers === 'boolean') {
    normalized.delegateReqToPeers = raw.delegateReqToPeers;
  }

  if (typeof raw.blindPeerEnabled === 'boolean') {
    normalized.blindPeerEnabled = raw.blindPeerEnabled;
  }

  if (raw.blindPeerKeys != null) {
    const list = Array.isArray(raw.blindPeerKeys) ? raw.blindPeerKeys : [raw.blindPeerKeys];
    const keys = Array.from(new Set(list.map((value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }).filter(Boolean)));
    normalized.blindPeerKeys = keys;
  }

  if (typeof raw.blindPeerEncryptionKey === 'string') {
    const value = raw.blindPeerEncryptionKey.trim();
    normalized.blindPeerEncryptionKey = value || null;
  }

  if (typeof raw.blindPeerReplicationTopic === 'string') {
    const value = raw.blindPeerReplicationTopic.trim();
    normalized.blindPeerReplicationTopic = value || null;
  }

  if (raw.blindPeerMaxBytes != null) {
    const bytes = Number(raw.blindPeerMaxBytes);
    if (Number.isFinite(bytes) && bytes > 0) {
      normalized.blindPeerMaxBytes = Math.trunc(bytes);
    }
  }

  if (raw.defaultTokenTtl != null) {
    const ttl = Number(raw.defaultTokenTtl);
    if (Number.isFinite(ttl) && ttl > 0) {
      normalized.defaultTokenTtl = Math.round(ttl);
    }
  }

  if (raw.tokenRefreshWindowSeconds != null) {
    const value = Number(raw.tokenRefreshWindowSeconds);
    if (Number.isFinite(value) && value > 0) {
      normalized.tokenRefreshWindowSeconds = Math.round(value);
    }
  }

  if (raw.resolvedDefaultTokenTtl != null) {
    const ttl = Number(raw.resolvedDefaultTokenTtl);
    if (Number.isFinite(ttl) && ttl > 0) {
      normalized.resolvedDefaultTokenTtl = Math.round(ttl);
    }
  }

  if (raw.resolvedTokenRefreshWindowSeconds != null) {
    const value = Number(raw.resolvedTokenRefreshWindowSeconds);
    if (Number.isFinite(value) && value > 0) {
      normalized.resolvedTokenRefreshWindowSeconds = Math.round(value);
    }
  }

  const dispatcherNumber = (candidate, min = 0) => {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > min) return num;
    return null;
  };

  const dispatcherFields = {
    dispatcherMaxConcurrent: 0,
    dispatcherInFlightWeight: 0,
    dispatcherLatencyWeight: 0,
    dispatcherFailureWeight: 0,
    dispatcherReassignLagBlocks: -1,
    dispatcherCircuitBreakerThreshold: 0,
    dispatcherCircuitBreakerTimeoutMs: 0
  };

  for (const field of Object.keys(dispatcherFields)) {
    if (raw[field] != null) {
      const value = dispatcherNumber(raw[field], dispatcherFields[field]);
      if (value !== null) {
        normalized[field] = field === 'dispatcherCircuitBreakerThreshold'
          ? Math.round(value)
          : Math.round(value);
      }
    }
  }

  if (typeof raw.resolvedGatewayId === 'string') {
    const value = raw.resolvedGatewayId.trim();
    normalized.resolvedGatewayId = value || null;
  }

  if (typeof raw.resolvedSecretVersion === 'string') {
    const value = raw.resolvedSecretVersion.trim();
    normalized.resolvedSecretVersion = value || null;
  }

  if (raw.resolvedAt != null) {
    const timestamp = Number(raw.resolvedAt);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      normalized.resolvedAt = timestamp;
    }
  }

  if (typeof raw.resolvedSharedSecretHash === 'string') {
    const value = raw.resolvedSharedSecretHash.trim();
    normalized.resolvedSharedSecretHash = value || null;
  }

  if (typeof raw.resolvedDisplayName === 'string') {
    const value = raw.resolvedDisplayName.trim();
    normalized.resolvedDisplayName = value || null;
  }

  if (typeof raw.resolvedRegion === 'string') {
    const value = raw.resolvedRegion.trim();
    normalized.resolvedRegion = value || null;
  }

  if (typeof raw.resolvedWsUrl === 'string') {
    const value = raw.resolvedWsUrl.trim();
    normalized.resolvedWsUrl = value || null;
  }

  if (raw.resolvedGatewayRelay && typeof raw.resolvedGatewayRelay === 'object') {
    const source = raw.resolvedGatewayRelay;
    const relay = {};
    if (typeof source.hyperbeeKey === 'string') relay.hyperbeeKey = source.hyperbeeKey.trim() || null;
    if (typeof source.discoveryKey === 'string') relay.discoveryKey = source.discoveryKey.trim() || null;
    if (typeof source.replicationTopic === 'string') relay.replicationTopic = source.replicationTopic.trim() || null;
    if (source.defaultTokenTtl != null) {
      const ttl = Number(source.defaultTokenTtl);
      if (Number.isFinite(ttl) && ttl > 0) relay.defaultTokenTtl = Math.round(ttl);
    }
    if (source.tokenRefreshWindowSeconds != null) {
      const refresh = Number(source.tokenRefreshWindowSeconds);
      if (Number.isFinite(refresh) && refresh > 0) relay.tokenRefreshWindowSeconds = Math.round(refresh);
    }
    if (source.dispatcher && typeof source.dispatcher === 'object') {
      const dispatcher = {};
      const assign = (key) => {
        const num = Number(source.dispatcher[key]);
        if (Number.isFinite(num) && num > 0) dispatcher[key] = Math.round(num);
      };
      assign('maxConcurrentJobsPerPeer');
      assign('inFlightWeight');
      assign('latencyWeight');
      assign('failureWeight');
      assign('reassignOnLagBlocks');
      assign('circuitBreakerThreshold');
      assign('circuitBreakerDurationMs');
      if (Object.keys(dispatcher).length) relay.dispatcher = dispatcher;
    }
    normalized.resolvedGatewayRelay = Object.keys(relay).length ? relay : null;
  }

  if (raw.resolvedDispatcher && typeof raw.resolvedDispatcher === 'object') {
    const dispatcher = {};
    const assign = (key) => {
      const num = Number(raw.resolvedDispatcher[key]);
      if (Number.isFinite(num) && num > 0) dispatcher[key] = Math.round(num);
    };
    assign('maxConcurrentJobsPerPeer');
    assign('inFlightWeight');
    assign('latencyWeight');
    assign('failureWeight');
    assign('reassignOnLagBlocks');
    assign('circuitBreakerThreshold');
    assign('circuitBreakerDurationMs');
    normalized.resolvedDispatcher = Object.keys(dispatcher).length ? dispatcher : null;
  }

  if (!normalized.selectedGatewayId && typeof raw.gatewayId === 'string') {
    const value = raw.gatewayId.trim();
    normalized.selectedGatewayId = value || null;
  }

  return normalized;
}

function withDefaults(raw = {}) {
  const normalized = normalizeSettings(raw);
  const merged = { ...DEFAULT_SETTINGS, ...normalized };

  if (!merged.preferredBaseUrl) {
    merged.preferredBaseUrl = DEFAULT_SETTINGS.preferredBaseUrl;
  }

  if (normalized.enabled === false && (!normalized.sharedSecret || normalized.sharedSecret.length === 0) && (normalized.selectionMode || 'default') !== 'manual') {
    merged.enabled = true;
  }

  const hasLegacySecret = typeof normalized.sharedSecret === 'string' && normalized.sharedSecret.trim().length > 0;

  if (!merged.selectionMode || !VALID_SELECTION_MODES.has(merged.selectionMode)) {
    if ((merged.baseUrl && merged.baseUrl !== DEFAULT_SETTINGS.baseUrl) || hasLegacySecret) {
      merged.selectionMode = 'manual';
    } else {
      merged.selectionMode = 'default';
    }
  }

  if (merged.selectionMode === 'default') {
    merged.selectedGatewayId = null;
    merged.preferredBaseUrl = merged.preferredBaseUrl || DEFAULT_SETTINGS.preferredBaseUrl;
    merged.baseUrl = merged.preferredBaseUrl || DEFAULT_SETTINGS.baseUrl;
  }

  if (merged.selectionMode === 'manual') {
    merged.baseUrl = merged.baseUrl || merged.preferredBaseUrl || DEFAULT_SETTINGS.baseUrl;
    merged.preferredBaseUrl = merged.baseUrl || merged.preferredBaseUrl || DEFAULT_SETTINGS.preferredBaseUrl;
  }

  if (merged.selectionMode !== 'discovered') {
    merged.resolvedGatewayId = null;
    merged.resolvedSecretVersion = null;
    merged.resolvedSharedSecretHash = null;
    merged.resolvedDisplayName = null;
    merged.resolvedRegion = null;
    merged.resolvedWsUrl = null;
    merged.resolvedAt = null;
    merged.resolvedGatewayRelay = null;
    merged.resolvedDefaultTokenTtl = null;
    merged.resolvedTokenRefreshWindowSeconds = null;
    merged.resolvedDispatcher = null;
  }

  if (!merged.baseUrl) merged.baseUrl = DEFAULT_SETTINGS.baseUrl;
  if (!merged.sharedSecret) merged.sharedSecret = '';
  if (!Number.isFinite(merged.defaultTokenTtl) || merged.defaultTokenTtl <= 0) {
    merged.defaultTokenTtl = DEFAULT_SETTINGS.defaultTokenTtl;
  }
  if (!Number.isFinite(merged.tokenRefreshWindowSeconds) || merged.tokenRefreshWindowSeconds <= 0) {
    merged.tokenRefreshWindowSeconds = DEFAULT_SETTINGS.tokenRefreshWindowSeconds;
  }

  const ensurePositive = (field, fallback) => {
    if (!Number.isFinite(merged[field]) || merged[field] <= 0) {
      merged[field] = fallback;
    }
  };

  ensurePositive('dispatcherMaxConcurrent', DEFAULT_SETTINGS.dispatcherMaxConcurrent);
  ensurePositive('dispatcherInFlightWeight', DEFAULT_SETTINGS.dispatcherInFlightWeight);
  ensurePositive('dispatcherLatencyWeight', DEFAULT_SETTINGS.dispatcherLatencyWeight);
  ensurePositive('dispatcherFailureWeight', DEFAULT_SETTINGS.dispatcherFailureWeight);
  ensurePositive('dispatcherReassignLagBlocks', DEFAULT_SETTINGS.dispatcherReassignLagBlocks);
  ensurePositive('dispatcherCircuitBreakerThreshold', DEFAULT_SETTINGS.dispatcherCircuitBreakerThreshold);
  ensurePositive('dispatcherCircuitBreakerTimeoutMs', DEFAULT_SETTINGS.dispatcherCircuitBreakerTimeoutMs);

  const sanitizeString = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  };

  merged.blindPeerEnabled = !!merged.blindPeerEnabled;
  merged.blindPeerKeys = Array.isArray(merged.blindPeerKeys)
    ? Array.from(new Set(merged.blindPeerKeys.map(sanitizeString).filter(Boolean)))
    : [];
  merged.blindPeerEncryptionKey = sanitizeString(merged.blindPeerEncryptionKey);
  merged.blindPeerReplicationTopic = sanitizeString(merged.blindPeerReplicationTopic);
  if (!Number.isFinite(merged.blindPeerMaxBytes) || merged.blindPeerMaxBytes <= 0) {
    merged.blindPeerMaxBytes = null;
  } else {
    merged.blindPeerMaxBytes = Math.trunc(merged.blindPeerMaxBytes);
  }

  if (!merged.resolvedGatewayRelay) {
    merged.resolvedGatewayRelay = null;
  }
  if (!Number.isFinite(merged.resolvedDefaultTokenTtl) || merged.resolvedDefaultTokenTtl <= 0) {
    merged.resolvedDefaultTokenTtl = null;
  }
  if (!Number.isFinite(merged.resolvedTokenRefreshWindowSeconds) || merged.resolvedTokenRefreshWindowSeconds <= 0) {
    merged.resolvedTokenRefreshWindowSeconds = null;
  }
  if (merged.resolvedDispatcher && typeof merged.resolvedDispatcher === 'object') {
    const dispatcher = {};
    const assign = (key) => {
      const num = Number(merged.resolvedDispatcher[key]);
      if (Number.isFinite(num) && num > 0) dispatcher[key] = Math.round(num);
    };
    assign('maxConcurrentJobsPerPeer');
    assign('inFlightWeight');
    assign('latencyWeight');
    assign('failureWeight');
    assign('reassignOnLagBlocks');
    assign('circuitBreakerThreshold');
    assign('circuitBreakerDurationMs');
    merged.resolvedDispatcher = Object.keys(dispatcher).length ? dispatcher : null;
  } else {
    merged.resolvedDispatcher = null;
  }

  return merged;
}

async function getNodeFs() {
  if (!nodeFsModule) {
    nodeFsModule = await import('node:fs/promises');
  }
  return nodeFsModule;
}

async function getNodePath() {
  if (!nodePathModule) {
    nodePathModule = await import('node:path');
  }
  return nodePathModule;
}

async function resolveNodeSettingsPath() {
  if (nodeSettingsPath) return nodeSettingsPath;
  const pathModule = await getNodePath();
  const explicit = process.env.PUBLIC_GATEWAY_SETTINGS_PATH;
  if (explicit) {
    nodeSettingsPath = explicit;
    return nodeSettingsPath;
  }
  const baseDir = process.env.STORAGE_DIR || process.cwd();
  nodeSettingsPath = pathModule.join(baseDir, SETTINGS_FILENAME);
  return nodeSettingsPath;
}

async function loadNodeSettings() {
  if (!isNodeProcess()) return null;
  try {
    const fs = await getNodeFs();
    const filePath = await resolveNodeSettingsPath();
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.error('[PublicGatewaySettings] Failed to read settings file:', error);
    }
    return null;
  }
}

async function saveNodeSettings(settings) {
  if (!isNodeProcess()) return;
  const fs = await getNodeFs();
  const pathModule = await getNodePath();
  const filePath = await resolveNodeSettingsPath();
  const dir = pathModule.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8');
}

function loadRendererSettings() {
  if (!isRenderer() || typeof localStorage === 'undefined') return null;
  try {
    const serialized = localStorage.getItem(LOCAL_STORAGE_KEY);
    return serialized ? JSON.parse(serialized) : null;
  } catch (error) {
    console.warn('[PublicGatewaySettings] Failed to parse renderer storage:', error);
    return null;
  }
}

function saveRendererSettings(settings) {
  if (!isRenderer() || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('[PublicGatewaySettings] Failed to persist renderer storage:', error);
  }
}

export async function loadPublicGatewaySettings() {
  if (cachedSettings) return cachedSettings;

  if (isRenderer()) {
    const stored = loadRendererSettings();
    cachedSettings = withDefaults(stored || {});
    return cachedSettings;
  }

  const stored = await loadNodeSettings();
  cachedSettings = withDefaults(stored || {});
  return cachedSettings;
}

export async function updatePublicGatewaySettings(partial = {}) {
  const next = withDefaults({ ...(cachedSettings || DEFAULT_SETTINGS), ...partial });
  cachedSettings = next;

  if (isRenderer()) {
    saveRendererSettings(next);
    return next;
  }

  await saveNodeSettings(next);
  return next;
}

export function getCachedPublicGatewaySettings() {
  if (!cachedSettings) return { ...DEFAULT_SETTINGS };
  return { ...cachedSettings };
}

export function clearCachedPublicGatewaySettings() {
  cachedSettings = null;
}

export function normalizePublicGatewaySettings(raw = {}) {
  return withDefaults(raw);
}
