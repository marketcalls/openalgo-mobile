// The storage keys the openalgo-charts 2.7.3 widget writes on the chart page (persist 'chart'),
// as the page's test (src/dom/chart/chart.test.ts) sees them cross the bridge. Native's storage
// test (src/dom/gateway/chartStorage.test.ts) maps the same keys to its areas. A WebView page may
// not import the gateway, so these literals are the tie: a library or key change that would move
// drawings into the preferences, or drop them, fails one of the two tests.
export const WIDGET_KEYS = {
  /** NSE:INFY's drawings (STORAGE_PREFIX, the persist name, DRAWINGS_KEY_PREFIX, EX:SYM). */
  drawings: 'oac-widget:chart:drawings:NSE:INFY',
  /** The widget's saved state, its interval among the rest: a preference. */
  state: 'oac-widget:chart:state',
} as const
