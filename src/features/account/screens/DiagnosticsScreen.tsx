// Diagnostics (design 7.2): what the app sees, as one redacted report that can be copied.

import * as Clipboard from 'expo-clipboard'
import Constants from 'expo-constants'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { getLogLines } from '~/core/log/logger'
import { useServices } from '~/core/services/services'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { ScreenHeader } from '../components/ScreenHeader'
import { buildDiagnostics, DIAGNOSTIC_LOG_LINES, serializeDiagnostics } from '../diagnostics'

export function DiagnosticsScreen() {
  const s = useServices()
  const { c } = useTheme()
  const [copied, setCopied] = useState(false)
  // a snapshot, taken when the screen opens or "Refresh" is pressed
  const [report, setReport] = useState(() => snapshot(s))

  const copy = async () => {
    await Clipboard.setStringAsync(serializeDiagnostics(report))
    setCopied(true)
  }

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <ScreenHeader title="Diagnostics" />
      <Section title="Server">
        <Text variant="mono">{`App ${report.appVersion}`}</Text>
        <Text variant="mono">{`${report.server.origin} (${report.server.version ?? 'version unknown'})`}</Text>
        <Text variant="mono">{`Broker ${report.server.broker ?? 'unknown'}`}</Text>
      </Section>
      <Section title="Capabilities">
        {report.capabilities.length === 0 ? <Text tone="muted">Not probed yet</Text> : null}
        {report.capabilities.map((row) => (
          <Text key={row.feature} variant="caption" testID={`cap-${row.feature}`}>
            {`${row.on ? 'on ' : 'off'}  ${row.feature}: ${row.reason}`}
          </Text>
        ))}
      </Section>
      <Section title="Live feed">
        <Text variant="mono">{`${report.feed.state}, mode ${report.server.feedMode}`}</Text>
        <Text variant="caption">{`failures ${report.feed.failures}, last close ${report.feed.lastCloseCode ?? 'none'}`}</Text>
      </Section>
      <Section title="Requests">
        <Text variant="caption">{`started ${report.scheduler.started}, deduped ${report.scheduler.deduped}, rate limited ${report.scheduler.rateLimited}, in flight ${report.scheduler.inFlight}${report.scheduler.paused ? ', paused' : ''}${report.scheduler.halted ? ', halted' : ''}`}</Text>
      </Section>
      <Section title="Quote store">
        <Text variant="caption">{`${report.store.keys} keys, ${report.store.ticksIn} ticks, ${report.store.flushes} flushes`}</Text>
      </Section>
      <Section title={`Last ${DIAGNOSTIC_LOG_LINES} log lines`}>
        {report.logs.length === 0 ? <Text tone="muted">No log lines</Text> : null}
        {report.logs.map((line, i) => (
          // lines repeat, and the list is fixed per snapshot
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          <Text key={i} variant="caption" style={{ color: c.mutedForeground }}>
            {line}
          </Text>
        ))}
      </Section>
      <Button
        testID="diagnostics-copy"
        title={copied ? 'Copied' : 'Copy diagnostics'}
        onPress={() => void copy()}
      />
      <Button
        testID="diagnostics-refresh"
        title="Refresh"
        variant="secondary"
        onPress={() => {
          setCopied(false)
          setReport(snapshot(s))
        }}
      />
    </ScrollView>
  )
}

function snapshot(s: ReturnType<typeof useServices>) {
  const p = s.profile.get()
  return buildDiagnostics({
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    server: {
      origin: p.restOrigin,
      version: p.serverVersion,
      broker: p.broker,
      feedMode: p.feedMode,
      wsUrl: p.wsUrl,
    },
    caps: s.caps.get(),
    feed: s.realtime.status(),
    scheduler: s.scheduler.stats(),
    store: s.store.stats(),
    logs: getLogLines(DIAGNOSTIC_LOG_LINES),
  })
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="heading">{title}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  section: { gap: 4 },
})
