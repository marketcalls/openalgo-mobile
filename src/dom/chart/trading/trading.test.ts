// The trading glue (design 7.9.4, 7.9.6) against a fake chart and widget, in the "dom" project
// (jsdom). Every action the page takes is a ChartIntent sent over the bridge; the page places
// nothing itself.
import { createChart, type OpenAlgoLiveDataFeed, type PriceLineOptions } from 'openalgo-charts'
import { TOPBAR_HEIGHT, type Widget } from 'openalgo-charts/widget'
import {
  CHART_TOPICS,
  type ChartIntent,
  type ChartMeta,
  type ChartOrder,
  type ChartPosition,
  type DomToNative,
  type Inst,
  type JSONValue,
} from '~/dom/bridge/protocol'
import { createDomClient } from '~/dom/web/client'
import { tokens } from '~/ui/tokens'
import { stubCanvas } from '../testCanvas'
import { attachTrading, holdTradePushes, type TradeSeed } from './glue'
import { lineExtent } from './lines'

const INFY: ChartMeta = {
  exchange: 'NSE',
  symbol: 'INFY',
  tick: 0.05,
  lotsize: 1,
  lots: false,
  quoteOnly: false,
  freezeQty: 0,
}
const NIFTY_FUT: ChartMeta = {
  exchange: 'NFO',
  symbol: 'NIFTY26DECFUT',
  tick: 0.1,
  lotsize: 75,
  lots: true,
  quoteOnly: false,
  freezeQty: 1800,
}
const NIFTY: ChartMeta = { ...INFY, exchange: 'NSE_INDEX', symbol: 'NIFTY', quoteOnly: true }

const LIMIT_BUY: ChartOrder = {
  id: '1',
  side: 'BUY',
  type: 'LIMIT',
  qty: 10,
  price: 100,
  trigger: null,
}
const LIMIT_SELL: ChartOrder = {
  id: '2',
  side: 'SELL',
  type: 'LIMIT',
  qty: 5,
  price: 120,
  trigger: null,
}
const SL_SELL: ChartOrder = { id: '3', side: 'SELL', type: 'SL', qty: 5, price: 95, trigger: 95.5 }

const dark = tokens.trade.dark

type FakeLine = {
  opts: PriceLineOptions
  ghost: number | null
  readonly price: number
  setPrice(p: number): void
  setDragGhost(p: number | null): void
  setOptions(patch: Partial<PriceLineOptions>): void
  options(): PriceLineOptions
}
type Listener = (payload: never) => void

function emitter() {
  const all = new Map<string, Set<Listener>>()
  return {
    on(event: string, cb: Listener) {
      let set = all.get(event)
      if (set === undefined) {
        set = new Set()
        all.set(event, set)
      }
      set.add(cb)
      return () => set.delete(cb)
    },
    emit(event: string, payload: unknown) {
      for (const cb of [...(all.get(event) ?? [])]) (cb as (p: unknown) => void)(payload)
    },
    count: () => [...all.values()].reduce((n, s) => n + s.size, 0),
  }
}

type Point = { x: number; y: number }
/** Where a finger grabs a line, and a point well past the chart's 3 px tap slop from it. */
const GRAB: Point = { x: 100, y: 100 }
const MOVED: Point = { x: 100, y: 140 }

/** A chart with what the glue uses; `coordinateToPrice` reads 1000 - y, its plot is 360 px wide. */
function fakeChart() {
  const lines: FakeLine[] = []
  const bus = emitter()
  const clicks = new Set<(id: string) => void>()
  const drags = new Set<{
    move: (id: string, p: number) => void
    end?: (id: string, p: number) => void
  }>()
  let plotWidth = 360
  const chart = {
    addPriceLine: jest.fn((opts: PriceLineOptions) => {
      const line: FakeLine = {
        opts: { ...opts },
        ghost: null,
        get price() {
          return this.opts.price
        },
        setPrice(p) {
          this.opts.price = p
        },
        setDragGhost(p) {
          this.ghost = p
        },
        setOptions(patch) {
          Object.assign(this.opts, patch)
        },
        options() {
          return this.opts
        },
      }
      lines.push(line)
      return line
    }),
    removePrimitive: jest.fn((line: FakeLine) => {
      lines.splice(lines.indexOf(line), 1)
    }),
    subscribeClick(cb: (id: string) => void) {
      clicks.add(cb)
      return () => clicks.delete(cb)
    },
    subscribeDrag(move: (id: string, p: number) => void, end?: (id: string, p: number) => void) {
      const pair = { move, end }
      drags.add(pair)
      return () => drags.delete(pair)
    },
    on: bus.on,
    coordinateToPrice: (y: number) => 1000 - y,
    primaryPaneIndex: () => 0,
    plotRect: () => ({ left: 0, top: 0, width: plotWidth, height: 700 }),
  }
  return {
    chart,
    lines,
    line: (id: string) => lines.find((l) => l.opts.id === id),
    click: (id: string) => {
      for (const cb of [...clicks]) cb(id)
    },
    /** A press on a draggable line: the chart says so before anything moves. */
    grab: (id: string, point: Point = GRAB) => bus.emit('drag:start', { id, point }),
    /** A pointermove of the finger on the line: the chart's drag callbacks, then its event. */
    drag: (id: string, price: number, point: Point = MOVED) => {
      for (const d of [...drags]) d.move(id, price)
      bus.emit('drag', { id, price, point })
    },
    release: (id: string, price: number) => {
      for (const d of [...drags]) d.end?.(id, price)
      bus.emit('drag:end', { id, price })
    },
    cancelDrag: (id: string) => bus.emit('drag:cancel', { id, reason: 'pinch' }),
    /** The phone turned, or the widget's chrome changed: a new plot width. */
    resize: (width: number) => {
      plotWidth = width
      bus.emit('resize', { width, height: 700 })
    },
    listeners: () => bus.count() + clicks.size + drags.size,
  }
}

