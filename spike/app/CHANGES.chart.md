<!-- THROWAWAY SPIKE. Log of what it took to reuse the web frontend's chart code inside an Expo DOM component. -->

# Chart screen: changes needed to reuse frontend chart code

Scope: `src/app/chart.tsx`, `src/dom/ChartDom.tsx`, `src/dom/chart/*`, `src/features/order/OrderSheet.tsx`,
`src/shims/chart/*`, `shims.chart.json`.

**Bottom line.** `@/components/chart/OpenAlgoChart` (frontend, 525 lines) runs **unchanged** inside a `'use dom'`
component, together with its deps `lib/chart/intervalRegistry`, `lib/trading/chartTheme`, `lib/utils` and
`stores/themeStore`. The changes needed are one module shim, a copied CSS file, a bundler workaround, and the
native glue. No wrapper around OpenAlgoChart was needed.

| # | Change | Category | Real app needs it? |
|---|--------|----------|--------------------|
| 1 | Shim `@/lib/trading/customIndicators` | shim / bundler | Yes, or the frontend changes its loader |
| 2 | Copy of `frontend/src/index.css` without its two `@import` lines | CSS | Yes, unless the frontend ships a dependency-free theme file |
| 3 | `@source not` for `components/trading/TickBox.tsx` | CSS | Yes, if the app scans all frontend sources |
| 4 | Static imports of every lazily loaded openalgo-charts chunk (`eagerChunks.ts`) | bundler (Expo CLI bug) | Until Expo fixes DOM export with split chunks |
| 5 | Dark theme forced via the frontend's own `useThemeStore.setMode('dark')` | theming | Yes (theme comes from native) |
| 6 | DataFeed implemented inside the DOM (`spikeFeed.ts`) | data | Yes: a mobile feed bridged from native or a WS inside the WebView |
| 7 | BuySellButtons + indicators attached through OpenAlgoChart's existing `onReady(widget)` | trading | Yes: the glue that terminal.ts does on the web |
| 8 | Native order ticket replacing terminal.ts' order paths | trading | Yes |
| 9 | Native host must memoize the DOM element; ref reset on remount | Expo DOM quirk | Yes |

## Details

### 1. `@/lib/trading/customIndicators` shimmed (`shims.chart.json` -> `src/shims/chart/customIndicators.ts`)
- **Why:** the real loader does `import(/* @vite-ignore */ urlOf(mod))`. Metro rejects a non-literal `import()`
  at build time: `customIndicators.ts: Invalid call at line 332: import(/* @vite-ignore */urlOf(mod))`.
  At runtime there is also no OpenAlgo origin or session in the WebView to fetch `/custom-indicators/index.json`.
