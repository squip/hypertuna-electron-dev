#!/usr/bin/env node
// ./hypertuna-worker/index.js
//
// Enhanced worker with Hyperswarm support instead of hypertele
/** @typedef {import('pear-interface')} */ 
import process from 'node:process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import b4a from 'b4a'
import {
  getAllRelayProfiles,
  getRelayProfileByKey,
  saveRelayProfile,
  removeRelayAuth, // <-- NEW IMPORT
  updateRelayMembers, // This is likely not used directly anymore for member_adds/removes
  updateRelayAuthToken, // <-- NEW IMPORT
  updateRelayMemberSets,
  calculateMembers,
  calculateAuthorizedUsers
} from './hypertuna-relay-profile-manager-bare.mjs'
import { loadRelayKeyMappings, activeRelays } from './hypertuna-relay-manager-adapter.mjs'
import {
  queuePendingAuthUpdate,
  applyPendingAuthUpdates
} from './pending-auth.mjs';
import {
  initializeHyperdrive,
  ensureRelayFolder,
  storeFile,
  getFile,
  fileExists,
  fetchFileFromDrive,
  watchDrive,
  getReplicationHealth
} from './hyperdrive-manager.mjs';
import { ensureMirrorsForProviders, stopAllMirrors } from './mirror-sync-manager.mjs';
import { NostrUtils } from './nostr-utils.js';
import { getRelayKeyFromPublicIdentifier } from './relay-lookup-utils.mjs';
import { loadGatewaySettings, getCachedGatewaySettings } from '../shared/config/GatewaySettings.mjs';

const pearRuntime = globalThis?.Pear
const __dirname = process.env.APP_DIR || pearRuntime?.config?.dir || process.cwd()
const defaultStorageDir = process.env.STORAGE_DIR || pearRuntime?.config?.storage || join(process.cwd(), 'data')

global.userConfig = global.userConfig || { storage: defaultStorageDir }

function getGatewayWebsocketProtocol(config) {
  return config?.proxy_websocket_protocol === 'ws' ? 'ws' : 'wss'
}

function buildGatewayWebsocketBase(config) {
  const protocol = getGatewayWebsocketProtocol(config)
  const host = config?.proxy_server_address || 'localhost'
  return `${protocol}://${host}`
}

// Variable to store the relay server module
let relayServer = null
let isShuttingDown = false
// Map of relayKey -> members array
const relayMembers = new Map()
const relayMemberAdds = new Map()
const relayMemberRemoves = new Map()
const seenFileHashes = new Map()
let config = null
let configPath = null
let healthLogPath = null
let healthIntervalHandle = null

// Store configuration received from the parent process
let configReceived = false
let storedParentConfig = null

async function appendFilekeyDbEntry (relayKey, fileHash) {
  if (!config?.driveKey || !config?.nostr_pubkey_hex) {
    console.warn(`[Worker] appendFilekeyDbEntry skipped: missing driveKey or nostr_pubkey_hex (driveKey=${!!config?.driveKey}, pub=${!!config?.nostr_pubkey_hex})`)
    return
  }
  const relayManager = activeRelays.get(relayKey)
  if (!relayManager?.relay) {
    console.warn(`[Worker] appendFilekeyDbEntry skipped: no active relay manager for key=${relayKey}`)
    return
  }

  const fileKey = `filekey:${fileHash}:drivekey:${config.driveKey}:pubkey:${config.nostr_pubkey_hex}`
  const fileKeyValue = {
    filekey: fileHash,
    drivekey: config.driveKey,
    pubkey: config.nostr_pubkey_hex
  }

  try {
    await relayManager.relay.put(
      b4a.from(fileKey, 'utf8'),
      b4a.from(JSON.stringify(fileKeyValue), 'utf8')
    )
    // Ensure the view applies this operation before any immediate queries
    try {
      await relayManager.relay.update()
      const v = relayManager?.relay?.view?.version
      console.log(`[Index] put applied (viewVersion=${v}) key=${fileKey} value=${JSON.stringify(fileKeyValue)}`)
    } catch (e) {
      console.warn('[Index] relay.update after put failed:', e?.message || e)
    }
    console.log(`[Worker] Stored filekey index for ${fileHash} on relay ${relayKey}`)
  } catch (err) {
    console.error('[Worker] Failed to store filekey index:', err)
  }
}

async function publishFilekeyEvent (relayKey, fileHash) {
  if (!config?.nostr_pubkey_hex || !config?.nostr_nsec_hex || !config?.driveKey) return
  const relayManager = activeRelays.get(relayKey)
  try {
    await appendFilekeyDbEntry(relayKey, fileHash)
    console.log(`[Worker] Published filekey event for ${fileHash} on relay ${relayKey}`)
  } catch (err) {
    console.error('[Worker] Failed to publish filekey event:', err)
  }
}

async function publishFileDeletionEvent (relayKey, fileHash) {
  if (!config?.driveKey || !config?.nostr_pubkey_hex) return
  const relayManager = activeRelays.get(relayKey)
  if (!relayManager?.relay) return

  const fileKey = `filekey:${fileHash}:drivekey:${config.driveKey}:pubkey:${config.nostr_pubkey_hex}`
  try {
    await relayManager.relay.del(b4a.from(fileKey, 'utf8'))
    try { await relayManager.relay.update() } catch (_) {}
    console.log(`[Worker] Deleted filekey index for ${fileHash} on relay ${relayKey}`)
  } catch (err) {
    console.error('[Worker] Failed to delete filekey index:', err)
  }
}


