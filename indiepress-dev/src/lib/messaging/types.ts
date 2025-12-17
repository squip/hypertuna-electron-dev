import type { NDKUser, NostrEvent } from '@nostr-dev-kit/ndk'

export type MessageProtocol = 'nip17'

export type DMMessageType = 'text' | 'reaction'

export type DMMessage = {
  id: string
  type: DMMessageType
  content: string
  sender: NDKUser
  recipients: NDKUser[]
  timestamp: number
  protocol: MessageProtocol
  read: boolean
  rumor?: NostrEvent
  conversationId: string
  replyTo?: string
  tags?: string[][]
}

export type ConversationMeta = {
  id: string
  participants: string[]
  protocol: MessageProtocol
  subject?: string
  unreadCount: number
  lastMessageAt?: number
  lastReadAt?: number
  lastReadId?: string
}

export type MessengerEvent =
  | { type: 'message'; message: DMMessage }
  | { type: 'conversation-updated'; conversation: ConversationMeta }
  | { type: 'conversation-created'; conversation: ConversationMeta }
  | { type: 'error'; error: Error }

export type SendMessageOptions = {
  subject?: string
  replyTo?: string
}

export type SendReactionOptions = {
  targetEventId: string
  content: string
}
