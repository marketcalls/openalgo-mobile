// The Option Chain feature (design 7.8, 17.4): the native chain screen, the links it opens from,
// and the ticket a leg's BUY or SELL opens. Plan F builds on the same pieces.
export {
  CHAIN_LINK_INCOMPLETE,
  type ChainTarget,
  legTicket,
  optionChainQuery,
  targetFromKey,
  targetFromU,
} from './model'
export { ChainLinkIncomplete, OptionChainScreen } from './screens/OptionChainScreen'