function isHex64 (s) { return typeof s === 'string' && /^[a-fA-F0-9]{64}$/.test(s) }

function startDriveWatcher () {
  watchDrive(async ({ type, path }) => {
    console.log(`[DriveWatch] change type=${type} path=${path}`)
    const parts = path.split('/').filter(Boolean)
    if (parts.length !== 2) return
    const [identifier, fileHash] = parts
    let relayKey = identifier
    try {
      if (!isHex64(identifier) && identifier.includes(':')) {
        const mapped = await getRelayKeyFromPublicIdentifier(identifier)
        if (mapped) relayKey = mapped
        else console.warn(`[Worker] watchDrive: could not resolve relayKey for identifier ${identifier}`)
      }
    } catch (_) {}
    if (type === 'add') await publishFilekeyEvent(relayKey, fileHash)
    else if (type === 'del') await publishFileDeletionEvent(relayKey, fileHash)
  })
}


function getUserKey(config) {
    // If storage path contains /users/, extract the key
    if (config.storage && config.storage.includes('/users/')) {
      const match = config.storage.match(/\/users\/([a-f0-9]{64})/);
      if (match) {
        return match[1];
      }
    }
    
    // Otherwise, generate from nostr_nsec_hex
    if (config.nostr_nsec_hex) {
      return crypto.createHash('sha256')
        .update(config.nostr_nsec_hex)
        .digest('hex');
    }
    
    throw new Error('Unable to determine user key from config');
  }
  
// Load or create configuration
async function loadOrCreateConfig(customDir = null) {
  const configDir = customDir || defaultStorageDir
  await fs.mkdir(configDir, { recursive: true })

  configPath = join(configDir, 'relay-config.json')

  const gatewaySettings = await loadGatewaySettings()
  const cachedGatewaySettings = getCachedGatewaySettings()
  const defaultGatewayUrl = gatewaySettings.gatewayUrl || cachedGatewaySettings.gatewayUrl
  const defaultProxyHost = gatewaySettings.proxyHost || cachedGatewaySettings.proxyHost

  const defaultConfig = {
    port: 1945,
    gatewayUrl: defaultGatewayUrl,
    proxy_server_address: defaultProxyHost,
    proxy_websocket_protocol: gatewaySettings.proxyWebsocketProtocol || cachedGatewaySettings.proxyWebsocketProtocol,
    registerWithGateway: true,
    registerInterval: 300000,
    relays: [],
    driveKey: null
  }

  try {
    const configData = await fs.readFile(configPath, 'utf8')
    console.log('[Worker] Loaded existing config from:', configPath)
    const loadedConfig = JSON.parse(configData)
    if (!('driveKey' in loadedConfig)) {
      loadedConfig.driveKey = null
      await fs.writeFile(configPath, JSON.stringify(loadedConfig, null, 2))
    }
    if (!('proxy_websocket_protocol' in loadedConfig) || !loadedConfig.proxy_websocket_protocol) {
      loadedConfig.proxy_websocket_protocol = defaultConfig.proxy_websocket_protocol
      await fs.writeFile(configPath, JSON.stringify(loadedConfig, null, 2))
    }
    return { ...defaultConfig, ...loadedConfig }
  } catch (err) {
    console.log('[Worker] Creating new config at:', configPath)
    defaultConfig.storage = configDir
    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2))
    return defaultConfig
  }
}

// Load member lists from saved relay profiles
async function loadRelayMembers() {
  try {
    const profiles = await getAllRelayProfiles(global.userConfig?.userKey)
    for (const profile of profiles) {
      if (profile.relay_key) {
        const members = calculateMembers(profile.member_adds || [], profile.member_removes || [])
        relayMembers.set(profile.relay_key, members)
        relayMemberAdds.set(profile.relay_key, profile.member_adds || [])
        relayMemberRemoves.set(profile.relay_key, profile.member_removes || [])
        if (profile.public_identifier) {
          relayMembers.set(profile.public_identifier, members)
          relayMemberAdds.set(profile.public_identifier, profile.member_adds || [])
          relayMemberRemoves.set(profile.public_identifier, profile.member_removes || [])
        }
      }
    }
    console.log(`[Worker] Loaded members for ${relayMembers.size} relays`)
  } catch (err) {
    console.error('[Worker] Failed to load relay members:', err)
  }
}

// Handle worker communication
let workerPipe = null
if (pearRuntime?.worker?.pipe) {
  workerPipe = pearRuntime.worker.pipe()
}

console.log('[Worker] IPC channel:', workerPipe ? 'pear-pipe' : (typeof process.send === 'function' ? 'node-ipc' : 'none'))

