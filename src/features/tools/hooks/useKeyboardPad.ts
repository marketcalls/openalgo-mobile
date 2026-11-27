// The soft keyboard never covers a page's picker search or the field being typed in (design 7.7
// "Phone layout"). Android resizes the window for the keyboard, so the WebView shrinks above it,
// except edge to edge, where it may not: then the page's container is padded by the keyboard's
// height until it hides. iOS pads it through KeyboardAvoidingView (the screen's).
import { useEffect, useState } from 'react'
import { Dimensions, Keyboard, Platform, type ScaledSize } from 'react-native'

/** The padding the page's container needs now, in dp: 0 unless the window did not shrink. */
export function useKeyboardPad(bottomInset: number): number {
  const [pad, setPad] = useState(0)
  useEffect(() => {
    if (Platform.OS === 'ios') return
    /** The window's height with no keyboard up (a rotation or split screen changes it). */
    let resting = Dimensions.get('window').height
    let up = false
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      up = true
      // the window shrank for the keyboard: the page already ends above it
      if (Dimensions.get('window').height < resting) return
      setPad(Math.max(0, e.endCoordinates.height - bottomInset))
    })
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      up = false
      setPad(0)
    })
    const resize = Dimensions.addEventListener('change', (d: { window: ScaledSize }) => {
      if (!up) resting = d.window.height
    })
    return () => {
      show.remove()
      hide.remove()
      resize.remove()
    }
  }, [bottomInset])
  return pad
}
