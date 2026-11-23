<!-- THROWAWAY SPIKE. Merged log of every change it took to run the OpenAlgo web frontend's code inside Expo DOM components (chart tab and tool tab), plus the integration fixes. -->

# What reusing the web frontend took

This file merges `app/CHANGES.chart.md` (Chart tab) and `app/CHANGES.tool.md` (Tool tab). Both source files are
kept and have more detail. It adds the changes made while integrating the spike. No file under
`openalgo/frontend/src` was edited.

Scope reminder. Phase 1 ships order entry, the books, holdings, realtime data, charts and **all `/tools` pages**. For
charts the scope is **charting, built-in indicators, and button-based trading** (the Chart tab). The Tool tab (the
Max Pain page) tests the `/tools` half: a whole web page running inside a DOM component, with its own network calls.

Effort column: rough guesses for the real app, made by reading the code. Nothing was estimated from a
working prototype. XS = under half a day, S = 1 to 2 days, M = 3 to 5 days, L = 1 to 2 weeks.

## Summary

| # | Change | Category | File(s) in the spike | Needed in real app? | Rough effort |
|---|---|---|---|---|---|
| 1 | Stand-in for `@/lib/trading/customIndicators` (its `import(/* @vite-ignore */ url)` fails the Metro build) | bundler/metro | `app/shims.chart.json`, `app/src/shims/chart/customIndicators.ts` | Yes, for user (custom) indicators. Built-ins are unaffected. | M |
| 2 | Copy of `frontend/src/index.css` without its two package `@import` lines (two copies, one per DOM component) | css/tailwind | `app/src/dom/chart/frontend-index.css`, `app/src/dom/tool/frontend-index.css`, `app/src/dom/tool/sync-frontend-css.mjs` | Only if the frontend stays a folder without its own node_modules. As a workspace package it can be imported as-is. | S |
| 3 | `tw-animate-css` not installed, so Radix open/close animations do nothing | css/tailwind | none | Yes: install it (cosmetic only) | XS |
| 4 | Tailwind scanning: `source(none)`, an explicit `@source` for the frontend, and `@source not` for `components/trading/TickBox.tsx` | css/tailwind | `app/src/dom/chart/chart.css`, `app/src/dom/tool/tool.css` | Yes, in some form. Scope scanning to the pages that ship. | XS |
| 5 | openalgo-charts' lazily loaded widget chunks imported eagerly (works around an Expo CLI DOM-export bug) | bundler/metro | `app/src/dom/chart/eagerChunks.ts` | Yes, until Expo fixes it. Needs updating on every openalgo-charts upgrade. | XS, plus upkeep |
| 6 | `import.meta.env` given a value before `@/api/client` loads | env/import.meta | `app/src/dom/tool/env.ts` | Yes. Better: `import.meta.env?.X` in 4 frontend files, or a build-time define. | XS |
| 7 | `fetch` and `XMLHttpRequest` replaced inside the WebView, answered by fixtures in the DOM or by a native action | transport/auth | `app/src/dom/tool/transport.ts`, `app/src/dom/tool/fixtures.ts`, `serveRequest` in `app/src/app/tool.tsx` | **Yes. The largest item.** A native request proxy holding the server URL and API key, plus a hook for the 401 redirect. | L |
| 8 | Chart `DataFeed` implemented inside the DOM (seeded history plus a tick simulator, or ticks bridged from native) | transport/auth | `app/src/dom/chart/spikeFeed.ts`, bridge in `app/src/app/chart.tsx` | Yes: history from the REST API through native, ticks from the native WebSocket, no API key in the DOM | M |
| 9 | Built-in indicators and the BuySellButtons panel attached through OpenAlgoChart's existing `onReady(widget)` | trading glue | `app/src/dom/ChartDom.tsx` | Yes (the same glue `terminal.ts` does on the web) | S |
| 10 | Native order ticket for BUY/SELL taps (never sends anything in the spike) | trading | `app/src/features/order/OrderSheet.tsx` | Yes, plus the real `placeorder` call with the key from secure storage | M |
| 11 | Slim provider shell: sonner `Toaster` used directly (the frontend's wrapper needs `next-themes`) | other | `app/src/dom/ToolDom.tsx` | Yes, a per-page provider shell. Other pages also need react-query or the market-data context. | S |
| 12 | Dark theme forced through the frontend's own `useThemeStore.setMode('dark')` | other | `app/src/dom/ChartDom.tsx`, `app/src/dom/ToolDom.tsx` | Yes: native passes the theme as a prop | XS |
| 13 | DOM host memoised with stable callbacks; `ref.current` reset before a remount | Expo DOM quirk | `app/src/app/chart.tsx`, `app/src/app/tool.tsx` | Yes (a pattern, not code) | XS |
| 14 | Chart WebView mounted on the first visit to the Chart tab, not at app start | Expo Router quirk (integration) | `app/src/app/chart.tsx` | Yes: NativeTabs mounts every tab at startup | XS |
| 15 | Hidden tabs stop subscribing to ticks (`QuotesPausedContext`) | native perf (integration) | `app/src/core/tickStore.ts`, Watchlist, Chain and Chart screens | Yes: NativeTabs never freezes hidden tabs | XS |
| 16 | Frontend modules loaded with `require()` in the Tool DOM component | spike layout | `app/src/dom/ToolDom.tsx` | No, with a workspace setup | none |
| 17 | tsc-only package paths; Metro owns the `~/` and `@/` aliases (`experiments.tsconfigPaths: false`) | spike layout (integration) | `app/tsconfig.json`, `app/metro.config.js`, `app/app.json` | No, with a workspace setup | none |
| 18 | Tree shaking left off: the Tool bundle carries all of lucide-react (1.48 MB of 3.68 MB) | bundler/metro | none (build env) | Yes for pages like `/tools`: enable tree shaking, or import icons one by one | S, plus regression checks |
| 19 | Phone layout fixes for the Max Pain page (not done) | layout | none (frontend `pages/MaxPain.tsx`) | Yes, if `/tools` pages ship on mobile | S |
| 20 | React Compiler also compiles the frontend files (the web build does not use it) | other | `app/app.json` (`experiments.reactCompiler`) | Be aware. Opt a file out with `'use no memo'` if it misbehaves. | XS |

What did **not** need changes:
- **Chart:** `@/components/chart/OpenAlgoChart` (525 lines), `@/lib/chart/intervalRegistry`, `@/lib/trading/chartTheme`,
  `@/lib/utils` and `@/stores/themeStore` run as shipped. So do openalgo-charts 2.7.3's widget (`mobile: 'auto'`
  compact layout), its built-in indicators tier and `BuySellButtons`.
