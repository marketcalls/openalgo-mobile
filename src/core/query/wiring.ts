import NetInfo from '@react-native-community/netinfo'
import { focusManager, onlineManager } from '@tanstack/react-query'
import { AppState } from 'react-native'

/** Connects app foreground and network state to TanStack Query; returns the cleanup. */
export const wireQueryManagers = (): (() => void) => {
  const appSub = AppState.addEventListener('change', (state) => {
    focusManager.setFocused(state === 'active')
  })
  const unsubNet = NetInfo.addEventListener((s) => {
    onlineManager.setOnline(s.isConnected !== false)
  })
  return () => {
    appSub.remove()
    unsubNet()
  }
}
