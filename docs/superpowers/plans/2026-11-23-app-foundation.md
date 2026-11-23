# OpenAlgo Mobile: App Scaffold and Foundation (M0 scaffold + M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the repo root into the real Expo app with its CI quality gates, then build the foundation: https-only onboarding, OAuth sign-in with a per-device token, secure token handling, app lock, typed HTTP and WebSocket layers, the UI kit, the five tabs, the LIVE/ANALYZE badge, diagnostics, and a read-only watchlist with live prices.

**Architecture:** The repo root becomes the Expo project; `spike/` stays untouched until the M0 phone test passes. Core logic is written as pure TypeScript with injected dependencies (`fetch`, a SecureStore wrapper, crypto, WebSocket constructor, clock), so every behaviour is unit-tested under jest-expo without native modules. A Node mock server (`dev/mock-server`) implements the server contract below. The app can therefore be built, unit-tested and demoed before the server plan (Plan 1, `openalgo` repo) merges.

**Tech Stack:**
- Expo SDK 58: expo ~58.0.26, React Native 0.88.1, React 19.3.0, Hermes, New Architecture.
- expo-router ~58.0.32 (NativeTabs, `Stack.Protected`), React Compiler.
- TypeScript ~6.0.3 strict, zod 4.6.7, TanStack Query 5.108.3, zustand 5.0.15.
- expo-secure-store, expo-crypto, expo-web-browser, expo-local-authentication, expo-screen-capture.
- @shopify/flash-list 2.3.2.
- jest-expo ~58.0.15 with @testing-library/react-native 14.1.0.
- Biome 2.6.8, dependency-cruiser 18.9.0, gitleaks 8.30.1.
- GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-23-openalgo-mobile-phase1-design.md`. Read it before starting, in particular sections 7.3–7.9, 8, 9 and 12. The server side of every contract item below is Plan 1 (`docs/superpowers/plans/2026-11-23-server-auth.md`).

## Global Constraints

**Identity**
- App id, Android package, iOS bundle id and URL scheme: `in.openalgo.mobile`. Display name: `OpenAlgo`.
- OAuth `client_id=openalgo-mobile`.
- Redirect URI: exactly `in.openalgo.mobile:/oauth/callback`.
- Requested scope: `read:market read:account write:orders`.

**Transport**
- **https only.** The single exception is `http://` on a loopback host (`localhost`, `127.0.0.1`, `10.0.2.2`, `[::1]`), and only when `__DEV__` is true, so dev builds can reach `dev/mock-server`.
- Release builds never enable cleartext traffic. Do not add `usesCleartextTraffic` or ATS exceptions.
- Every request uses `credentials: 'omit'` and sends `Authorization: Bearer <access>`.
- `/api/v1/*` bodies are JSON and never contain `apikey`. Send `{}` when an endpoint takes no parameters.

**Credentials**
- The API key never exists in the app.
- The access token lives in memory only.
- The refresh token lives in expo-secure-store with `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`, under key `oa.<profileId>.rt`.
- No token, ticket, PKCE verifier or code ever appears in zustand, in logs, in the query cache or in diagnostics output.

**Retries**
- The HTTP client never retries a request.
- The one exception: after a 401 `TOKEN_EXPIRED` or `TOKEN_INVALID`, it replays the request once with a refreshed token. That is safe even for orders, because the server rejects a 401 before any service runs (contract C6).
- Query reads may retry twice on `network` or `server` errors. Mutations always use `retry: 0`.

**Code**
- TypeScript `strict` plus `noUncheckedIndexedAccess`.
- Biome formatter matching the web frontend: 2 spaces, width 100, single quotes, JSX double quotes, `semicolons: asNeeded`, `trailingCommas: es5`.
- Import boundaries (dependency-cruiser):
  - `src/dom/**` must not import `src/core/session/**` or `src/core/http/**`;
  - `src/core/**` must not import `src/features/**` or `src/app/**`;
  - a feature must not import another feature;
  - `src/app` (routes) may import anything.

**CI**
- Actions pinned by full SHA. Reuse the SHAs already in `.github/workflows/build.yml`:
  - checkout v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1`
  - setup-node v7.1.0 `949feb2413d6458794dcd2491c4babbbce0c15c1`
  - setup-java v6.3.0 `d1374f8ac74474200d16ef8ecee22c7ae7a51880`
  - upload-artifact v7.0.2 `cf430e030ddbb5b0abf93d22962f4752f3646cd9`
- `permissions: contents: read`, `persist-credentials: false`, `npm ci`, Node `26`.

**Performance**
- The Hermes bundle must stay at or under 4,340,000 bytes (the spec's "4.34 MB").
- Growth of more than 5% over the committed baseline fails CI.
- The tick store flushes at most once per animation frame. Rows subscribe per symbol.

**Honesty**
- Tabs that are not built yet say so plainly ("not in this build yet").
- No status document claims more than exists.
- M2 exit results go in the PR description, not in a committed "done" file.

**Process**
- Work on branch `phase1/app-foundation`. Never push without the owner's OK.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Pass it as a second `-m`.

## Server contract (implemented by Plan 1; the app and the mock server match it exactly)

**C1. Discovery**
- `GET {origin}/.well-known/oauth-authorization-server`.
- Returns `issuer` equal to the origin, with no trailing slash, plus:
  - `authorization_endpoint` = `{origin}/oauth/authorize`
  - `token_endpoint` = `{origin}/oauth/token`
  - `revocation_endpoint` = `{origin}/oauth/revoke`
  - `code_challenge_methods_supported: ["S256"]`

**C2. Client and authorize**
- Public client `openalgo-mobile`, redirect `in.openalgo.mobile:/oauth/callback`.
- Authorize params: `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`, and `device_name` (1–64 characters).
- Consent offers Trade (all three scopes) or Read-only (`read:market read:account`). The token response `scope` is what was granted.

**C3. Token**
- `POST /oauth/token`, form-encoded.
- Code grant: `grant_type=authorization_code&code&redirect_uri&code_verifier&client_id`.
- Refresh grant: `grant_type=refresh_token&refresh_token&client_id`.
- 200 returns `{access_token, token_type:"Bearer", expires_in (900), refresh_token:"<id>.<secret>", scope}`.
- The refresh token rotates on every use.
- **Reuse grace.** Replaying the just-rotated token within 60 s returns a fresh pair, provided its successor has never been used; that successor is then superseded. Any other replay of a rotated token revokes the whole device (family). This covers a refresh response lost on a mobile network.
- Errors are `{error, error_description}` with 400 or 401. `invalid_grant` means signed out.
- Rate limit: 20 per minute per IP.

**C4. Revoke**
- `POST /oauth/revoke` with `token`, `token_type_hint=refresh_token` and `client_id`.
- Always returns 200 and revokes the family. That device's open sockets close with **4403**.

**C5. Access token**
- RS256 JWT with `aud="openalgo-app"`, valid 15 minutes.
- The app treats it as opaque and schedules refresh from `expires_in`.

**C6. Bearer errors**
- 401 `{status:"error", code:"TOKEN_EXPIRED"|"TOKEN_INVALID"|"TOKEN_REVOKED", message}`, with `WWW-Authenticate: Bearer error="invalid_token"`.
- 403 `{status:"error", code:"INSUFFICIENT_SCOPE", message, required_scope}`.
- 403 with `code` `BROKER_SESSION_EXPIRED`, `API_KEY_MISSING` or `MOBILE_APP_DISABLED`.
- 403 `ENDPOINT_NOT_ALLOWED`: an `/api/v1` path the app may not call, such as GTT or alerts. It classifies as `forbidden`.
- 400 `INVALID_JSON`: a bearer write whose body isn't a JSON object. It classifies as `validation`.
- Every other error keeps the existing shape, `{status:"error", message}`, with no `code`.

**C7. `GET /api/v1/app/info`**
- Works without auth (the public part). With a bearer token it adds `account`:
  `{status:"success", data:{server_version, app_api_version: 1, min_app_version:"1.0.0", mobile_app_enabled, issuer, ws_path:"/ws", capabilities: string[], account: null | {user, broker: string|null, broker_session:"active"|"expired", analyze_mode, order_mode:"auto"|"semi_auto", scopes: string[], device_name}}}`
- Compatibility rule: `app_api_version >= 1`, and the app's version ≥ `min_app_version`.
- A 404 means "upgrade OpenAlgo". `mobile_app_enabled:false` means "enable mobile app access".

**C8. WebSocket ticket and socket**
- `POST /api/v1/ws/ticket` (bearer, needs `read:market`, body `{}`) returns `{status:"success", data:{ticket, expires_in:60, ws_path:"/ws"}}`. Each ticket is single-use, so every (re)connect needs a new one.
- Connect to `wss://{origin}{ws_path}`. The first message, within 15 s, is `{"action":"authenticate","ticket":…}`.
- Success is `{"type":"auth","status":"success","broker",…}`. Failure is `{"status":"error","code":"AUTHENTICATION_ERROR","message"}`.
- Close codes:
  - 4403: device revoked;
  - 1012: broker credentials changed;
  - 4401: auth timeout.
- Everything else is the existing protocol: `subscribe`/`unsubscribe` with `symbols[]` and `mode` LTP, Quote or Depth; `market_data` ticks carrying `{ltp, open, high, low, close, volume}`; `subscribe_orders` and `order_update`; `ping`/`pong`.

**C9. Session routes with bearer**
- Request and response shapes are unchanged from the web. M2 uses only `GET /watchlist/api/lists`, which returns `{status:"success", data:[{id, name, position, items:[{id, symbol, exchange, position}]}]}`.

## Review Focus

Each line names an input or condition a person will hit, and the expected behaviour. The test that pins it is added to the owning task, marked **(RF n)**.

1. **Server addresses as people actually type them.** Expected:
   - surrounding whitespace, an uppercase host, a trailing slash, or a pasted page URL such as `https://x.ngrok.app/login?next=/` all normalise to the origin, and the app shows "Using https://x.ngrok.app";
   - `http://` on a non-loopback host, or `user:pass@`, is refused with a specific message.

   Owner: Task 8.
2. **The process dies after the server rotated the refresh token but before the new one was saved.** On the next start the old token is replayed. Expected:
   - within the server's 60 s grace, the app simply gets a fresh pair and carries on;
   - after it, the server revokes the family and the app lands on sign-in with "Your sign-in expired. Sign in again.";
   - in both cases, no crash and no refresh loop.

   Owner: Task 11.
3. **The auth browser is cancelled, dismissed or abandoned**, or the callback carries the wrong `state`. Expected: the app is back on the server screen with "Sign-in was cancelled" (or the specific error), no token request is made, and the next attempt starts fresh. Owner: Task 10.
4. **The server answers with non-JSON**, such as an nginx 502 HTML page, a captive-portal page, or an `/api/v1/app/info` route that serves the SPA's `index.html`. Expected:
   - the HTTP client throws `bad_response` (2xx) or `server` (5xx), never a JSON parse crash;
   - onboarding says "This doesn't look like an OpenAlgo server."

   Owners: Tasks 9 and 10.
5. **The market is closed or symbols are illiquid, so no ticks arrive.** Expected: watchlist rows show the last price and change from one `multiquotes` call made when the screen gains focus, not `--`. A later live tick replaces the seeded value, and a seeded value never overwrites a newer tick. Owner: Task 20.

---

## File structure

```
app.config.ts  package.json  tsconfig.json  biome.json  jest.config.js  jest.setup.ts
.dependency-cruiser.cjs  .gitleaks.toml  openalgo.ref  bundle-baseline.json  expo-env.d.ts
assets/images/                      icon + android adaptive icon + splash (copied from spike/app/assets/images)
src/app/                            routes only
  _layout.tsx                       providers, RootStack (Stack.Protected), LockOverlay
  +native-intent.tsx                swallow /oauth/callback and /broker/done deep links
  (onboarding)/_layout.tsx  (onboarding)/server.tsx
  (app)/_layout.tsx                 AppServicesProvider, QueryClientProvider, RealtimeLifecycle
  (app)/diagnostics.tsx
  (app)/(tabs)/_layout.tsx          StatusStrip + NativeTabs (5 triggers)
  (app)/(tabs)/index.tsx  orders.tsx  portfolio.tsx  tools.tsx  account.tsx
src/core/config/     constants.ts  appVersion.ts  serverOrigin.ts  profile.ts  prefs.ts
src/core/log/        logger.ts
src/core/http/       errors.ts  coerce.ts  schemas.ts  client.ts
src/core/session/    pkce.ts  oauthSchemas.ts  serverCheck.ts  tokenClient.ts  signIn.ts
                     tokenStore.ts  session.ts  sessionStatus.ts  brokerSession.ts
src/core/query/      queryClient.ts  keys.ts  wiring.ts
src/core/realtime/   protocol.ts  tickStore.ts  subscriptions.ts  wsClient.ts  useScreenActive.ts  useLiveQuote.ts
src/core/platform/   lock.ts  privacy.ts  deviceName.ts
src/core/services/   deps.tsx  appServices.tsx  sessionController.ts
src/ui/              tokens.ts (GENERATED)  theme.tsx  format.ts  Text.tsx  Price.tsx  Change.tsx  Button.tsx
                     ListRow.tsx  Badge.tsx  Skeleton.tsx  EmptyState.tsx  ErrorState.tsx  NotYetAvailable.tsx  LockOverlay.tsx
src/features/onboarding/  problemCopy.ts  useOnboarding.ts  screens/ServerScreen.tsx
src/features/account/     model.ts  api.ts  diagnostics.ts  components/ModeBadge.tsx  components/StatusStrip.tsx
                          screens/AccountScreen.tsx  screens/DiagnosticsScreen.tsx
src/features/watchlist/   model.ts  api.ts  components/WatchRow.tsx  screens/WatchlistScreen.tsx
dev/mock-server/     main.mjs  server.mjs  state.mjs  oauth.mjs  api.mjs  feed.mjs  prices.mjs  fixtures/watchlists.json  *.test.mjs
scripts/             openalgo-src.mjs  sync-openalgo.mjs  gen-tokens.mjs  lib/css-tokens.mjs  check-bundles.mjs  *.test.mjs
test/                app.config.test.ts  env.test.ts  helpers/{fakeSocket.ts,memoryKV.ts,mockServer.ts}
                     fixtures/openalgo-docs/{multiquotes.json,analyzer-live.json,analyzer-analyze.json}  fixtures/boundaries/…
e2e/README.md
.github/workflows/ci.yml  .github/workflows/spike.yml (moved from build.yml)  .github/actions/ios-build/action.yml
```

