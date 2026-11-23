// THROWAWAY SPIKE. Native option chain screen: 40 NIFTY strikes in a FlashList v2
// with per-symbol ticking halves, cheap ATM/ITM shading, and a scripted 20 s
// programmatic-scroll benchmark ('chain:scroll').
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useIsFocused } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isBenchRunning, runBench } from '~/core/bench';
import { getQuote, QuotesPausedContext, subscribeKey } from '~/core/tickStore';
import { BenchBanner, UnderlyingHeader } from './ChainHeader';
import { ChainColumns, ChainRow } from './ChainRow';
import { bandCode, C, decodeBand, ROW_H, ROWS, type Row, UNDER_KEY } from './ui';

// One subscription to the underlying. The snapshot is the packed ATM/ITM band
// (a number), so useSyncExternalStore re-renders this screen only when the band
// changes, not on every NIFTY tick. The band goes to FlashList as extraData; the
// memo'd rows whose ceItm/peItm/atm props are unchanged bail out.
const subscribeUnderlying = (fn: () => void) => subscribeKey(UNDER_KEY, fn);
// While another tab is visible the band is not tracked (see QuotesPausedContext).
const subscribeNothing = () => () => {};
const bandSnapshot = () => bandCode(getQuote(UNDER_KEY)?.ltp);

function renderItem({ item, extraData }: ListRenderItemInfo<Row>) {
  const { atm, lt, le } = decodeBand(extraData as number);
  return <ChainRow row={item} ceItm={item.i < lt} peItm={item.i >= le} atm={item.i === atm} />;
}
const keyExtractor = (r: Row) => String(r.strike);

const BENCH_MS = 20_000;
const SWEEP_MS = 5_000; // one top-to-bottom sweep; triangle wave period is 2x this

export default function ChainScreen() {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const listRef = useRef<FlashListRef<Row>>(null);
  const viewportH = useRef(0);
  const bandMoves = useRef(0);
  const band = useSyncExternalStore(focused ? subscribeUnderlying : subscribeNothing, bandSnapshot);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    bandMoves.current++;
  }, [band]);

  const onListLayout = (e: LayoutChangeEvent) => {
    viewportH.current = e.nativeEvent.layout.height;
  };

  const runScrollBench = async () => {
    if (isBenchRunning()) return;
    setRunning(true);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    let range = -1;
    let seenMax = 0;
    let movesAtStart = 0;
    try {
      await runBench({
        scenario: 'chain:scroll',
        durationMs: BENCH_MS,
        drive: (el) => {
          const list = listRef.current;
          if (!list) return;
          if (range < 0) {
            // Measured once, after runBench's 1 s settle, from the live list.
            const content = list.getChildContainerDimensions().height || ROWS.length * ROW_H;
            const win = list.getWindowSize().height || viewportH.current;
            range = Math.max(0, Math.round(content - win));
            movesAtStart = bandMoves.current;
          }
          const p = (el % (2 * SWEEP_MS)) / SWEEP_MS;
          list.scrollToOffset({ offset: (p <= 1 ? p : 2 - p) * range, animated: false });
          // Last offset reported by onScroll: proves the list really moved.
          const seen = list.getAbsoluteLastScrollOffset();
          if (seen > seenMax) seenMax = seen;
        },
        collectExtra: () => ({
          scrollRangeDp: Math.max(0, range),
          observedMaxOffsetDp: Math.round(seenMax),
          sweepMs: SWEEP_MS,
          rows: ROWS.length,
          rowHeightDp: ROW_H,
          viewportDp: Math.round(viewportH.current),
          atmBandChanges: bandMoves.current - movesAtStart,
        }),
      });
    } catch (e) {
      // try/catch rather than try/finally: React Compiler cannot compile a bare finally.
      console.warn('chain:scroll bench failed', e);
    }
    setRunning(false);
  };

  return (
    // Extra 22 dp on top keeps the HUD (absolute, top-right) off the header.
    <QuotesPausedContext value={!focused}>
      <View style={[s.screen, { paddingTop: insets.top + 22 }]}>
        <UnderlyingHeader />
        <View style={s.actions}>
          <Pressable
            onPress={runScrollBench}
            disabled={running}
            style={({ pressed }) => [s.btn, (pressed || running) && s.btnDim]}
          >
            <Text style={s.btnTxt}>{running ? 'Running…' : 'Run scroll bench (20 s)'}</Text>
          </Pressable>
        </View>
        <BenchBanner running={running} />
        <View style={s.table}>
          <ChainColumns />
          <View style={s.listWrap} onLayout={onListLayout}>
            <FlashList
              ref={listRef}
              data={ROWS}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              extraData={band}
            />
          </View>
        </View>
      </View>
    </QuotesPausedContext>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  actions: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8 },
  btn: {
    flex: 1,
    backgroundColor: C.accent,
    borderRadius: 6,
    paddingVertical: 9,
    alignItems: 'center',
  },
  btnDim: { opacity: 0.55 },
  btnTxt: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  table: { flex: 1, marginTop: 6 },
  listWrap: { flex: 1 },
});
