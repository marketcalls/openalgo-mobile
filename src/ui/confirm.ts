import { Alert } from 'react-native'

/**
 * A native confirm: resolves true when the user taps `ok`, false on Cancel, a tap outside or
 * the back button. An empty `body` shows the title alone.
 */
export function confirm(
  title: string,
  body: string,
  ok: string,
  o: { destructive?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      body || undefined,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
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
