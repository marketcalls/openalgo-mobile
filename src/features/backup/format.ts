// The backup file (design 7.7): the user's own content as JSON and nothing else. Pure, so the
// whole format is tested without a file system. Never the key, the server address or the
// profile id: only the content goes in, and the text is checked once more before it is shared.
import { istClock, istDate } from '~/core/realtime/marketHours'
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

/** Content keys are USER_CONTENT names; M3 to M5 add `strategyPortfolio`, `chartDrawings`, `chartPrefs`. */
export type BackupFile = {
  kind: typeof BACKUP_KIND
  schema: number
  createdAt: string
  appVersion: string
  content: { watchlists?: Watchlists } & Record<string, unknown>
}

/** The content keys this version can restore; any other key in a file is skipped, at any schema. */
const RESTORABLE = ['watchlists'] as const

export class BackupLeakError extends Error {
  constructor() {
    super('A backup would have carried an API key.')
    this.name = 'BackupLeakError'
  }
}

/** A JSON key named apikey; a list or symbol that merely is called that is not a key. */
const LEAK = /"api_?key"\s*:/i

export function buildBackup(o: {
  watchlists: Watchlists
  now: Date | number
  appVersion: string
}): string {
  const file: BackupFile = {
    kind: BACKUP_KIND,
    schema: BACKUP_SCHEMA,
    createdAt: new Date(typeof o.now === 'number' ? o.now : o.now.getTime()).toISOString(),
    appVersion: o.appVersion,
    content: { watchlists: o.watchlists },
  }
  const text = JSON.stringify(file, null, 2)
  if (LEAK.test(text)) throw new BackupLeakError()
  return text
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
