// Set Node-like globals before loading any other modules
import './shims.js';

import './style.css';
import '@desktop/styles.css';

import { installWebShims, summarizeBrowserSupport } from './support/env.js';
import { getNostrClient, sharedModules } from './support/client.js';
import { TokenManager } from './state/tokenManager.js';
import {
  loadPublicGatewaySettings,
  updatePublicGatewaySettings,
  getCachedPublicGatewaySettings
} from '@shared/config/PublicGatewaySettings.mjs';
import { NostrUtils } from '@desktop/NostrUtils.js';
import { postTelemetry, getClientId } from './telemetry.js';

installWebShims();

const { support, warnings } = summarizeBrowserSupport();
const client = getNostrClient({ debug: false });

const state = {
  user: {
    privkey: null,
    pubkey: null,
    nsec: null,
    error: null
  },
  settings: {
    baseUrl: '',
    sharedSecret: '',
    defaultTokenTtl: 3600,
    tokenRefreshWindowSeconds: 300
  },
  tokens: {
    relayKey: '',
    relayAuthToken: '',
    lastIssued: null,
    error: null
  },
  connection: {
    discoveryUrl: '',
    status: 'disconnected',
    lastError: null
  },
  network: {
    online: typeof navigator !== 'undefined' ? navigator.onLine : true
  },
  groups: {},
  members: {},
  messages: {},
  selectedGroup: null,
  profileDraft: {
    name: '',
    about: '',
    picture: ''
  },
  followsDraft: '',
  telemetry: {
    replicationMirrors: 0,
    replicationMirrorErrors: 0,
    secretSnapshots: 0,
    secretSnapshotErrors: 0,
    sentAt: null,
    clientId: null
  }
};

const tokenManager = new TokenManager({
  sharedSecret: '',
  baseUrl: '',
  defaultTtlSeconds: 3600
});

async function init() {
  const app = document.querySelector('#app');
  if (!app) return;

  await hydrateSettings();
  attachNetworkListeners();
  state.telemetry.clientId = getClientId(state.telemetry.clientId);
  render(app);
  bindEvents(app);

  // Expose for debugging/development
  if (typeof window !== 'undefined') {
    window.hypertunaWeb = {
      client,
      support,
      modules: sharedModules,
      tokenManager,
      state
    };
  }
}

