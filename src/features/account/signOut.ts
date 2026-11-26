// Sign out (design 7.2): the key goes, the server profile stays, so the address is prefilled
// and the id is reused when the user signs in again.
import { clearProfileCache } from '~/core/query/invalidate'
import { useConnection } from '~/core/services/connection'
import { disposeServices, type Services, useSession } from '~/core/services/services'

export async function signOut(s: Services, o: { deleteUserContent: boolean }): Promise<void> {
  const pid = s.profile.get().id
  await s.vault.wipe()
  await s.storage.clearAll({ keepUserContent: !o.deleteUserContent })
  clearProfileCache(s.queryClient, pid)
  disposeServices(s)
  useConnection.getState().reset()
  useSession.getState().set({ status: 'onboarding' })
}
