# M2: Trading Core (Native) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The native trading core on Plan A's foundation, for an unmodified OpenAlgo ≥ 2.0.0.0: watchlists and index strip, search and metadata, quote and depth (20 levels where the broker has them), the order ticket with splits and order safety, the Orders and Portfolio tabs, order events and book polling, broker-logged-out and Semi-Auto handling, and watchlist backup.

**Architecture:**
- **`src/market/`** holds the shared trading logic as pure TypeScript taking `Api`, storage and clocks as parameters, so jest and the compat suite need no native modules; hooks and components sit beside it.
- **Features** import `core`, `market` and `ui`, never each other, and link only through `src/market/links.ts` hrefs.
- **Every call goes through `Api.call`** (A-T8); order writes use the `order` and `smart` lanes.

**Tech Stack:** Plan A's stack, plus expo-sharing, expo-document-picker and expo-file-system (via `npx expo install`), and the spike's react-native-gesture-handler ~3.3.0, @shopify/flash-list 2.3.2 and expo-haptics.

**Spec:** `docs/superpowers/specs/2026-11-23-openalgo-mobile-phase1-design.md`: section 11 (row M2), 7.3, 7.5, 7.6, 7.10 and 7.11.

**Depends on:** `docs/superpowers/plans/2026-11-24-m0-m1-foundation.md` (Plan A), done through its Task 25. "A-T7" means Plan A Task 7; tasks here are T1–T19.

## Global Constraints

- Plan A's Global Constraints all apply, including branch `phase1/foundation`, never push, and the `Co-Authored-By` trailer.
- **Strategy label.** Every order write sends `strategy: 'mobile'` (design 7.10).
- **Order writes** (placeorder, splitorder, placesmartorder, modifyorder, cancelorder, cancelallorder, closeposition) each:
  1. go through review or a confirm; a confirm first runs `gate.read()` (T10), prefixes its title with LIVE or ANALYZE, and passes that value as `shownMode`;
  2. read `/api/v1/analyzer` unless the last reading is under 5 s old;
  3. ask for biometrics when `usePrefs().confirmLiveWrites` is on and the mode is live;
  4. allow one request in flight per action, then a 120 ms cooldown;
  5. are sent exactly once: never retried, never self-healed.
