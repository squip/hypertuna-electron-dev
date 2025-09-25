// ./hypertuna-desktop/app.js
//
// Desktop controller logic for Hypertuna when running inside Electron.
import { ConfigLogger } from './ConfigLogger.js';
import { HypertunaUtils } from './HypertunaUtils.js';

const electronAPI = window.electronAPI || null;
const isElectron = !!electronAPI;

console.log('[App] electronAPI available:', isElectron);

console.log('[App] app.js loading started at:', new Date().toISOString());

// Application state
let workerStatus = 'stopped'
let workerActive = false
let logs = []
let relays = []
let pollingInterval = null
let healthState = null
let gatewayRegistered = false
let relayCreateResolvers = []
let initializedRelays = new Set() // Track which relays are ready
let relayJoinResolvers = new Map();
let workerListenersAttached = false;
let healthPollingInterval = null;
let gatewayStatusInfo = { running: false };
let gatewayLogs = [];
let gatewayLogVisible = false;
let gatewayOptionsState = { detectLanAddresses: false, detectPublicIp: false };
let gatewayUptimeTimer = null;
const DEFAULT_API_URL = 'http://localhost:1945';

// Store worker messages that may arrive before AppIntegration sets up handlers
let pendingRelayMessages = {
  initialized: [],
  registered: []
}
window.pendingRelayMessages = pendingRelayMessages

// Promise resolution for swarm key
let swarmKeyPromise = null
let swarmKeyResolver = null

// Track initialization state
let isInitialized = false
let eventListenersAttached = false

// DOM elements - Initialize after DOM is ready
let workerStatusIndicator = null
let workerStatusText = null
let startButton = null
let stopButton = null
let createRelayButton = null
let logsContainer = null
let relayList = null
let clearLogsButton = null
let exportLogsButton = null
let joinRelayButton = null
let newGroupFileSharing = null
let gatewayStartButton = null
let gatewayStopButton = null
let gatewayStatusIndicatorEl = null
let gatewayStatusTextEl = null
let gatewayUptimeEl = null
let gatewayPortEl = null
let gatewayPeersEl = null
let gatewayRelaysEl = null
let gatewayHyperswarmEl = null
let gatewayServiceStatusEl = null
let gatewayLastCheckEl = null
let gatewayLogsContainer = null
let gatewayToggleLogsButton = null
let gatewayLanToggle = null
let gatewayPublicToggle = null

// Log functions
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
  return `${seconds}s`
}

function formatRelativeTime(value) {
  if (!value) return '—'
  const timestamp = typeof value === 'string' ? Date.parse(value) : value
  if (!Number.isFinite(timestamp)) return '—'
  const diff = Date.now() - timestamp
  if (diff < 0) return 'just now'
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(timestamp).toLocaleString()
}

function applyGatewayOptionsToUI() {
  if (gatewayLanToggle) gatewayLanToggle.checked = !!gatewayOptionsState.detectLanAddresses
  if (gatewayPublicToggle) gatewayPublicToggle.checked = !!gatewayOptionsState.detectPublicIp
}

function persistGatewayOptions() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem('hypertuna_gateway_options', JSON.stringify(gatewayOptionsState))
  } catch (_) {}
}

function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString()
  const logEntry = {
    timestamp,
    message,
    type
  }
  logs.push(logEntry)

  if (logs.length > 1000) {
    logs = logs.slice(-1000)
  }

  if (logsContainer) {
    const logElement = document.createElement('div')
    logElement.className = `log-entry ${type}`
    logElement.textContent = `[${timestamp}] ${message}`
    logsContainer.appendChild(logElement)
    logsContainer.scrollTop = logsContainer.scrollHeight
  }

  console.log(`[Log ${type}] ${message}`)
}

function loadGatewayOptionsFromStorage() {
  if (typeof localStorage === 'undefined') return
  try {
    const stored = localStorage.getItem('hypertuna_gateway_options')
    if (stored) {
      const parsed = JSON.parse(stored)
      if (parsed && typeof parsed === 'object') {
        gatewayOptionsState = {
          ...gatewayOptionsState,
          detectLanAddresses: !!parsed.detectLanAddresses,
          detectPublicIp: !!parsed.detectPublicIp
        }
      }
    }
  } catch (_) {}
}

async function syncGatewayOptions() {
  if (!isElectron || !electronAPI?.setGatewayOptions) return
  try {
    const response = await electronAPI.setGatewayOptions(gatewayOptionsState)
    if (response && response.success === false) {
      if (response.error && response.error.includes('Worker not running')) {
        return
      }
      throw new Error(response.error || 'Gateway options update failed')
    }
  } catch (error) {
    console.error('[App] Failed to sync gateway options:', error)
    addLog(`Gateway options error: ${error.message}`, 'error')
  }
}

function updateGatewayUI(status) {
  gatewayStatusInfo = status || { running: false }
  const running = !!gatewayStatusInfo.running

  if (gatewayStatusIndicatorEl) {
    gatewayStatusIndicatorEl.classList.remove('active', 'pending')
    if (running) {
      const healthStatus = gatewayStatusInfo.health?.status
      if (healthStatus && healthStatus !== 'healthy') {
        gatewayStatusIndicatorEl.classList.add('pending')
      } else {
        gatewayStatusIndicatorEl.classList.add('active')
      }
    }
  }

  if (gatewayStatusTextEl) {
    gatewayStatusTextEl.textContent = running ? 'Online' : 'Offline'
  }

  if (gatewayStartButton) gatewayStartButton.disabled = running
  if (gatewayStopButton) gatewayStopButton.disabled = !running

  if (gatewayPortEl) gatewayPortEl.textContent = gatewayStatusInfo.port ?? '—'
  if (gatewayPeersEl) gatewayPeersEl.textContent = gatewayStatusInfo.peers ?? 0
  if (gatewayRelaysEl) gatewayRelaysEl.textContent = gatewayStatusInfo.relays ?? 0

  const services = gatewayStatusInfo.health?.services || {}
  if (gatewayHyperswarmEl) gatewayHyperswarmEl.textContent = services.hyperswarmStatus || (running ? 'connected' : 'offline')
  if (gatewayServiceStatusEl) gatewayServiceStatusEl.textContent = services.gatewayStatus || (running ? 'online' : 'offline')
  if (gatewayLastCheckEl) gatewayLastCheckEl.textContent = formatRelativeTime(gatewayStatusInfo.health?.lastCheck)

  if (gatewayUptimeTimer) {
    clearInterval(gatewayUptimeTimer)
    gatewayUptimeTimer = null
  }

  if (gatewayUptimeEl) {
    if (running && gatewayStatusInfo.startedAt) {
      const update = () => {
        const diff = Date.now() - gatewayStatusInfo.startedAt
        gatewayUptimeEl.textContent = formatDuration(diff)
      }
      update()
      gatewayUptimeTimer = setInterval(update, 1000)
    } else {
      gatewayUptimeEl.textContent = '—'
    }
  }
}

