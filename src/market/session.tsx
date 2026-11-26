// The broker session as trading screens see it (design 7.6): whether broker-backed calls are
// blocked, which broker the server uses, and the server's own web pages.
import { useSyncExternalStore } from 'react'
import { Linking } from 'react-native'
import { log } from '~/core/log/logger'
import { useConnection } from '~/core/services/connection'
import { type Services, useServices } from '~/core/services/services'

/**
 * True while broker-backed calls cannot succeed: the broker is logged out, the key is refused
 * or the IP is banned. Nothing polls then, and order buttons are disabled.
 */
export function useBrokerBlocked(): boolean {
  return useConnection(
    (c) => c.brokerSession === 'logged_out' || c.keyState === 'invalid' || c.banned !== null,
  )
}

/**
 * The server's broker: the feed's auth reply names it (design 7.6), else the connection's, else
 * the one the ping saved on the profile (ruling 20). Null when nothing has named it.
 */
export function useBroker(): string | null {
  const { realtime, profile } = useServices()
  const feed = useSyncExternalStore(realtime.onStatus, () => realtime.status().broker)
  const conn = useConnection((c) => c.broker)
  return feed ?? conn ?? profile.get().broker
}

/** `useBroker`'s answer at this moment, for code outside React (a reply's handler). */
export function currentBroker(s: Pick<Services, 'realtime' | 'profile'>): string | null {
  return s.realtime.status().broker ?? useConnection.getState().broker ?? s.profile.get().broker
}

export type ServerPage = '/login' | '/action-center' | '/apikey'

/** Opens one of the server's web pages in the system browser; a failure is only logged. */
export function openServerPage(origin: string, path: ServerPage): void {
  Linking.openURL(`${origin.replace(/\/+$/, '')}${path}`).catch((e) =>
    log.warn('session', `could not open ${path}`, e),
  )
}
