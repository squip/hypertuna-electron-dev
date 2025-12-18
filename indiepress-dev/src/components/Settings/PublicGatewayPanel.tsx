import { useState } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { isElectron } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function PublicGatewayPanel() {
  const { publicGatewayStatus, publicGatewayToken, lastError, sendToWorker } = useWorkerBridge()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tokenRelayKey, setTokenRelayKey] = useState('')
  const [tokenTtl, setTokenTtl] = useState(3600)

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

  const status = publicGatewayStatus
  const tokenExpiresText = (() => {
    const expiresAt = publicGatewayToken?.expiresAt
    if (!expiresAt) return null
    try {
      return new Date(expiresAt).toLocaleString()
    } catch (_) {
      return String(expiresAt)
    }
  })()

  const refreshStatus = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendToWorker({ type: 'get-public-gateway-status' })
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
      await sendToWorker({ type: 'refresh-public-gateway-all' })
      await refreshStatus().catch(() => {})
    } catch (err: any) {
      setError(err?.message || 'Failed to refresh')
    } finally {
      setBusy(false)
    }
  }

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
              try {
                await sendToWorker({
                  type: 'generate-public-gateway-token',
                  relayKey: tokenRelayKey || undefined,
                  ttlSeconds: tokenTtl || undefined
                })
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
        </div>
        {publicGatewayToken && (
          <div className="rounded-md border border-border/50 bg-background/60 p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium truncate">Token for {publicGatewayToken.relayKey}</div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const url = publicGatewayToken.connectionUrl
                  if (!url) return
                  navigator.clipboard?.writeText?.(url).catch(() => {})
                }}
              >
                Copy URL
              </Button>
            </div>
            {tokenExpiresText && (
              <div className="text-muted-foreground">Expires: {tokenExpiresText}</div>
            )}
            <div className="break-all">
              <span className="text-muted-foreground">URL: </span>
              {publicGatewayToken.connectionUrl}
            </div>
            <div className="break-all">
              <span className="text-muted-foreground">Token: </span>
              {publicGatewayToken.token}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
