// Change API key (design 7.2): the same key check as onboarding, then the vault swaps the key.
// Also where the "key rejected" banner leads. Screenshots are blocked while it is open.
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView, StyleSheet } from 'react-native'
import { clearClipboardIfPasted } from '~/core/credentials/clipboard'
import { log } from '~/core/log/logger'
import { useSecureScreen } from '~/core/platform/useSecureScreen'
import { defaultDeps } from '~/core/services/deps'
import { useServices } from '~/core/services/services'
import { COPY, KeyField, keyErrorText, keyStep } from '~/features/onboarding'
import { Banner } from '~/ui/Banner'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { ScreenHeader } from '../components/ScreenHeader'

export function ChangeKeyScreen() {
  useSecureScreen()
  const s = useServices()
  const router = useRouter()
  const { c } = useTheme()
  const [value, setValue] = useState('')
  const [pasted, setPasted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loggedOut, setLoggedOut] = useState(false)

  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      const r = await keyStep(s.profile.get().restOrigin, value, defaultDeps)
      if (r.kind !== 'ok') {
        setError(keyErrorText(r))
        return
      }
      await s.vault.replace(r.key)
      await clearClipboardIfPasted(pasted, r.key, Clipboard)
      if (r.brokerSession === 'logged_out') setLoggedOut(true)
      else router.back()
    } catch (e) {
      log.warn('account', 'could not change the key', e)
      setError(COPY.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Change API key" />
      <Text tone="muted">{`The new API key from ${s.profile.get().restOrigin}.`}</Text>
      <KeyField
        value={value}
        editable={!busy}
        onChangeText={(next, isPaste) => {
          setValue(next)
          setPasted((p) => p || isPaste)
          setError(null)
        }}
      />
      {error ? (
        <Text testID="key-error" style={{ color: c.destructive }}>
          {error}
        </Text>
      ) : null}
      {loggedOut ? (
        <>
          <Banner tone="warning" text={COPY.brokerLoggedOut} />
          <Button title="Done" variant="secondary" onPress={() => router.back()} />
        </>
      ) : (
        <Button testID="key-save" title="Save key" loading={busy} onPress={() => void save()} />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({ body: { padding: 16, gap: 16 } })
