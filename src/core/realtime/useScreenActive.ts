import { useIsFocused } from 'expo-router'
import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

/** True while the screen is focused and the app is in the foreground. */
export const useScreenActive = (): boolean => {
  const focused = useIsFocused()
  const [appActive, setAppActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'))
    return () => sub.remove()
  }, [])
  return focused && appActive
}
