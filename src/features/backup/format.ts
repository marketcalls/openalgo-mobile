// The backup file (design 7.7): the user's own content as JSON and nothing else. Pure, so the
// whole format is tested without a file system. Never the key, the server address or the
// profile id: only the content goes in, and the text is checked once more before it is shared.
import { istClock, istDate } from '~/core/realtime/marketHours'
import { chartRecordStorable } from '~/dom/gateway/chartStorage'
import {
  type DomStoreRecord,
  MAX_DOM_KEY,
  MAX_DOM_VALUE,
  utf8Length,
} from '~/dom/gateway/domStorage'
import { ALL_EXCHANGES } from '~/market/instruments/exchanges'
import {
  WATCH_SORTS,
  WATCHLIST_LIMITS,
  type WatchGroup,
  type WatchItem,
  type Watchlists,
  type WatchSort,
} from '~/market/watchlists/model'

export const BACKUP_KIND = 'openalgo-mobile-backup'
export const BACKUP_SCHEMA = 2
export const MAX_BACKUP_BYTES = 2_000_000

/** A parsed chart record: its key at most MAX_DOM_KEY characters, its value a string of at most MAX_DOM_VALUE. */
/** Records per chart section; the rest are counted as trimmed. */
const CHART_RECORDS_MAX = 2000

export type ChartRecords = { drawings: DomStoreRecord[]; prefs: DomStoreRecord[] }
export type ChartSection = 'chartDrawings' | 'chartPrefs'

/** Content keys are USER_CONTENT names; M4 adds `strategyPortfolio`. */
export type BackupFile = {
  kind: typeof BACKUP_KIND
  schema: number
  createdAt: string
  appVersion: string
  content: {
    watchlists?: Watchlists
    chartDrawings?: DomStoreRecord[]
    chartPrefs?: DomStoreRecord[]
  } & Record<string, unknown>
}

/** The content keys this version can restore; any other key in a file is skipped, at any schema. */
const RESTORABLE = ['watchlists', 'chartDrawings', 'chartPrefs'] as const

export class BackupLeakError extends Error {
  constructor() {
    super('A backup would have carried an API key.')
    this.name = 'BackupLeakError'
  }
}

/** A JSON key named apikey; a list or symbol that merely is called that is not a key. */
const LEAK = /\\*"api_?key\\*"\s*:/i

export function buildBackup(o: {
  watchlists: Watchlists
  chart?: ChartRecords
  now: Date | number
  appVersion: string
}): string {
  const content: BackupFile['content'] = { watchlists: o.watchlists }
  if (o.chart?.drawings.length) content.chartDrawings = o.chart.drawings
  if (o.chart?.prefs.length) content.chartPrefs = o.chart.prefs
  const file: BackupFile = {
    kind: BACKUP_KIND,
    schema: BACKUP_SCHEMA,
    createdAt: new Date(typeof o.now === 'number' ? o.now : o.now.getTime()).toISOString(),
    appVersion: o.appVersion,
    content,
  }
  const text = JSON.stringify(file, null, 2)
  if (LEAK.test(text)) throw new BackupLeakError()
  return text
}

/**
 * The backup text, within MAX_BACKUP_BYTES: drawings are left out first, then preferences, and
 * `dropped` names what was. The watchlists always stay.
 */
export function fitBackup(o: {
  watchlists: Watchlists
  chart: ChartRecords
  now: Date | number
  appVersion: string
}): { text: string; dropped: ChartSection[] } {
  const dropped: ChartSection[] = []
  let chart = o.chart
  let text = buildBackup({ ...o, chart })
  // The picker refuses a file by its bytes on disk (UTF-8), so that is what is measured.
  if (utf8Length(text) > MAX_BACKUP_BYTES && chart.drawings.length > 0) {
    dropped.push('chartDrawings')
    chart = { ...chart, drawings: [] }
    text = buildBackup({ ...o, chart })
  }
  if (utf8Length(text) > MAX_BACKUP_BYTES && chart.prefs.length > 0) {
    dropped.push('chartPrefs')
    chart = { ...chart, prefs: [] }
    text = buildBackup({ ...o, chart })
  }
  return { text, dropped }
}

const DROPPED_NAME: Record<ChartSection, string> = {
  chartDrawings: 'Chart drawings',
  chartPrefs: 'Chart preferences',
}

/** What to tell the user when a backup left chart content out; null when nothing was. */
export function droppedNotice(dropped: readonly ChartSection[]): string | null {
  if (dropped.length === 0) return null
  return dropped
    .map((d) => `${DROPPED_NAME[d]} were left out: the backup would be larger than 2 MB.`)
    .join(' ')
}

