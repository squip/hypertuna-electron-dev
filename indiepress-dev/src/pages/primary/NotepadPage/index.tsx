import HideUntrustedContentButton from '@/components/HideUntrustedContentButton'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { Pencil, NotebookPen } from 'lucide-react'
import { forwardRef, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNostr } from '@/providers/NostrProvider'
import { useNotepad } from '@/providers/NotepadProvider'
import { useSecondaryPage } from '@/PageManager'
import { Button } from '@/components/ui/button'
import { RefreshButton } from '@/components/RefreshButton'
import { isTouchDevice } from '@/lib/utils'
import PullToRefresh from 'react-simple-pull-to-refresh'
import { toNotepad } from '@/lib/link'
import PostEditor from '@/components/PostEditor'
import { CachedNotepadNote } from '@/lib/notepad/cache'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import UserAvatar from '@/components/UserAvatar'

const NotepadPage = forwardRef((_, ref) => {
  const { t } = useTranslation()
  const { pubkey } = useNostr()
  const { notes, ready, refresh, publish } = useNotepad()
  const { push } = useSecondaryPage()
  const [openComposer, setOpenComposer] = useState(false)
  const supportTouch = useMemo(() => isTouchDevice(), [])

  const noteList = useMemo(() => {
    return Array.from(notes.values())
      .filter((n) => n.pubkey === pubkey)
      .sort((a, b) => b.created_at - a.created_at)
  }, [notes, pubkey])

  const handleRefresh = async () => {
    await refresh()
  }

  const listContent = (
    <div className="flex-1 min-h-0">
      <ScrollArea className="h-full">
        {ready ? (
          noteList.length ? (
            <div>
              {noteList.map((note) => (
                <NotepadListItem key={note.key} note={note} onOpen={() => push(toNotepad(note.d || note.id))} />
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground px-4 py-3">{t('No notes yet.')}</div>
          )
        ) : (
          <div className="space-y-3 px-4 py-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="w-10 h-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )

  return (
    <PrimaryPageLayout
      ref={ref}
      pageName="notepad"
      titlebar={
        <NotepadTitlebar onCompose={() => setOpenComposer(true)} onRefresh={handleRefresh} supportTouch={supportTouch} />
      }
      displayScrollToTopButton
    >
      {supportTouch ? (
        <PullToRefresh onRefresh={handleRefresh}>{listContent}</PullToRefresh>
      ) : (
        listContent
      )}
      <PostEditor
        open={openComposer}
        setOpen={setOpenComposer}
        defaultTab="article"
        tabPreset="personal"
        articleOptions={{
          extraTags: pubkey ? [['t', `notepad:${pubkey}`]] : [],
          onPublish: async (draftEvent, { isDraft, relayUrls }) => {
            await publish(draftEvent, { isDraft, relayUrls })
          }
        }}
      />
    </PrimaryPageLayout>
  )
})
NotepadPage.displayName = 'NotepadPage'
export default NotepadPage

function NotepadTitlebar({
  onCompose,
  onRefresh,
  supportTouch
}: {
  onCompose: () => void
  onRefresh: () => void
  supportTouch: boolean
}) {
  const { t } = useTranslation()

  return (
    <div className="flex gap-2 items-center justify-between h-full pl-3 pr-2">
      <div className="flex items-center gap-2">
        <NotebookPen />
        <div className="text-lg font-semibold">{t('Notepad')}</div>
      </div>
      <div className="flex items-center gap-1">
        {!supportTouch && <RefreshButton onClick={onRefresh} />}
        <Button variant="ghost" size="titlebar-icon" onClick={onCompose} aria-label="New note">
          <Pencil />
        </Button>
        <HideUntrustedContentButton type="notifications" size="titlebar-icon" />
      </div>
    </div>
  )
}

function NotepadListItem({ note, onOpen }: { note: CachedNotepadNote; onOpen: () => void }) {
  const title = note.tags.find((t) => t[0] === 'title')?.[1] || 'Untitled'
  const image = note.tags.find((t) => t[0] === 'image')?.[1]
  const summary = note.tags.find((t) => t[0] === 'summary')?.[1]
  const preview = summary || (note.content || '').replace(/\s+/g, ' ').slice(0, 120)
  return (
    <div
      className="clickable flex items-center gap-3 px-4 py-3 border-b"
      onClick={onOpen}
    >
      <div className="w-10 h-10 rounded-full overflow-hidden bg-muted flex items-center justify-center">
        {image ? (
          <img src={image} alt={title} className="w-full h-full object-cover" />
        ) : (
          <UserAvatar userId={note.pubkey} size="small" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{title}</div>
        <div className="text-xs text-muted-foreground truncate">{preview}</div>
      </div>
    </div>
  )
}
