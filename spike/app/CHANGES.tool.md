// THROWAWAY SPIKE. Evidence for the reuse decision: what it took to run the web frontend's Max Pain page (/tools) inside an Expo DOM component.

# Tool tab: reusing a web `/tools` page in an Expo DOM component

## Result in one paragraph

`frontend/src/pages/MaxPain.tsx` and its whole import closure (19 files, 2,216 LOC:
shadcn badge/button/card/command/dialog/popover/select, lib/Plot2D + plotly-2d,
api/oi-tracker -> api/client (axios), hooks/useSupportedExchanges, stores
theme/broker/alert, utils/toast (sonner), lib/serverSentence) runs **unchanged**:
no frontend file edited, **zero module shims** (`shims.tool.json` is `{}`). The
page made its 4 real requests, rendered 41 Plotly bars, and its Select, Popover/cmdk
and toast all worked in a 390 px mobile-emulated harness. What it took is in the
table below. Two items are real work for a production app: the network/auth
transport (#2) and the bundle size (#6). The layout also needs phone fixes (see
"Phone usability"). On device the results JSON is the only evidence. Every
number in this file comes from desktop Chrome.

Scope note: the user's stated scope for the app is "only charting, builtin
indicators, trading feature with button based trading". Max Pain is not in that
scope. This tab is evidence about the *mechanism* (a web page inside a DOM
component with the shared transport, CSS and providers). A reused chart or order
panel would go through the same mechanism. It is not a proposal to ship /tools.

## Files