function renderGatewayLogs() {
  if (!gatewayLogsContainer) return
  gatewayLogsContainer.innerHTML = ''
  const entries = gatewayLogs.slice(-200)
  for (const entry of entries) {
    const row = document.createElement('div')
    row.className = `gateway-log-entry ${entry.level || 'info'}`
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''
    row.textContent = time ? `[${time}] ${entry.message}` : entry.message
    gatewayLogsContainer.appendChild(row)
  }
  gatewayLogsContainer.scrollTop = gatewayLogsContainer.scrollHeight
}

async function refreshGatewayStatus({ fetchOptions = true } = {}) {
  if (!isElectron || !electronAPI?.getGatewayStatus) return
  try {
    const requests = [electronAPI.getGatewayStatus(), electronAPI.getGatewayLogs()]
    if (fetchOptions && electronAPI.getGatewayOptions) {
      requests.push(electronAPI.getGatewayOptions())
    }
    const results = await Promise.all(requests)
    const statusResult = results[0]
    const logsResult = results[1]
    const optionsResult = results[2]

    if (statusResult && 'status' in statusResult) {
      updateGatewayUI(statusResult.status || { running: false })
    }

    if (Array.isArray(logsResult?.logs)) {
      gatewayLogs = logsResult.logs.slice(-500)
      if (gatewayLogVisible) {
        renderGatewayLogs()
      }
    }

    if (optionsResult?.options) {
      gatewayOptionsState = {
        ...gatewayOptionsState,
        detectLanAddresses: !!optionsResult.options.detectLanAddresses,
        detectPublicIp: !!optionsResult.options.detectPublicIp
      }
      applyGatewayOptionsToUI()
      persistGatewayOptions()
    }
  } catch (error) {
    console.error('[App] Failed to refresh gateway status:', error)
  }
}

async function handleGatewayStart() {
  if (!isElectron || !electronAPI?.startGateway) return
  if (gatewayStartButton) gatewayStartButton.disabled = true
  try {
    await syncGatewayOptions()
    addLog('Starting local gateway...', 'status')
    const response = await electronAPI.startGateway(gatewayOptionsState)
    if (response && response.success === false) {
      throw new Error(response.error || 'Gateway start failed')
    }
    await refreshGatewayStatus({ fetchOptions: false })
  } catch (error) {
    console.error('[App] Failed to start gateway:', error)
    addLog(`Failed to start gateway: ${error.message}`, 'error')
  } finally {
    if (gatewayStartButton) gatewayStartButton.disabled = false
  }
}

async function handleGatewayStop() {
  if (!isElectron || !electronAPI?.stopGateway) return
  if (gatewayStopButton) gatewayStopButton.disabled = true
  try {
    addLog('Stopping local gateway...', 'status')
    const response = await electronAPI.stopGateway()
    if (response && response.success === false) {
      throw new Error(response.error || 'Gateway stop failed')
    }
    await refreshGatewayStatus({ fetchOptions: false })
  } catch (error) {
    console.error('[App] Failed to stop gateway:', error)
    addLog(`Failed to stop gateway: ${error.message}`, 'error')
  } finally {
    if (gatewayStopButton) gatewayStopButton.disabled = false
  }
}

async function initializeGatewayControls() {
  loadGatewayOptionsFromStorage()
  applyGatewayOptionsToUI()
  persistGatewayOptions()

  if (!isElectron) return

  try {
    if (electronAPI.getGatewayOptions) {
      const optionsResult = await electronAPI.getGatewayOptions()
      if (optionsResult?.options) {
        gatewayOptionsState = {
          ...gatewayOptionsState,
          detectLanAddresses: !!optionsResult.options.detectLanAddresses,
          detectPublicIp: !!optionsResult.options.detectPublicIp
        }
        applyGatewayOptionsToUI()
        persistGatewayOptions()
      }
    }
  } catch (error) {
    console.error('[App] Failed to load gateway options:', error)
  }

  await syncGatewayOptions()
  await refreshGatewayStatus({ fetchOptions: false })
}

function handleGatewayLogEntry(entry) {
  if (!entry) return
  gatewayLogs.push(entry)
  if (gatewayLogs.length > 500) {
    gatewayLogs = gatewayLogs.slice(-500)
  }
  if (gatewayLogVisible) {
    renderGatewayLogs()
  }
}

function attachWorkerEventListeners() {
  if (workerListenersAttached || !isElectron) {
    return;
  }

  electronAPI.onWorkerMessage((payload) => {
    let message = payload;

    if (typeof payload === 'string') {
      try {
        message = JSON.parse(payload);
      } catch (error) {
        console.warn('[App] Failed to parse worker message string', error, payload);
        message = null;
      }
    }

    if (message && typeof message === 'object') {
      handleWorkerMessage(message);
    }
  });

  electronAPI.onWorkerError((error) => {
    addLog(`Worker error: ${error}`, 'error');
    updateWorkerStatus('stopped', 'Error');
    workerActive = false;
    stopPolling();
  });

  electronAPI.onWorkerExit((code) => {
    addLog('Worker process closed', 'status');
    updateWorkerStatus('stopped', 'Stopped');
    workerActive = false;
    stopPolling();
  });

  electronAPI.onWorkerStdout((output) => {
    if (output) {
      console.log('[Worker stdout]', output);
    }
  });

  electronAPI.onWorkerStderr((output) => {
    if (output) {
      console.error('[Worker stderr]', output);
    }
  });

  workerListenersAttached = true;
}

