import NDK, {
  NDKFilter,
  NDKKind,
  NDKEvent,
  NDKPrivateKeySigner,
  NDKRelaySet,
  NDKSubscription,
  NDKUser
} from '@nostr-dev-kit/ndk'
import type { ConversationMeta, DMMessage, MessengerEvent, SendMessageOptions } from './types'
import { MultiPartyNIP17Protocol } from './nip17-protocol'
import { MemoryStorage, type StorageAdapter } from './storage'
import { SimpleEmitter } from './emitter'

type MessengerOptions = {
  discoveryRelay?: string
  explicitRelayUrls?: string[]
  storage?: StorageAdapter
}

const DEFAULT_DISCOVERY = 'wss://hypertuna.com/relay'

const debug = (...args: any[]) => console.debug('[MultiPartyMessenger]', ...args)

export class MultiPartyMessenger {
  private ndk: NDK
  private protocol: MultiPartyNIP17Protocol
  private storage: StorageAdapter
  private emitter = new SimpleEmitter<MessengerEvent>()
  private conversations = new Map<string, ConversationMeta>()
  private messages = new Map<string, DMMessage[]>()
  private myPubkey?: string
  private subscription?: NDKSubscription
  private discoveryRelay: string
  private lastReceiptPublishedAt = 0
  private lastActivityAt = 0
  private subWatchdog: ReturnType<typeof setInterval> | null = null
  private relayCache = new Map<string, string[]>()
  private explicitRelays: string[]
  private lastMarkDebugSig = new Map<string, string>()
  private pendingReadMarkers = new Map<
    string,
    { lastReadAt: number; lastReadId?: string; subject?: string }
  >()

  constructor(ndk: NDK, options: MessengerOptions = {}) {
    this.ndk = ndk
    this.discoveryRelay = options.discoveryRelay || DEFAULT_DISCOVERY
    this.storage = options.storage || new MemoryStorage()
    this.explicitRelays = this.sanitizeRelays(options.explicitRelayUrls || [])

    const signer = ndk.signer
    if (!signer) {
      throw new Error('NDK signer required for messenger')
    }
    this.protocol = new MultiPartyNIP17Protocol(
      ndk,
      signer,
      this.getUserDMRelays,
      this.publishDMRelays,
      this.discoveryRelay
    )
  }

  on(cb: (event: MessengerEvent) => void) {
    const off = this.emitter.on('event', cb)
    debug('listener added', { total: this.emitter.count('event') })
    return () => {
      off()
      debug('listener removed', { total: this.emitter.count('event') })
    }
  }

  off(cb: (event: MessengerEvent) => void) {
    return this.emitter.off('event', cb)
  }

  private emit(event: MessengerEvent) {
    debug('emit', { type: event.type, listeners: this.emitter.count('event') })
    this.emitter.emit('event', event)
  }

  async start() {
    if (!this.ndk.signer) throw new Error('NDK signer required')
    const user = await this.ndk.signer.user()
    this.myPubkey = user.pubkey
    debug('start()', { myPubkey: this.myPubkey })
    await this.loadPersisted()
    await this.loadReadMarkers()
    await this.subscribe()
  }

  async stop() {
    this.subscription?.stop()
    this.subscription = undefined
    if (this.subWatchdog) {
      clearInterval(this.subWatchdog)
      this.subWatchdog = null
    }
  }

  async syncRecent(conversationId?: string, since?: number) {
    if (!this.myPubkey) return 0
    const meta = conversationId ? this.conversations.get(conversationId) : undefined
    const relayUrls = meta
      ? await this.getRelaySetForConversation(meta.participants)
      : await this.getRelaySetForConversation([this.myPubkey])
    const relaySet = relayUrls.length ? NDKRelaySet.fromRelayUrls(relayUrls, this.ndk) : undefined
    const lastTs =
      since ??
      (conversationId
        ? (this.messages.get(conversationId)?.at(-1)?.timestamp ?? 0)
        : Math.max(
            0,
            ...Array.from(this.messages.values()).map((list) => list.at(-1)?.timestamp || 0)
      ))
    const filter: NDKFilter = {
      kinds: [NDKKind.GiftWrap],
      '#p': [this.myPubkey],
      since: lastTs ? lastTs - 5 : undefined
    }
    debug('syncRecent fetch', {
      conversationId,
      since: filter.since,
      relays: relayUrls.slice(0, 5),
      relayCount: relayUrls.length
    })
    let count = 0
    try {
      const events = await this.ndk.fetchEvents(filter, { closeOnEose: true, relaySet })
      for (const evt of events) {
        await this.handleIncomingGiftWrap(evt)
        count++
      }
      debug('syncRecent done', { conversationId, fetched: count })
    } catch (err) {
      debug('syncRecent error', err)
    }
    return count
  }

