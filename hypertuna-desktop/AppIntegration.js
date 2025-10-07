/**
 * AppIntegration.js
 * Modifies the existing App to use real nostr relays
 * Enhanced with support for Hypertuna relay groups
 */

import NostrIntegration from './NostrIntegration.js';
import { NostrUtils } from './NostrUtils.js';
import { HypertunaUtils } from './HypertunaUtils.js';
import { ConfigLogger } from './ConfigLogger.js';
import NostrEvents from './NostrEvents.js';  // Add this import
import MembersList from './MembersList.js';
import { AvatarModal } from './AvatarModal.js';

const relayReadinessTracker = new Map(); // Track relay readiness state
const electronAPI = window.electronAPI || null;
const isElectron = !!electronAPI;
const ELECTRON_CONFIG_PATH = 'electron-storage/relay-config.json';

/**
 * This function modifies the existing App object to use real nostr relays
 * Call this function after the App has been initialized
 * @param {Object} App - The existing App object
 */
function integrateNostrRelays(App) {
    console.log('Integrating nostr relays with Hypertuna support...');
    
    let workerBridgeReadyPromise = null;
    const ensureWorkerBridgeReady = () => {
        if (typeof window.sendWorkerCommand === 'function') {
            return Promise.resolve();
        }
        if (workerBridgeReadyPromise) return workerBridgeReadyPromise;

        workerBridgeReadyPromise = new Promise((resolve) => {
            const handler = () => {
                if (typeof window.sendWorkerCommand === 'function') {
                    window.removeEventListener('worker-bridge-ready', handler);
                    resolve();
                }
            };
            window.addEventListener('worker-bridge-ready', handler);
            // In case the event already fired before we registered the listener
            setTimeout(handler, 0);
        });

        return workerBridgeReadyPromise;
    };

    const sendToWorkerQueued = async (message, options = {}) => {
        await ensureWorkerBridgeReady().catch(() => {});
        if (typeof window.sendWorkerCommand === 'function') {
            return window.sendWorkerCommand(message, options);
        }
        if (isElectron && electronAPI?.sendToWorker) {
            const result = await electronAPI.sendToWorker(message);
            if (result?.success === false && /Worker not running/i.test(result?.error || '')) {
                if (typeof window.startWorker === 'function') {
                    try { await window.startWorker(); } catch (_) {}
                }
                await ensureWorkerBridgeReady().catch(() => {});
                if (typeof window.sendWorkerCommand === 'function') {
                    return window.sendWorkerCommand(message, options);
                }
            }
            return result;
        }
        throw new Error('Worker messaging unavailable');
    };

    // Save original methods before replacing them - check if they exist first
    const originalMethods = {};
    
    // Define a list of methods to potentially save
    const methodsToSave = [
        'connectRelay', 'loadGroups', 'loadGroupDetails', 'loadGroupMessages',
        'loadGroupMembers', 'loadJoinRequests', 'createGroup', 'joinGroup', 'leaveGroup',
        'sendMessage', 'createInvite', 'addMember', 'updateMemberRole',
        'removeMember', 'approveJoinRequest', 'rejectJoinRequest', 'saveGroupSettings', 'deleteGroup', 'updateProfile',
        'login', 'generatePrivateKey', 'saveUserToLocalStorage', 
        'loadUserFromLocalStorage', 'updateProfileDisplay'
    ];
    
    // Save methods that exist
    methodsToSave.forEach(method => {
        if (typeof App[method] === 'function') {
            originalMethods[method] = App[method].bind(App);
        }
    });
    
    // Create nostr integration
    App.nostr = new NostrIntegration(App);

    App.gatewayPeerRelayMap = new Map();
    App.gatewayPeerDetails = new Map();
    App.publicGatewayState = null;
    App.relayGatewayCardInitialized = false;
    App.relayGatewayElements = {
        card: null,
        meta: null,
        stats: null,
        resyncBtn: null,
        ttlInput: null,
        generateBtn: null,
        tokenOutput: null,
        copyBtn: null,
        feedback: null,
        statusDot: null,
        headerCopyBtn: null
    };
    App.relayGatewayLastToken = null;
    App.currentGroupIsMember = false;

    // Track discovery relay connections displayed in profile UI
    App.discoveryRelays = new Map();
    App.discoveryRelayStorageKey = 'discovery_relay_whitelist';
    App.persistedDiscoveryRelays = [];

    App.pendingProfileAvatar = null;
    App.pendingCreateRelayAvatar = null;
    App.pendingEditRelayAvatar = null;

    App.resolveGroupAvatar = function(group) {
        if (!group) return null;
        const raw = group.picture || null;
        const isHypertuna = !!group.pictureIsHypertunaPfp;
        if (!raw) return null;
        return HypertunaUtils.resolvePfpUrl(raw, isHypertuna);
    };

    App.normalizeGatewayPath = function(identifier, metadata = null) {
        if (metadata && typeof metadata.gatewayPath === 'string' && metadata.gatewayPath.trim()) {
            return metadata.gatewayPath.replace(/^\//, '');
        }

        const legacyUrl = metadata?.connectionUrl;
        if (typeof legacyUrl === 'string' && legacyUrl.trim()) {
            try {
                const parsed = new URL(legacyUrl);
                const path = parsed.pathname.replace(/^\//, '');
                if (path) return path;
            } catch (_) {
                // ignore malformed legacy URL
            }
        }

        if (typeof identifier === 'string' && identifier.includes(':')) {
            return identifier.replace(':', '/');
        }

        return typeof identifier === 'string' ? identifier : null;
    };

    App.resolveLocalGatewayBase = async function() {
        let settings = null;
        try {
            settings = await HypertunaUtils.getGatewaySettings();
        } catch (_) {
            settings = null;
        }
        if (!settings || typeof settings !== 'object') {
            settings = HypertunaUtils.getCachedGatewaySettings() || {};
        }

        const protocol = settings.proxyWebsocketProtocol || settings.proxy_websocket_protocol || (() => {
            if (typeof settings.gatewayUrl === 'string') {
                try {
                    const parsed = new URL(settings.gatewayUrl);
                    return parsed.protocol === 'http:' ? 'ws' : 'wss';
                } catch (_) {}
            }
            return 'ws';
        })();

        let host = settings.proxyHost || settings.proxy_host;
        if (!host && typeof settings.gatewayUrl === 'string') {
            try {
                const parsed = new URL(settings.gatewayUrl);
                host = parsed.host;
            } catch (_) {}
        }
        if (!host) {
            host = '127.0.0.1:8443';
        }

        return `${protocol}://${host}`.replace(/\/$/, '');
    };

    App.updateGatewayPeers = function({ relayMap, peerDetails } = {}) {
        const nextRelayMap = new Map();

        if (relayMap instanceof Map) {
            for (const [identifier, info] of relayMap.entries()) {
                if (!identifier) continue;
                const peers = info?.peers instanceof Set
                    ? new Set(info.peers)
                    : new Set(Array.isArray(info?.peers) ? info.peers : []);
                const metadata = info?.metadata && typeof info.metadata === 'object'
                    ? { ...info.metadata }
                    : null;
                if (metadata && metadata.metadataUpdatedAt != null) {
                    const ts = Number(metadata.metadataUpdatedAt);
                    if (Number.isFinite(ts)) metadata.metadataUpdatedAt = ts;
                }

                nextRelayMap.set(identifier, {
                    peers,
                    peerCount: typeof info?.peerCount === 'number' ? info.peerCount : peers.size,
                    status: info?.status || 'unknown',
                    lastActive: info?.lastActive || null,
                    createdAt: info?.createdAt || null,
                    metadata
                });
            }
        } else if (relayMap && typeof relayMap === 'object') {
            for (const [identifier, info] of Object.entries(relayMap)) {
                if (!identifier) continue;
                const peers = Array.isArray(info?.peers) ? new Set(info.peers) : new Set();
                const metadata = info?.metadata && typeof info.metadata === 'object'
                    ? { ...info.metadata }
                    : null;
                if (metadata && metadata.metadataUpdatedAt != null) {
                    const ts = Number(metadata.metadataUpdatedAt);
                    if (Number.isFinite(ts)) metadata.metadataUpdatedAt = ts;
                }

                nextRelayMap.set(identifier, {
                    peers,
                    peerCount: typeof info?.peerCount === 'number' ? info.peerCount : peers.size,
                    status: info?.status || 'unknown',
                    lastActive: info?.lastActive || null,
                    createdAt: info?.createdAt || null,
                    metadata
                });
            }
        }

        const nextPeerDetails = new Map();
        if (peerDetails instanceof Map) {
            for (const [peerKey, info] of peerDetails.entries()) {
                nextPeerDetails.set(peerKey, {
                    nostrPubkeyHex: info?.nostrPubkeyHex || null,
                    relays: Array.isArray(info?.relays) ? [...info.relays] : [],
                    relayCount: typeof info?.relayCount === 'number'
                        ? info.relayCount
                        : Array.isArray(info?.relays) ? info.relays.length : 0,
                    lastSeen: info?.lastSeen || null,
                    status: info?.status || 'unknown',
                    mode: info?.mode || null,
                    address: info?.address || null
                });
            }
        } else if (peerDetails && typeof peerDetails === 'object') {
            for (const [peerKey, info] of Object.entries(peerDetails)) {
                nextPeerDetails.set(peerKey, {
                    nostrPubkeyHex: info?.nostrPubkeyHex || null,
                    relays: Array.isArray(info?.relays) ? [...info.relays] : [],
                    relayCount: typeof info?.relayCount === 'number'
                        ? info.relayCount
                        : Array.isArray(info?.relays) ? info.relays.length : 0,
                    lastSeen: info?.lastSeen || null,
                    status: info?.status || 'unknown',
                    mode: info?.mode || null,
                    address: info?.address || null
                });
            }
        }

        this.gatewayPeerRelayMap = nextRelayMap;
        this.gatewayPeerDetails = nextPeerDetails;

        this.discoverRelaysCache = null;
        this.discoverRelaysCacheTime = 0;

        if (this.currentPage === 'group-detail') {
            this.updateGroupPeerSummary();
            if (this.membersList && typeof this.membersList.updateOnlineStatuses === 'function') {
                this.membersList.setOnlineStatusResolver((pubkey) => this.isMemberOnline(pubkey));
                this.membersList.updateOnlineStatuses();
            }
        }

        this.updateVisibleGroupPeerSummaries();

        if (typeof this.refreshRelayGatewayCard === 'function') {
            this.refreshRelayGatewayCard();
        }

        if (this.currentListView === 'discover' && typeof this.loadDiscoverRelays === 'function') {
            this.loadDiscoverRelays(true).catch((err) => console.error('Failed to refresh discover relays:', err));
        }
    };

    App.updatePublicGatewayState = function(state) {
        this.publicGatewayState = state || null;
        if (typeof this.refreshRelayGatewayCard === 'function') {
            this.refreshRelayGatewayCard();
        }
    };

    App.getRelayPeerEntry = function(identifier = null) {
        const id = identifier || this.currentHypertunaId;
        if (!id) return null;
        return this.gatewayPeerRelayMap.get(id) || null;
    };

    App.getRelayPeerCount = function(identifier = null) {
        const entry = this.getRelayPeerEntry(identifier);
        if (!entry) return 0;
        if (typeof entry.peerCount === 'number') return entry.peerCount;
        if (entry.peers instanceof Set) return entry.peers.size;
        if (Array.isArray(entry.peers)) return entry.peers.length;
        return 0;
    };

    App.getRelayPeerSet = function(identifier = null) {
        const entry = this.getRelayPeerEntry(identifier);
        if (!entry) return new Set();
        if (entry.peers instanceof Set) return entry.peers;
        if (Array.isArray(entry.peers)) return new Set(entry.peers);
        return new Set();
    };

    App.isMemberOnline = function(pubkey, relayIdentifier = null) {
        if (!pubkey) return false;
        const normalized = pubkey.toLowerCase();
        const peers = this.getRelayPeerSet(relayIdentifier);
        for (const peerKey of peers) {
            const detail = this.gatewayPeerDetails.get(peerKey);
            if (!detail?.nostrPubkeyHex) continue;
            if (detail.nostrPubkeyHex.toLowerCase() === normalized) {
                return true;
            }
        }
        return false;
    };

    App.updateGroupPeerSummary = function(identifier = null) {
        const peerCountEl = document.getElementById('group-header-peer-count');
        if (!peerCountEl) return;
        const targetId = identifier || this.currentHypertunaId;
        if (!targetId) {
            peerCountEl.textContent = 'Peers unavailable';
            return;
        }
        const count = this.getRelayPeerCount(targetId);
        peerCountEl.textContent = count === 1 ? '1 peer online' : `${count} peers online`;
    };

    App.updateVisibleGroupPeerSummaries = function() {
        const updateContainer = (container) => {
            if (!container) return;
            const items = container.querySelectorAll('[data-role="peer-count"]');
            items.forEach((element) => {
                const host = element.closest('[data-hypertuna-id]');
                const identifier = host?.dataset.hypertunaId || null;
                if (!identifier) {
                    element.textContent = 'Peers unavailable';
                    return;
                }
                const count = this.getRelayPeerCount(identifier);
                element.textContent = count === 1 ? '1 peer online' : `${count} peers online`;
            });
        };

        updateContainer(document.getElementById('groups-list'));
        updateContainer(document.getElementById('discover-list'));
    };

    App.initRelayGatewayCard = function() {
        if (this.relayGatewayCardInitialized) return;
        this.relayGatewayCardInitialized = true;

        const elements = this.relayGatewayElements;
        elements.card = document.getElementById('relay-gateway-card');
        elements.meta = document.getElementById('relay-gateway-meta');
        elements.stats = document.getElementById('relay-gateway-stats');
        elements.resyncBtn = document.getElementById('relay-gateway-resync');
        elements.ttlInput = document.getElementById('relay-gateway-ttl');
        elements.generateBtn = document.getElementById('relay-gateway-generate');
        elements.tokenOutput = document.getElementById('relay-gateway-token-output');
        elements.copyBtn = document.getElementById('relay-gateway-token-copy');
        elements.feedback = document.getElementById('relay-gateway-feedback');
        elements.statusDot = elements.card?.querySelector('.relay-gateway-status-dot') || null;
        elements.headerCopyBtn = document.getElementById('relay-copy-link');

        if (elements.resyncBtn) {
            elements.resyncBtn.addEventListener('click', () => this.handleRelayGatewayResync());
        }
        if (elements.generateBtn) {
            elements.generateBtn.addEventListener('click', () => this.handleRelayGatewayGenerate());
        }
        if (elements.copyBtn) {
            elements.copyBtn.addEventListener('click', () => this.handleRelayGatewayCopy());
        }
        if (elements.headerCopyBtn) {
            elements.headerCopyBtn.addEventListener('click', (event) => this.handleRelayCopyLink(event));
        }

        window.addEventListener('public-gateway-status', () => {
            this.refreshRelayGatewayCard();
        });

        window.addEventListener('public-gateway-message', (event) => {
            if (!event?.detail?.message) return;
            if (!this.currentGroupIsMember) return;
            const { type, message } = event.detail;
            if (type === 'error') {
                this.setRelayGatewayFeedback('error', message);
            }
        });

        window.addEventListener('public-gateway-token', (event) => {
            const result = event?.detail;
            if (!result || result.relayKey !== this.currentHypertunaId) return;
            this.relayGatewayLastToken = result;
            this.updateRelayGatewayTokenOutput(result.connectionUrl, result.expiresAt);
        });
    };

    App.setRelayGatewayFeedback = function(variant, message) {
        const { feedback } = this.relayGatewayElements;
        if (!feedback) return;
        if (!message) {
            feedback.classList.add('hidden');
            feedback.textContent = '';
            feedback.classList.remove('success', 'error', 'info', 'warning');
            return;
        }
        feedback.textContent = message;
        feedback.classList.remove('hidden', 'success', 'error', 'info', 'warning');
        if (variant === 'success') {
            feedback.classList.add('success');
        } else if (variant === 'error') {
            feedback.classList.add('error');
        } else if (variant === 'warning') {
            feedback.classList.add('warning');
        } else {
            feedback.classList.add('info');
        }
    };

    App.updateRelayGatewayTokenOutput = function(value, expiresAt = null) {
        const { tokenOutput, copyBtn } = this.relayGatewayElements;
        if (tokenOutput) {
            tokenOutput.value = value || '';
        }
        if (copyBtn) {
            copyBtn.disabled = !value;
        }
        if (value) {
            const expiryText = expiresAt ? new Date(expiresAt).toLocaleString() : 'soon';
            this.setRelayGatewayFeedback('success', `Share link ready. Expires ${expiryText}.`);
        }
    };

    App.refreshRelayGatewayCard = function() {
        this.initRelayGatewayCard();
        const elements = this.relayGatewayElements;
        const { card, meta, stats, statusDot, ttlInput, resyncBtn, generateBtn } = elements;
        if (!card) return;

        const identifier = this.currentHypertunaId || null;
        const onDetailPage = this.currentPage === 'group-detail';
        const hasAccess = onDetailPage && this.currentGroupIsMember && !!identifier;
        card.classList.toggle('hidden', !hasAccess);
        if (!hasAccess) {
            this.setRelayGatewayFeedback(null, '');
            return;
        }

        const summary = typeof window.getPublicGatewaySummary === 'function'
            ? window.getPublicGatewaySummary()
            : { text: 'Public gateway bridge unavailable', status: 'disabled', bridgeEnabled: false, remoteActive: false };

        if (meta) {
            meta.textContent = summary.text || '';
        }

        card.classList.remove('online', 'error', 'warning', 'disabled', 'pending');
        if (summary.status) {
            card.classList.add(summary.status);
        }

        if (statusDot) {
            statusDot.classList.remove('online', 'error', 'warning');
        }

        const gatewayState = HypertunaUtils.getPublicGatewayState() || {};
        const relayState = gatewayState.relays?.[identifier] || null;
        const peerEntry = this.gatewayPeerRelayMap.get(identifier) || relayState || null;
        const statParts = [];
        if (relayState && typeof window.formatRelayGatewayStats === 'function') {
            statParts.push(...window.formatRelayGatewayStats(relayState));
        } else if (peerEntry && typeof window.formatRelayGatewayStats === 'function') {
            statParts.push(...window.formatRelayGatewayStats(peerEntry));
        }
        if (!statParts.length) {
            statParts.push('No gateway telemetry available');
        }
        if (stats) {
            stats.textContent = statParts.join(' • ');
        }

        const defaultConfig = HypertunaUtils.getPublicGatewayConfig() || {};
        if (ttlInput) {
            const minutes = Math.max(1, Math.round((defaultConfig.defaultTokenTtl || 3600) / 60));
            ttlInput.placeholder = `${minutes}`;
        }

        const bridgeReady = !!summary.bridgeEnabled && !!summary.remoteActive;
        const isRegistered = HypertunaUtils.isRelayRegisteredWithPublic(identifier);

        if (resyncBtn) {
            resyncBtn.disabled = !bridgeReady || !identifier;
        }
        if (generateBtn) {
            generateBtn.disabled = !bridgeReady || !isRegistered;
        }
        if (elements.copyBtn) {
            elements.copyBtn.disabled = !elements.tokenOutput?.value;
        }

        // Preserve last generated token if it matches current relay
        if (this.relayGatewayLastToken?.relayKey === identifier) {
            this.updateRelayGatewayTokenOutput(this.relayGatewayLastToken.connectionUrl, this.relayGatewayLastToken.expiresAt);
        } else {
            this.updateRelayGatewayTokenOutput('', null);
            this.setRelayGatewayFeedback(null, '');
        }
    };

    App.handleRelayGatewayResync = async function() {
        const elements = this.relayGatewayElements;
        const { resyncBtn } = elements;
        const identifier = this.currentHypertunaId || null;
        if (!identifier || typeof window.refreshPublicGatewayRelay !== 'function') return;

        try {
            if (resyncBtn) resyncBtn.disabled = true;
            this.setRelayGatewayFeedback('info', 'Requesting gateway resync…');
            await window.refreshPublicGatewayRelay(identifier);
            this.setRelayGatewayFeedback('success', 'Resync requested successfully.');
        } catch (error) {
            console.error('Failed to resync public gateway relay:', error);
            this.setRelayGatewayFeedback('error', error.message || 'Resync request failed.');
        } finally {
            if (resyncBtn) {
                setTimeout(() => {
                    resyncBtn.disabled = false;
                }, 600);
            }
        }
    };

    App.handleRelayGatewayGenerate = async function() {
        const elements = this.relayGatewayElements;
        const { generateBtn, ttlInput } = elements;
        const identifier = this.currentHypertunaId || null;
        if (!identifier || typeof window.requestPublicGatewayToken !== 'function') {
            this.setRelayGatewayFeedback('error', 'Public gateway bridge is unavailable.');
            return;
        }

        let ttlSeconds;
        if (ttlInput && ttlInput.value) {
            const minutes = Number(ttlInput.value);
            if (Number.isFinite(minutes) && minutes > 0) {
                ttlSeconds = Math.round(minutes * 60);
            } else {
                this.setRelayGatewayFeedback('error', 'Enter a valid TTL in minutes.');
                ttlInput.focus();
                return;
            }
        }

        try {
            if (generateBtn) generateBtn.disabled = true;
            this.setRelayGatewayFeedback('info', 'Generating public gateway link…');
            const result = await window.requestPublicGatewayToken({ relayKey: identifier, ttlSeconds });
            this.relayGatewayLastToken = result;
            this.updateRelayGatewayTokenOutput(result.connectionUrl, result.expiresAt);
        } catch (error) {
            console.error('Failed to generate public gateway token:', error);
            this.setRelayGatewayFeedback('error', error.message || 'Failed to generate link.');
        } finally {
            if (generateBtn) generateBtn.disabled = false;
        }
    };

    App.handleRelayGatewayCopy = async function() {
        const elements = this.relayGatewayElements;
        const { tokenOutput } = elements;
        const value = tokenOutput?.value?.trim();
        if (!value) {
            this.setRelayGatewayFeedback('warning', 'Generate a link before copying.');
            return;
        }

        try {
            await window.copyTextToClipboard(value);
            this.setRelayGatewayFeedback('success', 'Link copied to clipboard.');
        } catch (error) {
            console.error('Failed to copy relay link:', error);
            this.setRelayGatewayFeedback('error', 'Unable to copy link automatically.');
        }
    };

    App.handleRelayCopyLink = async function(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        this.initRelayGatewayCard();
        const { headerCopyBtn } = this.relayGatewayElements;
        if (!headerCopyBtn) return;

        const identifier = this.currentHypertunaId || null;
        if (!identifier) {
            return;
        }

        const resetTooltip = () => {
            const tooltip = headerCopyBtn.querySelector('.relay-copy-tooltip');
            if (tooltip) tooltip.textContent = 'Copy relay link';
            headerCopyBtn.classList.remove('copied');
        };

        const flashTooltip = (text, copied) => {
            const tooltip = headerCopyBtn.querySelector('.relay-copy-tooltip');
            if (tooltip) tooltip.textContent = text;
            headerCopyBtn.classList.toggle('copied', !!copied);
            setTimeout(() => {
                resetTooltip();
            }, 2000);
        };

        try {
            let targetUrl = '';
            const summary = typeof window.getPublicGatewaySummary === 'function'
                ? window.getPublicGatewaySummary()
                : null;
            const bridgeReady = !!summary?.bridgeEnabled && !!summary?.remoteActive;
            const registered = HypertunaUtils.isRelayRegisteredWithPublic(identifier);

            if (bridgeReady && registered) {
                this.setRelayGatewayFeedback('info', 'Generating public link for clipboard…');
                const result = await window.requestPublicGatewayToken({ relayKey: identifier });
                targetUrl = result.connectionUrl || '';
                this.relayGatewayLastToken = result;
                this.updateRelayGatewayTokenOutput(result.connectionUrl, result.expiresAt);
            }

            if (!targetUrl) {
                const base = await this.resolveLocalGatewayBase();
                const peerEntry = this.gatewayPeerRelayMap.get(identifier) || null;
                const gatewayPath = this.normalizeGatewayPath(identifier, peerEntry?.metadata) || identifier;
                targetUrl = `${base.replace(/\/$/, '')}/${gatewayPath}`;
            }

            await window.copyTextToClipboard(targetUrl);
            if (this.currentGroupIsMember && this.currentPage === 'group-detail') {
                if (this.relayGatewayLastToken?.relayKey === identifier) {
                    this.setRelayGatewayFeedback('success', 'Link copied to clipboard.');
                } else {
                    this.setRelayGatewayFeedback('info', 'Local relay URL copied to clipboard.');
                }
            }
            flashTooltip('Copied!', true);
        } catch (error) {
            console.error('Failed to copy relay link:', error);
            flashTooltip('Copy failed', false);
            this.setRelayGatewayFeedback('error', error.message || 'Copy failed.');
        }
    };

    const uint8ArrayToBase64 = (bytes) => {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            const segment = bytes.subarray(i, i + chunk);
            binary += String.fromCharCode(...segment);
        }
        return btoa(binary);
    };

    const inferExtension = (mimeType, fileName = '') => {
        const fromName = (fileName || '').match(/\.[a-z0-9]+$/i);
        if (fromName) return fromName[0];
        switch ((mimeType || '').toLowerCase()) {
            case 'image/png': return '.png';
            case 'image/jpeg':
            case 'image/jpg': return '.jpg';
            case 'image/webp': return '.webp';
            case 'image/gif': return '.gif';
            default: return '.bin';
        }
    };
    

    
    /**
     * Enhanced login method with Hypertuna support
     * Generate and store Hypertuna keypair during login
     */
    App.login = async function() {
        const privateKeyInput = document.getElementById('privateKey').value.trim();
        
        if (!privateKeyInput) {
            alert('Please enter a valid private key or generate a new one.');
            return;
        }
        
        try {
            // Normalize the private key input (handles both hex and nsec)
            const privateKey = NostrUtils.normalizePrivateKey(privateKeyInput);
            if (!privateKey) {
                alert('Invalid private key format. Please enter a hex key or nsec format.');
                return;
            }
            
            localStorage.removeItem('explicit_logout');
            const pubkey = NostrUtils.getPublicKey(privateKey);
            
            this.currentUser = {
                privateKey,
                pubkey,
                name: 'User_' + NostrUtils.truncatePubkey(pubkey),
                about: ''
            };
            
            // Generate and save Hypertuna configuration
            try {
                // Setup Hypertuna configuration with default gateway
                const hypertunaConfig = await HypertunaUtils.setupUserConfig(this.currentUser);
                
                // Add Hypertuna configuration to user object for easy access
                this.currentUser.hypertunaConfig = hypertunaConfig;
                
                console.log('Hypertuna configuration generated:', {
                    pubkey: hypertunaConfig.nostr_pubkey_hex.substring(0, 8) + '...',
                    proxy_pubkey: hypertunaConfig.proxy_publicKey.substring(0, 8) + '...',
                    proxy_server: hypertunaConfig.proxy_server_address,
                    gatewayUrl: hypertunaConfig.gatewayUrl
                });
                
                // IMPORTANT: Sync to file system for worker
                await this.syncHypertunaConfigToFile();
                
            } catch (e) {
                console.error('Error generating Hypertuna configuration:', e);
                // Continue with login even if Hypertuna config fails
            }
            
            // Save the user data to localStorage
            this.saveUserToLocalStorage();
            this.updateProfileDisplay();
            
            // IMPORTANT: Recreate NostrIntegration if it's null
            if (!this.nostr) {
                console.log('Creating new NostrIntegration instance');
                this.nostr = new NostrIntegration(this);
            }
            
            // Initialize nostr integration if login was successful
            try {
                this.showGroupListSpinner();
                await this.nostr.init(this.currentUser);
                console.log('Nostr integration initialized');

                if (this.configureRelays) {
                    await this.configureRelays(this.nostr.relayUrls || [], { skipNetwork: true, includePersisted: true });
                }

                // Fetch the latest profile metadata so avatar images load
                try {
                    const profile = await this.nostr.client.fetchUserProfile(this.currentUser.pubkey);
                    Object.assign(this.currentUser, profile);
                    this.saveUserToLocalStorage();
                    this.updateProfileDisplay();
                } catch (err) {
                    console.error('Failed to fetch user profile after init:', err);
                }
                if (window.startWorker) {
                    try {
                        const key = await window.startWorker();
                        if (key && this.currentUser.hypertunaConfig) {
                            this.currentUser.hypertunaConfig.swarmPublicKey = key;
                            await HypertunaUtils.saveConfig(this.currentUser.hypertunaConfig);
                            this.saveUserToLocalStorage();
                            if (typeof this.updateHypertunaDisplay === 'function') {
                                this.updateHypertunaDisplay();
                            }
                        }
                        if (window.refreshGatewayStatus) {
                            await window.refreshGatewayStatus({ fetchOptions: false });
                        }
                    } catch (err) {
                        console.error('Failed to start worker:', err);
                    }
                }
            } catch (e) {
                console.error('Error initializing nostr integration:', e);
            }
            
            // Connect to relay if not already connected
            if ((!this.relay || !this.relay.isConnected()) && this.nostr) {
                this.connectRelay();
            } else {
                this.updateUIState();
            }
        } catch (e) {
            console.error('Error logging in:', e);
            alert('Error: Invalid private key format.');
        }
    };


    App.logout = function() {
        try {
            localStorage.setItem('explicit_logout', 'true');
        } catch (error) {
            console.error('Failed to set explicit logout flag:', error);
        }

        if (typeof window.prunePfpQueueForOwner === 'function' && this.currentUser?.pubkey) {
            window.prunePfpQueueForOwner(this.currentUser.pubkey);
        }

        const clearUserData = () => {
            this.currentUser = null;
            try {
                this.saveUserToLocalStorage();
            } catch (error) {
                console.error('Failed to persist cleared user state during logout:', error);
            }

            try {
                localStorage.removeItem('hypertuna_config');
            } catch (error) {
                console.error('Failed to remove Hypertuna config during logout:', error);
            }
        };

        try {
            this.currentGroupIsMember = false;
            if (typeof this.refreshRelayGatewayCard === 'function') {
                try {
                    this.refreshRelayGatewayCard();
                } catch (error) {
                    console.error('Failed to refresh relay gateway card during logout:', error);
                }
            }

            if (this.relay && this.relay.isConnected()) {
                try {
                    this.relay.disconnect();
                } catch (error) {
                    console.error('Failed to disconnect relay during logout:', error);
                }
            }

            if (this.nostr) {
                if (this.nostr.client) {
                    try {
                        this.nostr.client.activeSubscriptions.forEach(subId => {
                            this.nostr.client.relayManager.unsubscribe(subId);
                        });
                        this.nostr.client.activeSubscriptions.clear();

                        this.nostr.client.relayManager.getRelays().forEach(url => {
                            const relay = this.nostr.client.relayManager.relays.get(url);
                            if (relay && relay.conn) {
                                relay.preventReconnect = true;
                                try {
                                    relay.conn.close();
                                } catch (error) {
                                    console.error('Failed to close relay connection during logout:', error);
                                }
                            }
                            this.nostr.client.relayManager.relays.delete(url);
                        });
                    } catch (error) {
                        console.error('Failed to clean up Nostr integration during logout:', error);
                    }
                }

                if (typeof this.nostr.shutdown === 'function') {
                    try {
                        this.nostr.shutdown({ clearState: true });
                    } catch (error) {
                        console.error('Failed to shutdown Nostr integration during logout:', error);
                    }
                }

                this.nostr = null;
            }

            if (typeof window.stopWorker === 'function') {
                try {
                    window.stopWorker();
                } catch (error) {
                    console.error('Failed to stop worker during logout:', error);
                }
            }
        } finally {
            clearUserData();
        }

        if (window.OnboardingFlow && typeof window.OnboardingFlow.startFreshSession === 'function') {
            window.OnboardingFlow.startFreshSession({ skipSplash: true });
        } else {
            this.currentPage = 'auth';
            this.updateUIState();
        }
    };
    
    /**
     * Enhanced key generation method with Hypertuna preview
     */
    App.generatePrivateKey = async function() {
        const newPrivateKey = NostrUtils.generatePrivateKey();
        document.getElementById('privateKey').value = newPrivateKey;
        
        // Preview Hypertuna configuration
        try {
            const pubkey = NostrUtils.getPublicKey(newPrivateKey);
            
            // Generate preview config without saving
            const previewConfig = await HypertunaUtils.generateHypertunaConfig(newPrivateKey, pubkey);
            
            console.log('Hypertuna preview configuration generated:', {
                pubkey: previewConfig.nostr_pubkey_hex.substring(0, 8) + '...',
                proxy_pubkey: previewConfig.proxy_publicKey.substring(0, 8) + '...',
                proxy_server: previewConfig.proxy_server_address,
                gatewayUrl: previewConfig.gatewayUrl
            });
        } catch (e) {
            console.error('Error generating Hypertuna preview configuration:', e);
        }
    };
    
    /**
     * Enhanced saveUserToLocalStorage method
     * Save Hypertuna configuration separately
     */
    App.saveUserToLocalStorage = function() {
        ConfigLogger.log('SAVE', {
            module: 'AppIntegration',
            method: 'saveUserToLocalStorage',
            attempting: true
        });

        let explicitLogoutActive = false;
        try {
            explicitLogoutActive = localStorage.getItem('explicit_logout') === 'true';
        } catch (_) {
            explicitLogoutActive = false;
        }

        if (explicitLogoutActive && this.currentUser) {
            console.warn('Skipping user persistence because explicit logout flag is active');
            return;
        }

        if (this.currentUser) {
            // Create a clean copy of the user object without any circular references
            const userToSave = {
                privateKey: this.currentUser.privateKey,
                pubkey: this.currentUser.pubkey,
                name: this.currentUser.name,
                about: this.currentUser.about,
                picture: this.currentUser.picture || null,
                pictureTagUrl: this.currentUser.pictureTagUrl || null,
                pictureIsHypertunaPfp: !!this.currentUser.pictureIsHypertunaPfp
            };
            
            // If there's Hypertuna configuration, add it to the saved user
            if (this.currentUser.hypertunaConfig) {
                userToSave.hypertunaConfig = this.currentUser.hypertunaConfig;
            }
            
            // Save user data to localStorage
            try {
                localStorage.setItem('nostr_user', JSON.stringify(userToSave));
                ConfigLogger.log('SAVE', {
                    module: 'AppIntegration',
                    method: 'saveUserToLocalStorage',
                    filepath: 'localStorage',
                    key: 'nostr_user',
                    success: true,
                    dataSize: ConfigLogger.getDataSize(userToSave)
                });
            } catch (e) {
                ConfigLogger.log('SAVE', {
                    module: 'AppIntegration',
                    method: 'saveUserToLocalStorage',
                    filepath: 'localStorage',
                    key: 'nostr_user',
                    success: false,
                    error: e.message
                });
            }
            
            // If the user has Hypertuna configuration, also save it separately
            if (this.currentUser.hypertunaConfig) {
                try {
                    localStorage.setItem('hypertuna_config', JSON.stringify(this.currentUser.hypertunaConfig));
                    ConfigLogger.log('SAVE', {
                        module: 'AppIntegration',
                        method: 'saveUserToLocalStorage',
                        filepath: 'localStorage',
                        key: 'hypertuna_config',
                        success: true,
                        dataSize: ConfigLogger.getDataSize(this.currentUser.hypertunaConfig)
                    });
                } catch (e) {
                    ConfigLogger.log('SAVE', {
                        module: 'AppIntegration',
                        method: 'saveUserToLocalStorage',
                        filepath: 'localStorage',
                        key: 'hypertuna_config',
                        success: false,
                        error: e.message
                    });
                }
            }
        } else {
            // Remove user data from localStorage
            ConfigLogger.log('DELETE', {
                module: 'AppIntegration',
                method: 'saveUserToLocalStorage',
                filepath: 'localStorage',
                key: 'nostr_user'
            });
            localStorage.removeItem('nostr_user');

            ConfigLogger.log('DELETE', {
                module: 'AppIntegration',
                method: 'saveUserToLocalStorage',
                filepath: 'localStorage',
                key: 'hypertuna_config'
            });
            localStorage.removeItem('hypertuna_config');
        }
    };
    
    /**
 * Enhanced loadUserFromLocalStorage method
 * Load and check for Hypertuna configuration
 */
    App.loadUserFromLocalStorage = async function() {
        ConfigLogger.log('LOAD', {
            module: 'AppIntegration',
            method: 'loadUserFromLocalStorage',
            attempting: true
        });
        
        const savedUser = localStorage.getItem('nostr_user');
        const explicitLogout = localStorage.getItem('explicit_logout') === 'true';
        
        // Only load user if they haven't explicitly logged out
        if (savedUser && !explicitLogout) {
            try {
            ConfigLogger.log('LOAD', {
                module: 'AppIntegration',
                method: 'loadUserFromLocalStorage',
                filepath: 'localStorage',
                key: 'nostr_user',
                success: true,
                dataSize: savedUser.length
            });
            
            this.currentUser = JSON.parse(savedUser);
            if (!this.currentUser.picture) this.currentUser.picture = null;
            if (!this.currentUser.pictureTagUrl) this.currentUser.pictureTagUrl = null;
            this.currentUser.pictureIsHypertunaPfp = !!this.currentUser.pictureIsHypertunaPfp;
            this.currentUser.tempAvatarPreview = null;
            
            // Check for Hypertuna configuration
            ConfigLogger.log('LOAD', {
                module: 'AppIntegration',
                method: 'loadUserFromLocalStorage',
                filepath: 'localStorage',
                key: 'hypertuna_config',
                attempting: true
            });
            
            const hypertunaConfig = localStorage.getItem('hypertuna_config');
            if (hypertunaConfig) {
                this.currentUser.hypertunaConfig = JSON.parse(hypertunaConfig);
                
                ConfigLogger.log('LOAD', {
                    module: 'AppIntegration',
                    method: 'loadUserFromLocalStorage',
                    filepath: 'localStorage',
                    key: 'hypertuna_config',
                    success: true,
                    dataSize: hypertunaConfig.length
                });
                
                console.log('Loaded Hypertuna configuration from localStorage:', {
                    pubkey: this.currentUser.hypertunaConfig.nostr_pubkey_hex.substring(0, 8) + '...',
                    proxy_pubkey: this.currentUser.hypertunaConfig.proxy_publicKey.substring(0, 8) + '...',
                    proxy_server: this.currentUser.hypertunaConfig.proxy_server_address,
                    gatewayUrl: this.currentUser.hypertunaConfig.gatewayUrl
                });
                
                // IMPORTANT: Sync to file system after loading
                await this.syncHypertunaConfigToFile();
                
            } else {
                ConfigLogger.log('LOAD', {
                    module: 'AppIntegration',
                    method: 'loadUserFromLocalStorage',
                    filepath: 'localStorage',
                    key: 'hypertuna_config',
                    success: false,
                    error: 'Config not found, generating new one'
                });
                
                // If no Hypertuna config exists, generate it now
                try {
                    this.currentUser.hypertunaConfig = await HypertunaUtils.setupUserConfig(this.currentUser);
                    console.log('Generated new Hypertuna configuration for existing user');
                    this.saveUserToLocalStorage();
                    
                    // IMPORTANT: Sync to file system
                    await this.syncHypertunaConfigToFile();
                    
                } catch (e) {
                    console.error('Error generating Hypertuna configuration for existing user:', e);
                }
            }
            
            this.updateProfileDisplay();
            
            // Initialize nostr integration for logged-in user
            if (this.nostr) {
                try {
                    this.showGroupListSpinner();
                    await this.nostr.init(this.currentUser);
                    console.log('Nostr integration initialized for existing user');

                    if (this.configureRelays) {
                        await this.configureRelays(this.nostr.relayUrls || [], { skipNetwork: true, includePersisted: true });
                    }

                    // Ensure local profile cache is populated so avatars display
                    try {
                        const profile = await this.nostr.client.fetchUserProfile(this.currentUser.pubkey);
                        Object.assign(this.currentUser, profile);
                        this.saveUserToLocalStorage();
                        this.updateProfileDisplay();
                    } catch (err) {
                        console.error('Failed to fetch user profile after init:', err);
                    }
                } catch (e) {
                    console.error('Error initializing nostr integration for existing user:', e);
                }
            }
        } catch (e) {
            ConfigLogger.log('LOAD', {
                module: 'AppIntegration',
                method: 'loadUserFromLocalStorage',
                filepath: 'localStorage',
                key: 'nostr_user',
                success: false,
                error: e.message
            });
            
            console.error('Error loading user data:', e);
            localStorage.removeItem('nostr_user');
        }
    } else {
        // If explicit logout, clear any saved user data
        if (explicitLogout) {
            localStorage.removeItem('nostr_user');
            localStorage.removeItem('hypertuna_config');
        }
        
        ConfigLogger.log('LOAD', {
            module: 'AppIntegration',
            method: 'loadUserFromLocalStorage',
            filepath: 'localStorage',
            key: 'nostr_user',
            success: false,
            error: explicitLogout ? 'Explicit logout detected' : 'No saved user found'
        });
    }
};
    
    /**
     * Enhanced updateProfileDisplay method
     * Display Hypertuna configuration in profile
     */
    App.updateProfileDisplay = function() {
        if (!this.currentUser) return;
        
        // Try to get profile from nostr client cache
        let profile = null;
        if (this.nostr && this.nostr.client) {
            profile = this.nostr.client.cachedProfiles.get(this.currentUser.pubkey);
        }
        
        // If no profile found, use basic info
        if (!profile) {
            profile = {
                name: this.currentUser.name || 'User_' + NostrUtils.truncatePubkey(this.currentUser.pubkey),
                about: this.currentUser.about || '',
                picture: this.currentUser.picture || null,
                pictureTagUrl: this.currentUser.pictureTagUrl || null,
                pictureIsHypertunaPfp: !!this.currentUser.pictureIsHypertunaPfp
            };
        }

        if (!profile.pictureTagUrl && profile.picture) {
            profile.pictureTagUrl = profile.picture;
        }
        profile.pictureIsHypertunaPfp = !!profile.pictureIsHypertunaPfp;
        
        const name = profile.name || 'User_' + NostrUtils.truncatePubkey(this.currentUser.pubkey);
        let resolvedPicture = null;
        if (this.currentUser?.tempAvatarPreview) {
            resolvedPicture = this.currentUser.tempAvatarPreview;
        } else if (profile) {
            const tagUrl = profile.pictureTagUrl || profile.picture || null;
            if (tagUrl) {
                resolvedPicture = HypertunaUtils.resolvePfpUrl(tagUrl, profile.pictureIsHypertunaPfp);
            }
        }
        
        console.log('Updating profile display with:', {
            name: profile.name,
            about: profile.about ? profile.about.substring(0, 30) + '...' : undefined,
            picture: profile.picture ? 'present' : undefined
        });
        
        // Update profile display on auth page with null checks
        const profileNameElement = document.getElementById('profile-name');
        if (profileNameElement) {
            profileNameElement.textContent = name;
        }
        
        const profilePubkeyElement = document.getElementById('profile-pubkey');
        if (profilePubkeyElement) {
            profilePubkeyElement.textContent = this.currentUser.pubkey;
        }
        
        // Update profile page with null checks
        const profileDisplayName = document.getElementById('profile-display-name');
        if (profileDisplayName) {
            profileDisplayName.textContent = name;
        }
        
        const profileDisplayPubkey = document.getElementById('profile-display-pubkey');
        if (profileDisplayPubkey) {
            profileDisplayPubkey.textContent = this.currentUser.pubkey;
        }
        
        const profileNameInput = document.getElementById('profile-name-input');
        if (profileNameInput) {
            profileNameInput.value = profile.name || '';
        }
        
        const profileAboutInput = document.getElementById('profile-about-input');
        if (profileAboutInput) {
            profileAboutInput.value = profile.about || '';
        }

        const summaryName = document.getElementById('profile-summary-name');
        if (summaryName) {
            summaryName.textContent = name || 'Display Name';
        }

        const summaryAbout = document.getElementById('profile-summary-about');
        if (summaryAbout) {
            if (profile.about) {
                summaryAbout.textContent = profile.about;
                summaryAbout.classList.remove('muted');
            } else {
                summaryAbout.textContent = 'Add something about yourself';
                summaryAbout.classList.add('muted');
            }
        }

        const profilePubkeyDisplay = document.getElementById('profile-pubkey-display');
        if (profilePubkeyDisplay) {
            // Display as npub by default
            profilePubkeyDisplay.value = NostrUtils.hexToNpub(this.currentUser.pubkey);
            profilePubkeyDisplay.dataset.format = 'npub';
            profilePubkeyDisplay.dataset.hex = this.currentUser.pubkey;
        }
        
        const profilePrivkeyDisplay = document.getElementById('profile-privkey-display');
        if (profilePrivkeyDisplay) {
            // Display as nsec by default
            profilePrivkeyDisplay.value = NostrUtils.hexToNsec(this.currentUser.privateKey);
            profilePrivkeyDisplay.dataset.format = 'nsec';
            profilePrivkeyDisplay.dataset.hex = this.currentUser.privateKey;
        }
        
        // Update profile picture if available
        const updateProfilePicture = (selector) => {
            const avatar = document.querySelector(selector);
            if (avatar) {
                if (resolvedPicture) {
                    console.log(`Setting profile picture from URL: ${resolvedPicture}`);
                    avatar.innerHTML = `<img src="${resolvedPicture}" alt="${name}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
                } else {
                    console.log(`Using initials for profile avatar: ${name.charAt(0).toUpperCase()}`);
                    // Use first character of name as avatar
                    avatar.innerHTML = `<span>${name.charAt(0).toUpperCase()}</span>`;
                }
            }
        };
        
        // Update profile pictures in all locations
        updateProfilePicture('#profile-display .profile-avatar-large');
        updateProfilePicture('.page#page-profile .profile-avatar-large');
        updateProfilePicture('#profile-details-card .profile-avatar-small');

        if (typeof this.renderDiscoveryRelays === 'function') {
            this.renderDiscoveryRelays();
        }
        
        // Update Hypertuna configuration if available
        if (this.currentUser.hypertunaConfig) {
            this.updateHypertunaDisplay();
        }
        
        if (profile.pictureTagUrl) {
            this.currentUser.pictureTagUrl = profile.pictureTagUrl;
        }
        this.currentUser.pictureIsHypertunaPfp = profile.pictureIsHypertunaPfp;
        if (resolvedPicture) {
            this.currentUser.picture = resolvedPicture;
        }

        console.log('Profile display updated successfully');
    };

    App.handleProfileAvatarChange = async function() {
        if (!this.currentUser) return;
        try {
            const result = await AvatarModal.open({ title: 'Update Profile Avatar' });
            if (!result) return;

            const buffer = result.buffer;
            const fileHash = await NostrUtils.computeSha256(buffer);
            const base64 = result.base64 || uint8ArrayToBase64(buffer);
            const gatewaySettings = await HypertunaUtils.getGatewaySettings();
            const cachedSettings = HypertunaUtils.getCachedGatewaySettings() || {};
            const baseUrl = (gatewaySettings.gatewayUrl || cachedSettings.gatewayUrl || '').replace(/\/$/, '');
            const owner = this.currentUser.pubkey;
            const fileName = `${fileHash}${result.extension}`;
            const pictureUrl = `${baseUrl}/pfp/${owner}/${fileName}`;
            const tagUrl = `${baseUrl}/pfp/${owner}/${fileName}`;

            const pendingAvatar = {
                fileHash,
                extension: result.extension,
                mimeType: result.mimeType,
                owner,
                pictureUrl,
                tagUrl,
                preview: result.preview,
                status: 'selected',
                error: null,
                previousPicture: this.currentUser.picture || null,
                previousTagUrl: this.currentUser.pictureTagUrl || null,
                previousIsHypertuna: !!this.currentUser.pictureIsHypertunaPfp
            };

            this.pendingProfileAvatar = pendingAvatar;

            this.currentUser.picture = pictureUrl;
            this.currentUser.pictureTagUrl = tagUrl;
            this.currentUser.pictureIsHypertunaPfp = true;
            this.currentUser.tempAvatarPreview = result.preview;
            this.currentUser.expectedPfpFileHash = fileHash;
            this.saveUserToLocalStorage();
            this.updateProfileDisplay();
            console.log('[Avatar] queued selection', { owner, fileHash, mime: result.mimeType });

            await this.updateProfile({ silent: true, omitPendingAvatar: true });

            if (isElectron) {
                pendingAvatar.status = 'queued';
                const queueTask = {
                    owner,
                    fileHash,
                    metadata: {
                        mimeType: result.mimeType,
                        filename: fileName
                    },
                    buffer: base64,
                    pictureUrl,
                    tagUrl,
                    preview: result.preview,
                    createdAt: Date.now(),
                    pendingAvatar
                };

                if (typeof window.enqueuePfpUpload === 'function') {
                    if (typeof window.prunePfpQueueForOwner === 'function') {
                        window.prunePfpQueueForOwner(owner, fileHash);
                    }
                    window.enqueuePfpUpload(queueTask);
                    console.log('[Avatar] enqueued durable upload task', { owner, fileHash });
                } else {
                    console.warn('[App] enqueuePfpUpload unavailable; aborting avatar upload');
                    await this.handlePendingAvatarUploadFailure(pendingAvatar, new Error('PFP upload queue unavailable'));
                }
            }
        } catch (error) {
            console.error('Error updating profile avatar:', error);
            alert('Failed to update avatar: ' + error.message);
        }
    };

    App.finalizePendingAvatarUpload = async function(pendingAvatar) {
        if (!pendingAvatar) return;

        if (this.currentUser?.expectedPfpFileHash && this.currentUser.expectedPfpFileHash !== pendingAvatar.fileHash) {
            console.warn('Ignoring stale avatar upload confirmation for', pendingAvatar.fileHash);
            return;
        }

        try {
            await this.updateProfile({ silent: true, forcePicture: pendingAvatar });
        } catch (error) {
            console.error('Failed to publish Hypertuna avatar:', error);
            throw error;
        }

        if (this.pendingProfileAvatar && this.pendingProfileAvatar.fileHash === pendingAvatar.fileHash) {
            this.pendingProfileAvatar = null;
        }

        delete this.currentUser.tempAvatarPreview;
        this.currentUser.picture = pendingAvatar.pictureUrl;
        this.currentUser.pictureTagUrl = pendingAvatar.tagUrl;
        this.currentUser.pictureIsHypertunaPfp = true;
        this.currentUser.expectedPfpFileHash = null;
        this.saveUserToLocalStorage();
        this.updateProfileDisplay();
        console.log('[Avatar] finalized uploaded image', { owner: pendingAvatar.owner, fileHash: pendingAvatar.fileHash });
    };

    App.handlePfpUploadConfirmed = async function(pendingAvatar) {
        if (!pendingAvatar) return;
        console.log('[Avatar] confirmation received', { owner: pendingAvatar.owner, fileHash: pendingAvatar.fileHash });
        try {
            await this.finalizePendingAvatarUpload(pendingAvatar);
        } catch (error) {
            console.error('Failed to finalize avatar after upload confirmation:', error);
        }
    };

    if (Array.isArray(window.pendingPfpConfirmations) && window.pendingPfpConfirmations.length) {
        const confirmations = [...window.pendingPfpConfirmations];
        window.pendingPfpConfirmations.length = 0;
        confirmations.forEach((entry) => {
            try {
                console.log('[Avatar] processing deferred confirmation', { owner: entry.owner, fileHash: entry.fileHash });
                App.handlePfpUploadConfirmed(entry);
            } catch (err) {
                console.error('Failed to process pending PFP confirmation:', err);
            }
        });
    }

    App.handlePendingAvatarUploadFailure = async function(pendingAvatar, error) {
        if (!pendingAvatar) return;

        console.error('Avatar upload failed:', error);

        if (this.pendingProfileAvatar && this.pendingProfileAvatar.fileHash === pendingAvatar.fileHash) {
            this.pendingProfileAvatar = null;
        }

        pendingAvatar.notifiedFailure = true;
        delete this.currentUser.tempAvatarPreview;
        this.currentUser.picture = pendingAvatar.previousPicture || this.currentUser.picture;
        this.currentUser.pictureTagUrl = pendingAvatar.previousTagUrl || this.currentUser.pictureTagUrl;
        this.currentUser.pictureIsHypertunaPfp = !!pendingAvatar.previousIsHypertuna;
        this.currentUser.expectedPfpFileHash = null;
        this.saveUserToLocalStorage();
        this.updateProfileDisplay();

        const message = error?.message || error || 'Unknown error';
        alert('Avatar upload failed: ' + message + '\nUpload will be retried automatically.');
        console.warn('[Avatar] upload failure recorded; retry scheduled', { owner: pendingAvatar.owner, fileHash: pendingAvatar.fileHash, message });
    };

    App.processPendingPfpFile = async function(file) {
        if (!file || !this.currentUser) return;
        try {
            console.log('[Avatar] processing pending onboarding PFP file', { name: file.name, size: file.size });
            const arrayBuffer = await file.arrayBuffer();
            const buffer = new Uint8Array(arrayBuffer);
            const fileHash = await NostrUtils.computeSha256(buffer);
            const base64 = uint8ArrayToBase64(buffer);
            const mimeType = file.type || 'application/octet-stream';
            const extension = inferExtension(mimeType, file.name || '');
            const preview = `data:${mimeType};base64,${base64}`;

            const gatewaySettings = await HypertunaUtils.getGatewaySettings();
            const cachedSettings = HypertunaUtils.getCachedGatewaySettings() || {};
            const baseUrl = (gatewaySettings.gatewayUrl || cachedSettings.gatewayUrl || '').replace(/\/$/, '');
            const owner = this.currentUser.pubkey;
            const fileName = `${fileHash}${extension}`;
            const pictureUrl = `${baseUrl}/pfp/${owner}/${fileName}`;
            const tagUrl = `${baseUrl}/pfp/${owner}/${fileName}`;

            const pendingAvatar = {
                fileHash,
                extension,
                mimeType,
                owner,
                pictureUrl,
                tagUrl,
                preview,
                status: 'queued',
                error: null,
                previousPicture: this.currentUser.picture || null,
                previousTagUrl: this.currentUser.pictureTagUrl || null,
                previousIsHypertuna: !!this.currentUser.pictureIsHypertunaPfp
            };

            this.pendingProfileAvatar = pendingAvatar;
            this.currentUser.picture = pictureUrl;
            this.currentUser.pictureTagUrl = tagUrl;
            this.currentUser.pictureIsHypertunaPfp = true;
            this.currentUser.tempAvatarPreview = preview;
            this.currentUser.expectedPfpFileHash = fileHash;
            this.saveUserToLocalStorage();
            this.updateProfileDisplay();
            console.log('[Avatar] prepared onboarding avatar', { owner, fileHash, mimeType });

            await this.updateProfile({ silent: true, omitPendingAvatar: true });

            const queueTask = {
                owner,
                fileHash,
                metadata: {
                    mimeType,
                    filename: fileName
                },
                buffer: base64,
                pictureUrl,
                tagUrl,
                preview,
                createdAt: Date.now(),
                pendingAvatar
            };

            if (typeof window.enqueuePfpUpload === 'function') {
                if (typeof window.prunePfpQueueForOwner === 'function') {
                    window.prunePfpQueueForOwner(owner, fileHash);
                }
                window.enqueuePfpUpload(queueTask);
                console.log('[Avatar] enqueued onboarding PFP upload', { owner, fileHash });
            } else {
                console.warn('[Avatar] enqueuePfpUpload unavailable during onboarding');
                await this.handlePendingAvatarUploadFailure(pendingAvatar, new Error('PFP upload queue unavailable'));
            }

            if (this.currentUser.pendingPfpFile) {
                delete this.currentUser.pendingPfpFile;
                this.saveUserToLocalStorage();
            }
        } catch (error) {
            console.error('[Avatar] Failed to process pending onboarding PFP file:', error);
            if (this.pendingProfileAvatar) {
                await this.handlePendingAvatarUploadFailure(this.pendingProfileAvatar, error);
            }
        }
    };

    App.handleCreateRelayAvatar = async function() {
        if (!this.currentUser) return;
        try {
            const result = await AvatarModal.open({ title: 'Relay Avatar' });
            if (!result) return;

            const buffer = result.buffer;
            const fileHash = await NostrUtils.computeSha256(buffer);
            const base64 = result.base64 || uint8ArrayToBase64(buffer);
            const gatewaySettings = await HypertunaUtils.getGatewaySettings();
            const cachedSettings = HypertunaUtils.getCachedGatewaySettings() || {};
            const baseUrl = (gatewaySettings.gatewayUrl || cachedSettings.gatewayUrl || '').replace(/\/$/, '');
            const fileName = `${fileHash}${result.extension}`;
            const pictureUrl = `${baseUrl}/pfp/${fileName}`;

            if (isElectron) {
                await sendToWorkerQueued({
                    type: 'upload-pfp',
                    data: {
                        owner: '',
                        fileHash,
                        metadata: {
                            mimeType: result.mimeType,
                            filename: fileName
                        },
                        buffer: base64
                    }
                }, {
                    requirePfpDrive: true,
                    description: 'relay avatar upload'
                }).catch((err) => {
                    console.error('Failed to send relay avatar to worker:', err);
                });
            }

            this.pendingCreateRelayAvatar = {
                fileHash,
                extension: result.extension,
                mimeType: result.mimeType,
                pictureUrl,
                tagUrl: pictureUrl,
                preview: result.preview
            };

            const previewEl = document.getElementById('create-relay-avatar-preview');
            if (previewEl) {
                previewEl.innerHTML = `<img src="${result.preview}" alt="Relay avatar preview">`;
            }
        } catch (error) {
            console.error('Error selecting relay avatar:', error);
            alert('Failed to update relay avatar: ' + error.message);
        }
    };

    App.handleEditRelayAvatar = async function() {
        if (!this.currentGroupId) return;
        try {
            const result = await AvatarModal.open({ title: 'Relay Avatar' });
            if (!result) return;

            const buffer = result.buffer;
            const fileHash = await NostrUtils.computeSha256(buffer);
            const base64 = result.base64 || uint8ArrayToBase64(buffer);
            const gatewaySettings = await HypertunaUtils.getGatewaySettings();
            const cachedSettings = HypertunaUtils.getCachedGatewaySettings() || {};
            const baseUrl = (gatewaySettings.gatewayUrl || cachedSettings.gatewayUrl || '').replace(/\/$/, '');
            const fileName = `${fileHash}${result.extension}`;
            const pictureUrl = `${baseUrl}/pfp/${fileName}`;

            if (isElectron) {
                await sendToWorkerQueued({
                    type: 'upload-pfp',
                    data: {
                        owner: '',
                        fileHash,
                        metadata: {
                            mimeType: result.mimeType,
                            filename: fileName
                        },
                        buffer: base64
                    }
                }, {
                    requirePfpDrive: true,
                    description: 'relay avatar upload'
                }).catch((err) => {
                    console.error('Failed to send relay avatar to worker:', err);
                });
            }

            this.pendingEditRelayAvatar = {
                fileHash,
                extension: result.extension,
                mimeType: result.mimeType,
                pictureUrl,
                tagUrl: pictureUrl,
                preview: result.preview
            };

            const previewEl = document.getElementById('edit-relay-avatar-preview');
            if (previewEl) {
                previewEl.innerHTML = `<img src="${result.preview}" alt="Relay avatar preview">`;
            }
        } catch (error) {
            console.error('Error selecting relay avatar:', error);
            alert('Failed to update relay avatar: ' + error.message);
        }
    };
    
    /**
     * New method to update Hypertuna configuration display
     */
    App.updateHypertunaDisplay = async function() {
        if (!this.currentUser || !this.currentUser.hypertunaConfig) return;

        try {
            const config = this.currentUser.hypertunaConfig;
            const gatewaySettings = await HypertunaUtils.getGatewaySettings();
            const placeholderGateway = gatewaySettings.gatewayUrl;

            const pubkeyInput = document.getElementById('hypertuna-pubkey-display');
            if (pubkeyInput) {
                pubkeyInput.value = config.swarmPublicKey || '';
            }

            const privkeyInput = document.getElementById('hypertuna-privkey-display');
            if (privkeyInput) {
                privkeyInput.value = config.proxy_privateKey || '';
            }

            const gatewayInput = document.getElementById('hypertuna-gateway-url');
            if (gatewayInput) {
                gatewayInput.placeholder = placeholderGateway;
                gatewayInput.value = config.gatewayUrl || placeholderGateway;
            }

            const togglePrivBtn = document.getElementById('btn-toggle-hypertuna-privkey');
            if (togglePrivBtn && !togglePrivBtn.dataset.bound) {
                togglePrivBtn.addEventListener('click', () => {
                    const input = document.getElementById('hypertuna-privkey-display');
                    if (!input) return;
                    input.type = input.type === 'password' ? 'text' : 'password';
                });
                togglePrivBtn.dataset.bound = 'true';
            }

            document.querySelectorAll('#relay-node-card .copy-btn').forEach(btn => {
                if (btn.dataset.bound === 'true') return;
                btn.addEventListener('click', () => {
                    const targetId = btn.dataset.copy;
                    const target = document.getElementById(targetId);
                    if (!target) return;

                    const isPassword = target.type === 'password';
                    if (isPassword) target.type = 'text';
                    target.select();
                    document.execCommand('copy');
                    if (isPassword) target.type = 'password';

                    const originalText = btn.textContent;
                    btn.textContent = 'Copied!';
                    setTimeout(() => {
                        btn.textContent = originalText;
                    }, 2000);
                });
                btn.dataset.bound = 'true';
            });
        } catch (error) {
            console.error('[App] Failed to update Hypertuna display:', error);
        }
    };

    /**
 * Sync current user's Hypertuna config to file system
 * Call this after login or when user changes
 */
App.syncHypertunaConfigToFile = async function() {
    if (!this.currentUser || !this.currentUser.hypertunaConfig) {
        console.log('[App] No Hypertuna config to sync');
        return;
    }

    if (!isElectron || !electronAPI?.writeConfig) {
        return;
    }

    try {
        ConfigLogger.log('SAVE', {
            module: 'AppIntegration',
            method: 'syncHypertunaConfigToFile',
            filepath: ELECTRON_CONFIG_PATH,
            attempting: true,
            dataSize: ConfigLogger.getDataSize(this.currentUser.hypertunaConfig)
        });

        const result = await electronAPI.writeConfig(this.currentUser.hypertunaConfig);
        if (!result?.success) {
            throw new Error(result?.error || 'Unknown write failure');
        }

        ConfigLogger.log('SAVE', {
            module: 'AppIntegration',
            method: 'syncHypertunaConfigToFile',
            filepath: ELECTRON_CONFIG_PATH,
            success: true,
            dataSize: ConfigLogger.getDataSize(this.currentUser.hypertunaConfig)
        });

        console.log('[App] Synced Hypertuna config to persistent storage');
    } catch (e) {
        ConfigLogger.log('SAVE', {
            module: 'AppIntegration',
            method: 'syncHypertunaConfigToFile',
            filepath: ELECTRON_CONFIG_PATH,
            success: false,
            error: e.message
        });

        console.error('[App] Failed to sync config to persistent storage:', e);
    }
};
    
    /**
     * New method to update Hypertuna settings
     */
    App.updateHypertunaSettings = async function() {
        ConfigLogger.log('UPDATE', {
            module: 'AppIntegration',
            method: 'updateHypertunaSettings',
            attempting: true
        });
        
        if (!this.currentUser || !this.currentUser.hypertunaConfig) return;
        
        const gatewayInput = document.getElementById('hypertuna-gateway-url');
        const gatewayUrl = gatewayInput ? gatewayInput.value.trim() : '';

        if (!gatewayUrl) {
            alert('Please enter a valid gateway URL');
            return;
        }
        
        try {
            const updatedSettings = await HypertunaUtils.persistGatewaySettings(gatewayUrl);
            const normalizedGatewayUrl = updatedSettings.gatewayUrl;
            const proxyHost = updatedSettings.proxyHost;
            const proxyWebsocketProtocol = updatedSettings.proxyWebsocketProtocol;

            this.currentUser.hypertunaConfig.gatewayUrl = normalizedGatewayUrl;
            this.currentUser.hypertunaConfig.proxy_server_address = proxyHost;
            this.currentUser.hypertunaConfig.proxy_websocket_protocol = proxyWebsocketProtocol;

            await HypertunaUtils.saveConfig(this.currentUser.hypertunaConfig);

            try {
                localStorage.setItem('hypertuna_config', JSON.stringify(this.currentUser.hypertunaConfig));
                ConfigLogger.log('UPDATE', {
                    module: 'AppIntegration',
                    method: 'updateHypertunaSettings',
                    filepath: 'localStorage',
                    key: 'hypertuna_config',
                    success: true,
                    dataSize: ConfigLogger.getDataSize(this.currentUser.hypertunaConfig)
                });
            } catch (e) {
                ConfigLogger.log('UPDATE', {
                    module: 'AppIntegration',
                    method: 'updateHypertunaSettings',
                    filepath: 'localStorage',
                    key: 'hypertuna_config',
                    success: false,
                    error: e.message
                });
            }

            this.saveUserToLocalStorage();

            if (gatewayInput) {
                gatewayInput.value = normalizedGatewayUrl;
                gatewayInput.placeholder = normalizedGatewayUrl;
            }

            ConfigLogger.log('UPDATE', {
                module: 'AppIntegration',
                method: 'updateHypertunaSettings',
                target: 'gateway-settings',
                success: true
            });

            await this.updateHypertunaDisplay();

            alert('Hypertuna configuration updated successfully');
        } catch (error) {
            ConfigLogger.log('UPDATE', {
                module: 'AppIntegration',
                method: 'updateHypertunaSettings',
                target: 'gateway-settings',
                success: false,
                error: error.message
            });

            console.error('[App] Failed to persist Hypertuna settings:', error);
            alert(`Failed to update Hypertuna settings: ${error.message}`);
        }
    };
    
 
    /**
     * Public Relay connection method
     * Uses real WebSocket connections to nostr relays
     */
    App.connectRelay = async function() {
        try {
            if (!this.currentUser) {
                throw new Error('User not logged in');
            }
            
            // Check if nostr integration exists
            if (!this.nostr) {
                console.error('NostrIntegration not initialized');
                throw new Error('NostrIntegration not initialized. Please try logging in again.');
            }
            
            // If we're using the local relay, switch to real relays
            if (this.relay && this.relay.isConnected()) {
                this.relay.disconnect();
            }
            
            // Initialize the nostr client
            await this.nostr.connectRelay();
            
            document.getElementById('relay-status').className = 'alert alert-success';
            document.getElementById('relay-status').innerHTML = 'Connected to nostr relays';
            
            this.updateUIState();
        } catch (e) {
            console.error('Error connecting to relays:', e);
            
            document.getElementById('relay-status').className = 'alert alert-error';
            document.getElementById('relay-status').textContent = 'Error connecting to relays: ' + e.message;
        }
    };
    
    /**
     * Display the loading spinner in the groups list
     */
    App.showGroupListSpinner = function() {
        const groupsList = document.getElementById('groups-list');
        if (groupsList) {
            groupsList.innerHTML = '<div class="loading">Loading relays...</div>';
        }
    };

    App.fetchGroupMetadata = async function(groupId) {
        if (!this.nostr || !this.nostr.client) return null;
        
        // Check if already in cache
        const existingGroup = this.nostr.getGroupById(groupId);
        if (existingGroup) return existingGroup;
        
        console.log(`Fetching metadata for group ${groupId}`);
        
        return new Promise((resolve) => {
            const subId = `group-metadata-${groupId}-${Date.now()}`;
            let resolved = false;
            
            const timeoutId = setTimeout(() => {
                this.nostr.client.relayManager.unsubscribe(subId);
                if (!resolved) {
                    resolved = true;
                    resolve(null);
                }
            }, 3000);
            
            this.nostr.client.relayManager.subscribe(subId, [
                {
                    kinds: [NostrEvents.KIND_GROUP_METADATA],
                    "#d": [groupId],
                    limit: 1
                }
            ], (event) => {
                if (!resolved && event.kind === NostrEvents.KIND_GROUP_METADATA) {
                    const groupData = NostrEvents.parseGroupMetadata(event);
                    if (groupData && groupData.id === groupId) {
                        // Manually add to the groups Map for caching
                        this.nostr.client.groups.set(groupId, groupData);
                        
                        // Also fetch the hypertuna mapping
                        const hypertunaId = groupData.hypertunaId;
                        if (hypertunaId) {
                            this.nostr.client.hypertunaGroups.set(hypertunaId, groupId);
                            this.nostr.client.groupHypertunaIds.set(groupId, hypertunaId);
                        }
                        
                        clearTimeout(timeoutId);
                        this.nostr.client.relayManager.unsubscribe(subId);
                        resolved = true;
                        resolve(groupData);
                    }
                }
            });
        });
    };

    /**
     * Gets Hypertuna groups from the nostr client
     */
    App.loadGroups = async function() {
        if (!this.currentUser) return;
    
        const groupsList = document.getElementById('groups-list');
        
        // Only show spinner if we're not already showing one
        if (!groupsList.querySelector('.loading')) {
            this.showGroupListSpinner();
        }
    
        try {
            // Wait for relay list to be ready
            let retries = 0;
            while (!this.nostr.areRelayIdsReady() && retries < 10) {
                await new Promise(resolve => setTimeout(resolve, 500));
                retries++;
            }
    
            // Get groups from the nostr client
            const allGroups = this.nostr.getGroups();
            const allowedIds = this.nostr.getUserRelayGroupIds();
            
            // Extra safety: filter out any groups that don't have the user as a member
            const groups = allGroups.filter(g => {
                // Must be in the user's relay list
                if (!allowedIds.includes(g.hypertunaId)) {
                    return false;
                }
                
                // Additional check: verify user is actually a member
                const isMember = this.nostr.isGroupMember(g.id, this.currentUser.pubkey);
                const isAdmin = this.nostr.isGroupAdmin(g.id, this.currentUser.pubkey);
                const isCreator = g.event && g.event.pubkey === this.currentUser.pubkey;
                
                return isMember || isAdmin || isCreator;
            });
            
            // Add a small delay to prevent flash of "no relays" message
            if (groups.length === 0 && retries < 5) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Re-check after delay
                const updatedGroups = this.nostr.getGroups();
                const updatedAllowedIds = this.nostr.getUserRelayGroupIds();
                const finalGroups = updatedGroups.filter(g => updatedAllowedIds.includes(g.hypertunaId));
                
                if (finalGroups.length > 0) {
                    groups.length = 0;
                    groups.push(...finalGroups);
                }
            }
            
            if (groups.length === 0) {
                groupsList.innerHTML = `
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                            <line x1="12" y1="22.08" x2="12" y2="12"></line>
                        </svg>
                        <p>No Hypertuna relays found</p>
                        <p>Create your first relay to get started!</p>
                    </div>
                `;
                return;
            }
            
            // Clear and populate groups
            groupsList.innerHTML = '';
            
            for (const group of groups) {
                // Skip deleted groups
                if (group.event && group.event.markedAsDeleted) continue;
                
                const groupElement = document.createElement('a');
                groupElement.href = '#';
                groupElement.className = 'group-item';
                
                // Create avatar with first letter of group name or image
                const firstLetter = group.name ? group.name.charAt(0).toUpperCase() : 'G';
                const avatarUrl = this.resolveGroupAvatar(group);
                const avatarMarkup = avatarUrl
                    ? `<img src="${avatarUrl}" alt="${group.name || 'Relay'}">`
                    : firstLetter;
                
                // Use hypertunaId as an additional identifier
                const hypertunaId = group.hypertunaId || '';
                
                const peerCount = hypertunaId ? this.getRelayPeerCount(hypertunaId) : 0;
                const peerLabel = hypertunaId
                    ? (peerCount === 1 ? '1 peer online' : `${peerCount} peers online`)
                    : 'Peers unavailable';

                groupElement.innerHTML = `
                    <div class="group-avatar">${avatarMarkup}</div>
                    <div class="group-info">
                        <div class="group-name">${group.name || 'Unnamed Relay'}</div>
                        <div class="group-description">${group.about || 'No description available'}</div>
                    </div>
                    <div class="group-peer-summary" data-role="peer-count">${peerLabel}</div>
                `;

                if (hypertunaId) {
                    groupElement.dataset.hypertunaId = hypertunaId;
                }
                
                groupElement.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.currentGroupId = group.id;
                    this.currentHypertunaId = hypertunaId;
                    this.navigateTo('group-detail');
                });
                
                groupsList.appendChild(groupElement);
            }
        } catch (e) {
            console.error('Error loading groups:', e);
            groupsList.innerHTML = `
                <div class="status-message error">
                    Error loading relays. Please try again.
                </div>
            `;
        }
    };
    
    /**
     * Replace load group details method
     * Gets group details from the nostr client
     */
    App.loadGroupDetails = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            // Subscribe to this group's events
            this.nostr.client.subscribeToGroup(this.currentGroupId);
            
            // First try to get from cache
            let group = this.nostr.getGroupById(this.currentGroupId);
            
            // If not in cache, fetch it
            if (!group) {
                console.log(`Group ${this.currentGroupId} not in cache, fetching...`);
                group = await this.fetchGroupMetadata(this.currentGroupId);
            }
            
            if (!group || (group.event && group.event.markedAsDeleted)) {
                alert('Group not found or has been deleted');
                this.navigateTo('groups');
                return;
            }
            
            this.currentGroup = group;
            this.currentHypertunaId = group.hypertunaId;
            if (!this.relayGatewayLastToken || this.relayGatewayLastToken.relayKey !== this.currentHypertunaId) {
                this.relayGatewayLastToken = null;
            }

            // Rest of the method remains the same...
            // Update group header with null checks
            const groupNameElement = document.getElementById('group-detail-name');
            if (groupNameElement) {
                groupNameElement.textContent = group.name || 'Unnamed Relay';
            }

            const groupVisibilityElement = document.getElementById('group-detail-visibility');
            if (groupVisibilityElement) {
                groupVisibilityElement.textContent = group.isPublic ? 'Public' : 'Private';
            }

            const groupJoinTypeElement = document.getElementById('group-detail-join-type');
            if (groupJoinTypeElement) {
                groupJoinTypeElement.textContent = group.isOpen ? 'Open' : 'Closed';
            }

            this.updateGroupPeerSummary(group.hypertunaId);

            const groupDescriptionElement = document.getElementById('group-detail-description');
            if (groupDescriptionElement) {
                groupDescriptionElement.textContent = group.about || 'No description available.';
            }
            
            // Load members and check if user is a member/admin - with retries
            await this.loadGroupMembers();
            
            // Check if creator of group is automatically admin and member
            const isCreator = group.event && group.event.pubkey === this.currentUser.pubkey;
            console.log(`Current user is group creator: ${isCreator}`);
            
            // If they're the creator, force-add them to admin and member lists if not already there
            if (isCreator) {
                if (!this.nostr.isGroupAdmin(this.currentGroupId, this.currentUser.pubkey)) {
                    console.log('Group creator not in admin list, adding manually');
                    this.nostr.client.groupAdmins.set(
                        this.currentGroupId, 
                        [...(this.nostr.client.groupAdmins.get(this.currentGroupId) || []),
                        { pubkey: this.currentUser.pubkey, roles: ['admin'] }]
                    );
                }
                
                if (!this.nostr.isGroupMember(this.currentGroupId, this.currentUser.pubkey)) {
                    console.log('Group creator not in member list, adding manually');
                    this.nostr.client.groupMembers.set(
                        this.currentGroupId, 
                        [...(this.nostr.client.groupMembers.get(this.currentGroupId) || []),
                        { pubkey: this.currentUser.pubkey, roles: ['member'] }]
                    );
                }
            }
            
            // Re-check member and admin status
            const isMember = this.nostr.isGroupMember(this.currentGroupId, this.currentUser.pubkey);
            const isAdmin = this.nostr.isGroupAdmin(this.currentGroupId, this.currentUser.pubkey);

            console.log(`Final status checks - isMember: ${isMember}, isAdmin: ${isAdmin}`);

            this.currentGroupIsMember = isMember;
            this.refreshRelayGatewayCard();

            // Update join/leave buttons
            const joinButton = document.getElementById('btn-join-group');
            const leaveButton = document.getElementById('btn-leave-group');
            if (joinButton) joinButton.classList.toggle('hidden', isMember);
            if (leaveButton) leaveButton.classList.toggle('hidden', !isMember);
            
            // Load messages if user is a member
            if (isMember) {
                this.loadGroupMessages();
            } else {
                const messageList = document.getElementById('message-list');
                if (messageList) {
                    messageList.innerHTML = `
                        <div class="empty-state">
                            <p>Join this relay to view messages</p>
                        </div>
                    `;
                }
                const messageInput = document.getElementById('message-input');
                const sendButton = document.getElementById('btn-send-message');
                if (messageInput) messageInput.disabled = true;
                if (sendButton) sendButton.disabled = true;
            }
            
            // Update admin panel visibility
            const adminPanel = document.getElementById('admin-panel');
            if (adminPanel) {
                adminPanel.classList.toggle('hidden', !isAdmin);
            }

            if (isAdmin) {
                this.loadJoinRequests();
            } else {
                const jrSection = document.getElementById('join-requests-section');
                if (jrSection) jrSection.classList.add('hidden');
            }

            const memberPanel = document.getElementById('member-actions');
            if (memberPanel) {
                memberPanel.classList.toggle(
                    'hidden',
                    !(isMember && !isAdmin && group.isOpen)
                );
            }

            const adminInviteBtn = document.getElementById('btn-invite-members');
            if (adminInviteBtn) adminInviteBtn.disabled = !isAdmin;

            const memberInviteBtn = document.getElementById('btn-member-invite');
            if (memberInviteBtn) memberInviteBtn.disabled = !(isMember && group.isOpen);

            // Update settings form
            const settingsForm = document.getElementById('group-settings-form');
            const noPermissionMsg = document.getElementById('group-settings-no-permission');
            
            if (isAdmin && settingsForm && noPermissionMsg) {
                settingsForm.classList.remove('hidden');
                noPermissionMsg.classList.add('hidden');
                
                // Populate settings form with null checks
                const editNameInput = document.getElementById('edit-group-name');
                if (editNameInput) editNameInput.value = group.name || '';
                
                const editDescInput = document.getElementById('edit-group-description');
                if (editDescInput) editDescInput.value = group.about || '';
                
                const editPublicCheckbox = document.getElementById('edit-group-public');
                if (editPublicCheckbox) editPublicCheckbox.checked = group.isPublic;
                
                const editOpenCheckbox = document.getElementById('edit-group-open');
                if (editOpenCheckbox) editOpenCheckbox.checked = group.isOpen;

                const editAvatarPreview = document.getElementById('edit-relay-avatar-preview');
                if (editAvatarPreview) {
                    const avatarUrl = this.resolveGroupAvatar(group);
                    if (avatarUrl) {
                        editAvatarPreview.innerHTML = `<img src="${avatarUrl}" alt="${group.name || 'Relay'}">`;
                    } else {
                        editAvatarPreview.innerHTML = '<span>🛰️</span>';
                    }
                }
                this.pendingEditRelayAvatar = null;
            } else if (settingsForm && noPermissionMsg) {
                settingsForm.classList.add('hidden');
                noPermissionMsg.classList.remove('hidden');
            }
        } catch (e) {
            console.error('Error loading group details:', e);
            alert('Error loading group details');
        }
    };
    
    /**
     * Replace load group messages method
     * Gets messages from the nostr client
     */
    App.loadGroupMessages = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            // First check if user is a member (existing logic)
            const isMember = this.nostr.isGroupMember(this.currentGroupId, this.currentUser.pubkey);
            if (!isMember) return;
            
            const messageList = document.getElementById('message-list');
            
            // Then check if connected to group's relay (new logic)
            if (!this.nostr.isConnectedToGroupRelay(this.currentGroupId)) {
                messageList.innerHTML = `
                    <div class="status-message warning">
                        Connecting to relay...
                    </div>
                `;
                
                // Try to connect if we have the relay URL
                const group = this.nostr.getGroupById(this.currentGroupId);
                if (group && group.hypertunaId) {
                    const relayUrl = this.nostr.client.hypertunaRelayUrls.get(this.currentGroupId);
                    if (relayUrl) {
                        await this.nostr.connectToGroupRelay(this.currentGroupId, relayUrl);
                        // Retry loading messages after connection
                        setTimeout(() => this.loadGroupMessages(), 1000);
                    }
                }
                return;
            }
            
            // Clear message list
            messageList.innerHTML = '';
            
            // Get messages for the group (existing logic continues)
            const messages = this.nostr.getGroupMessages(this.currentGroupId);
            
            if (messages.length === 0) {
                messageList.innerHTML = `
                    <div class="empty-state">
                        <p>No messages yet</p>
                        <p>Be the first to send a message!</p>
                    </div>
                `;
                return;
            }
            
            // Get profiles for all message authors
            const profiles = {};
            const authors = [...new Set(messages.map(msg => msg.pubkey))];
            
            // Fetch profiles for each author
            for (const pubkey of authors) {
                try {
                    const profile = await this.nostr.client.fetchUserProfile(pubkey);
                    profiles[pubkey] = profile;
                } catch (e) {
                    profiles[pubkey] = { name: 'User_' + NostrUtils.truncatePubkey(pubkey) };
                }
            }
            
            // Display messages
            for (const message of messages) {
                const author = profiles[message.pubkey] || { name: 'User_' + NostrUtils.truncatePubkey(message.pubkey) };
                const isCurrentUser = message.pubkey === this.currentUser.pubkey;
                const npub = NostrUtils.hexToNpub(message.pubkey);
                const displayPub = NostrUtils.truncateNpub(npub);

                const messageElement = document.createElement('div');
                messageElement.className = `message ${isCurrentUser ? 'own' : ''}`;

                const contentHtml = await this.renderMessageContent(message);

                messageElement.innerHTML = `
                    <div class="message-bubble">
                        <div class="message-content">${contentHtml}</div>
                    </div>
                    <div class="message-meta">
                        <span>${author.name || 'Unknown'}</span>
                        <span class="message-pubkey">${displayPub}</span>
                        <span>${this.formatTime(message.created_at)}</span>
                    </div>
                `;

                messageList.appendChild(messageElement);
                this.setupDriveMediaFallbacks(messageElement);
            }
            
            // Scroll to bottom
            messageList.scrollTop = messageList.scrollHeight;
            
            // Enable message input
            document.getElementById('message-input').disabled = false;
            document.getElementById('btn-send-message').disabled = false;
            
        } catch (e) {
            console.error('Error loading messages:', e);
            document.getElementById('message-list').innerHTML = `
                <div class="status-message error">
                    Error loading messages. Please try again.
                </div>
            `;
        }
    };
    
    
    /**
     * Replace load group members method
     * Gets members from the nostr client
     */
    App.loadGroupMembers = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
    
        // Debounce rapid calls
        if (this._loadMembersTimeout) {
            clearTimeout(this._loadMembersTimeout);
        }
        
        // Prevent concurrent loads
        if (this._loadingMembers) {
            console.log('Member loading already in progress, skipping');
            return;
        }
        
        this._loadMembersTimeout = setTimeout(async () => {
            await this._doLoadGroupMembers();
            delete this._loadMembersTimeout;
        }, 100);
    };
    
    App._doLoadGroupMembers = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        // Set loading flag
        this._loadingMembers = true;
    
        const container = document.getElementById("member-list");
        if (!container) {
            this._loadingMembers = false;
            return;
        }
        
        // Show loading state only if membersList doesn't exist
        if (!this.membersList) {
            container.innerHTML = '<div class="loading">Loading members...</div>';
        }
    
        // Ensure member list is built from history
        try {
            await this.nostr.client.buildMemberList(this.currentGroupId);
        } catch (err) {
            console.error('Failed to build member list', err);
        }
    
        // Remove old event listeners before adding new ones
        if (this._memberListeners) {
            this._memberListeners.forEach(({ event, handler }) => {
                container.removeEventListener(event, handler);
            });
            this._memberListeners = null;
        }
        
        // Create or update the MembersList instance
        const onlineResolver = (pubkey) => this.isMemberOnline(pubkey, this.currentHypertunaId);

        if (!this.membersList) {
            this.membersList = new MembersList(container, this.nostr.client, this.currentUser.pubkey, {
                onlineStatusResolver: onlineResolver
            });
        } else {
            // Clear rendered members tracking when updating
            this.membersList.clearRenderedMembers();
            this.membersList.container = container;
            this.membersList.client = this.nostr.client;
            this.membersList.setUserPubkey(this.currentUser.pubkey);
            this.membersList.setOnlineStatusResolver(onlineResolver);
        }

        try {
            // Get members and admins
            const members = this.nostr.getGroupMembers(this.currentGroupId);
            const admins = this.nostr.getGroupAdmins(this.currentGroupId);
            
            console.log(`Loading members for group ${this.currentGroupId}:`, {
                memberCount: members.length,
                adminCount: admins.length
            });
            
            // Clear container before rendering to ensure clean slate
            container.innerHTML = '';
            
            // Render the members list
            await this.membersList.render(members, admins);
            this.membersList.updateOnlineStatuses();
            
            // Create new event handlers with proper cleanup
            const promoteHandler = (e) => {
                e.stopPropagation();
                if (e.detail && e.detail.pubkey) {
                    this.updateMemberRole(e.detail.pubkey, ['admin']);
                }
            };
            
            const removeHandler = (e) => {
                e.stopPropagation();
                if (e.detail && e.detail.pubkey) {
                    this.removeMember(e.detail.pubkey);
                }
            };
            
            // Add new listeners
            container.addEventListener('promote', promoteHandler);
            container.addEventListener('remove', removeHandler);
            
            // Store references for cleanup
            this._memberListeners = [
                { event: 'promote', handler: promoteHandler },
                { event: 'remove', handler: removeHandler }
            ];
            
        } catch (e) {
            console.error("Error loading members:", e);
            container.innerHTML = `
                <div class="status-message error">
                    Error loading members. Please try again.
                </div>
            `;
        } finally {
            // Clear loading flag
            this._loadingMembers = false;
        }
    };

    App.renderMembersList = async function(members) {
        if (!this.currentUser || !this.currentGroupId) return;
        const admins = this.nostr.getGroupAdmins(this.currentGroupId);
        const container = document.getElementById("member-list");
        const onlineResolver = (pubkey) => this.isMemberOnline(pubkey, this.currentHypertunaId);

        if (!this.membersList) {
            this.membersList = new MembersList(container, this.nostr.client, this.currentUser.pubkey, {
                onlineStatusResolver: onlineResolver
            });
        } else {
            this.membersList.container = container;
            this.membersList.client = this.nostr.client;
            this.membersList.setUserPubkey(this.currentUser.pubkey);
            this.membersList.setOnlineStatusResolver(onlineResolver);
        }
        await this.membersList.render(members, admins);
        this.membersList.updateOnlineStatuses();
        container.addEventListener('promote', (e) => {
            this.updateMemberRole(e.detail.pubkey, ['admin']);
        });
        container.addEventListener('remove', (e) => {
            this.removeMember(e.detail.pubkey);
        });
    };

    App.escapeHtml = function(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };
    
    // Add this helper method for formatting time
    App.formatTime = function(timestamp) {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diff = now - date;
        
        // If less than 24 hours ago, show time
        if (diff < 24 * 60 * 60 * 1000) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        
        // If less than 7 days ago, show day and time
        if (diff < 7 * 24 * 60 * 60 * 1000) {
            return date.toLocaleDateString([], { weekday: 'short' }) + ' ' + 
                   date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        
        // Otherwise show full date
        return date.toLocaleDateString();
    };

    App.isMediaUrl = function(url) {
        return /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|ogg|mov)$/i.test(url);
    };

    App.setupDriveMediaFallbacks = function(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;

        const attachFallbackSequence = (element, setSource, alternates) => {
            if (!element || !alternates || !alternates.length) return;
            const queue = [...alternates];

            const applyNext = () => {
                const nextUrl = queue.shift();
                if (!nextUrl) return;

                if (queue.length) {
                    const chainedHandler = () => {
                        element.removeEventListener('error', chainedHandler);
                        applyNext();
                    };
                    element.addEventListener('error', chainedHandler, { once: true });
                }

                setSource(nextUrl);
            };

            const onError = () => {
                element.removeEventListener('error', onError);
                applyNext();
            };

            element.addEventListener('error', onError, { once: true });
        };

        const attachImageFallback = (img) => {
            if (!img) return;
            const src = img.getAttribute('src');
            const info = HypertunaUtils.parseDriveUrl(src);
            if (!info) return;
            const driveInfo = HypertunaUtils.buildDriveUrl({
                identifier: info.identifier,
                fileId: info.fileId,
                preferPublic: true
            });
            if (!driveInfo) return;

            const alternates = [];
            if (driveInfo.url && driveInfo.url !== src) alternates.push(driveInfo.url);
            if (driveInfo.fallbackUrl && driveInfo.fallbackUrl !== src) alternates.push(driveInfo.fallbackUrl);
            attachFallbackSequence(img, (nextUrl) => {
                img.setAttribute('src', nextUrl);
            }, alternates);
        };

        const attachVideoFallback = (video) => {
            if (!video) return;
            const sourceEl = video.querySelector?.('source') || null;
            const currentSrc = sourceEl?.getAttribute('src') || video.getAttribute('src');
            const info = HypertunaUtils.parseDriveUrl(currentSrc);
            if (!info) return;
            const driveInfo = HypertunaUtils.buildDriveUrl({
                identifier: info.identifier,
                fileId: info.fileId,
                preferPublic: true
            });
            if (!driveInfo) return;

            const alternates = [];
            if (driveInfo.url && driveInfo.url !== currentSrc) alternates.push(driveInfo.url);
            if (driveInfo.fallbackUrl && driveInfo.fallbackUrl !== currentSrc) alternates.push(driveInfo.fallbackUrl);

            attachFallbackSequence(video, (nextUrl) => {
                if (sourceEl) {
                    sourceEl.setAttribute('src', nextUrl);
                } else {
                    video.setAttribute('src', nextUrl);
                }
                try {
                    video.load();
                } catch (_) {}
            }, alternates);
        };

        root.querySelectorAll('img[src]').forEach(attachImageFallback);
        root.querySelectorAll('video').forEach(attachVideoFallback);
    };

    App.fetchPreview = async function(url) {
        try {
            const oembed = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
            const res = await fetch(oembed);
            if (res.ok) {
                const data = await res.json();
                return {
                    title: data.title || '',
                    description: data.description || '',
                    thumbnail: data.thumbnail_url || '',
                    url
                };
            }
        } catch (e) {
            // ignore oEmbed errors
        }
        const parsedDrive = HypertunaUtils.parseDriveUrl(url);
        const driveUrls = parsedDrive
            ? HypertunaUtils.buildDriveUrl({ identifier: parsedDrive.identifier, fileId: parsedDrive.fileId, preferPublic: true })
            : null;
        const primaryUrl = driveUrls?.url || url;
        const fallbackUrl = driveUrls?.fallbackUrl || null;

        const fetchHtml = async (targetUrl, alternateUrl = null) => {
            const response = await fetch(targetUrl);
            if (!response.ok) {
                if (alternateUrl && alternateUrl !== targetUrl) {
                    return fetchHtml(alternateUrl, null);
                }
                throw new Error(`Preview fetch failed with status ${response.status}`);
            }
            const text = await response.text();
            return { text, usedUrl: targetUrl };
        };

        try {
            const { text, usedUrl } = await fetchHtml(primaryUrl, fallbackUrl);
            const doc = new DOMParser().parseFromString(text, 'text/html');
            const title = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || '';
            const description = doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
            let thumbnail = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
            if (thumbnail) {
                try {
                    thumbnail = new URL(thumbnail, usedUrl).toString();
                } catch (_) {}
            }
            return { title, description, thumbnail, url: usedUrl };
        } catch (e) {
            console.error('fetchPreview failed', e);
        }
        return null;
    };

    App.renderMessageContent = async function(message) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const parts = [];
        let lastIndex = 0;
        const text = this.escapeHtml(message.content);
        for (const match of text.matchAll(urlRegex)) {
            const url = match[0];
            parts.push(text.slice(lastIndex, match.index));
            let replacement = `<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
            if (this.isMediaUrl(url)) {
                if (/\.(mp4|webm|ogg|mov)$/i.test(url)) {
                    replacement = `<video controls class="media-video"><source src="${url}"></video>`;
                } else {
                    replacement = `<img src="${url}" class="media-image"/>`;
                }
            } else {
                const preview = await this.fetchPreview(url);
                if (preview) {
                    replacement = `<a href="${url}" target="_blank" rel="noopener" class="link-preview">`;
                    if (preview.thumbnail) {
                        replacement += `<img src="${preview.thumbnail}" class="preview-thumb">`;
                    }
                    replacement += `<div class="preview-info">`;
                    if (preview.title) {
                        replacement += `<div class="preview-title">${this.escapeHtml(preview.title)}</div>`;
                    }
                    if (preview.description) {
                        replacement += `<div class="preview-desc">${this.escapeHtml(preview.description)}</div>`;
                    }
                    replacement += `</div></a>`;
                }
            }
            parts.push(replacement);
            lastIndex = match.index + url.length;
        }
        parts.push(text.slice(lastIndex));
        return parts.join('');
    };

    App.loadJoinRequests = function() {
        if (!this.currentUser || !this.currentGroupId) return;
        const requests = this.nostr.client.getJoinRequests(this.currentGroupId);
        if (typeof this.updateJoinRequests === 'function') {
            this.updateJoinRequests(this.currentGroupId, requests);
        }
    };
    
    /**
     * Replace create group method
     * Creates a group via the nostr client with Hypertuna events
     */
    App.createGroup = async function() {
        if (!this.currentUser) return;
        
        const name = document.getElementById('new-group-name').value.trim();
        const about = document.getElementById('new-group-description').value.trim();
        const isPublic = document.getElementById('new-group-public').checked;
        const isOpen = document.getElementById('new-group-open').checked;
        const fileSharing = true;
        
        if (!name) {
            alert('Please enter a group name.');
            return;
        }
        
        try {
            // Get the user's npub
            const npub = NostrUtils.hexToNpub(this.currentUser.pubkey); 
            
            console.log("Creating group with parameters:", { name, about, isPublic, isOpen, npub, fileSharing });

            let relayKey = null;

            // Show a modal similar to the join flow
            const modal = document.getElementById('join-auth-modal');
            modal.classList.add('show');
            this.resetAuthModal();
            document.getElementById('auth-status-title').textContent = 'Creating Relay...';
            document.getElementById('auth-status-message').textContent = 'Initializing relay instance in worker...';

            if (window.createRelayInstance) {
                try {
                    // Pass all necessary metadata to the worker for profile creation
                    relayKey = await window.createRelayInstance(name, about, isPublic, isOpen, fileSharing);
                } catch (err) {
                    console.error('Failed to create relay instance:', err);
                }
            }

            const proxyServer = this.currentUser?.hypertunaConfig?.proxy_server_address || '';
            const proxyProtocol = this.currentUser?.hypertunaConfig?.proxy_websocket_protocol || 'wss';

            if (relayKey && relayKey.authToken) {
                await this.showAuthSuccess(relayKey, isPublic);
            } else {
                this.closeJoinAuthModal();
            }

            const eventsCollection = await this.nostr.createGroup(
                name,
                about,
                isPublic,
                isOpen,
                relayKey,
                proxyServer,
                proxyProtocol,
                npub,
                relayKey?.relayUrl || null,
                fileSharing,
                { avatar: this.pendingCreateRelayAvatar }
            );

            console.log(`Group created successfully with public ID: ${eventsCollection.groupId}`);
            console.log(`Internal relay key: ${eventsCollection.internalRelayKey}`);
            
            // Store the mapping in the Nostr client
            if (eventsCollection.internalRelayKey && eventsCollection.groupId) {
                this.nostr.client.publicToInternalMap = this.nostr.client.publicToInternalMap || new Map();
                this.nostr.client.internalToPublicMap = this.nostr.client.internalToPublicMap || new Map();
                
                this.nostr.client.publicToInternalMap.set(eventsCollection.groupId, eventsCollection.internalRelayKey);
                this.nostr.client.internalToPublicMap.set(eventsCollection.internalRelayKey, eventsCollection.groupId);
            }
            
            // Give the relays time to process the events
            console.log("Waiting for relays to process events...");
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Force-load the groups to ensure the new group appears
            console.log("Force reloading groups list...");
            this.loadGroups();
            
            alert('Group created successfully!');
            this.pendingCreateRelayAvatar = null;
            const previewEl = document.getElementById('create-relay-avatar-preview');
            if (previewEl) {
                previewEl.innerHTML = '<span>🛰️</span>';
            }
            // this.navigateTo('groups'); // Don't navigate away immediately, let user see modal
        } catch (e) {
            console.error('Error creating group:', e);
            alert('Error creating group: ' + e.message);
        }
    };
    
    /**
     * Enhanced join group method with authentication flow
     */
    App.joinGroup = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            const group = this.nostr.getGroupById(this.currentGroupId);
            if (!group) return;
            
            if (group.isOpen) {
                // For open groups, show authentication modal
                await this.showJoinAuthModal();
            } else {
                // For closed groups, immediately send join request and display status
                this.showJoinModal(false);
                await this.sendJoinRequest();
            }
        } catch (e) {
            console.error('Error joining group:', e);
            alert('Error joining group: ' + e.message);
        }
    };

    /**
     * Show join authentication modal
     */
    App.showJoinAuthModal = async function() {
        const modal = document.getElementById('join-auth-modal');
        modal.classList.add('show');

        // Reset modal state
        this.resetAuthModal();

        try {
            const group = this.nostr.getGroupById(this.currentGroupId) || {};
            const fileSharing = true;
            // The new global function will handle communication with the worker
            // and return a promise that resolves with the auth result.
            // The UI will be updated by messages from the worker.
            const authResult = await window.joinRelayInstance(this.currentGroupId, fileSharing);

            // The 'join-auth-success' message from the worker will have already
            // called App.showAuthSuccess. We can just log the successful outcome.
            console.log('Worker-driven join flow completed successfully.', authResult);

        } catch (error) {
            console.error('Worker-driven join flow failed:', error);
            // The 'join-auth-error' message from the worker will have already
            // called App.showAuthError. We can just log it here.
        }
    };

    /**
     * Reset authentication modal to initial state
     */
    App.resetAuthModal = function() {
        // Reset progress steps
        document.querySelectorAll('.progress-step').forEach(step => {
            step.classList.remove('active', 'completed');
        });
        document.getElementById('step-request').classList.add('active');
        
        // Show status section
        document.getElementById('auth-status').classList.remove('hidden');
        document.getElementById('auth-success').classList.add('hidden');
        document.getElementById('auth-error').classList.add('hidden');
        
        // Reset status text
        document.getElementById('auth-status-title').textContent = 'Approval Pending';
        document.getElementById('auth-status-message').textContent = 'Registering your pubkey with the relay...';
        
        // Hide continue button
        document.getElementById('btn-close-auth-modal').classList.add('hidden');
        document.getElementById('btn-cancel-auth').classList.remove('hidden');
    };

    /**
     * Update authentication progress
     */
    App.updateAuthProgress = function(step) {
        const steps = ['request', 'verify', 'complete'];
        const currentIndex = steps.indexOf(step);
        
        steps.forEach((s, index) => {
            const stepElement = document.getElementById(`step-${s}`);
            stepElement.classList.remove('active', 'completed');
            
            if (index < currentIndex) {
                stepElement.classList.add('completed');
            } else if (index === currentIndex) {
                stepElement.classList.add('active');
            }
        });
        
        // Update status message based on step
        const statusTitle = document.getElementById('auth-status-title');
        const statusMessage = document.getElementById('auth-status-message');
        
        switch (step) {
            case 'verify':
                statusTitle.textContent = 'Verifying Identity';
                statusMessage.textContent = 'Completing cryptographic handshake...';
                break;
            case 'complete':
                statusTitle.textContent = 'Finalizing';
                statusMessage.textContent = 'Setting up your access credentials...';
                break;
        }
    };

    /**
     * Show authentication success
     * @param {Object} authResult - Result object from the worker
     * @param {boolean|null} [isPublic] - Public flag for the relay if known
     */
    App.showAuthSuccess = async function(authResult, isPublic = null) {
        // Update progress to complete
        this.updateAuthProgress('complete');
        
        // Wait a moment to show completion
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Hide status and show success
        document.getElementById('auth-status').classList.add('hidden');
        document.getElementById('auth-success').classList.remove('hidden');
        document.getElementById('btn-close-auth-modal').classList.remove('hidden');
        document.getElementById('btn-cancel-auth').classList.add('hidden');
        
    
        // IMPORTANT: Update the user's relay list with the FULL authenticated URL
        if (this.nostr && this.nostr.client) {
            // The relayUrl should already include the token from the worker
            await this.nostr.client.updateUserRelayListWithAuth(
                authResult.publicIdentifier,
                authResult.relayUrl, // This should be the full authenticated URL
                authResult.authToken,
                isPublic
            );
        } else {
            console.error("Nostr client not available to update relay list.");
        }
        
        // Reload group details and list
        setTimeout(() => {
            this.loadGroupDetails();
            this.loadGroups();
        }, 500);
    };

    /**
     * Show authentication error
     */
    App.showAuthError = function(errorMessage) {
        document.getElementById('auth-status').classList.add('hidden');
        document.getElementById('auth-error').classList.remove('hidden');
        document.getElementById('auth-error-message').textContent = errorMessage || 'An error occurred during authentication.';
        document.getElementById('btn-cancel-auth').classList.remove('hidden');
    };

    /**
     * Close authentication modal
     */
    App.closeJoinAuthModal = function() {
        document.getElementById('join-auth-modal').classList.remove('show');
        
        // If authentication was successful, navigate to group
        const successSection = document.getElementById('auth-success');
        if (!successSection.classList.contains('hidden')) {
            this.loadGroupDetails();
        }
    };

    /**
     * Setup authentication modal event listeners
     */
    App.setupAuthModalListeners = function() {
        // Close button
        document.getElementById('close-join-auth-modal').addEventListener('click', () => {
            this.closeJoinAuthModal();
        });
        
        // Cancel button
        document.getElementById('btn-cancel-auth').addEventListener('click', () => {
            this.closeJoinAuthModal();
        });
        
        // Continue button (after success)
        document.getElementById('btn-close-auth-modal').addEventListener('click', () => {
            this.closeJoinAuthModal();
        });
        
        // Retry button
        document.getElementById('btn-retry-auth').addEventListener('click', () => {
            this.showJoinAuthModal();
        });
        
        
        // Click outside modal to close
        window.addEventListener('click', (e) => {
            if (e.target.id === 'join-auth-modal') {
                // Only allow closing if not in progress
                const statusSection = document.getElementById('auth-status');
                if (statusSection.classList.contains('hidden')) {
                    this.closeJoinAuthModal();
                }
            }
        });
    };

    /**
     * Replace send join request method
     * Sends a join request via the nostr client
     */
    App.sendJoinRequest = async function(inviteCode = null) {
        if (!this.currentUser || !this.currentGroupId) return;

        const statusEl = document.getElementById('join-request-status');
        if (statusEl) {
            statusEl.classList.add('hidden');
        }

        try {
            const group = this.nostr.getGroupById(this.currentGroupId) || {};
            const fileSharing = true;
            // Build the join request event without publishing
            const event = await this.nostr.joinGroup(
                this.currentGroupId,
                inviteCode,
                { publish: false, fileSharing }
            );

            // Send the event to the gateway
            const gatewaySettings = await HypertunaUtils.getGatewaySettings();
            const gatewayUrl = this.currentUser.hypertunaConfig?.gatewayUrl || gatewaySettings.gatewayUrl;
            const response = await fetch(`${gatewayUrl}/post/join/${this.currentGroupId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event })
            });

            if (response.ok) {
                if (statusEl) {
                    statusEl.textContent = 'join request received – pending admin approval';
                    statusEl.classList.remove('hidden');
                }
                const messageEl = document.getElementById('join-modal-message');
                if (messageEl) {
                    messageEl.textContent = 'Join request submitted.';
                }
            } else {
                const text = await response.text();
                throw new Error(`Gateway error: ${response.status} ${text}`);
            }

            // Reload group details and groups list to reflect membership changes
            setTimeout(() => {
                this.loadGroupDetails();
                this.loadGroups();
            }, 1000);

        } catch (e) {
            console.error('Error sending join request:', e);
            alert('Error joining group: ' + e.message);
            throw e;
        }
    };
    
    /**
     * Replace leave group method
     * Leaves a group via the nostr client
     */
    App.leaveGroup = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.leaveGroup(this.currentGroupId);

            if (window.disconnectRelayInstance && this.currentHypertunaId) {
                window.disconnectRelayInstance(this.currentHypertunaId);
            }
            
            // Reload group details and groups list to reflect membership changes
            setTimeout(() => {
                this.loadGroupDetails();
                this.loadGroups();
            }, 1000);
            
        } catch (e) {
            console.error('Error leaving group:', e);
            alert('Error leaving group: ' + e.message);
        }
    };
    
    /**
     * Replace send message method
     * Sends a message via the nostr client
     */
    App.sendMessage = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        const messageInput = document.getElementById('message-input');
        const fileInput = document.getElementById('message-file');
        const sendButton = document.getElementById('btn-send-message');
        const attachButton = document.getElementById('btn-attach-file');
        const messageText = messageInput.value.trim();

        const file = fileInput.files[0];
        let filePath = '';
        if (file) {
            if ('path' in file && file.path) {
                filePath = file.path;
            } else {
                console.warn('File path is not accessible for the selected attachment');
            }
        }

        if (!messageText && !filePath) return;
        
        try {
            // Disable input and button while sending
            messageInput.disabled = true;
            fileInput.disabled = true;
            sendButton.disabled = true;
            if (attachButton) {
                attachButton.disabled = true;
            }
            
            await this.nostr.sendGroupMessage(
                this.currentGroupId,
                messageText,
                filePath
            );
            
            // Clear inputs
            messageInput.value = '';
            messageInput.style.height = 'auto';
            fileInput.value = '';
            if (attachButton) {
                attachButton.classList.remove('message-attach-btn--active');
                attachButton.setAttribute('aria-pressed', 'false');
            }
            
            // Reload messages
            this.loadGroupMessages();
            
        } catch (e) {
            console.error('Error sending message:', e);
            alert('Error sending message: ' + e.message);
        } finally {
            // Re-enable input and button
            messageInput.disabled = false;
            fileInput.disabled = false;
            sendButton.disabled = false;
            if (attachButton) {
                attachButton.disabled = false;
            }
            messageInput.focus();
        }
    };
    
    
    /**
     * Replace create invite method
     * Creates an invite code via the nostr client
     */
    App.createInvite = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.createGroupInvite(this.currentGroupId);
            
            // Generate invite code (in real implementation, this would come from the relay response)
            const inviteCode = NostrUtils.generateInviteCode();
            
            // Show invite code in modal
            this.showInviteCodeModal(inviteCode);
            
        } catch (e) {
            console.error('Error creating invite code:', e);
            alert('Error creating invite code: ' + e.message);
        }
    };
    
    /**
     * Replace add member method
     * Adds a member via the nostr client
     */
    App.addMember = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        const memberPubkeyInput = document.getElementById('add-member-pubkey').value.trim();
        const role = document.getElementById('add-member-role').value;
        
        if (!memberPubkeyInput) {
            alert('Please enter a valid public key.');
            return;
        }
        
        // Normalize the public key (handles both hex and npub)
        const memberPubkey = NostrUtils.normalizePublicKey(memberPubkeyInput);
        if (!memberPubkey) {
            alert('Invalid public key format. Please enter a hex key or npub format.');
            return;
        }
        
        try {
            await this.nostr.addGroupMember(this.currentGroupId, memberPubkey, [role]);
            
            this.closeAddMemberModal();
            setTimeout(() => {
                this.loadGroupMembers();
            }, 1000);
            
        } catch (e) {
            console.error('Error adding member:', e);
            alert('Error adding member: ' + e.message);
        }
    };
    
    /**
     * Replace update member role method
     * Updates a member's role via the nostr client
     */
    App.updateMemberRole = async function(pubkey, roles) {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.addGroupMember(this.currentGroupId, pubkey, roles);
            
            // Reload members to reflect changes
            setTimeout(() => {
                this.loadGroupMembers();
            }, 1000);
            
        } catch (e) {
            console.error('Error updating member role:', e);
            alert('Error updating member role: ' + e.message);
        }
    };
    
    /**
     * Replace remove member method
     * Removes a member via the nostr client
     */
    App.removeMember = async function(pubkey) {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.removeGroupMember(this.currentGroupId, pubkey);
            
            // Reload members to reflect changes
            setTimeout(() => {
                this.loadGroupMembers();
            }, 1000);
            
        } catch (e) {
            console.error('Error removing member:', e);
            alert('Error removing member: ' + e.message);
        }
    };

    App.approveJoinRequest = async function(pubkey) {
        if (!this.currentUser || !this.currentGroupId) return;
        try {
            await this.nostr.approveJoinRequest(this.currentGroupId, pubkey);
            setTimeout(() => {
                this.loadJoinRequests();
                this.loadGroupMembers();
            }, 500);
        } catch (e) {
            console.error('Error approving join request:', e);
            alert('Error approving join request: ' + e.message);
        }
    };

    App.rejectJoinRequest = function(pubkey) {
        if (!this.currentUser || !this.currentGroupId) return;
        this.nostr.rejectJoinRequest(this.currentGroupId, pubkey);
        this.loadJoinRequests();
    };
    
    /**
     * Replace save group settings method
     * Updates group settings via the nostr client with metadata events
     */
    App.saveGroupSettings = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        const name = document.getElementById('edit-group-name').value.trim();
        const about = document.getElementById('edit-group-description').value.trim();
        const isPublic = document.getElementById('edit-group-public').checked;
        const isOpen = document.getElementById('edit-group-open').checked;
        
        if (!name) {
            alert('Please enter a group name.');
            return;
        }
        
        try {
            const currentGroup = this.nostr.getGroupById(this.currentGroupId) || {};
            let avatarOption = this.pendingEditRelayAvatar;
            if (!avatarOption && currentGroup.pictureIsHypertunaPfp && currentGroup.picture) {
                avatarOption = { tagUrl: currentGroup.picture };
            }

            // Update group metadata with both kind 9002 and 39000 events
            const events = await this.nostr.updateGroupMetadata(this.currentGroupId, {
                name,
                about,
                isPublic,
                isOpen
            }, { avatar: avatarOption });
            
            // Reload group details to reflect changes
            setTimeout(() => {
                this.loadGroupDetails();
            }, 1000);
            
            alert('Group settings updated successfully!');
            this.pendingEditRelayAvatar = null;
            
        } catch (e) {
            console.error('Error updating group settings:', e);
            alert('Error updating group settings: ' + e.message);
        }
    };
    
    /**
     * Replace delete group method
     * Deletes a group via the nostr client
     */
    App.deleteGroup = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.deleteGroup(this.currentGroupId);

            if (window.disconnectRelayInstance && this.currentHypertunaId) {
                window.disconnectRelayInstance(this.currentHypertunaId);
            }
            
            this.closeConfirmationModal();
            alert('Group deletion request sent! The group will be removed once relays process the event.');
            
            // Navigate back to groups list
            setTimeout(() => {
                this.navigateTo('groups');
            }, 1000);
            
        } catch (e) {
            console.error('Error deleting group:', e);
            alert('Error deleting group: ' + e.message);
        }
    };

/**
 * Current list view mode
 */
App.currentListView = 'your'; // 'your' or 'discover'
App.discoverRelaysCache = null;
App.discoverRelaysCacheTime = 0;
App.DISCOVER_CACHE_DURATION = 60000; // 1 minute cache

/**
 * Setup list toggle listeners
 */
App.setupListToggle = function() {
    const toggleOptions = document.querySelectorAll('.toggle-option');
    
    toggleOptions.forEach(option => {
        option.addEventListener('click', (e) => {
            const view = e.target.dataset.view;
            this.switchListView(view);
        });
    });
    
    // Setup following modal listeners
    this.setupFollowingModalListeners();
};

/**
 * Switch between list views
 */
App.switchListView = function(view) {
    if (this.currentListView === view) return;
    
    this.currentListView = view;
    
    // Update toggle buttons
    document.querySelectorAll('.toggle-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    
    // Show/hide appropriate buttons
    const createBtn = document.getElementById('btn-create-new-group');
    const followingBtn = document.getElementById('btn-edit-following');
    
    if (view === 'your') {
        if (createBtn) createBtn.style.display = 'flex';
        if (followingBtn) followingBtn.style.display = 'none';
    } else {
        if (createBtn) createBtn.style.display = 'none';
        if (followingBtn) followingBtn.style.display = 'flex';
    }
    
    // Switch lists
    const groupsList = document.getElementById('groups-list');
    const discoverList = document.getElementById('discover-list');
    
    if (view === 'your') {
        groupsList.classList.remove('hidden');
        discoverList.classList.add('hidden');
        this.loadGroups();
    } else {
        groupsList.classList.add('hidden');
        discoverList.classList.remove('hidden');
        this.loadDiscoverRelays();
    }
};

App.setupKeyFormatToggles = function() {
    // Add toggle buttons next to key displays
    const addToggleButton = (inputId, keyType) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'key-format-toggle';
        toggleBtn.textContent = '[Toggle Format]';
        toggleBtn.onclick = () => {
            const currentFormat = input.dataset.format;
            const hexValue = input.dataset.hex;
            
            if (currentFormat === 'hex') {
                if (keyType === 'public') {
                    input.value = NostrUtils.hexToNpub(hexValue);
                    input.dataset.format = 'npub';
                } else {
                    input.value = NostrUtils.hexToNsec(hexValue);
                    input.dataset.format = 'nsec';
                }
            } else {
                input.value = hexValue;
                input.dataset.format = 'hex';
            }
        };
        
        // Insert after the input
        input.parentElement.appendChild(toggleBtn);
    };
    
    addToggleButton('profile-pubkey-display', 'public');
    addToggleButton('profile-privkey-display', 'private');
};


/**
 * Load discover relays
 */
App.loadDiscoverRelays = async function(force = false) {
    const discoverList = document.getElementById('discover-list');
    if (!discoverList) return;

    if (!this.currentUser || !this.nostr?.client) {
        discoverList.innerHTML = `
            <div class="empty-state">
                <p>Sign in to browse relays from your network.</p>
            </div>
        `;
        return;
    }

    if (!(this.gatewayPeerRelayMap instanceof Map) || this.gatewayPeerRelayMap.size === 0) {
        discoverList.innerHTML = `
            <div class="empty-state">
                <p>No active relays available from the gateway.</p>
                <p>Ensure your gateway is online and peers are registered.</p>
            </div>
        `;
        return;
    }

    const now = Date.now();
    if (!force && this.discoverRelaysCache && (now - this.discoverRelaysCacheTime) < this.DISCOVER_CACHE_DURATION) {
        this.displayDiscoverRelays(this.discoverRelaysCache);
        return;
    }

    discoverList.innerHTML = `
        <div class="discover-loading">
            <div class="loading"></div>
            <div class="discover-loading-text">Loading recommended relays…</div>
        </div>
    `;

    try {
        const followRelayMap = await this.nostr.client.discoverRelaysFromFollows();
        const userRelayIds = this.nostr.client.userRelayIds || new Set();
        const entries = [];
        const gatewayBaseUrl = await this.resolveLocalGatewayBase();

        for (const [identifier, relayInfo] of this.gatewayPeerRelayMap.entries()) {
            if (!identifier || !relayInfo) continue;

            const metadata = relayInfo.metadata && typeof relayInfo.metadata === 'object'
                ? relayInfo.metadata
                : {};
            const followerInfo = followRelayMap.get(identifier);
            const followerCount = followerInfo?.followerCount || 0;

            const isPublic = typeof metadata.isPublic === 'boolean'
                ? metadata.isPublic
                : (typeof followerInfo?.group?.isPublic === 'boolean'
                    ? followerInfo.group.isPublic
                    : true);

            if (!isPublic && followerCount === 0) {
                continue;
            }

            if (userRelayIds instanceof Set && userRelayIds.has(identifier)) {
                continue;
            }

            if (typeof this.nostr.isGroupMember === 'function' && this.nostr.isGroupMember(identifier, this.currentUser.pubkey)) {
                continue;
            }

            const name = metadata.name || followerInfo?.group?.name || 'Unnamed Relay';
            const description = metadata.description || followerInfo?.group?.about || 'No description available';

            const peerCount = typeof relayInfo.peerCount === 'number'
                ? relayInfo.peerCount
                : relayInfo.peers instanceof Set
                    ? relayInfo.peers.size
                    : Array.isArray(relayInfo.peers)
                        ? relayInfo.peers.length
                        : 0;

            const groupData = followerInfo?.group || null;
            const hypertunaId = groupData?.hypertunaId || identifier;
            const avatarUrl = metadata.avatarUrl || (groupData ? this.resolveGroupAvatar(groupData) : null);
            const gatewayPath = this.normalizeGatewayPath(identifier, metadata);
            const connectionUrl = gatewayPath ? `${gatewayBaseUrl}/${gatewayPath}` : null;

            entries.push({
                identifier,
                hypertunaId,
                name,
                description,
                avatarUrl,
                isPublic,
                peerCount,
                followerCount,
                followers: followerInfo?.followers || [],
                group: groupData,
                connectionUrl,
                metadataUpdatedAt: metadata.metadataUpdatedAt || metadata.updatedAt || null,
                metadataEventId: metadata.metadataEventId || null
            });

            if (connectionUrl && this.nostr?.client) {
                try {
                    this.nostr.client.queueRelayConnection(identifier, connectionUrl);
                } catch (err) {
                    console.warn('Failed to queue relay connection', identifier, err);
                }
            }
        }

        entries.sort((a, b) => {
            if (b.followerCount !== a.followerCount) return b.followerCount - a.followerCount;
            if (b.peerCount !== a.peerCount) return b.peerCount - a.peerCount;
            return a.name.localeCompare(b.name);
        });

        this.discoverRelaysCache = entries;
        this.discoverRelaysCacheTime = now;

        this.displayDiscoverRelays(entries);
    } catch (error) {
        console.error('Error discovering relays:', error);
        discoverList.innerHTML = `
            <div class="empty-state">
                <p>Error discovering relays</p>
                <p>Please try again later</p>
            </div>
        `;
    }
};

/**
 * Display discovered relays
 */
App.displayDiscoverRelays = function(relays) {
    const discoverList = document.getElementById('discover-list');
    if (!discoverList) return;

    let entries = relays;
    if (entries instanceof Map) {
        entries = Array.from(entries.entries()).map(([identifier, relayData]) => ({
            identifier,
            hypertunaId: relayData.group?.hypertunaId || identifier,
            name: relayData.group?.name || 'Unnamed Relay',
            description: relayData.group?.about || 'No description available',
            avatarUrl: this.resolveGroupAvatar(relayData.group),
            followers: relayData.followers || [],
            followerCount: relayData.followerCount || 0,
            peerCount: this.getRelayPeerCount(relayData.group?.hypertunaId || identifier),
            isPublic: typeof relayData.group?.isPublic === 'boolean' ? relayData.group.isPublic : true,
            group: relayData.group || null,
            connectionUrl: relayData.connectionUrl || null
        }));
    }

    if (!Array.isArray(entries) || entries.length === 0) {
        discoverList.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                    <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
                <p>No relays match the current criteria.</p>
                <p>Follow more people or wait for peers to come online.</p>
            </div>
        `;
        return;
    }

    discoverList.innerHTML = '';

    entries.forEach((entry) => {
        const {
            identifier,
            hypertunaId,
            name,
            description,
            avatarUrl,
            followers = [],
            followerCount = 0,
            peerCount = 0,
            isPublic = true,
            group = null,
            connectionUrl = null
        } = entry;

        if (this.nostr && typeof this.nostr.isGroupMember === 'function' && this.currentUser) {
            if (this.nostr.isGroupMember(identifier, this.currentUser.pubkey)) {
                return;
            }
        }

        const groupElement = document.createElement('a');
        groupElement.href = '#';
        groupElement.className = 'group-item group-item-with-followers';

        const displayName = name || 'Unnamed Relay';
        const descriptionText = description || 'No description available';
        const displayNameEsc = this.escapeHtml(displayName);
        const descriptionEsc = this.escapeHtml(descriptionText);
        const visibilityLabel = isPublic ? 'Public Relay' : 'Private Relay';
        const visibilityEsc = this.escapeHtml(visibilityLabel);

        const fallbackLetter = displayName.trim() ? displayName.trim().charAt(0).toUpperCase() : 'R';
        const resolvedAvatar = avatarUrl || (group ? this.resolveGroupAvatar(group) : null);
        const avatarMarkup = resolvedAvatar
            ? `<img src="${this.escapeHtml(resolvedAvatar)}" alt="${displayNameEsc}">`
            : this.escapeHtml(fallbackLetter);

        const maxAvatars = 3;
        const displayedFollowers = followers.slice(0, maxAvatars);
        const additionalCount = Math.max(0, followers.length - displayedFollowers.length);

        const avatarsHtml = displayedFollowers.map((follower) => {
            const followerName = follower.profile?.name || '';
            const followerNameEsc = this.escapeHtml(followerName || 'Unknown user');
            const initial = followerName ? followerName.charAt(0).toUpperCase() : '?';
            const followerAvatar = follower.profile?.picture
                ? HypertunaUtils.resolvePfpUrl(
                    follower.profile.pictureTagUrl || follower.profile.picture,
                    follower.profile.pictureIsHypertunaPfp
                )
                : null;

            if (followerAvatar) {
                return `
                    <div class="follower-avatar">
                        <img src="${this.escapeHtml(followerAvatar)}" alt="${followerNameEsc}">
                        <div class="follower-tooltip">${followerNameEsc}</div>
                    </div>
                `;
            }

            return `
                <div class="follower-avatar">
                    <span>${this.escapeHtml(initial)}</span>
                    <div class="follower-tooltip">${followerNameEsc}</div>
                </div>
            `;
        }).join('');

        const latestPeerCount = this.getRelayPeerCount(hypertunaId) || peerCount || 0;
        const peerLabel = latestPeerCount === 1 ? '1 peer online' : `${latestPeerCount} peers online`;

        groupElement.innerHTML = `
            <div class="group-avatar">${avatarMarkup}</div>
            <div class="group-info">
                <div class="group-name">${displayNameEsc}</div>
                <div class="group-description">${descriptionEsc}</div>
                <div class="group-visibility muted">${visibilityEsc}</div>
            </div>
            <div class="group-peer-summary" data-role="peer-count">${this.escapeHtml(peerLabel)}</div>
            <div class="followers-info">
                <div class="followers-avatars">
                    ${avatarsHtml}
                </div>
                <div class="followers-count">
                    ${this.escapeHtml(String(followerCount))} ${followerCount === 1 ? 'follow' : 'follows'}
                    ${additionalCount > 0 ? `+${this.escapeHtml(String(additionalCount))}` : ''}
                </div>
            </div>
        `;

        if (hypertunaId) {
            groupElement.dataset.hypertunaId = hypertunaId;
        }

        if (connectionUrl) {
            groupElement.dataset.connectionUrl = connectionUrl;
        }

        groupElement.addEventListener('click', (e) => {
            e.preventDefault();
            if (connectionUrl && this.nostr?.client) {
                try {
                    this.nostr.client.queueRelayConnection(identifier, connectionUrl);
                } catch (err) {
                    console.warn('Failed to queue relay connection on click', identifier, err);
                }
            }
            this.currentGroupId = identifier;
            this.currentHypertunaId = hypertunaId;
            this.navigateTo('group-detail');
        });

        discoverList.appendChild(groupElement);
    });

    if (typeof this.updateVisibleGroupPeerSummaries === 'function') {
        this.updateVisibleGroupPeerSummaries();
    }
};

// properties for following management
App.followingModalOpen = false;
App.pendingFollowChanges = {
    toAdd: new Set(),
    toRemove: new Set()
};
App.originalFollows = new Set();
// properties for invite members management
App.inviteMembersModalOpen = false;
App.pendingInvites = new Set();

/**
 * Show the following modal
 */
App.showFollowingModal = async function() {
    this.followingModalOpen = true;
    document.getElementById('following-modal').classList.add('show');
    
    // Reset pending changes
    this.pendingFollowChanges.toAdd.clear();
    this.pendingFollowChanges.toRemove.clear();
    
    // Load current follows
    await this.loadFollowingList();
    
    // Clear the input
    document.getElementById('add-follow-pubkey').value = '';
};

/**
 * Close the following modal
 */
App.closeFollowingModal = function() {
    this.followingModalOpen = false;
    document.getElementById('following-modal').classList.remove('show');
    
    // Reset pending changes
    this.pendingFollowChanges.toAdd.clear();
    this.pendingFollowChanges.toRemove.clear();
};

/**
 * Load and display the following list
 */
App.loadFollowingList = async function() {
    const followingList = document.getElementById('following-list');
    const followingCount = document.getElementById('following-count');
    
    // Show loading state
    followingList.innerHTML = '<div class="following-loading">Loading...</div>';
    
    try {
        // Get current follows
        const follows = this.nostr.client.follows;
        this.originalFollows = new Set(follows);
        
        if (follows.size === 0) {
            followingList.innerHTML = `
                <div class="following-empty">
                    <p>You're not following anyone yet</p>
                </div>
            `;
            followingCount.textContent = '(0)';
            return;
        }
        
        // Fetch profiles for all follows
        const followsArray = Array.from(follows);
        const profiles = await this.nostr.client.fetchMultipleProfiles(followsArray);
        
        // Update count
        followingCount.textContent = `(${follows.size})`;
        
        // Clear list
        followingList.innerHTML = '';
        
        // Display each follow
        followsArray.forEach(pubkey => {
            const profile = profiles.get(pubkey) || { 
                name: `User_${NostrUtils.truncatePubkey(pubkey)}`,
                pubkey 
            };
            
            const followItem = document.createElement('div');
            followItem.className = 'following-item';
            followItem.dataset.pubkey = pubkey;
            
            const name = profile.name || `User_${NostrUtils.truncatePubkey(pubkey)}`;
            const firstLetter = name.charAt(0).toUpperCase();
            
            const resolvedPicture = profile.picture
                ? HypertunaUtils.resolvePfpUrl(profile.pictureTagUrl || profile.picture, profile.pictureIsHypertunaPfp)
                : null;
            const avatarHtml = resolvedPicture
                ? `<img src="${resolvedPicture}" alt="${name}">`
                : `<span>${firstLetter}</span>`;
            
            const npub = NostrUtils.hexToNpub(pubkey);
            const displayPub = NostrUtils.truncateNpub(npub);

            followItem.innerHTML = `
                <div class="following-avatar">
                    ${avatarHtml}
                </div>
                <div class="following-info">
                    <div class="following-name">${name}</div>
                    <div class="following-pubkey">${displayPub}</div>
                </div>
                <button class="btn-remove" data-pubkey="${pubkey}">Remove</button>
            `;
            
            // Add remove handler
            const removeBtn = followItem.querySelector('.btn-remove');
            removeBtn.addEventListener('click', () => {
                this.toggleFollowRemoval(pubkey);
            });
            
            followingList.appendChild(followItem);
        });
        
    } catch (e) {
        console.error('Error loading following list:', e);
        followingList.innerHTML = `
            <div class="following-empty">
                <p>Error loading following list</p>
            </div>
        `;
    }
};

/**
 * Add a new follow
 */
App.addFollow = async function() {
    const input = document.getElementById('add-follow-pubkey');
    let pubkeyInput = input.value.trim();
    
    if (!pubkeyInput) {
        alert('Please enter a public key');
        return;
    }
    
    // Normalize the public key input
    const pubkey = NostrUtils.normalizePublicKey(pubkeyInput);
    if (!pubkey) {
        alert('Invalid public key format. Please enter a hex key or npub format.');
        return;
    }
    
    // Validate hex pubkey
    if (!/^[a-fA-F0-9]{64}$/.test(pubkey)) {
        alert('Invalid public key format. Must be 64 hex characters.');
        return;
    }
    
    // Check if already following
    if (this.originalFollows.has(pubkey) && !this.pendingFollowChanges.toRemove.has(pubkey)) {
        alert('You are already following this user');
        return;
    }
    
    // Add to pending additions
    this.pendingFollowChanges.toAdd.add(pubkey);
    if (this.pendingFollowChanges.toRemove.has(pubkey)) {
        this.pendingFollowChanges.toRemove.delete(pubkey);
    }
    
    // Fetch profile and add to list
    try {
        const profile = await this.nostr.client.fetchUserProfile(pubkey);
        const name = profile.name || `User_${NostrUtils.truncatePubkey(pubkey)}`;
        const firstLetter = name.charAt(0).toUpperCase();
        
        const followingList = document.getElementById('following-list');
        
        // Remove empty state if present
        const emptyState = followingList.querySelector('.following-empty');
        if (emptyState) {
            emptyState.remove();
        }
        
        const followItem = document.createElement('div');
        followItem.className = 'following-item pending-addition';
        followItem.dataset.pubkey = pubkey;
        
        const resolvedPicture = profile.picture
            ? HypertunaUtils.resolvePfpUrl(profile.pictureTagUrl || profile.picture, profile.pictureIsHypertunaPfp)
            : null;
        const avatarHtml = resolvedPicture
            ? `<img src="${resolvedPicture}" alt="${name}">`
            : `<span>${firstLetter}</span>`;
        
        const npubAdded = NostrUtils.hexToNpub(pubkey);
        const displayPubAdded = NostrUtils.truncateNpub(npubAdded);

        followItem.innerHTML = `
            <div class="following-avatar">
                ${avatarHtml}
            </div>
            <div class="following-info">
                <div class="following-name">${name}</div>
                <div class="following-pubkey">${displayPubAdded}</div>
            </div>
            <button class="btn-remove" data-pubkey="${pubkey}">Remove</button>
        `;
        
        // Add remove handler
        const removeBtn = followItem.querySelector('.btn-remove');
        removeBtn.addEventListener('click', () => {
            this.toggleFollowRemoval(pubkey);
        });
        
        // Add to top of list
        followingList.insertBefore(followItem, followingList.firstChild);
        
        // Clear input
        input.value = '';
        
        // Update count
        const currentCount = this.originalFollows.size + this.pendingFollowChanges.toAdd.size - this.pendingFollowChanges.toRemove.size;
        document.getElementById('following-count').textContent = `(${currentCount})`;
        
    } catch (e) {
        console.error('Error adding follow:', e);
        alert('Error adding follow. Please try again.');
    }
};

/**
 * Toggle removal of a follow
 */
App.toggleFollowRemoval = function(pubkey) {
    const item = document.querySelector(`.following-item[data-pubkey="${pubkey}"]`);
    if (!item) return;
    
    if (this.pendingFollowChanges.toAdd.has(pubkey)) {
        // If it was pending addition, just remove it
        this.pendingFollowChanges.toAdd.delete(pubkey);
        item.remove();
    } else if (this.pendingFollowChanges.toRemove.has(pubkey)) {
        // Cancel removal
        this.pendingFollowChanges.toRemove.delete(pubkey);
        item.classList.remove('pending-removal');
    } else {
        // Mark for removal
        this.pendingFollowChanges.toRemove.add(pubkey);
        item.classList.add('pending-removal');
    }
    
    // Update count
    const currentCount = this.originalFollows.size + this.pendingFollowChanges.toAdd.size - this.pendingFollowChanges.toRemove.size;
    document.getElementById('following-count').textContent = `(${currentCount})`;
};

/**
 * Save following changes
 */
App.saveFollowingChanges = async function() {
    if (this.pendingFollowChanges.toAdd.size === 0 && this.pendingFollowChanges.toRemove.size === 0) {
        this.closeFollowingModal();
        return;
    }
    
    try {
        // Show saving state
        const saveBtn = document.getElementById('btn-save-following');
        const originalText = saveBtn.textContent;
        saveBtn.textContent = 'Saving...';
        saveBtn.disabled = true;
        
        // Create new follows set
        const newFollows = new Set(this.originalFollows);
        
        // Apply removals
        this.pendingFollowChanges.toRemove.forEach(pubkey => {
            newFollows.delete(pubkey);
            this.nostr.client.follows.delete(pubkey);
        });
        
        // Apply additions
        this.pendingFollowChanges.toAdd.forEach(pubkey => {
            newFollows.add(pubkey);
            this.nostr.client.follows.add(pubkey);
            this.nostr.client.relevantPubkeys.add(pubkey);
        });
        
        // Create kind 3 event
        const tags = Array.from(newFollows).map(pubkey => ['p', pubkey]);
        
        const event = await NostrEvents.createEvent(
            3, // Kind 3 - Contact List
            '', // Empty content
            tags,
            this.currentUser.privateKey
        );
        
        // Publish the event
        await this.nostr.client.relayManager.publish(event);
        
        // Clear pending changes
        this.pendingFollowChanges.toAdd.clear();
        this.pendingFollowChanges.toRemove.clear();
        
        // Close modal
        this.closeFollowingModal();
        
        // Refresh discover view if active
        if (this.currentListView === 'discover') {
            // Clear cache to force refresh
            this.discoverRelaysCache = null;
            this.loadDiscoverRelays();
        }
        
        alert('Following list updated successfully!');
        
    } catch (e) {
        console.error('Error saving following changes:', e);
        alert('Error saving changes. Please try again.');
    } finally {
        const saveBtn = document.getElementById('btn-save-following');
        saveBtn.textContent = 'Save Changes';
        saveBtn.disabled = false;
    }
};

/**
 * Show the invite members modal
 */
App.showInviteMembersModal = async function() {
    this.inviteMembersModalOpen = true;
    document.getElementById('invite-members-modal').classList.add('show');

    // Reset any pending invites
    this.pendingInvites.clear();

    // Load followed users to invite
    const list = document.getElementById('invite-members-list');
    list.innerHTML = '<div class="following-loading">Loading...</div>';

    try {
        const follows = this.nostr.client.follows;

        if (follows.size === 0) {
            list.innerHTML = `
                <div class="following-empty">
                    <p>You're not following anyone yet</p>
                </div>
            `;
            return;
        }

        const followsArray = Array.from(follows);
        const profiles = await this.nostr.client.fetchMultipleProfiles(followsArray);

        list.innerHTML = '';

        followsArray.forEach(pubkey => {
            const profile = profiles.get(pubkey) || { name: `User_${NostrUtils.truncatePubkey(pubkey)}` };
            const npub = NostrUtils.hexToNpub(pubkey);
            const displayPub = NostrUtils.truncateNpub(npub);

            const item = document.createElement('div');
            item.className = 'invite-member-item';
            item.dataset.pubkey = pubkey;
            item.innerHTML = `
                <label>
                    <input type="checkbox" data-pubkey="${pubkey}">
                    <div class="invite-member-info">
                        <div class="name">${profile.name}</div>
                        <div class="pubkey">${displayPub}</div>
                    </div>
                </label>`;

            const checkbox = item.querySelector('input');
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.pendingInvites.add(pubkey); else this.pendingInvites.delete(pubkey);
            });

            list.appendChild(item);
        });
    } catch (e) {
        console.error('Error loading invite members list:', e);
        list.innerHTML = `
            <div class="following-empty">
                <p>Error loading list</p>
            </div>
        `;
    }

    document.getElementById('invite-member-pubkey').value = '';
};

/**
 * Close the invite members modal
 */
App.closeInviteMembersModal = function() {
    this.inviteMembersModalOpen = false;
    document.getElementById('invite-members-modal').classList.remove('show');

    this.pendingInvites.clear();
    document.getElementById('invite-members-list').innerHTML = '';
    document.getElementById('invite-member-pubkey').value = '';
};

/**
 * Send invites to selected members
 */
App.saveInviteMembers = async function() {
    const additionalInput = document.getElementById('invite-member-pubkey').value.trim();
    if (additionalInput) {
        const normalized = NostrUtils.normalizePublicKey(additionalInput);
        if (!normalized || !/^[a-fA-F0-9]{64}$/.test(normalized)) {
            alert('Invalid public key format.');
            return;
        }
        this.pendingInvites.add(normalized);
    }

    if (this.pendingInvites.size === 0) {
        this.closeInviteMembersModal();
        return;
    }

    const btn = document.getElementById('btn-send-invites');
    const originalText = btn.textContent;
    btn.textContent = 'Sending...';
    btn.disabled = true;

    try {
        const pubkeys = Array.from(this.pendingInvites);
        await this.nostr.inviteMembers(this.currentGroupId, pubkeys);

        alert('Invites sent successfully!');
        this.closeInviteMembersModal();
    } catch (e) {
        console.error('Error sending invites:', e);
        alert('Error sending invites. Please try again.');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
        this.pendingInvites.clear();
    }
};

/**
 * Setup following modal event listeners
 */
App.setupFollowingModalListeners = function() {
    // Edit following button
    const editFollowingBtn = document.getElementById('btn-edit-following');
    if (editFollowingBtn) {
        editFollowingBtn.addEventListener('click', () => {
            this.showFollowingModal();
        });
    }
    
    // Modal controls
    document.getElementById('close-following-modal').addEventListener('click', () => {
        this.closeFollowingModal();
    });
    
    document.getElementById('btn-cancel-following').addEventListener('click', () => {
        this.closeFollowingModal();
    });
    
    document.getElementById('btn-save-following').addEventListener('click', () => {
        this.saveFollowingChanges();
    });
    
    document.getElementById('btn-add-follow').addEventListener('click', () => {
        this.addFollow();
    });
    
    // Enter key in input
    document.getElementById('add-follow-pubkey').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            this.addFollow();
        }
    });
    
    // Click outside modal
    window.addEventListener('click', (e) => {
        if (e.target.id === 'following-modal') {
            this.closeFollowingModal();
        }
    });
};


    // Update handleRelayInitialized in AppIntegration.js:
    App.handleRelayInitialized = function(data) {
        console.log('[App] Received relay-initialized:', {
            relayKey: data.relayKey,
            publicIdentifier: data.publicIdentifier,
            hasUrl: !!data.gatewayUrl,
            hasToken: data.gatewayUrl?.includes('?token='),
            timestamp: data.timestamp
        });
        
        const identifier = data.publicIdentifier || data.relayKey;
        
        // Track state
        if (!relayReadinessTracker.has(identifier)) {
            relayReadinessTracker.set(identifier, {
                initialized: false,
                registered: false,
                initCount: 0,
                regCount: 0,
                lastUrl: null
            });
        }
        
        const state = relayReadinessTracker.get(identifier);
        state.initialized = true;
        state.initCount++;
        state.lastUrl = data.gatewayUrl;
        state.requiresAuth = data.requiresAuth === true;
        
        console.log(`[App] Relay ${identifier} state after initialized:`, state);
        
        if (this.nostr) {
            this.nostr.handleRelayInitialized(identifier, data.gatewayUrl, data.userAuthToken, {
                requiresAuth: data.requiresAuth === true
            });
        }
    };

    // Add handleRelayRegistered if it doesn't exist:
    App.handleRelayRegistered = function(data) {
        console.log('[App] Received relay-registration-complete:', {
            relayKey: data.relayKey,
            publicIdentifier: data.publicIdentifier,
            hasUrl: !!data.gatewayUrl,
            hasToken: data.gatewayUrl?.includes('?token='),
            timestamp: data.timestamp
        });
        
        const identifier = data.publicIdentifier || data.relayKey;
        
        // Track state
        if (!relayReadinessTracker.has(identifier)) {
            relayReadinessTracker.set(identifier, {
                initialized: false,
                registered: false,
                initCount: 0,
                regCount: 0,
                lastUrl: null
            });
        }
        
        const state = relayReadinessTracker.get(identifier);
        state.registered = true;
        state.regCount++;
        if (data.gatewayUrl) {
            state.lastUrl = data.gatewayUrl;
        }
        
        console.log(`[App] Relay ${identifier} state after registered:`, state);
        console.log('[App] All relay states:', Array.from(relayReadinessTracker.entries()));
        
        if (this.nostr) {
            this.nostr.handleRelayRegistered(identifier);
        }
    };

    // Process any queued worker messages that arrived before handlers were ready
    if (window.pendingRelayMessages) {
        while (window.pendingRelayMessages.initialized.length) {
            App.handleRelayInitialized(window.pendingRelayMessages.initialized.shift());
        }
        while (window.pendingRelayMessages.registered.length) {
            App.handleRelayRegistered(window.pendingRelayMessages.registered.shift());
        }
    }
    
    /**
     * Replace update profile method
     * Updates user profile via the nostr client
     */
    App.updateProfile = async function(options = {}) {
        if (!this.currentUser) return;

        const {
            silent = false,
            omitPendingAvatar = false,
            forcePicture = null
        } = options;

        const name = document.getElementById('profile-name-input').value.trim();
        const about = document.getElementById('profile-about-input').value.trim();
        const profileTags = [];
        const profileUpdate = { name, about };

        let pictureSource = null;

        if (forcePicture) {
            pictureSource = { ...forcePicture, fromPending: true };
        } else if (!omitPendingAvatar && this.pendingProfileAvatar) {
            pictureSource = { ...this.pendingProfileAvatar, fromPending: true };
        } else if (this.currentUser?.picture) {
            pictureSource = {
                pictureUrl: this.currentUser.picture,
                tagUrl: this.currentUser.pictureTagUrl,
                fromHypertuna: !!this.currentUser.pictureIsHypertunaPfp
            };
        }

        if (pictureSource?.pictureUrl) {
            profileUpdate.picture = pictureSource.pictureUrl;
            if (pictureSource.tagUrl && (pictureSource.fromPending || pictureSource.fromHypertuna || forcePicture)) {
                profileTags.push(['picture', pictureSource.tagUrl, 'hypertuna:drive:pfp']);
            }
        }

        try {
            await this.nostr.updateProfile(profileUpdate, { tags: profileTags });

            this.currentUser.name = name;
            this.currentUser.about = about;

            if (pictureSource?.pictureUrl) {
                this.currentUser.picture = pictureSource.pictureUrl;
                if (pictureSource.tagUrl) {
                    this.currentUser.pictureTagUrl = pictureSource.tagUrl;
                }
                if (pictureSource.fromPending || pictureSource.fromHypertuna || forcePicture) {
                    this.currentUser.pictureIsHypertunaPfp = true;
                }
            }

            if (forcePicture && this.pendingProfileAvatar && this.pendingProfileAvatar.fileHash === forcePicture.fileHash) {
                this.pendingProfileAvatar = null;
                delete this.currentUser.tempAvatarPreview;
            } else if (!omitPendingAvatar && this.pendingProfileAvatar && !forcePicture) {
                this.pendingProfileAvatar = null;
                delete this.currentUser.tempAvatarPreview;
            }

            this.saveUserToLocalStorage();
            this.updateProfileDisplay();

            if (!silent) {
                alert('Profile updated successfully');
            }
        } catch (e) {
            console.error('Error updating profile:', e);
            alert('Error updating profile: ' + e.message);
        }
    };
    
    /**
     * Normalize a relay URL for display and connection
     * @param {string} url - Relay URL entered by the user
     * @returns {{normalized: string, connection: string, display: string}|null}
     */
    App.normalizeRelayUrl = function(url) {
        if (!url) return null;

        let value = url.trim();
        if (!value) return null;

        if (!/^wss?:\/\//i.test(value)) {
            value = `wss://${value}`;
        }

        try {
            const parsed = new URL(value);
            const basePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/$/, '') : '';
            const normalized = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${basePath}`;
            const connection = parsed.toString();
            const display = normalized || connection;

            return { normalized, connection, display };
        } catch (error) {
            console.warn('[App] Invalid relay URL provided:', url, error);
            return null;
        }
    };

    /**
     * Merge relay URL lists while preserving order and removing duplicates
     * @param {string[]} primary - Primary list of relay URLs
     * @param {string[]} secondary - Secondary list of relay URLs to append if missing
     * @returns {string[]} - Merged array of connection URLs
     */
    App.mergeRelayLists = function(primary = [], secondary = []) {
        const merged = [];
        const seen = new Set();

        const append = (value) => {
            const normalized = this.normalizeRelayUrl(value);
            if (!normalized) return;
            if (seen.has(normalized.normalized)) return;
            seen.add(normalized.normalized);
            merged.push(normalized.connection);
        };

        primary.forEach(append);
        secondary.forEach(append);

        return merged;
    };

    App.loadPersistedDiscoveryRelays = function() {
        if (typeof localStorage === 'undefined') {
            return [];
        }

        try {
            const raw = localStorage.getItem(this.discoveryRelayStorageKey);
            if (!raw) return [];

            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];

            return this.mergeRelayLists(parsed, []);
        } catch (error) {
            console.warn('Failed to load discovery relay whitelist:', error);
            return [];
        }
    };

    /**
     * Replace current discovery relay list with provided URLs
     * @param {string[]|Array} relayUrls - Array of relay URLs
     * @param {Object} [options]
     * @param {boolean} [options.skipRender] - Skip UI render (used internally)
     */
    App.setDiscoveryRelays = function(relayUrls = [], { skipRender = false } = {}) {
        const nextRelays = new Map();

        relayUrls.forEach((entry) => {
            const value = typeof entry === 'string' ? entry : entry?.connection || entry?.url;
            const normalized = this.normalizeRelayUrl(value);
            if (normalized) {
                nextRelays.set(normalized.normalized, normalized);
            }
        });

        this.discoveryRelays = nextRelays;

        if (!skipRender) {
            if (typeof this.renderDiscoveryRelays === 'function') {
                this.renderDiscoveryRelays();
            } else {
                this._pendingDiscoveryRender = true;
            }
        }
    };

    App.persistedDiscoveryRelays = App.loadPersistedDiscoveryRelays();
    if (App.persistedDiscoveryRelays.length > 0 && App.discoveryRelays.size === 0) {
        App.setDiscoveryRelays(App.persistedDiscoveryRelays);
    }

    /**
     * Get discovery relay URLs for connection
     * @returns {string[]}
     */
    App.getDiscoveryRelays = function() {
        return Array.from(this.discoveryRelays.values()).map(entry => entry.connection);
    };

    /**
     * Render discovery relay list UI
     */
    App.renderDiscoveryRelays = function() {
        const listEl = document.getElementById('discovery-relay-list');
        const emptyState = document.getElementById('discovery-relay-empty');
        if (!listEl) return;

        const entries = Array.from(this.discoveryRelays.values());

        listEl.innerHTML = '';

        if (entries.length === 0) {
            if (emptyState) emptyState.classList.remove('hidden');
            listEl.classList.add('hidden');
            if (typeof this.updateDiscoveryRelaySummary === 'function') {
                this.updateDiscoveryRelaySummary();
            }
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');
        listEl.classList.remove('hidden');

        entries.forEach((entry) => {
            const rawStatus = this.nostr?.client?.relayManager?.getRelayStatus(entry.connection) ||
                this.nostr?.client?.relayManager?.getRelayStatus(entry.normalized) ||
                'closed';
            const indicatorStatusSource = rawStatus === 'pending' ? 'connecting' : rawStatus;
            const indicatorStatus = ['open', 'connecting', 'closed', 'error'].includes(indicatorStatusSource)
                ? indicatorStatusSource
                : 'closed';

            const item = document.createElement('li');
            item.className = 'relay-list-item';
            item.dataset.relayUrl = entry.normalized;

            const main = document.createElement('div');
            main.className = 'relay-item-main';

            const indicator = document.createElement('span');
            indicator.className = `status-indicator status-${indicatorStatus}`;
            indicator.setAttribute('aria-hidden', 'true');
            indicator.title = indicatorStatus.charAt(0).toUpperCase() + indicatorStatus.slice(1);

            const text = document.createElement('span');
            text.className = 'relay-url';
            text.textContent = entry.display;

            main.append(indicator, text);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'relay-remove-btn';
            removeBtn.type = 'button';
            removeBtn.innerHTML = '&times;';
            removeBtn.setAttribute('aria-label', `Remove relay ${entry.display}`);

            item.append(main, removeBtn);
            listEl.appendChild(item);
        });

        if (typeof this.updateDiscoveryRelaySummary === 'function') {
            this.updateDiscoveryRelaySummary();
        }
    };

    if (App._pendingDiscoveryRender) {
        App._pendingDiscoveryRender = false;
        App.renderDiscoveryRelays();
    }

    /**
     * Update discovery relay summary count text
     */
    App.updateDiscoveryRelaySummary = function() {
        const summaryEl = document.getElementById('discovery-relay-count');
        if (!summaryEl) return;

        const manager = this.nostr?.client?.relayManager || null;
        const entries = Array.from(this.discoveryRelays.values());

        let connected = 0;
        if (manager) {
            entries.forEach(entry => {
                const status = manager.getRelayStatus(entry.connection) || manager.getRelayStatus(entry.normalized);
                if (status === 'open') connected += 1;
            });
        }

        const label = connected === 1 ? 'Connected Relay' : 'Connected Relays';
        summaryEl.textContent = `${connected} ${label}`;
    };

    /**
     * Persist discovery relay whitelist to local storage
     */
    App.persistDiscoveryRelays = async function() {
        if (typeof localStorage === 'undefined') {
            return;
        }

        const list = this.getDiscoveryRelays();

        try {
            localStorage.setItem(this.discoveryRelayStorageKey, JSON.stringify(list));
            this.persistedDiscoveryRelays = list;
        } catch (error) {
            console.warn('Failed to persist discovery relay whitelist:', error);
            throw error;
        }
    };

    /**
     * Add a relay to discovery list and update connections
     * @param {string} url - Relay URL
     */
    App.addDiscoveryRelay = async function(url) {
        const normalized = this.normalizeRelayUrl(url);
        if (!normalized) {
            alert('Please enter a valid relay URL (e.g. wss://relay.example.com).');
            return;
        }

        if (this.discoveryRelays.has(normalized.normalized)) {
            alert('That relay is already in your discovery list.');
            return;
        }

        const updated = [...this.getDiscoveryRelays(), normalized.connection];
        await this.configureRelays(updated);
    };

    /**
     * Remove a relay from discovery list
     * @param {string} normalizedUrl - Normalized relay URL key
     */
    App.removeDiscoveryRelay = async function(normalizedUrl) {
        if (!this.discoveryRelays.has(normalizedUrl)) {
            return;
        }

        const remaining = Array.from(this.discoveryRelays.entries())
            .filter(([key]) => key !== normalizedUrl)
            .map(([, entry]) => entry.connection);

        await this.configureRelays(remaining);
    };

    /**
     * Handler for add relay button/input
     */
    App.handleAddDiscoveryRelay = function() {
        const input = document.getElementById('new-discovery-relay');
        if (!input) return;

        const value = input.value.trim();
        if (!value) {
            input.focus();
            return;
        }

        this.addDiscoveryRelay(value)
            .then(() => {
                input.value = '';
                input.focus();
            })
            .catch(err => {
                console.error('Failed to add discovery relay:', err);
            });
    };

    /**
     * Initialize accordion interactions on profile page
     */
    App.initializeProfileAccordions = function() {
        const toggles = document.querySelectorAll('.accordion-toggle');
        toggles.forEach(toggle => {
            const card = toggle.closest('.accordion-card');
            if (!card) return;

            const expanded = !card.classList.contains('collapsed');
            toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');

            toggle.addEventListener('click', () => {
                const isCollapsed = card.classList.toggle('collapsed');
                toggle.setAttribute('aria-expanded', (!isCollapsed).toString());
            });
        });
    };

    // Add method to configure relays
    App.configureRelays = async function(relayUrls = [], options = {}) {
        const urls = Array.isArray(relayUrls) ? relayUrls : [];
        const { skipNetwork = false, skipRender = false, includePersisted = false } = options;

        const finalUrls = includePersisted
            ? this.mergeRelayLists(urls, this.persistedDiscoveryRelays)
            : urls;

        this.setDiscoveryRelays(finalUrls, { skipRender });

        try {
            await this.persistDiscoveryRelays();
        } catch (err) {
            console.warn('Failed to persist discovery relays:', err);
        }

        if (!skipNetwork && this.nostr) {
            try {
                await this.nostr.updateRelays(this.getDiscoveryRelays());
            } catch (err) {
                console.error('Failed to update discovery relays:', err);
            }
        }
    };
    
    // Add method to track Hypertuna ID 
    App.setCurrentHypertunaId = function(hypertunaId) {
        this.currentHypertunaId = hypertunaId;
    };
    
    // Method to confirm join group with invite code
    App.confirmJoinGroup = async function() {
        if (!this.currentUser || !this.currentGroupId) {
            this.closeJoinModal();
            return;
        }
        
        const inviteCode = document.getElementById('invite-code-input').value.trim();
        if (!inviteCode) {
            alert('Please enter an invite code.');
            return;
        }
        
        try {
            await this.sendJoinRequest(inviteCode);
            // Modal remains open to display status message
        } catch (e) {
            console.error('Error joining group with invite code:', e);
            // Don't close the modal in case of error, so the user can try again
        }
    };
    
    // Initialize nostr integration if user is already logged in
    const explicitLogout = localStorage.getItem('explicit_logout') === 'true';

    // Initialize nostr integration if user is already logged in AND hasn't explicitly logged out
    if (App.currentUser && App.currentUser.privateKey && !explicitLogout) {
        App.showGroupListSpinner();
        
        App.nostr.init(App.currentUser)
            .then(async () => {
                console.log('Nostr integration initialized with discovery relays');

                if (App.configureRelays) {
                    await App.configureRelays(App.nostr.relayUrls || [], { skipNetwork: true, includePersisted: true });
                }

                // Populate profile cache for the logged in user
                try {
                    const profile = await App.nostr.client.fetchUserProfile(App.currentUser.pubkey);
                    Object.assign(App.currentUser, profile);
                    App.saveUserToLocalStorage();
                    App.updateProfileDisplay();
                } catch (err) {
                    console.error('Failed to fetch user profile after init:', err);
                }

                // Wait for relays to be ready before loading groups
                await App.nostr.waitForRelaysAndLoadGroups();
                
                // Start worker if available
                if (window.startWorker) {
                    try {
                        const key = await window.startWorker();
                        // ... rest of worker start code ...
                    } catch (err) {
                        console.error('Failed to start worker:', err);
                    }
                }
            })
            .catch(e => console.error('Error initializing nostr integration:', e));
    }
    
    return App;
}


export default integrateNostrRelays;
