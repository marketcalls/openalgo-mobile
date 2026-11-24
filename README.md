# OpenAlgo Mobile

The OpenAlgo mobile app, built with **React Native + Expo** (SDK 58) for Android and iOS.
It talks to an unmodified OpenAlgo server over its REST API and WebSocket feed.

**OpenAlgo Desktop** (the Rust/Tauri engine) is not supported yet: it was not tested in M1,
and it may lack `/auth/app-info` and `swagger.json` or number its versions differently from
the Flask server the app's feature gates follow.

> The previous Flutter app is preserved, unchanged, on the
> [`backup/flutter-main-2026-11-23`](https://github.com/marketcalls/openalgo-mobile/tree/backup/flutter-main-2026-11-23)
> branch.

## Layout

| Path | What it is |
|---|---|
| `src/` | App code (Expo Router screens, features, core services, UI) |
| `assets/` | Icons and splash images |
| `dev/mock-server/` | A local OpenAlgo-compatible server (REST and WebSocket) for development and tests |
| `scripts/` | Build helpers: theme token generation, openalgo sync, bundle budgets, pre-commit check |
| `test/` | Test helpers, fixtures, `compat` tests (against the mock) and `real` tests (against a real server) |
| `openalgo.ref` | The pinned `marketcalls/openalgo` commit the theme tokens come from |
| `spike/` | The earlier performance spike, kept for reference; it has its own README |
| `docs/superpowers/` | The design and plans |

## Mock server

```bash
npm ci
npm run mock          # starts the mock and prints MOCK_READY rest=... ws=...
```

Point the app's server step at the printed REST URL. `npm run test:compat` runs the
integration tests against it. `npm run real-server-check` runs the same checks against a
real OpenAlgo test server: the openalgo checkout on your Mac, in analyzer mode and logged in to
the broker, never the live trading server. Copy `.env.test.example` to `.env.test.local` (git
ignores it) and fill in `OPENALGO_TEST_URL`, `OPENALGO_TEST_APIKEY` and, for the live-feed
checks, `OPENALGO_TEST_WS_URL`. The test server needs `FLASK_HOST_IP='0.0.0.0'` and
`WEBSOCKET_HOST='0.0.0.0'`. Without the file the suite skips itself; in live mode every test
fails, and the suite never toggles the mode.

## Checks

| Command | What it checks |
|---|---|
| `npm run lint` | Biome |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit and component tests (jest) |
| `npm run test:scripts` | Tests for `scripts/` and `dev/` (node test runner) |
| `npm run test:compat` | App services against the mock server |
| `npm run boundaries` | Import boundaries (dependency-cruiser) |
| `npm run tokens:check` | Generated theme tokens match the pinned openalgo web source |
| `npm run export` then `npm run bundles` | Production bundles build and stay inside the size budgets |

CI also runs `expo install --check`, `expo-doctor`, gitleaks (git history and the
exported bundles) and `scripts/check-bundle-keys.mjs`, which fails on any 64-hex run in the
Hermes bundles (gitleaks cannot see a key there). `.githooks` runs a fast subset before each
commit.

## CI and artifacts

`.github/workflows/ci.yml` runs on every push and pull request to `main`. The `checks`
job gates the builds. Open the run under the **Actions** tab and download from
**Artifacts**:

- **`android-apk`**: a release APK for arm64 and armv7, to sideload
  (`adb install -r <file>.apk`). It is not suitable for the Play Store. With the release
  keystore secrets set (below) it is `openalgo-<version>-b<run>-<sha7>-release.apk`, and
  the job summary shows the signing certificate's SHA-256. Without them (and on pull
  requests from forks) it is signed with the debug key and named `...-debugkey.apk`; that
  build will not update a release-signed install.
- **`ios-simulator-app`**: the app for the iOS Simulator on an Apple Silicon Mac. Unzip it,
  then `xcrun simctl install booted <name>.app`.
- **`ios-ipa-unsigned`** (not built for pull requests): an unsigned iPhone build. Re-sign it
  with your own Apple ID (for example Sideloadly or AltStore) to install it.

`.github/workflows/spike.yml` (**Spike builds**) builds the old spike and runs only when
`spike/**` or the workflow itself changes. Store signing, golden-image regeneration and
TestFlight upload are not set up yet.

## Android release signing (owner steps)

The builder never handles the key. Do this once, on your own machine:

1. `keytool -genkeypair -v -storetype PKCS12 -keystore openalgo-release.jks -alias openalgo -keyalg RSA -keysize 4096 -validity 10000`
2. `base64 -i openalgo-release.jks | gh secret set ANDROID_KEYSTORE_BASE64`, then
   `gh secret set ANDROID_KEY_ALIAS`, `gh secret set ANDROID_KEYSTORE_PASSWORD` and
   `gh secret set ANDROID_KEY_PASSWORD` (for a PKCS12 keystore the two passwords are equal).
3. Keep the `.jks` and its passwords in two offline places. Losing them means installs
   signed with it can never be updated.

## Bumping the openalgo ref

The theme tokens are generated from the OpenAlgo web frontend at the commit in
`openalgo.ref`. To move to a newer commit:

1. Put the new commit SHA in `openalgo.ref`.
2. Run `npm run sync-openalgo` (finds the commit in your local `../openalgo` checkout), then
   `npm run tokens` to regenerate the tokens.
3. Commit `openalgo.ref` and the regenerated files together. CI fetches only
   `frontend/src` at that commit and runs `tokens:check`.

Renovate (`renovate.json`) proposes weekly dependency updates, grouping `expo`, `expo-*`
and `react-native*`, and pins GitHub Actions to digests.

## License

[AGPL-3.0](LICENSE). The app reuses OpenAlgo web frontend code, which is AGPL-3.0, so this
repository and any build you distribute must stay AGPL-3.0 with source available. The
Flutter app remains available on the backup branch above.
