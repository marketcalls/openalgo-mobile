// The Account tab (design 7.2): the connection, the analyzer mode, the broker, settings, the
// way to the other account screens, and the app's name and version.
import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, Platform, ScrollView, StyleSheet, Switch, View } from 'react-native'
import { usePrefs } from '~/core/config/prefs'
import { log } from '~/core/log/logger'
import { useConnection } from '~/core/services/connection'
import { defaultDeps } from '~/core/services/deps'
import { useServices } from '~/core/services/services'
import { backupHref } from '~/market/links'
import { BrandMark } from '~/ui/BrandMark'
import { Button } from '~/ui/Button'
import { confirm } from '~/ui/confirm'
import { ListRow } from '~/ui/ListRow'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { useAnalyzer, useToggleAnalyzer } from '../api'
import { useStoredUpdate } from '../update'

export const ACCOUNT_COPY = {
  versionUnknown: 'unknown, 2.0.0.0 or later',
  semiAuto:
    'Mode switching is off because this account uses Semi-Auto orders. Change the mode on the web.',
  noPasscode: 'Set a device passcode to use app lock',
  noPasscodeConfirm: 'Set a device passcode to confirm live actions',
  login: 'Log in to your broker',
  hideContent: 'Hide content in screenshots and recent apps',
  confirmLive: 'Confirm live actions with biometrics',
  updateCheck: 'Check for app updates',
  updateCaption:
    'Once a day the app asks GitHub for the latest release. Nothing about you or your server is sent.',
  oneTap: 'One-tap chart trading',
} as const

/** What turning one-tap on means, which the switch asks the user to accept first (design 7.10). */
export const ONE_TAP_COPY =
  'BUY and SELL on the chart will place a market order at once, without the review step, in ' +
  "the exchange's default product: CNC (delivery) for shares, NRML for futures, options and " +
  'commodities. A live order still asks for biometrics when that is on.'

const LOCK_AFTER = [
  { ms: 60_000, label: '1 min' },
  { ms: 300_000, label: '5 min' },
  { ms: 900_000, label: '15 min' },
] as const

const THEMES = ['system', 'dark', 'light'] as const

const BROKER_TEXT = {
  active: 'Logged in',
  logged_out: 'Logged out',
  unknown: 'Not checked yet',
} as const

