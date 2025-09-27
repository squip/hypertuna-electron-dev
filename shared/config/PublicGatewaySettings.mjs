const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  baseUrl: '',
  sharedSecret: '',
  defaultTokenTtl: 3600
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

  if (typeof raw.baseUrl === 'string') {
    normalized.baseUrl = raw.baseUrl.trim();
  }

  if (typeof raw.sharedSecret === 'string') {
    normalized.sharedSecret = raw.sharedSecret.trim();
  }

  if (raw.defaultTokenTtl != null) {
    const ttl = Number(raw.defaultTokenTtl);
    if (Number.isFinite(ttl) && ttl > 0) {
      normalized.defaultTokenTtl = Math.round(ttl);
    }
  }

  return normalized;
}

function withDefaults(raw = {}) {
  const normalized = normalizeSettings(raw);
  const merged = { ...DEFAULT_SETTINGS, ...normalized };
  if (!merged.baseUrl) merged.baseUrl = '';
  if (!merged.sharedSecret) merged.sharedSecret = '';
  if (!Number.isFinite(merged.defaultTokenTtl) || merged.defaultTokenTtl <= 0) {
    merged.defaultTokenTtl = DEFAULT_SETTINGS.defaultTokenTtl;
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
