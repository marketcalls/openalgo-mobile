// The chart's intents (design 7.9.4, 7.9.6): the page places nothing, and each tap, drag, X and
// long press it sends becomes one of the native order flows, the guards ported from the web
// terminal (frontend/src/lib/trading/terminal.ts:2203-2340 at c8b2896). The exit is design
// 7.10's close confirm, not the terminal's opposite placeorder.
// - Only the instrument on screen is acted on (RF 1): an intent for another, from a chart that
//   was changing symbol, is refused and opens nothing.
// - An order or position is read afresh before it is acted on (RF 2): one no longer open is said
//   so, and the lines are drawn again from the books.
// - Every write that starts here is 'mobile-chart': the ticket and modify links carry
//   `source: 'chart'`, the cancel and close their strategy; every price is snapped to the tick
//   again (preflight conflict 26).
import { type Href, useRouter } from 'expo-router'
import { createElement, type ReactNode, useCallback, useRef, useState } from 'react'
import { usePrefs } from '~/core/config/prefs'
import type { ChartIntent, ChartMeta, DomIntentMsg, Inst } from '~/dom/bridge/protocol'
import { orderSummary, useOrderWrites } from '~/features/orders'
import { usePositionWrites } from '~/features/portfolio'
import { isWorking, type OrderRow } from '~/market/books/schemas'
import { isStop } from '~/market/chart/lines'
import { type PriceAction, priceActions } from '~/market/chart/priceActions'
import type { WriteOutcome } from '~/market/components/OutcomeLine'
import { fmtTick, snapTick } from '~/market/instruments/tick'
import { useInstrument } from '~/market/instruments/useInstrument'
import { depthHref, modifyHref, ticketHref } from '~/market/links'
import { errorText } from '~/market/orders/outcome'
import { useFreshBook, useFreshPositions } from '~/market/orders/useFreshBook'
import type { Side } from '~/market/types'
import { toast } from '~/ui/Toast'
import { PriceActionSheet } from '../components/PriceActionSheet'
import { useOneTap } from './useOneTap'

export const WRONG_SYMBOL = 'The chart was changing symbol. Try again.'
export const NOT_OPEN = 'This order is no longer open.'
export const NO_POSITION = 'No open position for this product.'

const isInst = (a: Inst, b: Inst) => a.exchange === b.exchange && a.symbol === b.symbol

/** Whose notices the chart shows: the writer the last write started with. */
type Writer = 'orders' | 'positions' | 'oneTap'

/** An open long-press menu; `n` mounts each one afresh. */
type Menu = { n: number; title: string; actions: PriceAction[] }

/**
 * `current` is the instrument on screen now (a symbol intent changes it at once, T14), `meta` its
 * metadata as pushed to the page (null until it loads), `ltp` its last price, and `redraw` pushes
 * the lines again. The notices are the last writer's, of the order writes (cancel), the position
 * writes (close) and one-tap; `sheet` is the long-press menu, to render on the screen.
 */
