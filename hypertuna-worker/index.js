#!/usr/bin/env node
// ./hypertuna-worker/index.js
//
// Enhanced worker with Hyperswarm support instead of hypertele
/** @typedef {import('pear-interface')} */ 
import process from 'node:process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import nodeCrypto from 'node:crypto'
import swarmCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import GatewayService from './gateway/GatewayService.mjs'
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
import { loadRelayKeyMappings, activeRelays, virtualRelayKeys, keyToPublic } from './hypertuna-relay-manager-adapter.mjs'
import {
  queuePendingAuthUpdate,
  applyPendingAuthUpdates
} from './pending-auth.mjs';
import {
  initializeHyperdrive,
  initializePfpHyperdrive,
  ensureRelayFolder,
  storeFile,
  getFile,
  fileExists,
  fetchFileFromDrive,
  storePfpFile,
  getPfpFile,
  pfpFileExists,
  fetchPfpFileFromDrive,
  getPfpDriveKey,
  mirrorPfpDrive,
  watchDrive,
  getReplicationHealth,
  getCorestore,
  getLocalDrive,
  getPfpDrive
} from './hyperdrive-manager.mjs';
import { ensureMirrorsForProviders, stopAllMirrors } from './mirror-sync-manager.mjs';
import { NostrUtils } from './nostr-utils.js';
import { getRelayKeyFromPublicIdentifier } from './relay-lookup-utils.mjs';
import { loadGatewaySettings, getCachedGatewaySettings, updateGatewaySettings } from '../shared/config/GatewaySettings.mjs'
import {
  loadPublicGatewaySettings,
  updatePublicGatewaySettings,
  getCachedPublicGatewaySettings
} from '../shared/config/PublicGatewaySettings.mjs'
import {
  encryptSharedSecretToString,
  decryptSharedSecretFromString
} from './challenge-manager.mjs'
import BlindPeeringManager from './blind-peering-manager.mjs'

const pearRuntime = globalThis?.Pear
const __dirname = process.env.APP_DIR || pearRuntime?.config?.dir || process.cwd()
const defaultStorageDir = process.env.STORAGE_DIR || pearRuntime?.config?.storage || join(process.cwd(), 'data')
const BLIND_PEERING_METADATA_FILENAME = 'blind-peering-metadata.json'
const BLIND_PEER_REHYDRATION_TIMEOUT_MS = 45000

global.userConfig = global.userConfig || { storage: defaultStorageDir }

const relayMirrorSubscriptions = new Map()
let lastBlindPeerFingerprint = null
let lastDispatcherAssignmentFingerprint = null

function getGatewayWebsocketProtocol(config) {
  return config?.proxy_websocket_protocol === 'ws' ? 'ws' : 'wss'
}

function buildGatewayWebsocketBase(config) {
  const protocol = getGatewayWebsocketProtocol(config)
  const host = config?.proxy_server_address || 'localhost'
  return `${protocol}://${host}`
}

function deriveGatewayHostFromStatus(status) {
  try {
    const hostnameUrl = status?.urls?.hostname ? new URL(status.urls.hostname) : null
    if (hostnameUrl) {
      return {
        httpUrl: `http://${hostnameUrl.host}`,
        proxyHost: hostnameUrl.host,
        wsProtocol: hostnameUrl.protocol === 'wss:' ? 'wss' : 'ws'
      }
    }
  } catch (_) {}
  const port = status?.port || gatewayOptions.port || 8443
  const host = `${gatewayOptions.hostname || '127.0.0.1'}:${port}`
  return {
    httpUrl: `http://${host}`,
    proxyHost: host,
    wsProtocol: 'ws'
  }
}

async function initializeGatewayOptionsFromSettings() {
  try {
    await loadGatewaySettings()
  } catch (error) {
    console.warn('[Worker] Failed to load gateway option defaults:', error)
  }
  gatewayOptions.listenHost = '127.0.0.1'
  gatewayOptions.hostname = gatewayOptions.hostname || '127.0.0.1'
}

