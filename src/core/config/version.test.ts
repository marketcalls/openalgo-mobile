import { atLeast, compareVersions, normalizeVersion } from './version'

test('normalizeVersion maps the 2.0.1.17 quirk and trims', () => {
  expect(normalizeVersion('2.0.1.17')).toBe('2.0.1.7')
  expect(normalizeVersion(' v2.0.3.5 ')).toBe('2.0.3.5')
})

test('compareVersions is numeric per segment', () => {
  expect(compareVersions('2.0.10.0', '2.0.9.9')).toBe(1)
  expect(compareVersions('2.0.0.0', '2.0.0.1')).toBe(-1)
  expect(compareVersions('2.0.1.17', '2.0.1.7')).toBe(0)
  expect(compareVersions('2.0.1', '2.0.1.0')).toBe(0)
})

test('atLeast treats an unknown version as too old', () => {
  expect(atLeast(null, '2.0.0.0')).toBe(false)
  expect(atLeast('2.0.0.0', '2.0.0.0')).toBe(true)
  expect(atLeast('2.0.2.1', '2.0.3.0')).toBe(false)
})
