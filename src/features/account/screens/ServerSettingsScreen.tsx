// Server settings (design 7.2): the server address and the live-feed address. Each runs the
// onboarding check again; the profile id, watchlists and key stay.
import { useState } from 'react'
import { Platform, ScrollView, StyleSheet, View } from 'react-native'
import { checkWsUrl, normalizeServerUrl, sameHost } from '~/core/config/urlRules'
import { log } from '~/core/log/logger'
import { defaultDeps } from '~/core/services/deps'
import { useServices } from '~/core/services/services'
import {
  COPY,
  feedStep,
  serverErrorLines,
  serverStep,
  UrlField,
  urlErrorText,
  usingUrl,
  wsHostDiffers,
} from '~/features/onboarding'
import { Banner } from '~/ui/Banner'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { ScreenHeader } from '../components/ScreenHeader'
import { applyFeed, applyServerUrl } from '../serverChange'

export function ServerSettingsScreen() {
  const s = useServices()
  const { c } = useTheme()
  const profile = s.profile.get()

  const [url, setUrl] = useState(profile.restOrigin)
  const [askAck, setAskAck] = useState(false)
  const [urlBusy, setUrlBusy] = useState(false)
  const [urlErrors, setUrlErrors] = useState<string[]>([])

  const [ws, setWs] = useState(profile.wsUrl ?? '')
  const [confirm, setConfirm] = useState<{ url: string; text: string } | null>(null)
  const [feedBusy, setFeedBusy] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [feedResult, setFeedResult] = useState<'live' | 'polling' | null>(null)

  const urlCheck = normalizeServerUrl(url, { allowDevHosts: defaultDeps.allowDevHosts })

  const saveUrl = async (acked: boolean) => {
    setUrlErrors([])
    if (!urlCheck.ok) {
      setUrlErrors([urlErrorText(urlCheck.reason)])
      return
    }
    const home = urlCheck.hostClass === 'home'
    if (urlCheck.scheme === 'http' && home && !acked && !profile.httpWarningAcked) {
      setAskAck(true)
      return
    }
    setAskAck(false)
    setUrlBusy(true)
    try {
      const r = await serverStep(url, defaultDeps)
      if (r.kind === 'ok') {
        if (!profile.httpWarningAcked && urlCheck.scheme === 'http') {
          await s.profile.update({ httpWarningAcked: true })
        }
        await applyServerUrl(s, r.url, r.caps.version)
      } else if (r.kind === 'too_old') {
        setUrlErrors([`${COPY.tooOld}: ${COPY.tooOldNative} ${COPY.tooOldDocker}`])
      } else {
        setUrlErrors(serverErrorLines(r, { home, ios: Platform.OS === 'ios' }))
      }
    } catch (e) {
      log.warn('account', 'server change failed', e)
      setUrlErrors([COPY.failed])
    } finally {
      setUrlBusy(false)
    }
  }

  const runFeed = async (target: string) => {
    setFeedBusy(true)
    setFeedResult(null)
    try {
      const r = await feedStep(target, s.vault.get(), {
        WebSocketImpl: defaultDeps.WebSocketImpl,
      })
      await applyFeed(s, { wsUrl: target, mode: r.mode, now: defaultDeps.now() })
      setFeedResult(r.mode)
    } catch (e) {
      log.warn('account', 'live feed test failed', e)
      setFeedError(COPY.failed)
    } finally {
      setFeedBusy(false)
    }
  }

  const testFeed = () => {
    setFeedError(null)
    const check = checkWsUrl(ws, { allowDevHosts: defaultDeps.allowDevHosts })
    if (!check.ok) {
      setFeedError(urlErrorText(check.reason))
      return
    }
    const rest = normalizeServerUrl(profile.restOrigin, { allowDevHosts: true })
    if (!sameHost(check.url, profile.restOrigin)) {
      setConfirm({
        url: check.url,
        text: wsHostDiffers(check.host, rest.ok ? rest.host : profile.restOrigin),
      })
      return
    }
    void runFeed(check.url)
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Server settings" />
      <Text variant="heading">Server address</Text>
      <UrlField
        testID="server-url"
        label="Server address"
        placeholder="https://algo.example.com"
        value={url}
        editable={!urlBusy}
        onChangeText={(next) => {
          setUrl(next)
          setAskAck(false)
          setUrlErrors([])
        }}
      />
      {urlCheck.ok && urlCheck.stripped ? (
        <Text variant="caption" tone="muted">
          {usingUrl(urlCheck.url)}
        </Text>
      ) : null}
      {urlErrors.map((line) => (
        <Text key={line} style={{ color: c.destructive }}>
          {line}
        </Text>
      ))}
      {askAck ? (
        <>
          <Banner tone="warning" text={COPY.httpWarning} />
          <Button testID="http-ack" title={COPY.httpAck} onPress={() => void saveUrl(true)} />
        </>
      ) : (
        <Button
          testID="server-save"
          title="Save server address"
          loading={urlBusy}
          onPress={() => void saveUrl(false)}
        />
      )}

      <Text variant="heading">Live feed</Text>
      <UrlField
        testID="feed-url"
        label="Live feed address"
        placeholder="wss://algo.example.com/ws"
        value={ws}
        editable={!feedBusy}
        onChangeText={(next) => {
          setWs(next)
          setConfirm(null)
          setFeedError(null)
          setFeedResult(null)
        }}
      />
      {feedError ? (
        <Text testID="feed-error" style={{ color: c.destructive }}>
          {feedError}
        </Text>
      ) : null}
      {confirm ? (
        <>
          <Banner tone="warning" text={confirm.text} />
          <View style={styles.row}>
            <View style={styles.fill}>
              <Button
                testID="feed-host-cancel"
                title="Cancel"
                variant="secondary"
                onPress={() => setConfirm(null)}
              />
            </View>
            <View style={styles.fill}>
              <Button
                testID="feed-host-continue"
                title="Continue"
                onPress={() => {
                  const target = confirm.url
                  setConfirm(null)
                  void runFeed(target)
                }}
              />
            </View>
          </View>
        </>
      ) : (
        <Button testID="feed-test" title="Test live feed" loading={feedBusy} onPress={testFeed} />
      )}
      {feedResult === 'live' ? <Text testID="feed-live">{COPY.feedLive}</Text> : null}
      {feedResult === 'polling' ? <Banner tone="warning" text={COPY.feedFailed} /> : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  row: { flexDirection: 'row', gap: 12 },
  fill: { flex: 1 },
})
