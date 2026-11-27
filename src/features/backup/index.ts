// What other features may use of backup: Sign out offers a backup first.
import Constants from 'expo-constants'
import type { ProfileStorage } from '~/core/config/storage'
import { readChartRecords } from '~/dom/gateway/chartStorage'
import type { StrategyStore } from '~/market/strategies/store'
import type { WatchlistsStore } from '~/market/watchlists/store'
import { type BackupSection, backupFileName, droppedNotice, fitBackup } from './format'
import { shareBackup } from './io'

export { droppedNotice }

/**
 * Builds a backup of the device's watchlists, chart content and strategies and opens the share sheet.
 * `dropped` names the content left out to keep the file under 2 MB.
 */
export async function backupNow(
  store: WatchlistsStore,
  storage: ProfileStorage,
  now: number = Date.now(),
  strategies?: StrategyStore,
): Promise<{ dropped: BackupSection[] }> {
  if (!store.getState().loaded) await store.getState().load()
  const { text, dropped } = fitBackup({
    watchlists: store.getState().data,
    chart: await readChartRecords(storage),
    strategies: strategies ? await strategies.all() : [],
    now,
    appVersion: Constants.expoConfig?.version ?? 'unknown',
  })
  await shareBackup(text, backupFileName(now))
  return { dropped }
}
