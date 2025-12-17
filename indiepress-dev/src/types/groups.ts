import { Event } from '@nostr/tools/wasm'

export type TGroupIdentifier = {
  rawId: string
  groupId: string
  relay?: string
}

export type TGroupMetadata = {
  id: string
  relay?: string
  name: string
  about?: string
  picture?: string
  isPublic?: boolean
  isOpen?: boolean
  tags: string[]
  event: Event
}

export type TGroupAdmin = {
  pubkey: string
  roles: string[]
}

export type TGroupMembershipStatus = 'member' | 'not-member' | 'removed' | 'pending'

export type TGroupMemberSnapshot = {
  pubkeys: string[]
  event: Event
}

export type TGroupRoles = {
  roles: { name: string; description?: string }[]
  event: Event
}

export type TGroupInvite = {
  groupId: string
  relay?: string
  token?: string
  event: Event
}

export type TGroupListEntry = {
  groupId: string
  relay?: string
}
