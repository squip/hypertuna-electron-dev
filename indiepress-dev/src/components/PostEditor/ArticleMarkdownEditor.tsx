import React, {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Node, Extension } from '@tiptap/core'
import {
  EditorContent,
  NodeViewContent,
  ReactNodeViewRenderer,
  useEditor,
  NodeViewWrapper
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Heading, { type Level } from '@tiptap/extension-heading'
import Blockquote from '@tiptap/extension-blockquote'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import ImageExtension from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import { createPortal } from 'react-dom'
import Uploader from './Uploader'
import EmojiPickerDialog from '../EmojiPickerDialog'
import Mentions from './Mentions'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn, isTouchDevice } from '@/lib/utils'
import {
  Bold,
  Code,
  CodeXml,
  ImageUp as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo,
  Type,
  Underline as UnderlineIcon,
  Undo,
  Smile,
  Save,
  SquarePlus,
  SquareX,
  Upload,
  LayoutTemplate,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Trash2
} from 'lucide-react'
import Mention from './PostTextarea/Mention'
import mentionSuggestion from './PostTextarea/Mention/suggestion'
import Emoji from './PostTextarea/Emoji'
import emojiSuggestion from './PostTextarea/Emoji/suggestion'
import { ClipboardAndDropHandler } from './PostTextarea/ClipboardAndDropHandler'
import { createLongFormDraftEvent } from '@/lib/draft-event'
import { randomString } from '@/lib/random'
import WebPreview from '../WebPreview'
import YoutubeEmbeddedPlayer from '../YoutubeEmbeddedPlayer'
import VideoPlayer from '../VideoPlayer'
import { useFetchWebMetadata } from '@/hooks/useFetchWebMetadata'
import { Play } from 'lucide-react'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Plugin } from '@tiptap/pm/state'
import { DOMParser as PMDOMParser } from '@tiptap/pm/model'
import { useNostr } from '@/providers/NostrProvider'

type ArticleMarkdownEditorProps = {
  value: string
  onChange: (next: string) => void
  initialJson?: any
  onJsonChange?: (json: any) => void
  onBodyChange?: (next: string) => void
  onMetadataChange?: (meta: MetadataSnapshot) => void
  initialMetadata?: MetadataSnapshot
  mentions?: string[]
  setMentions?: (m: string[]) => void
  onEmojiSelect?: (emoji: any) => void
  onUploadStart?: (file: File, cancel: () => void) => void
  onUploadEnd?: (file: File) => void
  onUploadProgress?: (file: File, progress: number) => void
  onUploadSuccess?: ({ url, tags }: { url: string; tags: string[][] }) => void
  onSaveDraft?: () => void
  shouldInsertTemplate?: boolean
  renderToolbar?: (toolbar: React.ReactNode) => void
  onClearEditor?: () => void
  templateResetKey?: number
}

type MetadataControlsMode = 'hidden' | 'group' | 'field'
type MetadataRole = 'title' | 'summary' | 'cover'

export type MetadataSnapshot = {
  title?: string
  summary?: string
  image?: string
  metadataId?: string | null
  hasMetadataBlock: boolean
  dismissed: boolean
  isTemplatePristine: boolean
  coverDismissed?: boolean
}

type MetadataControls = {
  getMode: () => MetadataControlsMode
  onGroupRemove: (metadataId?: string | null) => void
  debugLog?: (message: string, data?: unknown) => void
  setLastAction?: (source: string) => void
}

const METADATA_TITLE_PLACEHOLDER = 'Add a title'
const METADATA_SUMMARY_PLACEHOLDER = 'Add a summary ...'

