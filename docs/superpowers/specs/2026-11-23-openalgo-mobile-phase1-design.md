# OpenAlgo Mobile, Phase 1: Design

**Status:** approved by the product owner on 2026-11-24 ("implement the plan with market depth"); revised for the stock-server constraint (the 2026-11-23 version, which changed the server, is superseded) · **Date:** 2026-11-24

**Plans:** the two plans in `docs/superpowers/plans/` were written for the superseded version. The server plan is withdrawn. The app plan will be rewritten from this document before anything is built.
**Repos touched:** `openalgo-mobile` (the app). `openalgo` is read only, as the source of web code the app reuses. `openalgo-docs` gets an optional page update.

Code references are `path:line`. `openalgo/` means the server repo at commit `c8b2896` (VERSION 2.0.3.5), and `frontend/` means `openalgo/frontend/src`.

---

## 1. Intent

OpenAlgo users trade from their own self-hosted OpenAlgo server. **These servers are already deployed and run many versions. The app must work with them as they are**, through the API they already expose to API clients:
- the REST API under `/api/v1`, authenticated by the user's API key;
- the WebSocket proxy.

The old Flutter app worked the same way, but it was a weak client:
- it stored the key in plain text;
- it polled every price over HTTP;
- its chart was a "Coming Soon" placeholder;
- there was no CI.

The product owner wants a complete rebuild:

- A **modern, robust UI** that a trader would choose over the mobile web page.
- **Android and iOS built automatically** in CI.
- **Robust security**, plus a codebase that is **modular, hygienic and easy to maintain**.
- In phase 1, users can do on the phone what they do in the web app:
  - place orders
  - monitor the books and holdings
  - chart with built-in indicators and button-based trading
  - watch real-time market data
  - use **all the /tools features**

**No change to the OpenAlgo server is required or assumed.** A spike (`spike/` in this repo, now on `main`) showed that the web frontend's chart and a full /tools page run unchanged inside Expo DOM components. That is the basis for reusing the web code rather than rewriting it.

## 2. Goals, non-goals, anti-goals

**Goals (phase 1)**
1. **One codebase** for Android and iOS: React Native + Expo.
2. **Works with the servers people already run.**
   - Any OpenAlgo **2.0.0.0 or later** (released 2026-01-22).
   - Connected with a server URL and the user's API key, using only `/api/v1` and the WebSocket.
   - Features newer than the server switch off cleanly.
   - Setups without a reachable WebSocket fall back to polling.
3. **The API key is guarded.**
   - It is kept only in the phone's hardware-backed secure storage, behind an app lock.
   - It never enters web content inside the app, logs, crash data or backups.
4. **Trading:**
   - place, modify and cancel orders one at a time;
   - in bulk: Cancel all and Close all, plus the multi-leg basket orders that Strategy Builder and Arbitrage place (section 7.10);
   - order book, trade book, positions (including close one and close all), holdings and funds.
5. **Market data:**
   - watchlists kept on the phone, with live prices over the WebSocket;
   - symbol search;
   - quote and 5-level market depth.
6. **Chart:** the openalgo-charts chart with its built-in indicators, the on-chart BUY/SELL panel, and order and position lines.
7. **Tools:** all 20 pages in the web `/tools` registry (`frontend/lib/tools.ts`). Where the web computes a tool on the server through a browser-session route, the app computes the same result on the phone from `/api/v1` data (section 7.8).
8. **Safety and parity with the old app:**
   - an always-visible LIVE/ANALYZE badge and the analyzer toggle;
   - an app lock;
   - a server check showing what works on this server and why.
9. **CI:**
   - lint, typecheck, tests, bundle budgets and security scans;
   - Android and iOS builds on every PR;
   - signed release builds once signing secrets exist.

**Non-goals (phase 1)**
- **Any change to the OpenAlgo server or the web frontend.** Upstream improvements may be offered as optional PRs, but the app never depends on them.
- **Action Center approvals.** No `/api/v1` route lists or approves Semi-Auto orders; the app links to the web Action Center instead (section 7.10).
- **Watchlist sync with the web.** Web watchlists exist only behind session routes.
- **Strategies saved on the web portfolio.** The app's Strategy Portfolio is its own.
- **Inside the chart:** custom JS indicators and OpenScript studies, which exist only behind session routes.
- **Chart alerts.** This is a scope choice: the app could only check alerts while it is open, and the server's alert log is session-only. Telegram and WhatsApp notify would work through the API.
- **Servers behind an extra access layer** (Cloudflare Access, nginx basic auth). IP allowlists work as long as the phone's address is allowed.
- Push notifications.
- Over-the-air JS updates.
- Offline trading.
- GTT orders.
- Web pages outside `/tools`: Scalping, Historify, Flow, strategies and admin.
- Public Play Store and App Store listings. They come after phase 1; phase 1 ships through GitHub Releases and TestFlight.
- Servers older than 2.0.0.0. The app shows "Update OpenAlgo" and how to do it.

**Anti-goals (this would count as a failure even if it "works")**
- The app only works after the user changes their server.
  - The one exception is a home-PC install bound to 127.0.0.1, which no phone can reach. There the app shows the exact `.env` lines to change (section 7.1).
- The API key reaches web content inside the app, a log, a crash report, a backup, a screenshot, or a URL the app builds when a POST body would do.
- An order is sent twice because of an automatic retry.
- The app's traffic gets the user's IP banned, or starves their running strategies of the server's shared rate limit.
- The app keeps a forked copy of the web tool pages, or computes a tool differently from the web without a test catching it.
- A web page inside the app can make arbitrary network calls, or can call native code beyond a fixed, typed set of functions.
- Status documents that claim more than is true. The old repo has about 30 "Production Ready" summaries while its charts said "Coming Soon". Here, docs describe what exists.

## 3. Decisions already made by the product owner

| Decision | When |
|---|---|
| React Native + Expo, not Flutter, PWA or Capacitor. Picked after a scored comparison of the options; the spike followed | Earlier in this effort |
| The chart uses the OpenAlgo `/trading` feature, limited to **charting, built-in indicators and button-based trading** | Same |
| Phase 1 scope as in goals 4–7; no push notifications | Same |
| `main` of `openalgo-mobile` replaced by the spike. The Flutter app is preserved on `backup/flutter-main-2026-11-23`. CI builds the APK, an unsigned IPA and a simulator app | 2026-11-23 |
| "We can build the actual app" | 2026-11-23 |
| **Distribution:** Android APK from GitHub Releases, iPhone through TestFlight; store listings after phase 1 | 2026-11-23 |
| **The product owner runs the M0 phone test** with the spike APK; chart and tools work waits for the results | 2026-11-23 |
| **Build on the API existing servers already expose** (`/api/v1` + WebSocket, API key), as the Flutter app did. No server changes. *Supersedes Approach A (OAuth device tokens and server changes) from 2026-11-23* | 2026-11-23 |
| **http is allowed for home-network addresses only**, with a visible warning; everything else must be https. *Supersedes "https only" from 2026-11-23* | 2026-11-24 |
| **Minimum server: OpenAlgo 2.0.0.0** (2026-01-22); older servers see "Update OpenAlgo" | 2026-11-24 |
| *Withdrawn:* Action Center approvals in phase 1 (approved 2026-11-23). The stock API cannot list or approve queued orders | 2026-11-24 |
| **User content stays on the phone** (watchlists, saved strategies, drawings), with backup and restore | 2026-11-24 |
| **Real-data testing uses a local test server** on the development Mac, in analyzer mode, logged in to the owner's broker; never the live trading server | 2026-11-24 |
| **Market depth:** tap a level to prefill a limit order; 20/30 levels where the broker supports them | 2026-11-24 |
| **Design approved; implement** ("implement the plan with market depth") | 2026-11-24 |

## 4. Approaches

### 4.1 Stack (decided)

| Option | Trade-off | Outcome |
|---|---|---|
| Flutter (stay) | Reuses 0% of the web code; ranked last on 3 of 4 criteria | Rejected |
| React web as a PWA or Capacitor shell | Highest code reuse. Weaker native feel and store story; WebView-only performance | Close runner-up |
| **React Native + Expo** | Native lists, navigation and gestures. Web chart and tools reused through Expo DOM components | **Chosen** |

### 4.2 Server and auth (decided)

| Option | Trade-off | Outcome |
|---|---|---|
| A. Update the server alongside the app | Revocable per-device tokens and every web route available. Users would have to upgrade, and the OAuth work is large | **Superseded**: people already run servers the app must work with |
| **B. Work with the servers people run** | The API key lives on the phone, and only `/api/v1` and the WebSocket are usable. Session-route features are rebuilt on the phone or dropped | **Chosen** (product owner, 2026-11-23) |

### 4.3 How the 14 session-route tools are built (my call)

Fourteen of the 20 tools get their numbers from browser-session routes such as `/gex/api/gex-data`. A stock server will not serve those routes to an API key. None of them needs data the server collects over time. Each is a computation over live `/api/v1` data: option chains, history, expiries, quotes and the symbol master. The research checked this tool by tool.

| Option | Trade-off | Outcome |
|---|---|---|
| **i. Web page unchanged in a DOM component, plus on-device routes** | The tool page runs as on the web. Its call to a session route is answered on the phone by a TypeScript port of that route's Python service, which fetches its inputs from `/api/v1`. The UI is reused as is; only the service maths is ported, about 40–300 lines per route. Parity is held by golden tests generated from the server's own Python (section 9.2) | **Chosen** |
| ii. Native rewrites of each tool | Native feel, but 14 UIs to rebuild, including Plotly 3D and canvas charts. The UI would drift from the web | Rejected |
| iii. Change the web frontend so tools compute client-side | Moves the same maths upstream and needs openalgo PRs merged. The app pins a frontend commit anyway, so this adds coupling and saves little | Rejected; may be offered upstream later |