Unit tests sit next to the code as `*.test.ts(x)`. Node-side tests (`scripts/`, `dev/`) use `node:test` and run under `npm run test:scripts`.

---

## M0: scaffold

### Task 1: Expo project at the repo root

**Files:**
- Create: `package.json`, `app.config.ts`, `tsconfig.json`, `biome.json`, `jest.config.js`, `jest.setup.ts`, `expo-env.d.ts`, `src/app/_layout.tsx`, `src/app/index.tsx` (a placeholder that Task 17 removes), `test/app.config.test.ts`, `test/env.test.ts`
- Copy: `spike/app/assets/images/{icon.png,android-icon-foreground.png,android-icon-background.png,android-icon-monochrome.png,splash-icon.png}` → `assets/images/`
- Modify: `.gitignore`. Add `/android/`, `/ios/`, `.expo/`, `dist-export/`, `coverage/`, `*.tgz`.

**Interfaces:**
- Produces: the npm scripts every later task runs.
  - `lint` = `biome ci .`
  - `format` = `biome format --write .`
  - `typecheck` = `tsc --noEmit`
  - `test` = `jest`
  - `test:scripts` = `node --test "scripts/**/*.test.mjs" "dev/**/*.test.mjs"`
  - `boundaries` = `depcruise src --config .dependency-cruiser.cjs`
  - `tokens` / `tokens:check` = `node scripts/gen-tokens.mjs [--check]`
  - `bundles` = `node scripts/check-bundles.mjs dist-export`
  - `mock` = `node dev/mock-server/main.mjs`
  - `sync-openalgo` = `node scripts/sync-openalgo.mjs`
  - `start`, `android`, `ios` as in the spike
