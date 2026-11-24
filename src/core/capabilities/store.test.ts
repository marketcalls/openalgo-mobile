import { profileStorage } from '~/core/config/storage'
import { clearLogs, getLogLines } from '~/core/log/logger'
import { memoryKV } from '../../../test/helpers/memoryKV'
import type { Capabilities } from './gates'
import { createCapabilityStore } from './store'

const HOST = 'https://algo.example.com'
const T0 = Date.UTC(2026, 10, 24, 4, 0)
const H = 3_600_000

const CAPS: Capabilities = {
  host: HOST,
  version: '2.0.3.5',
  versionSource: 'app-info',
  endpoints: ['ping', 'optionchain', 'history'],
  probed: { multioptiongreeks: true },
  fields: {},
  ws: { orderStream: null, ping: null, close1012: true, authDeadline: true },
  probedAt: T0,
}

function setup(seed: Record<string, string> = {}) {
  const kv = memoryKV(seed)
  const store = createCapabilityStore(profileStorage(kv, 'p1'))
  const stored = () => {
    const raw = kv.data.get('oa.p1.caps')
    return raw === undefined ? undefined : JSON.parse(raw)
  }
  return { kv, store, stored }
}

/** Lets fire-and-forget writes land. */
const settle = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => jest.restoreAllMocks())

describe('load and save', () => {
  test('save writes oa.<pid>.caps, and a new store loads it back', async () => {
    const { kv, store, stored } = setup()
    expect(store.get()).toBeNull()
    await store.save(CAPS)
    expect(store.get()).toEqual(CAPS)
    expect(stored()).toEqual(CAPS)

    const again = createCapabilityStore(profileStorage(kv, 'p1'))
    expect(await again.load()).toEqual(CAPS)
    expect(again.get()).toEqual(CAPS)
  })

  test('nothing stored, or unreadable data, loads as null', async () => {
    expect(await setup().store.load()).toBeNull()
    const { store } = setup({ 'oa.p1.caps': JSON.stringify({ host: HOST, version: 2 }) })
    expect(await store.load()).toBeNull()
    expect(store.get()).toBeNull()
  })

  test('a failed write rejects save and is logged; the caps stay in use and later writes land', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    clearLogs()
    const { kv, store, stored } = setup()
    const set = kv.set
    kv.set = async () => {
      throw new Error('disk full')
    }
    await expect(store.save(CAPS)).rejects.toThrow('disk full')
    expect(store.get()).toEqual(CAPS)
    expect(
      getLogLines().filter((l) => l.includes('could not store the capabilities')),
    ).toHaveLength(1)

    kv.set = set
    store.setField('history.source', false)
    await settle()
    expect(stored()).toEqual({ ...CAPS, fields: { 'history.source': false } })
  })
})

