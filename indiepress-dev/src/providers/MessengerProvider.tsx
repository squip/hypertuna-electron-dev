import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNostr } from './NostrProvider'
import { MultiPartyMessenger, createNDKWithSigner } from '@/lib/messaging/multi-party-messenger'
import type { ConversationMeta, DMMessage, MessengerEvent } from '@/lib/messaging/types'
import NDKCacheAdapterDexie from '@nostr-dev-kit/cache-dexie'
import { MemoryStorage } from '@/lib/messaging/storage'
import { CacheStorage } from '@/lib/messaging/cache-storage'
import NDK, { NDKNip07Signer } from '@nostr-dev-kit/ndk'
import * as nip49 from '@nostr/tools/nip49'
import Dexie from 'dexie'

const PASSWORD_PROMPT = 'Enter the password to decrypt your ncryptsec for messaging'
const debug = (...args: any[]) => console.debug('[MessengerProvider]', ...args)

type MessengerContextType = {
  messenger: MultiPartyMessenger | null
  conversations: ConversationMeta[]
  ready: boolean
  unsupportedReason?: string
  drainBufferedMessages: (conversationId: string) => DMMessage[]
}

const MessengerContext = createContext<MessengerContextType | undefined>(undefined)

export function useMessenger() {
  const ctx = useContext(MessengerContext)
  if (!ctx) throw new Error('useMessenger must be used within MessengerProvider')
  return ctx
}