function normalizeGatewayPathFragment(fragment) {
  if (typeof fragment !== 'string') return null
  const trimmed = fragment.trim()
  if (!trimmed) return null
  return trimmed.replace(/^\//, '').replace(/\/+$/, '')
}

function resolveRelayIdentifierPath(identifier) {
  if (!identifier || typeof identifier !== 'string') return null
  return identifier.includes(':') ? identifier.replace(':', '/') : identifier
}

async function buildGatewayRelayMetadataSnapshot(precomputedRelays = null) {
  if (!relayServer?.getActiveRelays) {
    return { entries: [], relayCount: 0 }
  }

  try {
    const activeRelays = Array.isArray(precomputedRelays)
      ? precomputedRelays
      : await relayServer.getActiveRelays()

    const entries = []

    for (const relay of activeRelays) {
      if (!relay) continue
      const {
        relayKey,
        publicIdentifier,
        name,
        description,
        connectionUrl,
        createdAt,
        isActive = true
      } = relay

      const primaryIdentifier = publicIdentifier || relayKey
      if (!primaryIdentifier) continue

      const gatewayPath = normalizeGatewayPathFragment(resolveRelayIdentifierPath(primaryIdentifier))
      const effectiveConnectionUrl = connectionUrl || `${buildGatewayWebsocketBase(config)}/${gatewayPath || primaryIdentifier}`

      const baseMetadata = {
        identifier: primaryIdentifier,
        name,
        description,
        gatewayPath: gatewayPath || normalizeGatewayPathFragment(primaryIdentifier),
        connectionUrl: effectiveConnectionUrl,
        isPublic: isActive !== false,
        metadataUpdatedAt: createdAt || null
      }

      const aliasSet = new Set()
      if (relayKey && relayKey !== primaryIdentifier) {
        const normalizedAlias = normalizeGatewayPathFragment(relayKey)
        if (normalizedAlias) {
          aliasSet.add(normalizedAlias)
        }
      }

      if (aliasSet.size > 0) {
        baseMetadata.pathAliases = Array.from(aliasSet)
      }

      entries.push(baseMetadata)

      if (relayKey && relayKey !== primaryIdentifier) {
        const aliasPath = normalizeGatewayPathFragment(relayKey)
        const aliasConnectionUrl = `${buildGatewayWebsocketBase(config)}/${aliasPath || relayKey}`
        const aliasMetadata = {
          identifier: relayKey,
          name,
          description,
          gatewayPath: aliasPath || relayKey,
          connectionUrl: aliasConnectionUrl,
          isPublic: isActive !== false,
          metadataUpdatedAt: createdAt || null,
          pathAliases: gatewayPath ? [gatewayPath] : []
        }
        entries.push(aliasMetadata)
      }
    }

    return { entries, relayCount: activeRelays.length }
  } catch (error) {
    console.warn('[Worker] Failed to enumerate relays for gateway sync:', error?.message || error)
    return { entries: [], relayCount: 0 }
  }
}

async function syncGatewayPeerMetadata(reason = 'unspecified', options = {}) {
  if (!config?.nostr_pubkey_hex || !config?.swarmPublicKey || !config?.pfpDriveKey) {
    pendingGatewayMetadataSync = true
    return
  }
  if (!gatewayService) {
    pendingGatewayMetadataSync = true
    return
  }

  try {
    const { relays: precomputedRelays } = options
    const { entries, relayCount } = await buildGatewayRelayMetadataSnapshot(precomputedRelays)

    await gatewayService.registerPeerMetadata({
      publicKey: config.swarmPublicKey,
      nostrPubkeyHex: config.nostr_pubkey_hex,
      pfpDriveKey: config.pfpDriveKey,
      mode: 'hyperswarm',
      address: config.proxy_server_address || `${gatewayOptions.hostname || '127.0.0.1'}:${gatewayOptions.port || 8443}`,
      relays: entries
    }, { source: reason, skipConnect: true })
    pendingGatewayMetadataSync = false
    console.log('[Worker] Synced gateway peer metadata', {
      reason,
      owner: config.nostr_pubkey_hex.slice(0, 8),
      pfpDriveKey: config.pfpDriveKey.slice(0, 8),
      relayCount,
      aliasEntries: Math.max(entries.length - relayCount, 0)
    })
  } catch (error) {
    pendingGatewayMetadataSync = true
    console.warn('[Worker] Failed to sync gateway peer metadata:', error?.message || error)
  }
}

async function ensurePublicGatewaySettingsLoaded() {
  if (publicGatewaySettings) return publicGatewaySettings
  try {
    publicGatewaySettings = await loadPublicGatewaySettings()
  } catch (error) {
    console.warn('[Worker] Failed to load public gateway settings:', error)
    publicGatewaySettings = getCachedPublicGatewaySettings()
  }

  if (publicGatewaySettings && typeof publicGatewaySettings.delegateReqToPeers !== 'boolean') {
    publicGatewaySettings.delegateReqToPeers = false
  }
  return publicGatewaySettings
}

async function ensureBlindPeeringManager(runtime = {}) {
  await ensurePublicGatewaySettingsLoaded()
  const storageBase = (config && config.storage) ? config.storage : defaultStorageDir
  const metadataPath = join(storageBase, BLIND_PEERING_METADATA_FILENAME)
  const swarmKeyPair = deriveSwarmKeyPair(config)
  if (!blindPeeringManager) {
    blindPeeringManager = new BlindPeeringManager({
      logger: console,
      settingsProvider: () => publicGatewaySettings
    })
  }

  blindPeeringManager.setMetadataPath(metadataPath)
  blindPeeringManager.configure(publicGatewaySettings)

  if (runtime.start === true) {
    await blindPeeringManager.start({
      corestore: runtime.corestore,
      wakeup: runtime.wakeup,
      swarmKeyPair
    })
  } else if (swarmKeyPair) {
    blindPeeringManager.runtime.swarmKeyPair = swarmKeyPair
  }

  return blindPeeringManager
}

async function seedBlindPeeringMirrors(manager) {
  if (!manager?.started) return
  const localDrive = getLocalDrive()
  if (config?.driveKey && localDrive) {
    manager.ensureHyperdriveMirror({
      identifier: config.driveKey,
      driveKey: config.driveKey,
      type: 'drive',
      drive: localDrive
    })
  }
  const pfpDriveInstance = getPfpDrive()
  if (config?.pfpDriveKey && pfpDriveInstance) {
    manager.ensureHyperdriveMirror({
      identifier: config.pfpDriveKey,
      driveKey: config.pfpDriveKey,
      type: 'pfp-drive',
      isPfp: true,
      drive: pfpDriveInstance
    })
  }
  for (const [relayKey, relayManager] of activeRelays.entries()) {
    if (!relayManager?.relay) continue
    manager.ensureRelayMirror({
      relayKey,
      publicIdentifier: relayManager?.publicIdentifier || null,
      autobase: relayManager.relay
    })
    attachRelayMirrorHooks(relayKey, relayManager, manager)
  }
}

function attachRelayMirrorHooks(relayKey, relayManager, manager) {
  if (!manager?.started) return
  const autobase = relayManager?.relay
  if (!autobase || typeof autobase.on !== 'function') return
  if (relayMirrorSubscriptions.has(autobase)) return
  const handler = () => {
    manager.ensureRelayMirror({
      relayKey,
      publicIdentifier: relayManager?.publicIdentifier || null,
      autobase
    })
    manager.refreshFromBlindPeers('relay-update')
      .then(() => manager.rehydrateMirrors({
        reason: 'relay-update',
        timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
      }))
      .catch((error) => {
        manager.logger?.warn?.('[BlindPeering] Relay update sync failed', {
          relayKey,
          err: error?.message || error
        })
      })
  }
  autobase.on('update', handler)
  relayMirrorSubscriptions.set(autobase, () => {
    if (typeof autobase.off === 'function') {
      autobase.off('update', handler)
    } else if (typeof autobase.removeListener === 'function') {
      autobase.removeListener('update', handler)
    }
  })
}

function detachRelayMirrorHooks(relayManager) {
  if (!relayManager) return
  const autobase = relayManager.relay
  if (!autobase) return
  const unsubscribe = relayMirrorSubscriptions.get(autobase)
  if (!unsubscribe) return
  try {
    unsubscribe()
  } catch (error) {
    console.warn('[Worker] Failed to detach relay mirror subscription:', error?.message || error)
  }
  relayMirrorSubscriptions.delete(autobase)
}

function cleanupRelayMirrorSubscriptions() {
  for (const unsubscribe of relayMirrorSubscriptions.values()) {
    try {
      unsubscribe()
    } catch (error) {
      console.warn('[Worker] Failed to remove relay mirror subscription:', error?.message || error)
    }
  }
  relayMirrorSubscriptions.clear()
}

async function startGatewayService(options = {}) {
  await ensurePublicGatewaySettingsLoaded()

  if (!gatewayService) {
    gatewayService = new GatewayService({
      publicGateway: publicGatewaySettings,
      getCurrentPubkey: () => config?.nostr_pubkey_hex || null,
      getOwnPeerPublicKey: () => config?.swarmPublicKey || deriveSwarmPublicKey(config)
    })
    global.gatewayService = gatewayService
    gatewayService.on('log', (entry) => {
      sendMessage({ type: 'gateway-log', entry })
    })
    gatewayService.on('status', async (status) => {
      gatewayStatusCache = status
      if (status?.publicGateway) {
        publicGatewayStatusCache = status.publicGateway
      }
      sendMessage({ type: 'gateway-status', status })
      if (status?.running) {
        if (pendingGatewayMetadataSync) {
          syncGatewayPeerMetadata('gateway-status-running').catch((err) => {
            console.warn('[Worker] Deferred gateway metadata sync failed on status:', err?.message || err)
          })
        }
        const { httpUrl, proxyHost, wsProtocol } = deriveGatewayHostFromStatus(status)
        if (!gatewaySettingsApplied) {
          try {
            await updateGatewaySettings({
              gatewayUrl: httpUrl,
              proxyHost,
              proxyWebsocketProtocol: wsProtocol
            })
            gatewaySettingsApplied = true
          } catch (error) {
            console.error('[Worker] Failed to update gateway settings:', error)
          }
        }
      }
    })
    gatewayService.on('public-gateway-status', async (state) => {
      publicGatewayStatusCache = state
      sendMessage({ type: 'public-gateway-status', state })
      if (!state?.blindPeer) return

      try {
        const blindPeerState = state.blindPeer || {}
        const summary = blindPeerState.summary || null
        const remoteKeys = Array.isArray(blindPeerState.keys) && blindPeerState.keys.length
          ? blindPeerState.keys.filter(Boolean)
          : summary?.publicKey ? [summary.publicKey] : []
        const previousSettings = publicGatewaySettings || {}
        const manualKeys = Array.isArray(previousSettings.blindPeerManualKeys)
          ? previousSettings.blindPeerManualKeys.filter(Boolean)
          : []

        publicGatewaySettings = {
          ...previousSettings,
          blindPeerEnabled: summary?.enabled ?? !!blindPeerState.enabled,
          blindPeerKeys: remoteKeys,
          blindPeerManualKeys: manualKeys,
          blindPeerEncryptionKey: summary?.encryptionKey || blindPeerState.encryptionKey || null,
          blindPeerMaxBytes: blindPeerState.maxBytes ?? previousSettings.blindPeerMaxBytes ?? null
        }

        const manager = await ensureBlindPeeringManager()
        manager.configure(publicGatewaySettings)
        manager.markTrustedMirrors(remoteKeys)

        const dispatcherAssignments = Array.isArray(blindPeerState.dispatcherAssignments)
          ? blindPeerState.dispatcherAssignments
          : Array.isArray(summary?.dispatcherAssignments) ? summary.dispatcherAssignments : []
        const ownPeerKey = config?.swarmPublicKey || deriveSwarmPublicKey(config)
        const ownAssignments = dispatcherAssignments.filter((assignment) => assignment?.peerKey === ownPeerKey)
        const dispatcherFingerprint = JSON.stringify(ownAssignments.map((assignment) => (
          `${assignment?.jobId || ''}:${assignment?.relayKey || ''}:${assignment?.status || 'assigned'}`
        )))
        const keysFingerprint = Array.from(new Set([...remoteKeys, ...manualKeys].filter(Boolean))).join(',')
        const fingerprint = summary?.enabled
          ? `${summary.publicKey || ''}:${summary.encryptionKey || ''}:${summary.trustedPeerCount ?? remoteKeys.length}:${keysFingerprint}`
          : 'disabled'

          if (manager.enabled && !manager.started) {
            await manager.start({
              corestore: getCorestore(),
              wakeup: null,
              swarmKeyPair: deriveSwarmKeyPair(config)
            })
            await seedBlindPeeringMirrors(manager)
            await manager.refreshFromBlindPeers('status-sync')
            await manager.rehydrateMirrors({
              reason: 'status-sync',
              timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
            })
            lastBlindPeerFingerprint = fingerprint
            lastDispatcherAssignmentFingerprint = dispatcherFingerprint
          } else if (manager.enabled && manager.started) {
            if (fingerprint !== lastBlindPeerFingerprint) {
              lastBlindPeerFingerprint = fingerprint
              try {
                await manager.refreshFromBlindPeers('status-sync')
            } catch (error) {
              console.warn('[Worker] Blind peering refresh failed on status update:', error?.message || error)
            }
            manager.rehydrateMirrors({
              reason: 'status-sync',
              timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
            }).catch((error) => {
              console.warn('[Worker] Blind peering rehydration failed after status update:', error?.message || error)
              })
            }
            if (dispatcherFingerprint !== lastDispatcherAssignmentFingerprint) {
              lastDispatcherAssignmentFingerprint = dispatcherFingerprint
              try {
                await seedBlindPeeringMirrors(manager)
              } catch (seedErr) {
                console.warn('[Worker] Blind peering mirror seeding failed (dispatcher update):', seedErr?.message || seedErr)
              }
              try {
                await manager.refreshFromBlindPeers('dispatcher-assignment')
              } catch (refreshErr) {
                console.warn('[Worker] Blind peering refresh failed on dispatcher update:', refreshErr?.message || refreshErr)
              }
              manager.rehydrateMirrors({
                reason: 'dispatcher-assignment',
                timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
              }).catch((error) => {
                console.warn('[Worker] Blind peering rehydration failed after dispatcher update:', error?.message || error)
              })
            }
          } else if (!manager.enabled && manager.started) {
            try {
              await manager.clearAllMirrors({ reason: 'status-disabled' })
            } catch (error) {
              console.warn('[Worker] Failed to clear blind peering mirrors before shutdown:', error?.message || error)
            }
            await manager.stop()
            lastBlindPeerFingerprint = fingerprint
            lastDispatcherAssignmentFingerprint = dispatcherFingerprint
          }
      } catch (error) {
        console.warn('[Worker] Failed to reconcile blind peering manager from status update:', error?.message || error)
      }
    })
    if (pendingGatewayMetadataSync) {
      syncGatewayPeerMetadata('gateway-service-initialized').catch((err) => {
        console.warn('[Worker] Deferred gateway metadata sync failed:', err?.message || err)
      })
    }
  }

  await gatewayService.updatePublicGatewayConfig(publicGatewaySettings)
  sendMessage({ type: 'public-gateway-config', config: publicGatewaySettings })
  publicGatewayStatusCache = gatewayService.getPublicGatewayState()
  sendMessage({ type: 'public-gateway-status', state: publicGatewayStatusCache })

  const incomingOptions = options && typeof options === 'object' ? options : {}
  const sanitizedOptions = { ...incomingOptions }
  delete sanitizedOptions.detectLanAddresses
  delete sanitizedOptions.detectPublicIp
  const mergedOptions = {
    ...gatewayOptions,
    ...sanitizedOptions,
    publicGateway: publicGatewaySettings
  }
  mergedOptions.listenHost = '127.0.0.1'
  mergedOptions.hostname = '127.0.0.1'

  const needsRestart = gatewayService?.isRunning && (
    mergedOptions.port !== gatewayOptions.port ||
    mergedOptions.hostname !== gatewayOptions.hostname ||
    mergedOptions.listenHost !== gatewayOptions.listenHost
  )

  if (needsRestart) {
    await gatewayService.stop().catch((err) => {
      console.warn('[Worker] Gateway stop during restart failed:', err)
    })
  }

  if (gatewayService.isRunning && !needsRestart) {
    gatewayOptions = mergedOptions
    return
  }

  try {
    gatewaySettingsApplied = false
    await gatewayService.start(mergedOptions)
    gatewayOptions = mergedOptions
    await ensureBlindPeeringManager({
      start: true,
      corestore: getCorestore(),
      wakeup: null
    })
    if (pendingGatewayMetadataSync) {
      syncGatewayPeerMetadata('gateway-started').catch((err) => {
        console.warn('[Worker] Deferred gateway metadata sync failed after start:', err?.message || err)
      })
    }
  } catch (error) {
    console.error('[Worker] Failed to start gateway service:', error)
    throw error
  }
}

async function stopGatewayService() {
  if (!gatewayService) return
  try {
    await gatewayService.stop()
    publicGatewayStatusCache = gatewayService.getPublicGatewayState()
    sendMessage({ type: 'public-gateway-status', state: publicGatewayStatusCache })
    if (blindPeeringManager) {
      await blindPeeringManager.stop()
    }
  } catch (error) {
    console.error('[Worker] Failed to stop gateway service:', error)
    throw error
  }
}

function waitForGatewayReady(timeoutMs = 15000) {
  if (gatewayStatusCache?.running) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const start = Date.now()
    const interval = setInterval(() => {
      if (gatewayStatusCache?.running) {
        clearInterval(interval)
        resolve(true)
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(interval)
        resolve(false)
      }
    }, 200)
  })
}