- **Tool:** `pages/MaxPain.tsx` and its whole import closure (19 files, 2,216 lines: shadcn badge, button, card,
  command, dialog, popover and select; `lib/Plot2D` and `lib/plotly-2d`; `api/oi-tracker` and `api/client` (axios);
  `hooks/useSupportedExchanges`; the theme, broker and alert stores; `utils/toast`; `lib/serverSentence`) run as
  shipped. `app/shims.tool.json` is `{}`.

## Details

### 1. `@/lib/trading/customIndicators` stand-in
- **Why.** The real loader calls `import(/* @vite-ignore */ urlOf(mod))`. Metro rejects a non-literal `import()` at
  build time: `Invalid call at line 332: import(/* @vite-ignore */urlOf(mod))`. Inside the WebView there is also no
  OpenAlgo origin or session to fetch `/custom-indicators/index.json` from.
- **Spike.** `app/shims.chart.json` maps the module to `app/src/shims/chart/customIndicators.ts`, whose
  `loadCustomIndicators` and `ensureCustomIndicators` return `{ loaded: [], errors: [] }`.
- **Effect.** User indicators are not available. Built-ins work: OpenAlgoChart imports `openalgo-charts/indicators`
  itself. EMA 20, EMA 50 and RSI 14 are added on load, and the widget's Indicators sheet lists the rest.
- **Real app.** A loader that works in a WebView: fetch the module text with credentials (through native), then
  register it through a blob URL or `new Function`, or have the server precompile user modules.