function fakeWidget(start: Inst = { exchange: 'NSE', symbol: 'INFY' }) {
  const chart = fakeChart()
  const bus = emitter()
  let inst = start
  let tool: string | null = null
  const root = document.createElement('div')
  root.className = 'oac-widget'
  const plot = document.createElement('div')
  plot.className = 'oac-chart'
  root.append(plot)
  document.body.append(root)
  // The chart sits 100 px down the page: a press is priced at its y inside the chart.
  plot.getBoundingClientRect = () => ({ top: 100, left: 0 }) as DOMRect
  const widget = {
    chart: chart.chart,
    draw: { activeTool: () => tool },
    root,
    isDestroyed: false,
    symbol: () => inst.symbol,
    exchange: () => inst.exchange,
    interval: () => '5m',
    theme: () => 'dark',
    on: bus.on,
  }
  return {
    widget: widget as unknown as Widget,
    chart,
    root,
    plot,
    setTool: (t: string | null) => {
      tool = t
    },
    /** The widget's own symbol box moved the chart. */
    changeSymbol: (next: Inst) => {
      inst = next
      bus.emit('symbol', next)
    },
    listeners: () => chart.listeners() + bus.count(),
  }
}

function fakeLive() {
  const subs: Array<{ req: unknown; opts: unknown; cb: (d: unknown) => void; off: jest.Mock }> = []
  const live = {
    subscribeDepth: jest.fn((req: unknown, cb: (d: unknown) => void, opts: unknown) => {
      const off = jest.fn()
      subs.push({ req, opts, cb, off })
      return off
    }),
  }
  return {
    live: live as unknown as Pick<OpenAlgoLiveDataFeed, 'subscribeDepth'>,
    subs,
    depth: (d: { bids?: { price: number }[]; asks?: { price: number }[]; ltp: number }) =>
      subs.at(-1)?.cb({ bids: [], asks: [], ...d }),
  }
}

const mounted: Array<() => void> = []

function setup(o: { seed?: Partial<TradeSeed>; inst?: Inst } = {}) {
  const sent: DomToNative[] = []
  const client = createDomClient(async (m: JSONValue) => {
    sent.push(m as DomToNative)
    return { status: 202, body: null }
  })
  const w = fakeWidget(o.inst)
  const feed = fakeLive()
  const seed: TradeSeed = { meta: null, ltp: null, orders: [], positions: [], ...o.seed }
  const trading = attachTrading(w.widget, client, feed.live, seed)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    trading.dispose()
    w.root.remove()
  }
  mounted.push(dispose)
  const push = (topic: string, payload: unknown) =>
    client.deliver([{ kind: 'push', topic, payload }])
  const $ = (id: string) => w.root.querySelector<HTMLElement>(`#${id}`)
  return {
    ...w,
    ...feed,
    client,
    push,
    dispose,
    $,
    // every intent the chart page sent: it sends chart intents only
    intents: () => sent.flatMap((m) => (m.kind === 'intent' ? [m.intent as ChartIntent] : [])),
    panel: () => $('chart-buy')?.parentElement ?? null,
    shown: () => $('chart-buy')?.parentElement?.style.display !== 'none',
    tap: (id: string) => $(id)?.click(),
  }
}

type Pointer = {
  id?: number
  x?: number
  y: number
  primary?: boolean
  type?: 'touch' | 'mouse'
}
function pointer(target: EventTarget, type: string, p: Pointer) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: p.x ?? 50,
    clientY: p.y,
  })
  Object.defineProperty(e, 'pointerId', { value: p.id ?? 1 })
  Object.defineProperty(e, 'isPrimary', { value: p.primary ?? true })
  Object.defineProperty(e, 'pointerType', { value: p.type ?? 'touch' })
  target.dispatchEvent(e)
  return e
}

afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose()
  jest.useRealTimers()
})

