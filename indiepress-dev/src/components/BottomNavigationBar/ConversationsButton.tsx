import { usePrimaryPage } from '@/PageManager'
import { useConversationBadge } from '@/hooks'
import { MessageSquare } from 'lucide-react'
import BottomNavigationBarItem from './BottomNavigationBarItem'

export default function ConversationsButton() {
  const { navigate, current, display } = usePrimaryPage()
  const { hasNewMessages } = useConversationBadge()

  return (
    <BottomNavigationBarItem
      active={current === 'conversations' && display}
      onClick={() => navigate('conversations')}
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
    </BottomNavigationBarItem>
  )
}
