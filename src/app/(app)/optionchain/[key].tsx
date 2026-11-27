import { useLocalSearchParams } from 'expo-router'
import { ChainLinkIncomplete, OptionChainScreen, targetFromKey } from '~/features/optionchain'

/** The chain of an underlying, by its quote key (`NSE_INDEX:NIFTY`), as optionChainHref links it. */
export default function OptionChainRoute() {
  const { key } = useLocalSearchParams<{ key: string }>()
  const target = targetFromKey(key ?? '')
  if (!target) return <ChainLinkIncomplete />
  return (
    <OptionChainScreen key={`${target.optionsExchange}:${target.underlying}`} initial={target} />
  )
}
