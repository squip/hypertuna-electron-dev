import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  electronIpc,
  WorkerStartResult,
  GatewayLogEntry,
  GatewayStatus,
  PublicGatewayStatus,
  RelayEntry
} from '@/services/electron-ipc.service'
import { isElectron } from '@/lib/platform'
import { useNostr } from '@/providers/NostrProvider'

type WorkerStatusPhase =
  | 'starting'
  | 'waiting-config'
  | 'config-applied'
  | 'initializing'
  | 'gateway-starting'
  | 'gateway-ready'
  | 'relays-loading'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error'

type WorkerStatusState = {
  user: { pubkeyHex?: string | null; userKey?: string | null } | null
  app: { initialized: boolean; mode: string | null; shuttingDown: boolean }
  gateway: { ready: boolean; running: boolean }
  relays: { expected: number; active: number }
}

type WorkerStatusV1 = {
  type: 'status'
  v: 1
  ts: number
  sessionId: string
  phase: WorkerStatusPhase
  message: string
  state: WorkerStatusState
  error?: { message: string; stack?: string | null }
}

type WorkerConfigAppliedV1 = {
  type: 'config-applied'
  v: 1
  ts: number
  sessionId: string
  data: unknown
}

type WorkerLifecycle =
  | 'unavailable'
  | 'needs-auth'
  | 'idle'
  | 'starting'
  | 'initializing'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'restarting'
  | 'error'

type PublicGatewayTokenResult = {
  relayKey: string
  token: string
  connectionUrl: string
  expiresAt?: number
  ttlSeconds?: number
  gatewayPath?: string
  baseUrl?: string
  issuedForPubkey?: string
  refreshAfter?: number | null
  sequence?: string | null
}

type JoinAuthProgress = 'request' | 'verify' | 'complete'

type JoinFlowPhase =
  | 'idle'
  | 'starting'
  | 'request'
  | 'verify'
  | 'complete'
  | 'success'
  | 'error'

type JoinFlowState = {
  publicIdentifier: string
  phase: JoinFlowPhase
  startedAt: number
  updatedAt: number
  hostPeers?: string[]
  hostPeer?: string | null
  relayKey?: string | null
  authToken?: string | null
  relayUrl?: string | null
  error?: string | null
}

type RelayCreateRequest = {
  name: string
  description?: string
  isPublic?: boolean
  isOpen?: boolean
  fileSharing?: boolean
}

type RelayCreatedPayload = {
  success: boolean
  relayKey?: string
  publicIdentifier?: string
  relayUrl?: string
  authToken?: string
  error?: string
  name?: string
  description?: string
  isPublic?: boolean
  isOpen?: boolean
  fileSharing?: boolean
  gatewayRegistration?: string
  registrationError?: string
  members?: string[]
}

type WorkerBridgeContextValue = {
  isElectron: boolean
  ready: boolean
  lifecycle: WorkerLifecycle
  readinessMessage: string
  autostartEnabled: boolean
  setAutostartEnabled: (enabled: boolean) => void
  sessionStopRequested: boolean
  statusV1: WorkerStatusV1 | null
  configAppliedV1: WorkerConfigAppliedV1 | null
  relays: RelayEntry[]
  gatewayStatus: GatewayStatus | null
  publicGatewayStatus: PublicGatewayStatus | null
  publicGatewayToken: PublicGatewayTokenResult | null
  joinFlows: Record<string, JoinFlowState>
  gatewayLogs: GatewayLogEntry[]
  workerStdout: string[]
  workerStderr: string[]
  lastError: string | null
  startWorker: () => Promise<void>
  stopWorker: () => Promise<void>
  restartWorker: () => Promise<void>
  sendToWorker: (message: unknown) => Promise<void>
  createRelay: (data: RelayCreateRequest) => Promise<RelayCreatedPayload>
  startJoinFlow: (publicIdentifier: string, opts?: { fileSharing?: boolean }) => Promise<void>
  clearJoinFlow: (publicIdentifier: string) => void
}

const WorkerBridgeContext = createContext<WorkerBridgeContextValue | undefined>(undefined)

const MAX_LOGS = 500
const MAX_OUTPUT_LINES = 250
const AUTOSTART_KEY = 'hypertuna_worker_autostart_enabled'
const RESTART_DELAYS_MS = [1000, 3000, 10000, 30000]

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)
}

