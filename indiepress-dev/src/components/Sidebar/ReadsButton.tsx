import { usePrimaryPage } from '@/PageManager'
import { BookOpen } from 'lucide-react'
import SidebarItem from './SidebarItem'

export default function ReadsButton({ collapse }: { collapse: boolean }) {
  const { navigate, current, display } = usePrimaryPage()

  return (
    <SidebarItem
      title="Reads"
      onClick={() => navigate('reads')}
      active={display && current === 'reads'}
      collapse={collapse}
    >
      <BookOpen />
    </SidebarItem>
  )
}
