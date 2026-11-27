// The web frontend's own stores, the ones the shell seeds and reads, loaded through typed requires:
// the pages read these very instances, and tsc never checks the frontend's closure under the app's
// flags (design 7.8). Only the fields the shell touches are typed.
import type { BrokerCapsJson } from '~/dom/bridge/protocol'

type Store<S> = {
  getState(): S
  setState(partial: Partial<S>): void
  <T>(select: (s: S) => T): T
}

export type AuthState = {
  user: {
    username: string
    broker: string | null
    isLoggedIn: boolean
    loginTime: string | null
  } | null
  apiKey: string | null
  isAuthenticated: boolean
}
export type BrokerState = { capabilities: BrokerCapsJson | null; isLoaded: boolean }
export type ThemeState = { mode: 'light' | 'dark'; appMode: 'live' | 'analyzer' }
export type ToastPosition =
  | 'top-right'
  | 'top-center'
  | 'top-left'
  | 'bottom-right'
  | 'bottom-center'
  | 'bottom-left'
export type AlertState = { position: ToastPosition; maxVisibleToasts: number; duration: number }

export const useAuthStore = (require('@/stores/authStore') as { useAuthStore: Store<AuthState> })
  .useAuthStore
export const useBrokerStore = (
  require('@/stores/brokerStore') as { useBrokerStore: Store<BrokerState> }
).useBrokerStore
export const useThemeStore = (
  require('@/stores/themeStore') as { useThemeStore: Store<ThemeState> }
).useThemeStore
export const useAlertStore = (
  require('@/stores/alertStore') as { useAlertStore: Store<AlertState> }
).useAlertStore