// Update worker status UI
function updateWorkerStatus(status, text) {
  console.log(`[App] Updating worker status to: ${status} - ${text}`)
  workerStatus = status
  
  if (workerStatusText) {
    workerStatusText.textContent = text
  }
  
  // Update indicator
  if (workerStatusIndicator) {
    workerStatusIndicator.classList.remove('active', 'inactive', 'pending')
    
    switch (status) {
      case 'running':
        workerStatusIndicator.classList.add('active')
        if (startButton) startButton.disabled = true
        if (stopButton) stopButton.disabled = false
        if (createRelayButton) createRelayButton.disabled = false
        if (joinRelayButton) joinRelayButton.disabled = false
        break
      case 'stopped':
        workerStatusIndicator.classList.add('inactive')
        if (startButton) startButton.disabled = false
        if (stopButton) stopButton.disabled = false
        if (createRelayButton) createRelayButton.disabled = true
        if (joinRelayButton) joinRelayButton.disabled = true
        break
      case 'starting':
      case 'stopping':
        workerStatusIndicator.classList.add('pending')
        if (startButton) startButton.disabled = true
        if (stopButton) stopButton.disabled = true
        if (createRelayButton) createRelayButton.disabled = true
        if (joinRelayButton) joinRelayButton.disabled = true
        break
    }
  }
}

// Start the worker
async function startWorker() {
  console.log('[App] startWorker() called at:', new Date().toISOString());

  attachWorkerEventListeners();

  swarmKeyPromise = new Promise((resolve) => {
    swarmKeyResolver = resolve;
  });

  if (!isElectron) {
    addLog('Electron runtime not detected. Worker cannot be started.', 'error');
    if (swarmKeyResolver) swarmKeyResolver(null);
    return swarmKeyPromise;
  }

  if (workerStatus !== 'stopped') {
    console.log('[App] Worker already starting/running, ignoring duplicate call');
    if (swarmKeyResolver) swarmKeyResolver(null);
    return swarmKeyPromise;
  }

  try {
    addLog('Starting relay worker...', 'status');
    updateWorkerStatus('starting', 'Starting...');

    const startResult = await electronAPI.startWorker();
    if (!startResult?.success) {
      throw new Error(startResult?.error || 'Failed to start worker');
    }

    workerActive = true;

    let configToUse = {};
    const hypertunaConfigStr = localStorage.getItem('hypertuna_config');
    if (hypertunaConfigStr) {
      try {
        configToUse = JSON.parse(hypertunaConfigStr);
        ConfigLogger.log('LOAD', {
          module: 'app.js',
          method: 'startWorker',
          filepath: 'localStorage',
          key: 'hypertuna_config',
          success: true,
          dataSize: hypertunaConfigStr.length
        });
      } catch (error) {
        console.error('[App] Failed to parse localStorage hypertuna_config:', error);
      }
    }

    if (!configToUse.nostr_pubkey_hex) {
      try {
        const configResult = await electronAPI.readConfig();
        if (configResult?.success && configResult.data) {
          configToUse = configResult.data;
          ConfigLogger.log('LOAD', {
            module: 'app.js',
            method: 'startWorker',
            filepath: 'relay-config.json',
            success: true,
            dataSize: JSON.stringify(configResult.data).length
          });
        }
      } catch (error) {
        console.error('[App] Failed to load config from storage', error);
      }
    }

    const currentUserStr = localStorage.getItem('nostr_user');
    if (configToUse?.nostr_pubkey_hex && currentUserStr) {
      try {
        const currentUser = JSON.parse(currentUserStr);
        if (currentUser?.pubkey && currentUser.pubkey !== configToUse.nostr_pubkey_hex) {
          console.warn('[App] Stored config does not match current user. Using in-memory config.');
        }
      } catch (error) {
        console.warn('[App] Failed to parse nostr_user for verification', error);
      }
    }

    if (!configToUse.nostr_pubkey_hex && window.App?.currentUser?.pubkey) {
      configToUse.nostr_pubkey_hex = window.App.currentUser.pubkey;
    }

    if (!configToUse.nostr_nsec && window.App?.currentUser?.privateKey) {
      configToUse.nostr_nsec = window.App.currentUser.privateKey;
    }

    if (configToUse.nostr_pubkey_hex && !configToUse.nostr_npub) {
      try {
        const { NostrUtils } = await import('./NostrUtils.js');
        configToUse.nostr_npub = NostrUtils.hexToNpub(configToUse.nostr_pubkey_hex);
      } catch (error) {
        console.error('[App] Failed to generate npub for worker config', error);
      }
    }

    if (configToUse.nostr_nsec_hex && !configToUse.nostr_nsec) {
      try {
        const { NostrUtils } = await import('./NostrUtils.js');
        configToUse.nostr_nsec = NostrUtils.hexToNsec(configToUse.nostr_nsec_hex);
      } catch (error) {
        console.error('[App] Failed to generate nsec for worker config', error);
      }
    }

    const apiUrl = configToUse.apiUrl || DEFAULT_API_URL;
    const configMessage = {
      type: 'config',
      data: {
        ...configToUse,
        apiUrl
      }
    };

    console.log('[App] Config to send to worker:', {
      pubkey: configMessage.data.nostr_pubkey_hex?.substring(0, 8) + '...',
      npub: configMessage.data.nostr_npub?.substring(0, 8) + '...',
      proxy_pubkey: configMessage.data.proxy_publicKey?.substring(0, 8) + '...',
      hasStorage: !!configMessage.data.storage,
      hasBech32: !!(configMessage.data.nostr_npub && configMessage.data.nostr_nsec)
    });

    const sendResult = await electronAPI.sendToWorker(configMessage);
    if (!sendResult?.success) {
      throw new Error(sendResult?.error || 'Failed to deliver config to worker');
    }

    setTimeout(() => {
      if (workerActive) {
        electronAPI.sendToWorker(configMessage).catch(() => {});
      }
    }, 1000);

    startPolling();
    startHealthPolling();
  } catch (error) {
    addLog(`Failed to start worker: ${error.message}`, 'error');
    updateWorkerStatus('stopped', 'Failed');
    workerActive = false;
    stopPolling();
    if (swarmKeyResolver) {
      swarmKeyResolver(null);
      swarmKeyResolver = null;
    }
  }

  return swarmKeyPromise;
}


