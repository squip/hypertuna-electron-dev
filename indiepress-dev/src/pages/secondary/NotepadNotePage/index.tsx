import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { forwardRef, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNotepad } from '@/providers/NotepadProvider'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { remarkNostrLinks, nostrSanitizeSchema } from '@/lib/markdown'
import { Button } from '@/components/ui/button'
import ArticleContent from '@/components/PostEditor/ArticleContent'
import { useNostr } from '@/providers/NostrProvider'
import { useSecondaryPage } from '@/PageManager'

const NotepadNotePage = forwardRef(({ id, index }: { id?: string; index?: number }, ref) => {
  const { t } = useTranslation()
  const { notes, publish } = useNotepad()
  const { pubkey } = useNostr()
  const { pop } = useSecondaryPage()
  const [editing, setEditing] = useState(false)

  const note = useMemo(() => {
    if (!id) return undefined
    const matches = Array.from(notes.values()).filter((n) => (n.d || n.id) === id)
    if (!matches.length) return undefined
    return matches.sort((a, b) => b.created_at - a.created_at)[0]
  }, [id, notes])

  const title = note?.tags.find((t) => t[0] === 'title')?.[1] || t('Notepad')

  return (
    <SecondaryPageLayout
      ref={ref}
      index={index}
      title={title}
      displayScrollToTopButton
      controls={
        <div className="flex gap-2">
          <Button variant="ghost" size="icon" onClick={() => pop()}>
            {t('Back')}
          </Button>
          {!editing && (
            <Button size="sm" onClick={() => setEditing(true)}>
              {t('Edit')}
            </Button>
          )}
        </div>
      }
    >
      {!note ? (
        <div className="text-center text-muted-foreground py-12">{t('Note not found')}</div>
      ) : (
        <article
          className="px-4 pt-3 pb-8 max-w-3xl mx-auto"
          onClick={() => {
            if (!editing) setEditing(true)
          }}
        >
          <h1 className="text-2xl font-bold mb-6 select-text">{title}</h1>
          {!editing ? (
            <div className="prose prose-lg dark:prose-invert max-w-none select-text">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkNostrLinks]}
                rehypePlugins={[rehypeRaw, [rehypeSanitize, nostrSanitizeSchema]]}
              >
                {note.content}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="space-y-3 border rounded-lg p-3">
              <ArticleContent
                close={() => setEditing(false)}
                existingEvent={
                  {
                    id: note.id,
                    kind: note.kind,
                    pubkey: note.pubkey,
                    created_at: note.created_at,
                    content: note.content,
                    tags: note.tags
                  } as any
                }
                extraTags={pubkey ? [['t', `notepad:${pubkey}`]] : []}
                onPublish={async (draftEvent, { isDraft, relayUrls }) => {
                  await publish(draftEvent, { isDraft, relayUrls })
                  setEditing(false)
                }}
              />
              <div className="flex gap-2 justify-end">
                <Button variant="secondary" onClick={() => setEditing(false)}>
                  {t('Cancel')}
                </Button>
              </div>
            </div>
          )}
        </article>
      )}
    </SecondaryPageLayout>
  )
})

NotepadNotePage.displayName = 'NotepadNotePage'
export default NotepadNotePage
