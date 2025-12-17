import HideUntrustedContentButton from '@/components/HideUntrustedContentButton'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { MessageSquare, Pencil } from 'lucide-react'
import { forwardRef, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMessenger } from '@/providers/MessengerProvider'
import { ConversationListPanel } from '@/components/DMConversations'
import { useNostr } from '@/providers/NostrProvider'
import { useSecondaryPage } from '@/PageManager'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import * as nip19 from '@nostr/tools/nip19'
import { NDKUser } from '@nostr-dev-kit/ndk'

const ConversationListPage = forwardRef((_, ref) => {
  const { pubkey } = useNostr()
  const { push } = useSecondaryPage()
  const [openNew, setOpenNew] = useState(false)
  const [recipients, setRecipients] = useState('')
  const [subject, setSubject] = useState('')
  const [creating, setCreating] = useState(false)

  return (
    <PrimaryPageLayout
      ref={ref}
      pageName="conversations"
      titlebar={<ConversationListPageTitlebar onNew={() => setOpenNew(true)} />}
      displayScrollToTopButton
    >
      <ConversationListPanel
        myPubkey={pubkey}
        onOpenConversation={(id) => push(`/conversations/${id}`)}
      />
      <NewConversationDialog
        open={openNew}
        onOpenChange={setOpenNew}
        recipients={recipients}
        subject={subject}
        setRecipients={setRecipients}
        setSubject={setSubject}
        creating={creating}
        setCreating={setCreating}
        myPubkey={pubkey}
      />
    </PrimaryPageLayout>
  )
})
ConversationListPage.displayName = 'ConversationListPage'
export default ConversationListPage

function ConversationListPageTitlebar({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation()

  return (
    <div className="flex gap-2 items-center justify-between h-full pl-3 pr-2">
      <div className="flex items-center gap-2">
        <MessageSquare />
        <div className="text-lg font-semibold">{t('Conversations')}</div>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="titlebar-icon" onClick={onNew} aria-label="New conversation">
          <Pencil />
        </Button>
        <HideUntrustedContentButton type="notifications" size="titlebar-icon" />
      </div>
    </div>
  )
}

function NewConversationDialog({
  open,
  onOpenChange,
  recipients,
  subject,
  setRecipients,
  setSubject,
  creating,
  setCreating,
  myPubkey
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  recipients: string
  subject: string
  setRecipients: (v: string) => void
  setSubject: (v: string) => void
  creating: boolean
  setCreating: (v: boolean) => void
  myPubkey: string | null
}) {
  const { messenger } = useMessenger()
  const { push } = useSecondaryPage()

  const decodedRecipients = useMemo(() => {
    return recipients
      .split(',')
      .map((p: string) => p.trim())
      .map((p: string) => {
        if (!p) return ''
        try {
          const { type, data } = nip19.decode(p)
          if (type === 'npub') return data as string
          if (type === 'nprofile' && typeof data === 'object' && 'pubkey' in data) {
            return (data as any).pubkey as string
          }
          return p
        } catch {
          return p
        }
      })
      .filter(Boolean)
  }, [recipients])

  const startConversation = async () => {
    if (!messenger) return
    if (decodedRecipients.length === 0) return
    setCreating(true)
    try {
      const participants = decodedRecipients.map((p: string) => new NDKUser({ pubkey: p }))
      const msgs = await messenger.sendMessage(
        participants,
        subject ? `Started conversation: ${subject}` : '(conversation created)',
        { subject }
      )
      const convId =
        msgs[0]?.conversationId || decodedRecipients.concat(myPubkey || '').sort().join(':')
      onOpenChange(false)
      setRecipients('')
      setSubject('')
      push(`/conversations/${convId}`)
    } catch (err) {
      console.error('Failed to start conversation', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Conversation</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (optional)"
          />
          <Input
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="Recipients (comma-separated npub/nprofile or hex)"
          />
          <div className="flex justify-end">
            <Button onClick={startConversation} disabled={creating || decodedRecipients.length === 0}>
              {creating ? 'Starting…' : 'Start chat'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
