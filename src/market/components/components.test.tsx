import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { BrokerBanner, QUEUED_COPY, SEMI_AUTO_COPY, SemiAutoBanner } from './SessionBanners'
import { StaleNote } from './StaleNote'

const ORIGIN = 'https://algo.example.com'

beforeEach(() => {
  useConnection.getState().reset()
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
})
afterEach(() => jest.restoreAllMocks())

const setup = () => {
  const check = jest.fn(async () => {})
  const services = {
    broker: { check },
    profile: { get: () => ({ id: 'p1', restOrigin: `${ORIGIN}/`, broker: 'zerodha' }) },
  } as unknown as Services
  const ui = (node: React.ReactElement) => (
    <ServicesProvider value={services}>{node}</ServicesProvider>
  )
  return { check, ui }
}

describe('BrokerBanner', () => {
  test('shows nothing while the broker session is not logged out', async () => {
    const h = setup()
    await render(h.ui(<BrokerBanner />))
    expect(screen.queryByTestId('banner-broker')).toBeNull()
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    expect(screen.queryByTestId('banner-broker')).toBeNull()
  })

  test('logged out: the A-T7 copy; log in opens {origin}/login, check again asks the broker', async () => {
    const h = setup()
    useConnection.getState().set({ brokerSession: 'logged_out' })
    await render(h.ui(<BrokerBanner />))
    expect(screen.getByTestId('banner-broker')).toHaveTextContent(
      /Your broker session has ended\. Log in to your broker on the OpenAlgo web\./,
    )
    await fireEvent.press(screen.getByTestId('broker-banner-login'))
    expect(Linking.openURL).toHaveBeenCalledWith(`${ORIGIN}/login`)
    expect(h.check).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByTestId('broker-banner-recheck'))
    expect(h.check).toHaveBeenCalledTimes(1)
    // Account's own button keeps its id (ruling 9).
    expect(screen.queryByTestId('broker-login')).toBeNull()
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    expect(screen.queryByTestId('banner-broker')).toBeNull()
  })
})

describe('SemiAutoBanner', () => {
  test('shows once Semi-Auto has been seen, and opens the web Action Center', async () => {
    const h = setup()
    await render(h.ui(<SemiAutoBanner />))
    expect(screen.queryByTestId('banner-semi-auto')).toBeNull()
    await act(async () => useConnection.getState().set({ semiAutoSeen: true }))
    expect(screen.getByTestId('banner-semi-auto')).toHaveTextContent(
      /Orders need approval in the web Action Center/,
    )
    await fireEvent.press(screen.getByTestId('open-action-center'))
    expect(Linking.openURL).toHaveBeenCalledWith(`${ORIGIN}/action-center`)
  })

  test('the shared copy', () => {
    expect(SEMI_AUTO_COPY).toBe('Orders need approval in the web Action Center')
    expect(QUEUED_COPY).toBe('Queued for approval in the web Action Center')
  })
})

describe('StaleNote', () => {
  test('says when the data was last updated, in IST', async () => {
    // 09:02:05 UTC is 14:32:05 IST, whatever the device zone.
    await render(<StaleNote at={Date.UTC(2026, 10, 24, 9, 2, 5)} />)
    expect(screen.getByTestId('stale-note')).toHaveTextContent('Last updated 14:32:05')
  })

  test('pads each part to two digits', async () => {
    // 21:31:02 UTC is 03:01:02 IST the next day.
    await render(<StaleNote at={Date.UTC(2026, 10, 24, 21, 31, 2)} />)
    expect(screen.getByTestId('stale-note')).toHaveTextContent('Last updated 03:01:02')
  })
})