### 4.4 Native or DOM, per screen (my call, unchanged)

Each screen is one of two kinds:
- **Native:** rebuilt in React Native.
- **DOM:** the web page runs unchanged inside an Expo DOM component, adapted only at its network and storage boundary.

The rule:
- Rebuild natively anything that is a list, a form or scrolls under live data.
- Reuse the web code wherever a canvas or Plotly page renders a computed view.

So the trading screens, Option Chain and Arbitrage are native. The chart and the other 18 tools are DOM. Details are in section 7.3.

## 5. Constraints found in the code

These facts shape the design. Each was checked in code, and two reviewers re-checked the ones that drive decisions. `[I]` marks an inference.

1. **API key model.**
   - The key is 64 hex characters (`secrets.token_hex(32)`, `blueprints/apikey.py:42`).
   - It goes in the JSON body; GET routes take `?apikey=`.
   - There is one key per user with **no scopes**. It can place orders, close every position, flip the analyzer for the whole install, and control strategies and the Telegram bot.
   - Regenerating the key on `/apikey` cuts off every other client at once (Amibroker, TradingView, Python), **but it may not drop a WebSocket session that is already open** until the user logs out of the broker or OpenAlgo restarts.
2. **Session-only routes** (`@check_session_validity`, cookie, CSRF), unreachable with a key:
   - the data routes of 14 tools (section 7.8);
   - `/search/api/underlyings` and `/search/api/expiries`;
   - watchlists (`blueprints/watchlist.py:65-165`);
   - Strategy Portfolio (`/api/strategy-portfolio`);
   - the Action Center (`orders.py:947-1265`);
   - `/api/websocket/config`, which holds the WebSocket URL;
   - the chart's custom indicators, OpenScript and alerts.
3. **Errors are ambiguous.**
   - `403 "Invalid openalgo apikey"` comes back both for a bad key and for a logged-out broker (`place_order_service.py:378-382`).
   - After the 03:00 IST expiry, `/ping` keeps returning 200 until something triggers the session check.
   - `POST /api/v1/search` checks only the key, not the broker session (`search_service.py:28-32`), so it can tell the two cases apart.
   - A banned IP gets a 403 in one of two forms: plain text `Access Denied: Your IP has been banned`, or JSON `{"error":"Access Denied"}` with no `status` (`utils/security_middleware.py:66-72, 130-132`).
   - A 502 on `placeorder` or `placesmartorder` means the order may have been placed: reconcile, never retry.
4. **Strict schemas.** Marshmallow rejects unknown fields with 400 `"Unknown field"`. Sending a newer optional field to an older server therefore fails: for example `with_greeks` below 2.0.2.0, or `history.source` below 2.0.0.0.
5. **Rate limits.**
   - Each route has its own bucket, keyed by remote address (`limiter.py:7`), with no ProxyFix.
   - Behind nginx, Docker Desktop or a tunnel, **every client of the server shares each bucket**: the web UI, strategies and the phone `[I]`.
   - `.env` values are never rewritten on upgrade, so a server installed in 2025 may still run `API_RATE_LIMIT` at 10 or 50/s and smart orders at 2/s. The in-code fallback is 10/s.
   - Broker history is paced server-wide at about 3 calls/s (`history_service.py:18-53`). Under the gthread worker, a call that would wait more than 10 s gets a 429.
   - 429s come in at least three shapes: flask-restx `{message}`, broker-busy `{status, message}`, and nginx HTML on the Docker VPS installer. `retry_after` is not reliable.
   - Optional auto-ban, when the user has enabled it, is permanent by default and is triggered by repeated 404s or invalid keys.
6. **WebSocket reachability.**
   - The proxy binds `127.0.0.1:8765` by default.
   - The VPS installers proxy `wss://<domain>/ws` through nginx.
   - The built-in ngrok tunnels only port 5000.
   - `docker-run.sh` publishes 8765 but leaves the bind at 127.0.0.1.
   - The app cannot discover the URL, because `/api/websocket/config` is session-only. Section 7.1 has the matrix.
7. **WebSocket protocol, by version.**
   - Authenticate with `{"action":"authenticate","api_key":…}` within 15 s, or the socket closes with 4401 (from 2.0.0.5).
   - Subscribe with modes 1/2/3 (LTP, Quote, Depth) and `depth`.
   - `subscribe_orders` / `order_update` exist from 2.0.1.6; **15 brokers emit no order events**.
   - Application `ping`/`pong` exists from 2.0.0.0.
   - Close 1012 on broker re-login exists only from 2.0.3.5. Before that, the feed goes silent.
   - From 2.0.3.3, absent tick fields are omitted rather than sent as 0.
   - A `BROKER_ERROR` on authenticate leaves the socket open but useless.
   - There is no replay after a reconnect.
8. **Version discovery.**
   - `/api/v1` exposes no version field.
   - `GET /auth/app-info` (from 2.0.0.0; `blueprints/auth.py:1267-1272`) returns `{status:"success", version, name:"OpenAlgo"}` with no key or session. It is public and read-only, but outside `/api/v1` and undocumented.
   - Version numbers trail main-branch builds. A feature can land on `main` a release before VERSION is bumped. For example, `with_greeks` landed while the tree still said 2.0.1.9, and `history.source` landed after the 2.0.0.0 bump. Detection must therefore probe, not just compare versions.
   - `GET /api/v1/swagger.json` lists every registered path, because flask-restx serves specs by default even when the docs UI is off.
   - How a missing endpoint answers depends on the version:
     - from 2.0.2.1: 404 JSON;
     - 2.0.0.0 to 2.0.2.0: **200 text/html** (the React shell);
     - so a client must check that the response is JSON with a `status`.
9. **Semi-Auto mode.**
   - `placeorder` and `placesmartorder` return 200 `{mode:"semi_auto", pending_order_id}` and only queue the order. This includes a single-position close, even in analyzer mode.
   - In live mode the API refuses modify, cancel, cancel-all and close-all with 403.
   - The analyzer toggle is install-wide and, because of a server bug, works even in Semi-Auto.
10. **Loose response types.** Numbers arrive as strings, ints or floats depending on the broker; dates use several formats. This caused repeated crashes in the old app.
11. **CORS blocks the WebView.** The stock server sends CORS headers only when enabled, only on `/api/*`, and only for configured origins. A DOM component's origin is `file://` or Metro, so **every server call from web code must go through native**. This is also what keeps the key out of the DOM.
12. **Expo DOM facts from the spike:**
    - Only JSON crosses the bridge, and the DOM can call any function prop by name.
    - Each prop change re-renders the whole DOM tree; imperative handles avoid that.
    - Releases load from `file://`. The DOM export has a lazy-chunk bug (worked around).
    - `import.meta.env` is undefined in DOM bundles; the spike seeds it (`spike/app/src/dom/tool/env.ts`).
    - The tool page bundle is 3.68 MB, of which 1.48 MB is lucide icons. Tree shaking cuts it to 1.9 MB.
13. **Nothing has run on a budget Android phone yet.** The spike's pass bars are targets, not results (section 12).

## 6. Architecture overview

```
┌──────────────────────────── Phone (Expo app) ────────────────────────────┐
│ Native screens                     DOM components (WebView, no key)      │
│  watchlist · orders · portfolio ·   ChartDom: openalgo-charts widget      │
│  ticket · depth · option chain ·    ToolDom:  web /tools pages, unchanged │
│  arbitrage · account · onboarding        │ fetch shim · WebSocket shim    │
│        │                                 ▼ (typed bridge only)            │
│  core: scheduler ─ http ─ realtime ─ ◄── DOM gateway: allowlist, key      │
│        capabilities ─ query            injection, on-device routes,       │
│  API key in SecureStore (this device)   order review interception         │
└────────────────┬───────────────────────────────┬─────────────────────────┘
      HTTPS (or LAN http) + apikey in body     WSS /ws or ws://host:8765
┌────────────────▼───────────────────────────────▼─────────────────────────┐
│ The user's OpenAlgo server, unchanged (2.0.0.0+)                          │
│  /api/v1/*  ·  /api/v1/swagger.json  ·  /auth/app-info  ·  WebSocket proxy│
└───────────────────────────────────────────────────────────────────────────┘
```

**One rule ties it together: to the web code inside the app, the native layer is the server.**
- The DOM pages make the same calls they make on the web.
- The **DOM gateway** answers each one in one of four ways:
  - it forwards an allowlisted `/api/v1` call with the real key injected;
  - it computes a session route on the phone from `/api/v1` data;
  - it serves device-local storage;
  - it emulates the WebSocket protocol over the app's own socket.
- The real server only ever sees API-key calls, which is exactly what a stock server supports.

## 7. Design

### 7.1 Connecting to a server

**Onboarding** (one server per install in phase 1; storage is keyed by a server profile, so adding more later is cheap):

