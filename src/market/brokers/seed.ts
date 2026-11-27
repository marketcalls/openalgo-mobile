// The broker capabilities a tool page's startup call expects, built on the phone from the
// generated plugin map and the server version's accepted exchanges (the app never calls the
// web's session route /api/broker/capabilities).
import { searchExchanges } from '../instruments/exchanges'
import { FALLBACK_EXCHANGES } from '../tools/registry'
import { BROKERS } from './registry'

export type BrokerCaps = {
  broker_name: string
  broker_type: 'IN_stock' | 'crypto'
  supported_exchanges: string[]
  leverage_config: boolean
}

/**
 * The plugin's exchanges the server version accepts, in the plugin's order. An unknown or missing
 * broker gets the web's fallback list under the same filter.
 */
export function brokerCaps(broker: string | null, version: string | null): BrokerCaps {
  const accepted = new Set(searchExchanges(version))
  const plugin = broker ? BROKERS[broker.toLowerCase()] : undefined
  const exchanges = plugin ? plugin.exchanges : FALLBACK_EXCHANGES
  return {
    broker_name: broker ?? '',
    broker_type: plugin?.type ?? 'IN_stock',
    supported_exchanges: exchanges.filter((e) => accepted.has(e)),
    leverage_config: plugin?.leverage ?? false,
  }
}
