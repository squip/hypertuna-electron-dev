// hypertuna-worker/hyperdrive-manager.mjs

import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { setTimeout as scheduleTimeout, clearTimeout } from 'node:timers'
import crypto from 'node:crypto'

let store = null
let drive = null
let localDriveKeyHex = null
let storageDir = null
let replicationSwarm = null
const topicCache = new Map() // key -> { discovery, refCount, lastUsed, readyPromise, timer }
let replicationConnectionsOpen = 0
let replicationConnectionsTotal = 0

function topicKey (discoveryKey) {
  return b4a.toString(discoveryKey, 'hex')
}

async function acquireRemoteTopic (remoteDrive, ttlMs = 90000) {
  const swarm = await ensureReplicationSwarm()
  const key = topicKey(remoteDrive.discoveryKey)
  const now = Date.now()

  let entry = topicCache.get(key)
  if (entry) {
    entry.refCount += 1
    entry.lastUsed = now
    if (entry.timer) {
      try { clearTimeout(entry.timer) } catch (_) {}
      entry.timer = null
    }
    await entry.readyPromise
    console.log(`[Topic] reuse join dkey=${key} refCount=${entry.refCount}`)
    return () => releaseTopic(key, ttlMs)
  }

  const discovery = swarm.join(remoteDrive.discoveryKey)
  const readyPromise = discovery.flushed()
  entry = { discovery, refCount: 1, lastUsed: now, readyPromise, timer: null }
  topicCache.set(key, entry)
  console.log(`[Topic] first join dkey=${key} refCount=1`)
  await readyPromise
  return () => releaseTopic(key, ttlMs)
}

function releaseTopic (key, ttlMs) {
  const entry = topicCache.get(key)
  if (!entry) return
  entry.refCount = Math.max(0, entry.refCount - 1)
  entry.lastUsed = Date.now()
  console.log(`[Topic] release dkey=${key} refCount=${entry.refCount}`)
  if (entry.refCount === 0 && !entry.timer) {
    entry.timer = setTimeoutEvict(key, ttlMs)
  }
}

function setTimeoutEvict (key, ttlMs) {
  const timer = scheduleTimeout(async () => {
    try {
      const entry = topicCache.get(key)
      if (!entry || entry.refCount > 0) return
      try { entry.discovery.destroy() } catch (_) {}
      topicCache.delete(key)
      console.log(`[Topic] evicted dkey=${key}`)
    } catch (_) {}
  }, ttlMs)
  timer?.unref?.()
  return timer
}

export function getCorestore() {
  return store
}

export function getLocalDrive() {
  return drive
}

function isHex64 (s) {
  return typeof s === 'string' && /^[a-fA-F0-9]{64}$/.test(s)
}

export function normalizeIdentifier(id) {
  if (!id) return ''
  if (typeof id === 'string') {
    // Keep public identifiers as-is (npub:alias), normalize relayKey hex to lowercase
    return isHex64(id) ? id.toLowerCase() : id
  }
  if (id instanceof Uint8Array || Buffer.isBuffer(id)) {
    return Buffer.from(id).toString('hex')
  }
  return String(id)
}

export const relayPath = (identifier) => `/${normalizeIdentifier(identifier)}`
export const relayFilePath = (identifier, fileHash) => `${relayPath(identifier)}/${fileHash}`

export async function ensureRelayFolder(identifier) {
  const path = relayPath(identifier)
  try {
    // Hyperdrive is key-based and does not require explicit directory creation.
    // We intentionally no-op here since folder prefixes are implicit.
    await drive.ready()
    console.log(`[Hyperdrive] ensureRelayFolder ready path=${path}`)
  } catch (_) {}
}

