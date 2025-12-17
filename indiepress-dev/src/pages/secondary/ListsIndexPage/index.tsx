import { SecondaryPageLink } from '@/PageManager'
import { Button } from '@/components/ui/button'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { toCreateList, toList } from '@/lib/link'
import { useLists } from '@/providers/ListsProvider'
import { useTranslation } from 'react-i18next'
import { forwardRef } from 'react'

const ListsIndexPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { t } = useTranslation()
  const { lists, isLoading } = useLists()

  return (
    <SecondaryPageLayout ref={ref} index={index} title={t('Lists')} displayScrollToTopButton>
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">{t('My Lists')}</div>
          <SecondaryPageLink to={toCreateList()}>
            <Button size="sm">{t('New List')}</Button>
          </SecondaryPageLink>
        </div>
        {isLoading && <div className="text-sm text-muted-foreground">{t('Loading...')}</div>}
        {!isLoading && (!lists || lists.length === 0) && (
          <div className="text-sm text-muted-foreground">{t('No lists found')}</div>
        )}
        <div className="grid gap-2">
          {lists.map((list) => (
            <SecondaryPageLink key={list.id} to={toList(list.id)}>
              <div className="p-3 border rounded hover:bg-accent cursor-pointer">
                <div className="font-semibold">{list.title}</div>
                {list.description && (
                  <div className="text-sm text-muted-foreground line-clamp-2">
                    {list.description}
                  </div>
                )}
              </div>
            </SecondaryPageLink>
          ))}
        </div>
      </div>
    </SecondaryPageLayout>
  )
})

ListsIndexPage.displayName = 'ListsIndexPage'

export default ListsIndexPage
