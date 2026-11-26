// The once-a-day update check: one anonymous GET of GitHub's latest release, no body, no
// credentials. Nothing about the user or their server is sent.
import { z } from 'zod'
import type { KV } from '~/core/config/storage'
import { compareVersions } from '~/core/config/version'
import { log } from '~/core/log/logger'

export const RELEASES_API =
  'https://api.github.com/repos/marketcalls/openalgo-mobile/releases/latest'
export const RELEASES_PAGE = 'https://github.com/marketcalls/openalgo-mobile/releases'
export const UPDATE_KEY = 'oa.update.v1'
export const CHECK_EVERY_MS = 86_400_000
export const UPDATE_TIMEOUT_MS = 10_000

const TAG = 'update'

export type UpdateNotice = { version: string; url: string }
export type UpdateState = { checkedAt: number; latest: UpdateNotice | null; dismissed?: string }

const StateSchema = z.object({
  checkedAt: z.number(),
  latest: z.object({ version: z.string(), url: z.string() }).nullable(),
  dismissed: z.string().optional(),
})

const TAG_RE = /^v?\d+\.\d+\.\d+$/

/** The release as a notice, or null for a draft, a prerelease or a tag that is not x.y.z. */
export function parseRelease(json: unknown): UpdateNotice | null {
  if (!json || typeof json !== 'object') return null
  const r = json as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  if (typeof r.tag_name !== 'string' || !TAG_RE.test(r.tag_name)) return null
  const html = r.html_url
  const url =
    typeof html === 'string' && html.startsWith(`${RELEASES_PAGE}/`)
      ? html
      : `${RELEASES_PAGE}/latest`
  return { version: r.tag_name.replace(/^v/, ''), url }
}

export async function readUpdateState(kv: KV): Promise<UpdateState | null> {
  try {
    const raw = await kv.get(UPDATE_KEY)
    if (!raw) return null
    const parsed = StateSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function writeState(kv: KV, state: UpdateState): Promise<void> {
  try {
    await kv.set(UPDATE_KEY, JSON.stringify(state))
  } catch (e) {
    log.warn(TAG, 'could not store the update state', e)
  }
}

/** The stored release when it is newer than this app and not dismissed. */
export function noticeFor(state: UpdateState | null, appVersion: string): UpdateNotice | null {
  const latest = state?.latest
  if (!latest || latest.version === state?.dismissed) return null
  return compareVersions(latest.version, appVersion) > 0 ? latest : null
}

export type UpdateDeps = {
  fetch: typeof fetch
  kv: KV
  now: () => number
  appVersion: string
  enabled: boolean
}

export async function checkForUpdate(d: UpdateDeps): Promise<UpdateNotice | null> {
  if (!d.enabled) return null
  const state = await readUpdateState(d.kv)
  if (state && d.now() - state.checkedAt < CHECK_EVERY_MS) return noticeFor(state, d.appVersion)

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), UPDATE_TIMEOUT_MS)
  try {
    const res = await d.fetch(RELEASES_API, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const latest = parseRelease(JSON.parse(await res.text()))
    const next: UpdateState = { checkedAt: d.now(), latest }
    if (state?.dismissed !== undefined) next.dismissed = state.dismissed
    await writeState(d.kv, next)
    return noticeFor(next, d.appVersion)
  } catch (e) {
    log.warn(TAG, 'the update check failed', e)
    await writeState(d.kv, {
      checkedAt: d.now(),
      latest: state?.latest ?? null,
      dismissed: state?.dismissed,
    })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Remember that this version's banner was dismissed. */
export async function dismissUpdate(kv: KV, version: string): Promise<void> {
  const state = await readUpdateState(kv)
  await writeState(kv, {
    checkedAt: state?.checkedAt ?? 0,
    latest: state?.latest ?? null,
    dismissed: version,
  })
}
