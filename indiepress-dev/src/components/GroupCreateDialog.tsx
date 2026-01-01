import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from 'react-i18next'
import { useGroups } from '@/providers/GroupsProvider'
import { toast } from 'sonner'
import Uploader from '@/components/PostEditor/Uploader'
import { Upload, X } from 'lucide-react'

export default function GroupCreateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const { createHypertunaRelayGroup } = useGroups()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [picture, setPicture] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [isOpen, setIsOpen] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('Please enter a group name'))
      return
    }
    setIsSaving(true)
    try {
      await createHypertunaRelayGroup({
        name: name.trim(),
        about: about.trim(),
        isPublic,
        isOpen,
        picture: picture.trim() || undefined,
        fileSharing: true
      })
      toast.success(t('Group created'), { duration: 2000 })
      onOpenChange(false)
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
            <Tabs defaultValue="url" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="url">URL</TabsTrigger>
                <TabsTrigger value="upload">{t('Upload')}</TabsTrigger>
              </TabsList>
              <TabsContent value="url" className="space-y-2">
                <Input
                  value={picture}
                  onChange={(e) => setPicture(e.target.value)}
                  placeholder="https://..."
                />
                {picture && (
                  <div className="relative w-full h-32 rounded overflow-hidden border">
                    <img src={picture} alt="Preview" className="w-full h-full object-cover" />
                  </div>
                )}
              </TabsContent>
              <TabsContent value="upload" className="space-y-2">
                <Uploader
                  accept="image/*"
                  onUploadSuccess={({ url }) => setPicture(url)}
                >
                  <div className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:bg-accent/50 transition-colors">
                    <Upload className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm text-muted-foreground">
                      {t('Click to upload an image')}
                    </p>
                  </div>
                </Uploader>
                {picture && (
                  <div className="relative w-full h-32 rounded overflow-hidden border">
                    <img src={picture} alt="Preview" className="w-full h-full object-cover" />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute top-2 right-2"
                      onClick={() => setPicture('')}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </TabsContent>
            </Tabs>
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
