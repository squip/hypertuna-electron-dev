import { useEffect, useState } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { electronIpc, PublicGatewayStatus } from '@/services/electron-ipc.service'
import { isElectron } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function PublicGatewayPanel() {
  const { publicGatewayStatus, lastError } = useWorkerBridge()
  const [manualStatus, setManualStatus] = useState<PublicGatewayStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tokenRelayKey, setTokenRelayKey] = useState('')
  const [tokenTtl, setTokenTtl] = useState(3600)
  const [tokenResult, setTokenResult] = useState<string | null>(null)

  if (!isElectron()) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
        <div className="font-semibold mb-1">Public gateway</div>
        <div className="text-sm text-muted-foreground">
          Desktop-only: configure public gateway access in the Electron app.
        </div>
      </div>
    )
  }

  const status = manualStatus || publicGatewayStatus

  const refreshStatus = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await electronIpc.getPublicGatewayStatus()
      if (res?.success) setManualStatus(res.status || null)
      else setError('Failed to fetch status')
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch status')
    } finally {
      setBusy(false)
    }
  }

  const resyncAll = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await electronIpc.refreshPublicGatewayAll()
      if (!res?.success) throw new Error(res?.error || 'Refresh failed')
      await refreshStatus()
    } catch (err: any) {
      setError(err?.message || 'Failed to refresh')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    setTokenResult(null)
  }, [manualStatus, publicGatewayStatus])

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Public gateway</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={refreshStatus} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button size="sm" variant="outline" onClick={resyncAll} disabled={busy}>
            Resync all
          </Button>
        </div>
      </div>
      {(error || lastError) && (
        <div className="text-sm text-red-500">{error || lastError}</div>
      )}
      <div className="flex items-center gap-2 text-sm">
        <Badge variant={status?.enabled ? 'default' : 'outline'}>
          {status?.enabled ? 'Enabled' : 'Disabled'}
        </Badge>
        {status?.baseUrl && <div className="text-muted-foreground">{status.baseUrl}</div>}
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">Registered relays</div>
        {!status?.relays || !Object.keys(status.relays).length ? (
          <div className="text-xs text-muted-foreground">No relays reported.</div>
        ) : (
          <div className="space-y-1 text-xs">
            {Object.entries(status.relays).map(([id, entry]) => (
              <div key={id} className="rounded-md border border-border/50 bg-background/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium truncate">{id}</div>
                  <Badge variant="outline" className="capitalize">
                    {entry?.status || 'unknown'}
                  </Badge>
                </div>
                {entry?.error && <div className="text-red-500">{entry.error}</div>}
                {entry?.lastSyncedAt && (
                  <div className="text-muted-foreground">Last sync: {entry.lastSyncedAt}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Issue access token</div>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr] items-end">
          <div className="space-y-1">
            <Label htmlFor="token-relay">Relay key or identifier</Label>
            <Input
              id="token-relay"
              value={tokenRelayKey}
              onChange={(e) => setTokenRelayKey(e.target.value)}
              placeholder="relay key or npub:relayName"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="token-ttl">TTL (seconds)</Label>
            <Input
              id="token-ttl"
              type="number"
              value={tokenTtl}
              onChange={(e) => setTokenTtl(Number(e.target.value) || 0)}
              min={60}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={async () => {
              setBusy(true)
              setError(null)
              setTokenResult(null)
              try {
                const res = await electronIpc.generatePublicGatewayToken({
                  relayKey: tokenRelayKey || undefined,
                  ttlSeconds: tokenTtl || undefined
                })
                if (!res?.success) throw new Error(res?.error || 'Token generation failed')
                setTokenResult('Token issued. Check worker messages for details.')
              } catch (err: any) {
                setError(err?.message || 'Failed to issue token')
              } finally {
                setBusy(false)
              }
            }}
            disabled={busy || !tokenRelayKey}
          >
            {busy ? 'Issuing…' : 'Generate token'}
          </Button>
          {tokenResult && <div className="text-sm text-muted-foreground">{tokenResult}</div>}
        </div>
      </div>
    </div>
  )
}
