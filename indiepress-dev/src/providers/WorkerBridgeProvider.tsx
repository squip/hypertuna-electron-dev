import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from 'react'
import {
  electronIpc,
  GatewayLogEntry,
  GatewayStatus,
  PublicGatewayStatus,
  RelayEntry
} from '@/services/electron-ipc.service'
import { isElectron } from '@/lib/platform'

type WorkerBridgeContextValue = {
  isElectron: boolean
  ready: boolean
  relays: RelayEntry[]
  gatewayStatus: GatewayStatus | null
  publicGatewayStatus: PublicGatewayStatus | null
  gatewayLogs: GatewayLogEntry[]
  lastError: string | null
  startWorker: () => Promise<void>
  stopWorker: () => Promise<void>
  sendToWorker: (message: unknown) => Promise<void>
}

const WorkerBridgeContext = createContext<WorkerBridgeContextValue | undefined>(undefined)

const MAX_LOGS = 500

export function WorkerBridgeProvider({ children }: PropsWithChildren<{}>) {
  const [ready, setReady] = useState(false)
  const [relays, setRelays] = useState<RelayEntry[]>([])
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const [publicGatewayStatus, setPublicGatewayStatus] = useState<PublicGatewayStatus | null>(null)
  const [gatewayLogs, setGatewayLogs] = useState<GatewayLogEntry[]>([])
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => {
    if (!isElectron()) return

    const unsubscribers: Array<() => void> = []

    unsubscribers.push(
      electronIpc.onWorkerMessage((msg) => {
        if (!msg || typeof msg !== 'object') return
        switch (msg.type) {
          case 'relay-update':
            if (Array.isArray(msg.relays)) setRelays(msg.relays)
            break
          case 'relay-created':
          case 'relay-joined':
            // let relay-update events drive the main list; optionally merge here
            break
          case 'relay-disconnected':
            setRelays((prev) => prev.filter((r) => r.relayKey !== msg?.data?.relayKey))
            break
          case 'gateway-status':
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
          case 'public-gateway-status':
            setPublicGatewayStatus(msg.state || msg.status || null)
            break
          case 'public-gateway-config':
            // could cache config if needed
            break
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
        setLastError(`Worker exited with code ${code}`)
        setReady(false)
      })
    )

    // Initial fetches to warm state
    electronIpc
      .getGatewayStatus()
      .then((res) => {
        if (res?.success) setGatewayStatus(res.status || null)
      })
      .catch(() => {})

    electronIpc
      .getGatewayLogs()
      .then((res) => {
        if (res?.success && Array.isArray(res.logs)) {
          setGatewayLogs(res.logs.slice(-MAX_LOGS))
        }
      })
      .catch(() => {})

    electronIpc
      .getPublicGatewayStatus()
      .then((res) => {
        if (res?.success) setPublicGatewayStatus(res.status || null)
      })
      .catch(() => {})

    // Request current relays
    electronIpc.sendToWorker({ type: 'get-relays' }).catch(() => {})

    setReady(true)

    return () => {
      unsubscribers.forEach((u) => {
        try {
          u()
        } catch (_) {}
      })
    }
  }, [])

  const value = useMemo<WorkerBridgeContextValue>(
    () => ({
      isElectron: isElectron(),
      ready,
      relays,
      gatewayStatus,
      publicGatewayStatus,
      gatewayLogs,
      lastError,
      startWorker: async () => {
        if (!isElectron()) throw new Error('Electron IPC unavailable')
        const res = await electronIpc.startWorker()
        if (!res?.success) throw new Error(res?.error || 'Failed to start worker')
        setReady(true)
      },
      stopWorker: async () => {
        if (!isElectron()) throw new Error('Electron IPC unavailable')
        const res = await electronIpc.stopWorker()
        if (!res?.success) throw new Error(res?.error || 'Failed to stop worker')
        setReady(false)
      },
      sendToWorker: async (message: unknown) => {
        if (!isElectron()) throw new Error('Electron IPC unavailable')
        const res = await electronIpc.sendToWorker(message)
        if (!res?.success) throw new Error(res?.error || 'Worker rejected message')
      }
    }),
    [ready, relays, gatewayStatus, publicGatewayStatus, gatewayLogs, lastError]
  )

  return <WorkerBridgeContext.Provider value={value}>{children}</WorkerBridgeContext.Provider>
}

export function useWorkerBridge() {
  const ctx = useContext(WorkerBridgeContext)
  if (!ctx) throw new Error('useWorkerBridge must be used within WorkerBridgeProvider')
  return ctx
}
