// THROWAWAY SPIKE. Results/settings tab: how to run the benches, feed settings, startup, device, and the copyable results log.
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DeviceCard, StartupCard } from './InfoCards';
import { ResultsCard } from './ResultsCard';
import { SettingsCard } from './SettingsCard';
import { C } from './theme';
import { Card } from './ui';

const STEPS = [
  'Force-stop the app (Settings › Apps › OpenAlgo Spike › Force stop), reopen it and wait 5 s. Startup below is now a cold-start lower bound.',
  'Here: Feed = Sim, rate 300, flush raf (the defaults).',
  'Chart tab (the feature in scope): its first open is recorded automatically. Wait for "Ready in …", press Open time 3 times, then run the pan bench with Ticks in-DOM and again via bridge. Tap BUY and SELL on the chart once each.',
  'Watchlist tab: run the scroll bench with Flash on, then Flash off.',
  'Chain tab: run the scroll bench. Tool tab (/tools is in phase-1 scope): Open Max Pain 3 times, then use the page by hand.',
  'Set rate 1000 and run the chart pan bench (in-DOM) and the watchlist bench (Flash on) again.',
  'Optional: flush = immediate, one watchlist bench, then back to raf. Optional: spike/mock-feed over WebSocket (see spike/README.md).',
  'Do not touch the screen while a bench runs. Tap “Copy all as JSON” and paste it back with the phone model and how the chart felt to pan and zoom by hand.',
];

function HowTo() {
  return (
    <Card title="How to test">
      {STEPS.map((t, i) => (
        <View key={i} style={st.step}>
          <Text style={st.stepNo}>{i + 1}.</Text>
          <Text style={st.stepTxt}>{t}</Text>
        </View>
      ))}
    </Card>
  );
}

export default function ResultsScreen() {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={st.root}
      contentContainerStyle={{
        // Extra top space keeps the HUD (top-right) clear of the content.
        paddingTop: insets.top + 30,
        paddingBottom: insets.bottom + 32,
        paddingLeft: insets.left + 12,
        paddingRight: insets.right + 12,
      }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <Text style={st.h1}>Results & settings</Text>
      {__DEV__ ? <Text style={st.devBanner}>DEV build. Benchmark the release APK, not this one.</Text> : null}
      <HowTo />
      <SettingsCard />
      <ResultsCard />
      <StartupCard />
      <DeviceCard />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  h1: { color: C.text, fontSize: 22, fontWeight: '800', marginBottom: 12 },
  devBanner: {
    color: '#ffffff',
    backgroundColor: C.down,
    borderRadius: 8,
    padding: 8,
    marginBottom: 12,
    fontSize: 13,
    fontWeight: '700',
  },
  step: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  stepNo: { color: C.accent, fontSize: 13, fontWeight: '700', width: 18, fontVariant: ['tabular-nums'] },
  stepTxt: { color: C.text, fontSize: 13, lineHeight: 18, flex: 1 },
});
