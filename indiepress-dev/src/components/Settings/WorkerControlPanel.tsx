import { useMemo, useState } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { useNostr } from '@/providers/NostrProvider'
import { isElectron } from '@/lib/platform'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)
}

export default function WorkerControlPanel() {
  const nostr = useNostr()
  const {
    lifecycle,
    readinessMessage,
    autostartEnabled,
    setAutostartEnabled,
    sessionStopRequested,
    ready,
    lastError,
    workerStdout,
    workerStderr,
    startWorker,
    stopWorker,
    restartWorker,
    statusV1
  } = useWorkerBridge()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const identityReady = useMemo(
    () => isHex64(nostr.pubkey) && isHex64(nostr.nsecHex),
    [nostr.nsecHex, nostr.pubkey]
  )

  if (!isElectron()) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
        <div className="font-semibold mb-1">Hypertuna worker</div>
        <div className="text-sm text-muted-foreground">
          Desktop-only: manage local relays and gateway services in the Electron app.
        </div>
      </div>
    )
  }

  const canStart = identityReady && (lifecycle === 'idle' || lifecycle === 'stopped' || lifecycle === 'error')
  const canStop = lifecycle === 'starting' || lifecycle === 'initializing' || lifecycle === 'ready' || lifecycle === 'restarting'
  const canRestart = identityReady && (lifecycle === 'ready' || lifecycle === 'error' || canStop)

  const phase = statusV1?.phase ?? null

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold">Hypertuna worker</div>
          <div className="text-sm text-muted-foreground">{readinessMessage}</div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={ready ? 'default' : 'outline'}>{ready ? 'Ready' : 'Not ready'}</Badge>
          {phase && (
            <Badge variant="outline" className="capitalize">
              {phase}
            </Badge>
          )}
        </div>
      </div>

      {!identityReady && (
        <div className="text-sm text-muted-foreground">
          Hypertuna desktop features require a local <span className="font-medium">nsec</span> or{' '}
          <span className="font-medium">ncryptsec</span> login so the worker can be configured.
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Switch
            checked={autostartEnabled}
            onCheckedChange={(checked) => setAutostartEnabled(!!checked)}
          />
          <Label className="text-sm">Auto-start on next launch</Label>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canStart || busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await startWorker()
              } catch (err: any) {
                setError(err?.message || 'Failed to start worker')
              } finally {
                setBusy(false)
              }
            }}
          >
            Start
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canStop || busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await stopWorker()
              } catch (err: any) {
                setError(err?.message || 'Failed to stop worker')
              } finally {
                setBusy(false)
              }
            }}
          >
            Stop
          </Button>
          <Button
            size="sm"
            disabled={!canRestart || busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await restartWorker()
              } catch (err: any) {
                setError(err?.message || 'Failed to restart worker')
              } finally {
                setBusy(false)
              }
            }}
          >
            Restart
          </Button>
        </div>
      </div>

      {sessionStopRequested && (
        <div className="text-xs text-muted-foreground">
          Worker stopped manually this session (auto-restart is disabled until you press Start/Restart).
        </div>
      )}

      {(error || lastError) && <div className="text-sm text-red-500">{error || lastError}</div>}

      {(workerStdout.length > 0 || workerStderr.length > 0) && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Worker output</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-border/50 bg-background/60 p-2">
              <div className="text-xs text-muted-foreground mb-1">stdout</div>
              <div className="max-h-40 overflow-auto text-xs whitespace-pre-wrap break-words">
                {workerStdout.slice(-120).join('\n') || '—'}
              </div>
            </div>
            <div className="rounded-md border border-border/50 bg-background/60 p-2">
              <div className="text-xs text-muted-foreground mb-1">stderr</div>
              <div className="max-h-40 overflow-auto text-xs whitespace-pre-wrap break-words">
                {workerStderr.slice(-120).join('\n') || '—'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

