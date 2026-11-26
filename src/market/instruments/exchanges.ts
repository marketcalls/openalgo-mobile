// Exchange rules: the accepted set per server version (C2) and the ticket rules (C9,
// frontend/src/lib/trading/terminal.ts:891-905).
import { atLeast } from '~/core/config/version'
import type { Product } from '../types'

/** Exchanges that show a price and nothing else: no ladder, no ticket. */
export const QUOTE_ONLY: ReadonlySet<string> = new Set([
  'NSE_INDEX',
  'BSE_INDEX',
  'MCX_INDEX',
  'GLOBAL_INDEX',
])

/** Quantity is entered in lots here, and the products are MIS and NRML. */
export const DERIVATIVE_EXCHANGES: ReadonlySet<string> = new Set([
  'NFO',
  'BFO',
  'CDS',
  'BCD',
  'MCX',
  'NCO',
  'NCDEX',
  'CRYPTO',
])

export const isQuoteOnly = (ex: string): boolean => QUOTE_ONLY.has(ex)
/** The section label for an exchange: the index exchanges share one. */
export const exchangeLabel = (ex: string): string => (isQuoteOnly(ex) ? 'INDICES' : ex)
export const usesLots = (ex: string): boolean => DERIVATIVE_EXCHANGES.has(ex)

export const productOptionsFor = (ex: string): Product[] =>
  usesLots(ex) ? ['MIS', 'NRML'] : ['MIS', 'CNC']

export const defaultProduct = (ex: string): Product => (usesLots(ex) ? 'NRML' : 'CNC')

// utils/constants.py:52-67, from 2.0.0.0.
const BASE = ['NSE', 'NFO', 'CDS', 'BSE', 'BFO', 'BCD', 'MCX', 'NCDEX', 'NSE_INDEX', 'BSE_INDEX']

/** Every exchange any supported server version accepts. */
export const ALL_EXCHANGES: readonly string[] = [
  ...BASE,
  'CRYPTO',
  'NCO',
  'MCX_INDEX',
  'GLOBAL_INDEX',
]

/** The exchanges a server accepts: 2.0.0.1 adds CRYPTO, 2.0.1.0 adds NCO and two indices. */
export function searchExchanges(version: string | null): string[] {
  const out = [...BASE]
  if (atLeast(version, '2.0.0.1')) out.push('CRYPTO')
  if (atLeast(version, '2.0.1.0')) out.push('NCO', 'MCX_INDEX', 'GLOBAL_INDEX')
  return out
}
