# M0 + M1: Scaffold, CI and App Foundation (Stock Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** M0 turns the repo root into the Expo app, with CI gates. M1 builds the foundation for an unmodified OpenAlgo ≥ 2.0.0.0, reached over `/api/v1` and the WebSocket proxy. It covers:
- onboarding, key storage and app lock;
- the HTTP client, scheduler, error model and capability probe;
- live data with market depth, plus a polling fallback;
- the UI kit, tabs, Account and a minimal live watchlist;
- a per-version mock server and a compatibility suite.

**Architecture:**
- **Pure TypeScript core.** Core logic takes its dependencies as parameters (`fetch`, a key-value store, the WebSocket constructor, timers, the clock), so jest runs it without native modules. Hooks and native bindings live in separate files.
- **Mock server.** `dev/mock-server` emulates a stock server for each version.
- **Market depth** is in the realtime layer now: mode 3 with `depth` 5/20/30, depth in the tick store, and `/depth` polling. The depth screen is Plan B (M2).

**Tech Stack:** Expo SDK 58 (expo ~58.0.26, React Native 0.88.1, React 19.3.0, Hermes); expo-router ~58.0.32; React Compiler; TypeScript ~6.0.3; zod 4.6.7; TanStack Query 5.108.3; zustand 5.0.15; expo-secure-store, expo-local-authentication and expo-screen-capture; jest-expo ~58.0.15; Biome 2.6.8; dependency-cruiser 18.9.0; gitleaks 8.30.1; Maestro 2.12.1 (CI only).

**Spec:** `docs/superpowers/specs/2026-11-23-openalgo-mobile-phase1-design.md`, sections 5, 7.1–7.6, 7.11, 8, 9, 11 and 12. This plan supersedes `2026-11-23-app-foundation.md` and the withdrawn `2026-11-23-server-app-auth.md` (Task 1 Step 0 marks both); it needs neither.

## Global Constraints

- **Server:** unmodified OpenAlgo ≥ `2.0.0.0`. The app uses only `/api/v1` (apikey in the JSON body), `GET /auth/app-info`, `GET /api/v1/swagger.json` and the WS proxy (`api_key` authenticate). No OAuth, bearer tokens, tickets, session routes or server changes.
- **Identity:** `in.openalgo.mobile`, display name `OpenAlgo`, `extra.minServerVersion = '2.0.0.0'`.
- **URL rule (REST and WS):**
  - https/wss for public hosts;
  - http/ws only for home-network hosts (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, `*.local`), shown with a "Not encrypted" badge;
  - `localhost` and `127/8` only when `__DEV__`;
  - enforced in app code. Android cleartext is global. iOS uses `NSAllowsLocalNetworking`, never `NSAllowsArbitraryLoads`.
- **REST headers:** every request sends `ngrok-skip-browser-warning: 1`, `Accept: application/json` and `credentials: 'omit'`. Every POST, `probe` included, also sends `Content-Type: application/json`: under Flask 3.1.3/Werkzeug 3.1.9, `request.json` refuses React Native's default `text/plain`, and the restx handlers turn that into 500 `"An unexpected error occurred"` (`restx_api/search.py:47-58`).
- **The key:**
  - must match `^[0-9a-f]{64}$`;
  - is stored in SecureStore under `oa.<profileId>.apikey` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, and held in memory only while unlocked;
  - never appears in zustand, logs, query keys, diagnostics or URLs. M1 calls no GET-only route.
- **Retries:** only TanStack reads on `Network`/`Server` (at most 2) and the read-only Unknown-field self-heal (once). Never on 401/403/404, order endpoints or `MaybePlaced`.
- **Budgets:**
  - app-wide: about 5 req/s, with one read in flight per endpoint plus args;
  - smart orders: at least 500 ms apart;
  - history: at most 3 in flight and 3 starts/s;
  - 429: back off from 2 s, doubling to 30 s, ignoring `retry_after`;
  - WS: at most 500 symbols;
  - a live watchlist makes 0 steady REST calls; polling makes about 1 req/s or less; nothing polls while hidden.
- **Code:**
  - TS `strict` plus `noUncheckedIndexedAccess`;
  - Biome as on the web: 2 spaces, width 100, single quotes, `semicolons: asNeeded`;
  - `~/*` maps to `src/*`; tests sit next to the code, and `scripts/` and `dev/` use `node:test`;
  - pure core: `src/core/{config,log,http,capabilities,realtime,credentials}` imports no `react-native` or `expo-*`, except in `use*.ts(x)` and `bindings.ts`.
- **CI:**
  - actions pinned by SHA:

    | Action | Version | SHA |
    |---|---|---|
    | checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
    | setup-node | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
    | setup-java | v6.3.0 | `d1374f8ac74474200d16ef8ecee22c7ae7a51880` |
    | upload-artifact | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
    | android-emulator-runner | v2.38.0 | `a421e43855164a8197daf9d8d40fe71c6996bb0d` |

  - `contents: read`, `persist-credentials: false`, `npm ci`, Node 26.
- **Disk:** no local prebuild, gradle, xcodebuild or `expo run:*`. Delete `dist-export/` after each check.
- **Process:**
  - work on branch `phase1/foundation`, created from `phase1/design-and-plans`; never push;
  - every commit adds `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`;
  - evidence goes in the PR description, never in status files.

## Review Focus

1. **Pasted keys** (scan-text spaces and line breaks, uppercase hex, `api key: <key>`). Expected: whitespace stripped and hex lowercased; anything else refused locally, with nothing sent. Test: Task 10 **(RF 1)**.
2. **Something else answers** (captive portal, ngrok interstitial, nginx error page). Expected: "This doesn't look like an OpenAlgo server", never "Update OpenAlgo", and at most 10 probes. Test: Task 9 **(RF 2)**.
3. **Key regenerated mid-session.** Expected: 20 concurrent 403s produce one `/search` call, then the `banner-key` prompt, with the scheduler halted and the socket stopped; a WS `AUTHENTICATION_ERROR` leads to the same state. Tests: Task 11 and Task 18 **(RF 3)**.
4. **Tunnel `/ws` returns 404 forever.** Expected: 3 handshakes at onboarding, then polling. At runtime, at most 10 reconnects, then one retry per 10 min on foreground. Test: Task 15 **(RF 4)**.
5. **Phone not on IST.** Expected: market-hours decisions identical to IST. Test: Task 13 **(RF 5)**.

---

## Stock-server contract

The app and `dev/mock-server` both match this contract. Line references are to openalgo at `c8b2896` (VERSION 2.0.3.5).

**S1. Key.** 64 lowercase hex characters (`secrets.token_hex(32)`, `blueprints/apikey.py:42`), one per user, with no scopes.

**S2. Envelopes.**
- Requests are `POST /api/v1/<endpoint>`, with no trailing slash and `"apikey"` in the JSON body.
- Success is `{"status":"success","data":…}`; multiquotes returns `"results"` instead of `"data"`.
- Errors are `{"status":"error","message":…}`.
- Numbers may arrive as strings.

| Endpoint | Response |
|---|---|
| `ping` | `data{message:"pong", broker}` |
| `funds` | `data{availablecash:"320.66", collateral, m2mrealized, m2munrealized, utiliseddebits}` |
| `search {query, exchange?}` | `data[{symbol, name, exchange, token, expiry, strike, lotsize, instrumenttype, tick_size, freeze_qty?}]`, possibly empty |
| `analyzer` | `data{mode:"live"\|"analyze", analyze_mode, total_logs}`; `analyzer/toggle {mode: bool}` adds `message`; 409 "Another mode change is still in progress. Try again in a moment." |
| `multiquotes {symbols:[{symbol, exchange}]}` | `results[{symbol, exchange, data{ltp, prev_close, open, high, low, volume, oi, bid, ask}}]`; an invalid entry has `error` and no `data` |
| `depth {symbol, exchange}` | `data{ltp, ltq, open, high, low, prev_close, volume, oi, totalbuyqty, totalsellqty, bids[{price, quantity}]×5, asks[…]}` |

**S3. The 403 split.**
- `403 {"status":"error","message":"Invalid openalgo apikey"}` means either a bad key or a logged-out broker (`services/place_order_service.py:378-382`; ping and funds behave the same way).
- `search` checks only the key (`services/search_service.py:28-32`). `funds` checks the broker.
- `ping` can stay 200 after the 03:00 IST expiry.
- A Semi-Auto refusal is a 403 whose message contains `Semi-Auto mode`.

**S4. Ban.** Either `403 text/plain` with body `Access Denied: Your IP has been banned` (`utils/security_middleware.py:66-72`), or `403 application/json` with body `{"error":"Access Denied"}` and no `status` (`:130-132`).

**S5. 429** comes in three shapes:
- restx `{"message":"10 per 1 second"}` (inferred);
- broker-busy `{"status":"error","message":…}` (`services/broker_busy.py:49-51`);
- nginx HTML (`install/install-docker.sh:776`).

`retry_after: 60` is a constant; ignore it.

**S6. Missing endpoint.**
- before 2.0.0.0: `404 text/html`;
- 2.0.0.0 to 2.0.2.0: `200 text/html`;
- from 2.0.2.1: `404 {"status":"error","message":"Not found","path":…}` (`app.py:658-659`).

**A reply counts only if it is JSON with a string `status`.** Session-less 404s feed auto-ban when it is enabled (100 per day, permanent).

**S7. Unknown field (400).** Four shapes:
- placeorder and analyzer: the first line below;
- history, funds, quotes, multiquotes, depth, search and ping: the second;
- optionchain: the third; multioptiongreeks: the fourth (`restx_api/multi_option_greeks.py:90-97`).

```json
{"status":"error","message":"{'source': ['Unknown field.']}"}
{"status":"error","message":{"source":["Unknown field."]}}
{"status":"error","message":"Validation error","errors":{"with_greeks":["Unknown field."]}}
{"status":"error","message":"Validation failed","errors":{"extra":["Unknown field."]}}
```
`errors` is read whenever it is present, whatever `message` says.
`POST {}` without a key, sent to an existing endpoint, returns 400 JSON (missing `apikey`) before any key lookup. That is the presence probe.

**S8. `GET /auth/app-info`** (public, from 2.0.0.0, `blueprints/auth.py:1267-1272`) returns `{"status":"success","version":"2.0.3.5","name":"OpenAlgo"}`. Accept only JSON with a string `version`, and map `2.0.1.17` to `2.0.1.7`.

**S9. `GET /api/v1/swagger.json`** is public and has no rate limit. `paths` keys look like `/placeorder/`, `/portfolio/benchmarks`, `/market/timings/`; the endpoint id is the key with the slashes trimmed. Ignore `info.version`.

**S10. Version gates.**

| From | Adds | Below it, the app |
|---|---|---|
| 2.0.0.0 | app-info, WS ping/pong, `multioptiongreeks` (the marker), `history.source` (most builds) | shows "Update OpenAlgo" |
| 2.0.0.5 | WS close 4401 after 15 s without auth | – |
| 2.0.1.6 | `subscribe_orders` / `order_update` | polls the books |
| 2.0.1.8 | `portfolio/*`, `sip/*` | hides the tools |
| 2.0.2.0 | `optionchain.with_greeks`/`interest_rate`; `expiry_ts`, `server_ts`, `forward_price`, `underlying_symbol` | computes Greeks on the device |
| 2.0.2.1 | JSON 404 | treats HTML 200 as missing |
| 2.0.3.0 | `sectorrotation` | hides the tool |
| 2.0.3.3 | absent tick fields omitted (before: 0) | treats price fields ≤ 0 as absent |
| 2.0.3.5 | WS close 1012 on broker re-login | runs a tick-silence watchdog |

**S11. WebSocket** (`websocket_proxy/server.py`). Errors have no `type`.
```jsonc
→ {"action":"authenticate","api_key":"<key>"}
← {"type":"auth","status":"success","message":"Authentication successful","broker":"zerodha","user_id":"u1","supported_features":{"ltp":true,"quote":true,"depth":true}}
← {"status":"error","code":"AUTHENTICATION_ERROR","message":"Invalid API key"}
← {"status":"error","code":"BROKER_ERROR","message":"No broker configuration found for user"}   // socket stays open, useless
→ {"action":"subscribe","symbols":[{"symbol":"RELIANCE","exchange":"NSE"}],"mode":3,"depth":20}
← {"type":"subscribe","status":"success"|"partial","subscriptions":[{"symbol":"RELIANCE","exchange":"NSE","status":"success","mode":"Depth","depth":20,"broker":"angel"}],"message":"Subscription processing complete","broker":"angel"}
   // failed entry {"symbol","exchange","status":"error","message","broker"}; before 2.0.1.1 "mode" echoes the request
← {"type":"market_data","symbol":"RELIANCE","exchange":"NSE","mode":3,"broker":"angel","data":{"ltp":1424.0,"ltt":1732421234,"open":1415.0,"high":1432.5,"low":1408.0,"close":1418.0,"volume":100000,"oi":0,"average_price":1421.2,"total_buy_quantity":591351,"total_sell_quantity":835701,"depth":{"buy":[{"price":1423.9,"quantity":10,"orders":2}],"sell":[{"price":1424.1,"quantity":7,"orders":1}]}}}
→ {"action":"unsubscribe","symbols":[{"symbol":"RELIANCE","exchange":"NSE","mode":3}],"mode":3}
← {"type":"unsubscribe","status":"success"|"partial"|"error","message":"Unsubscription processing complete","successful":[…],"failed":[…],"broker":"angel"}
→ {"action":"subscribe_orders"}
← {"type":"subscribe_orders","status":"success","message":"Subscribed to order updates"}
← {"status":"error","code":"INVALID_ACTION","message":"Invalid action: subscribe_orders"}          // before 2.0.1.6
← {"type":"order_update","user_id","mode":"live"|"analyze","broker","orderid","symbol","exchange","action","quantity","price","trigger_price","pricetype","product","order_status","filled_quantity","pending_quantity","average_price","rejection_reason"}
→ {"action":"ping"}
← {"type":"pong","status":"success","server_timestamp":1732421234000}
```
- **Error codes:** AUTHENTICATION_ERROR, NOT_AUTHENTICATED, BROKER_ERROR, BROKER_INIT_ERROR, BROKER_CONNECTION_ERROR, BROKER_LIST_ERROR, INVALID_MODE, INVALID_PARAMETERS, INVALID_ACTION (its message names the action), INVALID_JSON, SERVER_ERROR, PROCESSING_ERROR.
- **`BROKER_*` proves nothing alone.** `BROKER_INIT_ERROR` and `BROKER_CONNECTION_ERROR` come from adapter connect failures that can be transient (`:1032-1051`), and `BROKER_ERROR "Broker adapter not found"` also answers subscribe and unsubscribe (`:1274, :1524`).
- **Close codes:** 4401 `auth timeout` (from 2.0.0.5); 1012 `Broker credentials changed` (from 2.0.3.5).

