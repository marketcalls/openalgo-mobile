THROWAWAY SPIKE - do not build the product on this code.

# OpenAlgo mobile: React Native + Expo performance spike

This app answers two questions before any mobile product work starts:

1. **Is React Native + Expo fast enough on a budget Android phone?** That covers live ticks, scrolling lists, and a
   full trading chart.
2. **How much of the existing OpenAlgo web frontend can run unchanged inside Expo DOM components?** The tests use
   `OpenAlgoChart` with its built-in indicators and the `BuySellButtons` trading panel, plus one whole web page
   (Max Pain) as a mechanism test.

The requested mobile scope is **charting, built-in indicators, and button-based trading**. The **Chart tab** is the
main test of that scope. The other tabs support it:
- **Watchlist** is the native live-price list a trading screen needs.
- **Results** holds the settings and the copyable results.
- **Tool** (the Max Pain page) is in phase-1 scope: every `/tools` page ships on mobile, so this is the test of
  reusing a whole `/tools` page unchanged. Run it.
- **Chain** (a native option chain list) is a heavier native-list test. Run it too.

What was changed to make the web code run is in [CHANGES.md](CHANGES.md).

Nothing in this spike has been run on an Android device or emulator yet. Your phone run is the first real data.

## What is in the app

| Tab | What it shows | Scripted benchmark | Scenario(s) recorded |
|---|---|---|---|
| Watchlist | 100 NSE rows in a FlashList, each subscribed only to its own symbol, with an optional tick flash | "Run scroll bench (20 s)": a scripted up-and-down scroll | `watchlist:scroll:flash-on`, `watchlist:scroll:flash-off` |
| Chain | 40 NIFTY strikes (CE and PE) with ATM and ITM shading | "Run scroll bench (20 s)" | `chain:scroll` |
| **Chart** | The web frontend's `OpenAlgoChart`, unchanged, in a DOM component: 2,000 RELIANCE 5m candles, EMA 20, EMA 50, RSI 14, volume, and the widget's mobile layout. The on-chart SELL / qty / BUY panel opens a native order ticket that sends nothing. | Open time (automatic on the first visit, then the "Open time" button); "Run pan bench (20 s)" with ticks in-DOM or via the bridge | `chart:open`, `chart:pan:ticks-dom`, `chart:pan:ticks-bridge`, `chart:trade-tap` (information only) |
| Tool | The web frontend's Max Pain page, unchanged, in a fresh DOM component each time, with fixture data | "Open Max Pain" | `tool:maxpain-open` |
| Results | How-to, feed settings, all results, startup, device | none | none |

A small HUD at the top right always shows the live JS fps, UI fps and feed state.

Ticks come from an in-app simulator by default. It serializes and parses every tick as JSON, the way a socket would,
at 300 ticks per second across 181 instruments. It can also come from a real WebSocket using the OpenAlgo protocol
(see "Mock feed" below).

## Pass bars

These come from `PASS` in `app/src/core/results.ts`.

| Bar | Value | Applies to | What is measured |
|---|---|---|---|
| Native UI fps | at least 55 | `watchlist:scroll:*`, `chain:scroll` | UI-thread frame rate (Reanimated frame callback) during the 20 s window |
| Native JS fps | at least 45 | the same | JS-thread `requestAnimationFrame` rate |
| Slow frames | at most 5 % | the same | Share of UI frames longer than 25 ms |
| Chart fps | at least 30 | `chart:pan:*` | The WebView's own frame rate while the chart pans through history every frame. Native UI and JS fps are recorded alongside, but are not part of the pass rule. |
| Chart open | at most 2,500 ms | `chart:open` | From the native mount of the chart's DOM component to the first painted frame with candles |
| Tool open | at most 2,500 ms | `tool:maxpain-open` | From the press to the moment the Plotly bars are painted. Backend time is not included. |
| Tool memory | at most 250 MB | `tool:maxpain-open` | WebView JS heap (`performance.memory`), when the WebView exposes it |
| Cold start | at most 3,500 ms | Startup card | The in-app number is a lower bound, so also measure with adb (below) |

On a 90 Hz or 120 Hz screen, fps values can be above 60. The 25 ms slow-frame threshold stays the same.

## Build the release APK locally

You need Node, JDK 17 and the Android SDK. The working machine has Zulu 17 and an SDK set up in
`app/android/local.properties`. React Native 0.88 here uses compileSdk 37, targetSdk 36 and minSdk 24 (Android 7.0).

