import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMessenger } from '@/providers/MessengerProvider'
import type { ConversationMeta, DMMessage } from '@/lib/messaging/types'
import UserAvatar from '@/components/UserAvatar'
import { Users, Search } from 'lucide-react'
import { FormattedTimestamp } from '@/components/FormattedTimestamp'
import { SimpleUsername } from '@/components/Username'
import { Input } from '@/components/ui/input'
import { EmbeddedUrlParser, parseContent } from '@/lib/content-parser'
import PullToRefresh from 'react-simple-pull-to-refresh'
import { isTouchDevice } from '@/lib/utils'
import { RefreshButton } from '../RefreshButton'

const debug = (...args: any[]) => console.debug('[DMConversations]', ...args)

type ConversationMessageMeta = {
  first?: DMMessage | null
  last?: DMMessage | null
  unread?: number
}

function deriveDisplayName(meta: ConversationMeta, myPubkey: string | null): string {
  if (meta.subject) return meta.subject
  const others = meta.participants.filter((p) => p !== myPubkey)
  if (others.length === 0) return 'Me'
  if (others.length === 1) return others[0]
  return `${others[0]} +${others.length - 1}`
}

const LINK_PLACEHOLDER = '[link attachment]'

function formatMessagePreview(text: string) {
  const nodes = parseContent(text, [EmbeddedUrlParser])
  if (!nodes?.length) return text

  const replaced = nodes
    .map((node) => (node.type === 'text' ? node.data : LINK_PLACEHOLDER))
    .join('')
  const compacted = replaced.replace(/\s+/g, ' ').trim()

  return compacted || LINK_PLACEHOLDER
}

export function ConversationListPanel({
  myPubkey,
  onOpenConversation
}: {
  myPubkey: string | null
  onOpenConversation: (id: string) => void
}) {
  const { messenger, conversations, ready, unsupportedReason } = useMessenger()
  const [filter, setFilter] = useState('')
  const [messageMeta, setMessageMeta] = useState<Record<string, ConversationMessageMeta>>({})
  const supportTouch = useMemo(() => isTouchDevice(), [])
  const topRef = useRef<HTMLDivElement | null>(null)

  const loadMessageMeta = useCallback(async () => {
    if (!messenger) return null
    debug('messageMeta fetch start', { conversations: conversations.length })
    const entries = await Promise.all(
      conversations.map(async (c) => {
        const msgs = await messenger.getConversationMessages(c.id)
        const last = msgs.length ? msgs[msgs.length - 1] : null
        const first = msgs[0] || null
        const unread = msgs.filter((m) => !m.read && m.sender.pubkey !== myPubkey).length
        return [c.id, { last, first, unread }] as const
      })
    )
    return Object.fromEntries(entries)
  }, [conversations, messenger, myPubkey])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const meta = await loadMessageMeta()
      if (cancelled || !meta) return
      setMessageMeta(meta)
      debug('messageMeta updated', { conversations: conversations.length })
    })()
    return () => {
      cancelled = true
    }
  }, [loadMessageMeta, conversations.length])

  const refresh = useCallback(async () => {
    if (!messenger) return
    topRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
    await messenger.syncRecent()
    const meta = await loadMessageMeta()
    if (meta) setMessageMeta(meta)
  }, [loadMessageMeta, messenger])

  const filtered = useMemo(() => {
    return conversations.filter((c) => {
      if (!filter.trim()) return true
      const name = deriveDisplayName(c, myPubkey).toLowerCase()
      return name.includes(filter.toLowerCase())
    })
  }, [conversations, filter, myPubkey])

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)),
    [filtered]
  )

  const listContent = (
    <div className="h-full overflow-y-auto bg-background">
      {sorted.map((c) => (
        <ConversationListItem
          key={c.id}
          meta={c}
          messageMeta={messageMeta[c.id]}
          myPubkey={myPubkey}
          onOpenConversation={onOpenConversation}
        />
      ))}
      {sorted.length === 0 && (
        <div className="text-sm text-muted-foreground px-4 py-3">No conversations yet.</div>
      )}
    </div>
  )

  if (unsupportedReason) {
    return <div className="p-4 text-sm text-muted-foreground">{unsupportedReason}</div>
  }

  if (!ready || !messenger) {
    return <div className="p-4 text-sm text-muted-foreground">Loading conversations…</div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="sticky flex items-center justify-between top-12 bg-background z-30 px-4 py-2 w-full border-b gap-3">
        <div
          tabIndex={0}
          className="relative flex w-full items-center rounded-md border border-input px-3 py-1 text-base transition-colors md:text-sm [&:has(:focus-visible)]:ring-ring [&:has(:focus-visible)]:ring-1 [&:has(:focus-visible)]:outline-none bg-surface-background shadow-inner h-full border-none"
        >
          <Search className="size-4 shrink-0 opacity-50" />
          <Input
            type="text"
            placeholder="Search conversations"
            value={filter}
            onChange={(e) => setFilter((e?.target as HTMLInputElement).value)}
            showClearButton
            onClear={() => setFilter('')}
            className="flex-1 h-9 size-full shadow-none border-none bg-transparent focus:outline-none focus-visible:outline-none focus-visible:ring-0 placeholder:text-muted-foreground"
          />
        </div>
        {!supportTouch && <RefreshButton onClick={() => refresh()} />}
      </div>
      <div ref={topRef} className="scroll-mt-[calc(6rem+1px)]" />
      {supportTouch ? (
        <div className="flex-1 min-h-0">
          <PullToRefresh
            onRefresh={async () => {
              await refresh()
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }}
            pullingContent=""
            className="h-full"
          >
            {listContent}
          </PullToRefresh>
        </div>
      ) : (
        <div className="flex-1 min-h-0">{listContent}</div>
      )}
    </div>
  )
}

