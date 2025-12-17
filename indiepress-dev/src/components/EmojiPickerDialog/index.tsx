import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useScreenSize } from '@/providers/ScreenSizeProvider'
import { TEmoji } from '@/types'
import { useRef, useState } from 'react'
import EmojiPicker from '../EmojiPicker'

export default function EmojiPickerDialog({
  children,
  onEmojiClick,
  onOpenChange
}: {
  children: React.ReactNode
  onEmojiClick?: (emoji: string | TEmoji | undefined) => void
  onOpenChange?: (open: boolean, surface: 'drawer' | 'dropdown') => void
}) {
  const { isSmallScreen } = useScreenSize()
  const [open, setOpen] = useState(false)
  const pointerToggledRef = useRef(false)

  const handleOpenChange = (next: boolean, surface: 'drawer' | 'dropdown') => {
    pointerToggledRef.current = false
    setOpen(next)
    onOpenChange?.(next, surface)
  }

  if (isSmallScreen) {
    return (
      <Drawer open={open} onOpenChange={(next) => handleOpenChange(next, 'drawer')}>
        <DrawerTrigger asChild>{children}</DrawerTrigger>
        <DrawerContent>
          <EmojiPicker
            onEmojiClick={(emoji, e) => {
              e.stopPropagation()
              handleOpenChange(false, 'drawer')
              onEmojiClick?.(emoji)
            }}
          />
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => handleOpenChange(next, 'dropdown')}
    >
      <DropdownMenuTrigger
        asChild
        onPointerDown={(e) => {
          // Force-open for reliability while still letting Radix manage focus.
          pointerToggledRef.current = true
          handleOpenChange(!open, 'dropdown')
        }}
        onClick={(e) => {
          // Avoid double toggling; Radix handles it but we keep state in sync.
          if (pointerToggledRef.current) {
            pointerToggledRef.current = false
            return
          }
          handleOpenChange(!open, 'dropdown')
        }}
      >
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="p-0 w-fit">
        <EmojiPicker
          onEmojiClick={(emoji, e) => {
            e.stopPropagation()
            handleOpenChange(false, 'dropdown')
            onEmojiClick?.(emoji)
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