  async getConversations(): Promise<ConversationMeta[]> {
    const list = Array.from(this.conversations.values()).sort(
      (a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)
    )
    debug('getConversations ->', list.length)
    return list
  }

  async getConversationMessages(conversationId: string, limit?: number): Promise<DMMessage[]> {
    const cached = this.messages.get(conversationId)
    if (cached) {
      const result = limit ? cached.slice(-limit) : cached.slice()
      debug('getConversationMessages cache hit', { conversationId, count: result.length, limit })
      return result
    }
    const stored = await this.storage.getMessages(conversationId, limit)
    this.messages.set(conversationId, stored)
    debug('getConversationMessages storage', { conversationId, count: stored.length, limit })
    return stored
  }

  async sendMessage(
    participants: NDKUser[],
    content: string,
    opts: SendMessageOptions = {}
  ): Promise<DMMessage[]> {
    if (!this.myPubkey) await this.start()
    debug('sendMessage', {
      participants: participants.map((p) => p.pubkey),
      contentLength: content?.length || 0,
      opts
    })
    const { rumor } = await this.protocol.sendMessage(participants, content, opts)
    const senderPubkey = this.myPubkey!
    const rumorMessage = this.protocol.rumorToMessage(rumor, senderPubkey)
    rumorMessage.read = true
    await this.persistMessage(rumorMessage)
    await this.publishReadMarker(rumorMessage.conversationId, rumorMessage.id, rumorMessage.timestamp)
    debug('sendMessage persisted', { id: rumorMessage.id, conversationId: rumorMessage.conversationId })
    return [rumorMessage]
  }

  async sendReaction(
    conversationId: string,
    targetEventId: string,
    content = '+'
  ): Promise<DMMessage | null> {
    if (!this.myPubkey) await this.start()
    const meta = this.conversations.get(conversationId)
    if (!meta) return null
    debug('sendReaction', { conversationId, targetEventId, content })
    const participants = meta.participants.map((p) => new NDKUser({ pubkey: p }))
    const { rumor } = await this.protocol.sendReaction(participants, {
      targetEventId,
      content
    })
    const message = this.protocol.rumorToMessage(rumor, this.myPubkey!)
    message.read = true
    await this.persistMessage(message)
    debug('sendReaction persisted', { id: message.id, conversationId })
    return message
  }

  async markConversationRead(conversationId: string) {
    const metaBefore = this.conversations.get(conversationId)
    if (metaBefore && metaBefore.unreadCount === 0) {
      debug('markConversationRead skip (no unread)', { conversationId, lastReadId: metaBefore.lastReadId })
      return
    }
    const msgs = await this.getConversationMessages(conversationId)
    if (!msgs.length) return
    const last = msgs[msgs.length - 1]
    const unreadIds = msgs
      .filter((m) => !m.read && m.sender.pubkey !== this.myPubkey)
      .map((m) => m.id)
    const debugSig = `${last.id}:${unreadIds.length}:${msgs.length}`
    if (this.lastMarkDebugSig.get(conversationId) !== debugSig) {
      debug('markConversationRead', {
        conversationId,
        total: msgs.length,
        unread: unreadIds.length,
        lastId: last.id,
        lastAt: last.timestamp
      })
      this.lastMarkDebugSig.set(conversationId, debugSig)
    }
    if (unreadIds.length === 0) {
      const meta = this.conversations.get(conversationId)
      if (meta && meta.lastReadId === last.id) {
        debug('markConversationRead skip (already up-to-date)', { conversationId, lastId: last.id })
        return
      }
    }
    if (unreadIds.length) {
      await this.storage.markAsRead(unreadIds)
      msgs.forEach((m) => {
        if (unreadIds.includes(m.id)) m.read = true
      })
    }
    const metaExisting = this.conversations.get(conversationId)
    if (metaExisting) {
      const meta = { ...metaExisting, unreadCount: 0, lastReadAt: last.timestamp, lastReadId: last.id }
      this.conversations.set(conversationId, meta)
      await this.storage.saveConversation(meta)
      await this.storage.setLastRead(conversationId, last.id, last.timestamp)
      this.emit({ type: 'conversation-updated', conversation: meta })
    }
    await this.publishReadMarker(conversationId, last.id, last.timestamp)
  }

