# OpenAlgo Mobile, Phase 1: Design

**Status:** approved by the product owner · **Date:** 2026-11-23
**Repos touched:** `openalgo-mobile` (the app), `openalgo` (server and web frontend), `openalgo-docs`

Code references are `path:line`. `openalgo/` means the server repo at commit `c8b2896`, and `frontend/` means `openalgo/frontend/src`.

---

## 1. Intent

OpenAlgo users trade from their own self-hosted OpenAlgo server. The current mobile app is a basic Flutter client. It was built without CI and stored the API key in plain text. It polled prices over HTTP, and its chart was a "Coming Soon" placeholder. The product owner wants a complete rebuild:

- A **modern, robust UI** that a trader would choose over the mobile web page.
- **Android and iOS built automatically** in CI.
- **Robust security**, plus a codebase that is **modular, hygienic and easy to maintain**.
- In phase 1, users can do on the phone what they do in the web app:
  - place orders
  - monitor the books and holdings
  - chart with built-in indicators and button-based trading
  - watch real-time market data
  - use **all the /tools features**

A spike (`spike/` in this repo, now on `main`) showed that the web frontend's chart and a full /tools page run unchanged inside Expo DOM components. That is the basis for reusing the web code rather than rewriting it.

## 2. Goals, non-goals, anti-goals

**Goals (phase 1)**
1. **One codebase** for Android and iOS: React Native + Expo.
2. **Sign-in that never puts the user's API key on the phone.** The phone gets a per-device token that the user can revoke.
3. **Trading:**
   - place, modify and cancel orders one at a time;
   - in bulk: Cancel all and Close all, plus the multi-leg basket orders that Strategy Builder and Arbitrage place (section 7.8);
   - order book, trade book, positions (including close one and close all), holdings and funds;
   - Action Center approvals: approve or reject orders that Semi-Auto mode has queued.
4. **Market data:**
   - server-side watchlists with live prices over the WebSocket;
   - symbol search;
   - quote and 5-level market depth.
5. **Chart:** the web chart with built-in indicators and on-chart BUY/SELL buttons that open a native order ticket.
6. **Tools:** all 20 pages in the web `/tools` registry (`frontend/lib/tools.ts`).
7. **Safety and parity with the old app:**
   - an always-visible LIVE/ANALYZE badge and the analyzer toggle;
   - an app lock;
   - a server-compatibility check.
8. **CI:**
   - lint, typecheck, tests, bundle budgets and security scans;
   - Android and iOS builds on every PR;
   - signed release builds once signing secrets exist.

**Non-goals (phase 1)**
- Push notifications.
- Over-the-air JS updates.
- Offline trading.
- A Flutter or web build of the app. The web frontend already serves browsers.
- Web pages outside `/tools`: Scalping, Historify, Flow, strategies and admin.
- Public Play Store and App Store listings. They come after phase 1; phase 1 ships through GitHub Releases and TestFlight.
- Plain-http servers, including home-network addresses. Phase 1 is https only.
- GTT orders. The plan is to show them read-only at most, if time allows.

**Anti-goals (this would count as a failure even if it "works")**
- The raw API key reaches the phone, or any web content inside the app.
- An order is sent twice because of an automatic retry.
- The app keeps a second, forked copy of the web tools that drifts from the web.
- A web page inside the app can make arbitrary network calls, or can call native code beyond a fixed, typed set of functions.
- Status documents that claim more than is true. The old repo has about 30 "Production Ready" summaries while its charts said "Coming Soon". Here, docs describe what exists.

## 3. Decisions already made by the product owner

| Decision | When |
|---|---|
| React Native + Expo, not Flutter, PWA or Capacitor. Picked after a scored comparison of the options; the spike followed | Earlier in this effort |
| The chart uses the OpenAlgo `/trading` feature, limited to **charting, built-in indicators and button-based trading** | Same |
| Phase 1 scope as in goals 3–6; no push notifications | Same |
| `main` of `openalgo-mobile` replaced by the spike. The Flutter app is preserved on `backup/flutter-main-2026-11-23`. CI builds the APK, an unsigned IPA and a simulator app | 2026-11-23 |
| "We can build the actual app" | 2026-11-23 |
| **Approach A** for auth (section 4.2) | 2026-11-23 |
| **Distribution:** Android APK from GitHub Releases, iPhone through TestFlight; store listings after phase 1 | 2026-11-23 |
| **https only:** the app connects only to servers reached over https (ngrok or a domain) | 2026-11-23 |
| **Action Center approvals** are in phase 1 | 2026-11-23 |
| **The product owner runs the M0 phone test** with the spike APK; chart and tools work waits for the results | 2026-11-23 |

## 4. Approaches

### 4.1 Stack (decided)

| Option | Trade-off | Outcome |
|---|---|---|
| Flutter (stay) | Reuses 0% of the web code; ranked last on 3 of 4 criteria | Rejected |
| React web as a PWA or Capacitor shell | Highest code reuse. Weaker native feel and store story; WebView-only performance | Close runner-up |
| **React Native + Expo** | Native lists, navigation and gestures. Web chart and tools reused through Expo DOM components | **Chosen** |

### 4.2 Server and auth (decided: A)

