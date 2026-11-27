// Sign out (design 7.2): the key goes, the server profile stays, so the address is prefilled
// and the id is reused when the user signs in again.
import { log } from '~/core/log/logger'
import { clearProfileCache } from '~/core/query/invalidate'
import { useConnection } from '~/core/services/connection'
import { disposeServices, type Services, useSession } from '~/core/services/services'
import type { Trading } from '~/market/trading'

export async function signOut(
  s: Services,
  trading: Trading,
  o: { deleteUserContent: boolean },
): Promise<void> {
  const pid = s.profile.get().id
  await s.vault.wipe()
  await s.storage.clearAll({ keepUserContent: !o.deleteUserContent })
  // The server's instrument lists: a database that fails here does not keep the user signed in.
  await trading.master.clear().catch((e: unknown) => {
    log.warn('account', 'the symbol master was not cleared', e)
  })
  clearProfileCache(s.queryClient, pid)
  disposeServices(s)
  useConnection.getState().reset()
  useSession.getState().set({ status: 'onboarding' })
}
