export function useHyperdriveUploads(): boolean {
  // Default to external storage; enable via env or localStorage in future.
  const envFlag = typeof import.meta !== 'undefined' ? import.meta.env.VITE_USE_HYPERDRIVE_UPLOADS : undefined
  if (typeof envFlag === 'string') {
    if (envFlag === '1' || envFlag.toLowerCase() === 'true') return true
  }

  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem('hypertuna_use_hyperdrive_uploads')
      if (stored === '1' || stored === 'true') return true
    } catch (_) {}
  }

  return false
}