function render(app) {
  app.innerHTML = `
    <main class="web-shell">
      <header>
        <div>
          <div class="badge">Public Gateway</div>
          <h1>Hypertuna Web Client</h1>
        </div>
        <div class="pill muted">Pass B – Auth & Settings</div>
      </header>

      <section class="card">
        <h2>Environment</h2>
        <p>Browser-targeted build using shared desktop modules. Worker IPC and file uploads are disabled in this context.</p>
        <ul class="status-list">
          <li>
            <span class="status-dot ${support.webSockets ? 'dot-ok' : 'dot-error'}"></span>
            <span>WebSocket API</span>
            <span class="pill">${support.webSockets ? 'available' : 'missing'}</span>
          </li>
          <li>
            <span class="status-dot ${support.webCrypto ? 'dot-ok' : 'dot-warn'}"></span>
            <span>WebCrypto</span>
            <span class="pill">${support.webCrypto ? 'ready' : 'limited'}</span>
          </li>
          <li>
            <span class="status-dot ${support.indexedDB ? 'dot-ok' : 'dot-warn'}"></span>
            <span>IndexedDB cache</span>
            <span class="pill">${support.indexedDB ? 'enabled' : 'in-memory only'}</span>
          </li>
        </ul>
        ${warnings.length
          ? `<p class="muted">${warnings.join(' ')}</p>`
          : '<p class="muted">All baseline browser checks passed.</p>'
        }
        <div class="pill ${state.network.online ? '' : 'error'}">Network: ${state.network.online ? 'online' : 'offline'}</div>
      </section>

      <section class="card">
        <h2>Gateway Settings</h2>
        <div class="form-grid">
          <div class="input-group">
            <label for="base-url">Gateway Base URL</label>
            <input id="base-url" name="base-url" type="url" autocomplete="url" value="${escapeHtml(state.settings.baseUrl)}" placeholder="https://hypertuna.com">
          </div>
          <div class="input-group">
            <label for="shared-secret">Shared Secret (for token signing)</label>
            <input id="shared-secret" name="shared-secret" type="text" autocomplete="off" value="${escapeHtml(state.settings.sharedSecret)}" placeholder="hex or string">
          </div>
          <div class="row">
            <div class="input-group half">
              <label for="default-ttl">Default Token TTL (seconds)</label>
              <input id="default-ttl" name="default-ttl" type="number" min="60" step="60" value="${state.settings.defaultTokenTtl}">
            </div>
            <div class="input-group half">
              <label for="refresh-window">Refresh Window (seconds)</label>
              <input id="refresh-window" name="refresh-window" type="number" min="60" step="30" value="${state.settings.tokenRefreshWindowSeconds}">
            </div>
          </div>
          <div class="row">
            <button id="save-settings" class="btn" type="button">Save Settings</button>
            <div id="settings-status" class="status muted"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Nostr Login</h2>
        <div class="form-grid">
          <div class="input-group">
            <label for="nostr-key">Private Key (nsec or hex)</label>
            <input id="nostr-key" name="nostr-key" type="password" autocomplete="off" placeholder="nsec1..." />
          </div>
          <div class="row">
            <button id="login-btn" class="btn" type="button">Load Key</button>
            <div id="login-status" class="status muted"></div>
          </div>
          <div class="stack">
            <div class="pill">Pubkey: <span id="pubkey-display">${state.user.pubkey ? escapeHtml(state.user.pubkey) : '—'}</span></div>
            <div class="pill">nsec: <span id="nsec-display">${state.user.nsec ? escapeHtml(state.user.nsec) : '—'}</span></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Connection</h2>
        <p class="muted">Connect to the gateway relay using your key + tokenized URL (if provided).</p>
        <div class="row">
          <button id="connect-btn" class="btn" type="button">Connect</button>
          <div id="connect-status" class="status ${state.connection.lastError ? 'error' : 'muted'}">
            ${state.connection.lastError
              ? `Error: ${escapeHtml(state.connection.lastError)}`
              : `Status: ${state.connection.status}${state.connection.discoveryUrl ? ` (${escapeHtml(state.connection.discoveryUrl)})` : ''}`}
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Profile (kind 0)</h2>
        <div class="form-grid">
          <div class="input-group">
            <label for="profile-name">Display Name</label>
            <input id="profile-name" type="text" value="${escapeHtml(state.profileDraft.name)}" placeholder="name">
          </div>
          <div class="input-group">
            <label for="profile-about">About</label>
            <textarea id="profile-about" placeholder="bio">${escapeHtml(state.profileDraft.about)}</textarea>
          </div>
          <div class="input-group">
            <label for="profile-picture">Picture URL</label>
            <input id="profile-picture" type="url" value="${escapeHtml(state.profileDraft.picture)}" placeholder="https://...">
          </div>
          <div class="row">
            <button id="save-profile" class="btn" type="button">Publish Profile</button>
            <div id="profile-status" class="status muted"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Follows (kind 3)</h2>
        <p class="muted">Enter npubs or hex pubkeys (comma/space separated) to set a contact list. This overwrites the current contact list.</p>
        <div class="form-grid">
          <div class="input-group">
            <label for="follows-input">Pubkeys</label>
            <textarea id="follows-input" placeholder="npub1..., npub1..., hex...">${escapeHtml(state.followsDraft)}</textarea>
          </div>
          <div class="row">
            <button id="save-follows" class="btn secondary" type="button">Publish Follows</button>
            <div id="follows-status" class="status muted"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Gateway Tokens</h2>
        <p class="muted">Issue/refresh relay tokens via the gateway using the shared secret. Tokens will auto-refresh ~80% into their TTL.</p>
        <div class="form-grid">
          <div class="input-group">
            <label for="relay-key">Relay Key</label>
            <input id="relay-key" name="relay-key" type="text" value="${escapeHtml(state.tokens.relayKey)}" placeholder="relay:identifier or colon path">
          </div>
          <div class="input-group">
            <label for="relay-auth-token">Relay Auth Token</label>
            <input id="relay-auth-token" name="relay-auth-token" type="text" value="${escapeHtml(state.tokens.relayAuthToken)}" placeholder="Provided by relay membership/registration">
          </div>
          <div class="row">
            <button id="issue-token" class="btn" type="button">Issue Token</button>
            <button id="refresh-token" class="btn secondary" type="button">Refresh Token</button>
          </div>
          <div class="stack">
            <div id="token-status" class="status muted">No token issued yet.</div>
            <div class="pill">Signed relay URL: <span id="relay-url-display">${escapeHtml(tokenManager.getRelayUrl(state.tokens.relayKey) || '—')}</span></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Groups</h2>
        <p class="muted">Read-only view: lists discovered groups and latest messages. Create/join/uploads/worker actions are hidden in web.</p>
        <div class="row align-start">
          <div class="half">
            ${renderGroupsList()}
          </div>
          <div class="half">
            ${renderGroupDetail()}
          </div>
        </div>
        <div class="stack">
          <div class="pill">Replication mirrors: ${state.telemetry.replicationMirrors}</div>
          <div class="pill">Replication mirror errors: ${state.telemetry.replicationMirrorErrors}</div>
          <div class="pill">Secret snapshots: ${state.telemetry.secretSnapshots}</div>
          <div class="pill">Secret snapshot errors: ${state.telemetry.secretSnapshotErrors}</div>
          <div class="pill">Client ID: ${state.telemetry.clientId || '—'}</div>
        </div>
      </section>
    </main>
  `;
}