describe('order and position lines', () => {
  test('working orders become lines and gone orders are removed', () => {
    const t = setup({ seed: { meta: INFY } })
    t.push(CHART_TOPICS.orders, [LIMIT_BUY, LIMIT_SELL])
    expect(t.chart.lines.map((l) => l.opts)).toEqual([
      {
        id: 'order:1',
        price: 100,
        color: dark.buy,
        lineWidth: 1,
        dashed: true,
        cursor: 'ns-resize',
        extentFromRight: lineExtent(360),
        closeButton: true,
        badge: 'BUY',
        qty: 10,
        leftLabel: 'LIMIT',
      },
      expect.objectContaining({ id: 'order:2', price: 120, color: dark.sell, badge: 'SELL' }),
    ])

    // The SELL was filled and the BUY modified to 5 at 101: one line, moved in place.
    const buy = t.chart.line('order:1')
    t.push(CHART_TOPICS.orders, [{ ...LIMIT_BUY, qty: 5, price: 101 }])
    expect(t.chart.lines).toEqual([buy])
    expect(buy?.opts).toMatchObject({ price: 101, qty: 5 })
    expect(t.chart.chart.addPriceLine).toHaveBeenCalledTimes(2)

    t.push(CHART_TOPICS.orders, [])
    expect(t.chart.lines).toEqual([])
  })

  test("an SL order's line sits at its trigger", () => {
    const t = setup({ seed: { meta: INFY, orders: [SL_SELL] } })
    expect(t.chart.line('order:3')?.opts).toMatchObject({
      price: 95.5,
      badge: 'SELL',
      leftLabel: 'SL',
    })
  })

  test('a position line reads @ avg and the P&L, LONG or SHORT, one per product', () => {
    const positions: ChartPosition[] = [
      { product: 'MIS', net: 10, avg: 123456.5 },
      { product: 'CNC', net: -5, avg: 123400 },
      { product: 'NRML', net: 0, avg: 100 },
    ]
    const t = setup({ seed: { meta: INFY, ltp: 123460 } })
    t.push(CHART_TOPICS.positions, positions)
    expect(t.chart.lines.map((l) => l.opts)).toEqual([
      {
        id: 'position:MIS',
        price: 123456.5,
        color: dark.buy,
        lineWidth: 2,
        dashed: false,
        extentFromRight: lineExtent(360),
        closeButton: true,
        badge: 'LONG',
        qty: 10,
        leftLabel: '@ 1,23,456.50  +₹35.00',
      },
      expect.objectContaining({
        id: 'position:CNC',
        color: dark.sell,
        badge: 'SHORT',
        qty: 5,
        leftLabel: '@ 1,23,400.00  -₹300.00',
      }),
    ])

    // Each tick re-prices the P&L.
    t.depth({ ltp: 123450 })
    expect(t.chart.line('position:MIS')?.opts.leftLabel).toBe('@ 1,23,456.50  -₹65.00')
    expect(t.chart.line('position:CNC')?.opts.leftLabel).toBe('@ 1,23,400.00  -₹250.00')

    // The MIS position was closed.
    t.push(CHART_TOPICS.positions, positions.slice(1))
    expect(t.chart.lines.map((l) => l.opts.id)).toEqual(['position:CNC'])
  })

  test('a position without an LTP reads flat at its average', () => {
    const t = setup({ seed: { meta: INFY, positions: [{ product: 'MIS', net: 3, avg: 99.9 }] } })
    expect(t.chart.line('position:MIS')?.opts.leftLabel).toBe('@ 99.90  +₹0.00')
  })

  test("a line reaches as far into the plot as its badges need: the web's 0.3 only on a wide plot", () => {
    expect(lineExtent(1000)).toBe(0.3)
    expect(lineExtent(600)).toBe(0.5)
    expect(lineExtent(360)).toBeCloseTo(0.833, 3)
    // a 360 px phone, its rail hidden: a plot of about 300 px, all of it the line's
    expect(lineExtent(300)).toBe(1)
    expect(lineExtent(250)).toBe(1)
    // a plot not laid out yet
    expect(lineExtent(0)).toBe(1)

    const t = setup({
      seed: { meta: INFY, orders: [LIMIT_BUY], positions: [{ product: 'MIS', net: 1, avg: 99 }] },
    })
    // The phone turned to landscape: the lines draw again for the wider plot, and back.
    t.chart.resize(1000)
    expect(t.chart.lines.map((l) => l.opts.extentFromRight)).toEqual([0.3, 0.3])
    t.chart.resize(300)
    expect(t.chart.lines.map((l) => l.opts.extentFromRight)).toEqual([1, 1])
  })

  test('the lines and the panel open with the pushes that came before the widget', () => {
    const sent: DomToNative[] = []
    const client = createDomClient(async (m: JSONValue) => {
      sent.push(m as DomToNative)
      return { status: 202, body: null }
    })
    const held = holdTradePushes(client)
    const push = (topic: string, payload: unknown) =>
      client.deliver([{ kind: 'push', topic, payload }])
    push(CHART_TOPICS.init, { inst: { exchange: 'NSE', symbol: 'INFY' }, meta: null, ltp: 1510 })
    push(CHART_TOPICS.orders, [LIMIT_BUY])
    push(CHART_TOPICS.positions, [{ product: 'MIS', net: 1, avg: 1500 }])
    push(CHART_TOPICS.meta, INFY)
    expect(held.seed).toEqual({
      meta: INFY,
      ltp: 1510,
      orders: [LIMIT_BUY],
      positions: [{ product: 'MIS', net: 1, avg: 1500 }],
    })
    held.stop()
    push(CHART_TOPICS.orders, [])
    expect(held.seed.orders).toEqual([LIMIT_BUY])

    const t = setup({ seed: held.seed })
    expect(t.chart.lines.map((l) => l.opts.id)).toEqual(['order:1', 'position:MIS'])
    expect(t.chart.line('position:MIS')?.opts.leftLabel).toBe('@ 1,500.00  +₹10.00')
    expect(t.shown()).toBe(true)
    expect(t.$('chart-buy')?.textContent).toBe('BUY1,510.00')
  })
})

