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
let gatewayUptimeTimer = null;
let gatewayPeerRelayMap = new Map();
let gatewayPeerDetails = new Map();
const DEFAULT_API_URL = 'http://localhost:1945';
const DEFAULT_PUBLIC_GATEWAY_URL = 'https://hypertuna.com';
const RELAY_CACHE_STORAGE_KEY = 'hypertuna_relays_cache_v1';

let relayInitializationComplete = false;
let relayCacheHydrated = false;

if (typeof window !== 'undefined') {
  window.HypertunaRelayCacheKey = RELAY_CACHE_STORAGE_KEY;
}

// Store worker messages that may arrive before AppIntegration sets up handlers
let pendingRelayMessages = {
  initialized: [],
  registered: []
}
window.pendingRelayMessages = pendingRelayMessages

// PFP upload queue persisted locally
const PFP_QUEUE_STORAGE_KEY = 'hypertuna_pfp_upload_queue_v1'
let pfpUploadQueue = []
let pfpQueueProcessing = false
let pfpQueueFlushTimer = null

// Promise resolution for swarm key
let swarmKeyPromise = null
let swarmKeyResolver = null

// Track initialization state
let isInitialized = false
let eventListenersAttached = false

// Worker command queue + readiness tracking
const workerQueue = []
let workerQueueProcessing = false
let workerQueueFlushTimer = null
let workerInitializedFlag = false
let workerPfpReady = false
const pendingPfpUploads = new Map()
const pendingPfpConfirmations = []

const defaultQueueOptions = {
  requireWorker: true,
  requireInitialized: true,
  requirePfpDrive: false,
  autoStart: true,
  maxAttempts: 5,
  retryDelayMs: 500,
  retryOnFail: true,
  description: 'worker message'
}

function makeQueueKey(owner = '', fileHash = '') {
  return `${owner || ''}:${fileHash || ''}`
}

function getQueueOptions(options = {}) {
  return { ...defaultQueueOptions, ...(options || {}) }
}

function canSendWorkerMessage(options) {
  if (options.requireWorker && !workerActive) return false
  if (options.requireInitialized && !workerInitializedFlag) return false
  if (options.requirePfpDrive && !workerPfpReady) return false
  return true
}

function scheduleWorkerQueueFlush(delay = 0) {
  if (workerQueueFlushTimer) {
    clearTimeout(workerQueueFlushTimer)
    workerQueueFlushTimer = null
  }
  workerQueueFlushTimer = setTimeout(() => {
    workerQueueFlushTimer = null
    processWorkerQueue().catch((err) => {
      console.error('[App] Worker queue flush failed:', err)
    })
  }, delay)
}

function markWorkerInitialized(value) {
  const next = !!value
  if (workerInitializedFlag !== next) {
    workerInitializedFlag = next
    if (next) {
      scheduleWorkerQueueFlush(0)
      schedulePfpQueueFlush(0)
    }
  }
}

function markWorkerPfpReady(value) {
  const next = !!value
  if (workerPfpReady !== next) {
    workerPfpReady = next
    if (next) {
      scheduleWorkerQueueFlush(0)
      schedulePfpQueueFlush(0)
    }
  }
}

function resetWorkerReadiness(reason = null) {
  if (reason) {
    console.warn('[App] Resetting worker readiness:', reason)
  }
  workerInitializedFlag = false
  workerPfpReady = false
  workerQueue.forEach((entry) => {
    entry.nextAttemptAt = Date.now() + entry.options.retryDelayMs
  })
  scheduleWorkerQueueFlush(250)
  failAllPendingPfpUploads(new Error(reason || 'Worker reset'))
  schedulePfpQueueFlush(2500)
}

function ensureWorkerForQueue() {
  if (!isElectron) return
  if (workerActive) return
  const needsWorker = workerQueue.some((entry) => entry.options.requireWorker && entry.options.autoStart)
  if (needsWorker) {
    startWorker().catch((err) => {
      console.error('[App] Failed to auto-start worker for queue:', err)
    })
  }
}

function isTransientWorkerError(err) {
  const message = err?.message || ''
  if (!message) return false
  return /Worker not running|IPC send error|channel closed|socket hang up/i.test(message)
}

async function processWorkerQueue() {
  if (workerQueueProcessing) return
  if (!workerQueue.length) return
  if (!isElectron || !electronAPI?.sendToWorker) {
    console.warn('[App] Worker queue skipped: electronAPI unavailable')
    return
  }

  workerQueueProcessing = true
  try {
    let madeProgress = false
    const now = Date.now()

    for (let i = 0; i < workerQueue.length; ) {
      const entry = workerQueue[i]
      if (!entry) {
        i += 1
        continue
      }

      if (!canSendWorkerMessage(entry.options)) {
        i += 1
        continue
      }

      if (entry.nextAttemptAt && entry.nextAttemptAt > now) {
        i += 1
        continue
      }

      try {
        const result = await electronAPI.sendToWorker(entry.message)
        if (!result?.success) {
          throw new Error(result?.error || 'Worker rejected message')
        }
        entry.resolve(result)
        workerQueue.splice(i, 1)
        madeProgress = true
        continue
      } catch (err) {
        entry.attempts = (entry.attempts || 0) + 1
        const canRetry = entry.options.retryOnFail && entry.attempts < entry.options.maxAttempts && isTransientWorkerError(err)
        if (!canRetry) {
          workerQueue.splice(i, 1)
          entry.reject(err)
          console.error('[App] Worker message failed:', entry.options.description, err)
          continue
        }

        if (err?.message && /Worker not running/i.test(err.message)) {
          workerActive = false
        }

        entry.nextAttemptAt = Date.now() + entry.options.retryDelayMs
        i += 1
        ensureWorkerForQueue()
      }
    }

    if (madeProgress && workerQueue.length) {
      scheduleWorkerQueueFlush(0)
    } else if (workerQueue.length) {
      const nextRetryIn = workerQueue.reduce((min, entry) => {
        if (!entry.nextAttemptAt) return min
        const delta = Math.max(0, entry.nextAttemptAt - Date.now())
        return min === null ? delta : Math.min(min, delta)
      }, null)
      if (nextRetryIn != null) {
        scheduleWorkerQueueFlush(Math.min(nextRetryIn + 10, 1000))
      }
    }
  } finally {
    workerQueueProcessing = false
  }
}

async function sendWorkerCommand(message, options = {}) {
  if (!isElectron || !electronAPI?.sendToWorker) {
    throw new Error('Worker messaging is unavailable outside Electron runtime')
  }

  const queueOptions = getQueueOptions(options)

  return new Promise((resolve, reject) => {
    workerQueue.push({
      message,
      options: queueOptions,
      resolve,
      reject,
      attempts: 0,
      nextAttemptAt: 0
    })

    if (queueOptions.autoStart) {
      ensureWorkerForQueue()
    }

    scheduleWorkerQueueFlush(0)
  })
}

function waitForPfpAck(owner, fileHash, { timeoutMs = 45000 } = {}) {
  if (!fileHash) {
    return Promise.reject(new Error('Missing fileHash for PFP ack wait'))
  }

  const key = makeQueueKey(owner, fileHash)
  if (pendingPfpUploads.has(key)) {
    return pendingPfpUploads.get(key).promise
  }

  let timeoutId = null
  let settled = false
  const entry = {
    resolve: null,
    reject: null,
    promise: null
  }

  const promise = new Promise((resolve, reject) => {
    entry.resolve = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      pendingPfpUploads.delete(key)
      resolve(payload)
    }
    entry.reject = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      pendingPfpUploads.delete(key)
      reject(error)
    }

    timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      pendingPfpUploads.delete(key)
      reject(new Error('PFP upload acknowledgment timed out'))
    }, Math.max(1000, timeoutMs))
  })

  entry.promise = promise
  pendingPfpUploads.set(key, entry)
  console.log('[PFPQueue] waiting for ACK', { owner, fileHash, timeoutMs })

  return promise
}

