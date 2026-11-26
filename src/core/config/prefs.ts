import { z } from 'zod'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { persistStorage } from './bindings'
import { DEFAULT_LOCK_AFTER_MS } from './constants'

/** Every field falls back to its default, so a corrupt stored value never reaches the app. */
const PrefsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).catch('system'),
  appLock: z.boolean().catch(true),
  lockAfterMs: z
    .union([z.literal(60_000), z.literal(300_000), z.literal(900_000)])
    .catch(DEFAULT_LOCK_AFTER_MS),
  hideContentAndroid: z.boolean().catch(false),
  confirmLiveWrites: z.boolean().catch(false),
  updateCheck: z.boolean().catch(true),
})
export type Prefs = z.infer<typeof PrefsSchema>

export const PREFS_DEFAULTS: Prefs = PrefsSchema.parse({})

type PrefsStore = Prefs & { setPrefs: (patch: Partial<Prefs>) => void }

export const usePrefs = create<PrefsStore>()(
  persist(
    (set) => ({
      ...PREFS_DEFAULTS,
      setPrefs: (patch) => set(patch),
    }),
    {
      name: 'oa.prefs.v1',
      storage: persistStorage,
      partialize: ({
        theme,
        appLock,
        lockAfterMs,
        hideContentAndroid,
        confirmLiveWrites,
        updateCheck,
      }) => ({
        theme,
        appLock,
        lockAfterMs,
        hideContentAndroid,
        confirmLiveWrites,
        updateCheck,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...PrefsSchema.parse(persisted && typeof persisted === 'object' ? persisted : {}),
      }),
    },
  ),
)
