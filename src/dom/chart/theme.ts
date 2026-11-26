// The chart's palette: the library's dark or light theme on the app's own surfaces, with BUY green
// and SELL red everywhere (candles, wicks, the last-price tag, the trade layer), as on every other
// screen of the app.
import { type ChartTheme, darkTheme, lightTheme } from 'openalgo-charts'
import { tokens } from '~/ui/tokens'

export function chartTheme(scheme: 'dark' | 'light'): ChartTheme {
  const surface = tokens[scheme]
  const trade = tokens.trade[scheme]
  return {
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
}