function resolvePendingPfpUpload(owner, fileHash, payload = null) {
  if (!fileHash) return
  const key = makeQueueKey(owner, fileHash)
  const entry = pendingPfpUploads.get(key)
  if (entry?.resolve) {
    entry.resolve(payload)
  }
}

function rejectPendingPfpUpload(owner, fileHash, error) {
  if (!fileHash) return
  const key = makeQueueKey(owner, fileHash)
  const entry = pendingPfpUploads.get(key)
  if (entry?.reject) {
    entry.reject(error instanceof Error ? error : new Error(error || 'PFP upload failed'))
  }
}

function failAllPendingPfpUploads(error) {
  if (!pendingPfpUploads.size) return
  const keys = Array.from(pendingPfpUploads.keys())
  keys.forEach((key) => {
    const entry = pendingPfpUploads.get(key)
    if (entry?.reject) {
      entry.reject(error instanceof Error ? error : new Error(String(error || 'PFP upload cancelled')))
    }
  })
  pendingPfpUploads.clear()
}

function enqueuePfpUpload(task) {
  if (!task || !task.fileHash || !task.buffer) return
  task.attempts = task.attempts || 0
  task.nextAttemptAt = null
  if (task.pendingAvatar && typeof task.pendingAvatar === 'object') {
    task.pendingAvatar.status = task.pendingAvatar.status || 'queued'
    task.pendingAvatar.error = null
    task.pendingAvatar.notifiedFailure = false
  }
  console.log('[PFPQueue] enqueue', { owner: task.owner, fileHash: task.fileHash, attempts: task.attempts })
  const existingIdx = pfpUploadQueue.findIndex((entry) => entry.fileHash === task.fileHash && entry.owner === task.owner)
  if (existingIdx >= 0) {
    console.log('[PFPQueue] replacing existing entry', { owner: task.owner, fileHash: task.fileHash })
    pfpUploadQueue[existingIdx] = task
  } else {
    pfpUploadQueue.push(task)
  }
  persistPfpQueue()
  schedulePfpQueueFlush(0)
}

function removePfpUpload(owner, fileHash) {
  const idx = pfpUploadQueue.findIndex((entry) => entry.fileHash === fileHash && entry.owner === owner)
  if (idx >= 0) {
    pfpUploadQueue.splice(idx, 1)
    persistPfpQueue()
    console.log('[PFPQueue] removed entry', { owner, fileHash })
  }
}

function prunePfpQueueForOwner(owner, exceptHash = null) {
  const before = pfpUploadQueue.length
  pfpUploadQueue = pfpUploadQueue.filter((entry) => {
    if (!entry) return false
    if (entry.owner !== owner) return true
    if (exceptHash && entry.fileHash === exceptHash) return true
    return false
  })
  if (pfpUploadQueue.length !== before) {
    persistPfpQueue()
    console.log('[PFPQueue] pruned entries for owner', { owner, exceptHash, removed: before - pfpUploadQueue.length })
  }
}

function schedulePfpQueueFlush(delay = 0) {
  if (pfpQueueFlushTimer) {
    clearTimeout(pfpQueueFlushTimer)
    pfpQueueFlushTimer = null
  }
  pfpQueueFlushTimer = setTimeout(() => {
    pfpQueueFlushTimer = null
    processPfpQueue().catch((err) => {
      console.error('[App] PFP queue flush failed:', err)
    })
  }, delay)
  console.log('[PFPQueue] scheduled flush', delay)
}

async function ensureWorkerReadyForPfp () {
  if (!isElectron) throw new Error('Worker unavailable')
  if (!workerActive) {
    await startWorker().catch((err) => {
      throw new Error(`Failed to start worker: ${err?.message || err}`)
    })
  }

  const maxWaitMs = 45000
  const start = Date.now()
  while (!workerInitializedFlag || !workerPfpReady) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error('Timed out waiting for worker to become ready')
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  console.log('[PFPQueue] worker ready (initialized & pfp drive)')
}

async function processPfpQueue () {
  if (pfpQueueProcessing) return
  if (!pfpUploadQueue.length) return

  pfpQueueProcessing = true
  try {
    await ensureWorkerReadyForPfp()
  } catch (err) {
    console.error('[App] Worker not ready for PFP queue:', err)
    pfpQueueProcessing = false
    schedulePfpQueueFlush(2000)
    return
  }

  try {
    console.log('[PFPQueue] processing run start', { queueSize: pfpUploadQueue.length })
    for (let i = 0; i < pfpUploadQueue.length; ) {
      const task = pfpUploadQueue[i]
      if (!task) {
        pfpUploadQueue.splice(i, 1)
        persistPfpQueue()
        continue
      }

      if (task.nextAttemptAt && task.nextAttemptAt > Date.now()) {
        console.log('[PFPQueue] skipping until nextAttemptAt', { owner: task.owner, fileHash: task.fileHash, nextAttemptAt: task.nextAttemptAt })
        i += 1
        continue
      }

      const baseOptions = {
        requirePfpDrive: true,
        description: 'pfp upload queue'
      }

      try {
        if (task.pendingAvatar) {
          task.pendingAvatar.status = 'processing'
        }
        console.log('[PFPQueue] sending to worker', { owner: task.owner, fileHash: task.fileHash, attempts: task.attempts })
        const ackPromise = waitForPfpAck(task.owner, task.fileHash, { timeoutMs: 60000 })
        await sendWorkerCommand({
          type: 'upload-pfp',
          data: {
            owner: task.owner,
            fileHash: task.fileHash,
            metadata: task.metadata,
            buffer: task.buffer
          }
        }, baseOptions)

        await ackPromise
        removePfpUpload(task.owner, task.fileHash)
        const confirmationPayload = task.pendingAvatar ? { ...task.pendingAvatar, status: 'confirmed', notifiedFailure: false } : task
        if (task.pendingAvatar) {
          task.pendingAvatar.status = 'confirmed'
        }
        console.log('[PFPQueue] worker ack received', { owner: task.owner, fileHash: task.fileHash })
        if (typeof window.App?.handlePfpUploadConfirmed === 'function') {
          try { window.App.handlePfpUploadConfirmed(confirmationPayload) } catch (err) { console.warn('[App] handlePfpUploadConfirmed failed:', err) }
        } else {
          pendingPfpConfirmations.push(confirmationPayload)
        }
        continue
      } catch (err) {
        console.error('[App] Failed to process PFP upload task:', err)
        rejectPendingPfpUpload(task.owner, task.fileHash, err)
        if (task.attempts == null) task.attempts = 0
        task.attempts += 1
        task.lastError = err?.message || String(err)
        task.nextAttemptAt = Date.now() + Math.min(60000, task.attempts * 4000)
        if (task.pendingAvatar) {
          task.pendingAvatar.status = 'retrying'
          task.pendingAvatar.error = task.lastError
        }
        if (task.attempts >= 5 && task.pendingAvatar && !task.pendingAvatar.notifiedFailure && typeof window.App?.handlePendingAvatarUploadFailure === 'function') {
          task.pendingAvatar.notifiedFailure = true
          try { window.App.handlePendingAvatarUploadFailure(task.pendingAvatar, err) } catch (notifyErr) { console.warn('[App] handlePendingAvatarUploadFailure failed:', notifyErr) }
        }
        pfpUploadQueue[i] = task
        persistPfpQueue()
        console.log('[PFPQueue] scheduled retry', { owner: task.owner, fileHash: task.fileHash, attempts: task.attempts, nextAttemptAt: task.nextAttemptAt })
        i += 1
        continue
      }
    }
  } finally {
    pfpQueueProcessing = false
    const soonest = pfpUploadQueue.reduce((min, entry) => {
      if (!entry?.nextAttemptAt) return min
      const delta = Math.max(0, entry.nextAttemptAt - Date.now())
      return min == null ? delta : Math.min(min, delta)
    }, null)
    if (soonest != null) {
      console.log('[PFPQueue] run complete; next flush in', Math.min(soonest + 50, 60000))
      schedulePfpQueueFlush(Math.min(soonest + 50, 60000))
    } else if (pfpUploadQueue.length) {
      console.log('[PFPQueue] queue non-empty, scheduling watchdog flush')
      schedulePfpQueueFlush(5000)
    }
  }
}