- **Note.** `shims.*.json` files are global in `metro.config.js`, so this shim applies to every bundle.

### 2. The frontend's global stylesheet is copied, not imported
- **Why.** `frontend/src/index.css` starts with `@import "tailwindcss"` and `@import "tw-animate-css"`. Tailwind v4
  resolves CSS `@import` relative to the importing file, and `openalgo/frontend` has no node_modules:
  `Can't resolve 'tailwindcss' in '.../openalgo/frontend/src'`. Metro's resolver and `shims.*.json` do not apply to
  CSS `@import`.
- **Spike.** Each DOM stylesheet imports `tailwindcss` from the app, then a copy of `index.css` with those two
  lines removed. The tool copy is regenerated by `node src/dom/tool/sync-frontend-css.mjs`. The chart copy is
  `sed 1,2d index.css` plus a header. The two copies drift if `index.css` changes; regenerate both before a device run.
- **What depends on it.** `buildChartTheme()` reads the `.dark` tokens (`--background`, `--foreground`, `--primary`,
  `--muted-foreground`, `--border`), and the shadcn components use the Tailwind theme.
- **Risk.** The tokens are `oklch()`. Android System WebView older than Chromium 111 cannot parse them, and
  `chartTheme.ts` then falls back to `#000`. Not tested on an old WebView.
- **Real app.** Make the frontend a workspace package with its own node_modules (then `import '@/index.css'`
  works), or split the tokens into a file with no package imports.

### 3. `tw-animate-css`
Not installed in the app, because the spike may not add packages. Radix classes such as `animate-in`, `fade-in-0`
and `zoom-in-95` do nothing. This is cosmetic only.

### 4. Tailwind scanning (`source(none)`, `@source`, `@source not`)
- **Why.** Tailwind v4 auto-detects class names in the current working directory, which is `spike/app`. That picked
  up utility-like text from `CHANGES.*.md` and from native-only files. A comment in `components/trading/TickBox.tsx`
  also contains an arbitrary mask-url utility. Tailwind emitted it as a rule with `url("...")`, and Expo's CSS
  pipeline printed `Importing local resources in CSS is not supported yet` for both stylesheets. The builders' first
  fix, `@source not TickBox.tsx`, did not stop it, most likely because auto-detection also scanned the CHANGES
  files that quote the same text (not isolated further).
- **Spike (integration).** `@import "tailwindcss" source(none);` turns auto-detection off. Only
  `@source "<frontend>/src"` (and, for the tool, `@source "../ToolDom.tsx"`) is scanned, minus TickBox.tsx. The final
  export prints no CSS warning, and both stylesheets are about 244 KB (about 37 KB gzip).
- **Real app.** Scan only the pages and components that ship, which also shrinks the CSS.

### 5. openalgo-charts lazy chunks loaded eagerly
- **Why.** `expo export --platform android` failed with `Error: Asset not found:
  _expo/static/js/web/__common-<hash>.js`. Expo CLI's `exportDomComponentAsync` renames DOM chunk files to md5 names
  but leaves the old names in each chunk's `metadata.requires`. The widget lazy-loads 8 dialog modules, two of them
  share `grid-bar`, and that shared code becomes a `__common` chunk. This is an Expo CLI bug, not an openalgo-charts
  or frontend bug.
- **Spike.** `app/src/dom/chart/eagerChunks.ts` imports `openalgo-charts/indicators` and the 8 hashed
  `openalgo-charts.widget.*-<hash>.mjs` files statically, by relative path, because they are not in the package's
  `exports`. The chart DOM bundle is then one JS file with no `import(` calls. This costs about 63 KB more parsed at
  open. The hashes are pinned to openalgo-charts 2.7.3.
- **Alternative, not tried.** `EXPO_NO_BUNDLE_SPLITTING=1` in the build environment.
- **Real app.** Needed until Expo fixes it. Worth an upstream issue.

### 6. `import.meta.env`
- **Why.** babel-preset-expo rewrites `import.meta` to `globalThis.__ExpoImportMetaRegistry`, which only has `url`.
  `api/client.ts` reads `import.meta.env.VITE_API_URL` while it loads, so it would throw before anything renders.
