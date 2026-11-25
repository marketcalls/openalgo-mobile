import { WATCHLIST_LIMITS, type Watchlists } from '~/market/watchlists/model'
import {
  applyRestore,
  BACKUP_KIND,
  BACKUP_SCHEMA,
  BackupLeakError,
  backupFileName,
  buildBackup,
  MAX_BACKUP_BYTES,
  parseBackup,
} from './format'

const W: Watchlists = {
  version: 1,
  activeId: 'b',
  lists: [
    { id: 'a', name: 'Watchlist', items: [{ exchange: 'NSE', symbol: 'TCS' }] },
    {
      id: 'b',
      name: 'Options',
      items: [
        { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        { exchange: 'NSE_INDEX', symbol: 'NIFTY' },
      ],
    },
  ],
}
const NOW = Date.UTC(2026, 10, 24, 9, 0)
let n = 0
const newId = () => `new${++n}`
const wrap = (content: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: BACKUP_KIND,
    schema: BACKUP_SCHEMA,
    createdAt: 'x',
    appVersion: '1',
    content,
    ...over,
  })
const list = (i: number) => ({ id: `l${i}`, name: `List ${i}`, items: [] })
const parsed = (text: string) => {
  const r = parseBackup(text, newId)
  if (!r.ok) throw new Error(r.reason)
  return r
}

beforeEach(() => {
  n = 0
})

describe('buildBackup', () => {
  test('holds only the content: no key, server address or profile id; parses back the same', () => {
    // the profile's storage also holds these; none can reach the file because only the lists go in
    const text = buildBackup({ watchlists: W, now: NOW, appVersion: '0.2.0' })
    expect(text).not.toMatch(/apikey|secret-key-123|https?:\/\/|profile-id-9/i)
    expect(text).toContain('\n  "kind": "openalgo-mobile-backup"')
    const r = parsed(text)
    expect(r.file.content.watchlists).toEqual(W)
    expect(r.file.appVersion).toBe('0.2.0')
    expect(r.file.createdAt).toBe(new Date(NOW).toISOString())
    expect(r.skipped).toEqual([])
    expect(r.trimmed).toBe(0)
  })

  test('refuses text that carries an api key field, but not a list that is named that', () => {
    const leaky = { ...W, lists: [{ ...W.lists[0], items: [], apikey: 'k' }] } as unknown
    expect(() =>
      buildBackup({ watchlists: leaky as Watchlists, now: NOW, appVersion: '1' }),
    ).toThrow(BackupLeakError)
    const named: Watchlists = { ...W, lists: [{ id: 'a', name: 'apikey', items: [] }] }
    expect(() => buildBackup({ watchlists: named, now: NOW, appVersion: '1' })).not.toThrow()
  })
})

