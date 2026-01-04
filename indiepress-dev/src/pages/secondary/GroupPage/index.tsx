import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { useGroups } from '@/providers/GroupsProvider'
import { TPageRef } from '@/types'
import { useTranslation } from 'react-i18next'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { Event as NostrEvent } from '@nostr/tools/wasm'
import {
  Users,
  Loader2,
  LogOut,
  Star,
  Settings,
  Copy,
  Check,
  Search,
  UserPlus,
  EllipsisVertical,
  Pin,
  BellOff,
  TriangleAlert
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import UserAvatar from '@/components/UserAvatar'
import Username from '@/components/Username'
import NormalFeed from '@/components/NormalFeed'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useWorkerBridge } from '@/providers/WorkerBridgeProvider'
import { useSearchProfiles } from '@/hooks/useSearchProfiles'
import FollowButton from '@/components/FollowButton'
import Nip05 from '@/components/Nip05'
import { useMuteList } from '@/providers/MuteListProvider'
import ReportDialog from '@/components/NoteOptions/ReportDialog'
import * as nip19 from '@nostr/tools/nip19'
import { SimpleUserAvatar } from '@/components/UserAvatar'
import { SimpleUsername } from '@/components/Username'
import { generateImageByPubkey } from '@/lib/pubkey'
import React from 'react'

type MemberActionsMenuProps = {
  targetPubkey: string
  showGrantAdmin: boolean
  actionsDisabled?: boolean
  onGrantAdmin: (pubkey: string) => void
  onReportUser: (pubkey: string) => void
  onMutePrivately: (pubkey: string) => void
  onMutePublicly: (pubkey: string) => void
  t: (key: string, opts?: any) => string
}