- Produces: the `~/*` → `src/*` alias, set in tsconfig `paths` (Expo's `tsconfigPaths` stays enabled) and in jest `moduleNameMapper`.

- [ ] **Step 1: Write `package.json`.** Name `openalgo-mobile`, version `0.1.0`, `"private": true`, `"main": "expo-router/entry"`, `"engines": {"node": ">=26"}`.
  - **Dependencies copied from `spike/app/package.json` with the same specifiers:**
    - expo, expo-router, expo-constants, expo-linking, expo-splash-screen, expo-status-bar, expo-system-ui
    - expo-web-browser, expo-device, expo-haptics, expo-clipboard, expo-font, expo-symbols
    - react, react-native, react-native-screens, react-native-safe-area-context, react-native-gesture-handler, react-native-reanimated, react-native-worklets
    - @shopify/flash-list, zustand
  - **New dependencies:**
    - `expo-secure-store ~58.0.3`, `expo-crypto ~58.0.8`, `expo-local-authentication ~58.0.3`, `expo-screen-capture ~58.0.6`, `expo-application ~58.1.2`
    - `@react-native-community/netinfo 12.0.1`, `@react-native-async-storage/async-storage 2.2.0`
    - `@tanstack/react-query 5.108.3`, `zod 4.6.7`
  - **devDependencies:**
    - `typescript ~6.0.3`, `@types/react ~19.3.0`
    - `jest 30.5.2`, `jest-expo ~58.0.15`, `@react-native/jest-preset 0.88.1`, `test-renderer 1.3.0`, `@testing-library/react-native 14.1.0`, `@types/jest 30.0.0`
    - `@biomejs/biome 2.6.8`, `dependency-cruiser 18.9.0`
    - `culori 4.0.2`, `postcss 8.5.23`, `tailwindcss 4.3.0` (tailwind is only the source of `theme.css` palette values)
    - `ws 8.22.2`, `expo-doctor 1.21.8`
  - **Not included:** react-dom, react-native-web, axios, Plotly, openalgo-charts. Those arrive with DOM components in M4/M5.
  - Run `npm install` to create `package-lock.json`.

- [ ] **Step 2: Write the failing tests.**

```ts
// test/app.config.test.ts
import pkg from '../package.json'
import makeConfig from '../app.config'
const build = (env: Record<string, string | undefined>) => {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try { return makeConfig({ config: {} } as never) } finally { process.env = saved }
}
test('identity', () => {
  const c = build({ BUILD_NUMBER: undefined })
  expect(c.name).toBe('OpenAlgo')
  expect(c.scheme).toBe('in.openalgo.mobile')
  expect(c.ios?.bundleIdentifier).toBe('in.openalgo.mobile')
  expect(c.android?.package).toBe('in.openalgo.mobile')
  expect(c.version).toBe(pkg.version)
})
test('build number comes from BUILD_NUMBER', () => {
  expect(build({ BUILD_NUMBER: '42' }).android?.versionCode).toBe(42)
  expect(build({ BUILD_NUMBER: '42' }).ios?.buildNumber).toBe('42')
  expect(build({ BUILD_NUMBER: undefined }).android?.versionCode).toBe(1)
  expect(() => build({ BUILD_NUMBER: '4x' })).toThrow(/BUILD_NUMBER/)
})
test('no cleartext, no Android backup, compiler and typed routes on', () => {
  const c = build({})
  expect(c.android?.allowBackup).toBe(false)
  expect(JSON.stringify(c)).not.toMatch(/usesCleartextTraffic|NSAllowsArbitraryLoads/)
  expect(c.experiments).toMatchObject({ typedRoutes: true, reactCompiler: true })
})
// test/env.test.ts — integration tests rely on Node's fetch and the ws client
test('Node fetch is available under jest-expo', async () => {
  expect(await (await fetch('data:text/plain,ok')).text()).toBe('ok')
})
test('ws client is importable', async () => {
  expect(typeof (await import('ws')).WebSocket).toBe('function')
})
```

- [ ] **Step 3: Run `npx jest test/` and confirm it fails.** Expected: FAIL with "Cannot find module '../app.config'".

- [ ] **Step 4: Implement `app.config.ts`**, exporting a default `({ config }: ConfigContext) => ExpoConfig`:
  - **Identity:** name `OpenAlgo`, slug `openalgo-mobile`, `version: pkg.version`, scheme `in.openalgo.mobile`, orientation `portrait`, `userInterfaceStyle: 'automatic'`, icon `./assets/images/icon.png`.
  - **iOS:** `{ bundleIdentifier, buildNumber: String(n), supportsTablet: false }`.
  - **Android:** `{ package, versionCode: n, allowBackup: false, predictiveBackGestureEnabled: false, adaptiveIcon }`, with the adaptiveIcon block copied from the spike.
  - **Plugins:**
    - `'expo-router'`
    - `['expo-splash-screen', { backgroundColor: '#0a0a0a', image: './assets/images/splash-icon.png', imageWidth: 76 }]`. `#0a0a0a` is the web's dark `--background`; Task 3 asserts this value.
    - `['expo-local-authentication', { faceIDPermission: 'OpenAlgo uses Face ID to unlock the app.' }]`
  - **Experiments:** `{ typedRoutes: true, reactCompiler: true }`.
  - **Build number:** `n` is parsed from `process.env.BUILD_NUMBER`. It defaults to `1`, must match `/^[1-9]\d*$/`, and otherwise throws `BUILD_NUMBER must be a positive integer`.
  - **The other config files:**
    - `tsconfig.json`: extends `expo/tsconfig.base`; `strict`, `noUncheckedIndexedAccess`, `paths: {"~/*": ["./src/*"]}`; include `src`, `test`, `app.config.ts`, `jest.setup.ts`, `.expo/types/**/*.ts`, `expo-env.d.ts`; exclude `spike`, `dev`, `scripts`.
    - `biome.json`: the frontend's settings from the Global Constraints; `files.includes` covers `src`, `test`, `scripts`, `dev` and the root config files; it excludes `src/ui/tokens.ts`, `spike/**` and `test/fixtures/**`.
    - `jest.config.js`: `preset: 'jest-expo'`, `setupFiles: ['<rootDir>/jest.setup.ts']`, `moduleNameMapper: {'^~/(.*)$': '<rootDir>/src/$1'}`, `testPathIgnorePatterns: ['/node_modules/', '/spike/', '/dev/', '/scripts/', '/android/', '/ios/']`.
    - `jest.setup.ts`: AsyncStorage's official jest mock (`@react-native-async-storage/async-storage/jest/async-storage-mock`) and NetInfo's (`@react-native-community/netinfo/jest/netinfo-mock.js`).
    - `src/app/_layout.tsx`: a plain `<Stack screenOptions={{ headerShown: false }} />`.
    - `src/app/index.tsx`: renders `OpenAlgo`.

- [ ] **Step 5: Run the checks and confirm they all pass.**
  - Run: `npx jest test/ && npm run typecheck && npm run lint && npx expo install --check && npx expo-doctor && npx expo export --platform android --platform ios --output-dir dist-export`
  - Expected: tests PASS, no tsc or Biome errors, "Dependencies are up to date", doctor "No issues detected", and the export finishes.
  - If `test/env.test.ts` fails because the RN preset replaced `fetch`, stop and report. Tasks 11 and 14 depend on Node's fetch in jest.

- [ ] **Step 6: Commit.** `git add -A . ':!spike' && git commit -m "build: Expo SDK 58 app at the repo root" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

### Task 2: Pinned openalgo source

The app reads frontend files at a pinned openalgo commit. It never moves the developer's own `../openalgo` checkout; it reads files at the ref with `git show`.

**Files:** Create `openalgo.ref`, `scripts/openalgo-src.mjs`, `scripts/sync-openalgo.mjs`, `scripts/openalgo-src.test.mjs`

**Interfaces:**
- Produces:
  - `readRef(repoRoot: string): string`
  - `readOpenalgoFile(relPath: string, opts?: { repoRoot?: string; env?: NodeJS.ProcessEnv }): string`. Task 3 uses it.

- [ ] **Step 1:** Write `openalgo.ref` containing `c8b2896ca8e9cb2d0200be29fbb3e9a162ac5276` and a newline. That is the commit CI builds against today.
- [ ] **Step 2: Write the failing tests** (`node:test`), each building a temporary git repo with `frontend/src/index.css` committed twice (A, then B on HEAD).
  - `readOpenalgoFile` with `env.OPENALGO_REPO=<tmp>` and a ref file containing A returns A's content, and HEAD is still B afterwards.
  - With `env.OPENALGO_DIR=<tmp>` checked out at B while the ref is A, it throws `/OPENALGO_DIR is at .* openalgo.ref wants/`.
  - With `env.OPENALGO_DIR` at A, it reads from disk.
  - A ref file holding `main` throws `/40-character commit SHA/`.
- [ ] **Step 3:** Run `node --test scripts/openalgo-src.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement both scripts** with `execFileSync('git', [...])`. No shell strings.
  - Without `OPENALGO_DIR`, the repo is `env.OPENALGO_REPO ?? <repoRoot>/../openalgo`. Read the file with `git -C <repo> show <ref>:<relPath>`.
  - If `git cat-file -e <ref>^{commit}` fails, run `git fetch --no-tags origin <ref>` once, then retry.
  - `sync-openalgo.mjs` prints `openalgo.ref <ref> — available in <repo>: yes|no` and exits 1 when the ref cannot be fetched.
- [ ] **Step 5:** Run `node --test scripts/openalgo-src.test.mjs && npm run sync-openalgo`. Expected: PASS, then `available … yes`.
- [ ] **Step 6:** Commit: `feat(scripts): read openalgo files at the pinned ref`.

### Task 3: Theme tokens generated from the web

**Decision: no web change (F6) is needed.** The app parses `frontend/src/index.css` at the pinned ref.
- **Cascade.** Unlayered `:root` and `.dark` rules override the `@layer base` ones, exactly as in the browser. That is why the web's core colours are the oklch values at `index.css:166-233`.
- **Trading colours.** The web's order surfaces paint BUY and SELL with Tailwind classes, not with the `--buy`/`--sell` variables (which only the Flow editor uses):
  - `PlaceOrderDialog.tsx:425` BUY `bg-green-600`; `:433` SELL `bg-red-600`;
  - `OrderBook.tsx:729` and `TradeBook.tsx:565` `bg-green-500`;
  - `ExecuteBasketDialog.tsx:391` emerald-700 and rose-700.
- **P&L colours.** P&L text is `text-green-600 dark:text-green-400` and `text-red-600 dark:text-red-400` (`Dashboard.tsx:50-51`, `Positions.tsx:1018`).
- **Mapping.** The generator therefore maps the trading colours from Tailwind's palette, in one table, so a later change is one line.

**Files:** Create `scripts/lib/css-tokens.mjs`, `scripts/gen-tokens.mjs`, `scripts/css-tokens.test.mjs`, and the generated `src/ui/tokens.ts`

**Interfaces:**
- Produces, from `css-tokens.mjs`:
  - `extractVars(css: string): { root: Record<string,string>; dark: Record<string,string>; analyzer: Record<string,string> }`
  - `toHex(value: string): string | null`
  - `tailwindColor(themeCss: string, name: string): string`
  - `buildTokens({ indexCss, themeCss }): Tokens`
  - `renderTokensTs(tokens: Tokens, ref: string): string`
- Produces, from `src/ui/tokens.ts`: `export const tokens = { light: Palette, dark: Palette, analyzer: Palette, trade: { light: TradePalette, dark: TradePalette } } as const`.
  - `Palette` keys are camelCase CSS names: background, foreground, card, cardForeground, popover, popoverForeground, primary, primaryForeground, secondary, secondaryForeground, muted, mutedForeground, accent, accentForeground, destructive, border, input, ring.
  - `TradePalette` = `{ profit, loss, buy, sell, onBuy, onSell }`.

- [ ] **Step 1: Write the failing tests.** All values are computed with culori 4.0.2, `toGamut('rgb')`.

```js
test('oklch, alpha and hsl triples to hex', () => {
  assert.equal(toHex('oklch(1 0 0)'), '#ffffff')
  assert.equal(toHex('oklch(0.145 0 0)'), '#0a0a0a')
  assert.equal(toHex('oklch(0.205 0 0)'), '#171717')
  assert.equal(toHex('oklch(1 0 0 / 10%)'), '#ffffff1a')
  assert.equal(toHex('oklch(0.7 0.2 280)'), '#8b8cff')   // out of gamut: clamped, not clipped
  assert.equal(toHex('217 91% 60%'), '#3c83f6')          // bare HSL triple from @layer base
  assert.equal(toHex('0.625rem'), null)
})
test('unlayered :root beats @layer base, layered-only vars survive', () => {
  const v = extractVars(`@layer base { :root { --background: 0 0% 100%; --buy: 217 91% 60% } }
                         :root { --background: oklch(0.145 0 0) }`)
  assert.equal(v.root.background, 'oklch(0.145 0 0)'); assert.equal(v.root.buy, '217 91% 60%')
})
test('trading colours follow the web order surfaces', () => {
  const t = buildTokens({ indexCss: FIXTURE_INDEX_CSS, themeCss: FIXTURE_THEME_CSS })
  assert.deepEqual(t.trade.light, { profit: '#00a63e', loss: '#e7000b', buy: '#00a63e', sell: '#e7000b', onBuy: '#ffffff', onSell: '#ffffff' })
  assert.deepEqual(t.trade.dark,  { profit: '#05df72', loss: '#ff6467', buy: '#00a63e', sell: '#e7000b', onBuy: '#ffffff', onSell: '#ffffff' })
  assert.equal(t.dark.background, '#0a0a0a'); assert.equal(t.dark.border, '#ffffff1a')
})
```

  - `FIXTURE_THEME_CSS` holds the four Tailwind lines: `--color-green-600: oklch(62.7% 0.194 149.214)`, `--color-red-600: oklch(57.7% 0.245 27.325)`, `--color-green-400: oklch(79.2% 0.209 151.711)`, `--color-red-400: oklch(70.4% 0.191 22.216)`.
  - `FIXTURE_INDEX_CSS` is a trimmed copy of the real `:root`/`.dark`/`.analyzer` blocks.
- [ ] **Step 2:** Run `node --test scripts/css-tokens.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Parse with `postcss.parse`. A rule counts as layered when any ancestor is an `@layer` at-rule. Selectors read: `:root`, `.dark`, `.analyzer`; `[data-theme=…]` accent rules are ignored.
  - The trade mapping table sits at the top of `gen-tokens.mjs`, with the file:line citations above:
    - light: profit `green-600`, loss `red-600`, buy `green-600`, sell `red-600`;
    - dark: profit `green-400`, loss `red-400`, buy `green-600`, sell `red-600`;
    - onBuy and onSell: `#ffffff`.
  - `gen-tokens.mjs` reads `frontend/src/index.css` through `readOpenalgoFile`, and `node_modules/tailwindcss/theme.css` from disk.
  - It writes `src/ui/tokens.ts` with the header `// GENERATED by scripts/gen-tokens.mjs from openalgo@<ref>. Do not edit.`
  - `--check` regenerates in memory and exits 1 with `tokens.ts is stale: run npm run tokens` on any difference.
- [ ] **Step 4:** Run `node --test scripts/css-tokens.test.mjs && npm run tokens && npm run tokens:check`. Expected: PASS, `src/ui/tokens.ts` written, check exits 0.
- [ ] **Step 5:** Commit: `feat(ui): generate theme tokens from the web stylesheet`.

### Task 4: Boundaries, bundle budget, secret scan

**Files:**
- Create: `.dependency-cruiser.cjs`, `test/fixtures/boundaries/src/{dom/leak.ts,core/session/tokenStore.ts,core/http/client.ts,core/uses-feature.ts,features/a/x.ts,features/b/y.ts}`, `scripts/boundaries.test.mjs`
- Create: `scripts/check-bundles.mjs`, `scripts/check-bundles.test.mjs`, `bundle-baseline.json`
- Create: `.gitleaks.toml`

**Interfaces:**
- Produces: dependency-cruiser rules `dom-no-session-http`, `core-no-features`, `no-cross-feature`, and `no-circular` (warn).
- Produces: `measure(exportDir: string): { android: number; ios: number }` and `compare(measured, baseline, opts?: { maxBytes?: number; growth?: number }): { ok: boolean; lines: string[] }`.

- [ ] **Step 1: Write the failing tests.**
  - `boundaries.test.mjs` runs `npx depcruise test/fixtures/boundaries/src --config .dependency-cruiser.cjs --output-type err`. It asserts a non-zero exit and that the output names all three rules. It then asserts `npx depcruise src --config .dependency-cruiser.cjs` exits 0.
  - `check-bundles.test.mjs` tests:
    - `compare({android:1050,ios:1000},{android:1000,ios:1000})` is ok, since 5% is allowed;
    - `android:1051` fails with a line naming android and `+5.1%`;
    - `{android:4_340_001}` fails against any baseline;
    - a missing platform in `measured` fails.
- [ ] **Step 2:** Run `node --test scripts/boundaries.test.mjs scripts/check-bundles.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Rule patterns** use `(?:^|/)src/…`, so they match both `src` and the fixture tree.
    - `no-cross-feature`: `from.path: '(?:^|/)src/features/([^/]+)/'`, `to.path: '(?:^|/)src/features/'`, `to.pathNot: '(?:^|/)src/features/$1/'`.
    - Options: `tsConfig: { fileName: 'tsconfig.json' }`, `tsPreCompilationDeps: true`, `exclude: '(^|/)(spike|node_modules)/'`.
  - **`measure`** reads `<dir>/metadata.json` `fileMetadata.<platform>.bundle` and `fs.statSync`s it.
  - **CLI:** `node scripts/check-bundles.mjs <dir> [--update]`. `--update` rewrites `bundle-baseline.json`.
  - **`.gitleaks.toml`:** `[extend] useDefault = true` with an allowlist for `test/fixtures/` and `dev/mock-server/fixtures/` only.
- [ ] **Step 4: Run the checks.**
  - Run: `node --test scripts/boundaries.test.mjs scripts/check-bundles.test.mjs && npx expo export --platform android --platform ios --output-dir dist-export && node scripts/check-bundles.mjs dist-export --update && npm run bundles`. Expected: PASS, baseline written, check ok.
  - Then install gitleaks locally (`brew install gitleaks`) and run `gitleaks git --redact --no-banner .`. Expected: no leaks.
  - If a finding is a known-fake value in `spike/`, add that exact path, with a comment, to the allowlist. Never allowlist `src/`.
- [ ] **Step 5:** Commit: `build: import boundaries, bundle budget and secret scan`.

### Task 5: CI workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/actions/ios-build/action.yml`
- Move: `git mv .github/workflows/build.yml .github/workflows/spike.yml`
- Modify: `README.md`

**Interfaces:** Consumes the npm scripts from Task 1, `openalgo.ref` (Task 2), `tokens:check` (Task 3), and `boundaries`/`bundles` (Task 4).

- [ ] **Step 1: Write `spike.yml`.** Rename the workflow to `Spike builds`.
  - Triggers: `push` and `pull_request` on `main` with `paths: ['spike/**', '.github/workflows/spike.yml']`, plus `workflow_dispatch` (keep its `openalgo_ref` input).
  - Leave the jobs unchanged, so the product owner's phone-test APK keeps building.
- [ ] **Step 2: Write `ci.yml`.**
  - Name `CI`. Triggers: push and PR on `main`, plus `workflow_dispatch`. `concurrency` cancels in progress.
  - Env: `NODE_VERSION: "26"`, `CI: "1"`, `EXPO_NO_TELEMETRY: "1"`, `BUILD_NUMBER: ${{ github.run_number }}`.
  - **`checks` job** (ubuntu-latest), in this order:
    1. checkout with `fetch-depth: 0`;
    2. step `ref`: `echo "sha=$(tr -d '[:space:]' < openalgo.ref)" >> "$GITHUB_OUTPUT"`;
    3. checkout `marketcalls/openalgo` at `steps.ref.outputs.sha`, `path: openalgo`, `sparse-checkout: frontend/src`;
    4. setup-node with the npm cache;
    5. `npm ci`;
    6. `npm run lint`, `npm run typecheck`, `npx jest --ci`, `npm run test:scripts`, `npm run boundaries`;
    7. `OPENALGO_DIR=$GITHUB_WORKSPACE/openalgo npm run tokens:check`;
    8. `npx expo install --check`, `npx expo-doctor`;
    9. `npx expo export --platform android --platform ios --output-dir dist-export`, then `npm run bundles`;
    10. gitleaks: download `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz` and verify `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` with `sha256sum -c`;
    11. `./gitleaks git --redact --no-banner .`, then `./gitleaks dir --redact --no-banner dist-export`. The second scan is the bundle scan for key-like strings.
  - **`android` job** (`needs: checks`): free disk space, checkout, node, `npm ci`, Java temurin 17 with the gradle cache, `npx expo prebuild --platform android --no-install`, and `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a --no-daemon`.
    - Upload artifact `android-apk` as `dist/openalgo-<version>-b<BUILD_NUMBER>-<sha7>.apk`, with `<version>` from `node -p "require('./package.json').version"`.
    - Keep the spike's comment that it is signed with the template debug key.
  - **`ios-simulator` job** (`needs: checks`, macos-26): uses `./.github/actions/ios-build` with `sdk: iphonesimulator`, `destination: generic/platform=iOS Simulator`, `ext: zip`, `artifact: ios-simulator-app`.
  - **`ios-device` job:** the same with `if: github.event_name != 'pull_request'`, `sdk: iphoneos`, `destination: generic/platform=iOS`, `ext: ipa`, `artifact: ios-ipa-unsigned`.
  - **The composite action** holds the spike's prebuild, xcodebuild (unsigned, `ARCHS=arm64`), packaging and upload steps, with the app name in the artifact file names.
  - Leave Maestro and signed builds as comments that point at the M3/M6 plans.
- [ ] **Step 3: Rewrite `README.md`.**
  - The layout: the root app plus `spike/` (throwaway, kept for the M0 phone test).
  - Develop: `npm ci`, `npm run mock`, `npx expo run:ios` / `run:android`, then type `http://localhost:8080`, or `http://10.0.2.2:8080` on the Android emulator.
  - The checks (`npm run lint && npm run typecheck && npm test && npm run test:scripts && npm run boundaries`).
  - The CI artifacts, and what `openalgo.ref` is and how to bump it.
  - Keep the AGPL note and the Flutter backup branch note.
- [ ] **Step 4:** Run `brew install actionlint && actionlint .github/workflows/*.yml`. Expected: no output. The real proof is the first PR run, after the owner OKs a push.
- [ ] **Step 5:** Commit: `ci: quality gates and builds for the app; spike builds only on spike changes`.

---

## M2: foundation

### Task 6: Mock server, OAuth and REST

The server grows from `spike/mock-feed/server.mjs`, which stays in place. Plain ESM JavaScript, with `node:http` plus `ws`.

**Files:** Create `dev/mock-server/{main.mjs,server.mjs,state.mjs,oauth.mjs,api.mjs,fixtures/watchlists.json,oauth.test.mjs,api.test.mjs}`

**Interfaces:**
- Produces: `startMockServer(opts?: { port?: number; host?: string; rate?: number; accessTtlSec?: number; autoApprove?: 'trade'|'readonly'|null; authTimeoutMs?: number }): Promise<{ origin: string; port: number; state: MockState; close(): Promise<void> }>`.
- Produces: `main.mjs` reads `PORT` (default 8080; `0` means ephemeral), `HOST` (`0.0.0.0`), `RATE` (20), `ACCESS_TTL` (900) and `AUTO_APPROVE`, then prints exactly `MOCK_READY <origin>` on stdout.
- Produces: the control endpoint `POST /__mock/control` (JSON patch).
  - Patchable fields: `mobileAppEnabled`, `brokerSession` ('active'|'expired'), `analyzeMode`, `orderMode`, `apiKeyMissing`, `accessTtlSec`.
  - Actions:
    - `{revokeAll:true}`;
    - `{closeSockets:<code>}`;
    - `{failNext:{path, status, body, contentType}}`: the next request to `path` gets exactly that response.
  - `GET /__mock/control` returns the state plus `stats: { tokenCalls, refreshCalls, ticketCalls }`.

- [ ] **Step 1: Write the failing tests** (`node:test`; Node fetch with `redirect: 'manual'`). The tests are named:
  - `discovery matches C1 with issuer === origin`.
  - `authorize rejects an unregistered redirect_uri with 400 and no redirect`.
  - `authorize GET renders consent with the device_name`.
  - `consent POST decision=trade → 302 to in.openalgo.mobile:/oauth/callback?code&state; decision=deny → error=access_denied`.
  - `code exchange checks PKCE S256 and is single-use`.
  - `refresh rotates; replaying the old refresh token within 60 s with an unused successor returns a fresh pair (grace)`.
  - `replaying the old refresh token after the successor was used, or after 60 s, returns invalid_grant and revokes the family (the new one now fails too)`.
  - `revoke always returns 200 and kills the family`.
  - `app/info without auth has account:null; with a bearer it has account.scopes`.
  - `expired access → 401 TOKEN_EXPIRED with WWW-Authenticate; unknown → TOKEN_INVALID; revoked family → TOKEN_REVOKED`.
  - `read-only device calling ws/ticket with read:market succeeds; a route needing write:orders → 403 INSUFFICIENT_SCOPE with required_scope`.
  - `brokerSession=expired → 403 BROKER_SESSION_EXPIRED on /api/v1/analyzer; apiKeyMissing → API_KEY_MISSING; mobileAppEnabled=false → MOBILE_APP_DISABLED on bearer routes, and app/info shows mobile_app_enabled:false`.
  - `failNext serves an HTML 502 once`.
  - `watchlist lists match C9`.
  - `multiquotes returns results[] with ltp and prev_close`.
  - `/oauth/token answers 429 after 20 calls in a minute from one IP`.
- [ ] **Step 2:** Run `node --test "dev/**/*.test.mjs"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Tokens:**
    - access tokens are opaque `mock.<base64url 24 bytes>`, mapped in memory to `{familyId, scope, exp}`;
    - refresh tokens are `<id>.<secret>`;
    - codes last 60 s.
  - **Consent page:** plain HTML with three submit buttons (Trade, Read-only, Deny) posting back to `/oauth/authorize` with the parameters in hidden fields. `AUTO_APPROVE` skips the page and 302s at once.
  - **Routes:**
    - `GET /api/v1/app/info`: `server_version: "mock-1"`, `capabilities: ["ws_ticket","ws_main_port","bearer_session_routes","action_center"]`.
    - `POST /api/v1/ws/ticket`.
    - `POST /api/v1/analyzer`: shapes from `test/fixtures/openalgo-docs/analyzer-*.json`.
    - `POST /api/v1/multiquotes`: prices from `prices.mjs`, introduced in Task 7. A stub that returns `ltp = prev_close = 100` is acceptable until then.
    - `GET /watchlist/api/lists`.
  - **Watchlist fixture:**
    - list 1 `Nifty picks`: RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK, SBIN on NSE, and NIFTY on NSE_INDEX;
    - list 2 `Empty`, with no items.
  - **Request checks:**
    - a POST under `/api/v1` without `Content-Type: application/json` gets 400 `{status:"error", message:"JSON body required"}`;
    - an `apikey` in the body is ignored.
  - **Doc fixtures:** create `test/fixtures/openalgo-docs/{multiquotes.json,analyzer-live.json,analyzer-analyze.json}` from `../openalgo-docs/api-documentation/v1/data-api/multiquotes.md` and `accounts-api/analyzer-status.md`. Put the source path in a `"_source"` field.
- [ ] **Step 4:** Run `node --test "dev/**/*.test.mjs"`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dev): mock server for OAuth, app info, tickets and watchlists`.

### Task 7: Mock server, WebSocket feed with tickets

**Files:** Create `dev/mock-server/{feed.mjs,prices.mjs,feed.test.mjs}`; modify `server.mjs` to route `upgrade` on `/ws` into `feed.mjs`, and `api.mjs` so multiquotes uses `prices.mjs`.

**Interfaces:**
- Consumes: `state.tickets` and `state.families` (Task 6).
- Produces: `closeFamilySockets(familyId, code, reason)`. Revoke and `revokeAll` call it with `4403, 'device revoked'`; `closeSockets` calls it for all sockets.

- [ ] **Step 1: Write the failing tests.** They are named:
  - `authenticate with a fresh ticket → {type:'auth',status:'success',broker:'mock'}`.
  - `a reused or expired ticket → {status:'error',code:'AUTHENTICATION_ERROR'}`.
  - `no auth within authTimeoutMs (set to 200 in the test) → close 4401`.
  - `subscribe [{symbol:'RELIANCE',exchange:'NSE'}] mode 'Quote' → subscribe ack, then market_data with mode 2 and data {ltp,open,high,low,close,volume}`.
  - `unsubscribe stops ticks for that key`.
  - `ping → {type:'pong',status:'success'}`.
  - `revoking the family closes its sockets with 4403 and leaves another family's socket open`.
  - `control closeSockets:1012 closes all sockets with 1012`.
- [ ] **Step 2:** Run `node --test dev/mock-server/feed.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Move the deterministic price walk (`hash32`, `mulberry32`, `basePrice`, `r05`, `UNDERLYING`) from `spike/mock-feed/server.mjs` into `prices.mjs` unchanged.
  - Port the subscribe, unsubscribe, ping and error shapes from the same file.
  - Authentication accepts only `ticket`.
  - `RATE` is market_data messages per second per connection, spread over that connection's subscriptions.
- [ ] **Step 4:** Run `node --test "dev/**/*.test.mjs"`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dev): mock WebSocket feed with single-use tickets`.

### Task 8: Config, preferences, redacting logger

**Files:**
- Create: `src/core/config/{constants.ts,appVersion.ts,serverOrigin.ts,profile.ts,prefs.ts}`, `src/core/log/logger.ts`
- Tests: `serverOrigin.test.ts`, `profile.test.ts`, `prefs.test.ts`, `logger.test.ts`

**Interfaces:**
- Produces, from `constants.ts`: `APP_SCHEME`, `CLIENT_ID`, `REDIRECT_URI`, `REQUESTED_SCOPE`, `MIN_APP_API_VERSION = 1`, `DEFAULT_LOCK_AFTER_MS = 300_000`, `HTTP_TIMEOUT_MS = 15_000`, `NGROK_DOCS_URL = 'https://docs.openalgo.in/getting-started/mac-os-installation/ngrok-config'`.
- Produces, from `appVersion.ts`: `appVersion(): string` (expo-application `nativeApplicationVersion`, falling back to `Constants.expoConfig?.version`, then `'0.0.0'`), and `compareVersions(a: string, b: string): -1 | 0 | 1` (numeric dotted parts; missing parts count as 0; a non-numeric suffix is ignored).
- Produces, from `serverOrigin.ts`: `parseServerOrigin(input: string, opts: { allowLoopbackHttp: boolean }): { ok: true; origin: string; stripped: boolean } | { ok: false; reason: 'empty' | 'invalid' | 'http_not_allowed' | 'has_credentials' }`.
- Produces, from `profile.ts`:
  - `type ServerProfile = { id: string; origin: string; serverVersion: string; deviceName: string; tokenEndpoint: string; revocationEndpoint: string; createdAt: number }`
  - `ServerProfileSchema` (zod)
  - `profileIdFor(origin: string): string`, which returns `'p'` plus 8 lowercase hex characters (FNV-1a 32-bit).
- Produces, from `prefs.ts`: the zustand store `usePrefs`, persisted to AsyncStorage under `oa.prefs.v1`:
  - state: `{ theme: 'system'|'dark'|'light'; appLock: boolean; lockAfterMs: 60_000|300_000|900_000; hideContentAndroid: boolean; selectedWatchlistId: number|null; lastOrigin: string|null }`, with defaults `system`, `true`, `300_000`, `false`, `null`, `null`;
  - setter: `setPrefs(patch)`.
- Produces, from `logger.ts`: `log.debug|info|warn|error(tag: string, msg: string, data?: Record<string, unknown>)`, `redact(v: unknown): unknown`, `getLogLines(limit?: number): LogLine[]` (a 500-entry ring buffer) and `clearLogs()`.

- [ ] **Step 1: Write the failing tests.**

```ts
// (RF 1) what people type
test.each([
  ['  HTTPS://Example.COM/  ', { ok: true, origin: 'https://example.com', stripped: false }],
  ['example.com', { ok: true, origin: 'https://example.com', stripped: false }],
  ['https://x.ngrok.app/login?next=/', { ok: true, origin: 'https://x.ngrok.app', stripped: true }],
  ['https://algo.example.com:8443/dashboard#x', { ok: true, origin: 'https://algo.example.com:8443', stripped: true }],
  ['https://example.com:443', { ok: true, origin: 'https://example.com', stripped: false }],
  ['http://example.com', { ok: false, reason: 'http_not_allowed' }],
  ['https://user:pw@example.com', { ok: false, reason: 'has_credentials' }],
  ['ftp://example.com', { ok: false, reason: 'invalid' }],
  ['', { ok: false, reason: 'empty' }],
  ['https://exa mple.com', { ok: false, reason: 'invalid' }],
])('parseServerOrigin(%j)', (input, out) =>
  expect(parseServerOrigin(input, { allowLoopbackHttp: false })).toEqual(out))
test('loopback http only when allowed', () => {
  expect(parseServerOrigin('http://localhost:8080', { allowLoopbackHttp: true })).toEqual({ ok: true, origin: 'http://localhost:8080', stripped: false })
  expect(parseServerOrigin('http://10.0.2.2:8080', { allowLoopbackHttp: true }).ok).toBe(true)
  expect(parseServerOrigin('http://192.168.1.5:5000', { allowLoopbackHttp: true })).toEqual({ ok: false, reason: 'http_not_allowed' })
  expect(parseServerOrigin('http://localhost:8080', { allowLoopbackHttp: false })).toEqual({ ok: false, reason: 'http_not_allowed' })
})
test('profileIdFor is stable and SecureStore-key-safe', () => {
  expect(profileIdFor('https://example.com')).toMatch(/^p[0-9a-f]{8}$/)
  expect(profileIdFor('https://example.com')).toBe(profileIdFor('https://example.com'))
})
test('redact', () => {
  const out = redact({ access_token: 'a', nested: { Authorization: 'Bearer xyz', ok: 1 }, url: 'x?code=abc&state=s1&page=2', note: 'sent Bearer eyJabc.def' })
  expect(out).toEqual({ access_token: '[redacted]', nested: { Authorization: '[redacted]', ok: 1 }, url: 'x?code=[redacted]&state=[redacted]&page=2', note: 'sent Bearer [redacted]' })
})
test('prefs rehydrate drops invalid values back to defaults', ...)   // AsyncStorage holds {theme:'neon',lockAfterMs:7}
test('compareVersions', () => { expect(compareVersions('1.0.0', '1.0')).toBe(0); expect(compareVersions('0.9.9', '1.0.0')).toBe(-1); expect(compareVersions('1.10.0', '1.9.0')).toBe(1) })
```

- [ ] **Step 2:** Run `npx jest src/core/config src/core/log`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`parseServerOrigin`** uses an explicit parser, not the global `URL`, whose RN implementation is incomplete:
    - lowercase the scheme and host;
    - prefix `https://` when there is no `scheme://`;
    - host: `^\[[0-9a-f:]+\]$|^[a-z0-9-]+(\.[a-z0-9-]+)*$`;
    - port: 1–65535; `:443` is dropped for https and `:80` for http;
    - any path other than `/`, query or fragment is dropped and sets `stripped`.
  - **Redaction:**
    - keys matching `/^(authorization|access_?token|refresh_?token|token|ticket|code|code_verifier|apikey|api_key|password|secret|state)$/i` become `'[redacted]'`;
    - in strings, `Bearer\s+\S+` becomes `Bearer [redacted]`, and the `(code|state|ticket|token|access_token|refresh_token)=[^&\s]+` query params become `$1=[redacted]`.
  - **Console output** only when `__DEV__`.
  - **Prefs** rehydrate through `PrefsSchema.safeParse`, falling back per field to the defaults.
- [ ] **Step 4:** Run `npx jest src/core/config src/core/log`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): config, prefs and redacting logger`.

### Task 9: HTTP error model, coercing schemas, client

**Files:**
- Create: `src/core/http/{errors.ts,coerce.ts,schemas.ts,client.ts}`
- Tests: `errors.test.ts`, `coerce.test.ts`, `schemas.test.ts`, `client.test.ts`

**Interfaces:**
- Produces, from `errors.ts`:
  - `type ApiErrorKind = 'auth_expired'|'revoked'|'insufficient_scope'|'broker_session_expired'|'api_key_missing'|'mobile_app_disabled'|'rate_limited'|'validation'|'rejected'|'forbidden'|'not_found'|'server'|'maybe_placed'|'network'|'bad_response'`
  - `class ApiError extends Error { kind; status: number | null; code?: string; retryAfterSec?: number; requiredScope?: string; serverMessage?: string }`
  - `classifyHttpError(i: { status: number; body: unknown; retryAfter: string | null; placement: boolean }): ApiError`
  - `networkError(cause: unknown, placement: boolean): ApiError`
  - `userMessage(e: ApiError): string`
- Produces, from `coerce.ts`:
  - `num`: a zod number that also accepts numeric strings (`"320.66"` → 320.66; `""` fails);
  - `int`;
  - `str`: accepts a number and returns `String(n)`, for ids;
  - `bool`: accepts `true|false|'true'|'false'|1|0`.
- Produces, from `schemas.ts`:
  - `envelope<T>(data: z.ZodType<T>)`: `{status:'success', data}`;
  - `AppInfoSchema`, `AppInfoAccountSchema` (C7);
  - `WsTicketResponseSchema` (C8);
  - `MultiQuotesSchema`: `{status:'success', results: Array<{symbol, exchange, data?: {ltp, prev_close, open, high, low, volume}}>}`, coerced with `num`; entries with `error` are allowed and kept.
- Produces, from `client.ts`:
  - `interface TokenSource { getAccessToken(): Promise<string>; refreshAfterReject(rejected: string): Promise<string> }`
  - `interface HttpClient { request<T>(r: { method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; path: string; body?: unknown; schema: z.ZodType<T>; placement?: boolean; auth?: boolean; signal?: AbortSignal }): Promise<T>; api<T>(endpoint: string, body: Record<string, unknown>, schema: z.ZodType<T>, opts?: { placement?: boolean }): Promise<T> }`
  - `createHttpClient(d: { origin: string; tokens: TokenSource; fetch: typeof fetch; timeoutMs?: number; onAuthFailure?: (e: ApiError) => void; onBrokerSessionExpired?: () => void }): HttpClient`

**Classification table** (exact, tested row by row):

| HTTP and body | kind |
|---|---|
| 401 `code` TOKEN_EXPIRED or TOKEN_INVALID, or 401 with no code | `auth_expired` |
| 401 TOKEN_REVOKED | `revoked` |
| 403 INSUFFICIENT_SCOPE (keeps `requiredScope`) | `insufficient_scope` |
| 403 BROKER_SESSION_EXPIRED | `broker_session_expired` |
| 403 API_KEY_MISSING | `api_key_missing` |
| 403 MOBILE_APP_DISABLED | `mobile_app_disabled` |
| other 403 | `forbidden` |
| 429 (`retryAfterSec` from `body.retry_after`, else the `Retry-After` header, else 60) | `rate_limited` |
| 400, 422 | `validation` |
| 404 | `not_found` |
| 502 with `placement`; or a timeout or network failure with `placement` | `maybe_placed` |
| other ≥ 500 | `server` |
| 2xx with `status:"error"` | `rejected` |

`userMessage` copy (exact):

| kind | message |
|---|---|
| `auth_expired` | "Your session needs to be renewed. Try again." |
| `revoked` | "This device was signed out. Sign in again." |
| `insufficient_scope` | "This device is read-only. Sign in again and choose Trade to place orders." |
| `broker_session_expired` | "Your broker session has ended. Log in to your broker to continue." |
| `api_key_missing` | "Generate an API key in OpenAlgo on the web, then try again." |
| `mobile_app_disabled` | "Mobile app access is turned off on this server." |
| `rate_limited` | "Too many requests. Try again in {n} s." |
| `validation`, `rejected`, `forbidden` | `serverMessage`, or "The server rejected the request." |
| `not_found` | "Not found on this server." |
| `server` | "The server had a problem. Try again." |
| `maybe_placed` | "Status unknown: checking the order book." |
| `network` | "Can't reach the server. Check your connection." |
| `bad_response` | "The server sent an unexpected response." |

- [ ] **Step 1: Write the failing tests.**
  - One `test.each` covers every classification row and every message.
  - `schemas.test.ts` parses `test/fixtures/openalgo-docs/multiquotes.json`, and a copy with every number turned into a string, and gets equal output.
  - `client.test.ts` uses a scripted fake `fetch` that records calls. The tests are named:
    - `sends Authorization, Accept, JSON Content-Type and credentials:'omit'; GET sends no body; api() POSTs to /api/v1/<endpoint> with {} by default`.
    - `auth:false sends no Authorization`.
    - `rejects absolute or protocol-relative paths ('https://x', '//x') before any fetch`.
    - `401 TOKEN_EXPIRED → refreshAfterReject(usedToken) once → replay once with the new token → success`.
    - `a second 401 after the replay → throws auth_expired and calls onAuthFailure; no third fetch`.
    - `401 TOKEN_REVOKED → no replay, onAuthFailure(revoked)`.
    - `403 BROKER_SESSION_EXPIRED calls onBrokerSessionExpired`.
    - `timeout after timeoutMs → network; with placement → maybe_placed; fetch is never called twice`.
    - `(RF 4) 200 text/html body → bad_response; 502 text/html → server; 502 html with placement → maybe_placed`.
    - `2xx {status:'error', message:'Insufficient funds'} → rejected with serverMessage`.
    - `schema mismatch → bad_response, and the logged entry has issue paths but no values`.
- [ ] **Step 2:** Run `npx jest src/core/http`. Expected: FAIL.
- [ ] **Step 3: Implement** to the table.
  - Read the body as text, then `JSON.parse` it inside a try block.
  - Implement the timeout with `AbortController` plus `setTimeout`. A caller's `signal` aborts too.
  - Log `method path status durationMs` only.
- [ ] **Step 4:** Run `npx jest src/core/http`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): typed HTTP client with the error model`.