window.sendWorkerCommand = sendWorkerCommand
window.waitForPfpAck = waitForPfpAck
window.rejectPendingPfpUpload = rejectPendingPfpUpload
window.enqueuePfpUpload = enqueuePfpUpload
window.schedulePfpQueueFlush = schedulePfpQueueFlush
window.prunePfpQueueForOwner = prunePfpQueueForOwner
window.pendingPfpConfirmations = pendingPfpConfirmations
try {
  window.dispatchEvent(new Event('worker-bridge-ready'))
} catch (_) {}

loadPfpQueueFromStorage()
schedulePfpQueueFlush(1000)

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
let publicGatewayEnableToggle = null
let publicGatewaySelectionSelect = null
let publicGatewayUrlInput = null
let publicGatewaySecretInput = null
let publicGatewaySaveButton = null
let publicGatewayDefaultTtlInput = null
let publicGatewayManualFields = null
let publicGatewaySelectionHelp = null
let publicGatewaySelectionMeta = null
const publicGatewayTokenRequests = new Map()

let publicGatewayConfig = {
  enabled: false,
  selectionMode: 'default',
  selectedGatewayId: null,
  preferredBaseUrl: DEFAULT_PUBLIC_GATEWAY_URL,
  baseUrl: DEFAULT_PUBLIC_GATEWAY_URL,
  sharedSecret: '',
  defaultTokenTtl: 3600,
  resolvedGatewayId: null,
  resolvedDisplayName: null,
  resolvedRegion: null,
  resolvedSecretVersion: null,
  resolvedFallback: false,
  resolvedFromDiscovery: false,
  resolvedAt: null,
  disabledReason: null
}
let publicGatewayState = null
let publicGatewayDiscovered = []

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

function loadPfpQueueFromStorage () {
  try {
    const raw = localStorage.getItem(PFP_QUEUE_STORAGE_KEY)
    if (!raw) {
      console.log('[PFPQueue] storage empty')
      pfpUploadQueue = []
      return
    }
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      console.log('[PFPQueue] loaded entries from storage', parsed.length)
      pfpUploadQueue = parsed
        .filter(entry => entry && entry.fileHash && entry.buffer)
        .map(entry => {
          const normalized = { ...entry }
          normalized.metadata = entry.metadata && typeof entry.metadata === 'object' ? { ...entry.metadata } : {}
          if (entry.pendingAvatar && typeof entry.pendingAvatar === 'object') {
            normalized.pendingAvatar = {
              ...entry.pendingAvatar,
              status: entry.pendingAvatar.status || 'queued',
              error: entry.pendingAvatar.error || null,
              notifiedFailure: !!entry.pendingAvatar.notifiedFailure
            }
          }
          normalized.attempts = entry.attempts || 0
          normalized.nextAttemptAt = entry.nextAttemptAt || null
          return normalized
        })
    } else {
      console.warn('[PFPQueue] invalid storage payload, clearing queue')
      pfpUploadQueue = []
    }
  } catch (err) {
    console.warn('[App] Failed to load PFP queue from storage:', err)
    pfpUploadQueue = []
  }
}

function persistPfpQueue () {
  try {
    localStorage.setItem(PFP_QUEUE_STORAGE_KEY, JSON.stringify(pfpUploadQueue))
    console.log('[PFPQueue] persisted queue size', pfpUploadQueue.length)
  } catch (err) {
    console.warn('[App] Failed to persist PFP queue:', err)
  }
}

function buildPublicGatewaySummary() {
  const selectionMode = publicGatewayConfig.selectionMode || 'default'
  const selectedGatewayId = publicGatewayConfig.selectedGatewayId || null
  const selectedGateway = selectedGatewayId
    ? publicGatewayDiscovered.find((entry) => entry.gatewayId === selectedGatewayId)
    : null

  const bridgeEnabled = !!publicGatewayConfig.enabled
  const remoteActive = !!publicGatewayState?.enabled

  let status = 'inactive'
  let text = ''

  if (!bridgeEnabled) {
    status = 'disabled'
    text = 'Enable the bridge to connect through a public gateway.'
  } else if (selectionMode === 'discovered' && selectedGateway?.isExpired) {
    status = 'warning'
    const label = selectedGateway.displayName || selectedGateway.publicUrl || 'Selected gateway'
    text = `${label} is currently offline.`
  } else if (selectionMode === 'discovered' && selectedGateway?.secretFetchError) {
    status = 'warning'
    const label = selectedGateway.displayName || selectedGateway.publicUrl || 'Selected gateway'
    text = `${label} secret unavailable: ${selectedGateway.secretFetchError}`
  } else if (bridgeEnabled && publicGatewayState?.disabledReason) {
    status = 'error'
    text = `Bridge unavailable: ${publicGatewayState.disabledReason}`
  } else if (bridgeEnabled && publicGatewayState?.discoveryUnavailableReason) {
    status = 'warning'
    text = `Discovery error: ${publicGatewayState.discoveryUnavailableReason}`
  } else if (bridgeEnabled && publicGatewayState?.enabled) {
    status = 'online'
    const label = publicGatewayState.resolvedDisplayName
      || publicGatewayState.baseUrl
      || selectedGateway?.publicUrl
      || publicGatewayConfig.baseUrl
      || DEFAULT_PUBLIC_GATEWAY_URL
    const parts = [`Connected to ${label}`]
    if (publicGatewayState.resolvedRegion) parts.push(publicGatewayState.resolvedRegion)
    if (publicGatewayState.resolvedSecretVersion) parts.push(`secret v${publicGatewayState.resolvedSecretVersion}`)
    if (publicGatewayState.resolvedFallback) parts.push('fallback in use')
    if (publicGatewayState.resolvedAt) parts.push(`updated ${formatRelativeTime(publicGatewayState.resolvedAt)}`)
    text = parts.join(' • ')
  } else {
    status = 'pending'
    text = 'Waiting for connection to a public gateway.'
  }

  return {
    text,
    status,
    bridgeEnabled,
    remoteActive,
    selectionMode,
    selectedGateway
  }
}

function formatRelayGatewayStats(relayInfo) {
  if (!relayInfo) return []
  const peers = typeof relayInfo.peerCount === 'number'
    ? relayInfo.peerCount
    : relayInfo.peers instanceof Set
      ? relayInfo.peers.size
      : Array.isArray(relayInfo.peers)
        ? relayInfo.peers.length
        : 0

  const parts = [`Peers: ${peers}`]
  const syncValue = relayInfo.metadata?.lastSyncedAt || relayInfo.lastSyncedAt || relayInfo.lastActive
  const syncedText = syncValue ? formatRelativeTime(syncValue) : '—'
  parts.push(`Synced: ${syncedText}`)
  const gatewayPath = relayInfo.metadata?.gatewayPath
  if (gatewayPath) parts.push(`Path: ${gatewayPath}`)
  return parts
}

function emitPublicGatewayMessage(type, message, detail = {}) {
  window.dispatchEvent(new CustomEvent('public-gateway-message', {
    detail: {
      type,
      message,
      ...detail
    }
  }))
}

