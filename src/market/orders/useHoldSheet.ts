// While a write is on its way its sheet stays open, so its outcome shows where it was sent. The
// ticket and the modify sheet share it.
import { usePreventRemove } from 'expo-router'
import { useEffect } from 'react'
import { BackHandler, Platform } from 'react-native'
import { toast } from '~/ui/Toast'

export const HOLD_COPY = 'The order is being sent. Wait for its outcome.'

/**
 * Holds the sheet open while `hold` is true; `copy` says why when a dismissal is refused.
 * - **iOS:** removal is prevented, so react-native-screens refuses the sheet's swipe
 *   (`preventNativeDismiss`) and a pop does nothing.
 * - **Android:** the back button is consumed. The form sheet itself can still be swiped away:
 *   react-native-screens 4.30 makes an Android sheet always draggable and hideable, and refusing
 *   the pop after that native dismissal would leave an invisible screen in the stack. So removal
 *   is not prevented there, and the sheet reports a gone sheet's outcome through the toast.
 */
export function useHoldSheet(hold: boolean, copy: string = HOLD_COPY): void {
  usePreventRemove(hold && Platform.OS === 'ios', () => toast(copy))
  useEffect(() => {
    if (!hold) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      toast(copy)
      return true
    })
    return () => sub.remove()
  }, [hold, copy])
}