  private async loadPersisted() {
    const metas = await this.storage.getConversations()
    debug('loadPersisted conversations', metas.length)
    metas.forEach((meta) => this.conversations.set(meta.id, meta))
    for (const meta of metas) {
      const msgs = await this.storage.getMessages(meta.id)
      debug('loadPersisted messages', { conversationId: meta.id, count: msgs.length })
      this.messages.set(meta.id, msgs)
    }
  }

  private async subscribe() {
    if (!this.myPubkey) return
    const filters: NDKFilter = {
      kinds: [NDKKind.GiftWrap],
      '#p': [this.myPubkey]
    }
    const relays = await this.getRelaySetForConversation([this.myPubkey])
    const relaySet = relays.length ? NDKRelaySet.fromRelayUrls(relays, this.ndk) : undefined
    debug('subscribe', {
      filters,
      relaySet: relays.length ? relays : 'default'
    })
    this.lastActivityAt = Date.now()
    this.subscription = this.ndk.subscribe(filters, {
      closeOnEose: false,
      subId: 'nip17-messenger',
      ...{ relaySet },
      onEvent: async (evt) => {
        this.lastActivityAt = Date.now()
        debug('subscription event', { id: evt.id, kind: evt.kind, created_at: evt.created_at })
        await this.handleIncomingGiftWrap(evt)
      }
    })
    this.startSubscriptionWatchdog()
  }

  private async handleIncomingGiftWrap(evt: NDKEvent) {
    if (!this.myPubkey) return
    this.lastActivityAt = Date.now()
    debug('handleIncomingGiftWrap start', { id: evt.id })
    try {
      const rumor = await this.protocol.unwrapMessage(evt)
      if (!rumor) {
        debug('handleIncomingGiftWrap unwrap failed', { id: evt.id, reason: 'no rumor returned' })
        return
      }
      debug('handleIncomingGiftWrap unwrap success', { id: evt.id, rumorKind: rumor.kind })
      const message = this.protocol.rumorToMessage(rumor, this.myPubkey)
      await this.persistMessage(message)
      await this.maybePublishReceipt(message.conversationId, message.id, message.timestamp)
      debug('handleIncomingGiftWrap persisted', { id: message.id, conversationId: message.conversationId })
    } catch (err) {
      console.warn('unwrapMessage failed', err)
      debug('handleIncomingGiftWrap unwrap error', { id: evt.id, err })
    }
  }

  private async persistMessage(message: DMMessage) {
    const list = this.messages.get(message.conversationId) || []
    const exists = list.find((m) => m.id === message.id)
    if (!exists) {
      const meta = this.conversations.get(message.conversationId)
      const lastReadAt = meta?.lastReadAt || 0
      if (message.sender.pubkey === this.myPubkey) {
        message.read = true
      } else if (message.read === undefined) {
        message.read = message.timestamp <= lastReadAt
      }
      list.push(message)
      list.sort((a, b) => a.timestamp - b.timestamp)
      this.messages.set(message.conversationId, list)
      this.emit({ type: 'message', message })
      try {
        await this.storage.saveMessage(message)
      } catch (err) {
        debug('persistMessage storage error', err)
      }
      await this.ensureConversationMeta(message)
      debug('persistMessage new', {
        conversationId: message.conversationId,
        id: message.id,
        read: message.read,
        total: list.length
      })
    } else {
      debug('persistMessage skip existing', { conversationId: message.conversationId, id: message.id })
    }
  }