| Option | Trade-off | Outcome |
|---|---|---|
| **A. Update the server alongside the app** | The app signs in through the server's existing OAuth 2.1 server and holds a revocable token. The server accepts that token where the app needs it, and serves the WebSocket on the main port. Users must upgrade the server | **Chosen**: every tool works, it's safer, and the owner maintains both repos |
| B. Work with today's servers | The API key is stored on the phone, and only `/api/v1` is usable. Watchlists and 14 of the 20 tools would need native rewrites or would wait | Rejected |

### 4.3 How each screen is built (my call, backed by the research)

Each screen falls into one of three categories:
- **Native:** rebuilt in React Native.
- **DOM unchanged:** the web page runs as-is inside an Expo DOM component.
- **DOM with adapter:** the web page runs inside a DOM component with small, listed changes.

The rule:
- Rebuild natively anything that is a list, a form or scrolls under live data.
- Reuse the web code wherever a canvas or Plotly page renders a computed view.

The core trading screens send the API key in the request body, or use the session and CSRF token. They are also list-and-form heavy. So they are native, and the old app's and spike's screens are the seeds. Details are in section 7.3.

## 5. Constraints found in the code

These facts shape the design. Each was checked in code; the reports are in this session's research notes.

1. **OAuth today is MCP-only.**
   - `verify_access_token` is called only from `blueprints/mcp_http.py` (336, 706, 1035).
   - The blueprints load only with `MCP_HTTP_ENABLED` and an https `MCP_PUBLIC_URL`, and never with FLASK_DEBUG (`app.py:366-407`).
   - The audience is `<MCP_PUBLIC_URL>/mcp` (`utils/oauth_tokens.py:71-77`).
2. **OAuth gaps a phone client would hit:**
   - Custom-scheme redirect URIs are rejected (`mcp_oauth.py:151-177`).
   - A refreshed token loses its user (`user_id=0`, `mcp_oauth.py:999`); refresh rows have no user column (`database/oauth_db.py:112-144`).
   - Refresh does a newest-first Argon2 scan of every row of the client, revoked rows included, and nothing is purged. With one shared client this is slow, and it is a CPU-exhaustion vector for unknown tokens (`oauth_tokens.py:190-207`).
   - Revoke removes one row, not the token family (`oauth_tokens.py:270-292`).
   - `/oauth/authorize` requires a completed *broker* login (`@check_session_validity`, 665). Login has no return-to (`auth.py`, `Login.tsx`).
   - The consent page's CSP `form-action` would block a custom-scheme redirect (`mcp_oauth.py:425-458, 646-661`; `csp.py:95`).
3. **Session-only routes the app needs.** These use `@check_session_validity`, global CSRF, and a cookie:
   - watchlists (`blueprints/watchlist.py:65-164`)
   - search (`search.py:133, 227, 248`)
   - 13 tool blueprints plus `strategy_portfolio`
   - order actions `/modify_order`, `/cancel_order`, `/close_position`, `/close_all_positions`, `/cancel_all_orders` (`orders.py:504-890`)
   - Action Center (`orders.py:947-1262`)

   Only `api_v1_bp` is CSRF-exempt (`app.py:295`). The tool handlers all read `session["user"]` and `session["broker"]` the same way (e.g. `ivchart.py:26-60`).
4. **`/api/v1` checks the key late.**
   - The key is read from the JSON body after marshmallow `schema.load`. About 49 schema fields mark `apikey` required.
   - Errors are `{status:"error", message}`.
   - A revoked broker session returns the same 403 "Invalid openalgo apikey" as a bad key (`place_order_service.py:378-382`).
   - A 502 on placeorder means "may have been placed": the app must reconcile, never retry.
5. **WebSocket.** The proxy listens on `127.0.0.1:8765`.
   - It authenticates by `api_key` only (`websocket_proxy/server.py:883-911`). It supports `subscribe` (LTP, Quote or Depth), `subscribe_orders` and `ping`.
   - It closes with 1012 when broker credentials change. Nginx installs map `/ws`.
   - **ngrok exposes only port 5000** (`utils/ngrok_manager.py:146-196`), so ngrok users have no WebSocket today.
6. **Raw API key exposure in the web app.**
   - `/auth/session-status` returns `api_key` (`auth.py:1214, 1227`). The frontend persists it in localStorage (`stores/authStore.ts`, `openalgo-auth`).
   - `/api/websocket/apikey` also returns it (`websocket_example.py:179-197`).
   - 18 frontend files read `apiKey` from the store.
7. **Daily broker session.**
   - It expires at 03:00 IST (`utils/session.py:62`).
   - Re-login needs a browser session that started the login within 10 minutes (`brlogin.py:155-161`).
   - Broker redirect URLs default to `127.0.0.1:5000`.
8. **Semi-Auto mode.**
   - `/api/v1/placeorder` is queued for Action Center approval.
   - API-key modify and cancel are blocked in live mode.
   - The web UI's session routes for modify, cancel and close bypass both. The web UI itself places orders through `/api/v1/placeorder`, so its orders are queued too.
9. **Loose response types.** Numbers arrive as strings, ints or floats depending on the broker. This caused repeated crashes in the old app. Dates use several formats.
10. **Expo DOM facts from the spike:**
    - Only JSON crosses the bridge, and the DOM can call any function prop by name.
    - Each prop change re-renders the whole DOM tree; imperative handles avoid that.
    - Releases load from `file://`. The DOM export has a lazy-chunk bug (worked around).
    - `import.meta.env` is undefined in DOM bundles.
    - The tool page bundle is 3.68 MB, of which 1.48 MB is lucide icons. Tree shaking cuts it to 1.9 MB.
