import { DEFAULT_UNDERLYINGS, FALLBACK_EXCHANGES, TOOLS } from '../tools/registry'
import { BROKERS } from './registry'
import { brokerCaps } from './seed'

describe('brokerCaps', () => {
  test('filters to what the server version accepts', () => {
    expect(brokerCaps('zerodha', '2.0.0.0').supported_exchanges).not.toContain('NCO')
    expect(brokerCaps('zerodha', '2.0.3.5').supported_exchanges).toContain('NCO')
    expect(brokerCaps('zerodha', '2.0.3.5').supported_exchanges).toContain('GLOBAL_INDEX')
    expect(brokerCaps('zerodha', '2.0.0.0').supported_exchanges.slice(0, 3)).toEqual([
      'NSE',
      'BSE',
      'NFO',
    ])
  })

  test('zerodha is IN_stock without leverage', () => {
    expect(brokerCaps('zerodha', '2.0.3.5')).toMatchObject({
      broker_name: 'zerodha',
      broker_type: 'IN_stock',
      leverage_config: false,
    })
  })

  test('an unknown broker gets the web fallback, filtered the same way', () => {
    expect(brokerCaps('nobroker', '2.0.3.5').supported_exchanges).toEqual([...FALLBACK_EXCHANGES])
    expect(brokerCaps(null, '2.0.0.0').supported_exchanges).toEqual(
      FALLBACK_EXCHANGES.filter((e) => e !== 'CRYPTO'),
    )
    expect(brokerCaps(null, null).broker_type).toBe('IN_stock')
  })

  test('a crypto broker keeps CRYPTO only from 2.0.0.1', () => {
    const name = Object.keys(BROKERS).find((n) => BROKERS[n]?.type === 'crypto')
    expect(name).toBeDefined()
    expect(brokerCaps(name ?? '', '2.0.0.0').supported_exchanges).not.toContain('CRYPTO')
    expect(brokerCaps(name ?? '', '2.0.3.5').supported_exchanges).toContain('CRYPTO')
  })
})

describe('generated registries', () => {
  test('20 tools, the web underlyings', () => {
    expect(TOOLS).toHaveLength(20)
    expect(TOOLS[0]?.id).toBe('strategybuilder')
    expect(DEFAULT_UNDERLYINGS.NFO).toEqual(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'])
  })
})
