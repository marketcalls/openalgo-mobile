// The GTT paths of the app against the stock-server mock, over a real socket and Node's fetch,
// on each version profile: support by version and mode, place, modify and cancel, the trigger
// direction (RF 6), an unknown outcome, a mode flip and Semi-Auto.
import { atLeast } from '~/core/config/version'
import { reconcileGttCancel, reconcileGttPlacement } from '~/market/gtt/reconcile'
import type { GttSpec } from '~/market/gtt/schemas'
import { GTT_GATES, gttSupport } from '~/market/gtt/support'
import { probeCaps } from '../helpers/compatApp'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'
import { type TradingHarness, tradingHarness } from '../helpers/tradingHarness'

const G3_MODIFY = 'Modify GTT order is not allowed in Semi-Auto mode. Switch to Auto mode.'
const G3_CANCEL = 'Cancel GTT order is not allowed in Semi-Auto mode. Switch to Auto mode.'

// The mock's LTP for RELIANCE is about 1,800.
const SINGLE: GttSpec = {
  type: 'SINGLE',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  product: 'CNC',
  quantity: 1,
  trigger: 1500,
  price: 1499,
  above: false,
}
const OCO: GttSpec = {
  type: 'OCO',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'SELL',
  product: 'CNC',
  quantity: 1,
  sl: { trigger: 1700, price: 1699 },
  tg: { trigger: 1900, price: 1901 },
}

let mock: MockServerProcess | null = null
let h: TradingHarness | null = null
afterEach(async () => {
  h?.dispose()
  h = null
  await mock?.stop()
  mock = null
})

async function start(env: Record<string, string>): Promise<TradingHarness> {
  mock = await startMockServerProcess(env)
  h = await tradingHarness(mock)
  return h
}

/** The trigger id of a `done` GTT write. */
function triggerIdOf(o: Awaited<ReturnType<TradingHarness['submit']>>): string {
  if (o.kind !== 'done') throw new Error(`not done: ${o.kind}`)
  const r = o.reply as { kind: string; triggerId?: string }
  if (r.kind !== 'ok' || !r.triggerId) throw new Error(`not ok: ${r.kind}`)
  return r.triggerId
}

describe('2.0.0.0', () => {
  test('the GTT endpoints are not listed: support is no, needing 2.0.0.8', async () => {
    const t = await start({ PROFILE: '2.0.0.0' })
    const caps = await probeCaps(mock as MockServerProcess)
    const s = gttSupport(caps, { mode: 'live', broker: 'zerodha' })
    expect(s).toMatchObject({ state: 'no', needs: GTT_GATES.endpoints, detect: false })
    expect((await t.stats()).requests.placegttorder).toBeUndefined()
  })

  test('without swagger the probe reads gttorderbook once and finds it missing', async () => {
    const t = await start({ PROFILE: '2.0.0.0' })
    await t.control({ swagger: false })
    const caps = await probeCaps(mock as MockServerProcess)
    expect(caps.probed.gttorderbook).toBe(false)
    expect(gttSupport(caps, { mode: 'live', broker: 'zerodha' })).toMatchObject({
      state: 'no',
      needs: GTT_GATES.endpoints,
    })
    const stats = await t.stats()
    expect(stats.requests.gttorderbook).toBe(1)
    expect(stats.requests.placegttorder).toBeUndefined()
  })
})

