import type {
  CacheModuleCollection,
  CacheModuleDefinition,
  CacheModuleStorage
} from '@nostr-dev-kit/ndk'
import type { ConversationMeta, DMMessage } from './types'
import type { StorageAdapter } from './storage'
import { NDKUser } from '@nostr-dev-kit/ndk'

const MODULE_NAMESPACE = 'nip17'

const moduleDefinition: CacheModuleDefinition = {
  namespace: MODULE_NAMESPACE,
  version: 2,
  collections: {
    messages: {
      primaryKey: 'id',
      indexes: ['conversationId', 'timestamp', 'sender']
    },
    conversations: {
      primaryKey: 'id',
      indexes: ['lastMessageAt']
    }
  },
  migrations: {
    1: async (ctx) => {
      await ctx.createCollection('messages', moduleDefinition.collections.messages)
      await ctx.createCollection('conversations', moduleDefinition.collections.conversations)
    },
    2: async (ctx) => {
      // Ensure collections exist on upgrade
      await ctx.createCollection('messages', moduleDefinition.collections.messages)
      await ctx.createCollection('conversations', moduleDefinition.collections.conversations)
    }
  }
}

/**
 * Cache-backed storage using NDK cache modules (Dexie adapter).
 */
export class CacheStorage implements StorageAdapter {
  private adapter: CacheModuleStorage
  private ready: Promise<void>
  private messages?: CacheModuleCollection<DMMessage>
  private conversations?: CacheModuleCollection<ConversationMeta>

  constructor(adapter: CacheModuleStorage) {
    if (typeof (adapter as any)?.getModuleCollection !== 'function') {
      throw new Error('Cache adapter does not support cache modules API')
    }
    this.adapter = adapter
    this.ready = this.init()
  }

  private async init() {
    if (!this.adapter.registerModule) {
      throw new Error('Cache adapter does not support module registration')
    }

    const needsRegister =
      !this.adapter.hasModule || !this.adapter.hasModule(MODULE_NAMESPACE)
    const version = (this.adapter as any)?.getModuleVersion
      ? await (this.adapter as any).getModuleVersion(MODULE_NAMESPACE)
      : 0

    if (needsRegister || version < moduleDefinition.version) {
      await this.adapter.registerModule(moduleDefinition)
    }

    const getCollections = async () => {
      const messages = await (this.adapter as unknown as {
        getModuleCollection: (
          namespace: string,
          collection: string
        ) => Promise<CacheModuleCollection<DMMessage>>
      }).getModuleCollection(MODULE_NAMESPACE, 'messages')

      const conversations = await (this.adapter as unknown as {
        getModuleCollection: (
          namespace: string,
          collection: string
        ) => Promise<CacheModuleCollection<ConversationMeta>>
      }).getModuleCollection(MODULE_NAMESPACE, 'conversations')

      return { messages, conversations }
    }

    let collections: { messages: CacheModuleCollection<DMMessage>; conversations: CacheModuleCollection<ConversationMeta> }
    try {
      collections = await getCollections()
    } catch (err) {
      // Attempt to recover by registering the module schema again (helps when collection is missing)
      await this.adapter.registerModule(moduleDefinition)
      collections = await getCollections()
    }

    this.messages = collections.messages
    this.conversations = collections.conversations
  }

  private async ensureReady() {
    await this.ready
    if (!this.messages || !this.conversations) {
      throw new Error('CacheStorage not initialized')
    }
  }

  private serializeMessage(message: DMMessage) {
    return {
      id: message.id,
      type: message.type,
      content: message.content,
      senderPubkey: message.sender.pubkey,
      recipientPubkeys: (message.recipients || []).map((r) => r.pubkey),
      timestamp: message.timestamp,
      protocol: message.protocol,
      read: message.read,
      conversationId: message.conversationId,
      replyTo: message.replyTo,
      tags: message.tags
    }
  }

  private deserializeMessage(raw: any): DMMessage {
    const sender = new NDKUser({ pubkey: raw.senderPubkey || raw.sender })
    const recipients = (raw.recipientPubkeys || []).map(
      (pk: string | { pubkey: string }) => new NDKUser({ pubkey: typeof pk === 'string' ? pk : pk.pubkey })
    )
    return {
      id: raw.id,
      type: raw.type,
      content: raw.content,
      sender,
      recipients,
      timestamp: raw.timestamp,
      protocol: raw.protocol,
      read: !!raw.read,
      conversationId: raw.conversationId,
      replyTo: raw.replyTo,
      tags: raw.tags
    }
  }

  async saveMessage(message: DMMessage): Promise<void> {
    await this.ensureReady()
    await this.messages!.save(this.serializeMessage(message) as any)
  }

  async getMessages(conversationId: string, limit?: number): Promise<DMMessage[]> {
    await this.ensureReady()
    const list = await this.messages!.findBy('conversationId', conversationId)
    const sorted = list
      .map((m: any) => this.deserializeMessage(m))
      .sort((a, b) => a.timestamp - b.timestamp)
    if (limit && sorted.length > limit) {
      return sorted.slice(-limit)
    }
    return sorted
  }

  async markAsRead(messageIds: string[]): Promise<void> {
    await this.ensureReady()
    const msgs = await this.messages!.getMany(messageIds)
    if (!msgs.length) return
    const updated = msgs.map((m: any) => ({ ...m, read: true }))
    await this.messages!.saveMany(updated)
  }

  async getConversations(): Promise<ConversationMeta[]> {
    await this.ensureReady()
    return this.conversations!.all()
  }

  async saveConversation(conversation: ConversationMeta): Promise<void> {
    await this.ensureReady()
    await this.conversations!.save(conversation)
  }

  async setLastRead(conversationId: string, lastReadId: string, lastReadAt: number): Promise<void> {
    await this.ensureReady()
    const convo = await this.conversations!.get(conversationId)
    if (convo) {
      convo.lastReadId = lastReadId
      convo.lastReadAt = lastReadAt
      await this.conversations!.save(convo)
    }
    const msgs = await this.messages!.findBy('conversationId', conversationId)
    if (msgs.length) {
      const updated = msgs.map((m: any) => ({
        ...m,
        read: m.timestamp <= lastReadAt || m.id === lastReadId
      }))
      await this.messages!.saveMany(updated)
    }
  }
}
