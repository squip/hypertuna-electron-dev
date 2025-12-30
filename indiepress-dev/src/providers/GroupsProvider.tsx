import { BIG_RELAY_URLS, ExtendedKind } from '@/constants'
import {
  deriveMembershipStatus,
  parseGroupAdminsEvent,
  parseGroupIdentifier,
  parseGroupInviteEvent,
  parseGroupListEvent,
  parseGroupMembersEvent,
  parseGroupMetadataEvent,
  buildGroupIdForCreation
} from '@/lib/groups'
import {
  buildHypertunaAdminBootstrapDraftEvents,
  buildHypertunaDiscoveryDraftEvents,
  getBaseRelayUrl,
  HYPERTUNA_IDENTIFIER_TAG,
  isHypertunaTaggedEvent,
  KIND_HYPERTUNA_RELAY,
  parseHypertunaRelayEvent30166
} from '@/lib/hypertuna-group-events'
import { TDraftEvent } from '@/types'
import {
  TGroupAdmin,
  TGroupInvite,
  TGroupListEntry,
  TGroupMembershipStatus,
  TGroupMetadata
} from '@/types/groups'
import client from '@/services/client.service'
import localStorageService from '@/services/local-storage.service'
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useNostr } from './NostrProvider'
import { randomString } from '@/lib/random'
import { useWorkerBridge } from './WorkerBridgeProvider'
import type { TPublishOptions } from '@/types'

type TGroupsContext = {
  discoveryGroups: TGroupMetadata[]
  invites: TGroupInvite[]
  favoriteGroups: string[]
  myGroupList: TGroupListEntry[]
  isLoadingDiscovery: boolean
  discoveryError: string | null
  invitesError: string | null
  refreshDiscovery: () => Promise<void>
  refreshInvites: () => Promise<void>
  resolveRelayUrl: (relay?: string) => string | undefined
  toggleFavorite: (groupKey: string) => void
  saveMyGroupList: (entries: TGroupListEntry[], options?: TPublishOptions) => Promise<void>
  sendJoinRequest: (groupId: string, relay?: string, code?: string, reason?: string) => Promise<void>
  sendLeaveRequest: (groupId: string, relay?: string, reason?: string) => Promise<void>
  fetchGroupDetail: (groupId: string, relay?: string) => Promise<{
    metadata: TGroupMetadata | null
    admins: TGroupAdmin[]
    members: string[]
    membershipStatus: TGroupMembershipStatus
  }>
  sendInvites: (groupId: string, invitees: string[], relay?: string) => Promise<void>
  updateMetadata: (groupId: string, data: Partial<{ name: string; about: string; picture: string; isPublic: boolean; isOpen: boolean }>, relay?: string) => Promise<void>
  addUser: (groupId: string, targetPubkey: string, relay?: string) => Promise<void>
  removeUser: (groupId: string, targetPubkey: string, relay?: string) => Promise<void>
  deleteGroup: (groupId: string, relay?: string) => Promise<void>
  deleteEvent: (groupId: string, eventId: string, relay?: string) => Promise<void>
  createGroup: (data: {
    name: string
    about?: string
    picture?: string
    isPublic: boolean
    isOpen: boolean
    relays?: string[]
  }) => Promise<{ groupId: string; relay: string }>
  createHypertunaRelayGroup: (data: {
    name: string
    about?: string
    isPublic: boolean
    isOpen: boolean
    fileSharing?: boolean
  }) => Promise<{ groupId: string; relay: string }>
}

const GroupsContext = createContext<TGroupsContext | undefined>(undefined)

export const useGroups = () => {
  const context = useContext(GroupsContext)
  if (!context) {
    throw new Error('useGroups must be used within a GroupsProvider')
  }
  return context
}

const defaultDiscoveryRelays = BIG_RELAY_URLS

const toGroupKey = (groupId: string, relay?: string) => (relay ? `${relay}|${groupId}` : groupId)

