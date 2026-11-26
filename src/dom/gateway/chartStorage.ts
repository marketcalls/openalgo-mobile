// The chart's storage (design 7.9.5): drawings per profile and instrument, everything else the
// widget keeps (its state, layout, template choices) as preferences. Both are USER_CONTENT, so
// they survive "clear data" when asked to and travel in the backup.
import type { ProfileStorage } from '~/core/config/storage'
import type { DomReply, DomStorageMsg } from '~/dom/bridge/protocol'
import {
  createDomStorageHandler,
  type DomStoreRecord,
  readDomRecords,
  writeDomRecords,
} from './domStorage'

const DRAWINGS = 'chartDrawings:'
const PREFS = 'chartPrefs:'
export const CHART_AREAS = [DRAWINGS, PREFS] as const

/** `oac-widget:<namespace>:drawings:EX:SYM` (openalgo-charts DRAWINGS_KEY_PREFIX), namespace optional. */
const DRAWING_KEY = /^oac-widget:(?:[^:]+:)?drawings:(.+)$/

/** The stored name for a widget key: drawings by instrument, anything else a preference. */
export function chartStoreName(key: string): string {
  const m = DRAWING_KEY.exec(key)
  return m?.[1] !== undefined ? DRAWINGS + m[1] : PREFS + key
}

/** Only the widget's own keys are kept; a key outside its prefix is refused. */
const nameOf = (key: string): string | null =>
  key.startsWith('oac-widget:') ? chartStoreName(key) : null

export function createChartStorageHandler(
  storage: ProfileStorage,
): (m: DomStorageMsg) => Promise<DomReply> {
  return createDomStorageHandler({ storage, areas: CHART_AREAS, nameOf })
}

export async function readChartRecords(
  storage: ProfileStorage,
): Promise<{ drawings: DomStoreRecord[]; prefs: DomStoreRecord[] }> {
  return {
    drawings: await readDomRecords(storage, DRAWINGS),
    prefs: await readDomRecords(storage, PREFS),
  }
}

/** True when `writeChartRecords` would store a record with this key in this section. */
export function chartRecordStorable(section: 'drawings' | 'prefs', key: string): boolean {
  return nameOf(key)?.startsWith(section === 'drawings' ? DRAWINGS : PREFS) ?? false
}

/** Restores records: same key replaced, the rest kept. A record in the wrong section is skipped. */
export async function writeChartRecords(
  storage: ProfileStorage,
  r: { drawings: DomStoreRecord[]; prefs: DomStoreRecord[] },
): Promise<number> {
  const into = (area: string) => (key: string) => {
    const name = nameOf(key)
    return name?.startsWith(area) ? name : null
  }
  return (
    (await writeDomRecords(storage, r.drawings, into(DRAWINGS))) +
    (await writeDomRecords(storage, r.prefs, into(PREFS)))
  )
}