- **`MaybePlaced`** (502 or a timeout on an order lane) shows "Status unknown: checking the order book." (A-T7 copy) and reconciles. It never re-sends.
- **Quote-only exchanges** (`NSE_INDEX`, `BSE_INDEX`, `MCX_INDEX`, `GLOBAL_INDEX`): no B/S, no ladder, no ticket.
- **Unknown keys** (T5's `unknown`, or `instruments.peek` → `'unknown'`) never acquire the feed or register a quotes or depth poll consumer.
- **Colours, haptics, states.** BUY/SELL use `useTheme().trade.buy`/`.sell`, P&L uses `profit`/`loss`; `notifySuccess` on a placed order, `notifyWarning` on an error or MaybePlaced. Loading shows `Skeleton`; read errors show `ErrorState` with retry (design 7.11).
- **Blocked** (`brokerSession === 'logged_out'`, `keyState === 'invalid'` or `banned`): nothing polls a broker-backed endpoint, order buttons are disabled, and screens show cached data with stale styling.
- **Watchlist limits:** 50 lists of 250 items (the server's own, `database/watchlist_db.py:49,52`); names 1–30 characters, the app's own limit (the server allows 64, `blueprints/watchlist.py:39`).
- **Backups** hold user content only: never the key, server URL or profile id.
- **testIDs** named in tasks are the Maestro contract; `e2e/README.md` lists them.
- **Verification** runs from the repo root, with no native builds. "→ FAIL" means the module is missing; "→ PASS" means every test in the command passes.

## Review Focus

1. **Expired or unknown contract in a watchlist** (restored after expiry, or mistyped). `/symbol` answers 404 (A-T7 `Unsupported`); multiquotes returns error entries, or a 400 with `invalid_symbols` when no symbol is valid; `/depth`, `/quotes` and the WS ack fail. Expected: "Expired or unknown" with no B/S, no polling, and at most one `/symbol` call per symbol per trading day, so expired contracts add no steady requests (design 12). Test: T2, T5 **(RF 1)**.
2. **The analyzer mode flips between review and send** (by a strategy or the web). Expected: if the pre-send read (5 s cache) no longer matches the confirmed badge, nothing is sent and the review reopens with the new badge. Test: T10 **(RF 2)**.
3. **A broker listed as emitting order events, but none arrive** (a server older than its adapter, or `ORDER_UPDATES_ENABLED=FALSE`). Expected: if the app's own order gets no `order_update` within 10 s, the books poll at the no-events rate for the session. Test: T11 **(RF 3)**.
4. **One malformed book row** (empty price, `Trigger Pending` casing, a different timestamp format, `"1.0"` quantity, null pnl, missing orderid). Expected: bad fields show `--`; a row without an id is dropped with "1 row could not be read"; the rest renders. Test: T8, T13 **(RF 4)**.
5. **A foreign, hand-edited, oversized or newer backup file.** Expected: refused with one plain sentence, or trimmed to the limits with a note; the current lists stay unchanged until the user confirms. Test: T15 **(RF 5)**.

---

## Trading contract (stock server, openalgo `c8b2896`)

**C1. Instrument metadata.** `symbol {symbol, exchange}` returns `data{symbol, name, exchange, lotsize, tick_size, freeze_qty, instrumenttype, expiry, strike, token}`; an unknown symbol gets 404 `{"status":"error","message":"Symbol X not found in exchange Y"}` (`services/symbol_service.py:42-44,75-77`). Search rows carry the same fields (`services/search_service.py:60-73,105-118`). `freeze_qty` 0 means unknown (`database/qty_freeze_db.py:233,262`); the web ignores values ≤ 1.

**C2. Accepted exchanges** (`utils/constants.py:52-67`); a request outside the set gets a 400. From 2.0.0.0: NSE NFO CDS BSE BFO BCD MCX NCDEX NSE_INDEX BSE_INDEX. 2.0.0.1 adds CRYPTO (landed at tree 2.0.0.0, `dea52011`); 2.0.1.0 adds NCO MCX_INDEX GLOBAL_INDEX (tree 2.0.0.9, `6bc37381`). An unknown version uses the 2.0.0.0 set.

**C3. Order requests** (`restx_api/schemas.py:22-211`). 2.0.0.0 types quantity as `Int`, so quantities are always integers.

| Endpoint | Body besides `apikey` |
|---|---|
| placeorder | strategy, exchange, symbol, action, quantity, pricetype, product, price, trigger_price, disclosed_quantity |
| splitorder | the same plus `splitsize` (int ≥ 1); more than 100 children gets a 400 (`services/split_order_service.py:209-222`) |
| placesmartorder (close one) | strategy, exchange, symbol, product (the row's own), action (the closing side; ignored by the server), quantity `"0"`, position_size `"0"`, pricetype `"MARKET"`, price `"0"`, trigger_price `"0"`, disclosed_quantity `"0"` |
| modifyorder | all 12 required: apikey, orderid, strategy, symbol, action, exchange, pricetype, product, quantity, price, trigger_price, disclosed_quantity (0, as the row has none) |
| cancelorder | orderid, strategy |
| cancelallorder, closeposition | strategy only; any extra field gets a 400 |
| margin | `positions[1..50]{symbol, exchange, action, quantity, product, pricetype, price, trigger_price}`; quantity, price and trigger_price are `fields.Str` (`restx_api/schemas.py:339,344-345`), so a number gets 400 "Not a valid string." |

**C4. Replies.**
```jsonc
{"status":"success","orderid":"250408000989443"}                                   // place, modify, cancel, smart; sandbox adds "mode":"analyze"
{"status":"success","message":"Order queued for approval in Action Center","mode":"semi_auto","pending_order_id":12}
                       // order_router_service.py:137-146: place, smart, split, basket; also in analyzer mode
{"status":"success","total_quantity":105,"split_size":20,"results":[{"order_num":1,"quantity":20,"status":"success","orderid":"…"},
                       {"order_num":6,"quantity":5,"status":"error","message":"…"}]}  // split_order_service.py:406-411
{"status":"success","message":"Canceled 3 orders. Failed to cancel 2 orders.","canceled_orders":["…"],
 "failed_cancellations":["…" , {"orderid":"…","message":"…"}]}                      // cancel_all_order_service.py:166-172
{"status":"success","message":"All Open Positions Squared Off"}                     // or "No open positions to close"; close_position_service.py:181
{"status":"success","message":"Positions Already Matched. No Action needed."}       // flat close, place_smart_order_service.py:227
{"status":"success","message":"No OpenPosition Found. Not placing Exit order."}     // flat close in the sandbox, sandbox_service.py:508
{"status":"success","data":{"total_margin_required":91555.76,"span_margin":0,"exposure_margin":91555.76}}
```
- **Margin:** 501 for 15 brokers (`services/margin_service.py:184-199`).
- **Flat close returns 500** on ibulls, definedge and tradejini (`broker/<b>/api/order_api.py:362-369`, `:383-386`, `:1185-1197`), because the service maps only "No action needed" to 200 (`place_smart_order_service.py:284-304`).

**C5. Semi-Auto 403s** (live mode only; analyzer mode is allowed). Modify: "Modify order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to modify orders." (`services/modify_order_service.py:243`). Cancel, cancel all and close all follow the same pattern (`cancel_order_service.py:247`, `cancel_all_order_service.py:228`, `close_position_service.py:252`). The web Action Center is `<origin>/action-center` (`frontend/src/App.tsx:317`).

**C6. Books** (`openalgo-docs/.../accounts-api/*.md`). Values are often strings.
- **orderbook:** `data{orders[{action, symbol, exchange, orderid, product, quantity, price, pricetype, order_status, trigger_price, timestamp "08-Apr-2025 13:58:03"}], statistics{total_buy_orders, total_sell_orders, total_completed_orders, total_open_orders, total_rejected_orders}}`.
- **tradebook:** `data[{action, symbol, exchange, orderid, product, quantity, average_price, timestamp "13:58:03", trade_value}]`.
- **positionbook:** `data[{symbol, exchange, product, quantity, average_price, ltp, pnl, pnlpercent?, lot_size?, today_realized_pnl?}]`.
- **holdings:** `data{holdings[{symbol, exchange, product, quantity, pnl, pnlpercent, ltp?, average_price?}], statistics{totalholdingvalue, totalinvvalue, totalprofitandloss, totalpnlpercentage}}`.
- **Statuses:** complete, rejected, cancelled, open, pending, trigger pending (`frontend/src/types/trading.ts:24`). **Working** = open, pending or trigger pending. The web allows cancel only on `open` (`pages/OrderBook.tsx:716`); the app also allows it on waiting stop orders.

**C7. Order events by broker** (`services/order_update_service.py`):
- **Push (22, `:36-95`):** aliceblue, angel, arrow, definedge, dhan, flattrade, fyers, groww, iiflcapital, indmoney, kotak, motilal, nubra, nuvama, pocketful, sahi, shoonya, tradejini, tradesmart, upstox, zebu, zerodha.
- **Server-polled every 5 s (2, `:113`):** fivepaisa, samco.
- **None (15):** compositedge, deltaexchange, dhan_sandbox, firstock, fivepaisaxts, hdfcsecurities, hdfcsky, ibulls, iifl, jainamxts, mstock, paytm, rmoney, rupeezy, wisdom.
- **Exceptions:** `ORDER_UPDATES_ENABLED=FALSE` turns events off for the whole install. The sandbox emits events in analyzer mode (`sandbox/order_manager.py:666,736,1187`).

**C8. Depth levels by broker** (`broker/<b>/streaming/<b>_mapping.py`, `get_supported_depth_levels`):
- **5 and 20 on NSE and NFO, 5 elsewhere:** compositedge, fivepaisaxts, ibulls, iifl, jainamxts, rmoney and wisdom (each `<b>_mapping.py:131-138`), and dhan (`dhan_mapping.py:86-96`).
- **Every other broker and exchange: 5 or fewer.** indmoney sends 1 (`indmoney_mapping.py:110-117`); deltaexchange 1 or 5 on CRYPTO (`delta_mapping.py:71-73`). Brokers without the function serve 5: fyers' 50-level feed uses a `:50` symbol suffix, not `depth` (`fyers_websocket_adapter.py:343`), and upstox's 30-level feed is Plus-only and unused (`upstox_adapter.py:189-193`).
- **Angel is 5 only** (`angel_mapping.py:43-50`). **No broker offers 30 today**; the map type still allows 30 for later ref bumps.
- **Rejections:** angel (`angel_adapter.py:360-362`) and compositedge (`compositedge_adapter.py:313-315`) refuse an unsupported depth (`INVALID_DEPTH`): the ack entry is `status:'error'` (`websocket_proxy/server.py:1324-1334`) and no depth ticks come.
- **The ack's `depth` can't be trusted alone:** it is the adapter's `actual_depth`, or else the requested value (`websocket_proxy/server.py:1321`).

**C9. Ticket rules** (`frontend/src/lib/trading/terminal.ts`, `format.ts`; bare `:n` is `terminal.ts`):
- **Derivative exchanges:** NFO BFO CDS BCD MCX NCO NCDEX CRYPTO (`:891`).
- **Products:** MIS/NRML on derivatives, MIS/CNC on the rest; quantity in lots on derivatives (`:897-904`). **Default:** CNC on cash, NRML on derivatives (`PlaceOrderDialog.tsx:199-205`).
- **Quote-only:** the four `*_INDEX` exchanges, tick 0.05 (`:905`, `:920-923`).
- **Tick guard:** a tick ≤ 0 or > 1% of the price becomes 0.05 (`format.ts:11-19`). **Snapping:** `round(price/t)*t` at the tick's decimals (`format.ts:22-42`).
- **Units:** `max(1, floor(lots)) × lotsize`; `lotsize = Number(x) || 1` (`:955-958`, `:7061`). **Freeze limit:** `Number(freeze_qty) || 1`, checked only when > 1 (`:7080`, `:2223`).
- **Stop side:** a BUY stop must be above LTP, a SELL stop below (`:2229-2233`). **Price fields:** MARKET and SL-M carry no price; SL carries price and trigger (`:966-995`). **Positive prices:** LIMIT/SL need price > 0, SL/SL-M trigger > 0 (`sandbox/order_manager.py:1437-1450`).
- **Summary:** `${side} ${type} ${lots}L (${units}) ${symbol} @ ${px} · ${product}` (`:2263-2264`). **Cooldown:** 120 ms (`:948`).

---

## File structure

```
src/market/  types.ts links.ts session.tsx trading.tsx
  instruments/ exchanges.ts tick.ts meta.ts cache.ts useInstrument.ts depthSupport.ts
  watchlists/  model.ts store.ts                       (moved from src/features/watchlist, A-T21)
  orders/      schemas.ts api.ts ticket.ts guard.ts analyzerGate.ts submit.ts reconcile.ts
  books/       schemas.ts queries.ts policy.ts eventWatch.ts livePnl.ts useLiveLtps.ts
  components/  SessionBanners.tsx StaleNote.tsx
src/core/realtime/orderEvents.ts          src/ui/{confirm.ts,Toast.tsx}
src/features/{watchlist,search,instrument,depth,order,orders,portfolio,backup}/
src/app/(app)/ search instrument/[key] depth/[key] order/new order/[id]/modify chart/[key] tools/[toolId] account/backup
dev/mock-server/{instruments,orders}.mjs   test/compat/trading.test.ts   test/helpers/tradingHarness.ts   e2e/trading-*.yaml
```

Tests sit beside each module, as in Plan A.

---

### Task 1: Mock server: instruments, books and the order engine

**Files:**
- Create: `dev/mock-server/{instruments,orders}.mjs` and `orders.test.mjs`, plus `test/fixtures/openalgo-docs/{orderbook,tradebook,positionbook,holdings,symbol-nse,symbol-nfo,splitorder,margin,cancelallorder,closeposition}.json`, each with a `_source`.
- Modify: `dev/mock-server/{rest,state,feed,server,main}.mjs`.

**Interfaces:**
- **Consumes** from A-T5: `startMockServer`, `PROFILES`, the state, and the controls `failNext`, `semiAuto`, `analyzer` and `brokerLoggedOut`.
- **Instruments:** NSE (lot 1, tick 0.05, freeze 0) RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK, SBIN, ITC, M&M, BAJAJ-AUTO; NFO (lot 65, freeze 1800) NIFTY30DEC26FUT (tick 0.1) and NIFTY30DEC2624000CE (tick 0.05); NSE_INDEX NIFTY, BANKNIFTY, INDIAVIX; BSE_INDEX SENSEX. `NIFTY25NOV25FUT` is absent, so `/symbol` returns the C1 404 for it.
- **REST:** symbol, search, every C3 endpoint, and the four books, shaped per C4 and C6 with strings where the docs use them. Search is a prefix match on symbol or name; an exchange outside the profile's C2 set gets a 400. A multiquotes call with no valid symbol gets 400 `{"status":"error","message":…,"invalid_symbols":[{symbol,exchange,error}]}` (`services/quotes_service.py:237-253`); `/quotes` and `/depth` of an unknown symbol get 400 (`services/depth_service.py:35,88`).
- **Engine:** MARKET fills at once at the mock price (trade plus position). LIMIT stays `open` and SL/SL-M `trigger pending` until `fillWorking`. Positions net per (exchange, symbol, product) with an average price, and a closed position stays listed with quantity 0. Holdings are seeded with RELIANCE 10 @ 1300 and TCS 5 @ 3500 (CNC). Analyzer mode adds `mode:"analyze"`; timestamps are IST in the C6 format.
- **Validation as marshmallow does it:** a missing field → 400 `{"status":"error","message":"{'<f>': ['Missing data for required field.']}"}`; an unknown field → the first S7 shape; a margin `price` that isn't a string → 400 `{'price': ['Not a valid string.']}`. **Quantity 1.5:** 2.0.0.0 (`fields.Int`) truncates it to 1 and rejects only the string `'1.5'`; later profiles answer 400 "Fractional quantity (1.5) is not allowed for non-crypto exchanges." (`restx_api/schemas.py:6-19`, from tree 2.0.0.1).
- **Semi-Auto (C4, C5):** place, smart and split are queued, in analyzer mode too. In live mode, modify, cancel, cancel all and close all get the C5 403s.
- **Events:** an `order_update` reaches `subscribe_orders` subscribers on every order change, when the profile has `orderStream` and `orderEvents !== false`.
- **New controls:**
  - `broker`: the ping and WS-auth broker name; default `zerodha`, also env `BROKER`;
  - `orderEvents`: default true;
  - `delayNext {path, ms, afterApply?}`, and `failNext.afterApply`: apply the write, then answer late or with the failure;
  - `flatCloseError`: a smart close on a flat position → 500 `{"status":"error","message":"No position to square off"}`;
  - `splitFailFrom: n`: children n and up get `status:'error'`;
  - `marginUnsupported` → 501; `fillWorking` fills every working order now.

  `GET /__mock/control` stats add `orders` (counts by status) and `lastBody: Record<path, body>`, without the apikey.

- [ ] **Step 1: Failing tests** in `orders.test.mjs`:
  - **Smart close:** long 10 → one SELL 10, then a row with quantity 0; flat → "Positions Already Matched. No Action needed."; flat in analyzer mode → "No OpenPosition Found. Not placing Exit order."; `flatCloseError` → 500.
  - **Split:** 105 by 20 → children 20, 20, 20, 20, 20, 5; 2,001 by 20 → 400; `splitFailFrom 4` → children 4–6 fail, top level `success`.
  - **Modify:** without `disclosed_quantity` → 400 naming it; all 12 fields → success, price changed in the book.
  - **Semi-Auto:** live placeorder → queued with a `pending_order_id`; live cancelorder → the C5 403; in analyzer mode closeposition succeeds and placeorder is still queued.
  - **Failures:** `failNext {path:'placeorder', status:502, afterApply:true}` → 502 with the order in the book; `delayNext 300` delays ≥ 300 ms; quantity 1.5 → 1 unit on 2.0.0.0, 400 on 2.0.3.5; a numeric margin price → 400.
  - **Instruments:** `NIFTY25NOV25FUT` → the exact C1 404, and a multiquotes of it alone → the `invalid_symbols` 400; `search {exchange:'CRYPTO'}` → 400 on 2.0.0.0, 200 `[]` on 2.0.3.5.
  - **Events:** none with `orderEvents:false`, none on profile 2.0.0.0. **Cancel all** with 2 open → `canceled_orders` length 2.
- [ ] **Step 2:** `npm run test:scripts` → FAIL.
- [ ] **Step 3:** Implement. Validation lives in `orders.mjs`; `rest.mjs` only routes.
- [ ] **Step 4:** `npm run test:scripts` → PASS.
- [ ] **Step 5:** Commit `feat(dev): mock order engine, books and trading endpoints`. Every commit adds only its task's files and carries the trailer.

### Task 2: Market layer: types, links, exchanges, ticks, instrument cache

**Files:**
- Create: `src/market/{types,links,trading}.ts(x)`, `src/market/instruments/{exchanges,tick,meta,cache,useInstrument}.ts`, plus tests, and `test/fixtures/boundaries/src/market/uses-feature.ts`.
- Modify:
  - `.dependency-cruiser.cjs`: add rule `market-no-features`, so `src/market` cannot import `src/features` or `src/app`;
  - `scripts/boundaries.test.mjs`: six rules;
  - `src/app/(app)/_layout.tsx`: mount `TradingProvider` inside `ServicesProvider`.

**Interfaces:**
- **Consumes:** `Api` (A-T8); `ApiError`, `SearchSchema`, `envelope` (A-T7); `ProfileStorage` (A-T6); `atLeast` (A-T6); `quoteKey`, `istParts` (A-T13); `Services`, `useServices` (A-T18).
- **types:** `Side = 'BUY'|'SELL'`, `Product = 'MIS'|'CNC'|'NRML'`, `PriceType = 'MARKET'|'LIMIT'|'SL'|'SL-M'`, `TicketParams = { exchange; symbol; action: Side; pricetype?; price?; product?; quantity? /* units */ }`.
- **exchanges** (C2, C9): `QUOTE_ONLY`, `DERIVATIVE_EXCHANGES`, `isQuoteOnly(ex)`, `usesLots(ex)`, `productOptionsFor(ex): Product[]`, `defaultProduct(ex)`, `searchExchanges(version: string | null): string[]`.
- **tick:** `tickSize(t, ref)`, `tickDecimals`, `snapTick(price, t, ref)`, `resolveTick(ex, t)`, `fmtTick(n, t, ref)`: a port of `format.ts:11-42` and `terminal.ts:920-923`, cited in the file header.
- **meta:** `InstrumentMeta = { exchange; symbol; name; lotsize; tick; freezeQty; instrumenttype; expiry: string | null; strike: number | null; quoteOnly; lots }`; `SymbolSchema` (the C1 envelope, coerced); `toMeta(row)`.
- **cache:** `createInstrumentCache({ api, storage, now })` → `{ get(ex, sym): Promise<InstrumentMeta | 'unknown'>; peek(ex, sym): InstrumentMeta | 'unknown' | undefined; putMany(rows) }`.
  - Stored as `instruments` = `{ day, items, unknown: string[] }`; `day` is the IST date, a new day clears it, and at most 2,000 items are kept, oldest dropped first.
  - `isSymbolNotFound(e)`: status 404 and a message matching `/not found in exchange/i`.
- **useInstrument(ex, sym)** → `{ meta?; unknown: boolean; loading }`, under `qk.symbol(pid, ex, sym)`.
- **links** (pure): `instrumentHref(ex, sym)`, `depthHref`, `chartHref`, `searchHref({ addTo? })`, `ticketHref(p)`. The key segment is `encodeURIComponent(\`${ex}:${sym}\`)`; `parseKey(param)` splits at the first `:`; `parseTicketParams(raw): TicketParams | null`.
- **trading:** `Trading = { instruments }` (later tasks add fields), `createTrading(s, { now })`, `TradingProvider`, `useTrading()`.

- [ ] **Step 1: Failing tests.**
```ts
resolveTick('NSE_INDEX', 0.0005) === 0.05; resolveTick('CDS', 0.0025) === 0.0025; tickSize(1, 23) === 0.05
snapTick(1424.03, 0.05, 1424) === 1424.05; snapTick(24117.27, 0.1, 24117) === 24117.3; snapTick(83.1234, 0.0025, 83) === 83.1225
productOptionsFor('MCX') → ['MIS','NRML']; productOptionsFor('NSE') → ['MIS','CNC']; defaultProduct('NFO') === 'NRML'; defaultProduct('NSE') === 'CNC'
```
  - **Search exchanges:** `'2.0.0.0'` has neither CRYPTO nor NCO; `'2.0.0.1'` adds CRYPTO; `'2.0.1.0'` adds NCO, MCX_INDEX, GLOBAL_INDEX; `null` = the 2.0.0.0 set.
  - **toMeta:** lotsize `''` → 1; freeze_qty `null` → 0; NSE_INDEX → `quoteOnly`.
  - **Links:** keys round-trip for `M&M`, `BAJAJ-AUTO` and `NIFTY30DEC2624000CE`; `parseTicketParams` returns null for action `HOLD`, a negative price or an unknown exchange (a quote-only exchange parses, and `validateTicket` refuses it).
  - **Cache:** a second `get` the same day makes no call; the next IST day refetches; rows given to `putMany` skip `/symbol`.
  - **(RF 1)** `NIFTY25NOV25FUT` → `'unknown'`; five more `get`s that day make no call; the next day makes exactly one.
  - **Boundaries:** depcruise names all six rules, including `market-no-features`.
- [ ] **Step 2:** `npx jest src/market && node --test scripts/boundaries.test.mjs` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same, then `npm run boundaries` → PASS.
- [ ] **Step 5:** Commit `feat(market): instrument metadata cache, ticks, exchanges and route links`.

### Task 3: Watchlists store (move and extend A-T21)

**Files:**
- Move with `git mv`: `src/features/watchlist/{model,store}.ts` to `src/market/watchlists/`, updating imports.
- Tests: `model.test.ts`, `store.test.ts`. Modify `src/market/trading.tsx`.

**Interfaces:**
- `WatchlistsSchema` stays at version 1 and gains `activeId: z.string().optional()`, so no version bump. Types `Watchlists`, `WatchItem = { exchange; symbol }`; `WATCHLIST_LIMITS = { lists: 50, items: 250, nameMax: 30 }`.
- **Pure reducers**, each returning `{ next, result }`: `createList(w, name, id)` → `'ok'|'limit'|'bad_name'`; `renameList`; `deleteList` → `'ok'|'last_list'`; `addItem(w, listId, item)` → `'added'|'duplicate'|'full'`; `removeItem`; `moveItem(w, listId, from, to)`; `setActive`.
- **Store:** `createWatchlistsStore(storage)`, a zustand vanilla store `{ data; load(); apply(reducer, …args) }` that saves after each change. `loadWatchlists`/`saveWatchlists` keep their A-T21 signatures. `Trading` gains `watchlists`; `useWatchlists(selector)` reads it.

- [ ] **Step 1: Failing tests.**
  - Names are trimmed; `''` and 31 characters → `bad_name`. The 51st list → `limit`; the 251st item → `full`; a duplicate → `duplicate`.
  - Deleting the last list → `last_list`; deleting the active list makes the first one active. `moveItem(0 → 2)` reorders.
  - An A-T21 document without `activeId` loads with the first list active; save then load round-trips.
- [ ] **Step 2:** `npx jest src/market/watchlists` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx jest src/market/watchlists src/features/watchlist && npm run boundaries` → PASS.
- [ ] **Step 5:** Commit `refactor(watchlist): shared watchlists store with list management`.

### Task 4: Search modal

**Files:**
- Create: `src/features/search/{api.ts, components/ResultRow.tsx, screens/SearchScreen.tsx}`, `src/ui/Toast.tsx` and `src/app/(app)/search.tsx`.
- Modify `src/app/(app)/_layout.tsx`: mount `ToastHost` and declare every new route once: `search` as `presentation:'modal'`; `instrument/[key]` as `formSheet` with detents `[0.5]`; `order/new` and `order/[id]/modify` as `formSheet` with `[0.92]`; the rest pushed.

**Interfaces:**
- `normalizeQuery(raw)`: trim, collapse spaces, uppercase, cut to 40 characters.
- **`useSymbolSearch(q, ex?)`:** only for 2+ characters, debounced 300 ms; `qk.search(pid, q, ex)`, `staleTime` 60_000, `keepPreviousData`; rows go to `instruments.putMany`; the first 100 are shown.
- `toast(text)` and `ToastHost`: one line for 2 s.
- **Screen** (param `addTo?`):
  - `search-input` (autofocus); chips `search-chip-{EX}` over `['ALL', …searchExchanges(caps.get().version)]`.
  - Rows `search-row-{EX}-{SYM}`: symbol, name, exchange, expiry and strike, and a "Quote only" badge on quote-only exchanges.
  - **Add mode:** a tap toggles the row in the list, toasting "Added ITC to {list}", "Already in this list" or "This list is full (250)". **Browse mode:** `router.replace(instrumentHref)`.
  - **States:** "Type at least 2 letters"; "No matching symbols"; `ErrorState` with retry.

- [ ] **Step 1: Failing tests.**
  - Typing `r`, `re`, `rel` within 300 ms sends one search, query `REL`. A one-character query makes no call.
  - Chip NFO sends `exchange:'NFO'`; ALL omits it. Caps at 2.0.0.0 → no CRYPTO chip.
  - Add mode adds the symbol and shows ✓. NIFTY shows "Quote only".
- [ ] **Step 2:** `npx jest src/features/search src/ui/Toast` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(search): symbol search modal with exchange chips and add-to-list`.

### Task 5: Watchlist screen (upgrade A-T21) and session banners

**Files:**
- Create: `src/market/session.tsx`, `src/market/components/{SessionBanners,StaleNote}.tsx`, `src/ui/confirm.ts`, and `src/features/watchlist/components/{ListTabs,EditControls}.tsx`.
- Modify: `src/features/watchlist/{api.ts, components/WatchRow.tsx, screens/WatchlistScreen.tsx}` and `src/core/http/errors.ts`.

**Interfaces:**
- **Session (`session.tsx`):**
  - `useBrokerBlocked(): boolean`;
  - `useBroker(): string | null`: the WS auth broker (`FeedStatus.broker`, design 7.6), else `useConnection().broker` from ping;
  - `openServerPage(origin, path: '/login'|'/action-center'|'/apikey')`, via `Linking.openURL`.
- **`useSeedQuotes(items)`** (A-T21) now also returns `unknown: Set<string>`: the keys whose multiquotes entry carried `error`, plus the `invalid_symbols` of a seed 400 `Validation`. For this, A-T7's `ApiError` gains `invalidSymbols?: {exchange; symbol}[]`, parsed from a 400 body as `unknownFields` is.
- **Banners:**
  - **`BrokerBanner()`**, when `brokerSession === 'logged_out'`: the A-T7 BrokerLoggedOut copy, with `broker-login` (opens `/login`) and `broker-recheck` (`services.broker.check()`).
  - **`SemiAutoBanner()`**, when `semiAutoSeen`: "Orders need approval in the web Action Center", with `open-action-center`.
  - **`StaleNote({ at })`**: "Last updated 14:32:05" (IST).
- **`confirm(title, body, ok, { destructive? }): Promise<boolean>`** wraps `Alert.alert`.
- **Screen:**
  - **List tabs** `wl-tab-{id}`: `wl-new` asks for a name; a long press offers Rename and Delete, which confirms "Delete {name} and its {n} symbols?".
  - **Header:** `wl-add` opens `searchHref({ addTo })`; `wl-edit` toggles edit mode, where rows show `wl-up-…`, `wl-down-…` and `wl-remove-…`.
  - **Body:** `BrokerBanner`, then a FlashList of `WatchRow`; an empty list shows "This list is empty" with "Add symbols".
- **WatchRow additions:**
  - **B/S:** `watch-buy-{EX}-{SYM}` and `watch-sell-{EX}-{SYM}` open `ticketHref`; hidden for quote-only and unknown symbols. A row press opens `instrumentHref`.
  - **Removing:** a left swipe (`ReanimatedSwipeable`) and the accessibility action `remove` both confirm "Remove {SYM} from {list}?".
  - **Unknown symbols:** a key in `unknown`, or one `instruments.peek` already marks unknown, shows a Badge "Expired or unknown". Rows never fetch `/symbol` (A-T23's live-watchlist budget); only opening a ticket does.
  - **No seeding while blocked:** `useSeedQuotes` is skipped while `useBrokerBlocked()`.

- [ ] **Step 1: Failing tests.**
  - **B/S:** B on RELIANCE pushes the `ticketHref` for BUY; NIFTY has no B/S.
  - **Editing:** the `remove` action confirms, removes and saves; edit-mode up and down reorder and save; a new list appears and becomes active; deleting the last list shows "Keep at least one list."
  - **Logged out:** `BrokerBanner` shows, and `broker-login` calls `Linking.openURL('{origin}/login')`.
  - **Unknown symbol:** a multiquotes `error` entry → "Expired or unknown", with no B/S and no `/symbol` call.
  - **(RF 1) Only expired:** a list holding only NIFTY25NOV25FUT → a seed 400; the row shows "Expired or unknown", and there are 0 further `multiquotes` calls in 10 s.
  - **Blocked:** focusing makes zero multiquotes calls.
- [ ] **Step 2:** `npx jest src/features/watchlist src/market/components src/market/session src/core/http/errors` → FAIL.
- [ ] **Step 3: Implement.** Use `react-native-gesture-handler/ReanimatedSwipeable`.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(watchlist): named lists, add via search, reorder, swipe-delete, B/S and broker banner`.

### Task 6: Instrument sheet, placeholders and index strip

**Files:** create `src/features/instrument/screens/InstrumentSheet.tsx`, `src/features/watchlist/{indexStrip.ts, components/IndexStrip.tsx}`, `src/market/books/queries.ts` (`useFunds` only) and the routes `src/app/(app)/{instrument/[key],chart/[key],tools/[toolId]}.tsx`. Modify `WatchlistScreen.tsx` to mount `IndexStrip`.

**Interfaces:**
- **Sheet:** a header with symbol, name, exchange, LTP and change (`useLiveQuote(ex, sym, 2)`). Buttons:
  - `inst-buy` and `inst-sell` (not on quote-only exchanges); `inst-chart` → `chartHref`; `inst-depth` → `depthHref`;
  - `inst-optionchain` → `/tools/optionchain?u={key}`, shown unless the exchange is CDS, BCD, CRYPTO, GLOBAL_INDEX, MCX_INDEX or NCDEX (M4 replaces this with a symbol-master check);
  - `inst-watch` adds to or removes from the active list.
- **Placeholders:** `chart/[key]` renders `NotYetAvailable({ what: 'Charts' })`; `tools/[toolId]` renders `NotYetAvailable({ what: toolId === 'optionchain' ? 'Option chains' : 'Tools' })`.
- **Index strip:**
  - choices NSE_INDEX NIFTY, NSE_INDEX BANKNIFTY, BSE_INDEX SENSEX, NSE_INDEX INDIAVIX; 1–4 selected, kept in profile storage as `indexStrip`, default `['NSE_INDEX:NIFTY','BSE_INDEX:SENSEX']`; `index-edit` picks them;
  - chips `index-{SYM}` show LTP and change (`useLiveQuote(…, 2)`);
  - a tap opens `index-panel`: that index's O/H/L/prev close, and funds "Available" (`availablecash`) and "Used margin" (`utiliseddebits`).
- **`useFunds({ enabled })`:** `qk.funds(pid)`, only while the panel is open and nothing is blocked.

- [ ] **Step 1: Failing tests.**
  - **Strip:** default chips NIFTY and SENSEX; adding INDIAVIX persists; the last chip can't be removed; funds load only after expanding, and the panel shows `320.66` from the docs fixture.
  - **Sheet:** NIFTY has Chart and Depth but no BUY/SELL; RELIANCE BUY routes to `ticketHref` BUY; the chart route shows "Charts aren't in this build yet. They arrive in the next update."
- [ ] **Step 2:** `npx jest src/features/instrument src/features/watchlist` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(instrument): instrument sheet, chart and option-chain placeholders, index strip`.

### Task 7: Quote and market depth

**Files:** create `src/market/instruments/depthSupport.ts`, `src/features/depth/{model.ts, components/Ladder.tsx, screens/DepthScreen.tsx}` and the route `src/app/(app)/depth/[key].tsx`.

**Interfaces:**
- **Consumes:** `useLiveDepth(ex, sym, levels)` → `{ buy, sell, levels, confirmedDepth?, source }`, `useLiveQuote`, `DepthLevels` (A-T13, A-T16); `useBroker()` (T5); `Realtime.isLive`.
- **Depth map:** `BROKER_DEPTH: Record<string, Partial<Record<string, readonly DepthLevels[]>>>` holds C8 with a `file:line` comment per entry; `supportedDepth(broker | null, ex): DepthLevels[]` defaults to `[5]`.
- **`depthChoices({ map?, broker, exchange, live, downgraded: ReadonlySet<string> })`** → `[5]` unless the feed is live, the map offers more than 5, and the key isn't downgraded.
- **`confirmLevels({ requested, ackDepth?, ackError?: boolean, tickLevelCounts: number[] })`** → `{ downgraded }`. For a request above 5, it downgrades on an error ack entry (a C8 rejection, which A-T14 B6 marks not wired), on `ackDepth < requested`, or when the first 2 depth ticks carry 5 levels or fewer. The downgrade is kept per `broker:exchange` for the session; after any downgrade the screen switches to `useLiveDepth(ex, sym, 5)`.
- **`ladderRows(depth, n)`** → `{ bids; asks }` of `{ price; quantity; orders?; share }`, `share` being the quantity over the side's largest. **`levelTicket(side, price, ex, sym)`:** bid → SELL LIMIT at that price; ask → BUY LIMIT.
- **Screen:**
  - Header `depth-ltp`, change, O/H/L/prev close and volume, plus OI when `usesLots(ex)`.
  - `depth-levels-{n}`, only with more than one choice; a downgrade hides it with "This broker sends 5 levels here."
  - Rows `depth-bid-{i}`/`depth-ask-{i}` (price, quantity, orders, bar); totals `depth-total-buy`/`-sell` from `totalBuyQty`/`totalSellQty`; `depth-buy`/`depth-sell` open a MARKET ticket; `depth-chart` opens `chartHref` (the T6 placeholder until M3).
  - Not live: "Deeper levels need the live feed"; A-T16 polls `/depth` at 2 s home, 5 s tunnel. Quote-only: the header only, via `useLiveQuote(…, 2)`. `BrokerBanner`, and `StaleNote` while stale.

- [ ] **Step 1: Failing tests.**
  - **Map:** `supportedDepth('dhan','NSE')` → `[5,20]`; `('dhan','BSE')`, `('angel','NSE')`, `('zerodha','NFO')` and `(null,'NSE')` → `[5]`.
  - **Choices:** a test map `{x:{NSE:[5,20,30]}}` gives 5, 20 and 30 when live, `[5]` when not.
  - **Downgrade:** an ack depth of 5 for a request of 20 downgrades; two 5-level ticks downgrade; 20-level ticks do not. An error ack for depth 20 shows "This broker sends 5 levels here.", then `acquire({mode:3, depth:5})`, and 5 rows render.
  - **Screen:** dhan NSE live shows the switch; choosing 20 calls `realtime.acquire({mode:3, depth:20})` and renders 20 rows; a downgrade, or polling, hides the switch and shows its note.
  - **Level taps:** `depth-bid-0` at 1423.9 → `ticketHref({action:'SELL', pricetype:'LIMIT', price:1423.9})`; an ask → BUY.
  - **Index:** NIFTY has no ladder and no BUY/SELL, and acquires mode 2. **Chart:** `depth-chart` (on NIFTY too) pushes `chartHref`.
- [ ] **Step 2:** `npx jest src/market/instruments/depthSupport src/features/depth` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(depth): quote and depth ladder with broker-aware 20/30 levels and tap-to-limit`.

### Task 8: Trading schemas and order API

**Files:** `src/market/books/schemas.ts` and `src/market/orders/{schemas,api}.ts`, with tests that use the T1 docs fixtures.

**Interfaces:**
- **Coercion:** the A-T7 coercers; `dmyHms` gives `placedAt` (IST). **`lenientRows(row)`** parses an array row by row → `{ rows; dropped }`.
- **Book schemas:**
  - `OrderRow = { orderid: string; symbol; exchange; action: Side; product; pricetype; quantity; price?; trigger_price?; status; timestamp; placedAt: number | null }`, status lowercased and trimmed; a numeric `orderid` becomes a string, since modify and cancel take `fields.Str` (`restx_api/schemas.py:92,121`).
  - `TradeRow = { orderid: string; symbol; exchange; action; product; quantity; average_price?; trade_value?; timestamp }`; `PositionRow = { symbol; exchange; product; quantity; average_price?; ltp?; pnl?; pnlpercent?; lot_size?; today_realized_pnl? }`; `HoldingRow = { symbol; exchange; product; quantity; pnl?; pnlpercent?; ltp?; average_price? }`.
  - Required: orderid, symbol, exchange, action on orders and trades; symbol, exchange, product on positions and holdings.
  - `OrderbookSchema` → `{ orders, stats, dropped }` (missing `orders` → `[]`); `TradebookSchema`, `PositionbookSchema`, `HoldingsSchema` → `{ rows, stats, dropped }`; `WORKING`, `isWorking(row)`.
- **Reply schemas:**
  - `PlaceReplySchema` → `{kind:'placed'; orderid; analyze}` | `{kind:'queued'; pendingId}` | `{kind:'no_id'}`;
  - `SplitReplySchema` → `{kind:'split'; total; size; children: {n; qty; ok; orderid?; message?}[]; analyze}` | `queued`;
  - `SmartReplySchema` → `placed` | `queued` | `{kind:'flat'; message}` (message matching `/Already Matched|No OpenPosition/i`);
  - `CancelAllReplySchema` → `{ canceled: string[]; failed: {orderid; message?}[] }`; `CloseAllReplySchema` → `{ message }`; `MarginSchema` → `{ total }`; `IdReplySchema` → `{ orderid; analyze }`.
- **Requests:** `OrderSpec = { exchange; symbol; action; quantity /* units, integer */; pricetype; product; price; trigger_price }`. Pure C3 builders, each with exactly its row's keys (`strategy:'mobile'` on every write, `disclosed_quantity: 0` where the row has it): `placeBody(o)`, `splitBody(o, size)`, `smartCloseBody(row)`, `modifyBody(row, change)`, `cancelBody(id)`, `cancelAllBody()`, `closeAllBody()`, `marginBody(o)`.
- **`createOrderApi(api)`** → `{ place, split, smartClose, modify, cancel, cancelAll, closeAll, margin, orderbook, tradebook, positionbook, holdings }`, each one `api.call` with its schema; `export type OrderApi = ReturnType<typeof createOrderApi>`.

- [ ] **Step 1: Failing tests.**
  - **Fixtures:** every docs fixture parses (4 books, 3 cancel-all variants, split, margin, closeposition).
  - **Replies:** semi_auto → `queued` with `pendingId` `'12'`; success without an orderid → `no_id`; `mode:'analyze'` → `analyze: true`.
  - **Smart close body** for `{symbol:'NHPC', exchange:'NSE', product:'MIS', quantity:-1}` deep-equals the C3 row with `strategy:'mobile'`, `action:'BUY'` and `product:'MIS'`.
  - **Modify body:** exactly the 11 C3 keys besides apikey; a price-only change copies every other field from the row.
  - **Bulk bodies:** `cancelAllBody()` and `closeAllBody()` have exactly the keys `['strategy']`.
  - **Price fields:** MARKET sends price 0 and trigger 0; SL-M price 0 with a trigger; SL both.
  - **Margin body:** `marginBody({…price:24117.3, trigger_price:0, quantity:130})` deep-equals `{positions:[{…, quantity:'130', price:'24117.3', trigger_price:'0'}]}`.
  - **(RF 4)** An orderbook with `{price:'', order_status:' Trigger Pending', timestamp:'2025-04-08 13:58:03', quantity:'1.0'}` and a row without an orderid → one row kept (`price` undefined, status `'trigger pending'`, `isWorking` true, `placedAt` null, quantity 1) and `dropped` 1. A positionbook row with `pnl: null` is kept with `pnl` undefined.
- [ ] **Step 2:** `npx jest src/market/orders/schemas src/market/orders/api src/market/books/schemas` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(market): order request builders, reply and book schemas`.

### Task 9: Ticket model and validation

**Files:** `src/market/orders/ticket.ts`, plus its test.

**Interfaces:**
- **`TicketState = { exchange; symbol; action; product; pricetype; qty /* lots on derivatives, else units */; price?; trigger? }`.**
- **`initialTicket(p, meta)`:** product = `p.product` if `productOptionsFor` allows it, else `defaultProduct`; type = `p.pricetype ?? 'MARKET'`; qty = `max(1, round(p.quantity / lotsize))` lots on derivatives, else `p.quantity ?? 1`; the price is snapped to the tick. **`ticketUnits(t, meta)`.**
- **`TicketIssue`** = `'quote_only'|'unknown_instrument'|'qty'|'price_required'|'trigger_required'|'stop_side'|'product'|'split_too_large'|'split_unavailable'`; **`validateTicket(t, meta | 'unknown', ltp?, { splitAvailable }): TicketIssue[]`**.
- **`planOrder(t, meta)`** → `{ kind:'single'; spec }` | `{ kind:'split'; spec; splitsize; children: number[] }`. It splits when `freezeQty > 1 && units > freezeQty`, with `splitsize = max(lotsize, floor(freezeQty / lotsize) * lotsize)`.
- **`ticketSummary(t, meta)`** uses the C9 format.
- **`issueText(issue, ctx)`** gives this exact copy:
  - quote_only: "Indices can't be traded. Open the futures or options contract instead."
  - unknown_instrument: "This symbol isn't on the server's list (expired or misspelt)."
  - qty: "Enter a quantity of at least 1."; price_required: "Enter a price above 0."; trigger_required: "Enter a trigger price above 0."
  - stop_side: "BUY stop must be above LTP {ltp}." / "SELL stop must be below LTP {ltp}."
  - product: "{product} isn't available on {exchange}."
  - split_too_large: "This needs {n} orders; OpenAlgo splits into 100 at most. Reduce the quantity."
  - split_unavailable: "Above the freeze limit of {freeze}. Reduce the quantity."

- [ ] **Step 1: Failing tests.** Fixtures: NIFTY30DEC26FUT (lot 65, tick 0.1, freeze 1800) and RELIANCE (lot 1, freeze 0).
  - **Splits:** 2 lots → 130 units, single; 28 lots → 1,820 units, `splitsize` 1755, children `[1755, 65]`; 2,700 lots → exactly 100 children, allowed; 2,701 lots → `split_too_large` with n = 101; RELIANCE with freeze 0 or 1 never splits; no split endpoint → `split_unavailable`.
  - **Stops:** BUY SL trigger 1420 with LTP 1424 → `stop_side`; trigger 1425 → ok; LTP unknown → no `stop_side`.
  - **Prices:** LIMIT price 0 → `price_required`; SL-M without a trigger → `trigger_required`; MARKET ignores the price.
  - **Instrument and product:** NSE_INDEX → `quote_only`; NRML on NSE → `product`.
  - **Initial tickets:** the holdings Sell preset (SELL, CNC, MARKET, quantity 10) → qty 10, CNC; a bid price of 1423.93 → 1423.95; a derivative with quantity 130 → 2 lots.
  - **Summaries:** `'BUY LIMIT 2L (130) NIFTY30DEC26FUT @ 24,117.30 · NRML'` and `'SELL MARKET 10 RELIANCE · CNC'`.
- [ ] **Step 2:** `npx jest src/market/orders/ticket` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(market): order ticket rules from the web terminal, with freeze splits`.

### Task 10: Order safety: guard, analyzer gate, submit, reconcile

**Files:** `src/market/orders/{guard,analyzerGate,submit,reconcile}.ts` plus tests. Modify `src/market/trading.tsx` to add `orders: OrderApi` and `analyzer: AnalyzerGate`.

**Interfaces:**
- **Consumes:** `AnalyzerSchema` (A-T7); `useConnection` and `markSemiAuto` (A-T11); `confirmLiveWrite` and `expoAuthenticate` (A-T10); `usePrefs` (A-T6); `books.poke` (A-T12).
- **`createSubmitGuard({ now, cooldownMs = 120 })`** → `{ run<T>(fn): Promise<T | 'busy'>; busy(); subscribe(cb) }`: busy while in flight and for 120 ms after it settles. `useSubmitGuard()` gives one per component.
- **`createAnalyzerGate({ api, now, ttlMs = 5000, onMode })`** → `{ read(): Promise<'live'|'analyze'>; peek(); noteReply(json) }`; `onMode` writes `useConnection.analyzer`. `noteReply`: a reply with `mode:'analyze'` sets the cache to `analyze` at `now()`. `export type AnalyzerGate = ReturnType<typeof createAnalyzerGate>`.
- **`ActionKind`** = `'place'|'split'|'modify'|'cancel'|'cancelAll'|'closeOne'|'closeAll'`. **`Outcome<R>`** = `{kind:'done'; reply: R}` | `{kind:'mode_changed'; now}` | `{kind:'cancelled'}` | `{kind:'maybe'}` | `{kind:'semi_auto_blocked'; message}` | `{kind:'error'; error: ApiError}`.
- **`submitOrderAction({ kind, shownMode, send, gate, confirmLive, books, onSemiAuto }): Promise<Outcome>`**, in order:
  1. `gate.read()`. A failed read → `error`, nothing sent. A mode other than `shownMode` → `mode_changed`, nothing sent.
  2. In live mode, `confirmLive()`; false → `cancelled`.
  3. `send()`, exactly once; then `books.poke()` after any reply or error.
  4. MaybePlaced → `maybe`. SemiAutoBlocked → `semi_auto_blocked` and `onSemiAuto`, as a queued reply also calls.
- **Reconcile:** `reconcilePlacement({ fetchOrders, spec, sentAt, knownIds, sleep, delaysMs = [2000, 5000, 10000] })` → `{ found: OrderRow | null }`, where `knownIds` are the ids in the orderbook cache at submit time; `reconcileSplit({ fetchOrders, spec, children, sentAt, knownIds, sleep, delaysMs })` → `{ found: OrderRow[] }`: the same rule, but `r.quantity` must be in `children`, and it stops at `children.length` candidates; `reconcileClose({ fetchPositions, row })` → `'closed'|'open'|'unknown'`; `reconcileRow({ fetchOrders, orderid })` → `OrderRow | null`. The placement match rule:
```
candidate(r) = r.symbol==spec.symbol && r.exchange==spec.exchange && r.action==spec.action && r.product==spec.product
            && r.quantity==spec.quantity && !knownIds.has(r.orderid) && (r.placedAt==null || r.placedAt >= sentAt-120_000)
after each delay: fetch once; if any candidate, return the newest (placedAt desc, else last in list); else continue; finally null
```

- [ ] **Step 1: Failing tests.**
  - **Guard:** two `run`s in the same tick → the second returns `'busy'` and `fn` runs once; still busy 119 ms after settling, free at 120 ms.
  - **Gate:** two reads within 5 s → 1 call; a read at 5,001 ms → a second call; after `noteReply({mode:'analyze'})` a read gives `analyze` with no call.
  - **(RF 2)** `shownMode` `'analyze'` with the gate reading `'live'` → `mode_changed`; `send` is never called. An analyzer read that fails with `Network` → `error`, not sent.
  - **Live confirm:** `confirmLive` false in live mode → `cancelled`, not sent; in analyzer mode `confirmLive` is never called.
  - **Failures:** MaybePlaced → `maybe`, `send` called once, `books.poke` called; SemiAutoBlocked carries the server message; a queued reply calls `onSemiAuto`.
  - **Reconcile:** appears on the 2nd fetch → found after 2 fetches; never appears → null after 3; an identical order in `knownIds` is not matched; `TZ=America/New_York` gives the same match. **Split:** children `[1755, 65]` in the book → `reconcileSplit` finds 2, and a 1,820 row is not matched.
  - **Close check:** qty 0 → `closed`; row gone → `closed`; qty -1 → `open`.
- [ ] **Step 2:** `npx jest src/market/orders/guard src/market/orders/analyzerGate src/market/orders/submit src/market/orders/reconcile` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(market): order safety: single flight, analyzer gate, live confirm, reconcile`.

### Task 11: Order events and book refresh

**Files:** create `src/core/realtime/orderEvents.ts` and `src/market/books/{policy,eventWatch}.ts`, plus tests. Modify `src/core/services/services.tsx` (`Services` gains `orderEvents`; `onOrderUpdate` becomes `u => { books.poke(); orderEvents.emit(u) }`), `src/market/books/queries.ts`, and `src/market/trading.tsx` (adds `eventWatch`).

**Interfaces:**
- **Event bus:** over `OrderUpdate` (A-T13), `createOrderEventBus()` → `{ emit(u); subscribe(fn): () => void }`.
- **policy:** `ORDER_EVENT_BROKERS` (the 24 C7 push and server-polled names), `NO_ORDER_EVENT_BROKERS` (15), `hasOrderEvents(broker)`; an unknown broker counts as having none.
- **`isEvented({ streamLive, broker, analyzer, demoted }): boolean`** and **`bookPollMs({ streamLive, broker, analyzer, anyWorking, marketOpen, demoted })`**, where `streamLive` = realtime state `'live'` and `caps.ws.orderStream === true`, and `broker` comes from `useBroker()` (T5):
```
isEvented(…) = streamLive && !demoted && (hasOrderEvents(broker) || analyzer === 'analyze')
base         = isEvented(…) ? 30_000 : anyWorking ? 5_000 : 30_000
return marketOpen ? base : base * 5
```
- **`createEventWatch({ now, setTimer, timeoutMs = 10_000 })`** returns `{ expect(orderid); seen(orderid); demoted(); reset() }`. The ticket calls `expect` after a `placed` outcome when `isEvented`, and the bus feeds `seen`.
- **queries:** `useOrderbook`, `useTradebook`, `usePositionbook` and `useHoldings`, each `enabled: !useBrokerBlocked()`; `useFunds({ enabled })` keeps T6's signature and is also off while blocked.
- **`useBookPolling(active)`** registers a `custom` PollConsumer: `intervalMs = bookPollMs(…)`, `run = books.poke`. It is active only while a book screen is focused (`useScreenActive`) and nothing is blocked.

- [ ] **Step 1: Failing tests.**
  - **Lists:** 22 + 2 + 15 = 39 distinct names, with no overlap.
  - **`bookPollMs`:** zerodha, stream live, idle → 30000; ibulls working → 5000, idle → 30000; zerodha with `orderStream` false, working → 5000; ibulls, analyzer, stream live → 30000; polling mode, working → 5000; `newbroker`, working → 5000; market closed → ×5.

  - **(RF 3)** With zerodha and the stream live, `expect('A1')` and no event for 10 s → `demoted`, and a working book polls at 5000. An event at 3 s → not demoted.
  - **Services:** three identical `order_update` frames on the `FakeSocket` give one bus emit and one invalidation 500 ms later (A-T15 dedupe plus A-T12 debounce).
  - **Blocked:** a `logged_out` session → `useOrderbook` makes no call on focus, and polling makes 0 calls in 60 s.
- [ ] **Step 2:** `npx jest src/core/realtime/orderEvents src/core/services src/market/books` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same, then `npm run boundaries` → PASS.
- [ ] **Step 5:** Commit `feat(core): order event bus and broker-aware book refresh with self-demotion`.

### Task 12: Order ticket screen

**Files:** `src/features/order/{hooks/useMarginPreview.ts, components/{TicketForm,ReviewStep,ResultView,SplitResult}.tsx, screens/TicketScreen.tsx}` and the route `src/app/(app)/order/new.tsx`. `Trading` gains `flags: { marginOff: boolean }`.

**Interfaces:**
- **Consumes:** T2, T8, T9, T10 and T11, plus `useLiveQuote` (A-T16), `hasEndpoint` (A-T9) and `ENDPOINTS.splitorder.timeoutMs` (45 s, A-T7).
- **`useMarginPreview(spec | null)`:** debounced 600 ms; runs when `hasEndpoint(caps,'margin')`, `!flags.marginOff` and nothing is blocked. `Unsupported` sets `marginOff` and hides the line; other errors hide it quietly.
- **Steps:** `'edit' → 'review' → 'sending' → 'result'`.
  - **Edit:** `ticket-side-buy`/`-sell`, `ticket-product-{P}`, `ticket-type-{T}`; `ticket-qty` (with "{lots} × {lotsize} = {units}" on derivatives); `ticket-price` and `ticket-trigger`, snapped on blur; the LTP; `ticket-margin` "Margin ≈ ₹{x}"; issue texts and the split note "Sent as {n} orders (freeze limit {freeze})". `ticket-review` is disabled while there are issues or while blocked.
  - **Review:** opening it runs a fresh `gate.read()`. It shows the summary, the split breakdown "1,755 + 65" and `review-mode-badge` (LIVE in danger, ANALYZE in analyze). `ticket-confirm` reads "Place BUY order" or "Place SELL order" in the side colour; `ticket-back` returns.
  - **Result** (`order-result`), by outcome:

    | Outcome | Shows |
    |---|---|
    | placed | "Order placed", the id, and "Analyzer (sandbox)" if `analyze` |
    | queued | "Queued for approval in the web Action Center", with `open-action-center` |
    | maybe or no_id | "Status unknown: checking the order book.", then the reconcile result: "Found in the order book: {status}", or "Not found in the order book. It was probably not placed. Check the order book before trying again." A split instead shows `reconcileSplit`'s "Found {k} of {n} child orders in the order book." (never "probably not placed"), with `view-orderbook` and no resend control |
    | split | `split-child-{n}` rows and "{k} of {n} placed", with `view-orderbook` and no resend control |
    | mode_changed | back to review, with "The server is now in {LIVE\|ANALYZE} mode. Review again." |
    | error | `userMessage`, back to edit |

  - `ticket-done` closes the sheet. A quote-only or unknown symbol shows only its issue text; params that don't parse show "This order link is incomplete."
  - After a `placed` outcome, when `isEvented(…)` (T11) is true, call `eventWatch.expect(orderid)`.

- [ ] **Step 1: Failing tests** (`scriptedFetch`):
  - **From depth:** the ask params preset BUY LIMIT with the price; switching to MARKET hides the price.
  - **Split:** 28 lots shows the split note and the review "1,755 + 65"; confirm sends one `splitorder` with `splitsize` 1755; one failed child → "1 of 2 placed", with no resend control.
  - **Single flight:** a double tap on confirm sends one `placeorder`.
  - **Maybe:** a 502 → "Status unknown: checking the order book.", then the reconcile finds it → "Found in the order book: open". A split timeout with both children in the book → "Found 2 of 2 child orders in the order book." and no "probably not placed".
  - **Queued:** the queued copy shows, the link opens `{origin}/action-center`, and `markSemiAuto` runs.
  - **Biometrics:** live with `confirmLiveWrites` on calls `expoAuthenticate`; a failure sends nothing.
  - **Margin:** after a 501, no more margin calls that session; 3 edits within 600 ms → 1 call.
  - **Body and wiring:** `strategy:'mobile'`; an analyze reply shows "Analyzer (sandbox)"; a placed order with zerodha live calls `eventWatch.expect`.
- [ ] **Step 2:** `npx jest src/features/order` → FAIL.
- [ ] **Step 3:** Implement. The ticket's guard wraps the whole of confirm.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(order): order ticket with review, split orders, margin preview and reconcile`.

### Task 13: Orders tab and modify sheet

**Files:** `src/features/orders/{components/{OrderRow,TradeRow,OrderActions}.tsx, screens/{OrdersScreen,ModifySheet}.tsx}`. Modify `src/app/(app)/(tabs)/orders.tsx`, replacing `NotYetAvailable`. Route: `src/app/(app)/order/[id]/modify.tsx`.

**Interfaces:**
- **Segments:** `orders-seg-open` (the default, working rows), `orders-seg-all` (every row, newest first) and `orders-seg-trades`. The header shows the counts from `statistics`.
- **Order rows** (`order-row-{orderid}`): symbol, exchange, side colour, quantity (in lots when the instrument is known), type, price or trigger, product, a status Badge and the time.
- **Row actions:** a tap opens the actions: `order-modify` and `order-cancel` on working rows, plus Depth and Chart.
- **Cancel:** confirm "Cancel this order?", with the row summary as the body. It runs `submitOrderAction('cancel')`. A `maybe` result runs `reconcileRow` and shows the row's new status.
- **Cancel all:** `orders-cancel-all` ("Cancel all ({n})", disabled at 0). Confirm: "Cancel all {n} open orders?" / "This cancels every open order in the account, including ones placed by strategies or the web." Result: "Cancelled {c}. Failed {f}."; a `maybe` refetches the orderbook and shows "Status unknown. {k} orders still open."
- **Modify sheet** (param `id`): the row comes from the orderbook cache, refetched once if missing (still missing: "This order is no longer open."). Fields: quantity (lots on derivatives), type, price and trigger, checked with `validateTicket(…, { splitAvailable: false })`. Opening it runs `gate.read()` and shows the mode. `modify-confirm` sends `modifyBody(row, change)` through `submitOrderAction('modify')`: `done` closes it with the toast "Order modified"; `maybe` runs `reconcileRow` and shows its status; `error` shows `userMessage` and stays.
- **Dropped rows:** `books-dropped` "1 row could not be read" ("{n} rows…" for more) when a book's `dropped` > 0; a missing field renders `--`.
- **Banners and polling:** `BrokerBanner`; `SemiAutoBanner` when `semiAutoSeen`; a `semi_auto_blocked` result shows a danger Banner with the server message and `open-action-center`; `StaleNote` while blocked or after a failed refetch; `useBookPolling(active)`.
- **Empty states:** "No open orders", "No orders today", "No trades today".

- [ ] **Step 1: Failing tests.**
  - **Actions by status:** a `trigger pending` row in Open has Modify and Cancel; a `complete` row has neither.
  - **Modify:** the body equals the row's 12 C3 fields, with only the price changed; `done` toasts "Order modified"; a 400 keeps the sheet open with the message.
  - **Cancel:** sends `{orderid, strategy:'mobile'}`; in analyzer mode the confirm title starts with ANALYZE.
  - **Cancel all:** with 2 open orders, the confirm names 2, and the reply shows "Cancelled 2. Failed 0."; a 502 → "Status unknown. 2 orders still open."
  - **(RF 4)** An orderbook with one row lacking an orderid shows `books-dropped` "1 row could not be read" and renders the other rows; a row with `price` undefined shows `--`.
  - **Semi-Auto:** a Semi-Auto 403 on cancel shows the C5 text and `open-action-center`.
  - **Logged out:** the banner shows, the rows are dimmed, `StaleNote` shows, and there are 0 orderbook calls in 60 s.
  - **Events:** a bus `order_update` refetches the orderbook once, after 500 ms.
- [ ] **Step 2:** `npx jest src/features/orders` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(orders): order book, trades, modify, cancel, cancel all and Semi-Auto banners`.

### Task 14: Portfolio: positions, holdings, funds

**Files:** `src/market/books/{livePnl,useLiveLtps}.ts` and `src/features/portfolio/{components/{PositionRow,HoldingRow,FundsView}.tsx, screens/PortfolioScreen.tsx}`. Modify `src/app/(app)/(tabs)/portfolio.tsx`.

**Interfaces:**
- **`livePositionPnl(row, ltp?)`** → `{ ltp; pnl; pnlPct; live }`, a port of `frontend/src/hooks/useLivePrice.ts:248-289`. Closed rows (quantity 0), and rows without both an LTP and `average_price > 0` (the web's guard, `useLivePrice.ts:273`), keep the REST `pnl`/`pnlpercent`. Otherwise the P&L is `(ltp-avg)·qty·lot` for a long or `(avg-ltp)·|qty|·lot` for a short (`lot_size` defaults to 1) plus `today_realized_pnl`, and the percentage is against `|avg·qty|`.
- **`liveHoldingPnl(row, ltp?)`** recomputes only when `average_price` is present; **`totals(rows)`** adds them up.
- **`useLiveLtps(keys, active): Record<string, number | undefined>`** acquires mode 1 for the open keys and registers a `quotes` consumer (so polling mode works), reading the tick store once per frame.
- **Segments:** `pf-seg-positions`, `pf-seg-holdings`, `pf-seg-funds`.
- **Positions:** `pf-total-pnl` in the header; rows `pos-row-{EX}-{SYM}-{PRODUCT}`, each with `pos-chart-…` → `chartHref`. Positions and holdings show T13's `books-dropped` note.
  - **Close one** (`pos-close-…`, when qty ≠ 0). Confirm: "Close {SYM} {PRODUCT}?" / "This closes the whole net position ({qty}) for {SYM} {PRODUCT} at market, including quantity opened by strategies or the web." It runs `submitOrderAction('closeOne')` with `smartClose(row)`:
    - placed → "Close order sent"; flat → "Already flat"; queued → the queued copy;
    - a `Server` error (any 500) or `maybe` → "Close may have gone through: checking positions.", then `reconcileClose` → "Position is closed", "Still open: {qty}. You can try Close again." or "Couldn't check. Pull to refresh."
  - **Close all** (`pf-close-all`, "Close all ({n})"). Confirm: "Close all {n} open positions?" / "This closes every open position in the account at market, across all strategies and the web." The result shows the reply message; a `maybe` refetches the positionbook and shows "Status unknown. {k} positions still open."
- **Holdings:** `hold-stats` (current value, investment, P&L, P&L %); rows `hold-row-{EX}-{SYM}` (quantity, average when present, live LTP, P&L, P&L %); `hold-sell-{EX}-{SYM}` opens `ticketHref({action:'SELL', product:'CNC', pricetype:'MARKET', quantity: row.quantity})`; `hold-chart-{EX}-{SYM}` → `chartHref`.
- **Funds** (`funds-view`): "Available cash", "Collateral", "Unrealised M2M", "Realised M2M", "Used margin"; refetched every `POLL_RATES.funds` (60 s) while visible.
- **Session:** `BrokerBanner`, `StaleNote`, `useBookPolling`.

- [ ] **Step 1: Failing tests.**
  - **`livePositionPnl`:** long 10 @ 100, LTP 105 → 50 (5%); short -104 @ 17.2, LTP 17.31 → -11.44; a closed row keeps its REST pnl 5.90; `today_realized_pnl` 20 on the long → 70; `lot_size` 0.01, qty 2 @ 3000, LTP 3100 → 2; qty 5 @ 0, LTP 100 keeps the REST pnl. `totals` sums the rows.
  - **Live ticks:** a tick on RELIANCE updates the row and the total with no refetch.
  - **Close one:** the body follows C3 with the row's product; a flat reply → "Already flat"; a 500 → reconcile → qty 0 → "Position is closed"; a double tap sends one call.
  - **Close all:** the confirm names the count; a Semi-Auto 403 shows the banner.
  - **Holdings and funds:** Sell → `ticketHref` with SELL, CNC, MARKET, quantity 10; the funds labels map from the docs fixture; a holdings row without a symbol → `books-dropped`.
  - **Charts:** `pos-chart-NSE-RELIANCE-CNC` and `hold-chart-NSE-RELIANCE` each push `chartHref`.
- [ ] **Step 2:** `npx jest src/market/books src/features/portfolio` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same → PASS.
- [ ] **Step 5:** Commit `feat(portfolio): positions with live P&L, close one and all, holdings with Sell, funds`.

### Task 15: Backup and restore

**Files:**
- Create: `src/features/backup/{format.ts, io.ts, screens/BackupScreen.tsx}` and `src/app/(app)/account/backup.tsx`.
- Modify: `src/features/account/screens/{AccountScreen,SignOutScreen}.tsx`.
- Run: `npx expo install expo-sharing expo-document-picker expo-file-system`.

**Interfaces:**
- **Constants:** `BACKUP_KIND = 'openalgo-mobile-backup'`, `BACKUP_SCHEMA = 1`, `MAX_BACKUP_BYTES = 2_000_000`.
- **`BackupFile = { kind; schema; createdAt; appVersion; content: { watchlists?: Watchlists } & Record<string, unknown> }`.** Content keys are `USER_CONTENT` names; M3–M5 add `strategyPortfolio`, `chartDrawings` and `chartPrefs`.
- **`buildBackup({ watchlists, now, appVersion }): string`**: 2-space JSON built only from the content; throws `BackupLeakError` if the text matches `/"api_?key"/i`.
- **`parseBackup(text)`** → `{ ok: true; file; skipped: string[]; trimmed: number }` or `{ ok: false; reason: 'too_large'|'not_backup' }`:
  - over 2 MB → `too_large`; not JSON or the wrong kind → `not_backup`;
  - a schema above 1 keeps the known keys and lists the rest in `skipped`;
  - lists and items are validated one by one, invalid items dropped, anything beyond 50 lists or 250 items trimmed and counted, and duplicate list ids reissued.
- **`applyRestore(current, incoming, mode: 'replace'|'merge', newId)`**: merge appends, renames a clashing name to "{name} (restored)", and keeps the limits. **`backupFileName(now)`** → `openalgo-backup-20261124-1430.json` (IST).
- **io:** `shareBackup(text, name)` writes `Paths.cache/<name>` (expo-file-system `File`) and calls `Sharing.shareAsync(uri, { mimeType:'application/json', UTI:'public.json', dialogTitle:'Save backup' })`; `pickBackup(): Promise<string | null>` calls `DocumentPicker.getDocumentAsync({ type:['application/json','text/plain'], copyToCacheDirectory:true })`.
- **Screen:** `backup-create`; `backup-restore` shows "{n} lists, {m} symbols" and any notes, then `restore-replace` (confirm "Replace your {k} watchlists?") or `restore-merge`. Copy:
  - too_large: "This file is too large to be an OpenAlgo backup."
  - not_backup: "This isn't an OpenAlgo Mobile backup file."
  - skipped: "Skipped data this version can't read: {keys}."
  - trimmed: "{n} entries were over the limits and were left out."
- **Account and sign out:** Account gets a row "Back up and restore". SignOut gets `signout-backup` "Back up watchlists first", replacing A-T20's "Backup comes in Plan B".

- [ ] **Step 1: Failing tests.**
  - **No secrets:** a backup built from a profile whose storage also holds the key and URL contains neither, nor the profile id; parsing it back gives the same watchlists.
  - **(RF 5)** 3 MB → `too_large`; `{}` → `not_backup`; schema 2 with `chartDrawings` → ok, `skipped: ['chartDrawings']`; 60 lists → 50 kept, `trimmed: 10`; the item `{exchange:'NSE'}` is dropped; duplicate ids are reissued; on screen the current lists stay unchanged until the confirm.
  - **Merge** renames a clashing name. **File name** under a faked IST time: `openalgo-backup-20261124-1430.json`. **Sign out:** `signout-backup` calls `shareBackup`.
- [ ] **Step 2:** `npx jest src/features/backup src/features/account` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same, then `npx expo install --check && npm run typecheck` → PASS and "Dependencies are up to date".
- [ ] **Step 5:** Commit `feat(backup): watchlist backup and restore; sign-out offers a backup first`.

### Task 16: Compatibility suite: every order path

**Files:** `test/helpers/tradingHarness.ts` and `test/compat/trading.test.ts`.

**Interfaces:** `tradingHarness(mock)` returns `{ api, orders, gate, watch, realtime, bus, instruments, submit(kind, send, shownMode?), control, splitTimeoutMs }`, wired from A-T7, A-T8, A-T15 (`createRealtime`), T2 (instrument cache), T8, T10 and T11 (bus, `createEventWatch`) with Node `fetch` and `ws` against `startMockServerProcess`. It uses reconcile `delaysMs [200, 500, 1000]`, a splitorder timeout `splitTimeoutMs` of 2,000, and a gate with `ttlMs: 0`, so a toggle shows on the next read.

- [ ] **Step 1: Failing tests**, each with `test.each(['2.0.0.0','2.0.1.6','2.0.2.0','2.0.3.5'])`:
  - **Analyzer orders:** MARKET → `placed` with `analyze`, and the position shows. LIMIT → open; modify (the mock's `lastBody.modifyorder` has all 12 fields; the price changes); cancel → cancelled.
  - **502:** `failNext 502 afterApply` → `maybe`, then reconcile finds it, with `stats.requests.placeorder === 1`; without `afterApply` → null after 3 fetches.
  - **Timeout:** `delayNext {path:'placeorder', ms:16000, afterApply:true}` → `maybe` → found (the default timeout is 15 s).
  - **Semi-Auto:** placing → `queued`; a live cancel → `semi_auto_blocked` with the C5 text; analyzer plus Semi-Auto close all → `done`.
  - **Flat close:** `flatCloseError` → `error` of kind `Server` → `reconcileClose` → `closed`.
  - **Split:** 28 lots with `splitFailFrom 2` → children `[ok, error]` from one splitorder request. `delayNext {path:'splitorder', ms: splitTimeoutMs+1000, afterApply:true}` → `maybe`, then `reconcileSplit` finds 2 of 2.
  - **Bulk and margin:** cancel all with 2 open → `canceled` length 2; `marginUnsupported` → `Unsupported`.
  - **Mode change:** an analyzer toggle between the review read and the send → `mode_changed`, no placeorder.
  - **Events:** 2.0.3.5 zerodha → own `order_update` within 2 s; 2.0.1.6 with `orderEvents:false` → `watch.demoted()` after `timeoutMs` 1000.
  - **Unknown symbol:** `/symbol` NIFTY25NOV25FUT is requested once per day.
- [ ] **Step 2:** `npm run test:compat` → FAIL.
- [ ] **Step 3:** Write the harness. A failure here is a bug in T1–T15: fix it test-first, in the module that owns it.
- [ ] **Step 4:** `npm run test:compat` → PASS.
- [ ] **Step 5:** Commit `test: compatibility suite for every order path against the mock`.

### Task 17: Maestro trading flows (CI only)

**Files:**
- Create: `e2e/{trading-analyzer,trading-semiauto,depth-levels}.yaml`, `e2e/scripts/mock.js` and `scripts/e2e-ids.test.mjs`.
- Modify: `e2e/README.md` and `.github/workflows/ci.yml` (job `e2e-android`).

**Interfaces:**
- **`mock.js`** posts `CONTROL` to `${MOCK}/__mock/control` (`MOCK` defaults to `http://localhost:5000`).
- **`e2e-ids.test.mjs`**: every `id:` in `e2e/*.yaml` matches a template in `e2e/README.md` (`{X}` matches `[A-Z0-9&_-]+`), and each template's static prefix appears in `src/`.

**Flows** (each starts with `launchApp: {clearState: true}`, then `runFlow: onboarding-live.yaml`):
- **`trading-analyzer.yaml`:**
  1. Control `{"analyzer":true}`.
  2. `wl-add`, type "ITC" in `search-input`, tap `search-row-NSE-ITC`, go back; `watch-row-NSE-ITC` is visible.
  3. `watch-buy-NSE-ITC`, `ticket-type-LIMIT`, `ticket-price` "100", `ticket-review`; `review-mode-badge` reads ANALYZE; `ticket-confirm`; `order-result` contains "Order placed"; `ticket-done`.
  4. Orders: tap the ITC row, `order-modify`, price "101", `modify-confirm`; "101.00" shows. Then `order-cancel`, confirm; "No open orders" shows.
  5. `watch-row-NSE-ITC`, `inst-depth`, `depth-ask-0`; `ticket-type-LIMIT` is selected. Switch to `ticket-type-MARKET`, review, confirm: "Order placed".
  6. Portfolio: `pos-close-NSE-ITC-CNC`, confirm; "Close order sent" shows, and the row reads qty 0.
  7. `pf-seg-holdings`, `hold-sell-NSE-RELIANCE`; `ticket-side-sell` and `ticket-product-CNC` are selected.
- **`trading-semiauto.yaml`:** control `{"semiAuto":true,"analyzer":false}`. A MARKET BUY shows "Queued for approval in the web Action Center" and `open-action-center`, and the Orders tab shows the Semi-Auto banner.
- **`depth-levels.yaml`:** with the mock started with env `BROKER=dhan`, control `{"maxDepth":20}`. Open the RELIANCE depth, tap `depth-levels-20`; `depth-bid-19` is visible.
- **CI:** in `e2e-android`, after Plan A's flows (which leave the mock at `WS_PORT=off`), restart the mock with `PORT=5000 WS_PORT=8765 PROFILE=$PROFILE` and run the two trading flows, then restart it with `BROKER=dhan` added and run `depth-levels.yaml`; reset the mock (`POST /__mock/reset`) before each flow.

- [ ] **Step 1:** Write `e2e-ids.test.mjs`. `node --test scripts/e2e-ids.test.mjs` → FAIL, because the flows don't exist yet.
- [ ] **Step 2:** Write the flows and the README templates.
- [ ] **Step 3:** `node --test scripts/e2e-ids.test.mjs && actionlint .github/workflows/ci.yml` → PASS, with no actionlint output.
- [ ] **Step 4:** Commit `test(e2e): Maestro analyzer trading loop, Semi-Auto and 20-level depth flows`.

### Task 18: Real-server check: books and analyzer orders

**Files:** modify `test/real/realServer.test.ts`, replacing A-T24's `test.todo` entries, and `README.md`.

**Behaviour.** A-T24's safety stays: the whole suite fails unless the analyzer reads `analyze`, and the suite never toggles the mode.
1. **Books:** orderbook, tradebook, positionbook, holdings and funds all parse. Print the `dropped` counts; they should be 0.
2. **Metadata:** `/symbol` RELIANCE gives a lotsize and a tick; WS depth 5 is acked.
3. **Analyzer order loop** (strategy `mobile`):
   - place LIMIT BUY 1 RELIANCE at `snapTick(ltp × 0.9)` → it shows `open`;
   - modify to `ltp × 0.91` → the price changes;
   - cancel → `cancelled`.
4. **While NSE is open** (`test.skip` otherwise): MARKET BUY 1 CNC, then `smartClose` → the position is flat.

- [ ] **Step 1:** Write the tests. `npm run real-server-check` → `1 skipped` without `.env.test.local`.
- [ ] **Step 2: With the owner,** against the local test server in analyzer mode: `npm run real-server-check` → all PASS, and the key does not appear in the output.
- [ ] **Step 3:** Commit `test: real-server books and analyzer order loop`.

### Task 19: M2 exit run

- [ ] **Step 1:** Run the local gate. Expected: all pass, `ok` and `no leaks found`. If the bundles grew more than 5%, run `--update` and give the reason in the PR.

  ```
  npm run lint && npm run typecheck && npx jest --ci && npm run test:scripts && npm run test:compat \
    && npm run boundaries && npm run tokens:check && npm run export && npm run bundles \
    && rm -rf dist-export && gitleaks git --redact --no-banner .
  ```
- [ ] **Step 2:** Stop. Ask the owner to push `phase1/foundation` and run CI with dispatch. Expected: `checks`, `android` and `ios-simulator` are green, and `e2e-android` passes the three trading flows on 2.0.0.0 and 2.0.3.5 (the design's M2 exit).
- [ ] **Step 3: With the owner,** on the CI APK against the local test server in analyzer mode:
  1. Search and add a symbol; place, modify and cancel a LIMIT order; place a MARKET order and close it; holdings Sell opens SELL CNC.
  2. Depth shows 5 levels, and the 20-level switch too if the owner's broker is in C8.
  3. Over a cloudflared tunnel (polling mode), depth refreshes about every 5 s and the books stay right.
  4. After logging out of the broker on the web, a resume shows the banner and stale screens, and "Log in to your broker" opens the web login.
  5. Back up, sign out deleting watchlists, sign in, restore: the lists come back.
- [ ] **Step 4:** Record the device, OS and results in the PR description, then stop for review.

---

## Self-review

1. **Spec coverage.** Watchlists T3, T5, T6; search T4; metadata T2; depth T7; ticket T9, T10, T12; Orders T13; order events T11; portfolio T14; chart entry points T6, T7, T14; logged out T5–T7, T12–T14; Semi-Auto T10, T12–T14; backup T15; mock T1, T16; Maestro T17; exit T18, T19. Deferred: the chart (M3), Option Chain and tool baskets (M4–M5).
2. **Types.** Each shared type and hook is defined once, in the Interfaces of T2, T3, T5, T8, T10 or T11.
3. **Review Focus.** RF 1–5 are tested in T2 and T5, T10, T11, T8 and T13, and T15.

**Beyond Plan A's export list:** `Services.orderEvents` (T11), `ApiError.invalidSymbols` (T5), the move of `features/watchlist/{model,store}` to `src/market/watchlists`, and the T1 mock controls.
