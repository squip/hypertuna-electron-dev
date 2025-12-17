export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

export function isWeb(): boolean {
  return !isElectron()
}