export default function ArticleMarkdownEditor({
  value,
  onChange,
  initialJson,
  onJsonChange,
  onBodyChange,
  onMetadataChange,
  initialMetadata,
  mentions,
  setMentions,
  onEmojiSelect,
  onUploadStart,
  onUploadEnd,
  onUploadProgress,
  onUploadSuccess,
  onSaveDraft,
  shouldInsertTemplate,
  renderToolbar,
  onClearEditor,
  templateResetKey
}: ArticleMarkdownEditorProps) {
  const lastMarkdown = useRef(value)
  const initialJsonRef = useRef<any>(sanitizeContent(initialJson))
  const templateInsertedRef = useRef(false)
  const metadataControlsRef = useRef<MetadataControls>({
    getMode: () => 'hidden',
    onGroupRemove: () => {},
    setLastAction: () => {}
  })
  const metadataModeRef = useRef<MetadataControlsMode>('hidden')
  const [metadataMode, setMetadataMode] = useState<MetadataControlsMode>('hidden')
  const metadataDismissedRef = useRef(false)
  const allowMetadataRemovalRef = useRef(false)
  const [metadataSnapshot, setMetadataSnapshot] = useState<MetadataSnapshot | null>(null)
  const [hasFocus, setHasFocus] = useState(false)
  const [keyboardOffset, setKeyboardOffset] = useState(0)
  const [isFabOpen, setIsFabOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const hydratedFromInitialJsonRef = useRef(false)
  const keyboardOpenRef = useRef(false)
  const lastResetKeyRef = useRef<number | undefined>(undefined)
  const baselineViewportHeight = useRef<number | null>(null)
  const caretRafRef = useRef<number | null>(null)
  const toolbarScrollRef = useRef<HTMLDivElement | null>(null)
  const toolbarDragRef = useRef<{
    startX: number
    startScrollLeft: number
    moved: boolean
  } | null>(null)
  const skipToolbarTapRef = useRef(false)
  const [scrollShadows, setScrollShadows] = useState({ left: false, right: false })
  const inertiaFrameRef = useRef<number | null>(null)
  const lastTouchRef = useRef<{ x: number; t: number } | null>(null)
  const prevTouchRef = useRef<{ x: number; t: number } | null>(null)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('https://')
  const [linkText, setLinkText] = useState('')
  const { signEvent } = useNostr()
  const editorRef = useRef<ReturnType<typeof useEditor> | null>(null)
  const [debugEnabled, setDebugEnabled] = useState(() => {
    if (typeof window === 'undefined') return false
    const stored = localStorage.getItem('article-editor-debug')
    if (stored === 'true') return true
    if (stored === 'false') return false
    return Boolean(import.meta.env.DEV)
  })
  const [debugEntries, setDebugEntries] = useState<
    { id: string; time: string; message: string; data?: unknown }[]
  >([])
  const [debugPanelOpen, setDebugPanelOpen] = useState(() => {
    if (typeof window === 'undefined') return false
    const stored = localStorage.getItem('article-editor-debug')
    if (stored === 'true') return true
    if (stored === 'false') return false
    return Boolean(import.meta.env.DEV)
  })
  const lastMetadataSnapshotRef = useRef<MetadataSnapshot | null>(null)
  const lastMetadataActionRef = useRef<string | null>(null)
  const linkSelectionRef = useRef<{ from: number; to: number } | null>(null)

  const debugIdRef = useRef(0)
  const debugLog = useCallback(
    (message: string, data?: unknown) => {
      if (!debugEnabled) return
      const now = new Date()
      debugIdRef.current += 1
      const entry = {
        id: `${now.getTime()}-${debugIdRef.current}`,
        time: now.toLocaleTimeString(),
        message,
        data: serializeDebug(data)
      }
      setDebugEntries((prev) => [...prev.slice(-49), entry])
      console.log('[ArticleEditor]', message, entry.data ?? '')
    },
    [debugEnabled]
  )
  metadataControlsRef.current.debugLog = debugLog
  metadataControlsRef.current.setLastAction = (source: string) => {
    lastMetadataActionRef.current = source
  }

  const withMetadataRemovalAllowed = useCallback(
    (fn: () => void) => {
      allowMetadataRemovalRef.current = true
      try {
        fn()
      } finally {
        allowMetadataRemovalRef.current = false
      }
    },
    []
  )

  useEffect(() => {
    localStorage.setItem('article-editor-debug', debugEnabled ? 'true' : 'false')
    if (debugEnabled) {
      setDebugPanelOpen(true)
    }
  }, [debugEnabled])

  const [isTouchSmallScreen, setIsTouchSmallScreen] = useState(() => {
    if (typeof window === 'undefined') return false
    return isTouchDevice() && window.innerWidth <= 1100
  })
  const [isTouchInput, setIsTouchInput] = useState(() => isTouchDevice())

  const updateScrollShadows = useCallback(() => {
    const el = toolbarScrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
    setScrollShadows({
      left: scrollLeft > 2,
      right: scrollLeft < maxScrollLeft - 2
    })
  }, [])

  const scrollCaretIntoView = useCallback(() => {
    if (!isTouchSmallScreen) return
    if (!keyboardOpenRef.current) return
    const view = editorRef.current?.view
    if (!view) return

    const viewport = document.querySelector('[data-post-editor-scroll] [data-radix-scroll-area-viewport]') as HTMLElement | null
    const scrollContainer =
      viewport ||
      document.querySelector('[data-post-editor-scroll] [data-viewport]') as HTMLElement | null
    if (!scrollContainer) return

    const { state } = view
    const pos = state.selection?.to ?? state.selection?.from ?? 0
    let coords: { top: number; bottom: number } | null = null
    try {
      coords = view.coordsAtPos(pos)
    } catch (_e) {
      return
    }
    if (!coords) return

    const containerRect = scrollContainer.getBoundingClientRect()
    const lineTop = coords.top
    const lineBottom = coords.bottom
    const topInContainer = lineTop - containerRect.top + scrollContainer.scrollTop
    const bottomInContainer = lineBottom - containerRect.top + scrollContainer.scrollTop

    const vpHeight = typeof window !== 'undefined' ? window.visualViewport?.height ?? window.innerHeight : scrollContainer.clientHeight
    const keyboardInset = Math.max(0, (typeof window !== 'undefined' ? window.innerHeight - vpHeight : 0))
    const safePadding = 24 + keyboardInset + keyboardOffset
    const visibleTop = scrollContainer.scrollTop
    const visibleBottom = scrollContainer.scrollTop + scrollContainer.clientHeight - safePadding

    if (bottomInContainer > visibleBottom) {
      scrollContainer.scrollTo({
        top: bottomInContainer - scrollContainer.clientHeight + safePadding,
        behavior: 'smooth'
      })
    } else if (topInContainer < visibleTop) {
      scrollContainer.scrollTo({
        top: topInContainer - 12,
        behavior: 'smooth'
      })
    }
  }, [isTouchSmallScreen, keyboardOffset])

  const updateDesktopToolbarOffset = useCallback(() => {
    if (typeof document === 'undefined' || isTouchSmallScreen) return
    const tabs = document.querySelector('[data-post-editor-tabs]') as HTMLElement | null
    const tabsHeight = tabs?.getBoundingClientRect().height ?? 0
    debugLog('layout:toolbar-offset', {
      tabsHeight,
      hasTabs: Boolean(tabs)
    })
  }, [debugLog, isTouchSmallScreen])

  const guardMetadataDeletion = useCallback(
    (view: any, event: KeyboardEvent) => {
      if (allowMetadataRemovalRef.current) return false
      const isDeleteKey =
        event.key === 'Backspace' ||
        event.key === 'Delete' ||
        ((event.metaKey || event.ctrlKey) && (event.key === 'Backspace' || event.key === 'Delete'))
      if (!isDeleteKey) return false
      const { state } = view
      const titleNode = findMetadataNodeByRole(state.doc, 'title')
      const summaryNode = findMetadataNodeByRole(state.doc, 'summary')
      const { from, to, empty, $from } = state.selection
      const protectedNodes = [titleNode, summaryNode].filter(
        (node): node is { from: number; to: number; node: any } => Boolean(node)
      )
      const overlapping = protectedNodes.filter((node) => from < node.to && to > node.from)

      // If selection is non-empty, allow edits entirely inside a single metadata node;
      // block if it crosses/erases boundaries or spans multiple metadata nodes.
      if (!empty && overlapping.length) {
        const single = overlapping.length === 1 ? overlapping[0] : null
        if (single && from > single.from && to < single.to) {
          return false
        }
        event.preventDefault()
        return true
      }

      if (!empty) return false
      const parentIsMetadata = Boolean($from.parent?.attrs?.metadata)
      if (parentIsMetadata) {
        const offset = $from.parentOffset
        const parentSize = $from.parent?.content?.size ?? 0
        if (
          (event.key === 'Backspace' && offset === 0) ||
          (event.key === 'Delete' && offset === parentSize) ||
          ((event.metaKey || event.ctrlKey) && (event.key === 'Backspace' || event.key === 'Delete'))
        ) {
          event.preventDefault()
          return true
        }
      }
      return false
    },
    []
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleResize = () => {
      const touch = isTouchDevice()
      setIsTouchInput(touch)
      setIsTouchSmallScreen(touch && window.innerWidth <= 1100)
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    updateDesktopToolbarOffset()
    if (typeof window === 'undefined') return
    window.addEventListener('resize', updateDesktopToolbarOffset)
    return () => window.removeEventListener('resize', updateDesktopToolbarOffset)
  }, [updateDesktopToolbarOffset])

  const getMarkdown = useCallback(
    (editorInstance: ReturnType<typeof useEditor> | null) => {
      if (!editorInstance) return ''
      const storage = (editorInstance as any)?.storage?.markdown
      if (storage?.getMarkdown) {
        return storage.getMarkdown()
      }
      return editorInstance?.getText?.() ?? ''
    },
    []
  )

  const MentionWithMarkdown = useMemo(
    () =>
      Mention.extend({
        addStorage() {
          return {
            markdown: {
              serialize: (state: any, node: any) => {
                const npub = (node?.attrs?.id as string) || ''
                if (npub) {
                  state.write(`nostr:${npub}`)
                }
              },
              parse: {
                // no-op; mentions will come back as plain text unless a custom parser is added
              }
            }
          }
        }
      }),
    []
  )

  const EmojiWithMarkdown = useMemo(
    () =>
      Emoji.extend({
        addStorage() {
          const parent = this.parent?.() ?? {}
          return {
            ...parent,
            markdown: {
              serialize: (state: any, node: any) => {
                const text = node?.attrs?.name || node?.text || ''
                state.write(text)
              },
              parse: {
                // no-op; emojis will round-trip as text
              }
            }
          }
        }
      }),
    []
  )

  const metadataHeadingExtension = useMemo(
    () => createMetadataHeadingExtension(metadataControlsRef),
    []
  )
  const metadataBlockquoteExtension = useMemo(
    () => createMetadataBlockquoteExtension(metadataControlsRef),
    []
  )
  const coverPlaceholderExtension = useMemo(
    () => createCoverPlaceholderNode(metadataControlsRef),
    []
  )
  const metadataProtectionExtension = useMemo(
    () =>
      Extension.create({
        name: 'metadataProtection',
        addProseMirrorPlugins() {
          return [
            new Plugin({
              filterTransaction(tr, state) {
                if (allowMetadataRemovalRef.current) return true
                if (!tr.docChanged) return true

                const prevTitle = findMetadataNodeByRole(state.doc, 'title')
                const prevSummary = findMetadataNodeByRole(state.doc, 'summary')
                const nextTitle = findMetadataNodeByRole(tr.doc, 'title')
                const nextSummary = findMetadataNodeByRole(tr.doc, 'summary')

                // Reject removal or type/role changes.
                if (prevTitle && (!nextTitle || prevTitle.node.type.name !== nextTitle.node.type.name)) return false
                if (nextTitle && nextTitle.node.attrs?.level !== 1) return false
                if (prevSummary && (!nextSummary || prevSummary.node.type.name !== nextSummary.node.type.name)) return false
                const summaryChild = nextSummary?.node?.firstChild
                if (nextSummary && (!summaryChild || summaryChild.type.name !== 'heading' || summaryChild.attrs?.level !== 4)) {
                  return false
                }
                const top0 = tr.doc.childCount > 0 ? tr.doc.child(0) : null
                const top1 = tr.doc.childCount > 1 ? tr.doc.child(1) : null
                const top2 = tr.doc.childCount > 2 ? tr.doc.child(2) : null
                if (top0 && !(top0.attrs?.metadata && top0.attrs?.metadataRole === 'title')) return false
                if (top1 && !(top1.attrs?.metadata && top1.attrs?.metadataRole === 'summary')) return false
                if (
                  top2 &&
                  !(
                    top2.attrs?.metadata &&
                    top2.attrs?.metadataRole === 'cover'
                  )
                )
                  return false
                return true
              }
            })
          ]
        }
      }),
    [allowMetadataRemovalRef]
  )

  const notifyMetadataChange = useCallback(
    (doc: any, reason?: string) => {
      const snapshot = extractMetadataFromDoc(doc, metadataDismissedRef.current)
      if (snapshot.hasMetadataBlock) {
        metadataDismissedRef.current = false
      } else if (templateInsertedRef.current) {
        metadataDismissedRef.current = true
      }
      if (lastMetadataSnapshotRef.current?.hasMetadataBlock !== snapshot.hasMetadataBlock) {
        debugLog('metadata:transition', {
          previous: lastMetadataSnapshotRef.current?.hasMetadataBlock ?? null,
          next: snapshot.hasMetadataBlock,
          reason,
          dismissed: snapshot.dismissed,
          lastAction: lastMetadataActionRef.current
        })
      }
      lastMetadataSnapshotRef.current = snapshot
      setMetadataSnapshot(snapshot)
      onMetadataChange?.(snapshot)
      debugLog('metadata:snapshot', { reason, ...snapshot })
      return snapshot
    },
    [onMetadataChange, debugLog]
  )

  const recomputeMetadataUi = useCallback(
    (state: any, reason?: string, options?: { forceGroup?: boolean }) => {
      if (!state?.doc) return metadataModeRef.current
      const hasMetadata = hasMetadataBlock(state.doc)
      const selectionInside =
        !options?.forceGroup && hasMetadata && isSelectionInsideMetadata(state.doc, state.selection)
      const nextMode: MetadataControlsMode = !hasMetadata
        ? 'hidden'
        : selectionInside
          ? 'field'
          : 'group'
      if (metadataModeRef.current !== nextMode) {
        debugLog('metadata:ui', {
          reason,
          previous: metadataModeRef.current,
          next: nextMode,
          hasMetadata,
          selectionInside
        })
      }
      metadataModeRef.current = nextMode
      setMetadataMode(nextMode)
      metadataControlsRef.current.getMode = () => nextMode
      return nextMode
    },
    [debugLog]
  )

  useEffect(() => {
    const currentEditor = editorRef.current
    if (!currentEditor) return
    if (!initialMetadata) return
    if (initialMetadata.dismissed) return
    // If we already have metadata in the doc, don't override.
    if (hasMetadataBlock(currentEditor.state.doc)) return
    const metadataId = initialMetadata.metadataId || generateMetadataId()
    try {
      const bodyDocJson = currentEditor?.getJSON?.() ?? currentEditor.state.doc.toJSON()
      const baseDoc = {
        type: 'doc',
        content: [
          ...getTemplateContent(metadataId, initialMetadata, !initialMetadata.coverDismissed).content,
          ...(Array.isArray(bodyDocJson?.content) ? stripMetadataFromDocJSON(bodyDocJson).content : [])
        ]
      }
      currentEditor.commands.setContent(baseDoc)
      templateInsertedRef.current = true
      metadataDismissedRef.current = false
      notifyMetadataChange(currentEditor.state.doc, 'initial-metadata-apply')
      recomputeMetadataUi(currentEditor.state, 'initial-metadata-apply')
      debugLog('template:initial-restore', {
        metadataId,
        hasTitle: Boolean(initialMetadata.title),
        hasSummary: Boolean(initialMetadata.summary),
        hasImage: Boolean(initialMetadata.image)
      })
    } catch (e) {
      debugLog('template:initial-restore-error', { message: (e as Error)?.message })
    }
  }, [initialMetadata, notifyMetadataChange, recomputeMetadataUi, debugLog])

  useEffect(() => {
    const currentEditor = editorRef.current
    if (!currentEditor) return
    if (templateResetKey === undefined) return
    if (lastResetKeyRef.current === templateResetKey) return
    if (templateResetKey === 0 && lastResetKeyRef.current === undefined) {
      lastResetKeyRef.current = templateResetKey
      return
    }
    lastResetKeyRef.current = templateResetKey
    const metadataId = generateMetadataId()
    withMetadataRemovalAllowed(() => {
      templateInsertedRef.current = false
      metadataDismissedRef.current = false
      hydratedFromInitialJsonRef.current = false
      currentEditor
        .chain()
        .clearContent()
        .insertContent(getTemplateContent(metadataId))
        .command(({ tr, dispatch }) => {
          // Place the caret in the body paragraph after the metadata block.
          const end = tr.doc.content.size
          try {
            const Selection = (currentEditor.state.selection as any).constructor
            const pos = Math.max(1, end - 1)
            tr.setSelection(Selection.near(tr.doc.resolve(pos)))
          } catch {
            /* ignore */
          }
          if (dispatch) dispatch(tr)
          return true
        })
        .run()
      templateInsertedRef.current = true
      const nextMarkdown = getMarkdown(currentEditor as any)
      lastMarkdown.current = nextMarkdown
      if (nextMarkdown !== value) {
        onChange(nextMarkdown)
      }
    })
    recomputeMetadataUi(currentEditor.state, 'template-reset')
    notifyMetadataChange(currentEditor.state.doc, 'template-reset')
    debugLog('template:reset', { templateResetKey })
  }, [
    templateResetKey,
    notifyMetadataChange,
    recomputeMetadataUi,
    debugLog,
    withMetadataRemovalAllowed,
    onChange,
    value,
    getMarkdown
  ])

  const restoreCoverPlaceholder = useCallback(() => {
    const currentEditor = editorRef.current
    if (!currentEditor) return
    const coverNode = findMetadataNodeByRole(currentEditor.state.doc, 'cover')
    if (coverNode) {
      debugLog('template:cover-restore-skip', { reason: 'cover-exists' })
      return
    }
    const metadataRange = getMetadataRange(currentEditor.state.doc)
    const metadataId = metadataRange?.metadataId || generateMetadataId()
    const summaryNode = findMetadataNodeByRole(currentEditor.state.doc, 'summary')
    const titleNode = findMetadataNodeByRole(currentEditor.state.doc, 'title')
    const insertAt = summaryNode?.to ?? titleNode?.to ?? 0
    try {
      currentEditor
        .chain()
        .focus()
        .command(({ tr, dispatch }) => {
          const schema = currentEditor.state.schema
          const node = schema.nodeFromJSON({
            type: 'coverPlaceholder',
            attrs: {
              src: null,
              isTemplate: true,
              metadata: true,
              metadataId,
              metadataRole: 'cover'
            }
          })
          tr.insert(insertAt, node)
          if (dispatch) dispatch(tr)
          return true
        })
        .run()
      notifyMetadataChange(currentEditor.state.doc, 'cover-restore')
      recomputeMetadataUi(currentEditor.state, 'cover-restore')
      debugLog('template:cover-restore', { metadataId })
    } catch (e) {
      debugLog('template:cover-restore-error', { message: (e as Error)?.message })
    }
  }, [notifyMetadataChange, recomputeMetadataUi, debugLog])

  const handleClear = useCallback(() => {
    const currentEditor = editorRef.current
    if (!currentEditor) return
    debugLog('toolbar:clear')
    withMetadataRemovalAllowed(() => {
      currentEditor.commands.clearContent()
      lastMarkdown.current = ''
      hydratedFromInitialJsonRef.current = false
      templateInsertedRef.current = false
      metadataDismissedRef.current = false
    })
    onChange('')
    onBodyChange?.('')
    onJsonChange?.(null)
    recomputeMetadataUi(currentEditor.state, 'toolbar-clear')
    notifyMetadataChange(currentEditor.state.doc, 'toolbar-clear')
    onClearEditor?.()
  }, [
    onBodyChange,
    onChange,
    onClearEditor,
    onJsonChange,
    notifyMetadataChange,
    recomputeMetadataUi,
    withMetadataRemovalAllowed,
    debugLog
  ])

  const simulateArticleEvent = useCallback(async () => {
    const dismissed = metadataSnapshot?.dismissed
    const currentEditor = editorRef.current
    const bodyMarkdown = currentEditor ? getBodyMarkdown(currentEditor as any) : value
    const draft = createLongFormDraftEvent(
      {
        title: dismissed ? undefined : metadataSnapshot?.title,
        content: bodyMarkdown,
        summary: dismissed ? undefined : metadataSnapshot?.summary,
        image: dismissed ? undefined : metadataSnapshot?.image,
        identifier: metadataSnapshot?.metadataId ?? randomString(12),
        hashtags: [],
        publishedAt: Math.floor(Date.now() / 1000)
      },
      { isDraft: false }
    )
    let signed: any = null
    let error: any = null
    if (signEvent) {
      try {
        signed = await signEvent(draft)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    } else {
      error = 'signEvent unavailable (not logged in?)'
    }
    debugLog('debug:simulate-30023', {
      draft,
      signed: signed ?? null,
      error
    })
  }, [metadataSnapshot, value, signEvent, debugLog])

  const editor = useEditor({
    content: initialJsonRef.current ?? (value || ''),
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false
      }),
      metadataHeadingExtension,
      metadataBlockquoteExtension,
      metadataProtectionExtension,
      Underline.extend({
        addStorage() {
          return {
            markdown: {
              // Markdown has no native underline; serialize by keeping plain text (no markers).
              serialize: {
                open: '',
                close: '',
                mixable: true,
                expelEnclosingWhitespace: true
              },
              parse: {
                // handled by markdown-it if html is enabled; otherwise ignored
              }
            }
          }
        }
      }),
      Link.configure({
        openOnClick: true,
        autolink: true,
        linkOnPaste: true
      }),
      TaskList,
      TaskItem.configure({
        nested: false
      }),
      ImageNode.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: {
          class: 'rounded-md my-3 max-w-full'
        }
      }),
      coverPlaceholderExtension,
      MentionWithMarkdown.configure({
        suggestion: mentionSuggestion
      }),
      EmojiWithMarkdown.configure({
        suggestion: emojiSuggestion
      }),
      ClipboardAndDropHandler.configure({
        onUploadStart: (file, cancel) => {
          onUploadStart?.(file, cancel)
          debugLog('upload:start', { name: file.name, type: file.type, size: file.size })
        },
        onUploadEnd: (file) => onUploadEnd?.(file),
        onUploadProgress: (file, p) => onUploadProgress?.(file, p),
        onUploadSuccess: (file, result) => {
          const handled = insertUploadedMedia(editor, file.type, result.url)
          if (handled) {
            onUploadSuccess?.(result)
            debugLog('upload:inserted', {
              url: result.url,
              type: detectMediaType(result.url, file.type)
            })
          }
          return handled
        }
      }),
      Placeholder.configure({
        placeholder: ({ node, pos, editor }) => {
          const isParagraph = node.type.name === 'paragraph'
          if (!isParagraph) return ''
          const isMetadata = node.attrs?.metadata
          if (isMetadata) return ''
          if (isInsideMetadata(editor.state.doc, pos)) return ''
          return 'Start writing your article...'
        },
        includeChildren: false,
        showOnlyCurrent: true
      }),
      Markdown.configure({
        html: false,
        transformCopiedText: true,
        transformPastedText: true,
        breaks: true
      }),
      LinkPreviewNode,
      MediaEmbedNode,
      ParagraphHighlight
    ],
    editorProps: {
      attributes: {
        class: 'article-editor__content'
      },
      handlePaste: (view, event) => {
        const hasFiles =
          event.clipboardData?.files && Array.from(event.clipboardData.files).some((f) => f)
        if (hasFiles) {
          // Let ClipboardAndDropHandler manage file uploads.
          return false
        }
        const pastedText = event.clipboardData?.getData('text/plain') ?? ''
        if (!pastedText.trim()) {
          return false
        }

        const slice = parseMarkdownToSlice(editor, pastedText, debugLog)
        if (!slice) {
          return false
        }

        event.preventDefault()
        const tr = view.state.tr.replaceSelection(slice)
        view.dispatch(tr)
        convertStandaloneUrls(editor, debugLog)
        return true
      },
      handleKeyDown: (view, event) => {
        if (guardMetadataDeletion(view, event as KeyboardEvent)) {
          return true
        }
        const isList =
          editor?.isActive('bulletList') ||
          editor?.isActive('orderedList') ||
          editor?.isActive('taskList')
        const isTask = editor?.isActive('taskItem')
        const isCode = editor?.isActive('codeBlock')

        if (event.key === 'Tab' && (isList || isCode)) {
          if (isList) {
            // Disable list indent/outdent behavior to keep lists single-level.
            return false
          }
          event.preventDefault()
          if (event.shiftKey) {
            editor?.chain().focus().command(({ tr }) => {
              const { from, to } = tr.selection
              tr.replaceRangeWith(from, Math.min(to, from + 4), editor.state.schema.text(''))
              return true
            }).run()
          } else {
            editor?.chain().focus().insertContent('    ').run()
          }
          debugLog('keydown:tab', { shift: event.shiftKey, isList, isTask, isCode })
          return true
        }

        if (event.key === 'Backspace' && (isList || isCode)) {
          const { state } = view
          const { from } = state.selection
          const $from = state.doc.resolve(from)
          if ($from.parentOffset === 0) {
            if (isList) {
              const type = isTask ? 'taskItem' : 'listItem'
              editor?.chain().focus().liftListItem(type as any).run()
              debugLog('keydown:backspace-lift', { isTask })
              return true
            }
          }
        }
        return false
      }
    },
    onUpdate: ({ editor }) => {
      const markdown = getMarkdown(editor as any)
      const bodyMarkdown = getBodyMarkdown(editor as any)
      lastMarkdown.current = markdown
      hydratedFromInitialJsonRef.current = true
      onChange(markdown)
      onBodyChange?.(bodyMarkdown)
      onJsonChange?.(editor.getJSON())
      recomputeMetadataUi(editor.state, 'onUpdate')
      notifyMetadataChange(editor.state.doc, 'onUpdate')
      if (caretRafRef.current) cancelAnimationFrame(caretRafRef.current)
      caretRafRef.current = requestAnimationFrame(scrollCaretIntoView)
      debugLog('update', {
        markdownLength: markdown?.length ?? 0,
        bodyMarkdownLength: bodyMarkdown?.length ?? 0,
        selection: editor.state.selection?.toJSON?.()
      })
    },
    onSelectionUpdate: ({ editor }) => {
      recomputeMetadataUi(editor.state, 'selection')
      if (caretRafRef.current) cancelAnimationFrame(caretRafRef.current)
      caretRafRef.current = requestAnimationFrame(scrollCaretIntoView)
    },
    onFocus() {
      setHasFocus(true)
      recomputeMetadataUi(editor?.state, 'focus')
      debugLog('focus')
      if (caretRafRef.current) cancelAnimationFrame(caretRafRef.current)
      caretRafRef.current = requestAnimationFrame(scrollCaretIntoView)
    },
    onBlur() {
      setHasFocus(false)
      convertStandaloneUrls(editor, debugLog)
      recomputeMetadataUi(editor?.state, 'blur', { forceGroup: true })
      debugLog('blur')
    }
  })
  editorRef.current = editor

  const removeMetadataGroup = useCallback(
    (metadataId?: string | null) => {
      debugLog('metadata:group-remove-blocked', { metadataId: metadataId ?? null })
    },
    [debugLog]
  )

  useEffect(() => {
    if (!editor) return
    metadataControlsRef.current.onGroupRemove = removeMetadataGroup
  }, [editor, removeMetadataGroup])

  useEffect(() => {
    if (!editor) return
    recomputeMetadataUi(editor.state, 'init')
    notifyMetadataChange(editor.state.doc, 'init')
  }, [editor, notifyMetadataChange, recomputeMetadataUi])

  useEffect(() => {
    if (!editor) return

    if (hydratedFromInitialJsonRef.current) {
      debugLog('content:skip', { reason: 'already-hydrated', valueLength: value?.length ?? 0 })
    }

    const applyContent = (content: any, reason: string) => {
      debugLog('content:apply', {
        reason,
        hasFocus,
        shouldInsertTemplate: Boolean(shouldInsertTemplate),
        templateInserted: templateInsertedRef.current,
        valueLength: value?.length ?? 0,
        lastMarkdownLength: lastMarkdown.current?.length ?? 0,
        initialJsonProvided: Boolean(initialJson),
        initialJsonMatchesRef: initialJson === initialJsonRef.current,
        contentSummary: summarizeContent(content),
        contentEmpty: isContentEmpty(content)
      })
      const run = () => {
        if (!editor) return
        const cleaned = sanitizeContent(content)
        try {
          editor.commands.setContent(cleaned ?? '')
        } catch (e) {
          debugLog('content:set-error', { reason, message: (e as Error)?.message })
          const metadataId = generateMetadataId()
          editor
            .chain()
            .clearContent()
            .insertContent(getTemplateContent(metadataId))
            .run()
          templateInsertedRef.current = true
        }
        recomputeMetadataUi(editor.state, `after-apply:${reason}`)
        notifyMetadataChange(editor.state.doc, `after-apply:${reason}`)
      }
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(run)
      } else {
        Promise.resolve().then(run)
      }
    }

    const initialJsonProvided = !isContentEmpty(initialJson)

    // Insert default template when empty and requested
    if (shouldInsertTemplate && !templateInsertedRef.current) {
      const currentText = editor.state.doc.textContent?.trim() ?? ''
      const isDocTriviallyEmpty = !currentText && editor.state.doc.childCount <= 1
      if (isDocTriviallyEmpty) {
        if (metadataDismissedRef.current) {
          debugLog('template:ready', {
            reason: 'reset-dismissed',
            dismissedRef: metadataDismissedRef.current
          })
          metadataDismissedRef.current = false
        }
        debugLog('template:force', {
          currentText,
          childCount: editor.state.doc.childCount,
          shouldInsertTemplate,
          dismissedRef: metadataDismissedRef.current
        })
        const metadataId = generateMetadataId()
        editor
          .chain()
          .clearContent()
          .insertContent(getTemplateContent(metadataId))
          .command(({ tr, dispatch }) => {
            // Place the caret in the body paragraph after the metadata block.
            const end = tr.doc.content.size
            try {
              const Selection = (editor.state.selection as any).constructor
              const pos = Math.max(1, end - 1)
              tr.setSelection(Selection.near(tr.doc.resolve(pos)))
            } catch {
              /* ignore */
            }
            if (dispatch) dispatch(tr)
            return true
          })
          .run()
        templateInsertedRef.current = true
        metadataDismissedRef.current = false
        const nextMarkdown = getMarkdown(editor as any)
        lastMarkdown.current = nextMarkdown
        if (nextMarkdown !== value) {
          onChange(nextMarkdown)
        }
        notifyMetadataChange(editor.state.doc, 'template-inserted')
        return
      }

      debugLog('template:check', {
        currentText,
        childCount: editor.state.doc.childCount,
        valueLength: value?.length ?? 0,
        lastMarkdownLength: lastMarkdown.current?.length ?? 0,
        initialJsonProvided: Boolean(initialJson)
      })
      if (!currentText && editor.state.doc.childCount <= 1) {
        debugLog('template:insert')
        const metadataId = generateMetadataId()
        editor
          .chain()
          .clearContent()
          .insertContent(getTemplateContent(metadataId))
          .command(({ tr, dispatch }) => {
            // Place the caret in the body paragraph after the metadata block.
            const end = tr.doc.content.size
            try {
              const Selection = (editor.state.selection as any).constructor
              const pos = Math.max(1, end - 1)
              tr.setSelection(Selection.near(tr.doc.resolve(pos)))
            } catch {
              /* ignore */
            }
            if (dispatch) dispatch(tr)
            return true
          })
          .run()
        templateInsertedRef.current = true
        metadataDismissedRef.current = false
        const nextMarkdown = getMarkdown(editor as any)
        lastMarkdown.current = nextMarkdown
        if (nextMarkdown !== value) {
          onChange(nextMarkdown)
        }
        notifyMetadataChange(editor.state.doc, 'template-inserted')
        return
      }
    }

    // Avoid resetting content while user is actively editing; only sync when not focused.
    if (hasFocus) {
      debugLog('content:skip', { reason: 'has-focus', valueLength: value?.length ?? 0 })
      return
    }

    // If the incoming value matches last known markdown, no-op to avoid overwriting template/custom nodes.
    if (value === lastMarkdown.current) {
      debugLog('content:skip', { reason: 'value-matches-last' })
      return
    }

    // If a template was inserted, wait for upstream state to catch up before applying stale content.
    if (
      shouldInsertTemplate &&
      templateInsertedRef.current &&
      value !== lastMarkdown.current &&
      !initialJson
    ) {
      debugLog('content:skip', {
        reason: 'template-awaiting-sync',
        valueLength: value?.length ?? 0,
        lastMarkdownLength: lastMarkdown.current?.length ?? 0
      })
      return
    }

    const initialJsonEmpty = isContentEmpty(initialJson)

    if (templateInsertedRef.current && (initialJsonEmpty || !initialJsonProvided)) {
      debugLog('content:skip', {
        reason: 'initial-json-empty-after-template',
        initialJsonProvided,
        initialJsonMatchesRef: initialJson === initialJsonRef.current,
        initialJsonSummary: summarizeContent(initialJson)
      })
    } else if (
      initialJsonProvided &&
      !hydratedFromInitialJsonRef.current &&
      initialJson !== initialJsonRef.current
    ) {
      initialJsonRef.current = initialJson
      hydratedFromInitialJsonRef.current = true
      applyContent(initialJson, 'initial-json')
      lastMarkdown.current = getMarkdown(editor as any)
      return
    }

    if (hydratedFromInitialJsonRef.current) {
      debugLog('content:skip', { reason: 'already-hydrated-post-json' })
      return
    }

    if (value === lastMarkdown.current) {
      debugLog('content:skip', { reason: 'value-matches-last-after-json' })
      return
    }

    if (templateInsertedRef.current && isContentEmpty(value)) {
      debugLog('content:skip', {
        reason: 'value-empty-after-template',
        valueLength: value?.length ?? 0
      })
    } else {
      applyContent(value || '', 'value-change')
      lastMarkdown.current = value
    }
  }, [
    value,
    initialJson,
    editor,
    getMarkdown,
    hasFocus,
    shouldInsertTemplate,
    debugLog,
    notifyMetadataChange
  ])

  useEffect(() => {
    const el = toolbarScrollRef.current
    if (!el) return
    updateScrollShadows()
    const handler = () => updateScrollShadows()
    el.addEventListener('scroll', handler, { passive: true })
    return () => {
      el.removeEventListener('scroll', handler)
    }
  }, [updateScrollShadows, isTouchSmallScreen, isFabOpen])

  useEffect(() => {
    if (!isFabOpen) return
    requestAnimationFrame(() => updateScrollShadows())
  }, [isFabOpen, updateScrollShadows])

  useEffect(() => {
    if (!isTouchSmallScreen || typeof window === 'undefined') {
      return
    }
    const vv = window.visualViewport
    const update = () => {
      const vpH = vv?.height ?? window.innerHeight
      const offset = Math.max(0, window.innerHeight - vpH - (vv?.offsetTop ?? 0))
      setKeyboardOffset(offset)
      const baseline = baselineViewportHeight.current
      if (
        baseline === null ||
        (!keyboardOpenRef.current && vpH > baseline - 16) ||
        (!keyboardOpenRef.current && Math.abs(vpH - baseline) > 200)
      ) {
        baselineViewportHeight.current = vpH
      }

      const deltaFromBaseline = (baselineViewportHeight.current ?? vpH) - vpH
      const keyboardLikelyOpen = deltaFromBaseline > 110 || offset > 40
      keyboardOpenRef.current = keyboardLikelyOpen
      setKeyboardOpen(keyboardLikelyOpen)
      if (!keyboardLikelyOpen) {
        setIsFabOpen(false)
      }
    }
    update()
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [isTouchSmallScreen])

  const floatingToolbarVisible = useMemo(() => {
    if (!isTouchSmallScreen) return false
    if (typeof window !== 'undefined' && typeof window.visualViewport === 'undefined') {
      return hasFocus
    }
    return keyboardOpen
  }, [isTouchSmallScreen, keyboardOpen, hasFocus])

  useEffect(() => {
    if (!isTouchSmallScreen) return
    if (hasFocus) {
      setIsFabOpen(true)
    }
  }, [isTouchSmallScreen, hasFocus])

  const emojiEnabled = useMemo(
    () => !isTouchInput && !isTouchSmallScreen,
    [isTouchInput, isTouchSmallScreen]
  )

  useEffect(() => {
    debugLog('emoji:availability', { enabled: emojiEnabled, isTouchInput, isTouchSmallScreen })
  }, [emojiEnabled, isTouchInput, isTouchSmallScreen, debugLog])

  const editorContentClass = useMemo(
    () =>
      cn(
        'article-prose tiptap prose prose-zinc dark:prose-invert max-w-none break-words overflow-wrap-anywhere min-h-[290px] w-full',
        isTouchSmallScreen
          ? 'max-h-[45vh] sm:max-h-none overflow-y-auto overflow-x-hidden'
          : 'max-h-none overflow-visible'
      ),
    [isTouchSmallScreen]
  )

  if (!editor) return null

  const toolbarBody = (
    <>
      <ToolbarGroup>
        <ToolbarButton
          icon={Undo}
          label="Undo"
          onClick={() => {
            debugLog('toolbar:undo')
            editor.chain().focus().undo().run()
          }}
          disabled={!editor.can().undo()}
          isFirst
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <ToolbarButton
          icon={Redo}
          label="Redo"
          onClick={() => {
            debugLog('toolbar:redo')
            editor.chain().focus().redo().run()
          }}
          disabled={!editor.can().redo()}
          isLast
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
      </ToolbarGroup>
      <ToolbarDivider />
      <ToolbarGroup>
        {!isTouchSmallScreen ? (
          <HeadingMenu
            editor={editor}
            shouldIgnoreTap={() => skipToolbarTapRef.current}
            debugLog={debugLog}
          />
        ) : (
          <HeadingButtonsMobile editor={editor} debugLog={debugLog} />
        )}
        <ToolbarButton
          icon={Bold}
          label="Bold"
          onClick={() => {
            debugLog('toolbar:bold')
            editor.chain().focus().toggleBold().run()
          }}
          active={editor.isActive('bold')}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <ToolbarButton
          icon={Italic}
          label="Italic"
          onClick={() => {
            debugLog('toolbar:italic')
            editor.chain().focus().toggleItalic().run()
          }}
          active={editor.isActive('italic')}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <ToolbarButton
          icon={UnderlineIcon}
          label="Underline"
          onClick={() => {
            debugLog('toolbar:underline')
            editor.chain().focus().toggleUnderline().run()
          }}
          active={editor.isActive('underline')}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <ToolbarButton
          icon={Code}
          label="Inline code"
          onClick={() => {
            debugLog('toolbar:inline-code')
            editor.chain().focus().toggleCode().run()
          }}
          active={editor.isActive('code')}
          isLast
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
      </ToolbarGroup>
      <ToolbarDivider />
      <ToolbarGroup>
        <ToolbarButton
          icon={LinkIcon}
          label="Insert link"
          onClick={() => {
            const previousUrl = editor.getAttributes('link').href as string | undefined
            setLinkUrl(previousUrl || 'https://')
            const { from, to } = editor.state.selection
            linkSelectionRef.current = { from, to }
            const selectionText = editor.state.doc.textBetween(
              editor.state.selection.from,
              editor.state.selection.to,
              ' '
            )
            setLinkText(selectionText || '')
            debugLog('toolbar:link-open', { previousUrl, selectionText })
            setLinkDialogOpen(true)
          }}
          active={editor.isActive('link')}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <Uploader
          onUploadStart={onUploadStart}
          onUploadEnd={onUploadEnd}
          onProgress={onUploadProgress}
          onUploadSuccess={({ url, tags }) => {
            onUploadSuccess?.({ url, tags })
            const type = detectMediaType(url)
            if (type === 'image') {
              editor.chain().focus().setImage({ src: url, alt: '' }).run()
            } else if (type === 'video') {
              editor
                .chain()
                .focus()
                .insertContent({ type: 'mediaEmbed', attrs: { src: url, mediaType: 'video' } })
                .run()
            } else {
              editor.chain().focus().insertContent(url).run()
            }
            debugLog('toolbar:upload-insert', { url, type })
          }}
          accept="image/*,video/*,audio/*"
          onPickerOpen={() => {
            debugLog('toolbar:upload-picker-open', { source: 'article-toolbar' })
            setIsFabOpen(false)
          }}
        >
          <ToolbarButton
            icon={ImageIcon}
            label="Upload media"
            onClick={() => {
              debugLog('toolbar:upload-trigger', { source: 'article-toolbar' })
            }}
            shouldIgnoreTap={() => skipToolbarTapRef.current}
            allowEventPropagation
          />
        </Uploader>
        {emojiEnabled && (
          <EmojiPickerDialog
            onOpenChange={(open, surface) =>
              debugLog('emoji:toggle', { open, surface, source: 'article-toolbar' })
            }
            onEmojiClick={(emoji) => {
              onEmojiSelect?.(emoji)
              if (!emoji) return
              editor
                .chain()
                .focus()
                .insertContent(typeof emoji === 'string' ? emoji : `:${emoji.shortcode}:`)
                .run()
              debugLog('toolbar:emoji-insert', {
                emoji: typeof emoji === 'string' ? emoji : emoji?.shortcode
              })
            }}
          >
            <ToolbarButton
              icon={Smile}
              label="Emoji"
              onClick={() => {
                debugLog('toolbar:emoji-trigger', { source: 'article-toolbar' })
              }}
              onPointerDown={(e) => {
                debugLog('toolbar:emoji-pointer', {
                  source: 'article-toolbar',
                  button: e.button,
                  type: e.pointerType
                })
              }}
              shouldIgnoreTap={() => skipToolbarTapRef.current}
              allowEventPropagation
            />
          </EmojiPickerDialog>
        )}
        <ToolbarButton
          icon={Minus}
          label="Horizontal rule"
          onClick={() => {
            debugLog('toolbar:hr')
            editor.chain().focus().setHorizontalRule().run()
          }}
          isLast
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
      </ToolbarGroup>
      <ToolbarDivider />
      <ToolbarGroup>
        <ToolbarButton
          icon={LayoutTemplate}
          label="Add cover"
          onClick={() => {
            debugLog('toolbar:add-cover')
            restoreCoverPlaceholder()
          }}
          isFirst
          disabled={Boolean(findMetadataNodeByRole(editor.state.doc, 'cover'))}
          withText={!isTouchSmallScreen}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <ToolbarButton
          icon={Trash2}
          label="Clear"
          onClick={handleClear}
          isLast
          withText={!isTouchSmallScreen}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
      </ToolbarGroup>
      <ToolbarDivider />
      <ToolbarGroup>
        <ToolbarButton
          icon={List}
          label="Bullet list"
          onClick={() => {
            debugLog('toolbar:bullet-list')
            editor.chain().focus().toggleBulletList().run()
          }}
          active={editor.isActive('bulletList')}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <ToolbarButton
          icon={ListOrdered}
          label="Numbered list"
          onClick={() => {
            debugLog('toolbar:ordered-list')
            editor.chain().focus().toggleOrderedList().run()
          }}
          active={editor.isActive('orderedList')}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <ToolbarButton
          icon={Quote}
          label="Blockquote"
          onClick={() => {
            debugLog('toolbar:blockquote')
            editor.chain().focus().toggleBlockquote().run()
          }}
          active={editor.isActive('blockquote')}
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
        <ToolbarButton
          icon={CodeXml}
          label="Code block"
          onClick={() => {
            debugLog('toolbar:code-block')
            editor.chain().focus().toggleCodeBlock().run()
          }}
          active={editor.isActive('codeBlock')}
          isLast
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
      </ToolbarGroup>
      <ToolbarDivider />
      <ToolbarGroup>
        <ToolbarButton
          icon={Save}
          label="Save Draft"
          onClick={() => {
            debugLog('toolbar:save-draft')
            onSaveDraft?.()
          }}
          isFirst
          isLast
          shouldIgnoreTap={() => skipToolbarTapRef.current}
        />
      </ToolbarGroup>
      {mentions && setMentions && (
        <>
          <ToolbarDivider />
          <ToolbarGroup>
            <Mentions content={value} mentions={mentions} setMentions={setMentions} />
          </ToolbarGroup>
        </>
      )}
    </>
  )

  const toolbarElement = useMemo(
    () => (
      <div
        className="article-toolbar flex flex-wrap items-center gap-2 bg-background border-b border-border shadow-sm px-2 py-1"
        style={{ top: 'var(--post-editor-header-height, 0px)' }}
      >
        {toolbarBody}
      </div>
    ),
    [toolbarBody]
  )

  useEffect(() => {
    if (!isTouchSmallScreen && renderToolbar) {
      renderToolbar(toolbarElement)
    }
  }, [isTouchSmallScreen, renderToolbar, toolbarElement])

  return (
    <div className="article-editor space-y-2">
      <LinkDialog
        open={linkDialogOpen}
        setOpen={setLinkDialogOpen}
        url={linkUrl}
        setUrl={setLinkUrl}
          text={linkText}
          setText={setLinkText}
        onSubmit={(url, text) => {
          const trimmed = url.trim()
          if (!trimmed) {
            editor.chain().focus().unsetLink().run()
            debugLog('link:unset')
            return
          }
          editor.commands.focus()
          const { state } = editor
          const stored = linkSelectionRef.current
          const from = stored?.from ?? state.selection.from
          const to = stored?.to ?? state.selection.to
          const hasText = Boolean(text)
          const insertText = hasText
            ? text!
            : state.doc.textBetween(from, to, ' ') || trimmed

          editor.chain().command(({ tr, dispatch }) => {
            // Replace selection (or caret) with text
            tr.insertText(insertText, from, to)
            const start = from
            const end = from + insertText.length
            tr.setSelection((state.selection as any).constructor.create(tr.doc, start, end))
            tr.addMark(start, end, state.schema.marks.link.create({ href: trimmed }))
            if (dispatch) {
              dispatch(tr.scrollIntoView())
            }
            return true
          }).run()

          debugLog('link:apply', { url: trimmed, text: insertText })
          linkSelectionRef.current = null
          }}
        />
      {!isTouchSmallScreen && !renderToolbar && (
        <div
          className="article-toolbar flex flex-wrap items-center gap-2 sticky z-30 bg-background border-b border-border shadow-sm px-2 py-1"
          style={{ top: 'var(--post-editor-header-height, 0px)' }}
        >
          {toolbarBody}
        </div>
      )}
      {floatingToolbarVisible &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed z-[80] pointer-events-none"
            style={{
              top: Math.max(10, (typeof window !== 'undefined' ? window.visualViewport?.offsetTop ?? 0 : 0) + 10),
              right: 14,
              paddingTop: 'env(safe-area-inset-top, 0px)'
            }}
          >
            <div className="relative inline-flex items-center gap-2 pointer-events-auto translate-y-1">
              <div className="relative">
                <div
                  className={`flex items-center gap-1 overflow-x-auto whitespace-nowrap bg-background border border-border px-2 py-2 rounded-md shadow-lg transition-all duration-200 ease-out origin-bottom-right touch-pan-x ${
                    isFabOpen
                      ? 'opacity-100 translate-x-0'
                      : 'opacity-0 translate-x-4 pointer-events-none'
                  }`}
                  style={{
                    maxWidth: 'calc(100vw - 72px)',
                    width: 'calc(100vw - 72px)',
                    WebkitOverflowScrolling: 'touch',
                    touchAction: 'pan-x'
                  }}
                  ref={toolbarScrollRef}
                  onTouchStart={(e) => {
                    if (!toolbarScrollRef.current) return
                    if (inertiaFrameRef.current) {
                      cancelAnimationFrame(inertiaFrameRef.current)
                      inertiaFrameRef.current = null
                    }
                    const touch = e.touches[0]
                    toolbarDragRef.current = {
                      startX: touch.clientX,
                      startScrollLeft: toolbarScrollRef.current.scrollLeft,
                      moved: false
                    }
                    prevTouchRef.current = null
                    lastTouchRef.current = { x: touch.clientX, t: performance.now() }
                    skipToolbarTapRef.current = false
                  }}
                  onTouchMove={(e) => {
                    if (!toolbarScrollRef.current || !toolbarDragRef.current) return
                    const touch = e.touches[0]
                    const deltaX = touch.clientX - toolbarDragRef.current.startX
                    if (Math.abs(deltaX) > 2) {
                      toolbarDragRef.current.moved = true
                      skipToolbarTapRef.current = true
                    }
                    const next = toolbarDragRef.current.startScrollLeft - deltaX
                    toolbarScrollRef.current.scrollLeft = next
                    updateScrollShadows()
                    prevTouchRef.current = lastTouchRef.current
                    lastTouchRef.current = { x: touch.clientX, t: performance.now() }
                    if (toolbarDragRef.current.moved) {
                      e.preventDefault()
                    }
                  }}
                  onTouchEnd={() => {
                    const el = toolbarScrollRef.current
                    const last = lastTouchRef.current
                    const prev = prevTouchRef.current
                    toolbarDragRef.current = null
                    if (el && last && prev) {
                      const dt = Math.max(1, last.t - prev.t)
                      const velocityPxPerMs = (last.x - prev.x) / dt
                      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth)
                      let v = velocityPxPerMs
                      const friction = 0.94
                      const bounce = 0.55

                      const step = () => {
                        if (!el) return
                        const next = el.scrollLeft - v * 16
                        el.scrollLeft = Math.min(maxScroll + 32, Math.max(-32, next))
                        updateScrollShadows()
                        const atBoundary = el.scrollLeft < 0 || el.scrollLeft > maxScroll
                        v *= friction * (atBoundary ? bounce : 1)
                        if (Math.abs(v) < 0.05) {
                          if (el.scrollLeft < 0) el.scrollTo({ left: 0, behavior: 'smooth' })
                          if (el.scrollLeft > maxScroll) el.scrollTo({ left: maxScroll, behavior: 'smooth' })
                          inertiaFrameRef.current = null
                          return
                        }
                        inertiaFrameRef.current = requestAnimationFrame(step)
                      }
                      inertiaFrameRef.current = requestAnimationFrame(step)
                    }
                    requestAnimationFrame(() => {
                      skipToolbarTapRef.current = false
                    })
                  }}
                >
                  {toolbarBody}
                </div>
                <div
                  className={`pointer-events-none absolute inset-y-1 left-0 w-6 rounded-l-md bg-gradient-to-r from-background to-transparent transition-opacity duration-150 ${
                    scrollShadows.left && isFabOpen ? 'opacity-70' : 'opacity-0'
                  }`}
                />
                <div
                  className={`pointer-events-none absolute inset-y-1 right-0 w-6 rounded-r-md bg-gradient-to-l from-background to-transparent transition-opacity duration-150 ${
                    scrollShadows.right && isFabOpen ? 'opacity-70' : 'opacity-0'
                  }`}
                />
              </div>
              <Button
                size="icon"
                variant="default"
                className="shadow-lg rounded-md h-11 w-11"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={() => {
                  setIsFabOpen((open: boolean) => !open)
                  editor?.commands.focus()
                }}
              >
                {isFabOpen ? <SquareX className="h-8 w-8" /> : <SquarePlus className="h-8 w-8" />}
              </Button>
            </div>
          </div>,
          document.body
        )}
      <EditorContent
        editor={editor}
        data-metadata-mode={metadataMode}
        className={editorContentClass}
      />
      <DebugConsole
        enabled={debugEnabled}
        setEnabled={setDebugEnabled}
        open={debugPanelOpen}
        setOpen={setDebugPanelOpen}
        entries={debugEntries}
        onClear={() => setDebugEntries([])}
        onSimulateEvent={simulateArticleEvent}
      />
    </div>
  )
}