describe('drag to modify', () => {
  test('a drag moves by tick and ends in one modify at the snapped price; the same tick sends none', () => {
    const t = setup({ seed: { meta: INFY, orders: [LIMIT_BUY] } })
    const line = t.chart.line('order:1')
    t.chart.grab('order:1')
    t.chart.drag('order:1', 101.03)
    expect(line?.ghost).toBe(100)
    expect(line?.price).toBe(101.05)
    t.chart.drag('order:1', 101.12)
    expect(line?.price).toBe(101.1)
    t.chart.release('order:1', 101.12)
    expect(line?.ghost).toBeNull()
    expect(t.intents()).toEqual([
      { type: 'modify', inst: { exchange: 'NSE', symbol: 'INFY' }, orderid: '1', price: 101.1 },
    ])

    // Back on the tick it started from: nothing to modify.
    t.chart.grab('order:1')
    t.chart.drag('order:1', 100.6)
    t.chart.drag('order:1', 100.02)
    t.chart.release('order:1', 100.02)
    // A tap on the line ends a drag that never moved.
    t.chart.grab('order:1')
    t.chart.release('order:1', 100.4)
    expect(t.intents()).toHaveLength(1)
  })

  test("a tap's jitter within the chart's 3 px slop moves nothing and modifies nothing", () => {
    const t = setup({ seed: { meta: INFY, orders: [LIMIT_BUY] } })
    const line = t.chart.line('order:1')
    t.chart.grab('order:1', { x: 100, y: 100 })
    // 3 px down and 3 across: still a tap, though the finger's price is a tick away
    t.chart.drag('order:1', 100.4, { x: 103, y: 103 })
    expect(line?.price).toBe(100)
    expect(line?.ghost).toBeNull()
    t.chart.release('order:1', 100.4)
    expect(t.intents()).toEqual([])

    // One pixel more is a drag, and from then on the line follows the finger, back near the
    // press included.
    t.chart.grab('order:1', { x: 100, y: 100 })
    t.chart.drag('order:1', 100.4, { x: 100, y: 104 })
    expect(line?.price).toBe(100.4)
    t.chart.drag('order:1', 100.6, { x: 100, y: 101 })
    expect(line?.price).toBe(100.6)
    t.chart.release('order:1', 100.6)
    expect(t.intents()).toMatchObject([{ type: 'modify', orderid: '1', price: 100.6 }])
  })

  test('a drag end puts the line back at the book price until a push moves it (RF 6)', () => {
    const t = setup({ seed: { meta: INFY, orders: [SL_SELL] } })
    const line = t.chart.line('order:3')
    t.chart.grab('order:3')
    t.chart.drag('order:3', 97)
    // A book push mid-drag leaves the line under the finger.
    t.push(CHART_TOPICS.orders, [{ ...SL_SELL, qty: 4 }])
    expect(line?.opts).toMatchObject({ price: 97, qty: 4 })
    t.chart.release('order:3', 97)
    expect(t.intents()).toMatchObject([{ type: 'modify', orderid: '3', price: 97 }])
    // The modify sheet was dismissed: the line stays at the book's trigger.
    expect(line?.price).toBe(95.5)
    t.push(CHART_TOPICS.redraw, null)
    expect(line?.price).toBe(95.5)
    t.push(CHART_TOPICS.orders, [{ ...SL_SELL, trigger: 97 }])
    expect(line?.price).toBe(97)

    // A drag the chart cancels (a second finger) goes back and sends nothing.
    t.chart.grab('order:3')
    t.chart.drag('order:3', 99)
    t.chart.cancelDrag('order:3')
    expect(line?.price).toBe(97)
    expect(line?.ghost).toBeNull()
    t.chart.release('order:3', 99)
    expect(t.intents()).toHaveLength(1)
  })
})

describe('close buttons', () => {
  test('X on an order sends cancel; X on a position sends close with its product', () => {
    const t = setup({
      seed: {
        meta: INFY,
        orders: [LIMIT_BUY],
        positions: [{ product: 'NRML', net: 2, avg: 1500 }],
      },
    })
    t.chart.click('order:1::close')
    t.chart.click('position:NRML::close')
    // The line itself, and X on lines the glue did not draw, send nothing.
    t.chart.click('order:1')
    t.chart.click('order:9::close')
    t.chart.click('position:MIS::close')
    t.chart.click('alert:1::close')
    const inst = { exchange: 'NSE', symbol: 'INFY' }
    expect(t.intents()).toEqual([
      { type: 'cancel', inst, orderid: '1' },
      { type: 'close', inst, product: 'NRML' },
    ])
  })
})

