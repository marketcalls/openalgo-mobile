const main = require('./jest.config')

// babel-preset-expo is nested under expo, so resolve it from there.
const expoPreset = require.resolve('babel-preset-expo', {
  paths: [require.resolve('expo/package.json')],
})

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/real'],
  transform: { '\\.[jt]sx?$': ['babel-jest', { presets: [expoPreset] }] },
  moduleNameMapper: {
    ...main.moduleNameMapper,
    '^@react-native-async-storage/async-storage$':
      '@react-native-async-storage/async-storage/jest/async-storage-mock',
  },
  globals: { __DEV__: false },
  testTimeout: 60000,
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/openalgo/'],
  modulePathIgnorePatterns: ['<rootDir>/openalgo/'],
}