### Task 10: Session I: PKCE, server check, token client, sign-in

**Files:**
- Create: `src/core/session/{pkce.ts,oauthSchemas.ts,serverCheck.ts,tokenClient.ts,signIn.ts}`
- Tests: the matching `*.test.ts`

**Interfaces:**
- Consumes: `compareVersions`, `appVersion` (Task 8); `AppInfoSchema`, `ApiError` (Task 9).
- Produces, from `pkce.ts`:
  - `type CryptoDeps = { randomBytes(n: number): Uint8Array; sha256(d: Uint8Array): Promise<ArrayBuffer> }`
  - `expoCrypto: CryptoDeps`, built from `getRandomBytes` and `digest(CryptoDigestAlgorithm.SHA256, …)`
  - `base64url(b: Uint8Array): string`
  - `createPkcePair(c: CryptoDeps): Promise<{ verifier: string; challenge: string }>`: 48 random bytes, so a 64-character verifier
  - `randomState(c: CryptoDeps): string`: 16 bytes
- Produces, from `oauthSchemas.ts`: `DiscoverySchema` (C1), `TokenResponseSchema` (C3), `OAuthErrorSchema`.
- Produces, from `serverCheck.ts`:
  - `type ServerProblem = { kind: 'unreachable' } | { kind: 'not_openalgo' } | { kind: 'upgrade_server' } | { kind: 'mobile_app_disabled' } | { kind: 'issuer_mismatch'; issuer: string } | { kind: 'app_update_required'; minAppVersion: string }`
  - `checkServer(origin: string, d: { fetch: typeof fetch; appVersion: string; timeoutMs?: number }): Promise<{ ok: true; discovery: Discovery; info: AppInfo } | { ok: false; problem: ServerProblem }>`
