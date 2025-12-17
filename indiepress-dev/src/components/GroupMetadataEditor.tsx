import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
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
  saving
}: {
  initial?: Partial<TGroupMetadataForm>
  onSave: (data: TGroupMetadataForm) => void
  onCancel: () => void
  saving?: boolean
}) {
  const [form, setForm] = useState<TGroupMetadataForm>({
    name: initial?.name ?? '',
    about: initial?.about ?? '',
    picture: initial?.picture ?? '',
    isPublic: initial?.isPublic ?? true,
    isOpen: initial?.isOpen ?? true
  })

  useEffect(() => {
    setForm({
      name: initial?.name ?? '',
      about: initial?.about ?? '',
      picture: initial?.picture ?? '',
      isPublic: initial?.isPublic ?? true,
      isOpen: initial?.isOpen ?? true
    })
  }, [initial])

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Group Name</Label>
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Enter group name"
        />
      </div>
      <div className="space-y-2">
        <Label>About</Label>
        <Textarea
          value={form.about}
          onChange={(e) => setForm((f) => ({ ...f, about: e.target.value }))}
          placeholder="Description"
          rows={3}
        />
      </div>
      <div className="space-y-2">
        <Label>Picture</Label>
        <Input
          value={form.picture}
          onChange={(e) => setForm((f) => ({ ...f, picture: e.target.value }))}
          placeholder="https://..."
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label>Public</Label>
          <div className="text-xs text-muted-foreground">Anyone can read the group</div>
        </div>
        <Switch
          checked={form.isPublic}
          onCheckedChange={(val) => setForm((f) => ({ ...f, isPublic: val }))}
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label>Open membership</Label>
          <div className="text-xs text-muted-foreground">Join requests auto-accept</div>
        </div>
        <Switch checked={form.isOpen} onCheckedChange={(val) => setForm((f) => ({ ...f, isOpen: val }))} />
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
