// ToolShell, the provider shell a tool page renders in by default (design 7.8; ux-bar T11): what the
// web's App and Providers give a page, a query client and a router at the tool's path, around the
// shell shellCore.tsx holds. An entry whose pages use no router or query hook mounts BareToolShell
// (shellCore.tsx) instead, so that neither package is in its bundle (design 17.6; ruling 12a).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type JSX, type ReactNode, useState } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { ShellCore, type ShellFrame, type ShellLocation, type ToolShellProps } from './shellCore'

export {
  FALLBACK_BODY,
  FALLBACK_TITLE,
  type ShellHost,
  type ToolShellProps,
} from './shellCore'

/** The router's location, as the shell's routes read it. */
function RouterLocation({ children }: { children: (at: ShellLocation) => ReactNode }): ReactNode {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return children({ pathname, navigate })
}

/** QueryClientProvider (retry 0, staleTime 60_000, refetchOnWindowFocus false) > MemoryRouter. */
function RouterFrame({ path, children }: Parameters<ShellFrame>[0]): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 0, staleTime: 60_000, refetchOnWindowFocus: false } },
      }),
  )
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <RouterLocation>{children}</RouterLocation>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

/** The shell with the web's providers: QueryClientProvider > MemoryRouter initialEntries [path]. */
export function ToolShell(p: ToolShellProps): JSX.Element {
  return <ShellCore {...p} frame={RouterFrame} />
}