function getGatewayStatus() {
  if (gatewayService) {
    return gatewayService.getStatus()
  }
  return gatewayStatusCache || { running: false }
}

function getGatewayLogs() {
  if (gatewayService) {
    return gatewayService.getLogs()
  }
  return []
}

// Variable to store the relay server module
let relayServer = null
let isShuttingDown = false
// Map of relayKey -> members array
const relayMembers = new Map()
const relayMemberAdds = new Map()
const relayMemberRemoves = new Map()
const relayRegistrationStatus = new Map()
const seenFileHashes = new Map()
let config = null
let configPath = null
let healthLogPath = null
let healthIntervalHandle = null

// Store configuration received from the parent process
let configReceived = false
let storedParentConfig = null

let gatewayService = null
let blindPeeringManager = null
let gatewayStatusCache = null
let gatewaySettingsApplied = false
let gatewayOptions = { port: 8443, hostname: '127.0.0.1', listenHost: '127.0.0.1' }
let publicGatewaySettings = null
let publicGatewayStatusCache = null
let pendingGatewayMetadataSync = false

const WORKER_MESSAGE_VERSION = 1
const WORKER_SESSION_ID =
  typeof nodeCrypto.randomUUID === 'function'
    ? nodeCrypto.randomUUID()
    : nodeCrypto.randomBytes(16).toString('hex')