11. **Nothing has run on a budget Android phone yet.** The spike's pass bars are targets, not results (section 12).

## 6. Architecture overview

```
┌──────────────────────── Phone (Expo app) ────────────────────────┐
│ Native screens (lists, forms, nav)    DOM components (WebView)   │
│  watchlist · orders · portfolio ·      ChartDom: OpenAlgoChart   │
│  ticket · depth · option chain · …     ToolDom:  /tools pages     │
│        │                                   │  typed bridge only   │
│  core: session ─ http ─ realtime ─ query ◄─┘  (proxy + allowlist) │
│  tokens in SecureStore; access token in memory; nothing in DOM   │
└───────────────┬───────────────────────────────┬──────────────────┘
        HTTPS + Bearer                    WSS /ws + one-time ticket
┌───────────────▼───────────────────────────────▼──────────────────┐
│ OpenAlgo server (updated)                                         │
│  /oauth/*  (first-party app client, PKCE, device token families)  │
│  /api/v1/* (apikey | bearer | session+CSRF)                       │
│  session routes: watchlist, search, tools, order actions          │
│     (session | bearer, CSRF-exempt only for bearer)               │
│  /ws on the main port → WebSocket proxy (ticket | api_key)        │
└───────────────────────────────────────────────────────────────────┘
```

**One rule ties it together: the app calls the same endpoints the web UI calls, authenticated by a bearer token instead of a cookie or API key.** That gives behaviour parity with the web for free, including Semi-Auto mode, analyzer mode and validation. The server has one place to change.

## 7. Design

### 7.1 Server changes (`openalgo` repo)

Every item ships with pytest coverage. MCP keeps working unchanged.

| ID | Change | Notes |
|---|---|---|
| **S1** | **App auth enablement separate from MCP.** New setting `MOBILE_APP_ENABLED`. OAuth tables and keys are initialised when MCP *or* the app is enabled. The issuer is the server's public https origin (`HOST_SERVER`) | The issuer must equal the origin the user types into the app. One canonical origin per server |
| **S2** | **First-party mobile client.** A pre-registered public client `openalgo-mobile`; its redirect URI uses a private-use scheme, `in.openalgo.mobile:/oauth/callback` (RFC 8252 §7.1). This is allowed **only** for this static client, and dynamic registration stays https-only. The CSP `form-action` on the consent page and the redirect allows the scheme. Audience `openalgo-app`, distinct from MCP | Fixes the redirect and audience gaps (section 5.2; A6 in the research) |
| **S3** | **Sign-in flow.** `/oauth/authorize` requires only an OpenAlgo sign-in (`check_signed_in`, `session.py:492`), not a broker login. Login gets a safe same-origin `next` return-to. The consent page names the device and offers **Trade** (`read:market read:account write:orders`) or **Read-only**. If the user has TOTP enabled, consent for a trading device asks for a fresh TOTP | Generalises the MCP TOTP rule; needs a small migration |
| **S4** | **Token store hardening** (also fixes MCP). Refresh tokens become `<id>.<secret>`, looked up by id with no scan. Each row carries `user_id`, a family id, a device label, created and last-used times. Revoke removes the whole family. Expired rows are purged. The access JWT (15 min) carries the family id, and resources check a cached revoked-family set, so revoking a device takes effect at once | Fixes the refresh and revoke gaps in section 5.2 |
| **S5** | **Bearer on `/api/v1`.** A `before_request` on `api_v1_bp` verifies the bearer token, checks scope (write endpoints need `write:orders`), resolves the user and injects that user's API key into the request **before** `schema.load`. If the body carries an `apikey`, it is ignored. **Also session + CSRF on `/api/v1`** for the web app (F3). Because the blueprint is CSRF-exempt, cookie-authenticated requests must check the CSRF token explicitly | API-key clients are unchanged |
| **S6** | **Bearer on session-only routes.** A decorator `session_or_app_token` replaces `check_session_validity` on every route the app needs (section 5.3), plus a `current_caller()` helper that replaces the repeated `session[...]` reads. A request with a bearer token and no session cookie skips CSRF. A failed bearer check returns 401 JSON and must **not** call `revoke_user_tokens` | Mechanical changes across about 18 blueprints |
| **S7** | **WebSocket.** (a) `POST /api/v1/ws/ticket` (bearer or session) returns a single-use ticket valid for 60 seconds. The proxy's `authenticate` accepts `ticket`, and still accepts `api_key`. (b) A `/ws` route on the main HTTP port bridges to `127.0.0.1:8765` for installs without nginx (ngrok, plain gunicorn); nginx keeps its own `/ws`. (c) Revoking a device closes that device's sockets only, not the user's | (b) must suit the eventlet and gthread workers; measure thread cost |
| **S8** | **Clear errors for bearer calls.** A dead broker session returns `code: "BROKER_SESSION_EXPIRED"` (reusing the string at `auth.py:1353`). Separate codes for `TOKEN_EXPIRED`, `TOKEN_REVOKED` and `INSUFFICIENT_SCOPE` | The app's error model depends on these |
| **S9** | **`GET /api/v1/app/info`** (bearer). Returns the server version, app API version, minimum supported app version, capabilities, the WebSocket path, broker name and analyzer mode | Onboarding and diagnostics |
| **S10** | **Broker re-login from the phone.** `/app/broker-login` starts the broker login in the auth browser. On completion it redirects to `in.openalgo.mobile:/broker/done`. It respects the same-browser guard | Works only when the broker redirect URL is the public origin. Otherwise the app tells the user to log in on the web |
| **S11** | **Web "Mobile app" page.** A QR code with the server URL, setup checks (https, enabled, WebSocket reachable) and **Connected devices**: name, last used, scopes, revoke | Modelled on `pages/admin/RemoteMcp.tsx` |
| **S12** | **Remove raw-key exposure**, sequenced *after* F3 and F5. `/auth/session-status` drops `api_key`, and `/api/websocket/apikey` is removed | Closes section 5.6 |
| **S13** | **Docs.** Rewrite `openalgo-docs/trading-platform/mobile-app.md`. Document the bearer auth, ticket and error codes in the API docs | |