```bash
cd spike/app
npm install                                   # only on a fresh checkout; node_modules is already present here
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
```

- Output: `spike/app/android/app/build/outputs/apk/release/app-release.apk`.
- The APK is signed with the debug key. That is fine for sideloading, but it cannot go to the Play Store.
- `android/` is generated and gitignored. `--clean` regenerates it from `app.json`.
- **An `android/` folder and an `app-release.apk` already exist in `spike/app`, built at 04:46 before the screens
  were finished.** That APK contains no DOM component pages, so it predates the chart and tool screens. Do not
  install it; rebuild with the commands above.
- The Gradle build runs `expo export:embed`. That step bundles the native JS (compiled to Hermes bytecode) and
  copies the two DOM component pages (chart and tool) into the APK's assets. The same step was run by hand during
  integration and succeeded.

## Install

- **With a cable:** enable USB debugging on the phone, then run
  `adb install -r spike/app/android/app/build/outputs/apk/release/app-release.apk`.
- **Without a cable:** copy the APK to the phone, open it in the Files app, and allow "Install unknown apps" for
  that app when asked.

The app is called **OpenAlgo Spike** (package `in.openalgo.spike`).

## Test procedure

Before you start:
- Use the release APK, not a dev build.
- Turn battery saver off. The battery should be over 50 %.
- Close other apps and leave the phone on a table.
- Do not touch the screen while a bench says it is running.

The Results tab has the same steps in short form.

1. **Cold start.** Force-stop the app (Settings › Apps › OpenAlgo Spike › Force stop), open it, and wait 5 s. If you
   have adb, also run `adb shell am start -S -W in.openalgo.spike/.MainActivity` three times and note each
   `TotalTime`. That is the true cold start; the in-app number is a lower bound.
2. **Results tab.** Check that the Device card says release and not emulator. Leave Feed = Sim, rate 300, flush raf.
3. **Chart tab** (the requested scope):
   1. The first visit mounts the chart and records `chart:open` (`kind: first-mount`) by itself. Wait for
      "Ready in … ms".
   2. Press **Open time** three times, waiting for "Ready" each time. Each press is a fresh WebView.
   3. With Ticks = **in-DOM**, press **Run pan bench (20 s)**.
   4. Switch Ticks to **via bridge** and run the pan bench again.
   5. Tap **BUY** on the chart, then confirm in the sheet. Tap **SELL**, then close the sheet.
   6. By hand: pan and pinch-zoom the chart, open **Indicators** in the chart's bottom bar, then add and remove one
      study. Note how it feels.
4. **Watchlist tab.** Run the scroll bench with **Flash on**, then switch to **Flash off** and run it again.
5. **Chain and Tool tabs** (`/tools` is in phase-1 scope): run the **Chain** tab scroll bench. On the **Tool** tab,
   press **Open Max Pain** three times, then scroll and tap around the page and note how usable it is on the phone.
6. **Higher load.** On the Results tab set the rate to **1000**. Run the chart pan bench (in-DOM) and the watchlist
   bench (Flash on) again.
7. **Optional:** set flush = **immediate**, run one watchlist bench, then set it back to **raf**.
8. **Optional:** the WebSocket run against the mock feed (next section).
9. On the Results tab, tap **Copy all as JSON** (see "Send the results back").

Results live in memory only. Killing or force-stopping the app loses them, so copy them before any force-stop.

Each result records its run conditions in `settings`:
- `feedMode` and `simRate`
- `flushMode`
- `domMounted`: which WebViews were alive during the run. Once you open the Chart tab, the chart WebView stays alive
  behind the other tabs, as it would in a real app.
- `hiddenTabsPaused`: hidden tabs do not re-render on ticks.

## Mock feed (optional WebSocket run)

`spike/mock-feed` is a small Node server that speaks the market-data part of the OpenAlgo WebSocket protocol. It
uses seeded random prices and needs no broker login or market hours. Full details are in
[mock-feed/README.md](mock-feed/README.md).

```bash
cd spike/mock-feed
npm install          # ws 8.22.2, pinned
npm start            # or: RATE=1000 npm start
```

1. Put the computer and the phone on the same Wi-Fi, and allow `node` through the firewall if asked.
2. In the app's Results tab, enter the LAN URL the server prints (for example `ws://192.168.1.23:8765`) and any API
   key.