- Produces, from `tokenClient.ts`:
  - `type TokenSet = { accessToken: string; refreshToken: string; scope: string[]; expiresAt: number }`
  - `type SignedOutReason = 'user' | 'revoked' | 'session_ended' | 'storage_error'`
  - `class SignedOutError extends Error { reason: SignedOutReason }`
  - `exchangeCode(d: { tokenEndpoint: string; fetch; now: () => number }, p: { code: string; verifier: string }): Promise<TokenSet>`
  - `refreshTokens(d, refreshToken: string): Promise<TokenSet>`
  - `revokeRefreshToken(d: { revocationEndpoint: string; fetch }, token: string): Promise<void>`
- Produces, from `signIn.ts`:
  - `type OpenAuthSession = (url: string, redirect: string) => Promise<{ type: string; url?: string }>`
  - `expoOpenAuthSession`, which calls `WebBrowser.openAuthSessionAsync(url, redirect, { preferEphemeralSession: false })`. Not ephemeral, so the OpenAlgo login cookie persists for the M3 broker re-login.
  - `buildAuthorizeUrl(discovery: Discovery, p: { challenge: string; state: string; deviceName: string }): string`
  - `parseCallback(url: string, expectedState: string): { code: string } | { error: string; description?: string }`
  - `type SignInResult = { ok: true; tokens: TokenSet } | { ok: false; reason: 'cancelled' | 'denied' | 'state_mismatch' | 'invalid_callback' | 'exchange_failed'; message?: string }`
  - `signIn(a: { discovery: Discovery; deviceName: string }, d: { crypto: CryptoDeps; openAuthSession: OpenAuthSession; fetch; now }): Promise<SignInResult>`

- [ ] **Step 1: Write the failing tests.**

```ts
test('RFC 7636 appendix B vector', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  expect(base64url(new Uint8Array(await nodeSha256(verifier)))).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})
test('createPkcePair: 64-char verifier, url-safe alphabet', ...)
```

  - **serverCheck**, against scripted fetch responses. The tests are named:
    - `ok path`.
    - `app/info network error → unreachable`.
    - `app/info 404 → upgrade_server`.
    - `(RF 4) app/info returns the SPA's index.html with 200 → not_openalgo`.
    - `mobile_app_enabled:false → mobile_app_disabled`.
    - `app_api_version 0 → upgrade_server`.
    - `min_app_version '9.0.0' → app_update_required`.
    - `issuer 'https://other.example.com' → issuer_mismatch with that issuer`.
    - `a token_endpoint on another origin → not_openalgo`.
    - Rule: every discovery endpoint must start with `origin + '/'`.
  - **tokenClient.** The tests are named:
    - `form-encodes the code grant exactly as C3`.
    - `expiresAt = now() at receipt + expires_in*1000 (device clock offset does not matter)`.
    - `refresh invalid_grant → SignedOutError('session_ended')`.
    - `refresh network failure → ApiError network, not SignedOutError`.
    - `revokeRefreshToken never throws, even on 500 or network error`.
  - **signIn.** The tests are named:
    - `builds the authorize URL with all C2 params including device_name and code_challenge_method=S256`.
    - `success exchanges the code with the matching verifier`.
    - `(RF 3) {type:'cancel'} → cancelled, no token request; {type:'dismiss'} → cancelled; a callback with the wrong state → state_mismatch, no token request; error=access_denied → denied; a callback missing code → invalid_callback; two consecutive signIn calls use different state and verifier`.
- [ ] **Step 2:** Run `npx jest src/core/session`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Form bodies are built with a local `formEncode(obj)`, via `encodeURIComponent` and `&`, not `URLSearchParams`.
  - `parseCallback` requires the URL to start with `REDIRECT_URI` followed by `?`.
  - `checkServer` order: app/info first, then the version checks, then discovery with the issuer and same-origin checks.
- [ ] **Step 4:** Run `npx jest src/core/session`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): PKCE sign-in, server check and token client`.

### Task 11: Session II: token store, single-flight session, status

**Files:**
- Create: `src/core/session/{tokenStore.ts,session.ts,sessionStatus.ts,brokerSession.ts}`, `test/helpers/{memoryKV.ts,mockServer.ts}`
- Tests: `tokenStore.test.ts`, `session.test.ts`, `session.integration.test.ts`, `sessionStatus.test.ts`

**Interfaces:**
- Consumes: `TokenSet`, `SignedOutError`, `refreshTokens` and `revokeRefreshToken` (Task 10); `ServerProfile` and `ServerProfileSchema` (Task 8); `TokenSource` (Task 9).
- Produces, from `tokenStore.ts`:
  - `interface SecureKV { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; del(k: string): Promise<void> }`
  - `expoSecureKV: SecureKV`, which uses `{ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }`
  - `createTokenStore(kv: SecureKV, profileId: string): TokenStore`, where `TokenStore = { loadRefresh(): Promise<string | null>; saveRefresh(t: string): Promise<void>; clear(): Promise<void> }` and the key is `oa.<profileId>.rt`
  - `createProfileStore(kv): { load(): Promise<ServerProfile | null>; save(p: ServerProfile): Promise<void>; clear(): Promise<void> }`, under key `oa.profile`; invalid JSON returns `null`
- Produces, from `session.ts`:
  - `interface Session extends TokenSource { profile: ServerProfile; scopes(): string[]; establish(t: TokenSet): Promise<void>; signOut(r: SignedOutReason): Promise<void>; onSignedOut(cb: (r: SignedOutReason) => void): () => void; dispose(): void }`
  - `createSession(d: { profile: ServerProfile; store: TokenStore; fetch: typeof fetch; now: () => number }): Session`
- Produces, from `sessionStatus.ts`: zustand `useSessionStatus`, state `{ status: 'restoring' | 'signedOut' | 'signedIn'; profile: ServerProfile | null; signedOutReason: SignedOutReason | null }` with actions `setSignedIn(profile)` and `setSignedOut(reason | null)`. It holds no tokens.
- Produces, from `brokerSession.ts`: zustand `useBrokerSession` `{ expired: boolean; setExpired(b: boolean) }`.
- Produces, from `test/helpers/mockServer.ts`: `startMockServerProcess(env?: Record<string, string>): Promise<{ origin: string; control(p: object): Promise<any>; stop(): Promise<void> }>`. It spawns `node dev/mock-server/main.mjs` with `PORT=0` and waits for `MOCK_READY`.

**Behaviour:**
- `getAccessToken` returns the in-memory token while `now < expiresAt - 60_000`. Otherwise it refreshes.
- **One refresh in flight at a time.** Concurrent callers share one promise.
- **Order of a refresh:**
  1. Use the in-memory refresh token, or `store.loadRefresh()`. If there is none, run `signOut('session_ended')` and throw.
  2. Call `refreshTokens`.
  3. `await store.saveRefresh(new)`. If that throws: revoke the new token (best effort), clear, emit `storage_error`, and throw.
  4. Only then set the in-memory tokens and return the access token.
- `refreshAfterReject(rejected)` returns the current token without refreshing if the current token is not `rejected` and is still valid.
- `establish` saves the refresh token, then sets the in-memory tokens.
- `signOut('user')` revokes with a 5 s timeout. Every reason then clears the store and the in-memory tokens, and emits once. A second call is a no-op.

- [ ] **Step 1: Write the failing tests.**
  - **Unit, with a scripted fetch and `memoryKV`.** The tests are named:
    - `five concurrent getAccessToken calls after expiry → exactly one token request; all five get the same token`.
    - `refresh saves the new refresh token before resolving (assert call order: fetch, kv.set, then resolve)`.
    - `saveRefresh failure → revoke called with the new refresh token, store cleared, onSignedOut('storage_error')`.
    - `invalid_grant → store cleared, onSignedOut('session_ended')`.
    - `network error keeps the stored refresh token and signed-in state`.
    - `refreshAfterReject with a stale rejected token returns the current one with no request`.
    - `signOut('user') revokes then clears; a second signOut does nothing`.
    - `(RF 2) a server-rotated token that was never saved: on the next createSession the store still holds the old token; refresh → invalid_grant → onSignedOut('session_ended') and no second request`.
  - **Integration, against `startMockServerProcess({ ACCESS_TTL: '1', AUTO_APPROVE: 'trade' })`.** Sign in by hand: GET authorize with `AUTO_APPROVE=trade`, read the `Location`, then `exchangeCode`. Then:
    - wait 1.1 s, then fire 5 parallel `createHttpClient(...).request(GET /api/v1/app/info)` calls; `GET /__mock/control` shows `refreshCalls === 1` and all five succeed;
    - `control({revokeAll:true})`, then the next request → onSignedOut fires once.
  - **sessionStatus:** after `setSignedIn(profile)`, `JSON.stringify(useSessionStatus.getState())` contains no `mock.` token string and no `.`-separated refresh token.
- [ ] **Step 2:** Run `npx jest src/core/session test/`. Expected: FAIL.
- [ ] **Step 3:** Implement to the behaviour above.
- [ ] **Step 4:** Run `npx jest src/core/session`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): secure token store and single-flight session`.

