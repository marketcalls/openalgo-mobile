// The session calls the web code makes at startup (design 7.7), answered on the phone so that no
// tool needs a web session: the CSRF token every POST waits for, the seeded broker store, the
// mode, the WebSocket placeholders the shim accepts, and the error reporter. None is sent. The
// mode switch is denied: only the app's Account screen changes it.
import { DOM_WS_URL, type DomReply, NATIVE_KEY, type ToolSeed } from '~/dom/bridge/protocol'
import type { Route } from './requests'

/** Any token will do: the bridge carries no headers and the gateway checks none. */
export const CSRF_REPLY = { csrf_token: 'native' }
export const TOGGLE_DENIED = "Switch LIVE or ANALYZE in the app's Account screen."

const answer = (method: Route['method'], path: string, reply: () => Promise<DomReply>): Route => ({
  method,
  path,
  handle: reply,
})
const success = (fields: Record<string, DomReply['body']>): DomReply => ({
  status: 200,
  body: { status: 'success', ...fields },
})

/**
 * `seed`: the broker store the page is seeded with. `analyzer`: the server's mode, read as the
 * app reads it. `onErrorReport`: one call per report the page's error reporter posts; the report
 * itself is neither read nor logged (it can hold URLs and the page's state).
 */
export function createStartupRoutes(o: {
  seed: () => ToolSeed
  analyzer: () => Promise<'live' | 'analyze'>
  onErrorReport?: () => void
}): Route[] {
  return [
    answer('GET', '/auth/csrf-token', async () => ({ status: 200, body: CSRF_REPLY })),
    // stores/brokerStore.ts reads `data` once `status` is success
    answer('GET', '/api/broker/capabilities', async () => success({ data: o.seed().capabilities })),
    // blueprints/auth.py get_analyzer_mode_status's body
    answer('GET', '/auth/analyzer-mode', async () => {
      const mode = await o.analyzer()
      return success({ data: { mode, analyze_mode: mode === 'analyze' } })
    }),
    answer('GET', '/api/websocket/config', async () => success({ websocket_url: DOM_WS_URL })),
    answer('GET', '/api/websocket/apikey', async () => success({ api_key: NATIVE_KEY })),
    answer('POST', '/admin/api/errors/client', async () => {
      o.onErrorReport?.()
      return { status: 204, body: null }
    }),
    answer('POST', '/auth/analyzer-toggle', async () => ({
      status: 403,
      body: { status: 'error', message: TOGGLE_DENIED },
    })),
  ]
}