  private async ensureConversationMeta(message: DMMessage) {
    const participants = this.extractParticipantsFromMessage(message)
    const id = this.conversationIdFromParticipants(participants)
    const subject = message.tags?.find((t) => t[0] === 'subject')?.[1]
    const existing = this.conversations.get(id)
    if (existing) {
      const prev = { ...existing }
      const updated: ConversationMeta = { ...existing, lastMessageAt: message.timestamp }
      if (message.sender.pubkey !== this.myPubkey) {
        if (!message.read) updated.unreadCount = (updated.unreadCount || 0) + 1
      }
      if (subject) updated.subject = subject
      const pending = this.pendingReadMarkers.get(id)
      if (pending) {
        updated.lastReadAt = Math.max(updated.lastReadAt || 0, pending.lastReadAt)
        if (pending.lastReadId) updated.lastReadId = pending.lastReadId
        const msgs = this.messages.get(id) || []
        let unread = 0
        msgs.forEach((m) => {
          if (m.timestamp <= (updated.lastReadAt || 0)) m.read = true
          if (!m.read && m.sender.pubkey !== this.myPubkey) unread += 1
        })
        updated.unreadCount = unread
      }
      this.conversations.set(id, updated)
      await this.storage.saveConversation(updated)
      const changed =
        prev.lastMessageAt !== updated.lastMessageAt ||
        prev.unreadCount !== updated.unreadCount ||
        prev.lastReadAt !== updated.lastReadAt ||
        prev.lastReadId !== updated.lastReadId ||
        prev.subject !== updated.subject
      if (changed) {
        this.emit({ type: 'conversation-updated', conversation: updated })
        debug('ensureConversationMeta updated', {
          id,
          unread: updated.unreadCount,
          lastMessageAt: updated.lastMessageAt
        })
      } else {
        debug('ensureConversationMeta skipped emit (no change)', { id })
      }
      return
    }
    const meta: ConversationMeta = {
      id,
      participants,
      protocol: 'nip17',
      subject,
      unreadCount: message.sender.pubkey === this.myPubkey || message.read ? 0 : 1,
      lastMessageAt: message.timestamp,
      lastReadAt: message.read ? message.timestamp : undefined,
      lastReadId: message.read ? message.id : undefined
    }
    const pending = this.pendingReadMarkers.get(id)
    if (pending) {
      meta.lastReadAt = pending.lastReadAt
      meta.lastReadId = pending.lastReadId
      const msgs = this.messages.get(id) || []
      let unread = 0
      msgs.forEach((m) => {
        if (m.timestamp <= (meta.lastReadAt || 0)) m.read = true
        if (!m.read && m.sender.pubkey !== this.myPubkey) unread += 1
      })
      meta.unreadCount = unread
    }
    this.conversations.set(id, meta)
    await this.storage.saveConversation(meta)
    this.emit({ type: 'conversation-created', conversation: meta })
    debug('ensureConversationMeta created', { id, unread: meta.unreadCount, lastMessageAt: meta.lastMessageAt })
  }

  private extractParticipantsFromMessage(message: DMMessage): string[] {
    const pTags = message.tags?.filter((t) => t[0] === 'p').map((t) => t[1]) ?? []
    const set = new Set<string>([...pTags, message.sender.pubkey, ...(message.recipients || []).map((r) => r.pubkey)])
    return Array.from(set).sort()
  }

  private conversationIdFromParticipants(participants: string[]) {
    return Array.from(new Set(participants)).sort().join(':')
  }

  private getUserDMRelays = async (user: NDKUser): Promise<string[]> => {
    try {
      const dmRelayList = await this.ndk.fetchEvent({
        kinds: [NDKKind.DirectMessageReceiveRelayList],
        authors: [user.pubkey]
      })
      if (dmRelayList) {
        const relays = dmRelayList.getMatchingTags('relay').map((t) => t[1])
        if (relays.length > 0) return this.sanitizeRelays(relays)
      }
      const relayList = await this.ndk.fetchEvent({
        kinds: [10002],
        authors: [user.pubkey]
      })
      if (relayList) {
        const relays = relayList.getMatchingTags('r').map((t) => t[1])
        if (relays.length > 0) return this.sanitizeRelays(relays.slice(0, 3))
      }
    } catch (err) {
      console.warn('Failed to load DM relays for', user.pubkey, err)
    }
    return []
  }

  private publishDMRelays = async (relays: string[]): Promise<void> => {
    const event = new NDKEvent(this.ndk)
    event.kind = NDKKind.DirectMessageReceiveRelayList
    event.tags = relays.map((r) => ['relay', r])
    event.created_at = Math.floor(Date.now() / 1000)
    await event.sign(this.ndk.signer!)
    const relaySet = NDKRelaySet.fromRelayUrls(relays, this.ndk)
    await event.publish(relaySet)
  }