- **Spike.** `app/src/dom/tool/env.ts` runs first and sets `__ExpoImportMetaRegistry.env = { VITE_API_URL: '',
  MODE: 'production', DEV: false, PROD: true, ... }`. This depends on an Expo-internal global name.
- **Real app.** `import.meta.env?.VITE_API_URL` in `api/client.ts`, `lib/agent/stream.ts` and `lib/agent/voice.ts`,
  plus the `import.meta.env.DEV` check in `utils/errorReporter.ts`, or a build-time define.

### 7. Network transport (the largest item)
- **Why.** Release DOM components load from `file://`, so every relative URL the frontend uses
  (`/search/api/...`, `/auth/csrf-token`, `/oitracker/api/maxpain`) resolves to `file:///...`. The frontend assumes
  it shares an origin with the Flask server. It has 116 relative `fetch('/...')` calls in 37 files, 3 axios instances
  with base URL `''`, session cookies plus CSRF, and `window.location.href = '/login'` on 401, which in a WebView
  navigates to a blank `file:///login`.
- **Spike.** `app/src/dom/tool/transport.ts` replaces `window.XMLHttpRequest` (used by axios) and `window.fetch`
  (used for the CSRF token). The page's axios client, its CSRF interceptor and its stores run unchanged; only the
  wire is swapped. Answers come from `fixtures.ts`, either inside the DOM or, in "via native bridge" mode, through
  the async native action `serveRequest`. The fixtures' max-pain numbers use the backend's own formula.
- **Real app.** Keep this hook and forward each request to native over the DOM bridge. Native holds the server URL
  and the API key or session and calls OpenAlgo. That avoids CORS and cookies in the WebView, and works with
  plain-HTTP LAN servers. The alternative, pointing `VITE_API_URL` at the server, needs CORS with credentials from
  origin `null` and `SameSite=None; Secure` cookies, so HTTPS on every self-hosted server. The 401 redirect needs a
  hook into native navigation. "via native bridge" mode measures the per-request bridge cost on the phone.

### 8. Chart data feed
- OpenAlgoChart accepts any `DataFeed` (`getBars` plus an optional `subscribeBars`), so `spikeFeed.ts` is a plain class.
  It serves 2,000 seeded 5-minute bars (1m, 15m and 1h on demand), with no NSE session gaps. The last close is the
  native RELIANCE quote at mount.
- Live updates come in one of two ways. In-DOM, the feed simulates 5 ticks per second. Via bridge, native polls its
  own tick store at 4 Hz and passes `{ ltp, seq, sentAt }` as a prop; each bridged quote re-renders the DOM root once.
  The sim clock runs 30 times faster than real time, so a 5-minute candle rolls every 10 s.
- **Real app.** History from `/api/v1/history` through native, and ticks from the native WebSocket bridged in. The API
  key must never live in the DOM.

### 9. Built-in indicators and BuySellButtons: no wrapper needed
- OpenAlgoChart already passes the widget out through `onReady(widget)`. `widget.chart` has `addIndicator`,
  `addPrimitive`, `subscribeClick` and `setPriceScaleOptions`, so OpenAlgoChart did not change.
- On load: `ema {length: 20}`, `ema {length: 50}`, `rsi {length: 14}` (RSI gets its own pane), price step 0.05.
  `topbar`, `indicators`, `rail`, `statusline` and `volume` are on. With `mobile: 'auto'` the phone gets the widget's
  compact layout: a bottom bar with Draw, Indicators, Objects, Data and More.
- `BuySellButtons` (SELL | qty | BUY) sits top-left on pane 0 at scale 1 (the terminal uses 0.72) for touch. Its mark
  follows every tick outside React. A BUY or SELL tap calls the async native prop `onTrade`. A tap on the qty chip
  does nothing.

### 10. Native order ticket
- `OrderSheet.tsx` is a React Native `Modal` with side, symbol, the chart price at the tap, a qty stepper, MARKET or
  LIMIT with a price field, MIS, CNC or NRML, and a large confirm button with haptics. Confirm shows
  "Order placed (spike, not sent)". There are no network calls anywhere.