### Task 12: Query client and keys

**Files:** Create `src/core/query/{queryClient.ts,keys.ts,wiring.ts}` and `queryClient.test.ts`

**Interfaces:**
- Consumes: `ApiError` (Task 9).
- Produces:
  - `createQueryClient(): QueryClient`. Query defaults: `staleTime: 5_000`, `gcTime: 300_000`, `retry: (n, e) => n < 2 && e instanceof ApiError && (e.kind === 'network' || e.kind === 'server')`, `refetchOnWindowFocus: true`. Mutation defaults: `retry: 0`.
  - `qk`: `root(pid)` = `['p', pid]`, plus `appInfo(pid)`, `analyzer(pid)`, `watchlists(pid)` and `seedQuotes(pid, keys: string[])`, each starting with `root(pid)`.
  - `clearProfileCache(qc, pid)`.
  - `wireQueryManagers(): () => void`, which drives `focusManager` from AppState (`active`) and `onlineManager` from NetInfo `isConnected`.

- [ ] **Step 1: Write the failing tests.** The tests are named:
  - `retry predicate: network yes ×2, server yes, validation/rejected/maybe_placed no`.
  - `mutations default retry 0`.
  - `every qk key starts with ['p', pid]`.
  - `clearProfileCache removes only that profile's queries`.
  - `wireQueryManagers unsubscribes both listeners on cleanup`.
- [ ] **Step 2:** Run `npx jest src/core/query`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx jest src/core/query`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): query client with profile-scoped keys`.

### Task 13: Realtime I: protocol and tick store

**Files:**
- Create: `src/core/realtime/{protocol.ts,tickStore.ts,useScreenActive.ts}`
- Tests: `protocol.test.ts`, `tickStore.test.ts`

**Interfaces:**
- Produces, from `protocol.ts`:
  - `type Mode = 'LTP' | 'Quote' | 'Depth'` and `MODE_NUM = { LTP: 1, Quote: 2, Depth: 3 }`
  - `quoteKey(exchange: string, symbol: string): string` → `'NSE:RELIANCE'`
  - `subKey(exchange, symbol, mode): string` → `'NSE:RELIANCE:Quote'`
  - `type Quote = { ltp: number; open: number; high: number; low: number; close: number; volume: number; change: number; changePct: number; ts: number; dir: 1 | -1 | 0; seeded?: true }`
  - `type ServerMessage = { t: 'auth_ok'; broker?: string } | { t: 'error'; code: string; message: string } | { t: 'tick'; exchange: string; symbol: string; mode: number; data: TickData } | { t: 'sub_ack' } | { t: 'pong' } | { t: 'order_update'; data: Record<string, unknown> }`
  - `parseServerMessage(raw: string): ServerMessage | null`
  - `toQuote(d: TickData, now: number): Omit<Quote, 'dir'>`. Change is `ltp - close`. `changePct` is 0 when close is 0. Missing OHLC fields fall back to ltp.
- Produces, from `tickStore.ts`:
  - `createTickStore(schedule?: (fn: () => void) => void): TickStore`, where `TickStore = { put(key: string, q: Omit<Quote,'dir'>): void; seed(key: string, q: Omit<Quote,'dir'>): void; get(key: string): Quote | undefined; subscribe(key: string, fn: () => void): () => void; evict(key: string): void; reset(): void; setStale(b: boolean): void; isStale(): boolean; subscribeStale(fn: () => void): () => void; stats(): { ticksIn: number; flushes: number; keys: number; listenerKeys: number } }`
  - the singleton `tickStore`
  - `useQuote(key: string, active: boolean): Quote | undefined` and `useFeedStale(): boolean`
- Produces, from `useScreenActive.ts`: `useScreenActive(): boolean`, which is `useIsFocused()` (from expo-router) && `AppState.currentState === 'active'`, updated by the AppState listener.

- [ ] **Step 1: Write the failing tests.**
  - **protocol.** The tests are named:
    - `parses auth ok, error-without-type, market_data with string numbers, subscribe ack, pong and order_update`.
    - `returns null for non-JSON and unknown types`.
    - `toQuote computes change and pct from close; close 0 → pct 0`.
  - **tickStore**, with a manual `schedule`. The tests are named:
    - `100 puts on 3 keys then one flush → each key listener called once`.
    - `the last unsubscribe deletes the key's listener set (listenerKeys drops)`.
    - `evict removes the quote`.
    - `reset clears quotes, listeners and stale`.
    - `seed does not overwrite a quote with a newer ts, and put always overwrites a seed`.
    - `dir follows the ltp direction`.
    - `useQuote with active=false does not re-render on ticks, and catches up when active turns true`.
- [ ] **Step 2:** Run `npx jest src/core/realtime`. Expected: FAIL.
- [ ] **Step 3: Implement**, starting from `spike/app/src/core/tickStore.ts`. Drop `FlushMode`, `interval250` and `immediate`. The default `schedule` is `requestAnimationFrame`.
- [ ] **Step 4:** Run `npx jest src/core/realtime`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): tick store with eviction and protocol parsing`.

### Task 14: Realtime II: subscriptions and the WebSocket client

**Files:**
- Create: `src/core/realtime/{subscriptions.ts,wsClient.ts,useLiveQuote.ts}`, `test/helpers/fakeSocket.ts`
- Tests: `subscriptions.test.ts`, `wsClient.test.ts`, `wsClient.integration.test.ts`

**Interfaces:**
- Consumes: `TickStore`, `parseServerMessage`, `toQuote` and `quoteKey` (Task 13).
- Produces, from `subscriptions.ts`: `createSubscriptionManager(send: (m: object) => void, o?: { debounceMs?: number; setTimer?: typeof setTimeout }): { acquire(exchange: string, symbol: string, mode: Mode): () => void; resendAll(): void; activePairs(): Array<{ exchange: string; symbol: string }>; onReleased(cb: (quoteKey: string) => void): () => void }`.
  - Reference-counted per `subKey`.
  - Changes are batched over a 100 ms debounce into one `{action:'subscribe', symbols:[{symbol, exchange}], mode}` and one `{action:'unsubscribe', …}` per mode.
  - An acquire and release inside one window sends nothing.
- Produces, from `wsClient.ts`:
  - `type WebSocketCtor = new (url: string) => WebSocketLike`
  - `type RealtimeState = 'idle' | 'connecting' | 'authenticating' | 'live' | 'polling' | 'stopped'`
  - `type RealtimeStatus = { state: RealtimeState; lastCloseCode: number | null; reconnects: number; consecutiveFailures: number; lastError: string | null; messagesIn: number }`
  - `interface Realtime { start(): void; stop(): void; pause(): void; resume(): void; subscribe(exchange: string, symbol: string, mode: Mode): () => void; status(): RealtimeStatus; onStatus(cb: (s: RealtimeStatus) => void): () => void; onOrderUpdate(cb: (d: Record<string, unknown>) => void): () => void }`
  - `createRealtime(d: { origin: string; getTicket: () => Promise<{ ticket: string; wsPath: string }>; WebSocketImpl: WebSocketCtor; store: TickStore; pollQuotes: (pairs: Array<{ exchange: string; symbol: string }>) => Promise<void>; onRevoked: () => void; onCredentialsChanged: () => void; random?: () => number }): Realtime`
- Produces, from `useLiveQuote.ts`: `RealtimeContext` (a React context holding a `Realtime`), `useRealtime(): Realtime`, and `useLiveQuote(exchange: string, symbol: string, mode?: Mode): Quote | undefined`. It acquires through `useRealtime().subscribe` while `useScreenActive()` is true, releases otherwise, and reads `useQuote(quoteKey, active)`. Task 17 provides `RealtimeContext`; tests wrap with their own.

**Behaviour (exact numbers):**
- **URL:** `https→wss`, `http→ws`, origin plus `wsPath`. Every connect fetches a fresh ticket.
- **Auth:** on open, send `{action:'authenticate', ticket}`. No auth success within 15_000 ms → close and count a failure.
- **On auth success:** state `live`, `consecutiveFailures = 0`, `resendAll()`. If any order listener exists, send `{action:'subscribe_orders'}`.
- **Ticks:** `market_data` → `store.put(quoteKey, toQuote(...))`.
- **Order updates:** `order_update` messages are de-duplicated on `orderid|order_status|filled_quantity` (an LRU of the last 500) before reaching listeners.
- **Close 4403:** state `stopped`, call `onRevoked()`, never reconnect.
- **Close 1012:** call `onCredentialsChanged()` and reconnect after 0 ms.
- **Any other close or a ticket failure:** delay = `min(30_000, 500 * 2 ** consecutiveFailures)` × (0.8 + 0.4 × `random()`).
- **Polling fallback:** at `consecutiveFailures >= 5`, state `polling`. Call `pollQuotes(activePairs())` at once and then every 5_000 ms, while reconnecting continues. Polling stops when the socket is `live` again.
- **Ticket errors:** a `getTicket` failure of kind `revoked` → `onRevoked()`, then stop.
- **App-level ping:** send `{action:'ping'}` every 25_000 ms. No inbound message within 10_000 ms after a ping → close `4000 'ping timeout'`, then reconnect (half-open sockets on mobile networks).
- **Background:** `pause()` closes the socket (code 1000) after 30_000 ms. `resume()` reconnects at once if it was closed, and otherwise cancels the pending close.
- **Stale flag:** `store.setStale(state !== 'live')`.

- [ ] **Step 1: Write the failing tests.**
  - `FakeSocket` records `sent`, exposes `serverOpen()`, `serverSend(obj)` and `serverClose(code, reason)`, and keeps the instances in a static list. Use jest fake timers and `random: () => 0.5`.
  - **subscriptions.** The tests are named:
    - `two acquires of one key → one subscribe; first release → no unsubscribe; second → unsubscribe`.
    - `acquire+release inside 100 ms → nothing sent`.
    - `mixed modes batch into one message per mode`.
    - `resendAll re-sends every active key grouped by mode`.
    - `onReleased fires when the last mode of a quoteKey goes`.
  - **wsClient.** The tests are named:
    - `authenticates with the ticket, then resubscribes`.
    - `a new ticket per reconnect`.
    - `backoff delays 500, 1000, 2000, 4000, 8000 ms, capped at 30000`.
    - `polling starts at the 5th failure and stops when live`.
    - `4403 → onRevoked and no reconnect`.
    - `1012 → onCredentialsChanged and immediate reconnect`.
    - `auth timeout at 15 s`.
    - `ping timeout reconnects`.
    - `pause closes after 30 s; resume within 30 s keeps the socket`.
    - `stale flag tracks live`.
    - `duplicate order_update delivered once`.
  - **Integration**, with `startMockServerProcess()` and `WebSocketImpl: (await import('ws')).WebSocket`. `getTicket` signs in as in Task 11. The tests are named:
    - `subscribe NSE:RELIANCE Quote → store has a quote within 2 s`.
    - `control({revokeAll:true}) → onRevoked within 1 s`.
- [ ] **Step 2:** Run `npx jest src/core/realtime`. Expected: FAIL.
- [ ] **Step 3:** Implement to the behaviour above.
- [ ] **Step 4:** Run `npx jest src/core/realtime`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): WebSocket client with tickets, backoff and polling fallback`.

### Task 15: App lock and privacy

**Files:**
- Create: `src/core/platform/{lock.ts,privacy.ts,deviceName.ts}`, `src/ui/LockOverlay.tsx`
- Tests: `lock.test.ts`, `privacy.test.ts`, `LockOverlay.test.tsx`

**Interfaces:**
- Produces, from `lock.ts`:
  - `createLockController(d: { now: () => number; settings: () => { enabled: boolean; lockAfterMs: number }; authenticate: () => Promise<boolean> }): LockController`, where `LockController = { isLocked(): boolean; subscribe(cb: () => void): () => void; handleAppState(s: AppStateStatus): void; unlock(): Promise<boolean> }`
  - `expoAuthenticate()`, which is `LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock OpenAlgo', disableDeviceFallback: false })` → `success`
  - `canUseAppLock(): Promise<boolean>`, which is `getEnrolledLevelAsync() !== SecurityLevel.NONE`
  - the singleton `lockController`
- Produces, from `privacy.ts`: `applyPrivacy(o: { hideContentAndroid: boolean }): Promise<void>`.
  - iOS: `enableAppSwitcherProtectionAsync(0.9)`, always on.
  - Android: `hideContentAndroid ? preventScreenCaptureAsync('oa-privacy') : allowScreenCaptureAsync('oa-privacy')`.
  - On Android, `FLAG_SECURE` hides the recents preview **and** blocks screenshots. That is why this setting is off by default: the spec says screenshot blocking is off by default.
- Produces, from `deviceName.ts`: `deviceName(): string`, which is `(Device.modelName ?? 'Mobile device').slice(0, 64)`.
- Produces: `LockOverlay({ controller: LockController })`. It is an opaque full-screen view in the theme background, with an "Unlock" button (`testID="lock-unlock"`) that calls `unlock()`. It prompts once automatically on mount.

