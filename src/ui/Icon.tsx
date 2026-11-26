// A system icon: an SF Symbol on iOS, a Material Symbol on Android (expo-symbols). On Android
// the glyph comes from a font that expo-symbols loads on first use.
import { type AndroidSymbol, type SFSymbol, SymbolView } from 'expo-symbols'
import { useTheme } from './theme'

export type IconName = { ios: SFSymbol; android: AndroidSymbol }

/** Decorative: the control around it carries the label. */
export function Icon({
  name,
  size = 20,
  color,
  testID,
}: {
  name: IconName
  size?: number
  color?: string
  testID?: string
}) {
  const { c } = useTheme()
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color ?? c.foreground}
      testID={testID}
      accessible={false}
      importantForAccessibility="no"
    />
  )
}
