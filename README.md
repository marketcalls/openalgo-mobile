# OpenAlgo Mobile

The OpenAlgo mobile app, built with **React Native + Expo** (SDK 58) for Android and iOS.
It talks to an unmodified OpenAlgo server over its REST API and WebSocket feed.

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
real OpenAlgo server you configure through the environment.

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

CI also runs `expo install --check`, `expo-doctor` and gitleaks (git history and the
exported bundles). `.githooks` runs a fast subset before each commit.

## CI and artifacts

`.github/workflows/ci.yml` runs on every push and pull request to `main`. The `checks`
job gates the builds. Open the run under the **Actions** tab and download from
**Artifacts**:

- **`android-apk`**: `openalgo-<version>-b<run>-<sha7>.apk`, a release APK for arm64 and
  armv7. It is signed with the React Native debug key, so sideload it
  (`adb install -r <file>.apk`). It is not suitable for the Play Store.
- **`ios-simulator-app`**: the app for the iOS Simulator on an Apple Silicon Mac. Unzip it,
  then `xcrun simctl install booted <name>.app`.
- **`ios-ipa-unsigned`** (not built for pull requests): an unsigned iPhone build. Re-sign it
  with your own Apple ID (for example Sideloadly or AltStore) to install it.

`.github/workflows/spike.yml` (**Spike builds**) builds the old spike and runs only when
`spike/**` or the workflow itself changes. Store signing, golden-image regeneration and
TestFlight upload are not set up yet.

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
