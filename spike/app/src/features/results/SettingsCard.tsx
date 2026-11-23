// THROWAWAY SPIKE. Feed and flush settings for benchmark runs; every change goes through useSettings().set(patch).
import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { isBenchRunning } from '~/core/bench';
import { type FeedMode, useSettings } from '~/core/settings';
import type { FlushMode } from '~/core/tickStore';
import { C } from './theme';
import { Button, Card, Label, Note, Segmented } from './ui';

const RATES = [100, 300, 1000, 2000];

const FLUSH_HELP: Record<FlushMode, string> = {
  raf: 'raf: publish once per frame (the intended design).',
  interval250: 'interval250: publish 4 times a second (what a throttled UI would do).',
  immediate: 'immediate: publish every tick as it arrives (the naive baseline, expected to be slow).',
};

const STATE_COLOR: Record<string, string> = {
  streaming: C.up,
  authenticated: C.up,
  connecting: C.warn,
  idle: C.muted,
  closed: C.muted,
  error: C.down,
};

/** Changing the feed mid-run would mix two settings into one result. */
function guard(): boolean {
  if (!isBenchRunning()) return true;
  Alert.alert('Benchmark running', 'Wait for the current benchmark to finish before changing settings.');
  return false;
}

export function SettingsCard() {
  const feedMode = useSettings((s) => s.feedMode);
  const simRate = useSettings((s) => s.simRate);
  const flushMode = useSettings((s) => s.flushMode);
  const status = useSettings((s) => s.status);
  const set = useSettings((s) => s.set);

  // Drafts: set() restarts the feed on every wsUrl/apiKey change, so the text
  // fields are only committed when the user taps the button.
  const [url, setUrl] = useState(() => useSettings.getState().wsUrl);
  const [key, setKey] = useState(() => useSettings.getState().apiKey);
  const urlOk = /^wss?:\/\/[^\s/]+/.test(url.trim());

  const useWs = () => {
    if (!guard()) return;
    if (!urlOk) {
      Alert.alert('WebSocket URL', 'Enter a URL like ws://192.168.1.23:8765');
      return;
    }
    set({ feedMode: 'ws', wsUrl: url.trim(), apiKey: key });
  };

  const onFeed = (m: FeedMode) => {
    if (m === 'ws') return useWs();
    if (guard()) set({ feedMode: 'sim' });
  };

  return (
    <Card title="Feed">
      <View style={st.statusRow}>
        <View style={[st.dot, { backgroundColor: STATE_COLOR[status.state] ?? C.muted }]} />
        <Text style={st.statusTxt} numberOfLines={2}>
          {status.state}
          {status.detail ? ` · ${status.detail}` : ''}
        </Text>
      </View>

      <Label>Source</Label>
      <Segmented<FeedMode>
        options={[
          { label: 'Sim', value: 'sim' },
          { label: 'WebSocket', value: 'ws' },
        ]}
        value={feedMode}
        onChange={onFeed}
      />

      <Label>Sim rate (ticks/s, all symbols)</Label>
      <Segmented<number>
        options={RATES.map((r) => ({ label: String(r), value: r }))}
        value={simRate}
        onChange={(r) => {
          if (guard()) set({ simRate: r });
        }}
        disabled={feedMode !== 'sim'}
      />
      {feedMode !== 'sim' ? <Note>In WebSocket mode the server sets the rate (mock-feed: RATE env).</Note> : null}

      <Label>WebSocket URL</Label>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder="ws://192.168.1.23:8765"
        placeholderTextColor={C.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={[st.input, !urlOk && url.length > 0 && { borderColor: C.down }]}
      />
      <Label>API key</Label>
      <TextInput
        value={key}
        onChangeText={setKey}
        placeholder="any key for mock-feed"
        placeholderTextColor={C.muted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={st.input}
      />
      <Note>The key stays in memory for this session only. The spike never saves it and never puts it in the copied JSON.</Note>
      <View style={st.btnRow}>
        <Button label={feedMode === 'ws' ? 'Reconnect' : 'Use WebSocket'} onPress={useWs} />
      </View>

      <Label>Flush mode</Label>
      <Segmented<FlushMode>
        options={[
          { label: 'raf', value: 'raf' },
          { label: 'interval250', value: 'interval250' },
          { label: 'immediate', value: 'immediate' },
        ]}
        value={flushMode}
        onChange={(m) => {
          if (guard()) set({ flushMode: m });
        }}
      />
      <Note>{FLUSH_HELP[flushMode]}</Note>
    </Card>
  );
}

const st = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusTxt: { color: C.text, fontSize: 13, flexShrink: 1, fontVariant: ['tabular-nums'] },
  input: {
    color: C.text,
    backgroundColor: C.bg,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
  },
  btnRow: { flexDirection: 'row', marginTop: 10 },
});
