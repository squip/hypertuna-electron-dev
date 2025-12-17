import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { isTouchDevice } from '@/lib/utils'
import client from '@/services/client.service'
import { TFeedSubRequest } from '@/types'
import { Event } from '@nostr/tools/wasm'
import { Filter } from '@nostr/tools/filter'
import dayjs from 'dayjs'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import PullToRefresh from 'react-simple-pull-to-refresh'
import ArticleCard from '../ArticleCard'
import { useNostr } from '@/providers/NostrProvider'

const LIMIT = 50
const SHOW_COUNT = 10

export type TArticleListRef = {
  refresh: () => void
  scrollToTop: (behavior?: ScrollBehavior) => void
}

export type TArticleSubRequest = {
  source: 'relays'
  urls: string[]
  filter: Omit<Filter, 'since' | 'until' | 'limit'>
}

const ArticleList = forwardRef(
  (
    {
      subRequests
    }: {
      subRequests: TArticleSubRequest[]
    },
    ref
  ) => {
    const { t } = useTranslation()
    const { startLogin } = useNostr()
    const [articles, setArticles] = useState<Event[]>([])
    const [loading, setLoading] = useState(true)
    const [hasMore, setHasMore] = useState<boolean>(true)
    const [showCount, setShowCount] = useState(SHOW_COUNT)
    const [refreshCount, setRefreshCount] = useState(0)
    const supportTouch = useMemo(() => isTouchDevice(), [])
    const bottomRef = useRef<HTMLDivElement | null>(null)
    const topRef = useRef<HTMLDivElement | null>(null)

    const buildSubRequests = useMemo<TFeedSubRequest[]>(() => {
      return subRequests.map(({ urls, filter }) => ({
        source: 'relays',
        urls,
        filter
      }))
    }, [subRequests])

    const scrollToTop = (behavior: ScrollBehavior = 'instant') => {
      setTimeout(() => {
        topRef.current?.scrollIntoView({ behavior, block: 'start' })
      }, 20)
    }

    const refresh = () => {
      scrollToTop()
      setTimeout(() => {
        setRefreshCount((count) => count + 1)
      }, 500)
    }

    useImperativeHandle(ref, () => ({
      refresh,
      scrollToTop
    }))

    useEffect(() => {
      if (!buildSubRequests.length) return

      async function init() {
        setLoading(true)
        setArticles([])
        setHasMore(true)

        const subc = client.subscribeTimeline(
          buildSubRequests,
          {
            kinds: [30023],
            limit: LIMIT
          },
          {
            onEvents: (events, isFinal) => {
              if (events.length > 0) {
                setArticles(events)
              }
              if (isFinal) {
                setLoading(false)
                setHasMore(events.length > 0)
              }
            },
            onNew: (event) => {
              setArticles((oldArticles) =>
                oldArticles.some((e) => e.id === event.id) ? oldArticles : [event, ...oldArticles]
              )
            }
          },
          {
            startLogin
          }
        )

        return subc
      }

      const subscription = init()
      return () => {
        subscription?.then((subc) => subc?.close())
      }
    }, [buildSubRequests, refreshCount, startLogin])

    useEffect(() => {
      const options = {
        root: null,
        rootMargin: '10px',
        threshold: 0.1
      }

      const loadMore = async () => {
        if (showCount < articles.length) {
          setShowCount((prev) => prev + SHOW_COUNT)
          // preload more
          if (articles.length - showCount > LIMIT / 2) {
            return
          }
        }

        if (loading || !hasMore) return
        setLoading(true)
        const newArticles = await client.loadMoreTimeline(
          buildSubRequests,
          {
            until: articles.length ? articles[articles.length - 1].created_at - 1 : dayjs().unix(),
            limit: LIMIT,
            kinds: [30023]
          },
          {
            startLogin
          }
        )
        setLoading(false)
        if (newArticles.length === 0) {
          setHasMore(false)
          return
        }
        setArticles((oldArticles) => [...oldArticles, ...newArticles])
      }

      const observerInstance = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          loadMore()
        }
      }, options)

      const currentBottomRef = bottomRef.current

      if (currentBottomRef) {
        observerInstance.observe(currentBottomRef)
      }

      return () => {
        if (observerInstance && currentBottomRef) {
          observerInstance.unobserve(currentBottomRef)
        }
      }
    }, [loading, hasMore, articles, showCount, buildSubRequests, startLogin])

    const displayedArticles = useMemo(() => {
      const filteredTitles = ['Untitled', 'Untitled Draft', 'Draft', 'Test', 'Testing']

      const uniqueArticles = new Map<string, Event>()
      articles.forEach((event) => {
        const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1]
        const key = `${event.pubkey}:${dTag || event.id}`

        const existing = uniqueArticles.get(key)
        if (!existing || event.created_at > existing.created_at) {
          uniqueArticles.set(key, event)
        }
      })

      return Array.from(uniqueArticles.values())
        .filter((event) => {
          const titleTag = event.tags.find((tag) => tag[0] === 'title')
          const title = titleTag?.[1] || 'Untitled'
          return !filteredTitles.includes(title)
        })
        .sort((a, b) => {
          const aPublishedAt =
            parseInt(a.tags.find((tag) => tag[0] === 'published_at')?.[1] || '0') ||
            a.created_at
          const bPublishedAt =
            parseInt(b.tags.find((tag) => tag[0] === 'published_at')?.[1] || '0') ||
            b.created_at
          return bPublishedAt - aPublishedAt
        })
        .slice(0, showCount)
    }, [articles, showCount])

    const handleRefresh = async () => {
      refresh()
    }

    const content = (
      <div className="pb-4">
        <div ref={topRef} />
        {loading && articles.length === 0 ? (
          <div>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex gap-4 py-4 px-4 border-b border-border">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
                <Skeleton className="w-32 h-24 rounded-lg flex-shrink-0" />
              </div>
            ))}
          </div>
        ) : displayedArticles.length > 0 ? (
          <div>
            {displayedArticles.map((article) => (
              <ArticleCard key={article.id} event={article} />
            ))}
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-12">
            {t('No articles found')}
          </div>
        )}
        <div ref={bottomRef} className="h-1" />
        {!loading && hasMore && displayedArticles.length > 0 && (
          <div className="text-center py-4">
            <Button variant="outline" onClick={() => setShowCount((prev) => prev + SHOW_COUNT)}>
              {t('Load More')}
            </Button>
          </div>
        )}
      </div>
    )

    if (supportTouch) {
      return <PullToRefresh onRefresh={handleRefresh}>{content}</PullToRefresh>
    }

    return content
  }
)

ArticleList.displayName = 'ArticleList'

export default ArticleList
