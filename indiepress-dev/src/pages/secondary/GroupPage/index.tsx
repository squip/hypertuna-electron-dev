import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { useGroups } from '@/providers/GroupsProvider'
import { TPageRef } from '@/types'
import { useTranslation } from 'react-i18next'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { Heart, Loader2, LogOut, Send, Star } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import UserAvatar from '@/components/UserAvatar'
import Username from '@/components/Username'
import NormalFeed from '@/components/NormalFeed'
import ProfileList from '@/components/ProfileList'
import { BIG_RELAY_URLS } from '@/constants'
import { parseGroupIdentifier } from '@/lib/groups'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { useNostr } from '@/providers/NostrProvider'
import { isElectron } from '@/lib/platform'
import PostEditor from '@/components/PostEditor'
import GroupMetadataEditor, { TGroupMetadataForm } from '@/components/GroupMetadataEditor'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'

type TGroupPageProps = {
  index?: number
  id?: string
  relay?: string
}

const makeGroupKey = (groupId: string, relay?: string) => (relay ? `${relay}|${groupId}` : groupId)

const GroupPage = forwardRef<TPageRef, TGroupPageProps>(({ index, id, relay }, ref) => {
  const { t } = useTranslation()
  const {
    discoveryGroups,
    fetchGroupDetail,
    sendJoinRequest,
    sendLeaveRequest,
    favoriteGroups,
    toggleFavorite,
    invites,
    sendInvites,
    updateMetadata,
    addUser,
    removeUser,
    deleteGroup,
    deleteEvent,
    resolveRelayUrl
  } = useGroups()
  const { pubkey } = useNostr()
  const { joinFlows, startJoinFlow } = useWorkerBridge()
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'notes' | 'members'>('notes')
  const [error, setError] = useState<string | null>(null)
  const [groupRelay, setGroupRelay] = useState<string | undefined>(relay)
  const [groupId, setGroupId] = useState<string | undefined>(id)
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchGroupDetail>> | null>(null)
  const [inviteeInput, setInviteeInput] = useState('')
  const [isSendingInvite, setIsSendingInvite] = useState(false)
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [isMetadataDialogOpen, setIsMetadataDialogOpen] = useState(false)
  const [isSavingMeta, setIsSavingMeta] = useState(false)
  const [memberInput, setMemberInput] = useState('')
  const [removePubkey, setRemovePubkey] = useState('')
  const [removeEventId, setRemoveEventId] = useState('')
  const requestIdRef = useRef(0)

  useEffect(() => {
    const searchRelay =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('r') || undefined
        : undefined
    const parsed = parseGroupIdentifier(id || '')
    setGroupRelay(parsed.relay ?? relay ?? searchRelay)
    setGroupId(parsed.groupId || id)
  }, [id, relay])

  useEffect(() => {
    if (!groupId) return
    const requestId = ++requestIdRef.current
    setIsLoading(true)
    setError(null)
    fetchGroupDetail(groupId, groupRelay)
      .then((d) => {
        // Ignore stale responses
        if (requestId !== requestIdRef.current) return
        setDetail((prev) => {
          const next = { ...d }
          // Preserve previous data if new fetch is empty/undefined
          const isSameGroup = prev?.metadata?.id === groupId
          if (!next.metadata && isSameGroup && prev?.metadata) next.metadata = prev.metadata
          if ((!next.admins || !next.admins.length) && isSameGroup && prev?.admins?.length) {
            next.admins = prev.admins
          }
          if ((!next.members || !next.members.length) && isSameGroup && prev?.members?.length) {
            next.members = prev.members
          }
          if (!next.membershipStatus && isSameGroup && prev?.membershipStatus) {
            next.membershipStatus = prev.membershipStatus
          }
          return next
        })
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setIsLoading(false))
  }, [fetchGroupDetail, groupId, groupRelay])

  const groupKey = useMemo(() => makeGroupKey(groupId || '', groupRelay), [groupId, groupRelay])
  const isFavorite = favoriteGroups.includes(groupKey)

  const inviteToken = useMemo(() => {
    const match = invites.find(
      (inv) =>
        inv.groupId === groupId && (!groupRelay || !inv.relay || inv.relay === groupRelay)
    )
    return match?.token
  }, [invites, groupId, groupRelay])

  const joinFlow = useMemo(() => {
    const id = groupId || ''
    return id ? joinFlows[id] : undefined
  }, [groupId, joinFlows])

  const resolvedGroupRelay = useMemo(() => {
    return groupRelay ? resolveRelayUrl(groupRelay) : undefined
  }, [groupRelay, resolveRelayUrl])

  const groupSubRequests = useMemo(
    () =>
      groupId
        ? [
            {
              source: 'relays' as const,
              urls: resolvedGroupRelay
                ? [resolvedGroupRelay]
                : groupRelay
                  ? [groupRelay]
                  : BIG_RELAY_URLS,
              filter: {
                '#h': [groupId],
                kinds: [
                  // Core group metadata / membership / admin
                  39000, 39001, 39002, 39003,
                  // Hypertuna/NIP-29 flows
                  9000, 9001, 9002, 9005, 9007, 9008, 9009, 9021, 9022,
                  // Timeline kinds (retain existing set)
                  1, 6, 20, 21, 22, 1068, 1111, 1222, 1244, 9802, 30023, 31987, 39089
                ]
              }
            }
          ]
        : [],
    [groupId, groupRelay, resolvedGroupRelay]
  )

  useEffect(() => {
    // Debug aid: confirm routing + relay resolution for hypertuna relays
    console.info('[GroupPage] route params', {
      rawId: id,
      groupId,
      groupRelay,
      resolvedGroupRelay
    })
    if (groupSubRequests.length) {
      console.info('[GroupPage] subRequests', groupSubRequests)
    }
  }, [groupId, groupRelay, id, resolvedGroupRelay, groupSubRequests])

  const isHypertunaGroup = useMemo(() => {
    const tags = detail?.metadata?.event?.tags
    return Array.isArray(tags) && tags.some((t) => t[0] === 'i' && t[1] === 'hypertuna:relay')
  }, [detail?.metadata?.event?.tags])

  useEffect(() => {
    if (!groupId) return
    if (joinFlow?.phase !== 'success') return
    fetchGroupDetail(groupId, groupRelay).then(setDetail).catch(() => {})
  }, [fetchGroupDetail, groupId, groupRelay, joinFlow?.phase])

  const handleJoin = async () => {
    if (!groupId) return
    try {
      if (isElectron() && isHypertunaGroup && detail?.metadata?.isOpen !== false) {
        await startJoinFlow(groupId, { fileSharing: true })
        return
      }

      await sendJoinRequest(groupId, groupRelay, inviteToken)
      setDetail((prev) =>
        prev
          ? { ...prev, membershipStatus: 'pending' }
          : prev
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleSendInvites = async () => {
    if (!groupId || !inviteeInput.trim()) return
    const invitees = inviteeInput
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    if (!invitees.length) return
    setIsSendingInvite(true)
    try {
      await sendInvites(groupId, invitees, groupRelay)
      toast.success(t('Invites sent'))
      setInviteeInput('')
    } catch (err) {
      toast.error(t('Failed to send invites'))
      setError((err as Error).message)
    } finally {
      setIsSendingInvite(false)
    }
  }

  const handleSaveMetadata = async (data: TGroupMetadataForm) => {
    if (!groupId) return
    setIsSavingMeta(true)
    try {
      await updateMetadata(groupId, data, groupRelay)
      toast.success(t('Metadata updated'))
      setIsMetadataDialogOpen(false)
      // Refresh detail
      fetchGroupDetail(groupId, groupRelay).then(setDetail)
    } catch (err) {
      toast.error(t('Failed to update metadata'))
      setError((err as Error).message)
    } finally {
      setIsSavingMeta(false)
    }
  }

  const handleAddMember = async () => {
    if (!groupId || !memberInput.trim()) return
    try {
      await addUser(groupId, memberInput.trim(), groupRelay)
      toast.success(t('User added'))
      setMemberInput('')
    } catch (err) {
      toast.error(t('Failed to add user'))
      setError((err as Error).message)
    }
  }

  const handleRemoveMember = async () => {
    if (!groupId || !removePubkey.trim()) return
    try {
      await removeUser(groupId, removePubkey.trim(), groupRelay)
      toast.success(t('User removed'))
      setRemovePubkey('')
    } catch (err) {
      toast.error(t('Failed to remove user'))
      setError((err as Error).message)
    }
  }

  const handleDeleteGroup = async () => {
    if (!groupId) return
    try {
      await deleteGroup(groupId, groupRelay)
      toast.success(t('Group delete requested'))
    } catch (err) {
      toast.error(t('Failed to delete group'))
      setError((err as Error).message)
    }
  }

  const handleDeleteEvent = async () => {
    if (!groupId || !removeEventId.trim()) return
    try {
      await deleteEvent(groupId, removeEventId.trim(), groupRelay)
      toast.success(t('Delete requested'))
      setRemoveEventId('')
    } catch (err) {
      toast.error(t('Failed to delete event'))
      setError((err as Error).message)
    }
  }

  const handleLeave = async () => {
    if (!groupId) return
    try {
      await sendLeaveRequest(groupId, groupRelay)
      setDetail((prev) =>
        prev
          ? { ...prev, membershipStatus: 'not-member' }
          : prev
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const membershipStatus = detail?.membershipStatus ?? 'not-member'
  const isAdmin =
    !!pubkey && !!detail?.admins?.some((admin) => admin.pubkey === pubkey)

  const fallbackMeta = discoveryGroups.find(
    (g) => g.id === groupId && (!groupRelay || !g.relay || g.relay === groupRelay)
  )
  const groupDisplayName = detail?.metadata?.name || fallbackMeta?.name || groupId || t('Group')
  const groupPicture = detail?.metadata?.picture || fallbackMeta?.picture
  const groupTitle = (
    <span className="inline-flex items-center gap-2 min-w-0">
      <Avatar className="h-8 w-8 shrink-0">
        {groupPicture && <AvatarImage src={groupPicture} alt={groupDisplayName} />}
        <AvatarFallback className="text-sm font-semibold">
          {(groupDisplayName || 'GR').slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{groupDisplayName}</span>
    </span>
  )

  const content = (
    <SecondaryPageLayout
      ref={ref}
      index={index}
      title={groupTitle}
      controls={
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="titlebar-icon"
            onClick={() => toggleFavorite(groupKey)}
            title={isFavorite ? t('Remove from favorites') : t('Add to favorites')}
          >
            <Star className={`w-4 h-4 ${isFavorite ? 'fill-current text-yellow-500' : ''}`} />
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('Loading...')}
        </div>
      ) : error ? (
        <div className="text-red-500 px-4 py-3">{error}</div>
      ) : !detail || !groupId ? (
        <div className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground">
          <Heart className="w-6 h-6" />
          {t('Group not found')}
        </div>
      ) : (
        <div className="space-y-4 pb-6">
          <Card className="overflow-hidden border">
            <CardContent className="p-4 space-y-3">
              <div className="flex gap-3 items-start">
                {detail.metadata?.picture && (
                  <img
                    src={detail.metadata.picture}
                    alt={detail.metadata.name}
                    className="w-16 h-16 rounded-lg object-cover"
                  />
                )}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-2xl font-semibold truncate">
                      {detail.metadata?.name || groupId}
                    </div>
                  </div>
                  {detail.metadata?.about && (
                    <div className="text-sm text-muted-foreground whitespace-pre-line">
                      {detail.metadata.about}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    {detail.metadata?.isPublic === false && <span>{t('Private')}</span>}
                    {detail.metadata?.isOpen === false && <span>{t('Closed')}</span>}
                    {detail.members && (
                      <span>
                        {detail.members.length}{' '}
                        {detail.members.length === 1 ? t('member') : t('members')}
                      </span>
                    )}
                    {groupRelay && (
                      <>
                        <span>•</span>
                        <span className="truncate max-w-[200px]">{groupRelay}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {membershipStatus === 'member' ? (
                  <>
                    <Button size="sm" onClick={() => setIsComposerOpen(true)}>
                      {t('New post')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleLeave}>
                      <LogOut className="w-4 h-4 mr-2" />
                      {t('Leave')}
                    </Button>
                  </>
                ) : membershipStatus === 'pending' ? (
                  <Button variant="secondary" size="sm" disabled>
                    {t('Request sent')}
                  </Button>
                ) : membershipStatus === 'removed' ? (
                  <Button variant="destructive" size="sm" disabled>
                    {t('Removed')}
                  </Button>
                ) : (
                  <Button size="sm" onClick={handleJoin} disabled={joinFlow?.phase === 'starting' || joinFlow?.phase === 'request' || joinFlow?.phase === 'verify' || joinFlow?.phase === 'complete'}>
                    {joinFlow?.phase && joinFlow.phase !== 'idle' && joinFlow.phase !== 'error'
                      ? t('Joining…')
                      : t('Join')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleFavorite(groupKey)}
                  title={isFavorite ? t('Remove from favorites') : t('Add to favorites')}
                >
                  <Star className={`w-4 h-4 ${isFavorite ? 'fill-current text-yellow-500' : ''}`} />
                </Button>
                {inviteToken && membershipStatus !== 'member' && (
                  <Button size="sm" variant="secondary" onClick={handleJoin}>
                    {t('Use invite')}
                  </Button>
                )}
              </div>
              {joinFlow && joinFlow.phase !== 'idle' && joinFlow.phase !== 'success' && (
                <div className="text-xs text-muted-foreground">
                  Hypertuna join flow: <span className="capitalize">{joinFlow.phase}</span>
                  {joinFlow.error ? ` — ${joinFlow.error}` : ''}
                </div>
              )}
              {detail.admins && detail.admins.length > 0 && (
                <div className="flex gap-2 flex-wrap text-sm text-muted-foreground">
                  {detail.admins.map((admin) => (
                    <div
                      key={admin.pubkey}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"
                    >
                      <UserAvatar userId={admin.pubkey} size="xSmall" />
                      <Username userId={admin.pubkey} className="text-xs" />
                      {admin.roles.length > 0 && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {admin.roles.join(', ')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'notes' | 'members')}>
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="notes">{t('Notes')}</TabsTrigger>
              <TabsTrigger value="members">
                {t('Members')}
                {detail.members ? ` (${detail.members.length})` : ''}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="notes" className="mt-2">
              <NormalFeed
                subRequests={groupSubRequests}
                isMainFeed={false}
              />
            </TabsContent>
            <TabsContent value="members" className="mt-2">
              <div className="space-y-3">
                {isAdmin && (
                  <div className="flex gap-2">
                    <Input
                      value={memberInput}
                      onChange={(e) => setMemberInput(e.target.value)}
                      placeholder={t('Add member by pubkey') as string}
                    />
                    <Button onClick={handleAddMember} size="sm">
                      {t('Add')}
                    </Button>
                  </div>
                )}
                {detail.members && detail.members.length > 0 ? (
                  <div className="space-y-2">
                    <ProfileList pubkeys={detail.members} />
                    {isAdmin && (
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">{t('Remove member')}</div>
                        <div className="flex gap-2">
                          <Input
                            value={removePubkey}
                            onChange={(e) => setRemovePubkey(e.target.value)}
                            placeholder={t('Pubkey to remove') as string}
                          />
                          <Button variant="outline" onClick={handleRemoveMember} size="sm">
                            {t('Remove')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-muted-foreground text-sm">{t('No members listed')}</div>
                )}
              </div>
            </TabsContent>
          </Tabs>

          {membershipStatus === 'member' && isAdmin && (
            <Card className="overflow-hidden border">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">{t('Send invites')}</div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSendInvites}
                    disabled={isSendingInvite}
                  >
                    {isSendingInvite ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4 mr-2" />
                    )}
                    {t('Send')}
                  </Button>
                </div>
                <Input
                  value={inviteeInput}
                  onChange={(e) => setInviteeInput(e.target.value)}
                  placeholder={t('Enter npubs or hex pubkeys, comma separated') as string}
                />
                <div className="text-xs text-muted-foreground">
                  {t('Each invite will include a unique token encrypted to the invitee.')}
                </div>
              </CardContent>
            </Card>
          )}

          {isAdmin && (
            <Card className="overflow-hidden border">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">{t('Admin controls')}</div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setIsMetadataDialogOpen(true)}>
                      {t('Edit metadata')}
                    </Button>
                    <Button variant="destructive" size="sm" onClick={handleDeleteGroup}>
                      {t('Delete group')}
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t('Delete event by id')}</Label>
                  <div className="flex gap-2">
                    <Input
                      value={removeEventId}
                      onChange={(e) => setRemoveEventId(e.target.value)}
                      placeholder={t('Event ID')}
                    />
                    <Button variant="outline" onClick={handleDeleteEvent} size="sm">
                      {t('Delete')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </SecondaryPageLayout>
  )

  return (
    <>
      {content}
      {groupId && (
        <PostEditor
          open={isComposerOpen}
          setOpen={setIsComposerOpen}
          groupContext={{
            groupId,
            relay: resolvedGroupRelay || groupRelay,
            name: detail?.metadata?.name,
            picture: groupPicture
          }}
          openFrom={resolvedGroupRelay ? [resolvedGroupRelay] : groupRelay ? [groupRelay] : undefined}
        />
      )}
      <Dialog open={isMetadataDialogOpen} onOpenChange={setIsMetadataDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Edit group')}</DialogTitle>
          </DialogHeader>
          <GroupMetadataEditor
            initial={{
              name: detail?.metadata?.name,
              about: detail?.metadata?.about,
              picture: detail?.metadata?.picture,
              isOpen: detail?.metadata?.isOpen,
              isPublic: detail?.metadata?.isPublic
            }}
            onSave={handleSaveMetadata}
            onCancel={() => setIsMetadataDialogOpen(false)}
            saving={isSavingMeta}
          />
        </DialogContent>
      </Dialog>
    </>
  )
})

GroupPage.displayName = 'GroupPage'

export default GroupPage