1. **Server URL.** The app normalizes it: scheme, trailing slash, and a default port when there is no scheme.
   - **https** is required for every public host.
   - **http** is allowed only for home-network hosts, with a persistent "Not encrypted" badge and a one-time warning that anyone on the same Wi-Fi can capture the key. Home-network hosts are:
     - the private ranges 10/8, 172.16/12 and 192.168/16;
     - link-local 169.254/16;
     - CGNAT/Tailscale 100.64/10;
     - `*.local`;
     - in development builds only, `localhost` and `10.0.2.2`.
   - The rule is enforced in app code. Android's cleartext switch is global and iOS uses `NSAllowsLocalNetworking`.
   - **iOS local network.** iOS asks for local-network permission, so the app ships an `NSLocalNetworkUsageDescription`. If the user declines, the app shows how to allow it in Settings.
   - **ngrok.** Requests send `ngrok-skip-browser-warning: 1`, so ngrok's interstitial HTML is never mistaken for a missing endpoint.
2. **Version check.** `GET /auth/app-info`, accepted only if the reply is JSON with a `version`.
   - Versions are compared segment-wise, treating the mistaken `2.0.1.17` as `2.0.1.7`.
   - If app-info is missing or not JSON, the app looks for a 2.0.0.0 marker: `multioptiongreeks` in `GET /api/v1/swagger.json`, or a 400 JSON reply to `POST /api/v1/multioptiongreeks {}`.
   - A server that shows a marker is accepted even without app-info, because app-info is not an official API.
     - The marker is not exact: `main` builds from the week before the 2.0.0.0 bump also pass it. That risk is accepted, because probes cover the gaps.
   - A server with no marker gets "Update OpenAlgo" with the steps for `install/update.sh` or the Docker image.
3. **API key.** A masked paste field with a show toggle and "Where do I find this?" (the web `/apikey` page).
   - The keyboard's scan-text feature (iOS Live Text, Gboard) works in the field.
   - The key must match `^[0-9a-f]{64}$`.
   - `POST /api/v1/search` checks the key alone.
   - `POST /api/v1/funds` checks the broker session. `/ping` is not used for this, because it can return 200 after the 03:00 expiry.
   - `POST /api/v1/ping` gives the broker name.
   - Funds 403 with search 200 means "Your key works; log in to your broker on the OpenAlgo web to see live data".
   - **Clipboard.** Once the key validates, the app clears the clipboard if it still holds the key, because iOS Universal Clipboard can carry it to the user's other devices.
4. **WebSocket URL**, derived and editable:
   - `https://h` becomes `wss://h/ws`;
   - `http://h:5000` becomes `ws://h:8765`.
   - **The same URL rule as REST.** `wss://` is required for public hosts; `ws://` is allowed only on home-network hosts. The key travels in `authenticate`, so a live-feed host that differs from the REST host needs explicit confirmation.
   - The app tries the handshake: authenticate within 15 s, then `ping`.
   - After 3 failed attempts it saves the server in **polling mode**, with a banner "Live feed unavailable: prices refresh every few seconds" and a link to setup help.
5. **Save.** The key goes to SecureStore (section 7.2); the URL and profile go to normal storage.
   - **Profile id.** The profile is keyed by a stable local id, not the host. Changing the URL, for example after a quick-tunnel restart, keeps the user's data.

**Changing it later.** Account has:
- **Server URL**, **Live feed URL** and **Test live feed**;
- **Change API key**.

In polling mode, the app retries the live feed on foreground, at most once every 10 minutes. A user who fixes their setup gets the live feed back without signing out.

**Capability probe.** It runs once per server, re-runs on foreground when older than 24 h, after a 1012 close, and after a version change, and is cached by host and version.

| Capability | Source | Effect when absent |
|---|---|---|
| Endpoint present | `swagger.json` path set. Otherwise a single `POST {}` probe (a 400 JSON reply means present), at most about 10 probes per server | Tool shown disabled with the version it needs; reason in diagnostics |
| `optionchain.with_greeks` / `interest_rate` | 2.0.2.0+, or self-heal | Greeks computed on the phone in `with_greeks` mode (section 7.8) |
| Chain fields `expiry_ts`, `server_ts`, `forward_price`, `underlying_symbol` / `underlying_exchange` | 2.0.2.0+, detected in the response | Derived on the device. The expiry instant comes from `DDMMMYY` plus the exchange cut-off. The forward comes from ATM put-call parity. The underlying comes from a port of the index map (`services/iv_chart_service.py:41-97`) and MCX near-month futures |
| `history.source` | Present on most 2.0.0.0 builds, not all | Read self-heal drops it |
| Order stream | `subscribe_orders` acked, not `INVALID_ACTION` (2.0.1.6+) | Book polling (section 7.6) |
| 1012 on re-login | 2.0.3.5+ | Tick-silence watchdog |
| Portfolio and SIP, Sector Rotation | 2.0.1.8+, 2.0.3.0+ | Those tools hidden |

**Self-healing on reads only.** On a 400 whose message names `'<field>': ['Unknown field.']`, the app drops that optional field, records the capability as false, and retries once. Order endpoints never self-heal or retry.

**Deployment matrix** (what users get, and what the setup help says):

| Setup | REST | Live feed | What the app says |
|---|---|---|---|
| VPS installers (native or Docker; nginx + TLS) | ✓ `https://domain` | ✓ `wss://domain/ws` | — |
| Docker on a home PC (`docker-compose`, `docker-build.sh`) | ✓ LAN http | ✓ `ws://host:8765` | Not-encrypted badge |
| Docker via `install/docker-run.sh` | ✓ | ✗ until `WEBSOCKET_HOST='0.0.0.0'` | The one `.env` line and a restart |
| Native install on a home PC, unchanged `.env` | ✗ (binds 127.0.0.1) | ✗ | Detects connection refused; shows the two lines `FLASK_HOST_IP='0.0.0.0'` and `WEBSOCKET_HOST='0.0.0.0'` |
| Built-in ngrok, cloudflared quick tunnel, Dev Tunnels | ✓ https | ✗ | Polling mode. For cloudflared, the help shows an ingress rule `path: ^/ws → 127.0.0.1:8765` that brings the live feed back without changing the server |
| OpenAlgo Desktop (Rust/Tauri engine) | Unverified | Unverified | It may lack `/auth/app-info` and `swagger.json`, and its version numbers may not map to the Flask feature gates. Tested in M1 if a Desktop build is available; otherwise listed as not yet supported |

**Broker logged out.** It is checked with `/funds` on cold start and on resume. A 403 from any broker-backed call also triggers one `POST /api/v1/search` check.
- If it returns 200, the broker session has ended. A banner offers "Log in to your broker", which opens the server's web login in the system browser. Market screens show stale-data styling.
- If it returns 403, the key is wrong or was regenerated. The app asks for the key again.
- A WebSocket `BROKER_ERROR` leads to the same broker-logged-out state, and the app closes that socket itself.

### 7.2 Credential storage and app lock