const PROXY_DERIVATION_CONTEXT = 'hypertuna-relay-peer'
const PROXY_DERIVATION_ITERATIONS = 100000
const PROXY_DERIVATION_DKLEN_BYTES = 32

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

    if (blindPeeringManager?.started) {
      try {
        if (config?.driveKey && identifier === config.driveKey) {
          const localDrive = getLocalDrive()
          if (localDrive) {
            blindPeeringManager.ensureHyperdriveMirror({
              identifier: config.driveKey,
              driveKey: config.driveKey,
              type: 'drive',
              drive: localDrive
            })
          }
        } else if (config?.pfpDriveKey && identifier === config.pfpDriveKey) {
          const pfpDrive = getPfpDrive()
          if (pfpDrive) {
            blindPeeringManager.ensureHyperdriveMirror({
              identifier: config.pfpDriveKey,
              driveKey: config.pfpDriveKey,
              type: 'pfp-drive',
              isPfp: true,
              drive: pfpDrive
            })
          }
        }
        blindPeeringManager.refreshFromBlindPeers('drive-watch').catch((error) => {
          console.warn('[Worker] Blind peering drive-watch refresh failed:', error?.message || error)
        })
      } catch (error) {
        console.warn('[Worker] Failed to update blind peering mirrors from drive watch:', error?.message || error)
      }
    }
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
      return nodeCrypto.createHash('sha256')
        .update(config.nostr_nsec_hex)
        .digest('hex');
    }
    
    throw new Error('Unable to determine user key from config');
  }
  
function deriveSwarmPublicKey(cfg = {}) {
  if (cfg.swarmPublicKey && typeof cfg.swarmPublicKey === 'string') {
    return cfg.swarmPublicKey;
  }
  if (cfg.proxy_seed && typeof cfg.proxy_seed === 'string') {
    try {
      const keyPair = swarmCrypto.keyPair(b4a.from(cfg.proxy_seed, 'hex'));
      const key = keyPair?.publicKey?.toString('hex');
      if (key) return key;
    } catch (error) {
      console.warn('[Worker] Failed to derive swarm public key from seed:', error?.message || error);
    }
  }
  return null;
}

function deriveSwarmKeyPair(cfg = {}) {
  if (cfg?.proxy_seed && typeof cfg.proxy_seed === 'string') {
    try {
      return swarmCrypto.keyPair(b4a.from(cfg.proxy_seed, 'hex'));
    } catch (error) {
      console.warn('[Worker] Failed to derive swarm key pair from seed:', error?.message || error);
    }
  }
  return null;
}

function deriveProxySeedHex(nostr_nsec_hex) {
  if (typeof nostr_nsec_hex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(nostr_nsec_hex)) {
    throw new Error('Invalid nostr_nsec_hex for proxy seed derivation')
  }

  const seed = nodeCrypto.pbkdf2Sync(
    Buffer.from(nostr_nsec_hex.toLowerCase(), 'hex'),
    Buffer.from(PROXY_DERIVATION_CONTEXT, 'utf8'),
    PROXY_DERIVATION_ITERATIONS,
    PROXY_DERIVATION_DKLEN_BYTES,
    'sha256'
  )

  return seed.toString('hex')
}

function ensureProxyIdentity(cfg = {}) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('Missing config for proxy identity derivation')
  }

  if (!cfg.proxy_seed) {
    cfg.proxy_seed = deriveProxySeedHex(cfg.nostr_nsec_hex)
  }

  try {
    const keyPair = swarmCrypto.keyPair(b4a.from(cfg.proxy_seed, 'hex'))
    if (keyPair?.publicKey) {
      cfg.proxy_publicKey = keyPair.publicKey.toString('hex')
      cfg.swarmPublicKey = cfg.swarmPublicKey || cfg.proxy_publicKey
    }
    if (keyPair?.secretKey) {
      cfg.proxy_privateKey = keyPair.secretKey.toString('hex')
    }
  } catch (error) {
    console.warn('[Worker] Failed to derive proxy keypair from proxy_seed:', error?.message || error)
  }

  return cfg
}

function sanitizeConfigForDisk(configData) {
  if (!configData || typeof configData !== 'object') return configData
  const sanitized = { ...configData }

  // Never persist nostr private keys (memory-only).
  delete sanitized.nostr_nsec
  delete sanitized.nostr_nsec_hex
  delete sanitized.nostr_nsec_bech32

  // Never persist proxy key material (re-derived from nostr_nsec_hex at runtime).
  delete sanitized.proxy_seed
  delete sanitized.proxy_privateKey
  delete sanitized.proxy_private_key
  delete sanitized.proxySecretKey

  return sanitized
}

function getUserKeyFromDiskConfig(configData) {
  if (!configData || typeof configData !== 'object') return null
  if (isHex64(configData.userKey)) return configData.userKey.toLowerCase()
  if (typeof configData.storage === 'string') {
    const match = configData.storage.match(/\/users\/([a-f0-9]{64})/i)
    if (match) return match[1].toLowerCase()
  }
  if (isHex64(configData.nostr_nsec_hex)) {
    return nodeCrypto.createHash('sha256').update(configData.nostr_nsec_hex).digest('hex')
  }
  return null
}