// Stop the worker
async function stopWorker() {
  console.log('[App] stopWorker() called at:', new Date().toISOString());

  if (!isElectron) {
    addLog('Electron runtime not detected. Cannot control worker.', 'error');
    return;
  }

  if (!workerActive) {
    addLog('Worker not running', 'error');
    return;
  }

  try {
    addLog('Stopping relay worker...', 'status');
    updateWorkerStatus('stopping', 'Stopping...');
    stopPolling();

    const shutdownResult = await electronAPI.sendToWorker({ type: 'shutdown' });
    if (!shutdownResult?.success) {
      throw new Error(shutdownResult?.error || 'Worker did not accept shutdown request');
    }

    setTimeout(async () => {
      try {
        const result = await electronAPI.stopWorker();
        if (!result?.success) {
          addLog(result?.error || 'Failed to stop worker', 'error');
        }
      } catch (error) {
        console.error('[App] Error while stopping worker', error);
      } finally {
        workerActive = false;
        updateWorkerStatus('stopped', 'Stopped');
      }
    }, 3000);
  } catch (error) {
    console.error('[App] Error in stopWorker:', error);
    addLog(`Error stopping worker: ${error.message}`, 'error');
    workerActive = false;
    updateWorkerStatus('stopped', 'Error');
  }
}


// Handle messages from worker
async function handleWorkerMessage(message) {
  console.log('[App] Received worker message:', message)

  switch (message.type) {
    case 'status':
        addLog(`Worker: ${message.message}`, 'status')
            if (message.swarmKey) {
            try {
                const stored = localStorage.getItem('hypertuna_config')
                const cfg = stored ? JSON.parse(stored) : {}
                cfg.swarmPublicKey = message.swarmKey
                localStorage.setItem('hypertuna_config', JSON.stringify(cfg))
                if (window.App && window.App.currentUser && window.App.currentUser.hypertunaConfig) {
                    window.App.currentUser.hypertunaConfig.swarmPublicKey = message.swarmKey
                if (typeof window.App.updateHypertunaDisplay === 'function') {
                    window.App.updateHypertunaDisplay()
                    }
                }
                if (swarmKeyResolver) {
                    swarmKeyResolver(message.swarmKey)
                    swarmKeyResolver = null
                  }
            } catch (e) {
                console.error('[App] Failed to store swarm key', e)
            }
        }
        if (message.initialized) {
                updateWorkerStatus('running', 'Running')
        }
        break

    case 'drive-key':
      try {
        const cfg = (await HypertunaUtils.loadConfig()) || {}
        cfg.driveKey = message.driveKey
        await HypertunaUtils.saveConfig(cfg)
        if (window.App && window.App.currentUser && window.App.currentUser.hypertunaConfig) {
          window.App.currentUser.hypertunaConfig.driveKey = message.driveKey
          if (typeof window.App.saveUserToLocalStorage === 'function') {
            window.App.saveUserToLocalStorage()
          }
          if (typeof window.App.updateHypertunaDisplay === 'function') {
            window.App.updateHypertunaDisplay()
          }
        }
      } catch (e) {
        console.error('[App] Failed to persist drive key', e)
      }
      break

    case 'pfp-drive-key':
      try {
        const cfg = (await HypertunaUtils.loadConfig()) || {}
        cfg.pfpDriveKey = message.driveKey
        await HypertunaUtils.saveConfig(cfg)
        if (window.App && window.App.currentUser && window.App.currentUser.hypertunaConfig) {
          window.App.currentUser.hypertunaConfig.pfpDriveKey = message.driveKey
          if (typeof window.App.saveUserToLocalStorage === 'function') {
            window.App.saveUserToLocalStorage()
          }
          if (typeof window.App.updateHypertunaDisplay === 'function') {
            window.App.updateHypertunaDisplay()
          }
        }
      } catch (e) {
        console.error('[App] Failed to persist pfp drive key', e)
      }
      break

    case 'upload-pfp-complete':
      console.log(`[App] Worker stored avatar owner=${message.owner || 'root'} fileHash=${message.fileHash}`)
      break

    case 'heartbeat':
      // Update last heartbeat time
      updateWorkerStatus('running', `Running (${new Date(message.timestamp).toLocaleTimeString()})`)
      break
      
    case 'error':
      addLog(`Worker error: ${message.message}`, 'error')
      break
      
    case 'relay-update':
      updateRelayList(message.relays)
      break

    case 'relay-initialized':
      // Message when a relay has finished initializing
      if (message.relayKey) {
        console.log(`[App] Relay initialized: ${message.relayKey}`)
        console.log(`[App] Relay gateway URL: ${message.gatewayUrl}`)
        initializedRelays.add(message.relayKey)

        // Register mapping between the worker key and the public identifier first
        if (window.App && window.App.nostr && message.publicIdentifier) {
          window.App.nostr.registerRelayMapping(message.relayKey, message.publicIdentifier)
        }

        // Notify the UI that this relay is ready or queue if handler not yet present
        if (window.App && typeof window.App.handleRelayInitialized === 'function') {
          window.App.handleRelayInitialized(message)
        } else {
          pendingRelayMessages.initialized.push(message)
        }
      }
      break
      
    case 'relay-registration-complete':
      // When a relay has been registered with gateway
      if (message.relayKey) {
        console.log(`[App] Relay registered with gateway: ${message.relayKey}`)
        addLog(`Relay ${message.relayKey} registered with gateway`, 'status')

        // Notify the nostr client that this relay is fully registered and ready for connection
        if (window.App && typeof window.App.handleRelayRegistered === 'function') {
            window.App.handleRelayRegistered(message);
        } else {
            pendingRelayMessages.registered.push(message);
        }
      }
      break
      
    case 'all-relays-initialized':
      // When all stored relays have been initialized
      console.log('[App] All stored relays initialized')
      if (window.App && window.App.nostr) {
        window.App.nostr.handleAllRelaysReady()
      }
      break
      
    case 'relay-created':
      const resolver = relayCreateResolvers.shift()
      if (resolver) resolver(message)
      if (message.data.success) {
        addLog(`Relay created successfully: ${message.data.relayKey}`, 'status')
        if (window.App && window.App.nostr && message.data.publicIdentifier) {
          window.App.nostr.registerRelayMapping(message.data.relayKey, message.data.publicIdentifier)
        }
      } else {
        addLog(`Failed to create relay: ${message.data.error}`, 'error')
      }
      break
      
    case 'relay-joined':
      if (message.data.success) {
        addLog(`Joined relay successfully: ${message.data.relayKey}`, 'status')
        if (window.App && window.App.nostr && message.data.publicIdentifier) {
          window.App.nostr.registerRelayMapping(message.data.relayKey, message.data.publicIdentifier)
        }
      } else {
        addLog(`Failed to join relay: ${message.data.error}`, 'error')
      }
      break
      
    case 'relay-disconnected':
      if (message.data.success) {
        addLog(`Disconnected from relay successfully`, 'status')
      } else {
        addLog(`Failed to disconnect: ${message.data.error}`, 'error')
      }
      break

    case 'join-auth-progress':
      if (window.App && typeof window.App.updateAuthProgress === 'function') {
        addLog(`Join auth progress: ${message.data.status}`, 'status');
        window.App.updateAuthProgress(message.data.status);
      }
      break;

    case 'join-auth-success':
      addLog(`Join auth success for ${message.data.publicIdentifier}`, 'status');
      if (relayJoinResolvers.has(message.data.publicIdentifier)) {
        const { resolve } = relayJoinResolvers.get(message.data.publicIdentifier);
        resolve(message.data);
        relayJoinResolvers.delete(message.data.publicIdentifier);
      }
      if (window.App && typeof window.App.showAuthSuccess === 'function') {
        window.App.showAuthSuccess(message.data);
      }
      break;

    case 'join-auth-error':
      addLog(`Join auth error for ${message.data.publicIdentifier}: ${message.data.error}`, 'error');
      if (relayJoinResolvers.has(message.data.publicIdentifier)) {
        const { reject } = relayJoinResolvers.get(message.data.publicIdentifier);
        reject(new Error(message.data.error));
        relayJoinResolvers.delete(message.data.publicIdentifier);
      }
      if (window.App && typeof window.App.showAuthError === 'function') {
        window.App.showAuthError(message.data.error);
      }
      break;

    case 'members-updated':
      // Relay membership list was updated in the worker
      if (message.relayKey) {
        addLog(`Members updated for ${message.relayKey}`, 'status');
      } else {
        addLog('Members updated', 'status');
      }

      // Refresh relay info so UI reflects latest members
      fetchRelays();

      // If currently viewing a group, refresh the member list
      if (window.App && typeof window.App.loadGroupMembers === 'function') {
        window.App.loadGroupMembers();
      }
      break;

    case 'health-update':
      updateHealthStatus(message.healthState)
      break
      
    case 'gateway-registered':
      gatewayRegistered = true
      addLog('Successfully registered with gateway', 'status')
      updateHealthStatus(healthState) // Update display
      break

    case 'gateway-status':
      if (message.status) {
        updateGatewayUI(message.status)
      }
      break

    case 'gateway-log':
      handleGatewayLogEntry(message.entry)
      break

    case 'gateway-logs':
      if (Array.isArray(message.logs)) {
        gatewayLogs = message.logs.slice(-500)
        if (gatewayLogVisible) renderGatewayLogs()
      }
      break

    case 'gateway-started':
      addLog('Local gateway started', 'status')
      if (message.status) updateGatewayUI(message.status)
      break

    case 'gateway-stopped':
      addLog('Local gateway stopped', 'status')
      if (message.status) updateGatewayUI(message.status)
      break

    case 'gateway-error':
      if (message.message) {
        addLog(`Gateway error: ${message.message}`, 'error')
      }
      break

    case 'gateway-options-set':
      if (message.options) {
        gatewayOptionsState = {
          ...gatewayOptionsState,
          detectLanAddresses: !!message.options.detectLanAddresses,
          detectPublicIp: !!message.options.detectPublicIp
        }
        applyGatewayOptionsToUI()
        persistGatewayOptions()
      }
      break

      
    default:
      addLog(`Unknown worker message: ${JSON.stringify(message)}`, 'info')
  }
}

