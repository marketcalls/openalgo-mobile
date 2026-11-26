# End-to-end flows

Maestro flows for the Android release build. They run only in CI (the `e2e-android` job in
`.github/workflows/ci.yml`): the job builds an x86_64 APK, starts the mock server on the runner and
runs the flows in an API 34 emulator with the Pixel 6 profile (1080 x 2400), where the host is
`10.0.2.2`. The job hides system error dialogs on the emulator (`hide_error_dialogs`): after a
slow boot, a "Pixel Launcher isn't responding" dialog once covered every screen. A failed flow
does not stop the next one; the job fails at the end and uploads
`e2e-debug-<PROFILE>`: Maestro's output for each run (`maestro/`: screenshots, the commands with
the UI hierarchy at the failure, its log), each mock start's log, and the device log and activity
stack of each failed flow.

Writing a flow:
- A row of a list may be below the fold on a small screen: `scrollUntilVisible` it before an
  assert or a tap.
- On Android, `hideKeyboard` presses Back. Use it only right after `inputText`, where the keyboard
  is up; otherwise it leaves the screen. To leave a screen whose keyboard may or may not be up,
  repeat `back` while one of its ids is visible.
- A button that waits for a read (Confirm in the review, Modify order) is tapped with
  `enabled: true`.

| Flow | Mock server | What it checks |
|---|---|---|
| `onboarding-live.yaml` | `PORT=5000 WS_PORT=8765` | server, key and live-feed steps; the watchlist shows a price within 10 s |
| `onboarding-polling.yaml` | `PORT=5000 WS_PORT=off` | the feed test fails, the profile saves in polling mode, `badge-polling` shows, and the price updates |
| `trading-analyzer.yaml` | `PORT=5000 WS_PORT=8765`, control `analyzer` | add ITC, a LIMIT buy from its instrument sheet reviewed as ANALYZE, modify, cancel, depth into a ticket, close a position, sell a holding |
| `trading-semiauto.yaml` | `PORT=5000 WS_PORT=8765`, control `semiAuto` | a market buy from the instrument sheet is queued for the web Action Center and the Orders tab shows the Semi-Auto banner |
| `depth-levels.yaml` | `BROKER=dhan PORT=5000 WS_PORT=8765`, control `maxDepth` 20 | the 20-level switch shows `depth-bid-19` |

The job runs the flows for `PROFILE` 2.0.0.0 and 2.0.3.5. The trading flows start with the mock
restarted on `PORT=5000 WS_PORT=8765` and reset (`POST /__mock/reset`) before each flow;
`depth-levels.yaml` needs the mock started with `BROKER=dhan` as well. A flow sets the mock's
controls with `scripts/mock.js` (env `CONTROL`, a JSON patch for `POST /__mock/control`). Run the mock yourself with
`PROFILE=2.0.3.5 npm run mock`, then `maestro test e2e/onboarding-live.yaml` against an emulator
with the release APK installed.

## Test IDs

The flows use the ids marked with *. The rest are listed for writing new flows. `{X}` is a part
that varies: an upper-case instrument id such as `NSE-ITC` (`{ID}`, `{EXCHANGE}`, `{SYMBOL}`), a
product or order type, or a number.

Onboarding
- `server-url` *, `server-using`, `server-continue` *, `http-ack` *
- `key-input` *, `key-show`, `key-error`, `key-continue` *
- `feed-url`, `feed-test` *, `feed-live` *, `feed-broker`, `feed-error`, `feed-help` *,
  `feed-host-cancel`, `feed-host-continue`, `onboarding-save` *
- `update-back`, `start-retry`, `start-forget`

Watchlist
- `watch-row-{ID}` *, `watch-ltp-{ID}` *, `watch-ex-{ID}`, `watch-held-{ID}`, `watch-flash-{ID}`,
  `watch-swipe-{ID}`, `watch-unknown-{ID}`
- `wl-tab-{LISTID}` (not for flows: list ids are lower case; tap a tab by its label), `wl-manage`
- `wl-search-add` *, `wl-count`, `wl-sort`, `wl-sort-{SORT}` (`ADDED`, `AZ`, `CHANGE`, `LTP`,
  `EXCHANGE`), `wl-edit`, `wl-empty-add`
- edit mode: `wl-up-{ID}`, `wl-down-{ID}`, `wl-regroup-{ID}` (once the list has a group),
  `wl-remove-{ID}`, `wl-new-group`, `wl-move-{N}`, `wl-move-none`
- groups: `wl-group-{N}`, and in edit mode `wl-group-up-{N}`, `wl-group-down-{N}`,
  `wl-group-menu-{N}` (a native menu: tap Rename or Delete by its text)
- the manage sheet: `wl-list-{N}`, `wl-list-up-{N}`, `wl-list-down-{N}`, `wl-list-rename-{N}`,
  `wl-list-delete-{N}`, `wl-new`, `wl-manage-done`
- the name sheet: `wl-name-input`, `wl-name-save`, `wl-name-cancel`
- `index-strip`, `index-toggle`, `index-edit`, `index-edit-done`, `index-panel`,
  `index-panel-{ID}`, `index-pick-{ID}`, `index-{ID}`

Search
- `search-input` *, `search-row-{ID}` *, `search-added-{ID}` *, `search-open-{ID}` (add mode),
  `search-chip-{EXCHANGE}`, `search-status`