function bindEvents(app) {
  const settingsBtn = app.querySelector('#save-settings');
  const loginBtn = app.querySelector('#login-btn');
  const issueBtn = app.querySelector('#issue-token');
  const refreshBtn = app.querySelector('#refresh-token');
  const connectBtn = app.querySelector('#connect-btn');
  const saveProfileBtn = app.querySelector('#save-profile');
  const saveFollowsBtn = app.querySelector('#save-follows');
  const sendMsgBtn = app.querySelector('#send-msg');

  settingsBtn?.addEventListener('click', onSaveSettings);
  loginBtn?.addEventListener('click', onLogin);
  issueBtn?.addEventListener('click', onIssueToken);
  refreshBtn?.addEventListener('click', onRefreshToken);
  connectBtn?.addEventListener('click', onConnect);
  saveProfileBtn?.addEventListener('click', onSaveProfile);
  saveFollowsBtn?.addEventListener('click', onSaveFollows);
  sendMsgBtn?.addEventListener('click', onSendMessage);

  app.querySelectorAll('[data-group-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const gid = el.getAttribute('data-group-id');
      state.selectedGroup = gid;
      render(app);
      bindEvents(app);
    });
  });

  // Disable publish buttons when offline
  const disableWhenOffline = [saveProfileBtn, saveFollowsBtn, issueBtn, refreshBtn, connectBtn, sendMsgBtn];
  disableWhenOffline.forEach((btn) => {
    if (!btn) return;
    btn.disabled = !state.network.online;
    btn.title = state.network.online ? '' : 'Gateway unreachable (offline)';
  });
}

function attachNetworkListeners() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => {
    state.network.online = true;
    maybeSendTelemetry();
    rerender();
  });
  window.addEventListener('offline', () => {
    state.network.online = false;
    maybeSendTelemetry();
    rerender();
  });
}

async function hydrateSettings() {
  try {
    const settings = await loadPublicGatewaySettings();
    state.settings.baseUrl = settings.baseUrl || settings.preferredBaseUrl || 'https://hypertuna.com';
    state.settings.sharedSecret = settings.sharedSecret || '';
    state.settings.defaultTokenTtl = Number(settings.defaultTokenTtl) || 3600;
    state.settings.tokenRefreshWindowSeconds = Number(settings.tokenRefreshWindowSeconds) || 300;
    tokenManager.updateConfig({
      sharedSecret: state.settings.sharedSecret,
      baseUrl: state.settings.baseUrl,
      defaultTtlSeconds: state.settings.defaultTokenTtl
    });
  } catch (error) {
    console.warn('[web] Failed to hydrate gateway settings', error);
  }
}

function computeDiscoveryRelayUrl() {
  return tokenManager.getRelayUrl(state.tokens.relayKey || null)
    || `${(state.settings.baseUrl || 'https://hypertuna.com').replace(/\/+$/, '')}/relay`;
}

