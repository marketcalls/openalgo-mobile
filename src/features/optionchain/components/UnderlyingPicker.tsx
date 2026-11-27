// The underlying picker (design 7.8, ux OC-10): search first. The exchanges are the broker's F&O
// exchanges the master covers; the names are what the symbol master lists now (today's, else an
// earlier day's, else the web's defaults, never waiting for a download). On the defaults alone the
// search field also asks /api/v1/search, 300 ms after the last key, and offers the distinct
// underlyings of what it finds.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useServices } from '~/core/services/services'
import { useSymbolSearch } from '~/features/search'
import { brokerCaps } from '~/market/brokers/seed'
import { MASTER_EXCHANGES } from '~/market/master/master'
import { extractUnderlying } from '~/market/master/underlying'
import { useBroker } from '~/market/session'
import { useTrading } from '~/market/trading'
import { BottomSheet } from '~/ui/BottomSheet'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { type ChainTarget, pickerList } from '../model'

type Listing = { exchange: string; list: string[]; source: 'today' | 'earlier' | 'defaults' }

export function UnderlyingPicker(p: {
  target: ChainTarget
  onPick(t: ChainTarget): void
  onClose(): void
}) {
  const { c } = useTheme()
  const s = useServices()
  const { master } = useTrading()
  const broker = useBroker()
  const caps = useSyncExternalStore(s.caps.subscribe, s.caps.get)
  const exchanges = useMemo(() => {
    const own = brokerCaps(broker, caps?.version ?? null).supported_exchanges
    const fo = own.filter((e) => (MASTER_EXCHANGES as readonly string[]).includes(e))
    return fo.includes(p.target.optionsExchange) ? fo : [p.target.optionsExchange, ...fo]
  }, [broker, caps, p.target.optionsExchange])
  const [exchange, setExchange] = useState(p.target.optionsExchange)
  const [query, setQuery] = useState('')

  const [listing, setListing] = useState<Listing | null>(null)
  useEffect(() => {
    let live = true
    void master.underlyingsNow(exchange).then((r) => {
      if (live) setListing({ exchange, ...r })
    })
    return () => {
      live = false
    }
  }, [master, exchange])
  const shown = listing?.exchange === exchange ? listing : null

  const search = useSymbolSearch(shown?.source === 'defaults' ? query : '', exchange)
  const names = useMemo(() => {
    const found = search.rows
      .map((r) => extractUnderlying(r.symbol, r.exchange))
      .filter((u): u is string => u !== null)
    return pickerList([...(shown?.list ?? []), ...found], query)
  }, [shown, search.rows, query])

  return (
    <View style={StyleSheet.absoluteFill}>
      <BottomSheet
        testID="oc-underlying-sheet"
        snapPoints={[1]}
        persistTaps
        onClose={p.onClose}
        header={
          <View style={styles.head}>
            <TextInput
              testID="oc-pick-search"
              autoFocus
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="Search underlying"
              placeholderTextColor={c.mutedForeground}
              value={query}
              onChangeText={setQuery}
              style={[styles.input, { color: c.foreground, borderColor: c.border }]}
            />
            <View style={styles.chips}>
              {exchanges.map((e) => (
                <Pressable
                  key={e}
                  testID={`oc-exchange-${e}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: e === exchange }}
                  hitSlop={6}
                  onPress={() => setExchange(e)}
                  style={[
                    styles.chip,
                    { borderColor: c.border },
                    e === exchange && { backgroundColor: c.primary },
                  ]}
                >
                  <Text style={[styles.chipText, e === exchange && { color: c.primaryForeground }]}>
                    {e}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        }
      >
        {names.map((u) => {
          const selected = u === p.target.underlying && exchange === p.target.optionsExchange
          return (
            <Pressable
              key={u}
              testID={`oc-pick-${u}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => p.onPick({ optionsExchange: exchange, underlying: u })}
              style={[
                styles.row,
                { borderBottomColor: c.border },
                selected && { backgroundColor: c.accent },
              ]}
            >
              <Text style={selected ? styles.bold : undefined}>{u}</Text>
            </Pressable>
          )
        })}
        {shown && names.length === 0 && !search.loading ? (
          <Text tone="muted" style={styles.none}>
            No underlying matches {query.trim().toUpperCase()}.
          </Text>
        ) : null}
      </BottomSheet>
    </View>
  )
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  input: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  row: {
    minHeight: 48,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bold: { fontWeight: '700' },
  none: { padding: 16 },
})
