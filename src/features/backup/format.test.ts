import { WATCHLIST_LIMITS, type Watchlists } from '~/market/watchlists/model'
import {
  applyRestore,
  BACKUP_KIND,
  BACKUP_SCHEMA,
  BackupLeakError,
  backupFileName,
  buildBackup,
  droppedNotice,
  fitBackup,
  MAX_BACKUP_BYTES,
  parseBackup,
} from './format'

const W: Watchlists = {
  version: 2,
  activeId: 'b',
  lists: [
    {
      id: 'a',
      name: 'Watchlist',
      items: [{ exchange: 'NSE', symbol: 'TCS', group: 'g1' }],
      groups: [{ id: 'g1', name: 'Core' }],
      sort: 'az',
    },
    {
      id: 'b',
      name: 'Options',
      items: [
        { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        { exchange: 'NSE_INDEX', symbol: 'NIFTY' },
      ],
      groups: [],
      sort: 'added',
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
const list = (i: number) => ({
  id: `l${i}`,
  name: `List ${i}`,
  items: [],
  groups: [],
  sort: 'added' as const,
})
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
    const named: Watchlists = {
      ...W,
      lists: [{ id: 'a', name: 'apikey', items: [], groups: [], sort: 'added' }],
    }
    expect(() => buildBackup({ watchlists: named, now: NOW, appVersion: '1' })).not.toThrow()
  })

  test('refuses an api key inside a chart record value (escaped in the text)', () => {
    const chart = {
      drawings: [],
      prefs: [{ k: 'oac-widget:chart:state', v: JSON.stringify({ apikey: 'secret' }) }],
    }
    expect(() => buildBackup({ watchlists: W, chart, now: NOW, appVersion: '1' })).toThrow(
      BackupLeakError,
    )
  })

  test('a chart record the restore would skip is counted as left out at parse time', () => {
    const text = JSON.stringify({
      kind: 'openalgo-mobile-backup',
      schema: 2,
      content: {
        chartDrawings: [
          { k: 'oac-widget:chart:drawings:NSE:INFY', v: 'a' },
          { k: 'other:drawings:NSE:TCS', v: 'b' },
          { k: 'oac-widget:chart:state', v: 'c' },
        ],
        chartPrefs: [
          { k: 'oac-widget:chart:drawings:NSE:INFY', v: 'd' },
          { k: 'oac-widget:chart:state', v: 'e' },
        ],
      },
    })
    const r = parsed(text)
    expect(r.file.content.chartDrawings).toEqual([
      { k: 'oac-widget:chart:drawings:NSE:INFY', v: 'a' },
    ])
    expect(r.file.content.chartPrefs).toEqual([{ k: 'oac-widget:chart:state', v: 'e' }])
    expect(r.trimmed).toBe(3)
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
    const r = parsed(wrap({ watchlists: W, strategyPortfolio: { a: 1 } }, { schema: 3 }))
    expect(r.skipped).toEqual(['strategyPortfolio'])
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
      {
        id: 'a',
        name: 'A',
        items: [{ exchange: 'NSE', symbol: 'TCS' }],
        groups: [],
        sort: 'added',
      },
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
    const r = parsed(wrap({ strategyPortfolio: {} }))
    expect(r.file.content.watchlists).toBeUndefined()
    expect(r.skipped).toEqual(['strategyPortfolio'])
  })
})

