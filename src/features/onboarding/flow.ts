// Onboarding's steps (design 7.1) as plain functions over an injected fetch and WebSocket, so the
// compat suite runs them against the mock server. The screens add only the prompts between them.
import type { Capabilities } from '~/core/capabilities/gates'
import { type ProbeOutcome, probeServer } from '~/core/capabilities/probe'
import { createCapabilityStore } from '~/core/capabilities/store'
import { createProfileRepo, newProfileId, type ServerProfile } from '~/core/config/profile'
import { type KV, profileStorage } from '~/core/config/storage'
import { normalizeServerUrl, type UrlCheck } from '~/core/config/urlRules'
import { normalizeKeyInput } from '~/core/credentials/keyFormat'
import { createKeyStore, type SecureKV } from '~/core/credentials/keyStore'
import { checkKey } from '~/core/credentials/status'
import { createHttpClient, type HttpClient } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import { FundsSchema, PingSchema } from '~/core/http/schemas'
import {
  type HandshakeOptions,
  type HandshakeResult,
  testLiveFeed,
} from '~/core/realtime/handshake'
import type { BrokerSession } from '~/core/services/connection'

export type UrlError = Extract<UrlCheck, { ok: false }>['reason']

export type ServerStepResult =
  | { kind: 'ok'; url: string; caps: Capabilities }
  | { kind: 'url_error'; reason: UrlError }
  | Exclude<ProbeOutcome, { kind: 'ok' }>

export type KeyStepResult =
  | { kind: 'ok'; key: string; brokerSession: BrokerSession; broker: string | null }
  | { kind: 'format' }
  | { kind: 'invalid' }
  | { kind: 'error'; error: unknown }

type HandshakeFailure = Extract<HandshakeResult, { ok: false }>['reason']

export type FeedStepResult =
  /**
   * `reason` is set when the feed answered with a broker error: the socket and key work, and
   * prices stream once the user logs in to the broker.
   */
  | { mode: 'live'; broker: string | null; reason?: 'broker_logged_out' }
  | { mode: 'polling'; reason: Exclude<HandshakeFailure, 'broker_error'> }

/** What onboarding saves: the probed server, the checked key and the tested feed. */
export type OnboardingResult = {
  url: string
  caps: Capabilities
  key: string
  broker: string | null
  wsUrl: string | null
  feedMode: 'live' | 'polling'
  httpWarningAcked: boolean
}

const FEED_ATTEMPTS = 3

const noKey = (): never => {
  throw new Error('the server step sends no key')
}

const isKind = (e: unknown, kind: ApiError['kind']) => e instanceof ApiError && e.kind === kind

/** Normalizes the address (design 7.1 step 1), then probes the version (step 2). Keyless. */
export async function serverStep(
  input: string,
  d: { fetch: typeof fetch; allowDevHosts: boolean; now: () => number },
): Promise<ServerStepResult> {
  const check = normalizeServerUrl(input, { allowDevHosts: d.allowDevHosts })
  if (!check.ok) return { kind: 'url_error', reason: check.reason }
  const http = createHttpClient({
    origin: check.url,
    fetch: d.fetch,
    getKey: noKey,
    resolveAuth403: noKey,
  })
  const out = await probeServer({ http, host: check.url, now: d.now() })
  return out.kind === 'ok' ? { kind: 'ok', url: check.url, caps: out.caps } : out
}

/**
 * Checks a key (design 7.1 step 3): the format locally, then `search` (the key alone), `funds`
 * (the broker session) and `ping` (the broker's name). A bad format sends nothing.
 */
export async function keyStep(
  origin: string,
  raw: string,
  d: { fetch: typeof fetch },
): Promise<KeyStepResult> {
  const { key, ok } = normalizeKeyInput(raw)
  if (!ok) return { kind: 'format' }
  const http: Pick<HttpClient, 'request'> = createHttpClient({
    origin,
    fetch: d.fetch,
    getKey: () => key,
    // Search has accepted the key by then, so a later 403 means a logged-out broker (S3).
    resolveAuth403: async () => 'broker_logged_out',
  })
  try {
    if ((await checkKey(http)) === 'invalid') return { kind: 'invalid' }
  } catch (error) {
    return { kind: 'error', error }
  }

  let brokerSession: BrokerSession = 'active'
  try {
    await http.request('funds', {}, FundsSchema)
  } catch (error) {
    if (isKind(error, 'IpBanned')) return { kind: 'error', error }
    brokerSession = isKind(error, 'BrokerLoggedOut') ? 'logged_out' : 'unknown'
  }

  let broker: string | null = null
  try {
    broker = (await http.request('ping', {}, PingSchema)).broker
  } catch (error) {
    if (isKind(error, 'IpBanned')) return { kind: 'error', error }
  }
  return { kind: 'ok', key, brokerSession, broker }
}

/**
 * The live-feed test (design 7.1 step 4): three handshakes, then polling. A BROKER_* answer to
 * authenticate proves the socket reaches OpenAlgo and the key works, so it is live with the
 * broker logged out: polling would keep the feed off for 10 minutes after the broker login.
 */
export async function feedStep(
  wsUrl: string,
  key: string,
  d: Omit<HandshakeOptions, 'attempts'>,
): Promise<FeedStepResult> {
  const r = await testLiveFeed(wsUrl, key, { ...d, attempts: FEED_ATTEMPTS })
  if (r.ok) return { mode: 'live', broker: r.broker }
  if (r.reason === 'broker_error') {
    return { mode: 'live', broker: null, reason: 'broker_logged_out' }
  }
  return { mode: 'polling', reason: r.reason }
}

/**
 * Saves onboarding (design 7.1 step 5) under the existing profile's id, or a new one. The key
 * marker is written last, so boot sees a finished onboarding or none.
 */
export async function saveOnboarding(
  r: OnboardingResult,
  d: { kv: KV; secureKV: SecureKV; uuid: () => string; now: () => number },
): Promise<ServerProfile> {
  const repo = createProfileRepo(d.kv)
  const existing = await repo.load()
  const now = d.now()
  const profile: ServerProfile = {
    id: existing?.id ?? newProfileId(d.uuid()),
    restOrigin: r.url,
    wsUrl: r.wsUrl,
    feedMode: r.feedMode,
    httpWarningAcked: r.httpWarningAcked || (existing?.httpWarningAcked ?? false),
    serverVersion: r.caps.version,
    broker: r.broker,
    createdAt: existing?.createdAt ?? now,
    // Ruling 7: the failed test counts as a live-feed retry, so the next waits 10 minutes.
    lastFeedRetryAt: r.feedMode === 'polling' ? now : null,
  }
  await repo.save(profile)
  await createCapabilityStore(profileStorage(d.kv, profile.id)).save(r.caps)
  await createKeyStore(d.secureKV, d.kv, profile.id).save(r.key)
  return profile
}
