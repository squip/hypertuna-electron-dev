import Username from '@/components/Username'
import UserAvatar from '@/components/UserAvatar'
import { FormattedTimestamp } from '@/components/FormattedTimestamp'
import { SecondaryPageLink } from '@/PageManager'
import { toArticle } from '@/lib/link'
import { Event } from '@nostr/tools/wasm'
import { useEffect, useMemo, useState } from 'react'
import * as nip19 from '@nostr/tools/nip19'

export default function ArticleCard({ event }: { event: Event }) {
  const [shouldShowImage, setShouldShowImage] = useState(true)

  const { title, summary, image, publishedAt, identifier } = useMemo(() => {
    const titleTag = event.tags.find((tag) => tag[0] === 'title')
    const summaryTag = event.tags.find((tag) => tag[0] === 'summary')
    const imageTag = event.tags.find((tag) => tag[0] === 'image')
    const publishedAtTag = event.tags.find((tag) => tag[0] === 'published_at')
    const dTag = event.tags.find((tag) => tag[0] === 'd')

    return {
      title: titleTag?.[1] || 'Untitled',
      summary: summaryTag?.[1] || '',
      image: imageTag?.[1],
      publishedAt: publishedAtTag?.[1] ? parseInt(publishedAtTag[1]) : event.created_at,
      identifier: dTag?.[1] || ''
    }
  }, [event])

  useEffect(() => {
    if (!image) {
      setShouldShowImage(false)
      return
    }

    fetch(image, { method: 'HEAD' })
      .then((response) => {
        const xStatus = response.headers.get('x-status')
        if (xStatus && parseInt(xStatus) >= 400) {
          setShouldShowImage(false)
        } else if (!response.ok) {
          setShouldShowImage(false)
        } else {
          setShouldShowImage(true)
        }
      })
      .catch(() => {
        setShouldShowImage(false)
      })
  }, [image])

  const naddr = useMemo(() => {
    if (!identifier) return ''

    return nip19.naddrEncode({
      kind: 30023,
      pubkey: event.pubkey,
      identifier,
      relays: []
    })
  }, [event.pubkey, identifier])

  const displaySummary = useMemo(() => {
    if (summary) return summary

    const plainText = event.content
      .replace(/[#*_~`]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim()

    return plainText.length > 200 ? plainText.slice(0, 200) + '...' : plainText
  }, [summary, event.content])

  return (
    <SecondaryPageLink to={toArticle(naddr)}>
      <div className="py-4 px-4 hover:bg-accent/50 transition-colors cursor-pointer border-b border-border">
        <div className="flex gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-lg mb-1 line-clamp-2">{title}</h3>
            {displaySummary && (
              <p className="text-sm text-muted-foreground mb-2 line-clamp-2">{displaySummary}</p>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>By</span>
              <UserAvatar userId={event.pubkey} size="small" />
              <Username userId={event.pubkey} />
              <span>•</span>
              <FormattedTimestamp timestamp={publishedAt} />
            </div>
          </div>
          {image && shouldShowImage && (
            <div className="flex-shrink-0 w-32 h-24 rounded-lg overflow-hidden bg-muted">
              <img
                src={image}
                alt={title}
                className="w-full h-full object-cover"
                loading="lazy"
                onError={() => setShouldShowImage(false)}
              />
            </div>
          )}
        </div>
      </div>
    </SecondaryPageLink>
  )
}
