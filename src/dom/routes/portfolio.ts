// The Strategy Portfolio's shapes are the frontend's (api/strategy-portfolio.ts): the page reads
// what the store holds as its own PortfolioEntry and sends its own PortfolioSavePayload. These
// assertions fail the typecheck when the schemas' outputs stop being assignable to them.
import type {
  PortfolioEntry as FrontendEntry,
  PortfolioSavePayload as FrontendSavePayload,
} from '@/api/strategy-portfolio'
import type { PortfolioEntry, PortfolioSavePayload } from '~/market/strategies/schemas'

export const entryIsFrontends = (e: PortfolioEntry) => e satisfies FrontendEntry
export const payloadIsFrontends = (p: PortfolioSavePayload) => p satisfies FrontendSavePayload
