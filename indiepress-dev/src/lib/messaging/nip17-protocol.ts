import type NDK from '@nostr-dev-kit/ndk'
import {
  giftUnwrap,
  giftWrap,
  NDKEvent,
  NDKKind,
  NDKRelaySet,
  type NDKSigner,
  NDKUser,
  type NostrEvent
} from '@nostr-dev-kit/ndk'
import { getEventHash } from 'nostr-tools/pure'
import type { DMMessage, SendMessageOptions, SendReactionOptions } from './types'

type RelayFetcher = (user: NDKUser) => Promise<string[]>
type RelayPublisher = (relays: string[]) => Promise<void>

export class MultiPartyNIP17Protocol {
  constructor(
    private ndk: NDK,
    private signer: NDKSigner,
    private getRelays: RelayFetcher,
    private publishDMRelays: RelayPublisher,
    private discoveryRelay: string
  ) {}

  async sendMessage(
    participants: NDKUser[],
    content: string,
    opts: SendMessageOptions = {}
  ): Promise<{ wraps: NDKEvent[]; rumor: NostrEvent }> {
    const sender = await this.signer.user()
    const rumorEvent = this.buildRumor(participants, sender, content, opts)
    const relays = await this.collectRelaySet(participants, sender)
    const relaySet = relays.length ? NDKRelaySet.fromRelayUrls(relays, this.ndk) : undefined

    const wraps: NDKEvent[] = []
    for (const participant of participants) {
      const wrapped = await giftWrap(rumorEvent, participant, this.signer)
      await wrapped.publish(relaySet)
      wraps.push(wrapped)
    }
    // keep a copy for sender if not already included
    if (!participants.find((p) => p.pubkey === sender.pubkey)) {
      const wrappedSelf = await giftWrap(
        rumorEvent,
        new NDKUser({ pubkey: sender.pubkey }),
        this.signer
      )
      await wrappedSelf.publish(relaySet)
      wraps.push(wrappedSelf)
    }
    const rumor = rumorEvent.rawEvent()
    if (!rumor.id) {
      rumor.id = getEventHash({
        ...rumor,
        kind: rumor.kind ?? 0,
        created_at: rumor.created_at ?? 0,
        tags: rumor.tags ?? [],
        content: rumor.content ?? '',
        pubkey: rumor.pubkey ?? ''
      })
    }
    return { wraps, rumor }
  }

  async sendReaction(
    participants: NDKUser[],
    reaction: SendReactionOptions
  ): Promise<{ wraps: NDKEvent[]; rumor: NostrEvent }> {
    const sender = await this.signer.user()
    const rumor = new NDKEvent(this.ndk)
    rumor.kind = NDKKind.Reaction
    rumor.content = reaction.content
    rumor.pubkey = sender.pubkey
    rumor.created_at = Math.floor(Date.now() / 1000)
    rumor.tags = [['e', reaction.targetEventId]]
    participants.forEach((p) => {
      if (p.pubkey !== sender.pubkey) {
        rumor.tags.push(['p', p.pubkey])
      }
    })
    const relays = await this.collectRelaySet(participants, sender)
    const relaySet = relays.length ? NDKRelaySet.fromRelayUrls(relays, this.ndk) : undefined
    const wraps: NDKEvent[] = []
    for (const participant of participants) {
      const wrapped = await giftWrap(rumor, participant, this.signer)
      await wrapped.publish(relaySet)
      wraps.push(wrapped)
    }
    const rumorEvent = rumor.rawEvent()
    if (!rumorEvent.id) {
      rumorEvent.id = getEventHash({
        ...rumorEvent,
        kind: rumorEvent.kind ?? 0,
        created_at: rumorEvent.created_at ?? 0,
        tags: rumorEvent.tags ?? [],
        content: rumorEvent.content ?? '',
        pubkey: rumorEvent.pubkey ?? ''
      })
    }
    return { wraps, rumor: rumorEvent }
  }

  async unwrapMessage(wrappedEvent: NDKEvent): Promise<NostrEvent | null> {
    try {
      const rumor = await giftUnwrap(wrappedEvent, undefined, this.signer)
      if (rumor.kind !== NDKKind.PrivateDirectMessage && rumor.kind !== NDKKind.Reaction) {
        return null
      }
      return rumor.rawEvent()
    } catch (err) {
      console.error('Failed to unwrap message', err)
      return null
    }
  }

  rumorToMessage(rumor: NostrEvent, myPubkey: string): DMMessage {
    if (!rumor.id) {
      rumor.id = getEventHash({
        ...rumor,
        kind: rumor.kind ?? 0,
        created_at: rumor.created_at ?? 0,
        tags: rumor.tags ?? [],
        content: rumor.content ?? '',
        pubkey: rumor.pubkey ?? ''
      })
    }
    const pTags = (rumor.tags || []).filter((t) => t[0] === 'p').map((t) => t[1])
    const participants = Array.from(new Set([...pTags, rumor.pubkey, myPubkey])).sort()
    const recipients = participants.filter((p) => p !== rumor.pubkey)

    return {
      id: rumor.id,
      type: rumor.kind === NDKKind.Reaction ? 'reaction' : 'text',
      content: rumor.content || '',
      sender: new NDKUser({ pubkey: rumor.pubkey }),
      recipients: recipients.map((p) => new NDKUser({ pubkey: p })),
      timestamp: rumor.created_at || Math.floor(Date.now() / 1000),
      protocol: 'nip17',
      read: rumor.pubkey === myPubkey,
      rumor,
      conversationId: participants.join(':'),
      replyTo: rumor.tags?.find((t) => t[0] === 'e')?.[1],
      tags: rumor.tags
    }
  }

  private buildRumor(
    participants: NDKUser[],
    sender: NDKUser,
    content: string,
    opts: SendMessageOptions
  ): NDKEvent {
    const rumor = new NDKEvent(this.ndk)
    rumor.kind = NDKKind.PrivateDirectMessage
    rumor.content = content
    rumor.created_at = Math.floor(Date.now() / 1000)
    rumor.pubkey = sender.pubkey
    rumor.tags = []
    participants.forEach((p) => {
      if (p.pubkey !== sender.pubkey) {
        rumor.tags!.push(['p', p.pubkey])
      }
    })
    if (opts.subject) {
      rumor.tags!.push(['subject', opts.subject])
    }
    if (opts.replyTo) {
      rumor.tags!.push(['e', opts.replyTo])
    }
    return rumor
  }

  private async collectRelaySet(participants: NDKUser[], sender: NDKUser): Promise<string[]> {
    const relaySets = await Promise.all(
      participants.map(async (p) => {
        if (p.pubkey === sender.pubkey) return this.getRelays(p)
        const relays = await this.getRelays(p)
        if (!relays.length) {
          await this.publishDMRelays([this.discoveryRelay])
          return [this.discoveryRelay]
        }
        return relays
      })
    )
    const myRelays = await this.getRelays(sender)
    const merged = new Set<string>([...myRelays.flat(), ...relaySets.flat(), this.discoveryRelay])
    return Array.from(merged)
  }
}
