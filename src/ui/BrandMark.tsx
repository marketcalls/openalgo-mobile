import { Image, type ImageSourcePropType, type ImageStyle, type StyleProp } from 'react-native'
import { useTheme } from './theme'

/** The white OpenAlgo mark, 64 px with @2x and @3x (assets/brand/README.md). */
const MARK: ImageSourcePropType = require('../../assets/brand/openalgo-mark.png')

/**
 * The OpenAlgo mark, tinted to the theme's foreground so it reads on light and dark. Screen
 * readers announce it as "OpenAlgo"; pass `decorative` where a text beside it already says so.
 */
export function BrandMark({
  size = 48,
  color,
  decorative = false,
  testID,
  style,
}: {
  size?: number
  /** Defaults to the theme's foreground. */
  color?: string
  decorative?: boolean
  testID?: string
  style?: StyleProp<ImageStyle>
}) {
  const { c } = useTheme()
  const a11y = decorative
    ? {
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants' as const,
      }
    : { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: 'OpenAlgo' }
  return (
    <Image
      testID={testID}
      source={MARK}
      resizeMode="contain"
      {...a11y}
      style={[{ width: size, height: size, tintColor: color ?? c.foreground }, style]}
    />
  )
}
