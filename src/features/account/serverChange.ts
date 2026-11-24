// Applying a changed server address or live-feed address (design 7.2). The services container
// builds its HTTP client for one origin, so a new address restarts the app group.
import type { Capabilities } from '~/core/capabilities/gates'
import { deriveWsUrl } from '~/core/config/urlRules'
import type { Services } from '~/core/services/services'
import { useSession } from '~/core/services/services'

/**
 * Saves the new address under the same profile id (watchlists and key stay), with the
 * capabilities its probe just found, so the next start does not probe it again. The old
 * server's feed mode and retry clock say nothing about the new one: its feed starts live, as
 * a fresh attempt. The app group then remounts.
 */
export async function applyServerUrl(s: Services, url: string, caps: Capabilities) {
  const pid = s.profile.get().id
  await s.profile.update({
    restOrigin: url,
    wsUrl: deriveWsUrl(url),
    serverVersion: caps.version,
    feedMode: 'live',
    lastFeedRetryAt: null,
  })
  await s.caps.save(caps)
  const status = useSession.getState().status
  useSession.getState().set({ status: 'loading' })
  // one tick, so the root layout unmounts the old group before the new one mounts
  await new Promise((r) => setTimeout(r, 0))
  useSession.getState().set({ status, profileId: pid })
}

/** Saves the tested live-feed address and mode, then restarts the feed on it. */
export async function applyFeed(
  s: Services,
  r: { wsUrl: string; mode: 'live' | 'polling'; now: number },
) {
  await s.profile.update({
    wsUrl: r.wsUrl,
    feedMode: r.mode,
    lastFeedRetryAt: r.mode === 'polling' ? r.now : null,
  })
  s.realtime.stop()
  s.realtime.start()
}
