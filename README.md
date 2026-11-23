# OpenAlgo Mobile

The OpenAlgo mobile app is being rebuilt with **React Native + Expo** for Android and iOS.

> **Current state: performance spike.** `main` holds a throwaway spike that measures
> whether React Native + Expo, reusing the OpenAlgo web frontend's charts and `/tools`
> pages, is smooth enough on a budget Android phone. It is not the finished app and it
> never places real orders. The production app will be designed from its results.
>
> The previous Flutter app is preserved, unchanged, on the
> [`backup/flutter-main-2026-11-23`](https://github.com/marketcalls/openalgo-mobile/tree/backup/flutter-main-2026-11-23)
> branch.

## What's here

| Path | What it is |
|---|---|
| `spike/app` | The Expo app (SDK 58, React Native 0.88, New Architecture). Tabs: Chart, Watchlist, Chain, Tool, Results |
| `spike/mock-feed` | A local WebSocket server that speaks the OpenAlgo market-data protocol, for testing without a broker |
| `spike/README.md` | Pass criteria, local build steps and the on-device test procedure |
| `spike/CHANGES.md` | What reusing the web frontend's code would take in the real app |
| `.github/workflows/build.yml` | CI that builds the Android APK and an unsigned iOS IPA |

The app imports the OpenAlgo web frontend's source directly, so it expects
[marketcalls/openalgo](https://github.com/marketcalls/openalgo) checked out next to this repo:

```
openmobile/
├── openalgo/          # marketcalls/openalgo
└── openalgo-mobile/   # this repo
```

## Builds

Every push and pull request to `main` runs **Build apps** in GitHub Actions. Open the run
under the **Actions** tab and download from **Artifacts**:

- **`android-apk`**: a release APK for arm64 and armv7 phones. It is signed with the
  React Native debug key, so install it by sideloading (`adb install -r <file>.apk`, or open
  the file on the phone). It is not suitable for the Play Store.
- **`ios-ipa-unsigned`**: a release build for iPhone with no signature. An iPhone will not
  install it as is; re-sign it with your own Apple ID (for example with Sideloadly or
  AltStore), or add Apple signing to CI (below).

To build against a different openalgo commit, run the workflow by hand
(**Actions › Build apps › Run workflow**) and set `openalgo_ref`.

### Not set up yet

- **Store signing.** A Play upload key, and an Apple Developer certificate with a
  provisioning profile, would be stored as GitHub secrets so CI can produce store-ready
  builds. None are configured.
- **Store upload** (Play Console, TestFlight).

## Local development

See [`spike/README.md`](spike/README.md). In short:

```bash
cd spike/app
npm ci
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
```

## License

[AGPL-3.0](LICENSE)