// Add function to check if a relay is ready
window.isRelayReady = function(relayKey) {
  return initializedRelays.has(relayKey)
}

function startHealthPolling() {
  if (!isElectron) return;

  const requestHealth = () => {
    if (workerActive) {
      electronAPI.sendToWorker({ type: 'get-health' }).catch(() => {});
    }
  };

  requestHealth();

  if (healthPollingInterval) {
    clearInterval(healthPollingInterval);
  }

  healthPollingInterval = setInterval(() => {
    if (workerStatus === 'running' && workerActive) {
      requestHealth();
    }
  }, 30000);
}

function stopHealthPolling() {
  if (healthPollingInterval) {
    clearInterval(healthPollingInterval);
    healthPollingInterval = null;
  }
}


function updateHealthStatus(health) {
  healthState = health
  
  if (!health) return
  
  // Update status
  const statusEl = document.getElementById('health-status')
  if (statusEl) {
    statusEl.textContent = health.status || 'Unknown'
    statusEl.style.color = health.status === 'healthy' ? 'var(--success-color)' : 
                          health.status === 'ready' ? 'var(--text-primary)' : 
                          'var(--error-color)'
  }
  
  // Update uptime
  const uptimeEl = document.getElementById('health-uptime')
  if (uptimeEl && health.uptime) {
    const hours = Math.floor(health.uptime / (1000 * 60 * 60))
    const minutes = Math.floor((health.uptime % (1000 * 60 * 60)) / (1000 * 60))
    const seconds = Math.floor((health.uptime % (1000 * 60)) / 1000)
    uptimeEl.textContent = `${hours}h ${minutes}m ${seconds}s`
  }
  
  // Update success rate - handle both old and new formats
  const successRateEl = document.getElementById('health-success-rate')
  if (successRateEl && health.metrics) {
    let successRate = 100; // Default
    
    // Check if successRate is already calculated
    if (typeof health.metrics.successRate === 'number') {
      successRate = health.metrics.successRate;
    } else if (health.metrics.totalRequests > 0) {
      // Calculate it ourselves
      successRate = (health.metrics.successfulRequests / health.metrics.totalRequests) * 100;
    }
    
    successRateEl.textContent = `${successRate.toFixed(1)}%`
  }
  
  // Update service statuses
  if (health.services) {
    const hyperteleEl = document.getElementById('hypertele-status')
    if (hyperteleEl) {
      hyperteleEl.textContent = health.services.hyperteleStatus || 'Unknown'
      hyperteleEl.style.color = health.services.hyperteleStatus === 'connected' ? 
                               'var(--success-color)' : 'var(--error-color)'
    }
  }
  
  // Update gateway status
  const gatewayEl = document.getElementById('gateway-status')
  if (gatewayEl) {
    gatewayEl.textContent = gatewayRegistered ? 'Registered' : 'Not Registered'
    gatewayEl.style.color = gatewayRegistered ? 'var(--success-color)' : 'var(--text-secondary)'
  }
}

