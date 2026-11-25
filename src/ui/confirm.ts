import { Alert } from 'react-native'

/**
 * A native confirm: resolves true when the user taps `ok`, false on the dismiss button (`cancel`,
 * "Cancel" unless given), a tap outside or the back button. An empty `body` shows the title
 * alone. A confirm whose `ok` itself cancels something ("Cancel order") names its dismiss for
 * what it keeps ("Keep order"), so neither button reads "Cancel" twice.
 */
export function confirm(
  title: string,
  body: string,
  ok: string,
  o: { destructive?: boolean; cancel?: string } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      body || undefined,
      [
        { text: o.cancel ?? 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        {
          text: ok,
          style: o.destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    )
  })
}
