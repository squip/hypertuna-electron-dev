import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { useGroups } from '@/providers/GroupsProvider'
import { TPageRef } from '@/types'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from 'react-i18next'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Heart, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useSecondaryPage } from '@/PageManager'
import { toGroup } from '@/lib/link'
import GroupCreateDialog from '@/components/GroupCreateDialog'
import { isElectron } from '@/lib/platform'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { SimpleUserAvatar } from '@/components/UserAvatar'
import { useNostr } from '@/providers/NostrProvider'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'

type TTab = 'discover' | 'my' | 'invites'

const makeGroupKey = (groupId: string, relay?: string) => (relay ? `${relay}|${groupId}` : groupId)

function GroupFacepile({ groupId, relay }: { groupId: string; relay?: string }) {
  const { t } = useTranslation()
  const { followList } = useNostr()
  const { fetchGroupDetail } = useGroups()
  const [members, setMembers] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchGroupDetail(groupId, relay)
      .then((d) => {
        if (cancelled) return
        setMembers(d.members || [])
      })
      .catch(() => {
        if (cancelled) return
        setMembers([])
      })
    return () => {
      cancelled = true
    }
  }, [fetchGroupDetail, groupId, relay])

  const sortedMembers = useMemo(() => {
    if (!members || !members.length) return []
    const list = [...members]
    list.sort((a, b) => {
      const aFollow = followList.includes(a)
      const bFollow = followList.includes(b)
      if (aFollow !== bFollow) return aFollow ? -1 : 1
      return 0
    })
    return list.slice(0, 5)
  }, [members, followList])

  if (!members || members.length === 0 || sortedMembers.length === 0) return null

  const countLabel = `${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(
    members.length
  )} ${t('Members')}`

  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2">
        {sortedMembers.map((pubkey) => (
          <div
            key={pubkey}
            className="h-5 w-5 rounded-full ring-2 ring-background overflow-hidden bg-muted"
          >
            <SimpleUserAvatar userId={pubkey} size="small" className="h-full w-full rounded-full" />
          </div>
        ))}
      </div>
      <div className="text-xs text-muted-foreground font-medium whitespace-nowrap">{countLabel}</div>
    </div>
  )
}