function dequeuePublicGatewayRequest(relayKey) {
  if (!relayKey) return null
  const queue = publicGatewayTokenRequests.get(relayKey)
  if (!Array.isArray(queue) || queue.length === 0) {
    return null
  }
  const entry = queue.shift()
  if (queue.length === 0) {
    publicGatewayTokenRequests.delete(relayKey)
  }
  return entry
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

function updateGatewayPeerState(status = {}) {
  const relayEntries =
    status && typeof status.peerRelayMap === 'object'
      ? Object.entries(status.peerRelayMap)
      : [];
  const detailEntries =
    status && typeof status.peerDetails === 'object'
      ? Object.entries(status.peerDetails)
      : [];

  const nextRelayMap = new Map();
  for (const [identifier, info] of relayEntries) {
    const peersArray = Array.isArray(info?.peers) ? info.peers : [];
    const metadata = info?.metadata && typeof info.metadata === 'object'
      ? { ...info.metadata }
      : null;

    if (metadata && metadata.metadataUpdatedAt != null) {
      const ts = Number(metadata.metadataUpdatedAt);
      if (Number.isFinite(ts)) metadata.metadataUpdatedAt = ts;
    }

    nextRelayMap.set(identifier, {
      peers: new Set(peersArray),
      peerCount:
        typeof info?.peerCount === 'number' ? info.peerCount : peersArray.length,
      status: info?.status || 'unknown',
      lastActive: info?.lastActive || null,
      createdAt: info?.createdAt || null,
      metadata
    });
  }

  const nextDetailMap = new Map();
  for (const [peerKey, info] of detailEntries) {
    const relays = Array.isArray(info?.relays) ? info.relays : [];
    nextDetailMap.set(peerKey, {
      nostrPubkeyHex: info?.nostrPubkeyHex || null,
      relays,
      relayCount:
        typeof info?.relayCount === 'number' ? info.relayCount : relays.length,
      lastSeen: info?.lastSeen || null,
      status: info?.status || 'unknown',
      mode: info?.mode || null,
      address: info?.address || null
    });
  }

  gatewayPeerRelayMap = nextRelayMap;
  gatewayPeerDetails = nextDetailMap;

  window.gatewayPeerRelayMap = gatewayPeerRelayMap;
  window.gatewayPeerDetails = gatewayPeerDetails;

  if (window.App && typeof window.App.updateGatewayPeers === 'function') {
    window.App.updateGatewayPeers({
      relayMap: gatewayPeerRelayMap,
      peerDetails: gatewayPeerDetails,
      status
    });
  }

  renderPublicGatewayStatus(publicGatewayState);
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

function normalizePublicGatewayConfig(config = {}) {
  const enabled = !!config.enabled
  const selectionRaw = typeof config.selectionMode === 'string' ? config.selectionMode.trim().toLowerCase() : ''
  const selectionMode = ['default', 'discovered', 'manual'].includes(selectionRaw) ? selectionRaw : 'default'
  const selectedGatewayId = typeof config.selectedGatewayId === 'string'
    ? config.selectedGatewayId.trim() || null
    : null
  const preferredBaseUrl = typeof config.preferredBaseUrl === 'string'
    ? config.preferredBaseUrl.trim() || DEFAULT_PUBLIC_GATEWAY_URL
    : DEFAULT_PUBLIC_GATEWAY_URL
  const baseUrlRaw = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  const sharedSecretRaw = typeof config.sharedSecret === 'string' ? config.sharedSecret.trim() : ''
  const ttlRaw = Number(config.defaultTokenTtl)
  const defaultTokenTtl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.max(60, Math.round(ttlRaw)) : 3600

  const normalized = {
    enabled,
    selectionMode,
    selectedGatewayId,
    preferredBaseUrl: preferredBaseUrl || DEFAULT_PUBLIC_GATEWAY_URL,
    baseUrl: baseUrlRaw || DEFAULT_PUBLIC_GATEWAY_URL,
    sharedSecret: sharedSecretRaw,
    defaultTokenTtl,
    resolvedGatewayId: config.resolvedGatewayId || null,
    resolvedDisplayName: config.resolvedDisplayName || null,
    resolvedRegion: config.resolvedRegion || null,
    resolvedSecretVersion: config.resolvedSecretVersion || null,
    resolvedFallback: !!config.resolvedFallback,
    resolvedFromDiscovery: !!config.resolvedFromDiscovery,
    resolvedAt: config.resolvedAt || null,
    disabledReason: config.disabledReason || null
  }

  if (normalized.selectionMode === 'default') {
    normalized.selectedGatewayId = null
    normalized.baseUrl = normalized.preferredBaseUrl || DEFAULT_PUBLIC_GATEWAY_URL
    normalized.sharedSecret = ''
  } else if (normalized.selectionMode === 'manual') {
    if (!normalized.baseUrl) normalized.baseUrl = normalized.preferredBaseUrl || DEFAULT_PUBLIC_GATEWAY_URL
  } else if (normalized.selectionMode === 'discovered') {
    normalized.sharedSecret = ''
  }

  return normalized
}

function applyPublicGatewayConfigToUI() {
  HypertunaUtils.updatePublicGatewayConfig(publicGatewayConfig)
  if (publicGatewayEnableToggle) {
    publicGatewayEnableToggle.checked = !!publicGatewayConfig.enabled
  }
  if (publicGatewayUrlInput && publicGatewayConfig.selectionMode === 'manual') {
    publicGatewayUrlInput.value = publicGatewayConfig.baseUrl || ''
  } else if (publicGatewayUrlInput && !publicGatewayUrlInput.value) {
    publicGatewayUrlInput.value = ''
  }
  if (publicGatewaySecretInput && publicGatewayConfig.selectionMode === 'manual') {
    publicGatewaySecretInput.value = publicGatewayConfig.sharedSecret || ''
  } else if (publicGatewaySecretInput && publicGatewaySecretInput.value) {
    publicGatewaySecretInput.value = ''
  }
  if (publicGatewayDefaultTtlInput) {
    const minutes = Math.max(1, Math.round((publicGatewayConfig.defaultTokenTtl || 3600) / 60))
    publicGatewayDefaultTtlInput.value = String(minutes)
  }
  populatePublicGatewaySelectionOptions()
  updatePublicGatewayFormState()
}

function updatePublicGatewayFormState() {
  const selectionMode = publicGatewayConfig.selectionMode || 'default'
  const summary = buildPublicGatewaySummary()
  const bridgeEnabled = summary.bridgeEnabled

  if (publicGatewaySelectionSelect) {
    publicGatewaySelectionSelect.disabled = false
  }

  if (publicGatewayManualFields) {
    publicGatewayManualFields.classList.toggle('hidden', selectionMode !== 'manual')
  }

  if (publicGatewayUrlInput) {
    if (selectionMode === 'manual') {
      publicGatewayUrlInput.readOnly = false
      publicGatewayUrlInput.disabled = !bridgeEnabled
    } else {
      publicGatewayUrlInput.readOnly = true
      publicGatewayUrlInput.disabled = true
      if (selectionMode === 'default') {
        publicGatewayUrlInput.value = publicGatewayConfig.preferredBaseUrl || DEFAULT_PUBLIC_GATEWAY_URL
      } else if (selectionMode === 'discovered') {
        const resolvedUrl = selectedGateway?.publicUrl
          || publicGatewayState?.baseUrl
          || publicGatewayConfig.baseUrl
          || ''
        publicGatewayUrlInput.value = resolvedUrl
      }
    }
  }

  if (publicGatewaySecretInput) {
    if (selectionMode === 'manual') {
      publicGatewaySecretInput.readOnly = false
      publicGatewaySecretInput.disabled = !bridgeEnabled
    } else {
      publicGatewaySecretInput.readOnly = true
      publicGatewaySecretInput.disabled = true
      publicGatewaySecretInput.value = ''
    }
  }

  if (publicGatewaySelectionHelp) {
    if (selectionMode === 'manual') {
      publicGatewaySelectionHelp.textContent = 'Provide the gateway details and shared secret supplied by the administrator.'
    } else if (selectionMode === 'discovered') {
      publicGatewaySelectionHelp.textContent = 'Open public gateways share their connection secret automatically when selected.'
    } else {
      publicGatewaySelectionHelp.textContent = 'Hypertuna.com will be used by default unless it is unavailable.'
    }
  }

  if (publicGatewaySelectionMeta) {
    publicGatewaySelectionMeta.textContent = summary.text
  }
}

function handlePublicGatewaySelectionChange() {
  if (!publicGatewaySelectionSelect) return
  const value = publicGatewaySelectionSelect.value || 'default'
  if (value === 'manual') {
    publicGatewayConfig.selectionMode = 'manual'
    publicGatewayConfig.selectedGatewayId = null
    publicGatewayConfig.preferredBaseUrl = publicGatewayConfig.baseUrl || publicGatewayConfig.preferredBaseUrl || DEFAULT_PUBLIC_GATEWAY_URL
  } else if (value.startsWith('gateway:')) {
    const gatewayId = value.slice(8)
    publicGatewayConfig.selectionMode = 'discovered'
    publicGatewayConfig.selectedGatewayId = gatewayId || null
    const selected = publicGatewayDiscovered.find((entry) => entry.gatewayId === gatewayId)
    if (selected?.publicUrl) {
      publicGatewayConfig.baseUrl = selected.publicUrl
    }
  } else {
    publicGatewayConfig.selectionMode = 'default'
    publicGatewayConfig.selectedGatewayId = null
    publicGatewayConfig.preferredBaseUrl = DEFAULT_PUBLIC_GATEWAY_URL
    publicGatewayConfig.baseUrl = DEFAULT_PUBLIC_GATEWAY_URL
  }
  updatePublicGatewayFormState()
}

function populatePublicGatewaySelectionOptions() {
  if (!publicGatewaySelectionSelect) return

  const previousValue = publicGatewaySelectionSelect.value
  publicGatewaySelectionSelect.innerHTML = ''

  const defaultOption = document.createElement('option')
  defaultOption.value = 'default'
  defaultOption.textContent = 'Default (hypertuna.com)'
  publicGatewaySelectionSelect.appendChild(defaultOption)

  const gateways = Array.isArray(publicGatewayDiscovered) ? [...publicGatewayDiscovered] : []
  gateways.sort((a, b) => {
    if (!!a.isExpired !== !!b.isExpired) return a.isExpired ? 1 : -1
    return (b.lastSeenAt || 0) - (a.lastSeenAt || 0)
  })

  for (const gateway of gateways) {
    const option = document.createElement('option')
    option.value = `gateway:${gateway.gatewayId}`
    const name = gateway.displayName || gateway.publicUrl || gateway.gatewayId
    const descriptors = []
    if (gateway.region) descriptors.push(gateway.region)
    if (gateway.isExpired) descriptors.push('offline')
    else if (gateway.secretFetchError) descriptors.push('error')
    else descriptors.push('online')
    option.textContent = descriptors.length ? `${name} (${descriptors.join(' • ')})` : name
    option.dataset.url = gateway.publicUrl || ''
    if (gateway.isExpired || !gateway.sharedSecret) {
      option.disabled = true
    }
    publicGatewaySelectionSelect.appendChild(option)
  }

  const manualOption = document.createElement('option')
  manualOption.value = 'manual'
  manualOption.textContent = 'Manual entry'
  publicGatewaySelectionSelect.appendChild(manualOption)

  let targetValue = 'default'
  if (publicGatewayConfig.selectionMode === 'manual') {
    targetValue = 'manual'
  } else if (publicGatewayConfig.selectionMode === 'discovered' && publicGatewayConfig.selectedGatewayId) {
    targetValue = `gateway:${publicGatewayConfig.selectedGatewayId}`
    const option = Array.from(publicGatewaySelectionSelect.options).find((opt) => opt.value === targetValue && !opt.disabled)
    if (!option) {
      targetValue = previousValue && previousValue.startsWith('gateway:') ? previousValue : 'default'
    }
  }

  if (!Array.from(publicGatewaySelectionSelect.options).some((opt) => opt.value === targetValue && !opt.disabled)) {
    targetValue = 'default'
  }

  publicGatewaySelectionSelect.value = targetValue
}

function renderPublicGatewayStatus(state) {
  publicGatewayState = state || null
  publicGatewayDiscovered = Array.isArray(state?.discoveredGateways) ? state.discoveredGateways : []
  HypertunaUtils.updatePublicGatewayState(publicGatewayState, publicGatewayConfig)
  if (window.App?.updatePublicGatewayState) {
    window.App.updatePublicGatewayState(publicGatewayState)
  }
  populatePublicGatewaySelectionOptions()
  updatePublicGatewayFormState()
  const summary = buildPublicGatewaySummary()
  if (window.App?.refreshRelayGatewayCard) {
    try {
      window.App.refreshRelayGatewayCard()
    } catch (error) {
      console.warn('Failed to refresh relay gateway card:', error)
    }
  }
  window.dispatchEvent(new CustomEvent('public-gateway-status', {
    detail: {
      state: publicGatewayState,
      summary
    }
  }))
}

async function loadPublicGatewayConfig() {
  if (!isElectron || !electronAPI?.getPublicGatewayConfig) return
  try {
    const response = await electronAPI.getPublicGatewayConfig()
    if (response && response.config) {
      publicGatewayConfig = normalizePublicGatewayConfig(response.config)
    } else if ((!response || response.config == null) && electronAPI.readPublicGatewaySettings) {
      const fallback = await electronAPI.readPublicGatewaySettings()
      if (fallback?.data) {
        publicGatewayConfig = normalizePublicGatewayConfig(fallback.data)
      }
    }
  } catch (error) {
    console.error('[App] Failed to load public gateway config:', error)
    if (electronAPI?.readPublicGatewaySettings) {
      try {
        const fallback = await electronAPI.readPublicGatewaySettings()
        if (fallback?.data) {
          publicGatewayConfig = normalizePublicGatewayConfig(fallback.data)
        }
      } catch (fallbackError) {
        console.error('[App] Failed to read public gateway settings fallback:', fallbackError)
      }
    }
  }

  applyPublicGatewayConfigToUI()
}

async function refreshPublicGatewayStatus({ requestLatest = true } = {}) {
  if (!isElectron || !electronAPI?.getPublicGatewayStatus) return
  try {
    if (requestLatest) {
      const response = await electronAPI.getPublicGatewayStatus()
      if (response && response.status) {
        publicGatewayState = response.status
      }
    }
  } catch (error) {
    console.error('[App] Failed to refresh public gateway status:', error)
  }

  renderPublicGatewayStatus(publicGatewayState)
}

async function refreshPublicGatewayRelay(relayKey) {
  if (!relayKey) {
    throw new Error('Relay key is required to request a resync.')
  }
  if (!isElectron || !electronAPI?.refreshPublicGatewayRelay) {
    throw new Error('Public gateway bridge is unavailable in this environment.')
  }
  try {
    await electronAPI.refreshPublicGatewayRelay(relayKey)
  } catch (error) {
    console.error('[App] Failed to request public gateway relay refresh:', error)
    throw error
  }
}

async function handlePublicGatewaySave(event) {
  if (event) {
    event.preventDefault()
    event.stopPropagation()
  }
  if (!isElectron || !electronAPI?.setPublicGatewayConfig) return

  const enabled = !!publicGatewayEnableToggle?.checked
  const selectionValue = publicGatewaySelectionSelect?.value || 'default'
  let selectionMode = 'default'
  let selectedGatewayId = null
  let preferredBaseUrl = publicGatewayConfig.preferredBaseUrl || DEFAULT_PUBLIC_GATEWAY_URL
  let baseUrl = ''
  let sharedSecret = ''

  if (selectionValue === 'manual') {
    selectionMode = 'manual'
    baseUrl = publicGatewayUrlInput?.value?.trim() || ''
    sharedSecret = publicGatewaySecretInput?.value?.trim() || ''
    preferredBaseUrl = baseUrl || preferredBaseUrl || DEFAULT_PUBLIC_GATEWAY_URL
    if (enabled && (!baseUrl || !sharedSecret)) {
      emitPublicGatewayMessage('error', 'Base URL and shared secret are required for manual configuration.')
      return
    }
  } else if (selectionValue.startsWith('gateway:')) {
    selectionMode = 'discovered'
    selectedGatewayId = selectionValue.slice(8)
    const selectedGateway = publicGatewayDiscovered.find((entry) => entry.gatewayId === selectedGatewayId)
    baseUrl = selectedGateway?.publicUrl || publicGatewayConfig.baseUrl || ''
    sharedSecret = ''
    if (enabled && (!selectedGatewayId || !baseUrl)) {
      emitPublicGatewayMessage('error', 'Select an available public gateway before saving.')
      return
    }
  } else {
    selectionMode = 'default'
    preferredBaseUrl = publicGatewayConfig.preferredBaseUrl || DEFAULT_PUBLIC_GATEWAY_URL
    baseUrl = preferredBaseUrl
    sharedSecret = ''
  }

  const ttlMinutes = Number(publicGatewayDefaultTtlInput?.value)
  const ttlSecondsRaw = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Math.round(ttlMinutes * 60) : publicGatewayConfig.defaultTokenTtl
  const ttlSeconds = Math.max(60, ttlSecondsRaw)

  const nextConfig = normalizePublicGatewayConfig({
    enabled,
    selectionMode,
    selectedGatewayId,
    preferredBaseUrl,
    baseUrl,
    sharedSecret,
    defaultTokenTtl: ttlSeconds
  })

  try {
    const response = await electronAPI.setPublicGatewayConfig(nextConfig)
    if (response && response.success === false) {
      throw new Error(response.error || 'Failed to update public gateway config')
    }
    publicGatewayConfig = nextConfig
    applyPublicGatewayConfigToUI()
    emitPublicGatewayMessage('success', 'Public gateway settings saved.')
    await refreshPublicGatewayStatus({ requestLatest: true })
  } catch (error) {
    console.error('[App] Failed to save public gateway settings:', error)
    emitPublicGatewayMessage('error', `Failed to save settings: ${error.message}`)
  }
}

async function requestPublicGatewayToken({ relayKey, ttlSeconds } = {}) {
  if (!relayKey) {
    throw new Error('Relay key is required to generate a link.')
  }

  if (!isElectron || !electronAPI?.generatePublicGatewayToken) {
    throw new Error('Token generation is only available in the desktop app.')
  }

  if (!publicGatewayState?.enabled) {
    throw new Error('Enable the public gateway bridge before generating tokens.')
  }

  const ttlSecondsValid = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? Math.round(ttlSeconds)
    : Math.max(60, publicGatewayConfig.defaultTokenTtl || 3600)

  return new Promise((resolve, reject) => {
    const queue = publicGatewayTokenRequests.get(relayKey) || []
    const entry = { resolve, reject }
    queue.push(entry)
    publicGatewayTokenRequests.set(relayKey, queue)

    electronAPI.generatePublicGatewayToken({ relayKey, ttlSeconds: ttlSecondsValid }).catch((error) => {
      const pending = publicGatewayTokenRequests.get(relayKey) || []
      const idx = pending.indexOf(entry)
      if (idx !== -1) {
        pending.splice(idx, 1)
      }
      if (!pending.length) {
        publicGatewayTokenRequests.delete(relayKey)
      } else {
        publicGatewayTokenRequests.set(relayKey, pending)
      }
      reject(error)
    })
  })
}

async function copyTextToClipboard(value) {
  if (!value) {
    throw new Error('Nothing to copy.')
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return true
  }

  const tempInput = document.createElement('textarea')
  tempInput.value = value
  tempInput.setAttribute('readonly', '')
  tempInput.style.position = 'absolute'
  tempInput.style.left = '-9999px'
  document.body.appendChild(tempInput)
  tempInput.select()
  try {
    const success = document.execCommand('copy')
    return success
  } finally {
    document.body.removeChild(tempInput)
  }
}

function handlePublicGatewayTokenResult(result) {
  if (!result) return
  const resolver = dequeuePublicGatewayRequest(result.relayKey)
  if (resolver) {
    resolver.resolve(result)
  }
  emitPublicGatewayMessage('success', 'Public gateway link generated.', { result })
  window.dispatchEvent(new CustomEvent('public-gateway-token', { detail: result }))
}

function handlePublicGatewayTokenError(message, relayKey) {
  const text = message || 'Failed to generate token.'
  const resolver = dequeuePublicGatewayRequest(relayKey)
  const error = new Error(text)
  if (resolver) {
    resolver.reject(error)
  }
  emitPublicGatewayMessage('error', text, { relayKey })
  window.dispatchEvent(new CustomEvent('public-gateway-token-error', {
    detail: {
      relayKey: relayKey || null,
      message: text
    }
  }))
}

async function refreshGatewayStatus() {
  if (!isElectron || !electronAPI?.getGatewayStatus) return
  try {
    const [statusResult, logsResult] = await Promise.all([
      electronAPI.getGatewayStatus(),
      electronAPI.getGatewayLogs()
    ])

    if (statusResult && 'status' in statusResult) {
      const statusPayload = statusResult.status || { running: false }
      updateGatewayUI(statusPayload)
      updateGatewayPeerState(statusPayload)
    }

    if (Array.isArray(logsResult?.logs)) {
      gatewayLogs = logsResult.logs.slice(-500)
      if (gatewayLogVisible) {
        renderGatewayLogs()
      }
    }
  } catch (error) {
    console.error('[App] Failed to refresh gateway status:', error)
  }
}

async function handleGatewayStart() {
  if (!isElectron || !electronAPI?.startGateway) return
  if (gatewayStartButton) gatewayStartButton.disabled = true
  try {
    addLog('Starting local gateway...', 'status')
    const response = await electronAPI.startGateway()
    if (response && response.success === false) {
      throw new Error(response.error || 'Gateway start failed')
    }
    await refreshGatewayStatus()
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
    await refreshGatewayStatus()
  } catch (error) {
    console.error('[App] Failed to stop gateway:', error)
    addLog(`Failed to stop gateway: ${error.message}`, 'error')
  } finally {
    if (gatewayStopButton) gatewayStopButton.disabled = false
  }
}

async function initializeGatewayControls() {
  if (!isElectron) return

  await refreshGatewayStatus()
  await loadPublicGatewayConfig()
  await refreshPublicGatewayStatus({ requestLatest: true })
  populatePublicGatewayRelayOptions()
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
    resetWorkerReadiness('worker error')
  });

  electronAPI.onWorkerExit((code) => {
    addLog('Worker process closed', 'status');
    updateWorkerStatus('stopped', 'Stopped');
    workerActive = false;
    stopPolling();
    resetWorkerReadiness('worker exit')
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

  relayInitializationComplete = false
  if (window.App?.relayProgress && typeof window.App.relayProgress.reset === 'function') {
    window.App.relayProgress.reset({ hide: true })
  }
  if (!relayCacheHydrated) {
    hydrateRelayListFromCache()
  }

  attachWorkerEventListeners();

  swarmKeyPromise = new Promise((resolve) => {
    swarmKeyResolver = resolve;
  });

  markWorkerInitialized(false)
  markWorkerPfpReady(false)
  failAllPendingPfpUploads(new Error('Worker restarting'))

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

    await sendWorkerCommand(configMessage, {
      requireInitialized: false,
      requirePfpDrive: false,
      autoStart: false,
      description: 'worker config delivery',
      retryOnFail: true
    })

    setTimeout(() => {
      if (workerActive) {
        sendWorkerCommand(configMessage, {
          requireInitialized: false,
          requirePfpDrive: false,
          autoStart: false,
          description: 'worker config refresh',
          retryOnFail: false,
          maxAttempts: 1
        }).catch(() => {})
      }
    }, 1000)

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

    await sendWorkerCommand({ type: 'shutdown' }, {
      requireInitialized: false,
      requirePfpDrive: false,
      autoStart: false,
      description: 'worker shutdown command',
      maxAttempts: 3
    })

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
        resetWorkerReadiness('worker stopped')
      }
    }, 3000);
  } catch (error) {
    console.error('[App] Error in stopWorker:', error);
    addLog(`Error stopping worker: ${error.message}`, 'error');
    workerActive = false;
    updateWorkerStatus('stopped', 'Error');
    resetWorkerReadiness('worker stop failed')
  }
}