function doesDiskConfigMatchUser(configData, { userKey, pubkeyHex } = {}) {
  if (!configData || typeof configData !== 'object') return false
  const expectedUserKey = isHex64(userKey) ? userKey.toLowerCase() : null
  const expectedPubkeyHex = isHex64(pubkeyHex) ? pubkeyHex.toLowerCase() : null

  const diskUserKey = getUserKeyFromDiskConfig(configData)
  const diskPubkeyHex = isHex64(configData.nostr_pubkey_hex) ? configData.nostr_pubkey_hex.toLowerCase() : null

  if (expectedUserKey && diskUserKey && diskUserKey !== expectedUserKey) return false
  if (expectedPubkeyHex && diskPubkeyHex && diskPubkeyHex !== expectedPubkeyHex) return false

  // Require at least one verifiable identity signal to avoid cross-imports.
  if (!diskUserKey && !diskPubkeyHex) return false

  return true
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
    driveKey: null,
    pfpDriveKey: null
  }
  defaultConfig.storage = configDir
  if (global.userConfig?.userKey) {
    defaultConfig.userKey = global.userConfig.userKey
  }

  try {
    const configData = await fs.readFile(configPath, 'utf8')
    console.log('[Worker] Loaded existing config from:', configPath)
    const loadedConfig = JSON.parse(configData)
    let needsPersist = false
    for (const secretKey of [
      'nostr_nsec_hex',
      'nostr_nsec',
      'nostr_nsec_bech32',
      'proxy_seed',
      'proxy_privateKey',
      'proxy_private_key',
      'proxySecretKey'
    ]) {
      if (secretKey in loadedConfig) {
        needsPersist = true
      }
    }
    if (!('driveKey' in loadedConfig)) {
      loadedConfig.driveKey = null
      needsPersist = true
    }
    if (!('pfpDriveKey' in loadedConfig)) {
      loadedConfig.pfpDriveKey = null
      needsPersist = true
    }
    if (!('proxy_websocket_protocol' in loadedConfig) || !loadedConfig.proxy_websocket_protocol) {
      loadedConfig.proxy_websocket_protocol = defaultConfig.proxy_websocket_protocol
      needsPersist = true
    }
    if (needsPersist) {
      await fs.writeFile(configPath, JSON.stringify(sanitizeConfigForDisk(loadedConfig), null, 2))
    }
    return { ...defaultConfig, ...loadedConfig }
  } catch (err) {
    const missingFile = err && typeof err === 'object' && err.code === 'ENOENT'
    if (missingFile && customDir && /\/users\/[a-f0-9]{64}$/i.test(customDir)) {
      const globalConfigPath = join(defaultStorageDir, 'relay-config.json')
      try {
        const globalConfigData = await fs.readFile(globalConfigPath, 'utf8')
        const globalConfig = JSON.parse(globalConfigData)
        const expectedUserKey = global.userConfig?.userKey || null
        const expectedPubkeyHex = storedParentConfig?.nostr_pubkey_hex || null

        if (doesDiskConfigMatchUser(globalConfig, { userKey: expectedUserKey, pubkeyHex: expectedPubkeyHex })) {
          const migratedConfig = {
            ...defaultConfig,
            ...globalConfig,
            storage: configDir,
            userKey: expectedUserKey || globalConfig.userKey
          }
          await fs.writeFile(configPath, JSON.stringify(sanitizeConfigForDisk(migratedConfig), null, 2))
          try {
            await fs.writeFile(globalConfigPath, JSON.stringify(sanitizeConfigForDisk(globalConfig), null, 2))
          } catch (scrubError) {
            console.warn('[Worker] Failed to scrub secrets from legacy global config:', scrubError?.message || scrubError)
          }
          console.log('[Worker] Migrated legacy global config to user config:', {
            from: globalConfigPath,
            to: configPath
          })
          return migratedConfig
        }
      } catch (migrationError) {
        if (migrationError && typeof migrationError === 'object' && migrationError.code !== 'ENOENT') {
          console.warn('[Worker] Failed to migrate legacy global config:', migrationError?.message || migrationError)
        }
      }
    }

    console.log('[Worker] Creating new config at:', configPath)
    await fs.writeFile(configPath, JSON.stringify(sanitizeConfigForDisk(defaultConfig), null, 2))
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
function trackRegistrationStatus(message) {
  if (!message || typeof message !== 'object') return

  if (message.type === 'relay-created' && message.data) {
    const { relayKey, publicIdentifier, gatewayRegistration, registrationError } = message.data
    if (relayKey) {
      relayRegistrationStatus.set(relayKey, {
        status: gatewayRegistration || 'unknown',
        error: registrationError || null
      })
    }
    if (publicIdentifier) {
      relayRegistrationStatus.set(publicIdentifier, {
        status: gatewayRegistration || 'unknown',
        error: registrationError || null
      })
    }
  } else if (message.type === 'relay-registration-complete') {
    const entry = { status: 'success', error: null }
    if (message.relayKey) relayRegistrationStatus.set(message.relayKey, entry)
    if (message.publicIdentifier) relayRegistrationStatus.set(message.publicIdentifier, entry)
  } else if (message.type === 'relay-registration-failed') {
    const entry = { status: 'failed', error: message.error || null }
    if (message.relayKey) relayRegistrationStatus.set(message.relayKey, entry)
    if (message.publicIdentifier) relayRegistrationStatus.set(message.publicIdentifier, entry)
  }
}

const sendMessage = (message) => {
  if (isShuttingDown) return

  trackRegistrationStatus(message)

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

let workerStatusState = {
  user: null,
  app: {
    initialized: false,
    mode: 'hyperswarm',
    shuttingDown: false
  },
  gateway: {
    ready: false,
    running: false
  },
  relays: {
    expected: 0,
    active: 0
  }
}

function mergeWorkerStatusState(patch = null) {
  if (!patch || typeof patch !== 'object') return

  if ('user' in patch) {
    workerStatusState.user = patch.user ? { ...(workerStatusState.user || {}), ...patch.user } : null
  }
  if (patch.app) {
    workerStatusState.app = { ...workerStatusState.app, ...patch.app }
  }
  if (patch.gateway) {
    workerStatusState.gateway = { ...workerStatusState.gateway, ...patch.gateway }
  }
  if (patch.relays) {
    workerStatusState.relays = { ...workerStatusState.relays, ...patch.relays }
  }
}

function sendWorkerStatus(phase, message, { statePatch = null, legacy = null, error = null } = {}) {
  mergeWorkerStatusState(statePatch)

  const payload = {
    type: 'status',
    v: WORKER_MESSAGE_VERSION,
    ts: Date.now(),
    sessionId: WORKER_SESSION_ID,
    phase,
    message: message || '',
    state: workerStatusState
  }

  if (legacy && typeof legacy === 'object') {
    Object.assign(payload, legacy)
  }

  if (error) {
    payload.error = {
      message: error?.message || String(error),
      stack: error?.stack || null
    }
  }

  sendMessage(payload)
}

function sendConfigAppliedV1(data) {
  sendMessage({
    type: 'config-applied',
    v: WORKER_MESSAGE_VERSION,
    ts: Date.now(),
    sessionId: WORKER_SESSION_ID,
    data
  })
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
	      const requiresParentConfig = process.env.ELECTRON_RUN_AS_NODE === '1'
	      console.log('[Worker] Config wait timeout' + (requiresParentConfig ? '' : ' - proceeding with defaults'))
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

      const statusEntry = relayRegistrationStatus.get(r.relayKey)
        || (profile.public_identifier ? relayRegistrationStatus.get(profile.public_identifier) : null)
        || null

      return {
        ...r,
        publicIdentifier: profile.public_identifier || null,
        connectionUrl,
        userAuthToken: token,
        requiresAuth: profile.auth_config?.requiresAuth || false,
        registrationStatus: statusEntry?.status || 'unknown',
        registrationError: statusEntry?.error || null
      }
    })
  } catch (err) {
    console.error('[Worker] Failed to add auth info to relays:', err)
    return relays
  }
}