### 7.2 Web frontend changes (`openalgo/frontend`)

These make web code safe to run inside the app, and remove the key from the browser.

| ID | Change |
|---|---|
| **F1** | `import.meta.env?.` at the 4 sites: `api/client.ts:3`, `lib/agent/stream.ts:37`, `lib/agent/voice.ts:44`, `utils/errorReporter.ts:205` |
| **F2** | A pluggable "unauthorized" handler in `api/client.ts`. The default is the current redirect to `/login`; the app's DOM host installs its own |
| **F3** | **Keyless API calls.** Requests stop carrying `apikey`; the transport authenticates (web: cookie + CSRF via S5; app: bearer through the native proxy). `authStore` drops `apiKey`. Migrate module by module across the 18 files and the helpers that take the key as a parameter |
| **F4** | An injectable market-data transport for `MarketDataManager` and `useLivePrice`. Default: WebSocket with a ticket. App: a tick source fed from native |
| **F5** | Web WebSocket auth uses the S7 ticket (`MarketDataManager.ts:411-425`, `Trading.tsx:907`, and the 4 other consumers) |
| **F6** | A dependency-free theme tokens file split out of `index.css`. The app generates native tokens from it, and CI fails on drift |
| **F7** | Tool registry metadata (`lib/tools.ts`) stays pure data, so the app's Tools tab is generated from it |
| **F8** | **An injectable order executor** for `components/trading/ExecuteBasketDialog.tsx` and Arbitrage's two-leg order, following the `place` prop pattern already on `PlaceOrderDialog` (`:77`, `:317-321`). The default calls `/api/v1/basketorder` as today; the app's DOM shell injects one that raises `basketIntent` to native |
| **F9** | **A phone-layout pass on the 18 DOM tool pages**, done in the web frontend so it also improves the mobile web: no horizontal overflow at 360 px, chart heights that follow the viewport rather than fixed pixels, and Plotly touch settings so a vertical swipe scrolls the page instead of zooming. The spike measured Max Pain overflowing at 390 px with a fixed 500 px chart |

The app pins the openalgo commit that contains these changes (section 9.1).

### 7.3 Mobile app: screens

Five tabs, using expo-router NativeTabs:

| Tab | Screens | Built as |
|---|---|---|
| **Watchlist** | Index strip (pick the indices; tap for O/H/L/prev close and funds). Server-side watchlists with a list switcher, add via search, reorder, and swipe-delete with confirm. Each row has one-tap B/S. Tapping a row opens an instrument sheet: BUY, SELL, Chart, Depth, Option chain | Native (seed: spike `WatchlistScreen`) |
| **Orders** | Segments: Open, All orders, Trades, and **Approvals** (shown when Semi-Auto mode is on, with a pending-count badge on the tab). Modify (sheet), cancel (confirm), Cancel all (confirm). Approvals lists queued orders; each can be approved or rejected after a review step showing the LIVE/ANALYZE badge, with the app lock's optional biometric check. Phase 1 has no "approve all" | Native |
| **Portfolio** | Positions with live P&L (close one or all, with confirm), Holdings (investment, P&L, P&L %), Funds | Native |
| **Tools** | A grid of the 20 registry tools, grouped as on the web. Each opens full screen | Option Chain native (seed: spike `ChainScreen`). Arbitrage native, falling back to DOM. The other 18 in DOM (section 7.6) |
| **Account** | Server and broker, LIVE/ANALYZE toggle (confirm when switching to LIVE), broker session status and re-login, theme, app lock, privacy, diagnostics, sign out / revoke this device, version | Native |

Shared screens and modals:
- **Search:** a modal with exchange chips and a debounce.
- **Quote + depth:** WebSocket Depth mode, BUY/SELL.
- **Chart:** full screen, DOM.
- **Order ticket:** a form sheet.
- **Lock screen.**
- **Onboarding:** server, sign-in, compatibility.

**Index symbols are quote-only:** no trading, carried over from the old app and the terminal.

### 7.4 Mobile app: code structure

