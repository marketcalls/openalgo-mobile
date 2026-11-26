// The day's quote at the foot of the instrument sheet, shown once it is at full height (design
// 17.2). Brokers send different fields, so each figure shows only when the quote carries it. It
// reads the quote the sheet's one subscription brings (ruling 31).
import { StyleSheet, View } from 'react-native'
import { istClock } from '~/core/realtime/marketHours'
import { type Quote, quoteKey } from '~/core/realtime/protocol'
import { useFeedStale, useQuote } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { usesLots } from '~/market/instruments/exchanges'
import { fmtPrice, fmtQty } from '~/ui/format'
import { Text } from '~/ui/Text'

type Figure = { id: string; label: string; value: string }

const pad = (n: number) => String(n).padStart(2, '0')

/** `HH:MM:SS` in IST, whatever the device time zone. */
const istTime = (ms: number) => {
  const { hh, mm, ss } = istClock(ms)
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`
}

/** The figures the quote carries, in the order they show; OI only where contracts trade in lots. */
function figures(q: Quote | undefined, lots: boolean): Figure[] {
  const out: Figure[] = []
  const add = (id: string, label: string, v: number | undefined, fmt: (n: number) => string) => {
    if (v !== undefined) out.push({ id, label, value: fmt(v) })
  }
  add('open', 'Open', q?.open, fmtPrice)
  add('high', 'High', q?.high, fmtPrice)
  add('low', 'Low', q?.low, fmtPrice)
  add('close', 'Prev close', q?.close, fmtPrice)
  add('volume', 'Volume', q?.volume, fmtQty)
  add('avg', 'Avg price', q?.avgPrice, fmtPrice)
  add('ltq', 'Last qty', q?.lastQty, fmtQty)
  add('ltt', 'Last trade', q?.ltt, istTime)
  if (lots) add('oi', 'OI', q?.oi, fmtQty)
  add('lc', 'Lower circuit', q?.lowerCircuit, fmtPrice)
  add('uc', 'Upper circuit', q?.upperCircuit, fmtPrice)
  return out
}

export function QuoteDetails({ exchange, symbol }: { exchange: string; symbol: string }) {
  const active = useScreenActive()
  const q = useQuote(quoteKey(exchange, symbol), active)
  const stale = useFeedStale()
  return (
    <View testID="inst-quote-details" style={[styles.grid, { opacity: stale ? 0.5 : 1 }]}>
      {figures(q, usesLots(exchange)).map((f) => (
        <View key={f.id} style={styles.cell}>
          <Text variant="caption" tone="muted">
            {f.label}
          </Text>
          <Text variant="mono" testID={`inst-q-${f.id}`}>
            {f.value}
          </Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 },
  cell: { width: '33%', gap: 2 },
})
