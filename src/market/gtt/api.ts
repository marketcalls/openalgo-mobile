// The GTT endpoints (G1-G4), each one Api.call with its G2 body and its reply schema. Each reply
// also says whether this server serves GTT for its broker in the mode the reply came from: the
// mode is the reply's own, never the badge's, since GTT support differs by mode (Review Focus 2).
import type { Api } from '~/core/http/api'
import type { RequestOptions } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import {
  type GttBook,
  GttBookSchema,
  type GttReply,
  GttReplySchema,
  type GttSpec,
  gttCancelBody,
  gttModifyBody,
  gttPlaceBody,
} from './schemas'

type GttMode = 'live' | 'analyze'

/** Where each reply's evidence of support goes: `ok` is whether GTT was served in `mode`. */
export type GttSeen = { record(ok: boolean, mode: GttMode): void }

export type GttApi = {
  place(s: GttSpec, o?: RequestOptions): Promise<GttReply>
  modify(triggerId: string, s: GttSpec, o?: RequestOptions): Promise<GttReply>
  cancel(triggerId: string, o?: RequestOptions): Promise<GttReply>
  /** Every status (2.0.2.4+); an older server's refusal of `status` heals to active rows only. */
  book(o?: RequestOptions): Promise<GttBook>
}

/** ANALYZE mode before the sandbox served GTT (G1: before 2.0.1.9). */
const SANDBOX_501 = 'Sandbox GTT support not yet implemented'

const modeOf = (analyze: boolean): GttMode => (analyze ? 'analyze' : 'live')

/**
 * What a refused place or book read shows. A 501 is the sandbox's (ANALYZE) or the broker's
 * (LIVE, G3). A route that is missing answers HTML, with no message: no mode has GTT. Any other
 * refusal carries the server's message (a JSON 404 is the broker's status passed through) and
 * shows nothing.
 */
function recordRefusal(seen: GttSeen, e: unknown): void {
  if (!(e instanceof ApiError) || e.kind !== 'Unsupported') return
  if (e.status === 501) {
    seen.record(false, e.serverMessage === SANDBOX_501 ? 'analyze' : 'live')
  } else if (e.serverMessage === undefined) {
    seen.record(false, 'live')
    seen.record(false, 'analyze')
  }
}

export function createGttApi(api: Api, seen: GttSeen): GttApi {
  /**
   * Only an `ok` reply shows GTT served: a Semi-Auto place is queued before the server checks
   * the mode or the broker (place_gtt_order_service.py:227), and no_id shows nothing. Modify and
   * cancel never record a refusal: their 404 is "No active GTT" (G3), and they reach only a GTT
   * the book listed.
   */
  async function write(send: () => Promise<GttReply>, refusals: boolean): Promise<GttReply> {
    let reply: GttReply
    try {
      reply = await send()
    } catch (e) {
      if (refusals) recordRefusal(seen, e)
      throw e
    }
    if (reply.kind === 'ok') seen.record(true, modeOf(reply.analyze))
    return reply
  }

  return {
    place: (s, o) =>
      write(() => api.call('placegttorder', gttPlaceBody(s), GttReplySchema, o), true),
    modify: (triggerId, s, o) =>
      write(
        () => api.call('modifygttorder', gttModifyBody(triggerId, s), GttReplySchema, o),
        false,
      ),
    cancel: (triggerId, o) =>
      write(() => api.call('cancelgttorder', gttCancelBody(triggerId), GttReplySchema, o), false),
    async book(o) {
      let book: GttBook
      try {
        book = await api.call('gttorderbook', { status: 'all' }, GttBookSchema, o)
      } catch (e) {
        recordRefusal(seen, e)
        throw e
      }
      seen.record(true, modeOf(book.analyze))
      return book
    },
  }
}