async function onSaveSettings() {
  const statusEl = document.querySelector('#settings-status');
  if (statusEl) statusEl.textContent = 'Saving...';
  const baseUrl = document.querySelector('#base-url')?.value?.trim() || '';
  const sharedSecret = document.querySelector('#shared-secret')?.value?.trim() || '';
  const defaultTtl = Number(document.querySelector('#default-ttl')?.value) || state.settings.defaultTokenTtl;
  const refreshWindow = Number(document.querySelector('#refresh-window')?.value) || state.settings.tokenRefreshWindowSeconds;

  try {
    const next = await updatePublicGatewaySettings({
      baseUrl,
      preferredBaseUrl: baseUrl,
      sharedSecret,
      defaultTokenTtl: defaultTtl,
      tokenRefreshWindowSeconds: refreshWindow
    });
    const normalized = getCachedPublicGatewaySettings();
    state.settings.baseUrl = normalized.baseUrl || next.baseUrl || baseUrl;
    state.settings.sharedSecret = normalized.sharedSecret || sharedSecret;
    state.settings.defaultTokenTtl = Number(normalized.defaultTokenTtl) || defaultTtl;
    state.settings.tokenRefreshWindowSeconds = Number(normalized.tokenRefreshWindowSeconds) || refreshWindow;
    tokenManager.updateConfig({
      sharedSecret: state.settings.sharedSecret,
      baseUrl: state.settings.baseUrl,
      defaultTtlSeconds: state.settings.defaultTokenTtl
    });
    state.connection.discoveryUrl = computeDiscoveryRelayUrl();
    if (statusEl) {
      statusEl.textContent = 'Settings saved.';
      statusEl.className = 'status success';
    }
    updateRelayUrlText();
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `Save failed: ${error?.message || error}`;
      statusEl.className = 'status error';
    }
  }
}

async function onLogin() {
  const statusEl = document.querySelector('#login-status');
  const input = document.querySelector('#nostr-key');
  if (statusEl) {
    statusEl.textContent = '';
    statusEl.className = 'status muted';
  }
  const raw = input?.value?.trim();
  if (!raw) {
    if (statusEl) statusEl.textContent = 'Enter a private key.';
    return;
  }
  try {
    const privkey = normalizePrivkey(raw);
    if (!privkey) throw new Error('Invalid key');
    const pubkey = NostrUtils.getPublicKey(privkey);
    const nsec = NostrUtils.hexToNsec(privkey);
    state.user.privkey = privkey;
    state.user.pubkey = pubkey;
    state.user.nsec = nsec;
    state.user.error = null;
    setText('#pubkey-display', pubkey);
    setText('#nsec-display', nsec);
    if (statusEl) {
      statusEl.textContent = 'Key loaded.';
      statusEl.className = 'status success';
    }
  } catch (error) {
    state.user.error = error?.message || String(error);
    if (statusEl) {
      statusEl.textContent = `Error: ${state.user.error}`;
      statusEl.className = 'status error';
    }
  }
}

async function onIssueToken() {
  const relayKey = document.querySelector('#relay-key')?.value?.trim();
  const relayAuthToken = document.querySelector('#relay-auth-token')?.value?.trim();
  const statusEl = document.querySelector('#token-status');
  if (statusEl) {
    statusEl.textContent = 'Issuing token...';
    statusEl.className = 'status muted';
  }
  if (!relayKey || !relayAuthToken) {
    if (statusEl) {
      statusEl.textContent = 'Relay key and relay auth token are required.';
      statusEl.className = 'status error';
    }
    return;
  }
  try {
    state.tokens.relayKey = relayKey;
    state.tokens.relayAuthToken = relayAuthToken;
    const result = await tokenManager.issueToken({
      relayKey,
      relayAuthToken,
      pubkey: state.user.pubkey || null
    });
    state.tokens.lastIssued = result;
    if (statusEl) {
      statusEl.textContent = `Token issued. Expires ${formatTs(result.expiresAt)} (seq ${result.sequence || '?'})`;
      statusEl.className = 'status success';
    }
    if (state.tokens.relayKey && result?.token && client?.relayAuthTokens) {
      client.relayAuthTokens.set(state.tokens.relayKey, result.token);
    }
    updateRelayUrlText();
  } catch (error) {
    state.tokens.error = error?.message || String(error);
    if (statusEl) {
      statusEl.textContent = `Issue failed: ${state.tokens.error}`;
      statusEl.className = 'status error';
    }
  }
}

