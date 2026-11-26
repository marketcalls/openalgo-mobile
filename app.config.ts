import type { ConfigContext, ExpoConfig } from 'expo/config'
import pkg from './package.json'

function buildNumber(): number {
  const raw = process.env.BUILD_NUMBER
  if (raw === undefined || raw === '') return 1
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`BUILD_NUMBER must be a positive integer, got "${raw}"`)
  }
  return Number(raw)
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const build = buildNumber()
  return {
    ...config,
    name: 'OpenAlgo',
    slug: 'openalgo-mobile',
    version: pkg.version,
    scheme: 'openalgo',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    userInterfaceStyle: 'automatic',
    ios: {
      bundleIdentifier: 'in.openalgo.mobile',
      buildNumber: String(build),
      infoPlist: {
        // Local-network HTTP only; the URL rule in app code gates everything else.
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        NSLocalNetworkUsageDescription:
          'OpenAlgo connects to your OpenAlgo server on your home network.',
      },
    },
    android: {
      package: 'in.openalgo.mobile',
      versionCode: build,
      allowBackup: false,
      predictiveBackGestureEnabled: false,
      // The white OpenAlgo mark on black; assets/brand/README.md says how the images are made.
      adaptiveIcon: {
        backgroundColor: '#000000',
        foregroundImage: './assets/images/android-icon-foreground.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        // The white logo (mark and wordmark) on black, the same in light and dark mode.
        {
          backgroundColor: '#000000',
          image: './assets/images/splash-icon.png',
          imageWidth: 200,
        },
      ],
      [
        'expo-local-authentication',
        { faceIDPermission: 'OpenAlgo uses Face ID to unlock the app.' },
      ],
      './plugins/withReleaseSigning',
      ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    ],
    web: { favicon: './assets/images/favicon.png' },
    experiments: { typedRoutes: true, reactCompiler: true },
    extra: { minServerVersion: '2.0.0.0' },
  }
}
