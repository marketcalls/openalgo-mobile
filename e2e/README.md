# End-to-end flows

Maestro flows for the Android release build. They run only in CI (the `e2e-android` job in
`.github/workflows/ci.yml`): the job builds an x86_64 APK, starts the mock server on the runner and
runs both flows in an API 34 emulator, where the host is `10.0.2.2`.

| Flow | Mock server | What it checks |
|---|---|---|
| `onboarding-live.yaml` | `PORT=5000 WS_PORT=8765` | server, key and live-feed steps; the watchlist shows a price within 10 s |
| `onboarding-polling.yaml` | `PORT=5000 WS_PORT=off` | the feed test fails, the profile saves in polling mode, `badge-polling` shows and a price is shown |

The job runs both flows for `PROFILE` 2.0.0.0 and 2.0.3.5. Run the mock yourself with
`PROFILE=2.0.3.5 npm run mock`, then `maestro test e2e/onboarding-live.yaml` against an emulator
with the release APK installed.

## Test IDs

The flows use the ids marked with *. The rest are listed for writing new flows.

Onboarding
- `server-url` *, `server-using`, `server-continue` *, `http-ack` *
- `key-input` *, `key-show`, `key-error`, `key-continue` *
- `feed-url`, `feed-test` *, `feed-live` *, `feed-broker`, `feed-error`, `feed-help` *,
  `feed-host-cancel`, `feed-host-continue`, `onboarding-save` *
- `update-back`, `start-retry`, `start-forget`

Watchlist
- `watch-row-<EXCHANGE>-<SYMBOL>`, `watch-ltp-<EXCHANGE>-<SYMBOL>` * (for example
  `watch-ltp-NSE-RELIANCE`), `watch-flash-<EXCHANGE>-<SYMBOL>`

Status
- `badge-http`, `badge-polling` *, `badge-broker`, `mode-badge`
- `banner-banned`, `banner-key`, `banner-broker`, `banner-polling`

Lock
- `lock-overlay`, `lock-unlock`, `lock-forget`

Account
- `account-screen`, `account-url`, `account-version`, `account-feed`, `app-version`
- `link-server`, `link-key`, `link-diagnostics`, `link-lost-phone`
- `server-save`, `key-save`, `broker-status`, `broker-login`
- `analyzer-toggle`, `analyzer-error`, `analyzer-semi-auto`
- `pref-app-lock`, `pref-confirm-live`, `pref-hide-content`, `app-lock-unavailable`,
  `lock-after-<ms>`, `theme-<mode>`
- `diagnostics-copy`, `diagnostics-refresh`, `cap-<feature>`, `lost-step-<n>`
- `sign-out`, `sign-out-confirm`, `sign-out-delete`

Shared
- `skeleton`, `sheet-backdrop`
