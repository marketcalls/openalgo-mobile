// The biometric check before a live order write (design 7.10, ruling 4): asked only when the
// user turned on "confirm live writes" and the phone has something to confirm with. It binds
// the native prompt, so the pure modules take it as a parameter (`confirmLive`).
import { usePrefs } from '~/core/config/prefs'
import { confirmLiveWrite, type PromptResult } from '~/core/credentials/lock'
import { defaultDeps } from '~/core/services/deps'

/** The prompt's title: a live write names itself (ruling 5 of Plan A). */
export const LIVE_ORDER_PROMPT = 'Confirm live order'

/** For `submitOrderAction`'s `confirmLive`, used by the ticket, the order and the position actions. */
export function confirmLiveOrder(): Promise<PromptResult> {
  return confirmLiveWrite({
    enabled: usePrefs.getState().confirmLiveWrites,
    available: defaultDeps.lock.available,
    prompt: () => defaultDeps.lock.confirm(LIVE_ORDER_PROMPT),
  })
}