// Start polling for relay updates
function startPolling() {
  // Initial fetch
  fetchRelays()
  
  // Poll every 5 seconds
  pollingInterval = setInterval(() => {
    if (workerStatus === 'running') {
      fetchRelays()
    }
  }, 5000)
}

// Stop polling
function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = null
  }
  stopHealthPolling();
}

// Fetch relays from API
async function fetchRelays() {
  if (workerStatus !== 'running' || !workerActive || !isElectron) return;
  
  try {
    const result = await electronAPI.sendToWorker({ type: 'get-relays' });
    if (!result?.success) {
      throw new Error(result?.error || 'Worker rejected get-relays request');
    }
  } catch (error) {
    addLog(`Failed to fetch relays: ${error.message}`, 'error');
  }
}

// Update relay list
function updateRelayList(relayData) {
  if (!relayList) return;
  
  relays = relayData || [];
  
  if (relays.length === 0) {
    relayList.innerHTML = '<p style="color: var(--text-secondary); font-size: 12px;">No active relays</p>';
    return;
  }
  
  relayList.innerHTML = '';
  relays.forEach(relay => {
    if (window.App && window.App.nostr && relay.relayKey && relay.publicIdentifier) {
      window.App.nostr.registerRelayMapping(relay.relayKey, relay.publicIdentifier)
    }
    const relayElement = document.createElement('div');
    relayElement.className = 'relay-item';
    
    // Use public identifier if available, fallback to relay key
    const displayKey = relay.publicIdentifier || relay.relayKey || 'unknown';
    const truncatedKey = displayKey.length > 30 ? 
      displayKey.substring(0, 30) + '...' : displayKey;
    
    // Create relay item with disconnect button
    relayElement.innerHTML = `
      <div style="flex: 1;">
        <div><strong>${relay.name || 'Unnamed Relay'}</strong></div>
        <div class="relay-key">${truncatedKey}</div>
        <div style="font-size: 11px; color: var(--text-secondary);">
          Peers: ${relay.peerCount || 0}
        </div>
        <div style="font-size: 10px; color: var(--text-secondary); margin-top: 2px;">
          ${relay.connectionUrl ? 'URL: ' + relay.connectionUrl : ''}
        </div>
      </div>
      <button class="disconnect-btn" data-relay-identifier="${relay.publicIdentifier || relay.relayKey}">
        Disconnect
      </button>
    `;
    
    // Add disconnect handler
    const disconnectBtn = relayElement.querySelector('.disconnect-btn');
    disconnectBtn.addEventListener('click', () => 
      disconnectRelay(relay.publicIdentifier || relay.relayKey)
    );
    
    relayList.appendChild(relayElement);
  });
}

// Update disconnect function to handle public identifiers
async function disconnectRelay(identifier) {
  if (!workerActive || !isElectron) {
    addLog('Worker not running', 'error');
    return;
  }
  
  const displayName = identifier.length > 30 ? 
    identifier.substring(0, 30) + '...' : identifier;
  
  if (confirm(`Are you sure you want to disconnect from relay ${displayName}?`)) {
    addLog(`Disconnecting from relay ${displayName}`, 'status');
    
    try {
      const result = await electronAPI.sendToWorker({
        type: 'disconnect-relay',
        data: {
          relayKey: identifier,
          identifier
        }
      });

      if (!result?.success) {
        addLog(result?.error || `Failed to disconnect ${displayName}`, 'error');
      } else {
        addLog(`Disconnect request sent for ${displayName}`, 'status');
      }
    } catch (error) {
      addLog(`Failed to disconnect ${displayName}: ${error.message}`, 'error');
    }
  }
}

// Create a new relay
async function createRelay() {
  const nameInput = document.getElementById('relay-name')
  const descriptionInput = document.getElementById('relay-description')
  
  if (!nameInput || !descriptionInput) {
    addLog('Form elements not found', 'error')
    return
  }
  
  const name = nameInput.value.trim()
  const description = descriptionInput.value.trim()
  
  if (!name) {
    addLog('Please enter a relay name', 'error')
    return
  }
  
  if (!workerActive || !isElectron) {
    addLog('Worker not running', 'error')
    return
  }
  
  try {
    addLog(`Creating relay: ${name}`, 'status')
    
    // Send create relay command to worker
    const fileSharing = newGroupFileSharing ? newGroupFileSharing.checked : false
    const result = await electronAPI.sendToWorker({
      type: 'create-relay',
      data: { name, description, fileSharing }
    })

    if (!result?.success) {
      throw new Error(result?.error || 'Worker rejected create-relay command');
    }
    
    // Clear inputs
    nameInput.value = ''
    descriptionInput.value = ''
    
  } catch (error) {
    addLog(`Failed to create relay: ${error.message}`, 'error')
  }
}

// Create a relay instance with provided parameters and return relay key
async function createRelayInstance(name, description, isPublic, isOpen, fileSharing = false) {
  return new Promise((resolve, reject) => {
    if (!workerActive || !isElectron) {
      addLog('Worker not running', 'error')
      return reject(new Error('Worker not running'))
    }

    // The resolver will now receive the full message data from the worker
    relayCreateResolvers.push((msg) => {
      if (msg.data.success) resolve(msg.data)
      else reject(new Error(msg.data.error))
    })

    electronAPI
      .sendToWorker({
        type: 'create-relay',
        data: { name, description, isPublic, isOpen, fileSharing }
      })
      .catch((error) => {
        addLog(`Failed to send create-relay command: ${error.message}`, 'error')
        reject(error)
      })
  })
}

