import { useRouter } from 'expo-router'
import { NativeTabs } from 'expo-router/native-tabs'
import { Linking, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { log } from '~/core/log/logger'
import { useConnection } from '~/core/services/connection'
import { shellBanners, useServices } from '~/core/services/services'
import { Banner } from '~/ui/Banner'
import { StatusBadges } from '~/ui/StatusBadges'
import { useTheme } from '~/ui/theme'

/** The five tabs, each with its SF Symbol (iOS) and Material icon (Android). */
const TABS = [
  { name: 'index', label: 'Watchlist', sf: 'list.bullet', md: 'list' },
  { name: 'orders', label: 'Orders', sf: 'doc.text', md: 'receipt_long' },
  { name: 'portfolio', label: 'Portfolio', sf: 'briefcase', md: 'work' },
  { name: 'tools', label: 'Tools', sf: 'square.grid.2x2', md: 'apps' },
  { name: 'account', label: 'Account', sf: 'person.crop.circle', md: 'account_circle' },
] as const

export default function TabsLayout() {
  const s = useServices()
  const conn = useConnection()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { c } = useTheme()
  const banners = shellBanners(conn, s, {
    go: (href) => router.push(href),
    openUrl: (url) => {
      Linking.openURL(url).catch((e) => log.warn('shell', 'could not open the browser', e))
    },
  })

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <StatusBadges
          transport={conn.transport}
          feed={conn.feed}
          brokerSession={conn.brokerSession}
          analyzer={conn.analyzer}
        />
      </View>
      {banners.map((b) => (
        <Banner key={b.testID} testID={b.testID} tone={b.tone} text={b.text} action={b.action} />
      ))}
      <View style={styles.fill}>
        <NativeTabs backgroundColor={c.background} tintColor={c.foreground}>
          {TABS.map((t) => (
            <NativeTabs.Trigger
              key={t.name}
              name={t.name}
              contentStyle={{ backgroundColor: c.background }}
            >
              <NativeTabs.Trigger.Label>{t.label}</NativeTabs.Trigger.Label>
              <NativeTabs.Trigger.Icon sf={t.sf} md={t.md} />
            </NativeTabs.Trigger>
          ))}
        </NativeTabs>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
})