- [ ] **Step 1: Write the failing tests.** The tests are named:
  - `locked at start when enabled; unlocked at start when disabled`.
  - `background 299 s then active → still unlocked; 300 s → locked (lockAfterMs 300_000)`.
  - `'inactive' alone never locks`.
  - `unlock success unlocks; failure stays locked; concurrent unlock calls share one prompt`.
  - `privacy: iOS calls enableAppSwitcherProtectionAsync(0.9); Android toggles prevent/allow`.
  - `LockOverlay renders no children content and calls unlock on press`.
- [ ] **Step 2:** Run `npx jest src/core/platform src/ui/LockOverlay.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): app lock and app-switcher privacy`.

### Task 16: UI kit and theme

**Files:**
- Create: `src/ui/{theme.tsx,format.ts,Text.tsx,Price.tsx,Change.tsx,Button.tsx,ListRow.tsx,Badge.tsx,Skeleton.tsx,EmptyState.tsx,ErrorState.tsx,NotYetAvailable.tsx}`
- Tests: `format.test.ts`, `components.test.tsx`

**Interfaces:**
- Consumes: `tokens` (Task 3), `usePrefs` (Task 8), `ApiError` and `userMessage` (Task 9).
- Produces, from `theme.tsx`:
  - `ThemeProvider` and `useTheme(): { scheme: 'dark' | 'light'; c: Palette; trade: TradePalette; analyzer: Palette }`
  - The scheme is prefs.theme, with `system` resolved via `useColorScheme()` and falling back to `dark`.
- Produces, from `format.ts`:
  - `fmtPrice(n: number | undefined, dp = 2): string`: `'--'` for undefined; otherwise `en-IN` with `dp` fixed decimals
  - `fmtSigned(n)`: `+12.30` / `-4.05`
  - `fmtPct(n)`: `+1.23%`
  - `signOf(n): 1 | -1 | 0`
- Produces, as components (all props typed):
  - `Text({ variant?: 'title'|'heading'|'body'|'caption'|'mono'; tone?: 'default'|'muted'|'profit'|'loss' })`; `mono` uses `fontVariant: ['tabular-nums']`
  - `Price({ value })`
  - `Change({ change, pct })`, coloured by `signOf` with `trade.profit` or `trade.loss`
  - `Button({ title; onPress; variant?: 'primary'|'secondary'|'destructive'|'buy'|'sell'; loading?; disabled?; testID? })`, which fires a Light haptic on press
  - `ListRow`
  - `Badge({ label; tone: 'neutral'|'live'|'analyze'|'warning'|'danger' })`
  - `Skeleton({ rows })`
  - `EmptyState({ title; body?; action? })`
  - `ErrorState({ error: unknown; onRetry? })`, which shows `userMessage` for an `ApiError`, else "Something went wrong."
  - `NotYetAvailable({ what })`, which renders `{what} aren't in this build yet. They arrive in the next update.`

- [ ] **Step 1: Write the failing tests.**
  - `format` table: `fmtPrice(1569.9)` → `'1,569.90'`, `fmtPrice(123456.5)` → `'1,23,456.50'`, `fmtPct(-0.456)` → `'-0.46%'`, `fmtSigned(0)` → `'0.00'`.
  - `Change` colours by sign under both schemes.
  - `Button` with `loading` ignores presses.
  - `ErrorState` shows the `rate_limited` copy with its seconds.
  - `useTheme` returns `tokens.dark.background` when the prefs theme is dark.
- [ ] **Step 2:** Run `npx jest src/ui`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the components small and use StyleSheet only, with no styling library.
- [ ] **Step 4:** Run `npx jest src/ui`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ui): theme and base components`.

### Task 17: App shell: services, navigation guard, tabs, status strip

**Files:**
- Create: `src/core/services/{deps.tsx,appServices.tsx,sessionController.ts}`, `src/app/+native-intent.tsx`, `src/app/(app)/_layout.tsx`, `src/app/(app)/(tabs)/{_layout.tsx,index.tsx,orders.tsx,portfolio.tsx,tools.tsx,account.tsx}`, `src/features/account/components/StatusStrip.tsx`
- Modify: `src/app/_layout.tsx`
- Delete: `src/app/index.tsx`
- Tests: `sessionController.test.ts`, `src/app/rootStack.test.tsx`, `StatusStrip.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 8–16.
- Produces, from `deps.tsx`:
  - `interface AppDeps { fetch: typeof fetch; crypto: CryptoDeps; openAuthSession: OpenAuthSession; secureKV: SecureKV; now: () => number; appVersion: string; deviceName: string; WebSocketImpl: WebSocketCtor; allowLoopbackHttp: boolean }`
  - `defaultDeps`, with `allowLoopbackHttp: __DEV__`
  - `DepsProvider({ deps?: Partial<AppDeps> })` and `useDeps()`
- Produces, from `appServices.tsx`:
  - `interface AppServices { profile: ServerProfile; session: Session; http: HttpClient; realtime: Realtime; queryClient: QueryClient }`
  - `createAppServices(profile: ServerProfile, deps: AppDeps, controller: SessionController): AppServices`
  - `disposeAppServices(s: AppServices): void`, which runs `realtime.stop`, `session.dispose`, `queryClient.clear` and `tickStore.reset`
  - `AppServicesProvider` and `useServices()`
- **Wiring** inside `createAppServices`:
  - `http.onAuthFailure(revoked)` → `controller.signOut('revoked')`
  - `onBrokerSessionExpired` → `useBrokerSession.setExpired(true)` and `tickStore.setStale(true)`
  - `realtime.getTicket` = `http.api('ws/ticket', {}, WsTicketResponseSchema)`
  - `pollQuotes` = multiquotes → `tickStore.put`
  - `onRevoked` → `controller.signOut('revoked')`
  - `onCredentialsChanged` → invalidate `qk.appInfo`
- Produces, from `sessionController.ts`: `createSessionController(deps: AppDeps): SessionController`, where `SessionController = { restore(): Promise<void>; completeSignIn(profile: ServerProfile, tokens: TokenSet): Promise<void>; signOut(reason: SignedOutReason): Promise<void>; current(): AppServices | null }`, plus the singleton `sessionController`.
  - `restore`: when a profile and a refresh token are both present → `signedIn`, with no network call (a refresh happens on the first request); otherwise → `signedOut(null)`.
  - `completeSignIn`: `profileStore.save`, then `session.establish`, then `signedIn`.
  - `signOut`: `session.signOut`, then dispose, `clearProfileCache`, `profileStore.clear`, set `prefs.lastOrigin = profile.origin`, and `signedOut(reason)`. It is idempotent.
- Produces: `RootStack` (a named export of `src/app/_layout.tsx`):

```tsx
<Stack screenOptions={{ headerShown: false }}>
  <Stack.Protected guard={status === 'signedIn'}><Stack.Screen name="(app)" /></Stack.Protected>
  <Stack.Protected guard={status === 'signedOut'}><Stack.Screen name="(onboarding)" /></Stack.Protected>
</Stack>
```

- **The default root layout:**
  - `SplashScreen.preventAutoHideAsync()`; wraps `GestureHandlerRootView` → `SafeAreaProvider` → `ThemeProvider` → `DepsProvider` → `RootStack`;
  - calls `sessionController.restore()` once, and hides the splash when the status leaves `restoring`;
  - calls `applyPrivacy(prefs)`;
  - feeds `lockController.handleAppState` from AppState;
  - renders `<LockOverlay>` over everything while signed in and locked.
- **`(app)/_layout.tsx`** provides `AppServicesProvider`, `QueryClientProvider` and `RealtimeContext` (Task 14) from `sessionController.current()`, and mounts `RealtimeLifecycle`. That component runs `start` on mount; AppState `background` → `pause()` and `active` → `resume()`; `stop` on unmount. It also runs `wireQueryManagers()`.
- **`(tabs)/_layout.tsx`:** `<View style={{ flex: 1 }}><StatusStrip /><NativeTabs …>`, with five triggers:

| Route | Label | iOS `sf` | Android `md` |
|---|---|---|---|
| `index` | Watchlist | `list.bullet` | `list` |
| `orders` | Orders | `doc.text` | `receipt_long` |
| `portfolio` | Portfolio | `briefcase` | `work` |
| `tools` | Tools | `square.grid.2x2` | `apps` |
| `account` | Account | `person.crop.circle` | `account_circle` |

  - `orders`, `portfolio` and `tools` render `<NotYetAvailable what="Orders" />` (and "Portfolio", "Tools").
  - `index` and `account` render placeholders until Tasks 19 and 20.
- **`StatusStrip`** (top safe-area padded):
  - `ModeBadge` comes from Task 19; until then a slot that renders `null`;
  - a connection dot from `realtime.onStatus`: `live` = green, `connecting`/`authenticating` = amber, `polling` = amber with the label "Delayed", `stopped`/`idle` = grey;
  - when `useBrokerSession.expired` is set: "Broker session ended. Log in to your broker on the web." In-app re-login is M3.
- **`+native-intent.tsx`:** `redirectSystemPath({ path })` returns `'/'` when the path contains `/oauth/callback` or `/broker/done`, and otherwise returns `path`. Without it, the Android Custom Tab redirect would hit an unmatched route.

- [ ] **Step 1: Write the failing tests.**
  - **sessionController**, with injected deps and `memoryKV`. The tests are named:
    - `restore with profile+token → signedIn without any fetch`.
    - `restore with nothing → signedOut(null)`.
    - `completeSignIn saves the profile and refresh token, then signedIn`.
    - `signOut('user') revokes, wipes both keys, clears the cache and tick store, keeps lastOrigin`.
    - `two signOut calls → one revoke`.
  - **`rootStack.test.tsx`**, with `renderRouter` from `expo-router/testing-library` and inline routes (`_layout` = `RootStack`, plus `(onboarding)/server` and `(app)/index` showing text). The tests are named:
    - `signedOut shows onboarding`.
    - `switching to signedIn shows the app`.
    - `switching back to signedOut returns to onboarding`.
  - **StatusStrip.** The tests are named:
    - `shows Delayed when polling`.
    - `shows the broker banner when expired`.
- [ ] **Step 2:** Run `npx jest src/core/services src/app src/features/account`. Expected: FAIL.
- [ ] **Step 3: Implement.** If NativeTabs cannot render under jest-expo, nothing in this task's tests renders it. Only the device run in Task 21 covers it.
- [ ] **Step 4:** Run the same command, then `npm run typecheck && npm run boundaries`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(app): session controller, protected navigation and tab shell`.

### Task 18: Onboarding

**Files:**
- Create: `src/features/onboarding/{problemCopy.ts,useOnboarding.ts,screens/ServerScreen.tsx}`, `src/app/(onboarding)/{_layout.tsx,server.tsx}`
- Tests: `problemCopy.test.ts`, `ServerScreen.test.tsx`

**Interfaces:**
- Consumes: `parseServerOrigin`, `profileIdFor` and `usePrefs` (Task 8); `checkServer` and `signIn` (Task 10); `sessionController.completeSignIn` (Task 17); `useDeps` (Task 17).
- Produces:
  - `problemText(p: ServerProblem | { kind: 'origin'; reason: OriginError } | { kind: 'signin'; reason: SignInResult['reason'] } | { kind: 'signed_out'; reason: SignedOutReason }): { title: string; body: string; action?: { label: string; kind: 'use_issuer' | 'open_docs' | 'retry' } }`
  - `useOnboarding()`, with state `'idle' | 'checking' | 'ready' | 'signing_in' | 'error'`

**Copy (exact).**

Origin, server and sign-in problems:

| Case | Title | Body | Action |
|---|---|---|---|
| origin `empty` | Enter your server address | e.g. https://openalgo.example.com | |
| origin `invalid` | That isn't a valid address | Check for typos. Use the address you open OpenAlgo with in a browser. | |
| origin `http_not_allowed` | https is required | The app connects only over https. Use your ngrok address or your domain. | `open_docs` "ngrok setup" |
| origin `has_credentials` | Remove the username and password | Enter only the server address. | |
| `unreachable` | Can't reach the server | Check the address and your connection. If the server uses a self-signed certificate, the app can't connect to it. | `retry` |
| `not_openalgo` | This doesn't look like an OpenAlgo server | Check the address. | |
| `upgrade_server` | Upgrade OpenAlgo | This server is too old for the mobile app. Update OpenAlgo to the latest release, then try again. | |
| `mobile_app_disabled` | Mobile app access is off | In OpenAlgo's .env set MOBILE_APP_ENABLED = 'True' and restart the server. | |
| `issuer_mismatch` | This server calls itself {issuer} | Use that address instead. | `use_issuer` "Use {issuer}" |
| `app_update_required` | Update the app | This server needs OpenAlgo mobile {minAppVersion} or later. | |
| signin `cancelled` | Sign-in was cancelled | | |
| signin `denied` | Access was denied | You chose Deny on the server. | |
| signin `state_mismatch` / `invalid_callback` | Sign-in didn't complete | Try again. | |
| signin `exchange_failed` | Sign-in didn't complete | {message} | |

Signed-out reasons:

| Reason | Body |
|---|---|
| `revoked` | This device was removed from OpenAlgo. Sign in again. |
| `session_ended` | Your sign-in expired. Sign in again. |
| `storage_error` | Couldn't save your sign-in securely on this device. Sign in again. |
| `user` | (nothing) |

**The flow:**
1. The URL field (`testID="server-url"`) is prefilled from `prefs.lastOrigin`. It sets autoCapitalize none, autoCorrect off and `keyboardType="url"`.
2. Continue (`server-continue`) runs `parseServerOrigin`. When the result is `stripped`, the screen shows `Using {origin}`.
3. Then `checkServer`. On success it shows `Connected to {origin} · OpenAlgo {server_version}` and a "Sign in" button (`server-signin`).
4. Sign in runs `signIn({ discovery, deviceName })`, then `completeSignIn(profile, tokens)`. The profile is built from the origin, the info, the discovery endpoints and the device name.
5. When the status arrives with a `signedOutReason`, its body shows as a banner.
6. A Read-only grant shows "Signed in read-only. Trading is off on this device." on the Account screen (Task 19).

- [ ] **Step 1: Write the failing tests.**
  - One `test.each` covers every copy row.
  - `ServerScreen.test.tsx`, with injected deps. The tests are named:
    - `http://example.com shows 'https is required' with the docs link`.
    - `(RF 1) a pasted 'https://x.ngrok.app/login' shows 'Using https://x.ngrok.app'`.
    - `issuer_mismatch shows 'Use https://b.example.com' and pressing it re-checks that origin`.
    - `success then Sign in calls completeSignIn with the profile (origin, tokenEndpoint, deviceName)`.
    - `(RF 3) a cancelled sign-in shows 'Sign-in was cancelled' and the Sign in button is enabled again`.
    - `(RF 4) checkServer → not_openalgo shows the not-OpenAlgo copy`.
    - `arriving with signedOutReason 'revoked' shows the banner`.