function HeadingMenu({
  editor,
  shouldIgnoreTap,
  debugLog
}: {
  editor: NonNullable<ReturnType<typeof useEditor>>
  shouldIgnoreTap: () => boolean
  debugLog: (message: string, data?: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const pointerToggledRef = useRef(false)
  const isHeadingActive = (level: Level) => editor.isActive('heading', { level })

  useEffect(() => {
    debugLog('heading-menu:open', { open })
  }, [debugLog, open])

  const handleParagraph = () => {
    debugLog('heading-menu:select', { selection: 'paragraph' })
    editor.chain().focus().setParagraph().run()
  }

  const handleHeading = (lvl: Level) => {
    debugLog('heading-menu:select', {
      selection: `heading-${lvl}`,
      wasActive: isHeadingActive(lvl)
    })
    editor.chain().focus().toggleHeading({ level: lvl }).run()
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        pointerToggledRef.current = false
        debugLog('heading-menu:open-change', { next, source: 'radix' })
        setOpen(next)
      }}
    >
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          icon={Type}
          label="Type"
          active={
            isHeadingActive(1) ||
            isHeadingActive(2) ||
            isHeadingActive(3) ||
            isHeadingActive(4)
          }
          isFirst
          shouldIgnoreTap={shouldIgnoreTap}
          onClick={() => {
            if (pointerToggledRef.current) {
              pointerToggledRef.current = false
              debugLog('heading-menu:click-skip', { reason: 'pointer-already-toggled' })
              return
            }
            debugLog('heading-menu:trigger')
            setOpen((prev) => {
              const next = !prev
              debugLog('heading-menu:toggle', { next, reason: 'click' })
              return next
            })
            editor.chain().focus().run()
          }}
          onPointerDown={(e) => {
            // Ensure Radix sees a pointer event and we also toggle for safety.
            debugLog('heading-menu:pointer', { button: e.button, type: e.pointerType })
            pointerToggledRef.current = true
            setOpen((prev) => {
              const next = !prev
              debugLog('heading-menu:toggle', { next, reason: 'pointer' })
              return next
            })
          }}
          allowEventPropagation
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48">
        <DropdownMenuItem onSelect={handleParagraph}>Paragraph</DropdownMenuItem>
        {[1, 2, 3, 4].map((lvl) => (
          <DropdownMenuItem key={lvl} onSelect={() => handleHeading(lvl as Level)}>
            {`Heading ${lvl}`}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HeadingButtonsMobile({
  editor,
  debugLog
}: {
  editor: NonNullable<ReturnType<typeof useEditor>>
  debugLog: (message: string, data?: unknown) => void
}) {
  const makeHeading = (
    level: Level,
    Icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>,
    className: string,
    strokeWidth: number
  ) => (
    <ToolbarButton
      key={level}
      icon={(props) => <Icon className={cn(props.className, className)} strokeWidth={strokeWidth} />}
      label={`H${level}`}
      onClick={() => {
        debugLog('heading:mobile', { level })
        editor.chain().focus().toggleHeading({ level }).run()
      }}
      active={editor.isActive('heading', { level })}
      allowEventPropagation
    />
  )

  return (
    <>
      {makeHeading(1 as Level, Heading1, 'h-5 w-5', 2.2)}
      {makeHeading(2 as Level, Heading2, 'h-5 w-5', 2)}
      {makeHeading(3 as Level, Heading3, 'h-4 w-4', 2)}
      {makeHeading(4 as Level, Heading4, 'h-4 w-4', 1.8)}
    </>
  )
}

function ToolbarGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center rounded-md border border-input overflow-hidden shrink-0">
      {children}
    </div>
  )
}

function ToolbarDivider() {
  return <Separator orientation="vertical" className="h-8" />
}

const ToolbarButton = React.forwardRef<
  HTMLButtonElement,
  {
    icon: React.ComponentType<{ className?: string; strokeWidth?: number | string }>
    label: string
    onClick: () => void
    active?: boolean
    disabled?: boolean
    isFirst?: boolean
    isLast?: boolean
    withText?: boolean
    shouldIgnoreTap?: () => boolean
    allowEventPropagation?: boolean
    onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void
  }
>(({ icon: Icon, label, onClick, active, disabled, isFirst, isLast, withText, shouldIgnoreTap, allowEventPropagation, onPointerDown }, ref) => {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      data-active={active ? 'true' : undefined}
      className={cn(
        'toolbar-button h-8 px-1.5 min-w-[38px] shadow-none border-r border-input rounded-none hover:bg-accent hover:text-accent-foreground shrink-0',
        isFirst && 'rounded-l-md',
        isLast && 'rounded-r-md border-r-0'
      )}
      onPointerDown={onPointerDown}
      onMouseDown={(e) => {
        if (!allowEventPropagation) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
      onClick={(e) => {
        if (!allowEventPropagation) {
          e.stopPropagation()
        }
        if (shouldIgnoreTap?.()) return
        if (isTouchDevice() && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate?.(50)
        }
        ;(ref as any)?.current?.focus?.()
        onClick()
      }}
    >
      <Icon className="h-4 w-4" />
      {withText && <span className="ml-1 text-sm">{label}</span>}
    </Button>
  )
})
ToolbarButton.displayName = 'ToolbarButton'

const LinkPreviewNode = Node.create({
  name: 'linkPreview',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      url: { default: '' }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-link-preview]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-link-preview': 'true' }]
  },
  addNodeView() {
    return ReactNodeViewRenderer(LinkPreviewView)
  },
  addStorage() {
    return {
      markdown: {
        serialize: (state: any, node: any) => {
          state.ensureNewLine()
          state.write((node.attrs.url as string) ?? '')
          state.closeBlock(node)
        }
      }
    }
  }
})

const MediaEmbedNode = Node.create({
  name: 'mediaEmbed',
  priority: 1000,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: '' },
      mediaType: { default: 'video' }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-media-embed]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-media-embed': 'true' }]
  },
  addNodeView() {
    return ReactNodeViewRenderer(MediaEmbedView)
  },
  addStorage() {
    return {
      markdown: {
        serialize: (state: any, node: any) => {
          state.ensureNewLine()
          state.write((node.attrs.src as string) ?? '')
          state.closeBlock(node)
        }
      }
    }
  }
})

