import { usePrimaryPage } from '@/PageManager'
import { useMessenger } from '@/providers/MessengerProvider'
import { useNostr } from '@/providers/NostrProvider'
import { useEffect, useMemo, useState } from 'react'

const storageKey = (pubkey: string | null | undefined) =>
  `conversationsSeenAt:${pubkey || 'anon'}`

export function useConversationBadge() {
  const { conversations } = useMessenger()
  const { current, display } = usePrimaryPage()
  const { pubkey } = useNostr()

  const key = useMemo(() => storageKey(pubkey), [pubkey])
  const onConversationRoute =
    typeof window !== 'undefined' && window.location.pathname.startsWith('/conversations')

  const [seenAt, setSeenAt] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    const stored = window.localStorage.getItem(key)
    const parsed = stored ? Number(stored) : 0
    return Number.isFinite(parsed) ? parsed : 0
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(key)
    const parsed = stored ? Number(stored) : 0
    setSeenAt(Number.isFinite(parsed) ? parsed : 0)
  }, [key])

  useEffect(() => {
    if ((current === 'conversations' && display) || onConversationRoute) {
      const now = Date.now()
      setSeenAt(now)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, now.toString())
      }
    }
  }, [current, display, key, onConversationRoute])

  const hasNewMessages = useMemo(() => {
    if ((current === 'conversations' && display) || onConversationRoute) return false
    const latestMs = conversations.reduce(
      (max, c) => Math.max(max, (c.lastMessageAt || 0) * 1000),
      0
    )
    return latestMs > seenAt
  }, [conversations, seenAt, current, display, onConversationRoute])

  const reset = () => {
    const now = Date.now()
    setSeenAt(now)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, now.toString())
    }
  }

  return { hasNewMessages, reset }
}
