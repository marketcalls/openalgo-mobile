// What other features may use of backup: Sign out offers a backup first.
import Constants from 'expo-constants'
import type { WatchlistsStore } from '~/market/watchlists/store'
import { backupFileName, buildBackup } from './format'
import { shareBackup } from './io'

/** Builds a backup of the device's watchlists and opens the share sheet. */
export async function backupNow(store: WatchlistsStore, now: number = Date.now()): Promise<void> {
  if (!store.getState().loaded) await store.getState().load()
  const text = buildBackup({
    watchlists: store.getState().data,
    now,
    appVersion: Constants.expoConfig?.version ?? 'unknown',
  })
  await shareBackup(text, backupFileName(now))
}
