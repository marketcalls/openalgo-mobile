// The index strip's choices and the user's pick (design 7.7): one to four of four indices, kept
// in profile storage as `indexStrip`, and whether the strip is open (`indexStripOpen`, design
// 17.1). Pure helpers plus the loads and saves.
import { z } from 'zod'
import type { ProfileStorage } from '~/core/config/storage'

export type IndexChoice = { exchange: string; symbol: string; key: string }

const choice = (exchange: string, symbol: string): IndexChoice => ({
  exchange,
  symbol,
  key: `${exchange}:${symbol}`,
})

/** The four indices on offer, in the order the strip shows them. */
export const INDEX_CHOICES: readonly IndexChoice[] = [
  choice('NSE_INDEX', 'NIFTY'),
  choice('NSE_INDEX', 'BANKNIFTY'),
  choice('BSE_INDEX', 'SENSEX'),
  choice('NSE_INDEX', 'INDIAVIX'),
]

export const DEFAULT_INDEX_STRIP: readonly string[] = ['NSE_INDEX:NIFTY', 'BSE_INDEX:SENSEX']

const NAME = 'indexStrip'
const KEYS = INDEX_CHOICES.map((i) => i.key)

/** Keeps the known keys once each, in the choices' order; the default when none is left. */
export function normalizeStrip(keys: readonly string[]): string[] {
  const kept = KEYS.filter((k) => keys.includes(k))
  return kept.length > 0 ? kept : [...DEFAULT_INDEX_STRIP]
}

/** Adds the index if absent, removes it if present; the last one stays. */
export function toggleIndex(strip: readonly string[], key: string): string[] {
  if (!KEYS.includes(key)) return [...strip]
  if (!strip.includes(key)) return normalizeStrip([...strip, key])
  return strip.length <= 1 ? [...strip] : strip.filter((k) => k !== key)
}

export async function loadIndexStrip(s: ProfileStorage): Promise<string[]> {
  const saved = await s.getJSON(NAME, z.array(z.string()))
  return saved ? normalizeStrip(saved) : [...DEFAULT_INDEX_STRIP]
}

export const saveIndexStrip = (s: ProfileStorage, strip: readonly string[]): Promise<void> =>
  s.setJSON(NAME, strip)

const OPEN = 'indexStripOpen'

/** Whether the strip shows its chips; open unless the user collapsed it. */
export async function loadIndexStripOpen(s: ProfileStorage): Promise<boolean> {
  return (await s.getJSON(OPEN, z.boolean())) ?? true
}

export const saveIndexStripOpen = (s: ProfileStorage, open: boolean): Promise<void> =>
  s.setJSON(OPEN, open)
