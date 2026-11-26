// What other features may use of backup: Sign out offers a backup first.
import Constants from 'expo-constants'
import type { ProfileStorage } from '~/core/config/storage'
import { readChartRecords } from '~/dom/gateway/chartStorage'
import type { WatchlistsStore } from '~/market/watchlists/store'
import { backupFileName, type ChartSection, droppedNotice, fitBackup } from './format'
import { shareBackup } from './io'

export { droppedNotice }

/**
 * Builds a backup of the device's watchlists and chart content and opens the share sheet.
 * `dropped` names the chart content left out to keep the file under 2 MB.
 */
export async function backupNow(
  store: WatchlistsStore,
  storage: ProfileStorage,
  now: number = Date.now(),
): Promise<{ dropped: ChartSection[] }> {
  if (!store.getState().loaded) await store.getState().load()
  const { text, dropped } = fitBackup({
    watchlists: store.getState().data,
    chart: await readChartRecords(storage),
    now,
    appVersion: Constants.expoConfig?.version ?? 'unknown',
  })
  await shareBackup(text, backupFileName(now))
  return { dropped }
}
