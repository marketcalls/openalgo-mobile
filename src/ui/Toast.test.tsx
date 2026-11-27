import { act, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Platform } from 'react-native'
import { LONG_TOAST_MS, TOAST_MS, ToastHost, toast } from './Toast'

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

  test('a long message stays 4 s and wraps rather than being cut to one line', async () => {
    await render(<ToastHost />)
    const long = 'Close may have gone through: checking positions. This can take a while.'
    await act(async () => toast(long))
    expect(screen.getByText(long).props.numberOfLines).toBeGreaterThan(1)
    await act(async () => jest.advanceTimersByTime(LONG_TOAST_MS - 1))
    expect(screen.getByTestId('toast')).toBeOnTheScreen()
    await act(async () => jest.advanceTimersByTime(1))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  // A link refused at a cold start toasts before the unlock prompt is answered (+native-intent).
  test('a held host (the app is locked) keeps the toast, then shows it for its full time', async () => {
    const view = await render(<ToastHost hold />)
    await act(async () => toast('Orders cannot open from here'))
    await act(async () => jest.advanceTimersByTime(TOAST_MS * 5))
    expect(screen.queryByTestId('toast')).toBeNull()
    await view.rerender(<ToastHost hold={false} />)
    expect(screen.getByTestId('toast')).toHaveTextContent('Orders cannot open from here')
    await act(async () => jest.advanceTimersByTime(TOAST_MS - 1))
    expect(screen.getByTestId('toast')).toBeOnTheScreen()
    await act(async () => jest.advanceTimersByTime(1))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('VoiceOver hears it: iOS announces each toast, Android reads the live region', async () => {
    const say = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {})
    try {
      const os = jest.replaceProperty(Platform, 'OS', 'ios')
      toast('Position is closed')
      expect(say).toHaveBeenCalledWith('Position is closed')
      os.replaceValue('android')
      toast('Order cancelled')
      expect(say).not.toHaveBeenCalledWith('Order cancelled')
    } finally {
      jest.restoreAllMocks()
    }
  })
})