- [ ] **Step 2:** Run `npx jest src/features/onboarding`. Expected: FAIL.
- [ ] **Step 3:** Implement. Open `NGROK_DOCS_URL` with `WebBrowser.openBrowserAsync`. Before committing, run `curl -sI <url>` and expect `200`. If it is not 200, use `https://docs.openalgo.in` and note it.
- [ ] **Step 4:** Run `npx jest src/features/onboarding`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(onboarding): https-only server check and sign-in`.

### Task 19: Account, LIVE/ANALYZE badge, diagnostics

**Files:**
- Create: `src/features/account/{model.ts,api.ts,diagnostics.ts,components/ModeBadge.tsx,screens/AccountScreen.tsx,screens/DiagnosticsScreen.tsx}`, `src/app/(app)/diagnostics.tsx`
- Modify: `src/app/(app)/(tabs)/account.tsx` and `StatusStrip.tsx` (mount `LiveModeBadge`)
- Tests: `api.test.tsx`, `ModeBadge.test.tsx`, `diagnostics.test.ts`, `AccountScreen.test.tsx`

**Interfaces:**
- Consumes: `useServices` (Task 17), `qk` (Task 12), `AppInfoSchema` (Task 9), `getLogLines` and `redact` (Task 8), `tickStore.stats` and `realtime.status` (Tasks 13–14), `usePrefs`, `canUseAppLock` and `applyPrivacy` (Tasks 8, 15).
- Produces, from `model.ts`: `AnalyzerSchema = envelope(z.object({ mode: z.enum(['live', 'analyze']), analyze_mode: bool, total_logs: num }))`.
- Produces, from `api.ts`:
  - `useAppInfo()`: GET `/api/v1/app/info` with a bearer. On `account.broker_session === 'active'` it calls `useBrokerSession.setExpired(false)`.
  - `useAnalyzerMode(): 'live' | 'analyze' | 'unknown'`: `http.api('analyzer', {}, AnalyzerSchema)`, with `refetchInterval: 30_000` while `useScreenActive()`.
- Produces: `ModeBadge({ mode })`: `LIVE` uses tone `danger`, because real money is at stake; `ANALYZE` uses tone `analyze`, the web's analyzer primary; `unknown` shows `—`. `testID="mode-badge"`. `LiveModeBadge` wires it to `useAnalyzerMode`.
- Produces, from `diagnostics.ts`: `buildDiagnostics(i: { profile; info; realtime: RealtimeStatus; ticks: ReturnType<TickStore['stats']>; prefs; app: { version: string; build: string; platform: string; os: string; device: string }; logs: LogLine[] }): Record<string, unknown>` and `serializeDiagnostics(r): string`. The latter is `JSON.stringify(redact(r), null, 2)`.

**AccountScreen sections:**
- **Server:** origin, server version, broker.
- **Device:** name, access "Trade" or "Read-only (trading off)" from `session.scopes()`.
- **Mode:** `ModeBadge`. The toggle comes in M3.
- **Appearance:** theme System, Dark or Light.
- **Security:**
  - App lock switch, disabled with "Set a device passcode to use app lock" when `canUseAppLock()` is false;
  - Lock after 1, 5 or 15 min;
  - on Android, "Hide content in screenshots and recent apps".
- **Diagnostics** (link).
- **Sign out** (`testID="sign-out"`): asks "Sign out of {origin}?", then `sessionController.signOut('user')`.
- **Version:** `{appVersion} ({build})`.

**DiagnosticsScreen:** the report sections, the last 200 log lines, "Copy diagnostics" (expo-clipboard `setStringAsync(serializeDiagnostics(...))`) and "Check server again" (runs `checkServer` and shows the result with `problemText`).

- [ ] **Step 1: Write the failing tests.**
  - `useAnalyzerMode`, against a fake http: `analyze` for `analyzer-analyze.json`, `live` for `analyzer-live.json`, `unknown` on error.
  - `ModeBadge` labels and tones.
  - `serializeDiagnostics`: given logs and data containing `Bearer eyJabc.def`, `refresh_token: 'r1.secret'` and `?ticket=t1`, the output matches none of `/eyJ|r1\.secret|t1\b|Bearer [^\[]/`.
  - `AccountScreen`:
    - a Read-only session shows "Read-only (trading off)";
    - Sign out confirms, then calls `signOut('user')`;
    - lock settings write prefs.
- [ ] **Step 2:** Run `npx jest src/features/account`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx jest src/features/account && npm run boundaries`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(account): mode badge, settings, diagnostics and sign out`.

### Task 20: Watchlist (read-only, live)

**Files:**
- Create: `src/features/watchlist/{model.ts,api.ts,components/WatchRow.tsx,screens/WatchlistScreen.tsx}`
- Modify: `src/app/(app)/(tabs)/index.tsx`
- Tests: `model.test.ts`, `api.test.tsx`, `WatchRow.test.tsx`, `WatchlistScreen.test.tsx`

**Interfaces:**
- Consumes: `useServices`, `qk`, `useLiveQuote`, `tickStore`, `MultiQuotesSchema`, `useScreenActive`, `usePrefs` and the UI kit.
- Produces, from `model.ts`: `WatchlistsResponseSchema = envelope(z.array(z.object({ id: int, name: z.string(), position: num, items: z.array(z.object({ id: int, symbol: z.string(), exchange: z.string(), position: num })) })))`.
- Produces, from `api.ts`:
  - `useWatchlists()`: GET `/watchlist/api/lists`.
  - `useSeedQuotes(items: Array<{ exchange: string; symbol: string }>)`. Each time the screen gains focus with these items, it POSTs `multiquotes` in batches of 100 and calls `tickStore.seed(quoteKey, …)` with `{ ltp, close: prev_close, open, high, low, volume }`. Entries carrying `error` are skipped.

**Screen:**
- Title "Watchlist".
- List chips in a horizontal scroll, one per list; the selected id is stored in `prefs.selectedWatchlistId` and defaults to the first list.
- A `FlashList` of `WatchRow`s.
- Pull to refresh refetches the lists and the seed.
- **States:**
  - loading: `Skeleton rows={8}`;
  - error: `ErrorState` with retry;
  - no lists: EmptyState "No watchlists yet" / "Create one in OpenAlgo on the web. Editing on the phone comes in the next update.";
  - empty list: "This list is empty."
- **WatchRow** (memo, `testID="watch-row-{EXCHANGE}-{SYMBOL}"`):
  - symbol and exchange tag; `Price` of the LTP; `Change`;
  - a flash on LTP change for 400 ms, as in the spike, skipped when `useReducedMotion()` (reanimated) is true;
  - `opacity: 0.5` while `useFeedStale()`;
  - the row is 56 px high;
  - no B/S buttons in M2. Index exchanges (`*_INDEX`) never get trade actions, also in M3.

- [ ] **Step 1: Write the failing tests.**
  - The schema accepts string ids and positions.
  - `api.test.tsx`: `(RF 5) with no ticks, rows show the multiquotes price after focus; a later tick with a newer ts replaces it; a seed arriving after a tick does not overwrite it`.
  - `WatchRow`:
    - shows `--` with no quote;
    - updates on `tickStore.put` after a flush;
    - is dimmed when stale;
    - renders no flash overlay when reduced motion is on.
  - `WatchlistScreen`: chips switch lists and persist the selection; the empty and error states use the exact copy.
- [ ] **Step 2:** Run `npx jest src/features/watchlist`. Expected: FAIL.
- [ ] **Step 3:** Implement. Start the row from `spike/app/src/features/watchlist/WatchRow.tsx`, with theme colours instead of the spike's `C`.
- [ ] **Step 4:** Run `npx jest src/features/watchlist`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(watchlist): server watchlists with live prices`.

### Task 21: M2 exit run, e2e hooks, docs

**Files:** Create `e2e/README.md`. Modify `README.md` if the run shows a wrong step.

- [ ] **Step 1: Run the full local gate.**
  - Run: `npm run lint && npm run typecheck && npx jest --ci && npm run test:scripts && npm run boundaries && npm run tokens:check && npx expo export --platform android --platform ios --output-dir dist-export && npm run bundles`
  - Expected: all pass, and the bundle stays inside budget. If growth over the baseline is above 5%, run `--update` in this commit and give the reason in the PR.
- [ ] **Step 2: iOS simulator run against the mock.** Start `npm run mock`, then `npx expo run:ios`. Check, in order:
  1. Enter `localhost:8080` and see `https is required`. Enter `http://localhost:8080` and see "Connected to … OpenAlgo mock-1".
  2. Sign in and choose Trade on the mock consent page. The Watchlist shows "Nifty picks", with rows ticking and the mode badge showing LIVE.
  3. Run `curl -X POST localhost:8080/__mock/control -d '{"analyzeMode":true}' -H 'Content-Type: application/json'`. Within 30 s the badge shows ANALYZE.
  4. Run `…'{"closeSockets":1012}'`. The dot turns amber, then green again.
  5. Run `…'{"brokerSession":"expired"}'`. The broker banner appears and the rows dim.
  6. Account → Sign out. You are back on the server screen with the origin prefilled.
  7. Sign in again, then run `…'{"revokeAll":true}'`. You land on the server screen with "This device was removed from OpenAlgo."
  8. Set Lock after 1 min, background the app for over 60 s, and return. The lock overlay shows, and Unlock (simulator Face ID → Matching) opens the app.
- [ ] **Step 3: Android emulator run.** Run `npx expo run:android` and use `http://10.0.2.2:8080`. Repeat checks 1–2 and 6. Also check:
  - after the Custom Tab redirect, no "Unmatched route" screen appears;
  - the back button from the Custom Tab gives "Sign-in was cancelled".
- [ ] **Step 4: Real server run, once Plan 1's M1 is merged.**
  - Point `openalgo.ref` at that merge commit and run `npm run tokens:check`.
  - Use an https dev server: ngrok to a local OpenAlgo with `MOBILE_APP_ENABLED='True'`.
  - Run checks 1, 2, 6 and 7 against it. Revoke the device from the web, or with `/oauth/revoke`.
  - Record the device, the OS, what passed and anything that didn't in the PR description. That is the M2 exit evidence: "sign in to a real server; live LTP on a watchlist row".
- [ ] **Step 5: Write `e2e/README.md`.** It lists the testIDs Maestro will use in M3:
  - `server-url`, `server-continue`, `server-signin`
  - `watch-row-{EXCHANGE}-{SYMBOL}`
  - `mode-badge`, `lock-unlock`, `sign-out`

  It also records the mock's `AUTO_APPROVE=trade` mode, used for unattended runs.
- [ ] **Step 6:** Commit: `docs: e2e hooks for Maestro`. Then stop, and hand over for review. Do not push without the owner's OK.

---

## Self-review

1. **Spec coverage**
   - 7.3: tab shells (T17), Account (T19), Watchlist read-only (T20; editing is M3), onboarding (T18), lock screen (T15).
   - 7.4: the layout, and the boundaries with the DOM rule (T4).
   - 7.5: zod coercion and the error model (T9); TanStack keys (T12); the WS manager with ticket, backoff, polling, 1012 and 30 s background (T14); the tick store fixes (T13); zustand without credentials (T8, T11).
   - 7.7: https only (T8, T18); PKCE and the system browser (T10); SecureStore this-device-only, memory-only access token, single-flight refresh with save-before-use (T11); app lock and privacy (T15); sign-out revoke and wipe (T11, T17).
   - 7.9: tokens from the web (T3); dense rows, flash with reduced motion, skeletons, empty and error states (T16, T20).
   - 8: no secrets (T4 gitleaks plus the bundle scan; T8 redaction; T19 diagnostics test).
   - 9.1: `openalgo.ref` and sync (T2).
   - 9.2–9.3 PR tier: T1, T4, T5.
   - 12: bundle budget (T4).
   - Deferred by scope, as written in each task:
     - Maestro: M3, hooks in T21.
     - Signed release and TestFlight: M6.
     - LIVE/ANALYZE toggle, broker re-login and order flows: M3.
     - DOM, the WebView version check and the frontend Metro alias: M4/M5.
2. **Step scan.** Every code step names its file, its signatures and the pinned values. Every test step names its assertions. No "TBD" remains.
3. **Type consistency.** These are used with the same names across tasks: `TokenSource` (T9) is implemented by `Session` (T11); `ServerProfile` (T8) is used in T11, T17 and T18; `Quote`, `TickStore` and `quoteKey` (T13) are used in T14 and T20; `AppServices` and `useServices` (T17) are used in T14's hook, T19 and T20; `SignedOutReason` (T10) is used in T11, T17 and T18.
4. **Review Focus.** All five lines have tests, marked (RF n), in Tasks 8, 9, 10, 11, 18 and 20.
5. **Proportion.** Bodies are given only where tests don't fix the result: the classification table, the copy, the backoff numbers and the colour mapping. Everything else is signatures and assertions.