export function MessengerProvider({ children }: { children: React.ReactNode }) {
  const { pubkey, relayList, nsec, ncryptsec, isReady } = useNostr()
  const [messenger, setMessenger] = useState<MultiPartyMessenger | null>(null)
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [unsupportedReason, setUnsupportedReason] = useState<string | undefined>(undefined)
  const ready = useRef(false)
  const [readyFlag, setReadyFlag] = useState(false)
  const messageBufferRef = useRef<Map<string, DMMessage[]>>(new Map())

  useEffect(() => {
    debug('ready state', { readyFlag, hasMessenger: !!messenger })
  }, [readyFlag, messenger])

  useEffect(() => {
    const init = async () => {
      if (!isReady || !pubkey || !relayList) return
      debug('init start', { isReady, pubkey, relays: relayList })
      setUnsupportedReason(undefined)
      setReadyFlag(false)

      const primaryDbName = 'fevela-nip17'
      const fallbackDbName = `fevela-nip17-v2-${Date.now()}`

      const discoveryRelay = import.meta.env.VITE_DISCOVERY_RELAY as string | undefined
      const relayUrls = Array.from(
        new Set([
          ...((relayList.read || []) as string[]),
          ...((relayList.write || []) as string[]),
          discoveryRelay
        ].filter(Boolean))
      ) as string[]

      let mp: MultiPartyMessenger | null = null
      let off: (() => void) | null = null

      try {
        const cacheAdapter = new NDKCacheAdapterDexie({ dbName: primaryDbName })
        let ndk: NDK | null = null

        if (nsec) {
          ndk = createNDKWithSigner(nsec, relayUrls, discoveryRelay, cacheAdapter)
        } else if (ncryptsec) {
          const password = typeof window !== 'undefined' ? window.prompt(PASSWORD_PROMPT) : null
          if (!password) {
            setUnsupportedReason('Password required to decrypt ncryptsec for messaging.')
            setReadyFlag(true)
            return
          }
          const privkey = nip49.decrypt(ncryptsec, password)
          ndk = createNDKWithSigner(privkey, relayUrls, discoveryRelay, cacheAdapter)
        } else if (typeof window !== 'undefined' && (window as any).nostr) {
          const signer = new NDKNip07Signer(10_000)
          ndk = new NDK({
            explicitRelayUrls: relayUrls,
            signer
          })
          if (signer.blockUntilReady) {
            await signer.blockUntilReady()
          }
        } else {
          setUnsupportedReason('No compatible signer available for NIP-17.')
          setReadyFlag(true)
          return
        }

        ndk.cacheAdapter = cacheAdapter as any

        await ndk.connect()
        debug('NDK connected', { relays: relayUrls.length })

        const buildStorage = async (dbName: string) => {
          const adapter = dbName === primaryDbName ? cacheAdapter : new NDKCacheAdapterDexie({ dbName })
          const storage = new CacheStorage(adapter as any)
          // ensure tables exist now so we fail early if the module is missing
          await storage.getConversations()
          debug('storage ready', dbName)
          return storage
        }

        const ensureModuleSchema = async () => {
          const db = new Dexie(`${primaryDbName}_modules`)
          db.version(3).stores({
            moduleMetadata: '&namespace',
            nip17_messages: '&id, conversationId, timestamp, sender',
            nip17_conversations: '&id, lastMessageAt'
          })
          await db.open()
          db.close()
        }

        let storage: CacheStorage | MemoryStorage
        try {
          storage = await buildStorage(primaryDbName)
          debug('storage selected', 'CacheStorage', primaryDbName)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('Collection messages not found')) {
            console.warn('Cache module missing; repairing module schema and retrying primary', msg)
            try {
              await ensureModuleSchema()
              storage = await buildStorage(primaryDbName)
              debug('storage selected', 'CacheStorage', primaryDbName, '(after repair)')
            } catch (errReset) {
              console.warn('Cache module repair failed; trying fresh DB name', fallbackDbName, errReset)
              try {
                storage = await buildStorage(fallbackDbName)
                debug('storage selected', 'CacheStorage', fallbackDbName)
              } catch (err2) {
                console.warn('Cache fallback failed; using MemoryStorage', err2)
                storage = new MemoryStorage()
                debug('storage selected', 'MemoryStorage')
              }
            }
          } else {
            console.warn('Cache adapter unavailable; using MemoryStorage', err)
            storage = new MemoryStorage()
            debug('storage selected', 'MemoryStorage')
          }
        }

        mp = new MultiPartyMessenger(ndk, { storage, explicitRelayUrls: relayUrls })
        await mp.start()
        debug('messenger started')
        ready.current = true
        setMessenger(mp)
        const convos = await mp.getConversations()
        debug('initial conversations', convos.length)
        setConversations(convos)

        off = mp.on(async (event: MessengerEvent) => {
          if (event.type === 'message') {
            debug('event message', {
              id: event.message.id,
              conversationId: event.message.conversationId,
              read: event.message.read
            })
            // buffer in case UI listeners are not attached yet
            const buf = messageBufferRef.current.get(event.message.conversationId) || []
            buf.push(event.message)
            // keep the latest 30 per conversation to avoid unbounded growth
            messageBufferRef.current.set(event.message.conversationId, buf.slice(-30))
          } else if (
            event.type === 'conversation-created' ||
            event.type === 'conversation-updated'
          ) {
            debug('event conversation', { type: event.type, id: event.conversation.id, unread: event.conversation.unreadCount })
            setConversations((prev) => {
              const existing = prev.find((c) => c.id === event.conversation.id)
              const same =
                existing &&
                existing.lastMessageAt === event.conversation.lastMessageAt &&
                existing.unreadCount === event.conversation.unreadCount &&
                existing.lastReadAt === event.conversation.lastReadAt &&
                existing.lastReadId === event.conversation.lastReadId &&
                existing.subject === event.conversation.subject
              if (same) {
                return prev
              }
              const without = prev.filter((c) => c.id !== event.conversation.id)
              return [...without, event.conversation].sort(
                (a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)
              )
            })
          }
        })
      } catch (err) {
        console.error('Failed to initialize NIP-17 messenger', err)
        setUnsupportedReason(
          err instanceof Error ? err.message : 'Unable to initialize NIP-17 messaging with this signer.'
        )
        setMessenger(null)
      } finally {
        setReadyFlag(true)
      }

      return () => {
        if (off) off()
        debug('cleanup messenger')
        mp?.stop()
      }
    }

    const cleanupPromise = init()
    return () => {
      cleanupPromise?.then((cleanup) => cleanup?.())
    }
  }, [isReady, pubkey, relayList, nsec, ncryptsec])

  const value = useMemo(
    () => ({
      messenger,
      conversations,
      ready: readyFlag,
      unsupportedReason,
      drainBufferedMessages: (conversationId: string) => {
        const buf = messageBufferRef.current.get(conversationId) || []
        messageBufferRef.current.delete(conversationId)
        return buf
      }
    }),
    [messenger, conversations, unsupportedReason, readyFlag]
  )

  return <MessengerContext.Provider value={value}>{children}</MessengerContext.Provider>
}
