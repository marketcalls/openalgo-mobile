import { z } from 'zod'
import type { KV } from './storage'

export const ServerProfileSchema = z.object({
  id: z.string(),
  restOrigin: z.string(),
  wsUrl: z.string().nullable(),
  feedMode: z.enum(['live', 'polling']),
  httpWarningAcked: z.boolean(),
  serverVersion: z.string().nullable(),
  broker: z.string().nullable(),
  createdAt: z.number(),
  lastFeedRetryAt: z.number().nullable(),
})
export type ServerProfile = z.infer<typeof ServerProfileSchema>

const ProfilesSchema = z.object({
  activeId: z.string().nullable(),
  profiles: z.array(ServerProfileSchema),
})
type Profiles = z.infer<typeof ProfilesSchema>

const KEY = 'oa.profiles.v1'

/** 'p' plus the first 12 hex characters of a UUID. */
export function newProfileId(uuid: string): string {
  return `p${uuid.replace(/-/g, '').toLowerCase().slice(0, 12)}`
}

export interface ProfileRepo {
  /** The active profile, or null when none is saved (or the stored data is unreadable). */
  load(): Promise<ServerProfile | null>
  /** Upserts the profile and makes it the active one. */
  save(profile: ServerProfile): Promise<void>
  /** Patches the active profile (never its id); returns it, or null when there is none. */
  update(patch: Partial<Omit<ServerProfile, 'id'>>): Promise<ServerProfile | null>
}

export function createProfileRepo(kv: KV): ProfileRepo {
  async function read(): Promise<Profiles> {
    const raw = await kv.get(KEY)
    if (raw !== null) {
      try {
        const r = ProfilesSchema.safeParse(JSON.parse(raw))
        if (r.success) return r.data
      } catch {}
    }
    return { activeId: null, profiles: [] }
  }
  const write = (p: Profiles) => kv.set(KEY, JSON.stringify(p))

  return {
    async load() {
      const s = await read()
      return s.profiles.find((p) => p.id === s.activeId) ?? null
    },
    async save(profile) {
      const s = await read()
      const profiles = s.profiles.some((p) => p.id === profile.id)
        ? s.profiles.map((p) => (p.id === profile.id ? profile : p))
        : [...s.profiles, profile]
      await write({ activeId: profile.id, profiles })
    },
    async update(patch) {
      const s = await read()
      const cur = s.profiles.find((p) => p.id === s.activeId)
      if (!cur) return null
      const next: ServerProfile = { ...cur, ...patch, id: cur.id }
      await write({ ...s, profiles: s.profiles.map((p) => (p.id === cur.id ? next : p)) })
      return next
    },
  }
}