// Helper function to send messages with newline delimiter (Pear) or Node IPC events
const sendMessage = (message) => {
  if (isShuttingDown) return

  if (workerPipe) {
    const messageStr = JSON.stringify(message) + '\n'
    console.log('[Worker] Sending message:', messageStr.trim())
    try {
      workerPipe.write(messageStr)
    } catch (err) {
      console.error('[Worker] Error writing to pear pipe:', err)
    }
    return
  }

  if (typeof process.send === 'function') {
    try {
      process.send(message)
    } catch (err) {
      console.error('[Worker] Error sending IPC message:', err)
    }
    return
  }

  try {
    console.log('[Worker] IPC unavailable, message:', JSON.stringify(message))
  } catch (_) {
    console.log('[Worker] IPC unavailable, message sent but not serialized')
  }
}

const configWaiters = []

function notifyConfigWaiters(configData) {
  if (!configWaiters.length) return
  const waiters = configWaiters.splice(0, configWaiters.length)
  for (const waiter of waiters) {
    try {
      waiter(configData)
    } catch (err) {
      console.error('[Worker] Config waiter error:', err)
    }
  }
}

function waitForParentConfig(timeoutMs = 3000) {
  if (configReceived) return Promise.resolve(storedParentConfig)
  return new Promise((resolve) => {
    let settled = false
    const resolver = (configData) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const index = configWaiters.indexOf(resolver)
      if (index !== -1) configWaiters.splice(index, 1)
      resolve(configData)
    }

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      const index = configWaiters.indexOf(resolver)
      if (index !== -1) configWaiters.splice(index, 1)
      console.log('[Worker] Config wait timeout - proceeding with defaults')
      resolve(null)
    }, timeoutMs)

    configWaiters.push(resolver)
  })
}

async function logToFile (filepath, line) {
  try {
    await fs.mkdir(barePathDirname(filepath), { recursive: true }).catch(() => {})
  } catch (_) {}
  try {
    await fs.appendFile(filepath, line + '\n')
  } catch (err) {
    console.error('[Worker] Failed to append health log:', err)
  }
}

function barePathDirname (p) {
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  return '/' + parts.join('/')
}

function addMembersToRelays(relays) {
  return relays.map(r => ({
    ...r,
    members: relayMembers.get(r.relayKey) || []
  }))
}