function readAutostartEnabled(): boolean {
  try {
    const stored = window.localStorage.getItem(AUTOSTART_KEY)
    if (stored == null) return true
    return stored === '1' || stored === 'true'
  } catch (_) {
    return true
  }
}

function phaseToLifecycle(phase: WorkerStatusPhase): WorkerLifecycle {
  switch (phase) {
    case 'starting':
    case 'waiting-config':
      return 'starting'
    case 'config-applied':
    case 'initializing':
    case 'gateway-starting':
    case 'gateway-ready':
    case 'relays-loading':
      return 'initializing'
    case 'ready':
      return 'ready'
    case 'stopping':
      return 'stopping'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
  }
}

function readinessMessageForStatus(status: WorkerStatusV1 | null): string {
  if (!status) return 'Stopped'

  const active = status.state?.relays?.active ?? 0
  const expected = status.state?.relays?.expected ?? 0
  const gatewayReady = status.state?.gateway?.ready ?? false

  switch (status.phase) {
    case 'starting':
      return 'Starting Hypertuna worker…'
    case 'waiting-config':
      return 'Waiting for account config…'
    case 'config-applied':
      return 'Config applied. Initializing…'
    case 'initializing':
      return 'Initializing relay server…'
    case 'gateway-starting':
      return 'Starting gateway…'
    case 'gateway-ready':
      return gatewayReady ? 'Gateway ready.' : 'Gateway not ready (timeout).'
    case 'relays-loading':
      return 'Loading relays…'
    case 'ready': {
      const suffix = expected > 0 ? ` (${active}/${expected} relays active)` : ''
      const gatewaySuffix = gatewayReady ? '' : ' (gateway not ready)'
      return `Ready${suffix}${gatewaySuffix}`
    }
    case 'stopping':
      return 'Stopping…'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return status.error?.message ? `Error: ${status.error.message}` : 'Error'
  }
}

