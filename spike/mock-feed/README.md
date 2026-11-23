<!-- THROWAWAY SPIKE. How to run the mock OpenAlgo WebSocket feed and point the RN spike app at it. -->
# Mock OpenAlgo feed (spike only)

A tiny Node server that speaks the market-data part of the OpenAlgo WebSocket
protocol (`openalgo/websocket_proxy/server.py`). Use it to benchmark the spike
app over a real socket on your Wi-Fi, without a broker login or market hours.
Prices are seeded random walks, not real data.

## Run

```bash
cd spike/mock-feed
npm install          # installs ws 8.22.2, pinned exactly
npm start            # same as: node server.mjs
```

It prints the URLs to use, for example:

```
OpenAlgo mock feed listening on 0.0.0.0:8765
  rate: 300 market_data msgs/s per connection, spread over its subscriptions
  auth: any non-empty API key (timeout 15000 ms -> close 4401)
  local: ws://127.0.0.1:8765
  LAN:   ws://192.168.1.23:8765   (en0)
```

Every 5 s it logs one line per connected client with the rate it actually
sent, how many ticks it dropped, and the socket's send buffer. If `dropped`
grows or `buffered` keeps climbing, the phone is not reading the socket as fast
as the server writes it. That is a result in itself, so note it.

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8765` | Listen port |
| `HOST` | `0.0.0.0` | Listen address (all interfaces, so the phone can reach it) |
| `RATE` | `300` | `market_data` messages per second **per connection**, spread over that connection's subscriptions (60% go to the first 30 subscribed names, like the app's SimFeed) |
| `MOCK_API_KEY` | unset | When set, `authenticate` must send exactly this key. When unset, any non-empty key works |
| `AUTH_TIMEOUT_MS` | `15000` | Close with code 4401 if the client has not authenticated by then |
| `QUIET` | unset | `1` turns off the connection and stats log lines |

Examples: `RATE=1000 npm start`, `MOCK_API_KEY=secret PORT=9000 npm start`.

## Point the app at it

1. Put the phone and the computer running the server on the same Wi-Fi.
   On macOS, allow `node` when the firewall asks. On Windows, allow it through
   Windows Defender Firewall on private networks.
2. In the app, open the **Results** tab.
3. Under **Feed**, enter the LAN URL the server printed, e.g.
   `ws://192.168.1.23:8765`, and any API key (or the `MOCK_API_KEY` value).
4. Tap **Use WebSocket**. The feed status goes `connecting`, then
   `authenticated`, then `streaming`, and the HUD at the top right shows
   `streaming`. The server logs `#1 authenticated` and `subscribed 181 (Quote)`.
5. Run the benches as usual. In WebSocket mode the server's `RATE` sets the
   tick rate. The app's sim-rate buttons do nothing in this mode.

Plain `ws://` works in the release APK because `app.json` sets
`usesCleartextTraffic: true` through expo-build-properties.

## Check it works

```bash
npm run check        # spawns the server on port 18765, runs every check, stops it (about 20 s: it waits out the real 15 s auth timeout)
npm run check:fast   # same, with a 1.5 s auth timeout
node check.mjs --url ws://192.168.1.23:8765   # check a running server, e.g. from another machine
```

The check subscribes to the app's real symbol universe (it imports
`../app/src/core/symbols.ts`, so 181 instruments) with the exact request the
app's `WsFeed` sends. It then verifies:

- ping and pong
- subscribing before auth is rejected
- a wrong key is rejected when `MOCK_API_KEY` is set
- auth succeeds
- an invalid mode is rejected
- the subscribe ack arrives
- the tick rate is within 10% of `RATE`
- every `market_data` message has the right shape (`oi` only on NFO)
- prices move as a continuous random walk
- `unsubscribe` and `unsubscribe_all` work
- an unknown action gets `INVALID_ACTION`
- an unauthenticated socket is closed with 4401 at the timeout

Node prints one harmless `MODULE_TYPELESS_PACKAGE_JSON` warning when it
imports the `.ts` file. Add `--no-warnings` to hide it.

## Protocol subset

Client to server, using `action` (or `type`, as the real server allows):

- `{"action":"authenticate","api_key":"..."}` (`apikey` also accepted). Reply:
  `{"type":"auth","status":"success","message":"Authentication successful","broker":"mock","user_id":"spike","supported_features":{}}`
- `{"action":"subscribe","symbols":[{"symbol":"RELIANCE","exchange":"NSE"}],"mode":"Quote","request_id":"x"}`.
  The mode can be `1`/`2`/`3` or `LTP`/`Quote`/`Depth` in any case, as in
  `mode_utils.py`. A single `symbol` + `exchange` pair also works. Reply:
  `{"type":"subscribe","status":"success","subscriptions":[{"symbol","exchange","status":"success","mode":"Quote","depth":5,"broker":"mock"}],"message":...,"broker":"mock","request_id":"x"}`
- `{"action":"unsubscribe","symbols":[...],"mode":...}` or
  `{"action":"unsubscribe_all"}`. Reply:
  `{"type":"unsubscribe","status","successful":[...],"failed":[...],"request_id"?}`
- `{"action":"ping","timestamp"?,"_pingId"?}`. Reply:
  `{"type":"pong","status":"success","server_timestamp":<ms>,"client_timestamp"?,"_pingId"?}`

Server to client, one WebSocket frame per message, about 245 bytes each:

```json
{"type":"market_data","symbol":"NIFTY27NOV2624850PE","exchange":"NFO","mode":2,"broker":"mock",
 "data":{"ltp":872.15,"open":871.8,"high":875.6,"low":871.8,"close":875.6,"volume":487112,
         "change":-3.45,"change_percent":-0.39,"oi":354000,"timestamp":1795389291381}}
```

Errors use the real server's shape, which has **no `type` field**:
`{"status":"error","code":"NOT_AUTHENTICATED"|"AUTHENTICATION_ERROR"|"INVALID_MODE"|"INVALID_PARAMETERS"|"INVALID_ACTION"|"INVALID_JSON","message":...,"request_id"?}`.

## Differences from a real OpenAlgo server

- There is no broker, database or real API key check. Prices are seeded random
  walks per symbol: NIFTY options are priced off a 24000 underlying, and
  equities fall between 100 and 5000.
- `supported_features` is `{}`. The real server sends
  `{"ltp":true,"quote":true,"depth":true}`.
- The Quote payload follows the field list the spike app reads. Real payloads
  depend on the broker adapter. The LTP (`{ltp,timestamp}`) and Depth
  (Quote fields plus 5 fake levels) payloads are approximations.
- If a client subscribes to one symbol in several modes, it gets one message
  per tick in the highest mode.
- When a client's send buffer passes 8 MB, ticks are dropped and counted
  instead of queued without limit.
- Order updates (`subscribe_orders`), `get_broker_info` and
  `get_supported_brokers` are not implemented. They return `INVALID_ACTION`.