/**
 * `trimmed`: entries over the limits, left out. `unlisted`: entries whose exchange no OpenAlgo
 * version accepts (a hand-edited file), left out: one such entry would fail the whole multiquotes
 * batch of its list.
 */
export type ParsedBackup =
  | { ok: true; file: BackupFile; skipped: string[]; trimmed: number; unlisted: number }
  | { ok: false; reason: 'too_large' | 'not_backup' }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const FIELD_MAX = 64

/** The usable records of a chart section; `trimmed` counts those past the section's limit. */
function cleanRecords(
  v: unknown,
  section: 'drawings' | 'prefs',
): { records: DomStoreRecord[]; trimmed: number } {
  const records: DomStoreRecord[] = []
  let trimmed = 0
  for (const r of Array.isArray(v) ? v : []) {
    if (
      !isRecord(r) ||
      typeof r.k !== 'string' ||
      r.k === '' ||
      r.k.length > MAX_DOM_KEY ||
      typeof r.v !== 'string' ||
      r.v.length > MAX_DOM_VALUE
    ) {
      continue
    }
    // A record the restore would skip (a key outside the widget's, or in the wrong section) is
    // counted as left out here, so the summary matches what is restored.
    if (!chartRecordStorable(section, r.k)) trimmed++
    else if (records.length >= CHART_RECORDS_MAX) trimmed++
    else records.push({ k: r.k, v: r.v })
  }
  return { records, trimmed }
}

/** An entry, its exchange upper-cased ('nse' is NSE); 'unlisted' when no server accepts it. */
const cleanItem = (v: unknown): (WatchItem & { rawGroup?: string }) | 'unlisted' | null => {
  if (!isRecord(v) || typeof v.exchange !== 'string' || typeof v.symbol !== 'string') return null
  const exchange = v.exchange.trim().toUpperCase()
  const symbol = v.symbol.trim()
  if (!exchange || !symbol || exchange.length > FIELD_MAX || symbol.length > FIELD_MAX) return null
  if (!ALL_EXCHANGES.includes(exchange)) return 'unlisted'
  return typeof v.group === 'string'
    ? { exchange, symbol, rawGroup: v.group }
    : { exchange, symbol }
}

/** An id not in `taken`: from `newId` when it gives a fresh one, else numbered from its last try. */
function freshId(newId: () => string, taken: Set<string>): string {
  let id = newId()
  for (let i = 0; i < 5 && taken.has(id); i++) id = newId()
  for (let k = 2; taken.has(id); k++) id = `${id.replace(/-\d+$/, '')}-${k}`
  return id
}

const cut = (name: string) => name.slice(0, WATCHLIST_LIMITS.nameMax)

/**
 * A list's groups: a record with a non-blank name, cut to 30 characters, at most 20 (the extras
 * count in `trimmed`), ids unique within the list. `known` maps a file's group id to the kept id:
 * a repeated id keeps its items with the first group.
 */
function cleanGroups(
  v: unknown,
  newId: () => string,
): { groups: WatchGroup[]; known: Map<string, string>; trimmed: number } {
  const groups: WatchGroup[] = []
  const known = new Map<string, string>()
  const taken = new Set<string>()
  let trimmed = 0
  for (const g of Array.isArray(v) ? v : []) {
    if (!isRecord(g) || typeof g.name !== 'string') continue
    const name = cut(g.name.trim())
    if (!name) continue
    if (groups.length >= WATCHLIST_LIMITS.groups) {
      trimmed++
      continue
    }
    const given = typeof g.id === 'string' && g.id !== '' ? g.id : null
    const id = given !== null && !taken.has(given) ? given : freshId(newId, taken)
    taken.add(id)
    if (given !== null && !known.has(given)) known.set(given, id)
    groups.push({ id, name })
  }
  return { groups, known, trimmed }
}

const isSort = (v: unknown): v is WatchSort => (WATCH_SORTS as readonly unknown[]).includes(v)