- **Key storage.** `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (Keychain this-device-only; Android Keystore-backed). This keeps it out of backups.
  - It is read into memory once the app is unlocked, and dropped when the app locks.
  - It is shown masked, with no length hint.
  - Screenshots are blocked on the screen that shows it.
- **App lock.** Biometrics or the device passcode on cold start, and after 5 minutes in the background (configurable).
  - **Optional:** confirm with biometrics before live writes: orders, close, cancel-all, analyzer toggle. Off by default; the setting explains why it exists.
- **Privacy.** App content is hidden in the app switcher (iOS blur; on Android, off by default, because the only way to hide it also blocks screenshots). Screenshot blocking is optional and off by default.
- **Logging.** One redacting logger strips `apikey` and `api_key` everywhere: request bodies, WebSocket frames, errors, the diagnostics export. Request bodies are never logged.
- **Key only in bodies.** The app uses POST wherever the API offers it. A few routes are GET-only and take `?apikey=`, which puts the key in the user's own server access log; the help text says so. The app sends only these:
  - `/api/v1/instruments`, at most once a day (section 7.8);
  - `/api/v1/portfolio/benchmarks`, the SIP `frequencies` and the Sector Rotation `options`, only when those tools open.
- **User content stays on the phone** (product owner, 2026-11-24): watchlists, saved strategies and chart drawings. Nothing is stored on the server, and `/api/v1/chart` is not used.
  - **Back up** in Account writes one JSON file through the share sheet; **Restore** reads one back through the file picker.
  - The file holds no key and no server URL, so it can be shared safely.
- **Sign out** wipes the key, the query cache, the tick store and the socket.
  - User content is kept unless the user also chooses to delete it. The sign-out screen offers a backup first.
  - It tells the user that only regenerating the key on the web cuts the phone off for good.
- **Lost phone** (in the help and on the Account screen):
  1. Regenerate the key on the web. This also breaks the user's other API clients until each one is updated.
  2. Log out of the broker, or restart OpenAlgo, so any open live-feed session drops.

### 7.3 Mobile app: screens

Five tabs, using expo-router NativeTabs:

| Tab | Screens | Built as |
|---|---|---|
| **Watchlist** | An index strip (pick from NIFTY, BANKNIFTY, SENSEX, INDIAVIX; tap for O/H/L/prev close and funds). Watchlists on the device: several named lists, add via search, reorder, swipe-delete with confirm. Each row has one-tap B/S. Tapping a row opens an instrument sheet: BUY, SELL, Chart, Depth, Option chain | Native (seed: spike `WatchlistScreen`) |
| **Orders** | Segments: Open, All orders, Trades. Modify (sheet), cancel (confirm), Cancel all (confirm). In Semi-Auto, a banner "Orders need approval in the web Action Center" with **Open Action Center** (system browser) | Native |
| **Portfolio** | Positions with live P&L (close one or all, with confirm). Holdings (investment, P&L, P&L %), with **Sell** on each row: it opens the ticket preset to SELL CNC, because a smart-order close does nothing for delivery holdings. Funds | Native |
| **Tools** | A grid of the 20 registry tools, grouped as on the web. Tools the server is too old for are shown disabled, with the version they need | Option Chain and Arbitrage native; the other 18 in DOM (sections 7.7–7.8) |
| **Account** | Server, version, broker and connection mode (live feed or polling); Server URL, Live feed URL and Test live feed; LIVE/ANALYZE toggle; broker session status and "Log in to your broker"; theme; app lock; privacy; Back up and Restore; diagnostics; change key; sign out; lost-phone help; app version | Native |

The **LIVE/ANALYZE toggle**:
- It confirms when switching to LIVE.
- It says the switch applies to the **whole OpenAlgo install**, including the web and running strategies.
- It is hidden once the app has seen Semi-Auto responses, because the server's toggle guard is broken there.

Shared screens and modals:
- **Search:** a modal with exchange chips and a debounce (`/api/v1/search`).
- **Quote + depth** (product owner, 2026-11-24). It opens from the instrument sheet, an Option Chain call or put, and search results.
  - **Header:** LTP, change, open/high/low/prev close, volume, and OI for F&O.
  - **Ladder:**
    - **5 levels** of bids and asks by default: price, quantity and orders, plus total buy and sell quantity.
    - **A 5 / 20 / 30 switch** appears only where the broker supports deeper levels on that exchange (e.g. Dhan: 5, 20 on NSE/NFO; no broker offers 30 at openalgo `c8b2896`, so 30 is reserved for later ref bumps). It is decided from a bundled per-broker map, and confirmed by the subscribe ack's `depth` and the level count in the ticks. Otherwise it falls back to 5.
    - **Tapping a level** opens the order ticket with that price as a LIMIT: a bid level presets SELL and an ask level presets BUY, and the user can flip it.
  - **BUY/SELL** buttons open the ticket at market.
  - **Live and fallback.** Live over WebSocket Depth mode. In polling mode it uses `/api/v1/depth` every 2–5 s (5 levels only; deeper levels need the WebSocket).
  - **Indices** show the quote without a ladder or BUY/SELL.
- **Chart:** full screen, DOM. It opens from four places: the instrument sheet (watchlist row), search results, the quote and depth screen, and a position or holding row. Indices can be charted, without BUY/SELL.
- **Order ticket:** a form sheet.
- **Lock screen.**
- **Onboarding:** URL, version, key, live feed (section 7.1).

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
    config/       server profile, URL rules (https / home-network http)
    credentials/  API key store, app lock
    capabilities/ version + endpoint probe, capability flags
    http/         fetch client, request scheduler, zod schemas, error model
    realtime/     WS client, subscription manager, tick store, polling fallback
    query/        TanStack Query client, key factory, focus/online wiring
    platform/     biometrics, secure screen, haptics
    log/          redacting logger
  src/features/<watchlist|orders|portfolio|funds|search|instrument|chart|tools|account|onboarding>/
    api.ts  model.ts  components/  screens/
  src/market/     shared market logic: symbol master, expiry/underlying resolution,
                  Black-76 wrapper, history queue (used by tools, chart and native screens)
  src/ui/         tokens.ts (generated), Text, Price, Change, Button, ListRow, Sheet, Skeleton, Empty, Badge
  src/dom/
    bridge/       protocol.ts (versioned, zod), DomHost.tsx
    gateway/      allowlists, key injection, order-review interception, WS emulation
    routes/       on-device routes: one module per session route (section 7.8)
    chart/        ChartDom.tsx ('use dom')
    tools/        ToolDom.tsx ('use dom') + provider shell (MemoryRouter, QueryClient, Toaster,
                  phone stylesheet, fetch and WebSocket shims)
  dev/mock-server/          stock-server emulator: REST + WS, per-version behaviour
  e2e/                      Maestro flows
  scripts/                  sync-openalgo, gen-tokens, check-bundles, gen-golden
  test/golden/              fixtures generated from the server's Python services
  docs/                     specs, ADRs
```

**Boundaries, enforced in CI with dependency-cruiser:**
- A feature imports `core`, `market`, `ui` and `dom/bridge` types, and never another feature's internals.
- `core` never imports features.
- **`src/dom/chart` and `src/dom/tools` can never import `core/credentials`, `core/http` or `dom/gateway`**, so the key cannot reach a DOM bundle.
- `dom/routes` is native code: it runs in the app's JS runtime, not in the WebView.

### 7.5 Mobile app: data layer

**REST client**
- A typed `fetch` client with the base URL of the server profile.
- The key is added to the JSON body by the client and nowhere else.
- Every response is parsed by a **zod schema that coerces the loose types**: strings to numbers, and all the date formats.
- **Each endpoint declares the content type it expects.**
  - The default is JSON with a `status` field. An HTML 200 on such an endpoint means "endpoint missing".
  - The exceptions are CSV for `/instruments` and HTML for the Portfolio tearsheet. Native fetches the tearsheet and opens it in a viewer or the share sheet; the web's object-URL download cannot work in the WebView.
- **Each endpoint has its own timeout:**
  - 15 s by default;
  - 30 s for `history`;
  - 30 s or more for `splitorder`, which can place up to 100 child orders;
  - 120 s for the portfolio, SIP and sector-rotation tools.

**Error model**
- `KeyInvalid`, `BrokerLoggedOut`, `IpBanned` (either "Access Denied" form, section 5.3: stop all traffic for that server and explain), `Unsupported` (endpoint or field missing), `SemiAutoBlocked` (403 with the Semi-Auto message), `RateLimited`, `Validation`, `Server`, `Network`, and `MaybePlaced`. On an order lane, that is a timeout, a 502, or any other 5xx without an OpenAlgo JSON `status` except 501 and 503. It covers proxy pages such as nginx 504 and Cloudflare 520/524.

**Request scheduler** (one per server). It protects the user's shared rate-limit buckets and their strategies:
- **Pacing.**
  - About 5 requests/s sustained across the app, half the oldest 10/s floor.
  - One read in flight per endpoint and argument set.
  - An **orders lane** that jumps the read queue, with at least 0.5 s between smart orders (old installs allow 2/s).
- **History queue.** At most 2–3 `/history` calls in flight, and no more than 3/s.
  - The server paces broker history to about 3/s for everyone. Strictly serial calls would add a phone round trip to each call, while 2–3 in flight keep the server's pacer full with little queueing.
  - It reports progress to the screen that asked.
- **429, any shape:** back off that endpoint from 2 s, doubling to 30 s, and ignore `retry_after`.
- **No automatic retry, ever,** of 401/403/404, of any order endpoint, or of a request that got `MaybePlaced`.
- **Pausing.** Polling stops when the screen is hidden or the app is in the background, and slows outside market hours.

**TanStack Query** v5, matching the web.
- Query keys are prefixed by the server profile.
- Order mutations use `retry: 0`.
- After any order action or `order_update`, the books, positions and funds are invalidated, debounced 500 ms.

**zustand** holds only UI preferences and session status, never credentials.

### 7.6 Mobile app: live data

**WebSocket** (one per server)
- **Auth:** it authenticates with `api_key` within 15 s. The success reply gives `broker` and `user_id`.
- **Subscriptions:**
  - A subscription manager reference-counts each (symbol, exchange) at the **highest mode any screen needs**, because Depth carries LTP.
  - It sends numeric modes and the `depth` key, debounced.
  - It re-authenticates and re-subscribes after every reconnect.
- **Keep-alive and reconnect:**
  - Application `ping` every 25 s.
  - Reconnect backoff is `min(1 s · 2^n, 30 s)`.
  - On 1012 (2.0.3.5+), it re-authenticates and re-subscribes.
  - On older servers, a tick-silence watchdog does the same: during market hours, with live subscriptions and no ticks for 60 s, it reconnects once and then checks the broker session.
- **Tick fields** are all optional (2.0.3.3+ omits absent fields).
- **Background:** the socket drops after 30 s in the background and resumes on foreground with a resync of the books.

**Order updates**
- On 2.0.1.6+, the app sends `subscribe_orders` on every authenticate and deduplicates `order_update` on orderid + status + filled quantity.
- The books refresh after each update, after the app's own actions, and on foreground.
- Fallback book poll, chosen from the WS `broker` field:
  - **30 s** for brokers with order events, and in analyzer mode;
  - **5 s while orders are working** for the 15 brokers without them, and on servers before 2.0.1.6.

**Polling mode** (no reachable WebSocket). Every live consumer has a defined fallback, and only the visible screen polls:

| Consumer | Fallback | Every |
|---|---|---|
| Watchlist, index strip, position P&L | `multiquotes` for visible symbols | 2 s on a home network, 5 s on a tunnel |
| Quote and depth screen | `depth` | 2 s home, 5 s tunnel |
| Chart forming bar | LTP from `multiquotes`, plus the 30 s history tail (as on the web) | 2 s / 5 s |
| Option Chain | `optionchain` | 5 s home, 10 s tunnel |
| Arbitrage | `multiquotes` for visible rows (bid/ask from `depth` for the selected row) | 5 s |
| DOM tools (Strategy Builder, Strategy Portfolio and others) | The WebSocket shim fails fast. MarketDataManager then takes its own `multiquotes` fallback through the gateway and scheduler | 5 s (the web's value) |
| Positions, funds, books | as above | 5 s, 60 s, per order state |

- Peak load is about 1 request/s.
- Tick-level candles are not available; the chart says so.

**Symbol budget.** The WebSocket allows 1,000 symbols per connection, and the user shares that pool with their web tabs and other clients. The app keeps a budget of 500 symbols. Screens subscribe only what is visible: Arbitrage subscribes its visible rows, not the whole universe.

**Tick store:** the spike's design. A Map outside React, flushed once per frame, with one subscription per row. Fixes:
- evict keys with no listeners;
- a `useScreenActive()` hook (focus plus AppState) pauses hidden screens.

### 7.7 Mobile app: DOM bridge and gateway

**What the DOM sees.** Web code inside the app runs against a fake origin that native serves.
- Its auth store (`stores/authStore.ts`, persisted as `openalgo-auth`) is seeded with the placeholder key `"__native__"` and a `loginTime` of now. Otherwise `checkSession()` logs out anything older than 03:00 IST.
- Its `import.meta.env` is seeded as in the spike.
- Its broker store is seeded from the `ping` broker name and a bundled map of each broker's exchanges (from the brokers' `plugin.json`), filtered to the exchanges the server's version accepts. Without that, pages fall back to `FALLBACK_EXCHANGES`, which old servers partly reject.
- **No real key, server URL or socket ever exists in the WebView.**

