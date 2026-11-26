jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock.js'),
)
require('react-native-gesture-handler/jestSetup')
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'))
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'))
// An icon renders as a plain View that carries its testID.
jest.mock('expo-symbols', () => {
  const { createElement } = require('react')
  const { View } = require('react-native')
  return { SymbolView: (p: { testID?: string }) => createElement(View, { testID: p.testID }) }
})
