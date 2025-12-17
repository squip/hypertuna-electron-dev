import type { ConversationMeta, DMMessage } from './types'

const debug = (...args: any[]) => console.debug('[MessagingStorage]', ...args)

export interface StorageAdapter {
  saveMessage(message: DMMessage): Promise<void>
  getMessages(conversationId: string, limit?: number): Promise<DMMessage[]>
  markAsRead(messageIds: string[]): Promise<void>
  getConversations(): Promise<ConversationMeta[]>
  saveConversation(conversation: ConversationMeta): Promise<void>
  setLastRead(conversationId: string, lastReadId: string, lastReadAt: number): Promise<void>
}

export class MemoryStorage implements StorageAdapter {
  private conversations = new Map<string, ConversationMeta>()
  private messages = new Map<string, DMMessage[]>()

  async saveMessage(message: DMMessage): Promise<void> {
    const list = this.messages.get(message.conversationId) || []
    const exists = list.find((m) => m.id === message.id)
    if (!exists) {
      list.push(message)
      list.sort((a, b) => a.timestamp - b.timestamp)
      this.messages.set(message.conversationId, list)
      debug('saveMessage', { id: message.id, conversationId: message.conversationId, total: list.length })
    }
  }

  async getMessages(conversationId: string, limit?: number): Promise<DMMessage[]> {
    const list = this.messages.get(conversationId) || []
    if (limit && list.length > limit) {
      debug('getMessages limited', { conversationId, limit, total: list.length })
      return list.slice(-limit)
    }
    debug('getMessages', { conversationId, total: list.length })
    return [...list]
  }

  async markAsRead(messageIds: string[]): Promise<void> {
    for (const [, list] of this.messages) {
      list.forEach((msg) => {
        if (messageIds.includes(msg.id)) {
          msg.read = true
        }
      })
    }
    debug('markAsRead', { count: messageIds.length })
  }

  async getConversations(): Promise<ConversationMeta[]> {
    const list = Array.from(this.conversations.values())
    debug('getConversations', { total: list.length })
    return list
  }

  async saveConversation(conversation: ConversationMeta): Promise<void> {
    this.conversations.set(conversation.id, conversation)
    debug('saveConversation', { id: conversation.id, unreadCount: conversation.unreadCount })
  }

  async setLastRead(conversationId: string, lastReadId: string, lastReadAt: number): Promise<void> {
    const convo = this.conversations.get(conversationId)
    if (convo) {
      convo.lastReadId = lastReadId
      convo.lastReadAt = lastReadAt
      this.conversations.set(conversationId, convo)
    }
    const list = this.messages.get(conversationId) || []
    list.forEach((m) => {
      if (m.timestamp <= lastReadAt) {
        m.read = true
      }
    })
    debug('setLastRead', { conversationId, lastReadId, lastReadAt })
  }
}