function MemberActionsMenu({
  targetPubkey,
  showGrantAdmin,
  actionsDisabled,
  onGrantAdmin,
  onReportUser,
  onMutePrivately,
  onMutePublicly,
  t
}: MemberActionsMenuProps) {
  const [open, setOpen] = React.useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0 rounded-lg [&_svg]:size-5"
          onClick={(e) => e.stopPropagation()}
          disabled={actionsDisabled}
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="p-1 scrollbar-hide max-h-[50vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {showGrantAdmin && (
          <DropdownMenuItem
            onClick={() => onGrantAdmin(targetPubkey)}
            className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md"
            disabled={actionsDisabled}
          >
            <Pin className="w-4 h-4" />
            {t('Grant admin permissions')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => onReportUser(targetPubkey)}
          className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md text-destructive focus:text-destructive"
          disabled={actionsDisabled}
        >
          <TriangleAlert className="w-4 h-4" />
          {t('Report')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onMutePrivately(targetPubkey)}
          className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md text-destructive focus:text-destructive"
          disabled={actionsDisabled}
        >
          <BellOff className="w-4 h-4" />
          {t('Mute user privately')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onMutePublicly(targetPubkey)}
          className="relative flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm rounded-md text-destructive focus:text-destructive"
          disabled={actionsDisabled}
        >
          <BellOff className="w-4 h-4" />
          {t('Mute user publicly')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type MemberRowProps = {
  memberPubkey: string
  isSelf: boolean
  showGrantAdmin: boolean
  canMute: boolean
  nostrProfile: any
  pubkey?: string | null
  onGrantAdmin: (pubkey: string) => void
  onReportUser: (pubkey: string) => void
  onMutePrivately: (pubkey: string) => void
  onMutePublicly: (pubkey: string) => void
  t: (key: string, opts?: any) => string
}

function MemberRowComponent({
  memberPubkey,
  isSelf,
  showGrantAdmin,
  canMute,
  nostrProfile,
  pubkey,
  onGrantAdmin,
  onReportUser,
  onMutePrivately,
  onMutePublicly,
  t
}: MemberRowProps) {
  React.useEffect(() => {
    console.info('[GroupPage] member row render', {
      memberPubkey,
      isSelf,
      ts: Date.now()
    })
  })

  const actionsDisabled = isSelf
  const selfProfile =
    isSelf && pubkey
      ? (nostrProfile || {
          pubkey,
          metadata: { picture: generateImageByPubkey(pubkey) }
        })
      : null

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-transparent hover:border-border hover:bg-accent/30">
      {isSelf ? (
        <>
          <SimpleUserAvatar
            userId={memberPubkey}
            profile={selfProfile || undefined}
            className="shrink-0"
          />
          <div className="min-w-0 flex-1">
            <SimpleUsername
              userId={memberPubkey}
              profile={selfProfile || undefined}
              className="font-semibold truncate max-w-full w-fit"
              withoutSkeleton
            />
            <Nip05 pubkey={memberPubkey} profile={selfProfile || undefined} />
          </div>
        </>
      ) : (
        <>
          <UserAvatar userId={memberPubkey} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <Username userId={memberPubkey} className="font-semibold truncate max-w-full w-fit" />
            <Nip05 pubkey={memberPubkey} />
          </div>
        </>
      )}
      <div className="flex items-center gap-2 flex-shrink-0">
        {!isSelf ? (
          <>
            <FollowButton pubkey={memberPubkey} />
            {(canMute || actionsDisabled) && (
              <MemberActionsMenu
                targetPubkey={memberPubkey}
                showGrantAdmin={showGrantAdmin}
                actionsDisabled={actionsDisabled}
                onGrantAdmin={onGrantAdmin}
                onReportUser={onReportUser}
                onMutePrivately={onMutePrivately}
                onMutePublicly={onMutePublicly}
                t={t}
              />
            )}
          </>
        ) : (
          <>
            <Button className="rounded-full min-w-28" variant="outline" size="sm" disabled>
              {t('Follow')}
            </Button>
            <MemberActionsMenu
              targetPubkey={memberPubkey}
              showGrantAdmin={false}
              actionsDisabled
              onGrantAdmin={onGrantAdmin}
              onReportUser={onReportUser}
              onMutePrivately={onMutePrivately}
              onMutePublicly={onMutePublicly}
              t={t}
            />
          </>
        )}
      </div>
    </div>
  )
}

const MemoizedMemberRow = React.memo(
  MemberRowComponent,
  (prev, next) =>
    prev.memberPubkey === next.memberPubkey &&
    prev.isSelf === next.isSelf &&
    prev.showGrantAdmin === next.showGrantAdmin &&
    prev.canMute === next.canMute &&
    prev.nostrProfile === next.nostrProfile &&
    prev.pubkey === next.pubkey &&
    prev.onGrantAdmin === next.onGrantAdmin &&
    prev.onReportUser === next.onReportUser &&
    prev.onMutePrivately === next.onMutePrivately &&
    prev.onMutePublicly === next.onMutePublicly &&
    prev.t === next.t
)

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
    grantAdmin,
    resolveRelayUrl,
    myGroupList
  } = useGroups()
  const { pubkey, profile: nostrProfile } = useNostr()
  const { joinFlows, startJoinFlow } = useWorkerBridge()
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'notes' | 'members'>('notes')
  const [error, setError] = useState<string | null>(null)
  const [groupRelay, setGroupRelay] = useState<string | undefined>(relay)
  const [groupId, setGroupId] = useState<string | undefined>(id)
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchGroupDetail>> | null>(null)
  const [isSendingInvite, setIsSendingInvite] = useState(false)
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [isMetadataDialogOpen, setIsMetadataDialogOpen] = useState(false)
  const [isSavingMeta, setIsSavingMeta] = useState(false)
  const [copiedRelayUrl, setCopiedRelayUrl] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false)
  const [inviteSearch, setInviteSearch] = useState('')
  const [selectedInvitees, setSelectedInvitees] = useState<string[]>([])
  const [reportTarget, setReportTarget] = useState<string | null>(null)
  const { profiles: inviteProfiles, isFetching: isSearchingInvites } = useSearchProfiles(inviteSearch, 8)
  const { mutePrivately, mutePublicly } = useMuteList()
  const reportEvent = useMemo(() => {
    if (!reportTarget) return null
    return {
      id: reportTarget,
      pubkey: reportTarget,
      kind: 0,
      tags: [],
      content: '',
      created_at: Math.floor(Date.now() / 1000),
      sig: ''
    } as NostrEvent
  }, [reportTarget])
  const requestIdRef = useRef(0)

  const myGroupRelay = useMemo(
    () => (groupId ? myGroupList.find((entry) => entry.groupId === groupId)?.relay : undefined),
    [groupId, myGroupList]
  )
  const isInMyGroups = useMemo(
    () => !!(groupId && myGroupList.some((entry) => entry.groupId === groupId)),
    [groupId, myGroupList]
  )
  const effectiveGroupRelay = useMemo(() => groupRelay || myGroupRelay, [groupRelay, myGroupRelay])
  const fallbackMeta = useMemo(
    () =>
      discoveryGroups.find(
        (g) => g.id === groupId && (!effectiveGroupRelay || !g.relay || g.relay === effectiveGroupRelay)
      ),
    [discoveryGroups, effectiveGroupRelay, groupId]
  )

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
    setIsLoading(false) // allow showing cached data immediately
    setError(null)
    fetchGroupDetail(groupId, effectiveGroupRelay, { preferRelay: true })
      .then((d) => {
        // Ignore stale responses
        if (requestId !== requestIdRef.current) return
        console.info('[GroupPage] detail fetched', {
          groupId,
          relay: effectiveGroupRelay,
          membershipStatus: d?.membershipStatus,
          membersCount: d?.members?.length,
          adminsCount: d?.admins?.length,
          metadataCreatedAt: d?.metadata?.event?.created_at,
          metadataPicture: d?.metadata?.picture,
          metadataTags: d?.metadata?.event?.tags,
          prevMetadataCreatedAt: detail?.metadata?.event?.created_at,
          prevMetadataPicture: detail?.metadata?.picture,
          prevMetadataTags: detail?.metadata?.event?.tags
        })
        setDetail((prev) => {
          if (!d) return prev
          const incomingMetaTs = d?.metadata?.event?.created_at || 0
          const incomingMetaPicture = d?.metadata?.picture
          const prevMetaTs = prev?.metadata?.event?.created_at || 0
          const prevMetaPicture = prev?.metadata?.picture
          const fallbackMetaTs = fallbackMeta?.event?.created_at || 0
          const fallbackMetaPicture = fallbackMeta?.picture
          console.info('[GroupPage] detail merge', {
            groupId,
            incomingMetaTs,
            incomingMetaPicture,
            prevMetaTs,
            prevMetaPicture,
            fallbackMetaTs,
            fallbackMetaPicture
          })
          const normalizeMembers = (members?: any[]) =>
            (members || [])
              .map((m) => (typeof m === 'string' ? m : m?.pubkey))
              .filter(Boolean) as string[]

          d.members = normalizeMembers(d.members)
          const normalizedPrevMembers = normalizeMembers(prev?.members)

          const isSameGroup = (prev?.metadata?.id || groupId) === groupId
          const next = { ...d }
          const isIncomingEmpty =
            !next.metadata &&
            (!next.admins || next.admins.length === 0) &&
            (!next.members || next.members.length === 0)
          if (isSameGroup && prev?.metadata && isIncomingEmpty) {
            console.info('[GroupPage] detail merge skip empty', { groupId })
            return prev
          }
          // Preserve previous data if new fetch is empty/undefined
          // If incoming metadata is older than cached, keep the newer one
          const prevMetadata = prev?.metadata
          const prevMetaTsCached = prevMetadata?.event?.created_at || 0
          const nextMetaTs = next?.metadata?.event?.created_at || 0
          if (isSameGroup && prevMetadata && prevMetaTsCached > 0 && nextMetaTs > 0 && nextMetaTs < prevMetaTsCached) {
            console.info('[GroupPage] keeping newer cached metadata', {
              groupId,
              prevMetaTs: prevMetaTsCached,
              nextMetaTs
            })
            next.metadata = prevMetadata
          }
          const metaCandidates = [
            next.metadata,
            prevMetadata,
            fallbackMeta
          ].filter(Boolean) as typeof next.metadata[]
          const bestMeta = metaCandidates.sort((a, b) => (b?.event?.created_at || 0) - (a?.event?.created_at || 0))[0]
          if (bestMeta) {
            const pictureFromBestOrFallback =
              bestMeta.picture || metaCandidates.find((m) => m?.picture)?.picture
            next.metadata = { ...bestMeta, picture: pictureFromBestOrFallback || bestMeta.picture }
          }
          if (isSameGroup && prevMetadata?.picture && (!next?.metadata || !next.metadata.picture)) {
            next.metadata = {
              ...next.metadata,
              picture: prevMetadata.picture,
              id: next.metadata?.id || prevMetadata.id,
              relay: next.metadata?.relay || prevMetadata.relay,
              name: next.metadata?.name ?? prevMetadata.name,
              about: next.metadata?.about ?? prevMetadata.about,
              isOpen: next.metadata?.isOpen ?? prevMetadata.isOpen,
              isPublic: next.metadata?.isPublic ?? prevMetadata.isPublic,
              tags: next.metadata?.tags ?? prevMetadata.tags,
              event: next.metadata?.event || prevMetadata.event
            }
          }
          if (!next.metadata && isSameGroup && prevMetadata) next.metadata = prevMetadata
          if ((!next.admins || !next.admins.length) && isSameGroup && prev?.admins?.length) {
            next.admins = prev.admins
          }
          if ((!next.members || !next.members.length) && isSameGroup && normalizedPrevMembers?.length) {
            next.members = normalizedPrevMembers
          }
          if (
            (!next.membershipStatus ||
              (next.membershipStatus === 'not-member' &&
                isSameGroup &&
                prev?.membershipStatus === 'member' &&
                (!next.members || next.members.length === 0))) &&
            prev?.membershipStatus
          ) {
            next.membershipStatus = prev.membershipStatus
          }
          if (isInMyGroups || isCreator) {
            if (next.membershipStatus !== 'member') {
              console.info('[GroupPage] forcing membership via myGroupList/creator', { groupId })
            }
            next.membershipStatus = 'member'
            if (pubkey) {
              const hasSelf = next.members?.some((m) => m === pubkey)
              if (!hasSelf) {
                next.members = [...(next.members || []), pubkey]
              }
            }
          }
          return next
        })
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setIsLoading(false))
  }, [fetchGroupDetail, groupId, effectiveGroupRelay])

  const groupKey = useMemo(
    () => makeGroupKey(groupId || '', effectiveGroupRelay),
    [groupId, effectiveGroupRelay]
  )
  const isFavorite = favoriteGroups.includes(groupKey)

  const inviteToken = useMemo(() => {
    const match = invites.find(
      (inv) =>
        inv.groupId === groupId && (!effectiveGroupRelay || !inv.relay || inv.relay === effectiveGroupRelay)
    )
    return match?.token
  }, [invites, groupId, effectiveGroupRelay])

  const joinFlow = useMemo(() => {
    const id = groupId || ''
    return id ? joinFlows[id] : undefined
  }, [groupId, joinFlows])

  const resolvedGroupRelay = useMemo(() => {
    return effectiveGroupRelay ? resolveRelayUrl(effectiveGroupRelay) : undefined
  }, [effectiveGroupRelay, resolveRelayUrl])

  const groupSubRequests = useMemo(
    () =>
      groupId
        ? [
            {
              source: 'relays' as const,
              urls: resolvedGroupRelay
                ? [resolvedGroupRelay]
                : effectiveGroupRelay
                  ? [effectiveGroupRelay]
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
    [groupId, effectiveGroupRelay, resolvedGroupRelay]
  )

  useEffect(() => {
    // Debug aid: confirm routing + relay resolution for hypertuna relays
    console.info('[GroupPage] route params', {
      rawId: id,
      groupId,
      groupRelay,
      effectiveGroupRelay,
      resolvedGroupRelay
    })
    if (groupSubRequests.length) {
      console.info('[GroupPage] subRequests', groupSubRequests)
    }
  }, [groupId, groupRelay, effectiveGroupRelay, id, resolvedGroupRelay, groupSubRequests])

  const isHypertunaGroup = useMemo(() => {
    const tags = detail?.metadata?.event?.tags
    return Array.isArray(tags) && tags.some((t) => t[0] === 'i' && t[1] === 'hypertuna:relay')
  }, [detail?.metadata?.event?.tags])

  const decodeNpub = (value?: string) => {
    if (!value || !value.startsWith('npub')) return undefined
    try {
      const decoded = nip19.decode(value)
      return decoded.type === 'npub' ? (decoded.data as string) : undefined
    } catch {
      return undefined
    }
  }

  const isCreator = useMemo(() => {
    if (!pubkey) return false
    const idPart = groupId?.split(':')?.[0]
    const idPubkey = decodeNpub(idPart)
    const dTagPubkey =
      decodeNpub(detail?.metadata?.event?.tags?.find?.((t) => t[0] === 'd')?.[1]) ||
      decodeNpub(fallbackMeta?.event?.tags?.find?.((t) => t[0] === 'd')?.[1])
    const metaPubkey = detail?.metadata?.event?.pubkey || fallbackMeta?.event?.pubkey
    return metaPubkey === pubkey || idPubkey === pubkey || dTagPubkey === pubkey
  }, [pubkey, groupId, detail?.metadata?.event, fallbackMeta])

  useEffect(() => {
    if (!groupId) return
    if (joinFlow?.phase !== 'success') return
    fetchGroupDetail(groupId, effectiveGroupRelay, { preferRelay: true }).then(setDetail).catch(() => {})
  }, [fetchGroupDetail, groupId, effectiveGroupRelay, joinFlow?.phase])

  const handleJoin = async () => {
    if (!groupId) return
    try {
      if (isElectron() && isHypertunaGroup && detail?.metadata?.isOpen !== false) {
        await startJoinFlow(groupId, { fileSharing: true })
        return
      }

      await sendJoinRequest(groupId, effectiveGroupRelay, inviteToken)
      setDetail((prev) =>
        prev
          ? { ...prev, membershipStatus: 'pending' }
          : prev
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleSaveMetadata = async (data: TGroupMetadataForm) => {
    if (!groupId) return
    setIsSavingMeta(true)
    try {
      await updateMetadata(groupId, data, effectiveGroupRelay)
      toast.success(t('Metadata updated'))
      // Optimistic local update
      setDetail((prev) => {
        if (!prev?.metadata) return prev
        return {
          ...prev,
          metadata: {
            ...prev.metadata,
            name: data.name ?? prev.metadata.name,
            about: data.about ?? prev.metadata.about,
            picture: data.picture ?? prev.metadata.picture,
            isOpen: typeof data.isOpen === 'boolean' ? data.isOpen : prev.metadata.isOpen,
            isPublic: typeof data.isPublic === 'boolean' ? data.isPublic : prev.metadata.isPublic
          }
        }
      })
      setIsMetadataDialogOpen(false)
      // Refresh detail
      fetchGroupDetail(groupId, effectiveGroupRelay, { preferRelay: true }).then(setDetail)
    } catch (err) {
      toast.error(t('Failed to update metadata'))
      setError((err as Error).message)
    } finally {
      setIsSavingMeta(false)
    }
  }

  const handleLeave = async () => {
    if (!groupId) return
    try {
      await sendLeaveRequest(groupId, effectiveGroupRelay)
      setDetail((prev) =>
        prev
          ? { ...prev, membershipStatus: 'not-member' }
          : prev
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const baseDetail =
    detail ||
    (fallbackMeta
      ? { metadata: fallbackMeta, admins: [], members: [], membershipStatus: 'not-member' as const }
      : null)
  let membershipStatus = baseDetail?.membershipStatus ?? 'not-member'
  if (isInMyGroups || isCreator) {
    membershipStatus = 'member'
  }
  const membersWithSelf = new Set(baseDetail?.members || [])
  if (membershipStatus === 'member' && pubkey) {
    membersWithSelf.add(pubkey)
  }
  const mockMembersConfig = useMemo(() => {
    if (process.env.NODE_ENV !== 'development') return null
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    if (!params.has('mockMembers')) return null

    let parsed: string[] | null = null
    const raw = params.get('mockMembers')
    if (raw) {
      try {
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          parsed = data.filter((m) => typeof m === 'string' && m.length > 10)
        }
      } catch (err) {
        console.warn('[GroupPage] mockMembers parse failed, using defaults', err)
      }
    }

    const normalizeMockMember = (m: string) => {
      try {
        const decoded = nip19.decode(m)
        if (decoded.type === 'npub') return decoded.data as string
        if (decoded.type === 'nprofile' && typeof decoded.data === 'object' && 'pubkey' in decoded.data) {
          return (decoded.data as any).pubkey as string
        }
      } catch {
        // fall through to returning raw value
      }
      return m
    }

    const defaultMembers = [
      pubkey ?? 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ]
    const members = Array.from(
      new Set((parsed?.length ? parsed : defaultMembers).map(normalizeMockMember).filter((m) => !!m && m.length > 10))
    )
    const admins = members[1] ? [{ pubkey: members[1] }] : []
    console.info('[GroupPage] mockMembers enabled', { members, admins })
    return { members, admins }
  }, [pubkey])

  const effectiveDetail = useMemo(() => {
    if (!baseDetail) return null
    const detailWithSelf = { ...baseDetail, membershipStatus, members: Array.from(membersWithSelf) }
    if (!mockMembersConfig) return detailWithSelf
    return {
      ...detailWithSelf,
      members: mockMembersConfig.members,
      admins: mockMembersConfig.admins,
      membershipStatus: 'member' as const
    }
  }, [baseDetail, membershipStatus, membersWithSelf, mockMembersConfig])
  const isOpenGroup = effectiveDetail?.metadata?.isOpen !== false

  const isAdmin =
    !!pubkey && !!effectiveDetail?.admins?.some((admin) => admin.pubkey === pubkey)

  const groupDisplayName =
    effectiveDetail?.metadata?.name || fallbackMeta?.name || groupId || t('Group')
  const groupPicture = effectiveDetail?.metadata?.picture || fallbackMeta?.picture
  const groupTitle = (
    <span className="inline-flex items-center gap-2 min-w-0">
     
      <span className="truncate">{groupDisplayName}</span>
    </span>
  )

  const relayUrlToCopy = resolvedGroupRelay || effectiveGroupRelay

  const filteredMembers = useMemo(() => {
    const term = memberSearch.trim().toLowerCase()
    const members = effectiveDetail?.members || []
    if (!term) return members
    return members.filter((m) => {
      const normalized = m.toLowerCase()
      let npub: string | null = null
      try {
        npub = nip19.npubEncode(m)
      } catch {
        npub = null
      }
      return normalized.includes(term) || (npub ? npub.toLowerCase().includes(term) : false)
    })
  }, [effectiveDetail?.members, memberSearch])

  const canInviteMembers = isOpenGroup || isAdmin

  const handleCopyRelayUrl = async () => {
    if (!relayUrlToCopy) return
    try {
      await navigator.clipboard.writeText(relayUrlToCopy)
      setCopiedRelayUrl(true)
      setTimeout(() => setCopiedRelayUrl(false), 2000)
    } catch (err) {
      toast.error(t('Failed to copy to clipboard'))
      console.error('[GroupPage] failed to copy relay URL', err)
    }
  }

  const handleInviteToggle = (pubkey: string) => {
    setSelectedInvitees((prev) =>
      prev.includes(pubkey) ? prev.filter((p) => p !== pubkey) : [...prev, pubkey]
    )
  }

  const handleInviteSubmit = async () => {
    if (!groupId || !selectedInvitees.length) return
    setIsSendingInvite(true)
    try {
      await sendInvites(groupId, selectedInvitees, effectiveGroupRelay)
      toast.success(t('Invites sent'))
      setSelectedInvitees([])
      setInviteSearch('')
      setIsInviteDialogOpen(false)
    } catch (err) {
      toast.error(t('Failed to send invites'))
      setError((err as Error).message)
    } finally {
      setIsSendingInvite(false)
    }
  }

  const handleGrantAdmin = React.useCallback(
    async (targetPubkey: string) => {
      if (!groupId) return
      try {
        await grantAdmin(groupId, targetPubkey, effectiveGroupRelay)
        toast.success(t('Admin permissions granted'))
      } catch (err) {
        toast.error(t('Failed to grant admin permissions'))
        setError((err as Error).message)
      }
    },
    [effectiveGroupRelay, grantAdmin, groupId, t]
  )

  const handleReportUser = React.useCallback((targetPubkey: string) => {
    setReportTarget(targetPubkey)
  }, [])

  const handleMutePrivately = React.useCallback(
    (targetPubkey: string) => {
      mutePrivately(targetPubkey)
    },
    [mutePrivately]
  )

  const handleMutePublicly = React.useCallback(
    (targetPubkey: string) => {
      mutePublicly(targetPubkey)
    },
    [mutePublicly]
  )

  const memberRows = useMemo(
    () =>
      filteredMembers.map((member) => (
        <MemoizedMemberRow
          key={member}
          memberPubkey={member}
          isSelf={member === pubkey}
          showGrantAdmin={isAdmin && member !== pubkey}
          canMute={member !== pubkey}
          nostrProfile={nostrProfile}
          pubkey={pubkey}
          onGrantAdmin={handleGrantAdmin}
          onReportUser={handleReportUser}
          onMutePrivately={handleMutePrivately}
          onMutePublicly={handleMutePublicly}
          t={t}
        />
      )),
    [
      filteredMembers,
      handleGrantAdmin,
      handleMutePrivately,
      handleMutePublicly,
      handleReportUser,
      isAdmin,
      nostrProfile,
      pubkey,
      t
    ]
  )

  const content = (
    <SecondaryPageLayout
      ref={ref}
      index={index}
      title={groupTitle}
    >
      {isLoading ? (
        <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('Loading...')}
        </div>
      ) : error ? (
        <div className="text-red-500 px-4 py-3">{error}</div>
      ) : (!effectiveDetail || !groupId) ? (
        <div className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground">
          <Users className="w-6 h-6" />
          {t('Group not found')}
        </div>
      ) : (
        <div className="space-y-4 pb-6">
          <Card className="overflow-hidden border-0 shadow-none">
            <CardContent className="p-4 space-y-3">
              <div className="flex gap-3 items-start">
                {effectiveDetail.metadata?.picture && (
                  <img
                    src={effectiveDetail.metadata.picture}
                    alt={effectiveDetail.metadata.name}
                    className="w-16 h-16 rounded-lg object-cover"
                  />
                )}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-2xl font-semibold truncate">
                      {effectiveDetail.metadata?.name || groupId}
                    </div>
                    <div className="flex items-center gap-1">
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="titlebar-icon"
                          onClick={() => setIsMetadataDialogOpen(true)}
                          title={t('Edit metadata')}
                        >
                          <Settings className="w-5 h-5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="titlebar-icon"
                        onClick={handleCopyRelayUrl}
                        disabled={!relayUrlToCopy}
                        title={t('Copy URL')}
                      >
                        {copiedRelayUrl ? (
                          <Check className="w-5 h-5" />
                        ) : (
                          <Copy className="w-5 h-5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="titlebar-icon"
                        onClick={() => toggleFavorite(groupKey)}
                        title={isFavorite ? t('Remove from favorites') : t('Add to favorites')}
                      >
                        <Star className={`w-5 h-5 ${isFavorite ? 'fill-current text-yellow-500' : ''}`} />
                      </Button>
                    </div>
                  </div>
                  {effectiveDetail.metadata?.about && (
                    <div className="text-sm text-muted-foreground whitespace-pre-line">
                      {effectiveDetail.metadata.about}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    {effectiveDetail.metadata?.isPublic === false && <span>{t('Private')}</span>}
                    {effectiveDetail.metadata?.isOpen === false && <span>{t('Closed')}</span>}
                    {effectiveDetail.members && effectiveDetail.members.length > 0 && (
                      <span>
                        {effectiveDetail.members.length}{' '}
                        {effectiveDetail.members.length === 1 ? t('member') : t('members')}
                      </span>
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
              {effectiveDetail.admins && effectiveDetail.admins.length > 0 && (
                <div className="flex gap-2 flex-wrap text-sm text-muted-foreground">
                  {effectiveDetail.admins.map((admin) => (
                    <div
                      key={admin.pubkey}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"
                    >
                      <UserAvatar userId={admin.pubkey} size="xSmall" />
                      <Username userId={admin.pubkey} className="text-xs" />
                      {(() => {
                        const roles = Array.isArray((admin as any).roles) ? (admin as any).roles : []
                        return roles.length > 0 ? (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {roles.join(', ')}
                        </span>
                        ) : null
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as 'notes' | 'members')}
            className="w-full"
          >
            <div className="border-b border-t">
              <TabsList className="w-full justify-start h-auto p-0 bg-transparent px-4">
                <TabsTrigger
                  value="notes"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                >
                  {t('Notes')}
                </TabsTrigger>
                <TabsTrigger
                  value="members"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-3"
                >
                  {t('Members')}
                  {effectiveDetail.members ? ` (${effectiveDetail.members.length})` : ''}
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="notes" className="mt-0">
              <NormalFeed
                subRequests={groupSubRequests}
                isMainFeed={false}
              />
            </TabsContent>
            <TabsContent value="members" className="mt-0">
              <div className="space-y-4">
                <div className="px-4 py-3 border-b flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder={t('Search users...') as string}
                      className="pl-9"
                    />
                  </div>
                  {canInviteMembers && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 shrink-0 rounded-lg"
                      onClick={() => setIsInviteDialogOpen(true)}
                      title={t('Invite members')}
                    >
                      <UserPlus className="w-5 h-5" />
                    </Button>
                  )}
                </div>
                <div className="space-y-2">{memberRows}</div>
              </div>
            </TabsContent>
          </Tabs>
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
            relay: resolvedGroupRelay || effectiveGroupRelay,
            name: effectiveDetail?.metadata?.name,
            picture: groupPicture
          }}
          openFrom={resolvedGroupRelay ? [resolvedGroupRelay] : effectiveGroupRelay ? [effectiveGroupRelay] : undefined}
        />
      )}
      {reportEvent && (
        <ReportDialog
          event={reportEvent}
          isOpen={!!reportTarget}
          closeDialog={() => setReportTarget(null)}
        />
      )}
      <Dialog
        open={isInviteDialogOpen}
        onOpenChange={(open) => {
          setIsInviteDialogOpen(open)
          if (!open) {
            setSelectedInvitees([])
            setInviteSearch('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Invite members')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={inviteSearch}
                onChange={(e) => setInviteSearch(e.target.value)}
                placeholder={t('Search users...') as string}
                className="pl-9"
              />
            </div>
            <div className="max-h-64 overflow-y-auto space-y-2">
              {inviteSearch && isSearchingInvites && (
                <div className="text-sm text-muted-foreground px-2">{t('Searching...')}</div>
              )}
              {inviteSearch && !isSearchingInvites && inviteProfiles.length === 0 && (
                <div className="text-sm text-muted-foreground px-2">{t('No users found')}</div>
              )}
              {inviteProfiles
                .filter((profile) => !(effectiveDetail?.members || []).includes(profile.pubkey))
                .map((profile) => {
                  const isSelected = selectedInvitees.includes(profile.pubkey)
                  return (
                    <div
                      key={profile.pubkey}
                      className="flex items-center gap-2 hover:bg-accent rounded px-2 py-1 transition-colors"
                    >
                      <UserAvatar userId={profile.pubkey} className="shrink-0" />
                      <div className="flex-1 overflow-hidden">
                        <Username
                          userId={profile.pubkey}
                          className="font-semibold truncate max-w-full w-fit"
                        />
                        <Nip05 pubkey={profile.pubkey} />
                      </div>
                      <Button
                        variant={isSelected ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => handleInviteToggle(profile.pubkey)}
                        className="flex-shrink-0 h-8 px-3"
                      >
                        {isSelected ? (
                          <>
                            <Check className="w-3 h-3 mr-1" />
                            {t('Added')}
                          </>
                        ) : (
                          <>
                            <UserPlus className="w-3 h-3 mr-1" />
                            {t('Add')}
                          </>
                        )}
                      </Button>
                    </div>
                  )
                })}
            </div>
            {selectedInvitees.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedInvitees.map((pk) => (
                  <Button
                    key={pk}
                    variant="secondary"
                    size="sm"
                    className="flex items-center gap-2"
                    onClick={() => handleInviteToggle(pk)}
                  >
                    <UserAvatar userId={pk} size="xSmall" />
                    <Username userId={pk} className="truncate max-w-[8rem]" />
                    <span className="text-xs text-muted-foreground">{t('Remove')}</span>
                  </Button>
                ))}
              </div>
            )}
            <Button
              onClick={handleInviteSubmit}
              disabled={!selectedInvitees.length || isSendingInvite}
              className="w-full"
            >
              {isSendingInvite && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('Invite')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
            isOpen={isMetadataDialogOpen}
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
