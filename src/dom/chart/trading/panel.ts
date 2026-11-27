// The trade panel: BUY, the lots chip and SELL, at the top left of the chart (design 7.9.4). The
// web terminal draws it on the canvas (BuySellButtons, terminal.ts:2668-2680 at c8b2896), SELL
// first, and prices it from its depth stream (6590-6611). Here BUY comes first, as on the ticket,
// the Option Chain leg sheet and Kite: one side order across the app. It is HTML, for 44 px touch
// targets, the screen reader and Maestro, which find the buttons in the WebView's accessibility
// tree; the row is built in the order it is drawn, so reading and focus order match it. Prices
// are written to text nodes, never through React. A tap is a trade intent: native opens the
// ticket, or places at once in one-tap mode.
import { TOPBAR_HEIGHT } from 'openalgo-charts/widget'
import type { ChartMeta } from '~/dom/bridge/protocol'
import type { TradeColors } from './lines'

/** The terminal's double-fire guard (terminal.ts:948): a tap inside it is the same tap. */
export const ORDER_COOLDOWN_MS = 120
export const MAX_LOTS = 9_999
const TOUCH = '44px'
const NO_PRICE = '—'
/**
 * What a finger on the panel sends that the chart's element would act on too (openalgo-charts
 * 2.7.3 _attachInput): the whole press, its end included, not only its start. The glue's
 * capture listener already cancels a contextmenu, and the chart's lostpointercapture handler
 * acts only on pointers it pressed itself.
 */
const PANEL_OWNS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'dblclick',
  'wheel',
] as const

export type TradePanel = {
  setMeta(m: ChartMeta | null): void
  setPrices(bid?: number, ask?: number, ltp?: number): void
  dispose(): void
}

const isPrice = (n: number | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0

/** The decimals a tick implies (0.05 → 2, 0.0025 → 4, 1 → 0), as the terminal's format.ts. */
function tickDecimals(tick: number): number {
  let d = 0
  for (let v = tick; d < 8 && Math.abs(v - Math.round(v)) > 1e-9; v *= 10) d++
  return d
}

const formats = new Map<number, Intl.NumberFormat>()
function priceText(n: number | null, tick: number): string {
  if (n === null) return NO_PRICE
  const dp = Math.max(2, tick > 0 ? tickDecimals(tick) : 0)
  let f = formats.get(dp)
  if (f === undefined) {
    f = new Intl.NumberFormat('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
    formats.set(dp, f)
  }
  return f.format(n)
}

export function mountTradePanel(
  root: HTMLElement,
  o: { colors: TradeColors; onTrade(side: 'BUY' | 'SELL', lots: number): void },
): TradePanel {
  const doc = root.ownerDocument
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    style: Partial<CSSStyleDeclaration>,
    attrs: Record<string, string> = {},
  ) => {
    const e = doc.createElement(tag)
    Object.assign(e.style, style)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
    return e
  }

  let meta: ChartMeta | null = null
  let instKey: string | null = null
  let lots = 1
  let lastTap = Number.NEGATIVE_INFINITY

  const panel = el('div', {
    position: 'absolute',
    top: `${TOPBAR_HEIGHT + 8}px`,
    left: '8px',
    zIndex: '20',
    display: 'none',
    gap: '6px',
    font: '600 13px var(--oac-font, sans-serif)',
  })

  function sideButton(side: 'BUY' | 'SELL') {
    const button = el(
      'button',
      {
        minWidth: '76px',
        minHeight: TOUCH,
        padding: '4px 10px',
        border: '0',
        borderRadius: '6px',
        background: side === 'BUY' ? o.colors.buy : o.colors.sell,
        color: side === 'BUY' ? o.colors.onBuy : o.colors.onSell,
        font: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      },
      {
        id: side === 'BUY' ? 'chart-buy' : 'chart-sell',
        type: 'button',
        'aria-label': side === 'BUY' ? 'Chart buy' : 'Chart sell',
      },
    )
    const label = el('span', {})
    label.textContent = side
    const price = doc.createTextNode(NO_PRICE)
    const priceRow = el('span', {
      fontSize: '11px',
      fontWeight: '500',
      fontVariantNumeric: 'tabular-nums',
    })
    priceRow.append(price)
    button.append(label, priceRow)
    button.addEventListener('click', () => {
      const now = Date.now()
      if (meta === null || meta.quoteOnly || now - lastTap < ORDER_COOLDOWN_MS) return
      lastTap = now
      o.onTrade(side, lots)
    })
    return { button, price }
  }

  const lotButton = (id: string, label: string, text: string) => {
    const b = el(
      'button',
      {
        minWidth: TOUCH,
        minHeight: TOUCH,
        border: '0',
        background: 'transparent',
        color: 'inherit',
        font: '500 18px var(--oac-font, sans-serif)',
      },
      { id, type: 'button', 'aria-label': label },
    )
    b.textContent = text
    return b
  }

  const buy = sideButton('BUY')
  const sell = sideButton('SELL')
  const chip = el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      borderRadius: '6px',
      background: 'var(--oac-panel)',
      color: 'var(--oac-tx)',
      border: '1px solid var(--oac-bd)',
    },
    { id: 'chart-lots', role: 'group', 'aria-label': 'Lots' },
  )
  const dec = lotButton('chart-lots-dec', 'Fewer lots', '−')
  const inc = lotButton('chart-lots-inc', 'More lots', '+')
  const count = doc.createTextNode('')
  const countBox = el('span', {
    minWidth: '36px',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
  })
  countBox.append(count)
  chip.append(dec, countBox, inc)
  panel.append(buy.button, chip, sell.button)

  function showLots() {
    count.data = meta?.lots ? `${lots}L` : String(lots)
    dec.toggleAttribute('disabled', lots <= 1)
    inc.toggleAttribute('disabled', lots >= MAX_LOTS)
  }
  const step = (by: number) => () => {
    lots = Math.min(MAX_LOTS, Math.max(1, lots + by))
    showLots()
  }
  dec.addEventListener('click', step(-1))
  inc.addEventListener('click', step(1))

  // A press on the panel is not the chart's: no pan, no crosshair, no long press, and no
  // double-tap reset under a fast second tap. The panel sits inside the chart's own input
  // element (.oac-chart), so the end of a press stops here too: openalgo-charts 2.7.3 turns a
  // pointerup or pointercancel that comes with no press of its own into a click at the chart's
  // last press (_onPointerUp → _endClick), and a tap on BUY after a tap on a line's X would
  // send that X's cancel or close again.
  const own = (e: Event) => e.stopPropagation()
  for (const type of PANEL_OWNS) panel.addEventListener(type, own)

  const write = (node: Text, text: string) => {
    if (node.data !== text) node.data = text
  }

  showLots()
  root.append(panel)

  return {
    setMeta(m) {
      const key = m === null ? null : `${m.exchange}:${m.symbol}`
      if (key !== null && key !== instKey) {
        // Another instrument: one lot, and no price until its own arrives.
        instKey = key
        lots = 1
        write(sell.price, NO_PRICE)
        write(buy.price, NO_PRICE)
      }
      meta = m
      panel.style.display = m === null || m.quoteOnly ? 'none' : 'flex'
      showLots()
    },
    setPrices(bid, ask, ltp) {
      const tick = meta?.tick ?? 0
      const last = isPrice(ltp) ? ltp : null
      write(sell.price, priceText(isPrice(bid) ? bid : last, tick))
      write(buy.price, priceText(isPrice(ask) ? ask : last, tick))
    },
    dispose() {
      panel.remove()
    },
  }
}
