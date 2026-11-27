// The web stores a tool page reads, seeded from native's tool.init before the page renders (design
// 7.8): a session with the key placeholder (the DOM never holds the key), the broker's capabilities,
// the app's scheme in live mode (no analyzer purple on a DOM page: native's ANALYZE badge says the
// mode), and toasts where a phone wants them.
import { NATIVE_KEY, type ToolPageId, type ToolSeed } from '~/dom/bridge/protocol'
import { tokens } from '~/ui/tokens'
import {
  type AlertState,
  useAlertStore,
  useAuthStore,
  useBrokerStore,
  useThemeStore,
} from './stores'

/** Top centre (the bottom holds sticky errors, sheets and primary actions), two at a time, 5 s. */
export const TOAST_SETTINGS: AlertState = {
  position: 'top-center',
  duration: 5000,
  maxVisibleToasts: 2,
}

export function seedStores(seed: ToolSeed, scheme: 'dark' | 'light', page: ToolPageId): void {
  // A second call for the same seed (the scheme changed) keeps the session and the capabilities
  // objects, so no page effect that depends on them runs again (it would drop the page's picks).
  const auth = useAuthStore.getState()
  if (auth.apiKey !== NATIVE_KEY || !auth.isAuthenticated || auth.user?.broker !== seed.broker) {
    useAuthStore.setState({
      user: {
        username: 'mobile',
        broker: seed.broker,
        isLoggedIn: true,
        loginTime: new Date().toISOString(),
      },
      apiKey: NATIVE_KEY,
      isAuthenticated: true,
    })
  }
  if (useBrokerStore.getState().capabilities !== seed.capabilities) {
    useBrokerStore.setState({ capabilities: seed.capabilities, isLoaded: true })
  }
  useThemeStore.setState({ mode: scheme, appMode: 'live' })
  useAlertStore.setState(TOAST_SETTINGS)

  // What the theme store would do to <html> (themeStore.ts setAppMode), minus a colour theme: a
  // rehydrated analyzer or sandbox class must not survive the seed.
  const html = document.documentElement
  html.classList.remove('analyzer', 'sandbox')
  html.classList.toggle('dark', scheme === 'dark')
  html.removeAttribute('data-theme')
  html.dataset.oaTool = page
  // The app's profit and loss colours, for the pages' emerald and rose values (phone.css).
  const trade = tokens.trade[scheme]
  html.style.setProperty('--oa-profit', trade.profit)
  html.style.setProperty('--oa-loss', trade.loss)
}