async function onRefreshToken() {
  const relayKey = document.querySelector('#relay-key')?.value?.trim();
  const statusEl = document.querySelector('#token-status');
  if (statusEl) {
    statusEl.textContent = 'Refreshing token...';
    statusEl.className = 'status muted';
  }
  if (!relayKey) {
    if (statusEl) {
      statusEl.textContent = 'Relay key is required.';
      statusEl.className = 'status error';
    }
    return;
  }
  try {
    const result = await tokenManager.refreshToken(relayKey);
    state.tokens.lastIssued = result;
    if (statusEl) {
      statusEl.textContent = `Token refreshed. Expires ${formatTs(result.expiresAt)} (seq ${result.sequence || '?'})`;
      statusEl.className = 'status success';
    }
    if (state.tokens.relayKey && result?.token && client?.relayAuthTokens) {
      client.relayAuthTokens.set(state.tokens.relayKey, result.token);
    }
    updateRelayUrlText();
  } catch (error) {
    state.tokens.error = error?.message || String(error);
    if (statusEl) {
      statusEl.textContent = `Refresh failed: ${state.tokens.error}`;
      statusEl.className = 'status error';
    }
  }
}

function updateRelayUrlText() {
  const target = document.querySelector('#relay-url-display');
  if (!target) return;
  target.textContent = tokenManager.getRelayUrl(state.tokens.relayKey) || '—';
}

async function onSaveProfile() {
  const statusEl = document.querySelector('#profile-status');
  const name = document.querySelector('#profile-name')?.value || '';
  const about = document.querySelector('#profile-about')?.value || '';
  const picture = document.querySelector('#profile-picture')?.value || '';
  state.profileDraft = { name, about, picture };
  if (!state.user.privkey || !state.user.pubkey) {
    setStatus(statusEl, 'Load your nostr key first.', true);
    return;
  }
  try {
    setStatus(statusEl, 'Publishing profile...', false);
    await client.updateProfile({ name, about, picture }, {});
    setStatus(statusEl, 'Profile published.', false, true);
  } catch (error) {
    setStatus(statusEl, `Profile publish failed: ${error?.message || error}`, true);
  }
}

async function onSaveFollows() {
  const statusEl = document.querySelector('#follows-status');
  const raw = document.querySelector('#follows-input')?.value || '';
  state.followsDraft = raw;
  if (!state.user.privkey || !state.user.pubkey) {
    setStatus(statusEl, 'Load your nostr key first.', true);
    return;
  }
  const list = parsePubkeys(raw);
  if (!list.length) {
    setStatus(statusEl, 'Enter at least one pubkey.', true);
    return;
  }
  try {
    setStatus(statusEl, 'Publishing follows...', false);
    const tags = list.map((pk) => ['p', pk]);
    const event = await NostrEvents.createEvent(3, '', tags, state.user.privkey);
    await client.relayManager.publish(event);
    setStatus(statusEl, `Follows published (${list.length}).`, false, true);
  } catch (error) {
    setStatus(statusEl, `Follows publish failed: ${error?.message || error}`, true);
  }
}

async function onSendMessage() {
  const gid = state.selectedGroup;
  const statusEl = document.querySelector('#msg-status');
  if (!gid || !state.groups[gid]) {
    setStatus(statusEl, 'Select a group first.', true);
    return;
  }
  if (!state.user.privkey || !state.user.pubkey) {
    setStatus(statusEl, 'Load your nostr key first.', true);
    return;
  }
  if (!state.network.online) {
    setStatus(statusEl, 'gateway unreachable (offline)', true);
    return;
  }
  const input = document.querySelector('#msg-input');
  const content = input?.value?.trim() || '';
  if (!content) {
    setStatus(statusEl, 'Message cannot be empty.', true);
    return;
  }
  const relayUrl = state.groups[gid].relayUrl || computeDiscoveryRelayUrl();
  try {
    setStatus(statusEl, 'Sending...', false);
    const event = await NostrEvents.createGroupMessage(gid, content, [], state.user.privkey, null, gid);
    await client.relayManager.publishToRelays(event, [relayUrl]);
    try {
      client.ensureSecretSubscription?.(gid);
      await client.publishReplicationEvent?.(event, gid);
      state.telemetry.replicationMirrors += 1;
      maybeSendTelemetry();
    } catch (err) {
      state.telemetry.replicationMirrorErrors += 1;
      console.warn('[web] replication mirror failed', err?.message || err);
      maybeSendTelemetry();
    }
    // optimistic add
    if (!state.messages[gid]) state.messages[gid] = [];
    state.messages[gid].unshift(event);
    input.value = '';
    setStatus(statusEl, 'Sent.', false, true);
    rerender();
  } catch (error) {
    setStatus(statusEl, `Send failed: ${error?.message || error}`, true);
  }
}

