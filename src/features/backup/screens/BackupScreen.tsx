// Back up and restore the watchlists (design 7.7). A backup file holds the lists only. A restore
// shows what the file holds first and changes nothing until Replace is confirmed or Merge is tapped.
import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { log } from '~/core/log/logger'
import { notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { defaultDeps } from '~/core/services/deps'
import { useServices } from '~/core/services/services'
import { writeChartRecords } from '~/dom/gateway/chartStorage'
import { useTrading, useWatchlists } from '~/market/trading'
import { WATCHLIST_LIMITS, type Watchlists } from '~/market/watchlists/model'
import { Button } from '~/ui/Button'
import { confirm } from '~/ui/confirm'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'
import { applyRestore, type ChartRecords, droppedNotice, parseBackup } from '../format'
import { backupNow } from '../index'
import { pickBackup } from '../io'

export const BACKUP_COPY = {
  intro:
    'A backup holds your watchlists and chart drawings and preferences. It never contains your API key or server address.',
  tooLarge: 'This file is too large to be an OpenAlgo backup.',
  notBackup: "This isn't an OpenAlgo Mobile backup file.",
  createFailed: 'Could not create the backup. Try again.',
  readFailed: 'Could not read that file. Try again.',
  restoreFailed: 'Could not restore the backup. Try again.',
  nothing: 'This backup has nothing to restore.',
  restored: 'Backup restored',
  restoredChart: (n: number) => `Restored ${n} chart ${n === 1 ? 'item' : 'items'}.`,
  chartOnly: (n: number) => `${n} chart ${n === 1 ? 'item' : 'items'}`,
  skipped: (keys: string[]) => `Skipped data this version can't read: ${keys.join(', ')}.`,
  trimmed: (n: number) => `${n} entries were over the limits and were left out.`,
  unlisted: (n: number) =>
    `${n} ${n === 1 ? 'entry names an exchange' : 'entries name an exchange'} OpenAlgo doesn't accept, left out.`,
  leftOut: (n: number) =>
    `Backup restored. ${n} ${n === 1 ? 'list was' : 'lists were'} left out: a phone holds at most ${WATCHLIST_LIMITS.lists} lists.`,
  summary: (lists: number, symbols: number) =>
    `${lists} ${lists === 1 ? 'list' : 'lists'}, ${symbols} ${symbols === 1 ? 'symbol' : 'symbols'}`,
  replaceTitle: (k: number) => `Replace your ${k} ${k === 1 ? 'watchlist' : 'watchlists'}?`,
  replaceBody: 'The lists on this phone are removed and the lists from the file take their place.',
} as const

type Pending = { watchlists: Watchlists | null; chart: ChartRecords; notes: string[] }

export function BackupScreen() {
  const { c } = useTheme()
  const store = useTrading().watchlists
  const { storage } = useServices()
  const current = useWatchlists((w) => w.lists.length)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [dropped, setDropped] = useState<string | null>(null)

  useEffect(() => {
    store
      .getState()
      .load()
      .catch((e) => log.warn('backup', 'could not load the watchlists', e))
  }, [store])

  const fail = (text: string, e?: unknown) => {
    if (e !== undefined) log.warn('backup', text, e)
    notifyWarning()
    setError(text)
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    setDropped(null)
    try {
      const r = await backupNow(store, storage, defaultDeps.now())
      setDropped(droppedNotice(r.dropped))
    } catch (e) {
      fail(BACKUP_COPY.createFailed, e)
    } finally {
      setBusy(false)
    }
  }

  const choose = async () => {
    setBusy(true)
    setError(null)
    setPending(null)
    try {
      const text = await pickBackup()
      if (text === null) return
      const r = parseBackup(text, defaultDeps.uuid)
      if (!r.ok)
        return fail(r.reason === 'too_large' ? BACKUP_COPY.tooLarge : BACKUP_COPY.notBackup)
      const notes: string[] = []
      if (r.skipped.length > 0) notes.push(BACKUP_COPY.skipped(r.skipped))
      if (r.trimmed > 0) notes.push(BACKUP_COPY.trimmed(r.trimmed))
      if (r.unlisted > 0) notes.push(BACKUP_COPY.unlisted(r.unlisted))
      setPending({
        watchlists: r.file.content.watchlists ?? null,
        chart: {
          drawings: r.file.content.chartDrawings ?? [],
          prefs: r.file.content.chartPrefs ?? [],
        },
        notes,
      })
    } catch (e) {
      fail(BACKUP_COPY.readFailed, e)
    } finally {
      setBusy(false)
    }
  }

  /** Restores the file's lists (when it has any) and chart records: same key replaced, the rest kept. */
  const restore = async (
    incoming: Watchlists | null,
    chart: ChartRecords,
    mode: 'replace' | 'merge',
  ) => {
    setBusy(true)
    setError(null)
    try {
      let leftOut = 0
      if (incoming) {
        await store.getState().apply((w) => {
          const r = applyRestore(w, incoming, mode, defaultDeps.uuid)
          leftOut = r.leftOut
          return { next: r.value, result: 'ok' as const }
        })
      }
      const items = await writeChartRecords(storage, chart)
      setPending(null)
      const chartNote = items > 0 ? BACKUP_COPY.restoredChart(items) : null
      if (leftOut > 0) {
        const text = [BACKUP_COPY.leftOut(leftOut), chartNote].filter(Boolean).join(' ')
        notifyWarning()
        setError(text)
        toast(text)
      } else {
        notifySuccess()
        toast(chartNote ?? BACKUP_COPY.restored)
      }
    } catch (e) {
      fail(BACKUP_COPY.restoreFailed, e)
    } finally {
      setBusy(false)
    }
  }

  const replace = async (incoming: Watchlists, chart: ChartRecords) => {
    const ok = await confirm(
      BACKUP_COPY.replaceTitle(current),
      BACKUP_COPY.replaceBody,
      'Replace',
      {
        destructive: true,
      },
    )
    if (ok) await restore(incoming, chart, 'replace')
  }

  const found = pending?.watchlists ?? null
  const chartItems = pending ? pending.chart.drawings.length + pending.chart.prefs.length : 0
  return (
    <ScrollView contentContainerStyle={styles.body} testID="backup-screen">
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Back up and restore',
          headerStyle: { backgroundColor: c.background },
          headerTintColor: c.foreground,
          headerShadowVisible: false,
        }}
      />
      <Text>{BACKUP_COPY.intro}</Text>
      <Button
        testID="backup-create"
        title="Create a backup"
        loading={busy}
        onPress={() => void create()}
      />
      <Button
        testID="backup-restore"
        title="Restore from a file"
        variant="secondary"
        loading={busy}
        onPress={() => void choose()}
      />
      {error ? (
        <Text testID="backup-error" style={{ color: c.destructive }}>
          {error}
        </Text>
      ) : null}
      {dropped ? (
        <Text testID="backup-dropped" variant="caption" tone="muted">
          {dropped}
        </Text>
      ) : null}
      {pending ? (
        <View style={styles.group} testID="backup-found">
          <Text variant="heading" testID="backup-summary">
            {[
              found
                ? BACKUP_COPY.summary(
                    found.lists.length,
                    found.lists.reduce((n, l) => n + l.items.length, 0),
                  )
                : null,
              chartItems > 0 ? BACKUP_COPY.chartOnly(chartItems) : null,
            ]
              .filter(Boolean)
              .join(', ') || BACKUP_COPY.nothing}
          </Text>
          {pending.notes.map((n) => (
            <Text key={n} variant="caption" tone="muted" testID="backup-note">
              {n}
            </Text>
          ))}
          {found ? (
            <>
              <Button
                testID="restore-replace"
                title="Replace my watchlists"
                variant="destructive"
                loading={busy}
                onPress={() => void replace(found, pending.chart)}
              />
              <Button
                testID="restore-merge"
                title="Add to my watchlists"
                variant="secondary"
                loading={busy}
                onPress={() => void restore(found, pending.chart, 'merge')}
              />
            </>
          ) : chartItems > 0 ? (
            <Button
              testID="restore-chart"
              title="Restore chart items"
              loading={busy}
              onPress={() => void restore(null, pending.chart, 'merge')}
            />
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  group: { gap: 12 },
})