- The DOM never sees credentials and cannot place an order: it only calls the native prop.
- **Real app.** Native calls `placeorder` with the key from secure storage. A one-click mode would be a native setting,
  with the DOM still only emitting intents.

### 11. Provider shell
`showToast` needs a mounted Toaster. The frontend's `components/ui/sonner.tsx` imports `next-themes`, which is not
installed, so `ToolDom.tsx` renders sonner's `Toaster` with the props `app/providers.tsx` passes. Max Pain needed
nothing else. Other pages do: 26 of 97 use react-query and 7 use the market-data context. `MarketDataProvider` opens a
socket.io connection, so one would open per WebView. Feeding ticks in from native is probably better.

### 12. Theme
Both DOM components call the frontend's own `useThemeStore.getState().setMode('dark')` before rendering. The store
persists to the WebView's localStorage, which is separate from native storage. In the real app, native owns the
theme and passes it as a prop. OpenAlgoChart re-applies theme changes without a rebuild.

### 13. Expo DOM host rules
- The native wrapper re-sends every prop on **every render** of the DOM element, because its `smartActions` object is
  new each time. The DOM side then re-renders its whole React tree. So the chart host is `memo`'d with stable
  `useCallback` props, and the header LTP is its own component. Without this, every native tick would re-render the
  chart's React tree.
- The wrapper fills `ref.current` with a proxy only while it is `null` and never clears it. `chart.tsx` sets
  `domRef.current = null` before a remount, or the ref would point at the old, dead WebView.
- `useDOMImperativeHandle` methods must fit `(...args: JSONValue[]) => void`, so `startPanBench` takes `unknown`.
- A `'use dom'` file may export only its default component plus `interface` and `type` declarations.

### 14. Chart WebView mounted on the first visit (integration)
- **Why.** expo-router's NativeTabs preloads every tab (`lazyByDefault: false`), and react-native-screens never
  freezes hidden tabs, so all five screens mount at app start (found by reading their code, not observed on a
  device). Before this change, the chart WebView would have loaded its 2.3 MB bundle during app startup, its
  "first open" would have been measured in the background, and it would have stayed alive behind every native bench.
- **Spike.** `chart.tsx` renders the DOM host only once the Chart tab has been focused. `chart:open` with
  `kind: 'first-mount'` now means "the user opened the Chart tab". Each result records `settings.domMounted`, the
  WebViews that were alive during the run.

### 15. Hidden tabs stop subscribing to ticks (integration)
- **Why.** For the same reason, a hidden Watchlist (100 rows) or Chain (80 option cells) kept re-rendering on every
  tick, and that work landed in whichever bench was running on the visible tab.
- **Spike.** `useQuote` reads `QuotesPausedContext`. The Watchlist, Chain and Chart screens provide
  `value={!focused}`. A paused row has no subscription. When the tab is shown again, React re-subscribes and
  the row catches up at once. Results record `settings.hiddenTabsPaused: true`.

### 16 and 17. Typecheck layout (spike only)
- `ToolDom.tsx` loads the frontend with `require()`, so tsc does not pull the Max Pain closure into the app's program.
  It also guarantees those modules load after `env.ts` and the transport. A scratch config showed the closure
  typechecks cleanly in strict mode against the app's package versions.
- `ChartDom.tsx` uses plain `import`, so tsc checks 6 frontend files. tsc looked for their packages by walking up from
  `openalgo/frontend/src`, which has no node_modules, and reported 30 errors. The integration added tsc-only `paths`
  entries in `app/tsconfig.json` that map `openalgo-charts`, `react`, `zustand`, `clsx` and `tailwind-merge` to the
  same `.d.ts` files the app resolves. Those 6 files now typecheck in strict mode with 0 errors.
- Expo's Metro also applies tsconfig `paths` by default, and it must never resolve a `.d.ts` file as a runtime module.
  So `app/app.json` sets `experiments.tsconfigPaths: false`, and `app/metro.config.js` now implements `~/` as well
  as `@/`. The chart and tool DOM JS bundles came out byte-identical to the pre-change export (same content hashes).