**Startup calls the web code makes.** The gateway answers these locally:

| Call | Made by | Answer |
|---|---|---|
| `GET /auth/csrf-token` | `api/client.ts:6-12`, `MarketDataManager.ts:86`, `themeStore`, `errorReporter` | `{csrf_token:"<dummy>"}`. Every POST waits on this token, so denying it would block every tool |
| `GET /api/websocket/config` | `MarketDataManager.ts:371` | A placeholder URL that only the WebSocket shim accepts |
| `GET /api/websocket/apikey` | `MarketDataManager.ts:411, 740` | `{status:"success", api_key:"__native__"}` |
| `GET /auth/analyzer-mode` | `themeStore.ts:150` | Built from `/api/v1/analyzer` |
| `/api/broker/capabilities` | `brokerStore.ts:29` | The seeded broker store |
| The error-report endpoint | `utils/errorReporter.ts:127` | Swallowed locally (no crash reporting in phase 1) |
| `/auth/analyzer-toggle` | `themeStore.ts:122` | Denied. Only the native Account screen can switch the mode |

**Fetch shim → gateway.** A fetch/XHR shim forwards `{method, path, query, body}` to the native `request()` action. The gateway checks the call against the **per-tool allowlist** (methods and path patterns, taken from each page's API module) and then does one of five things:

| Kind | What native does |
|---|---|
| Allowlisted `/api/v1/*` read | Replaces the placeholder `apikey` with the real key, adapts the request to the server's capabilities (drops fields the server predates), and sends it through the scheduler |
| `/api/v1` order write: `placeorder`, `basketorder`, `optionsmultiorder`, `splitorder`, `placesmartorder` | **Holds the request** and shows the native review (section 7.10). It sends the request once only on confirm. If the user cancels, it answers the page with a JSON error |
| Session route with an on-device implementation (section 7.8) | Runs the TypeScript route module, which calls `/api/v1` through the scheduler, and returns the same JSON shape the web route returns |
| Device-local route (Strategy Portfolio) | Reads or writes app storage, keyed by server profile |
| A download (the Portfolio tearsheet) | Fetched by native and opened in a viewer or the share sheet |
| Anything else: absolute URLs, every other `/auth/*` path, unknown paths | Denied. The page gets a JSON 403. A 401 is never returned, because the web client would redirect to `/login` |

**WebSocket shim.** The DOM's `WebSocket` global is replaced with a bridge-backed class.
- Native emulates the server protocol for the page:
  - `authenticate` succeeds locally;
  - `subscribe` and `unsubscribe` go into the app's subscription manager on the app's single socket;
  - ticks come back as `market_data` frames, batched per animation frame through an imperative handle.
- In polling mode the shim fails to connect at once, so the page takes its own REST fallback (section 7.6).
- Socket.IO comes in only through the web layout's `SocketProvider`, which the DOM shell does not mount.

**Bridge hardening**
- Every DOM-to-native message is validated with zod, and the DOM is treated as less trusted than native code.
- Only the typed actions are exposed as props.
- `unstable_useExpoModulesBridge` stays off.
- Links open in the system browser.
- Restrict `originWhitelist` and file access to what release builds need. The builder verifies this on device.
- **A strict Content Security Policy in every DOM bundle.** The shims cover fetch, XHR and WebSocket, but images, scripts, CSS `url()`, EventSource and `sendBeacon` would still reach the network. The policy (`connect-src 'none'`, `img-src 'self' data: blob:`, scripts and styles from the bundle only) closes that, and is tested on device.

**Phone layout.** The DOM shell carries a phone stylesheet and small per-tool layout overrides, so the 18 pages work at 360 px:
- no horizontal overflow;
- chart heights follow the viewport;
- Plotly touch settings let a vertical swipe scroll the page instead of zooming.

No change to the web frontend is required. A fix that would also help the mobile web can be offered upstream later.

**Bundles.** Start with one ToolDom with tree shaking on (`EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH`) and lucide imported per icon. Split into per-tool DOM components if open time, memory or APK size miss their budgets (section 12).

### 7.8 Tools

**Shared market module** (`src/market`, native):
- **Symbol master.**
  - `GET /api/v1/instruments?exchange=<X>&format=csv`, downloaded lazily, only for the F&O exchanges a tool needs, at most once per trading day.
  - It is parsed off the UI thread and stored in expo-sqlite.
  - It supplies underlyings, futures contracts, strike lists, lot and tick sizes, and the Arbitrage universe.
  - If the download fails, it falls back to the web's default underlying list (`frontend/hooks/useSupportedExchanges.ts:11-17`) plus `/api/v1/search` type-ahead.
- **Expiries** come from `/api/v1/expiry`; the `DD-MMM-YY` and `DDMMMYY` forms are converted.
- **Futures resolution.**
  - It takes `/expiry` futures and builds `<U><DDMMMYY>FUT` (OpenAlgo symbology).
  - For CRYPTO, the chain already quotes the perpetual.
  - For MCX and CDS, the chain's underlying is already the near-month future.
- **Black-76:**
  - **Engine.** `frontend/lib/optionGreeks.ts` is imported from the pinned frontend, not copied.
  - **Server conventions.** A wrapper reproduces the server's `calculate_greeks` choices:
    - r = 0, a 365-day year and a t floor of 1e-4;
    - expiry cut-offs at 15:30, CDS 12:30 and MCX 23:30 IST;
    - time value measured against spot intrinsic with a 0.01 threshold;
    - expired legs give null;
    - rounding before aggregation;
    - the server-clock offset from `server_ts` or the HTTP `Date` header.
  - **Pricing reference.** Spot for GEX, IV Smile, Vol Surface and Option Greeks; the ATM put-call-parity forward for Gamma Density.
  - **No shortcuts.** `/optionchain with_greeks` and `/multioptiongreeks` price off the forward. Using them would give 2–5 vol points and 15–25% gamma away from the web's numbers.
  - **Proof.** Golden vectors generated from opengreeks 0.2.0 (section 9.2). If the web engine cannot match them, a dedicated engine replaces it behind the same wrapper.
  - **A second mode, `with_greeks`,** reproduces what `/optionchain with_greeks` returns (`services/option_chain_service.py:237-318`):
    - forward pricing from ATM put-call parity, with intrinsic value against the forward;
    - IV 0 and delta ±1 or 0 for legs with no time value;
    - IV rounded to 2 dp, delta 4, gamma 6, theta 4, vega 4.

    Pages that expect server Greeks (Option Chain, Strike Profile, Strategy Builder) use it on servers before 2.0.2.0. It has its own golden tests.
- **History queue**: the scheduler's history lane (section 7.5), plus a per-trading-day device cache where a tool re-reads past days. The cache is keyed by the date of the last completed daily candle (`data[-2]`), not by today's date.

**Per tool** (effort is the mobile port only; on-device routes live in `src/dom/routes/`):

| Tool | Built as | Session routes replaced on the device | `/api/v1` calls (per load / refresh) | Effort |
|---|---|---|---|---|
| Option Chain | Native. Greek columns (IV, delta, gamma, theta, vega) can be switched on. **Tapping a call or put gives BUY/SELL**, which opens the ticket prefilled with that option, lots and price; chart and depth open from the same tap | `/search/api/underlyings`, `/search/api/expiries` | `expiry`; `optionchain` (`with_greeks` on 2.0.2.0+, otherwise the on-device `with_greeks` mode) every 30 s; WS Depth on the underlying and the legs | S |
| OI Tracker | DOM | `/oitracker/api/oi-data` | `optionchain` strike_count 23 (no Greeks), `expiry` futures, `quotes` FUT (or WS); 4 on load, 1–2 per refresh | S |
| OI Range | DOM | same as OI Tracker | same | S |
| Max Pain | DOM | `/oitracker/api/maxpain` | `optionchain` 23 | S |
| IV Smile | DOM | `/ivsmile/api/*` | `expiry`, `optionchain` 25; every 30 s | S |
| GEX Dashboard | DOM | `/gex/api/*` | `expiry`, `optionchain` 45, `quotes` FUT; every 30 s | M |
| Gamma Density | DOM | `/gammadensity/api/*` | `expiry`, `optionchain` 23; every 60 s | M |
| Strike Profile | DOM | `/strikeprofile/api/*` | N × `optionchain` with Greeks, serial (default 6–7 expiries); about 250 lines of GEX, DEX, walls and flip | M |
| Vol Surface | DOM (Plotly 3D unchanged) | `/volsurface/api/*` | ≤ 8 × `optionchain` 40, serial, manual refresh | M |
| Option Greeks | DOM | `/ivchart/api/*` | `intervals`, `expiry`, `optionchain` 1 (ATM legs), 3 × `history`; per-candle IV and Greeks with F = underlying close | M |
| OI Profile | DOM | `/oiprofile/api/*` | `optionchain` + up to 82 daily `history` calls through the history lane. The first load of the day takes about 30–60 s, with progressive rendering; then a day cache makes refreshes 2 calls | M |
| Straddle Chart | DOM | `/straddle/api/*` | `intervals`, `expiry`, `optionchain` (strike grid), `history` for the underlying, then CE and PE per unique ATM strike, trimming to N days first | S |
| Straddle PnL | DOM | `/straddlepnl/api/*` | as Straddle Chart, up to about 81 `history` calls; lot size from the master | M |
| Arbitrage | Native | `/arbitrage/api/universe` | Universe from the symbol master (3 nearest FUT per name). WS Depth on the **visible** rows' legs only (symbol budget, section 7.6). `basketorder` through native review | M |
| Strategy Builder | DOM | `/search/api/underlyings`, `/scalping/api/futures`. Plus its Strategy Chart and Multi-strike OI tabs: `/strategybuilder/api/strategy-chart`, `/multi-strike-oi` and `/intervals` (`blueprints/strategy_chart.py:32,107,182`; about 180 lines of service code). Save and load go to the device-local `/api/strategy-portfolio` | Already `/api/v1`: `optionchain` 20 with `withGreeks:true` always (the on-device `with_greeks` mode before 2.0.2.0), `expiry`, `margin`, `multiquotes`, `quotes`; WS Depth; `basketorder` held for native review | M |
| Strategy Portfolio | DOM | `/api/strategy-portfolio[/<id>]` → device-local store | Live LTP through the WS shim. A note says strategies saved on the web do not appear here | S |
| Portfolio Backtester, SIP Backtester, Portfolio Analyzer, Sector Rotation | DOM, pass-through | Their symbol pickers' session search → `/api/v1/search` | `/api/v1/portfolio/*`, `/sip/*`, `/sectorrotation*` with `source='api'`, 120 s timeouts; limits 10/min, 5/min (tearsheet) and 30/min; need 2.0.1.8+ (Sector Rotation 2.0.3.0+). The tearsheet HTML opens natively (section 7.7) | S |

Each on-device route module:
- declares the web route it replaces;
- cites the server service it ports (`openalgo/services/<x>_service.py`);
- returns the **response type of the web page's own API module** (`frontend/api/<x>.ts`), so a frontend bump that changes a shape fails the typecheck.

### 7.9 Chart

**ChartDom** (`'use dom'`) hosts `createWidget` from `openalgo-charts/widget` with `mobile:'auto'`.
- It does **not** use the web's 8,124-line `lib/trading/terminal.ts` or its desktop chrome.
- It does not use the frontend's `OpenAlgoChart` wrapper either, which forces `pollIntervalMs:0` and would freeze the forming bar's volume.

**The host implements:**
1. **Data feed.** `OpenAlgoDataFeed` with a `fetchImpl` bridged to the gateway. The library calls only `history` and `search` itself (`openalgo-charts/src/feed/openalgo-rest.ts:157,180`). The host supplies `symbol` (lot and tick size), `intervals` and `quotes`.
2. **Live data.** `OpenAlgoLiveDataFeed` / `OpenAlgoWsFeed` with a `socketFactory` bridged to native, using the same protocol emulation as the WebSocket shim: Depth 5 or LTP.
   - The library's `SocketLike.onclose` carries no close code (`openalgo-ws.ts:72`), so 1012, 4401 and reconnects are handled entirely in native. The chart's socket simply stays open and keeps receiving ticks.
   - In polling mode the forming bar is fed from polled LTP (section 7.6).
3. **Session calendar.** Built from `/api/v1/market/timings` and `/market/holidays` instead of the session route `/admin/api/timings`. The timings' epochs depend on the server's time zone, so the app checks them against IST market hours and falls back to exchange defaults.
4. **Trading glue.** About 400 lines ported from `terminal.ts`:
   - order and position lines (`2084-2183`);
   - placement guards and exit (`2203-2340`);
   - buttons, drag and click (`2668-2760`);
   - subscriptions (`6585-6620`);
   - order updates and the book timer (`7964-8000`).

   Every action becomes a typed intent to native. The DOM places nothing:
   - BUY/SELL → order ticket;
   - drag a working order → modify review;
   - X → cancel confirm;
   - position close → close confirm.
5. **Storage.** Drawings and preferences go to native storage, keyed by server profile and symbol, because WebView storage is wiped with app data. Syncing to `/api/v1/chart` is not used in phase 1.
6. **Limit or stop at a price.** A long-press gesture, because the web's right-click menu does not exist on touch.

**Props** change rarely: theme, symbol, exchange, interval, indicator set, quantity. Ticks, order lines and positions go through the imperative handle.

**Lost against the web `/trading` page:** custom JS indicators and OpenScript studies, chart alerts (left out of scope), and the desktop multi-pane grid and side panels. The chart's book reconcile poll stays, because some brokers' order events come from a server-side poller.

### 7.10 Mobile app: order safety

- **Order ticket:**
  - BUY/SELL; product (MIS, CNC, NRML, filtered by segment); price type (MARKET, LIMIT, SL, SL-M);
  - quantity in **lots** for derivatives, using the lot size from `/api/v1/symbol`;
  - price and trigger snapped to the tick size; the stop on the correct side of LTP;
  - above a non-zero `freeze_qty`, the order goes through `splitorder`. The review shows the split, and the result shows each child order's status (timeout 30 s or more).
  - These rules come from `lib/trading/terminal.ts`.
- **Margin preview.** `/api/v1/margin`, debounced and optional. It is hidden for the session after a 501.
- **Confirmation.**
  - Every order shows a review step with the LIVE/ANALYZE badge, by default.
  - If enabled, biometrics are required for live orders.
  - Chart BUY/SELL can enable a **one-tap mode** in settings. It is off by default and shows a warning, like the web terminal's One-Click mode.
- **No duplicate sends.**
  - The submit button is disabled while a request is in flight, with a 120 ms cooldown after it.
  - The mutation never retries.
  - A 502 or a timeout shows "Status unknown: checking order book", reconciles against the order book, and never re-sends.
- **Modify** sends `modifyorder` with all 12 fields from the order-book row plus the user's changes.
- **Close one position.** `placesmartorder` with `quantity:"0"`, `position_size:"0"`, the row's exact product and `pricetype:"MARKET"`.
  - The confirm text says it closes the whole net position for that product, across strategies.
  - Some brokers answer HTTP 500 when the position is already flat (seen with ibulls, definedge and tradejini; the list may be incomplete). The app treats **any** 500 on a close as "maybe done" and checks the position book.
- **Close all and cancel all.** `closeposition` and `cancelallorder`, each behind a confirm that names the count.
- **Semi-Auto.**
  - A `mode:"semi_auto"` reply shows "Queued for approval in the web Action Center", with **Open Action Center**.
  - A Semi-Auto 403 on modify, cancel, cancel-all or close-all shows the server's reason and the same link.
  - The app never pretends an order was placed.
- **Analyzer.** Analyzer replies show a sandbox mark. `/api/v1/analyzer` is read on foreground and before each order, cached for 5 s.
- **Strategy tags:** `strategy:"mobile"` for tickets and `"mobile-chart"` for chart actions.
- **Baskets from tools** (Strategy Builder Execute, Arbitrage).
  - The gateway holds the `basketorder` request.
  - Native shows a multi-leg review: each leg, net premium, the LIVE/ANALYZE badge, and biometrics if enabled. The two Arbitrage legs can fill in either order, so the review warns about legging risk.
  - On confirm, the app sends the request once, with no retry. It reports the per-leg `results[]`, including partial success, and offers "view in order book" rather than resending failed legs.
  - Results come back in completion order, not request order, so they are matched to legs by symbol and action.

### 7.11 Mobile app: UI system

- **Theme.** Dark-first, with a light theme. Colours are generated from the web's `index.css` tokens, with oklch converted to hex at build time, so the app and the web look like one product.
- **Trading colours** follow what the web renders:
  - BUY green (`bg-green-600`) and SELL red (`bg-red-600`), as in `PlaceOrderDialog.tsx`;
  - profit green and loss red.
- **Feel.**
  - Dense, Kite-like rows with tabular numbers.
  - A price-change flash that respects reduced motion.
  - Haptics on order actions.
  - Skeletons rather than spinners; explicit empty and error states with a retry (reads only).
- **Native presentation.** Bottom sheets and form sheets for tickets and instrument actions.
- **Connection badges.** "Not encrypted" for http, "Polling" when the live feed is unavailable, "Broker logged out", and LIVE/ANALYZE. They stay visible in the header area.
- **WebView check.** At runtime, detect an Android System WebView older than Chromium 111, whose `oklch` colours break, and prompt the user to update it.

## 8. Security model (summary)

| Threat | Mitigation |
|---|---|
| A stolen or lost phone | App lock; the key in this-device-only hardware-backed storage; optional biometrics before live orders; lost-phone steps: regenerate the key, then log out of the broker or restart OpenAlgo |
| Key capture on the network | https and wss for every public host. http and ws only on home-network addresses, with a persistent warning. A live-feed host that differs from the REST host needs confirmation. The key only in POST bodies, except the few GET-only routes listed in section 7.2 |
| Malicious or compromised web code inside the app | The DOM never holds the key, the server URL or a socket. Per-tool allowlist gateway. Order writes held for native review. A strict CSP. Typed, validated bridge; no navigation |
| Key leakage in logs or backups | Redacting logger; no request bodies logged; secure store excluded from backups; screenshots blocked on the key screen |
| Locking the user out of their own server | The scheduler never retries 403/404 and keeps probes few, which avoids auto-ban. On a plain-text "Access Denied", all traffic stops and the app explains how to unban |
| Starving the user's strategies of rate limit | About 5 req/s app-wide, a serial history lane, polling paused when hidden |
| A fat-finger or duplicate order | Review step, no retries, reconciliation, lot, tick and freeze validation, LIVE/ANALYZE badge |
| Secrets in the repo or bundle | No secrets exist in the app; gitleaks in CI; a bundle scan for key-like strings; signing material only in GitHub secrets |
| A supply-chain attack | Lockfile, Renovate with review, actions pinned by SHA, a read-only workflow token, `npm ci` |

**Residual risk to state plainly to users.** The key has full trading power and cannot be limited per device. This is the cost of working with stock servers.

## 9. Engineering

### 9.1 Repos and code sharing (my call)

- **`openalgo-mobile` stays a separate repo.** Its root becomes the Expo project. `spike/` is deleted once M0 (section 11) passes; history keeps it.
- **Frontend code is consumed by pinned commit, read only.**
  - `openalgo.ref` holds the openalgo SHA.
  - Locally, `scripts/sync-openalgo` checks out `../openalgo` at that SHA, or verifies it is there.
  - CI sparse-checks out `frontend/src` (and `services/` for golden generation).
  - Metro resolves `@/` into it, and the app's `node_modules` stays the only package source, so React is never duplicated.
- **The pinned frontend is independent of users' servers.** It decides only the UI and maths the app ships. Users' servers supply raw `/api/v1` data, and the capability layer bridges version differences.
- Bumping the ref is a deliberate PR that runs the full suite, including the golden regeneration.
- **No openalgo PRs are needed.** Optional upstream fixes, such as the phone layout, may be offered later.

### 9.2 Quality gates

- **Code:**
  - TypeScript strict plus `noUncheckedIndexedAccess`;
  - Biome, matching the frontend;
  - dependency-cruiser boundaries;
  - React Compiler on, and typed routes.
- **Unit tests** (jest-expo + React Native Testing Library):
  - tick store
  - WebSocket client and the WebSocket shim's protocol emulation
  - request scheduler: pacing, lanes, 429 backoff, no-retry rules
  - URL rules: https versus home-network http
  - capability probe and self-heal
  - error classification, including the 403 split
  - gateway allowlists and key injection
  - order-ticket validation
  - zod schemas, against fixtures from openalgo-docs examples and the mock server
  - query-key namespacing
- **Golden parity tests for on-device routes and Black-76.**
  - `scripts/gen-golden` runs the server's own Python service functions at the pinned openalgo SHA (in its uv environment), with their data fetches replaced by recorded `/api/v1` responses. It writes each input/output pair to `test/golden/`.
  - The TypeScript route must reproduce the output within a stated tolerance, exactly for rounded fields.
  - Fixtures are committed and regenerated in CI when `openalgo.ref` changes.
- **Compatibility suite.** `dev/mock-server` emulates stock-server behaviour at **2.0.0.0, 2.0.1.6, 2.0.2.0 and 2.0.3.5**:
  - endpoint presence and how missing endpoints answer;
  - Unknown-field 400s;
  - the 403 ambiguity and plain-text ban;
  - the 429 shapes;
  - WS `INVALID_ACTION` for ping and orders on old versions;
  - the 4401 and 1012 closes;
  - `BROKER_ERROR`;
  - omitted tick fields.

  Onboarding, the capability flags and the trading flows run against each version.
- **End-to-end** (Maestro, Android emulator, against the mock server):
  - onboarding, including http-on-LAN and polling mode
  - watchlist
  - placing and cancelling an order (analyzer)
  - the chart opens
  - a tool opens and shows on-device route output
  - a DOM tool receives live ticks through the WebSocket shim, and falls back to polling when the shim fails

  iOS is build-and-unit-test only in phase 1.
- **Against a real server: a local test server** (product owner, 2026-11-24).
  - **What it is.** The openalgo checkout on the development Mac, run in analyzer mode and logged in to the owner's broker. It is never the owner's live trading server, because analyzer mode switches a whole install.
  - **Credentials.** Its URL and API key live in a git-ignored `.env.test.local`. A gitleaks rule and a pre-commit check keep them out of commits.
  - **`scripts/record-fixtures`**, run during market hours, records the `/api/v1` responses that feed the golden tests: option chains, history, quotes, expiries and the instruments CSV. It records each broker field exactly as returned and strips the key.
  - **`scripts/real-server-check`** runs the release checklist against the test server: onboarding, books, analyzer orders, modify, cancel, the live feed and each tool.

### 9.3 CI/CD (GitHub Actions)

| Trigger | Jobs |
|---|---|
| Every PR | Lint, typecheck, unit and golden tests, compatibility suite, `expo-doctor`, `expo export` for Android and iOS (catches the DOM chunk bug), bundle-size budgets, DOM import-boundary check, gitleaks, Android release build, iOS simulator build |
| `openalgo.ref` change | Golden regeneration (Python, uv) and a diff review |
| Push to `main` | All of the above, plus Maestro end-to-end, the unsigned IPA, and signed builds when secrets exist |
| Tag `v*` | Signed APK attached to a GitHub Release (with its SHA-256 checksum); signed IPA uploaded to TestFlight (fastlane `pilot` with an App Store Connect API key) |

- **Signing material** lives in GitHub secrets:
  - Android: a new release keystore, kept so every APK update installs over the previous one;
  - Apple: the distribution certificate and profile (or fastlane match), plus the App Store Connect API key.
- **TestFlight.** Internal testers (up to 100 App Store Connect users) need no review. External testers go through Apple's beta review, which needs a reachable demo OpenAlgo server in analyzer mode and its login details.
- **Versioning.** Semver marketing version; the build number comes from the CI run number via `app.config.ts`; the app declares its minimum server version, 2.0.0.0.
- **Renovate** updates dependencies weekly, with Expo SDK packages grouped and checked by `npx expo install --check`.

### 9.4 Docs

- **In this repo:** a README covering setup per deployment type (section 7.1), the `.env` lines for home-PC installs, the cloudflared `/ws` rule, lost-phone steps, and what Semi-Auto users can and cannot do.
- **In `openalgo-docs`:** `trading-platform/mobile-app.md` still describes the Flutter app. Rewriting it is an optional PR, opened only with the product owner's OK.

## 10. Data the app reads and writes

All server calls use the API key, and all are on a stock server.

| Need | Endpoint |
|---|---|
| Version and capabilities | `GET /auth/app-info` (public), `GET /api/v1/swagger.json` (public), `POST /api/v1/<x> {}` probes |
| Key and broker checks | `/api/v1/search` (key only), `/api/v1/ping` |
| Books and funds | `/api/v1/orderbook`, `tradebook`, `positionbook`, `holdings`, `funds`, `orderstatus` |
| Place, modify, cancel | `/api/v1/placeorder`, `splitorder`, `modifyorder`, `cancelorder` |
| Close and bulk | `/api/v1/placesmartorder` (close one), `closeposition`, `cancelallorder`, `basketorder` |
| Margin | `/api/v1/margin` |
| Quotes, depth, symbol | `/api/v1/quotes`, `multiquotes`, `depth`, `symbol` |
| History, intervals, calendar | `/api/v1/history`, `intervals`, `market/timings`, `market/holidays` |
| Search, expiries, symbol master | `/api/v1/search`, `expiry`, `GET /api/v1/instruments` (daily, CSV) |
| GET-only tool lookups | `GET /api/v1/portfolio/benchmarks`, SIP `frequencies`, Sector Rotation `options` (when those tools open) |
| Options | `/api/v1/optionchain`, `multioptiongreeks` (where a page uses it) |
| Analyzer | `/api/v1/analyzer`, `/api/v1/analyzer/toggle` |
| Tools (pass-through) | `/api/v1/portfolio/*`, `/sip/*`, `/sectorrotation*` |
| Live data | WebSocket: `authenticate` (api_key), `subscribe` (LTP, Quote, Depth), `subscribe_orders`, `ping` |
| Stored on the phone | Watchlists, Strategy Portfolio, chart drawings and preferences, the symbol master, history day caches, capability cache: all keyed by server profile |

## 11. Milestones

Each milestone ends with something running on a device or simulator.

| # | Milestone | Exit criteria |
|---|---|---|
| **M0** | **Device gate.** The product owner runs the spike release APK on a budget Android phone (3–4 GB RAM) per `spike/README.md` and sends the results JSON. In parallel, scaffold the repo and the CI quality gates | Chart and Max Pain meet the section 12 bars. If either fails, stop and re-plan the DOM approach |
| **M1** | **App foundation.** Onboarding (URL rules, version check, key, live-feed test), Account server settings, key storage, app lock, HTTP client, scheduler and error model, capability probe, WebSocket client, tick store and polling fallback, UI kit and tokens, tabs, LIVE/ANALYZE badge and analyzer toggle, diagnostics, lost-phone help; the stock-server mock and compatibility suite. The Android release keystore is created here, so preview APKs install over each other | Connect to the local test server; live LTP on a watchlist row; polling mode works over an https tunnel; onboarding passes against mock 2.0.0.0 and 2.0.3.5 |
| **M2** | **Trading core (native).** Watchlists and the index strip, search, quote and depth, order ticket (place, split, modify, cancel), books, positions (close one, close all), cancel all, holdings (with Sell), funds, Semi-Auto handling, broker-logged-out handling | A full analyzer-mode trading loop on device, under Maestro |
| **M3** | **Chart.** ChartDom with createWidget, bridged data feed and ticks, session calendar, ported trading glue, native order intents, native drawing storage | Chart open ≤ 2.5 s; pan ≥ 30 fps on the M0 phone; drag-to-modify goes through native review |
| **M4** | **Tools, part 1.** First, a WebGL check: Vol Surface's Plotly 3D on the M0 phone, with a 2D strike × expiry heatmap as the fallback. Then the ToolDom shell, gateway, WebSocket shim, phone stylesheet, CSP, on-device route framework, symbol master, Black-76 wrapper (both modes) and golden pipeline. Native Option Chain. Pass-through tools (Portfolio Backtester, SIP Backtester, Portfolio Analyzer, Sector Rotation). OI Tracker, OI Range, Max Pain, IV Smile, GEX, Gamma Density | These 11 tools open on device within budget at 360 px; golden tests green |
| **M5** | **Tools, part 2.** Strike Profile, Vol Surface, Option Greeks, OI Profile, Straddle Chart, Straddle PnL, Strategy Builder (with native basket review), Strategy Portfolio (device), native Arbitrage | All 20 tools work on device; baskets go through native review; golden tests green |
| **M6** | **Hardening and release.** Performance pass on device, security review, README setup docs, signed APK on GitHub Releases, IPA on TestFlight for internal testers | Release checklist green against the local test server; the first TestFlight build installs on an iPhone |

**Planning order.** M0 and M1 are planned in detail now. M2 follows. M3–M5 depend on DOM performance, so they are planned in detail only once the M0 phone results are in.

## 12. Performance and request budgets

These carry over from the spike (`spike/app/src/core/results.ts:27-36`). They are measured on the M0 budget phone before each release.

| Bar | Budget |
|---|---|
| Native UI fps | ≥ 55 |
| Native JS fps | ≥ 45 |
| Slow frames | ≤ 5% |
| Chart open | ≤ 2.5 s |
| Chart pan | ≥ 30 fps |
| Tool open (excluding first-load history fetches) | ≤ 2.5 s |
| Tool memory | ≤ 250 MB |
| Cold start (`adb am start -W` TotalTime) | ≤ 3.5 s |

**Every PR** checks bundle budgets: Hermes 4.34 MB, chart DOM 2.33 MB and tool DOM 1.9 MB after tree shaking; more than 5% growth fails.

**Request budgets.** The scheduler enforces these, and the compatibility suite asserts them.
- App-wide: about 5 req/s sustained.
- A watchlist with the live feed: 0 steady REST calls.
- In polling mode: at most about 1 req/s for the visible screen (section 7.6 lists each consumer's rate).
- WebSocket: at most 500 symbols across the app.
- A chart screen: about 8 calls at load and about 4/min steady.
- No screen polls while hidden.

**A diagnostics build** keeps the spike's bench harness and emits JSON for release checks.

## 13. Risks

| Risk | Mitigation |
|---|---|
| DOM chart or tools are too slow on budget phones (unmeasured) | The M0 gate comes before any DOM-dependent work. Fallback: native rewrites of the worst pages |
| On-device routes drift from the server's maths | Golden tests from the server's Python on every ref bump; route outputs typed by the web's own API types |
| Version quirks on older servers | Capability probe, field gating, read-only self-heal, and a compatibility suite at four versions |
| `/auth/app-info` or `swagger.json` disappears in a future release (neither is official) | Marker probes; never refuse a server that passes the 2.0.0.0 marker; nothing depends on them beyond detection |
| The live feed is unreachable on many home and tunnel setups | Polling mode with honest badges; setup help with the exact `.env` lines and the cloudflared rule |
| The API key on the phone has full power and can't be revoked per device | Secure storage, app lock, optional biometrics, lost-phone steps; stated plainly in the app and README |
| Shared rate limits or auto-ban hurt the user's other tools | Scheduler budgets, serial history, no retries on 403/404, few probes, ban detection |
| The instruments download is large (tens of MB of JSON for NFO; unmeasured) | CSV, lazy, F&O exchanges only, daily, off the UI thread, fallback to defaults plus search. Measure in M4 |
| OI Profile and Straddle PnL are slow on first load (server-wide history pacing; 30–60 s) | Progress UI, 2–3 calls in flight, day caches, trimming to N days before fetching strikes |
| OpenAlgo Desktop behaves differently from the Flask server | Marked unverified; tested in M1 if a build is available |
| Vol Surface's WebGL (Plotly 3D) fails on budget Android WebViews | Checked at the start of M4; 2D heatmap fallback |
| Licence: the app bundles AGPL code (the openalgo frontend, with outside contributors) and ships through Apple | The product owner's decision, needed before the TestFlight or App Store track (section 15). It does not change M0–M5 |
| Semi-Auto users can't manage orders in the app | Clear banners and a deep link to the web Action Center; documented |
| `market/timings` epochs depend on the server's time zone | Sanity check against IST hours; fall back to exchange defaults |
| Expo DOM chunk bug or SDK churn | The `expo export` CI check; pinned SDK; an upstream issue filed |
| TestFlight external testing (and later the App Store) needs a reviewer-accessible demo server | Start with internal testers; stand up a demo server in analyzer mode before external testing |
| Phase 1 needs an Apple Developer account and an Android release keystore | Signing secrets are added before M6; CI already builds unsigned until then |

## 14. Calls I made (please check)

1. **Tools reuse the web pages unchanged in DOM, and the 14 session routes are reimplemented on the phone** from `/api/v1` data, held to the server's numbers by golden tests (section 4.3). No openalgo PRs are needed.
2. **The native layer acts as the server for web code**: a placeholder key in the DOM, real-key injection in native, and WebSocket protocol emulation (section 7.7).
3. **Several named watchlists per server**, kept on the phone as decided, with Back up and Restore through a JSON file.
4. **Strategy Portfolio is device-local**, with a note that web-saved strategies don't appear. It is included in the backup.
5. **A daily symbol master from `/api/v1/instruments` (CSV)**, even though it puts the key in the user's own server access log once a day. It is the only complete source for underlyings, futures and the Arbitrage universe.
6. **The chart uses the openalgo-charts widget directly**, with about 400 lines of ported trading glue. Drawings and preferences stay on the phone, with no `/api/v1/chart` sync in phase 1.
7. **Version detection** uses `/auth/app-info`, then the swagger path list, then marker probes. Minimum 2.0.0.0, as decided.
8. **Broker-logout detection** with a single `/api/v1/search` check after a 403.
9. **Scheduler budgets:** about 5 req/s app-wide, history one at a time, polling 2 s on LAN and 5 s on tunnels.
10. **The analyzer toggle is hidden once Semi-Auto is seen**, and its confirm says the switch is install-wide.
11. **A review step before every order by default.** One-tap chart trading and biometrics are opt-in.
12. **Native vs DOM split:** Option Chain and Arbitrage native, the other 18 tools in DOM.
13. **App id `in.openalgo.mobile`, display name "OpenAlgo".** Users of the old app must install the new one; its device-only watchlist does not migrate.
14. **BUY green and SELL red**, as the web order ticket renders (not the blue and orange of the earlier draft).
15. **No OTA updates and no crash reporting service in phase 1.** Local logs only.
16. **GTT is out of phase 1.**
17. **TestFlight is for internal testers in phase 1.** External testing waits for a demo server in analyzer mode.
18. **Servers behind an extra access layer are not supported in phase 1** (section 2).
19. **Two modes in the Black-76 wrapper:** spot-priced to match the session-route tools, and forward-priced to stand in for `with_greeks` on servers before 2.0.2.0.
20. **Polling-mode fallbacks for every live screen**, at the rates in section 7.6, plus an app-wide 500-symbol WebSocket budget.

## 15. Questions for the product owner

All answered and folded into the sections above:

| Question | Answer |
|---|---|
| How is the app distributed in phase 1? | Android APK on GitHub Releases; iPhone through TestFlight; store listings after phase 1 (2026-11-23) |
| Who runs the M0 phone test? | The product owner, with the spike APK from GitHub Actions (2026-11-23) |
| Change the server, or work with what people run? | Work with the existing API, as the Flutter app did (2026-11-23) |
| https only, or also home-network http? | http allowed for home-network addresses only, with a warning (2026-11-24) |
| Oldest supported server? | 2.0.0.0 (2026-11-24) |
| Where do watchlists, saved strategies and drawings live? | On the phone only, with backup and restore (2026-11-24) |
| What does testing against real data use? | A local test server on the development Mac, in analyzer mode, logged in to the owner's broker (2026-11-24) |

**Open, for the product owner (does not block M0–M5):**
- **Licence.** The app bundles AGPL code from the openalgo frontend, which has outside contributors, and ships through Apple's TestFlight and later the App Store. How the AGPL fits Apple's distribution terms needs the owner's decision before the iOS release track.
- **M0 phone results** from the spike APK, which gate M3–M5.

## 16. Left to the builder

- Whether to use one ToolDom or several, decided by the section 12 measurements.
- The exact `originWhitelist` and file-access settings that release DOM builds need.
- Per-tool allowlist contents, derived from each page's API module.
- Tolerances for each golden test where the server does not round.
- Whether the web's Black-76 engine passes the opengreeks goldens, or a dedicated engine is needed behind the wrapper.
- How the mock server records and replays per-version behaviour.
- Maestro flow details.
- Storage engine choices for device data (SQLite for the symbol master; key-value storage for the rest).