**S12. Modes and ticks.**
- Modes are 1 LTP, 2 Quote, 3 Depth. The app always sends the numeric mode, plus `depth` (default 5) with mode 3.
- Unsubscribe carries the numeric `mode` on each symbol, because 2.0.0.0 matches on it and defaults to 2.
- Every tick field is optional. Depth ticks also carry the quote fields.
- Brokers pad missing depth levels with price 0 (`broker/zerodha/api/data.py:660`, `broker/angel/streaming/angel_adapter.py:870`), in REST and WS alike.
- The ack's `depth` is `actual_depth` when the adapter reports it (22 of 39 adapters), otherwise an echo of the request (`websocket_proxy/server.py:1321`). Zerodha ignores `depth_level` and sends 5 levels under an ack of 20 (`zerodha_adapter.py:263-272, 739`). So `confirmedDepth = min(ack depth, the largest count of levels with price > 0 seen in one depth tick)`, undefined until the first depth tick.
- The server sends transport pings every 20 s; React Native answers them itself.

---

## File structure

```
root        package.json app.config.ts tsconfig.json biome.json jest{,.compat,.real}.config.js openalgo.ref bundle-baseline.json
            .dependency-cruiser.cjs .gitleaks.toml renovate.json .env.test.example .githooks/ plugins/
src/app/    _layout (onboarding)/* (app)/_layout (app)/(tabs)/* (app)/account/* (app)/help
src/core/   config log http capabilities credentials realtime query platform services   (files named in each task)
src/ui/     tokens(generated) + components (Task 17)      src/features/{onboarding,account,watchlist}/
dev/mock-server/  scripts/  test/{helpers,fixtures,compat,real}/  e2e/  .github/{workflows,actions}/
```

In run steps, "→ FAIL" means the module is missing, and "→ PASS" means every test in the command passes.

---

## M0: scaffold and CI

### Task 1: Expo project at the repo root

**Files:**
- Create: `package.json`, `app.config.ts`, `tsconfig.json`, `biome.json`, `jest.config.js`, `jest.compat.config.js`, `jest.real.config.js`, `jest.setup.ts`, `expo-env.d.ts`, `src/app/_layout.tsx`, `src/app/index.tsx` (removed in Task 18), `test/app.config.test.ts`, `test/compat/env.test.ts`.
- Copy: the icon and splash PNGs from `spike/app/assets/images/`.
- Modify: add `/android/ /ios/ /openalgo/ .expo/ dist-export/ coverage/ *.tgz !.env.test.example` to `.gitignore`.

**Interfaces:** npm scripts:

| Script | Command |
|---|---|
| `lint` | `biome ci .` |
| `typecheck` | `tsc --noEmit` |
| `test` | `jest` |
| `test:compat` | `jest -c jest.compat.config.js --runInBand` |
| `test:scripts` | `node --test "scripts/**/*.test.mjs" "dev/**/*.test.mjs"` |
| `boundaries` | `depcruise src --config .dependency-cruiser.cjs` |
| `export` | `expo export --platform android --platform ios --output-dir dist-export` |
| `bundles` | `node scripts/check-bundles.mjs dist-export` |
| `mock` | `node dev/mock-server/main.mjs` |
| `real-server-check` | `jest -c jest.real.config.js --runInBand` |

Task 2 adds `tokens`, `tokens:check` and `sync-openalgo`.

