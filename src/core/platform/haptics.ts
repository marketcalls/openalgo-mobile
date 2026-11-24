import * as Haptics from 'expo-haptics'

// Haptics are a nicety: a device without them must never surface an error.
const ignore = () => {}

export function tapLight(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(ignore)
}

export function notifySuccess(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(ignore)
}

export function notifyWarning(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(ignore)
}
