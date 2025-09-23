const DEFAULT_SETTINGS = Object.freeze({
  gatewayUrl: 'https://hypertuna.com',
  proxyHost: 'hypertuna.com'
});

const LOCAL_STORAGE_KEY = 'hypertuna_gateway_settings';
const SETTINGS_FILENAME = 'gateway-settings.json';

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

  if (typeof raw.gatewayUrl === 'string') {
    const trimmed = raw.gatewayUrl.trim();
    if (trimmed) {
      normalized.gatewayUrl = trimmed;
    }
  }

  if (typeof raw.proxyHost === 'string') {
    const trimmed = raw.proxyHost.trim();
    if (trimmed) {
      normalized.proxyHost = trimmed;
    }
  }

  return normalized;
}

function deriveProxyHost(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.hostname;
  } catch (_err) {
    const stripped = value.replace(/^https?:\/\//i, '').split('/')[0] || value;
    return stripped.trim();
  }
}

function withDefaults(raw = {}) {
  const normalized = normalizeSettings(raw);
  const merged = { ...DEFAULT_SETTINGS, ...normalized };

  if (!merged.proxyHost) {
    const derived = deriveProxyHost(merged.gatewayUrl);
    merged.proxyHost = derived || DEFAULT_SETTINGS.proxyHost;
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
  const explicitPath = process.env.GATEWAY_SETTINGS_PATH;
  if (explicitPath) {
    nodeSettingsPath = explicitPath;
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
      console.error('[GatewaySettings] Failed to read node settings file:', error);
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

function loadRendererLocalStorage() {
  if (!isRenderer() || typeof localStorage === 'undefined') return null;
  try {
    const serialized = localStorage.getItem(LOCAL_STORAGE_KEY);
    return serialized ? JSON.parse(serialized) : null;
  } catch (_err) {
    return null;
  }
}

function saveRendererLocalStorage(settings) {
  if (!isRenderer() || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
  } catch (_err) {
    // ignore storage failures
  }
}

export function getGatewayDefaults() {
  return { ...DEFAULT_SETTINGS };
}

export function getCachedGatewaySettings() {
  if (!cachedSettings) {
    return getGatewayDefaults();
  }
  return { ...cachedSettings };
}

export async function loadGatewaySettings() {
  if (cachedSettings) {
    return { ...cachedSettings };
  }

  let settings = null;

  if (isRenderer() && window?.electronAPI?.readGatewaySettings) {
    try {
      const result = await window.electronAPI.readGatewaySettings();
      if (result?.success && result.data) {
        settings = result.data;
      }
    } catch (error) {
      console.error('[GatewaySettings] Failed to load via electron bridge:', error);
    }
  }

  if (!settings && isRenderer()) {
    settings = loadRendererLocalStorage();
  }

  if (!settings) {
    settings = await loadNodeSettings();
  }

  cachedSettings = withDefaults(settings || {});

  if (isRenderer()) {
    saveRendererLocalStorage(cachedSettings);
  }

  return { ...cachedSettings };
}

export async function updateGatewaySettings(partial) {
  const current = await loadGatewaySettings();
  const next = withDefaults({ ...current, ...partial });

  if (isRenderer() && window?.electronAPI?.writeGatewaySettings) {
    try {
      const result = await window.electronAPI.writeGatewaySettings(next);
      if (!result?.success) {
        throw new Error(result?.error || 'writeGatewaySettings failed');
      }
    } catch (error) {
      console.error('[GatewaySettings] Failed to persist via electron bridge:', error);
      throw error;
    }
  } else if (isNodeProcess()) {
    await saveNodeSettings(next);
  } else {
    saveRendererLocalStorage(next);
  }

  cachedSettings = next;
  if (isRenderer()) {
    saveRendererLocalStorage(next);
  }

  return { ...cachedSettings };
}

export function deriveGatewayProxyHost(url) {
  return deriveProxyHost(url);
}

export function invalidateGatewaySettingsCache() {
  cachedSettings = null;
}