3. Tap **Use WebSocket**. The status goes from `connecting` to `authenticated` ("subscribing 181 symbols") to
   `streaming`. A wrong key shows `error · AUTHENTICATION_ERROR: …`.
4. Run the watchlist bench (and the chart pan bench in **via bridge** mode, which uses the native feed). In this mode
   the server's `RATE` sets the tick rate.

`npm run check:fast` checks the server against the app's real subscribe request. It passed 16 of 16 checks during
integration.

## Send the results back

1. On the Results tab, tap **Copy all as JSON** and paste it into the chat or an issue. The JSON contains build info,
   device, startup, settings, pass bars and every result. It never contains the API key or the WebSocket URL.
2. Add these by hand:
   - the phone model, its RAM and Android version
   - the Android System WebView version (Settings › Apps › Android System WebView, or
     `adb shell dumpsys webviewupdate | grep -i version`)
   - the three adb `TotalTime` values
   - a few words on how panning, zooming and the BUY/SELL sheet felt
3. Optional: for real memory use, run `adb shell dumpsys meminfo in.openalgo.spike` with the chart open, and look at
   the WebView's sandboxed process too. The in-app memory number is only the WebView's JS heap.
4. If the app crashes, run `adb logcat -d -b crash` right after and include the output.

## Caveats

- **Plain `ws://` is allowed for this spike only.** `usesCleartextTraffic` is set through expo-build-properties in
  `app/app.json`, so the phone can reach a LAN mock feed. A product build must not ship this.
- **The API key is kept in memory only.** It is never written to disk and never included in the copied JSON. The
  spike does not design credential storage. The chart DOM component never sees a key and cannot place an order.
- **Numbers from an emulator or a debug build mean nothing.** The Results tab warns about both. Desktop-browser
  numbers in `app/CHANGES.*.md` also mean nothing for a budget phone.
- **The in-app startup figure is a lower bound.** On Android, React Native logs its start marker when it begins
  loading the JS bundle, so process start, native init and Hermes runtime creation are not counted. It also includes
  mounting all five tabs. Use the adb `TotalTime`.
- **The native scroll benches drive scrolling from JavaScript**, one `scrollToOffset` per frame. A real finger fling
  is driven by the UI thread. When the JS thread stalls, the scroll stutters while the UI-thread fps can still read
  close to 60. For those benches, read JS fps and JS slow % as the measure of visible smoothness.
- **The frame probes always run** (a UI-thread frame callback and a JS `requestAnimationFrame` loop), and add a small
  constant cost.
- **Memory numbers are coarse.** `memoryMb` is `performance.memory` (JS heap only, bucketed by Chromium), and may be
  `null` on Android System WebView.
- **Tool open time leaves out the backend.** Fixtures answer instantly, or with 150 ms per request when toggled. The
  real `/oitracker/api/maxpain` can take seconds. Tree shaking is off, so the Tool bundle carries all of lucide-react
  and its open time is pessimistic. The chart bundle does not include lucide-react.
- **The data is synthetic.** It is 24x7 with no NSE sessions. The chart sim clock runs 30 times faster than real
  time. Option prices in the Chain tab do not follow the underlying.
- **Custom (user) chart indicators are disabled** by a shim. Built-in indicators work.
- **The frontend stylesheet is copied** into `app/src/dom/chart/` and `app/src/dom/tool/`. If
  `openalgo/frontend/src/index.css` changes, regenerate both copies (see CHANGES.md, item 2).

## Layout

```
spike/
  README.md            this file
  CHANGES.md           what reusing the web frontend took (merged)
  app/                 the Expo app (SDK 58, RN 0.88, Hermes, New Architecture, React Compiler)
    src/app/           routes: index (Watchlist), chain, chart, tool, results, _layout (NativeTabs, HUD, feed)
    src/core/          symbols, tick store, feeds, metrics, bench runner, results, settings
    src/dom/           'use dom' components: ChartDom.tsx (+ chart/), ToolDom.tsx (+ tool/)
    src/features/      native screens: watchlist, chain, order (ticket), results
    shims.*.json       frontend modules replaced by local files (one entry: customIndicators)
    CHANGES.chart.md   chart builder's detailed log
    CHANGES.tool.md    tool builder's detailed log
  mock-feed/           Node mock of the OpenAlgo market-data WebSocket
```
