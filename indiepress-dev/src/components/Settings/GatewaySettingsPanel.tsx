import { useEffect, useState } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { electronIpc } from '@/services/electron-ipc.service'
import { isElectron } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function GatewaySettingsPanel() {
  const { gatewayStatus, gatewayLogs, lastError, sendToWorker } = useWorkerBridge()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [proxyHost, setProxyHost] = useState('')
  const [proxyProto, setProxyProto] = useState('wss')
  const [configBusy, setConfigBusy] = useState(false)

  useEffect(() => {
    if (!isElectron()) return
    electronIpc
      .readGatewaySettings()
      .then((res) => {
        if (res?.success && res.data) {
          const data = res.data as any
          if (data.gatewayUrl) setGatewayUrl(data.gatewayUrl)
          if (data.proxyHost) setProxyHost(data.proxyHost)
          if (data.proxyWebsocketProtocol) setProxyProto(data.proxyWebsocketProtocol)
        }
      })
      .catch(() => {})
  }, [])

  if (!isElectron()) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
        <div className="font-semibold mb-1">Local gateway</div>
        <div className="text-sm text-muted-foreground">
          Desktop-only: start/stop gateway and view logs in the Electron app.
        </div>
      </div>
    )
  }

  const status = gatewayStatus

  const refreshStatus = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendToWorker({ type: 'get-gateway-status' })
      await sendToWorker({ type: 'get-gateway-logs' })
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch status')
    } finally {
      setBusy(false)
    }
  }

  const startGateway = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendToWorker({ type: 'start-gateway', options: {} })
      await refreshStatus().catch(() => {})
    } catch (err: any) {
      setError(err?.message || 'Failed to start gateway')
    } finally {
      setBusy(false)
    }
  }

  const stopGateway = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendToWorker({ type: 'stop-gateway' })
      await refreshStatus().catch(() => {})
    } catch (err: any) {
      setError(err?.message || 'Failed to stop gateway')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Local gateway</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={refreshStatus} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button size="sm" variant="outline" onClick={startGateway} disabled={busy}>
            Start
          </Button>
          <Button size="sm" variant="outline" onClick={stopGateway} disabled={busy}>
            Stop
          </Button>
        </div>
      </div>
      {(error || lastError) && (
        <div className="text-sm text-red-500">{error || lastError}</div>
      )}
      <div className="flex items-center gap-2 text-sm">
        <Badge variant={status?.running ? 'default' : 'outline'}>
          {status?.running ? 'Running' : 'Stopped'}
        </Badge>
        {status?.host && status?.port && (
          <div className="text-muted-foreground">
            {status.host}:{status.port} {status.wsBase ? `(${status.wsBase})` : ''}
          </div>
        )}
      </div>
      {status?.urls && (
        <div className="text-xs text-muted-foreground space-y-1">
          {Object.entries(status.urls).map(([key, value]) => (
            <div key={key} className="break-all">
              {key}: {value}
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        <div className="text-sm font-medium">Gateway settings</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="gateway-url">Gateway URL</Label>
            <Input
              id="gateway-url"
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder="https://hypertuna.com"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="proxy-host">Proxy host</Label>
            <Input
              id="proxy-host"
              value={proxyHost}
              onChange={(e) => setProxyHost(e.target.value)}
              placeholder="hypertuna.com"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="proxy-proto">Proxy websocket protocol</Label>
            <Input
              id="proxy-proto"
              value={proxyProto}
              onChange={(e) => setProxyProto(e.target.value)}
              placeholder="wss"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              setConfigBusy(true)
              setError(null)
              try {
                const res = await electronIpc.writeGatewaySettings({
                  gatewayUrl: gatewayUrl || undefined,
                  proxyHost: proxyHost || undefined,
                  proxyWebsocketProtocol: proxyProto || undefined
                })
                if (!res?.success) throw new Error(res?.error || 'Save failed')
              } catch (err: any) {
                setError(err?.message || 'Failed to save gateway settings')
              } finally {
                setConfigBusy(false)
              }
            }}
            disabled={configBusy}
          >
            {configBusy ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">Recent logs</div>
        {!gatewayLogs.length && (
          <div className="text-xs text-muted-foreground">No logs yet.</div>
        )}
        <div className="max-h-48 overflow-auto text-xs space-y-1">
          {gatewayLogs.map((log, idx) => (
            <div key={idx} className="whitespace-pre-line break-words">
              {log.ts ? `[${log.ts}] ` : ''}
              {log.level ? `${log.level}: ` : ''}
              {log.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
