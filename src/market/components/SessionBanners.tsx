// The session banners trading screens share: the one broker banner (ruling 9) and the Semi-Auto
// note, with the copy later tasks reuse for a queued order (ruling 14).
import { Pressable, StyleSheet, View } from 'react-native'
import { ApiError, userMessage } from '~/core/http/errors'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import { type Tone, useToneColors } from '~/ui/Badge'
import { Text } from '~/ui/Text'
import { openServerPage } from '../session'

/** The standing note once the server has shown Semi-Auto mode. */
export const SEMI_AUTO_COPY = 'Orders need approval in the web Action Center'
/** An order the server queued for approval (C4 `mode: 'semi_auto'`). */
export const QUEUED_COPY = 'Queued for approval in the web Action Center'

const LOGGED_OUT = userMessage(
  new ApiError({ kind: 'BrokerLoggedOut', status: 0, endpoint: 'app' }),
)

type Action = { testID: string; label: string; onPress: () => void }

/** While the broker is logged out: log in on the web, or check the session again. */
export function BrokerBanner() {
  const { profile, broker } = useServices()
  const loggedOut = useConnection((c) => c.brokerSession === 'logged_out')
  if (!loggedOut) return null
  return (
    <SessionBanner
      testID="banner-broker"
      tone="danger"
      text={LOGGED_OUT}
      actions={[
        {
          testID: 'broker-banner-login',
          label: 'Log in to your broker',
          onPress: () => openServerPage(profile.get().restOrigin, '/login'),
        },
        {
          testID: 'broker-banner-recheck',
          label: 'Check again',
          onPress: () => void broker.check(),
        },
      ]}
    />
  )
}

/** Once the server has shown Semi-Auto mode: orders wait for approval on the web. */
export function SemiAutoBanner() {
  const { profile } = useServices()
  const seen = useConnection((c) => c.semiAutoSeen)
  if (!seen) return null
  return (
    <SessionBanner
      testID="banner-semi-auto"
      tone="warning"
      text={SEMI_AUTO_COPY}
      actions={[
        {
          testID: 'open-action-center',
          label: 'Open Action Center',
          onPress: () => openServerPage(profile.get().restOrigin, '/action-center'),
        },
      ]}
    />
  )
}

/** A banner with a row of actions under its text (ui's Banner holds one beside it). */
function SessionBanner(p: { testID: string; tone: Tone; text: string; actions: Action[] }) {
  const { bg, fg } = useToneColors(p.tone)
  return (
    <View testID={p.testID} style={[styles.banner, { backgroundColor: bg }]}>
      <Text style={{ color: fg }}>{p.text}</Text>
      <View style={styles.actions}>
        {p.actions.map((a) => (
          <Pressable
            key={a.testID}
            testID={a.testID}
            accessibilityRole="button"
            onPress={a.onPress}
            hitSlop={8}
          >
            <Text style={[styles.action, { color: fg }]}>{a.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: { gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  action: { fontWeight: '700', textDecorationLine: 'underline' },
})
