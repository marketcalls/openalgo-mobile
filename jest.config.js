// babel-preset-expo is nested under expo, so resolve it from there.
const expoPreset = require.resolve('babel-preset-expo', {
  paths: [require.resolve('expo/package.json')],
})

// The ~ alias, and @ for the pinned web frontend (npm run sync-openalgo -- --extract), for both
// projects; jest.compat.config.js and jest.real.config.js read it from here.
const moduleNameMapper = {
  '^~/(.*)$': '<rootDir>/src/$1',
  '^@/(.*)$': '<rootDir>/openalgo/frontend/src/$1',
}

// The node_modules packages babel compiles like app code: openalgo-charts ships ESM (.mjs) only,
// and so does expo/dom, which a 'use dom' entry imports for useDOMImperativeHandle; then the web
// frontend's DOM packages. The dom project, jest.compat.config.js and jest.real.config.js use it.
const ESM_PACKAGES = [
  'openalgo-charts',
  'expo/build/dom',
  'axios',
  'lucide-react',
  '@radix-ui',
  'cmdk',
  'sonner',
  'react-router',
  'tailwind-merge',
  'class-variance-authority',
  'clsx',
  'plotly.js',
  'react-plotly.js',
]
const transformIgnorePatterns = [`/node_modules/(?!(${ESM_PACKAGES.join('|')})/)`]

/** @type {import('jest').Config} */
module.exports = {
  moduleNameMapper,
  transformIgnorePatterns,
  // The jest-expo preset set this as the root config; inside a project it cannot set a global.
  passWithNoTests: true,
  projects: [
    {
      displayName: 'native',
      preset: 'jest-expo',
      // Maps Reanimated's web-only modules for Jest and chains the worklets resolver.
      resolver: 'react-native-reanimated/jest/resolver',
      setupFiles: ['<rootDir>/jest.setup.ts'],
      moduleNameMapper,
      testPathIgnorePatterns: [
        '/node_modules/',
        '<rootDir>/openalgo/',
        '<rootDir>/spike/',
        '<rootDir>/dev/',
        '<rootDir>/scripts/',
        '<rootDir>/test/compat/',
        '<rootDir>/test/real/',
        // WebView content runs in the "dom" project.
        '<rootDir>/src/dom/(web|chart|tools)/',
      ],
    },
    {
      // WebView content (design 7.7) runs in a browser: jsdom, built for web as Expo exports a
      // DOM page. The jest-expo preset cannot host jsdom (its React Native setup redefines
      // window), and its ios caller would turn a 'use dom' file into a WebView proxy.
      displayName: 'dom',
      testEnvironment: 'jsdom',
      roots: ['<rootDir>/src/dom'],
      testMatch: ['<rootDir>/src/dom/{web,chart,tools}/**/*.test.{ts,tsx}'],
      transform: {
        '\\.[mc]?[jt]sx?$': [
          'babel-jest',
          {
            presets: [expoPreset],
            caller: { name: 'metro', bundler: 'metro', platform: 'web' },
          },
        ],
      },
      transformIgnorePatterns,
      moduleNameMapper,
      globals: { __DEV__: false },
      testPathIgnorePatterns: ['/node_modules/', '<rootDir>/openalgo/'],
    },
  ],
}