async function addAuthInfoToRelays(relays) {
  try {
    const profiles = await getAllRelayProfiles(global.userConfig?.userKey)
    return relays.map(r => {
      const profile = profiles.find(p => p.relay_key === r.relayKey) || {}

      let token = null
      if (profile.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
        // Calculate authorized users from auth_adds and auth_removes
        // const { calculateAuthorizedUsers } = require('./hypertuna-relay-profile-manager-bare.mjs')
        const authorizedUsers = calculateAuthorizedUsers(
          profile.auth_config.auth_adds || [],
          profile.auth_config.auth_removes || []
        )
        
        const userAuth = authorizedUsers.find(
          u => u.pubkey === config.nostr_pubkey_hex
        )
        token = userAuth?.token || null
        
        if (!token && profile.auth_tokens && profile.auth_tokens[config.nostr_pubkey_hex]) {
          // Fallback to legacy auth_tokens if present
          token = profile.auth_tokens[config.nostr_pubkey_hex]
        }
        
        if (token) {
          console.log(`[Worker] Found auth token for user on relay ${r.relayKey}`)
        } else {
          console.log(`[Worker] No auth token found for user on relay ${r.relayKey}`)
        }
      }

      const identifierPath = profile.public_identifier
        ? profile.public_identifier.replace(':', '/')
        : r.relayKey

      const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`
      const connectionUrl = token ? `${baseUrl}?token=${token}` : baseUrl

      return {
        ...r,
        publicIdentifier: profile.public_identifier || null,
        connectionUrl,
        userAuthToken: token,
        requiresAuth: profile.auth_config?.requiresAuth || false
      }
    })
  } catch (err) {
    console.error('[Worker] Failed to add auth info to relays:', err)
    return relays
  }
}

async function reconcileRelayFiles() {
  for (const [relayKey, manager] of activeRelays.entries()) {
    let fileMap
    try {
      fileMap = await manager.relay.queryFilekeyIndex()
    } catch (err) {
      console.error(`[Worker] Failed to query filekey index for ${relayKey}:`, err)
      continue
    }

    // Debug sample of filekey index
    try {
      const sample = []
      for (const [fh, dm] of fileMap.entries()) {
        sample.push({ fileHash: fh, drives: Array.from(dm.keys()) })
        if (sample.length >= 5) break
      }
      console.log(`[Reconcile] relay ${relayKey}: filekey sample ${JSON.stringify(sample)}`)
    } catch (_) {}

    const seen = seenFileHashes.get(relayKey) || new Set()
    // Prefer publicIdentifier path if available for this relay
    let identifier = relayKey
    try {
      const profile = await getRelayProfileByKey(relayKey)
      if (profile?.public_identifier) identifier = profile.public_identifier
    } catch (_) {}

    for (const [fileHash, driveMap] of fileMap.entries()) {
      if (seen.has(fileHash)) continue

      let exists = null
      try {
        exists = await getFile(identifier, fileHash)
      } catch (err) {
        console.error(`[Worker] Error checking file ${fileHash} for relay ${relayKey}:`, err)
      }

      if (exists) {
        console.log(`[Worker] Deduped file ${fileHash} for relay ${relayKey}`)
        seen.add(fileHash)
        continue
      }

      let stored = false
      for (const [driveKey] of driveMap.entries()) {
        console.log(`[Reconcile] attempt fetch file=${fileHash} from drive=${driveKey} folder=/${identifier}`)
        for (let attempt = 0; attempt < 3 && !stored; attempt++) {
          try {
            const data = await fetchFileFromDrive(driveKey, identifier, fileHash)
            if (!data) throw new Error('File not found')
            await storeFile(identifier, fileHash, data, { sourceDrive: driveKey })
            stored = true
            break
          } catch (err) {
            console.error(`[Worker] Failed to download ${fileHash} from ${driveKey} (attempt ${attempt + 1}):`, err)
          }
        }
        if (stored) break
      }

      if (stored) {
        console.log(`[Worker] Stored file ${fileHash} for relay ${relayKey}`)
        seen.add(fileHash)
      } else {
        console.warn(`[Worker] Unable to retrieve file ${fileHash} for relay ${relayKey}`)
      }
    }

    seenFileHashes.set(relayKey, seen)
  }
}

async function ensureMirrorsForAllRelays() {
  const total = activeRelays.size
  console.log(`[Mirror] scanning active relays: ${total}`)
  for (const [relayKey, manager] of activeRelays.entries()) {
    console.log(`[Mirror] relay ${relayKey}: collecting providers from filekey index`)
    // Collect all provider drive keys for this relay from the filekey index
    let fileMap
    try {
      fileMap = await manager.relay.queryFilekeyIndex()
    } catch (err) {
      console.error(`[Worker] Mirror: Failed to query filekey index for ${relayKey}:`, err)
      continue
    }

    console.log(`[Mirror] relay ${relayKey}: filekey index size=${fileMap.size}`)
    const providers = new Set()
    for (const [_fileHash, driveMap] of fileMap.entries()) {
      for (const [driveKey] of driveMap.entries()) providers.add(driveKey)
    }
    console.log(`[Mirror] relay ${relayKey}: providers=${providers.size}`)
    try {
      console.log(`[Mirror] relay ${relayKey}: providers list ${JSON.stringify(Array.from(providers))}`)
      const sample = []
      for (const [fh, dm] of fileMap.entries()) {
        sample.push({ fileHash: fh, drives: Array.from(dm.keys()) })
        if (sample.length >= 5) break
      }
      console.log(`[Mirror] relay ${relayKey}: filekey sample ${JSON.stringify(sample)}`)
    } catch (_) {}

    // Determine identifier path (prefer public identifier)
    let identifier = relayKey
    try {
      const profile = await getRelayProfileByKey(relayKey)
      if (profile?.public_identifier) identifier = profile.public_identifier
    } catch (_) {}

    // If no providers indexed, try to backfill from local files, then re-evaluate
    if (providers.size === 0) {
      try { await backfillRelayFilekeyIndex(relayKey, identifier) } catch (e) { console.warn('[Mirror] backfill failed:', e) }
      try {
        const fm2 = await manager.relay.queryFilekeyIndex()
        console.log(`[Mirror] relay ${relayKey}: re-check filekey index size=${fm2.size}`)
        for (const [_fh, dm] of fm2.entries()) {
          for (const [driveKey] of dm.entries()) providers.add(driveKey)
        }
        console.log(`[Mirror] relay ${relayKey}: providers after backfill=${providers.size}`)
        const sample2 = []
        for (const [fh2, dm2] of fm2.entries()) {
          sample2.push({ fileHash: fh2, drives: Array.from(dm2.keys()) })
          if (sample2.length >= 5) break
        }
        console.log(`[Mirror] relay ${relayKey}: filekey sample after backfill ${JSON.stringify(sample2)}`)
      } catch (e) {
        console.warn('[Mirror] re-check providers failed:', e)
      }
    }
    await ensureMirrorsForProviders(providers, identifier)
  }
}

async function backfillRelayFilekeyIndex(relayKey, identifier) {
  if (!config?.driveKey) return
  const pathPrefix = `/${identifier}`
  const { getCorestore } = await import('./hyperdrive-manager.mjs')
  const { default: Hyperdrive } = await import('hyperdrive')
  const store = getCorestore()
  if (!store) return
  // Use the existing local drive from hyperdrive-manager via module cache
  const { getLocalDrive } = await import('./hyperdrive-manager.mjs')
  const localDrive = getLocalDrive()
  if (!localDrive) return

  let count = 0
  for await (const entry of localDrive.list(pathPrefix, { recursive: false })) {
    if (!entry?.value?.blob) continue
    const fileHash = entry.key.split('/').pop()
    console.log(`[Backfill] local entry key=${entry.key} hash=${fileHash}`)
    try {
      await appendFilekeyDbEntry(relayKey, fileHash)
      count++
    } catch (_) {}
  }
  console.log(`[Mirror] backfill for ${relayKey} (${identifier}) added ${count} index entries`)
}

async function collectRelayHealth(relayKey, manager, maxChecks = 200) {
  // filekey index map: Map<fileHash, Map<driveKey,pubkey>>
  let fileMap
  try {
    fileMap = await manager.relay.queryFilekeyIndex()
  } catch (err) {
    console.error(`[Worker] Health: queryFilekeyIndex failed for ${relayKey}:`, err)
    return {
      relayKey,
      error: 'queryFilekeyIndex failed',
      timestamp: Date.now()
    }
  }

  const totalFiles = fileMap.size
  let minProviders = Number.POSITIVE_INFINITY
  let maxProviders = 0
  let providerSum = 0

  // Build a deterministic sample set (first N keys)
  const hashes = Array.from(fileMap.keys())
  const sample = hashes.slice(0, Math.max(0, Math.min(maxChecks, hashes.length)))
  let presentLocal = 0

  for (const h of hashes) {
    const providers = fileMap.get(h) || new Map()
    const count = providers.size
    minProviders = Math.min(minProviders, count)
    maxProviders = Math.max(maxProviders, count)
    providerSum += count
  }
  if (!isFinite(minProviders)) minProviders = 0
  const avgProviders = totalFiles > 0 ? providerSum / totalFiles : 0

  for (const h of sample) {
    try {
      // Prefer public identifier for file path resolution
      let identifier = relayKey
      try {
        const profile = await getRelayProfileByKey(relayKey)
        if (profile?.public_identifier) identifier = profile.public_identifier
      } catch (_) {}
      if (await fileExists(identifier, h)) presentLocal++
    } catch (_) {}
  }

  const health = getReplicationHealth()

  const viewVersion = manager?.relay?.view?.version || null

  return {
    relayKey,
    timestamp: Date.now(),
    totals: {
      filesIndexed: totalFiles,
      sampleChecked: sample.length,
      samplePresentLocal: presentLocal
    },
    providers: {
      min: minProviders,
      avg: Number.isFinite(avgProviders) ? Number(avgProviders.toFixed(2)) : 0,
      max: maxProviders
    },
    drive: {
      driveKey: health.driveKey,
      discoveryKey: health.discoveryKey
    },
    swarm: {
      openConnections: health.openConnections,
      totalConnections: health.totalConnections,
      topicsJoined: health.topicsJoined
    },
    relayView: {
      version: viewVersion
    }
  }
}

async function logReplicationHealthOnce() {
  if (!config || !healthLogPath) return
  const entries = []
  for (const [relayKey, manager] of activeRelays.entries()) {
    try {
      const entry = await collectRelayHealth(relayKey, manager)
      entries.push(entry)
    } catch (err) {
      entries.push({ relayKey, timestamp: Date.now(), error: err.message })
    }
  }
  const line = JSON.stringify({ type: 'replication-health', at: Date.now(), entries })
  await logToFile(healthLogPath, line)
}

function startHealthLogger(intervalMs = 60000) {
  if (!config) return
  if (!healthLogPath) {
    const baseDir = config.storage || '.'
    healthLogPath = join(baseDir, 'hyperdrive-replication-health.log')
  }
  if (healthIntervalHandle) clearInterval(healthIntervalHandle)
  // Stagger slightly from reconcile to spread IO
  healthIntervalHandle = setInterval(() => {
    if (!isShuttingDown) {
      logReplicationHealthOnce().catch(err => console.error('[Worker] Health log error:', err))
    }
  }, intervalMs)
}

// Make pipe and sendMessage globally available for the relay server
global.workerPipe = workerPipe
global.sendMessage = sendMessage

async function handleMessageObject(message) {
  if (message == null) return

  if (typeof message === 'string') {
    try {
      message = JSON.parse(message)
    } catch (err) {
      console.error('[Worker] Failed to parse string message:', err)
      return
    }
  }

  if (Buffer.isBuffer(message)) {
    try {
      const parsed = JSON.parse(message.toString())
      message = parsed
    } catch (err) {
      console.error('[Worker] Failed to parse buffer message:', err)
      return
    }
  }

  if (typeof message !== 'object') {
    console.warn('[Worker] Ignoring non-object message:', message)
    return
  }

  console.log('[Worker] Received from parent:', message)

  if (message.type === 'config') {
    storedParentConfig = message.data
    if (!configReceived) {
      configReceived = true
      console.log('[Worker] Stored parent config:', storedParentConfig)
      notifyConfigWaiters(message.data)
      return
    }
  }

  switch (message.type) {
    case 'get-replication-health': {
      try {
        const entries = []
        for (const [relayKey, manager] of activeRelays.entries()) {
          entries.push(await collectRelayHealth(relayKey, manager, message.maxChecks || 200))
        }
        sendMessage({ type: 'replication-health', data: { entries, logPath: healthLogPath } })
      } catch (err) {
        sendMessage({ type: 'error', message: `get-replication-health failed: ${err.message}` })
      }
      break
    }

    case 'set-replication-health-interval': {
      const ms = Math.max(5000, Number(message.intervalMs) || 60000)
      startHealthLogger(ms)
      sendMessage({ type: 'replication-health-interval-set', intervalMs: ms, logPath: healthLogPath })
      break
    }

    case 'upload-file': {
      try {
        const { relayKey, identifier: idFromMsg, publicIdentifier, fileHash, metadata, buffer } = message.data || {}
        const identifier = idFromMsg || publicIdentifier || relayKey
        if (!identifier || !fileHash || !buffer) throw new Error('Missing identifier/publicIdentifier, fileHash, or buffer')
        console.log(`[Upload] begin relayKey=${relayKey} identifier=${identifier} fileHash=${fileHash} metaKeys=${metadata ? Object.keys(metadata) : 'none'} bufLen=${buffer?.length}`)
        const data = b4a.from(buffer, 'base64')
        await ensureRelayFolder(identifier)
        await storeFile(identifier, fileHash, data, metadata || null)
        let resolvedRelayKey = relayKey
        if (!resolvedRelayKey && identifier && !/^[a-fA-F0-9]{64}$/.test(identifier)) {
          try { resolvedRelayKey = await getRelayKeyFromPublicIdentifier(identifier) } catch (_) {}
        }
        if (resolvedRelayKey) {
          await appendFilekeyDbEntry(resolvedRelayKey, fileHash)
          ensureMirrorsForAllRelays().catch(err => console.warn('[Mirror] ensure after upload failed:', err))
        } else {
          console.warn('[Worker] upload-file: could not resolve relayKey for identifier', identifier)
        }
        console.log(`[Upload] complete relayKey=${resolvedRelayKey || relayKey} identifier=${identifier} fileHash=${fileHash}`)
        sendMessage({ type: 'upload-file-complete', relayKey: resolvedRelayKey || null, identifier, fileHash })
      } catch (err) {
        console.error('[Worker] upload-file error:', err)
        sendMessage({ type: 'error', message: `upload-file failed: ${err.message}` })
      }
      break
    }

    case 'shutdown':
      console.log('[Worker] Shutdown requested')
      isShuttingDown = true
      sendMessage({
        type: 'status',
        message: 'Shutting down...'
      })
      await cleanup()
      process.exit(0)
      break

    case 'config':
      console.log('[Worker] Received configuration:', message.data)
      break

    case 'create-relay':
      console.log('[Worker] Create relay requested:', message.data)
      if (relayServer) {
        try {
          const result = await relayServer.createRelay(message.data)
          relayMembers.set(result.relayKey, result.profile?.members || [])
          await ensureRelayFolder(result.profile?.public_identifier || result.relayKey)
          await applyPendingAuthUpdates(updateRelayAuthToken, result.relayKey, result.profile?.public_identifier)

          sendMessage({
            type: 'relay-created',
            data: {
              ...result,
              members: relayMembers.get(result.relayKey) || []
            }
          })

          const relays = await relayServer.getActiveRelays()
          const relaysAuth = await addAuthInfoToRelays(relays)
          sendMessage({
            type: 'relay-update',
            relays: addMembersToRelays(relaysAuth)
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to create relay: ${err.message}`
          })
        }
      } else {
        sendMessage({
          type: 'error',
          message: 'Relay server not initialized'
        })
      }
      break

    case 'join-relay':
      console.log('[Worker] Join relay requested:', message.data)
      if (relayServer) {
        try {
          const result = await relayServer.joinRelay(message.data)
          relayMembers.set(result.relayKey, result.profile?.members || [])
          await ensureRelayFolder(result.profile?.public_identifier || result.relayKey)
          await applyPendingAuthUpdates(updateRelayAuthToken, result.relayKey, result.profile?.public_identifier)

          sendMessage({
            type: 'relay-joined',
            data: {
              ...result,
              members: relayMembers.get(result.relayKey) || []
            }
          })

          const relays = await relayServer.getActiveRelays()
          const relaysAuth = await addAuthInfoToRelays(relays)
          sendMessage({
            type: 'relay-update',
            relays: addMembersToRelays(relaysAuth)
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to join relay: ${err.message}`
          })
        }
      } else {
        sendMessage({
          type: 'error',
          message: 'Relay server not initialized'
        })
      }
      break

    case 'disconnect-relay':
      console.log('[Worker] Disconnect relay requested:', message.data)
      if (relayServer) {
        try {
          const result = await relayServer.disconnectRelay(message.data.relayKey)

          sendMessage({
            type: 'relay-disconnected',
            data: result
          })

          const relays = await relayServer.getActiveRelays()
          const relaysAuth = await addAuthInfoToRelays(relays)
          sendMessage({
            type: 'relay-update',
            relays: addMembersToRelays(relaysAuth)
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to disconnect relay: ${err.message}`
          })
        }
      }
      break

    case 'start-join-flow':
      console.log('[Worker] Start join flow requested:', message.data)
      if (relayServer) {
        try {
          await relayServer.startJoinAuthentication(message.data)
        } catch (err) {
          sendMessage({
            type: 'join-auth-error',
            data: {
              publicIdentifier: message.data.publicIdentifier,
              error: `Failed to start join flow: ${err.message}`
            }
          })
        }
      } else {
        sendMessage({
          type: 'join-auth-error',
          data: { publicIdentifier: message.data.publicIdentifier, error: 'Relay server not initialized' }
        })
      }
      break

    case 'update-members':
      if (relayServer) {
        try {
          const { relayKey, publicIdentifier, members, member_adds, member_removes } = message.data
          const id = relayKey || publicIdentifier
          let profile
          if (member_adds || member_removes) {
            profile = await updateRelayMemberSets(id, member_adds || [], member_removes || [])
          } else {
            profile = await updateRelayMembers(id, members)
          }
          if (profile) {
            const finalMembers = profile.members || members
            relayMembers.set(profile.relay_key, finalMembers)
            relayMemberAdds.set(profile.relay_key, profile.member_adds || [])
            relayMemberRemoves.set(profile.relay_key, profile.member_removes || [])
            if (profile.public_identifier) {
              relayMembers.set(profile.public_identifier, finalMembers)
              relayMemberAdds.set(profile.public_identifier, profile.member_adds || [])
              relayMemberRemoves.set(profile.public_identifier, profile.member_removes || [])
            }
            sendMessage({ type: 'members-updated', relayKey: profile.relay_key })
          } else {
            sendMessage({ type: 'error', message: 'Relay profile not found' })
          }
        } catch (err) {
          sendMessage({ type: 'error', message: `Failed to update members: ${err.message}` })
        }
      }
      break

    case 'update-auth-data':
      console.log('[Worker] Update auth data requested:', message.data)
      if (relayServer) {
        try {
          const { relayKey, publicIdentifier, pubkey, token } = message.data
          const identifier = relayKey || publicIdentifier
          if (!identifier) {
            throw new Error('No identifier provided for auth data update')
          }
          const updated = await updateRelayAuthToken(identifier, pubkey, token)
          if (!updated) {
            queuePendingAuthUpdate(identifier, pubkey, token)
            console.log(`[Worker] Queued pending auth update for ${identifier}`)
          }
          sendMessage({
            type: 'auth-data-updated',
            identifier: identifier,
            pubkey: pubkey
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to update auth data: ${err.message}`
          })
        }
      }
      break

    case 'get-relays':
      console.log('[Worker] Get relays requested')
      if (relayServer) {
        try {
          const relays = await relayServer.getActiveRelays()
          const relaysAuth = await addAuthInfoToRelays(relays)
          sendMessage({
            type: 'relay-update',
            relays: addMembersToRelays(relaysAuth)
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to get relays: ${err.message}`
          })
        }
      }
      break

    case 'remove-auth-data':
      console.log('[Worker] Remove auth data requested:', message.data)
      if (relayServer) {
        try {
          const { relayKey, publicIdentifier, pubkey } = message.data
          const identifier = relayKey || publicIdentifier
          if (!identifier) {
            throw new Error('No identifier provided for auth data removal')
          }
          await removeRelayAuth(identifier, pubkey)
          const authStore = getRelayAuthStore()
          authStore.removeAuth(identifier, pubkey)

          sendMessage({
            type: 'auth-data-removed',
            identifier: identifier,
            pubkey: pubkey
          })
        } catch (err) {
          sendMessage({
            type: 'error',
            message: `Failed to remove auth data: ${err.message}`
          })
        }
      }
      break

    case 'get-health':
      console.log('[Worker] Get health requested')
      break

    default:
      console.log('[Worker] Unknown message type:', message.type)
  }
}