const ParagraphHighlight = Node.create({
  name: 'paragraphHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const { selection, doc } = state
            const { from } = selection
            const decorations: Decoration[] = []
            let found = false

            doc.nodesBetween(from, from, (node, pos) => {
              if (node.type.name === 'paragraph') {
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, { class: 'pm-current-paragraph' })
                )
                found = true
                return false
              }
              return
            })

            return found ? DecorationSet.create(doc, decorations) : null
          }
        }
      })
    ]
  }
})

function createMetadataHeadingExtension(controlsRef: React.MutableRefObject<MetadataControls>) {
  return Heading.extend({
    addOptions() {
      return {
        ...this.parent?.(),
        selectable: false,
        isolating: true,
        defining: true,
        levels: [1, 2, 3, 4] as Level[]
      }
    },
    addAttributes() {
      return {
        ...(this.parent?.() ?? {}),
        metadata: { default: false },
        metadataId: { default: null },
        metadataRole: { default: null },
        isPlaceholder: { default: false }
      }
    },
    addNodeView() {
      const renderer = ReactNodeViewRenderer((props) => (
        <MetadataHeadingView {...props} controlsRef={controlsRef} />
      ))
      const parentRenderer = this.parent?.()
      return ((props: any) => {
        if (props.node?.attrs?.metadata) {
          return renderer(props)
        }
        return parentRenderer ? parentRenderer(props) : null
      }) as any
    }
  })
}

