import { Event } from '@nostr/tools/wasm'
import { TDraftEvent } from '@/types'

export const HYPERTUNA_IDENTIFIER_TAG = 'hypertuna:relay'

export const KIND_GROUP_CREATE = 9007
export const KIND_GROUP_METADATA = 39000
export const KIND_GROUP_ADMIN_LIST = 39001
export const KIND_GROUP_MEMBER_LIST = 39002
export const KIND_HYPERTUNA_RELAY = 30166

export function getBaseRelayUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.delete('token')
    return u.toString().replace(/\?$/, '')
  } catch {
    return String(url || '').split('?')[0]
  }
}

function hasIdentifierTag(tags: string[][]): boolean {
  return tags.some((t) => t[0] === 'i' && t[1] === HYPERTUNA_IDENTIFIER_TAG)
}

export function isHypertunaTaggedEvent(event: Pick<Event, 'tags'> | null | undefined): boolean {
  const tags = event?.tags
  if (!Array.isArray(tags)) return false
  return hasIdentifierTag(tags as any)
}

function getTagValue(event: Pick<Event, 'tags'>, tagName: string): string | null {
  const tags = (event.tags || []) as any
  const found = tags.find((t: any) => Array.isArray(t) && t[0] === tagName)
  return typeof found?.[1] === 'string' ? found[1] : null
}

export function parseHypertunaRelayEvent30166(
  event: Pick<Event, 'kind' | 'tags'>
): { publicIdentifier: string; wsUrl: string } | null {
  if (event.kind !== KIND_HYPERTUNA_RELAY) return null
  const wsUrl = getTagValue(event, 'd')
  const publicIdentifier = getTagValue(event, 'h') || getTagValue(event, 'hypertuna')
  if (!wsUrl || !publicIdentifier) return null
  return { publicIdentifier, wsUrl }
}

export function buildHypertunaDiscoveryDraftEvents(args: {
  publicIdentifier: string
  name: string
  about?: string
  isPublic: boolean
  isOpen: boolean
  fileSharing?: boolean
  relayWsUrl: string
  pictureTagUrl?: string
}): { groupCreateEvent: TDraftEvent; metadataEvent: TDraftEvent; hypertunaEvent: TDraftEvent } {
  const now = Math.floor(Date.now() / 1000)
  const fileSharingEnabled = args.fileSharing !== false

  const groupTags: string[][] = [
    ['h', args.publicIdentifier],
    ['name', String(args.name)],
    ['about', args.about ? String(args.about) : ''],
    ['hypertuna', args.publicIdentifier],
    ['i', HYPERTUNA_IDENTIFIER_TAG],
    [args.isPublic ? 'public' : 'private'],
    [args.isOpen ? 'open' : 'closed'],
    [fileSharingEnabled ? 'file-sharing-on' : 'file-sharing-off']
  ]

  if (args.pictureTagUrl) {
    groupTags.push(['picture', args.pictureTagUrl, 'hypertuna:drive:pfp'])
  }

  const groupCreateEvent: TDraftEvent = {
    kind: KIND_GROUP_CREATE,
    created_at: now,
    tags: groupTags,
    content: `Created group: ${args.name}`
  }

  const metadataTags: string[][] = [
    ['d', args.publicIdentifier],
    ['name', String(args.name)],
    ['about', args.about ? String(args.about) : ''],
    ['hypertuna', args.publicIdentifier],
    ['i', HYPERTUNA_IDENTIFIER_TAG],
    [args.isPublic ? 'public' : 'private'],
    [args.isOpen ? 'open' : 'closed'],
    [fileSharingEnabled ? 'file-sharing-on' : 'file-sharing-off']
  ]

  if (args.pictureTagUrl) {
    metadataTags.push(['picture', args.pictureTagUrl, 'hypertuna:drive:pfp'])
  }

  const metadataEvent: TDraftEvent = {
    kind: KIND_GROUP_METADATA,
    created_at: now,
    tags: metadataTags,
    content: `Group metadata for: ${args.name}`
  }

  const hypertunaEvent: TDraftEvent = {
    kind: KIND_HYPERTUNA_RELAY,
    created_at: now,
    tags: [
      ['d', args.relayWsUrl],
      ['hypertuna', args.publicIdentifier],
      ['h', args.publicIdentifier],
      ['i', HYPERTUNA_IDENTIFIER_TAG]
    ],
    content: `Hypertuna relay for group: ${args.name}`
  }

  return { groupCreateEvent, metadataEvent, hypertunaEvent }
}

export function buildHypertunaAdminBootstrapDraftEvents(args: {
  publicIdentifier: string
  adminPubkeyHex: string
  name: string
}): { adminListEvent: TDraftEvent; memberListEvent: TDraftEvent } {
  const now = Math.floor(Date.now() / 1000)
  const tags: string[][] = [
    ['d', args.publicIdentifier],
    ['hypertuna', args.publicIdentifier],
    ['p', args.adminPubkeyHex, 'admin']
  ]

  const adminListEvent: TDraftEvent = {
    kind: KIND_GROUP_ADMIN_LIST,
    created_at: now,
    tags,
    content: `Admin list for group: ${args.name}`
  }

  const memberListEvent: TDraftEvent = {
    kind: KIND_GROUP_MEMBER_LIST,
    created_at: now,
    tags,
    content: `Member list for group: ${args.name}`
  }

  return { adminListEvent, memberListEvent }
}

