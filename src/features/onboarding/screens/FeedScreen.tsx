// Onboarding steps 4 and 5 (design 7.1): the live-feed address, derived and editable, its test,
// then the save. The key goes only to a host the user confirmed; a failed test saves polling.
import { Redirect, useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { checkWsUrl, deriveWsUrl, sameHost } from '~/core/config/urlRules'
import { log } from '~/core/log/logger'
import { useSession } from '~/core/services/services'
import { Banner } from '~/ui/Banner'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { UrlField } from '../components/UrlField'
import { useOnboarding } from '../context'
import { COPY, urlErrorText, wsHostDiffers } from '../copy'
import { type FeedStepResult, feedStep, saveOnboarding } from '../flow'

type Tested = { url: string; result: FeedStepResult }

export function FeedScreen() {
  const { deps, draft } = useOnboarding()
  const router = useRouter()
  const { c } = useTheme()
  const { server, key, existing } = draft
  const [input, setInput] = useState(() => {
    if (!server) return ''
    const kept = existing?.restOrigin === server.url ? existing.wsUrl : null
    return kept ?? deriveWsUrl(server.url) ?? ''
  })
  const [confirm, setConfirm] = useState<{ url: string; text: string } | null>(null)
  const [confirmedUrl, setConfirmedUrl] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<Tested | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!server || !key) return <Redirect href="/server" />

  const run = async (url: string) => {
    setTesting(true)
    try {
      setTested({
        url,
        result: await feedStep(url, key.key, { WebSocketImpl: deps.WebSocketImpl }),
      })
    } finally {
      setTesting(false)
    }
  }

  const test = () => {
    setError(null)
    const check = checkWsUrl(input, { allowDevHosts: deps.allowDevHosts })
    if (!check.ok) {
      setError(urlErrorText(check.reason))
      return
    }
    if (!sameHost(check.url, server.url) && confirmedUrl !== check.url) {
      setConfirm({ url: check.url, text: wsHostDiffers(check.host, server.host) })
      return
    }
    void run(check.url)
  }

  const save = async (t: Tested) => {
    setSaving(true)
    try {
      const profile = await saveOnboarding(
        {
          url: server.url,
          caps: server.caps,
          key: key.key,
          broker: key.broker ?? (t.result.mode === 'live' ? t.result.broker : null),
          wsUrl: t.url,
          feedMode: t.result.mode,
          httpWarningAcked: draft.httpAcked,
        },
        deps,
      )
      useSession.getState().set({ status: 'ready', profileId: profile.id })
    } catch (e) {
      log.warn('onboarding', 'could not save the server', e)
      setError(COPY.saveFailed)
      setSaving(false)
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text tone="muted">
        The live feed streams prices. Test it once; without it, prices refresh every few seconds.
      </Text>
      <UrlField
        testID="feed-url"
        label="Live feed address"
        placeholder="wss://algo.example.com/ws"
        value={input}
        editable={!testing && !saving}
        onChangeText={(next) => {
          setInput(next)
          setConfirm(null)
          setTested(null)
          setError(null)
        }}
      />
      {error ? <Text style={{ color: c.destructive }}>{error}</Text> : null}
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
                  setConfirmedUrl(confirm.url)
                  setConfirm(null)
                  void run(confirm.url)
                }}
              />
            </View>
          </View>
        </>
      ) : (
        <Button
          testID="feed-test"
          title="Test live feed"
          variant={tested ? 'secondary' : 'primary'}
          loading={testing}
          disabled={saving}
          onPress={test}
        />
      )}
      {tested?.result.mode === 'live' ? (
        <Text testID="feed-live">{COPY.feedLive}</Text>
      ) : tested ? (
        <>
          <Banner tone="warning" text={COPY.feedFailed} />
          <Button
            testID="feed-help"
            title={COPY.setupHelp}
            variant="secondary"
            onPress={() => router.push('/help')}
          />
        </>
      ) : null}
      {tested && !testing ? (
        <Button
          testID="onboarding-save"
          title="Save"
          loading={saving}
          onPress={() => void save(tested)}
        />
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  row: { flexDirection: 'row', gap: 12 },
  fill: { flex: 1 },
})