  private async publishReadMarker(
    conversationId: string,
    lastMessageId: string,
    lastMessageAt: number
  ) {
    if (!this.myPubkey) return
    const now = Date.now()
    if (now - this.lastReceiptPublishedAt < 1500) return
    this.lastReceiptPublishedAt = now

    const meta = this.conversations.get(conversationId)
    if (!meta) return
    debug('publishReadMarker', { conversationId, lastMessageId, lastMessageAt })
    const payload = {
      v: 1,
      rooms: [
        {
          id: conversationId,
          last_e: lastMessageId,
          ts: lastMessageAt,
          subject: meta.subject
        }
      ]
    }

    const evt = new NDKEvent(this.ndk)
    evt.kind = 10017 as NDKKind
    evt.content = JSON.stringify(payload)
    evt.tags = []
    evt.created_at = Math.floor(Date.now() / 1000)
    const selfUser = await this.ndk.signer!.user()
    try {
      await evt.encrypt(selfUser, this.ndk.signer!, 'nip44')
    } catch (err) {
      console.warn('Failed to encrypt 10017 payload, falling back to plaintext', err)
    }
    await evt.sign(this.ndk.signer!)

    const relayUrls = await this.getRelaySetForConversation(meta.participants)
    if (!relayUrls.length) return
    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, this.ndk)
    await evt.publish(relaySet)
    debug('publishReadMarker sent', { relayCount: relayUrls.length, relays: relayUrls.slice(0, 5) })
  }

  private async maybePublishReceipt(
    conversationId: string,
    lastMessageId: string,
    lastMessageAt: number
  ) {
    await this.publishReadMarker(conversationId, lastMessageId, lastMessageAt)
  }

  private async getRelaySetForConversation(participants: string[]): Promise<string[]> {
    const key = this.conversationIdFromParticipants(participants)
    if (this.relayCache.has(key)) return this.relayCache.get(key)!

    const urls = new Set<string>([this.discoveryRelay, ...this.explicitRelays])
    for (const pk of participants) {
      const rels = await this.getUserDMRelays(new NDKUser({ pubkey: pk }))
      rels.forEach((r) => urls.add(r))
    }
    const sanitized = this.sanitizeRelays(Array.from(urls))
    this.relayCache.set(key, sanitized)
    debug('relay set resolved', { conversationId: key, relays: sanitized })
    return sanitized
  }

  private sanitizeRelays(relays: string[]) {
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const url of relays) {
      const trimmed = (url || '').trim()
      if (!trimmed) continue
      try {
        const parsed = new URL(trimmed)
        if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') continue
        const normalized = `wss://${parsed.host}${parsed.pathname}`
        if (!seen.has(normalized)) {
          seen.add(normalized)
          cleaned.push(normalized)
        }
      } catch {
        continue
      }
    }
    return cleaned
  }

  private startSubscriptionWatchdog() {
    if (this.subWatchdog) return
    this.subWatchdog = setInterval(() => {
      if (!this.subscription) return
      const idleMs = Date.now() - this.lastActivityAt
      if (idleMs > 30000) {
        debug('subscription watchdog resubscribing after idle', { idleMs })
        this.subscription?.stop()
        this.subscription = undefined
        this.subscribe()
      }
    }, 10000)
  }

  private async loadReadMarkers() {
    if (!this.myPubkey) return
    debug('loadReadMarkers start')
    try {
      const events = await this.ndk.fetchEvents(
        {
          kinds: [10017 as NDKKind],
          authors: [this.myPubkey]
        },
        { closeOnEose: true }
      )
      for (const evt of events) {
        let content = evt.content
        try {
          await evt.decrypt(undefined, this.ndk.signer, 'nip44')
          content = evt.content
        } catch {
          // ignore decrypt failures
        }
        let payload: any
        try {
          payload = JSON.parse(content || '{}')
        } catch {
          continue
        }
        const rooms = payload?.rooms
        if (!Array.isArray(rooms)) continue
        for (const room of rooms) {
          const convId = room.id as string
          const ts = Number(room.ts) || 0
          const last_e = room.last_e as string | undefined
          if (!convId || !ts) continue
          const meta = this.conversations.get(convId)
          if (!meta) {
            this.pendingReadMarkers.set(convId, { lastReadAt: ts, lastReadId: last_e, subject: room.subject })
            continue
          }
          const updated = { ...meta }
          updated.lastReadAt = Math.max(updated.lastReadAt || 0, ts)
          if (last_e) updated.lastReadId = last_e
          const msgs = this.messages.get(convId) || []
          let unread = 0
          msgs.forEach((m) => {
            if (m.timestamp <= (updated.lastReadAt || 0)) {
              m.read = true
            }
            if (!m.read && m.sender.pubkey !== this.myPubkey) unread += 1
          })
          updated.unreadCount = unread
          await this.storage.saveConversation(updated)
          this.conversations.set(convId, updated)
          this.emit({ type: 'conversation-updated', conversation: updated })
          debug('loadReadMarkers applied', {
            convId,
            ts,
            last_e,
            unread: updated.unreadCount,
            lastReadAt: updated.lastReadAt
          })
        }
      }
    } catch (err) {
      console.warn('Failed to load 10017 markers', err)
      debug('loadReadMarkers error', err)
    }
  }
}

export function createNDKWithSigner(
  secret: string | Uint8Array,
  explicitRelayUrls: string[],
  discoveryRelay = DEFAULT_DISCOVERY,
  cacheAdapter?: any
) {
  const signer = new NDKPrivateKeySigner(secret as any)
  const ndk = new NDK({
    explicitRelayUrls: Array.from(new Set([...(explicitRelayUrls || []), discoveryRelay])),
    signer,
    cacheAdapter
  })
  return ndk
}