### 18. Bundle size and tree shaking (measured, not changed)
- The bundles are plain JavaScript compiled by the WebView, not Hermes bytecode. The final export:

  | Bundle | Size | gzip |
  |---|---|---|
  | Native Hermes bytecode (`entry-*.hbc`) | 4.34 MB | 1.80 MB |
  | Chart DOM JS | 2.33 MB | 650 KB |
  | Chart DOM CSS | 244 KB | 37 KB |
  | Tool DOM JS | 3.68 MB | 802 KB |
  | Tool DOM CSS (Tailwind + maplibre-gl) | 244 KB + 65 KB | 37 KB + 9 KB |

- The Tool bundle includes all of lucide-react (1,480 KB) for 2 icons, plus plotly.js (874 KB). maplibre-gl's CSS
  comes from a static `require` inside a branch of plotly's `src/registry.js`. The chart bundle has no lucide-react and
  no plotly; it is mostly openalgo-charts.
- One export with `EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 EXPO_UNSTABLE_TREE_SHAKING=1` cut the Tool bundle to
  1.90 MB. In a desktop harness, time to plot fell from 622 to 401 ms (one run each). **Tree shaking is not enabled
  in this spike.** It is experimental, its effect on the Hermes bundle is untested, and it does not change the chart
  bundle, which is the one in scope. Tool open times on the phone are therefore pessimistic.

### 19. Max Pain on a phone (found in a 390 px harness, not fixed)
The header row does not wrap (the page is 494 px wide and Refresh is off-screen). The chart height is fixed at 500
px. Plotly's `touchstart` `preventDefault` turns a vertical swipe over the chart into a box-zoom (read in the code,
not tried on a device). Values show only in hover labels. The modebar covers the annotation. The underlying picker
focuses its search input, so the keyboard opens at once. Each is a small CSS or Plotly-config fix in the shared page,
and would also help the web app on phones.

### 20. React Compiler
`experiments.reactCompiler` also compiles frontend files, because they are not under node_modules. The web build
does not use the compiler. Nothing misbehaved in the desktop harnesses. A few spike components are skipped by the
compiler (ChartDom, ChartHost, ChartScreen, UiFpsProbe) because they write refs or shared values during render. They
run as plain React, which is correct, just not auto-memoised.

## What reusing the web frontend in Expo DOM components actually took

- **The rendering code was reusable as-is.** OpenAlgoChart, the openalgo-charts widget with its mobile layout, the
  built-in indicators and BuySellButtons all ran without edits or wrappers. The same was true of a whole `/tools`
  page with shadcn, Radix, cmdk, axios, zustand and Plotly. On the chart side, reuse took one module shim (custom
  indicators), one copied stylesheet, one bundler workaround (eager chunks) and Tailwind source settings.
- **The integration code is the real work, and it is new code, not reuse.** For the requested scope that means:
  - a data path: history through native, ticks bridged from the native WebSocket
  - an order path: a native ticket and `placeorder`, with the DOM only emitting BUY or SELL intents
  - a DOM host that is memoised and mounted lazily
  For whole web pages it also means a request proxy, because the frontend assumes the same origin as Flask (116
  relative fetches, cookies plus CSRF, and a `/login` redirect). That proxy is the biggest single item.
- **Build friction was real but small:** a Metro-incompatible dynamic import, Tailwind resolving CSS imports from a
  folder without node_modules, an Expo CLI chunk-naming bug, and Expo's `import.meta` rewrite. Each has a workaround
  of a few lines, logged above. Most of them disappear if the frontend becomes a workspace package with its own
  node_modules.
- **The open question is speed, and only the phone can answer it.** The DOM bundles are 2.3 MB (chart) and 3.7 MB
  (tool) of plain JavaScript, parsed by Android System WebView on every open. Every timing so far comes from desktop
  Chrome and says nothing about a budget phone. The `chart:open` and `chart:pan:*` results from the device decide
  whether this path is viable.
- **Nothing here has run on an Android device or emulator yet.** That includes the native screens, the WebView bridge,
  the order sheet, touch handling on the chart canvas, and the frame probes.
