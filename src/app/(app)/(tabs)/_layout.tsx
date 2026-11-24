import { useRouter } from 'expo-router'
import { NativeTabs } from 'expo-router/native-tabs'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useConnection } from '~/core/services/connection'
import { type ShellBanner, shellBanners, useServices } from '~/core/services/services'
import { useAnalyzer } from '~/features/account/api'
import { BrokerBanner } from '~/market/components/SessionBanners'
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
  // the header badge reads conn.analyzer, which only this hook writes (ruling 10)
  useAnalyzer()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { c } = useTheme()
  const banners = shellBanners(conn, s, { go: (href) => router.push(href) })
  const show = (b: ShellBanner) => (
    <Banner key={b.testID} testID={b.testID} tone={b.tone} text={b.text} action={b.action} />
  )

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
      {/* Most serious first: the ban and the key, the broker (ruling 9), then polling. */}
      {banners.filter((b) => b.tone === 'danger').map(show)}
      <BrokerBanner />
      {banners.filter((b) => b.tone !== 'danger').map(show)}
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