// Join a relay instance via the worker-driven authentication flow
async function joinRelayInstance(publicIdentifier, fileSharing = false) {
  return new Promise((resolve, reject) => {
    if (!workerActive || !isElectron) {
      addLog('Worker not running', 'error');
      return reject(new Error('Worker not running'));
    }

    if (relayJoinResolvers.has(publicIdentifier)) {
      addLog(`Join flow already in progress for ${publicIdentifier}`, 'warn');
      return reject(new Error('Join flow already in progress'));
    }

    // Store the resolver for this specific join attempt
    relayJoinResolvers.set(publicIdentifier, { resolve, reject });

    addLog(`Starting join flow for relay: ${publicIdentifier}`, 'status');
    
    // Send message to worker to start the process
    electronAPI
      .sendToWorker({
        type: 'start-join-flow',
        data: { publicIdentifier, fileSharing }
      })
      .catch((error) => {
        addLog(`Failed to start join flow: ${error.message}`, 'error');
        relayJoinResolvers.delete(publicIdentifier);
        reject(error);
      });
  });
}

// Join a relay using data from an invite event
async function joinRelayFromInvite(relayKey, name = '', description = '', publicIdentifier = '', authToken = '', fileSharing = false) {
  return new Promise((resolve, reject) => {
    if (!workerActive || !isElectron) {
      addLog('Worker not running', 'error');
      return reject(new Error('Worker not running'));
    }

    try {
      electronAPI
        .sendToWorker({
          type: 'join-relay',
          data: { relayKey, name, description, publicIdentifier, authToken, fileSharing }
        })
        .then(() => resolve())
        .catch((error) => {
          addLog(`Failed to join relay from invite: ${error.message}`, 'error');
          reject(error);
        });
    } catch (err) {
      addLog(`Failed to join relay from invite: ${err.message}`, 'error');
      reject(err);
    }
  });
}

// Join an existing relay
async function joinRelay() {
  const keyInput = document.getElementById('join-relay-key')
  const nameInput = document.getElementById('join-relay-name')
  const descriptionInput = document.getElementById('join-relay-description')
  
  if (!keyInput || !nameInput || !descriptionInput) {
    addLog('Form elements not found', 'error')
    return
  }
  
  const relayKey = keyInput.value.trim()
  const name = nameInput.value.trim()
  const description = descriptionInput.value.trim()
  
  if (!relayKey) {
    addLog('Please enter a relay key', 'error')
    return
  }

  if (!workerActive || !isElectron) {
    addLog('Worker not running', 'error')
    return
  }
  
  // Validate relay key format (64 hex characters)
  if (!/^[a-fA-F0-9]{64}$/.test(relayKey)) {
    addLog('Invalid relay key format. Must be 64 hexadecimal characters', 'error')
    return
  }
  
  try {
    addLog(`Joining relay: ${relayKey.substring(0, 16)}...`, 'status')
    
    // Send join relay command to worker
    const fileSharing = false
    const result = await electronAPI.sendToWorker({
      type: 'join-relay',
      data: { relayKey, name, description, fileSharing }
    })

    if (!result?.success) {
      throw new Error(result?.error || 'Worker rejected join-relay command');
    }
    
    // Clear inputs
    keyInput.value = ''
    nameInput.value = ''
    descriptionInput.value = ''
    
  } catch (error) {
    addLog(`Failed to join relay: ${error.message}`, 'error')
  }
}

// Clear logs
function clearLogs() {
  logs = []
  if (logsContainer) {
    logsContainer.innerHTML = ''
  }
  addLog('Logs cleared', 'status')
}

// Export logs
function exportLogs() {
  const logText = logs.map(log => `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.message}`).join('\n')
  const blob = new Blob([logText], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `relay-logs-${new Date().toISOString().slice(0, 10)}.txt`
  a.click()
  URL.revokeObjectURL(url)
  addLog('Logs exported', 'status')
}

// Setup event listeners - ONLY CALL ONCE
function setupEventListeners() {
  if (eventListenersAttached) {
    console.log('[App] Event listeners already attached, skipping');
    return;
  }
  
  console.log('[App] setupEventListeners called at:', new Date().toISOString());
  console.log('[App] Current DOM readyState:', document.readyState);
  
  eventListenersAttached = true;
  
  // Button event listeners with debugging
  if (startButton) {
    console.log('[App] Adding listener to startButton:', startButton);
    startButton.addEventListener('click', (e) => {
      console.log('[App] Start button clicked event fired');
      e.preventDefault();
      e.stopPropagation();
      startWorker();
    });
    console.log('[App] Start button listener added successfully');
  } else {
    console.error('[App] Start button not found during setupEventListeners');
  }
  
  if (stopButton) {
    console.log('[App] Adding listener to stopButton:', stopButton);
    stopButton.addEventListener('click', (e) => {
      console.log('[App] Stop button clicked event fired');
      e.preventDefault();
      e.stopPropagation();
      stopWorker();
    });
    console.log('[App] Stop button listener added successfully');
  } else {
    console.error('[App] Stop button not found during setupEventListeners');
  }
  
  if (createRelayButton) {
    createRelayButton.addEventListener('click', createRelay)
    console.log('[App] Create relay button listener added')
  }
  
  if (clearLogsButton) {
    clearLogsButton.addEventListener('click', clearLogs)
    console.log('[App] Clear logs button listener added')
  }
  
  if (exportLogsButton) {
    exportLogsButton.addEventListener('click', exportLogs)
    console.log('[App] Export logs button listener added')
  }
  
  if (joinRelayButton) {
    joinRelayButton.addEventListener('click', joinRelay)
    console.log('[App] Join relay button listener added')
  }

  if (gatewayStartButton) {
    gatewayStartButton.addEventListener('click', (e) => {
      e.preventDefault()
      handleGatewayStart()
    })
  }

  if (gatewayStopButton) {
    gatewayStopButton.addEventListener('click', (e) => {
      e.preventDefault()
      handleGatewayStop()
    })
  }

  if (gatewayToggleLogsButton && gatewayLogsContainer) {
    gatewayToggleLogsButton.addEventListener('click', () => {
      gatewayLogVisible = !gatewayLogVisible
      gatewayLogsContainer.classList.toggle('hidden', !gatewayLogVisible)
      gatewayToggleLogsButton.textContent = gatewayLogVisible ? 'Hide Logs' : 'Show Logs'
      if (gatewayLogVisible) {
        renderGatewayLogs()
      }
    })
  }

  if (gatewayLanToggle) {
    gatewayLanToggle.addEventListener('change', () => {
      gatewayOptionsState.detectLanAddresses = !!gatewayLanToggle.checked
      persistGatewayOptions()
      syncGatewayOptions()
    })
  }

  if (gatewayPublicToggle) {
    gatewayPublicToggle.addEventListener('change', () => {
      gatewayOptionsState.detectPublicIp = !!gatewayPublicToggle.checked
      persistGatewayOptions()
      syncGatewayOptions()
    })
  }
  
  // Input field event listeners
  const relayNameInput = document.getElementById('relay-name')
  if (relayNameInput) {
    relayNameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && createRelayButton && !createRelayButton.disabled) {
        createRelay()
      }
    })
  }
  
  const joinRelayKeyInput = document.getElementById('join-relay-key')
  if (joinRelayKeyInput) {
    joinRelayKeyInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && joinRelayButton && !joinRelayButton.disabled) {
        joinRelay()
      }
    })
  }
}