export function GroupsProvider({ children }: { children: ReactNode }) {
  const { pubkey, publish, relayList, nip04Decrypt, nip04Encrypt } = useNostr()
  const { relays: workerRelays, joinFlows, createRelay } = useWorkerBridge()
  const [discoveryGroups, setDiscoveryGroups] = useState<TGroupMetadata[]>([])
  const [invites, setInvites] = useState<TGroupInvite[]>([])
  const [favoriteGroups, setFavoriteGroups] = useState<string[]>([])
  const [myGroupList, setMyGroupList] = useState<TGroupListEntry[]>([])
  const [isLoadingDiscovery, setIsLoadingDiscovery] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [invitesError, setInvitesError] = useState<string | null>(null)
  const [discoveryRelays, setDiscoveryRelays] = useState<string[]>(() => {
    const stored = localStorageService.getGroupDiscoveryRelays()
    return stored.length ? stored : defaultDiscoveryRelays
  })

  const workerRelayUrlMap = useMemo(() => {
    const map = new Map<string, string>()
    const withAuth = (url?: string, token?: string) => {
      if (!url) return url
      try {
        const u = new URL(url)
        if (token && !u.searchParams.has('token')) {
          u.searchParams.set('token', token)
          return u.toString()
        }
        return url
      } catch (_err) {
        return url
      }
    }
    workerRelays.forEach((r) => {
      const token = r.userAuthToken || (r as any)?.authToken
      const authUrl = withAuth(r.connectionUrl, token)
      if (r.relayKey && authUrl) map.set(r.relayKey, authUrl)
      if (r.publicIdentifier && authUrl) {
        map.set(r.publicIdentifier, authUrl)
        map.set(r.publicIdentifier.replace(':', '/'), authUrl)
      }
      if (authUrl) {
        const base = getBaseRelayUrl(authUrl)
        if (base) map.set(base, authUrl)
      }
    })
    console.info('[GroupsProvider] workerRelays', workerRelays)
    console.info('[GroupsProvider] relayUrlMap', Array.from(map.entries()))
    return map
  }, [workerRelays])

  const resolveRelayUrl = useCallback(
    (relay?: string) => {
      if (!relay) return relay
      return workerRelayUrlMap.get(relay) || relay
    },
    [workerRelayUrlMap]
  )

  useEffect(() => {
    setFavoriteGroups(localStorageService.getFavoriteGroups(pubkey))
  }, [pubkey])

  const refreshDiscovery = useCallback(async () => {
    setIsLoadingDiscovery(true)
    setDiscoveryError(null)
    try {
      const [metadataEvents, relayEvents] = await Promise.all([
        client.fetchEvents(discoveryRelays, {
          kinds: [ExtendedKind.GROUP_METADATA],
          limit: 200
        }),
        client.fetchEvents(discoveryRelays, {
          kinds: [KIND_HYPERTUNA_RELAY],
          '#i': [HYPERTUNA_IDENTIFIER_TAG],
          limit: 300
        })
      ])

      const hypertunaRelayUrlById = new Map<string, string>()
      relayEvents.forEach((evt) => {
        const parsed = parseHypertunaRelayEvent30166(evt)
        if (!parsed) return
        hypertunaRelayUrlById.set(parsed.publicIdentifier, getBaseRelayUrl(parsed.wsUrl))
      })

      const parsed = metadataEvents.map((evt) => {
        const parsedId = parseGroupIdentifier(evt.tags.find((t) => t[0] === 'd')?.[1] ?? '')
        const meta = parseGroupMetadataEvent(evt, parsedId.relay)
        if (isHypertunaTaggedEvent(evt)) {
          const relayUrl = hypertunaRelayUrlById.get(meta.id)
          if (relayUrl) {
            return { ...meta, relay: relayUrl }
          }
        }
        return meta
      })

      const seen = new Set<string>()
      const deduped = parsed.filter((g) => {
        const key = toGroupKey(g.id, g.relay)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      setDiscoveryGroups(deduped)
    } catch (error) {
      console.warn('Failed to refresh discovery groups', error)
      setDiscoveryError((error as Error).message)
    } finally {
      setIsLoadingDiscovery(false)
    }
  }, [discoveryRelays])

  const refreshInvites = useCallback(async () => {
    if (!pubkey) {
      setInvites([])
      return
    }
    try {
      const events = await client.fetchEvents(discoveryRelays, {
        kinds: [9009],
        '#p': [pubkey],
        limit: 200
      })
      const parsed = await Promise.all(
        events.map(async (evt) => {
          const invite = parseGroupInviteEvent(evt)
          if (!evt.content) return invite
          try {
            const token = await nip04Decrypt(evt.pubkey, evt.content)
            return { ...invite, token }
          } catch (_err) {
            return invite
          }
        })
      )
      setInvites(parsed)
    } catch (error) {
      console.warn('Failed to refresh group invites', error)
      setInvitesError((error as Error).message)
    }
  }, [discoveryRelays, nip04Decrypt, pubkey])

  const loadMyGroupList = useCallback(async () => {
    if (!pubkey) {
      setMyGroupList([])
      return
    }

    try {
      const relays = relayList?.read?.length ? relayList.read : BIG_RELAY_URLS
      const events = await client.fetchEvents(relays, {
        kinds: [10009],
        authors: [pubkey],
        limit: 1
      })
      const sorted = events.sort((a, b) => b.created_at - a.created_at)
      const latest = sorted[0]
      if (!latest) {
        setMyGroupList([])
        return
      }
      const entries = parseGroupListEvent(latest)
      setMyGroupList(entries)
    } catch (error) {
      console.warn('Failed to load group list (10009)', error)
    }
  }, [pubkey, relayList])

  useEffect(() => {
    loadMyGroupList()
  }, [loadMyGroupList])

  useEffect(() => {
    localStorageService.setGroupDiscoveryRelays(discoveryRelays)
  }, [discoveryRelays])

  const toggleFavorite = useCallback(
    (groupKey: string) => {
      if (localStorageService.isFavoriteGroup(groupKey, pubkey)) {
        localStorageService.removeFavoriteGroup(groupKey, pubkey)
      } else {
        localStorageService.addFavoriteGroup(groupKey, pubkey)
      }
      setFavoriteGroups(localStorageService.getFavoriteGroups(pubkey))
    },
    [pubkey]
  )

  const fetchGroupDetail = useCallback(
    async (groupId: string, relay?: string) => {
      const resolved = relay ? resolveRelayUrl(relay) : null
      // If we have an authenticated/tokenized relay, prefer it, but always include public discovery relays
      const groupRelays = resolved ? [resolved] : defaultDiscoveryRelays
      const metadataRelays = Array.from(
        new Set([...(resolved ? [resolved] : []), ...discoveryRelays])
      )

      let metadataEvt = null as any
      try {
        const events = await client.fetchEvents(metadataRelays, {
          kinds: [ExtendedKind.GROUP_METADATA],
          '#d': [groupId],
          limit: 5
        })
        metadataEvt = events.sort((a, b) => b.created_at - a.created_at)[0] || null
      } catch (error) {
        console.warn('Failed to fetch group metadata', error)
        metadataEvt = null
      }

      let adminsEvt = null as any
      let membersEvt = null as any
      let membershipEvents: any[] = []
      let joinRequests: any[] = []

      try {
        ;[adminsEvt] = await client.fetchEvents(groupRelays, {
          kinds: [39001],
          '#d': [groupId],
          limit: 1
        })
      } catch (_) {
        adminsEvt = null
      }

      try {
        ;[membersEvt] = await client.fetchEvents(groupRelays, {
          kinds: [39002],
          '#d': [groupId],
          limit: 1
        })
      } catch (_) {
        membersEvt = null
      }

      try {
        membershipEvents = await client.fetchEvents(groupRelays, {
          kinds: [9000, 9001],
          '#h': [groupId],
          limit: 50
        })
      } catch (_) {
        membershipEvents = []
      }

      if (pubkey) {
        try {
          joinRequests = await client.fetchEvents(groupRelays, {
            kinds: [9021],
            authors: [pubkey],
            '#h': [groupId],
            limit: 10
          })
        } catch (_) {
          joinRequests = []
        }
      }

      const membershipStatus = pubkey
        ? deriveMembershipStatus(pubkey, membershipEvents, joinRequests)
        : 'not-member'

      const metadata = metadataEvt ? parseGroupMetadataEvent(metadataEvt, relay) : null
      const admins = adminsEvt ? parseGroupAdminsEvent(adminsEvt) : []
      const members = membersEvt ? parseGroupMembersEvent(membersEvt) : []

      return { metadata, admins, members, membershipStatus }
    },
    [discoveryRelays, pubkey, resolveRelayUrl]
  )

  const saveMyGroupList = useCallback(
    async (entries: TGroupListEntry[], options?: TPublishOptions) => {
      if (!pubkey) throw new Error('Not logged in')
      const tags: string[][] = [['d', 'groups']]
      entries.forEach((entry) => {
        const tagValue = entry.relay ? `${entry.relay}'${entry.groupId}` : entry.groupId
        tags.push(['g', tagValue])
      })

      const draftEvent: TDraftEvent = {
        kind: 10009,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ''
      }

      await publish(draftEvent, options)
      setMyGroupList(entries)
    },
    [pubkey, publish]
  )

  const processedJoinFlowsRef = useMemo(() => new Set<string>(), [])

  useEffect(() => {
    processedJoinFlowsRef.clear()
  }, [processedJoinFlowsRef, pubkey])

  useEffect(() => {
    if (!pubkey) return

    Object.values(joinFlows || {}).forEach((flow) => {
      if (!flow || flow.phase !== 'success') return
      const identifier = flow.publicIdentifier
      if (!identifier) return
      if (processedJoinFlowsRef.has(identifier)) return

      const relayUrl = flow.relayUrl
      if (typeof relayUrl !== 'string' || !relayUrl) return
      const baseUrl = getBaseRelayUrl(relayUrl)
      if (!baseUrl) return

      const already = myGroupList.some((e) => e.groupId === identifier && e.relay === baseUrl)
      if (already) {
        processedJoinFlowsRef.add(identifier)
        return
      }

      processedJoinFlowsRef.add(identifier)
      const updated = [...myGroupList, { groupId: identifier, relay: baseUrl }]
      saveMyGroupList(updated, { specifiedRelayUrls: BIG_RELAY_URLS }).catch(() => {})
    })
  }, [joinFlows, myGroupList, pubkey, saveMyGroupList, processedJoinFlowsRef])

  useEffect(() => {
    if (!pubkey) return
    if (!workerRelays.length) return

    const desired = new Map<string, string>()
    workerRelays.forEach((relay) => {
      const publicIdentifier = relay.publicIdentifier
      const connectionUrl = relay.connectionUrl
      if (!publicIdentifier || !connectionUrl) return
      if (!publicIdentifier.includes(':')) return
      const baseUrl = getBaseRelayUrl(connectionUrl)
      if (!baseUrl) return
      desired.set(publicIdentifier, baseUrl)
    })

    if (!desired.size) return

    let changed = false
    const next = myGroupList.map((entry) => {
      const targetRelay = desired.get(entry.groupId)
      if (!targetRelay) return entry
      const currentRelay = entry.relay ? getBaseRelayUrl(entry.relay) : null
      if (currentRelay === targetRelay) return entry
      changed = true
      return { ...entry, relay: targetRelay }
    })

    desired.forEach((relay, groupId) => {
      const exists = next.some((e) => e.groupId === groupId && getBaseRelayUrl(e.relay || '') === relay)
      if (!exists) {
        changed = true
        next.push({ groupId, relay })
      }
    })

    if (!changed) return

    // Don’t force BIG_RELAY_URLS here; use normal publish routing (privacy-preserving for token-joins).
    saveMyGroupList(next).catch(() => {})
  }, [myGroupList, pubkey, saveMyGroupList, workerRelays])

  const createHypertunaRelayGroup = useCallback(
    async ({
      name,
      about,
      isPublic,
      isOpen,
      fileSharing
    }: {
      name: string
      about?: string
      isPublic: boolean
      isOpen: boolean
      fileSharing?: boolean
    }) => {
      if (!pubkey) throw new Error('Not logged in')
      const result = await createRelay({
        name,
        description: about || undefined,
        isPublic,
        isOpen,
        fileSharing
      })
      if (!result?.success) throw new Error(result?.error || 'Failed to create relay')

      const publicIdentifier = result.publicIdentifier
      const authenticatedRelayUrl = result.relayUrl
      if (!publicIdentifier || !authenticatedRelayUrl) {
        throw new Error('Worker did not return a publicIdentifier/relayUrl')
      }

      const relayWsUrl = getBaseRelayUrl(authenticatedRelayUrl)

      const { groupCreateEvent, metadataEvent, hypertunaEvent } = buildHypertunaDiscoveryDraftEvents({
        publicIdentifier,
        name,
        about,
        isPublic,
        isOpen,
        fileSharing,
        relayWsUrl
      })

      if (isPublic) {
        await Promise.all([
          publish(groupCreateEvent, { specifiedRelayUrls: BIG_RELAY_URLS }),
          publish(metadataEvent, { specifiedRelayUrls: BIG_RELAY_URLS }),
          publish(hypertunaEvent, { specifiedRelayUrls: BIG_RELAY_URLS })
        ])
      }

      const updatedList = [
        ...myGroupList.filter((entry) => entry.groupId !== publicIdentifier),
        { groupId: publicIdentifier, relay: relayWsUrl }
      ]
      await saveMyGroupList(
        updatedList,
        isPublic ? { specifiedRelayUrls: BIG_RELAY_URLS } : undefined
      )

      // Publish the same discovery events to the group relay itself (authenticated URL).
      await Promise.all([
        publish(groupCreateEvent, { specifiedRelayUrls: [authenticatedRelayUrl] }),
        publish(metadataEvent, { specifiedRelayUrls: [authenticatedRelayUrl] }),
        publish(hypertunaEvent, { specifiedRelayUrls: [authenticatedRelayUrl] })
      ])

      // Bootstrap admin/member snapshots on the group relay.
      const { adminListEvent, memberListEvent } = buildHypertunaAdminBootstrapDraftEvents({
        publicIdentifier,
        adminPubkeyHex: pubkey,
        name
      })
      await Promise.all([
        publish(adminListEvent, { specifiedRelayUrls: [authenticatedRelayUrl] }),
        publish(memberListEvent, { specifiedRelayUrls: [authenticatedRelayUrl] })
      ])

      return { groupId: publicIdentifier, relay: relayWsUrl }
    },
    [createRelay, myGroupList, pubkey, publish, saveMyGroupList]
  )

  const sendJoinRequest = useCallback(
    async (groupId: string, relay?: string, code?: string, reason?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const tags: string[][] = [['h', groupId]]
      if (code) {
        tags.push(['code', code])
      }
      const draftEvent: TDraftEvent = {
        kind: 9021,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: reason ?? ''
      }

      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const sendLeaveRequest = useCallback(
    async (groupId: string, relay?: string, reason?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9022,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId]],
        content: reason ?? ''
      }

      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const sendInvites = useCallback(
    async (groupId: string, invitees: string[], relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      if (!invitees.length) return

      const resolved = relay ? resolveRelayUrl(relay) : null
      const relayUrls = resolved ? [resolved] : defaultDiscoveryRelays
      await Promise.all(
        invitees.map(async (invitee) => {
          const token = randomString(24)
          const encrypted = await nip04Encrypt(invitee, token)
          const draftEvent: TDraftEvent = {
            kind: 9009,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['h', groupId],
              ['p', invitee]
            ],
            content: encrypted
          }
          await publish(draftEvent, { specifiedRelayUrls: relayUrls })
        })
      )
    },
    [nip04Encrypt, pubkey, publish, resolveRelayUrl]
  )

  const updateMetadata = useCallback(
    async (
      groupId: string,
      data: Partial<{ name: string; about: string; picture: string; isPublic: boolean; isOpen: boolean }>,
      relay?: string
    ) => {
      if (!pubkey) throw new Error('Not logged in')
      const tags: string[][] = [['h', groupId]]
      if (typeof data.name === 'string') tags.push(['name', data.name])
      if (typeof data.about === 'string') tags.push(['about', data.about])
      if (typeof data.picture === 'string') tags.push(['picture', data.picture])
      if (typeof data.isPublic === 'boolean') tags.push([data.isPublic ? 'public' : 'private'])
      if (typeof data.isOpen === 'boolean') tags.push([data.isOpen ? 'open' : 'closed'])

      const draftEvent: TDraftEvent = {
        kind: 9002,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const addUser = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9000,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['p', targetPubkey]
        ],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const removeUser = useCallback(
    async (groupId: string, targetPubkey: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9001,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['p', targetPubkey]
        ],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const deleteGroup = useCallback(
    async (groupId: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9008,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId]],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const deleteEvent = useCallback(
    async (groupId: string, eventId: string, relay?: string) => {
      if (!pubkey) throw new Error('Not logged in')
      const draftEvent: TDraftEvent = {
        kind: 9005,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['h', groupId],
          ['e', eventId]
        ],
        content: ''
      }
      const resolved = relay ? resolveRelayUrl(relay) : undefined
      await publish(draftEvent, { specifiedRelayUrls: resolved ? [resolved] : undefined })
    },
    [pubkey, publish, resolveRelayUrl]
  )

  const value = useMemo<TGroupsContext>(
    () => ({
      discoveryGroups,
      invites,
      favoriteGroups,
      myGroupList,
      isLoadingDiscovery,
      discoveryError,
      invitesError,
      refreshDiscovery,
      refreshInvites,
      resolveRelayUrl,
      toggleFavorite,
      saveMyGroupList,
      sendJoinRequest,
      sendLeaveRequest,
      fetchGroupDetail,
      sendInvites,
      updateMetadata,
      addUser,
      removeUser,
      deleteGroup,
      deleteEvent,
      createGroup: async (data) => {
        const { name, about, picture, isPublic, isOpen, relays } = data
        if (!pubkey) throw new Error('Not logged in')
        const targetRelays = relays?.length ? relays : discoveryRelays
        const groupId = buildGroupIdForCreation(pubkey, name)

        const creationEvent: TDraftEvent = {
          kind: 9007,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['h', groupId]],
          content: ''
        }

        const metadataTags: string[][] = [['h', groupId]]
        metadataTags.push(['name', name])
        if (about) metadataTags.push(['about', about])
        if (picture) metadataTags.push(['picture', picture])
        metadataTags.push([isPublic ? 'public' : 'private'])
        metadataTags.push([isOpen ? 'open' : 'closed'])

        const metadataEvent: TDraftEvent = {
          kind: 9002,
          created_at: Math.floor(Date.now() / 1000),
          tags: metadataTags,
          content: ''
        }

        await publish(creationEvent, { specifiedRelayUrls: targetRelays })
        await publish(metadataEvent, { specifiedRelayUrls: targetRelays })

        setDiscoveryRelays(targetRelays)
        const updatedList = [...myGroupList, { groupId, relay: targetRelays[0] }]
        setMyGroupList(updatedList)
        await saveMyGroupList(updatedList)
        return { groupId, relay: targetRelays[0] }
      },
      createHypertunaRelayGroup
    }),
    [
      discoveryGroups,
      favoriteGroups,
      invites,
      myGroupList,
      isLoadingDiscovery,
      discoveryError,
      invitesError,
      refreshDiscovery,
      refreshInvites,
      saveMyGroupList,
      sendJoinRequest,
      sendLeaveRequest,
      fetchGroupDetail,
      sendInvites,
      updateMetadata,
      addUser,
      removeUser,
      deleteGroup,
      deleteEvent,
      toggleFavorite,
      pubkey,
      discoveryRelays,
      publish,
      resolveRelayUrl,
      createHypertunaRelayGroup
    ]
  )

  useEffect(() => {
    refreshDiscovery()
  }, [refreshDiscovery])

  useEffect(() => {
    refreshInvites()
  }, [refreshInvites])

  return <GroupsContext.Provider value={value}>{children}</GroupsContext.Provider>
}
