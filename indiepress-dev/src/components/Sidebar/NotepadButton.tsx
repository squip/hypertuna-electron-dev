import { usePrimaryPage } from '@/PageManager'
import { NotebookPen } from 'lucide-react'
import SidebarItem from './SidebarItem'

export default function NotepadButton({ collapse }: { collapse: boolean }) {
  const { navigate, current, display } = usePrimaryPage()

  return (
    <SidebarItem
      title="Notepad"
      onClick={() => navigate('notepad')}
      active={display && current === 'notepad'}
      collapse={collapse}
    >
      <NotebookPen />
    </SidebarItem>
  )
}