function ConversationListItem({
  meta,
  messageMeta,
  myPubkey,
  onOpenConversation
}: {
  meta: ConversationMeta
  messageMeta?: ConversationMessageMeta
  myPubkey: string | null
  onOpenConversation: (id: string) => void
}) {
  const others = useMemo(
    () => meta.participants.filter((p) => p !== myPubkey),
    [meta.participants, myPubkey]
  )
  const last = messageMeta?.last
  const first = messageMeta?.first

  const groupImageTag = useMemo(() => {
    const tags = first?.tags || []
    const imageTag = tags.find((t) => ['image', 'img', 'picture', 'avatar'].includes(t[0]))
    return imageTag?.[1]
  }, [first])

  const unreadCount = useMemo(() => {
    if (typeof meta.unreadCount === 'number' && meta.unreadCount > 0) return meta.unreadCount
    return messageMeta?.unread || 0
  }, [meta.unreadCount, messageMeta?.unread])

  const previewText = useMemo(() => {
    if (!last) return 'No messages yet.'
    if (last.type === 'reaction') {
      return `Reacted: ${last.content || '+'}`
    }
    if (!last.content) return 'Encrypted message'
    return last.content
  }, [last])

  const previewDisplayText = useMemo(() => {
    if (last?.type === 'reaction') return previewText
    return formatMessagePreview(previewText)
  }, [last?.type, previewText])

  const lastSender = last?.sender.pubkey

  const title = deriveDisplayName(meta, myPubkey)

  return (
    <div
      className="clickable flex items-start gap-3 cursor-pointer px-4 py-3 border-b"
      onClick={() => {
        debug('open conversation', {
          conversationId: meta.id,
          metaUnread: meta.unreadCount,
          derivedUnread: unreadCount
        })
        onOpenConversation(meta.id)
      }}
    >
      <div className="flex items-center justify-center mt-1.5">
        {others.length <= 1 ? (
          <UserAvatar userId={others[0] || meta.participants[0]} size="medium" />
        ) : groupImageTag ? (
          <img
            src={groupImageTag}
            alt="Conversation"
            className="w-9 h-9 rounded-full object-cover border"
          />
        ) : (
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center border">
            <Users className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex-1 w-0 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold truncate">{title}</div>
          {last && (
            <FormattedTimestamp
              timestamp={last.timestamp}
              className="text-muted-foreground text-xs shrink-0"
              short
            />
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {others.length > 1 ? `${others.length} participants` : null}
        </div>
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          {lastSender ? (
            <SimpleUsername
              userId={lastSender}
              className="font-medium text-foreground truncate max-w-[40%]"
              withoutSkeleton
            />
          ) : null}
          {lastSender && <span className="text-muted-foreground">:</span>}
          <span className="line-clamp-1 flex-1 min-w-0">{previewDisplayText}</span>
        </div>
      </div>

      {unreadCount > 0 && (
        <div className="self-center shrink-0">
          <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded-full">
            {unreadCount}
          </span>
        </div>
      )}
    </div>
  )
}