function normalizePrivkey(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('nsec')) {
    return NostrUtils.nsecToHex(trimmed);
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value || '—';
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTs(ts) {
  if (!Number.isFinite(ts)) return 'unknown';
  try {
    return new Date(ts).toLocaleString();
  } catch (_) {
    return String(ts);
  }
}

function setStatus(el, text, isError = false, isSuccess = false) {
  if (!el) return;
  el.textContent = text;
  el.className = `status ${isError ? 'error' : isSuccess ? 'success' : 'muted'}`;
}

function parsePubkeys(raw) {
  return (raw || '')
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith('npub') ? NostrUtils.npubToHex(v) : v))
    .filter((v) => /^[0-9a-fA-F]{64}$/.test(v));
}

function ensureReplicationForGroup(groupId) {
  if (!client || !groupId) return;
  const group = state.groups[groupId];
  if (!group || group.encryptedReplication === false) return;
  if (!state.user.privkey || !state.user.pubkey) return;
  try {
    client.ensureSecretSubscription?.(groupId);
    client._subscribeToReplicationFallback?.(groupId);
    maybeSendTelemetry();
  } catch (error) {
    console.warn('[web] ensureReplicationForGroup failed', error?.message || error);
  }
}

let telemetryTimer = null;
function maybeSendTelemetry() {
  if (!state.settings.baseUrl || !state.telemetry.clientId) return;
  if (telemetryTimer) {
    clearTimeout(telemetryTimer);
  }
  telemetryTimer = setTimeout(async () => {
    telemetryTimer = null;
    const payload = {
      clientId: state.telemetry.clientId,
      online: state.network.online,
      replicationMirrors: state.telemetry.replicationMirrors,
      replicationMirrorErrors: state.telemetry.replicationMirrorErrors,
      secretSnapshots: state.telemetry.secretSnapshots,
      secretSnapshotErrors: state.telemetry.secretSnapshotErrors,
      sentAt: Date.now()
    };
    await postTelemetry(state.settings.baseUrl, payload);
    state.telemetry.sentAt = payload.sentAt;
  }, 300);
}

async function onConnect() {
  const statusEl = document.querySelector('#connect-status');
  if (!state.user.privkey || !state.user.pubkey) {
    if (statusEl) {
      statusEl.textContent = 'Load your nostr key before connecting.';
      statusEl.className = 'status error';
    }
    return;
  }
  state.connection.status = 'connecting';
  state.connection.lastError = null;
  state.connection.discoveryUrl = computeDiscoveryRelayUrl();
  updateConnectStatus(statusEl);

  try {
    attachClientListenersOnce();
    if (state.tokens.relayKey && tokenManager.tokens.has(state.tokens.relayKey)) {
      const t = tokenManager.tokens.get(state.tokens.relayKey);
      if (t?.token && client?.relayAuthTokens) {
        client.relayAuthTokens.set(state.tokens.relayKey, t.token);
      }
    }
    await client.initWithDiscoveryRelays(
      { privateKey: state.user.privkey, pubkey: state.user.pubkey },
      [state.connection.discoveryUrl],
      {}
    );
    if (typeof client.setGatewayReady === 'function') {
      client.setGatewayReady(true);
    }
    state.connection.status = 'connected';
    state.connection.lastError = null;
    syncGroupsFromClient();
  } catch (error) {
    state.connection.status = 'error';
    state.connection.lastError = error?.message || String(error);
  } finally {
    updateConnectStatus(statusEl);
    render(document.querySelector('#app'));
    bindEvents(document.querySelector('#app'));
  }
}

