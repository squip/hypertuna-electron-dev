import { usePrimaryPage } from '@/PageManager'
import { List } from 'lucide-react'
import SidebarItem from './SidebarItem'

export default function ListsButton({ collapse }: { collapse: boolean }) {
  const { navigate, current, display } = usePrimaryPage()

  return (
    <SidebarItem
      title="Lists"
      onClick={() => navigate('lists')}
      active={display && current === 'lists'}
      collapse={collapse}
    >
      <List strokeWidth={1.3} />
    </SidebarItem>
  )
}