if (workerPipe) {
  console.log('[Worker] Connected to parent via pipe')
  
  // Test the pipe immediately
  sendMessage({ 
    type: 'status', 
    message: 'Relay worker starting...' 
  })
  
  // Configuration may have been sent before initialization
  
  // Handle messages from parent
  let buffer = ''
  workerPipe.on('data', async (data) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        await handleMessageObject(message)
      } catch (err) {
        console.error('[Worker] Error handling message:', err)
      }
    }
  })
  
  // Handle pipe close
  workerPipe.on('close', () => {
    console.log('[Worker] Pipe closed by parent')
    isShuttingDown = true
    cleanup().then(() => process.exit(0))
  })
  
  // Handle pipe error
  workerPipe.on('error', (err) => {
    console.error('[Worker] Pipe error:', err)
    isShuttingDown = true
  })
} else if (typeof process.on === 'function') {
  console.log('[Worker] Using Node IPC for parent communication')
  process.on('message', async (message) => {
    try {
      await handleMessageObject(message)
    } catch (err) {
      console.error('[Worker] Error handling IPC message:', err)
    }
  })

  process.on('disconnect', () => {
    console.log('[Worker] Parent process disconnected')
    isShuttingDown = true
    cleanup().then(() => process.exit(0))
  })
}

