import { usePrimaryPage } from '@/PageManager'
import { Users } from 'lucide-react'
import SidebarItem from './SidebarItem'

export default function GroupsButton({ collapse }: { collapse: boolean }) {
  const { navigate, current, display } = usePrimaryPage()

  return (
    <SidebarItem
      title="Groups"
      onClick={() => navigate('groups')}
      active={display && current === 'groups'}
      collapse={collapse}
    >
      <Users strokeWidth={1.3} />
    </SidebarItem>
  )
}
