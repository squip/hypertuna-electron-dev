import { useSecondaryPage } from '@/PageManager'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import ListEditorForm from '@/components/ListEditorForm'

const ListEditorPage = forwardRef(
  ({ listId, index }: { listId?: string; index?: number }, ref) => {
    const { t } = useTranslation()
    const { pop } = useSecondaryPage()
    const isEditing = !!listId

    return (
      <SecondaryPageLayout
        ref={ref}
        index={index}
        title={isEditing ? t('Edit List') : t('New List')}
        displayScrollToTopButton
      >
        <div className="p-4">
          <ListEditorForm listId={listId} onSaved={() => pop()} onCancel={() => pop()} />
        </div>
      </SecondaryPageLayout>
    )
  }
)

ListEditorPage.displayName = 'ListEditorPage'

export default ListEditorPage
