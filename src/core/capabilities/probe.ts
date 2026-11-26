// The capability probe (design 7.1): two public GETs, then at most `maxProbes` keyless
// `POST {}` probes. A server that never answers like OpenAlgo is not_openalgo, never
// too_old (RF 2): only a JSON reply with a string `status` counts as OpenAlgo's.
import { MIN_SERVER_VERSION } from '~/core/config/constants'
import { atLeast, normalizeVersion } from '~/core/config/version'
import type { HttpClient } from '~/core/http/client'
import type { EndpointId } from '~/core/http/endpoints'
import { ApiError, type ApiErrorKind, type BanForm } from '~/core/http/errors'
import { AppInfoSchema, SwaggerSchema } from '~/core/http/schemas'
import { log } from '~/core/log/logger'
import { type Capabilities, VERSION_GATES } from './gates'

export type ProbeOutcome =
  | { kind: 'ok'; caps: Capabilities }
  | { kind: 'too_old'; version: string | null }
  | { kind: 'not_openalgo' }
  | { kind: 'unreachable' }
  | { kind: 'banned'; form: BanForm }

export type ProbeOptions = {
  http: Pick<HttpClient, 'getPublic' | 'probe'>
  /** Recorded as `Capabilities.host`: the REST origin being probed. */
  host: string
  /** Recorded as `Capabilities.probedAt`, in ms. */
  now: number
  maxProbes?: number
}

const TAG = 'caps'
const APP_INFO = '/auth/app-info'
const SWAGGER = '/api/v1/swagger.json'
/** Present from 2.0.0.0 (S10). */
const MARKER = 'multioptiongreeks'
/** Probed when swagger.json is missing: the endpoints the tool gates and GTT support read. */
const TOOL_PROBES: readonly EndpointId[] = [
  'portfolio/backtest',
  'sip/backtest',
  'sectorrotation',
  'gttorderbook',
]

const isKind = (e: unknown, kind: ApiErrorKind): e is ApiError =>
  e instanceof ApiError && e.kind === kind

/**
 * The version app-info reports, normalized, or null unless the reply is JSON with a string
 * `version` (S8). Throws ApiError Network or IpBanned.
 */
export async function readAppVersion(http: Pick<HttpClient, 'getPublic'>): Promise<string | null> {
  const info = AppInfoSchema.safeParse((await http.getPublic(APP_INFO)).json)
  return info.success ? normalizeVersion(info.data.version) : null
}

/** The endpoint ids swagger.json lists, or null when it is not a JSON object with `paths`. */
async function readSwagger(http: Pick<HttpClient, 'getPublic'>): Promise<string[] | null> {
  try {
    const spec = SwaggerSchema.safeParse((await http.getPublic(SWAGGER)).json)
    return spec.success ? spec.data : null
  } catch (e) {
    if (isKind(e, 'Network')) return null
    throw e
  }
}

export async function probeServer({
  http,
  host,
  now,
  maxProbes = 10,
}: ProbeOptions): Promise<ProbeOutcome> {
  let used = 0
  const probed: Record<string, boolean> = {}

  /** True only for a 400 JSON reply; past the cap nothing is sent. */
  async function probe(id: EndpointId): Promise<boolean> {
    if (used >= maxProbes) return false
    used++
    const r = await http.probe(id)
    if (r !== 'unknown') probed[id] = r === 'present'
    return r === 'present'
  }

  async function run(): Promise<ProbeOutcome> {
    let version: string | null
    try {
      version = await readAppVersion(http)
    } catch (e) {
      if (isKind(e, 'Network')) return { kind: 'unreachable' }
      throw e
    }
    const endpoints = await readSwagger(http)

    let versionSource: Capabilities['versionSource'] = 'app-info'
    if (version !== null) {
      if (!atLeast(version, MIN_SERVER_VERSION)) return { kind: 'too_old', version }
    } else if (endpoints) {
      if (!endpoints.includes(MARKER)) return { kind: 'too_old', version: null }
      versionSource = 'marker'
    } else if (await probe(MARKER)) {
      versionSource = 'marker'
    } else if (await probe('ping')) {
      return { kind: 'too_old', version: null }
    } else {
      return { kind: 'not_openalgo' }
    }

    // One at a time: these are the only requests outside the scheduler's budget.
    if (!endpoints) for (const id of TOOL_PROBES) await probe(id)

    const caps: Capabilities = {
      host,
      version,
      versionSource,
      endpoints,
      probed,
      fields: {},
      features: {},
      ws: {
        orderStream: null,
        ping: null,
        close1012: atLeast(version, VERSION_GATES.close1012),
        authDeadline: atLeast(version, VERSION_GATES.authDeadline),
      },
      probedAt: now,
    }
    return { kind: 'ok', caps }
  }

  let out: ProbeOutcome
  try {
    out = await run()
  } catch (e) {
    if (!isKind(e, 'IpBanned') || !e.banForm) throw e
    out = { kind: 'banned', form: e.banForm }
  }
  log.info(TAG, `probe ${out.kind} after ${used} probes`)
  return out
}
