// Applying a changed server address or live-feed address (design 7.2). The services container
// builds its HTTP client for one origin, so a new address restarts the app group.
import { deriveWsUrl } from '~/core/config/urlRules'
import type { Services } from '~/core/services/services'
import { useSession } from '~/core/services/services'

/**
 * Saves the new address under the same profile id (watchlists and key stay) and drops the stored
 * capabilities, so the next start probes the server again. The app group then remounts.
 */
export async function applyServerUrl(s: Services, url: string, version: string | null) {
  const pid = s.profile.get().id
  await s.profile.update({ restOrigin: url, wsUrl: deriveWsUrl(url), serverVersion: version })
  await s.storage.del('caps')
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
