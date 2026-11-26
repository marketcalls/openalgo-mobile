// Sign out (design 7.2): the key leaves this phone; the server address stays for the next sign-in.
import { useState } from 'react'
import { ScrollView, StyleSheet, Switch, View } from 'react-native'
import { log } from '~/core/log/logger'
import { useServices } from '~/core/services/services'
import { backupNow } from '~/features/backup'
import { useTrading } from '~/market/trading'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { ScreenHeader } from '../components/ScreenHeader'
import { signOut } from '../signOut'

export const SIGN_OUT_COPY = {
  keeps: 'Your watchlists stay on this phone unless you delete them below.',
  notRevoked: 'Only regenerating the key on the OpenAlgo web cuts this phone off for good.',
  deleteLabel: 'Also delete watchlists and saved data on this phone',
  backupFailed: 'Could not create the backup. Try again.',
  failed: 'Could not sign out. Try again.',
} as const

export function SignOutScreen() {
  const s = useServices()
  const { c } = useTheme()
  const [deleteUserContent, setDelete] = useState(false)
  const watchlists = useTrading().watchlists
  const [busy, setBusy] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await signOut(s, { deleteUserContent })
    } catch (e) {
      log.warn('account', 'sign-out failed', e)
      setError(SIGN_OUT_COPY.failed)
      setBusy(false)
    }
  }

  const backup = async () => {
    setBackingUp(true)
    setError(null)
    try {
      await backupNow(watchlists)
    } catch (e) {
      log.warn('account', 'backup before sign-out failed', e)
      setError(SIGN_OUT_COPY.backupFailed)
    } finally {
      setBackingUp(false)
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <ScreenHeader title="Sign out" />
      <Text>{SIGN_OUT_COPY.keeps}</Text>
      <Text>{SIGN_OUT_COPY.notRevoked}</Text>
      <View style={styles.rowBetween}>
        <Text style={styles.fill}>{SIGN_OUT_COPY.deleteLabel}</Text>
        <Switch
          testID="sign-out-delete"
          accessibilityLabel={SIGN_OUT_COPY.deleteLabel}
          value={deleteUserContent}
          onValueChange={setDelete}
        />
      </View>
      <Button
        testID="signout-backup"
        title="Back up watchlists first"
        variant="secondary"
        loading={backingUp}
        onPress={() => void backup()}
      />
      {error ? <Text style={{ color: c.destructive }}>{error}</Text> : null}
      <Button
        testID="sign-out-confirm"
        title="Sign out"
        variant="destructive"
        loading={busy}
        onPress={() => void run()}
      />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  fill: { flex: 1 },
})