const GroupsPage = forwardRef<TPageRef>((_, ref) => {
  const layoutRef = useRef<TPageRef>(null)
  useImperativeHandle(ref, () => layoutRef.current!)
  const { t } = useTranslation()
  const {
    discoveryGroups,
    invites,
    myGroupList,
    refreshDiscovery,
    refreshInvites,
    isLoadingDiscovery,
    discoveryError,
    invitesError,
    createHypertunaRelayGroup
  } =
    useGroups()
  const [tab, setTab] = useState<TTab>('discover')
  const [search, setSearch] = useState('')
  const { push } = useSecondaryPage()
  const [showCreate, setShowCreate] = useState(false)
  const [showCreateActions, setShowCreateActions] = useState(false)
  const [showRelayCreate, setShowRelayCreate] = useState(false)
  const [showRelayJoin, setShowRelayJoin] = useState(false)
  const [showRelayCta, setShowRelayCta] = useState(false)
  const [relayName, setRelayName] = useState('')
  const [relayDescription, setRelayDescription] = useState('')
  const [relayPublic, setRelayPublic] = useState(true)
  const [relayOpenMembership, setRelayOpenMembership] = useState(true)
  const [relayCreating, setRelayCreating] = useState(false)
  const [joinIdentifier, setJoinIdentifier] = useState('')
  const [joinToken, setJoinToken] = useState('')
  const [joinBusy, setJoinBusy] = useState(false)
  const desktopDownloadUrl =
    import.meta.env.VITE_DESKTOP_DOWNLOAD_URL || 'https://hypertuna.com/download'
  const isDesktop = isElectron()
  const { sendToWorker, startJoinFlow, joinFlows, clearJoinFlow } = useWorkerBridge()

  const joinId = joinIdentifier.trim()
  const joinFlow = joinId ? joinFlows[joinId] : undefined

  useEffect(() => {
    if (!showRelayJoin) return
    if (!joinId.includes(':')) return
    if (joinFlow?.phase === 'success') {
      setShowRelayJoin(false)
      setJoinIdentifier('')
      setJoinToken('')
      clearJoinFlow(joinId)
    }
  }, [clearJoinFlow, joinFlow?.phase, joinId, showRelayJoin])

  const filteredDiscovery = discoveryGroups.filter((g) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return g.name.toLowerCase().includes(q) || (g.about ?? '').toLowerCase().includes(q)
  })

  const renderGroupCard = (groupId: string, relay?: string) => {
    const meta = discoveryGroups.find(
      (g) => g.id === groupId && (relay ? g.relay === relay : true)
    )
    const name = meta?.name || groupId
    const about = meta?.about
    const membersText = meta?.tags?.length ? `${meta.tags.length} tags` : null
    const picture = meta?.picture
    const initials = (name || 'GR').slice(0, 2).toUpperCase()

    return (
      <Card
        key={makeGroupKey(groupId, relay)}
        className="cursor-pointer transition-colors hover:bg-accent/50 overflow-hidden"
        onClick={() => {
          push(toGroup(groupId, relay))
        }}
      >
        <CardContent className="p-4 flex gap-3 items-start">
          <Avatar className="h-11 w-11 shrink-0">
            {picture && <AvatarImage src={picture} alt={name} />}
            <AvatarFallback className="text-sm font-semibold">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-lg truncate">{name}</div>
              <GroupFacepile groupId={groupId} relay={relay} />
            </div>
            {about && <div className="text-sm text-muted-foreground line-clamp-2">{about}</div>}
            {membersText && <div className="text-xs text-muted-foreground">{membersText}</div>}
          </div>
        </CardContent>
      </Card>
    )
  }

  const renderDiscover = () => {
    if (isLoadingDiscovery) {
      return (
        <div className="flex flex-col items-center gap-3 text-muted-foreground py-12">
          <Loader2 className="w-6 h-6 animate-spin" />
          <div>{t('Loading...')}</div>
        </div>
      )
    }
    if (discoveryError) {
      return (
        <div className="text-sm text-red-500">
          {t('Failed to load groups')}: {discoveryError}
        </div>
      )
    }
    if (!discoveryGroups.length) {
      return <div className="text-muted-foreground">{t('No groups found')}</div>
    }
    return (
      <div className="space-y-3">
        {filteredDiscovery.map((g) => renderGroupCard(g.id, g.relay))}
      </div>
    )
  }

  const renderMyGroups = () => {
    if (!myGroupList.length) {
      return <div className="text-muted-foreground">{t('No groups yet')}</div>
    }
    return (
      <div className="space-y-3">
        {myGroupList.map((entry) => renderGroupCard(entry.groupId, entry.relay))}
      </div>
    )
  }

  const renderInvites = () => {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            {invites.length ? t('Invites') : t('No invites')}
          </div>
          <Button variant="ghost" size="sm" onClick={() => refreshInvites()}>
            <Loader2 className="w-4 h-4 mr-2" />
            {t('Refresh')}
          </Button>
        </div>
        {invitesError && <div className="text-sm text-red-500">{invitesError}</div>}
        {invites.map((inv) => (
          <Card key={inv.event.id} className="overflow-hidden">
            <CardContent className="p-4 flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold">{inv.groupId}</div>
                {inv.relay && (
                  <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {inv.relay}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => {
                  push(toGroup(inv.groupId, inv.relay))
                }}
              >
                {t('Use invite')}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <PrimaryPageLayout
      pageName="groups"
      ref={layoutRef}
      titlebar={<GroupsPageTitlebar />}
      displayScrollToTopButton
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Input
            placeholder={t('Search groups...') as string}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <Button variant="ghost" size="icon" onClick={() => refreshDiscovery()}>
            <Loader2 className="w-4 h-4" />
          </Button>
          <Button onClick={() => setShowCreateActions(true)}>{t('Create')}</Button>
        </div>
        <Tabs value={tab} onValueChange={(val) => setTab(val as TTab)}>
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="discover">{t('Discover')}</TabsTrigger>
            <TabsTrigger value="my">{t('My Groups')}</TabsTrigger>
            <TabsTrigger value="invites">{t('Invites')}</TabsTrigger>
          </TabsList>
          <TabsContent value="discover" className="mt-4">
            {renderDiscover()}
          </TabsContent>
          <TabsContent value="my" className="mt-4">
            {renderMyGroups()}
          </TabsContent>
          <TabsContent value="invites" className="mt-4">
            {renderInvites()}
          </TabsContent>
        </Tabs>
      </div>
      <GroupCreateDialog open={showCreate} onOpenChange={setShowCreate} />
      <Dialog open={showCreateActions} onOpenChange={setShowCreateActions}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Create or join')}</DialogTitle>
            <DialogDescription>
              {t('Start a new Nostr group or manage Hypertuna relays (desktop only).')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Button
              variant="outline"
              className="w-full justify-between"
              onClick={() => {
                setShowCreateActions(false)
                setShowCreate(true)
              }}
            >
              <span>{t('Create Nostr group')}</span>
              <span className="text-xs text-muted-foreground">{t('NIP-29')}</span>
            </Button>
            <Button
              variant="outline"
              className="w-full justify-between"
              onClick={() => {
                setShowCreateActions(false)
                if (isDesktop) setShowRelayCreate(true)
                else setShowRelayCta(true)
              }}
            >
              <span>{t('Create Hypertuna relay')}</span>
              <span className="text-xs text-muted-foreground">{isDesktop ? t('Desktop') : t('Desktop only')}</span>
            </Button>
            <Button
              variant="outline"
              className="w-full justify-between"
              onClick={() => {
                setShowCreateActions(false)
                if (isDesktop) setShowRelayJoin(true)
                else setShowRelayCta(true)
              }}
            >
              <span>{t('Join Hypertuna relay')}</span>
              <span className="text-xs text-muted-foreground">{isDesktop ? t('Desktop') : t('Desktop only')}</span>
            </Button>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowCreateActions(false)}>
              {t('Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showRelayCreate} onOpenChange={setShowRelayCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Create Hypertuna relay')}</DialogTitle>
            <DialogDescription>
              {t('Creates a new Hypertuna relay using the local worker (desktop only).')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="relay-name">{t('Name')}</Label>
              <Input
                id="relay-name"
                value={relayName}
                onChange={(e) => setRelayName(e.target.value)}
                placeholder={t('My Relay') as string}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="relay-description">{t('Description')}</Label>
              <Textarea
                id="relay-description"
                value={relayDescription}
                onChange={(e) => setRelayDescription(e.target.value)}
                placeholder={t('Optional description') as string}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <div className="font-medium text-sm">{t('Public')}</div>
                <div className="text-xs text-muted-foreground">
                  {t('Make this relay discoverable via gateway')}
                </div>
              </div>
              <Switch checked={relayPublic} onCheckedChange={setRelayPublic} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <div className="font-medium text-sm">{t('Open membership')}</div>
                <div className="text-xs text-muted-foreground">
                  {t('Anyone can join without approval')}
                </div>
              </div>
              <Switch checked={relayOpenMembership} onCheckedChange={setRelayOpenMembership} />
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setShowRelayCreate(false)}>
                {t('Cancel')}
              </Button>
              <Button
                onClick={async () => {
                  if (!relayName.trim()) {
                    toast.error(t('Please enter a relay name'))
                    return
                  }
                  setRelayCreating(true)
                  try {
                    await createHypertunaRelayGroup({
                      name: relayName.trim(),
                      about: relayDescription.trim() || undefined,
                      isPublic: relayPublic,
                      isOpen: relayOpenMembership,
                      fileSharing: true
                    })
                    toast.success(t('Relay created'))
                    setShowRelayCreate(false)
                    setRelayName('')
                    setRelayDescription('')
                  } catch (err: any) {
                    toast.error(err?.message || t('Failed to create relay'))
                  } finally {
                    setRelayCreating(false)
                  }
                }}
                disabled={relayCreating}
              >
                {relayCreating ? t('Creating...') : t('Create relay')}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showRelayJoin} onOpenChange={setShowRelayJoin}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Join Hypertuna relay')}</DialogTitle>
            <DialogDescription>
              {t('Join an existing Hypertuna relay by key or public identifier.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="join-identifier">{t('Relay key or public identifier')}</Label>
              <Input
                id="join-identifier"
                value={joinIdentifier}
                onChange={(e) => setJoinIdentifier(e.target.value)}
                placeholder="relay key or npub:relayName"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="join-token">{t('Auth token')} ({t('optional')})</Label>
              <Input
                id="join-token"
                value={joinToken}
                onChange={(e) => setJoinToken(e.target.value)}
                placeholder={t('Token if required') as string}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setShowRelayJoin(false)}>
                {t('Cancel')}
              </Button>
              <Button
                onClick={async () => {
                  if (!joinIdentifier.trim()) {
                    toast.error(t('Please enter a relay identifier'))
                    return
                  }
                  setJoinBusy(true)
                  try {
                    const identifier = joinIdentifier.trim()
                    const token = joinToken.trim()
                    const isHex = /^[a-fA-F0-9]{64}$/.test(identifier)
                    const relayKey = isHex ? identifier : undefined
                    const publicIdentifier = !relayKey && identifier.includes(':') ? identifier : undefined

                    if (publicIdentifier && !token) {
                      await startJoinFlow(publicIdentifier, { fileSharing: true })
                      toast.message(t('Join flow started'))
                    } else {
                      await sendToWorker({
                        type: 'join-relay',
                        data: {
                          relayKey,
                          publicIdentifier,
                          authToken: token || undefined,
                          fileSharing: true
                        }
                      })
                      toast.success(t('Join requested'))
                      sendToWorker({ type: 'get-relays' }).catch(() => {})
                      setShowRelayJoin(false)
                      setJoinIdentifier('')
                      setJoinToken('')
                    }
                  } catch (err: any) {
                    toast.error(err?.message || t('Failed to join relay'))
                  } finally {
                    setJoinBusy(false)
                  }
                }}
                disabled={joinBusy}
              >
                {joinBusy ? t('Joining...') : t('Join relay')}
              </Button>
            </DialogFooter>
            {joinFlow && (
              <div className="rounded-md border border-border/50 bg-muted/30 p-2 text-xs space-y-1">
                <div className="font-medium">{t('Join flow')}</div>
                <div className="text-muted-foreground capitalize">{t('Phase')}: {joinFlow.phase}</div>
                {joinFlow.error && <div className="text-red-500">{joinFlow.error}</div>}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showRelayCta} onOpenChange={setShowRelayCta}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Hypertuna relays')}</DialogTitle>
            <DialogDescription>
              {t('Available in the desktop app. Download to create or join relays.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col sm:flex-row sm:justify-end sm:space-x-2">
            <Button variant="outline" onClick={() => setShowRelayCta(false)}>
              {t('Close')}
            </Button>
            <Button asChild>
              <a href={desktopDownloadUrl} target="_blank" rel="noreferrer">
                {t('Download desktop app')}
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PrimaryPageLayout>
  )
})

GroupsPage.displayName = 'GroupsPage'

export default GroupsPage

function GroupsPageTitlebar() {
  const { t } = useTranslation()

  return (
    <div className="flex gap-2 items-center h-full pl-3 [&_svg]:text-muted-foreground">
      <Heart />
      <div className="text-lg font-semibold" style={{ fontSize: 'var(--title-font-size, 18px)' }}>
        {t('Groups')}
      </div>
    </div>
  )
}