```
openalgo-mobile/            (repo root = Expo project)
  app.config.ts  metro.config.js  package.json  openalgo.ref
  src/app/                  expo-router routes only (thin)
    _layout.tsx             providers; Stack.Protected guard
    (onboarding)/…  (app)/(tabs)/…  (app)/chart/[symbol]  (app)/tools/[toolId]
    (app)/order/new  order/[id]/modify  search  lock
  src/core/
    config/      app config, server profile
    session/     OAuth+PKCE, token store, single-flight refresh, app lock
    http/        fetch client, zod schemas, error model
    realtime/    WS client, subscription manager, tick store
    query/       TanStack Query client, key factory, focus/online wiring
    platform/    biometrics, secure screen, haptics
    log/         redacting logger
  src/features/<watchlist|orders|portfolio|funds|search|instrument|chart|tools|account|onboarding>/
    api.ts  model.ts  components/  screens/
  src/ui/        tokens.ts (generated), Text, Price, Change, Button, ListRow, Sheet, Skeleton, Empty, Badge
  src/dom/
    bridge/      protocol.ts (versioned, zod), DomHost.tsx, proxy.ts (allowlists)
    chart/       ChartDom.tsx ('use dom')
    tools/       ToolDom.tsx ('use dom') + provider shell (MemoryRouter, QueryClient, Toaster)
  dev/mock-server/          REST + WS + OAuth mock (grows from spike/mock-feed)
  e2e/                      Maestro flows
  scripts/                  sync-openalgo, gen-tokens, check-bundles
  docs/                     specs, ADRs
```

**Boundaries, enforced in CI with dependency-cruiser:**
- A feature imports `core`, `ui` and `dom/bridge` types, and never another feature's internals.
- `core` never imports features.
- **`src/dom/**` can never import `core/session` or `core/http`**, so tokens cannot reach DOM bundles.

### 7.5 Mobile app: data layer

**REST**
- A typed `fetch` client. Base URL is the server origin; requests carry `Authorization: Bearer`.
- Every response is parsed by a **zod schema that coerces the loose types**: strings to numbers, and all the date formats.
- Error model: `AuthExpired`, `Revoked`, `BrokerSessionExpired`, `InsufficientScope`, `RateLimited(retryAfter)`, `Validation`, `Server`, `Network`, `MaybePlaced`.
- TanStack Query v5, matching the web. Query keys are prefixed by the server profile.
- Order mutations use **`retry: 0`**. After any order mutation or `order_update`, books and positions are invalidated.
- Polling runs only while a screen is focused, as a fallback.

**WebSocket**
- One socket per signed-in server, using `wss://<origin>/ws` and authenticated with an S7 ticket.
- A subscription manager reference-counts each (symbol, exchange, mode) with a debounce, and re-authenticates and re-subscribes after every reconnect.
- Backoff runs from 0.5 s to 30 s. After repeated failures it falls back to polling `multiquotes` every 5 s, as the web does.
- Close code 1012 means credentials changed: refresh the session state.
- `subscribe_orders` events refresh the books and show a toast. They are deduplicated on orderid + status + filled quantity.
- The socket drops after 30 s in the background and resumes on foreground.

**Tick store:** the spike's design. A Map outside React, flushed once per frame, with one subscription per row. Fixes:
- evict keys with no listeners;
- a `useScreenActive()` hook (focus plus AppState) pauses hidden screens;
- no credentials in zustand.

**zustand** holds only UI preferences and session status.

### 7.6 Mobile app: DOM bridge and request proxy

**ChartDom** (`'use dom'`) hosts `OpenAlgoChart` unchanged, as in the spike.
- **Props** (they change rarely): theme, symbol, exchange, interval, indicator set, quantity.
- **Imperative handle:** `pushTicks(batch)` and `setPosition(...)`. Ticks never go through props, because a prop change re-renders the whole tree.
- **Actions from the DOM:**
  - `fetchHistory(req)`: native calls `/api/v1/history`;
  - `tradeIntent({side, qty, price})`: native opens the order ticket;
  - `ready` and `error`.
- **BuySellButtons place nothing.** They only raise `tradeIntent`.

**ToolDom** (`'use dom'`) hosts a static registry of tool pages keyed by `toolId`, inside a provider shell (MemoryRouter, QueryClient, Toaster, theme).
- **Request proxy.** A fetch/XHR shim in the DOM forwards `{method, path, query, body}` to the native `request()` action. Native checks the call against a **per-tool allowlist** of methods and path patterns, attaches the bearer token, and calls the server origin.
- **Always denied:** absolute URLs, `/auth/*`, `/api/websocket/*` and `/oauth/*`.
- **Live prices** for Strategy Builder, Strategy Portfolio and similar pages come from the F4 tick source, fed by native.

**Bridge hardening**
- Every DOM-to-native message is validated with zod, and the DOM is treated as less trusted than native code.
- Only the typed actions are exposed as props.
- `unstable_useExpoModulesBridge` stays off.
- Links open in the system browser.
- Restrict `originWhitelist` and file access to what release builds need. The builder verifies this on device.

**Bundles.** Start with one ToolDom with tree shaking on (`EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH`) and lucide imported per icon. Split into per-tool DOM components if open time, memory or APK size miss their budgets (section 12).

### 7.7 Mobile app: auth and session lifecycle

1. **Connect.** The user types or scans (S11 QR) the server origin. **https only** (decided). An `http://` address is refused with a short explanation and a link to the ngrok setup docs.
   - The app fetches OAuth discovery and `/api/v1/app/info`.
   - It checks the issuer equals the origin, the server version is at least the app's minimum, and app auth is enabled.
   - On failure it shows a specific fix, for example "Upgrade OpenAlgo to ≥ 2.1" or "Enable mobile app access".
2. **Sign in.** PKCE S256 in the system auth browser (`expo-web-browser` `openAuthSessionAsync` / `expo-auth-session`).
   - The user signs into OpenAlgo there, with TOTP if enabled, and approves the device as Trade or Read-only.
   - The redirect comes back to `in.openalgo.mobile:/oauth/callback`.
