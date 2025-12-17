import { BIG_RELAY_URLS, ExtendedKind } from '@/constants'
import { getZapInfoFromEvent } from '@/lib/event-metadata'
import client from '@/services/client.service'
import dayjs from 'dayjs'
import { Event } from '@nostr/tools/wasm'
import { Filter } from '@nostr/tools/filter'
import * as kinds from '@nostr/tools/kinds'

export type TListStats = {
  zapPrSet: Set<string>
  zaps: { pr: string; pubkey: string; amount: number; created_at: number; comment?: string }[]
  updatedAt?: number
}

class ListStatsService {
  static instance: ListStatsService
  private listStatsMap: Map<string, Partial<TListStats>> = new Map()

  constructor() {
    if (!ListStatsService.instance) {
      ListStatsService.instance = this
    }
    return ListStatsService.instance
  }

  private getListKey(authorPubkey: string, dTag: string): string {
    return `${authorPubkey}:${dTag}`
  }

  async fetchListStats(authorPubkey: string, dTag: string, pubkey?: string | null) {
    const listKey = this.getListKey(authorPubkey, dTag)
    const oldStats = this.listStatsMap.get(listKey)
    let since: number | undefined
    if (oldStats?.updatedAt) {
      since = oldStats.updatedAt
    }

    const [authorProfile, authorRelayList] = await Promise.all([
      client.fetchProfile(authorPubkey),
      client.fetchRelayList(authorPubkey)
    ])

    const coordinate = `${ExtendedKind.STARTER_PACK}:${authorPubkey}:${dTag}`
    const filters: Filter[] = []

    const lightningAddress =
      authorProfile?.metadata?.lud16 ||
      authorProfile?.metadata?.lud06 ||
      (authorProfile as any)?.lightningAddress

    if (lightningAddress) {
      filters.push({
        '#a': [coordinate],
        kinds: [kinds.Zap],
        limit: 500
      })

      if (pubkey) {
        filters.push({
          '#a': [coordinate],
          '#P': [pubkey],
          kinds: [kinds.Zap]
        })
      }
    }

    if (since) {
      filters.forEach((filter) => {
        filter.since = since
      })
    }

    if (!filters.length) {
      return this.listStatsMap.get(listKey) ?? {}
    }

    const events: Event[] = []
    const relays = authorRelayList.read.concat(BIG_RELAY_URLS).slice(0, 5)

    for (const filter of filters) {
      try {
        const fetched = await client.fetchEvents(relays, filter)
        events.push(...(fetched as Event[]))
      } catch (error) {
        console.error('Failed to fetch list stats', error)
      }
    }

    this.updateListStatsByEvents(authorPubkey, dTag, events)
    this.listStatsMap.set(listKey, {
      ...(this.listStatsMap.get(listKey) ?? {}),
      updatedAt: dayjs().unix()
    })
    return this.listStatsMap.get(listKey) ?? {}
  }

  private getListStats(authorPubkey: string, dTag: string): Partial<TListStats> | undefined {
    const listKey = this.getListKey(authorPubkey, dTag)
    return this.listStatsMap.get(listKey)
  }

  private addZap(
    authorPubkey: string,
    dTag: string,
    zapperPubkey: string,
    pr: string,
    amount: number,
    comment?: string,
    created_at: number = dayjs().unix()
  ) {
    const listKey = this.getListKey(authorPubkey, dTag)
    const old = this.listStatsMap.get(listKey) || {}
    const zapPrSet = old.zapPrSet || new Set()
    const zaps = old.zaps || []
    if (zapPrSet.has(pr)) return

    zapPrSet.add(pr)
    zaps.push({ pr, pubkey: zapperPubkey, amount, comment, created_at })
    this.listStatsMap.set(listKey, { ...old, zapPrSet, zaps })
  }

  private addZapByEvent(authorPubkey: string, dTag: string, evt: Event) {
    const info = getZapInfoFromEvent(evt)
    if (!info) return
    const { senderPubkey, invoice, amount, comment } = info
    if (!senderPubkey) return

    this.addZap(authorPubkey, dTag, senderPubkey, invoice, amount, comment, evt.created_at)
  }

  updateListStatsByEvents(authorPubkey: string, dTag: string, events: Event[]) {
    events.forEach((evt) => {
      if (evt.kind === kinds.Zap) {
        this.addZapByEvent(authorPubkey, dTag, evt)
      }
    })
  }

  getTotalZapAmount(authorPubkey: string, dTag: string): number {
    const stats = this.getListStats(authorPubkey, dTag)
    if (!stats?.zaps) return 0
    return stats.zaps.reduce((acc, zap) => acc + zap.amount, 0)
  }
}

const instance = new ListStatsService()
export default instance
