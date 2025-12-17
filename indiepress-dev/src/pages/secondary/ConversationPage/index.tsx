import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { useSecondaryPage } from '@/PageManager'
import { ChevronLeft, Users } from 'lucide-react'
import { forwardRef, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMessenger } from '@/providers/MessengerProvider'
import { useNostr } from '@/providers/NostrProvider'
import { DMThread } from '@/components/DMThread'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import Username, { SimpleUsername } from '@/components/Username'
import UserAvatar, { SimpleUserAvatar } from '@/components/UserAvatar'
import client from '@/services/client.service'
import { cn } from '@/lib/utils'

const debug = (...args: any[]) => console.debug('[ConversationPage]', ...args)

const ConversationPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { pop } = useSecondaryPage()
  const conversationId = useMemo(() => window.location.pathname.split('/').pop() || '', [])
  const { conversations, messenger } = useMessenger()
  const { pubkey } = useNostr()
  const meta = conversations.find((c) => c.id === conversationId)
  const [showMembers, setShowMembers] = useState(false)
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  const [groupImage, setGroupImage] = useState<string | null>(null)

  useEffect(() => {
    debug('render', { conversationId, hasMeta: !!meta, participants: meta?.participants?.length })
  }, [conversationId, meta?.id, meta?.participants?.length])

  useEffect(() => {
    let cancelled = false
    if (!meta?.participants?.length) return

    ;(async () => {
      const entries = await Promise.all(
        meta.participants.map(async (participant) => {
          try {
            const profile = await client.fetchProfile(participant)
            const display = profile?.shortName || participant
            return [participant, display] as const
          } catch {
            return [participant, participant] as const
          }
        })
      )
      if (!cancelled) {
        setNameMap(Object.fromEntries(entries))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [meta?.participants])

  const participantLine = useMemo(() => {
    if (!meta?.participants?.length) return ''
    return meta.participants.map((p) => nameMap[p] || p).join(', ')
  }, [meta?.participants, nameMap])

  const [useDocumentScroll, setUseDocumentScroll] = useState(false)

  useEffect(() => {
    if (!meta || !messenger) return
    let cancelled = false
    ;(async () => {
      debug('group image fetch', { conversationId: meta.id })
      const msgs = await messenger.getConversationMessages(meta.id, 1)
      if (cancelled) return
      const first = msgs?.[0]
      const imageTag = first?.tags?.find((t) => ['image', 'img', 'picture', 'avatar'].includes(t[0]))
      setGroupImage(imageTag?.[1] ?? null)
      debug('group image resolved', { conversationId: meta.id, hasImage: !!imageTag?.[1] })
    })()
    return () => {
      cancelled = true
    }
  }, [meta?.id, messenger])

  return (
    <SecondaryPageLayout
      ref={ref}
      index={index}
      titlebar={
        <div className="flex items-center gap-2 h-full px-2">
          <Button variant="ghost" size="titlebar-icon" onClick={() => pop()}>
            <ChevronLeft />
          </Button>
          <div className="flex items-center gap-2">
            {meta?.participants && meta.participants.length <= 2 ? (
              <UserAvatar
                userId={meta.participants.find((p) => p !== pubkey) || meta.participants[0]}
                size="small"
              />
            ) : groupImage ? (
              <img
                src={groupImage}
                alt="Conversation"
                className="w-8 h-8 rounded-full object-cover border"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center border">
                <Users className="h-4 w-4 text-muted-foreground" />
              </div>
            )}
          </div>
          <button
            type="button"
            className={cn(
              'flex flex-col min-w-0 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm',
              'hover:text-foreground'
            )}
            onClick={() => setShowMembers(true)}
          >
            <div className="text-sm font-semibold truncate">
              {meta?.subject || 'Conversation'}
            </div>
            <div className="text-xs text-muted-foreground truncate">{participantLine}</div>
          </button>
        </div>
      }
      displayScrollToTopButton={false}
      skipInitialScrollToTop
      onScrollContextChange={setUseDocumentScroll}
    >
      <DMThread conversationId={conversationId} myPubkey={pubkey} useDocumentScroll={useDocumentScroll} />
      <MembersDialog
        open={showMembers}
        onOpenChange={setShowMembers}
        subject={meta?.subject || 'Conversation'}
        participants={meta?.participants || []}
      />
    </SecondaryPageLayout>
  )
})
ConversationPage.displayName = 'ConversationPage'
export default ConversationPage

function MembersDialog({
  open,
  onOpenChange,
  subject,
  participants
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  subject: string
  participants: string[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex flex-row items-center gap-3">
          <DialogClose asChild>
            <Button variant="ghost" size="icon">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </DialogClose>
          <div className="flex-1 min-w-0">
            <DialogTitle className="truncate">{subject}</DialogTitle>
            <div className="text-sm text-muted-foreground truncate">
              {participants.length === 1 ? (
                <Username userId={participants[0]} className="truncate" withoutSkeleton />
              ) : (
                <div className="truncate">
                  {participants.map((p, idx) => (
                    <span key={p} className="text-sm text-muted-foreground">
                      <SimpleUsername userId={p} className="inline" withoutSkeleton />
                      {idx < participants.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>
        <div className="mt-2 max-h-[70vh] overflow-y-auto space-y-3 pr-1">
          {participants.map((p) => (
            <div key={p} className="flex items-center gap-3">
              <SimpleUserAvatar userId={p} size="medium" />
              <div className="flex-1 min-w-0">
                <SimpleUsername userId={p} className="font-medium truncate" withoutSkeleton />
                <div className="text-xs text-muted-foreground truncate">{p}</div>
              </div>
            </div>
          ))}
          {!participants.length && (
            <div className="text-sm text-muted-foreground">No conversation members found.</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