3. **Tokens.** The refresh token goes in `expo-secure-store` (Keychain *this-device-only*; Android Keystore-backed). The access token stays in memory only.
   - **Refresh is single-flight**, and the new refresh token is saved before it is used. Reusing an old one revokes the family.
   - `invalid_grant` means signed out, and the app shows the reason.
4. **Daily broker login.**
   - When a call returns `BROKER_SESSION_EXPIRED`, a banner offers **Log in to broker**: S10 in the auth browser, not in ephemeral mode, so its cookies persist from start to callback.
   - Market screens show stale-data styling until the login completes.
5. **App lock.**
   - Biometrics or the device passcode on cold start, and after 5 minutes in the background (configurable).
   - Optional biometric confirmation for live orders.
6. **Privacy.**
   - App content is hidden in the app switcher (iOS blur; Android secure flag where the platform allows).
   - Screenshot blocking is optional and off by default.
7. **Sign out** revokes the family on the server, then wipes secure storage, the query cache, the tick store and the socket.

### 7.8 Mobile app: order safety

- **Order ticket:**
  - BUY/SELL; product (MIS, CNC, NRML, filtered by segment); price type (MARKET, LIMIT, SL, SL-M);
  - quantity in **lots** for derivatives, using the lot size from `/api/v1/symbol`;
  - price and trigger snapped to the tick size; a freeze-quantity check; the stop on the correct side of LTP.
  - These rules come from `lib/trading/terminal.ts`.
- **Confirmation.**
  - Every order shows a review step with the LIVE/ANALYZE badge, by default.
  - Chart BUY/SELL can enable a **one-tap mode** in settings. It is off by default and shows a warning, like the web terminal's One-Click mode.
- **No duplicate sends.**
  - The submit button is disabled while a request is in flight, with a short cooldown.
  - The mutation never retries.
  - A 502 or a timeout on place shows "Status unknown: checking order book", reconciles against the order book, and never re-sends.
- **Responses.**
  - Semi-Auto responses (`mode:"semi_auto"`, `pending_order_id`) show "Queued for approval".
  - Analyzer responses show a sandbox mark.
- **Strategy tags:** `strategy:"mobile"` for tickets and `"mobile-chart"` for chart buttons.
- **Basket orders from tools** (Strategy Builder Execute, Arbitrage). The DOM never sends them. Through F8 it raises `basketIntent({legs})`. Native shows a multi-leg review (each leg, net premium, LIVE/ANALYZE badge, optional biometric), then sends `/api/v1/basketorder` once with no retry. Native reports the per-leg `results[]`, including partial success, and offers "view in order book" rather than resending failed legs.

### 7.9 Mobile app: UI system

- **Theme.** Dark-first, with a light theme. Colours come from the web theme tokens (F6), so the app and the web look like one product.
- **Trading colours.**
  - Profit and loss use the web's green and red.
  - BUY and SELL use the web's blue and orange tokens, themed into the chart's BuySellButtons where its options allow.
- **Feel.**
  - Dense, Kite-like rows with tabular numbers.
  - A price-change flash that respects reduced motion.
  - Haptics on order actions.
  - Skeletons rather than spinners; explicit empty and error states with a retry.
- **Native presentation.** Bottom sheets and form sheets for tickets and instrument actions.
- **WebView check.** At runtime, detect an Android System WebView older than Chromium 111, whose `oklch` colours break, and prompt the user to update it.

## 8. Security model (summary)

| Threat | Mitigation |
|---|---|
| A stolen or lost phone | App lock; revoke the device from the web (S11), effective immediately (S4); refresh token in hardware-backed storage |
| Token theft over the network | https only; short-lived access tokens; refresh rotation with reuse detection |
| Malicious or compromised web code inside the app | No tokens in the DOM; per-tool allowlist proxy; typed, validated bridge; no navigation |
| CSRF against bearer routes | Bearer requests carry no cookie; CSRF is skipped only when no session cookie is present |
| Raw API key leakage | Never on the phone; removed from web responses (S12) and localStorage (F3) |
| A fat-finger or duplicate order | Review step, no retries, reconciliation, lot and tick validation, LIVE/ANALYZE badge |
| Secrets in the repo or bundle | No client secret exists (public client); gitleaks in CI; a bundle scan for key-like strings; signing material only in GitHub secrets |
| A supply-chain attack | Lockfile, Renovate with review, actions pinned by SHA, a read-only workflow token, `npm ci` |
| Over-sharing logs | A redacting logger; no request bodies in logs; crash reporting deferred, opt-in later |

## 9. Engineering

### 9.1 Repos and code sharing (my call)

- **`openalgo-mobile` stays a separate repo.** Its root becomes the Expo project. `spike/` is deleted once M0 (section 11) passes; history keeps it.
- **Frontend code is consumed by pinned commit.**
  - `openalgo.ref` holds the openalgo SHA.
  - Locally, `scripts/sync-openalgo` checks out `../openalgo` at that SHA, or verifies it is there.
  - CI sparse-checks out `frontend/src`, as now.
  - Metro resolves `@/` into it, and the app's `node_modules` stays the only package source, so React is never duplicated.
- Bumping the ref is a deliberate PR that runs the full suite.
- **Later:** publish `@openalgo/*` packages from the openalgo repo.

### 9.2 Quality gates

- **Code:**
  - TypeScript strict plus `noUncheckedIndexedAccess`;
  - Biome, matching the frontend;
  - dependency-cruiser boundaries;
  - React Compiler on, and typed routes.