export function AccountScreen() {
  const s = useServices()
  const router = useRouter()
  const { c } = useTheme()
  const conn = useConnection()
  const prefs = usePrefs()
  const mode = useAnalyzer()
  const update = useStoredUpdate()
  const { toggle, pending, error } = useToggleAnalyzer()
  const [lockAvailable, setLockAvailable] = useState(true)

  useEffect(() => {
    let live = true
    defaultDeps.lock
      .available()
      .then((ok) => live && setLockAvailable(ok))
      .catch(() => live && setLockAvailable(false))
    return () => {
      live = false
    }
  }, [])

  const profile = s.profile.get()
  const broker = conn.broker ?? profile.broker
  /** On only once the user has read what it does and said yes; off at once. */
  const setOneTap = async (on: boolean) => {
    if (on && !(await confirm(ACCOUNT_COPY.oneTap, ONE_TAP_COPY, 'Turn on'))) return
    prefs.setPrefs({ chartOneTap: on })
  }
  const openLogin = () => {
    Linking.openURL(`${profile.restOrigin.replace(/\/+$/, '')}/login`).catch((e) =>
      log.warn('account', 'could not open the browser', e),
    )
  }

  return (
    <ScrollView contentContainerStyle={styles.body} testID="account-screen">
      <Text variant="title">Account</Text>

      <View style={styles.group}>
        <Text variant="heading">Server</Text>
        <Text testID="account-url">{profile.restOrigin}</Text>
        <Text variant="caption" tone="muted" testID="account-version">
          {`OpenAlgo ${profile.serverVersion ?? ACCOUNT_COPY.versionUnknown}`}
        </Text>
        <Text variant="caption" tone="muted">{`Broker: ${broker ?? 'unknown'}`}</Text>
        <Text variant="caption" tone="muted" testID="account-feed">
          {profile.feedMode === 'live' ? 'Live feed' : 'Polling: prices refresh every few seconds'}
        </Text>
      </View>
      <View>
        <ListRow
          testID="link-server"
          title="Server settings"
          onPress={() => router.push('/account/server')}
        />
        <ListRow
          testID="link-key"
          title="Change API key"
          onPress={() => router.push('/account/key')}
        />
      </View>

      <View style={styles.group}>
        <Text variant="heading">Trading mode</Text>
        {conn.semiAutoSeen ? (
          <Text testID="analyzer-semi-auto" tone="muted">
            {ACCOUNT_COPY.semiAuto}
          </Text>
        ) : (
          <View style={styles.rowBetween}>
            <Text>{mode === 'analyze' ? 'ANALYZE (sandbox)' : 'LIVE'}</Text>
            <Switch
              testID="analyzer-toggle"
              accessibilityLabel="Analyzer (sandbox) mode"
              value={mode === 'analyze'}
              disabled={mode === 'unknown' || pending}
              onValueChange={(on) => void toggle(on ? 'analyze' : 'live')}
            />
          </View>
        )}
        {error ? (
          <Text testID="analyzer-error" style={{ color: c.destructive }}>
            {error}
          </Text>
        ) : null}
      </View>

      <View style={styles.group}>
        <Text variant="heading">Broker</Text>
        <Text testID="broker-status">{BROKER_TEXT[conn.brokerSession]}</Text>
        {conn.brokerSession === 'logged_out' ? (
          <Button testID="broker-login" title={ACCOUNT_COPY.login} onPress={openLogin} />
        ) : null}
      </View>

      <View style={styles.group}>
        <Text variant="heading">Settings</Text>
        <Text>Theme</Text>
        <View style={styles.row}>
          {THEMES.map((t) => (
            <View key={t} style={styles.fill}>
              <Button
                testID={`theme-${t}`}
                title={t[0]?.toUpperCase() + t.slice(1)}
                variant={prefs.theme === t ? 'primary' : 'secondary'}
                onPress={() => prefs.setPrefs({ theme: t })}
              />
            </View>
          ))}
        </View>

        <View style={styles.rowBetween}>
          <Text>App lock</Text>
          <Switch
            testID="pref-app-lock"
            accessibilityLabel="App lock"
            value={prefs.appLock && lockAvailable}
            disabled={!lockAvailable}
            onValueChange={(v) => prefs.setPrefs({ appLock: v })}
          />
        </View>
        {lockAvailable ? null : (
          <Text variant="caption" tone="muted" testID="app-lock-unavailable">
            {ACCOUNT_COPY.noPasscode}
          </Text>
        )}
        {prefs.appLock && lockAvailable ? (
          <>
            <Text>Lock after</Text>
            <View style={styles.row}>
              {LOCK_AFTER.map((o) => (
                <View key={o.ms} style={styles.fill}>
                  <Button
                    testID={`lock-after-${o.ms}`}
                    title={o.label}
                    variant={prefs.lockAfterMs === o.ms ? 'primary' : 'secondary'}
                    onPress={() => prefs.setPrefs({ lockAfterMs: o.ms })}
                  />
                </View>
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.rowBetween}>
          <Text style={styles.fill}>{ACCOUNT_COPY.confirmLive}</Text>
          <Switch
            testID="pref-confirm-live"
            accessibilityLabel={ACCOUNT_COPY.confirmLive}
            value={prefs.confirmLiveWrites && lockAvailable}
            disabled={!lockAvailable}
            onValueChange={(v) => prefs.setPrefs({ confirmLiveWrites: v })}
          />
        </View>
        {lockAvailable ? null : (
          <Text variant="caption" tone="muted" testID="confirm-live-unavailable">
            {ACCOUNT_COPY.noPasscodeConfirm}
          </Text>
        )}
        <View style={styles.rowBetween}>
          <Text style={styles.fill}>{ACCOUNT_COPY.oneTap}</Text>
          <Switch
            testID="pref-chart-onetap"
            accessibilityLabel={ACCOUNT_COPY.oneTap}
            value={prefs.chartOneTap}
            onValueChange={(v) => void setOneTap(v)}
          />
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.fill}>{ACCOUNT_COPY.updateCheck}</Text>
          <Switch
            testID="pref-update-check"
            accessibilityLabel={ACCOUNT_COPY.updateCheck}
            value={prefs.updateCheck}
            onValueChange={(v) => prefs.setPrefs({ updateCheck: v })}
          />
        </View>
        <Text variant="caption" tone="muted">
          {ACCOUNT_COPY.updateCaption}
        </Text>
        {update && prefs.updateCheck ? (
          <Text testID="account-update">{`Version ${update.version} is available`}</Text>
        ) : null}
        {Platform.OS === 'android' ? (
          <View style={styles.rowBetween}>
            <Text style={styles.fill}>{ACCOUNT_COPY.hideContent}</Text>
            <Switch
              testID="pref-hide-content"
              accessibilityLabel={ACCOUNT_COPY.hideContent}
              value={prefs.hideContentAndroid}
              onValueChange={(v) => prefs.setPrefs({ hideContentAndroid: v })}
            />
          </View>
        ) : null}
      </View>

      <View>
        <ListRow
          testID="link-diagnostics"
          title="Diagnostics"
          onPress={() => router.push('/account/diagnostics')}
        />
        <ListRow
          testID="link-backup"
          title="Back up and restore"
          onPress={() => router.push(backupHref())}
        />
        <ListRow
          testID="link-lost-phone"
          title="Lost phone"
          onPress={() => router.push('/account/lost-phone')}
        />
        <ListRow
          testID="sign-out"
          title="Sign out"
          onPress={() => router.push('/account/sign-out')}
        />
      </View>
      <View style={styles.group} testID="account-about">
        <Text variant="heading">About</Text>
        <View style={styles.about}>
          {/* Decorative: the app name beside it says OpenAlgo. */}
          <BrandMark testID="about-mark" size={40} decorative />
          <View style={styles.fill}>
            <Text testID="app-name">{Constants.expoConfig?.name ?? 'OpenAlgo'}</Text>
            <Text variant="caption" tone="muted" testID="app-version">
              {`Version ${Constants.expoConfig?.version ?? 'unknown'}`}
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 20 },
  group: { gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  fill: { flex: 1 },
  about: { flexDirection: 'row', alignItems: 'center', gap: 12 },
})
