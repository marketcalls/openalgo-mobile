// An order write behind a native confirm rather than a review (Global 1): the server's mode,
// read now, heads the confirm's title, and the write is then checked against that mode
// (`submitOrderAction`'s `shownMode`), so a flip in between sends nothing (Review Focus 2).
// A tab's write acts on a row of a book the screen read in the mode it last knew: when the read
// finds the server in another mode, that row is the other mode's (a live position on a sandbox
// server), so nothing is asked and the books are read again (`followAnalyzerMode`).
import { confirm } from '~/ui/confirm'
import type { AnalyzerGate, AnalyzerMode } from './analyzerGate'
import { readMode } from './submit'

export const MODE_LABEL: Record<AnalyzerMode, string> = { live: 'LIVE', analyze: 'ANALYZE' }

export type ModeConfirm =
  | { kind: 'confirmed'; mode: AnalyzerMode }
  | { kind: 'declined' }
  /** The mode could not be read in time: nothing was asked. */
  | { kind: 'error'; error: unknown }
  /** The server is in another mode than the screen last knew: its rows may be the other mode's. */
  | { kind: 'mode_changed'; now: AnalyzerMode }

/** "LIVE · Cancel this order?": the confirm, once the mode is known. */
export async function confirmInMode(
  gate: Pick<AnalyzerGate, 'read' | 'peek'>,
  c: { title: string; body: string; ok: string; cancel?: string; destructive?: boolean },
): Promise<ModeConfirm> {
  const known = gate.peek()
  let mode: AnalyzerMode
  try {
    mode = await readMode(gate)
  } catch (error) {
    return { kind: 'error', error }
  }
  if (known !== null && mode !== known) return { kind: 'mode_changed', now: mode }
  const yes = await confirm(`${MODE_LABEL[mode]} · ${c.title}`, c.body, c.ok, {
    destructive: c.destructive,
    cancel: c.cancel,
  })
  return yes ? { kind: 'confirmed', mode } : { kind: 'declined' }
}
