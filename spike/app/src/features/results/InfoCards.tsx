// THROWAWAY SPIKE. Startup timing (vs the cold-start bar) and device facts, shown so every pasted result has its context.
import { useEffect, useState } from 'react';
import { deviceInfo, getStartup } from '~/core/metrics';
import { PASS } from '~/core/results';
import { deviceExtra, STARTUP_NOTE } from './summarize';
import { C } from './theme';
import { Card, Chip, KV, Note } from './ui';

export function StartupCard() {
  const [startup, setStartup] = useState(getStartup);
  useEffect(() => {
    // The root layout marks first render in its own effect; read again in case
    // this tab mounted first.
    const t = setTimeout(() => setStartup(getStartup()), 500);
    return () => clearTimeout(t);
  }, []);

  const native = startup?.rnStartMarkerToFirstRenderMs ?? null;
  const js = startup?.jsToFirstRenderMs ?? null;
  // A lower bound can prove a FAIL but not a PASS, so a pass is shown as soft.
  const chip =
    native == null ? <Chip kind="none" label="NO DATA" /> : native > PASS.coldStartMs ? <Chip kind="fail" label="FAIL" /> : <Chip kind="soft" label="UNDER BAR*" />;

  return (
    <Card title="Startup" right={chip}>
      <KV k="RN start marker → first render" v={native == null ? 'n/a' : `${native} ms`} />
      <KV k="JS bundle start → first render" v={js == null ? 'n/a' : `${js} ms`} />
      <KV k="Cold-start bar" v={`≤ ${PASS.coldStartMs} ms`} />
      <Note>
        * Lower bound only. For a true cold start, force-stop the app (Settings › Apps › OpenAlgo Spike › Force stop),
        then reopen it. Also time it from tap to first content with a stopwatch, or run adb shell am start -S -W
        in.openalgo.spike/.MainActivity and read TotalTime.
      </Note>
      <Note>{STARTUP_NOTE}</Note>
    </Card>
  );
}

export function DeviceCard() {
  const d = deviceInfo();
  const x = deviceExtra();
  return (
    <Card title="Device">
      {!x.isPhysicalDevice ? <Note tone="warn">This is an emulator. Its numbers do not represent a budget phone.</Note> : null}
      {__DEV__ ? <Note tone="down">DEV build: these numbers are not representative. Use the release APK.</Note> : null}
      <KV k="Model" v={[d.manufacturer, d.model].filter(Boolean).join(' ') || 'unknown'} />
      <KV k="OS" v={`${d.platform} ${d.osVersion ?? '?'}${x.apiLevel ? ` (API ${x.apiLevel})` : ''}`} />
      <KV k="RAM" v={d.totalMemoryMb ? `${d.totalMemoryMb} MB` : 'unknown'} />
      <KV k="Year class" v={d.yearClass ?? 'unknown'} />
      <KV k="CPU ABIs" v={x.cpuAbis?.join(', ') || 'unknown'} />
      <KV k="Build" v={__DEV__ ? 'dev' : 'release'} color={__DEV__ ? C.down : C.up} />
    </Card>
  );
}