export function WorkerBridgeProvider({ children }: PropsWithChildren) {
  const nostr = useNostr()
  const pubkeyHex = nostr.pubkey
  const nsecHex = nostr.nsecHex
  const identityReady = isHex64(pubkeyHex) && isHex64(nsecHex)

  const [autostartEnabled, setAutostartEnabledState] = useState(readAutostartEnabled)
  const [sessionStopRequested, setSessionStopRequested] = useState(false)
  const [lifecycle, setLifecycle] = useState<WorkerLifecycle>(() =>
    isElectron() ? 'idle' : 'unavailable'
  )
  const [statusV1, setStatusV1] = useState<WorkerStatusV1 | null>(null)
  const [configAppliedV1, setConfigAppliedV1] = useState<WorkerConfigAppliedV1 | null>(null)
  const [relays, setRelays] = useState<RelayEntry[]>([])
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const [publicGatewayStatus, setPublicGatewayStatus] = useState<PublicGatewayStatus | null>(null)
  const [publicGatewayToken, setPublicGatewayToken] = useState<PublicGatewayTokenResult | null>(null)
  const [joinFlows, setJoinFlows] = useState<Record<string, JoinFlowState>>({})
  const [gatewayLogs, setGatewayLogs] = useState<GatewayLogEntry[]>([])
  const [workerStdout, setWorkerStdout] = useState<string[]>([])
  const [workerStderr, setWorkerStderr] = useState<string[]>([])
  const [lastError, setLastError] = useState<string | null>(null)

  const restartAttemptRef = useRef(0)
  const restartTimeoutRef = useRef<number | null>(null)
  const lastIdentityRef = useRef<{ pubkeyHex: string | null; nsecHex: string | null } | null>(null)
  const warmSessionIdsRef = useRef(new Set<string>())
  const inFlightStartRef = useRef(false)
  const autostartEnabledRef = useRef(autostartEnabled)
  const sessionStopRequestedRef = useRef(sessionStopRequested)
  const identityReadyRef = useRef(identityReady)
  const relayCreateResolversRef = useRef<
    Array<{
      resolve: (payload: RelayCreatedPayload) => void
      reject: (err: Error) => void
      timeoutId: number
    }>
  >([])

  useEffect(() => {
    autostartEnabledRef.current = autostartEnabled
  }, [autostartEnabled])

  useEffect(() => {
    sessionStopRequestedRef.current = sessionStopRequested
  }, [sessionStopRequested])

  useEffect(() => {
    identityReadyRef.current = identityReady
  }, [identityReady])

  const clearRestartTimeout = useCallback(() => {
    if (restartTimeoutRef.current == null) return
    window.clearTimeout(restartTimeoutRef.current)
    restartTimeoutRef.current = null
  }, [])

  const setAutostartEnabled = useCallback((enabled: boolean) => {
    autostartEnabledRef.current = enabled
    setAutostartEnabledState(enabled)
    try {
      window.localStorage.setItem(AUTOSTART_KEY, enabled ? '1' : '0')
    } catch (err) {
      void err
    }
  }, [])

  const buildWorkerConfig = useCallback(() => {
    if (!isHex64(pubkeyHex) || !isHex64(nsecHex)) {
      throw new Error('Hypertuna worker requires a local nsec/ncryptsec account in Electron.')
    }
    return { nostr_pubkey_hex: pubkeyHex.toLowerCase(), nostr_nsec_hex: nsecHex.toLowerCase() }
  }, [pubkeyHex, nsecHex])

  const startWorkerInternal = useCallback(
    async ({ resetRestartAttempts }: { resetRestartAttempts: boolean }) => {
      if (!isElectron()) throw new Error('Electron IPC unavailable')
      if (!identityReady) throw new Error('Hypertuna worker requires nsec/ncryptsec login in Electron.')

      if (inFlightStartRef.current) return
      inFlightStartRef.current = true

      clearRestartTimeout()
      if (resetRestartAttempts) restartAttemptRef.current = 0
      setLastError(null)
      setLifecycle('starting')

      try {
        const config = buildWorkerConfig()
        const res: WorkerStartResult = await electronIpc.startWorker(config)
        if (!res?.success) {
          throw new Error(res?.error || 'Failed to start worker')
        }
      } finally {
        inFlightStartRef.current = false
      }
    },
    [buildWorkerConfig, clearRestartTimeout, identityReady]
  )

  const clearJoinFlow = useCallback((publicIdentifier: string) => {
    const key = String(publicIdentifier || '').trim()
    if (!key) return
    setJoinFlows((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const startJoinFlowInternal = useCallback(
    async (publicIdentifier: string, opts?: { fileSharing?: boolean }) => {
      if (!isElectron()) throw new Error('Electron IPC unavailable')
      const identifier = String(publicIdentifier || '').trim()
      if (!identifier || !identifier.includes(':')) {
        throw new Error('Expected a public identifier in the form npub:relayName')
      }

      setJoinFlows((prev) => ({
        ...prev,
        [identifier]: {
          publicIdentifier: identifier,
          phase: 'starting',
          startedAt: Date.now(),
          updatedAt: Date.now(),
          error: null
        }
      }))

      if (!statusV1) {
        await startWorkerInternal({ resetRestartAttempts: false })
      }

      // The gateway is the source of truth for relay host peers. Ensure it's running.
      if (!gatewayStatus?.running) {
        await electronIpc.sendToWorker({ type: 'start-gateway', options: {} }).catch(() => {})
      }

      // Refresh gateway status so peerRelayMap is as current as possible.
      await electronIpc.sendToWorker({ type: 'get-gateway-status' }).catch(() => {})

      const fileSharing = opts?.fileSharing !== false

      // Best-effort host peer discovery fast-path; worker has a fallback too.
      let hostPeers: string[] | undefined
      try {
        const peerRelayMap = gatewayStatus?.peerRelayMap
        const entry =
          peerRelayMap?.[identifier] ||
          (identifier.includes(':') ? peerRelayMap?.[identifier.replace(':', '/')] : null)
        if (Array.isArray(entry?.peers) && entry.peers.length) {
          hostPeers = entry.peers.map((p) => String(p || '').trim()).filter(Boolean)
        }
      } catch (err) {
        void err
      }

      const data: any = { publicIdentifier: identifier, fileSharing }
      if (hostPeers && hostPeers.length) data.hostPeers = hostPeers

      await electronIpc.sendToWorker({ type: 'start-join-flow', data })

      setJoinFlows((prev) => {
        const current = prev[identifier]
        if (!current) return prev
        return {
          ...prev,
          [identifier]: {
            ...current,
            hostPeers,
            updatedAt: Date.now()
          }
        }
      })
    },
    [gatewayStatus, startWorkerInternal, statusV1]
  )

  const createRelayInternal = useCallback(
    async (data: RelayCreateRequest): Promise<RelayCreatedPayload> => {
      if (!isElectron()) throw new Error('Electron IPC unavailable')
      if (!data?.name?.trim()) throw new Error('Relay name is required')

      if (!statusV1) {
        await startWorkerInternal({ resetRestartAttempts: false })
      }

      return await new Promise<RelayCreatedPayload>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          const pending = relayCreateResolversRef.current
          const idx = pending.findIndex((r) => r.timeoutId === timeoutId)
          if (idx >= 0) pending.splice(idx, 1)
          reject(new Error('Timed out waiting for relay-created'))
        }, 60_000)

        relayCreateResolversRef.current.push({
          timeoutId,
          resolve: (payload) => {
            window.clearTimeout(timeoutId)
            resolve(payload)
          },
          reject: (err) => {
            window.clearTimeout(timeoutId)
            reject(err)
          }
        })

        electronIpc
          .sendToWorker({ type: 'create-relay', data })
          .then((res) => {
            if (res?.success) return
            const pending = relayCreateResolversRef.current
            const current = pending.find((r) => r.timeoutId === timeoutId)
            if (current) {
              pending.splice(pending.indexOf(current), 1)
              window.clearTimeout(timeoutId)
              current.reject(new Error(res?.error || 'Worker rejected create-relay'))
            } else {
              reject(new Error(res?.error || 'Worker rejected create-relay'))
            }
          })
          .catch((err) => {
            const pending = relayCreateResolversRef.current
            const current = pending.find((r) => r.timeoutId === timeoutId)
            if (current) {
              pending.splice(pending.indexOf(current), 1)
              window.clearTimeout(timeoutId)
              current.reject(err instanceof Error ? err : new Error(String(err)))
            } else {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })
      })
    },
    [startWorkerInternal, statusV1]
  )

  const warmWorkerState = useCallback(
    async (sessionId: string) => {
      if (warmSessionIdsRef.current.has(sessionId)) return
      warmSessionIdsRef.current.add(sessionId)

      try {
        const [gwStatus, gwLogs, pgStatus] = await Promise.allSettled([
          electronIpc.getGatewayStatus(),
          electronIpc.getGatewayLogs(),
          electronIpc.getPublicGatewayStatus()
        ])

        if (gwStatus.status === 'fulfilled' && gwStatus.value?.success) {
          setGatewayStatus(gwStatus.value.status || null)
        }
        if (gwLogs.status === 'fulfilled' && gwLogs.value?.success && Array.isArray(gwLogs.value.logs)) {
          setGatewayLogs(gwLogs.value.logs.slice(-MAX_LOGS))
        }
        if (pgStatus.status === 'fulfilled' && pgStatus.value?.success) {
          setPublicGatewayStatus(pgStatus.value.status || null)
        }
      } catch (err) {
        void err
      }

      electronIpc.sendToWorker({ type: 'get-relays' }).catch(() => {})
    },
    [setGatewayLogs, setGatewayStatus, setPublicGatewayStatus]
  )

  const stopWorkerInternal = useCallback(
    async ({ markSessionStopped }: { markSessionStopped: boolean }) => {
      if (!isElectron()) throw new Error('Electron IPC unavailable')
      clearRestartTimeout()
      restartAttemptRef.current = 0
      warmSessionIdsRef.current.clear()
      if (markSessionStopped) {
        sessionStopRequestedRef.current = true
        setSessionStopRequested(true)
      }

      setLifecycle('stopping')
      setLastError(null)

      const res = await electronIpc.stopWorker()
      if (!res?.success) {
        setLastError(res?.error || 'Failed to stop worker')
      }

      setStatusV1(null)
      setConfigAppliedV1(null)
      setRelays([])
      setGatewayStatus(null)
      setPublicGatewayStatus(null)
      setPublicGatewayToken(null)
      setJoinFlows({})
      relayCreateResolversRef.current.forEach(({ reject, timeoutId }) => {
        window.clearTimeout(timeoutId)
        reject(new Error('Worker stopped'))
      })
      relayCreateResolversRef.current = []
      setLifecycle('stopped')
    },
    [clearRestartTimeout]
  )

  const scheduleAutoRestart = useCallback(() => {
    clearRestartTimeout()

    const attempt = restartAttemptRef.current + 1
    restartAttemptRef.current = attempt
    const delay = RESTART_DELAYS_MS[Math.min(attempt - 1, RESTART_DELAYS_MS.length - 1)]

    if (attempt > RESTART_DELAYS_MS.length) {
      setLifecycle('error')
      setLastError('Worker crashed repeatedly. Click Restart to try again.')
      return
    }

    setLifecycle('restarting')
    setLastError(`Worker exited. Restarting in ${Math.round(delay / 1000)}s (attempt ${attempt})…`)

    restartTimeoutRef.current = window.setTimeout(() => {
      startWorkerInternal({ resetRestartAttempts: false }).catch((err) => {
        setLifecycle('error')
        setLastError(err?.message || String(err))
      })
    }, delay)
  }, [clearRestartTimeout, startWorkerInternal])

  useEffect(() => {
    if (!isElectron()) return

    const unsubscribers: Array<() => void> = []

    unsubscribers.push(
      electronIpc.onWorkerMessage((msg) => {
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'status' && msg.v === 1) {
          const status = msg as WorkerStatusV1
          setStatusV1(status)
          setLifecycle(phaseToLifecycle(status.phase))
          if (status.phase === 'ready') {
            restartAttemptRef.current = 0
          }
          warmWorkerState(status.sessionId)
          return
        }
        if (msg.type === 'config-applied' && msg.v === 1) {
          const applied = msg as WorkerConfigAppliedV1
          setConfigAppliedV1(applied)
          warmWorkerState(applied.sessionId)
          return
        }
        switch (msg.type) {
          case 'relay-update':
            if (Array.isArray(msg.relays)) setRelays(msg.relays)
            break
          case 'relay-created':
            if (relayCreateResolversRef.current.length) {
              const resolver = relayCreateResolversRef.current.shift()
              if (resolver) {
                const payload = (msg?.data || {}) as RelayCreatedPayload
                if (payload?.success) resolver.resolve(payload)
                else resolver.reject(new Error(payload?.error || 'Failed to create relay'))
              }
            }
            // let relay-update events drive the main list; optionally merge here
            break
          case 'relay-joined':
            // let relay-update events drive the main list; optionally merge here
            break
          case 'relay-disconnected':
            setRelays((prev) => prev.filter((r) => r.relayKey !== msg?.data?.relayKey))
            break
          case 'gateway-status':
            setGatewayStatus(msg.status || null)
            break
          case 'gateway-started':
            setGatewayStatus(msg.status || null)
            break
          case 'gateway-logs':
            if (Array.isArray(msg.logs)) {
              const next = [...msg.logs].slice(-MAX_LOGS)
              setGatewayLogs(next)
            }
            break
          case 'gateway-log':
            if (msg.entry) {
              setGatewayLogs((prev) => {
                const next = [...prev, msg.entry]
                return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
              })
            }
            break
          case 'gateway-stopped':
            setGatewayStatus(msg.status || null)
            break
          case 'public-gateway-status':
            setPublicGatewayStatus(msg.state || msg.status || null)
            break
          case 'public-gateway-config':
            // could cache config if needed
            break
          case 'public-gateway-token':
            if (msg.result && typeof msg.result === 'object') {
              setPublicGatewayToken(msg.result as PublicGatewayTokenResult)
            }
            break
          case 'public-gateway-token-error':
            setLastError(msg.error || 'Failed to issue public gateway token')
            break
          case 'join-auth-progress': {
            const identifier = msg?.data?.publicIdentifier
            const progress: JoinAuthProgress | null =
              msg?.data?.status === 'request' || msg?.data?.status === 'verify' || msg?.data?.status === 'complete'
                ? msg.data.status
                : null
            if (!identifier || !progress) break
            setJoinFlows((prev) => {
              const current = prev[identifier]
              const startedAt = current?.startedAt ?? Date.now()
              return {
                ...prev,
                [identifier]: {
                  publicIdentifier: identifier,
                  phase: progress,
                  startedAt,
                  updatedAt: Date.now(),
                  hostPeers: current?.hostPeers,
                  hostPeer: current?.hostPeer ?? null,
                  relayKey: current?.relayKey ?? null,
                  authToken: current?.authToken ?? null,
                  relayUrl: current?.relayUrl ?? null,
                  error: null
                }
              }
            })
            break
          }
          case 'join-auth-success': {
            const identifier = msg?.data?.publicIdentifier
            if (!identifier) break
            setJoinFlows((prev) => {
              const current = prev[identifier]
              const startedAt = current?.startedAt ?? Date.now()
              return {
                ...prev,
                [identifier]: {
                  publicIdentifier: identifier,
                  phase: 'success',
                  startedAt,
                  updatedAt: Date.now(),
                  hostPeers: current?.hostPeers,
                  hostPeer: msg?.data?.hostPeer || null,
                  relayKey: msg?.data?.relayKey || null,
                  authToken: msg?.data?.authToken || null,
                  relayUrl: msg?.data?.relayUrl || null,
                  error: null
                }
              }
            })
            // Let relay-update events hydrate the full list, but trigger a refresh just in case.
            electronIpc.sendToWorker({ type: 'get-relays' }).catch(() => {})
            break
          }
          case 'join-auth-error': {
            const identifier = msg?.data?.publicIdentifier
            const errorText = msg?.data?.error || 'Join authentication failed'
            if (!identifier) break
            setJoinFlows((prev) => {
              const current = prev[identifier]
              const startedAt = current?.startedAt ?? Date.now()
              return {
                ...prev,
                [identifier]: {
                  publicIdentifier: identifier,
                  phase: 'error',
                  startedAt,
                  updatedAt: Date.now(),
                  hostPeers: current?.hostPeers,
                  hostPeer: current?.hostPeer ?? null,
                  relayKey: current?.relayKey ?? null,
                  authToken: current?.authToken ?? null,
                  relayUrl: current?.relayUrl ?? null,
                  error: errorText
                }
              }
            })
            setLastError(errorText)
            break
          }
          case 'error':
          case 'gateway-error':
          case 'public-gateway-error':
            setLastError(msg.message || 'Unknown worker error')
            break
          default:
            break
        }
      })
    )

    unsubscribers.push(
      electronIpc.onWorkerError((err) => {
        setLastError(err?.message || String(err))
      })
    )

    unsubscribers.push(
      electronIpc.onWorkerExit((code) => {
        warmSessionIdsRef.current.clear()
        setStatusV1(null)
        setConfigAppliedV1(null)
        setRelays([])
        setGatewayStatus(null)
        setPublicGatewayStatus(null)
        setPublicGatewayToken(null)
        setJoinFlows({})
        relayCreateResolversRef.current.forEach(({ reject, timeoutId }) => {
          window.clearTimeout(timeoutId)
          reject(new Error(`Worker exited (${code})`))
        })
        relayCreateResolversRef.current = []
        setLifecycle('stopped')

        const message = `Worker exited (${code})`
        if (sessionStopRequestedRef.current) {
          setLastError(message)
          return
        }
        if (!autostartEnabledRef.current) {
          setLastError(message)
          return
        }
        if (!identityReadyRef.current) {
          setLastError(message)
          return
        }
        setLastError(message)
        scheduleAutoRestart()
      })
    )

    unsubscribers.push(
      electronIpc.onWorkerStdout((data) => {
        setWorkerStdout((prev) => {
          const lines = String(data).split(/\r?\n/).filter(Boolean)
          const next = [...prev, ...lines]
          return next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next
        })
      })
    )

    unsubscribers.push(
      electronIpc.onWorkerStderr((data) => {
        setWorkerStderr((prev) => {
          const lines = String(data).split(/\r?\n/).filter(Boolean)
          const next = [...prev, ...lines]
          return next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next
        })
      })
    )

    return () => {
      unsubscribers.forEach((u) => {
        try {
          u()
        } catch (err) {
          void err
        }
      })
    }
  }, [scheduleAutoRestart, warmWorkerState])

  useEffect(() => {
    if (!isElectron()) {
      setLifecycle('unavailable')
      return
    }

    const next = { pubkeyHex: pubkeyHex ?? null, nsecHex: nsecHex ?? null }
    const prev = lastIdentityRef.current
    lastIdentityRef.current = next

    const prevReady = prev ? isHex64(prev.pubkeyHex) && isHex64(prev.nsecHex) : false
    const nextReady = identityReady
    const identityChanged = !!(
      prev &&
      (prev.pubkeyHex !== next.pubkeyHex || prev.nsecHex !== next.nsecHex)
    )

    const workerIsActive =
      lifecycle === 'starting' ||
      lifecycle === 'initializing' ||
      lifecycle === 'ready' ||
      lifecycle === 'restarting'

    if (identityChanged && prevReady) {
      if (!nextReady) {
        if (workerIsActive) {
          stopWorkerInternal({ markSessionStopped: false }).catch(() => {})
        }
        setLifecycle('needs-auth')
        return
      }

      if (workerIsActive) {
        stopWorkerInternal({ markSessionStopped: false })
          .catch(() => {})
          .finally(() => {
            startWorkerInternal({ resetRestartAttempts: true }).catch((err) => {
              setLifecycle('error')
              setLastError(err?.message || String(err))
            })
          })
        return
      }

      if (autostartEnabled && !sessionStopRequested) {
        startWorkerInternal({ resetRestartAttempts: true }).catch(() => {})
      }
      return
    }

    if (!nextReady) {
      setLifecycle('needs-auth')
      return
    }

    if (autostartEnabled && !sessionStopRequested && !workerIsActive && !statusV1) {
      startWorkerInternal({ resetRestartAttempts: true }).catch(() => {})
    }
  }, [
    autostartEnabled,
    identityReady,
    lifecycle,
    nsecHex,
    pubkeyHex,
    sessionStopRequested,
    startWorkerInternal,
    statusV1,
    stopWorkerInternal
  ])

  const ready = statusV1?.phase === 'ready'

  const readinessMessage = useMemo(() => {
    if (!isElectron()) return 'Desktop-only'
    if (!identityReady) return 'Login with nsec/ncryptsec to enable Hypertuna services.'
    if (lifecycle === 'restarting' || lifecycle === 'starting' || lifecycle === 'initializing') {
      return readinessMessageForStatus(statusV1)
    }
    if (lifecycle === 'ready') return readinessMessageForStatus(statusV1)
    if (lifecycle === 'stopping') return 'Stopping…'
    if (lifecycle === 'stopped' || lifecycle === 'idle') return 'Stopped'
    if (lifecycle === 'error') return lastError ? `Error: ${lastError}` : readinessMessageForStatus(statusV1)
    return readinessMessageForStatus(statusV1)
  }, [identityReady, lastError, lifecycle, statusV1])

  const value = useMemo<WorkerBridgeContextValue>(
    () => ({
      isElectron: isElectron(),
      ready,
      lifecycle,
      readinessMessage,
      autostartEnabled,
      setAutostartEnabled,
      sessionStopRequested,
      statusV1,
      configAppliedV1,
      relays,
      gatewayStatus,
      publicGatewayStatus,
      publicGatewayToken,
      joinFlows,
      gatewayLogs,
      workerStdout,
      workerStderr,
      lastError,
      startWorker: async () => {
        setSessionStopRequested(false)
        await startWorkerInternal({ resetRestartAttempts: true })
      },
      stopWorker: async () => {
        await stopWorkerInternal({ markSessionStopped: true })
      },
      restartWorker: async () => {
        setSessionStopRequested(false)
        await stopWorkerInternal({ markSessionStopped: false }).catch(() => {})
        await startWorkerInternal({ resetRestartAttempts: true })
      },
      sendToWorker: async (message: unknown) => {
        if (!isElectron()) throw new Error('Electron IPC unavailable')
        if (!statusV1) {
          await startWorkerInternal({ resetRestartAttempts: false })
        }
        const res = await electronIpc.sendToWorker(message)
        if (!res?.success) throw new Error(res?.error || 'Worker rejected message')
      },
      createRelay: async (data: RelayCreateRequest) => {
        return await createRelayInternal(data)
      },
      startJoinFlow: async (publicIdentifier: string, opts?: { fileSharing?: boolean }) => {
        await startJoinFlowInternal(publicIdentifier, opts)
      },
      clearJoinFlow
    }),
    [
      autostartEnabled,
      clearJoinFlow,
      configAppliedV1,
      gatewayLogs,
      gatewayStatus,
      joinFlows,
      lastError,
      lifecycle,
      createRelayInternal,
      publicGatewayStatus,
      publicGatewayToken,
      readinessMessage,
      ready,
      relays,
      sessionStopRequested,
      setAutostartEnabled,
      startJoinFlowInternal,
      startWorkerInternal,
      statusV1,
      stopWorkerInternal,
      workerStderr,
      workerStdout
    ]
  )

  return <WorkerBridgeContext.Provider value={value}>{children}</WorkerBridgeContext.Provider>
}

export function useWorkerBridge() {
  const ctx = useContext(WorkerBridgeContext)
  if (!ctx) throw new Error('useWorkerBridge must be used within WorkerBridgeProvider')
  return ctx
}
