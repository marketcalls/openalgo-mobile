import { EmptyState } from './EmptyState'

export function NotYetAvailable({ what }: { what: string }) {
  return (
    <EmptyState
      title={`${what} aren't in this build yet.`}
      body="They arrive in the next update."
    />
  )
}