Instrument sheet
- `instrument-sheet`, `inst-ltp`, `inst-change`, `inst-unknown`, `inst-buy` *, `inst-sell`,
  `inst-watch`, `inst-depth` *, `inst-chart`, `inst-optionchain`

Depth
- `depth-screen`, `depth-ladder`, `depth-levels-{N}` *, `depth-levels-note`, `depth-bid-{N}` *,
  `depth-ask-{N}` *, `depth-buy`, `depth-sell`, `depth-ltp`, `depth-change`, `depth-open`,
  `depth-high`, `depth-low`, `depth-prev-close`, `depth-volume`, `depth-oi`, `depth-total-buy`,
  `depth-total-sell`, `depth-chart`, `depth-footer`, `depth-error`, `depth-unknown`

Order ticket and review
- `ticket-screen`, `ticket-back`, `ticket-ltp`, `ticket-side-buy`, `ticket-side-sell` *,
  `ticket-product-{PRODUCT}` *, `ticket-type-{TYPE}` *, `ticket-qty`, `ticket-qty-units`,
  `ticket-price` *, `ticket-trigger`, `ticket-margin`, `ticket-review` *, `ticket-error`,
  `ticket-refused`, `ticket-split-note`, `ticket-issue-{ISSUE}`
- `ticket-review-step`, `review-mode-badge` *, `review-summary`, `review-split`, `review-notice`,
  `review-wait`, `review-earlier`, `ticket-confirm` *, `split-summary`, `split-child-{N}`
- `order-result` *, `order-result-id`, `order-result-status`, `result-reconcile`, `result-wait`,
  `result-sandbox`, `view-orderbook`, `open-action-center` *, `ticket-done` *

Orders
- `orders-screen`, `orders-list`, `orders-stats`, `orders-cancel-all`, `orders-seg-{SEGMENT}`,
  `order-row-{ID}`, `order-status-{ID}`, `order-side-{ID}`, `order-qty-{ID}`, `order-price-{ID}`,
  `order-time-{ID}`, `trade-row-{ID}`
- `order-modify` *, `order-cancel` *, `order-depth`, `order-chart`, `order-pending`
- `stale-note`, `books-dropped`, `live-surprise`, `live-surprise-dismiss`
- `write-outcome`, `write-outcome-text`, `write-outcome-orderbook`, `write-outcome-dismiss` (the
  last write's line on the Orders and Portfolio tabs)

Modify
- `modify-screen`, `modify-price` *, `modify-trigger`, `modify-qty`, `modify-qty-units`,
  `modify-ltp`, `modify-mode-badge`, `modify-check`, `modify-confirm` *, `modify-done`,
  `modify-wait`, `modify-earlier`, `modify-closing`, `modify-notice`, `modify-error`,
  `modify-refused`, `modify-issue-{ISSUE}`

Portfolio
- `portfolio-screen`, `portfolio-list`, `pf-total-pnl`, `pf-close-all`, `pf-seg-holdings` *, `pf-seg-funds` (and pf-seg-positions, which the tests
  name but src builds from the segment id)
- `pos-row-{ID}`, `pos-qty-{ID}` *, `pos-ltp-{ID}`, `pos-pnl-{ID}`, `pos-close-{ID}` *,
  `pos-chart-{ID}`
- `hold-row-{ID}`, `hold-qty-{ID}`, `hold-avg-{ID}`, `hold-ltp-{ID}`, `hold-pnl-{ID}`,
  `hold-pct-{ID}`, `hold-sell-{ID}` *, `hold-chart-{ID}`, `hold-stats`, `hold-stat-invested`,
  `hold-stat-value`, `hold-stat-pnl`, `hold-stat-pct`
- `funds-view`, `funds-{ID}`, `funds-cash`, `funds-collateral`, `funds-margin-used`,
  `funds-m2m-realised`, `funds-m2m-unrealised`

Status
- `badge-http`, `badge-polling` *, `badge-broker`, `mode-badge`
- `banner-banned`, `banner-key`, `banner-broker`, `banner-polling`, `broker-banner-login`,
  `broker-banner-recheck`
- `banner-semi-auto` *, `banner-semi-auto-blocked`, `blocked-open-action-center`

Lock
- `lock-overlay`, `lock-unlock`, `lock-forget`

Account
- `account-screen`, `account-url`, `account-version`, `account-feed`, `app-version`
- `link-server`, `link-key`, `link-diagnostics`, `link-lost-phone`, `link-backup`
- `server-save`, `key-save`, `broker-status`, `broker-login`
- `analyzer-toggle`, `analyzer-error`, `analyzer-semi-auto`
- `pref-app-lock`, `pref-confirm-live`, `pref-hide-content`, `app-lock-unavailable`,
  `confirm-live-unavailable`, `lock-after-{MS}`, `theme-{MODE}`
- `diagnostics-copy`, `diagnostics-refresh`, `cap-{FEATURE}`, `lost-step-{N}`
- `sign-out`, `sign-out-confirm`, `sign-out-delete`, `signout-backup`
- `backup-screen`, `backup-create`, `backup-found`, `backup-summary`, `backup-note`,
  `backup-error`, `backup-restore`, `restore-merge`, `restore-replace`

Shared
- `skeleton`, `sheet-backdrop`, `toast`

Order confirms are native dialogs, so the flows tap their button by its text (`Cancel order`,
`Close position`). The tab bar has no ids either: tap a tab by its label.
