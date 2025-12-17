import { usePrimaryPage } from '@/PageManager'
import { useConversationBadge } from '@/hooks'
import { MessageSquare } from 'lucide-react'
import SidebarItem from './SidebarItem'

export default function ConversationsButton({ collapse }: { collapse: boolean }) {
  const { navigate, current, display } = usePrimaryPage()
  const { hasNewMessages } = useConversationBadge()

  return (
    <SidebarItem
      title="Conversations"
      onClick={() => navigate('conversations')}
      active={display && current === 'conversations'}
      collapse={collapse}
    >
      <div className="relative">
        <MessageSquare />
        {hasNewMessages && (
          <div
            className="absolute size-2 rounded-full -right-1 -top-1 ring-2 ring-background"
            style={{ backgroundColor: 'hsl(var(--primary))' }}
          />
        )}
      </div>
    </SidebarItem>
  )
}