describe('subscribe', () => {
  test('listeners hear load, save, setField and setWs until they unsubscribe', async () => {
    const { store } = setup({ 'oa.p1.caps': JSON.stringify(CAPS) })
    const seen: unknown[] = []
    const off = store.subscribe((c) => seen.push(c))
    await store.load()
    await store.save({ ...CAPS, version: '2.0.3.6' })
    store.setField('history.source', false)
    store.setWs({ orderStream: true })
    off()
    store.setWs({ ping: true })
    expect(seen).toEqual([
      CAPS,
      { ...CAPS, version: '2.0.3.6' },
      { ...CAPS, version: '2.0.3.6', fields: { 'history.source': false } },
      {
        ...CAPS,
        version: '2.0.3.6',
        fields: { 'history.source': false },
        ws: { ...CAPS.ws, orderStream: true },
      },
    ])
  })

  test('get() keeps its identity until something changes', async () => {
    const { store } = setup()
    await store.save(CAPS)
    const a = store.get()
    store.setWs({ orderStream: null })
    store.setField('x.y', true)
    const b = store.get()
    expect(b).not.toBe(a)
    store.setField('x.y', true)
    store.setWs({ close1012: true })
    expect(store.get()).toBe(b)
  })

  test('a no-op change notifies no one', async () => {
    const { store } = setup()
    await store.save(CAPS)
    const fn = jest.fn()
    store.subscribe(fn)
    store.setWs({ close1012: true })
    store.setField('x.y', true)
    store.setField('x.y', true)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('fields', () => {
  test('adapt drops with_greeks once optionchain.with_greeks is false', async () => {
    const { store, stored } = setup()
    await store.save(CAPS)
    const body = { underlying: 'NIFTY', exchange: 'NSE_INDEX', with_greeks: true, interest_rate: 6 }
    expect(store.adapt('optionchain', body)).toEqual(body)

    store.markUnsupported('optionchain', 'with_greeks')
    expect(store.adapt('optionchain', body)).toEqual({
      underlying: 'NIFTY',
      exchange: 'NSE_INDEX',
      interest_rate: 6,
    })
    // Only that endpoint's field goes.
    expect(store.adapt('multioptiongreeks', { with_greeks: true })).toEqual({ with_greeks: true })
    await settle()
    expect(stored().fields).toEqual({ 'optionchain.with_greeks': false })
  })

  test('setField persists the value under its <endpoint>.<field> key', async () => {
    const { store, stored } = setup()
    await store.save(CAPS)
    store.setField('history.source', false)
    await settle()
    expect(stored()).toEqual({ ...CAPS, fields: { 'history.source': false } })
    expect(store.adapt('history', { symbol: 'SBIN', source: 'db' })).toEqual({ symbol: 'SBIN' })
  })

  test('before any caps, adapt passes the body through and setField does nothing', async () => {
    const { store, stored } = setup()
    store.markUnsupported('history', 'source')
    expect(store.adapt('history', { source: 'db' })).toEqual({ source: 'db' })
    await settle()
    expect(stored()).toBeUndefined()
  })
})

describe('ws', () => {
  test('before a probe: orderStream and ping unknown, close1012 and authDeadline off', () => {
    expect(setup().store.ws()).toEqual({
      orderStream: null,
      ping: null,
      close1012: false,
      authDeadline: false,
    })
  })

  test('setWs merges what the live feed showed, and persists it', async () => {
    const { store, stored } = setup()
    await store.save(CAPS)
    store.setWs({ orderStream: false })
    store.setWs({ ping: true })
    const ws = { orderStream: false, ping: true, close1012: true, authDeadline: true }
    expect(store.ws()).toEqual(ws)
    await settle()
    expect(stored().ws).toEqual(ws)
  })

  test('setWs before a probe does nothing', async () => {
    const { store, stored } = setup()
    store.setWs({ orderStream: true })
    expect(store.ws().orderStream).toBeNull()
    await settle()
    expect(stored()).toBeUndefined()
  })
})

describe('needsReprobe', () => {
  const at = (
    now: number,
    o: { host?: string; version?: string | null; force?: boolean } = {},
  ) => ({
    now,
    host: o.host ?? HOST,
    version: o.version === undefined ? '2.0.3.5' : o.version,
    force: o.force,
  })

  test('true before any caps', () => {
    expect(setup().store.needsReprobe(at(T0))).toBe(true)
  })

  test('false at 23 h; true at 25 h, on a host or version change, and with force', async () => {
    const { store } = setup()
    await store.save(CAPS)
    expect(store.needsReprobe(at(T0 + 23 * H))).toBe(false)
    expect(store.needsReprobe(at(T0 + 25 * H))).toBe(true)
    expect(store.needsReprobe(at(T0 + H, { host: 'https://new-tunnel.example.com' }))).toBe(true)
    expect(store.needsReprobe(at(T0 + H, { version: '2.0.3.6' }))).toBe(true)
    expect(store.needsReprobe(at(T0 + H, { version: null }))).toBe(true)
    expect(store.needsReprobe(at(T0 + H, { force: true }))).toBe(true)
  })

  test('the version is compared normalized, and a marker-only server stays cached', async () => {
    const { store } = setup()
    await store.save({ ...CAPS, version: '2.0.1.7' })
    expect(store.needsReprobe(at(T0 + H, { version: '2.0.1.17' }))).toBe(false)
    await store.save({ ...CAPS, version: null, versionSource: 'marker' })
    expect(store.needsReprobe(at(T0 + H, { version: null }))).toBe(false)
  })
})