function createMetadataBlockquoteExtension(
  controlsRef: React.MutableRefObject<MetadataControls>
) {
  return Blockquote.extend({
    addOptions() {
      return {
        ...this.parent?.(),
        selectable: false,
        isolating: true,
        defining: true
      }
    },
    addAttributes() {
      return {
        ...(this.parent?.() ?? {}),
        metadata: { default: false },
        metadataId: { default: null },
        metadataRole: { default: null },
        isPlaceholder: { default: false }
      }
    },
    addNodeView() {
      const renderer = ReactNodeViewRenderer((props) => (
        <MetadataSummaryView {...props} controlsRef={controlsRef} />
      ))
      const parentRenderer = this.parent?.()
      return ((props: any) => {
        if (props.node?.attrs?.metadata) {
          return renderer(props)
        }
        return parentRenderer ? parentRenderer(props) : null
      }) as any
    }
  })
}

function createCoverPlaceholderNode(controlsRef: React.MutableRefObject<MetadataControls>) {
  return Node.create({
    name: 'coverPlaceholder',
    group: 'block',
    atom: true,
    draggable: false,
    selectable: true,
    addAttributes() {
      return {
        src: { default: null },
        isTemplate: { default: true },
        metadata: { default: false },
        metadataId: { default: null },
        metadataRole: { default: null }
      }
    },
    parseHTML() {
      return [{ tag: 'div[data-cover-placeholder]' }]
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', { ...HTMLAttributes, 'data-cover-placeholder': 'true' }]
    },
    addNodeView() {
      return ReactNodeViewRenderer((props) => (
        <CoverPlaceholderView {...props} controlsRef={controlsRef} />
      ))
    },
    addStorage() {
      return {
        markdown: {
          serialize: (state: any, node: any) => {
            state.ensureNewLine()
            const src = node.attrs.src as string | null
            if (src) state.write(src)
            state.closeBlock(node)
          }
        }
      }
    }
  })
}