function attachClientListenersOnce() {
  if (client.__webListenersAttached) return;
  client.__webListenersAttached = true;

  client.on('relay:connect', ({ relayUrl }) => {
    state.connection.status = 'connected';
    state.connection.discoveryUrl = relayUrl;
    rerender();
  });
  client.on('relay:disconnect', () => {
    state.connection.status = 'disconnected';
    rerender();
  });
  client.on('group:metadata', ({ groupId, group }) => {
    upsertGroup(groupId, group);
    rerender();
  });
  client.on('group:members', ({ groupId, members }) => {
    if (!groupId || !Array.isArray(members)) return;
    state.members[groupId] = members;
    rerender();
  });
  client.on('group:message', ({ groupId, message }) => {
    if (!groupId || !message) return;
    if (!state.messages[groupId]) state.messages[groupId] = [];
    state.messages[groupId].unshift(message);
    state.messages[groupId] = state.messages[groupId].slice(0, 20);
    rerender();
  });
  client.on('relaylist:update', () => {
    syncGroupsFromClient();
    rerender();
  });
}

function updateConnectStatus(el) {
  if (!el) return;
  if (state.connection.lastError) {
    el.textContent = `Error: ${state.connection.lastError}`;
    el.className = 'status error';
  } else {
    el.textContent = `Status: ${state.connection.status}${state.connection.discoveryUrl ? ` (${state.connection.discoveryUrl})` : ''}`;
    el.className = 'status muted';
  }
}

function syncGroupsFromClient() {
  if (!client || !client.groups) return;
  client.groups.forEach((group, id) => {
    upsertGroup(id, group);
  });
}

function upsertGroup(groupId, group) {
  if (!groupId || !group) return;
  state.groups[groupId] = {
    id: groupId,
    name: group.name || group.title || groupId,
    about: group.about || '',
    relayUrl: group.relayUrl || group.relay || '',
    encryptedReplication: group.encryptedReplication !== false
  };
  if (!state.selectedGroup) {
    state.selectedGroup = groupId;
  }
  ensureReplicationForGroup(groupId);
}

function renderGroupsList() {
  const entries = Object.values(state.groups);
  if (!entries.length) {
    return '<p class="muted">No groups discovered yet.</p>';
  }
  return `
    <div class="stack">
      ${entries.map((g) => `
        <button class="btn secondary justify-start" type="button" data-group-id="${escapeHtml(g.id)}">
          <div class="text-left">
            <div><strong>${escapeHtml(g.name)}</strong></div>
            <div class="muted text-xs">${escapeHtml(g.id)}</div>
          </div>
        </button>
      `).join('')}
    </div>
  `;
}

function renderGroupDetail() {
  const gid = state.selectedGroup;
  if (!gid || !state.groups[gid]) {
    return '<p class="muted">Select a group to view details.</p>';
  }
  const g = state.groups[gid];
  const members = state.members[gid] || [];
  const messages = state.messages[gid] || [];
  return `
    <div class="stack">
      <div class="pill">Relay: ${escapeHtml(g.relayUrl || 'gateway')}</div>
      <div class="pill">Replication: ${g.encryptedReplication ? 'enabled' : 'disabled (read-only)'}</div>
      <p>${escapeHtml(g.about || 'No description')}</p>
      <div class="input-group">
        <label for="msg-input">Send message (kind 1)</label>
        <textarea id="msg-input" placeholder="Write a message to ${escapeHtml(g.name)}"></textarea>
        <div class="row">
          <button id="send-msg" class="btn" type="button">Send</button>
          <div id="msg-status" class="status muted"></div>
        </div>
      </div>
      <div><strong>Members (${members.length})</strong></div>
      <ul class="status-list">
        ${members.slice(0, 10).map((m) => `<li>${escapeHtml(m.pubkey || m)}</li>`).join('') || '<li class="muted">No members yet.</li>'}
      </ul>
      <div><strong>Recent messages</strong></div>
      <ul class="status-list">
        ${messages.slice(0, 10).map((m) => `<li><span class="muted">kind ${m.kind} · ${formatTs(m.created_at * 1000 || Date.now())}</span><div>${escapeHtml(m.content || '')}</div></li>`).join('') || '<li class="muted">No messages yet.</li>'}
      </ul>
    </div>
  `;
}

function rerender() {
  const app = document.querySelector('#app');
  if (!app) return;
  render(app);
  bindEvents(app);
}

init().catch((error) => {
  console.error('[web] Failed to initialize web client', error);
});
