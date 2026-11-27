// One request from a tool page, as the bridge carries it (design 7.7), by plan D's fetch rules
// (fetch.ts, which the chart page keeps to itself): only the app's own paths are bridged, a
// relative URL or one on DOM_ORIGIN, resolved against DOM_ORIGIN and never the page's file://
// location. Only GET and POST, and a POST's body is JSON text. Anything else is an Error, and
// nothing crosses the bridge.
import { DOM_ORIGIN, type DomRequest, type JSONValue } from '~/dom/bridge/protocol'
import { nextRid } from './client'

export function toDomRequest(method: string, url: string, body: unknown): DomRequest | Error {
  let href: URL
  try {
    href = new URL(url, DOM_ORIGIN)
  } catch {
    return new TypeError('openalgo-mobile: not a URL')
  }
  if (href.origin !== DOM_ORIGIN) return new TypeError('openalgo-mobile: only app paths are sent')

  const verb = method.toUpperCase()
  if (verb !== 'GET' && verb !== 'POST') {
    return new TypeError('openalgo-mobile: only GET and POST are sent')
  }
  let json: JSONValue | undefined
  if (body != null) {
    if (verb === 'GET') return new TypeError('openalgo-mobile: a GET has no body')
    if (typeof body !== 'string') {
      return new TypeError('openalgo-mobile: the body must be JSON text')
    }
    try {
      json = JSON.parse(body)
    } catch {
      return new TypeError('openalgo-mobile: the body must be JSON text')
    }
  }

  // The page's one rid sequence (client.ts), shared with the bridged fetch.
  const out: DomRequest = {
    v: 1,
    kind: 'request',
    rid: nextRid(),
    method: verb,
    path: href.pathname,
  }
  if (href.search !== '') out.query = Object.fromEntries(href.searchParams)
  if (json !== undefined) out.body = json
  return out
}