// The glue on a real openalgo-charts chart, built on the widget's `.oac-chart` element as the
// widget builds it: the chart's own pointer listeners sit on that element, and so does the panel.
// The chart turns a pointerup it gets without a pointerdown into a click at its last press, so
// a press on the panel must never reach it.
describe('on a real chart', () => {
  let restoreCanvas: () => void
  beforeAll(() => {
    restoreCanvas = stubCanvas()
  })
  afterAll(() => restoreCanvas())

  /** `width`: the chart's, the price axis included; a 360 px phone's chart once the rail hides. */
  function realChart(seed: Partial<TradeSeed>, width = 1000) {
    const frames: Array<() => void> = []
    const root = document.createElement('div')
    root.className = 'oac-widget'
    const plot = document.createElement('div')
    plot.className = 'oac-chart'
    root.append(plot)
    document.body.append(root)
    const chart = createChart(plot, { raf: { schedule: (cb) => frames.push(cb) } })
    chart.applySize(width, 600)
    const t0 = 1_700_000_000
    chart.addSeries('candlestick').setData(
      Array.from({ length: 50 }, (_, i) => ({
        time: t0 + 300 * i,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
      })),
    )
    const sent: DomToNative[] = []
    const client = createDomClient(async (m: JSONValue) => {
      sent.push(m as DomToNative)
      return { status: 202, body: null }
    })
    const widget = {
      chart,
      root,
      draw: { activeTool: () => null },
      isDestroyed: false,
      symbol: () => 'INFY',
      exchange: () => 'NSE',
      interval: () => '5m',
      theme: () => 'dark',
      on: () => () => {},
    }
    const trading = attachTrading(widget as unknown as Widget, client, fakeLive().live, {
      meta: INFY,
      ltp: 105,
      orders: [],
      positions: [],
      ...seed,
    })
    mounted.push(() => {
      trading.dispose()
      chart.destroy()
      root.remove()
    })
    for (let i = 0; i < 10 && frames.length > 0; i++) for (const frame of frames.splice(0)) frame()

    const clicks: Array<string | null> = []
    chart.on('click', (e) => clicks.push(e.id))
    let crosshairs = 0
    chart.on('crosshair:move', () => {
      crosshairs++
    })
    let hover: string | null = null
    chart.on('hover', (e) => {
      hover = e.id
    })
    const views: string[] = []
    for (const name of ['dblclick', 'zoom', 'pan'] as const) chart.on(name, () => views.push(name))
    let pointerId = 10
    const canvas = plot.querySelector('canvas') ?? plot
    const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`) as HTMLElement
    const paint = () => {
      for (let i = 0; i < 10 && frames.length > 0; i++)
        for (const frame of frames.splice(0)) frame()
    }
    return {
      plotWidth: () => chart.plotRect(0)?.width ?? 0,
      intents: () => sent.flatMap((m) => (m.kind === 'intent' ? [m.intent] : [])),
      clicks,
      crosshairs: () => crosshairs,
      /** The chart's double-tap reset, zoom and pan events. */
      views,
      /** The middle of a line's X, found as a mouse finds it: by hovering along the line. */
      closeAt(id: string, price: number) {
        const y = chart.priceToCoordinate(price) ?? Number.NaN
        const xs: number[] = []
        for (let x = 0; x < 1000; x++) {
          pointer(canvas, 'pointermove', { id: 1, x, y, type: 'mouse' })
          if (hover === `${id}::close`) xs.push(x)
        }
        pointer(canvas, 'pointerleave', { id: 1, x: 0, y, type: 'mouse' })
        expect(xs.length).toBeGreaterThan(4)
        return { x: xs[xs.length >> 1] as number, y }
      },
      tapChart(at: { x: number; y: number }) {
        const p = { id: ++pointerId, ...at }
        pointer(canvas, 'pointerdown', p)
        pointer(canvas, 'pointerup', p)
      },
      /** A finger down at `at`, moved `dy` px, and up there; the chart painted in between. */
      dragChart(at: { x: number; y: number }, dy: number) {
        const id = ++pointerId
        pointer(canvas, 'pointerdown', { id, ...at })
        pointer(canvas, 'pointermove', { id, x: at.x, y: at.y + dy })
        paint()
        pointer(canvas, 'pointerup', { id, x: at.x, y: at.y + dy })
        paint()
      },
      /** A finger held still at `at` past the long press, then lifted. */
      holdChart(at: { x: number; y: number }) {
        const p = { id: ++pointerId, ...at }
        pointer(canvas, 'pointerdown', p)
        jest.advanceTimersByTime(600)
        pointer(canvas, 'pointerup', p)
      },
      /** Where a price sits on the line: `price`'s y, 10 px in from the plot's right edge. */
      onLine(price: number) {
        const y = chart.priceToCoordinate(price) ?? Number.NaN
        return { x: (chart.plotRect(0)?.width ?? 0) - 10, y }
      },
      /** A finger on a panel button: down, up, then the click the browser makes of them. */
      tapButton(id: string) {
        const p = { id: ++pointerId, x: 20, y: TOPBAR_HEIGHT + 20 }
        pointer($(id), 'pointerdown', p)
        pointer($(id), 'pointerup', p)
        $(id).click()
      },
      /** A finger the WebView takes back (a scroll): down, then cancel, and no click. */
      cancelOn(id: string) {
        const p = { id: ++pointerId, x: 20, y: TOPBAR_HEIGHT + 20 }
        pointer($(id), 'pointerdown', p)
        pointer($(id), 'pointercancel', p)
      },
      moveOver(id: string) {
        for (const type of ['touch', 'mouse'] as const) {
          pointer($(id), 'pointermove', { id: ++pointerId, x: 24, y: TOPBAR_HEIGHT + 24, type })
        }
      },
      /** A fast second tap's dblclick, and a wheel turn, on a panel button. */
      doubleTapAndWheel(id: string) {
        const at = { bubbles: true, cancelable: true, clientX: 24, clientY: TOPBAR_HEIGHT + 24 }
        $(id).dispatchEvent(new MouseEvent('dblclick', at))
        $(id).dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: -120 }))
      },
    }
  }

  test("a tap on a line's X, then a BUY tap, sends exactly one cancel and one trade", () => {
    const t = realChart({ orders: [LIMIT_BUY] })
    t.tapChart(t.closeAt('order:1', LIMIT_BUY.price))
    // Native's confirm was dismissed; the next taps are on the panel.
    t.tapButton('chart-lots-inc')
    t.cancelOn('chart-lots-dec')
    const crosshairs = t.crosshairs()
    t.moveOver('chart-buy')
    t.doubleTapAndWheel('chart-lots-inc')
    t.tapButton('chart-buy')
    const inst = { exchange: 'NSE', symbol: 'INFY' }
    expect(t.intents()).toEqual([
      { type: 'cancel', inst, orderid: '1' },
      { type: 'trade', inst, side: 'BUY', lots: 2 },
    ])
    // The chart saw one click, the X's. No finger on the panel moved its crosshair, reset its
    // scale, zoomed or panned it.
    expect(t.clicks).toEqual(['order:1::close'])
    expect(t.crosshairs()).toBe(crosshairs)
    expect(t.views).toEqual([])
  })

  test("a tap on a position's X, then a SELL tap, sends exactly one close and one trade", () => {
    const t = realChart({ positions: [{ product: 'NRML', net: 2, avg: 104 }] })
    t.tapChart(t.closeAt('position:NRML', 104))
    t.tapButton('chart-sell')
    t.tapButton('chart-lots-inc')
    const inst = { exchange: 'NSE', symbol: 'INFY' }
    expect(t.intents()).toEqual([
      { type: 'close', inst, product: 'NRML' },
      { type: 'trade', inst, side: 'SELL', lots: 1 },
    ])
    expect(t.clicks).toEqual(['position:NRML::close'])
  })

  // A 360 px phone in the widget's mobile mode, which hides the rail: a plot of about 300 px.
  test("on a 360 px phone an order's X and a position's X sit on the plot: one cancel, one close", () => {
    const t = realChart(
      {
        orders: [LIMIT_BUY],
        positions: [{ product: 'NRML', net: 1500, avg: 104.25 }],
      },
      360,
    )
    expect(t.plotWidth()).toBeLessThan(330)
    // closeAt finds each X by hovering along its line, and the X is a line's last badge
    const cancel = t.closeAt('order:1', LIMIT_BUY.price)
    const close = t.closeAt('position:NRML', 104.25)
    for (const at of [cancel, close]) expect(at.x).toBeLessThan(t.plotWidth())
    t.tapChart(cancel)
    t.tapChart(close)
    const inst = { exchange: 'NSE', symbol: 'INFY' }
    expect(t.intents()).toEqual([
      { type: 'cancel', inst, orderid: '1' },
      { type: 'close', inst, product: 'NRML' },
    ])
  })

  test('a tap on an order line with 3 px of jitter modifies nothing; a drag sends one modify', () => {
    const t = realChart({ orders: [LIMIT_BUY] }, 360)
    const at = t.onLine(LIMIT_BUY.price)
    // 3 px is ticks away at this scale, but within the chart's own tap slop
    t.dragChart(at, 3)
    expect(t.intents()).toEqual([])
    t.dragChart(at, 30)
    expect(t.intents()).toMatchObject([{ type: 'modify', orderid: '1' }])
    const modify = t.intents()[0] as Extract<ChartIntent, { type: 'modify' }>
    expect(modify.price).toBeLessThan(LIMIT_BUY.price)
  })

  test("a long press on an order's X opens the price menu and sends no cancel", () => {
    jest.useFakeTimers()
    const t = realChart({ orders: [LIMIT_BUY] }, 360)
    t.holdChart(t.closeAt('order:1', LIMIT_BUY.price))
    expect(t.intents().map((i) => i.type)).toEqual(['priceMenu'])
    // the chart did make a click of the release
    expect(t.clicks).toEqual(['order:1::close'])
    // a tap on the X afterwards is a cancel
    t.tapChart(t.closeAt('order:1', LIMIT_BUY.price))
    expect(t.intents().map((i) => i.type)).toEqual(['priceMenu', 'cancel'])
  })
})

describe('trade panel', () => {
  // The ticket, the Option Chain leg sheet and Kite put BUY on the left: one side order across
  // the app, so a thumb used to one screen does not tap the other side here (ledger 44/46).
  test('BUY on the left, the lots, then SELL on the right; BUY green and SELL red', () => {
    const t = setup({
      seed: { meta: NIFTY_FUT },
      inst: { exchange: 'NFO', symbol: 'NIFTY26DECFUT' },
    })
    const panel = t.panel()
    const row = [...(panel?.children ?? [])] as HTMLElement[]
    expect(row.map((e) => e.id)).toEqual(['chart-buy', 'chart-lots', 'chart-sell'])
    // the screen reader and the focus order read the row as it is drawn: nothing reorders it
    expect(panel?.style.flexDirection ?? '').not.toMatch(/reverse/)
    expect(row.map((e) => e.style.order)).toEqual(['', '', ''])
    // a token as jsdom writes it back
    const css = (prop: 'background' | 'color', value: string) => {
      const probe = document.createElement('i')
      probe.style[prop] = value
      return probe.style[prop]
    }
    expect(t.$('chart-buy')?.style.background).toBe(css('background', dark.buy))
    expect(t.$('chart-buy')?.style.color).toBe(css('color', dark.onBuy))
    expect(t.$('chart-sell')?.style.background).toBe(css('background', dark.sell))
    expect(t.$('chart-sell')?.style.color).toBe(css('color', dark.onSell))
    expect(t.$('chart-buy')?.textContent).toMatch(/^BUY/)
    expect(t.$('chart-sell')?.textContent).toMatch(/^SELL/)
  })

  test('BUY and SELL send trade intents with lots; taps inside 120 ms are one', () => {
    jest.useFakeTimers({ now: 1_000_000 })
    const t = setup({
      seed: { meta: NIFTY_FUT },
      inst: { exchange: 'NFO', symbol: 'NIFTY26DECFUT' },
    })
    expect(t.$('chart-buy')?.getAttribute('aria-label')).toBe('Chart buy')
    expect(t.$('chart-sell')?.getAttribute('aria-label')).toBe('Chart sell')
    expect(t.$('chart-lots')?.textContent).toContain('1L')
    t.tap('chart-lots-dec')
    expect(t.$('chart-lots')?.textContent).toContain('1L')
    t.tap('chart-lots-inc')
    t.tap('chart-lots-inc')
    expect(t.$('chart-lots')?.textContent).toContain('3L')

    t.tap('chart-buy')
    jest.advanceTimersByTime(119)
    t.tap('chart-sell')
    t.tap('chart-buy')
    jest.advanceTimersByTime(1)
    t.tap('chart-sell')
    const inst = { exchange: 'NFO', symbol: 'NIFTY26DECFUT' }
    expect(t.intents()).toEqual([
      { type: 'trade', inst, side: 'BUY', lots: 3 },
      { type: 'trade', inst, side: 'SELL', lots: 3 },
    ])
  })

  test('lots run from 1 to 9,999, shown without L where the exchange trades in units', () => {
    const t = setup({ seed: { meta: INFY } })
    const lots = () => t.$('chart-lots')?.textContent
    expect(lots()).toBe('−1+')
    for (let i = 0; i < 10_005; i++) t.tap('chart-lots-inc')
    expect(lots()).toBe('−9999+')
    expect(t.$('chart-lots-inc')?.hasAttribute('disabled')).toBe(true)
    t.tap('chart-lots-dec')
    expect(lots()).toBe('−9998+')
  })

  test('the panel hides for quote-only and until meta arrives', () => {
    const t = setup()
    expect(t.panel()?.style).toMatchObject({
      position: 'absolute',
      top: `${TOPBAR_HEIGHT + 8}px`,
      left: '8px',
    })
    // On the chart, beside the candles.
    expect(t.panel()?.parentElement).toBe(t.plot)
    expect(t.shown()).toBe(false)

    t.push(CHART_TOPICS.meta, { ...INFY, quoteOnly: true })
    // A meta for another instrument is not this chart's.
    t.push(CHART_TOPICS.meta, { ...INFY, symbol: 'TCS' })
    expect(t.shown()).toBe(false)
    expect(t.subs).toEqual([])

    t.push(CHART_TOPICS.meta, INFY)
    expect(t.shown()).toBe(true)
    t.push(CHART_TOPICS.meta, null)
    expect(t.shown()).toBe(false)
  })

  test('the buttons show the bid and the ask from a depth subscription, else the LTP', () => {
    const t = setup({ seed: { meta: INFY, ltp: 1499.95 } })
    expect(t.subs.map((s) => [s.req, s.opts])).toEqual([
      [{ symbol: 'INFY', exchange: 'NSE', interval: '5m' }, { depthLevel: 5 }],
    ])
    const prices = () => [t.$('chart-sell')?.textContent, t.$('chart-buy')?.textContent]
    expect(prices()).toEqual(['SELL1,499.95', 'BUY1,499.95'])
    t.depth({ bids: [{ price: 1500 }], asks: [{ price: 1500.05 }], ltp: 1500 })
    expect(prices()).toEqual(['SELL1,500.00', 'BUY1,500.05'])
    t.depth({ ltp: 1501.5 })
    expect(prices()).toEqual(['SELL1,501.50', 'BUY1,501.50'])

    // The same meta again keeps the one subscription; an index has none.
    t.push(CHART_TOPICS.meta, INFY)
    expect(t.subs).toHaveLength(1)
    const index = setup({ seed: { meta: NIFTY }, inst: { exchange: 'NSE_INDEX', symbol: 'NIFTY' } })
    expect(index.subs).toEqual([])
    expect(index.shown()).toBe(false)
  })
})

describe('long press', () => {
  test('a 500 ms press in place sends one priceMenu at the snapped price', () => {
    jest.useFakeTimers()
    const t = setup({ seed: { meta: INFY } })
    // y 398.97 in the chart is 601.03, which snaps to 601.05.
    pointer(t.plot, 'pointerdown', { y: 498.97 })
    pointer(t.plot, 'pointermove', { x: 55, y: 502 })
    jest.advanceTimersByTime(499)
    expect(t.intents()).toEqual([])
    // Android raises the widget's own menu on a long press; the glue keeps it shut.
    const menu = pointer(t.plot, 'contextmenu', { y: 498.97 })
    expect(menu.defaultPrevented).toBe(true)
    jest.advanceTimersByTime(1)
    pointer(t.plot, 'pointerup', { y: 502 })
    jest.advanceTimersByTime(1000)
    expect(t.intents()).toEqual([
      { type: 'priceMenu', inst: { exchange: 'NSE', symbol: 'INFY' }, price: 601.05 },
    ])
  })

  test('a move over 8 px, a second finger or an active drawing tool cancels the press', () => {
    jest.useFakeTimers()
    const t = setup({ seed: { meta: INFY } })
    const hold = (steps: () => void) => {
      steps()
      jest.advanceTimersByTime(600)
      pointer(t.plot, 'pointerup', { y: 400 })
      pointer(t.plot, 'pointerup', { id: 2, y: 400 })
    }
    hold(() => {
      pointer(t.plot, 'pointerdown', { y: 400 })
      pointer(t.plot, 'pointermove', { x: 56, y: 406.5 })
    })
    hold(() => {
      pointer(t.plot, 'pointerdown', { y: 400 })
      pointer(t.plot, 'pointerdown', { id: 2, x: 200, y: 300, primary: false })
    })
    t.setTool('trend-line')
    hold(() => pointer(t.plot, 'pointerdown', { y: 400 }))
    t.setTool(null)
    // A tool picked while the finger is down wins too.
    hold(() => {
      pointer(t.plot, 'pointerdown', { y: 400 })
      t.setTool('trend-line')
    })
    t.setTool(null)
    // A press on an order line is its drag.
    t.push(CHART_TOPICS.orders, [LIMIT_BUY])
    hold(() => {
      t.chart.grab('order:1')
      pointer(t.plot, 'pointerdown', { y: 400 })
    })
    t.chart.release('order:1', 600)
    // On the panel, below the price pane, or where the chart has no price, a press is no price.
    hold(() => pointer(t.$('chart-lots') as HTMLElement, 'pointerdown', { y: 160 }))
    hold(() => pointer(t.plot, 'pointerdown', { y: 801 }))
    const priceAt = t.chart.chart.coordinateToPrice
    t.chart.chart.coordinateToPrice = () => null as unknown as number
    hold(() => pointer(t.plot, 'pointerdown', { y: 400 }))
    t.chart.chart.coordinateToPrice = priceAt
    expect(t.intents()).toEqual([])

    // Exactly 8 px still counts as in place.
    hold(() => {
      pointer(t.plot, 'pointerdown', { y: 400 })
      pointer(t.plot, 'pointermove', { y: 408 })
    })
    expect(t.intents()).toMatchObject([{ type: 'priceMenu', price: 700 }])
  })

  test("a long press on a line's X opens the price menu only: its release's click is no tap", () => {
    jest.useFakeTimers()
    const t = setup({
      seed: { meta: INFY, orders: [LIMIT_BUY], positions: [{ product: 'MIS', net: 1, avg: 99 }] },
    })
    for (const x of ['order:1::close', 'position:MIS::close']) {
      pointer(t.plot, 'pointerdown', { y: 400 })
      jest.advanceTimersByTime(500)
      pointer(t.plot, 'pointerup', { y: 400 })
      // the chart makes a click of the release, whatever the press's length
      t.chart.click(x)
    }
    expect(t.intents().map((i) => i.type)).toEqual(['priceMenu', 'priceMenu'])

    // the next tap on an X is one again
    pointer(t.plot, 'pointerdown', { y: 400 })
    pointer(t.plot, 'pointerup', { y: 400 })
    t.chart.click('order:1::close')
    expect(t.intents().map((i) => i.type)).toEqual(['priceMenu', 'priceMenu', 'cancel'])
  })

  test('a chart without a tradeable instrument has no price menu', () => {
    jest.useFakeTimers()
    const t = setup({ seed: { meta: NIFTY }, inst: { exchange: 'NSE_INDEX', symbol: 'NIFTY' } })
    pointer(t.plot, 'pointerdown', { y: 400 })
    jest.advanceTimersByTime(600)
    expect(t.intents()).toEqual([])
  })
})

describe('instrument', () => {
  test('a symbol change sends a symbol intent and clears the lines', () => {
    const t = setup({
      seed: {
        meta: INFY,
        ltp: 1500,
        orders: [LIMIT_BUY],
        positions: [{ product: 'MIS', net: 1, avg: 1490 }],
      },
    })
    const infyDepth = t.subs[0]
    t.changeSymbol({ exchange: 'NSE', symbol: 'TCS' })
    expect(t.intents()).toEqual([{ type: 'symbol', inst: { exchange: 'NSE', symbol: 'TCS' } }])
    expect(t.chart.lines).toEqual([])
    expect(t.shown()).toBe(false)
    expect(infyDepth?.off).toHaveBeenCalledTimes(1)

    // Nothing of INFY comes back: not on a redraw, nor from its late meta.
    t.push(CHART_TOPICS.redraw, null)
    t.push(CHART_TOPICS.meta, INFY)
    expect(t.chart.lines).toEqual([])
    expect(t.shown()).toBe(false)

    t.push(CHART_TOPICS.meta, { ...INFY, symbol: 'TCS' })
    expect(t.shown()).toBe(true)
    expect(t.subs.at(-1)?.req).toEqual({ symbol: 'TCS', exchange: 'NSE', interval: '5m' })
    expect(t.$('chart-buy')?.textContent).toBe('BUY—')
  })

  test('every intent carries the chart instrument', () => {
    jest.useFakeTimers()
    const t = setup({
      seed: {
        meta: INFY,
        orders: [LIMIT_BUY],
        positions: [{ product: 'CNC', net: 4, avg: 1500 }],
      },
    })
    /** A tap the chart makes a click of: its pointerdown first. */
    const tapX = (id: string) => {
      pointer(t.plot, 'pointerdown', { y: 400 })
      pointer(t.plot, 'pointerup', { y: 400 })
      t.chart.click(id)
    }
    const all = () => {
      t.tap('chart-buy')
      jest.advanceTimersByTime(200)
      t.chart.grab('order:1')
      t.chart.drag('order:1', 98)
      t.chart.release('order:1', 98)
      tapX('order:1::close')
      tapX('position:CNC::close')
      pointer(t.plot, 'pointerdown', { y: 400 })
      jest.advanceTimersByTime(500)
      pointer(t.plot, 'pointerup', { y: 400 })
    }
    all()
    t.changeSymbol({ exchange: 'BSE', symbol: 'TCS' })
    t.push(CHART_TOPICS.meta, { ...INFY, exchange: 'BSE', symbol: 'TCS' })
    t.push(CHART_TOPICS.orders, [LIMIT_BUY])
    t.push(CHART_TOPICS.positions, [{ product: 'CNC', net: 4, avg: 1500 }])
    all()
    const types = (i: ChartIntent[]) => i.map((x) => [x.type, x.inst.exchange, x.inst.symbol])
    const once = ['trade', 'modify', 'cancel', 'close', 'priceMenu']
    expect(types(t.intents())).toEqual([
      ...once.map((type) => [type, 'NSE', 'INFY']),
      ['symbol', 'BSE', 'TCS'],
      ...once.map((type) => [type, 'BSE', 'TCS']),
    ])
  })
})

test('dispose takes the panel, the lines and every listener away', () => {
  const t = setup({
    seed: { meta: INFY, orders: [LIMIT_BUY], positions: [{ product: 'MIS', net: 1, avg: 1 }] },
  })
  expect(t.listeners()).toBeGreaterThan(0)
  t.dispose()
  expect(t.chart.lines).toEqual([])
  expect(t.listeners()).toBe(0)
  expect(t.panel()).toBeNull()
  expect(t.subs[0]?.off).toHaveBeenCalledTimes(1)
  t.push(CHART_TOPICS.orders, [LIMIT_BUY])
  expect(t.chart.lines).toEqual([])
})
