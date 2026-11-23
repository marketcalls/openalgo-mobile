// THROWAWAY SPIKE. Lists every bench result with its pass chip and headline numbers, and copies them all as JSON.
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { type BenchResult, useResults } from '~/core/results';
import { buildExport, clock, keyNumbers, settingsLine } from './summarize';
import { C } from './theme';
import { Button, Card, Chip, Note } from './ui';

function ResultRow({ r }: { r: BenchResult }) {
  const [open, setOpen] = useState(false);
  const nums = keyNumbers(r);
  return (
    <Pressable onPress={() => setOpen((o) => !o)} style={({ pressed }) => [st.row, pressed && { opacity: 0.7 }]}>
      <View style={st.rowHead}>
        <Text style={st.scenario} numberOfLines={1}>
          {r.scenario}
        </Text>
        <Text style={st.time}>{clock(r.at)}</Text>
        <Chip kind={r.pass === true ? 'pass' : r.pass === false ? 'fail' : 'none'} label={r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : '—'} />
      </View>
      <Text style={st.sub}>{settingsLine(r)}</Text>
      <View style={st.nums}>
        {nums.map((n) => (
          <Text key={n.label} style={st.num}>
            <Text style={st.numLabel}>{n.label} </Text>
            {n.value}
          </Text>
        ))}
      </View>
      {r.notes ? <Text style={st.sub}>{r.notes}</Text> : null}
      {open ? (
        <Text style={st.raw} selectable>
          {JSON.stringify({ settings: r.settings, metrics: r.metrics }, null, 1)}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function ResultsCard() {
  const results = useResults((s) => s.results);
  const clear = useResults((s) => s.clear);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;

  const copy = async () => {
    try {
      const json = JSON.stringify(buildExport(results), null, 2);
      await Clipboard.setStringAsync(json);
      setCopyMsg({ ok: true, text: `Copied ${results.length} result(s), ${(json.length / 1024).toFixed(1)} KB, at ${clock(new Date().toISOString())}` });
    } catch (e) {
      setCopyMsg({ ok: false, text: `Copy failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const confirmClear = () =>
    Alert.alert('Clear results?', `This deletes ${results.length} result(s). Copy them first if you need them.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          clear();
          setCopyMsg(null);
        },
      },
    ]);

  return (
    <Card
      title={`Results (${results.length})`}
      right={
        <Text style={st.tally}>
          <Text style={{ color: C.up }}>{passed} pass</Text> · <Text style={{ color: C.down }}>{failed} fail</Text>
        </Text>
      }
    >
      <View style={st.btnRow}>
        <Button label="Copy all as JSON" onPress={copy} />
        <Button label="Clear" kind="danger" onPress={confirmClear} disabled={!results.length} />
      </View>
      {copyMsg ? <Note tone={copyMsg.ok ? 'muted' : 'down'}>{copyMsg.text}</Note> : null}
      <Note>The JSON also includes startup and device info, even when there are no results yet. Results live in memory only: they are lost when the app is killed.</Note>
      {results.length === 0 ? (
        <Text style={st.empty}>No results yet. Run a bench on another tab.</Text>
      ) : (
        [...results].reverse().map((r, i) => <ResultRow key={`${r.at}-${results.length - i}`} r={r} />)
      )}
    </Card>
  );
}

const st = StyleSheet.create({
  tally: { color: C.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  btnRow: { flexDirection: 'row', gap: 10 },
  empty: { color: C.muted, fontSize: 13, paddingVertical: 16, textAlign: 'center' },
  row: { borderTopColor: C.border, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10, marginTop: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scenario: { color: C.text, fontSize: 14, fontWeight: '700', flex: 1 },
  time: { color: C.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  sub: { color: C.muted, fontSize: 12, marginTop: 3 },
  nums: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2, marginTop: 6 },
  num: { color: C.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  numLabel: { color: C.muted, fontSize: 12 },
  raw: { color: C.muted, fontSize: 10, fontFamily: 'monospace', marginTop: 8 },
});
