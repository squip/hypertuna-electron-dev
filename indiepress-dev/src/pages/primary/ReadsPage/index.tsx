import { BIG_RELAY_URLS } from '@/constants'
import PrimaryPageLayout from '@/layouts/PrimaryPageLayout'
import { isTouchDevice } from '@/lib/utils'
import ArticleList, { TArticleListRef, TArticleSubRequest } from '@/components/ArticleList'
import { RefreshButton } from '@/components/RefreshButton'
import { TPageRef } from '@/types'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNostr } from '@/providers/NostrProvider'
import { useFetchFollowings } from '@/hooks'
import client from '@/services/client.service'

const ReadsPage = forwardRef((_, ref) => {
  const { t } = useTranslation()
  const layoutRef = useRef<TPageRef>(null)
  const articleListRef = useRef<TArticleListRef>(null)
  const { pubkey } = useNostr()
  const { followings } = useFetchFollowings(pubkey)
  const [subRequests, setSubRequests] = useState<TArticleSubRequest[]>([])
  const supportTouch = useMemo(() => isTouchDevice(), [])

  useImperativeHandle(ref, () => layoutRef.current)

  useEffect(() => {
    const init = async () => {
      if (pubkey && followings.length > 0) {
        const relayList = await client.fetchRelayList(pubkey)
        setSubRequests([
          {
            source: 'relays',
            urls: relayList.read.concat(BIG_RELAY_URLS).slice(0, 8),
            filter: {
              authors: followings
            }
          }
        ])
      } else {
        setSubRequests([
          {
            source: 'relays',
            urls: BIG_RELAY_URLS,
            filter: {}
          }
        ])
      }
    }

    init()
  }, [pubkey, followings])

  let content: React.ReactNode = null

  if (subRequests.length === 0) {
    content = (
      <div className="text-center text-sm text-muted-foreground py-8">
        {t('Loading articles...')}
      </div>
    )
  } else {
    content = <ArticleList ref={articleListRef} subRequests={subRequests} />
  }

  return (
    <PrimaryPageLayout
      pageName="reads"
      ref={layoutRef}
      titlebar={
        <ReadsPageTitlebar
          articleListRef={articleListRef}
          supportTouch={supportTouch}
          isLoggedIn={!!pubkey}
          hasFollowings={followings.length > 0}
        />
      }
      displayScrollToTopButton
    >
      {content}
    </PrimaryPageLayout>
  )
})

ReadsPage.displayName = 'ReadsPage'

export default ReadsPage

function ReadsPageTitlebar({
  articleListRef,
  supportTouch,
  isLoggedIn,
  hasFollowings
}: {
  articleListRef: React.RefObject<TArticleListRef>
  supportTouch: boolean
  isLoggedIn: boolean
  hasFollowings: boolean
}) {
  const { t } = useTranslation()

  return (
    <div className="flex gap-1 items-center h-full justify-between">
      <div className="flex-1 pl-4">
        <div className="font-semibold text-lg">{t('Reads')}</div>
        {isLoggedIn && hasFollowings && (
          <div className="text-xs text-muted-foreground">{t('From people you follow')}</div>
        )}
        {!isLoggedIn && (
          <div className="text-xs text-muted-foreground">{t('Public articles')}</div>
        )}
      </div>
      <div className="shrink-0 flex gap-1 items-center">
        {!supportTouch && <RefreshButton onClick={() => articleListRef.current?.refresh()} />}
      </div>
    </div>
  )
}
