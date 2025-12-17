import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNostr } from './NostrProvider'
import { NotepadService } from '@/services/notepad.service'
import { NotepadCache, type CachedNotepadNote } from '@/lib/notepad/cache'
import NDKCacheAdapterDexie from '@nostr-dev-kit/cache-dexie'
import { createNDKWithSigner } from '@/lib/messaging/multi-party-messenger'
import NDK, { NDKNip07Signer } from '@nostr-dev-kit/ndk'
import * as nip49 from '@nostr/tools/nip49'

type NotepadContextType = {
  ready: boolean
  notes: Map<string, CachedNotepadNote>
  publish: (draftEvent: any, options: { isDraft: boolean; relayUrls?: string[] }) => Promise<void>
  refresh: () => Promise<void>
}

const NotepadContext = createContext<NotepadContextType | undefined>(undefined)

export function useNotepad() {
  const ctx = useContext(NotepadContext)
  if (!ctx) throw new Error('useNotepad must be used within NotepadProvider')
  return ctx
}

export function NotepadProvider({ children }: { children: React.ReactNode }) {
  const { pubkey, relayList, nsec, ncryptsec, isReady, signEvent } = useNostr()
  const [ready, setReady] = useState(false)
  const [notes, setNotes] = useState<Map<string, CachedNotepadNote>>(new Map())
  const serviceRef = useRef<NotepadService | null>(null)
  const relayUrlsRef = useRef<string[]>([])

  useEffect(() => {
    return () => {
      serviceRef.current?.stop()
      serviceRef.current = null
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      setReady(false)
      serviceRef.current?.stop()
      serviceRef.current = null

      if (!isReady || !pubkey || !relayList) return

      const discoveryRelay = import.meta.env.VITE_DISCOVERY_RELAY as string | undefined
      const relayUrls = Array.from(
        new Set(
          [...(relayList.read || []), ...(relayList.write || []), discoveryRelay].filter(
            (u): u is string => !!u
          )
        )
      )
      relayUrlsRef.current = relayUrls

      let ndk: NDK | null = null
      let cacheAdapter: any = null
      try {
        cacheAdapter = new NDKCacheAdapterDexie({ dbName: 'fevela-notepad' })
      } catch (err) {
        console.warn('Notepad cache adapter unavailable', err)
      }

      try {
        if (nsec) {
          ndk = createNDKWithSigner(nsec, relayUrls, discoveryRelay, cacheAdapter)
        } else if (ncryptsec) {
          const password = typeof window !== 'undefined' ? window.prompt('Enter the password to decrypt your ncryptsec for notepad') : null
          if (!password) {
            console.warn('Password required to decrypt ncryptsec for notepad.')
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
          return
        }

        if (!ndk) return

        await ndk.connect()
        const adapter = cacheAdapter || (ndk as any).cacheAdapter
        if (!adapter) {
          console.warn('Notepad cache adapter missing; aborting NotepadService init')
          return
        }
        const cache = new NotepadCache(adapter)
        const service = new NotepadService(ndk, cache, pubkey)
        service.onNotesUpdated = (map) => setNotes(new Map(map))
        serviceRef.current = service
        await service.start(relayUrls)
        setNotes(new Map(service.latestNotes))
        setReady(true)

        const interval = setInterval(() => {
          setNotes(new Map(service.latestNotes))
        }, 5_000)

        return () => {
          clearInterval(interval)
          service.stop()
        }
      } catch (err) {
        console.error('Failed to initialize NotepadService', err)
      }
    }

    const cleanupPromise = init()
    return () => {
      cleanupPromise?.then((cleanup) => {
        if (typeof cleanup === 'function') cleanup()
      })
    }
  }, [isReady, pubkey, relayList, nsec, ncryptsec])

  const value = useMemo(
    () => ({
      ready,
      notes,
      publish: async (draftEvent: any, options: { isDraft: boolean; relayUrls?: string[] }) => {
        if (!serviceRef.current) throw new Error('Notepad not initialized')
        const relays = options.relayUrls?.length ? options.relayUrls : relayUrlsRef.current
        const signed = await signEvent(draftEvent)
        await serviceRef.current.wrapAndPublish(signed as any, relays)
      },
      refresh: async () => {
        if (!serviceRef.current) return
        await serviceRef.current.refresh(relayUrlsRef.current)
        setNotes(new Map(serviceRef.current.latestNotes))
      }
    }),
    [ready, notes, signEvent]
  )

  return <NotepadContext.Provider value={value}>{children}</NotepadContext.Provider>
}
