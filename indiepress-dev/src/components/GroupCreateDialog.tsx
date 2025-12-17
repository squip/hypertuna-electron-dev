import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useTranslation } from 'react-i18next'
import { useGroups } from '@/providers/GroupsProvider'
import { toast } from 'sonner'
import localStorageService from '@/services/local-storage.service'
import { BIG_RELAY_URLS } from '@/constants'

export default function GroupCreateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { createGroup } = useGroups()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [picture, setPicture] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [isOpen, setIsOpen] = useState(true)
  const [relays, setRelays] = useState<string[]>(() => {
    const stored = localStorageService.getGroupDiscoveryRelays()
    return stored.length ? stored : BIG_RELAY_URLS
  })
  const [isSaving, setIsSaving] = useState(false)

  const handleRelayChange = (index: number, value: string) => {
    setRelays((prev) => prev.map((r, i) => (i === index ? value : r)))
  }

  const addRelayField = () => setRelays((prev) => [...prev, ''])
  const removeRelayField = (index: number) =>
    setRelays((prev) => prev.filter((_, i) => i !== index))

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('Please enter a group name'))
      return
    }
    setIsSaving(true)
    try {
      const relayList = relays.filter((r) => r.trim())
      const result = await createGroup({
        name: name.trim(),
        about: about.trim(),
        picture: picture.trim(),
        isPublic,
        isOpen,
        relays: relayList.length ? relayList : undefined
      })
      toast.success(t('Group created'), { duration: 2000 })
      onOpenChange(false)
      // persist relays for next time
      if (relayList.length) {
        localStorageService.setGroupDiscoveryRelays(relayList)
      }
      setName('')
      setAbout('')
      setPicture('')
    } catch (err) {
      toast.error(t('Failed to create group'))
      console.error(err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('New Group')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('Group Name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('Enter group name') as string}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('Description')} ({t('optional')})</Label>
            <Textarea
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder={t('Enter group description') as string}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('Cover Image')} ({t('optional')})</Label>
            <Input
              value={picture}
              onChange={(e) => setPicture(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('Public Group')}</Label>
              <div className="text-xs text-muted-foreground">
                {t('Anyone can discover this group')}
              </div>
            </div>
            <Switch checked={isPublic} onCheckedChange={setIsPublic} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('Open Membership')}</Label>
              <div className="text-xs text-muted-foreground">
                {t('Anyone can join and invite others')}
              </div>
            </div>
            <Switch checked={isOpen} onCheckedChange={setIsOpen} />
          </div>
          <div className="space-y-2">
            <Label>{t('Discovery relays')}</Label>
            <div className="space-y-2">
              {relays.map((relay, idx) => (
                <div className="flex gap-2" key={`relay-${idx}`}>
                  <Input
                    value={relay}
                    onChange={(e) => handleRelayChange(idx, e.target.value)}
                    placeholder="wss://..."
                  />
                  {relays.length > 1 && (
                    <Button variant="outline" size="icon" onClick={() => removeRelayField(idx)}>
                      ×
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={addRelayField}>
              {t('Add relay')}
            </Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? t('Creating...') : t('Create Group')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