// Setup teardown handler
const handleShutdownSignal = async () => {
  if (isShuttingDown) return
  console.log('[Worker] Teardown initiated')
  isShuttingDown = true
  await cleanup()
  process.exit(0)
}

process.on('SIGTERM', handleShutdownSignal)
process.on('SIGINT', handleShutdownSignal)

if (pearRuntime?.teardown) {
  pearRuntime.teardown(async () => {
    if (isShuttingDown) return
    console.log('[Worker] Pear teardown received')
    isShuttingDown = true
    await cleanup()
  })
}

// Cleanup function
async function cleanup() {
  if (!isShuttingDown) {
    sendMessage({
      type: 'status',
      message: 'Worker shutting down...'
    })
  }

  if (relayServer && relayServer.shutdownRelayServer) {
    console.log('[Worker] Stopping relay server...')
    await relayServer.shutdownRelayServer()
  }

  // Stop all mirror watchers
  try { await stopAllMirrors() } catch (_) {}
  
  if (workerPipe) {
    try { workerPipe.end() } catch (err) { console.warn('[Worker] Failed to close pipe cleanly:', err?.message || err) }
  } else if (typeof process.disconnect === 'function' && process.connected) {
    try { process.disconnect() } catch (err) { console.warn('[Worker] Failed to disconnect IPC:', err?.message || err) }
  }
}

