// One order write, sent at most once (design 7.10): the analyzer mode is read again and must
// match the badge the user confirmed (Review Focus 2), a live write may ask for biometrics,
// and the request goes out once, never retried. A reply that may hide a placed order is
// `maybe`, which the caller reconciles against the books; it never re-sends. A reply that shows
// the server went LIVE after an ANALYZE review is `done` with `liveSurprise`, which the caller
// must show as a danger notice.
import type { PromptResult } from '~/core/credentials/lock'
import { ApiError, isRecord, userMessage } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import type { BookInvalidator } from '~/core/query/invalidate'
import type { AnalyzerGate, AnalyzerMode } from './analyzerGate'

const TAG = 'orders'

export type ActionKind =
  | 'place'
  | 'split'
  | 'modify'
  | 'cancel'
  | 'cancelAll'
  | 'closeOne'
  | 'closeAll'

export type Outcome<R> =
  /**
   * `liveSurprise` (present only when true): the review showed ANALYZE, but the reply carries no
   * sandbox tag, so the server was LIVE and the write went to the broker, without the live
   * confirm. The gate's reading is already dropped.
   */
  | { kind: 'done'; reply: R; liveSurprise?: true }
  /** The server is no longer in the mode the user confirmed; nothing was sent. */
  | { kind: 'mode_changed'; now: AnalyzerMode }
  /** The live confirm said no; `message` when the check failed rather than the user. */
  | { kind: 'cancelled'; message?: string }
  /** No reply, a 502, a reply that could not be read, or a send that threw: it may have gone. */
  | { kind: 'maybe' }
  | { kind: 'semi_auto_blocked'; message: string }
  | { kind: 'error'; error: ApiError }

/**
 * How long the pre-send read may take (ruling 6): a read held behind a 429 gate would otherwise
 * send the order up to 30 s after the tap.
 */
export const READ_DEADLINE_MS = 5_000

/** The account screen's copy for a biometric check that failed (ruling 4). */
export const CONFIRM_FAILED = 'Could not confirm with biometrics. Try again.'

/** What went to the broker, by the write's kind, for the LIVE notice. */
const SENT_LIVE: Record<ActionKind, string> = {
  place: 'This order was placed',
  split: 'This order was placed',
  closeOne: 'This closing order was placed',
  modify: 'This change was sent',
  cancel: 'This cancellation was sent',
  cancelAll: 'Cancel all was sent',
  closeAll: 'Close all was sent',
}

/** The danger notice for a `liveSurprise` outcome of a `kind` write. */
export const liveSurpriseText = (kind: ActionKind) =>
  `${SENT_LIVE[kind]} in LIVE mode. The server switched to LIVE after your review.`

/** The notice for a placed order, as the ticket shows it. */
export const LIVE_SURPRISE = liveSurpriseText('place')

export type SubmitArgs<R> = {
  kind: ActionKind
  /** The mode on the badge the user confirmed. */
  shownMode: AnalyzerMode
  /** Sends the write; called at most once. */
  send: () => Promise<R>
  gate: Pick<AnalyzerGate, 'read' | 'noteReply' | 'invalidate'>
  /** The biometric check for a live write (`confirmLiveOrder`). */
  confirmLive: () => Promise<PromptResult>
  books: Pick<BookInvalidator, 'poke'>
  /** UI only: the server showed Semi-Auto (a queued reply or a Semi-Auto 403). */
  onSemiAuto?: () => void
}

/** The server's mode, given up with a Network error after `READ_DEADLINE_MS` (ruling 6). */
export async function readMode(gate: Pick<AnalyzerGate, 'read'>): Promise<AnalyzerMode> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), READ_DEADLINE_MS)
  try {
    return await gate.read({ signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function submitOrderAction<R>({
  kind,
  shownMode,
  send,
  gate,
  confirmLive,
  books,
  onSemiAuto,
}: SubmitArgs<R>): Promise<Outcome<R>> {
  let mode: AnalyzerMode
  try {
    mode = await readMode(gate)
  } catch (e) {
    const error =
      e instanceof ApiError ? e : new ApiError({ kind: 'Network', status: 0, endpoint: 'analyzer' })
    return { kind: 'error', error }
  }
  if (mode !== shownMode) {
    log.info(TAG, `${kind}: the server is now in ${mode} mode, not sent`)
    return { kind: 'mode_changed', now: mode }
  }

  if (mode === 'live') {
    const confirmed = await confirmLive().catch((e: unknown) => {
      log.warn(TAG, `${kind}: the live confirm failed`, e)
      return 'failed' as const
    })
    if (confirmed === 'failed') return { kind: 'cancelled', message: CONFIRM_FAILED }
    if (confirmed !== 'ok') return { kind: 'cancelled' }
  }

  let reply: R
  try {
    reply = await send()
  } catch (e) {
    books.poke()
    if (!(e instanceof ApiError)) {
      // The request may have gone before this threw, so it is never offered again.
      log.warn(TAG, `${kind}: the send threw`, e)
      return { kind: 'maybe' }
    }
    if (e.kind === 'MaybePlaced') return { kind: 'maybe' }
    if (e.kind === 'SemiAutoBlocked') {
      onSemiAuto?.()
      return { kind: 'semi_auto_blocked', message: userMessage(e) }
    }
    return { kind: 'error', error: e }
  }
  books.poke()
  if (isRecord(reply)) {
    if (reply.kind === 'queued') onSemiAuto?.()
    if (reply.analyze === true) gate.noteReply({ mode: 'analyze' })
    else if (reply.analyze === false && shownMode === 'analyze') {
      // C4: every sandbox success says mode:'analyze', and this one did not, so the write went
      // to the broker. The reading that said ANALYZE is dropped now: within its 5 s the next
      // write would otherwise go live unchecked, without the live confirm.
      gate.invalidate()
      log.warn(TAG, `${kind}: the review showed ANALYZE, but the server answered LIVE`)
      return { kind: 'done', reply, liveSurprise: true }
    }
  }
  return { kind: 'done', reply }
}
