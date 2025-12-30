import Note from '@/components/Note'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  createCommentDraftEvent,
  createPollDraftEvent,
  createShortTextNoteDraftEvent,
  deleteDraftEventCache
} from '@/lib/draft-event'
import { useNostr } from '@/providers/NostrProvider'
import { useReply } from '@/providers/ReplyProvider'
import postEditorCache from '@/services/post-editor-cache.service'
import { TPollCreateData } from '@/types'
import { ImageUp, ListTodo, LoaderCircle, Settings, Smile, X } from 'lucide-react'
import { Event } from '@nostr/tools/wasm'
import * as kinds from '@nostr/tools/kinds'
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import EmojiPickerDialog from '../EmojiPickerDialog'
import Mentions from './Mentions'
import PollEditor from './PollEditor'
import PostOptions from './PostOptions'
import PostRelaySelector from './PostRelaySelector'
import PostTextarea, { TPostTextareaHandle } from './PostTextarea'
import Preview from './PostTextarea/Preview'
import Uploader from './Uploader'
import { isTouchDevice } from '@/lib/utils'

export default function PostContent({
  defaultContent = '',
  parentEvent,
  close,
  openFrom,
  groupContext,
  renderSections
}: {
  defaultContent?: string
  parentEvent?: Event
  close: () => void
  openFrom?: string[]
  groupContext?: {
    groupId: string
    relay?: string
    name?: string
    picture?: string
  }
  renderSections: (sections: {
    header: React.ReactNode | null
    body: React.ReactNode
    footer: React.ReactNode
  }) => React.ReactNode
}) {
  const { t } = useTranslation()
  const { pubkey, publish, checkLogin } = useNostr()
  const { addReplies } = useReply()
  const [text, setText] = useState('')
  const textareaRef = useRef<TPostTextareaHandle>(null)
  const [posting, setPosting] = useState(false)
  const [uploadProgresses, setUploadProgresses] = useState<
    { file: File; progress: number; cancel: () => void }[]
  >([])
  const [showMoreOptions, setShowMoreOptions] = useState(false)
  const [addClientTag, setAddClientTag] = useState(false)
  const [mentions, setMentions] = useState<string[]>([])
  const [isNsfw, setIsNsfw] = useState(false)
  const [isPoll, setIsPoll] = useState(false)
  const [isProtectedEvent, setIsProtectedEvent] = useState(false)
  const [additionalRelayUrls, setAdditionalRelayUrls] = useState<string[]>([])
  const [pollCreateData, setPollCreateData] = useState<TPollCreateData>({
    isMultipleChoice: false,
    options: ['', ''],
    endsAt: undefined,
    relays: []
  })
  const [minPow, setMinPow] = useState(0)
  const allowEmoji = useMemo(() => !isTouchDevice(), [])
  const [view, setView] = useState<'edit' | 'preview'>('edit')
  const isFirstRender = useRef(true)
  const canPost = useMemo(() => {
    return (
      !!pubkey &&
      !!text &&
      !posting &&
      !uploadProgresses.length &&
      (!isPoll || pollCreateData.options.filter((option) => !!option.trim()).length >= 2) &&
      (!isProtectedEvent || additionalRelayUrls.length > 0) &&
      (!groupContext || !!groupContext.groupId)
    )
  }, [
    pubkey,
    text,
    posting,
    uploadProgresses,
    isPoll,
    pollCreateData,
    isProtectedEvent,
    additionalRelayUrls,
    groupContext
  ])

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      const cachedSettings = postEditorCache.getPostSettingsCache({
        defaultContent,
        parentEvent
      })
      if (cachedSettings) {
        setIsNsfw(cachedSettings.isNsfw ?? false)
        setIsPoll(cachedSettings.isPoll ?? false)
        setPollCreateData(
          cachedSettings.pollCreateData ?? {
            isMultipleChoice: false,
            options: ['', ''],
            endsAt: undefined,
            relays: []
          }
        )
        setAddClientTag(cachedSettings.addClientTag ?? false)
      }
      return
    }
    postEditorCache.setPostSettingsCache(
      { defaultContent, parentEvent },
      {
        isNsfw,
        isPoll,
        pollCreateData,
        addClientTag
      }
    )
  }, [defaultContent, parentEvent, isNsfw, isPoll, pollCreateData, addClientTag])

  const post = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    checkLogin(async () => {
      if (!canPost) return

      setPosting(true)
      try {
        const draftEvent =
          parentEvent && parentEvent.kind !== kinds.ShortTextNote
            ? await createCommentDraftEvent(text, parentEvent, mentions, {
                addClientTag,
                protectedEvent: isProtectedEvent,
                isNsfw
              })
            : isPoll
              ? await createPollDraftEvent(pubkey!, text, mentions, pollCreateData, {
                  addClientTag,
                  isNsfw
                })
              : await createShortTextNoteDraftEvent(text, mentions, {
                  parentEvent,
                  addClientTag,
                  protectedEvent: isProtectedEvent,
                  isNsfw
                })

        if (groupContext?.groupId) {
          draftEvent.tags = draftEvent.tags || []
          draftEvent.tags.push(['h', groupContext.groupId])
        }

        const newEvent = await publish(draftEvent, {
          specifiedRelayUrls: groupContext?.relay
            ? [groupContext.relay]
            : isProtectedEvent
              ? additionalRelayUrls
              : undefined,
          additionalRelayUrls: isPoll ? pollCreateData.relays : additionalRelayUrls,
          minPow
        })
        postEditorCache.clearPostCache({ defaultContent, parentEvent })
        deleteDraftEventCache(draftEvent)
        addReplies([newEvent])
        close()
      } catch (error) {
        const errors = error instanceof AggregateError ? error.errors : [error]
        errors.forEach((err) => {
          toast.error(
            `${t('Failed to post')}: ${err instanceof Error ? err.message : String(err)}`,
            { duration: 10_000 }
          )
          console.error(err)
        })
        return
      } finally {
        setPosting(false)
      }
      toast.success(t('Post successful'), { duration: 2000 })
    })
  }

  const handlePollToggle = () => {
    if (parentEvent) return

    setIsPoll((prev) => !prev)
  }

  const handleUploadStart = (file: File, cancel: () => void) => {
    setUploadProgresses((prev) => [...prev, { file, progress: 0, cancel }])
  }

  const handleUploadProgress = (file: File, progress: number) => {
    setUploadProgresses((prev) =>
      prev.map((item) => (item.file === file ? { ...item, progress } : item))
    )
  }

  const handleUploadEnd = (file: File) => {
    setUploadProgresses((prev) => prev.filter((item) => item.file !== file))
  }

  const groupDisplayName = groupContext?.name || groupContext?.groupId
  const groupInitials = (groupDisplayName || 'GR').slice(0, 2).toUpperCase()

  const header = parentEvent ? null : (
    <div className="flex items-center justify-between gap-2">
      <Tabs value={view} onValueChange={(v) => setView(v as 'edit' | 'preview')}>
        <TabsList>
          <TabsTrigger value="edit">{t('Edit')}</TabsTrigger>
          <TabsTrigger value="preview">{t('Preview')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {groupContext?.groupId && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
          <span className="shrink-0">{t('Posting to group relay for')}</span>
          <div className="flex items-center gap-2 min-w-0">
            <Avatar className="h-6 w-6 shrink-0">
              {groupContext.picture && (
                <AvatarImage src={groupContext.picture} alt={groupDisplayName} />
              )}
              <AvatarFallback className="text-[10px] font-semibold">{groupInitials}</AvatarFallback>
            </Avatar>
            <span className="truncate font-semibold text-foreground">{groupDisplayName}</span>
          </div>
        </div>
      )}
    </div>
  )

  const body = (
    <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto">
      {parentEvent && (
        <div className="flex max-h-48 flex-col overflow-y-auto rounded-lg border bg-muted/40">
          <div className="p-2 sm:p-3 pointer-events-none">
            <Note size="small" event={parentEvent} hideParentNotePreview />
          </div>
        </div>
      )}
      {view === 'edit' ? (
        <>
          <PostTextarea
            ref={textareaRef}
            text={text}
            setText={setText}
            defaultContent={defaultContent}
            parentEvent={parentEvent}
            onSubmit={() => post()}
            className={isPoll ? 'min-h-20' : 'min-h-52'}
            onUploadStart={handleUploadStart}
            onUploadProgress={handleUploadProgress}
            onUploadEnd={handleUploadEnd}
            hidePreviewToggle
          />
          {isPoll && (
            <PollEditor
              pollCreateData={pollCreateData}
              setPollCreateData={setPollCreateData}
              setIsPoll={setIsPoll}
            />
          )}
        </>
      ) : (
        <Preview
          content={text}
          className={cn(
            'border rounded-lg p-3 min-h-52 bg-background',
            isPoll ? 'min-h-20' : 'min-h-52'
          )}
        />
      )}
      {uploadProgresses.length > 0 &&
        uploadProgresses.map(({ file, progress, cancel }, index) => (
          <div key={`${file.name}-${index}`} className="mt-2 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-muted-foreground mb-1">
                {file.name ?? t('Uploading...')}
              </div>
              <div className="h-0.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width] duration-200 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                cancel?.()
                handleUploadEnd(file)
              }}
              className="text-muted-foreground hover:text-foreground"
              title={t('Cancel')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      <PostOptions
        posting={posting}
        show={showMoreOptions}
        addClientTag={addClientTag}
        setAddClientTag={setAddClientTag}
        isNsfw={isNsfw}
        setIsNsfw={setIsNsfw}
        minPow={minPow}
        setMinPow={setMinPow}
      />
    </div>
  )

  const footer = (
    <div className="space-y-2">
      {!isPoll && !groupContext && (
        <PostRelaySelector
          setIsProtectedEvent={setIsProtectedEvent}
          setAdditionalRelayUrls={setAdditionalRelayUrls}
          parentEvent={parentEvent}
          openFrom={openFrom}
        />
      )}
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <Uploader
            onUploadSuccess={({ url }) => {
              textareaRef.current?.appendText(url, true)
            }}
            onUploadStart={handleUploadStart}
            onUploadEnd={handleUploadEnd}
            onProgress={handleUploadProgress}
            accept="image/*,video/*,audio/*"
          >
            <Button variant="ghost" size="icon">
              <ImageUp />
            </Button>
          </Uploader>
          {allowEmoji && (
            <EmojiPickerDialog
              onEmojiClick={(emoji) => {
                if (!emoji) return
                textareaRef.current?.insertEmoji(emoji)
              }}
            >
              <Button variant="ghost" size="icon">
                <Smile />
              </Button>
            </EmojiPickerDialog>
          )}
          {!parentEvent && (
            <Button
              variant="ghost"
              size="icon"
              title={t('Create Poll')}
              className={isPoll ? 'bg-accent' : ''}
              onClick={handlePollToggle}
            >
              <ListTodo />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={showMoreOptions ? 'bg-accent' : ''}
            onClick={() => setShowMoreOptions((pre) => !pre)}
          >
            <Settings />
          </Button>
        </div>
        <div className="flex gap-2 items-center">
          <Mentions
            content={text}
            parentEvent={parentEvent}
            mentions={mentions}
            setMentions={setMentions}
          />
          <div className="flex gap-2 items-center max-sm:hidden">
            <Button
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation()
                close()
              }}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={!canPost} onClick={post}>
              {posting && <LoaderCircle className="animate-spin" />}
              {parentEvent ? t('Reply') : t('Post')}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex gap-2 items-center justify-around sm:hidden">
        <Button
          className="w-full"
          variant="secondary"
          onClick={(e) => {
            e.stopPropagation()
            close()
          }}
        >
          {t('Cancel')}
        </Button>
        <Button className="w-full" type="submit" disabled={!canPost} onClick={post}>
          {posting && <LoaderCircle className="animate-spin" />}
          {parentEvent ? t('Reply') : t('Post')}
        </Button>
      </div>
    </div>
  )

  return renderSections({ header, body, footer })
}
