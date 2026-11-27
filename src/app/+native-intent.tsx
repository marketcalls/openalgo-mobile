// Expo Router calls redirectSystemPath for every link from outside the app: the initial URL of a
// cold start and each link that comes while it runs (deep links, and app or universal links).
// router.push inside the app never comes here. A link to an order screen, or to any route that is
// not a known screen, is refused; every other link comes back as the plain path the router reads
// from it, which it routes as it is (linkGuard).
import { guardOutsideLink, LINK_ORDER_REFUSED } from '~/market/linkGuard'
import { toast } from '~/ui/Toast'

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const link = guardOutsideLink(path)
  if (link.refused) {
    // a throw here could crash the app at start: the toast is only a courtesy
    try {
      toast(LINK_ORDER_REFUSED)
    } catch {}
  }
  return link.path
}