- [ ] **Step 0: Commit the inputs (with the owner's OK).** The revised design and both 2026-11-24 plans are uncommitted. On `phase1/design-and-plans`:
  - under the title of `2026-11-23-app-foundation.md` and `2026-11-23-server-app-auth.md`, add `> **Superseded by the 2026-11-24 plans. Do not execute.**`;
  - `git add docs/superpowers && git commit -m "docs: revised phase 1 design and the 2026-11-24 plans" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
- [ ] **Step 1: Preconditions.**
  - `git status --short` must print nothing. Then run `git switch -c phase1/foundation phase1/design-and-plans`.
  - `df -g . | awk 'NR==2{print $4}'` must print ≥ 4. Otherwise stop and ask the owner to free space. The regenerable, git-ignored candidate is `spike/app/node_modules` (2.7 GB). Never delete anything without the owner's OK.
- [ ] **Step 2: `package.json`.** `openalgo-mobile`, version `0.1.0`, private, `main: "expo-router/entry"`.
  - **Dependencies:** the spike's own, at its specifiers, minus @expo/ui, @radix-ui/*, axios, class-variance-authority, clsx, cmdk, expo-glass-effect, expo-image, lucide-react, openalgo-charts, plotly.js, react-dom, react-native-web, react-plotly.js, sonner and tailwind-merge.
  - **Added:** expo-secure-store ~58.0.3, expo-crypto ~58.0.8, expo-local-authentication ~58.0.3, expo-screen-capture ~58.0.6, expo-application ~58.1.2, @react-native-community/netinfo 12.0.1, @react-native-async-storage/async-storage 2.2.0, @tanstack/react-query 5.108.3, zod 4.6.7.
  - **Dev:** typescript ~6.0.3, @types/react ~19.3.0, jest 30.5.2, jest-expo ~58.0.15, @react-native/jest-preset 0.88.1, test-renderer 1.3.0, @testing-library/react-native 14.1.0, @types/jest 30.0.0, @biomejs/biome 2.6.8, dependency-cruiser 18.9.0, culori 4.0.2, postcss 8.5.23, tailwindcss 4.3.0, ws 8.22.2, expo-doctor 1.21.8.
  - Run `npm install` → lockfile written, no `ERR!`.
- [ ] **Step 3: Failing tests.** `test/app.config.test.ts`:
  - identity, and `version === pkg.version`;
  - `BUILD_NUMBER` `'42'` gives versionCode 42 and buildNumber `'42'`; unset gives 1; `'4x'` throws `/BUILD_NUMBER must be a positive integer/`;
  - `allowBackup === false`, and the `expo-build-properties` entry has `android.usesCleartextTraffic: true`;
  - `NSAppTransportSecurity` equals `{ NSAllowsLocalNetworking: true }`, with no `NSAllowsArbitraryLoads` anywhere;
  - `NSLocalNetworkUsageDescription` is `'OpenAlgo connects to your OpenAlgo server on your home network.'`;
  - `extra.minServerVersion` is `'2.0.0.0'`; `typedRoutes` and `reactCompiler` are on;
  - tsconfig `exclude` contains `openalgo`, and all three jest configs list `<rootDir>/openalgo/` in `testPathIgnorePatterns` and `modulePathIgnorePatterns`.

  `test/compat/env.test.ts`: `fetch` and the `ws` `WebSocket` exist.
- [ ] **Step 4:** `npx jest test/app.config.test.ts` → FAIL.
- [ ] **Step 5: Implement.**
  - **app.config.ts:** slug `openalgo-mobile`, portrait, `userInterfaceStyle: 'automatic'`, the spike's adaptive icon.
  - **Plugins:**
    - `expo-router`;
    - `expo-splash-screen` with `{ backgroundColor: '#0a0a0a', image, imageWidth: 76 }`;
    - `expo-local-authentication` with `{ faceIDPermission: 'OpenAlgo uses Face ID to unlock the app.' }`;
    - `expo-build-properties` with `{ android: { usesCleartextTraffic: true } }`.
  - **Tooling.** CI checks the web frontend out into `openalgo/` (Task 4), with 273 `*.test.ts(x)` files, so every tool skips it:
    - tsconfig extends `expo/tsconfig.base` and excludes `spike`, `dev`, `scripts` and `openalgo`;
    - Biome's `files.includes` negates `src/ui/tokens.ts`, `spike/**`, `test/fixtures/**` and `openalgo/**` (`!openalgo/**`).
  - **Jest:**
    - the main config uses the `jest-expo` preset, the official AsyncStorage and NetInfo mocks, and the `~` mapper, and ignores `spike`, `dev`, `scripts`, `test/compat` and `test/real`;
    - the compat and real configs use a `node` environment, `babel-jest` with `babel-preset-expo`, their own folder only, and a 60 s timeout;
    - all three put `<rootDir>/openalgo/` in `testPathIgnorePatterns` and `modulePathIgnorePatterns`. It is anchored because a bare `/openalgo/` also matches any parent directory of that name.
  - **Root layout:** a headerless `<Stack />`.
- [ ] **Step 6:** `npx jest test/app.config.test.ts && npm run test:compat && npm run typecheck && npm run lint && npx expo install --check && npx expo-doctor && npm run export && rm -rf dist-export` → PASS, plus "Dependencies are up to date", "No issues detected" and "Exported: dist-export". If `install --check` proposes patch bumps, take them.
- [ ] **Step 7:** `git add -A . ':!spike' && git commit -m "build: Expo SDK 58 app at the repo root" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 2: Pinned openalgo source and generated tokens

On the web, BUY uses `bg-green-600` and SELL uses `bg-red-600` (`frontend/src/components/trading/PlaceOrderDialog.tsx:425,433`). P&L uses `green-600`/`red-600`, and the `400` shades in dark mode. Unlayered `:root` and `.dark` rules beat `@layer base`.

**Files:**
- Create: `openalgo.ref` (`c8b2896ca8e9cb2d0200be29fbb3e9a162ac5276` followed by a newline), `scripts/{openalgo-src,sync-openalgo,gen-tokens}.mjs`, `scripts/lib/css-tokens.mjs`, `scripts/{openalgo-src,css-tokens}.test.mjs`.
- Modify: `package.json` scripts `tokens: node scripts/gen-tokens.mjs`, `tokens:check: node scripts/gen-tokens.mjs --check`, `sync-openalgo: node scripts/sync-openalgo.mjs`.
- Generate: `src/ui/tokens.ts`.

**Interfaces:**
- `readRef(repoRoot)` and `readOpenalgoFile(relPath, opts?)`.
- `toHex(v): string | null`.
- `extractVars(css): { root; dark; analyzer: Record<string,string> }` reads `:root`, `.dark` and `.analyzer`, and ignores `[data-theme=…]` rules.
- `tailwindColor(themeCss, name): string`, e.g. `'green-600'` → the `--color-green-600` value.
- `buildTokens({ indexCss, themeCss })`: `indexCss` is `frontend/src/index.css` read through `readOpenalgoFile`; `themeCss` is `node_modules/tailwindcss/theme.css` (tailwindcss 4.3.0) read from disk. `renderTokensTs(tokens, ref)`.
- `tokens = { light, dark, analyzer: Palette; trade: { light, dark: TradePalette } }`.
  - `Palette` holds camelCase names for: background, foreground, card, popover, primary, secondary, muted, accent (each with its `*Foreground`), plus destructive, border, input and ring.
  - `TradePalette = { profit, loss, buy, sell, onBuy, onSell }`.

- [ ] **Step 1: Failing tests.**
  - **Source.** On a temporary repo with A committed, then B:
    - `OPENALGO_REPO` with the ref at A returns A, and HEAD stays at B.
    - `OPENALGO_DIR` checked out at B with the ref at A throws `/OPENALGO_DIR is at .* openalgo.ref wants/`.
    - The ref `main` throws `/40-character commit SHA/`.
  - **Tokens** (culori 4.0.2, `toGamut('rgb')`):
```js
toHex('oklch(0.145 0 0)') === '#0a0a0a'; toHex('oklch(1 0 0 / 10%)') === '#ffffff1a'; toHex('oklch(0.7 0.2 280)') === '#8b8cff'
toHex('217 91% 60%') === '#3c83f6'; toHex('0.625rem') === null; dark.background === '#0a0a0a'; dark.border === '#ffffff1a'
trade.light = {profit:'#00a63e',loss:'#e7000b',buy:'#00a63e',sell:'#e7000b',onBuy:'#ffffff',onSell:'#ffffff'}
trade.dark  = {profit:'#05df72',loss:'#ff6467',buy:'#00a63e',sell:'#e7000b',onBuy:'#ffffff',onSell:'#ffffff'}
```
  - `extractVars`: an unlayered `:root` `--background` beats the `@layer base` one, and a layered-only `--buy` survives.
- [ ] **Step 2:** `node --test scripts/openalgo-src.test.mjs scripts/css-tokens.test.mjs` → FAIL.
- [ ] **Step 3: Implement.**
  - **Git access:** `execFileSync('git', …)` with no shell; read files with `git -C ../openalgo show <ref>:<path>`, fetching the ref once if it is missing. `sync-openalgo` prints `openalgo.ref <ref> — available in <repo>: yes|no`.
  - **Token generator:** parse with postcss. A rule counts as layered if any ancestor is `@layer`. The trade map, with its file:line citations, sits at the top of `gen-tokens.mjs`: light profit/buy `green-600`, loss/sell `red-600`; dark profit `green-400`, loss `red-400`, buy `green-600`, sell `red-600`; onBuy/onSell `#ffffff`.
  - **Output:** the header is `// GENERATED … Do not edit.` `--check` exits 1 with `tokens.ts is stale: run npm run tokens`.
- [ ] **Step 4:** the same, then `npm run sync-openalgo && npm run tokens && npm run tokens:check` → PASS, `… yes`, exit 0.
- [ ] **Step 5:** Commit `feat(ui): pinned openalgo source and theme tokens generated from the web`.

### Task 3: Boundaries, bundle budgets, secret scan, pre-commit

**Files:**
- Create: `.dependency-cruiser.cjs`, `test/fixtures/boundaries/{tsconfig.json,src/**}` (the tsconfig maps `~/*` to `src/*`), `scripts/{check-bundles,check-staged}.mjs` plus their tests, `scripts/boundaries.test.mjs`, `bundle-baseline.json`, `.gitleaks.toml`, `.githooks/pre-commit`, and `.env.test.example` (with empty `OPENALGO_TEST_URL`, `OPENALGO_TEST_APIKEY`, `OPENALGO_TEST_WS_URL`).
- Modify: `package.json` gains `"prepare": "git config core.hooksPath .githooks || true"`.

**Interfaces:**
- **Rules (design 7.4).**
  - `no-cross-feature`.
  - `core-no-features`: core can't import features, app or ui.
  - `dom-content-no-secrets`: `src/dom/(chart|tools)/` can't import `core/credentials`, `core/http` or `dom/gateway`.
  - `features-dom-bridge-only`: features reach `src/dom/` only through `dom/bridge`.
  - `core-logic-pure`.
  - `no-unresolvable`: `to: { couldNotResolve: true }`.
  - `no-circular`, as a warning.
- **Bundle check.** `measure(dir)` and `compare(measured, cfg): { ok; lines }`.
  - `bundle-baseline.json` is `{ growth: 0.05, limits: { android: 4340000, ios: 4340000, chartDom: 2330000, toolDom: 1900000 }, baseline: { …, chartDom: null, toolDom: null } }`.
  - A `null` baseline prints `chartDom: not built (skipped)`.

- [ ] **Step 1: Failing tests.**
  - **Boundaries.** depcruise on the fixtures (`--ts-config test/fixtures/boundaries/tsconfig.json`) exits non-zero, names all six error rules, and lists `dom/chart/alias.ts` under `dom-content-no-secrets`. Fixture edges:
    - `dom/chart/leak.ts`→`core/credentials/keyStore.ts`
    - `dom/chart/alias.ts`→`~/core/credentials/keyStore`
    - `core/bad.ts`→`./does-not-exist`
    - `dom/tools/leak.ts`→`core/http/client.ts`
    - `dom/tools/gw.ts`→`dom/gateway/x.ts`
    - `core/uses-feature.ts`→`features/a/x.ts`
    - `features/a/x.ts`→`features/b/y.ts`
    - `features/a/dom.ts`→`dom/gateway/x.ts`
    - `core/http/native.ts`→`react-native`

    The real `src` exits 0.
  - **Bundles.** 1050 against a baseline of 1000 passes. 1051 fails with `android +5.1%`. 4,340,001 fails. A missing platform fails, and `null` is skipped.
  - **Staged files.**
    - Staging `.env.test.local` → exit 1 with `refusing to commit .env.test.local`.
    - Content containing the local `OPENALGO_TEST_APIKEY` value → exit 1.
    - `.env.test.example` → exit 0.
- [ ] **Step 2:** `node --test scripts/boundaries.test.mjs scripts/check-bundles.test.mjs scripts/check-staged.test.mjs` → FAIL.
- [ ] **Step 3: Implement.**
  - **depcruise:** rule paths are `(?:^|/)src/…`; `options: { tsConfig: { fileName: 'tsconfig.json' }, tsPreCompilationDeps: true }`, so `~/` imports resolve and the path rules see them.
  - **Bundle check:** `measure` reads `metadata.json` `fileMetadata.<platform>.bundle`; `--update` rewrites the baseline.
  - **gitleaks:**
    - `[extend] useDefault = true`.
    - Rule `openalgo-test-env-file`: `path = '''(^|/)\.env\.test\.local$'''`.
    - Rule `openalgo-api-key`: `regex = '''(?i)(?:apikey|api_key|OPENALGO_TEST_APIKEY)["'\s:=]+([0-9a-f]{64})'''` with `secretGroup = 1`, so the reported secret is the key itself.
    - Allowlist: `test/fixtures/`, `dev/mock-server/fixtures/`, and the secret regex `^(ab){32}$|^(cd){32}$`.
  - **Hook:** the pre-commit hook runs `node scripts/check-staged.mjs`.
- [ ] **Step 4:** `node --test scripts/*.test.mjs && npm run export && node scripts/check-bundles.mjs dist-export --update && npm run bundles && rm -rf dist-export` → PASS, `ok`. Then `brew install gitleaks && gitleaks git --redact --no-banner .` → `no leaks found`. Allowlist findings under `spike/` only by exact path, and never anything under `src/`. `gitleaks dir --config .gitleaks.toml <scratch>` passes a `<scratch>/src/x.test.ts` holding `apikey: '<'ab'×32>'` and fails one whose key comes from `openssl rand -hex 32`.
- [ ] **Step 5:** Commit `build: import boundaries, bundle budgets, secret scan and pre-commit check`.

### Task 4: CI workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/actions/{ios-build,android-build}/action.yml`, `renovate.json`.
- Run: `git mv .github/workflows/build.yml .github/workflows/spike.yml`.
- Modify: `README.md`.

**Interfaces:** `android-build` takes inputs `abis` (default `arm64-v8a,armeabi-v7a`) and `artifact`. Task 22 adds four signing inputs.

- [ ] **Step 1: `spike.yml`.** Name it `Spike builds` and keep the jobs unchanged. Triggers:
  - push and PR on `main`, filtered to `paths: ['spike/**', '.github/workflows/spike.yml']`;
  - dispatch, keeping `openalgo_ref`.
- [ ] **Step 2: `ci.yml`.** Triggers: push and PR on `main`, plus dispatch, with `cancel-in-progress`. Env: `NODE_VERSION "26"`, `CI "1"`, `EXPO_NO_TELEMETRY "1"`, `BUILD_NUMBER ${{ github.run_number }}`.
  - **`checks`:**
    1. Check out the repo (depth 0). Sparse-checkout `marketcalls/openalgo` `frontend/src` at the `openalgo.ref` SHA into `openalgo/`, which Task 1 keeps out of tsc, Biome, jest and git.
    2. Run `npm ci`, lint, typecheck, `npx jest --ci`, `test:scripts`, `test:compat`, `boundaries`.
    3. Run `OPENALGO_DIR=$GITHUB_WORKSPACE/openalgo npm run tokens:check`.
    4. Run `npx expo install --check` and `npx expo-doctor`.
    5. Run `npm run export` and `npm run bundles`.
    6. Run gitleaks 8.30.1 (sha256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`): `git --redact .`, then `dir --redact dist-export`.
  - **`android`** (needs `checks`): free disk, then `android-build`, which runs `expo prebuild --platform android --no-install`, Temurin 17 and `./gradlew assembleRelease -PreactNativeArchitectures=<abis> --no-daemon`. The artifact is `dist/openalgo-<version>-b<BUILD_NUMBER>-<sha7>.apk`.
  - **`ios-simulator`** (needs `checks`, runs on macos-26) and **`ios-device`** (skipped on PRs; artifact `ios-ipa-unsigned`) both use the spike's unsigned `xcodebuild` (`ARCHS=arm64`).
  - **Comments:** golden regeneration comes in M4, TestFlight in M6.
- [ ] **Step 3:** Write the remaining files.
  - `renovate.json`: weekly, `config:recommended`, one group for `expo`, `expo-*` and `react-native*`, with `pinDigests` for actions.
  - README: the layout, the mock, the CI artifacts, the checks, how to bump the ref, and the AGPL and Flutter-backup notes.
- [ ] **Step 4:** `brew install actionlint && actionlint .github/workflows/*.yml` → no output.
- [ ] **Step 5:** Commit `ci: quality gates and builds for the app; spike builds only on spike changes`.

---

## M1: foundation

### Task 5: Stock-server mock (REST + WS, version profiles, states)

ESM on `node:http` and `ws`. `spike/mock-feed` stays as it is.

**Files:** `dev/mock-server/{main,server,profiles,state,rest,feed,prices}.mjs` with `rest.test.mjs` and `feed.test.mjs`, plus `test/fixtures/openalgo-docs/{multiquotes,depth,analyzer-live,analyzer-analyze,funds}.json`, each carrying a `_source` path.

**Interfaces:**
- `startMockServer(o?: { port?; wsPort?: number | 'off'; host?; profile?; apiKey?; rate?; authGraceMs? }): Promise<{ origin; wsUrl; state; close() }>`.
- `main.mjs` env:

  | Variable | Default |
  |---|---|
  | `PORT` | 5000 |
  | `WS_PORT` | 8765 (`0` = ephemeral, `off` = no WS) |
  | `HOST` | `0.0.0.0` |
  | `PROFILE` | `2.0.3.5` |
  | `MOCK_API_KEY` | `'ab'.repeat(32)` |
  | `RATE` | 10 ticks/s per connection |

  On start it prints `MOCK_READY rest=<origin> ws=<url|off>`.
- `PROFILES`:

  | id | app-info | missing endpoint | 4401 | orderStream | 1012 | omitAbsent | with_greeks | portfolio+sip | sectorrotation |
  |---|---|---|---|---|---|---|---|---|---|
  | 1.0.0.41 | 404 html | 404 html | – | – | – | – | – | – | – |
  | 2.0.0.0 | ✓ | 200 html | – | – | – | – | – | – | – |
  | 2.0.1.6 | ✓ | 200 html | ✓ | ✓ | – | – | – | – | – |
  | 2.0.2.0 | ✓ | 200 html | ✓ | ✓ | – | – | ✓ | ✓ | – |
  | 2.0.3.5 | ✓ | 404 json | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

  Every profile from 2.0.0.0 has `multioptiongreeks`, WS ping and `history.source`.
- `POST /__mock/control` merges a patch, and keeps working while banned:
  - `profile`, `brokerLoggedOut`, `semiAuto`, `analyzer`, `appInfo`, `swagger`;
  - `banned` (`false`, `'text'` or `'json'`) and `rateLimited` (`false`, `'restx'`, `'busy'` or `'nginx'`);
  - `wsBrokerError`, `wsPingUnsupported`, `maxDepth` (5, 20 or 30), `ackEchoesDepth` (the ack echoes the requested depth, as adapters without `actual_depth` do), `silenceFeed`;
  - `closeSockets: code`, `emitOrderUpdate`, `failNext: {path, status, body, contentType}`.
- `GET /__mock/control` returns the state plus `stats { requests: Record<path, n>, wsConnections, wsAuthAttempts }`. `POST /__mock/reset` resets everything.
- **REST:** app-info and swagger (S9 form, per profile); POST ping, search, funds, analyzer, analyzer/toggle, quotes, multiquotes, depth, history, optionchain and multioptiongreeks; portfolio/backtest, sip/backtest and sectorrotation per profile. A POST without a JSON `Content-Type` gets 500 `{"status":"error","message":"An unexpected error occurred"}`, as on Flask 3.1.

- [ ] **Step 1: Failing tests.** One test per profile-table column, asserting both its ✓ and – rows. One test per control field. Plus:
  - **Errors:**
    - `POST {}` → 400 naming `apikey`; the same body as `text/plain` → that 500; a wrong key → 403; `brokerLoggedOut` → 403 everywhere except search;
    - both ban forms (S4), the three 429 shapes (S5), and the four S7 shapes: history `source` on 1.0.0.41, optionchain `with_greeks` on 2.0.1.6, and an extra analyzer or multioptiongreeks field.
  - **Data:** multiquotes returns string prices plus an `error` entry; depth returns 5 levels.
  - **WS subscriptions:**
    - mode 3 with depth 20 under `maxDepth 20` → ack depth 20 and 20 levels per side; `maxDepth 5` → depth 5; `maxDepth 5` with `ackEchoesDepth` → ack depth 20 and 5 levels per side;
    - the ack mode is `3` on 2.0.0.0 and `'Depth'` on 2.0.3.5;
    - a numeric per-symbol unsubscribe stops ticks; a string mode on 2.0.0.0 does not.
  - **WS auth and pings:**
    - a WS `BROKER_ERROR` leaves the socket open;
    - `wsPingUnsupported` → `INVALID_ACTION 'Invalid action: ping'`;
    - `emitOrderUpdate` reaches only subscribers.
  - **Broker logout and bans:**
    - a broker logout while connected → 1012 on 2.0.3.5, silence on 2.0.2.0;
    - a ban refuses the upgrade with 403.
- [ ] **Step 2:** `npm run test:scripts` → FAIL.
- [ ] **Step 3: Implement.**
  - Move `hash32`, `mulberry32`, `basePrice` and `r05` out of `spike/mock-feed/server.mjs`, and port its frame shapes.
  - The HTML shell is `<!doctype html><html><head><title>OpenAlgo</title></head><body><div id="root"></div></body></html>`.
  - A WS upgrade on the REST port gets a 404 html page, as Flask returns.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(dev): stock-server mock with version profiles and switchable states`.

### Task 6: Config, URL rules, profile, storage, prefs, logger

**Files:** `src/core/config/{constants,urlRules,version,profile,storage,prefs}.ts`, `src/core/log/logger.ts`, `test/helpers/memoryKV.ts`, plus tests.

**Interfaces:**
- **constants:** `MIN_SERVER_VERSION`, `NGROK_HEADER`, `DEFAULT_REST_PORT=5000`, `DEFAULT_WS_PORT=8765`, `WS_PATH='/ws'`, `DEFAULT_LOCK_AFTER_MS=300_000`.
- **urlRules:**
  - `type HostClass = 'home'|'dev'|'public'`, with `classifyHost(host)`.
  - `type UrlCheck = { ok: true; url; scheme; host; hostClass; stripped } | { ok: false; reason: 'empty'|'invalid'|'has_credentials'|'cleartext_public'|'dev_host_in_release'|'wrong_scheme' }`.
  - `normalizeServerUrl(input, { allowDevHosts })` and `checkWsUrl(input, o)`.
  - `deriveWsUrl(restOrigin)`, `sameHost(a, b)`, and `pollNetwork(origin): 'home'|'tunnel'` (dev hosts count as home).
- **version:** `normalizeVersion(v)`, `compareVersions(a, b): -1|0|1`, `atLeast(v: string | null, min)`.
- **profile:**
  - `type ServerProfile = { id; restOrigin; wsUrl: string | null; feedMode: 'live'|'polling'; httpWarningAcked; serverVersion: string | null; broker: string | null; createdAt; lastFeedRetryAt: number | null }`, with `ServerProfileSchema`.
  - `newProfileId(uuid)` returns `'p'` plus 12 hex characters.
  - `createProfileRepo(kv)` exposes `{ load, save, update }` over `oa.profiles.v1`, which stores `{ activeId, profiles }`.
- **storage:**
  - `interface KV { get; set; del; keys(prefix) }`, with `asyncStorageKV`.
  - `USER_CONTENT = ['watchlists','strategyPortfolio','chartDrawings','chartPrefs'] as const`.
  - `profileStorage(kv, pid): ProfileStorage = { getJSON(name, schema); setJSON; del; clearAll({ keepUserContent }) }`, using keys `oa.<pid>.<name>`.
- **prefs:** `usePrefs` (zustand, persisted as `oa.prefs.v1`):
  - fields `theme: 'system'|'dark'|'light'`, `appLock`, `lockAfterMs: 60_000|300_000|900_000`, `hideContentAndroid`, `confirmLiveWrites`;
  - defaults `system`, `true`, `300_000`, `false`, `false`; updated with `setPrefs(patch)`.
- **logger:** `log.debug|info|warn|error(tag, msg, data?)`, `redact(v)`, `getLogLines(limit?)` (keeps the last 500 lines), `clearLogs()`.

- [ ] **Step 1: Failing tests.**
```ts
// normalizeServerUrl(input, { allowDevHosts: false }) toMatchObject:
'  HTTPS://Algo.Example.COM/  ' → { url: 'https://algo.example.com', hostClass: 'public', stripped: false }
'algo.example.com' → 'https://algo.example.com'    '192.168.1.20' → { url: 'http://192.168.1.20:5000', hostClass: 'home' }
'https://x.ngrok-free.app/login?next=/' → { url: 'https://x.ngrok-free.app', stripped: true }
'http://algo.example.com', 'http://172.32.0.1:5000' → 'cleartext_public'    'http://100.64.0.9:5000', 'http://pc.local:5000' → home
'http://localhost:5000' → 'dev_host_in_release'   'https://u:p@x.com' → 'has_credentials'   'ftp://x.com' → 'invalid'   '' → 'empty'
deriveWsUrl('https://algo.example.com') === 'wss://algo.example.com/ws'; deriveWsUrl('http://192.168.1.20:5000') === 'ws://192.168.1.20:8765'
checkWsUrl('ws://algo.example.com/ws', o) → 'cleartext_public'; normalizeVersion('2.0.1.17') === '2.0.1.7'
compareVersions('2.0.10.0', '2.0.9.9') === 1; atLeast(null, '2.0.0.0') === false
```
  - `newProfileId` matches `/^p[0-9a-f]{12}$/`, and `update({ restOrigin })` keeps the id.
  - `clearAll({ keepUserContent: true })` keeps `oa.p1.watchlists` and drops `oa.p1.caps`.
  - Saved prefs `{theme:'neon', lockAfterMs:7}` load back as the defaults.
  - `redact`:
    - `apikey`/`api_key` values → `[redacted]`;
    - `x?apikey=K` → `x?apikey=[redacted]`;
    - a bare 64-hex string → `[redacted-key]`.
- [ ] **Step 2:** `npx jest src/core/config src/core/log` → FAIL.
- [ ] **Step 3: Implement.**
  - **URL parsing:** an explicit parser, not the global `URL`.
    - Lowercase the scheme and host.
    - With no scheme, use `https://` for a public host, or `http://<host>:5000` for a home host without a port.
    - Drop `:443`, `:80`, and any path, query or fragment; dropping any of these sets `stripped`.
    - Classify IPv4 by octets.
  - **Redaction:** keys matching `/^(apikey|api_key|api-key|password|secret|auth_token)$/i`, and inside strings, `apikey=[^&\s]+` and `\b[0-9a-f]{64}\b`.
  - **Console output:** only in `__DEV__`.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): URL rules, server profile, storage, prefs and redacting logger`.

### Task 7: HTTP client, coercing schemas, error model

**Files:** `src/core/http/{endpoints,errors,coerce,schemas,client}.ts`, `test/helpers/fakeFetch.ts`, and tests.

**Interfaces:**
- **endpoints:**
  - `Lane = 'read'|'history'|'order'|'smart'|'control'`;
  - `EndpointDef = { path; method; expect: 'json'|'csv'|'html'; timeoutMs; lane; keyOnly?; optional? }`;
  - `ENDPOINTS`/`EndpointId` list exactly these ids, with paths from `restx_api/__init__.py:66-116`; POST and JSON unless marked:
    - books: `funds`, `orderbook`, `tradebook`, `positionbook`, `holdings`, `orderstatus`, `margin`;
    - orders: `placeorder`, `placesmartorder`, `modifyorder`, `cancelorder`, `cancelallorder`, `closeposition`, `basketorder`, `splitorder`, `optionsorder`, `optionsmultiorder`;
    - data: `ping`, `search`, `symbol`, `expiry`, `quotes`, `multiquotes`, `depth`, `history`, `intervals`, `market/timings`, `market/holidays`, `optionchain`, `multioptiongreeks`, `analyzer`, `analyzer/toggle`;
    - tools: `portfolio/backtest`, `portfolio/holdings`, `portfolio/tearsheet` (html), `sip/backtest`, `sectorrotation`;
    - GET-only: `instruments` (csv), `portfolio/benchmarks`, `sip/frequencies`, `sectorrotation/options`.
  - **Timeouts:** 15 s by default; history 30 s; splitorder 45 s; basketorder 30 s; the `portfolio/*`, `sip/*` and `sectorrotation*` ids 120 s.
  - **Lanes:**
    - `order`: placeorder, modifyorder, cancelorder, cancelallorder, closeposition, basketorder, splitorder, optionsorder, optionsmultiorder;
    - `smart`: placesmartorder;
    - `control`: analyzer/toggle;
    - `history`: history, with optional field `source`.
  - **Flags:** search is `keyOnly`; optionchain has optional fields `with_greeks` and `interest_rate`.
- **coerce:**
  - `num` (accepts numeric strings; rejects `''`), `optNum` (absent, `''` or null → undefined), `int`, `str`, `bool` (`true`, `false`, `'true'`, `'false'`, 1 or 0);
  - `dmyHms('08-Apr-2025 13:58:03')` → epoch ms, IST;
  - `expiryIso('28-NOV-26' | '28NOV26')` → `'2026-11-28'`.
- **schemas:** `envelope`, `AppInfoSchema`, `SwaggerSchema`, `PingSchema`, `FundsSchema`, `AnalyzerSchema`, `SearchSchema`, `MultiQuotesSchema`, `QuotesSchema`, `DepthSchema`.
- **errors:**
  - `ApiErrorKind = 'KeyInvalid'|'BrokerLoggedOut'|'IpBanned'|'Unsupported'|'SemiAutoBlocked'|'RateLimited'|'Validation'|'Server'|'Network'|'MaybePlaced'`;
  - `ApiError { kind; status; endpoint; serverMessage?; unknownFields?; banForm? }`;
  - `unknownFields(body)` reads all four S7 shapes, taking `errors` whenever it is present; `userMessage(e)`.
- **client:**
  - `RawResponse = { status; contentType; text; json? }`;
  - `HttpClient = { request<T>(id, body, schema, o?); getPublic(path): Promise<RawResponse>; probe(id): Promise<'present'|'absent'|'unknown'> }`;
  - `createHttpClient({ origin, getKey, fetch, resolveAuth403: () => Promise<'key_invalid'|'broker_logged_out'>, onResponse? })`.
- **fakeFetch:** `scriptedFetch(routes): typeof fetch & { calls }`. `routes` maps `'POST /api/v1/<path>'` or `'GET <path>'` to `{ status; contentType?; body }`, a function of the request, or `'throw'`; `calls` records each request's method, URL, headers and parsed body.

**Classification** (first match wins; "order lanes" = `order` and `smart`):

| Response | Kind |
|---|---|
| fetch throws or times out | `MaybePlaced` on order lanes, else `Network` |
| 403 text/plain starting `Access Denied` | `IpBanned 'text'` |
| 403 JSON `{error:'Access Denied'}` without `status` | `IpBanned 'json'` |
| 429 | `RateLimited` |
| no JSON `status`, 200 or 404 html | `Unsupported` |
| no JSON `status`, 502 on an order lane | `MaybePlaced` |
| no JSON `status`, anything else | `Server` |
| 403 containing `Semi-Auto` | `SemiAutoBlocked` |
| 403 `Invalid openalgo apikey` | `KeyInvalid` if `keyOnly`, else `await resolveAuth403()` |
| 400 with `unknownFields`; 404; 501 | `Unsupported` |
| other 403; 400, 401, 409, 422; 2xx with `status:'error'` | `Validation` |
| 502 on an order lane | `MaybePlaced` |
| other ≥ 500; 2xx failing its schema (log the paths only) | `Server` |

**Exact `userMessage` copy:**
- MaybePlaced: "Status unknown: checking order book" (design 7.10).
- IpBanned: "This server has banned your IP address. Unban it in OpenAlgo's Security page from another network, then try again."
- KeyInvalid: "Your API key no longer works on this server. Enter it again."
- BrokerLoggedOut: "Your broker session has ended. Log in to your broker on the OpenAlgo web."
- SemiAutoBlocked and Validation show `serverMessage`; the other kinds get one plain sentence.

- [ ] **Step 1: Failing tests.**
  - One `test.each` row for each classification row and each exact message.
  - `unknownFields` handles all four shapes, including multioptiongreeks' `"Validation failed"` with `errors`.
  - `MultiQuotesSchema` gives the same output for the docs fixture and an all-strings copy; `expiryIso` and `dmyHms` tables.
  - **Client:**
    - it POSTs to `origin/api/v1/<path>` with the apikey, Accept, the ngrok header and `credentials: 'omit'`; every POST, `probe` included, carries `Content-Type: application/json`; `getPublic` and `probe` send no key;
    - `probe`: 400 JSON → present; 404 JSON or html → absent; 200 html → absent; 500 → unknown; a ban throws;
    - history times out at 30 s; a placeorder timeout gives `MaybePlaced`; fetch is called exactly once;
    - `resolveAuth403` runs only when the endpoint is not `keyOnly`; no log line contains the key.
- [ ] **Step 2:** `npx jest src/core/http` → FAIL.
- [ ] **Step 3: Implement.**
  - Read the body as text, then `JSON.parse` it in a try.
  - Use `AbortController` for timeouts, and abort on the caller's `signal` too.
  - Log only `id status ms`.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): HTTP client, coercing schemas and the stock-server error model`.

### Task 8: Request scheduler and API facade

**Files:** `src/core/http/{scheduler,api}.ts`, plus tests.

**Interfaces:**
- `createScheduler(o?: { ratePerSec=5; historyMaxInFlight=3; historyRatePerSec=3; smartGapMs=500; backoffStartMs=2000; backoffMaxMs=30000; now?; setTimer? })`.
- `Scheduler = { run<T>(r: { endpoint; lane; dedupeKey?; exec }): Promise<T>; pause(); resume(); halt(e); unhalt(); stats() }`.
- `FieldGate = { adapt(id, body); markUnsupported(id, field) }`.
- `createApi({ http, scheduler, fields }): Api`, where `Api = { call<T>(id, body, schema, o?) }`.

**Behaviour.** Each item gets one test named after it.
- **B1 Read bucket:** a 5/s bucket with capacity 5. Of 20 reads, 5 go at t=0, 10 by 1 s and all 20 by 3 s.
- **B2 Priority lanes:** order, smart and control skip the bucket and go ahead of queued reads, so an order queued behind 10 reads goes first. Smart sends are ≥ 500 ms apart.
- **B3 History:** at most 3 in flight; starts ≥ 334 ms apart; each start also takes a token from the shared read bucket, so the app stays near 5 req/s. With 10 reads and 10 history calls queued, at most 10 start in the first second and 5/s after that.
- **B4 Dedupe:** reads with the same `dedupeKey` share one `exec`. `Api` builds the key from the endpoint plus a stable JSON of the body, without the key. Orders are never deduplicated.
- **B5 429 gate:** a `RateLimited` result gates its endpoint for 2, 4, 8, 16, 30, 30… s. Queued requests wait, a success resets the gate, and `retry_after` is ignored. The failing request still rejects.
- **B6 No retry:** `KeyInvalid`, an endpoint-level `Unsupported`, an order `RateLimited` and `MaybePlaced` each call `exec` exactly once.
- **B7 Pause:** holds the read and history lanes only.
- **B8 Halt:** `halt(e)` rejects queued and new requests until `unhalt()`.
- **B9 Self-heal:** `Api.call` runs `fields.adapt` first. On `Unsupported` with `unknownFields`, if the lane is read or history and the fields are in `optional`, it calls `markUnsupported` and retries once without them. Covers history `source` and optionchain `with_greeks`; placeorder never retries.

- [ ] **Step 1:** Write tests B1–B9 with fake timers.
- [ ] **Step 2:** `npx jest src/core/http/scheduler src/core/http/api` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): request scheduler with lanes, pacing and 429 backoff`.

### Task 9: Capability probe

**Files:** `src/core/capabilities/{gates,probe,store}.ts`, plus tests.

**Interfaces:**
- `VERSION_GATES = { authDeadline:'2.0.0.5', orderStream:'2.0.1.6', portfolioTools:'2.0.1.8', optionchainGreeks:'2.0.2.0', json404:'2.0.2.1', sectorRotation:'2.0.3.0', omitsAbsentTickFields:'2.0.3.3', close1012:'2.0.3.5' }`.
- `WsCaps = { orderStream: boolean | null; ping: boolean | null; close1012; authDeadline }`.
- `Capabilities = { host; version: string | null; versionSource: 'app-info'|'marker'; endpoints: string[] | null; probed; fields; ws: WsCaps; probedAt }`.
- `hasEndpoint(c, id)`; `FeatureId = keyof typeof VERSION_GATES | 'historySource'`; `gate(c, f): { on; reason; needs? }`.
- `ProbeOutcome = { kind:'ok'; caps } | { kind:'too_old'; version } | { kind:'not_openalgo' } | { kind:'unreachable' } | { kind:'banned'; form }`; `probeServer({ http, host, now, maxProbes=10 })`.
- `createCapabilityStore(s): CapabilityStore & FieldGate`:
  - `CapabilityStore = { get; load; save; setField(key, v); setWs(p); needsReprobe({ now, host, version, force? }); subscribe }`;
  - stored under `caps`; field keys look like `'history.source'`.

**Probe order:**
```
app-info: network error → unreachable; IpBanned → banned; v = JSON string version ? normalizeVersion : null
swagger:  endpoints = JSON object paths ? ids : null
v → (v < 2.0.0.0 ? too_old(v) : ok)    else endpoints → ('multioptiongreeks' ∈ endpoints ? ok(marker) : too_old(null))
else probe('multioptiongreeks') present → ok(marker); else probe('ping') present → too_old(null); else not_openalgo
ok && !endpoints → probe portfolio/backtest, sip/backtest, sectorrotation while total probes < maxProbes
ws = { orderStream: null, ping: null, close1012: atLeast(v,'2.0.3.5'), authDeadline: atLeast(v,'2.0.0.5') }
```
- **Gates** (design 5.8: probe, don't just compare). `gate(c, f)` takes the first that applies:
  1. `fields[key] === false` → off (`optionchainGreeks` ↔ `optionchain.with_greeks`, `historySource` ↔ `history.source`);
  2. observed evidence: `ws.orderStream` (when not null) for `orderStream`; `endpoints`, else `probed`, for `portfolioTools` (`portfolio/backtest` and `sip/backtest`) and `sectorRotation` (`sectorrotation`);
  3. `historySource` has no version gate, so it is on; otherwise, with a version, `VERSION_GATES` via `atLeast`;
  4. no version → off, with the reason `server version unknown`.
- **Re-probe** when the cache is over 24 h old, the host changed, the app-info version changed, or `force` (after a 1012).

- [ ] **Step 1: Failing tests.**
  - 2.0.3.5: every gate on, zero POST probes.
  - 2.0.1.6: `orderStream` on; `optionchainGreeks` off with needs `2.0.2.0`; `portfolioTools` off.
  - Marker in swagger, no app-info → ok, version null, `versionSource` `'marker'`.
  - Evidence beats version: version null with swagger listing `portfolio/backtest` and `sip/backtest` → `portfolioTools` on; 2.0.1.7 with them listed → on; version null with `ws.orderStream` true → `orderStream` on.
  - All HTML, but the multioptiongreeks probe returns 400 JSON → ok, the gated endpoints are probed, ≤ 10 probes.
  - Swagger without the marker → `too_old(null)`.
  - **(RF 2)** Everything returns 200 html → `not_openalgo`, never `too_old`, ≤ 10 probes.
  - A ban → `banned`; a network error → `unreachable`.
  - `needsReprobe`: false at 23 h; true at 25 h, on a host or version change, and with `force`.
  - `adapt` drops `with_greeks` once `optionchain.with_greeks` is false.
- [ ] **Step 2:** `npx jest src/core/capabilities` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): capability probe with markers, capped probes and caching`.

### Task 10: Credentials, app lock, privacy

**Files:** `src/core/credentials/{keyFormat,keyStore,vault,lock,clipboard,bindings}.ts`, `src/core/platform/{privacy,haptics,useSecureScreen}.ts`, `src/ui/LockOverlay.tsx`, plus tests.

**Interfaces:**
- **keyFormat:** `KEY_RE = /^[0-9a-f]{64}$/`; `normalizeKeyInput(raw): { key; ok }`, which strips whitespace and lowercases, and nothing more; `looksPasted(prev, next)`, true when `next` is at least 32 characters longer.
- **keyStore:** `SecureKV = { get; set; del }`; `createKeyStore(secureKV, kv, pid)` exposes `{ load, save, clear, hasKey }` under the key `oa.<pid>.apikey`. `save` also writes the non-secret marker `oa.<pid>.hasKey` to `kv`, `clear` deletes it, and `hasKey()` reads only the marker, so nothing loads the key before unlock.
- **bindings:**
  - `expoSecureKV`, with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`;
  - `expoAuthenticate()`, which calls `authenticateAsync({ promptMessage: 'Unlock OpenAlgo', disableDeviceFallback: false })`;
  - `canUseAppLock()`, true when the enrolled level is not `NONE`.
- **vault:** `LockedError`; `createKeyVault(store)` exposes `{ unlock(): Promise<boolean>; lock(); get(): string; has(); replace(key); wipe() }`; `KeyVault = ReturnType<typeof createKeyVault>`. `replace` saves through the store, so it writes the marker too. If `unlock()` finds no key, it drops the marker and the session goes to onboarding.
- **lock:**
  - `createLockController({ now, settings: () => { enabled, lockAfterMs }, authenticate, vault })` exposes `{ isLocked, subscribe, handleAppState, unlock }`; `LockController = ReturnType<typeof createLockController>`;
  - `confirmLiveWrite({ enabled, authenticate }): Promise<boolean>`;
  - `clearClipboardIfPasted(pasted, c)`.
- **platform:**
  - `applyPrivacy({ hideContentAndroid })`: on iOS, `enableAppSwitcherProtectionAsync(0.9)`; on Android, prevent or allow screen capture under the tag `'oa-privacy'`;
  - `useSecureScreen()`, which wraps `usePreventScreenCapture('oa-key')`;
  - `tapLight`, `notifySuccess`, `notifyWarning`.
- **LockOverlay:** `LockOverlay({ controller })` is opaque, with an unlock button (`testID` `lock-unlock`). It prompts once on mount.

- [ ] **Step 1: Failing tests.**
  - **(RF 1)** 64 uppercase hex characters with spaces and a line break → ok, lowercased. `'api key: <hex>'`, 63 or 65 characters, or a `g` → not ok. `looksPasted('', 64 chars)` → true; one typed character → false.
  - **Key storage:** the stored key is `oa.p1.apikey`, with the marker `oa.p1.hasKey`; `hasKey()` never calls `secureKV.get`; `clear()` removes both; `get()` before unlocking throws `LockedError`; `lock()` drops the key.
  - **Lock timing:**
    - locked at start;
    - still unlocked after 299 s in the background; locked, vault included, at 300 s;
    - `inactive` never locks;
    - concurrent `unlock()` calls share one prompt.
  - **Small helpers:**
    - `clearClipboardIfPasted(true)` sets `''`;
    - a disabled `confirmLiveWrite` returns true without a prompt;
    - the privacy calls run;
    - the overlay hides its children and calls `unlock`.
- [ ] **Step 2:** `npx jest src/core/credentials src/core/platform src/ui/LockOverlay` → FAIL.
- [ ] **Step 3: Implement.** If the app lock is off, or can't be used, the vault unlocks at start.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): API key storage, vault, app lock and privacy`.

### Task 11: Key, broker and connection status

**Files:** `src/core/credentials/status.ts`, `src/core/services/connection.ts`, `src/core/realtime/types.ts`, plus tests.

**Interfaces:**
- `types.ts` exports `FeedState = 'idle'|'connecting'|'authenticating'|'live'|'reconnecting'|'polling'|'broker_logged_out'|'key_invalid'|'stopped'`; Task 15 imports it.
- `checkKey(http): Promise<'ok'|'invalid'>` POSTs `search {query:'NIFTY', exchange:'NSE_INDEX'}`. A `KeyInvalid` result means `'invalid'`; any other error is rethrown.
- `BrokerSession = 'active'|'logged_out'|'unknown'`.
- `createBrokerStatus({ api, http, conn, now })` exposes `{ check(); resolveAuth403(); fetchBrokerName() }`:
  - `check()` POSTs funds. A 200 means `active` and `BrokerLoggedOut` means `logged_out`. `KeyInvalid` sets `keyState: 'invalid'`. Anything else is `unknown`.
  - `resolveAuth403()` runs `checkKey`, then sets `useConnection` and returns `broker_logged_out` or `key_invalid`. It is single-flight and cached for 30 s.
  - `BrokerStatus = ReturnType<typeof createBrokerStatus>`.
- `useConnection` (zustand) holds `{ broker; brokerSession; keyState: 'unknown'|'ok'|'invalid'; banned: 'text'|'json'|null; feed: FeedState; transport: 'https'|'http'; analyzer: 'live'|'analyze'|'unknown'; semiAutoSeen; set; reset }`. `transport` comes from the scheme of `restOrigin`.
- `markSemiAuto(json)` sets `semiAutoSeen` when it sees `mode:'semi_auto'`, as does any `SemiAutoBlocked` error. `semiAutoSeen` is persisted.

- [ ] **Step 1: Failing tests.**
  - `checkKey` sends `NIFTY`/`NSE_INDEX`, and a 403 gives `invalid`.
  - `check()`: funds 200 gives `active`. Funds 403 plus search 200 gives `logged_out`. Funds 403 plus search 403 gives `keyState: 'invalid'`.
  - **(RF 3)** 20 concurrent 403s make exactly one search, and all 20 reject with the right kind. A 21st request within 30 s makes no new search.
  - The serialized state never contains the key.
- [ ] **Step 2:** `npx jest src/core/credentials/status src/core/services/connection` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): key and broker-session checks with the 403 split`.

### Task 12: Query client and keys

**Files:** `src/core/query/{queryClient,keys,wiring,invalidate}.ts`, plus tests.

**Interfaces:**
- `createQueryClient()`:
  - query defaults: `staleTime` 5_000, `gcTime` 300_000, `refetchOnWindowFocus: true`;
  - query retry: `(n, e) => n < 2 && e instanceof ApiError && (e.kind === 'Network' || e.kind === 'Server')`;
  - mutations: `retry: 0`.
- `qk`: `root(pid) = ['p', pid]`, plus `caps`, `analyzer`, `funds`, `ping`, `multiquotes(pid, keys)`, `quotes`/`depth`/`symbol(pid, ex, sym)`, `search(pid, q, ex?)`, `orderbook`, `tradebook`, `positionbook`, `holdings` and `orderstatus(pid, id)`.
- `clearProfileCache(qc, pid)`.
- `wireQueryManagers()` connects AppState to `focusManager` and NetInfo to `onlineManager`, and returns a cleanup function.
- `createBookInvalidator(qc, pid, { debounceMs = 500 })` exposes `{ poke(); dispose() }` and invalidates the books and funds.

- [ ] **Step 1: Failing tests.**
  - The retry predicate allows `Network` and `Server`, and refuses `KeyInvalid`, `Validation`, `MaybePlaced` and `RateLimited`.
  - Mutations use `retry: 0`.
  - Every key starts with `['p', pid]` and contains no 64-hex string.
  - `clearProfileCache` clears only its profile.
  - Five pokes within 300 ms give one invalidation at 500 ms.
  - The wiring cleanup works.
- [ ] **Step 2:** `npx jest src/core/query` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): query client, profile-scoped keys and book invalidation`.

### Task 13: Realtime protocol, market hours, tick store with depth

**Files:** `src/core/realtime/{protocol,marketHours,tickStore,useQuote,useScreenActive}.ts`, plus tests.

**Interfaces:**
- **Protocol (zod):**
  - `Mode = 1|2|3`; `DepthLevels = 5|20|30`; `quoteKey(ex, sym)` → `'NSE:RELIANCE'`.
  - `parseInbound(raw): Inbound | null`, a union tagged `t`: `auth_ok`, `error {code, message}`, `sub_ack {entries: {symbol, exchange, ok, depth?}[]}`, `unsub_ack`, `tick {symbol, exchange, mode, data}`, `orders_ack`, `order_update`, `pong`. `Inbound` and `OrderUpdate = Extract<Inbound, { t: 'order_update' }>` are exported.
  - Builders that match S11 byte for byte: `authMsg`, `subscribeMsg(pairs, mode, depth?)`, `unsubscribeMsg(pairs, mode)`, `subscribeOrdersMsg`, `pingMsg`.
- **Patches and quotes:**
  - `DepthLevel = { price; quantity; orders? }`.
  - `QuotePatch = { ltp?; open?; high?; low?; close?; volume?; oi?; avgPrice?; bid?; ask?; totalBuyQty?; totalSellQty?; depth?: { buy; sell } }`.
  - `tickToPatch(data)` treats price fields ≤ 0 as absent.
  - `depthRestToPatch(d)` maps bids/asks to buy/sell, `prev_close` to close, and `totalbuyqty`/`totalsellqty` to `totalBuyQty`/`totalSellQty`.
  - Both drop depth levels with price ≤ 0 (S12 padding), keeping order; `levels` is the larger side's count after the drop.
  - `multiquoteToPatch(d)` maps `prev_close` to close.
  - `Quote = QuotePatch & { change?; changePct?; ts; dir: 1|-1|0; source: 'ws'|'poll'|'seed' }`. `change` is set only when there is an `ltp` and `close > 0`.
- **Market hours:**
  - `istParts(now)` uses UTC+5:30 arithmetic, never the device time zone.
  - `isExchangeOpen(ex, now)`, Monday to Friday, matching the server defaults (`database/market_calendar_db.py:57-73`):
    - NSE, BSE, NSE_INDEX, BSE_INDEX: 09:15–15:30;
    - NFO, BFO: 09:15–15:40;
    - CDS, BCD: 09:00–17:00;
    - MCX, NCO, MCX_INDEX: 09:00–23:55;
    - CRYPTO: always open;
    - no holidays in M1.
  - `isAnyMarketOpen(now)`.
- **Tick store:** `createTickStore(schedule?, { evictAfterMs = 60_000 })` exposes `put(key, patch, 'ws'|'poll')`, `seed(key, patch, ts)`, `get`, `subscribe`, `dropDepth`, `reset`, `setStale`, `isStale`, `subscribeStale`, `lastWsTickAt()` and `stats()`; `TickStore = ReturnType<typeof createTickStore>`.
- **Hooks:**
  - `useQuote(key, active)`.
  - `useDepth(key, active)` returns `{ buy, sell, levels }` or undefined.
  - `useFeedStale()`.
  - `useScreenActive()` is true while the screen is focused and AppState is `active`.

- [ ] **Step 1: Failing tests.**
  - **Parsing:** `parseInbound` handles every S11 frame, numbers sent as strings, a 2.0.0.0 ack with a numeric mode, and errors with no type. Non-JSON returns null.
  - **Builders:** exact S11 output, including a numeric mode on each unsubscribed symbol.
  - **Patches:** `tickToPatch` drops `close 0` and `ltp 0`, keeps `volume 0` and copies depth. `depthRestToPatch` maps every field. A REST depth with 2 zero-price rows gives 3 bids, and a WS depth tick does the same.
  - **Store:**
    - `put` merges fields, but replaces `depth` whole; `dropDepth` removes only depth;
    - 100 puts on 3 keys give one call per key per flush;
    - a seed never overwrites newer data, but `put` always overwrites a seed;
    - a key is evicted 60 s after its last unsubscribe, unless it is resubscribed first.
  - **Hooks:** an inactive `useQuote` doesn't re-render, and catches up when it becomes active.
  - **Market hours:** Monday 09:14 is closed for NSE and 09:15 is open; NFO is open at 15:39 and closed at 15:40; MCX is open at 23:54 and closed at 23:55; Saturday is closed; CRYPTO on Sunday is open.
  - **(RF 5)** The answers are identical with `process.env.TZ` set to `America/New_York` and to `Asia/Kolkata`.
- [ ] **Step 2:** `npx jest src/core/realtime/protocol src/core/realtime/marketHours src/core/realtime/tickStore src/core/realtime/useQuote` → FAIL.
- [ ] **Step 3: Implement.** Start from `spike/app/src/core/tickStore.ts` without its flush modes. The default schedule is `requestAnimationFrame`.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): realtime protocol, market hours and tick store with depth`.

### Task 14: Subscription manager

**Files:** `src/core/realtime/subscriptions.ts`, plus its test.

**Interfaces:**
- `SubRequest = { exchange; symbol; mode: Mode; depth?: DepthLevels }`.
- `createSubscriptionManager({ send, onDowngrade?, debounceMs = 100, budget = 500, setTimer? })` exposes `{ acquire(r): () => void; onAck(a); noteDepthLevels(ex, sym, n); resendAll(); connectionLost(); effective(); isWired(ex, sym); confirmedDepth(ex, sym): number | undefined; waiting() }`.

**Behaviour.** One named test per item.
- **B1 Refcount.** Counts are kept per (exchange, symbol, mode, depth). The effective subscription is the highest mode, and for mode 3 the highest depth. Two acquires send one subscribe. The first release sends nothing; the second unsubscribes, with a numeric mode.
- **B2 Flush.** Debounced by 100 ms, the flush diffs the effective set against what is on the wire.
  - A changed symbol gets the old unsubscribe, then the new subscribe. All unsubscribes go before any subscribe, one message per (mode, depth).
  - LTP followed by Depth sends unsubscribe 1, then subscribe 3 with depth 5.
  - An acquire and release in the same window send nothing.
- **B3 Depth change.** Holding depth 5 and depth 20 subscribes at 20. Releasing the 20 sends unsubscribe 3, then subscribe 3 at depth 5.
- **B4 Downgrade.** Leaving mode 3 calls `onDowngrade(key)`.
- **B5 Budget.** The 501st symbol waits in FIFO order, and a release promotes it.
- **B6 Ack.** `onAck` records the ack depth and `noteDepthLevels` the largest count of priced levels seen in one depth tick; `confirmedDepth` is the smaller (S12), undefined until the first depth tick. Ack 20 with 20-level ticks → 20; ack 20 with 5-level ticks → 5. Both reset when the depth changes or the connection drops. A failed entry is marked not wired.
- **B7 Reconnect.** `connectionLost` clears the wire state. `resendAll` resubscribes everything.

- [ ] **Step 1:** Write tests B1–B7.
- [ ] **Step 2:** `npx jest src/core/realtime/subscriptions` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): subscription manager with highest-mode refcount, depth and budget`.

### Task 15: WebSocket client and live-feed handshake

**Files:** `src/core/realtime/{handshake,wsClient}.ts`, `test/helpers/fakeSocket.ts`, and their tests.

**Interfaces:**
- **`testLiveFeed(url, key, { WebSocketImpl, attempts = 3, authTimeoutMs = 15000 })`** returns `{ ok: true; broker; ping } | { ok: false; reason: 'timeout'|'closed'|'auth_error'|'broker_error'; closeCode? }`.
  - It waits 1 s, then 2 s, between attempts.
  - Auth and broker errors stop it at once.
- **States:** `FeedState` comes from `types.ts` (Task 11). `FeedStatus = { state: FeedState; lastCloseCode; failures; everLive; broker }`.
- **`createRealtime(d): Realtime`.** The inputs in `d`:
  - connection: `url()`, `feedMode()`, `getKey`, `WebSocketImpl`, `lastFeedRetryAt()` (from the profile, seeding the 10-minute window);
  - wiring: `store`, `caps: { ws(); setWs(p) }`, `isExchangeOpen`;
  - callbacks: `onBrokerError(code): Promise<BrokerSession>`, `onKeyInvalid`, `on1012`, `onSilence`, `onOrderUpdate`, `onResync`, `onPollingRetry(ok)`;
  - optional `now`, `setTimer` and `config`.

  Config defaults: `authTimeoutMs` 15000, `pingEveryMs` 25000, `pongTimeoutMs` 10000, `backgroundDropMs` 30000, `silenceMs` 60000, `maxReconnectsBeforePolling` 10, `pollingRetryMs` 600000.
- **`Realtime`** = `{ start; stop; setAppState('active'|'background'); acquire(SubRequest); isLive(ex: string, sym: string): boolean; confirmedDepth; status; onStatus }`. `isLive` is state `live` and `isWired(ex, sym)`. Each instance owns one `SubscriptionManager`.

**Behaviour.** One named test per item. The tests use `FakeSocket` (`sent`, `serverOpen`, `serverSend`, `serverClose`) and fake timers.
- **B1 Handshake.** `testLiveFeed`: a success reports the broker. Three timeouts give `timeout` after exactly 3 sockets. `AUTHENTICATION_ERROR` stops after 1 socket.
- **B2 Start.** If there is no URL, or the feed mode is polling, the state is `polling` and no socket opens.
- **B3 Auth.**
  - On open, send `authMsg`. It is never logged; frames are logged by `type` only. No `auth_ok` within 15 s: close and count a failure.
  - On `auth_ok`: state live, failures reset to 0, `resendAll()`, then `subscribe_orders` unless `orderStream === false`.
  - The subscribe_orders ack sets `orderStream` to true. An `INVALID_ACTION` reply sets it to false and stops future sends.
- **B4 Ping.**
  - Send a ping every 25 s unless `ping === false`. An `INVALID_ACTION` reply sets `ping` to false.
  - No frame within 10 s of a ping: reconnect.
- **B5 Data.**
  - Each tick goes to `store.put(quoteKey, tickToPatch(data), 'ws')`. Depth ticks fill `depth` and call `subs.noteDepthLevels` with the priced-level count.
  - `order_update` is deduplicated on `orderid|order_status|filled_quantity`, over the last 500 updates.
- **B6 Errors.**
  - `AUTHENTICATION_ERROR`: state `key_invalid`, call `onKeyInvalid`, no reconnect.
  - Any `BROKER_*` code (S11: not proof of logout): close with 1000 and await `onBrokerError(code)`. `logged_out` → state `broker_logged_out`, no reconnect until `start()`. `active` or `unknown` → count a failure and reconnect on the B7 schedule.
  - `NOT_AUTHENTICATED`: reconnect.
- **B7 Close.**
  - 1012: call `on1012`, reconnect at once, reset failures.
  - Any other code: reconnect after `min(1000·2^failures, 30000)`, i.e. 1000, 2000, 4000, 8000, 16000, then 30000 and 30000.
  - After 10 consecutive failures, the state is `polling` for the rest of the session.
- **B8 Polling retry (RF 4).**
  - In `polling`, on `active`, at most once per 10 min, counted from `lastFeedRetryAt()` so the window survives cold starts: one `testLiveFeed` attempt, then `onPollingRetry(ok)`, failed or not. Success connects.
  - Scenario: an upgrade that always fails opens 10 sockets, then polls. 20 foregrounds over 9 min open no socket; at 10 min there is exactly one attempt. A cold start 5 min after a failed retry opens no socket.
- **B9 Watchdog.** Runs only when `close1012` is false.
  - Every 15 s, it fires if the feed is live, a wired symbol's exchange is open, and the last WS tick is more than 60 s old.
  - The first fire reconnects, the second calls `onSilence` once, and later fires are quiet until a tick arrives.
  - A closed exchange never fires.
- **B10 Background.** Close with 1000 after 30 s in the background; at 29 s the socket is kept. On `active`, reconnect and call `onResync` if the socket was closed, or else cancel the pending close.
- **B11 Stale.** `store.setStale(state !== 'live')`.

- [ ] **Step 1:** Write B1–B11.
- [ ] **Step 2:** `npx jest src/core/realtime/handshake src/core/realtime/wsClient` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): WebSocket client with api_key auth, keep-alive, watchdog and polling handoff`.

### Task 16: Polling fallback engine and live hooks

**Files:** `src/core/realtime/{polling,useLive}.ts`, plus tests.

**Interfaces:**
- `POLL_RATES` (ms, as `{home, tunnel}`):
  - `quotes`, `depth` and `chartLtp`: `{2000, 5000}`;
  - `optionchain`: `{5000, 10000}`;
  - `arbitrage`: `{5000, 5000}`;
  - `positions` 5000, `funds` 60000, `orderbookWorking` 5000, `orderbookIdle` 30000;
  - `offHoursFactor` 5.
- `PollConsumer = { kind:'quotes'; keys() } | { kind:'depth'; key() } | { kind:'custom'; intervalMs(); run() }`.
- `createPollingEngine({ api, store, isLive, network, now, setTimer?, isAnyMarketOpen })` exposes `{ register(c, active): () => void; setAppActive(b); stats() }`; `PollingEngine = ReturnType<typeof createPollingEngine>`.
- `LiveContext` provides `{ realtime, polling, store }`.
- `useLiveQuote(ex, sym, mode = 2)`; `useLiveDepth(ex, sym, levels = 5)` returns `{ buy; sell; levels; confirmedDepth?; source }` or undefined.

**Behaviour.** One named test per item.
- **B1 Merge.** On each tick, the not-live keys of every active `quotes` consumer go into one deduplicated `multiquotes` call (in batches of 100), and the results are stored with `put(…, 'poll')`. Two overlapping consumers get one call per 2 s covering their union.
- **B2 Live keys** are skipped. If everything is live, 10 s pass with zero calls.
- **B3 Rate** is `POLL_RATES[kind][network()]`: 5 s on a tunnel, multiplied by 5 while every market is closed.
- **B4 Inactive.** An inactive consumer, or an inactive app, makes zero calls.
- **B5 Depth.** One `depth` call per active depth consumer per tick, giving up to 5 levels once zero-price rows are dropped.
- **B6 Custom.** `run()` fires on its own interval.
- **B7 Hooks.** While `useScreenActive()` is true, the hooks acquire on realtime and register a consumer. `useLiveQuote` takes mode 2 and releases on blur. `useLiveDepth(…, 20)` acquires `{mode:3, depth:20}` and reports the manager's `confirmedDepth`: 5 when a 20-ack brings 5-level ticks.

- [ ] **Step 1:** Write tests B1–B7.
- [ ] **Step 2:** `npx jest src/core/realtime/polling src/core/realtime/useLive` → FAIL.
- [ ] **Step 3: Implement.** Every call goes through `api`.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(core): polling fallback engine and live quote/depth hooks`.

### Task 17: UI kit and connection badges

**Files:** `src/ui/{theme,format,Text,Price,Change,Button,ListRow,Sheet,Skeleton,EmptyState,ErrorState,Badge,Banner,StatusBadges,NotYetAvailable}`, plus tests.

**Interfaces:**
- **Theme:** `ThemeProvider` and `useTheme(): { scheme; c; trade; analyzer }`. `system` resolves through `useColorScheme()`, and falls back to dark.
- **Formatting:** `fmtPrice(n?, dp = 2)` gives `'--'` for undefined and formats en-IN. Also `fmtSigned`, `fmtPct`, `fmtQty` and `signOf`.
- **Components:**
  - `Text({ variant?: 'title'|'heading'|'body'|'caption'|'mono'; tone?: 'default'|'muted'|'profit'|'loss' })`, `Price({ value })`, `Change({ change, pct })`.
  - `Button({ title; onPress; variant?: 'primary'|'secondary'|'destructive'|'buy'|'sell'; loading?; disabled?; testID? })`, which calls `tapLight()`.
  - `ListRow`; `Sheet({ visible; onClose })`, a Modal (a page sheet on iOS, a bottom card on Android).
  - `Skeleton({ rows })`, `EmptyState({ title; body?; action? })`.
  - `ErrorState({ error; onRetry? })` shows `userMessage`, or "Something went wrong."
  - `Badge({ label; tone })`, `Banner({ tone; text; action?; testID? })`.
  - `NotYetAvailable({ what })` shows "{what} aren't in this build yet. They arrive in the next update."
- **Status badges:** `StatusBadges({ transport, feed, brokerSession, analyzer })` renders, in this order:
  1. `Not encrypted` (warning, when http; `badge-http`);
  2. `Polling` (warning; `badge-polling`);
  3. `Broker logged out` (danger; `badge-broker`);
  4. `LIVE` (danger), `ANALYZE` (analyze) or `—` (`mode-badge`).

- [ ] **Step 1: Failing tests.**
  - `fmtPrice(1569.9)` → `'1,569.90'`; `fmtPrice(123456.5)` → `'1,23,456.50'`; `fmtPct(-0.456)` → `'-0.46%'`.
  - `Change` uses the profit and loss colours in both schemes, and a buy `Button` uses `trade.buy`.
  - A `loading` button ignores presses.
  - `ErrorState` shows the RateLimited copy.
  - With http, polling, logged out and analyze, all four badges show, in order. With https, live, active and live, only `LIVE` shows.
- [ ] **Step 2:** `npx jest src/ui` → FAIL.
- [ ] **Step 3: Implement.** Use StyleSheet only.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(ui): theme, base components and connection badges`.

### Task 18: App shell: services, guards, tabs, lifecycle

**Files:**
- Create: `src/core/services/{deps.ts,services.tsx}`, `src/app/(app)/_layout.tsx`, `src/app/(app)/(tabs)/{_layout,index,orders,portfolio,tools,account}.tsx`.
- Modify: `src/app/_layout.tsx`. Delete: `src/app/index.tsx`.
- Tests: `src/core/services/services.test.ts`, `test/app/rootStack.test.tsx` (outside `src/app/`, where expo-router would treat a test as a route).

**Interfaces:**
- `AppDeps = { fetch; WebSocketImpl; secureKV; kv; now; uuid; allowDevHosts }`. `defaultDeps` sets `allowDevHosts: __DEV__`.
- `Services = { profile; vault; http; scheduler; api; caps; broker; realtime; polling; store; storage; queryClient; books }`.
- `createServices(profile, deps)`. `disposeServices(s)` stops realtime, resets the store, clears the queries and locks the vault. `ServicesProvider` and `useServices()`.
- `useSession` (zustand) holds `{ status: 'loading'|'onboarding'|'ready'; profileId; set }`. `bootSession(deps)` goes `ready` if a profile exists and `keyStore.hasKey()` (the marker), otherwise `onboarding`. It never calls `secureKV.get`; only `vault.unlock()` reads the key.

**Wiring:**

| Event | Action |
|---|---|
| any 403 needing disambiguation (`resolveAuth403`) | `broker.resolveAuth403` |
| `onResponse` | `markSemiAuto` |
| any `IpBanned` | `scheduler.halt(e)`, `realtime.stop()`, `conn.banned` (design 7.5: stop all traffic) |
| `conn.keyState` becomes `'invalid'` | `scheduler.halt(KeyInvalid)`, `realtime.stop()` |
| `vault.replace` succeeds | `keyState: 'ok'`, `scheduler.unhalt()`, then `realtime.start()` |
| `onBrokerError(code)` | returns `broker.check()`, which sets `brokerSession` |
| `onKeyInvalid` | `broker.resolveAuth403()` |
| `on1012` | forced re-probe, then `broker.check()` |
| `onSilence` | `broker.check()` |
| `onOrderUpdate`, `onResync` | `books.poke()` |
| `onPollingRetry(ok)` | `profile.update({ lastFeedRetryAt: now })` always, plus `feedMode: 'live'` when `ok` |
| broker back to `active` | `realtime.start()` |

**Layout:**
- **Root.** Keep the splash until boot finishes. Then mount GestureHandler, SafeArea, ThemeProvider and `RootStack`, call `applyPrivacy`, feed AppState to the lock controller, and render `<LockOverlay>` over everything while locked.
```tsx
<Stack.Protected guard={status === 'ready'}><Stack.Screen name="(app)" /></Stack.Protected>
<Stack.Protected guard={status === 'onboarding'}><Stack.Screen name="(onboarding)" /></Stack.Protected>
```
- **`(app)/_layout`** provides `ServicesProvider`, `QueryClientProvider` and `LiveContext`.
  - On mount, its `Lifecycle` runs `caps.load`, re-probes if needed (app-info is checked on every cold start), then `broker.check()`, `realtime.start()` and `wireQueryManagers()`.
  - On each AppState change it calls `realtime.setAppState`, `polling.setAppActive` and `scheduler.pause`/`resume`. On `active` it also re-probes when `caps.needsReprobe({ now, host, version })` is true (design 7.1: older than 24 h), then runs `broker.check()`.
- **Tabs.** `StatusBadges` sits above `NativeTabs` (`expo-router/native-tabs`). Each trigger is listed with its SF Symbol and Material icon:
  - index "Watchlist": `list.bullet`, `list`;
  - orders: `doc.text`, `receipt_long`;
  - portfolio: `briefcase`, `work`;
  - tools: `square.grid.2x2`, `apps`;
  - account: `person.crop.circle`, `account_circle`.

  Orders, Portfolio and Tools render `NotYetAvailable`.
- **Banners.**
  - Polling: "Live feed unavailable: prices refresh every few seconds", with a "Setup help" link to `/help`.
  - Banned: the IpBanned copy, with "Try again", which calls `unhalt()`, re-probes, then `realtime.start()`.
  - `banner-key`, non-dismissable while `keyState === 'invalid'`: the KeyInvalid copy, with "Enter key", which goes to `(app)/account/key`.
  - `banner-broker`, while `brokerSession === 'logged_out'`: the BrokerLoggedOut copy, with "Log in to your broker", which opens `{origin}/login` (web route, `frontend/src/App.tsx:180`) in the system browser.

- [ ] **Step 1: Failing tests.**
  - **Services and banners:**
    - `IpBanned` halts the scheduler and stops realtime; "Try again" unhalts, re-probes and restarts realtime;
    - **(RF 3)** 20 concurrent 403s with search also 403: one search, then `banner-key`, then no further fetch and no socket; a `vault.replace` unhalts, then restarts realtime;
    - a WS `AUTHENTICATION_ERROR` shows the same `banner-key`;
    - `BROKER_ERROR` with funds 403 and search 200 → `logged_out` and `banner-broker`, whose button opens `{origin}/login`; `active` again restarts realtime;
    - `BROKER_CONNECTION_ERROR` with funds 200 → no broker badge, and a reconnect at 1 s;
    - 1012 → a forced re-probe plus a broker check;
    - a resume at 25 h makes one re-probe; at 23 h, none;
    - a failed polling retry still writes `lastFeedRetryAt`;
    - `order_update` pokes the books;
    - boot never calls `secureKV.get`;
    - dispose locks the vault and resets the store.
  - **rootStack** (`renderRouter`): no profile → onboarding; profile plus key marker → app; changing back → onboarding.
- [ ] **Step 2:** `npx jest src/core/services test/app` → FAIL.
- [ ] **Step 3: Implement.** NativeTabs isn't rendered under jest; CI builds and the exit run cover it.
- [ ] **Step 4:** the same, then `npm run typecheck && npm run boundaries` → PASS.
- [ ] **Step 5:** Commit `feat(app): services container, protected navigation, tabs and lifecycle`.

### Task 19: Onboarding

**Files:**
- Feature: `src/features/onboarding/{flow,copy}.ts`, `components/KeyField.tsx`, `screens/{Server,Update,Key,Feed,SetupHelp}Screen.tsx`.
- Routes: `src/app/(onboarding)/{_layout,server,update,key,feed,help}.tsx`, `src/app/(app)/help.tsx`.
- Tests: `flow`, `copy`, `screens`.

**Interfaces.** `flow.ts` is pure, so the compat suite can run it.
- `serverStep(input, { fetch, allowDevHosts, now })` returns `{ kind:'ok'; url; caps }`, `{ kind:'url_error'; reason }`, or a non-ok `ProbeOutcome`.
- `keyStep(origin, raw, d)` returns `{ kind:'ok'; key; brokerSession; broker }`, `{ kind:'format' }`, `{ kind:'invalid' }` or `{ kind:'error'; error }`. It calls search, then funds, then ping.
- `feedStep(wsUrl, key, d)` runs `testLiveFeed` with 3 attempts and returns `{ mode:'live'; broker }` or `{ mode:'polling'; reason }`.
- `saveOnboarding(r, { kv, secureKV, uuid, now }): Promise<ServerProfile>` reuses an existing profile id.

**Flow:**
1. **URL** (`server-url`, `server-continue`). If the URL was stripped, show "Using {url}". On http to a home host, show the one-time `http-ack` first.
2. **Version.** `too_old` goes to `/update`.
3. **Key** (`key-input`).
   - `KeyField` is masked with `secureTextEntry` and has a show toggle; the screen uses `useSecureScreen`. Shown, it is a plain input with `autoCorrect={false}`, `spellCheck={false}`, `autoCapitalize="none"`, `autoComplete="off"`, `importantForAutofill="no"` and, on Android, `keyboardType="visible-password"`, so no suggestion strip learns the key. iOS may not offer Scan Text in a secure field, so the hint reads "To scan the key with the camera, tap Show first." Task 25 checks scan-text on devices.
   - "Where do I find this?" opens `{origin}/apikey` in the system browser.
   - Run `normalizeKeyInput`, `keyStep`, then `clearClipboardIfPasted`.
   - If the broker is logged out, show that message, and still allow continuing.
4. **Feed** (`feed-url`, `feed-test`). Prefill with `deriveWsUrl`, let the user edit it, and check it with `checkWsUrl`. A different host from the REST URL needs a confirm.
5. **Save** (`onboarding-save`): `saveOnboarding`, then `ready`.

**Copy.** Exact strings, by case. Other URL errors get one plain sentence.

| Case | Text |
|---|---|
| http warning | "Not encrypted: anyone on the same Wi-Fi can capture your API key. Use this only on a network you trust." / "I understand" |
| cleartext_public | "This address needs https. http is allowed only on your home network." |
| dev_host_in_release | "localhost is this phone, not your PC. Use your PC's network address, for example 192.168.1.20:5000." |
| unreachable, home host (extra line) | "If OpenAlgo runs on this PC with a stock .env, it listens only on 127.0.0.1. In .env set FLASK_HOST_IP='0.0.0.0' and WEBSOCKET_HOST='0.0.0.0', then restart OpenAlgo." On iOS, add: "Also allow Local Network for OpenAlgo in Settings > Privacy & Security > Local Network." |
| not_openalgo | "This doesn't look like an OpenAlgo server" |
| too_old | "Update OpenAlgo", with "Native install: run install/update.sh, then restart OpenAlgo." and "Docker: docker pull marketcalls/openalgo:latest, then recreate the container." |
| key format | "An OpenAlgo API key is 64 characters, 0-9 and a-f." |
| broker logged out | "Your key works; log in to your broker on the OpenAlgo web to see live data." |
| feed failed | "Live feed unavailable: prices refresh every few seconds", with "Setup help" |
| ws host differs | "The live feed is on {wsHost}, not {restHost}. Your API key will be sent there. Continue?" |

**SetupHelpScreen** shows:
- the design 7.1 matrix;
- the two `.env` lines;
- `WEBSOCKET_HOST='0.0.0.0'` for `install/docker-run.sh`;
- the cloudflared rule `path: ^/ws` → `http://127.0.0.1:8765`;
- and that ngrok and quick tunnels run in polling mode.

- [ ] **Step 1: Failing tests.**
  - **Copy:** each string in the table.
  - **Flow:**
    - `'192.168.1.20'` becomes `http://192.168.1.20:5000`;
    - `keyStep`: a format error sends nothing; search 403 → `invalid`; search 200 with funds 403 → ok with `logged_out`; ping supplies the broker;
    - `feedStep`: 3 failures → polling;
    - `saveOnboarding` writes `oa.<id>.apikey`, the `oa.<id>.hasKey` marker and `oa.profiles.v1`, and reuses an existing id.
  - **Screens:**
    - LAN http needs the ack;
    - a stripped URL shows "Using …";
    - the key stays masked until the toggle is pressed;
    - a different WS host needs a confirm;
    - a failure on a home host shows the `.env` lines.
- [ ] **Step 2:** `npx jest src/features/onboarding` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same, then `npm run boundaries` → PASS.
- [ ] **Step 5:** Commit `feat(onboarding): URL rules, version check, key and live-feed test`.

### Task 20: Account

**Files:** `src/features/account/{api,diagnostics,signOut}.ts`, `screens/{Account,ServerSettings,Diagnostics,LostPhone,SignOut}Screen.tsx`, `src/app/(app)/account/{server,key,diagnostics,lost-phone,sign-out}.tsx`. Modify the account tab.

**Interfaces:**
- `useAnalyzer(): 'live'|'analyze'|'unknown'` POSTs the analyzer endpoint on foreground (`staleTime` 5_000) and writes `conn.analyzer`.
- `useToggleAnalyzer(): { toggle(to); pending }`:
  - asks for confirmation; when the target is live, it also runs `confirmLiveWrite`;
  - sends `analyzer/toggle {mode: to === 'analyze'}` once, then invalidates.
- `capabilityReport(c): { feature; on; reason }[]`, `buildDiagnostics(i)`, and `serializeDiagnostics(r) = JSON.stringify(redact(r), null, 2)`.
- `signOut(s, { deleteUserContent })`:
  - wipes the key;
  - runs `disposeServices`, `clearProfileCache` and `storage.clearAll({ keepUserContent: !deleteUserContent })`;
  - keeps the profile, so the URL stays prefilled and the id is reused;
  - sets status `onboarding`.

**Screens:**
- **Account:**
  - Shows URL, version ("unknown, 2.0.0.0 or later" if not known), broker and connection mode.
  - Links: Server settings, and Change API key: `(app)/account/key` uses `KeyField` and `useSecureScreen`, runs `keyStep` (Task 19) on the candidate key, then `vault.replace`.
  - LIVE/ANALYZE toggle (`analyzer-toggle`). After `semiAutoSeen`, it is replaced by "Mode switching is off because this account uses Semi-Auto orders. Change the mode on the web."
  - Broker status, with "Log in to your broker" opening `{origin}/login`.
  - Settings: theme; app lock (disabled with "Set a device passcode to use app lock" when unavailable); Lock after 1, 5 or 15 min; "Confirm live actions with biometrics"; on Android, "Hide content in screenshots and recent apps".
  - Links: Diagnostics, Lost phone, Sign out (`sign-out`). Shows the version.
- **ServerSettings:** the server URL runs `serverStep`, keeps the id and forces a re-probe. The live feed URL runs `checkWsUrl` and, when its host differs from the REST host, the "ws host differs" confirm (design 7.1 step 4). Test live feed runs `feedStep` and sets `feedMode`.
- **Diagnostics:** the capability report, feed status, scheduler and store stats, the last 200 log lines, and "Copy diagnostics".
- **LostPhone:** the two design 7.2 steps, in order:
  1. Regenerate the key on the web. This breaks other API clients until each is updated.
  2. Log out of the broker, or restart OpenAlgo, so open live-feed sessions drop.
- **SignOut:**
  - Says that watchlists stay unless deleted, and that "Only regenerating the key on the OpenAlgo web cuts this phone off for good."
  - Switch "Also delete watchlists and saved data on this phone", off by default.
  - Backup comes in Plan B.
- **Confirms:**
  - "Switch to LIVE?" / "This switches the whole OpenAlgo install to live trading, including the web app and your running strategies." / "Switch to LIVE".
  - ANALYZE uses the same pattern, with "to the analyzer (sandbox)".

- [ ] **Step 1: Failing tests.**
  - **Analyzer:** the fixtures map to `live` and `analyze`; an error gives `unknown`.
  - **Toggle:** going LIVE confirms, then sends `{mode:false}` once; a 409 shows the server's message; `semiAutoSeen` swaps the toggle for the note.
  - **Diagnostics:** on 2.0.1.6, `optionchainGreeks` is off with "needs 2.0.2.0" and `orderStream` is on. The output holds no 64-hex string and no `apikey":"`.
  - **Sign out:** keeps watchlists unless asked; deletes the key and the `hasKey` marker; keeps the id.
  - **URL edit:** keeps the id, watchlist and key; forces a re-probe.
  - **Change key screen:** calls `useSecureScreen`; a valid key calls `vault.replace`.
  - **Feed URL edit:** `ws://` to a public host shows the cleartext_public error; a different host needs the confirm.
  - **Logged-out broker:** the login button opens `{origin}/login`.
- [ ] **Step 2:** `npx jest src/features/account` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same, then `npm run boundaries` → PASS.
- [ ] **Step 5:** Commit `feat(account): server settings, analyzer toggle, broker status, diagnostics, sign out`.

### Task 21: Minimal device-local watchlist with live LTP

This is enough for the M1 exit. List management, search, the index strip and B/S buttons are Plan B.

**Files:** `src/features/watchlist/{model,store,api}.ts`, `components/WatchRow.tsx`, `screens/WatchlistScreen.tsx`. Modify the index tab.

**Interfaces:**
- `WatchlistsSchema = z.object({ version: z.literal(1), lists: z.array(z.object({ id, name, items: z.array(z.object({ exchange, symbol })) })) })`.
- `DEFAULT_WATCHLISTS` is one list, `{ id:'default', name:'Watchlist' }`: NSE RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK and SBIN, plus NSE_INDEX NIFTY.
- `loadWatchlists(s)` seeds those defaults on first run, under storage name `watchlists`. `saveWatchlists(s, w)` writes.
- `useSeedQuotes(items)` makes one `multiquotes` call per focus, then `store.seed`.
- **`WatchRow`** (memo):
  - testIDs `watch-row-{EX}-{SYM}` and `watch-ltp-{EX}-{SYM}`;
  - data from `useLiveQuote(ex, sym, 2)`;
  - shows the symbol, an exchange tag, `Price` and `Change`;
  - a 400 ms flash on price change, skipped under reduced motion;
  - 56 px tall; opacity 0.5 while the feed is stale.

- [ ] **Step 1: Failing tests.**
  - The first load seeds `oa.<pid>.watchlists`.
  - A row shows `--`, then the seeded price after focus, then a later WS tick.
  - A stale feed dims the row, and reduced motion means no flash.
  - With live, wired symbols, the 10 s after the seed make zero REST calls.
- [ ] **Step 2:** `npx jest src/features/watchlist` → FAIL.
- [ ] **Step 3: Implement.** Start from `spike/app/src/features/watchlist/WatchRow.tsx`, using theme colours.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(watchlist): device-local list with live prices`.

### Task 22: Android release signing

**Files:**
- Create: `plugins/{releaseSigning,withReleaseSigning,releaseSigning.test}.js`, and `test/fixtures/android/app-build.gradle`, taken from the npm template (no prebuild): `npm pack expo-template-bare-minimum@sdk-58 --pack-destination <scratchpad>`, then extract `package/android/app/build.gradle`, with `// expo-template-bare-minimum@<version>` as its first line (58.0.35 today). In CI, the `android` job's prebuild runs the plugin on the real file, so template drift fails loudly with `release signing anchors not found`.
- Modify: `app.config.ts` (adds the plugin), `android-build/action.yml`, `ci.yml`, `README.md`.

**Interfaces:** `applyReleaseSigning(gradle): string`, pure and idempotent.
- It adds a `release` entry to `signingConfigs` that reads `System.getenv` for `OA_KEYSTORE_PATH`, `OA_KEYSTORE_PASSWORD`, `OA_KEY_ALIAS` and `OA_KEY_PASSWORD`.
- Inside `release {`, it replaces `signingConfig signingConfigs.debug` with `signingConfig System.getenv('OA_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug`.
- If either anchor is missing, it throws `release signing anchors not found`.

- [ ] **Step 1: Failing tests.**
  - Applying twice gives the same output as applying once.
  - The debug build type keeps the debug key.
  - A file without the anchors throws.
  - `app.config` includes the plugin.
- [ ] **Step 2:** `npx jest plugins` → FAIL.
- [ ] **Step 3: Implement and wire CI.**
  - A composite action cannot read `secrets`, so `ci.yml` computes `HAS_KEYSTORE: ${{ secrets.ANDROID_KEYSTORE_BASE64 != '' }}` and passes `keystore-base64`, `keystore-password`, `key-alias` and `key-password` to `android-build` as `with:` inputs; the action reads only `inputs.*`.
  - **When true:**
    - decode the keystore to `$RUNNER_TEMP/release.jks`;
    - export the `OA_*` variables from the three other inputs;
    - run `$ANDROID_HOME/build-tools/$(ls $ANDROID_HOME/build-tools | sort -V | tail -1)/apksigner verify --print-certs` and write the cert SHA-256 to `$GITHUB_STEP_SUMMARY`;
    - name the output `…-release.apk`.
  - **When false:** an unsigned APK cannot be installed, so this is the fallback:
    - sign with the debug key and name it `…-debugkey.apk`;
    - the summary says "Release keystore secrets not set: APK signed with the debug key; it will not update a release-signed install."
  - **README owner steps.** The builder never handles the key.
    1. `keytool -genkeypair -v -storetype PKCS12 -keystore openalgo-release.jks -alias openalgo -keyalg RSA -keysize 4096 -validity 10000`.
    2. `base64 -i openalgo-release.jks | gh secret set ANDROID_KEYSTORE_BASE64`, then `gh secret set` for the alias and both passwords.
    3. Keep the `.jks` and its passwords in two offline places.
- [ ] **Step 4:** `npx jest plugins && actionlint .github/workflows/*.yml && npx expo config --type public > /dev/null` → PASS, no output.
- [ ] **Step 5:** Commit `ci: release keystore signing with a debug-key fallback`.

### Task 23: Compatibility suite and Maestro flows (CI only)

**Files:** `test/helpers/mockServer.ts`, `test/compat/{onboarding,capabilities,realtime,budgets}.test.ts`, `e2e/{onboarding-live,onboarding-polling}.yaml`, `e2e/README.md`. Add the `e2e-android` job to `ci.yml`.

**Interfaces:** `startMockServerProcess(env?)` returns `{ origin; wsUrl; control(p); stats(); stop() }`. It spawns `main.mjs` with `PORT=0 WS_PORT=0` and waits for `MOCK_READY`. Tests use Node `fetch` and `ws`, with `allowDevHosts: true`.

- [ ] **Step 1: Failing tests.** Each runs `test.each` over `['2.0.0.0','2.0.1.6','2.0.2.0','2.0.3.5']`.
  - **Onboarding:**
    - `serverStep` → `keyStep` → `feedStep` reaches live on every profile;
    - 1.0.0.41 gives `too_old`;
    - with `WS_PORT=off`, it falls back to polling after exactly 3 handshakes.
  - **Capabilities,** after the WS connects:

    | Profile | orderStream | close1012 | optionchainGreeks | portfolioTools | sectorRotation |
    |---|---|---|---|---|---|
    | 2.0.0.0 | false | false | false | false | false |
    | 2.0.1.6 | true | false | false | false | false |
    | 2.0.2.0 | true | false | true | true | false |
    | 2.0.3.5 | true | true | true | true | true |

  - **Fallback detection:**
    - `appInfo:false` on 2.0.3.5 still succeeds via swagger;
    - with `swagger:false` too, 2.0.2.0 succeeds via the probe;
    - probes stay ≤ 10.
  - **Realtime:**
    - a Quote tick arrives within 2 s;
    - Depth 20 with `maxDepth 20` gives `confirmedDepth` 20 and 20 levels; with `maxDepth 5` and `ackEchoesDepth`, the ack says 20 but `confirmedDepth` is 5;
    - on 2.0.2.0, a tick with `close: 0` keeps the seeded close;
    - on 2.0.1.6 with `authGraceMs: 500` and the client's auth held back (a `WebSocketImpl` wrapper delays the first `send` by 600 ms), the client counts a failure on 4401 and reconnects after 1 s;
    - `subscribe_orders` behaves as each profile defines;
    - on 2.0.3.5, a broker logout gives 1012, then `on1012` and a reconnect;
    - on 2.0.2.0, `silenceFeed` with `silenceMs` 1000 and the exchange open gives one reconnect, then `onSilence`.
  - **Errors:**
    - a wrong key gives `KeyInvalid` after one search;
    - a logged-out broker gives `BrokerLoggedOut`;
    - both ban forms give `IpBanned`, after which no request reaches the mock, and `stats().wsConnections` and `wsAuthAttempts` stay flat for 10 s;
    - each 429 shape gives `RateLimited` and a 2 s gate.
  - **Budgets:**
    - a live watchlist makes ≤ 1 `multiquotes` call (the seed) and no other `/api/v1` call in 10 s;
    - home-rate polling makes ≤ 6 `multiquotes` calls in 10 s;
    - no request repeats after a 403 or a 404.
- [ ] **Step 2:** `npm run test:compat` → FAIL, then PASS. A failure here is a bug in Tasks 5–20: fix it test-first, in the module that owns it.
- [ ] **Step 3: Maestro.**
  - **`onboarding-live.yaml`:**
    1. Enter `http://10.0.2.2:5000`. It is in 10/8, so release builds allow it.
    2. Accept the http warning, enter the key `abab…` (64 characters), run Test live feed, then Save.
    3. `watch-ltp-NSE-RELIANCE` shows a value other than `--` within 10 s.
  - **`onboarding-polling.yaml`:** the same flow with `WS_PORT=off`. `badge-polling` appears, and the price updates.
  - **CI job `e2e-android`:** not on PRs; needs `checks`; matrix `PROFILE` `2.0.0.0` and `2.0.3.5`.
    1. Run `android-build` with `abis: x86_64`.
    2. Start the mock with `PORT=5000 WS_PORT=8765`.
    3. Download Maestro from `https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.12.1/maestro.zip` and verify sha256 `54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7`.
    4. Start `android-emulator-runner` (api 34, x86_64, google_apis), `adb install` the APK, and run both flows. Restart the mock with `WS_PORT=off` before the polling flow.
  - `e2e/README.md` lists every testID.
- [ ] **Step 4:** `npm run test:compat && actionlint .github/workflows/ci.yml` → PASS, no output.
- [ ] **Step 5:** Commit `test: stock-server compatibility suite and Maestro onboarding flows`.

### Task 24: Real-server check skeleton

**Files:** `test/real/{env,realServer.test}.ts`. Modify `README.md`.

**Interfaces:** `loadTestEnv(path = '.env.test.local')` returns `{ url; key; wsUrl: string | null }` or `null`.

**Behaviour:**
- **No env file:** the suite reduces to a single `test.skip('no .env.test.local')`.
- **Safety:** the first test reads the analyzer status. If it isn't `analyze`, every test fails with "Test server is in LIVE mode. Switch it to the analyzer on the web first." The suite never toggles the mode.
- **Checks, in order:**
  1. `probeServer` returns ok, and the `capabilityReport` is printed.
  2. `checkKey` is ok.
  3. The broker session is active, with a broker name.
  4. multiquotes for NSE:RELIANCE has an `ltp`, and depth has 5 bids.
  5. With a `wsUrl`:
     - `testLiveFeed` is ok;
     - a mode-3, depth-5 subscription is acked, with a tick within 10 s while NSE is open;
     - `subscribe_orders` behaves as the version says.
- **Plan B placeholders:** `test.todo` entries for books, analyzer orders, modify, cancel, and each tool.

- [ ] **Step 1:** Write the tests. `npm run real-server-check` → `1 skipped`.
- [ ] **Step 2: With the owner.**
  - The test server is the openalgo checkout on the Mac, never the live trading server. It runs in analyzer mode, logged in to the broker, with `FLASK_HOST_IP='0.0.0.0'` and `WEBSOCKET_HOST='0.0.0.0'`.
  - The owner writes `.env.test.local`.
  - `npm run real-server-check` → all PASS, and the key never appears in the output.
- [ ] **Step 3:** `git status --short` does not list `.env.test.local`, and `node scripts/check-staged.mjs` exits 0.
- [ ] **Step 4:** Commit `test: real-server check skeleton against the local test server`.

### Task 25: M1 exit run

**Files:** `README.md` and `e2e/README.md`, only if a step proves them wrong.

- [ ] **Step 1:** `npm run lint && npm run typecheck && npx jest --ci && npm run test:scripts && npm run test:compat && npm run boundaries && npm run tokens:check && npm run export && npm run bundles && rm -rf dist-export && gitleaks git --redact --no-banner .` → all pass, `ok`, `no leaks found`. If bundles grew by more than 5%, run `--update` and give the reason in the PR.
- [ ] **Step 2:** Stop. Ask the owner to push `phase1/foundation` and open a PR; the builder never pushes. Expected: `checks`, `android` and `ios-simulator` are green, and `e2e-android` is green on a dispatch run.
- [ ] **Step 3: With the owner,** using the CI APK, or the simulator app via `xcrun simctl install booted`:
  1. **Local test server over LAN http:** the Not encrypted badge, version, broker and ANALYZE all show.
  2. **Live prices:** `watch-ltp-NSE-RELIANCE` ticks during market hours.
  3. **Tunnel:** `cloudflared tunnel --url http://localhost:5000`. After 3 handshakes the Polling badge and banner show, and prices refresh about every 5 s.
  4. **Mock onboarding:** 2.0.0.0 and 2.0.3.5 are green in the compat suite and the e2e matrix.
  5. **Lock:** the overlay shows after the "Lock after" interval, and unlock works.
  6. **Analyzer toggle:** the install-wide confirm appears. Toggle on the test server only, then back.
  7. **OpenAlgo Desktop** (design 7.1): if the owner has a Desktop build, repeat checks 1–2 against it. Otherwise the README lists Desktop as not yet supported.
  8. **Scan text** (design 7.1): on an iPhone (Live Text) and on Android with Gboard, scan a printed key into the key field, masked and shown. Record where it works; if it works only when shown, the Task 19 hint stays.
- [ ] **Step 4:** Record the device, OS and results in the PR description, not in a file, then stop for review.

---

## Self-review

1. **Spec coverage.** M0: T1–T4. M1: onboarding T19; Account, toggle, diagnostics and lost phone T20; key and lock T10; HTTP, scheduler and errors T7–T8; probe T9; key/broker state and banners T11, T18; live data and polling T13–T16; UI and tokens T2, T17; tabs T18; mock and compat T5, T23; keystore T22. Exit: T23–T25. Depth: T5, T13–T16. Deferred: Plan B (backup, the depth screen and broker depth map, watchlist editing, books, orders); M4 (DOM, CSP, gateway, WebView check, goldens); M6 (TestFlight).
2. **Step scan.** Every step names its files, signatures and values; the B-items double as the test lists.
3. **Type consistency.** Each name is defined once, before its first use, and used unchanged:

   | Defined in | Names | Used in |
   |---|---|---|
   | T6 | `ServerProfile`, `ProfileStorage`, `atLeast` | T9, T18–T21 |
   | T7 | `EndpointId`, `Lane`, `ApiError`, `scriptedFetch` | T8–T12, T18–T20 |
   | T9 | `Capabilities`, `WsCaps` | T15, T18, T20, T23 |
   | T10 | `KeyVault`, `LockController` | T18, T20 |
   | T11 | `BrokerSession`, `BrokerStatus`, `FeedState` | T15–T20 |
   | T13 | `TickStore`, `Quote`, `Mode`, `DepthLevels`, `Inbound`, `OrderUpdate` | T14–T16, T21 |
   | T15 | `Realtime` | T16–T18 |
   | T16 | `PollingEngine` | T18 |

4. **Review Focus.** RF 1–5 have tests in T10, T9, T11 and T18, T15, and T13.

---

## Interfaces exported for Plan B

Signatures are in the defining task (T#).

- `~/core/http/endpoints` (T7): `ENDPOINTS`, `EndpointId`, `EndpointDef`, `Lane`.
- `~/core/http/api` (T8): `createApi`, `Api.call<T>(id, body, schema, o?)`. Every M2 call goes through it.
- `~/core/http/client` (T7): `HttpClient` (`request`, `getPublic`, `probe`), `RawResponse`.
- `~/core/http/scheduler` (T8): `Scheduler` (`run`, `pause`, `resume`, `halt`, `unhalt`, `stats`), and the `order`, `smart` and `control` lanes.
- `~/core/http/errors` (T7): `ApiError`, `ApiErrorKind` (10 kinds), `userMessage`, `unknownFields`.
- `~/core/http/coerce` and `schemas` (T7): `num`, `optNum`, `int`, `str`, `bool`, `dmyHms`, `expiryIso`, `envelope`, `PingSchema`, `FundsSchema`, `AnalyzerSchema`, `SearchSchema`, `MultiQuotesSchema`, `QuotesSchema`, `DepthSchema`.
- `~/core/capabilities` (T9): `Capabilities`, `WsCaps`, `FeatureId`, `VERSION_GATES`, `hasEndpoint(c, id)`, `gate(c, f)`, `CapabilityStore` (`get`, `subscribe`, `setField`, `setWs`).
- `~/core/credentials` (T10, T11): `confirmLiveWrite(d)`, `expoAuthenticate()`, `KeyVault`, `LockController`, `BrokerSession`, `BrokerStatus` (`check`, `resolveAuth403`, `fetchBrokerName`).
- `~/core/services` (T11, T18): `useConnection` (broker, brokerSession, keyState, banned, feed, transport, analyzer, semiAutoSeen), `markSemiAuto`, `Services` (including `books.poke()`), `useServices`, `createServices`, `disposeServices`.
- `~/core/realtime/protocol` (T13): `Mode`, `DepthLevels`, `DepthLevel`, `QuotePatch`, `Inbound`, `OrderUpdate`, `parseInbound`, `quoteKey`, `tickToPatch`, `depthRestToPatch`, `multiquoteToPatch`.
- `~/core/realtime/types` (T11): `FeedState`.
- `~/core/realtime/tickStore`, `useQuote` and `marketHours` (T13): `TickStore`, `Quote`, `useQuote(key, active)`, `useDepth(key, active)`, `useFeedStale()`, `useScreenActive()`, `isExchangeOpen`, `isAnyMarketOpen`, `istParts`.
- `~/core/realtime/wsClient` (T15): `Realtime` (`acquire(SubRequest)`, `isLive(ex, sym)`, `confirmedDepth`, `status`, `onStatus`), `FeedStatus`, `SubRequest` (T14).
- `~/core/realtime/polling` and `useLive` (T16): `POLL_RATES`, `PollConsumer` (`quotes`, `depth`, `custom`), `PollingEngine` (`register(c, active)`), `LiveContext`, `useLiveQuote(ex, sym, mode?)`, and `useLiveDepth(ex, sym, levels?)` → `{ buy, sell, levels, confirmedDepth?, source }`.
- `~/core/query` (T12): `qk` (`root` … `orderstatus`), `clearProfileCache`, `createBookInvalidator`.
- `~/core/config` (T6): `KV`, `ProfileStorage`, `USER_CONTENT`, `ServerProfile`, `createProfileRepo`, `classifyHost`, `pollNetwork`, `normalizeVersion`, `compareVersions`, `atLeast`, `usePrefs`, `setPrefs`.
- `~/core/platform` (T10): `tapLight`, `notifySuccess`, `notifyWarning`, `useSecureScreen`, `applyPrivacy`.
- `~/ui` (T17): `ThemeProvider`, `useTheme`, `fmtPrice`, `fmtSigned`, `fmtPct`, `fmtQty`, `signOf`, `Text`, `Price`, `Change`, `Button` (with buy and sell variants), `ListRow`, `Sheet`, `Skeleton`, `EmptyState`, `ErrorState`, `Badge`, `Banner`, `StatusBadges`, `NotYetAvailable`.
- `~/features/watchlist/{model,store}` (T21): `WatchlistsSchema` (version 1), `loadWatchlists`, `saveWatchlists`.
- **Routes** (T18–T20): `(app)/(tabs)/{index,orders,portfolio,tools,account}`, `(app)/account/{server,key,diagnostics,lost-phone,sign-out}`, `(app)/help`, `(onboarding)/{server,update,key,feed,help}`. Reserved for Plan B: `(app)/search`, `(app)/instrument/[key]`, `(app)/depth/[key]`, `(app)/order/new`, `(app)/order/[id]/modify`.
- **Test infrastructure** (T5, T23): `startMockServer`, `PROFILES` and the control fields (Plan B adds order and book endpoints), `startMockServerProcess`, `FakeSocket` (T15), `scriptedFetch` (T7), `memoryKV` (T6).