describe('parseBackup (RF 5)', () => {
  test('over 2 MB is too large', () => {
    expect(parseBackup('x'.repeat(3_000_000))).toEqual({ ok: false, reason: 'too_large' })
    expect(parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    })
  })

  test.each([
    ['{}'],
    ['not json'],
    ['[]'],
    ['null'],
    [JSON.stringify({ kind: 'other', schema: 1, content: {} })],
    [JSON.stringify({ kind: BACKUP_KIND, schema: 'one', content: {} })],
    [JSON.stringify({ kind: BACKUP_KIND, schema: 1, content: [] })],
  ])('%s is not a backup', (text) => {
    expect(parseBackup(text)).toEqual({ ok: false, reason: 'not_backup' })
  })

  test('a newer schema keeps the known keys and lists the rest', () => {
    const r = parsed(wrap({ watchlists: W, chartDrawings: { a: 1 } }, { schema: 2 }))
    expect(r.skipped).toEqual(['chartDrawings'])
    expect(r.file.content.watchlists?.lists).toHaveLength(2)
    expect(Object.keys(r.file.content)).toEqual(['watchlists'])
  })

  test('60 lists keep 50 and count 10', () => {
    const lists = Array.from({ length: 60 }, (_, i) => list(i))
    const r = parsed(wrap({ watchlists: { version: 1, lists } }))
    expect(r.file.content.watchlists?.lists).toHaveLength(WATCHLIST_LIMITS.lists)
    expect(r.trimmed).toBe(10)
  })

  test('300 items keep 250 and count 50', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ exchange: 'NSE', symbol: `S${i}` }))
    const r = parsed(wrap({ watchlists: { version: 1, lists: [{ id: 'a', name: 'A', items }] } }))
    expect(r.file.content.watchlists?.lists[0]?.items).toHaveLength(WATCHLIST_LIMITS.items)
    expect(r.trimmed).toBe(50)
  })

  test('invalid items and lists are dropped one by one, repeats once', () => {
    const items = [
      { exchange: 'NSE' },
      { exchange: 'NSE', symbol: 'TCS' },
      { exchange: 'NSE', symbol: 'TCS' },
      'x',
      { exchange: 5, symbol: 'A' },
      { exchange: 'BSE', symbol: ' ' },
    ]
    const r = parsed(
      wrap({
        watchlists: {
          version: 1,
          lists: [{ id: 'a', name: 'A', items }, { id: 'b', name: '', items: [] }, 7, null],
        },
      }),
    )
    expect(r.file.content.watchlists?.lists).toEqual([
      { id: 'a', name: 'A', items: [{ exchange: 'NSE', symbol: 'TCS' }] },
    ])
    expect(r.trimmed).toBe(0)
  })

  test('a hand-edited exchange is upper-cased; one no OpenAlgo accepts is left out and counted', () => {
    const items = [
      { exchange: 'nse', symbol: 'ITC' },
      { exchange: 'NSEX', symbol: 'TCS' },
      { exchange: 'mcx_index', symbol: 'MCXCOMPDEX' },
    ]
    const r = parsed(wrap({ watchlists: { version: 1, lists: [{ id: 'a', name: 'A', items }] } }))
    expect(r.file.content.watchlists?.lists[0]?.items).toEqual([
      { exchange: 'NSE', symbol: 'ITC' },
      { exchange: 'MCX_INDEX', symbol: 'MCXCOMPDEX' },
    ])
    expect(r.unlisted).toBe(1)
    expect(r.trimmed).toBe(0)
  })

  test('duplicate and missing list ids are reissued; the active list stays valid', () => {
    const r = parsed(
      wrap({
        watchlists: {
          version: 1,
          activeId: 'gone',
          lists: [
            { id: 'a', name: 'A', items: [] },
            { id: 'a', name: 'B', items: [] },
            { name: 'C', items: [] },
          ],
        },
      }),
    )
    const w = r.file.content.watchlists
    expect(w?.lists.map((l) => l.id)).toEqual(['a', 'new1', 'new2'])
    expect(w?.activeId).toBe('a')
  })

  test('a reissue never repeats even when the id source is constant', () => {
    const r = parseBackup(
      wrap({
        watchlists: {
          version: 1,
          lists: [1, 2, 3].map(() => ({ id: 'a', name: 'A', items: [] })),
        },
      }),
      () => 'same',
    )
    if (!r.ok) throw new Error('not ok')
    const ids = r.file.content.watchlists?.lists.map((l) => l.id) ?? []
    expect(new Set(ids).size).toBe(3)
  })

  test('a long name is cut to 30 characters', () => {
    const r = parsed(
      wrap({ watchlists: { version: 1, lists: [{ id: 'a', name: 'n'.repeat(40), items: [] }] } }),
    )
    expect(r.file.content.watchlists?.lists[0]?.name).toHaveLength(30)
  })

  test('a file with nothing to restore is still a backup', () => {
    const r = parsed(wrap({ chartPrefs: {} }))
    expect(r.file.content.watchlists).toBeUndefined()
    expect(r.skipped).toEqual(['chartPrefs'])
  })
})

describe('applyRestore', () => {
  const incoming: Watchlists = {
    version: 1,
    activeId: 'x',
    lists: [{ id: 'x', name: 'Options', items: [{ exchange: 'NSE', symbol: 'SBIN' }] }],
  }

  test('replace swaps in the incoming lists', () => {
    expect(applyRestore(W, incoming, 'replace', newId)).toEqual({ value: incoming, leftOut: 0 })
  })

  test('merge appends and renames a clashing name', () => {
    const r = applyRestore(W, incoming, 'merge', newId).value
    expect(r.lists.map((l) => l.name)).toEqual(['Watchlist', 'Options', 'Options (restored)'])
    expect(r.activeId).toBe('b')
  })

  test('merge keeps the renamed name within 30 characters', () => {
    const long = 'L'.repeat(30)
    const cur: Watchlists = {
      version: 1,
      activeId: 'a',
      lists: [{ id: 'a', name: long, items: [] }],
    }
    const inc: Watchlists = { version: 1, lists: [{ id: 'z', name: long, items: [] }] }
    const name = applyRestore(cur, inc, 'merge', newId).value.lists[1]?.name ?? ''
    expect(name.length).toBeLessThanOrEqual(30)
    expect(name.endsWith(' (restored)')).toBe(true)
    expect(name).not.toBe(long)
  })

  test('merge reissues a clashing id and keeps the 50-list limit', () => {
    const cur: Watchlists = {
      version: 1,
      activeId: 'l0',
      lists: Array.from({ length: 49 }, (_, i) => list(i)),
    }
    const inc: Watchlists = {
      version: 1,
      lists: [
        { id: 'l0', name: 'Fresh 1', items: [] },
        { id: 'q', name: 'Fresh 2', items: [] },
      ],
    }
    const { value: r, leftOut } = applyRestore(cur, inc, 'merge', newId)
    expect(r.lists).toHaveLength(50)
    expect(r.lists[49]?.id).toBe('new1')
    expect(new Set(r.lists.map((l) => l.id)).size).toBe(50)
    // the list past the limit is counted, so the screen says it was left out (RF 5)
    expect(leftOut).toBe(1)
  })
})

test('the file name is the IST time', () => {
  expect(backupFileName(NOW)).toBe('openalgo-backup-20261124-1430.json')
  expect(backupFileName(new Date(Date.UTC(2026, 11, 31, 19, 5)))).toBe(
    'openalgo-backup-20270101-0035.json',
  )
})
