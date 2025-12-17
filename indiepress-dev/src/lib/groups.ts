import { Event } from '@nostr/tools/wasm'
import { TGroupAdmin, TGroupIdentifier, TGroupInvite, TGroupListEntry, TGroupMetadata, TGroupMembershipStatus, TGroupRoles } from '@/types/groups'

export function parseGroupIdentifier(rawId: string): TGroupIdentifier {
  if (rawId.includes("'")) {
    const [relay, groupId] = rawId.split("'")
    return { rawId, relay, groupId }
  }
  return { rawId, groupId: rawId }
}

export function buildGroupIdForCreation(creatorNpub: string, name: string): string {
  const sanitizedName = name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9-_]/g, '')
  return `${creatorNpub}-${sanitizedName}`
}

export function parseGroupMetadataEvent(event: Event, relay?: string): TGroupMetadata {
  const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  const name = event.tags.find((t) => t[0] === 'name')?.[1] ?? (d || 'Untitled Group')
  const about = event.tags.find((t) => t[0] === 'about')?.[1]
  const picture = event.tags.find((t) => t[0] === 'picture')?.[1]
  const isPublic = event.tags.some((t) => t[0] === 'public')
  const isOpen = event.tags.some((t) => t[0] === 'open')
  const tags = event.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1])

  return {
    id: d,
    relay,
    name,
    about,
    picture,
    isPublic,
    isOpen,
    tags,
    event
  }
}

export function parseGroupAdminsEvent(event: Event): TGroupAdmin[] {
  return event.tags
    .filter((t) => t[0] === 'p' && t[1])
    .map((t) => ({
      pubkey: t[1],
      roles: t.slice(2)
    }))
}

export function parseGroupMembersEvent(event: Event): string[] {
  return event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1])
}

export function parseGroupRolesEvent(event: Event): TGroupRoles {
  const roles = event.tags
    .filter((t) => t[0] === 'role' && t[1])
    .map((t) => ({ name: t[1], description: t[2] }))

  return { roles, event }
}

export function parseGroupInviteEvent(event: Event, relay?: string): TGroupInvite {
  const groupId = event.tags.find((t) => t[0] === 'h')?.[1] || ''
  return {
    groupId,
    relay,
    // Token is encrypted in content per requirements; decrypted elsewhere
    token: undefined,
    event
  }
}

export function parseGroupListEvent(event: Event): TGroupListEntry[] {
  return event.tags
    .filter((t) => t[0] === 'g' && t[1])
    .map((t) => {
      const { groupId, relay } = parseGroupIdentifier(t[1])
      return { groupId, relay }
    })
}

export function deriveMembershipStatus(
  pubkey: string,
  events: Event[],
  joinRequests: Event[] = []
): TGroupMembershipStatus {
  const relevant = events
    .filter((evt) => evt.kind === 9000 || evt.kind === 9001)
    .sort((a, b) => b.created_at - a.created_at)
  if (relevant[0]) {
    if (relevant[0].kind === 9000) return 'member'
    if (relevant[0].kind === 9001) return 'removed'
  }

  const latestRequest = joinRequests
    .filter((evt) => evt.kind === 9021 && evt.pubkey === pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0]

  if (latestRequest) {
    return 'pending'
  }

  return 'not-member'
}
