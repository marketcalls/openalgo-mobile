// The trading glue (design 7.9.4, 7.9.6), ported from the web terminal's chart wiring,
// frontend/src/lib/trading/terminal.ts at c8b2896:
// - drag to modify with a ghost at the old price, snapped to the tick (2706-2745), once the finger
//   has moved past the chart's own tap slop;
// - the close buttons (2746-2760);
// - the depth subscription that prices the buttons (6614-6620). Here it is a second
//   subscription, beside the widget's own bars, and it names the interval (preflight
//   conflict 22).
// The page places nothing: a tap, a drag, an X and a long press each become a ChartIntent for
// native's order flows, always for the instrument the chart shows. Native reads the book fresh
// before it acts (RF 1, RF 2), and a dragged line goes back to the book price until a push
// moves it (RF 6).
import { type OpenAlgoLiveDataFeed, type PriceLine, roundToTick } from 'openalgo-charts'
import type { Widget } from 'openalgo-charts/widget'
import {
  CHART_TOPICS,
  type ChartIntent,
  type ChartMeta,
  type ChartOrder,
  type ChartPosition,
  type Inst,
} from '~/dom/bridge/protocol'
import type { DomClient } from '~/dom/web/client'
import { tokens } from '~/ui/tokens'
import {
  bookPrice,
  CLOSE_SUFFIX,
  lineExtent,
  ORDER_PREFIX,
  type OrderLineRec,
  POSITION_PREFIX,
  syncOrderLines,
  syncPositionLines,
} from './lines'
import { attachLongPress } from './longPress'
import { mountTradePanel } from './panel'

/** The book depth the buttons are priced from (terminal.ts:6619). */
const DEPTH_LEVEL = 5
/** The chart's own tap slop (openalgo-charts `_movedFromPress`): a finger that moves no more taps. */
const TAP_SLOP_PX = 3
const PRODUCTS: ReadonlySet<string> = new Set(['MIS', 'CNC', 'NRML'])
const ignore = () => {}