const ImageNode = ImageExtension.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  }
})

function ImageView({ node, getPos, editor, deleteNode }: any) {
  const src = node?.attrs?.src as string
  const alt = node?.attrs?.alt as string
  const title = node?.attrs?.title as string
  const imgClass = 'rounded-md my-3 max-w-full'

  return (
    <NodeViewWrapper
      as="div"
      className="my-3"
      data-image-node
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation()
        if (typeof getPos === 'function') {
          editor?.commands.setNodeSelection(getPos())
        }
      }}
    >
      <div className="flex justify-end">
        <button
          type="button"
          className="text-muted-foreground text-xs px-2 py-1 hover:text-foreground"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation()
            deleteNode?.()
          }}
        >
          ×
        </button>
      </div>
      <img src={src} alt={alt} title={title} className={imgClass} />
    </NodeViewWrapper>
  )
}

function LinkDialog({
  open,
  setOpen,
  url,
  setUrl,
  text,
  setText,
  onSubmit
}: {
  open: boolean
  setOpen: (v: boolean) => void
  url: string
  setUrl: (v: string) => void
  text: string
  setText: (v: string) => void
  onSubmit: (url: string, text: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Insert link</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="link-url">URL</Label>
            <Input
              id="link-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="link-text">Text (optional)</Label>
            <Input
              id="link-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Link title"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              onSubmit(url, text)
              setOpen(false)
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function convertStandaloneUrls(editor: any, debugLog?: (msg: string, data?: unknown) => void) {
  const urlRegex = /^(https?:\/\/\S+)$/
  const { state } = editor
  let tr = state.tr
  let changed = false
  const initialSelection = state.selection
  state.doc.descendants((node: any, pos: number) => {
    if (node.type.name !== 'paragraph') return true
    const text = node.textContent.trim()
    if (!text || node.childCount !== 1 || !node.firstChild?.isText) return true
    const match = urlRegex.exec(text)
    if (!match) return true
    const url = match[1]
    const linkPreview = state.schema.nodes.linkPreview?.create({ url })
    if (linkPreview) {
      tr = tr.replaceWith(pos, pos + node.nodeSize, linkPreview)
      changed = true
      debugLog?.('convert:url->preview', { url })
      return false
    }
    return true
  })
  if (changed) {
    // Preserve selection near the original position to avoid jumps.
    const mappedFrom = tr.mapping.map(initialSelection.from)
    const mappedTo = tr.mapping.map(initialSelection.to)
    const safePos = Math.min(tr.doc.content.size, Math.max(0, mappedFrom))
    try {
      tr = tr.setSelection(editor.state.selection.constructor.create(tr.doc, safePos, mappedTo))
    } catch (_e) {
      try {
        tr = tr.setSelection(editor.state.selection.constructor.near(tr.doc.resolve(safePos)))
      } catch {
        /* ignore */
      }
    }
    editor.view.dispatch(tr)
  }
}

function getTemplateContent(metadataId: string, values?: Partial<MetadataSnapshot>, includeCover = true) {
  const titleContent =
    values?.title && values.title.length
      ? [
          {
            type: 'text',
            text: values.title
          }
        ]
      : []

  const summaryContent =
    values?.summary && values.summary.length
      ? [
          {
            type: 'text',
            text: values.summary
          }
        ]
      : []

  const coverNode = includeCover
    ? [
        {
          type: 'coverPlaceholder',
          attrs: {
            src: values?.image ?? null,
            isTemplate: true,
            metadata: true,
            metadataId,
            metadataRole: 'cover'
          }
        }
      ]
    : []
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: {
          level: 1,
          metadata: true,
          metadataId,
          metadataRole: 'title',
          isPlaceholder: !values?.title
        },
        content: titleContent
      },
      {
        type: 'blockquote',
        attrs: {
          metadata: true,
          metadataId,
          metadataRole: 'summary',
          isPlaceholder: !values?.summary
        },
        content: [
          {
            type: 'heading',
            attrs: {
              level: 4
            },
            content: summaryContent
          }
        ]
      },
      ...coverNode,
      {
        type: 'paragraph',
        attrs: { metadata: false },
        content: []
      }
    ]
  }
}

