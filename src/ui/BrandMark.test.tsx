import { isHiddenFromAccessibility, render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { BrandMark } from './BrandMark'
import { buildTheme, useTheme } from './theme'
import { tokens } from './tokens'

jest.mock('./theme', () => {
  const actual = jest.requireActual('./theme')
  return { ...actual, useTheme: jest.fn(() => actual.buildTheme('dark')) }
})

const mockedTheme = jest.mocked(useTheme)
const styleOf = (el: { props: { style?: unknown } }) =>
  StyleSheet.flatten(el.props.style as never) as {
    width?: number
    height?: number
    tintColor?: string
  }

describe.each(['light', 'dark'] as const)('%s scheme', (scheme) => {
  beforeEach(() => mockedTheme.mockReturnValue(buildTheme(scheme)))

  test("the white mark is tinted to the theme's foreground", async () => {
    await render(<BrandMark testID="m" />)
    expect(styleOf(screen.getByTestId('m')).tintColor).toBe(tokens[scheme].foreground)
  })
})

test('the bundled mark, square at the given size, in the given colour', async () => {
  await render(<BrandMark testID="m" size={64} color="#123456" />)
  const mark = screen.getByTestId('m')
  expect(styleOf(mark)).toMatchObject({ width: 64, height: 64, tintColor: '#123456' })
  expect(JSON.stringify(mark.props.source)).toContain('assets/brand/openalgo-mark.png')
})

test('screen readers announce it as "OpenAlgo"', async () => {
  await render(<BrandMark testID="m" />)
  expect(screen.getByRole('image', { name: 'OpenAlgo' })).toHaveProp('testID', 'm')
})

test('a decorative mark is hidden from screen readers', async () => {
  await render(<BrandMark testID="m" decorative />)
  const mark = screen.getByTestId('m', { includeHiddenElements: true })
  expect(isHiddenFromAccessibility(mark)).toBe(true)
  expect(screen.queryByRole('image', { name: 'OpenAlgo' })).toBeNull()
})
