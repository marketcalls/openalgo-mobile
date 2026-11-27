// A tool screen's header (design 7.8, Kite's quiet chrome): one 48 dp row with back, the tool's
// name and the server's mode, then one fixed-height line under it, so the page below never
// resizes. The line says how fresh the page's figures are, or what it is doing, and ends with the
// connection badges that are true (the mode is in the row above: one badge, not two).
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import { istClock } from '~/core/realtime/marketHours'
import { useConnection } from '~/core/services/connection'
import { ModeBadge } from '~/market/components/ModeBadge'
import { Icon, type IconName } from '~/ui/Icon'
import { StatusBadges } from '~/ui/StatusBadges'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import type { ToolStatus } from '../hooks/useToolGateway'

const BACK: IconName = { ios: 'chevron.left', android: 'arrow_back' }
/** A pass or download out longer than this says it is working, with the time it has taken. */
export const WORKING_AFTER_MS = 600
/** The line's height: a 12 sp line at the largest font scale it allows. */
const LINE_HEIGHT = 24
const MAX_SCALE = 1.3

const two = (n: number) => String(n).padStart(2, '0')
/** `14:32:05` in IST. */
export function istTime(ms: number): string {
  const { hh, mm, ss } = istClock(ms)
  return `${two(hh)}:${two(mm)}:${two(ss)}`
}

export type Subtitle = {
  text: string
  tone: 'muted' | 'warning'
  progress?: number
}

/**
 * What the line says, the first that applies: a pass's progress; the last update failed; a long
 * pass or download is working; the figures are updating; when they were last updated.
 */
export function toolSubtitle(st: ToolStatus, deviceNow: number): Subtitle {
  if (st.progress) {
    const { label, done, total } = st.progress
    return {
      text: `${label}: ${done} of ${total}`,
      tone: 'muted',
      progress: total > 0 ? done / total : 0,
    }
  }
  if (st.last && !st.last.ok) {
    const why = st.last.message === '' ? '' : ` · ${st.last.message}`
    return {
      text: `Couldn't update · ${istTime(st.last.at)}${why} Tap Refresh to retry.`,
      tone: 'warning',
    }
  }
  if (st.longSince !== null && deviceNow - st.longSince > WORKING_AFTER_MS) {
    const sec = Math.floor((deviceNow - st.longSince) / 1000)
    return { text: `Working… ${Math.floor(sec / 60)}:${two(sec % 60)}`, tone: 'muted' }
  }
  if (st.updating > 0) return { text: 'Updating…', tone: 'muted' }
  if (st.last?.ok) return { text: `Updated ${istTime(st.last.at)}`, tone: 'muted' }
  return { text: '', tone: 'muted' }
}

/** The line re-reads the time each second while a long pass is out (its m:ss). */
function useTicking(on: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export function ToolHeader(p: {
  title: string
  topInset: number
  status: StoreApi<ToolStatus>
  onBack: () => void
  /** A tap on the title scrolls the page to its top. */
  onTitle: () => void
}) {
  const { c, status: tone } = useTheme()
  const conn = useConnection()
  const st = useStore(p.status)
  const now = useTicking(st.longSince !== null)
  const line = toolSubtitle(st, now)
  return (
    <View style={[styles.wrap, { paddingTop: p.topInset }]}>
      <View style={styles.row}>
        <Pressable
          testID="tool-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={p.onBack}
          style={styles.back}
        >
          <Icon name={BACK} size={22} color={c.foreground} />
        </Pressable>
        <Pressable
          testID="tool-title"
          accessibilityRole="header"
          accessibilityHint="Scrolls to the top"
          onPress={p.onTitle}
          style={styles.title}
        >
          <Text numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE} style={styles.titleText}>
            {p.title}
          </Text>
        </Pressable>
        {conn.analyzer === 'unknown' ? null : <ModeBadge mode={conn.analyzer} testID="tool-mode" />}
      </View>
      <View testID="tool-subtitle" style={styles.line}>
        <Text
          testID="tool-subtitle-text"
          numberOfLines={1}
          maxFontSizeMultiplier={MAX_SCALE}
          style={[
            styles.lineText,
            { color: line.tone === 'warning' ? tone.warning : c.mutedForeground },
          ]}
        >
          {line.text}
        </Text>
        <StatusBadges
          transport={conn.transport}
          feed={conn.feed}
          brokerSession={conn.brokerSession}
          analyzer={conn.analyzer}
          mode={false}
        />
        {line.progress !== undefined ? (
          <View
            testID="tool-progress"
            style={[
              styles.bar,
              { backgroundColor: c.foreground, width: `${Math.round(line.progress * 100)}%` },
            ]}
          />
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 4 },
  row: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 12 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center' },
  titleText: { fontSize: 17, fontWeight: '600' },
  line: {
    height: LINE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    overflow: 'hidden',
  },
  lineText: { flex: 1, minWidth: 0, fontSize: 12, fontVariant: ['tabular-nums'] },
  bar: { position: 'absolute', left: 0, bottom: 0, height: 2 },
})