async function ensureReplicationSwarm () {
  if (replicationSwarm) return replicationSwarm
  if (!store) throw new Error('Corestore not initialized')
  replicationSwarm = new Hyperswarm()
  console.log('[Hyperdrive] replication swarm initialized')
  replicationSwarm.on('connection', (conn, info) => {
    replicationConnectionsOpen++
    replicationConnectionsTotal++
    const peerKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : 'unknown'
    console.log(`[Hyperdrive] connection opened peer=${peerKey} open=${replicationConnectionsOpen}`)
    try { store.replicate(conn) } catch (err) { console.error('[Hyperdrive] replicate error:', err) }
    try {
      conn.once?.('close', () => {
        replicationConnectionsOpen = Math.max(0, replicationConnectionsOpen - 1)
        console.log(`[Hyperdrive] connection closed peer=${peerKey} open=${replicationConnectionsOpen}`)
      })
      conn.once?.('end', () => {
        replicationConnectionsOpen = Math.max(0, replicationConnectionsOpen - 1)
        console.log(`[Hyperdrive] connection ended peer=${peerKey} open=${replicationConnectionsOpen}`)
      })
      conn.once?.('error', () => {
        replicationConnectionsOpen = Math.max(0, replicationConnectionsOpen - 1)
        console.log(`[Hyperdrive] connection error peer=${peerKey} open=${replicationConnectionsOpen}`)
      })
    } catch (_) {}
  })
  return replicationSwarm
}

/**
 * Join the discovery topic for a remote Hyperdrive using the shared replication swarm.
 * Returns a release function that decrements the refcount and eventually evicts the topic.
 * @param {import('hyperdrive').default} remoteDrive
 * @param {number} ttlMs
 * @returns {Promise<() => void>}
 */
export async function joinRemoteDriveTopic (remoteDrive, ttlMs = 90000) {
  return acquireRemoteTopic(remoteDrive, ttlMs)
}

/**
 * Initialize a Hyperdrive instance for this worker.
 * @param {object} config - Worker configuration including storage path.
 * @returns {Promise<void>}
 */
export async function initializeHyperdrive(config) {
  storageDir = config.storage
  store = new Corestore(storageDir)
  drive = new Hyperdrive(store)
  await drive.ready()
  config.driveKey = drive.key.toString('hex')
  localDriveKeyHex = config.driveKey
  console.log(`[Hyperdrive] local drive ready key=${config.driveKey} dkey=${b4a.toString(drive.discoveryKey, 'hex')}`)

  // Start replication swarm and announce our local drive
  const swarm = await ensureReplicationSwarm()
  const done = drive.findingPeers()
  const discovery = swarm.join(drive.discoveryKey)
  await discovery.flushed().then(done, done)
  console.log('[Hyperdrive] local drive announced to swarm')

  if (Array.isArray(config.relays)) {
    for (const relay of config.relays) {
      const relayKey = relay?.relayKey || relay
      if (!relayKey) continue
      await ensureRelayFolder(relayKey)
    }
  }
}

function isClosingCoreError (err) {
  const msg = err?.message || ''
  const code = err?.code || ''
  return code === 'SESSION_CLOSED' || /SESSION_CLOSED|closing core/i.test(msg)
}

function isStoreClosedError (err) {
  const msg = err?.message || ''
  return /corestore is closed/i.test(msg)
}

async function announceLocalDriveOnSwarm () {
  try {
    const swarm = await ensureReplicationSwarm()
    const done = drive.findingPeers()
    const discovery = swarm.join(drive.discoveryKey)
    await discovery.flushed().then(done, done)
  } catch (e) {
    console.error('[Hyperdrive] announceLocalDriveOnSwarm failed:', e)
  }
}

async function restartLocalHyperdrive () {
  if (!storageDir || !localDriveKeyHex) return false
  try {
    store = new Corestore(storageDir)
    const reopened = new Hyperdrive(store, localDriveKeyHex)
    await reopened.ready()
    drive = reopened
    await announceLocalDriveOnSwarm()
    console.warn('[Hyperdrive] restartLocalHyperdrive: store/drive recreated')
    return true
  } catch (e) {
    console.error('[Hyperdrive] restartLocalHyperdrive failed:', e)
    return false
  }
}

async function reopenLocalDriveIfClosing () {
  if (!store || !localDriveKeyHex) return false
  try {
    const reopened = new Hyperdrive(store, localDriveKeyHex)
    await reopened.ready()
    drive = reopened
    return true
  } catch (e) {
    // If the shared store has been closed, recreate it and the drive
    if (isStoreClosedError(e)) {
      return await restartLocalHyperdrive()
    } else {
      console.error('[Hyperdrive] reopenLocalDrive failed:', e)
      return false
    }
  }
}

