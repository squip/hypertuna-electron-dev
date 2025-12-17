// Minimal IPC adapter; no-ops in web mode.
// Extend types as you learn more about worker payload shapes.

import { isElectron } from '@/lib/platform'

export type WorkerCommandResult = { success: boolean; error?: string }

export type RelayEntry = {
  relayKey: string
  publicIdentifier?: string
  connectionUrl?: string
  userAuthToken?: string
  requiresAuth?: boolean
  name?: string
  description?: string
  createdAt?: number
  members?: string[]
  registrationStatus?: string
  registrationError?: string
  isActive?: boolean
  gatewayPath?: string
}

export type GatewayLogEntry = {
  ts?: number | string
  level?: string
  message: string
  data?: unknown
}

export type GatewayStatus = {
  running: boolean
  host?: string
  port?: number
  wsBase?: string
  urls?: Record<string, string>
  startedAt?: number
  relays?: RelayEntry[]
  publicGateway?: PublicGatewayStatus
  peers?: unknown
  metrics?: unknown
}

export type PublicGatewayStatus = {
  enabled?: boolean
  baseUrl?: string
  wsBase?: string
  defaultTokenTtl?: number
  lastUpdatedAt?: number
  relays?: Record<
    string,
    {
      status?: string
      lastSyncedAt?: number
      tokenTtl?: number
      error?: string
    }
  >
}

type ElectronAPI = {
  startWorker: () => Promise<WorkerCommandResult>
  stopWorker: () => Promise<WorkerCommandResult>
  sendToWorker: (message: unknown) => Promise<WorkerCommandResult>

  getGatewayStatus: () => Promise<{ success: boolean; status: GatewayStatus | null }>
  getGatewayLogs: () => Promise<{ success: boolean; logs: GatewayLogEntry[] }>
  startGateway: (options?: unknown) => Promise<WorkerCommandResult>
  stopGateway: () => Promise<WorkerCommandResult>

  getPublicGatewayConfig: () => Promise<{ success: boolean; config: unknown }>
  setPublicGatewayConfig: (config: unknown) => Promise<WorkerCommandResult>
  getPublicGatewayStatus: () => Promise<{ success: boolean; status: PublicGatewayStatus | null }>
  generatePublicGatewayToken: (payload: unknown) => Promise<WorkerCommandResult>
  refreshPublicGatewayRelay: (payload: unknown) => Promise<WorkerCommandResult>
  refreshPublicGatewayAll: () => Promise<WorkerCommandResult>
  readPublicGatewaySettings: () => Promise<{ success: boolean; data: unknown }>
  writePublicGatewaySettings: (settings: unknown) => Promise<WorkerCommandResult>

  readGatewaySettings: () => Promise<{ success: boolean; data: unknown }>
  writeGatewaySettings: (settings: unknown) => Promise<WorkerCommandResult>

  getStoragePath: () => Promise<string>
  getLogFilePath: () => Promise<string>
  appendLogLine: (line: string) => Promise<WorkerCommandResult>
  readFileBuffer: (filePath: string) => Promise<{ success: boolean; data: ArrayBuffer }>

  importModule?: (specifier: string) => Promise<unknown>
  requireModule?: (specifier: string) => unknown

  onWorkerMessage: (cb: (message: any) => void) => () => void
  onWorkerError: (cb: (err: any) => void) => () => void
  onWorkerExit: (cb: (code: number) => void) => () => void
  onWorkerStdout: (cb: (data: string) => void) => () => void
  onWorkerStderr: (cb: (data: string) => void) => () => void
}

function api(): ElectronAPI | null {
  if (!isElectron()) return null
  return (window as any).electronAPI as ElectronAPI
}

function unavailable<T = any>(): Promise<T> {
  return Promise.reject(new Error('Electron IPC unavailable in web mode'))
}

export const electronIpc = {
  isElectron: () => isElectron(),

  startWorker() {
    return api()?.startWorker() ?? unavailable()
  },
  stopWorker() {
    return api()?.stopWorker() ?? unavailable()
  },
  sendToWorker(message: unknown) {
    return api()?.sendToWorker(message) ?? unavailable()
  },

  getGatewayStatus() {
    return api()?.getGatewayStatus() ?? unavailable()
  },
  getGatewayLogs() {
    return api()?.getGatewayLogs() ?? unavailable()
  },
  startGateway(options?: unknown) {
    return api()?.startGateway(options) ?? unavailable()
  },
  stopGateway() {
    return api()?.stopGateway() ?? unavailable()
  },

  getPublicGatewayConfig() {
    return api()?.getPublicGatewayConfig() ?? unavailable()
  },
  setPublicGatewayConfig(config: unknown) {
    return api()?.setPublicGatewayConfig(config) ?? unavailable()
  },
  getPublicGatewayStatus() {
    return api()?.getPublicGatewayStatus() ?? unavailable()
  },
  generatePublicGatewayToken(payload: unknown) {
    return api()?.generatePublicGatewayToken(payload) ?? unavailable()
  },
  refreshPublicGatewayRelay(payload: unknown) {
    return api()?.refreshPublicGatewayRelay(payload) ?? unavailable()
  },
  refreshPublicGatewayAll() {
    return api()?.refreshPublicGatewayAll() ?? unavailable()
  },
  readPublicGatewaySettings() {
    return api()?.readPublicGatewaySettings() ?? unavailable()
  },
  writePublicGatewaySettings(settings: unknown) {
    return api()?.writePublicGatewaySettings(settings) ?? unavailable()
  },

  readGatewaySettings() {
    return api()?.readGatewaySettings() ?? unavailable()
  },
  writeGatewaySettings(settings: unknown) {
    return api()?.writeGatewaySettings(settings) ?? unavailable()
  },

  getStoragePath() {
    return api()?.getStoragePath() ?? unavailable()
  },
  getLogFilePath() {
    return api()?.getLogFilePath() ?? unavailable()
  },
  appendLogLine(line: string) {
    return api()?.appendLogLine(line) ?? unavailable()
  },
  readFileBuffer(filePath: string) {
    return api()?.readFileBuffer(filePath) ?? unavailable()
  },

  onWorkerMessage(cb: (msg: any) => void) {
    return api()?.onWorkerMessage(cb) ?? (() => {})
  },
  onWorkerError(cb: (err: any) => void) {
    return api()?.onWorkerError(cb) ?? (() => {})
  },
  onWorkerExit(cb: (code: number) => void) {
    return api()?.onWorkerExit(cb) ?? (() => {})
  },
  onWorkerStdout(cb: (data: string) => void) {
    return api()?.onWorkerStdout(cb) ?? (() => {})
  },
  onWorkerStderr(cb: (data: string) => void) {
    return api()?.onWorkerStderr(cb) ?? (() => {})
  }
}
