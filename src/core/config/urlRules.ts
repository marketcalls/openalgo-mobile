import { DEFAULT_REST_PORT, DEFAULT_WS_PORT, WS_PATH } from './constants'

export type HostClass = 'home' | 'dev' | 'public'

export type UrlCheck =
  | {
      ok: true
      url: string
      scheme: string
      host: string
      hostClass: HostClass
      stripped: boolean
    }
  | {
      ok: false
      reason:
        | 'empty'
        | 'invalid'
        | 'has_credentials'
        | 'cleartext_public'
        | 'dev_host_in_release'
        | 'wrong_scheme'
    }

type Opts = { allowDevHosts: boolean }

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

export function classifyHost(host: string): HostClass {
  const h = host.toLowerCase()
  if (h === 'localhost') return 'dev'
  if (h.endsWith('.local')) return 'home'
  const m = IPV4.exec(h)
  if (!m) return 'public'
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127) return 'dev'
  if (a === 10) return 'home'
  if (a === 172 && b >= 16 && b <= 31) return 'home'
  if (a === 192 && b === 168) return 'home'
  if (a === 169 && b === 254) return 'home'
  if (a === 100 && b >= 64 && b <= 127) return 'home'
  return 'public'
}

type Parsed =
  | {
      ok: true
      scheme: string | null
      host: string
      port: number | null
      path: string
      extra: boolean
    }
  | { ok: false; reason: 'empty' | 'invalid' | 'has_credentials' }

function parse(input: string): Parsed {
  const t = input.trim()
  if (!t) return { ok: false, reason: 'empty' }
  const sm = /^([a-z][a-z0-9+.-]*):\/\//i.exec(t)
  const scheme = sm?.[1] ? sm[1].toLowerCase() : null
  const rest = sm ? t.slice(sm[0].length) : t
  const cut = rest.search(/[/?#]/)
  const authority = cut === -1 ? rest : rest.slice(0, cut)
  const tail = cut === -1 ? '' : rest.slice(cut)
  if (authority.includes('@')) return { ok: false, reason: 'has_credentials' }
  const pm = /^([^:]*)(?::(\d*))?$/.exec(authority)
  if (!pm) return { ok: false, reason: 'invalid' }
  const host = (pm[1] ?? '').toLowerCase()
  if (!HOSTNAME.test(host)) return { ok: false, reason: 'invalid' }
  const ipm = IPV4.exec(host)
  if (ipm?.slice(1).some((o) => Number(o) > 255)) return { ok: false, reason: 'invalid' }
  let port: number | null = null
  if (pm[2] !== undefined) {
    port = Number(pm[2])
    if (pm[2] === '' || port < 1 || port > 65535) return { ok: false, reason: 'invalid' }
  }
  const q = tail.search(/[?#]/)
  const path = q === -1 ? tail : tail.slice(0, q)
  return { ok: true, scheme, host, port, path, extra: q !== -1 }
}

function hostPolicy(
  hostClass: HostClass,
  secure: boolean,
  o: Opts,
): 'dev_host_in_release' | 'cleartext_public' | null {
  if (hostClass === 'dev' && !o.allowDevHosts) return 'dev_host_in_release'
  if (hostClass === 'public' && !secure) return 'cleartext_public'
  return null
}

export function normalizeServerUrl(input: string, o: Opts): UrlCheck {
  const p = parse(input)
  if (!p.ok) return p
  if (p.scheme !== null && p.scheme !== 'http' && p.scheme !== 'https') {
    return { ok: false, reason: 'invalid' }
  }
  const hostClass = classifyHost(p.host)
  let port = p.port
  let stripped = p.extra || (p.path !== '' && p.path !== '/')
  let scheme = p.scheme
  if (scheme === null) {
    if (hostClass === 'public') scheme = 'https'
    else {
      scheme = 'http'
      port ??= DEFAULT_REST_PORT
    }
  }
  if ((scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)) {
    port = null
    stripped = true
  }
  const refused = hostPolicy(hostClass, scheme === 'https', o)
  if (refused) return { ok: false, reason: refused }
  const url = `${scheme}://${p.host}${port === null ? '' : `:${port}`}`
  return { ok: true, url, scheme, host: p.host, hostClass, stripped }
}

/** Like normalizeServerUrl for ws/wss, but the path is kept (it is `/ws` on a tunnel). */
export function checkWsUrl(input: string, o: Opts): UrlCheck {
  const p = parse(input)
  if (!p.ok) return p
  if (p.scheme === null) return { ok: false, reason: 'invalid' }
  if (p.scheme === 'http' || p.scheme === 'https') return { ok: false, reason: 'wrong_scheme' }
  if (p.scheme !== 'ws' && p.scheme !== 'wss') return { ok: false, reason: 'invalid' }
  const hostClass = classifyHost(p.host)
  let port = p.port
  let stripped = p.extra
  if ((p.scheme === 'wss' && port === 443) || (p.scheme === 'ws' && port === 80)) {
    port = null
    stripped = true
  }
  const refused = hostPolicy(hostClass, p.scheme === 'wss', o)
  if (refused) return { ok: false, reason: refused }
  const path = p.path === '/' ? '' : p.path
  const url = `${p.scheme}://${p.host}${port === null ? '' : `:${port}`}${path}`
  return { ok: true, url, scheme: p.scheme, host: p.host, hostClass, stripped }
}

/** https origin -> wss://host[:port]/ws (the tunnel path); http origin -> ws://host:8765. */
export function deriveWsUrl(restOrigin: string): string | null {
  const p = parse(restOrigin)
  if (!p.ok || (p.scheme !== 'http' && p.scheme !== 'https')) return null
  if (p.scheme === 'https') {
    return `wss://${p.host}${p.port === null || p.port === 443 ? '' : `:${p.port}`}${WS_PATH}`
  }
  return `ws://${p.host}:${DEFAULT_WS_PORT}`
}

export function sameHost(a: string, b: string): boolean {
  const pa = parse(a)
  const pb = parse(b)
  return pa.ok && pb.ok && pa.host === pb.host
}

/** Home and dev hosts are on the local network; everything else goes through a tunnel. */
export function pollNetwork(origin: string): 'home' | 'tunnel' {
  const p = parse(origin)
  return p.ok && classifyHost(p.host) !== 'public' ? 'home' : 'tunnel'
}
