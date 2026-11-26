import { fmtPrice } from './format'
import { Text } from './Text'

/** A price; with `sign` (the day change's, from `signOf`) it takes the profit or loss colour. */
export function Price({
  value,
  testID,
  sign,
}: {
  value?: number
  testID?: string
  sign?: 1 | -1 | 0
}) {
  const tone = sign === 1 ? 'profit' : sign === -1 ? 'loss' : 'default'
  return (
    <Text variant="mono" tone={tone} testID={testID}>
      {fmtPrice(value)}
    </Text>
  )
}
