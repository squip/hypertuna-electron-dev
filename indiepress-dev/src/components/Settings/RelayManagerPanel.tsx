import { FormEvent, useMemo, useState } from 'react'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { electronIpc } from '@/services/electron-ipc.service'
import { isElectron } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'

export default function RelayManagerPanel() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [webCtaOpen, setWebCtaOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createPublic, setCreatePublic] = useState(true)
  const [createBusy, setCreateBusy] = useState(false)
  const [joinKey, setJoinKey] = useState('')
  const [joinToken, setJoinToken] = useState('')
  const [joinBusy, setJoinBusy] = useState(false)
  const { relays, lastError } = useWorkerBridge()
  const desktopDownloadUrl = useMemo(
    () => import.meta.env.VITE_DESKTOP_DOWNLOAD_URL || 'https://hypertuna.com/download',
    []
  )

  if (!isElectron()) {
    return (
      <>
        <div className="rounded-lg border border-border/50 bg-muted/40 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-semibold">Hypertuna relays</div>
              <div className="text-sm text-muted-foreground">
                Manage relays in the desktop app. You can still connect to them here via public-gateway
                URLs.
              </div>
            </div>
            <Button size="sm" onClick={() => setWebCtaOpen(true)}>
              Create relay
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Join and create actions are desktop-only. Download the app to manage your relays.
          </div>
        </div>

        <Dialog open={webCtaOpen} onOpenChange={setWebCtaOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Hypertuna relays</DialogTitle>
              <DialogDescription>
                Available in the desktop app. Download to create or manage relays locally.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex flex-col sm:flex-row sm:justify-end sm:space-x-2">
              <Button variant="outline" onClick={() => setWebCtaOpen(false)}>
                Close
              </Button>
              <Button asChild>
                <a href={desktopDownloadUrl} target="_blank" rel="noreferrer">
                  Download desktop app
                </a>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  const refreshRelays = async () => {
    setBusy(true)
    setError(null)
    try {
      await electronIpc.sendToWorker({ type: 'get-relays' })
    } catch (err: any) {
      setError(err?.message || 'Failed to refresh relays')
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setCreateBusy(true)
    setError(null)
    try {
      const res = await electronIpc.sendToWorker({
        type: 'create-relay',
        data: {
          name: createName || undefined,
          description: createDescription || undefined,
          isPublic: createPublic
        }
      })
      if (!res?.success) throw new Error(res?.error || 'Create failed')
      setCreateOpen(false)
      setCreateName('')
      setCreateDescription('')
      await refreshRelays()
    } catch (err: any) {
      setError(err?.message || 'Failed to create relay')
    } finally {
      setCreateBusy(false)
    }
  }

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault()
    setJoinBusy(true)
    setError(null)
    try {
      const identifier = joinKey.trim()
      const res = await electronIpc.sendToWorker({
        type: 'join-relay',
        data: {
          relayKey: identifier || undefined,
          publicIdentifier: identifier && identifier.includes(':') ? identifier : undefined,
          authToken: joinToken || undefined
        }
      })
      if (!res?.success) throw new Error(res?.error || 'Join failed')
      setJoinOpen(false)
      setJoinKey('')
      setJoinToken('')
      await refreshRelays()
    } catch (err: any) {
      setError(err?.message || 'Failed to join relay')
    } finally {
      setJoinBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">Hypertuna relays</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setJoinOpen(true)}>
            Join relay
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            Create relay
          </Button>
          <Button size="sm" variant="outline" onClick={refreshRelays} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>
      {(error || lastError) && (
        <div className="text-sm text-red-500">{error || lastError}</div>
      )}
      {!relays.length && (
        <div className="text-sm text-muted-foreground">No relays reported by worker yet.</div>
      )}
      <div className="space-y-2">
        {relays.map((relay) => (
          <div
            key={relay.relayKey}
            className="rounded-md border border-border/50 bg-background/60 p-3 space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium truncate">{relay.publicIdentifier || relay.relayKey}</div>
              <div className="flex items-center gap-2">
                {relay.registrationStatus && (
                  <Badge variant="outline" className="capitalize">
                    {relay.registrationStatus}
                  </Badge>
                )}
                {relay.requiresAuth && <Badge variant="secondary">Auth</Badge>}
              </div>
            </div>
            {relay.connectionUrl && (
              <div className="text-xs text-muted-foreground break-all">
                {relay.connectionUrl}
              </div>
            )}
            {relay.registrationError && (
              <div className="text-xs text-red-500">{relay.registrationError}</div>
            )}
          </div>
        ))}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create relay</DialogTitle>
            <DialogDescription>Create a new Hypertuna relay on this device.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleCreate}>
            <div className="space-y-2">
              <Label htmlFor="relay-name">Name</Label>
              <Input
                id="relay-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="My Relay"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="relay-description">Description</Label>
              <Textarea
                id="relay-description"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="Optional description"
              />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="space-y-0.5">
                <div className="font-medium text-sm">Public</div>
                <div className="text-xs text-muted-foreground">
                  Make this relay discoverable via the gateway.
                </div>
              </div>
              <Switch checked={createPublic} onCheckedChange={setCreatePublic} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createBusy}>
                {createBusy ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Join relay</DialogTitle>
            <DialogDescription>Join an existing Hypertuna relay by key or public identifier.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleJoin}>
            <div className="space-y-2">
              <Label htmlFor="relay-key">Relay key or public identifier</Label>
              <Input
                id="relay-key"
                value={joinKey}
                onChange={(e) => setJoinKey(e.target.value)}
                placeholder="relay key or npub:relayName"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="relay-token">Auth token (optional)</Label>
              <Input
                id="relay-token"
                value={joinToken}
                onChange={(e) => setJoinToken(e.target.value)}
                placeholder="Token if required"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setJoinOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={joinBusy}>
                {joinBusy ? 'Joining…' : 'Join'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