- **Unit tests** (jest-expo + React Native Testing Library):
  - tick store
  - WebSocket protocol, against the mock server
  - single-flight refresh
  - proxy allowlists
  - order-ticket validation
  - zod schemas, against fixtures taken from openalgo-docs examples
  - query-key namespacing
- **End-to-end** (Maestro, Android emulator, against `dev/mock-server`):
  - onboarding
  - watchlist
  - placing and cancelling an order (analyzer)
  - the chart opens
  - a tool opens

  iOS is build-and-unit-test only in phase 1.
- **Server:** pytest for S1–S12 in the openalgo repo, with the MCP regression suite kept green.

### 9.3 CI/CD (GitHub Actions)

| Trigger | Jobs |
|---|---|
| Every PR | Lint, typecheck, unit tests, `expo-doctor`, `expo export` for Android and iOS (catches the DOM chunk bug), bundle-size budgets, DOM import-boundary check, gitleaks, Android release build, iOS simulator build |
| Push to `main` | All of the above, plus Maestro end-to-end, the unsigned IPA, and signed builds when secrets exist |
| Tag `v*` | Signed APK attached to a GitHub Release (with its SHA-256 checksum); signed IPA uploaded to TestFlight (fastlane `pilot` with an App Store Connect API key) |

- **Signing material** lives in GitHub secrets:
  - Android: a new release keystore, kept so every APK update installs over the previous one;
  - Apple: the distribution certificate and profile (or fastlane match), plus the App Store Connect API key.
- **TestFlight.** Internal testers (up to 100 App Store Connect users) need no review. External testers go through Apple's beta review, which needs a reachable demo OpenAlgo server in analyzer mode and its login details.
- **Versioning.** Semver marketing version; the build number comes from the CI run number via `app.config.ts`; the app declares its minimum server version.
- **Renovate** updates dependencies weekly, with Expo SDK packages grouped and checked by `npx expo install --check`.

### 9.4 How the server changes ship (my call)

- **Incremental merges.** Server changes merge into `openalgo` `main` in small PRs behind `MOBILE_APP_ENABLED`, which is off by default. MCP and the web app keep working at every step.
- **Release.** They ship in the next openalgo minor release. The app's minimum server version is set to that release, and `openalgo.ref` always points at merged commits.
- **Order of key removal.** F3, F5 and S12 land last, in that order: F3 first, so the web stops needing the key before S12 removes it.
- **Who builds.** Claude builds both tracks (server and app) in parallel, with the product owner reviewing each PR. No deadline is assumed; milestones are ordered by dependency.

## 10. Data the app reads and writes

| Need | Endpoint (auth: bearer) |
|---|---|
| Books and funds | `/api/v1/orderbook`, `tradebook`, `positionbook`, `holdings`, `funds` |
| Place | `/api/v1/placeorder`; `/api/v1/basketorder` for tool baskets, sent by native only (`placesmartorder` not used in phase 1) |
| Modify, cancel, close, cancel all | `/modify_order`, `/cancel_order`, `/close_position`, `/close_all_positions`, `/cancel_all_orders` (web-parity session routes, S6) |
| Quotes, depth, symbol and lot size | `/api/v1/quotes`, `multiquotes`, `depth`, `symbol` |
| History and intervals | `/api/v1/history`, `/api/v1/intervals` |
| Search and expiries | `/search/api/search`, `/search/api/underlyings`, `/search/api/expiries` (S6) |
| Watchlists | `/watchlist/api/lists…` (S6) |
| Action Center | `/action-center/api/data`, `/action-center/count`, `/action-center/approve/<id>`, `/action-center/reject/<id>` (S6; approve and reject need `write:orders`) |
| Option chain | `/api/v1/optionchain`, `/api/v1/expiry` |
| Analyzer | `/api/v1/analyzer`, `/api/v1/analyzer/toggle` |
| Tools (DOM) | Per-tool allowlists over the routes in section 5.3 and `/api/v1/{portfolio,sip,sectorrotation,margin,multiquotes}` |
| Live data | `wss://origin/ws`: ticket auth; `subscribe` (LTP, Quote, Depth); `subscribe_orders` |
| Session | `/oauth/*`, `/api/v1/app/info`, `/api/v1/ws/ticket`, `/app/broker-login` |

## 11. Milestones

Server and app work run in parallel. Each milestone ends with something running on a device or simulator.

| # | Milestone | Exit criteria |
|---|---|---|
| **M0** | **Device gate.** The product owner runs the spike release APK on a budget Android phone (3–4 GB RAM) per `spike/README.md` and sends the results JSON. In parallel, scaffold the repo and the CI quality gates | Chart and Max Pain meet the section 12 bars. If either fails, stop and re-plan the DOM approach |
| **M1** | **Server auth.** S1–S9 with tests; F1, F2 | The mock-free sign-in, refresh, revoke, bearer `/api/v1`, bearer tool route and WebSocket ticket work end to end against a dev server |
| **M2** | **App foundation.** Onboarding, sign-in, secure storage, app lock, HTTP client, WebSocket and tick store, UI kit and tokens, tabs, LIVE/ANALYZE badge, diagnostics | Sign in to a real server; live LTP on a watchlist row |
| **M3** | **Trading core (native).** Watchlists, search, quote and depth, order ticket (place, modify, cancel), books, positions (close, close all), holdings, funds, Action Center approvals, daily broker re-login | A full analyzer-mode trading loop on device, under Maestro |
| **M4** | **Chart.** ChartDom, native history, tick push, BUY/SELL → ticket | Chart open ≤ 2.5 s; pan ≥ 30 fps on the M0 phone |
| **M5** | **Tools.** ToolDom with proxy allowlists; the F9 phone-layout pass; the 12 Plotly and chart pages; Sector Rotation, Portfolio and SIP backtesters and Portfolio Analyzer; Strategy Builder and Strategy Portfolio (need F3, F4 and F8); native Option Chain and Arbitrage, with native basket review | All 20 tools open on device within budget and are usable at 360 px width: no horizontal overflow, page scroll works, and basket orders go through native review |
| **M6** | **Hardening and release.** F3, F5 and S12 (key removal), S10, S11, S13; performance pass on device; signed APK on GitHub Releases; IPA on TestFlight | Release checklist green; the first TestFlight build installs on an iPhone |