/** The lists of a `watchlists` value that are usable, within the limits; null when none are. */
function cleanWatchlists(
  v: unknown,
  newId: () => string,
): { value: Watchlists; trimmed: number; unlisted: number } | null {
  if (!isRecord(v) || !Array.isArray(v.lists)) return null
  let trimmed = 0
  let unlisted = 0
  const taken = new Set<string>()
  const lists: Watchlists['lists'] = []
  const valid = v.lists.filter(isRecord)
  for (const raw of valid) {
    const name = typeof raw.name === 'string' ? cut(raw.name.trim()) : ''
    if (!name) continue
    if (lists.length >= WATCHLIST_LIMITS.lists) {
      trimmed++
      continue
    }
    const g = cleanGroups(raw.groups, newId)
    trimmed += g.trimmed
    const seen = new Set<string>()
    const items: WatchItem[] = []
    for (const r of Array.isArray(raw.items) ? raw.items : []) {
      const item = cleanItem(r)
      if (item === 'unlisted') {
        unlisted++
        continue
      }
      if (!item) continue
      const k = `${item.exchange}:${item.symbol}`
      if (seen.has(k)) continue
      seen.add(k)
      if (items.length >= WATCHLIST_LIMITS.items) trimmed++
      else {
        const group = item.rawGroup === undefined ? undefined : g.known.get(item.rawGroup)
        items.push(
          group === undefined
            ? { exchange: item.exchange, symbol: item.symbol }
            : { exchange: item.exchange, symbol: item.symbol, group },
        )
      }
    }
    const given = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
    const id = given !== null && !taken.has(given) ? given : freshId(newId, taken)
    taken.add(id)
    lists.push({ id, name, items, groups: g.groups, sort: isSort(raw.sort) ? raw.sort : 'added' })
  }
  if (lists.length === 0) return null
  const active = typeof v.activeId === 'string' && taken.has(v.activeId) ? v.activeId : lists[0]?.id
  return { value: { version: 2, activeId: active, lists }, trimmed, unlisted }
}

const fallbackId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export function parseBackup(text: string, newId: () => string = fallbackId): ParsedBackup {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, reason: 'too_large' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not_backup' }
  }
  if (
    !isRecord(raw) ||
    raw.kind !== BACKUP_KIND ||
    typeof raw.schema !== 'number' ||
    !Number.isInteger(raw.schema) ||
    raw.schema < 1 ||
    !isRecord(raw.content)
  ) {
    return { ok: false, reason: 'not_backup' }
  }
  const skipped = Object.keys(raw.content).filter(
    (k) => !(RESTORABLE as readonly string[]).includes(k),
  )
  const content: BackupFile['content'] = {}
  let trimmed = 0
  let unlisted = 0
  if ('watchlists' in raw.content) {
    const w = cleanWatchlists(raw.content.watchlists, newId)
    if (w) {
      content.watchlists = w.value
      trimmed = w.trimmed
      unlisted = w.unlisted
    }
  }
  for (const key of ['chartDrawings', 'chartPrefs'] as const) {
    if (!(key in raw.content)) continue
    const c = cleanRecords(raw.content[key], key === 'chartDrawings' ? 'drawings' : 'prefs')
    if (c.records.length > 0) content[key] = c.records
    trimmed += c.trimmed
  }
  return {
    ok: true,
    file: {
      kind: BACKUP_KIND,
      schema: raw.schema,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
      content,
    },
    skipped,
    trimmed,
    unlisted,
  }
}

const SUFFIX = ' (restored)'

/** `name` made unique among `taken` (lower case): "{name} (restored)", numbered if that is taken too. */
function restoredName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  for (let k = 1; ; k++) {
    const tail = k === 1 ? SUFFIX : `${SUFFIX.slice(0, -1)} ${k})`
    const candidate = name.slice(0, WATCHLIST_LIMITS.nameMax - tail.length).trimEnd() + tail
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * The lists after a restore. Replace swaps them in; merge appends within the limits, and
 * `leftOut` counts the incoming lists past them, which the screen says (RF 5: a restore trimmed
 * to the limits says so).
 */
export function applyRestore(
  current: Watchlists,
  incoming: Watchlists,
  mode: 'replace' | 'merge',
  newId: () => string,
): { value: Watchlists; leftOut: number } {
  if (mode === 'replace') return { value: incoming, leftOut: 0 }
  const ids = new Set(current.lists.map((l) => l.id))
  const names = new Set(current.lists.map((l) => l.name.toLowerCase()))
  const lists = [...current.lists]
  let leftOut = 0
  for (const l of incoming.lists) {
    if (lists.length >= WATCHLIST_LIMITS.lists) {
      leftOut++
      continue
    }
    const id = ids.has(l.id) ? freshId(newId, ids) : l.id
    const name = restoredName(l.name, names)
    ids.add(id)
    names.add(name.toLowerCase())
    lists.push({ id, name, items: l.items, groups: l.groups, sort: l.sort })
  }
  return { value: { ...current, lists }, leftOut }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `openalgo-backup-20261124-1430.json`, in IST. */
export function backupFileName(now: Date | number): string {
  const { hh, mm } = istClock(now)
  return `openalgo-backup-${istDate(now).replaceAll('-', '')}-${pad(hh)}${pad(mm)}.json`
}