describe('schema 2 (groups and sort)', () => {
  const lists = (raw: unknown) => parsed(wrap({ watchlists: { version: 2, lists: [raw] } }))

  test('the schema is 2 and groups, item groups and sort round-trip', () => {
    expect(BACKUP_SCHEMA).toBe(2)
    const r = parsed(buildBackup({ watchlists: W, now: NOW, appVersion: '0.2.0' }))
    expect(r.file.schema).toBe(2)
    expect(r.file.content.watchlists).toEqual(W)
  })

  test('a schema 1 file restores its lists with no groups and the added order', () => {
    const r = parsed(
      wrap(
        {
          watchlists: {
            version: 1,
            lists: [{ id: 'a', name: 'A', items: [{ exchange: 'NSE', symbol: 'TCS' }] }],
          },
        },
        { schema: 1 },
      ),
    )
    expect(r.file.content.watchlists?.lists[0]).toEqual({
      id: 'a',
      name: 'A',
      items: [{ exchange: 'NSE', symbol: 'TCS' }],
      groups: [],
      sort: 'added',
    })
  })

  test('21 groups keep 20 and count 1; blank names are dropped; names are cut to 30', () => {
    const groups = Array.from({ length: 21 }, (_, i) => ({ id: `g${i}`, name: `G${i}` }))
    const r = lists({ id: 'a', name: 'A', items: [], groups })
    expect(r.file.content.watchlists?.lists[0]?.groups).toHaveLength(WATCHLIST_LIMITS.groups)
    expect(r.trimmed).toBe(1)
    const c = lists({
      id: 'a',
      name: 'A',
      items: [],
      groups: [{ id: 'x', name: '  ' }, { id: 'y', name: 'n'.repeat(40) }, 5],
    })
    expect(c.file.content.watchlists?.lists[0]?.groups).toEqual([{ id: 'y', name: 'n'.repeat(30) }])
  })

  test('an item naming an unknown group restores ungrouped', () => {
    const r = lists({
      id: 'a',
      name: 'A',
      groups: [{ id: 'g1', name: 'G' }],
      items: [
        { exchange: 'NSE', symbol: 'TCS', group: 'nope' },
        { exchange: 'NSE', symbol: 'ITC', group: 'g1' },
        { exchange: 'NSE', symbol: 'SBIN', group: 7 },
      ],
    })
    expect(r.file.content.watchlists?.lists[0]?.items).toEqual([
      { exchange: 'NSE', symbol: 'TCS' },
      { exchange: 'NSE', symbol: 'ITC', group: 'g1' },
      { exchange: 'NSE', symbol: 'SBIN' },
    ])
  })

  test('a sort that is not one of the five becomes added', () => {
    expect(
      lists({ id: 'a', name: 'A', items: [], sort: 'random' }).file.content.watchlists?.lists[0]
        ?.sort,
    ).toBe('added')
    expect(
      lists({ id: 'a', name: 'A', items: [], sort: 'ltp' }).file.content.watchlists?.lists[0]?.sort,
    ).toBe('ltp')
  })

  test('group ids are unique within their list; items stay under the first of a duplicate', () => {
    const r = lists({
      id: 'a',
      name: 'A',
      groups: [{ id: 'g', name: 'First' }, { id: 'g', name: 'Second' }, { name: 'No id' }],
      items: [{ exchange: 'NSE', symbol: 'TCS', group: 'g' }],
    })
    const l = r.file.content.watchlists?.lists[0]
    expect(l?.groups).toEqual([
      { id: 'g', name: 'First' },
      { id: 'new1', name: 'Second' },
      { id: 'new2', name: 'No id' },
    ])
    expect(l?.items[0]?.group).toBe('g')
  })
})