## 12. Performance budgets

These carry over from the spike (`spike/app/src/core/results.ts:27-36`). They are measured on the M0 budget phone before each release.

| Bar | Budget |
|---|---|
| Native UI fps | ≥ 55 |
| Native JS fps | ≥ 45 |
| Slow frames | ≤ 5% |
| Chart open | ≤ 2.5 s |
| Chart pan | ≥ 30 fps |
| Tool open | ≤ 2.5 s |
| Tool memory | ≤ 250 MB |
| Cold start (`adb am start -W` TotalTime) | ≤ 3.5 s |

**Every PR** checks bundle budgets: Hermes 4.34 MB, chart DOM 2.33 MB and tool DOM 1.9 MB after tree shaking; more than 5% growth fails.

**A diagnostics build** keeps the spike's bench harness and emits JSON for release checks.

## 13. Risks

| Risk | Mitigation |
|---|---|
| DOM chart or tools are too slow on budget phones (unmeasured) | The M0 gate comes before any DOM-dependent work. Fallback: native rewrites of the worst pages |
| F3 touches many web files and could regress the web app | Module-by-module migration; S5 keeps the API key working throughout; web tests; key removal (S12) comes last |
| OAuth changes break MCP | MCP regression tests; S4 is a data migration with a rollback |
| Expo DOM chunk bug or SDK churn | The `expo export` CI check; pinned SDK; an upstream issue filed |
| The https-only rule excludes LAN-only users | Decided; the QR and setup page explains ngrok or a domain |
| Phone broker re-login fails when the broker redirect is `127.0.0.1` | Detect it, and tell the user to log in on the web |
| Rate limits are shared behind ngrok or nginx (keyed by IP; `TRUST_PROXY_HEADERS` off) | Document it; consider per-user keys for bearer calls later |
| TestFlight external testing (and later the App Store) needs a reviewer-accessible demo server | Start with internal testers; stand up a demo server in analyzer mode before external testing |
| Phase 1 needs an Apple Developer account and an Android release keystore | Signing secrets are added before M6; CI already builds unsigned until then |

## 14. Calls I made (please check)

1. **Parity items added** so current users lose nothing: the LIVE/ANALYZE badge and toggle, 5-level depth, the index strip, Cancel all and Close all, the theme toggle, diagnostics.
2. **The app calls the same endpoints as the web UI**, so Semi-Auto behaves exactly as on the web: new orders are queued, and modify, cancel and close go straight through.
3. **First-party static OAuth client** with a private-use redirect scheme. Per-device identity comes from token families, not one registered client per phone.
4. **WebSocket auth by a single-use ticket**, for both web and app.
5. **A review step before every order by default.** One-tap chart trading is opt-in.
6. **Native vs DOM split** as in section 7.3: Option Chain and Arbitrage native, the other 18 tools in DOM.
7. **Repo layout and pinned-commit sharing** (section 9.1). npm packages come later.
8. **App id `in.openalgo.mobile`, scheme `in.openalgo.mobile`, display name "OpenAlgo".**
9. **One server per install in phase 1**, but storage is keyed by profile, so adding more later is cheap.
10. **BUY/SELL colours follow the web tokens** (blue and orange), not the spike's green and red.
11. **No OTA updates and no crash reporting service in phase 1.** Local logs only.
12. **GTT is out of phase 1.** Action Center approvals have no "approve all" in phase 1.
13. **Tool baskets go through a native multi-leg review** (F8, section 7.8). The tools never place orders themselves.
14. **Tools get a phone-layout pass in the web frontend** (F9), which also improves the mobile web. "It opens" is not enough to ship.
15. **Server changes merge incrementally behind a flag** and ship in the next openalgo minor release (section 9.4).

## 15. Questions for the product owner

All answered on 2026-11-23 and folded into the sections above:

| Question | Answer |
|---|---|
| How is the app distributed in phase 1? | Android APK on GitHub Releases; iPhone through TestFlight; store listings after phase 1 |
| https only, or also home-network http? | https only |
| Action Center approvals on the phone in phase 1? | Yes |
| Who runs the M0 phone test? | The product owner, with the spike APK from GitHub Actions |

## 16. Left to the builder

- Whether to use one ToolDom or several, decided by the section 12 measurements.
- The exact `originWhitelist` and file-access settings that release DOM builds need.
- How to run the `/ws` bridge under each gunicorn worker class.
- The TOTP migration details.
- Purge schedule and caching for token families.
- Allowlist contents per tool, derived from each page's API module.
- Maestro flow details, and the mock server's coverage of OAuth.