// Debug function to check button state
function debugButtonState() {
  console.log('[App Debug] Button state check:');
  console.log('- startButton:', startButton, 'disabled:', startButton?.disabled);
  console.log('- stopButton:', stopButton, 'disabled:', stopButton?.disabled);
  console.log('- workerStatus:', workerStatus);
  console.log('- workerActive:', workerActive);
  console.log('- isInitialized:', isInitialized);
  console.log('- eventListenersAttached:', eventListenersAttached);
  
  // Check event listeners
  if (typeof getEventListeners !== 'undefined') {
    console.log('- stopButton listeners:', getEventListeners(stopButton));
  }
}

// Initialize DOM elements and setup - ONLY CALL ONCE
function initializeDOMElements() {
  if (isInitialized) {
    console.log('[App] Already initialized, skipping');
    return;
  }
  
  console.log('[App] Initializing DOM elements at:', new Date().toISOString());
  isInitialized = true;
  
  // Initialize DOM elements
  workerStatusIndicator = document.getElementById('worker-status-indicator')
  workerStatusText = document.getElementById('worker-status-text')
  startButton = document.getElementById('start-worker')
  stopButton = document.getElementById('stop-worker')
  createRelayButton = document.getElementById('create-relay')
  logsContainer = document.getElementById('logs')
  relayList = document.getElementById('relay-list')
  clearLogsButton = document.getElementById('clear-logs')
  exportLogsButton = document.getElementById('export-logs')
  joinRelayButton = document.getElementById('join-relay')
  newGroupFileSharing = document.getElementById('new-group-file-sharing')
  gatewayStartButton = document.getElementById('gateway-start')
  gatewayStopButton = document.getElementById('gateway-stop')
  gatewayStatusIndicatorEl = document.getElementById('gateway-status-indicator')
  gatewayStatusTextEl = document.getElementById('gateway-status-text')
  gatewayUptimeEl = document.getElementById('gateway-uptime')
  gatewayPortEl = document.getElementById('gateway-port')
  gatewayPeersEl = document.getElementById('gateway-peers')
  gatewayRelaysEl = document.getElementById('gateway-relays')
  gatewayHyperswarmEl = document.getElementById('gateway-hyperswarm-status')
  gatewayServiceStatusEl = document.getElementById('gateway-service-status')
  gatewayLastCheckEl = document.getElementById('gateway-last-check')
  gatewayLogsContainer = document.getElementById('gateway-logs-container')
  gatewayToggleLogsButton = document.getElementById('gateway-toggle-logs')
  gatewayLanToggle = document.getElementById('gateway-lan-toggle')
  gatewayPublicToggle = document.getElementById('gateway-public-toggle')
  
  // Log element status
  const elements = {
    workerStatusIndicator,
    workerStatusText,
    startButton,
    stopButton,
    createRelayButton,
    logsContainer,
    relayList,
    clearLogsButton,
    exportLogsButton,
    joinRelayButton,
    newGroupFileSharing,
    gatewayStartButton,
    gatewayStopButton,
    gatewayStatusIndicatorEl,
    gatewayStatusTextEl,
    gatewayUptimeEl,
    gatewayPortEl,
    gatewayPeersEl,
    gatewayRelaysEl,
    gatewayHyperswarmEl,
    gatewayServiceStatusEl,
    gatewayLastCheckEl,
    gatewayLogsContainer,
    gatewayToggleLogsButton,
    gatewayLanToggle,
    gatewayPublicToggle
  }
  
  console.log('[App] Element initialization results:');
  for (const [name, element] of Object.entries(elements)) {
    console.log(`- ${name}:`, element ? 'found' : 'NOT FOUND');
  }
  
  // Set up event listeners
  setupEventListeners();

  if (isElectron) {
    initializeGatewayControls().catch((error) => {
      console.error('[App] Failed to initialize gateway controls:', error);
    })
  }
  
  // Initialize UI state
  updateWorkerStatus('stopped', 'Not Started');
  addLog('Hypertuna Relay Desktop initialized', 'status');
  addLog('Click "Start" to launch the relay worker', 'info');
  
  // Debug button state after initialization
  debugButtonState();
}

// Wait for DOM to be ready - SINGLE HANDLER
if (document.readyState === 'loading') {
  console.log('[App] DOM is loading, setting up DOMContentLoaded listener');
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[App] DOMContentLoaded event fired');
    initializeDOMElements();
  });
} else {
  console.log('[App] DOM already ready, initializing immediately');
  initializeDOMElements();
}

// Cleanup when the renderer is about to unload
window.addEventListener('beforeunload', () => {
  addLog('Application shutting down...', 'status');
  stopPolling();

  if (workerActive && isElectron) {
    electronAPI.sendToWorker({ type: 'shutdown' }).finally(() => {
      electronAPI.stopWorker();
    });
  }
});

// Add CSS dynamically
const style = document.createElement('style')
style.textContent = `
.relay-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.disconnect-btn {
  padding: 4px 12px;
  font-size: 11px;
  background-color: var(--error-color);
  border-color: var(--error-color);
  margin-left: 10px;
}

.disconnect-btn:hover:not(:disabled) {
  background-color: #ff4444;
  color: white;
}
`
document.head.appendChild(style)

// Expose controls for integration - do this immediately
console.log('[App] Exposing window functions');
window.startWorker = startWorker;
window.stopWorker = stopWorker;
window.createRelayInstance = createRelayInstance;
window.joinRelayInstance = joinRelayInstance;
window.joinRelayFromInvite = joinRelayFromInvite;
window.disconnectRelayInstance = disconnectRelay;
window.debugButtonState = debugButtonState;
window.refreshGatewayStatus = refreshGatewayStatus;

console.log('[App] app.js loading completed at:', new Date().toISOString());
