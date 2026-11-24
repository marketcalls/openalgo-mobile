import { fmtPrice } from './format'
import { Text } from './Text'

export function Price({ value, testID }: { value?: number; testID?: string }) {
  return (
    <Text variant="mono" testID={testID}>
      {fmtPrice(value)}
    </Text>
  )
}