describe.each(['2.0.1.6', '2.0.2.0', '2.0.3.5'])('%s', (profile) => {
  describe('LIVE', () => {
    test('place, modify and cancel a SINGLE; the book follows', async () => {
      const t = await start({ PROFILE: profile })
      const placed = await t.submit('gttPlace', () => t.gtt.place(SINGLE), 'live')
      expect(placed).toMatchObject({ kind: 'done', reply: { kind: 'ok', analyze: false } })
      const id = triggerIdOf(placed)

      const next = { ...SINGLE, trigger: 1510 }
      const mod = await t.submit('gttModify', () => t.gtt.modify(id, next), 'live')
      expect(mod).toMatchObject({ kind: 'done', reply: { kind: 'ok', triggerId: id } })
      const book = await t.gtt.book({ fresh: true })
      expect(book.rows.find((r) => r.triggerId === id)).toMatchObject({
        status: 'active',
        triggers: [1510],
      })

      const cancel = await t.submit('gttCancel', () => t.gtt.cancel(id), 'live')
      expect(cancel).toMatchObject({ kind: 'done', reply: { kind: 'ok' } })
      const r = await reconcileGttCancel({
        fetchBook: () => t.gtt.book({ fresh: true }),
        triggerId: id,
        sleep: t.sleep,
        delaysMs: t.delaysMs,
      })
      // Before 2.0.2.4 the book lists active rows only, so a cancelled one is gone from it; from
      // 2.0.3.5 the book keeps it.
      expect(r).toEqual({ found: profile === '2.0.3.5' ? 'cancelled' : 'gone', checked: true })
    })

    test('an OCO is placed with both legs', async () => {
      const t = await start({ PROFILE: profile })
      const id = triggerIdOf(await t.submit('gttPlace', () => t.gtt.place(OCO), 'live'))
      const row = (await t.gtt.book({ fresh: true })).rows.find((r) => r.triggerId === id)
      expect(row).toMatchObject({ type: 'OCO', status: 'active', triggers: [1700, 1900] })
      expect(row?.legs.map((l) => l.price)).toEqual([1699, 1901])
    })

    test('the book read records GTT as served in LIVE', async () => {
      const t = await start({ PROFILE: profile })
      await t.gtt.book({ fresh: true })
      expect(t.gttSeen.calls).toContainEqual([true, 'live'])
    })
  })

  if (!atLeast(profile, GTT_GATES.status)) {
    test('the status field is refused once, the book heals, and the field is remembered as absent', async () => {
      const t = await start({ PROFILE: profile })
      const book = await t.gtt.book({ fresh: true })
      expect(book.rows).toEqual([])
      expect(t.app.caps.get()?.fields['gttorderbook.status']).toBe(false)
      expect((await t.stats()).requests.gttorderbook).toBe(2)
    })
  }

  describe('ANALYZE', () => {
    if (!atLeast(profile, GTT_GATES.sandbox)) {
      test('the place is refused with 501, and only a no is recorded for the analyzer', async () => {
        const t = await start({ PROFILE: profile })
        await t.control({ analyzer: true })
        const out = await t.submit('gttPlace', () => t.gtt.place(SINGLE), 'analyze')
        expect(out).toMatchObject({ kind: 'error', error: { kind: 'Unsupported', status: 501 } })
        expect(t.gttSeen.calls).toEqual([[false, 'analyze']])
      })
    } else {
      test('the place is done with analyze', async () => {
        const t = await start({ PROFILE: profile })
        await t.control({ analyzer: true })
        const out = await t.submit('gttPlace', () => t.gtt.place(SINGLE), 'analyze')
        expect(out).toMatchObject({ kind: 'done', reply: { kind: 'ok', analyze: true } })
        expect(t.gttSeen.calls).toEqual([[true, 'analyze']])
      })
    }
  })

  test('RF 6: a SELL with its trigger above the LTP, sent as a rise, is still active', async () => {
    const t = await start({ PROFILE: profile })
    const spec: GttSpec = { ...SINGLE, trigger: 1980, price: 1980, above: true }
    const id = triggerIdOf(await t.submit('gttPlace', () => t.gtt.place(spec), 'live'))
    await t.sleep(300)
    const row = (await t.gtt.book({ fresh: true })).rows.find((r) => r.triggerId === id)
    expect(row).toMatchObject({ status: 'active', triggers: [1980] })
  })

  test('no reply after the GTT was taken is maybe; reconcile finds it, with one place', async () => {
    const t = await start({ PROFILE: profile })
    await t.control({ failNext: { path: 'placegttorder', status: 502, afterApply: true } })
    const out = await t.submit('gttPlace', () => t.gtt.place(SINGLE), 'live')
    expect(out).toEqual({ kind: 'maybe' })
    const r = await reconcileGttPlacement({
      fetchBook: () => t.gtt.book({ fresh: true }),
      spec: SINGLE,
      knownIds: new Set(),
      sleep: t.sleep,
      delaysMs: t.delaysMs,
    })
    expect(r.checked).toBe(true)
    expect(r.found).toMatchObject({ symbol: 'RELIANCE', triggers: [1500] })
    expect((await t.stats()).requests.placegttorder).toBe(1)
  })

  test('a mode flip between the review read and the send is mode_changed, with no request', async () => {
    const t = await start({ PROFILE: profile })
    const shown = await t.gate.read()
    expect(shown).toBe('live')
    await t.control({ analyzer: true })
    const out = await t.submit('gttPlace', () => t.gtt.place(SINGLE), shown)
    expect(out).toEqual({ kind: 'mode_changed', now: 'analyze' })
    expect((await t.stats()).requests.placegttorder).toBeUndefined()
  })

  test('Semi-Auto in LIVE: the place is queued and records nothing; modify and cancel are blocked', async () => {
    const t = await start({ PROFILE: profile })
    const id = triggerIdOf(await t.submit('gttPlace', () => t.gtt.place(SINGLE), 'live'))
    t.gttSeen.calls.length = 0
    await t.control({ semiAuto: true })
    const queued = await t.submit('gttPlace', () => t.gtt.place(SINGLE), 'live')
    expect(queued).toMatchObject({ kind: 'done', reply: { kind: 'queued' } })
    expect(t.gttSeen.calls).toEqual([])

    const mod = await t.submit('gttModify', () => t.gtt.modify(id, SINGLE), 'live')
    expect(mod).toMatchObject({ kind: 'semi_auto_blocked' })
    if (mod.kind === 'semi_auto_blocked') expect(mod.message).toContain(G3_MODIFY)
    const cancel = await t.submit('gttCancel', () => t.gtt.cancel(id), 'live')
    expect(cancel).toMatchObject({ kind: 'semi_auto_blocked' })
    if (cancel.kind === 'semi_auto_blocked') expect(cancel.message).toContain(G3_CANCEL)
  })
})
