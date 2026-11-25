// An order write behind a native confirm rather than a review (Global 1): the server's mode,
// read now, heads the confirm's title, and the write is then checked against that mode
// (`submitOrderAction`'s `shownMode`), so a flip in between sends nothing (Review Focus 2).
import { confirm } from '~/ui/confirm'
import type { AnalyzerGate, AnalyzerMode } from './analyzerGate'
import { readMode } from './submit'

export const MODE_LABEL: Record<AnalyzerMode, string> = { live: 'LIVE', analyze: 'ANALYZE' }

export type ModeConfirm =
  | { kind: 'confirmed'; mode: AnalyzerMode }
  | { kind: 'declined' }
  /** The mode could not be read in time: nothing was asked. */
  | { kind: 'error'; error: unknown }

/** "LIVE · Cancel this order?": the confirm, once the mode is known. */
export async function confirmInMode(
  gate: Pick<AnalyzerGate, 'read'>,
  c: { title: string; body: string; ok: string; destructive?: boolean },
): Promise<ModeConfirm> {
  let mode: AnalyzerMode
  try {
    mode = await readMode(gate)
  } catch (error) {
    return { kind: 'error', error }
  }
  const yes = await confirm(`${MODE_LABEL[mode]} · ${c.title}`, c.body, c.ok, {
    destructive: c.destructive,
  })
  return yes ? { kind: 'confirmed', mode } : { kind: 'declined' }
}