| File | Role |
|---|---|
| `src/app/tool.tsx` | Native screen. "Open Max Pain" unmounts any previous instance, then mounts a fresh DOM component (new WebView). It times press -> DOM `onReady`, records `tool:maxpain-open`, and has a Close button and toggles for fixture mode and latency. |
| `src/dom/ToolDom.tsx` | The `'use dom'` component. Renders `@/pages/MaxPain` unchanged inside a Toaster plus the web Layout's `<main>` padding. Forces dark theme, detects the drawn Plotly bars, and reports timings and heap. |
| `src/dom/tool/env.ts` | Gives `import.meta.env` a value (change #1). |
| `src/dom/tool/transport.ts` | Replaces fetch/XHR in the WebView (change #2). |
| `src/dom/tool/fixtures.ts` | The fake backend (NIFTY, 3 expiries, 41 strikes, the backend's max-pain formula). Shared by the DOM and the native side. |
| `src/dom/tool/tool.css`, `frontend-index.css`, `sync-frontend-css.mjs` | Styling (change #5). `frontend-index.css` is GENERATED from `frontend/src/index.css`. |
| `src/dom/tool/css.d.ts` | `declare module '*.css'` for tsc (expo-env.d.ts is not generated in this checkout). |

## Changes the reuse needed

| # | Category | What the spike does | Why it was needed | Real app needs it? |
|---|---|---|---|---|
| 1 | env/import.meta | `tool/env.ts` runs first in the DOM bundle and sets `globalThis.__ExpoImportMetaRegistry.env = { VITE_API_URL: '', MODE: 'production', DEV: false, PROD: true, ... }`. | babel-preset-expo rewrites every `import.meta` to `globalThis.__ExpoImportMetaRegistry`, and that object has only `url`. `api/client.ts` line 3 (`import.meta.env.VITE_API_URL`) would throw while the module first loads, before anything renders. Expo's runtime had already installed the registry (`importMetaRegistryPreexisting: true` in the harness). | **Yes, some form of it.** This prelude depends on an Expo-internal global name. Sturdier options: (a) a one-character frontend change, `import.meta.env?.VITE_API_URL`, in `api/client.ts`, `lib/agent/stream.ts` and `lib/agent/voice.ts`, plus `utils/errorReporter.ts` (`import.meta.env.DEV`); (b) a build-time define. zustand's middleware already guards `import.meta.env?.MODE`. |
| 2 | transport/auth | `tool/transport.ts` swaps `window.XMLHttpRequest` (axios' xhr adapter) and `window.fetch` (the CSRF fetch in `api/client.ts`) for a responder. Absolute http(s) URLs pass through to the real network. The responder is either in-DOM fixtures or, in "via native bridge" mode, an async native action (`serveRequest`) answered by the RN side. | Release DOM components are served from `file://`, so every relative URL the frontend uses resolves to `file:///search/api/...`. The spike also has no server. The page's requests, in order: `GET /search/api/underlyings` and `GET /search/api/expiries` in parallel, then `GET /auth/csrf-token` (fetch), then `POST /oitracker/api/maxpain` (XHR). | **Yes. This is the biggest item.** The frontend assumes it shares an origin with the Flask server: 116 relative `fetch('/...')` calls in 37 files, 3 axios instances with base URL `''`, session cookies plus CSRF, and `window.location.href = '/login'` on 401 (in a WebView that navigates to `file:///login`, a blank page). Recommended: keep this transport hook and forward each request to the native side over the DOM bridge. Native holds the server URL and session/API key and calls OpenAlgo (no CORS, no cookies in the WebView, works over plain-HTTP LAN servers). The alternative (point `VITE_API_URL` at the server) needs CORS with credentials from origin `null` plus `SameSite=None; Secure` cookies, which means HTTPS on every self-hosted box. The 401 redirect also needs a hook to native navigation. "via native bridge" mode measures the per-request bridge cost on device. Not wired to a real server in the spike. |
| 3 | providers | Wraps the page in sonner's `<Toaster theme="dark" richColors closeButton position/visibleToasts/duration from alertStore>`, the same props `app/providers.tsx` passes. | `showToast.error` needs a mounted Toaster. The frontend's own `components/ui/sonner.tsx` imports `next-themes`, which is not installed in the app, so sonner's Toaster is used directly. Max Pain did not need `QueryClientProvider`, `MarketDataProvider`, router context or `next-themes`. | **Yes, a slim per-page provider shell.** Other pages need more: 26 of 97 pages use react-query and 7 use the market-data context. `MarketDataProvider` opens a socket.io connection, so one would open per WebView. That needs a design decision (probably feed ticks in from native as props/events instead). |
| 4 | theme | `useThemeStore.getState().setMode('dark')` plus the `dark` class on `<html>`. This is the store's own API and it persists to the WebView's localStorage. | The store defaults to light, and Plotly colours are chosen from `mode`. | Yes, trivially: pass the theme from native as a prop. Note that the WebView's localStorage is separate from native storage. |
| 5 | css/tailwind | `tool.css` = `@import "tailwindcss"` (from the app's node_modules) + `@import "./frontend-index.css"` + `@source "<frontend>/src"`. `frontend-index.css` is a byte-for-byte copy of `frontend/src/index.css` minus its two package `@import` lines (regenerate with `node src/dom/tool/sync-frontend-css.mjs`). | Importing `index.css` directly fails. Tailwind resolves its `@import "tailwindcss"` and `@import "tw-animate-css"` relative to `frontend/src`, which has no node_modules (verified: `Can't resolve 'tailwindcss' in '.../openalgo/frontend/src'`). `tw-animate-css` is not installed in the app at all, so Radix open/close animations (`animate-in`, `fade-in-0`, `zoom-in-95`) are no-ops (cosmetic). | **No code change** if the frontend is a workspace package with its own resolvable node_modules (npm workspaces/monorepo) and `tw-animate-css` is installed. Then `import '@/index.css'` works as-is. Output: 245 KB CSS (37 KB gzip), because `@source` scans all of frontend/src. Scoping `@source` to the shipped pages would shrink it. A harmless Metro warning, "Importing local resources in CSS is not supported yet", comes from Tailwind generating `[mask:url(...)]` out of a comment in `components/trading/TickBox.tsx`. |
| 6 | bundler/metro | Nothing changed (the config is not mine). Measured only. | The DOM bundle is **3.68 MB of plain JS** (not Hermes bytecode; 802 KB gzip) plus 245 KB + 65 KB CSS. By source map: lucide-react 1,480 KB (the whole icon set, because Metro does not tree-shake by default and MaxPain imports only 2 icons), plotly.js 874 KB, react-dom 203 KB, @plotly/d3 104 KB, axios 68 KB, frontend code 48 KB. The 65 KB CSS file is maplibre-gl's: plotly `src/registry.js` has a static `require('maplibre-gl/dist/maplibre-gl.css')` inside an `if (map)` branch, and Metro bundles it anyway. | **Yes, enable tree shaking for production exports.** One export run with `EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 EXPO_UNSTABLE_TREE_SHAKING=1` (env only, no file change) gave a ToolDom bundle of 1.90 MB (590 KB gzip). In the desktop harness below, time to plot dropped from 622 to 401 ms and long tasks from 449 to 246 ms (one run each; directional only). Worth measuring on the phone. |
| 7 | typecheck (spike layout) | `ToolDom.tsx` loads the frontend modules with `require()` instead of `import`. | The app's `tsc` cannot resolve react/axios/radix types from `frontend/src` (no node_modules there), so any `import '@/...'` drags hundreds of resolution errors into everyone's typecheck (ChartDom's imports show exactly this). `require()` also pins evaluation order after env.ts and the transport. Separately checked: the MaxPain closure **typechecks cleanly in strict mode** against the app's package versions (React 19.3 types, axios 1.20, radix, @types/plotly.js). That used a scratch tsconfig mapping packages to the app's node_modules plus a 2-line `ImportMeta.env` declaration. | No, with a workspace setup. Then plain `import` works and tsc covers frontend files. |
| 8 | other: React Compiler | Nothing. | `experiments.reactCompiler` also compiles the frontend files, because they are not under node_modules. The web build does not use the compiler. MaxPain behaved correctly compiled in the harness. | Be aware. Opt out with `'use no memo'` if a page misbehaves. |
| 9 | other: layout shell | The wrapper mirrors the web Layout's `<main className="container mx-auto px-4 ...">`. Navbar, Footer and MobileBottomNav are not reused. | The page assumes the Layout supplies its horizontal padding. | Yes, trivial. |

Not needed: babel.config.js, any `shims.tool.json` entry, routing context, any
change to MaxPain or its closure.

## Phone usability (rendered at 390x844, re-measured at 360 and 412)

Rendered in the harness described below. Screenshots are in the session
scratchpad: `tool-390-initial.png`, `tool-390-fullpage.png`,
`tool-390-underlying-popover.png`, `tool-390-exchange-select.png`.

1. **The header row overflows and the page scrolls sideways.** The
   `flex items-center gap-3` row with `w-[100px]` + `w-[160px]` + `w-[160px]`
   selectors + Refresh does not wrap, so the document is 494 px wide. That is
   104 px of horizontal scroll at 390, 134 px at 360 and 82 px at 412. At 390 the
   Refresh button is entirely off-screen (x 417-494) and the expiry select is
   cut. Expo's DOM template sets `user-scalable=no`, so the user cannot pinch
   out either.
2. **The chart has a fixed 500 px height** (566 px card) and sits below the title,
   the controls and 7 badges that wrap into 4 rows. Most of the chart is below
   the fold on an 844 px screen. The single-series legend wastes about 40 px.
   41 bars share a 340 px plot width, and 21 x labels at -45 degrees are crowded.
3. **Swipes on the chart zoom instead of scrolling.** Plotly's drag layer
   registers `touchstart` with `passive: false` and calls `preventDefault()`
   whenever dragmode is set (`plotly.js/src/components/dragelement/index.js`
   ~line 156; the page uses dragmode 'zoom'). A vertical swipe that starts on
   the chart box-zooms instead of scrolling, and the chart is most of the
   screen. Found by reading the code, not verified on a device.
4. **Values are hover-only.** Per-strike values appear only in the hover label.
   Plotly turns a tap into hover on touch; not verified on a device.
5. **The modebar overlaps the annotation.** The always-visible modebar (5
   buttons with roughly 22x24 px tap targets) covers the "Max Pain 24000"
   annotation at the top of the plot.
6. **The keyboard opens with the underlying picker.** Opening the underlying
   combobox focuses the cmdk search input (verified in the harness), so on a
   phone the soft keyboard pops up immediately over the list. The popover itself
   (w-48) fits and selecting BANKNIFTY refetched and redrew correctly.
7. **What worked on tap:** the Radix Select (exchange) opens over its trigger
   and is usable. The error toast showed (verified by forcing a 500 on
   `/oitracker/api/maxpain`), top-right by default.

Verdict on layout: the page *works* on a phone but is clearly desktop-shaped.
Each issue is a small CSS/Plotly-config fix in the shared page (`flex-wrap`,
responsive chart height, `dragmode: false` or `staticPlot` on touch,
`displayModeBar: false`), not a reuse blocker. Those fixes would also improve
the web app's own mobile layout.

## Desktop harness numbers (NOT phone numbers)

Harness: a `file://` HTML page that copies Expo's DOM component HTML and stubs
`window.ReactNativeWebView`, loading the exported DOM bundle and CSS. It ran in
Chrome via DevTools with a 390x844 DPR 3 mobile/touch viewport and 4x CPU
throttling, on an Apple Silicon Mac. Fixtures were served in-DOM with 0 ms
latency.

| Bundle | time to plot (ms since page start) | first React commit | long tasks (count / total / max) | JS heap |
|---|---|---|---|---|
| dev-server prod bundle, first load | 991 | 521 | 2 / 509 / 355 ms | 20.7 MB |
| same, reload | 572 | 410 | 2 / 425 / 309 ms | 20.7 MB |
| exported bundle (what ships), 3.68 MB | 622 | 446 | 2 / 449 / 327 ms | 20.7 MB |
| exported with tree shaking, 1.90 MB | 401 | 234 | 2 / 246 / 134 ms | 20.7 MB |

The identical 20.7 MB heap shows Chrome quantizes `performance.memory`. It is
JS heap only, not WebView process memory. A budget Android phone will be
several times slower than a throttled M-series Mac, so only the device JSON
counts.

## Reading the device result (`tool:maxpain-open`)

- `metrics.openMs`: press (after the previous WebView is unmounted) -> the DOM
  reports bars painted (bars found by MutationObserver, then 2 animation frames).
  The first open in a process (`settings.openIndexThisProcess: 1`) also pays for
  WebView/Chromium start-up. Open it several times.
- `metrics.nativeCommitMs`: press -> React commit of the native DOM-component
  host view.
- `metrics.dom.marks`: WebView-side timeline (0 = WebView navigation start).
  `moduleEvalMs` = runtime and React evaluated, before the frontend and Plotly
  load. `firstCommitMs`, `maxPainResponseMs` and `plotMs` follow.
- `metrics.dom.wire`: every request the page made, with time and status.
- `metrics.memoryMb`: WebView `performance.memory.usedJSHeapSize` (JS heap only,
  quantized). It is null if the WebView does not expose it. For real memory use
  `adb shell dumpsys meminfo in.openalgo.spike` (sandboxed_process / webview
  renderer).
- Pass rule: `openMs <= 2500` and (`memoryMb == null` or `<= 250`). **Backend time
  is not included.** The real `/oitracker/api/maxpain` fetches the option chain
  from the broker first, which can take seconds on its own. Toggle "150 ms" to
  add per-request latency (3 sequential round trips on the critical path).
