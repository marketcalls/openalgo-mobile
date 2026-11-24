import { KEY_RE, looksPasted, normalizeKeyInput } from './keyFormat'

const HEX = '0123456789abcdef'.repeat(4)

describe('normalizeKeyInput (RF 1)', () => {
  test('64 uppercase hex characters with spaces and a line break are ok, lowercased', () => {
    const upper = HEX.toUpperCase()
    const scanned = ` ${upper.slice(0, 16)} ${upper.slice(16, 32)}\n${upper.slice(32, 48)}\t${upper.slice(48)} \r\n`
    expect(normalizeKeyInput(scanned)).toEqual({ key: HEX, ok: true })
  })

  test('a clean lowercase key is ok as it is', () => {
    expect(normalizeKeyInput(HEX)).toEqual({ key: HEX, ok: true })
  })

  test("'api key: <hex>' is not ok: only whitespace is stripped", () => {
    expect(normalizeKeyInput(`api key: ${HEX}`)).toEqual({ key: `apikey:${HEX}`, ok: false })
  })

  test('63 or 65 characters are not ok', () => {
    expect(normalizeKeyInput(HEX.slice(1)).ok).toBe(false)
    expect(normalizeKeyInput(`${HEX}0`).ok).toBe(false)
  })

  test('a g is not ok', () => {
    expect(normalizeKeyInput(`g${HEX.slice(1)}`).ok).toBe(false)
  })

  test('empty input is not ok', () => {
    expect(normalizeKeyInput('  \n')).toEqual({ key: '', ok: false })
  })

  test('KEY_RE accepts only 64 lowercase hex characters', () => {
    expect(KEY_RE.test(HEX)).toBe(true)
    expect(KEY_RE.test(HEX.toUpperCase())).toBe(false)
    expect(KEY_RE.test(`${HEX}\n`)).toBe(false)
  })
})

describe('looksPasted', () => {
  test('64 characters at once look pasted', () => {
    expect(looksPasted('', HEX)).toBe(true)
  })

  test('one typed character does not', () => {
    expect(looksPasted('abc', 'abcd')).toBe(false)
    expect(looksPasted('', 'a')).toBe(false)
  })

  test('the threshold is 32 characters longer', () => {
    expect(looksPasted('ab', `ab${'c'.repeat(32)}`)).toBe(true)
    expect(looksPasted('ab', `ab${'c'.repeat(31)}`)).toBe(false)
  })

  test('deleting text never looks pasted', () => {
    expect(looksPasted(HEX, '')).toBe(false)
  })
})