// Handle messages from worker
async function handleWorkerMessage(message) {
  console.log('[App] Received worker message:', message)

  try {
    window.dispatchEvent(new CustomEvent('worker-message', { detail: message }))
  } catch (err) {
    console.warn('[App] Failed to dispatch worker-message event', err)
  }

  switch (message.type) {
    case 'status':
        addLog(`Worker: ${message.message}`, 'status')
        try {
          if (message.message) {
            const stage = message.initialized ? 'worker-ready' : 'worker-status';
            const variant = message.initialized ? 'success' : 'info';
            window.dispatchEvent(new CustomEvent('relay-loading-status', {
              detail: {
                stage,
                message: message.message,
                variant,
                source: 'worker',
                timestamp: Date.now()
              }
            }))
          }
        } catch (error) {
          console.warn('[App] Failed to broadcast worker status:', error)
        }
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
                markWorkerInitialized(true)
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
        markWorkerPfpReady(true)
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
      resolvePendingPfpUpload(message.owner || '', message.fileHash, message)
      break

    case 'upload-pfp-error':
      console.error('[App] Worker reported upload-pfp error:', message?.error)
      rejectPendingPfpUpload(message.owner || '', message.fileHash, message?.error || 'upload-pfp failed')
      addLog(`Worker upload-pfp error: ${message?.error || 'Unknown error'}`, 'error')
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
      
    case 'relay-loading': {
      try {
        const identifier = message.name
          || message.publicIdentifier
          || (message.relayKey ? `${message.relayKey.slice(0, 8)}…` : 'Relay')
        const stage = message.stage || 'relay-loading'
        let variant = message.variant || 'info'

        if (!message.variant) {
          if (stage.includes('error')) variant = 'error'
          else if (stage === 'initialized') variant = 'success'
          else if (stage === 'skipped') variant = 'warning'
          else variant = 'info'
        }

        const statusMessage = message.message
          || (stage === 'initialized'
            ? `${identifier} is online.`
            : stage === 'already-active'
              ? `${identifier} already running.`
              : stage === 'skipped'
                ? `${identifier} skipped (auto-connect disabled).`
                : `Initializing ${identifier}...`)

        window.dispatchEvent(new CustomEvent('relay-loading-status', {
          detail: {
            stage,
            message: statusMessage,
            variant,
            source: 'worker',
            relayKey: message.relayKey || null,
            publicIdentifier: message.publicIdentifier || null,
            count: typeof message.count === 'number' ? message.count : undefined,
            total: typeof message.total === 'number' ? message.total : undefined,
            timestamp: Date.now()
          }
        }))
      } catch (error) {
        console.warn('[App] Failed to broadcast relay-loading status:', error)
      }
      break
    }

    case 'relay-registration-complete':
      // When a relay has been registered with gateway
      if (message.relayKey) {
        console.log(`[App] Relay registered with gateway: ${message.relayKey}`)
        addLog(`Relay ${message.relayKey} registered with gateway`, 'status')

        try {
          const identifier = message.publicIdentifier
            || message.name
            || `${message.relayKey.slice(0, 8)}…`
          window.dispatchEvent(new CustomEvent('relay-loading-status', {
            detail: {
              stage: 'relay-registered',
              message: `${identifier} registered with gateway.`,
              variant: 'success',
              source: 'worker',
              relayKey: message.relayKey,
              publicIdentifier: message.publicIdentifier || null,
              timestamp: Date.now()
            }
          }))
        } catch (error) {
          console.warn('[App] Failed to broadcast relay registration status:', error)
        }

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
      relayInitializationComplete = true
      if (window.App) {
        window.App.relayInitializationComplete = true
        window.App.relayInitializationReportedCount = typeof message.count === 'number' ? message.count : null
      }
      try {
        const initializedCount = typeof message.count === 'number' ? message.count : initializedRelays.size
        const statusMessage = initializedCount > 0
          ? `Loaded ${initializedCount} relay${initializedCount === 1 ? '' : 's'}.`
          : 'No relays found for this account.'
        window.dispatchEvent(new CustomEvent('relay-loading-status', {
          detail: {
            stage: 'all-relays-initialized',
            message: statusMessage,
            variant: initializedCount > 0 ? 'success' : 'warning',
            source: 'worker',
            count: typeof message.count === 'number' ? message.count : undefined,
            timestamp: Date.now()
          }
        }))
      } catch (error) {
        console.warn('[App] Failed to broadcast all-relays-initialized status:', error)
      }
      if (window.App && window.App.nostr) {
        window.App.nostr.handleAllRelaysReady()
      }

      if (typeof message.count === 'number' && message.count === 0) {
        clearRelayCache()
        relays = []
        renderRelayListContent([], { showEmpty: true })
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
      
    case 'relay-initialization-failed':
      addLog(`Relay initialization failed for ${message.relayKey || 'unknown'}: ${message.error}`, 'error')
      try {
        window.dispatchEvent(new CustomEvent('relay-loading-status', {
          detail: {
            stage: 'relay-error',
            message: message.error || 'Relay initialization failed',
            variant: 'error',
            source: 'worker',
            relayKey: message.relayKey || null,
            publicIdentifier: message.publicIdentifier || null,
            timestamp: Date.now()
          }
        }))
      } catch (error) {
        console.warn('[App] Failed to broadcast relay error status:', error)
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
        updateGatewayPeerState(message.status)

        const gatewayIsReady = !!message.status?.running
        if (window.App && window.App.nostr && typeof window.App.nostr.setGatewayReady === 'function') {
          window.App.nostr.setGatewayReady(gatewayIsReady)
        }
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
      if (message.status) {
        updateGatewayUI(message.status)
        updateGatewayPeerState(message.status)
      }
      break

    case 'gateway-stopped':
      addLog('Local gateway stopped', 'status')
      if (message.status) {
        updateGatewayUI(message.status)
        updateGatewayPeerState(message.status)
      } else {
        updateGatewayPeerState({})
      }
      break

    case 'gateway-error':
      if (message.message) {
        addLog(`Gateway error: ${message.message}`, 'error')
      }
      break

    case 'public-gateway-config':
      if (message.config) {
        publicGatewayConfig = normalizePublicGatewayConfig(message.config)
        applyPublicGatewayConfigToUI()
      }
      break

    case 'public-gateway-status':
      if (message.state) {
        renderPublicGatewayStatus(message.state)
      }
      break

    case 'public-gateway-token':
      handlePublicGatewayTokenResult(message.result)
      break

    case 'public-gateway-token-error':
      handlePublicGatewayTokenError(message.error, message.relayKey)
      break

    case 'public-gateway-error':
      if (message.message) {
        addLog(`Public gateway error: ${message.message}`, 'error')
        emitPublicGatewayMessage('error', message.message)
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
      sendWorkerCommand({ type: 'get-health' }, {
        requirePfpDrive: false,
        autoStart: false,
        maxAttempts: 1,
        retryOnFail: false,
        description: 'worker health request'
      }).catch(() => {})
    }
  }

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
    await sendWorkerCommand({ type: 'get-relays' }, {
      requirePfpDrive: false,
      autoStart: false,
      description: 'relay fetch',
      maxAttempts: 2
    })
  } catch (error) {
    addLog(`Failed to fetch relays: ${error.message}`, 'error');
  }
}

function loadRelayCache() {
  try {
    const raw = localStorage.getItem(RELAY_CACHE_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    console.warn('[App] Failed to load relay cache:', error)
    return []
  }
}

function saveRelayCache(data) {
  try {
    if (Array.isArray(data) && data.length) {
      localStorage.setItem(RELAY_CACHE_STORAGE_KEY, JSON.stringify(data))
    }
  } catch (error) {
    console.warn('[App] Failed to persist relay cache:', error)
  }
}

function clearRelayCache() {
  try {
    localStorage.removeItem(RELAY_CACHE_STORAGE_KEY)
    relayCacheHydrated = false
  } catch (error) {
    console.warn('[App] Failed to clear relay cache:', error)
  }
}

function renderRelayListContent(relayData = [], { showEmpty = true } = {}) {
  if (!relayList) return

  if (!Array.isArray(relayData) || relayData.length === 0) {
    if (showEmpty) {
      relayList.innerHTML = '<p style="color: var(--text-secondary); font-size: 12px;">No active relays</p>'
    }
    return
  }

  relayList.innerHTML = ''

  relayData.forEach((relay) => {
    if (window.App && window.App.nostr && relay.relayKey && relay.publicIdentifier) {
      window.App.nostr.registerRelayMapping(relay.relayKey, relay.publicIdentifier)
    }
    const relayElement = document.createElement('div')
    relayElement.className = 'relay-item'

    const displayKey = relay.publicIdentifier || relay.relayKey || 'unknown'
    const truncatedKey = displayKey.length > 30 ? `${displayKey.substring(0, 30)}...` : displayKey

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
    `

    const disconnectBtn = relayElement.querySelector('.disconnect-btn')
    disconnectBtn.addEventListener('click', () =>
      disconnectRelay(relay.publicIdentifier || relay.relayKey)
    )

    relayList.appendChild(relayElement)
  })
}

function hydrateRelayListFromCache() {
  if (relayCacheHydrated) return
  const cachedRelays = loadRelayCache()
  if (Array.isArray(cachedRelays) && cachedRelays.length) {
    relays = cachedRelays
    renderRelayListContent(cachedRelays, { showEmpty: false })
    relayCacheHydrated = true
  }
}

// Update relay list
function updateRelayList(relayData) {
  if (!relayList) return;
  
  relays = relayData || [];
  
  if (relays.length) {
    saveRelayCache(relays)
  }

  const shouldShowEmpty = relayInitializationComplete && relays.length === 0
  renderRelayListContent(relays, { showEmpty: shouldShowEmpty })
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
      await sendWorkerCommand({
        type: 'disconnect-relay',
        data: {
          relayKey: identifier,
          identifier
        }
      }, {
        requirePfpDrive: false,
        autoStart: false,
        description: 'disconnect relay'
      })

      addLog(`Disconnect request sent for ${displayName}`, 'status');
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
    const fileSharing = true
    await sendWorkerCommand({
      type: 'create-relay',
      data: { name, description, fileSharing }
    }, {
      requirePfpDrive: false,
      autoStart: false,
      description: 'create relay'
    })
    
    // Clear inputs
    nameInput.value = ''
    descriptionInput.value = ''
    
  } catch (error) {
    addLog(`Failed to create relay: ${error.message}`, 'error')
  }
}

// Create a relay instance with provided parameters and return relay key
async function createRelayInstance(name, description, isPublic, isOpen, fileSharing = true) {
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

    sendWorkerCommand({
      type: 'create-relay',
      data: { name, description, isPublic, isOpen, fileSharing }
    }, {
      requirePfpDrive: false,
      autoStart: false,
      description: 'create relay (instance)'
    }).catch((error) => {
      addLog(`Failed to send create-relay command: ${error.message}`, 'error')
      reject(error)
    })
  })
}

// Join a relay instance via the worker-driven authentication flow
async function joinRelayInstance(publicIdentifier, fileSharing = true) {
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
  let hostPeers = []
  try {
    if (window.App?.getRelayPeerSet) {
      hostPeers = Array.from(window.App.getRelayPeerSet(publicIdentifier) || [])
    }
  } catch (err) {
    addLog(`Failed to resolve relay host peers: ${err.message}`, 'warn')
  }

  sendWorkerCommand({
    type: 'start-join-flow',
    data: { publicIdentifier, fileSharing, hostPeers }
  }, {
    requirePfpDrive: false,
    autoStart: false,
    description: 'start join flow'
  }).catch((error) => {
    addLog(`Failed to start join flow: ${error.message}`, 'error');
    relayJoinResolvers.delete(publicIdentifier);
    reject(error);
  })
  });
}

// Join a relay using data from an invite event
async function joinRelayFromInvite(relayKey, name = '', description = '', publicIdentifier = '', authToken = '', fileSharing = true) {
  return new Promise((resolve, reject) => {
    if (!workerActive || !isElectron) {
      addLog('Worker not running', 'error');
      return reject(new Error('Worker not running'));
    }

    try {
      sendWorkerCommand({
        type: 'join-relay',
        data: { relayKey, name, description, publicIdentifier, authToken, fileSharing }
      }, {
        requirePfpDrive: false,
        autoStart: false,
        description: 'join relay from invite'
      })
        .then(() => resolve())
        .catch((error) => {
          addLog(`Failed to join relay from invite: ${error.message}`, 'error');
          reject(error);
        })
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
    const fileSharing = true
    await sendWorkerCommand({
      type: 'join-relay',
      data: { relayKey, name, description, fileSharing }
    }, {
      requirePfpDrive: false,
      autoStart: false,
      description: 'join relay'
    })
    
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

  if (publicGatewayEnableToggle) {
    publicGatewayEnableToggle.addEventListener('change', () => {
      publicGatewayConfig.enabled = !!publicGatewayEnableToggle.checked
      updatePublicGatewayFormState()
    })
  }

  if (publicGatewaySelectionSelect) {
    publicGatewaySelectionSelect.addEventListener('change', handlePublicGatewaySelectionChange)
  }

  if (publicGatewaySaveButton) {
    publicGatewaySaveButton.addEventListener('click', handlePublicGatewaySave)
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
  publicGatewayEnableToggle = document.getElementById('public-gateway-enable')
  publicGatewaySelectionSelect = document.getElementById('public-gateway-selection')
  publicGatewayUrlInput = document.getElementById('public-gateway-url')
  publicGatewaySecretInput = document.getElementById('public-gateway-secret')
  publicGatewaySaveButton = document.getElementById('public-gateway-save')
  publicGatewayDefaultTtlInput = document.getElementById('public-gateway-token-ttl')
  publicGatewayManualFields = document.getElementById('public-gateway-manual-fields')
  publicGatewaySelectionHelp = document.getElementById('public-gateway-selection-help')
  publicGatewaySelectionMeta = document.getElementById('public-gateway-selection-meta')
  
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
    publicGatewayEnableToggle,
    publicGatewaySelectionSelect,
    publicGatewayUrlInput,
    publicGatewaySecretInput,
    publicGatewaySaveButton,
    publicGatewayDefaultTtlInput,
    publicGatewayManualFields,
    publicGatewaySelectionHelp,
    publicGatewaySelectionMeta
  }
  
  console.log('[App] Element initialization results:');
  for (const [name, element] of Object.entries(elements)) {
    console.log(`- ${name}:`, element ? 'found' : 'NOT FOUND');
  }

  hydrateRelayListFromCache()

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
    sendWorkerCommand({ type: 'shutdown' }, {
      requireInitialized: false,
      requirePfpDrive: false,
      autoStart: false,
      description: 'shutdown before unload',
      maxAttempts: 1
    }).finally(() => {
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
window.refreshPublicGatewayRelay = refreshPublicGatewayRelay;
window.requestPublicGatewayToken = requestPublicGatewayToken;
window.copyTextToClipboard = copyTextToClipboard;
window.getPublicGatewaySummary = buildPublicGatewaySummary;
window.formatRelayGatewayStats = formatRelayGatewayStats;

console.log('[App] app.js loading completed at:', new Date().toISOString());
