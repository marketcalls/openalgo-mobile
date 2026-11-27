import { render, screen, userEvent } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { ApiError } from '~/core/http/errors'
import { tapLight } from '~/core/platform/haptics'
import { Button } from './Button'
import { Change } from './Change'
import { ErrorState } from './ErrorState'
import { NotYetAvailable } from './NotYetAvailable'
import { Price } from './Price'
import { StatusBadges } from './StatusBadges'
import { Text } from './Text'
import { buildTheme, resolveScheme, useTheme } from './theme'
import { tokens } from './tokens'

jest.mock('~/core/platform/haptics', () => ({ tapLight: jest.fn() }))

jest.mock('./theme', () => {
  const actual = jest.requireActual('./theme')
  return { ...actual, useTheme: jest.fn(() => actual.buildTheme('dark')) }
})

const mockedTheme = jest.mocked(useTheme)
const colorOf = (el: { props: { style?: unknown } }) =>
  (StyleSheet.flatten(el.props.style as never) as { color?: string }).color
const bgOf = (el: { props: { style?: unknown } }) =>
  (StyleSheet.flatten(el.props.style as never) as { backgroundColor?: string }).backgroundColor

describe.each(['light', 'dark'] as const)('%s scheme', (scheme) => {
  beforeEach(() => mockedTheme.mockReturnValue(buildTheme(scheme)))

  test('Change uses the profit and loss colours', async () => {
    const { rerender } = await render(<Change change={1.2} pct={0.5} testID="c" />)
    expect(colorOf(screen.getByTestId('c'))).toBe(tokens.trade[scheme].profit)
    expect(screen.getByText('+1.20 (+0.50%)')).toBeTruthy()
    await rerender(<Change change={-1.2} pct={-0.5} testID="c" />)
    expect(colorOf(screen.getByTestId('c'))).toBe(tokens.trade[scheme].loss)
  })

  test('Price takes the profit or loss colour from its sign, and the default without one', async () => {
    const { rerender } = await render(<Price value={10} sign={1} testID="p" />)
    expect(colorOf(screen.getByTestId('p'))).toBe(tokens.trade[scheme].profit)
    await rerender(<Price value={10} sign={-1} testID="p" />)
    expect(colorOf(screen.getByTestId('p'))).toBe(tokens.trade[scheme].loss)
    await rerender(<Price value={10} sign={0} testID="p" />)
    expect(colorOf(screen.getByTestId('p'))).toBe(tokens[scheme].foreground)
    await rerender(<Price value={10} testID="p" />)
    expect(colorOf(screen.getByTestId('p'))).toBe(tokens[scheme].foreground)
  })

  test('a buy button uses trade.buy', async () => {
    await render(<Button title="Buy" variant="buy" onPress={() => {}} testID="b" />)
    expect(bgOf(screen.getByTestId('b'))).toBe(tokens.trade[scheme].buy)
  })
})

test('system resolves through the device scheme and falls back to dark', () => {
  expect(resolveScheme('system', 'light')).toBe('light')
  expect(resolveScheme('system', null)).toBe('dark')
  expect(resolveScheme('light', 'dark')).toBe('light')
})

test('Text tone muted uses the muted foreground', async () => {
  mockedTheme.mockReturnValue(buildTheme('light'))
  await render(
    <Text tone="muted" testID="t">
      x
    </Text>,
  )
  expect(colorOf(screen.getByTestId('t'))).toBe(tokens.light.mutedForeground)
})

describe('Button', () => {
  beforeEach(() => mockedTheme.mockReturnValue(buildTheme('dark')))

  test('a press calls onPress and taps', async () => {
    const onPress = jest.fn()
    await render(<Button title="Go" onPress={onPress} testID="b" />)
    await userEvent.press(screen.getByTestId('b'))
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(tapLight).toHaveBeenCalled()
  })

  test('a loading button ignores presses', async () => {
    const onPress = jest.fn()
    await render(<Button title="Go" onPress={onPress} loading testID="b" />)
    await userEvent.press(screen.getByTestId('b'))
    expect(onPress).not.toHaveBeenCalled()
  })
})

describe('ErrorState', () => {
  beforeEach(() => mockedTheme.mockReturnValue(buildTheme('dark')))

  test('shows the RateLimited copy', async () => {
    await render(
      <ErrorState error={new ApiError({ kind: 'RateLimited', status: 429, endpoint: 'funds' })} />,
    )
    expect(screen.getByText(/busy|too many|rate|slow/i)).toBeTruthy()
  })

  test('a non-API error is generic and retry works', async () => {
    const onRetry = jest.fn()
    await render(<ErrorState error={new Error('x')} onRetry={onRetry} />)
    expect(screen.getByText('Something went wrong.')).toBeTruthy()
    await userEvent.press(screen.getByText('Try again'))
    expect(onRetry).toHaveBeenCalled()
  })
})

test('NotYetAvailable names what is missing', async () => {
  mockedTheme.mockReturnValue(buildTheme('dark'))
  await render(<NotYetAvailable what="Orders" />)
  expect(screen.getByText("Orders aren't in this build yet.")).toBeTruthy()
  expect(screen.getByText('They arrive in the next update.')).toBeTruthy()
})

describe('StatusBadges', () => {
  beforeEach(() => mockedTheme.mockReturnValue(buildTheme('dark')))

  test('http, polling, logged out and analyze show all four, in order', async () => {
    await render(
      <StatusBadges
        transport="http"
        feed="polling"
        brokerSession="logged_out"
        analyzer="analyze"
      />,
    )
    const ids = ['badge-http', 'badge-polling', 'badge-broker', 'mode-badge']
    for (const id of ids) expect(screen.getByTestId(id)).toBeTruthy()
    expect(screen.getByText('Not encrypted')).toBeTruthy()
    expect(screen.getByText('ANALYZE')).toBeTruthy()
    const order = screen.getAllByTestId(/^(badge-|mode-badge)/).map((n) => n.props.testID)
    expect(order).toEqual(ids)
  })

  test('mode={false} leaves the mode to a header that shows it: the other badges stay', async () => {
    await render(
      <StatusBadges
        transport="http"
        feed="polling"
        brokerSession="logged_out"
        analyzer="live"
        mode={false}
      />,
    )
    expect(screen.queryByTestId('mode-badge')).toBeNull()
    expect(screen.queryByText('LIVE')).toBeNull()
    for (const id of ['badge-http', 'badge-polling', 'badge-broker']) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }
  })

  test('https, live, active and live shows only LIVE', async () => {
    await render(
      <StatusBadges transport="https" feed="live" brokerSession="active" analyzer="live" />,
    )
    expect(screen.getByText('LIVE')).toBeTruthy()
    expect(screen.queryByTestId('badge-http')).toBeNull()
    expect(screen.queryByTestId('badge-polling')).toBeNull()
    expect(screen.queryByTestId('badge-broker')).toBeNull()
  })

  test('an unknown mode shows a dash', async () => {
    await render(
      <StatusBadges transport="https" feed="idle" brokerSession="unknown" analyzer="unknown" />,
    )
    expect(screen.getByText('—')).toBeTruthy()
  })
})
