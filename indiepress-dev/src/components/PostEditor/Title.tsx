import { Event } from '@nostr/tools/wasm'
import { useTranslation } from 'react-i18next'

export default function Title({
  parentEvent,
  tab = 'post'
}: {
  parentEvent?: Event
  tab?: 'post' | 'article'
}) {
  const { t } = useTranslation()

  return parentEvent ? (
    <div className="flex gap-2 items-center w-full">
      <div className="shrink-0">{t('Reply to')}</div>
    </div>
  ) : (
    (tab === 'article' ? t('New Article') : t('New Post'))
  )
}