describe('applyRestore', () => {
  const incoming: Watchlists = {
    version: 2,
    activeId: 'x',
    lists: [
      {
        id: 'x',
        name: 'Options',
        items: [{ exchange: 'NSE', symbol: 'SBIN', group: 'g' }],
        groups: [{ id: 'g', name: 'Picks' }],
        sort: 'ltp',
      },
    ],
  }

  test('replace swaps in the incoming lists', () => {
    expect(applyRestore(W, incoming, 'replace', newId)).toEqual({ value: incoming, leftOut: 0 })
  })

  test('merge appends and renames a clashing name', () => {
    const r = applyRestore(W, incoming, 'merge', newId).value
    expect(r.lists.map((l) => l.name)).toEqual(['Watchlist', 'Options', 'Options (restored)'])
    expect(r.activeId).toBe('b')
  })

  test('merge keeps the incoming groups, item groups and sort with their list', () => {
    const r = applyRestore(W, incoming, 'merge', newId).value
    expect(r.lists[2]).toMatchObject({
      name: 'Options (restored)',
      groups: [{ id: 'g', name: 'Picks' }],
      sort: 'ltp',
      items: [{ exchange: 'NSE', symbol: 'SBIN', group: 'g' }],
    })
  })

  test('merge keeps the renamed name within 30 characters', () => {
    const long = 'L'.repeat(30)
    const cur: Watchlists = {
      version: 2,
      activeId: 'a',
      lists: [{ id: 'a', name: long, items: [], groups: [], sort: 'added' }],
    }
    const inc: Watchlists = {
      version: 2,
      lists: [{ id: 'z', name: long, items: [], groups: [], sort: 'added' }],
    }
    const name = applyRestore(cur, inc, 'merge', newId).value.lists[1]?.name ?? ''
    expect(name.length).toBeLessThanOrEqual(30)
    expect(name.endsWith(' (restored)')).toBe(true)
    expect(name).not.toBe(long)
  })

  test('merge reissues a clashing id and keeps the 50-list limit', () => {
    const cur: Watchlists = {
      version: 2,
      activeId: 'l0',
      lists: Array.from({ length: 49 }, (_, i) => list(i)),
    }
    const inc: Watchlists = {
      version: 2,
      lists: [
        { id: 'l0', name: 'Fresh 1', items: [], groups: [], sort: 'added' },
        { id: 'q', name: 'Fresh 2', items: [], groups: [], sort: 'added' },
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

describe('chart content', () => {
  const rec = (k: string, v = 'v') => ({ k, v })
  const chart = {
    drawings: [rec('oac-widget:chart:drawings:NSE:INFY')],
    prefs: [rec('oac-widget:chart:state')],
  }

  test('a backup carries chart drawings and prefs and they parse back', () => {
    const { text, dropped } = fitBackup({ watchlists: W, chart, now: NOW, appVersion: '1' })
    expect(dropped).toEqual([])
    const r = parsed(text)
    expect(r.file.content.chartDrawings).toEqual(chart.drawings)
    expect(r.file.content.chartPrefs).toEqual(chart.prefs)
    expect(r.skipped).toEqual([])
    expect(r.file.schema).toBe(2)
  })

  test('the size is in UTF-8 bytes, as the picker measures the file', () => {
    const hindi = { k: 'oac-widget:chart:drawings:NSE:INFY', v: 'नमस्ते'.repeat(100_000) }
    const r = fitBackup({
      watchlists: W,
      chart: { drawings: [hindi, { ...hindi, k: 'oac-widget:chart:drawings:NSE:TCS' }], prefs: [] },
      now: NOW,
      appVersion: '1',
    })
    // Each value is 600,000 characters but 1,800,000 bytes: two are under 2M characters, not bytes.
    expect(r.dropped).toEqual(['chartDrawings'])
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(MAX_BACKUP_BYTES)
  })

  test('over 2 MB, drawings go first and are named', () => {
    const big = { k: 'oac-widget:chart:drawings:NSE:INFY', v: 'x'.repeat(1_000_000) }
    const big2 = { k: 'oac-widget:chart:drawings:NSE:TCS', v: 'x'.repeat(1_000_000) }
    const r = fitBackup({
      watchlists: W,
      chart: { drawings: [big, big2], prefs: chart.prefs },
      now: NOW,
      appVersion: '1',
    })
    expect(r.dropped).toEqual(['chartDrawings'])
    expect(r.text.length).toBeLessThanOrEqual(MAX_BACKUP_BYTES)
    const f = parsed(r.text).file
    expect(f.content.chartDrawings).toBeUndefined()
    expect(f.content.chartPrefs).toEqual(chart.prefs)
    expect(droppedNotice(r.dropped)).toBe(
      'Chart drawings were left out: the backup would be larger than 2 MB.',
    )
  })

  test('prefs go next when the drawings alone did not make it fit', () => {
    const bigPref = (i: number) => ({ k: `oac-widget:p${i}`, v: 'x'.repeat(900_000) })
    const r = fitBackup({
      watchlists: W,
      chart: { drawings: chart.drawings, prefs: [bigPref(1), bigPref(2), bigPref(3)] },
      now: NOW,
      appVersion: '1',
    })
    expect(r.dropped).toEqual(['chartDrawings', 'chartPrefs'])
    expect(droppedNotice(r.dropped)).toContain('Chart preferences were left out')
  })

  test('a hand-edited chart record is skipped and the rest restores', () => {
    const r = parsed(
      wrap({
        watchlists: { version: 1, lists: [{ id: 'a', name: 'A', items: [] }] },
        chartDrawings: [
          rec('k'.repeat(300)),
          { k: 'oac-widget:a', v: 5 },
          null,
          { v: 'no key' },
          rec('oac-widget:chart:drawings:NSE:SBIN'),
        ],
        chartPrefs: 'nope',
      }),
    )
    expect(r.file.content.watchlists?.lists).toHaveLength(1)
    expect(r.file.content.chartDrawings).toEqual([rec('oac-widget:chart:drawings:NSE:SBIN')])
    expect(r.file.content.chartPrefs).toBeUndefined()
  })

  test('at most 2,000 records per section; a value over 1,000,000 is skipped', () => {
    const many = Array.from({ length: 2001 }, (_, i) => rec(`oac-widget:k${i}`))
    const r = parsed(wrap({ chartPrefs: [...many, rec('oac-widget:big', 'x'.repeat(1_000_001))] }))
    expect(r.file.content.chartPrefs).toHaveLength(2000)
    expect(r.trimmed).toBe(1)
  })
})
