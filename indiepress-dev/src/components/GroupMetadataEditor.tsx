import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import Uploader from '@/components/PostEditor/Uploader'
import { Upload, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export type TGroupMetadataForm = {
  name: string
  about: string
  picture: string
  isPublic: boolean
  isOpen: boolean
}

export default function GroupMetadataEditor({
  initial,
  onSave,
  onCancel,
  saving,
  isOpen
}: {
  initial?: Partial<TGroupMetadataForm>
  onSave: (data: TGroupMetadataForm) => void
  onCancel: () => void
  saving?: boolean
  isOpen?: boolean
}) {
  const [form, setForm] = useState<TGroupMetadataForm>({
    name: initial?.name ?? '',
    about: initial?.about ?? '',
    picture: initial?.picture ?? '',
    isPublic: initial?.isPublic ?? true,
    isOpen: initial?.isOpen ?? true
  })
  const [hasInteracted, setHasInteracted] = useState(false)

  const nextFormFromInitial = () => ({
      name: initial?.name ?? '',
      about: initial?.about ?? '',
      picture: initial?.picture ?? '',
      isPublic: initial?.isPublic ?? true,
      isOpen: initial?.isOpen ?? true
    })

  useEffect(() => {
    if (!isOpen) return
    if (hasInteracted) return
    setForm(nextFormFromInitial())
  }, [initial, isOpen, hasInteracted])

  useEffect(() => {
    if (!isOpen) return
    setHasInteracted(false)
    setForm(nextFormFromInitial())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Group Name</Label>
        <Input
          value={form.name}
          onChange={(e) => {
            setHasInteracted(true)
            setForm((f) => ({ ...f, name: e.target.value }))
          }}
          placeholder="Enter group name"
        />
      </div>
      <div className="space-y-2">
        <Label>About</Label>
        <Textarea
          value={form.about}
          onChange={(e) => {
            setHasInteracted(true)
            setForm((f) => ({ ...f, about: e.target.value }))
          }}
          placeholder="Description"
          rows={3}
        />
      </div>
      <div className="space-y-2">
        <Label>Picture</Label>
        <Tabs defaultValue="upload" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="url">URL</TabsTrigger>
            <TabsTrigger value="upload">Upload</TabsTrigger>
          </TabsList>
          <TabsContent value="url" className="space-y-2">
            <Input
              value={form.picture}
              onChange={(e) => {
                setHasInteracted(true)
                setForm((f) => ({ ...f, picture: e.target.value }))
              }}
              placeholder="https://..."
            />
          </TabsContent>
          <TabsContent value="upload" className="space-y-2">
            <Uploader
              accept="image/*"
              onUploadSuccess={({ url }) => {
                setHasInteracted(true)
                setForm((f) => ({ ...f, picture: url }))
              }}
            >
              <div className="relative w-full h-40 border-2 border-dashed rounded-lg overflow-hidden cursor-pointer hover:bg-accent/50 transition-colors flex items-center justify-center">
                {!form.picture && (
                  <div className="text-center p-6">
                    <Upload className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm text-muted-foreground">Click to upload an image</p>
                  </div>
                )}
                {form.picture && (
                  <>
                    <img src={form.picture} alt="Preview" className="w-full h-full object-cover" />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute top-2 right-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        setHasInteracted(true)
                        setForm((f) => ({ ...f, picture: '' }))
                      }}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </>
                )}
              </div>
            </Uploader>
          </TabsContent>
        </Tabs>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label>Public</Label>
          <div className="text-xs text-muted-foreground">Anyone can read the group</div>
        </div>
        <Switch
          checked={form.isPublic}
          onCheckedChange={(val) => {
            setHasInteracted(true)
            setForm((f) => ({ ...f, isPublic: val }))
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label>Open membership</Label>
          <div className="text-xs text-muted-foreground">Join requests auto-accept</div>
        </div>
        <Switch
          checked={form.isOpen}
          onCheckedChange={(val) => {
            setHasInteracted(true)
            setForm((f) => ({ ...f, isOpen: val }))
          }}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSave(form)} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