/**
 * Store a file and its metadata under the relay's directory.
 * @param {string} identifier - Relay publicIdentifier (npub:alias) or legacy relayKey.
 * @param {string} fileHash - Hash of the file's raw data.
 * @param {Uint8Array|Buffer} data - Raw file data.
 * @param {object} metadata - Additional metadata (e.g. mime type).
 */
export async function storeFile(identifier, fileHash, data, metadata) {
  const hash = crypto.createHash('sha256').update(data).digest('hex')
  if (hash !== fileHash) {
    throw new Error('Hash mismatch')
  }

  const path = relayFilePath(identifier, fileHash)
  let exists = false
  try {
    exists = await drive.exists(path)
  } catch (err) {
    if (isClosingCoreError(err)) {
      console.warn('[Hyperdrive] storeFile detected closing core; reopening local drive...')
      const ok = await reopenLocalDriveIfClosing()
      if (ok) exists = await drive.exists(path)
      else throw err
    } else {
      throw err
    }
  }
  if (exists) {
    console.log(`[Hyperdrive] storeFile skip exists path=${path}`)
    return
  }
  const t0 = Date.now()
  try {
    await drive.put(path, data, { metadata })
  } catch (err) {
    if (isClosingCoreError(err)) {
      console.warn('[Hyperdrive] storeFile.put detected closing core; reopening local drive...')
      const ok = await reopenLocalDriveIfClosing()
      if (ok) {
        await drive.put(path, data, { metadata })
      } else {
        throw err
      }
    } else {
      throw err
    }
  }
  console.log(`[Hyperdrive] storeFile wrote path=${path} bytes=${data?.length || 0} ms=${Date.now() - t0}`)
}

/**
 * Fetch a file from the local Hyperdrive instance.
 * @param {string} identifier - Relay folder identifier (publicIdentifier or relayKey).
 * @param {string} fileHash - Identifier of the file.
 * @returns {Promise<Uint8Array|null>}
 */
export async function getFile(identifier, fileHash) {
  // Hyperdrive.get returns the blob Buffer directly or null
  const path = relayFilePath(identifier, fileHash)
  try {
    const buf = await drive.get(path)
    console.log(`[Hyperdrive] getFile path=${path} found=${!!buf} bytes=${buf?.length || 0}`)
    return buf || null
  } catch (err) {
    // Handle cases where the underlying core is closing/closed
    const msg = err?.message || ''
    const code = err?.code || ''
    const isClosing = isClosingCoreError(err) || isStoreClosedError(err)
    if (isClosing && (store || storageDir) && localDriveKeyHex) {
      try {
        console.warn('[Hyperdrive] getFile detected closing core; reopening local drive...')
        // Reopen the local drive using the same key
        const ok = await reopenLocalDriveIfClosing()
        if (!ok) throw err
        const buf2 = await drive.get(path)
        console.log(`[Hyperdrive] getFile(after reopen) path=${path} found=${!!buf2} bytes=${buf2?.length || 0}`)
        return buf2 || null
      } catch (e2) {
        console.error('[Hyperdrive] getFile reopen failed:', e2)
        return null
      }
    }
    console.error('[Hyperdrive] getFile error:', err)
    return null
  }
}

/**
 * Lightweight existence check for a file path without reading the blob.
 * @param {string} identifier
 * @param {string} fileHash
 * @returns {Promise<boolean>}
 */
export async function fileExists(identifier, fileHash) {
  try {
    const path = relayFilePath(identifier, fileHash)
    let ok = false
    try {
      ok = await drive.exists(path)
    } catch (err) {
      const isClosing = isClosingCoreError(err) || isStoreClosedError(err)
      if (isClosing && (store || storageDir) && localDriveKeyHex) {
        console.warn('[Hyperdrive] fileExists detected closing core; reopening local drive...')
        try {
          const ok2 = await reopenLocalDriveIfClosing()
          if (!ok2) return false
          ok = await drive.exists(path)
        } catch (e2) {
          console.error('[Hyperdrive] fileExists reopen failed:', e2)
          return false
        }
      } else {
        throw err
      }
    }
    return ok
  } catch (_) {
    return false
  }
}