// Main function to start the relay server
async function main() {
    try {
      console.log('[Worker] Hypertuna Relay Worker starting...')
      
      // Load or create configuration
      config = await loadOrCreateConfig()
      
      // Wait for config from parent if available
      let parentConfig = storedParentConfig
      if (!parentConfig && (workerPipe || typeof process.send === 'function')) {
        console.log('[Worker] Waiting for parent config...')
        parentConfig = await waitForParentConfig()
      } else if (parentConfig) {
        console.log('[Worker] Using previously received parent config')
      }

      if (parentConfig) {
        storedParentConfig = parentConfig;
        configReceived = true;
        // Get user key from parent config
        const userKey = getUserKey(parentConfig);
        console.log('[Worker] User key:', userKey);
        
        // Create user-specific storage path in worker's directory
        const workerBaseStorage = defaultStorageDir;
        const userSpecificStorage = join(workerBaseStorage, 'users', userKey);
        
        // Ensure user directory exists
        await fs.mkdir(userSpecificStorage, { recursive: true });
        
        // Merge parent config with loaded config
        config = {
          ...config,
          ...parentConfig,
          storage: userSpecificStorage,  // Use user-specific path in worker's storage
          userKey: userKey  // Store for reference
        };
        
        console.log('[Worker] Merged config with user-specific storage:', {
          ...config,
          storage: config.storage,
          userKey: config.userKey
        });

        // Set global user config for profile manager
        global.userConfig = {
            userKey: config.userKey,
            storage: config.storage
        };

        console.log('[Worker] Set global user config for profile operations');

        await loadRelayMembers();
        await loadRelayKeyMappings();
      }

    global.userConfig = global.userConfig || { storage: config.storage };

    const hadDriveKey = !!config.driveKey;
    const hyperdriveConfig = { ...config, storage: global.userConfig.storage };
    await initializeHyperdrive(hyperdriveConfig);
    config.driveKey = hyperdriveConfig.driveKey;
    if (!hadDriveKey && config.driveKey) {
      try {
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      } catch (err) {
        console.error('[Worker] Failed to persist driveKey:', err);
      }
    }

    if (config.driveKey) {
      sendMessage({ type: 'drive-key', driveKey: config.driveKey });
    }

    startDriveWatcher()

    // Start periodic replication health logger
    startHealthLogger(60000)
    // Kick off mirror setup for all known relays/providers
    await ensureMirrorsForAllRelays().catch(err => console.error('[Worker] Mirror setup error:', err))

    sendMessage({
      type: 'status',
      message: 'Loading relay server...',
      config: {
        port: config.port,
        proxy_server_address: config.proxy_server_address,
        gatewayUrl: config.gatewayUrl,
        registerWithGateway: config.registerWithGateway
      }
    })
    
    // Import and initialize the Hyperswarm-based relay server
    try {
      console.log('[Worker] Importing Hyperswarm relay server module...')
      relayServer = await import('./pear-relay-server.mjs')
      
      console.log('[Worker] Initializing relay server...')
      await relayServer.initializeRelayServer(config)
      
      console.log('[Worker] Relay server started successfully with Hyperswarm')
      
      // Send initialization complete message with a small delay to ensure parent is ready
      setTimeout(() => {
        if (isShuttingDown) return
        sendMessage({ 
          type: 'status', 
          message: 'Relay server running with Hyperswarm',
          initialized: true,
          config: {
            port: config.port,
            proxy_server_address: config.proxy_server_address,
            gatewayUrl: config.gatewayUrl,
            registerWithGateway: config.registerWithGateway,
            relayCount: config.relays.length,
            mode: 'hyperswarm'
          }
        })

        console.log('[Worker] Sent status message with initialized=true')
      }, 500)
      
    } catch (error) {
      console.error('[Worker] Failed to start relay server:', error)
      console.log('[Worker] Make sure pear-relay-server.mjs is in the worker directory')
      
      sendMessage({ 
        type: 'error', 
        message: `Failed to start relay server: ${error.message}` 
      })
    }

    setInterval(() => {
      if (!isShuttingDown) {
        // Keep the legacy reconcilation for now, and also refresh mirrors to discover new providers
        reconcileRelayFiles().catch(err => console.error('[Worker] File reconciliation error:', err))
        ensureMirrorsForAllRelays().catch(err => console.error('[Worker] Mirror refresh error:', err))
      }
    }, 60000)

    // Keep the process alive with heartbeat
    const heartbeatInterval = setInterval(() => {
      if (isShuttingDown) {
        clearInterval(heartbeatInterval)
        return
      }
      
      sendMessage({ 
        type: 'heartbeat', 
        timestamp: Date.now(),
        status: 'running',
        mode: 'hyperswarm'
      })
    }, 5000)
    
  } catch (error) {
    console.error('[Worker] Error starting relay server:', error)
    sendMessage({ 
      type: 'error', 
      message: error.message 
    })
    process.exit(1)
  }
}

// Start the worker
main().catch(console.error)