/** The trade pushes the glue opens with. */
export type TradeSeed = {
  meta: ChartMeta | null
  ltp: number | null
  orders: ChartOrder[]
  positions: ChartPosition[]
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type IntentBody = DistributiveOmit<ChartIntent, 'inst'>

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isPrice = (x: unknown): x is number => isNum(x) && x > 0

function asMeta(x: unknown): ChartMeta | null {
  if (!isObj(x)) return null
  const ok =
    typeof x.exchange === 'string' &&
    typeof x.symbol === 'string' &&
    isNum(x.tick) &&
    typeof x.lots === 'boolean' &&
    typeof x.quoteOnly === 'boolean'
  return ok ? (x as ChartMeta) : null
}
const isOrder = (x: unknown): x is ChartOrder =>
  isObj(x) &&
  typeof x.id === 'string' &&
  x.id !== '' &&
  (x.side === 'BUY' || x.side === 'SELL') &&
  typeof x.type === 'string' &&
  isNum(x.qty) &&
  isNum(x.price) &&
  (x.trigger === null || isNum(x.trigger))
const isPosition = (x: unknown): x is ChartPosition =>
  isObj(x) && PRODUCTS.has(x.product as string) && isNum(x.net) && isNum(x.avg)
const asOrders = (x: unknown) => (Array.isArray(x) ? x.filter(isOrder) : [])
const asPositions = (x: unknown) => (Array.isArray(x) ? x.filter(isPosition) : [])

/**
 * roundToTick without its float noise: roundToTick(101.03, 0.05) is 101.05000000000001
 * (preflight conflict 26). Native snaps every intent price again.
 */
const snap = (price: number, tick: number) => Number(roundToTick(price, tick).toPrecision(12))

/**
 * Keeps the trade pushes that come while the widget is being built (the page reads its saved
 * state first), for attachTrading to open with: chart.init's meta and LTP, then the latest meta,
 * orders and positions.
 */
export function holdTradePushes(client: DomClient): { seed: TradeSeed; stop(): void } {
  const seed: TradeSeed = { meta: null, ltp: null, orders: [], positions: [] }
  const offs = [
    client.onPush(CHART_TOPICS.init, (p) => {
      if (!isObj(p)) return
      seed.meta = asMeta(p.meta)
      seed.ltp = isPrice(p.ltp) ? p.ltp : null
    }),
    client.onPush(CHART_TOPICS.meta, (p) => {
      seed.meta = asMeta(p)
    }),
    client.onPush(CHART_TOPICS.orders, (p) => {
      seed.orders = asOrders(p)
    }),
    client.onPush(CHART_TOPICS.positions, (p) => {
      seed.positions = asPositions(p)
    }),
  ]
  return {
    seed,
    stop() {
      for (const off of offs.splice(0)) off()
    },
  }
}

export function attachTrading(
  widget: Widget,
  client: DomClient,
  live: Pick<OpenAlgoLiveDataFeed, 'subscribeDepth'>,
  seed: TradeSeed,
): { dispose(): void } {
  const chart = widget.chart
  // The chart's own element: the panel sits on the plot, and a press there is priced.
  const plot = widget.root.querySelector<HTMLElement>('.oac-chart') ?? widget.root
  const orderRecs = new Map<string, OrderLineRec>()
  const positionRecs = new Map<string, PriceLine>()
  let { orders, positions, ltp } = seed
  let meta: ChartMeta | null = null
  let depth: { key: string; off: () => void } | null = null
  /** The line the finger is on, from the chart's drag:start to its end or cancel. */
  let dragId: string | null = null
  /** Where that finger went down, and whether it has left the tap slop since. */
  let grab: { x: number; y: number; moved: boolean } | null = null
  /** A long press opened the price menu: the click its release makes (an X under it) is no tap. */
  let pressed = false

  const inst = (): Inst => ({ exchange: widget.exchange(), symbol: widget.symbol() })
  let shown = inst()
  const colors = () => tokens.trade[widget.theme()]
  const tick = () => meta?.tick ?? 0
  const tradeable = () => meta !== null && !meta.quoteOnly
  const send = (body: IntentBody) => {
    const intent = { ...body, inst: inst() } as ChartIntent
    client.call({ v: 1, kind: 'intent', intent }).catch(ignore)
  }

  const panel = mountTradePanel(plot, {
    colors: colors(),
    onTrade: (side, lots) => send({ type: 'trade', side, lots }),
  })
  const extent = () => lineExtent(chart.plotRect(chart.primaryPaneIndex())?.width ?? 0)
  const drawOrders = () => syncOrderLines(chart, orderRecs, orders, colors(), extent())
  const drawPositions = () =>
    syncPositionLines(chart, positionRecs, positions, ltp, colors(), extent())

  const stopDepth = () => {
    depth?.off()
    depth = null
  }
  function setMeta(next: ChartMeta | null) {
    // A meta for an instrument the chart has left is not this chart's.
    if (next !== null && (next.exchange !== shown.exchange || next.symbol !== shown.symbol)) return
    meta = next
    panel.setMeta(next)
    const key = next !== null && !next.quoteOnly ? `${next.exchange}:${next.symbol}` : null
    if (depth?.key === key) return
    stopDepth()
    if (next === null || key === null) return
    const req = { symbol: next.symbol, exchange: next.exchange, interval: widget.interval() }
    const off = live.subscribeDepth(
      req,
      (d) => {
        if (isPrice(d.ltp)) ltp = d.ltp
        panel.setPrices(d.bids[0]?.price, d.asks[0]?.price, d.ltp)
        if (positionRecs.size > 0) drawPositions()
      },
      { depthLevel: DEPTH_LEVEL },
    )
    depth = { key, off }
  }

  /** The record of a drag on an order line's body (not its X). */
  const draggedOrder = (id: string) =>
    id.startsWith(ORDER_PREFIX) && !id.endsWith(CLOSE_SUFFIX)
      ? orderRecs.get(id.slice(ORDER_PREFIX.length))
      : undefined
  /** Ends a drag: no ghost, and the line back at the book price. */
  const putBack = (rec: OrderLineRec) => {
    rec.dragFrom = null
    rec.line.setDragGhost(null)
    rec.line.setPrice(bookPrice(rec.order))
  }

  // A line drags only while the chart has a drag subscriber. The move is the 'drag' event's, which
  // says where the finger is: the chart moves a line on every pointermove, a tap's jitter too.
  const offDrag = chart.subscribeDrag(ignore, (id, price) => {
    const rec = draggedOrder(id)
    // A tap on the line, or a drag the chart cancelled, ends with nothing to modify.
    if (rec === undefined || rec.dragFrom === null) return
    const from = snap(rec.dragFrom, tick())
    putBack(rec)
    const to = snap(price, tick())
    if (to > 0 && to !== from) send({ type: 'modify', orderid: rec.order.id, price: to })
  })
  const offBus = [
    chart.on('drag:start', (e) => {
      dragId = e.id
      grab = { ...e.point, moved: false }
    }),
    chart.on('drag', (e) => {
      const rec = draggedOrder(e.id)
      if (rec === undefined || grab === null) return
      const { x, y } = e.point
      grab.moved ||= Math.abs(x - grab.x) > TAP_SLOP_PX || Math.abs(y - grab.y) > TAP_SLOP_PX
      if (!grab.moved) return
      if (rec.dragFrom === null) {
        rec.dragFrom = bookPrice(rec.order)
        rec.line.setDragGhost(rec.dragFrom)
      }
      rec.line.setPrice(snap(e.price, tick()))
    }),
    chart.on('drag:end', () => {
      dragId = null
      grab = null
    }),
    chart.on('drag:cancel', (e) => {
      dragId = null
      grab = null
      const rec = draggedOrder(e.id)
      if (rec !== undefined && rec.dragFrom !== null) putBack(rec)
    }),
    // A turned phone, or the widget's chrome, changes the plot's width: the lines' reach with it.
    chart.on('resize', () => {
      drawOrders()
      drawPositions()
    }),
  ]

  const offClick = chart.subscribeClick((id) => {
    if (pressed || !id.endsWith(CLOSE_SUFFIX)) return
    const target = id.slice(0, -CLOSE_SUFFIX.length)
    if (target.startsWith(ORDER_PREFIX)) {
      const rec = orderRecs.get(target.slice(ORDER_PREFIX.length))
      if (rec !== undefined) send({ type: 'cancel', orderid: rec.order.id })
    } else if (target.startsWith(POSITION_PREFIX)) {
      const product = target.slice(POSITION_PREFIX.length)
      if (positionRecs.has(product)) {
        send({ type: 'close', product: product as ChartPosition['product'] })
      }
    }
  })

  const offPress = attachLongPress(plot, {
    blocked: () => widget.draw.activeTool() !== null || dragId !== null || !tradeable(),
    onPress: (y) => {
      pressed = true
      const pane = chart.primaryPaneIndex()
      const rect = chart.plotRect(pane)
      if (rect === null || y < rect.top || y > rect.top + rect.height) return
      const p = chart.coordinateToPrice(y, pane)
      if (p === null) return
      const price = snap(p, tick())
      if (price > 0) send({ type: 'priceMenu', price })
    },
  })
  // Android raises a context menu on a long press, and the widget opens its own unless the
  // event was handled (preflight conflict 25): the long press is the price menu instead.
  const noMenu = (e: Event) => e.preventDefault()
  widget.root.addEventListener('contextmenu', noMenu, true)
  const onDown = () => {
    pressed = false
  }
  plot.addEventListener('pointerdown', onDown, true)

  const offSymbol = widget.on('symbol', () => {
    const now = inst()
    if (now.exchange === shown.exchange && now.symbol === shown.symbol) return
    shown = now
    // Nothing of the last instrument stays: native pushes the new one's meta and books.
    orders = []
    positions = []
    ltp = null
    drawOrders()
    drawPositions()
    setMeta(null)
    send({ type: 'symbol' })
  })

  const offPushes = [
    client.onPush(CHART_TOPICS.meta, (p) => setMeta(asMeta(p))),
    client.onPush(CHART_TOPICS.orders, (p) => {
      orders = asOrders(p)
      drawOrders()
    }),
    client.onPush(CHART_TOPICS.positions, (p) => {
      positions = asPositions(p)
      drawPositions()
    }),
    client.onPush(CHART_TOPICS.redraw, () => {
      drawOrders()
      drawPositions()
    }),
  ]

  setMeta(seed.meta)
  panel.setPrices(undefined, undefined, ltp ?? undefined)
  drawOrders()
  drawPositions()

  return {
    dispose() {
      for (const off of [...offPushes, ...offBus, offDrag, offClick, offSymbol, offPress]) off()
      widget.root.removeEventListener('contextmenu', noMenu, true)
      plot.removeEventListener('pointerdown', onDown, true)
      stopDepth()
      panel.dispose()
      if (widget.isDestroyed) return
      orders = []
      positions = []
      drawOrders()
      drawPositions()
    },
  }
}