export async function fetchFileFromDrive(driveKey, identifier, fileHash) {
  const remote = new Hyperdrive(store, driveKey)
  await remote.ready()
  try {
    // Join the remote drive topic (cached) to discover peers holding it
    const done = remote.findingPeers()
    const release = await acquireRemoteTopic(remote)
    console.log(`[Fetch] join topic remoteKey=${driveKey} dkey=${b4a.toString(remote.discoveryKey, 'hex')} ident=/${normalizeIdentifier(identifier)} file=${fileHash}`)
    done()
    const path = relayFilePath(identifier, fileHash)
    const t0 = Date.now()
    const buf = await remote.get(path)
    console.log(`[Fetch] remote.get path=${path} found=${!!buf} bytes=${buf?.length || 0} ms=${Date.now() - t0}`)
    return buf || null
  } catch (_) {
    return null
  } finally {
    try {
      await remote.close()
      console.log(`[Fetch] remote drive closed key=${driveKey}`)
    } catch (_) {}
    try { release?.() } catch (_) {}
  }
}

export function watchDrive (onChange) {
  if (!drive) throw new Error('Hyperdrive not initialized')
  let stopped = false
  let currentWatcher = null

  async function runWatcherLoop () {
    while (!stopped) {
      try {
        currentWatcher = drive.watch('/')
        console.log('[Hyperdrive] watch registered for /')
        for await (const [curr, prev] of currentWatcher) {
          try {
            console.log(`[Hyperdrive] update prev=${prev?.version} curr=${curr?.version}`)
            let c = 0
            for await (const diff of drive.diff(prev.version, '/')) {
              const entry = diff.left || diff.right
              if (!entry) continue
              const type = diff.left && !diff.right ? 'add' : (!diff.left && diff.right ? 'del' : 'update')
              try {
                if (c < 20) console.log(`[Hyperdrive] diff type=${type} key=${entry.key}`)
                c++
                await onChange({ type, path: entry.key })
              } catch (cbErr) {
                console.error('[Hyperdrive] watch callback error:', cbErr)
              }
            }
          } catch (loopErr) {
            if (isClosingCoreError(loopErr)) {
              console.warn('[Hyperdrive] diff loop detected closing core; attempting reopen...')
              const ok = await reopenLocalDriveIfClosing()
              if (!ok) throw loopErr
              // After reopen, break to restart outer while and re-create watcher
              break
            } else {
              console.error('[Hyperdrive] watch diff error:', loopErr)
            }
          }
        }
        if (!stopped) {
          // Watcher ended unexpectedly (destroyed or stream finished); restart
          console.warn('[Hyperdrive] watcher ended; restarting...')
        }
      } catch (err) {
        if (isClosingCoreError(err)) {
          console.warn('[Hyperdrive] watch detected closing core; attempting reopen...')
          const ok = await reopenLocalDriveIfClosing()
          if (!ok) {
            console.error('[Hyperdrive] watch reopen failed; aborting watcher loop')
            break
          }
          // loop continues to restart watcher
        } else {
          console.error('[Hyperdrive] watch error:', err)
          break
        }
      }
    }
  }

  runWatcherLoop().catch(err => console.error('[Hyperdrive] watcher loop error:', err))

  // Return the first watcher for compatibility (not used by callers currently)
  return currentWatcher
}

/**
 * Get replication health metrics for the local Hyperdrive.
 * @returns {Object}
 */
export function getReplicationHealth () {
  const topics = []
  for (const [key, entry] of topicCache.entries()) {
    topics.push({
      discoveryKey: key,
      refCount: entry.refCount,
      lastUsed: entry.lastUsed
    })
  }
  return {
    driveKey: drive ? b4a.toString(drive.key, 'hex') : null,
    discoveryKey: drive ? b4a.toString(drive.discoveryKey, 'hex') : null,
    openConnections: replicationConnectionsOpen,
    totalConnections: replicationConnectionsTotal,
    topicsJoined: topicCache.size,
    topics
  }
}