function parseMarkdownToSlice(editor: any, text: string, debugLog?: (msg: string, data?: unknown) => void) {
  if (!text?.length) return null
  const parser = (editor as any)?.storage?.markdown?.parser
  if (!parser) return null
  try {
    const html = parser.parse(text)
    if (!html || typeof document === 'undefined') return null
    const container = document.createElement('div')
    container.innerHTML = html
    return PMDOMParser.fromSchema(editor.schema).parseSlice(container, {
      preserveWhitespace: true
    })
  } catch (error) {
    debugLog?.('paste:parse-error', { message: (error as Error)?.message })
    return null
  }
}

function insertUploadedMedia(editor: any, mimeType: string, url: string) {
  const mediaType = detectMediaType(url, mimeType)
  if (mediaType === 'image') {
    editor.chain().focus().setImage({ src: url, alt: '' }).run()
    return true
  }
  if (mediaType === 'video') {
    editor
      .chain()
      .focus()
      .insertContent({ type: 'mediaEmbed', attrs: { src: url, mediaType: 'video' } })
      .run()
    return true
  }
  return false
}

function detectMediaType(url: string, mimeType?: string) {
  const type = mimeType || ''
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(url)) return 'image'
  if (/\.(mp4|mov|webm|mkv|avi)$/i.test(url)) return 'video'
  return 'unknown'
}

function hasMetadataBlock(doc: any) {
  let found = false
  doc?.descendants?.((node: any) => {
    if (node?.attrs?.metadata) {
      found = true
      return false
    }
    return
  })
  return found
}

function getMetadataRange(doc: any, metadataId?: string | null) {
  let min = Number.POSITIVE_INFINITY
  let max = -1
  let resolvedId: string | null = metadataId ?? null
  doc?.descendants?.((node: any, pos: number) => {
    if (!node?.attrs?.metadata) return
    if (metadataId && node?.attrs?.metadataId && node.attrs.metadataId !== metadataId) return
    min = Math.min(min, pos)
    max = Math.max(max, pos + node.nodeSize)
    if (!resolvedId && node?.attrs?.metadataId) {
      resolvedId = node.attrs.metadataId
    }
  })
  if (min === Number.POSITIVE_INFINITY || max === -1) return null
  return { from: min, to: max, metadataId: resolvedId }
}

function findMetadataNodeByRole(
  doc: any,
  role: MetadataRole
): { from: number; to: number; node: any } | null {
  let found: { from: number; to: number; node: any } | null = null
  doc?.descendants?.((node: any, pos: number) => {
    if (node?.attrs?.metadata && (node?.attrs?.metadataRole as MetadataRole | undefined) === role) {
      found = { from: pos, to: pos + node.nodeSize, node }
      return false
    }
    return
  })
  return found
}

function isSelectionInsideMetadata(doc: any, selection: any, metadataId?: string | null) {
  const range = getMetadataRange(doc, metadataId)
  if (!range || !selection) return false
  const from = (selection?.from as number) ?? 0
  const to = (selection?.to as number) ?? from
  return from >= range.from && to <= range.to
}

function isInsideMetadata(doc: any, pos: number) {
  const range = getMetadataRange(doc)
  if (!range) return false
  return pos >= range.from && pos <= range.to
}

function getTopLevelIndex(doc: any, pos: number): number | null {
  try {
    const resolved = doc.resolve?.(pos)
    if (!resolved) return null
    return resolved.path?.[1] ?? null
  } catch (_e) {
    return null
  }
}

function extractMetadataFromDoc(doc: any, dismissed = false): MetadataSnapshot {
  const snapshot: MetadataSnapshot = {
    title: undefined,
    summary: undefined,
    image: undefined,
    metadataId: null,
    hasMetadataBlock: false,
    dismissed,
    isTemplatePristine: false,
    coverDismissed: false
  }
  let nonMetadataContent = false
  let coverFound = false
  doc?.descendants?.((node: any) => {
    const isMetadata = Boolean(node?.attrs?.metadata)
    if (isMetadata) {
      snapshot.hasMetadataBlock = true
      snapshot.metadataId = snapshot.metadataId ?? node?.attrs?.metadataId ?? null
      const role = node?.attrs?.metadataRole as MetadataRole | undefined
      if (role === 'title') {
        const text = (node.textContent || '').trim()
        if (text) {
          snapshot.title = text
        }
      } else if (role === 'summary') {
        const text = (node.textContent || '').trim()
        if (text) {
          snapshot.summary = text
        }
      } else if (role === 'cover') {
        const src = node?.attrs?.src as string | null
        if (src) {
          snapshot.image = src
        }
        coverFound = true
      }
      return false
    }
    if (node.type?.name === 'doc') return
    if (node.type?.name === 'paragraph' && !node.textContent?.trim()) return
    if (node.textContent?.trim() || node.type?.name !== 'paragraph') {
      nonMetadataContent = true
    }
    return
  })
  if (snapshot.hasMetadataBlock) {
    snapshot.dismissed = false
  }
  if (snapshot.hasMetadataBlock) {
    snapshot.coverDismissed = !coverFound
  }
  snapshot.isTemplatePristine =
    snapshot.hasMetadataBlock &&
    !snapshot.title &&
    !snapshot.summary &&
    !snapshot.image &&
    !nonMetadataContent &&
    !snapshot.coverDismissed
  return snapshot
}

function isContentEmpty(content: any) {
  if (content === null || content === undefined) return true
  if (typeof content === 'string') {
    return content.trim().length === 0
  }
  if (typeof content === 'object') {
    if (content.type === 'doc' && Array.isArray(content.content)) {
      if (content.content.length === 0) return true
      // Treat a single empty paragraph or hardBreak-only paragraph as empty.
      if (content.content.length === 1) {
        const node = content.content[0]
        const isParagraph = node?.type === 'paragraph'
        const isEmptyParagraph =
          isParagraph &&
          (!node.content ||
            node.content.length === 0 ||
            (node.content.length === 1 &&
              node.content[0]?.type === 'text' &&
              !(node.content[0]?.text || '').trim()))
        if (isEmptyParagraph) return true
      }
    }
  }
  return false
}

function summarizeContent(content: any) {
  if (content === null) return 'null'
  if (content === undefined) return 'undefined'
  if (typeof content === 'string') {
    return `string(len=${content.length})`
  }
  if (typeof content === 'object') {
    const type = (content as any)?.type
    const childCount = Array.isArray((content as any)?.content)
      ? (content as any).content.length
      : 'n/a'
    return `object(type=${type ?? 'unknown'}, children=${childCount})`
  }
  return typeof content
}

