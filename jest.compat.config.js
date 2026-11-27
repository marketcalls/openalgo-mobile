const main = require('./jest.config')

// babel-preset-expo is nested under expo, so resolve it from there.
const expoPreset = require.resolve('babel-preset-expo', {
  paths: [require.resolve('expo/package.json')],
})

/** @type {import('jest').Config} */
module.exports = {
  // Node by default; a file that renders a tool page says `@jest-environment jsdom` itself.
  testEnvironment: 'node',
  roots: ['<rootDir>/test/compat'],
  // openalgo-charts ships ESM (.mjs) only; the chart's compat test imports its live feed. Built
  // for web, as the dom project builds a page: a 'use dom' entry stays the page, not a WebView proxy.
  transform: {
    '\\.[mc]?[jt]sx?$': [
      'babel-jest',
      { presets: [expoPreset], caller: { name: 'metro', bundler: 'metro', platform: 'web' } },
    ],
  },
  transformIgnorePatterns: main.transformIgnorePatterns,
  moduleNameMapper: {
    // Plotly draws nothing in jsdom: the pages' 2D plot is a holder (listed first, it wins over `@/`).
    '^@/lib/Plot2D$': '<rootDir>/test/helpers/plot2dStub.tsx',
    ...main.moduleNameMapper,
    '^@react-native-async-storage/async-storage$':
      '@react-native-async-storage/async-storage/jest/async-storage-mock',
  },
  globals: { __DEV__: false },
  testTimeout: 60000,
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/openalgo/'],
}
