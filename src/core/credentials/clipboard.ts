import { log } from '~/core/log/logger'
import { normalizeKeyInput } from './keyFormat'

/** The part of expo-clipboard this needs. */
export interface ClipboardLike {
  getStringAsync(): Promise<string>
  setStringAsync(text: string): Promise<unknown>
}

/**
 * After a pasted key validates, clears the clipboard if it still holds that key (iOS Universal
 * Clipboard would carry it to the user's other devices). Other clipboard text is left alone.
 */
export async function clearClipboardIfPasted(
  pasted: boolean,
  key: string,
  c: ClipboardLike,
): Promise<void> {
  if (!pasted) return
  try {
    if (normalizeKeyInput(await c.getStringAsync()).key === key) await c.setStringAsync('')
  } catch (e) {
    log.warn('clipboard', 'could not clear the clipboard', e)
  }
}
