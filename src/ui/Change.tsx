import { fmtPct, fmtSigned, signOf } from './format'
import { Text } from './Text'

/** The day's change and percent, in the profit or loss colour (muted when flat or unknown). */
export function Change({
  change,
  pct,
  testID,
}: {
  change?: number
  pct?: number
  testID?: string
}) {
  const sign = signOf(change ?? pct)
  const tone = sign > 0 ? 'profit' : sign < 0 ? 'loss' : 'muted'
  return (
    <Text variant="mono" tone={tone} testID={testID}>
      {fmtSigned(change)} ({fmtPct(pct)})
    </Text>
  )
}
