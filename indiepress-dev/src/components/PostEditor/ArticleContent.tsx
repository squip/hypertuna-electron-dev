import { Button } from '@/components/ui/button'
import PostRelaySelector from './PostRelaySelector'
import { createLongFormDraftEvent } from '@/lib/draft-event'
import { useNostr } from '@/providers/NostrProvider'
import postEditorCache from '@/services/post-editor-cache.service'
import { Event } from '@nostr/tools/wasm'
import { useEffect, useMemo, useState, MouseEvent, ReactNode, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoaderCircle } from 'lucide-react'
import { randomString } from '@/lib/random'
import * as nip19 from '@nostr/tools/nip19'
import { TDraftEvent } from '@/types'
import ArticleMarkdownEditor, { MetadataSnapshot } from './ArticleMarkdownEditor'

export default function ArticleContent({
  close,
  openFrom,
  existingEvent,
  extraTags = [],
  onPublish,
  renderSections
}: {
  close: () => void
  openFrom?: string[]
  existingEvent?: Event
  extraTags?: string[][]
  onPublish?: (draftEvent: TDraftEvent, options: { isDraft: boolean; relayUrls: string[] }) => Promise<void>
  renderSections: (sections: {
    header?: React.ReactNode
    body: React.ReactNode
    footer: React.ReactNode
  }) => React.ReactNode
}) {
  const { t } = useTranslation()
  const { publish, checkLogin } = useNostr()
  const [title, setTitle] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [summary, setSummary] = useState('')
  const [image, setImage] = useState('')
  const [hashtagsText, setHashtagsText] = useState('')
  const [content, setContent] = useState('')
  const [bodyContent, setBodyContent] = useState('')
  const [editorJson, setEditorJson] = useState<any>(null)
  const [publishedAt, setPublishedAt] = useState<number | undefined>(undefined)
  const [posting, setPosting] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [mentions, setMentions] = useState<string[]>([])
  const [isProtectedEvent, setIsProtectedEvent] = useState(false)
  const [additionalRelayUrls, setAdditionalRelayUrls] = useState<string[]>([])
  const [uploadProgresses, setUploadProgresses] = useState<
    { file: File; progress: number; cancel: () => void }[]
  >([])
  const [metadataSnapshot, setMetadataSnapshot] = useState<MetadataSnapshot | null>(null)
  const [cacheHydrated, setCacheHydrated] = useState(false)
  const [templateResetKey, setTemplateResetKey] = useState(0)

  const cacheKey = useMemo(
    () => `article-editor:${existingEvent?.id ?? 'new'}`,
    [existingEvent?.id]
  )

  useEffect(() => {
    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached)
        setTitle(parsed.title ?? '')
        setIdentifier(parsed.identifier ?? randomString(12))
        setSummary(parsed.summary ?? '')
        setImage(parsed.image ?? '')
        setHashtagsText(parsed.hashtagsText ?? '')
        setContent(parsed.content ?? '')
        setBodyContent(parsed.bodyContent ?? parsed.content ?? '')
        setEditorJson(parsed.editorJson ?? null)
        setPublishedAt(parsed.publishedAt ?? undefined)
        setMetadataSnapshot(parsed.metadataSnapshot ?? null)
        setCacheHydrated(true)
        return
      } catch (e) {
        console.error('Failed to parse article editor cache', e)
      }
    }

    if (!existingEvent) {
      setIdentifier(randomString(12))
      return
    }
    const getTag = (name: string) => existingEvent.tags.find((tag) => tag[0] === name)?.[1] ?? ''
    const pubAt = getTag('published_at')
    const pubAtNum = pubAt ? parseInt(pubAt) : undefined
    setTitle(getTag('title') || '')
    setIdentifier(getTag('d') || randomString(12))
    setSummary(getTag('summary') || '')
    setImage(getTag('image') || '')
    if (pubAtNum && !Number.isNaN(pubAtNum)) {
      setPublishedAt(pubAtNum)
    }
    const hashTags = existingEvent.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1])
    if (hashTags.length) {
      setHashtagsText(hashTags.join(', '))
    }
    const incomingContent = existingEvent.content || ''
    setContent(incomingContent)
    setBodyContent(incomingContent)
    setMetadataSnapshot(null)
    setCacheHydrated(true)
  }, [existingEvent, cacheKey])

  useEffect(() => {
    if (!metadataSnapshot) return
    if (metadataSnapshot.hasMetadataBlock) {
      setTitle(metadataSnapshot.title ?? '')
      setSummary(metadataSnapshot.summary ?? '')
      setImage(metadataSnapshot.coverDismissed ? '' : metadataSnapshot.image ?? '')
    } else if (metadataSnapshot.dismissed) {
      setTitle('')
      setSummary('')
      setImage('')
    }
  }, [metadataSnapshot])

  useEffect(() => {
    const shouldClearCache =
      ((!content?.trim() && !editorJson) || metadataSnapshot?.isTemplatePristine === true)

    if (shouldClearCache) {
      localStorage.removeItem(cacheKey)
      setCacheHydrated(true)
      return
    }

    const payload = {
      title,
      identifier,
      summary,
      image,
      hashtagsText,
      content,
      bodyContent,
      editorJson,
      publishedAt,
      metadataSnapshot
    }
    try {
      localStorage.setItem(cacheKey, JSON.stringify(payload))
    } catch (e) {
      console.error('Failed to cache article editor state', e)
    }
  }, [
    title,
    identifier,
    summary,
    image,
    hashtagsText,
    content,
    bodyContent,
    publishedAt,
    cacheKey,
    editorJson,
    metadataSnapshot
  ])

  const canPublish = useMemo(() => {
    const effectiveBody = bodyContent || content
    const hasContent = !!effectiveBody.trim() && metadataSnapshot?.isTemplatePristine !== true
    return (
      !!identifier.trim() &&
      hasContent &&
      !posting &&
      !savingDraft &&
      !uploadProgresses.length
    )
  }, [identifier, bodyContent, content, posting, savingDraft, uploadProgresses.length, metadataSnapshot])

  const hashtags = useMemo(
    () =>
      hashtagsText
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    [hashtagsText]
  )

  const deriveTitle = () => {
    const base = bodyContent || content
    const lines = base.split('\n').map((l) => l.trim()).filter(Boolean)
    const firstLine = lines[0] ?? ''
    const cleaned = firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '')
    const fallback = cleaned || content.replace(/[#*_`>]/g, ' ').trim()
    const normalized = fallback || t('Untitled article') || 'Untitled article'
    return normalized.slice(0, 120)
  }

  const resolvedMetadata = useMemo(() => {
    if (metadataSnapshot?.dismissed) {
      return { title: undefined, summary: undefined, image: undefined }
    }
    if (metadataSnapshot?.hasMetadataBlock) {
      return {
        title: metadataSnapshot.title,
        summary: metadataSnapshot.summary,
        image: metadataSnapshot.coverDismissed ? undefined : metadataSnapshot.image
      }
    }
    if (existingEvent) {
      return {
        title: title || '',
        summary,
        image
      }
    }
    return { title, summary, image }
  }, [metadataSnapshot, existingEvent, title, summary, image])

  const shouldInsertTemplate = useMemo(() => {
    if (existingEvent) return false
    const hasMeaningfulCache =
      Boolean(content?.trim?.()) || Boolean(editorJson) || Boolean(bodyContent?.trim?.())
    if (templateResetKey > 0) {
      if (metadataSnapshot?.hasMetadataBlock) return false
      return true
    }
    if (metadataSnapshot?.hasMetadataBlock) return false
    if (hasMeaningfulCache) return false
    return true
  }, [existingEvent, content, bodyContent, editorJson, metadataSnapshot, templateResetKey])

  const handleClearEditor = useCallback(() => {
    setTitle('')
    setSummary('')
    setImage('')
    setContent('')
    setBodyContent('')
    setEditorJson(null)
    setMetadataSnapshot(null)
    setHashtagsText('')
    setIdentifier(randomString(12))
    setPublishedAt(undefined)
    try {
      localStorage.removeItem(cacheKey)
    } catch (_e) {
      /* ignore */
    }
    setTemplateResetKey((prev) => prev + 1)
  }, [cacheKey])

  const buildDraft = (isDraft: boolean) => {
    const dismissedMetadata = metadataSnapshot?.dismissed
    const fallbackTitle = (title || '').trim() || deriveTitle()
    const resolvedTitle =
      dismissedMetadata
        ? undefined
        : resolvedMetadata.title !== undefined
          ? resolvedMetadata.title?.trim?.() || undefined
          : metadataSnapshot?.hasMetadataBlock
            ? undefined
            : fallbackTitle
    const resolvedSummary =
      dismissedMetadata
        ? undefined
        : resolvedMetadata.summary !== undefined
          ? resolvedMetadata.summary?.trim?.() || undefined
          : metadataSnapshot?.hasMetadataBlock
            ? undefined
            : summary.trim() || undefined
    const resolvedImage =
      dismissedMetadata
        ? undefined
        : resolvedMetadata.image !== undefined
          ? resolvedMetadata.image?.trim?.() || undefined
          : metadataSnapshot?.hasMetadataBlock
            ? undefined
            : image.trim() || undefined

    const body = bodyContent || content
    const base = createLongFormDraftEvent(
      {
        title: resolvedTitle,
        content: body,
        summary: resolvedSummary,
        image: resolvedImage,
        identifier: identifier.trim(),
        hashtags,
        publishedAt: isDraft ? undefined : publishedAt ?? Math.floor(Date.now() / 1000),
        extraTags
      },
      {
        isDraft,
        existingEvent
      }
    )
    postEditorCache.clearPostCache({ defaultContent: 'article' })
    return base
  }

  const publishDraft = async (isDraft: boolean) => {
    await checkLogin(async () => {
      if (!canPublish) return
      if (isDraft) {
        setSavingDraft(true)
      } else {
        setPosting(true)
      }
      try {
        const draftEvent = buildDraft(isDraft)
        let newEvent
        if (onPublish) {
          await onPublish(draftEvent, { isDraft, relayUrls: additionalRelayUrls })
        } else {
          newEvent = await publish(draftEvent, {
            specifiedRelayUrls: isProtectedEvent ? additionalRelayUrls : undefined,
            additionalRelayUrls
          })
        }
        let description: string | undefined
        try {
          const dTag = (newEvent as Event | undefined)?.tags.find((tag) => tag[0] === 'd')?.[1] || identifier
          if (newEvent) {
            const naddr = nip19.naddrEncode({
              kind: 30023,
              pubkey: (newEvent as Event).pubkey,
              identifier: dTag,
              relays: []
            })
            description = naddr
          }
        } catch (e) {
          console.warn('Failed to encode naddr', e)
        }
        toast.success(isDraft ? t('Draft saved') : t('Article published'), {
          description
        })
        try {
          localStorage.removeItem(cacheKey)
        } catch (_e) {
          /* ignore */
        }
        close()
        return newEvent
      } catch (error) {
        const errors = error instanceof AggregateError ? error.errors : [error]
        errors.forEach((err) => {
          toast.error(
            `${t('Failed to post')}: ${err instanceof Error ? err.message : String(err)}`,
            { duration: 10_000 }
          )
          console.error(err)
        })
      } finally {
        setSavingDraft(false)
        setPosting(false)
      }
    })
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

  const [toolbar, setToolbar] = useState<ReactNode | null>(null)
  const handleRenderToolbar = useCallback((node: ReactNode) => {
    setToolbar(node)
  }, [])

  const body = (
    <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
      {!cacheHydrated ? (
        <div className="text-sm text-muted-foreground">{t('Loading...')}</div>
      ) : (
        <ArticleMarkdownEditor
          value={content}
          onChange={setContent}
          onBodyChange={setBodyContent}
          initialJson={editorJson}
          onJsonChange={setEditorJson}
          onMetadataChange={setMetadataSnapshot}
          initialMetadata={metadataSnapshot?.dismissed ? undefined : metadataSnapshot ?? undefined}
          shouldInsertTemplate={shouldInsertTemplate}
          mentions={mentions}
          setMentions={setMentions}
          onUploadStart={handleUploadStart}
          onUploadEnd={handleUploadEnd}
          onUploadProgress={handleUploadProgress}
          onClearEditor={handleClearEditor}
          onUploadSuccess={({ url }) => {
            setContent((prev) => `${prev}${prev ? '\n' : ''}${url}`)
          }}
          onEmojiSelect={(emoji) => {
            if (!emoji) return
            setContent((prev) =>
              `${prev} ${typeof emoji === 'string' ? emoji : `:${emoji.shortcode}:`}`.trim()
            )
          }}
          onSaveDraft={() => publishDraft(true)}
          renderToolbar={handleRenderToolbar}
          templateResetKey={templateResetKey}
        />
      )}
    </div>
  )

  const footer = (
    <div className="space-y-2">
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
              ×
            </button>
          </div>
        ))}
      <PostRelaySelector
        setIsProtectedEvent={setIsProtectedEvent}
        setAdditionalRelayUrls={setAdditionalRelayUrls}
        parentEvent={existingEvent}
        openFrom={openFrom}
      />
      <div className="flex flex-wrap items-center gap-2 justify-end max-sm:hidden">
        <Button
          data-post-cancel-button
          variant="secondary"
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            close()
          }}
        >
          {t('Cancel')}
        </Button>
        <Button
          data-post-publish-button
          disabled={!canPublish || posting}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            publishDraft(false)
          }}
        >
          {posting && <LoaderCircle className="animate-spin mr-2 h-4 w-4" />}
          {t('Publish')}
        </Button>
      </div>
      <div className="flex gap-2 items-center justify-around sm:hidden">
        <Button
          data-post-cancel-button
          className="w-full"
          variant="secondary"
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            close()
          }}
        >
          {t('Cancel')}
        </Button>
        <Button
          data-post-publish-button
          className="w-full"
          disabled={!canPublish || posting}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            publishDraft(false)
          }}
        >
          {posting && <LoaderCircle className="animate-spin mr-2 h-4 w-4" />}
          {t('Publish')}
        </Button>
      </div>
    </div>
  )

  return renderSections({ header: toolbar ?? undefined, body, footer })
}
