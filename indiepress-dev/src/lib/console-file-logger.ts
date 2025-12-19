import { electronIpc } from '@/services/electron-ipc.service'
import { isElectron } from './platform'

let logFilePath: string | null = null

async function initLogFilePath() {
  if (!isElectron()) return
  try {
    logFilePath = await electronIpc.getLogFilePath()
  } catch (err) {
    console.warn('[LogFile] Failed to resolve log file path', err)
    logFilePath = null
  }
}

function writeLog(level: 'log' | 'info' | 'warn' | 'error', args: any[]) {
  if (!isElectron()) return
  if (!electronIpc.appendLogLine) return

  const message = args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return '[Unserializable]'
      }
    })
    .join(' ')

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`
  electronIpc.appendLogLine(line).catch(() => {})
}

export function installConsoleFileLogger() {
  if (!isElectron()) return
  initLogFilePath().catch(() => {})

  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: any[]) => {
      writeLog(level, args)
      original(...args)
    }
  }
}

export function getLogFilePath() {
  return logFilePath
}

