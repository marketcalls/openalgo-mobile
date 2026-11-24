import { act, render, screen } from '@testing-library/react-native'
import { TOAST_MS, ToastHost, toast } from './Toast'

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('Toast', () => {
  test('shows one line for 2 s, then goes', async () => {
    await render(<ToastHost />)
    expect(screen.queryByTestId('toast')).toBeNull()
    await act(async () => toast('Added ITC to Watchlist'))
    expect(screen.getByTestId('toast')).toHaveTextContent('Added ITC to Watchlist')
    await act(async () => jest.advanceTimersByTime(TOAST_MS - 1))
    expect(screen.getByTestId('toast')).toBeOnTheScreen()
    await act(async () => jest.advanceTimersByTime(1))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('a newer toast replaces the text and restarts the 2 s', async () => {
    await render(<ToastHost />)
    await act(async () => toast('first'))
    await act(async () => jest.advanceTimersByTime(1500))
    await act(async () => toast('second'))
    await act(async () => jest.advanceTimersByTime(1500))
    expect(screen.getByTestId('toast')).toHaveTextContent('second')
    await act(async () => jest.advanceTimersByTime(500))
    expect(screen.queryByTestId('toast')).toBeNull()
  })
})
