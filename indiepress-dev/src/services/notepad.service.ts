import NDK, { giftUnwrap, giftWrap, NDKEvent, NDKKind, NDKRelaySet, NDKUser } from '@nostr-dev-kit/ndk'
import { NotepadCache, type CachedNotepadNote } from '@/lib/notepad/cache'
import { getEventHash } from 'nostr-tools/pure'
import { Event as NostrEvent } from '@nostr/tools/wasm'

const debug = (...args: any[]) => console.debug('[NotepadService]', ...args)

export class NotepadService {
  private ndk: NDK
  private cache: NotepadCache
  private pubkey: string
  private subscription: any = null
  private notes = new Map<string, CachedNotepadNote>()
  onNotesUpdated?: (notes: Map<string, CachedNotepadNote>) => void

  constructor(ndk: NDK, cache: NotepadCache, pubkey: string) {
    this.ndk = ndk
    this.cache = cache
    this.pubkey = pubkey
  }

  get latestNotes() {
    return this.notes
  }

  async loadFromCache() {
    this.notes = await this.cache.getLatestByPubkey(this.pubkey)
    debug('cache loaded', { size: this.notes.size })
  }

  async start(relayUrls: string[]) {
    await this.loadFromCache()
    await this.initialSync(relayUrls)
    await this.subscribe(relayUrls)
  }

  async stop() {
    this.subscription?.stop?.()
    this.subscription = null
  }

  async subscribe(relayUrls: string[]) {
    const relaySet = relayUrls.length ? NDKRelaySet.fromRelayUrls(relayUrls, this.ndk) : undefined
    this.subscription = this.ndk.subscribe(
      {
        kinds: [NDKKind.GiftWrap],
        '#p': [this.pubkey]
      },
      { closeOnEose: false, subId: 'notepad', groupable: false, relaySet }
    )
    this.subscription.on('event', (evt: NDKEvent) => {
      this.handleGiftWrap(evt).catch((err) => debug('unwrap error', err))
    })
  }

  private isNotepadRumor(evt: NostrEvent) {
    if (![30023, 30024].includes(evt.kind)) return false
    const hasTag = evt.tags.some((tag) => tag[0] === 't' && tag[1] === `notepad:${this.pubkey}`)
    return hasTag && evt.pubkey === this.pubkey
  }

  async handleGiftWrap(wrapped: NDKEvent) {
    if (!this.ndk.signer) return
    const rumor = await giftUnwrap(wrapped, undefined, this.ndk.signer)
    if (!rumor) return
    const raw = rumor.rawEvent() as NostrEvent
    if (!raw.id) {
      raw.id = getEventHash({
        ...raw,
        kind: raw.kind ?? 0,
        created_at: raw.created_at ?? 0,
        tags: raw.tags ?? [],
        content: raw.content ?? '',
        pubkey: raw.pubkey ?? ''
      })
    }
    if (!this.isNotepadRumor(raw)) return

    const d = raw.tags.find((t) => t[0] === 'd')?.[1] || ''
    const key = `${raw.kind}:${raw.pubkey}:${d || raw.id}`
    const saved = await this.cache.save({
      key,
      d,
      pubkey: raw.pubkey,
      kind: raw.kind,
      created_at: raw.created_at,
      content: raw.content,
      tags: raw.tags,
      id: raw.id,
      wrapId: wrapped.id,
      relays: wrapped.relay ? [wrapped.relay.url] : []
    })

    const existing = this.notes.get(d)
    if (!existing || saved.created_at >= existing.created_at) {
      this.notes.set(d, saved)
      this.onNotesUpdated?.(this.notes)
    }
  }

  async wrapAndPublish(rumor: NostrEvent, relayUrls: string[]) {
    if (!this.ndk.signer) {
      throw new Error('NDK signer required')
    }
    const recipient = new NDKUser({ pubkey: this.pubkey })
    const relaySet = relayUrls.length ? NDKRelaySet.fromRelayUrls(relayUrls, this.ndk) : undefined
    const wrapped = await giftWrap(new NDKEvent(this.ndk, rumor as any), recipient, this.ndk.signer)
    await wrapped.publish(relaySet)
    return wrapped
  }

  private async initialSync(relayUrls: string[]) {
    if (!this.ndk.signer) return
    const relaySet = relayUrls.length ? NDKRelaySet.fromRelayUrls(relayUrls, this.ndk) : undefined
    try {
      const events = await this.ndk.fetchEvents(
        {
          kinds: [NDKKind.GiftWrap],
          '#p': [this.pubkey]
        },
        { closeOnEose: true, relaySet }
      )
      for (const evt of events) {
        await this.handleGiftWrap(evt)
      }
    } catch (err) {
      debug('initial sync error', err)
    }
  }

  async refresh(relayUrls: string[]) {
    await this.initialSync(relayUrls)
  }
}