async function reconcileRelayFiles() {
  for (const [relayKey, manager] of activeRelays.entries()) {
    if (relayKey === 'public-gateway:hyperbee') {
      continue;
    }
    if (typeof manager?.relay?.queryFilekeyIndex !== 'function') {
      continue;
    }
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

async function syncRemotePfpMirrors() {
  if (!gatewayService?.getPeersWithPfpDrive) return
  const peers = gatewayService.getPeersWithPfpDrive()
  if (!Array.isArray(peers) || peers.length === 0) return

  const localPfpKey = getPfpDriveKey()
  for (const peer of peers) {
    try {
      if (!peer?.pfpDriveKey) continue
      if (localPfpKey && peer.pfpDriveKey === localPfpKey) continue
      await mirrorPfpDrive(peer.pfpDriveKey)
    } catch (err) {
      console.warn('[Worker] PFP mirror failed for peer', peer?.pfpDriveKey, err?.message || err)
    }
  }
}

async function ensureMirrorsForAllRelays() {
  const total = activeRelays.size
  console.log(`[Mirror] scanning active relays: ${total}`)
  for (const [relayKey, manager] of activeRelays.entries()) {
    if (virtualRelayKeys.has(relayKey)) {
      console.log(`[Mirror] skipping virtual relay ${relayKey} for mirror scan`)
      continue
    }
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
  if (virtualRelayKeys.has(relayKey)) {
    return {
      relayKey,
      skipped: true,
      reason: 'virtual-relay',
      timestamp: Date.now()
    }
  }
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

  if (message.type === 'config') {
    const pubkey = typeof message.data?.nostr_pubkey_hex === 'string' ? message.data.nostr_pubkey_hex : null
    console.log('[Worker] Received from parent: config', {
      pubkeyHex: pubkey ? `${pubkey.slice(0, 8)}...` : null,
      hasNsecHex: typeof message.data?.nostr_nsec_hex === 'string',
      hasStorage: typeof message.data?.storage === 'string'
    })
  } else {
    console.log('[Worker] Received from parent:', { type: message.type })
  }

  if (message.type === 'config') {
    storedParentConfig = message.data
    if (!configReceived) {
      configReceived = true
      const pubkey = typeof storedParentConfig?.nostr_pubkey_hex === 'string' ? storedParentConfig.nostr_pubkey_hex : null
      console.log('[Worker] Stored parent config (sanitized):', {
        pubkeyHex: pubkey ? `${pubkey.slice(0, 8)}...` : null,
        hasNsecHex: typeof storedParentConfig?.nostr_nsec_hex === 'string',
        hasStorage: typeof storedParentConfig?.storage === 'string'
      })
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

    case 'start-gateway': {
      try {
        await startGatewayService(message.options || {})
        sendMessage({ type: 'gateway-started', status: getGatewayStatus() })
      } catch (err) {
        sendMessage({ type: 'gateway-error', message: err.message })
      }
      break
    }

    case 'stop-gateway': {
      try {
        await stopGatewayService()
        sendMessage({ type: 'gateway-stopped', status: getGatewayStatus() })
      } catch (err) {
        sendMessage({ type: 'gateway-error', message: err.message })
      }
      break
    }

    case 'get-gateway-status': {
      sendMessage({ type: 'gateway-status', status: getGatewayStatus() })
      break
    }

    case 'get-gateway-logs': {
      sendMessage({ type: 'gateway-logs', logs: getGatewayLogs() })
      break
    }

    case 'get-public-gateway-config': {
      await ensurePublicGatewaySettingsLoaded()
      sendMessage({ type: 'public-gateway-config', config: publicGatewaySettings })
      break
    }

    case 'set-public-gateway-config': {
      await ensurePublicGatewaySettingsLoaded()
      try {
        const next = await updatePublicGatewaySettings(message.config || {})
        publicGatewaySettings = next
        if (blindPeeringManager) {
          blindPeeringManager.configure(next)
          if (Array.isArray(next.blindPeerKeys) && next.blindPeerKeys.length) {
            blindPeeringManager.markTrustedMirrors(next.blindPeerKeys)
          }
          if (blindPeeringManager.enabled && !blindPeeringManager.started) {
            try {
              await blindPeeringManager.start({
                corestore: getCorestore(),
                wakeup: null
              })
            } catch (err) {
              console.warn('[Worker] Failed to restart blind peering manager after config update:', err?.message || err)
            }
          } else if (!blindPeeringManager.enabled && blindPeeringManager.started) {
            try {
              await blindPeeringManager.clearAllMirrors({ reason: 'config-disabled' })
            } catch (err) {
              console.warn('[Worker] Failed to clear blind peering mirrors after config disable:', err?.message || err)
            }
            await blindPeeringManager.stop()
          }
        }
        if (gatewayService) {
          await gatewayService.updatePublicGatewayConfig(next)
          publicGatewayStatusCache = gatewayService.getPublicGatewayState()
          sendMessage({ type: 'public-gateway-status', state: publicGatewayStatusCache })
        }
        sendMessage({ type: 'public-gateway-config', config: next })
      } catch (err) {
        sendMessage({ type: 'public-gateway-error', message: err.message })
      }
      break
    }

    case 'get-public-gateway-status': {
      if (gatewayService) {
        const state = gatewayService.getPublicGatewayState()
        publicGatewayStatusCache = state
        sendMessage({ type: 'public-gateway-status', state })
      } else if (publicGatewayStatusCache) {
        sendMessage({ type: 'public-gateway-status', state: publicGatewayStatusCache })
      } else {
        await ensurePublicGatewaySettingsLoaded()
        sendMessage({
          type: 'public-gateway-status',
          state: {
            enabled: !!publicGatewaySettings?.enabled,
            baseUrl: publicGatewaySettings?.baseUrl || null,
            defaultTokenTtl: publicGatewaySettings?.defaultTokenTtl || 3600,
            wsBase: null,
            lastUpdatedAt: null,
            relays: {}
          }
        })
      }
      break
    }

    case 'get-blind-peering-status': {
      try {
        const manager = await ensureBlindPeeringManager()
        const status = manager ? manager.getStatus() : { enabled: false, running: false }
        const metadata = manager ? manager.getMirrorMetadata() : null
        sendMessage({ type: 'blind-peering-status', status, metadata })
      } catch (err) {
        sendMessage({ type: 'error', message: `blind-peering-status failed: ${err.message}` })
      }
      break
    }

    case 'generate-public-gateway-token': {
      try {
        if (!gatewayService) throw new Error('Gateway service not initialized')
        const result = gatewayService.issuePublicGatewayToken(message.relayKey, {
          ttlSeconds: message.ttlSeconds
        })
        sendMessage({ type: 'public-gateway-token', result })
      } catch (err) {
        sendMessage({
          type: 'public-gateway-token-error',
          relayKey: message.relayKey || null,
          error: err.message
        })
      }
      break
    }

    case 'refresh-public-gateway-relay': {
      try {
        if (!gatewayService) throw new Error('Gateway service not initialized')
        await gatewayService.syncPublicGatewayRelay(message.relayKey)
        const state = gatewayService.getPublicGatewayState()
        publicGatewayStatusCache = state
        sendMessage({ type: 'public-gateway-status', state })
      } catch (err) {
        sendMessage({ type: 'public-gateway-error', message: err.message })
      }
      break
    }

    case 'refresh-public-gateway-all': {
      try {
        if (!gatewayService) throw new Error('Gateway service not initialized')
        await gatewayService.resyncPublicGateway()
        const state = gatewayService.getPublicGatewayState()
        publicGatewayStatusCache = state
        sendMessage({ type: 'public-gateway-status', state })
      } catch (err) {
        sendMessage({ type: 'public-gateway-error', message: err.message })
      }
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

    case 'upload-pfp': {
      const payload = message?.data || {}
      const ownerRaw = typeof payload.owner === 'string' ? payload.owner : ''
      const ownerKey = ownerRaw.trim()
      try {
        const { fileHash, metadata, buffer } = payload
        if (!fileHash || !buffer) throw new Error('Missing fileHash or buffer')
        console.log(`[UploadPfp] begin owner=${ownerKey || 'root'} fileHash=${fileHash} bufLen=${buffer?.length}`)
        const data = b4a.from(buffer, 'base64')
        await storePfpFile(ownerKey, fileHash, data, metadata || null)
        sendMessage({ type: 'upload-pfp-complete', owner: ownerKey, fileHash })
      } catch (err) {
        console.error('[Worker] upload-pfp error:', err)
        sendMessage({ type: 'upload-pfp-error', owner: ownerKey, fileHash: payload?.fileHash || null, error: err?.message || String(err) })
        sendMessage({ type: 'error', message: `upload-pfp failed: ${err.message}` })
      }
      break
    }

    case 'crypto-encrypt': {
      const { requestId, privkey, pubkey, plaintext } = message || {}
      try {
        if (!requestId) throw new Error('Missing requestId')
        if (!privkey || !pubkey) throw new Error('Missing keys for encryption')
        const result = encryptSharedSecretToString(privkey, pubkey, plaintext)
        sendMessage({ type: 'crypto-response', requestId, success: true, result })
      } catch (err) {
        sendMessage({
          type: 'crypto-response',
          requestId: message?.requestId || null,
          success: false,
          error: err?.message || String(err)
        })
      }
      break
    }

    case 'crypto-decrypt': {
      const { requestId, privkey, pubkey, ciphertext } = message || {}
      try {
        if (!requestId) throw new Error('Missing requestId')
        if (!privkey || !pubkey) throw new Error('Missing keys for decryption')
        if (typeof ciphertext !== 'string') throw new Error('Missing ciphertext payload')
        const result = decryptSharedSecretFromString(privkey, pubkey, ciphertext)
        sendMessage({ type: 'crypto-response', requestId, success: true, result })
      } catch (err) {
        sendMessage({
          type: 'crypto-response',
          requestId: message?.requestId || null,
          success: false,
          error: err?.message || String(err)
        })
      }
      break
    }

    case 'shutdown':
      console.log('[Worker] Shutdown requested')
      isShuttingDown = true
      sendWorkerStatus('stopping', 'Shutting down...', {
        statePatch: { app: { shuttingDown: true } }
      })
      await cleanup()
      process.exit(0)
      break

    case 'config':
      console.log('[Worker] Received additional config message (ignored)')
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

          if (result.gatewayRegistration === 'failed') {
            sendMessage({
              type: 'relay-registration-failed',
              relayKey: result.relayKey,
              publicIdentifier: result.publicIdentifier || null,
              error: result.registrationError || 'Gateway registration failed'
            })
          }

          const relays = await relayServer.getActiveRelays()
          await syncGatewayPeerMetadata('relay-created', { relays })
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
          await syncGatewayPeerMetadata('relay-joined', { relays })
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
      if (relayServer && message?.data?.relayKey) {
        const relayKey = message.data.relayKey
        const relayManagerInstance = activeRelays.get(relayKey)
        const publicIdentifier = message.data?.publicIdentifier || keyToPublic.get(relayKey) || null
        try {
          const result = await relayServer.disconnectRelay(relayKey)

          detachRelayMirrorHooks(relayManagerInstance)
          try {
            const manager = await ensureBlindPeeringManager()
            if (manager?.started) {
              await manager.removeRelayMirror({
                relayKey,
                publicIdentifier,
                autobase: relayManagerInstance?.relay || null
              }, { reason: 'manual-disconnect' })
            }
          } catch (mirrorError) {
            console.warn('[Worker] Blind peering mirror removal on disconnect failed:', mirrorError?.message || mirrorError)
          }

          sendMessage({
            type: 'relay-disconnected',
            data: result
          })

          const relays = await relayServer.getActiveRelays()
          await syncGatewayPeerMetadata('relay-disconnected', { relays })
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

          if (relayManagerInstance && relayManagerInstance.relay) {
            attachRelayMirrorHooks(relayKey, relayManagerInstance, blindPeeringManager)
          }
        }
      }
      break

    case 'start-join-flow':
      console.log('[Worker] Start join flow requested:', message.data)
      if (relayServer) {
        const data = (message && typeof message === 'object' ? message.data : null) || {}
        const publicIdentifier = data.publicIdentifier
        const fileSharing = data.fileSharing
        try {
          let hostPeers = Array.isArray(data.hostPeers) ? data.hostPeers : []
          hostPeers = hostPeers
            .map((key) => String(key || '').trim().toLowerCase())
            .filter(Boolean)

          if (!hostPeers.length) {
            const status = getGatewayStatus()
            const peerRelayMap = status?.peerRelayMap
            const candidates = []
            if (peerRelayMap && typeof peerRelayMap === 'object') {
              candidates.push(publicIdentifier)
              if (typeof publicIdentifier === 'string' && publicIdentifier.includes(':')) {
                candidates.push(publicIdentifier.replace(':', '/'))
              }
            }

            for (const identifier of candidates) {
              if (!identifier) continue
              const entry = peerRelayMap?.[identifier]
              const peers = Array.isArray(entry?.peers) ? entry.peers : []
              if (peers.length) {
                hostPeers = peers
                  .map((key) => String(key || '').trim().toLowerCase())
                  .filter(Boolean)
                if (hostPeers.length) break
              }
            }
          }

          await relayServer.startJoinAuthentication({
            ...data,
            publicIdentifier,
            fileSharing,
            hostPeers
          })
        } catch (err) {
          sendMessage({
            type: 'join-auth-error',
            data: {
              publicIdentifier,
              error: `Failed to start join flow: ${err.message}`
            }
          })
        }
      } else {
        sendMessage({
          type: 'join-auth-error',
          data: {
            publicIdentifier: message?.data?.publicIdentifier,
            error: 'Relay server not initialized'
          }
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
  sendWorkerStatus('starting', 'Relay worker starting...')
  
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
    sendWorkerStatus('stopping', 'Worker shutting down...', {
      statePatch: { app: { shuttingDown: true } }
    })
  }

  if (relayServer && relayServer.shutdownRelayServer) {
    console.log('[Worker] Stopping relay server...')
    await relayServer.shutdownRelayServer()
  }

  try { await stopGatewayService() } catch (_) {}

  // Stop all mirror watchers
  cleanupRelayMirrorSubscriptions()
  try { await stopAllMirrors() } catch (_) {}

  if (blindPeeringManager) {
    try {
      await blindPeeringManager.clearAllMirrors({ reason: 'shutdown' })
    } catch (err) {
      console.warn('[Worker] Failed to clear blind peering mirrors during shutdown:', err?.message || err)
    }
    try {
      await blindPeeringManager.stop()
    } catch (err) {
      console.warn('[Worker] Failed to stop blind peering manager:', err?.message || err)
    }
    lastBlindPeerFingerprint = null
    lastDispatcherAssignmentFingerprint = null
  }
  
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
      sendWorkerStatus('starting', 'Hypertuna Relay Worker starting...', {
        statePatch: {
          app: { initialized: false, mode: 'hyperswarm', shuttingDown: false },
          gateway: { ready: false, running: false },
          relays: { expected: 0, active: 0 }
        }
      })

	      const hasParentIpc = !!(workerPipe || typeof process.send === 'function')
	      const requiresParentConfig = process.env.ELECTRON_RUN_AS_NODE === '1'
	      let expectedRelayCount = 0
	      
	      // Wait for config from parent if available
	      let parentConfig = storedParentConfig
	      if (!parentConfig && hasParentIpc) {
        console.log('[Worker] Waiting for parent config...')
        sendWorkerStatus('waiting-config', 'Waiting for parent config…')
        parentConfig = await waitForParentConfig()
	      } else if (parentConfig) {
	        console.log('[Worker] Using previously received parent config')
	      }

	      if (requiresParentConfig) {
	        if (!parentConfig) {
	          const message = 'Missing required parent config (nostr keys). Worker cannot start.'
	          console.error('[Worker] ' + message)
	          sendWorkerStatus('error', message, { error: new Error(message) })
	          sendMessage({ type: 'error', message })
	          await new Promise(resolve => setTimeout(resolve, 25))
	          process.exit(1)
	        }

	        if (!isHex64(parentConfig.nostr_pubkey_hex) || !isHex64(parentConfig.nostr_nsec_hex)) {
	          const message = 'Invalid parent config (expected nostr_pubkey_hex + nostr_nsec_hex). Worker cannot start.'
	          console.error('[Worker] ' + message)
	          sendWorkerStatus('error', message, { error: new Error(message) })
	          sendMessage({ type: 'error', message })
	          await new Promise(resolve => setTimeout(resolve, 25))
	          process.exit(1)
	        }
	      }

	      if (parentConfig) {
	        storedParentConfig = parentConfig
	        configReceived = true

	        // Get user key from parent config
        const userKey = getUserKey(parentConfig)
        console.log('[Worker] User key:', userKey)

        const userSpecificStorage = join(defaultStorageDir, 'users', userKey)
        await fs.mkdir(userSpecificStorage, { recursive: true })

        // Set global user config for profile manager early (so downstream modules use correct scope)
        global.userConfig = { userKey, storage: userSpecificStorage }

        // Load or create configuration *within user-specific storage*
        config = await loadOrCreateConfig(userSpecificStorage)

        // Merge parent config with loaded config (parent values win for identity fields)
        config = {
          ...config,
          ...parentConfig,
          storage: userSpecificStorage,
          userKey
        }

        // Derive deterministic proxy identity in worker (matches legacy design intent)
        try {
          ensureProxyIdentity(config)
        } catch (error) {
          console.warn('[Worker] Failed to ensure proxy identity:', error?.message || error)
        }

        const derivedSwarmKey = deriveSwarmPublicKey(config)
        if (derivedSwarmKey) {
          config.swarmPublicKey = derivedSwarmKey
          gatewayService?.setOwnPeerPublicKey(derivedSwarmKey)
        }

        expectedRelayCount = Array.isArray(config.relays) ? config.relays.length : 0

        sendConfigAppliedV1({
          user: {
            pubkeyHex: config.nostr_pubkey_hex || null,
            userKey
          },
          storage: {
            baseDir: defaultStorageDir,
            userDir: userSpecificStorage,
            configPath
          },
          proxy: {
            swarmPublicKey: config.swarmPublicKey || null,
            derivation: {
              scheme: 'pbkdf2-sha256-ed25519',
              salt: PROXY_DERIVATION_CONTEXT,
              iterations: PROXY_DERIVATION_ITERATIONS,
              dkLen: PROXY_DERIVATION_DKLEN_BYTES
            }
          },
          network: {
            gatewayUrl: config.gatewayUrl,
            proxyHost: config.proxy_server_address,
            proxyWebsocketProtocol: config.proxy_websocket_protocol === 'ws' ? 'ws' : 'wss'
          }
        })

        sendWorkerStatus('config-applied', 'Config applied. Initializing…', {
          statePatch: {
            user: {
              pubkeyHex: config.nostr_pubkey_hex || null,
              userKey
            },
            relays: { expected: expectedRelayCount, active: 0 }
          }
        })

        console.log('[Worker] Set global user config for profile operations')

        await loadRelayMembers()
        await loadRelayKeyMappings()
      } else {
        // Load or create configuration (no parent config provided)
        config = await loadOrCreateConfig()
        expectedRelayCount = Array.isArray(config.relays) ? config.relays.length : 0
      }

    await initializeGatewayOptionsFromSettings()

    global.userConfig = global.userConfig || { storage: config.storage };

    const hadDriveKey = !!config.driveKey;
    const hadPfpDriveKey = !!config.pfpDriveKey;
    const hyperdriveConfig = { ...config, storage: global.userConfig.storage };
    await initializeHyperdrive(hyperdriveConfig);
    config.driveKey = hyperdriveConfig.driveKey;

    const pfpConfig = { ...config, storage: global.userConfig.storage, pfpDriveKey: config.pfpDriveKey }
    await initializePfpHyperdrive(pfpConfig);
    config.pfpDriveKey = pfpConfig.pfpDriveKey;
    if (config.pfpDriveKey) {
      syncGatewayPeerMetadata('pfp-drive-ready').catch((err) => {
        console.warn('[Worker] Gateway metadata sync failed (pfp-drive-ready):', err?.message || err)
      })
    }

	    if ((!hadDriveKey && config.driveKey) || (!hadPfpDriveKey && config.pfpDriveKey)) {
	      try {
	        await fs.writeFile(configPath, JSON.stringify(sanitizeConfigForDisk(config), null, 2));
	      } catch (err) {
	        console.error('[Worker] Failed to persist hyperdrive keys:', err);
	      }
	    }

    if (config.driveKey) {
      sendMessage({ type: 'drive-key', driveKey: config.driveKey });
    }
    if (config.pfpDriveKey) {
      sendMessage({ type: 'pfp-drive-key', driveKey: config.pfpDriveKey });
    }

    startDriveWatcher()

    // Start periodic replication health logger
    startHealthLogger(60000)
    // Kick off mirror setup for all known relays/providers
    await ensureMirrorsForAllRelays().catch(err => console.error('[Worker] Mirror setup error:', err))

    try {
      const manager = await ensureBlindPeeringManager({
        start: true,
        corestore: getCorestore(),
        wakeup: null
      })
      await seedBlindPeeringMirrors(manager)
      await manager.refreshFromBlindPeers('startup')
      await manager.rehydrateMirrors({
        reason: 'startup',
        timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
      })
    } catch (error) {
      console.warn('[Worker] Blind peering manager failed to start:', error?.message || error)
    }

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
	    sendWorkerStatus('initializing', 'Loading relay server…', {
	      statePatch: {
	        relays: { expected: expectedRelayCount },
	        gateway: { ready: false, running: false }
	      }
	    })
	    
	    // Import and initialize the Hyperswarm-based relay server
	    try {
      console.log('[Worker] Importing Hyperswarm relay server module...')
      relayServer = await import('./pear-relay-server.mjs')
      
      console.log('[Worker] Initializing relay server...')
      await relayServer.initializeRelayServer(config)
      
      console.log('[Worker] Relay server base initialization complete')

      const derivedSwarmKey = deriveSwarmPublicKey(config)
      if (derivedSwarmKey) {
        config.swarmPublicKey = derivedSwarmKey
        gatewayService?.setOwnPeerPublicKey(derivedSwarmKey)
      }

	      const gatewayReadyPromise = (async () => {
	        try {
	          console.log('[Worker] Starting gateway service before auto-connecting relays...')
	          sendWorkerStatus('gateway-starting', 'Starting gateway…')
	          await startGatewayService()
	          const ready = await waitForGatewayReady()
	          if (!ready) {
	            console.warn('[Worker] Gateway did not report ready status within timeout; proceeding cautiously')
	          }
	          sendWorkerStatus('gateway-ready', ready ? 'Gateway ready.' : 'Gateway not ready (timeout).', {
	            statePatch: { gateway: { ready: !!ready, running: !!ready } }
	          })
	          return ready
	        } catch (gatewayError) {
	          console.error('[Worker] Failed to auto-start gateway:', gatewayError)
	          sendMessage({ type: 'gateway-error', message: gatewayError.message })
	          sendWorkerStatus('error', 'Gateway start failed', {
	            error: gatewayError,
	            statePatch: { gateway: { ready: false, running: false } }
	          })
	          return false
	        }
	      })()

      global.waitForGatewayReady = () => gatewayReadyPromise

	      const connectRelaysPromise = (async () => {
	        try {
	          sendWorkerStatus('relays-loading', 'Loading relays…', {
	            statePatch: { relays: { expected: expectedRelayCount, active: 0 } }
	          })
	          return await relayServer.connectStoredRelays()
	        } catch (connectError) {
	          console.error('[Worker] Failed to auto-connect stored relays:', connectError)
	          return []
	        }
	      })()

      const [connectedRelaysRaw, gatewayReadyResult] = await Promise.all([connectRelaysPromise, gatewayReadyPromise])
      const connectedRelays = Array.isArray(connectedRelaysRaw) ? connectedRelaysRaw : []
      const gatewayReady = !!gatewayReadyResult

      if (Array.isArray(connectedRelays)) {
        config.relays = connectedRelays
      }

      try {
        const relaysSnapshot = await relayServer.getActiveRelays()
        await syncGatewayPeerMetadata('auto-connect-complete', { relays: relaysSnapshot })
      } catch (syncError) {
        console.warn('[Worker] Gateway metadata sync failed (auto-connect-complete):', syncError?.message || syncError)
      }

	      if (!isShuttingDown) {
	        sendMessage({
	          type: 'status',
	          message: 'Relay server running with Hyperswarm',
	          initialized: true,
	          config: {
	            port: config.port,
	            proxy_server_address: config.proxy_server_address,
	            gatewayUrl: config.gatewayUrl,
	            registerWithGateway: config.registerWithGateway,
	            relayCount: Array.isArray(connectedRelays) ? connectedRelays.length : (config.relays?.length || 0),
	            mode: 'hyperswarm',
	            gatewayReady
	          }
	        })
	        sendWorkerStatus('ready', 'Relay server running with Hyperswarm', {
	          legacy: { initialized: true },
	          statePatch: {
	            app: { initialized: true },
	            gateway: { ready: gatewayReady, running: gatewayReady },
	            relays: {
	              expected: expectedRelayCount,
	              active: Array.isArray(connectedRelays) ? connectedRelays.length : 0
	            }
	          }
	        })
	
	        console.log('[Worker] Sent status message with initialized=true')
	      }

	    } catch (error) {
	      console.error('[Worker] Failed to start relay server:', error)
	      console.log('[Worker] Make sure pear-relay-server.mjs is in the worker directory')
	      sendWorkerStatus('error', 'Failed to start relay server', { error })
	      
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
        syncRemotePfpMirrors().catch(err => console.error('[Worker] PFP mirror error:', err))
        if (blindPeeringManager?.started) {
          seedBlindPeeringMirrors(blindPeeringManager).catch(err => {
            console.warn('[Worker] Blind peering mirror seeding failed:', err?.message || err)
          })
          blindPeeringManager.refreshFromBlindPeers('periodic')
            .then(() => blindPeeringManager.rehydrateMirrors({
              reason: 'periodic',
              timeoutMs: BLIND_PEER_REHYDRATION_TIMEOUT_MS
            }))
            .catch(err => {
              console.warn('[Worker] Blind peering periodic sync failed:', err?.message || err)
            })
        }
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
	    sendWorkerStatus('error', 'Worker failed to start', { error })
	    sendMessage({ 
	      type: 'error', 
	      message: error.message 
	    })
	    process.exit(1)
	  }
}

// Start the worker
main().catch(console.error)
