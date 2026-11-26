/** Where the live feed stands (design 7.3). The connection store holds it for the UI. */
export type FeedState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'live'
  | 'reconnecting'
  | 'polling'
  | 'broker_logged_out'
  | 'key_invalid'
  | 'stopped'