export function useChartIntents(o: {
  current: () => Inst
  meta: ChartMeta | null
  ltp: () => number | null
  redraw: () => void
}): {
  onIntent: (m: DomIntentMsg) => void
  sheet: ReactNode
  outcome: WriteOutcome | null
  dismissOutcome: () => void
  semiBlocked: string | null
  liveSurprise: string | null
  dismissLiveSurprise: () => void
} {
  const router = useRouter()
  const orders = useOrderWrites()
  const positions = usePositionWrites()
  const oneTap = useOneTap()
  const readOrders = useFreshBook()
  const readPositions = useFreshPositions()
  // The confirm names an order as the Orders tab does, in lots: from the native metadata
  // (preflight conflict 20), which the chart's own lacks.
  const native = useInstrument(o.meta?.exchange ?? '', o.meta?.symbol ?? '').meta
  const [last, setLast] = useState<Writer | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const menus = useRef(0)
  /**
   * A book read for an X or a drag is out: another X or drag meanwhile is dropped, so a double
   * tap opens one confirm and one modify sheet.
   */
  const reading = useRef(false)

  const here = (inst: Inst) => isInst(o.current(), inst)
  /** The metadata, when it is the instrument's: just after a symbol change it may not be yet. */
  const metaOf = (inst: Inst) => (o.meta && isInst(o.meta, inst) ? o.meta : null)

  /**
   * Reads a book afresh, then acts on it if the chart still shows `inst`. A read that fails says
   * why and draws the lines again from the books as they are.
   */
  const afresh = async <B>(read: () => Promise<B>, inst: Inst, act: (b: B) => void) => {
    if (reading.current) return
    reading.current = true
    try {
      let b: B
      try {
        b = await read()
      } catch (e) {
        toast(errorText(e))
        o.redraw()
        return
      }
      if (here(inst)) act(b)
      else toast(WRONG_SYMBOL)
    } finally {
      reading.current = false
    }
  }

  /** The working order of this instrument, else NOT_OPEN and the lines drawn again. */
  const workingOrder = (rows: readonly OrderRow[], inst: Inst, orderid: string) => {
    const row = rows.find((r) => r.orderid === orderid && isInst(r, inst) && isWorking(r))
    if (row) return row
    toast(NOT_OPEN)
    o.redraw()
    return null
  }

  /** BUY or SELL: the ticket at market, or with one-tap on, the order itself. */
  const trade = (inst: Inst, meta: ChartMeta, side: Side, lots: number) => {
    if (usePrefs.getState().chartOneTap) {
      setLast('oneTap')
      oneTap.place(inst, meta, side, lots)
      return
    }
    const quantity = lots * (meta.lots ? meta.lotsize : 1)
    const href = ticketHref({
      ...inst,
      action: side,
      pricetype: 'MARKET',
      quantity,
      source: 'chart',
    })
    router.push(href as Href)
  }

  /** A long press: the orders the ticket can open at the pressed price, if any. */
  const priceMenu = (inst: Inst, meta: ChartMeta, pressed: number) => {
    const price = snapTick(pressed, meta.tick, pressed)
    const actions = priceActions({
      inst,
      price,
      ltp: o.ltp(),
      quoteOnly: meta.quoteOnly,
      units: meta.lots ? meta.lotsize : 1,
    })
    if (!actions.length) return
    menus.current++
    setMenu({
      n: menus.current,
      title: `${inst.symbol} @ ${fmtTick(price, meta.tick, price)}`,
      actions,
    })
  }

  const handle = (intent: ChartIntent) => {
    const { inst } = intent
    if (!here(inst)) {
      toast(WRONG_SYMBOL)
      return
    }
    const meta = metaOf(inst)
    switch (intent.type) {
      case 'trade':
      case 'priceMenu':
        // nothing is sized or priced from another instrument's metadata
        if (!meta) toast(WRONG_SYMBOL)
        else if (intent.type === 'trade') trade(inst, meta, intent.side, intent.lots)
        else priceMenu(inst, meta, intent.price)
        return
      case 'modify':
        void afresh(readOrders, inst, (b) => {
          const row = workingOrder(b.orders, inst, intent.orderid)
          if (!row) return
          const price = snapTick(intent.price, meta?.tick, intent.price)
          // a stop's line is its trigger (T12): the drag moves the trigger, not the limit price
          const preset = isStop(row.pricetype) ? { trigger_price: price } : { price }
          router.push(modifyHref(row.orderid, { ...preset, source: 'chart' }) as Href)
        })
        return
      case 'cancel':
        void afresh(readOrders, inst, (b) => {
          const row = workingOrder(b.orders, inst, intent.orderid)
          if (!row) return
          setLast('orders')
          const m = native && isInst(native, inst) ? native : undefined
          orders.cancel(row, orderSummary(row, m), { strategy: 'mobile-chart' })
        })
        return
      case 'close':
        void afresh(readPositions, inst, (b) => {
          const row = b.rows.find(
            (r) => isInst(r, inst) && r.product === intent.product && r.quantity !== 0,
          )
          if (!row) {
            toast(NO_POSITION)
            o.redraw()
            return
          }
          setLast('positions')
          positions.closeOne(row, { strategy: 'mobile-chart' })
        })
        return
      case 'depth':
        router.push(depthHref(inst.exchange, inst.symbol) as Href)
        return
      case 'symbol':
        // the chart screen switches the instrument (T14)
        return
    }
  }
  // One function for the page's whole life, acting with what this render knows.
  const latest = useRef(handle)
  latest.current = handle
  const onIntent = useCallback((m: DomIntentMsg) => latest.current(m.intent), [])

  const pick = (a: PriceAction) => {
    setMenu(null)
    if (here(a.params)) router.push(ticketHref(a.params) as Href)
    else toast(WRONG_SYMBOL)
  }

  const w = last === 'orders' ? orders : last === 'positions' ? positions : last ? oneTap : null
  return {
    onIntent,
    sheet: menu
      ? createElement(PriceActionSheet, {
          key: menu.n,
          title: menu.title,
          actions: menu.actions,
          onPick: pick,
          onClose: () => setMenu(null),
        })
      : null,
    outcome: w?.outcome ?? null,
    dismissOutcome: () => w?.dismissOutcome(),
    semiBlocked: w?.semiBlocked ?? null,
    liveSurprise: w?.liveSurprise ?? null,
    dismissLiveSurprise: () => w?.dismissLiveSurprise(),
  }
}
