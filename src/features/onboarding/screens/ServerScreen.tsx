// Onboarding step 1 and 2 (design 7.1): the server address, the one-time http warning, then the
// version check. A too-old server goes to /update; anything else that fails is said here.
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Platform, ScrollView, StyleSheet } from 'react-native'
import { normalizeServerUrl } from '~/core/config/urlRules'
import { log } from '~/core/log/logger'
import { Banner } from '~/ui/Banner'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { UrlField } from '../components/UrlField'
import { useOnboarding } from '../context'
import { COPY, serverErrorLines, urlErrorText, usingUrl } from '../copy'
import { serverStep } from '../flow'

export function ServerScreen() {
  const { deps, draft, update } = useOnboarding()
  const router = useRouter()
  const { c } = useTheme()
  const [input, setInput] = useState(draft.existing?.restOrigin ?? '')
  const [askAck, setAskAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  const check = normalizeServerUrl(input, { allowDevHosts: deps.allowDevHosts })

  const submit = async (acked: boolean) => {
    setErrors([])
    if (!check.ok) {
      setErrors([urlErrorText(check.reason)])
      return
    }
    const home = check.hostClass === 'home'
    if (check.scheme === 'http' && home && !acked) {
      setAskAck(true)
      return
    }
    setAskAck(false)
    setBusy(true)
    try {
      const r = await serverStep(input, deps)
      if (r.kind === 'ok') {
        update({ server: { url: r.url, host: check.host, caps: r.caps } })
        router.push('/key')
      } else if (r.kind === 'too_old') {
        update({ tooOldVersion: r.version })
        router.push('/update')
      } else {
        setErrors(serverErrorLines(r, { home, ios: Platform.OS === 'ios' }))
      }
    } catch (e) {
      log.warn('onboarding', 'server step failed', e)
      setErrors([COPY.failed])
    } finally {
      setBusy(false)
    }
  }

  const acknowledge = () => {
    update({ httpAcked: true })
    void submit(true)
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text tone="muted">The address of your OpenAlgo server, as you open it in a browser.</Text>
      <UrlField
        testID="server-url"
        label="Server address"
        placeholder="https://algo.example.com or 192.168.1.20"
        value={input}
        editable={!busy}
        onChangeText={(next) => {
          setInput(next)
          setAskAck(false)
          setErrors([])
        }}
      />
      {check.ok && check.stripped ? (
        <Text testID="server-using" variant="caption" tone="muted">
          {usingUrl(check.url)}
        </Text>
      ) : null}
      {errors.map((line) => (
        <Text key={line} style={{ color: c.destructive }}>
          {line}
        </Text>
      ))}
      {askAck ? (
        <>
          <Banner tone="warning" text={COPY.httpWarning} />
          <Button testID="http-ack" title={COPY.httpAck} onPress={acknowledge} />
        </>
      ) : (
        <Button
          testID="server-continue"
          title="Continue"
          loading={busy}
          onPress={() => void submit(draft.httpAcked)}
        />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
})
