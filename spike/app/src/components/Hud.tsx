// THROWAWAY SPIKE. Always-on probe + tiny HUD. UiFpsProbe must stay mounted for UI
// thread numbers to exist; it is rendered once in the root layout.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { peekLive, registerUiCounters, startJsSampler } from '~/core/metrics';
import { useSettings } from '~/core/settings';

export function UiFpsProbe() {
  const frames = useSharedValue(0);
  const sum = useSharedValue(0);
  const max = useSharedValue(0);
  const slow = useSharedValue(0);
  const frozen = useSharedValue(0);
  const hist = useSharedValue<number[]>(new Array(26).fill(0));

  useEffect(() => {
    registerUiCounters({ frames, sum, max, slow, frozen, hist });
    startJsSampler();
    return () => registerUiCounters(null);
  }, [frames, sum, max, slow, frozen, hist]);

  useFrameCallback((info) => {
    'worklet';
    const dt = info.timeSincePreviousFrame;
    if (dt == null || dt <= 0) return;
    frames.value += 1;
    sum.value += dt;
    if (dt > max.value) max.value = dt;
    if (dt > 25) slow.value += 1;
    if (dt > 100) frozen.value += 1;
    const b = Math.min(25, Math.floor(dt / 4));
    hist.modify((h) => {
      'worklet';
      h[b] += 1;
      return h;
    });
  });

  return null;
}

export function Hud() {
  const [live, setLive] = useState({ jsFps: 0, uiFps: null as number | null });
  const status = useSettings((s) => s.status);
  useEffect(() => {
    const id = setInterval(() => setLive(peekLive()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <View pointerEvents="none" style={styles.hud}>
      <Text style={styles.txt}>
        JS {live.jsFps} | UI {live.uiFps ?? '-'} | {status.state}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hud: {
    position: 'absolute',
    top: 4,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    zIndex: 1000,
  },
  txt: { color: '#9fe870', fontSize: 10, fontVariant: ['tabular-nums'] },
});
