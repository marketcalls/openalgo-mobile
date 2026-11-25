// While an order is on its way the ticket stays open, so its outcome shows where it was sent.
import { usePreventRemove } from 'expo-router'
import { useEffect } from 'react'
import { BackHandler, Platform } from 'react-native'
import { toast } from '~/ui/Toast'

export const HOLD_COPY = 'The order is being sent. Wait for its outcome.'

/**
 * Holds the ticket open while `hold` is true.
 * - **iOS:** removal is prevented, so react-native-screens refuses the sheet's swipe
 *   (`preventNativeDismiss`) and a pop does nothing.
 * - **Android:** the back button is consumed. The form sheet itself can still be swiped away:
 *   react-native-screens 4.30 makes an Android sheet always draggable and hideable, and refusing
 *   the pop after that native dismissal would leave an invisible screen in the stack. So removal
 *   is not prevented there, and the ticket reports a gone sheet's outcome through the toast.
 */
export function useHoldSheet(hold: boolean): void {
  usePreventRemove(hold && Platform.OS === 'ios', () => toast(HOLD_COPY))
  useEffect(() => {
    if (!hold) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      toast(HOLD_COPY)
      return true
    })
    return () => sub.remove()
  }, [hold])
}
