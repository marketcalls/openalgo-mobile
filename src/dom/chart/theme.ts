// The chart's palette: the library's dark or light theme on the app's own surfaces, with BUY green
// and SELL red everywhere (candles, wicks, the last-price tag, the trade layer), as on every other
// screen of the app.
import { type ChartTheme, darkTheme, lightTheme } from 'openalgo-charts'
import type { Widget } from 'openalgo-charts/widget'
import { tokens } from '~/ui/tokens'

/** Every palette chartTheme has built; the widget passes the same object to its 'theme' event. */
const built = new WeakSet<ChartTheme>()

export function chartTheme(scheme: 'dark' | 'light'): ChartTheme {
  const surface = tokens[scheme]
  const trade = tokens.trade[scheme]
  const theme: ChartTheme = {
    ...(scheme === 'dark' ? darkTheme : lightTheme),
    background: surface.background,
    axisText: surface.mutedForeground,
    // An opaque token: the widget derives its chrome from these colours, and the border tokens
    // carry an alpha.
    grid: surface.muted,
    upColor: trade.buy,
    downColor: trade.sell,
    wickUpColor: trade.buy,
    wickDownColor: trade.sell,
    lastPriceUp: trade.buy,
    lastPriceDown: trade.sell,
    buy: trade.buy,
    sell: trade.sell,
    profit: trade.profit,
    loss: trade.loss,
  }
  built.add(theme)
  return theme
}

/**
 * Keeps the app's palette on the widget. The widget's own Theme control (the topbar button and
 * the mobile More sheet's row) and a restored widget state call `setTheme` with a theme name,
 * which is the library's palette: teal and off-red candles on the library's surfaces. The
 * scheme picked there stays, in the app's colours. The app's scheme still sets the theme on
 * every open and every change.
 *
 * The palette goes back on in a microtask, before the next paint: every listener sees the
 * library's palette first and the app's last. The second 'theme' event carries a palette built
 * here, so it is not applied again.
 */
export function keepAppPalette(
  widget: Pick<Widget, 'on' | 'setTheme' | 'isDestroyed'>,
): () => void {
  let stopped = false
  let latest: ChartTheme | null = null
  const off = widget.on('theme', ({ theme: name, chartTheme: applied }) => {
    latest = applied
    if (built.has(applied)) return
    queueMicrotask(() => {
      // A later theme replaced this one, or the chart went away.
      if (stopped || widget.isDestroyed || latest !== applied) return
      widget.setTheme(chartTheme(name))
    })
  })
  return () => {
    stopped = true
    off()
  }
}
