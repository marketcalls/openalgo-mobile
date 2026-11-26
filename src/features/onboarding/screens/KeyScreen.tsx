// Onboarding step 3 (design 7.1): the API key. Checked locally, then against the server; a
// pasted key is cleared from the clipboard once it works. Screenshots are blocked here.
import * as Clipboard from 'expo-clipboard'
import { Redirect, useRouter } from 'expo-router'
import { useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet } from 'react-native'
import { clearClipboardIfPasted } from '~/core/credentials/clipboard'
import { log } from '~/core/log/logger'
import { useSecureScreen } from '~/core/platform/useSecureScreen'
import { Banner } from '~/ui/Banner'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { KeyField } from '../components/KeyField'
import { useOnboarding } from '../context'
import { COPY, keyErrorText } from '../copy'
import { keyStep } from '../flow'

export function KeyScreen() {
  useSecureScreen()
  const { deps, draft, update } = useOnboarding()
  const router = useRouter()
  const { c } = useTheme()
  const [value, setValue] = useState('')
  const [pasted, setPasted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The key works but the broker is logged out: say so, and let the user go on.
  const [loggedOut, setLoggedOut] = useState(false)

  const origin = draft.server?.url
  if (!origin) return <Redirect href="/server" />

  const submit = async () => {
    if (loggedOut) {
      router.push('/feed')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const r = await keyStep(origin, value, deps)
      if (r.kind !== 'ok') {
        setError(keyErrorText(r))
        return
      }
      await clearClipboardIfPasted(pasted, r.key, Clipboard)
      update({ key: { key: r.key, broker: r.broker, brokerSession: r.brokerSession } })
      if (r.brokerSession === 'logged_out') setLoggedOut(true)
      else router.push('/feed')
    } catch (e) {
      log.warn('onboarding', 'key step failed', e)
      setError(COPY.failed)
    } finally {
      setBusy(false)
    }
  }

  const openKeyPage = () => {
    Linking.openURL(`${origin}/apikey`).catch((e) =>
      log.warn('onboarding', 'could not open the browser', e),
    )
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text tone="muted">{`The API key from ${origin}.`}</Text>
      <KeyField
        value={value}
        editable={!busy}
        onChangeText={(next, isPaste) => {
          setValue(next)
          setPasted((p) => p || isPaste)
          setError(null)
          setLoggedOut(false)
        }}
      />
      <Pressable accessibilityRole="link" hitSlop={8} onPress={openKeyPage}>
        <Text style={styles.link}>{COPY.findKey}</Text>
      </Pressable>
      {error ? (
        <Text testID="key-error" style={{ color: c.destructive }}>
          {error}
        </Text>
      ) : null}
      {loggedOut ? <Banner tone="warning" text={COPY.brokerLoggedOut} /> : null}
      <Button testID="key-continue" title="Continue" loading={busy} onPress={() => void submit()} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  link: { fontWeight: '600', textDecorationLine: 'underline' },
})
