import type {
  CacheModuleCollection,
  CacheModuleDefinition,
  CacheModuleStorage
} from '@nostr-dev-kit/ndk'

export type CachedNotepadNote = {
  key: string
  d: string
  pubkey: string
  kind: number
  created_at: number
  content: string
  tags: string[][]
  id: string
  wrapId?: string
  relays?: string[]
}

const MODULE_NAMESPACE = 'notepad'

const moduleDefinition: CacheModuleDefinition = {
  namespace: MODULE_NAMESPACE,
  version: 1,
  collections: {
    notes: {
      primaryKey: 'key',
      indexes: ['d', 'pubkey', 'created_at']
    }
  },
  migrations: {
    1: async (ctx) => {
      await ctx.createCollection('notes', moduleDefinition.collections.notes)
    }
  }
}

export class NotepadCache {
  private adapter: CacheModuleStorage
  private ready: Promise<void>
  private notes?: CacheModuleCollection<CachedNotepadNote>

  constructor(adapter: CacheModuleStorage) {
    if (typeof (adapter as any)?.getModuleCollection !== 'function') {
      throw new Error('Cache adapter does not support cache modules API')
    }
    this.adapter = adapter
    this.ready = this.init()
  }

  private async init() {
    if (!this.adapter.registerModule) {
      throw new Error('Cache adapter does not support module registration')
    }

    const needsRegister =
      !this.adapter.hasModule || !this.adapter.hasModule(MODULE_NAMESPACE)
    const version = (this.adapter as any)?.getModuleVersion
      ? await (this.adapter as any).getModuleVersion(MODULE_NAMESPACE)
      : 0

    if (needsRegister || version < moduleDefinition.version) {
      await this.adapter.registerModule(moduleDefinition)
    }

    const getCollections = async () => {
      const notes = await (this.adapter as unknown as {
        getModuleCollection: (
          namespace: string,
          collection: string
        ) => Promise<CacheModuleCollection<CachedNotepadNote>>
      }).getModuleCollection(MODULE_NAMESPACE, 'notes')
      return { notes }
    }

    let collections: { notes: CacheModuleCollection<CachedNotepadNote> }
    try {
      collections = await getCollections()
    } catch (err) {
      await this.adapter.registerModule(moduleDefinition)
      collections = await getCollections()
    }

    this.notes = collections.notes
  }

  private async ensureReady() {
    await this.ready
    if (!this.notes) {
      throw new Error('NotepadCache not initialized')
    }
  }

  async save(note: CachedNotepadNote) {
    await this.ensureReady()
    const existing = await this.notes!.get(note.key)
    if (existing && existing.created_at > note.created_at) {
      return existing
    }
    await this.notes!.save(note)
    return note
  }

  async getLatestByPubkey(pubkey: string): Promise<Map<string, CachedNotepadNote>> {
    await this.ensureReady()
    const list = await this.notes!.findBy('pubkey', pubkey)
    const map = new Map<string, CachedNotepadNote>()
    list.forEach((raw) => {
      const existing = map.get(raw.d)
      if (!existing || raw.created_at >= existing.created_at) {
        map.set(raw.d, raw)
      }
    })
    return map
  }
}
