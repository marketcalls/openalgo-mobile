import { StyleSheet, View } from 'react-native'
import type { FeedState } from '~/core/realtime/types'
import type { BrokerSession } from '~/core/services/connection'
import { Badge } from './Badge'

/**
 * The connection badges, in a fixed order: transport, feed, broker session, then the mode. A
 * screen whose header already shows the mode (the chart, a tool) passes `mode={false}`, so the
 * screen shows one LIVE or ANALYZE badge, not two.
 */
export function StatusBadges({
  transport,
  feed,
  brokerSession,
  analyzer,
  mode = true,
}: {
  transport: 'https' | 'http'
  feed: FeedState
  brokerSession: BrokerSession
  analyzer: 'live' | 'analyze' | 'unknown'
  mode?: boolean
}) {
  return (
    <View style={styles.row}>
      {transport === 'http' ? (
        <Badge testID="badge-http" label="Not encrypted" tone="warning" />
      ) : null}
      {feed === 'polling' ? <Badge testID="badge-polling" label="Polling" tone="warning" /> : null}
      {brokerSession === 'logged_out' ? (
        <Badge testID="badge-broker" label="Broker logged out" tone="danger" />
      ) : null}
      {!mode ? null : analyzer === 'live' ? (
        <Badge testID="mode-badge" label="LIVE" tone="danger" />
      ) : analyzer === 'analyze' ? (
        <Badge testID="mode-badge" label="ANALYZE" tone="analyze" />
      ) : (
        <Badge testID="mode-badge" label="—" tone="neutral" />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
})
