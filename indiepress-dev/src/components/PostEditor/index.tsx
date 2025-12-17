import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import postEditor from '@/services/post-editor.service'
import { Event } from '@nostr/tools/wasm'
import {
  CSSProperties,
  Dispatch,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import PostContent from './PostContent'
import ArticleContent from './ArticleContent'
import Title from './Title'
import { cn } from '@/lib/utils'

export type PostEditorProps = {
  defaultContent?: string
  parentEvent?: Event
  open: boolean
  setOpen: Dispatch<boolean>
  openFrom?: string[]
  defaultTab?: 'post' | 'article'
  articleOptions?: {
    existingEvent?: Event
    extraTags?: string[][]
    onPublish?: (draftEvent: any, options: { isDraft: boolean; relayUrls: string[] }) => Promise<void>
  }
  tabPreset?: 'default' | 'personal'
  groupContext?: {
    groupId: string
    relay?: string
  }
}

export default function PostEditor({
  defaultContent = '',
  parentEvent,
  open,
  setOpen,
  openFrom,
  defaultTab = 'post',
  articleOptions,
  tabPreset = 'default',
  groupContext
}: PostEditorProps) {
  const { isSmallScreen } = useScreenSize()
  const { t } = useTranslation()
  const tabsConfig = useMemo(() => {
    if (parentEvent) {
      return [{ value: 'post' as const, label: t('New Post') }]
    }
    if (tabPreset === 'personal') {
      return [{ value: 'article' as const, label: t('New Personal Note') }]
    }
    return [
      { value: 'post' as const, label: t('New Post') },
      { value: 'article' as const, label: t('New Article') }
    ]
  }, [parentEvent, tabPreset, t])

  const [tab, setTab] = useState<'post' | 'article'>(
    parentEvent ? 'post' : tabsConfig[0]?.value ?? defaultTab
  )

  useEffect(() => {
    const first = tabsConfig[0]?.value
    if (first && tab !== first && !tabsConfig.find((t) => t.value === tab)) {
      setTab(first)
    }
  }, [tabsConfig, tab])

  const canToggleTabs = !parentEvent && tabsConfig.length > 1

  // Replies/quotes should never switch into article mode
  useEffect(() => {
    if (parentEvent && tab !== 'post') {
      setTab('post')
    }
  }, [parentEvent, tab])

  // Layout instrumentation: log scroll parents and sticky positions on desktop.
  useEffect(() => {
    if (isSmallScreen) return
    if (typeof window === 'undefined') return

    const root = document.querySelector('[data-post-editor-scroll]') as HTMLElement | null
    const viewport =
      root?.querySelector('[data-radix-scroll-area-viewport]') ||
      root?.querySelector('[data-viewport]') ||
      null
    const tabs = document.querySelector('[data-post-editor-tabs]') as HTMLElement | null
    const toolbar = document.querySelector('.article-toolbar') as HTMLElement | null

    const findScrollParent = (el: HTMLElement | null): HTMLElement | null => {
      let node: HTMLElement | null = el
      while (node?.parentElement) {
        node = node.parentElement
        const style = getComputedStyle(node)
        if (/(auto|scroll)/.test(style.overflowY || style.overflow)) {
          return node
        }
      }
      return null
    }

    const logLayout = (label: string) => {
      const scrollParent = findScrollParent(tabs)
      const tabsRect = tabs?.getBoundingClientRect()
      const toolbarRect = toolbar?.getBoundingClientRect()
      const vpStyle = viewport ? getComputedStyle(viewport) : null
      const rootStyle = root ? getComputedStyle(root) : null
      const relaySelector = document.querySelector('[data-post-relay-selector]') as HTMLElement | null
      const cancelButton = document.querySelector('[data-post-cancel-button]') as HTMLElement | null
      const publishButton = document.querySelector('[data-post-publish-button]') as HTMLElement | null
      const relayRect = relaySelector?.getBoundingClientRect()
      const cancelRect = cancelButton?.getBoundingClientRect()
      const publishRect = publishButton?.getBoundingClientRect()
      // eslint-disable-next-line no-console
      console.log('[PostEditor] layout', {
        label,
        viewportOverflowY: vpStyle?.overflowY,
        rootOverflowY: rootStyle?.overflowY,
        scrollParent: scrollParent?.tagName,
        viewportScrollTop: viewport?.scrollTop ?? null,
        tabsTop: tabsRect?.top ?? null,
        toolbarTop: toolbarRect?.top ?? null,
        tabsPosition: tabs ? getComputedStyle(tabs).position : null,
        tabsTopStyle: tabs ? getComputedStyle(tabs).top : null,
        bodyScrollTop: document.scrollingElement?.scrollTop ?? null,
        relayTop: relayRect?.top ?? null,
        cancelTop: cancelRect?.top ?? null,
        publishTop: publishRect?.top ?? null
      })
    }

    const raf = requestAnimationFrame(() => logLayout('mount'))
    let loggedScroll = false
    const handleScroll = () => {
      if (!loggedScroll) {
        loggedScroll = true
      }
      logLayout('scroll')
    }
    const docScroll = () => logLayout('doc-scroll')
    viewport?.addEventListener('scroll', handleScroll, { passive: true })
    document.addEventListener('scroll', docScroll, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      viewport?.removeEventListener('scroll', handleScroll)
      document.removeEventListener('scroll', docScroll)
    }
  }, [isSmallScreen, tab])

  const renderTabs = (variant: 'sheet' | 'dialog') => {
    const TabsWrapper = variant === 'sheet' ? SheetHeader : DialogHeader
    const TitleWrapper = variant === 'sheet' ? SheetTitle : DialogTitle
    const singleLabel = tabsConfig.length === 1 ? tabsConfig[0]?.label : null
    return (
      <TabsWrapper className="space-y-3">
        {canToggleTabs ? (
          <Tabs
            className="w-full"
            value={tab}
            onValueChange={(v) => setTab(v as 'post' | 'article')}
          >
            <div className="bg-background">
              <TabsList
                data-post-editor-tabs
                className="bg-transparent p-0 h-auto gap-6 justify-start w-full"
              >
                {tabsConfig.map(({ value, label }) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="rounded-none px-0 py-1 text-base font-semibold shadow-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:shadow-none text-muted-foreground"
                  >
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </Tabs>
        ) : (
          <TitleWrapper className={variant === 'sheet' ? 'text-start' : undefined}>
            {singleLabel ?? <Title parentEvent={parentEvent} tab={tab} />}
          </TitleWrapper>
        )}
        {canToggleTabs
          ? (
            <TitleWrapper className="sr-only">
              {tab === 'post' ? t('New Post') : t('New Article')}
            </TitleWrapper>
          )
          : singleLabel && (
            <TitleWrapper className="sr-only">
              {singleLabel}
            </TitleWrapper>
          )}
      </TabsWrapper>
    )
  }

  if (isSmallScreen) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          className="h-full w-full p-0 border-none"
          side="bottom"
          hideClose
          onEscapeKeyDown={(e) => {
            if (postEditor.isSuggestionPopupOpen) {
              e.preventDefault()
              postEditor.closeSuggestionPopup()
            }
          }}
        >
          {parentEvent || tab === 'post' ? (
          <PostContent
            defaultContent={defaultContent}
            parentEvent={parentEvent}
            close={() => setOpen(false)}
            openFrom={openFrom}
            groupContext={groupContext}
            renderSections={({ header, body, footer }) => (
              <PostEditorFrame
                maxHeightClass="max-h-[calc(100vh-140px)]"
                header={
                    <>
                      {renderTabs('sheet')}
                      {header ? <div>{header}</div> : null}
                    </>
                  }
                  body={body}
                footer={footer}
              />
            )}
          />
          ) : (
            <ArticleContent
              close={() => setOpen(false)}
              openFrom={openFrom}
              existingEvent={articleOptions?.existingEvent}
              extraTags={articleOptions?.extraTags}
              onPublish={articleOptions?.onPublish}
              renderSections={({ header, body, footer }) => (
                <PostEditorFrame
                  maxHeightClass="max-h-[calc(100vh-140px)]"
                  header={
                    <>
                      {renderTabs('sheet')}
                      {header ? <div>{header}</div> : null}
                    </>
                  }
                  body={body}
                  footer={footer}
                />
              )}
            />
          )}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className={`p-0 ${parentEvent || tab === 'post' ? 'max-w-2xl' : 'max-w-4xl'}`}
        withoutClose
        onEscapeKeyDown={(e) => {
          if (postEditor.isSuggestionPopupOpen) {
            e.preventDefault()
            postEditor.closeSuggestionPopup()
          }
        }}
      >
        {parentEvent || tab === 'post' ? (
          <PostContent
            defaultContent={defaultContent}
            parentEvent={parentEvent}
            close={() => setOpen(false)}
            openFrom={openFrom}
            groupContext={groupContext}
            renderSections={({ header, body, footer }) => (
              <PostEditorFrame
                maxHeightClass="max-h-[calc(100vh-160px)]"
                header={
                  <>
                    {renderTabs('dialog')}
                    {header ? <div>{header}</div> : null}
                  </>
                }
                body={body}
                footer={footer}
              />
            )}
          />
        ) : (
          <ArticleContent
            close={() => setOpen(false)}
            openFrom={openFrom}
            existingEvent={articleOptions?.existingEvent}
            extraTags={articleOptions?.extraTags}
            onPublish={articleOptions?.onPublish}
            renderSections={({ header, body, footer }) => (
              <PostEditorFrame
                maxHeightClass="max-h-[calc(100vh-160px)]"
                header={
                  <>
                    {renderTabs('dialog')}
                    {header ? <div>{header}</div> : null}
                  </>
                }
                body={body}
                footer={footer}
              />
            )}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PostEditorFrame({
  header,
  body,
  footer,
  maxHeightClass,
  className
}: {
  header: ReactNode
  body: ReactNode
  footer?: ReactNode
  maxHeightClass: string
  className?: string
}) {
  const headerRef = useRef<HTMLDivElement | null>(null)
  const [headerHeight, setHeaderHeight] = useState(0)

  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => setHeaderHeight(el.getBoundingClientRect().height || 0)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const style = useMemo(
    () =>
      ({
        '--post-editor-header-height': `${headerHeight}px`
      }) as CSSProperties,
    [headerHeight]
  )

  return (
    <div
      className={cn('flex h-full w-full flex-col', maxHeightClass, className)}
      style={style}
    >
      <div ref={headerRef} className="px-4 pt-4 pb-2 space-y-3 min-h-[64px]">
        {header}
      </div>
      <ScrollArea
        className="flex-1 min-h-0 px-4"
        allowStickyChildren
        data-post-editor-scroll
      >
        <div className="space-y-3 px-2 py-3">{body}</div>
      </ScrollArea>
      {footer ? <div className="px-4 py-3">{footer}</div> : null}
    </div>
  )
}
