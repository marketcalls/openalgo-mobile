import type { ProfileStorage } from '~/core/config/storage'
import { DEFAULT_WATCHLISTS, type Watchlists, WatchlistsSchema } from './model'

const NAME = 'watchlists'

/** The saved lists; the first run (or an unreadable value) stores and returns the defaults. */
export async function loadWatchlists(s: ProfileStorage): Promise<Watchlists> {
  const saved = await s.getJSON(NAME, WatchlistsSchema)
  if (saved) return saved
  await s.setJSON(NAME, DEFAULT_WATCHLISTS)
  return DEFAULT_WATCHLISTS
}

export async function saveWatchlists(s: ProfileStorage, w: Watchlists): Promise<void> {
  await s.setJSON(NAME, w)
}
