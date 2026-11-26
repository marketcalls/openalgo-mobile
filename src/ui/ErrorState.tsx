import { ApiError, userMessage } from '~/core/http/errors'
import { Button } from './Button'
import { EmptyState } from './EmptyState'

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const text = error instanceof ApiError ? userMessage(error) : 'Something went wrong.'
  return (
    <EmptyState
      title={text}
      action={
        onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : undefined
      }
    />
  )
}