- **Shim:** `loadCustomIndicators` / `ensureCustomIndicators` return `{ loaded: [], errors: [] }`.
- **Effect:** user (custom) indicators are not available on mobile. Built-ins are unaffected (OpenAlgoChart imports
  `openalgo-charts/indicators` itself; 3 are added on load, the widget's picker lists the rest).
- **Real app:** needs a loader that works in a WebView: fetch the module text with an API key or session and
  register it through `new Function`/blob URLs, or precompile user modules on the server.
- **Note:** shims are global in `metro.config.js`. This shim also applies to the tool page if it ever imports this module.

### 2. Frontend stylesheet: copied, not imported (`src/dom/chart/frontend-index.css`)
- **Why:** `frontend/src/index.css` starts with `@import "tailwindcss"` and `@import "tw-animate-css"`.
  Tailwind v4 resolves CSS `@import` relative to the importing file, so from `openalgo/frontend/src` it fails:
  `Can't resolve 'tailwindcss' in '/Users/openalgo/openmobile/openalgo/frontend/src'` (verified with
  `@tailwindcss/postcss` directly). Metro's resolver and `shims.*.json` do not apply inside CSS `@import`.
  `tw-animate-css` is not installed in the app either.
- **Workaround:** `frontend-index.css` is `sed 1,2d index.css` (body byte-identical, header comment added).
  `chart.css` does `@import "tailwindcss"`, then imports the copy, then `@source "<frontend>/src"`.
- **What depends on it:** `buildChartTheme()` reads `--background`, `--foreground`, `--primary`,
  `--muted-foreground`, `--border` from the `.dark` tokens (oklch), plus OpenAlgoChart's own Tailwind classes.
- **Real app:** split the frontend's tokens into a theme file with no package imports, or install the frontend's
  CSS dependencies where Tailwind can resolve them.
- **Cost:** 244 KB of minified CSS in the chart DOM bundle (`cssRules` is in the `chart:open` result), because the
  whole frontend source is scanned. Scanning only `components/chart` + `lib` would shrink it.
- **Risk:** the tokens are `oklch()`. An Android System WebView older than Chromium 111 cannot parse them, and
  `chartTheme.ts` then falls back to `#000` for those tokens. Not tested on an old WebView.

### 3. `@source not ".../components/trading/TickBox.tsx"`
- **Why:** comments in TickBox.tsx contain `[mask:url(...)]` and `url("data:image/svg+xml,...")`. Tailwind
  emits those as utilities, and Expo's CSS pipeline then reports
  `Importing local resources in CSS is not supported yet. (src/dom/chart/chart.css:2:133034)`.
- **Real app:** same exclusion, or reword those comments in the frontend. (The tool page's `tool.css` shows the
  same message in the export log.)

### 4. openalgo-charts lazy chunks loaded eagerly (`src/dom/chart/eagerChunks.ts`)
- **Why:** `expo export --platform android` failed in the DOM component export:
  `Error: Asset not found: _expo/static/js/web/__common-ab6ce6b0....js` (in `serializeHtml.js assetsRequiresSort`).
  `exportDomComponentAsync` renames DOM chunks to md5 names but leaves the old names in each chunk's
  `metadata.requires`. The widget lazy-loads 8 dialog modules, and `grid-bar` is shared by two of them, which
  produces a `__common` chunk. This is an Expo CLI bug, not an openalgo-charts or frontend one.
- **Workaround:** import `openalgo-charts/indicators` and the 8 `openalgo-charts.widget.*-<hash>.mjs` files
  statically (by relative path into node_modules, because they are not in the package `exports`). The
  chart's DOM bundle then has 0 `import(` calls and one JS file. Pinned to openalgo-charts 2.7.3 hashes.
- **Cost:** about 63 KB more parsed at open (the dialogs); the indicators tier is needed before first paint anyway.
- **Alternative:** `EXPO_NO_BUNDLE_SPLITTING=1` in the build environment (not tried; it is a build config change).
- **Real app:** needed until Expo fixes DOM export with split chunks. Worth filing upstream.

### 5. Theme
- `useThemeStore.getState().setMode('dark')` at module scope in the DOM, before the widget is built. The store's
  `persist` uses localStorage in the WebView, which works but is per-WebView.
- **Real app:** native owns the theme and passes it as a prop. OpenAlgoChart re-applies theme changes without a
  rebuild.

### 6. Data
- OpenAlgoChart takes any `DataFeed` (`getBars` and an optional `subscribeBars`), so `SpikeFeed` is a plain class:
  - 2,000 seeded 5-minute bars (also 1m/15m/1h on demand), 24x7 with no NSE session gaps. The last close is native's
    RELIANCE quote at mount.
  - `getBars` returns the whole series (the engine asks for ~500), so pans never page. Older pages return `[]`.
  - Live: 5 ticks/s in the DOM, or one per bridged quote. The sim clock runs 30x, so a 5-minute candle rolls every
    10 s. Bar times run ahead of the wall clock over time, and the engine's bar-close countdown will look odd.
- **Real app:** a feed that reads history from `/api/v1/history` and ticks from the native WebSocket (bridged) or
  from a WS opened inside the WebView. Either way the API key must not live in the DOM; see 8.
- OpenAlgoChart forces `pollIntervalMs: 0` and passes no `onOrder`, as on the web. Live updates come only through the
  feed's `subscribeBars`, which OpenAlgoChart allows.

### 7. Built-in indicators and BuySellButtons: no wrapper needed
- OpenAlgoChart already exposes `onReady(widget)`. `widget.chart` provides `addIndicator`, `addPrimitive`,
  `subscribeClick` and `setPriceScaleOptions`, so nothing in OpenAlgoChart had to change.
- On load: `ema {length: 20}`, `ema {length: 50}`, `rsi {length: 14}` (RSI gets its own pane), and `minMove: 0.05`.
- `topbar`, `indicators`, `rail`, `statusline` and `volume` are on. With `mobile: 'auto'` (the widget default), the
  phone gets the widget's compact layout: symbol header, a bottom bar with Draw / Indicators / Objects / Data /
  More, and an Indicators sheet with Running studies (Remove) and the catalog. Web smoke test showed `data-mobile="true"`.
- `BuySellButtons({ id: 'trade', position: 'top-left', margin: {x: 8, y: 64}, scale: 1 })`, as terminal.ts uses it,
  at scale 1 (terminal uses 0.72) for touch. `setMark(lastPrice)` on every tick, outside React.
  `subscribeClick` maps `trade:buy` / `trade:sell` to the native `onTrade({side, qty, price, symbol, exchange,
  tappedAt})`. `trade:qty` taps are ignored. The qty chip follows a `qty` prop (the last confirmed qty).

### 8. Order entry is native
- terminal.ts: with One-Click off, a Buy/Sell click opens the host's ticket (`onOrderTicket`); with it on, the click
  places the order. Mobile here always takes the ticket path: `OrderSheet.tsx` (RN `Modal`, slide) with side, symbol,
  qty stepper, MARKET/LIMIT with price, MIS/CNC/NRML, a large confirm with expo-haptics, then
  "Order placed (spike, not sent)". No network calls anywhere.
- The DOM never sees credentials and cannot place orders: it only calls an async native prop.
- **Real app:** native calls `placeorder` with the key from secure storage. A one-click mode would be a native
  setting, with the DOM still only emitting intents.

### 9. Expo DOM quirks the host must respect
- The native wrapper re-sends all props (`$$props`) on **every render** of the DOM element, because its
  `smartActions` object is new each render, and the DOM side re-renders its whole React tree. The chart host is
  therefore `memo`'d with stable `useCallback` props, and the header LTP lives in its own component. Without this,
  every RELIANCE tick on the native side would re-render the DOM tree.
- `useDOMImperativeHandle` methods must fit `DOMImperativeFactory` (`(...args: JSONValue[]) => void`), so
  `startPanBench` is typed `(durationMs: unknown) => void`. A method with a `number` parameter fails tsc.
- The DOM wrapper fills `ref.current` with a proxy only while it is `null` and never clears it. After a remount
  (key change), the ref would point at the old, dead WebView. `chart.tsx` sets `domRef.current = null` before
  remounting.
- `'use dom'` files may export only the default component plus `interface` / `type` declarations
  (`export type { X }` re-exports are rejected).

### Things that did not need changes
- `@/lib/chart/intervalRegistry`, `@/lib/trading/chartTheme`, `@/lib/utils`, `@/stores/themeStore`: bundled as-is.
- Package resolution from frontend files goes through the app's node_modules (metro.config.js), so openalgo-charts
  resolves to one module instance for both the frontend code and ChartDom.

### Typecheck caveat (not a runtime issue)
`npx tsc` reports TS2307 for packages imported by frontend files (`openalgo-charts`, `react`, `zustand`, `clsx`...),
because tsc resolves bare imports by walking up from `openalgo/frontend/src`, which has no node_modules. Metro is
not affected. The fix belongs in tsconfig.json (not owned here); see the result's needed_changes_elsewhere.

## Verified vs not verified
- Verified: `npx tsc` clean for the files above. `expo export --platform android` succeeds; the chart DOM page is
  `www.bundle/<md5>.html` plus one 2.33 MB JS (650 KB gzip) and 244 KB CSS, referenced from the Hermes bundle.
- Verified on desktop Chrome (exported DOM page with a stubbed `ReactNativeWebView` bridge, 393x620 at dpr 2.75,
  touch): chart paints 2,000 bars with EMA20/EMA50/RSI/volume, mobile layout on, the Indicators sheet opens,
  synthetic touch taps on BUY/SELL reach `onTrade`, the qty prop updates the chip, `startPanBench` reports through
  `onBenchDone` in both tick modes, and bridged props re-render the DOM root once per quote.
- **Not verified:** anything on a real Android device or WebView: the native screen, order sheet, haptics, keyboard
  behaviour in the sheet, touch accuracy of the canvas buttons, real frame rates, `performance.memory` on Android
  WebView. Desktop numbers say nothing about a budget phone.
