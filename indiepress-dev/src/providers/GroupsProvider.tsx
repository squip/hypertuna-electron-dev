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
  toggleFavorite: (groupKey: string) => void
  saveMyGroupList: (entries: TGroupListEntry[]) => Promise<void>
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
  const { relays: workerRelays } = useWorkerBridge()
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
    workerRelays.forEach((r) => {
      if (r.relayKey && r.connectionUrl) map.set(r.relayKey, r.connectionUrl)
      if (r.publicIdentifier && r.connectionUrl) {
        map.set(r.publicIdentifier, r.connectionUrl)
        map.set(r.publicIdentifier.replace(':', '/'), r.connectionUrl)
      }
    })
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
      const events = await client.fetchEvents(discoveryRelays, {
        kinds: [ExtendedKind.GROUP_METADATA],
        limit: 200
      })
      const parsed = events.map((evt) => {
        const parsedId = parseGroupIdentifier(evt.tags.find((t) => t[0] === 'd')?.[1] ?? '')
        return parseGroupMetadataEvent(evt, parsedId.relay)
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
      const relays = resolved ? [resolved] : defaultDiscoveryRelays
      const [metadataEvt] = await client.fetchEvents(relays, {
        kinds: [ExtendedKind.GROUP_METADATA],
        '#d': [groupId],
        limit: 1
      })

      const [adminsEvt] = await client.fetchEvents(relays, {
        kinds: [39001],
        '#d': [groupId],
        limit: 1
      })

      const [membersEvt] = await client.fetchEvents(relays, {
        kinds: [39002],
        '#d': [groupId],
        limit: 1
      })

      const membershipEvents = await client.fetchEvents(relays, {
        kinds: [9000, 9001],
        '#h': [groupId],
        limit: 50
      })

      const joinRequests = pubkey
        ? await client.fetchEvents(relays, {
            kinds: [9021],
            authors: [pubkey],
            '#h': [groupId],
            limit: 10
          })
        : []

      const membershipStatus = pubkey
        ? deriveMembershipStatus(pubkey, membershipEvents, joinRequests)
        : 'not-member'

      const metadata = metadataEvt ? parseGroupMetadataEvent(metadataEvt, relay) : null
      const admins = adminsEvt ? parseGroupAdminsEvent(adminsEvt) : []
      const members = membersEvt ? parseGroupMembersEvent(membersEvt) : []

      return { metadata, admins, members, membershipStatus }
    },
    [pubkey, resolveRelayUrl]
  )

  const saveMyGroupList = useCallback(
    async (entries: TGroupListEntry[]) => {
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

      await publish(draftEvent)
      setMyGroupList(entries)
    },
    [pubkey, publish]
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

  const value = useMemo(
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
      createGroup: async ({
        name,
        about,
        picture,
        isPublic,
        isOpen,
        relays
      }) => {
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
      }
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
      publish
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