function generateMetadataId() {
  return `meta-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

function stripMetadataFromDocJSON(docJson: any) {
  if (!docJson || typeof docJson !== 'object') return docJson
  const clone = JSON.parse(JSON.stringify(docJson))
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return null
    if (node.attrs?.metadata) {
      return null
    }
    if (Array.isArray(node.content)) {
      const filtered = node.content
        .map((child: any) => walk(child))
        .filter(Boolean) as any[]
      node.content = filtered
    }
    return node
  }
  const cleaned = walk(clone)
  if (!cleaned?.content || cleaned.content.length === 0) {
    cleaned.content = [
      {
        type: 'paragraph',
        content: []
      }
    ]
  }
  return cleaned
}

function getBodyMarkdown(editor: any) {
  const storage = editor?.storage?.markdown
  const serializer = storage?.serializer
  const schema = editor?.schema
  try {
    const docJson = editor?.getJSON?.() ?? editor?.state?.doc?.toJSON?.()
    const stripped = stripMetadataFromDocJSON(docJson)
    if (!serializer || !schema || !stripped) {
      return storage?.getMarkdown?.() ?? editor?.getText?.() ?? ''
    }
    const node = schema.nodeFromJSON(stripped)
    return serializer.serialize(node)
  } catch (_e) {
    return storage?.getMarkdown?.() ?? editor?.getText?.() ?? ''
  }
}

function sanitizeContent(content: any): any {
  if (!content || typeof content !== 'object') return content
  const clone = JSON.parse(JSON.stringify(content))
  const cleanNode = (node: any): any => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'text') {
      if (!node.text || !String(node.text).length) return null
      return node
    }
    if (Array.isArray(node.content)) {
      const cleanedChildren = node.content
        .map((child: any) => cleanNode(child))
        .filter(Boolean)
      return { ...node, content: cleanedChildren }
    }
    return node
  }
  const cleaned = cleanNode(clone)
  return cleaned ?? content
}

function isYoutubeUrl(url: string) {
  return /(youtube\.com|youtu\.be)/i.test(url)
}

function extractYoutubeId(url: string) {
  try {
    const u = new URL(url)
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.replace('/', '')
    }
    if (u.searchParams.has('v')) {
      return u.searchParams.get('v') || ''
    }
    const paths = u.pathname.split('/')
    return paths.includes('embed') ? paths[paths.length - 1] : ''
  } catch {
    return ''
  }
}

function LinkPreviewView(props: any) {
  const { node, getPos, editor } = props
  const url = node.attrs.url as string
  if (!url) return null
  if (isYoutubeUrl(url)) {
    return (
      <NodeViewWrapper
        data-link-preview
        className="my-2"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          if (typeof getPos === 'function') {
            editor?.commands.setNodeSelection(getPos())
          }
        }}
      >
        <div className="flex justify-end">
          <button
            type="button"
            className="text-muted-foreground text-xs px-2 py-1 hover:text-foreground"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              ;(props as any)?.deleteNode?.()
            }}
          >
            ×
          </button>
        </div>
        <YoutubeCard url={url} />
      </NodeViewWrapper>
    )
  }
  return (
    <NodeViewWrapper
      data-link-preview
      className="my-2"
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation()
        if (typeof getPos === 'function') {
          editor?.commands.setNodeSelection(getPos())
        }
      }}
    >
      <div className="flex justify-end">
        <button
          type="button"
          className="text-muted-foreground text-xs px-2 py-1 hover:text-foreground"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation()
            ;(props as any)?.deleteNode?.()
          }}
        >
          ×
        </button>
      </div>
      <div className="space-y-2">
        <WebPreview url={url} className="my-2" showFallback={false} />
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-primary underline break-words"
        >
          {url}
        </a>
      </div>
    </NodeViewWrapper>
  )
}

function MediaEmbedView(props: any) {
  const { node, getPos, editor } = props
  const url = node?.attrs?.src as string
  if (!url) return null
  return (
    <NodeViewWrapper
      data-media-embed
      className="my-2"
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation()
        if (typeof getPos === 'function') {
          editor?.commands.setNodeSelection(getPos())
        }
      }}
    >
      <div className="flex justify-end">
        <button
          type="button"
          className="text-muted-foreground text-xs px-2 py-1 hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            ;(props as any)?.deleteNode?.()
          }}
        >
          ×
        </button>
      </div>
      <VideoPlayer src={url} className="my-2" />
    </NodeViewWrapper>
  )
}

  function YoutubeCard({ url }: { url: string }) {
  const { title, description, image } = useFetchWebMetadata(url)
  const thumb =
    image ||
    (isYoutubeUrl(url)
      ? `https://img.youtube.com/vi/${extractYoutubeId(url)}/hqdefault.jpg`
      : undefined)
  const [expanded, setExpanded] = useState(false)

  if (expanded) {
    return <YoutubeEmbeddedPlayer url={url} className="my-2" mustLoad />
  }

  return (
    <button
      type="button"
      className="youtube-card"
      onClick={(e) => {
        e.stopPropagation()
        setExpanded(true)
      }}
    >
      <div className="youtube-card__thumb">
        {thumb && <img src={thumb} alt={title || 'YouTube preview'} />}
        <div className="youtube-card__play">
          <Play className="h-6 w-6" />
        </div>
      </div>
      <div className="youtube-card__body">
        <div className="youtube-card__host">youtube.com</div>
        <div className="youtube-card__title">{title || url}</div>
        {description && <div className="youtube-card__desc">{description}</div>}
      </div>
    </button>
  )
}

function DebugConsole({
  enabled,
  setEnabled,
  open,
  setOpen,
  entries,
  onClear,
  onSimulateEvent
}: {
  enabled: boolean
  setEnabled: (v: boolean) => void
  open: boolean
  setOpen: (v: boolean) => void
  entries: { id: string; time: string; message: string; data?: unknown }[]
  onClear: () => void
  onSimulateEvent?: () => void
}) {
  return (
    <div className="mt-2 text-xs">
      <div className="flex items-center gap-2">
        <Button
          variant={enabled ? 'default' : 'outline'}
          size="sm"
          className="h-7"
          onClick={() => {
            const next = !enabled
            setEnabled(next)
            setOpen(next)
          }}
        >
          {enabled ? 'Debug on' : 'Debug off'}
        </Button>
        {enabled && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => setOpen(!open)}
            >
              {open ? 'Hide log' : 'Show log'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={onClear}>
              Clear
            </Button>
            {onSimulateEvent && (
              <Button
                variant="secondary"
                size="sm"
                className="h-7"
                onClick={() => onSimulateEvent()}
              >
                Simulate 30023
              </Button>
            )}
            <span className="text-muted-foreground">{entries.length} events</span>
          </>
        )}
      </div>
      {enabled && open && (
        <div className="mt-2 max-h-52 overflow-auto rounded border bg-muted/30 p-2 space-y-1">
          {entries.length === 0 && <div className="text-muted-foreground">No events yet</div>}
          {entries.map((entry) => (
            <div key={entry.id} className="break-words">
              <span className="text-muted-foreground mr-1">{entry.time}</span>
              <span className="font-semibold">{entry.message}</span>
              {entry.data !== undefined && (
                <pre className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-muted-foreground bg-background/70 rounded p-1 border">
                  {JSON.stringify(entry.data, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function serializeDebug(data: unknown) {
  if (data === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(data))
  } catch (_e) {
    try {
      return String(data)
    } catch {
      return '[[unserializable]]'
    }
  }
}

function useMetadataRerender(editor: any) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!editor) return
    const rerender = () => force((v) => v + 1)
    editor.on('selectionUpdate', rerender)
    editor.on('focus', rerender)
    editor.on('blur', rerender)
    editor.on('update', rerender)
    return () => {
      editor.off?.('selectionUpdate', rerender)
      editor.off?.('focus', rerender)
      editor.off?.('blur', rerender)
      editor.off?.('update', rerender)
    }
  }, [editor])
}

function MetadataHeadingView(props: any) {
  const { node, editor, updateAttributes, getPos } = props
  useMetadataRerender(editor)
  const metadataId = node?.attrs?.metadataId
  const isPlaceholder = node?.attrs?.isPlaceholder
  const text = node?.textContent ?? ''
  const isEmpty = !(text || '').trim()
  const level = Math.min(6, Math.max(1, Number(node?.attrs?.level) || 1))
  const HeadingTag = `h${level}` as keyof JSX.IntrinsicElements
  const topLevelIndex = useMemo(() => {
    if (typeof getPos !== 'function') return null
    try {
      return getTopLevelIndex(editor?.state?.doc, getPos())
    } catch {
      return null
    }
  }, [editor?.state?.doc, getPos])
  useEffect(() => {
    updateAttributes?.({ isPlaceholder: isEmpty })
  }, [isEmpty, updateAttributes])
  const allowPlaceholder = node?.attrs?.metadata && topLevelIndex === 0

  return (
    <NodeViewWrapper
      as="div"
      className="relative my-2"
      data-metadata="true"
      data-metadata-role="title"
      data-metadata-id={metadataId ?? undefined}
      data-placeholder={METADATA_TITLE_PLACEHOLDER}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    >
      <HeadingTag
        className={cn(
          'text-3xl font-bold leading-snug focus:outline-none relative',
          isPlaceholder && isEmpty ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {isEmpty && allowPlaceholder && (
          <span className="pointer-events-none absolute left-0 top-0 text-muted-foreground/70 select-none">
            {METADATA_TITLE_PLACEHOLDER}
          </span>
        )}
        <NodeViewContent />
      </HeadingTag>
    </NodeViewWrapper>
  )
}

function MetadataSummaryView(props: any) {
  const { node, editor, updateAttributes, getPos } = props
  useMetadataRerender(editor)
  const metadataId = node?.attrs?.metadataId
  const isPlaceholder = node?.attrs?.isPlaceholder
  const text = node?.textContent ?? ''
  const isEmpty = !(text || '').trim()
  const topLevelIndex = useMemo(() => {
    if (typeof getPos !== 'function') return null
    try {
      return getTopLevelIndex(editor?.state?.doc, getPos())
    } catch {
      return null
    }
  }, [editor?.state?.doc, getPos])
  useEffect(() => {
    updateAttributes?.({ isPlaceholder: isEmpty })
  }, [isEmpty, updateAttributes])
  const allowPlaceholder = node?.attrs?.metadata && topLevelIndex === 1

  return (
    <NodeViewWrapper
      as="div"
      className="relative my-1"
      data-metadata="true"
      data-metadata-role="summary"
      data-metadata-id={metadataId ?? undefined}
      data-placeholder={METADATA_SUMMARY_PLACEHOLDER}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    >
      <blockquote
        className={cn(
          'border-l-4 border-muted-foreground/50 pl-3 relative',
          isPlaceholder && isEmpty ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {isEmpty && allowPlaceholder && (
          <span className="pointer-events-none absolute left-3 top-0 text-muted-foreground/70 select-none">
            {METADATA_SUMMARY_PLACEHOLDER}
          </span>
        )}
        <NodeViewContent />
      </blockquote>
    </NodeViewWrapper>
  )
}

function CoverPlaceholderView(props: any) {
  const { node, updateAttributes, deleteNode, editor, getPos, controlsRef } = props
  useMetadataRerender(editor)
  const src = node?.attrs?.src as string | null
  const mode = controlsRef?.current?.getMode?.() ?? 'hidden'
  const metadataId = node?.attrs?.metadataId
  const showFieldDelete = mode === 'field'

  if (src) {
    return (
      <NodeViewWrapper
        data-cover-placeholder
        data-metadata="true"
        data-metadata-role="cover"
        data-metadata-id={metadataId ?? undefined}
        className="my-3 relative"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation()
          if (typeof getPos === 'function') {
            editor?.commands.setNodeSelection(getPos())
          }
        }}
      >
        {showFieldDelete && (
          <button
            type="button"
            className="absolute right-1 top-1 z-10 rounded-full bg-background/90 border text-xs px-2 py-1 shadow hover:bg-muted"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              controlsRef?.current?.setLastAction?.('field-button')
              controlsRef?.current?.debugLog?.('metadata:delete-click', {
                role: 'cover',
                metadataId,
                action: 'field-button'
              })
              deleteNode?.()
            }}
          >
            ×
          </button>
        )}
        <img src={src} alt="Cover image" className="w-full rounded-md max-h-72 object-cover" />
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper
      data-cover-placeholder
      data-metadata="true"
      data-metadata-role="cover"
      data-metadata-id={metadataId ?? undefined}
      className="my-3 relative"
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation()
        if (typeof getPos === 'function') {
          editor?.commands.setNodeSelection(getPos())
        }
      }}
    >
      {showFieldDelete && (
        <button
          type="button"
          className="absolute right-1 top-1 z-10 rounded-full bg-background/90 border text-xs px-2 py-1 shadow hover:bg-muted"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation()
            controlsRef?.current?.setLastAction?.('field-button')
            controlsRef?.current?.debugLog?.('metadata:delete-click', {
              role: 'cover',
              metadataId,
              action: 'field-button'
            })
            deleteNode?.()
          }}
        >
          ×
        </button>
      )}
      <Uploader
        onUploadSuccess={({ url }) => {
          updateAttributes({ src: url, isTemplate: false, metadata: true })
          if (typeof getPos === 'function') {
            editor?.commands.setNodeSelection(getPos())
          }
        }}
        onUploadStart={(file, cancel) => props?.extensionStorage?.onUploadStart?.(file, cancel)}
        onUploadEnd={(file) => props?.extensionStorage?.onUploadEnd?.(file)}
        onProgress={(file, p) => props?.extensionStorage?.onUploadProgress?.(file, p)}
      >
        <button
          type="button"
          className="relative w-full aspect-[3/1] overflow-hidden rounded-md border border-dashed border-muted text-muted-foreground bg-muted/40 hover:bg-muted/60 transition-colors"
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Upload className="h-5 w-5" />
            <span>Upload cover image</span>
          </div>
        </button>
      </Uploader>
    </NodeViewWrapper>
  )
}
