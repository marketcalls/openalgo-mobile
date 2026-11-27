// The provider shell every tool page renders in (design 7.8; ux-bar T11): what the web's App and
// Providers give a page (a query client, a router at the tool's path, the alert store's toaster),
// shaped for a phone in a native screen.
// - The root page stays mounted (keep-alive): a results page opens over it, and back returns to the
//   builder with its inputs and scroll position.
// - Native's back and top pushes: back closes an open picker, dialog or tip first, then leaves a
//   results page; otherwise it is native's.
// - A route that fails to render shows a fallback and reports it; the rest of the page goes on.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Component,
  type CSSProperties,
  type JSX,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { Toaster } from 'sonner'
import type { DomEvent, ToolPageId, ToolSeed } from '~/dom/bridge/protocol'
import { installHelpers } from './helpers'
import { type PageSet, TOOL_PUSH_TOPICS, TOOL_ROUTES } from './pages'
import { seedStores } from './seed'
import { useAlertStore } from './stores'

/** How the shell talks to native: the page's events out, native's pushes in. */
export type ShellHost = {
  send(e: DomEvent): void
  onPush(topic: string, fn: (payload: unknown) => void): () => void
}
export type ToolShellProps = {
  page: ToolPageId
  pages: PageSet
  seed: ToolSeed
  scheme: 'dark' | 'light'
  reduceMotion?: boolean
  host?: ShellHost
}

const NO_HOST: ShellHost = { send: () => {}, onPush: () => () => {} }
const MAX_ROUTE = 64
const MAX_PAGE_ERROR = 200

export const FALLBACK_TITLE = "This report couldn't be shown."
export const FALLBACK_BODY = "The server's reply is missing parts this app reads."

/** The open layers back closes before anything else (Radix renders them under <body>). */
const OPEN_LAYER = ['select-content', 'popover-content', 'dialog-content', 'alert-dialog-content']
  .map((slot) => `[data-slot="${slot}"][data-state="open"]`)
  .join(',')

// The web wrapper's toaster colours (components/ui/sonner.tsx), on the page's own tokens.
const TOAST_STYLE = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius)',
} as CSSProperties

const messageOf = (x: unknown): string => (x instanceof Error ? x.message : String(x))

/** Closes the topmost open layer, as Escape does; true when there was one. */
function closeOpenLayer(doc: Document): boolean {
  const tips = Array.from(doc.querySelectorAll('[data-oa-tip]'))
  if (tips.length > 0) {
    for (const tip of tips) tip.remove()
    return true
  }
  if (doc.querySelector(OPEN_LAYER) === null) return false
  // Radix's dismissable layer listens on the document in the capture phase.
  const at = doc.activeElement ?? doc.body
  at.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  )
  return true
}

/**
 * `--oa-vh`: 1% of the WebView's height when the page opens. It changes only with the width (a
 * rotation), so the keyboard, which takes height alone, never resizes a chart (ux-bar T11-07).
 */
function useViewportUnit() {
  useLayoutEffect(() => {
    const html = document.documentElement
    let width = Number.NaN
    const measure = () => {
      if (window.innerWidth === width) return
      width = window.innerWidth
      html.style.setProperty('--oa-vh', `${window.innerHeight / 100}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
}

type BoundaryProps = {
  extra: boolean
  onBack(): void
  onReload(): void
  onError(message: string): void
  children: ReactNode
}

/** One route's page, or its fallback once it has thrown while rendering. */
class RouteBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(messageOf(error).slice(0, MAX_PAGE_ERROR))
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { extra, onBack, onReload } = this.props
    // In the page root's place, so it takes the page's gutter (phone.css).
    return (
      <div data-oa-fallback="" className="p-4">
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border bg-card p-4 text-card-foreground"
        >
          <p className="text-base font-semibold">{FALLBACK_TITLE}</p>
          <p className="text-sm text-muted-foreground">{FALLBACK_BODY}</p>
          <button
            type="button"
            onClick={extra ? onBack : onReload}
            className="inline-flex min-h-11 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium"
          >
            {extra ? 'Back to builder' : 'Reload tool'}
          </button>
        </div>
      </div>
    )
  }
}

function ToolRoutes({ page, pages, host }: { page: ToolPageId; pages: PageSet; host: ShellHost }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const route = TOOL_ROUTES[page]
  const set = pages[page] ?? {}
  const Root = set[route.path]
  const isRoot = pathname === route.path
  const extra = route.extra?.includes(pathname) ? pathname : null
  const Extra = extra === null ? undefined : set[extra]
  const known = isRoot || Extra !== undefined

  const hostRef = useRef(host)
  hostRef.current = host
  const now = useRef({ isRoot, root: route.path })
  now.current = { isRoot, root: route.path }

  // A path the tool does not have (a page's link to the web's / or /login) goes back to its root.
  useEffect(() => {
    if (!known) navigate(route.path, { replace: true })
  }, [known, navigate, route.path])

  useEffect(() => {
    hostRef.current.send({ v: 1, kind: 'event', name: 'route', path: pathname.slice(0, MAX_ROUTE) })
  }, [pathname])

  // Each path's scroll position, kept as the page scrolls: when the root hides, the document
  // shrinks and the browser clamps the position, after the path has already changed here.
  const scrolls = useRef(new Map<string, number>())
  const at = useRef(pathname)
  useEffect(() => {
    const onScroll = () => scrolls.current.set(at.current, window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    if (at.current === pathname) return
    at.current = pathname
    window.scrollTo(0, isRoot ? (scrolls.current.get(pathname) ?? 0) : 0)
  }, [pathname, isRoot])

  useEffect(() => {
    const offBack = host.onPush(TOOL_PUSH_TOPICS.back, () => {
      let handled = closeOpenLayer(document)
      if (!handled && !now.current.isRoot) {
        navigate(now.current.root)
        handled = true
      }
      hostRef.current.send({ v: 1, kind: 'event', name: 'back', handled })
    })
    const offTop = host.onPush(TOOL_PUSH_TOPICS.top, () => window.scrollTo(0, 0))
    return () => {
      offBack()
      offTop()
    }
  }, [host, navigate])

  const boundary = {
    onBack: () => navigate(route.path),
    onReload: () => hostRef.current.send({ v: 1, kind: 'event', name: 'reload' }),
    onError: (message: string) =>
      hostRef.current.send({ v: 1, kind: 'event', name: 'pageError', message }),
  }

  return (
    <main id="oa-tool" className="w-full min-w-0" data-oa-main={isRoot ? '' : undefined}>
      <div data-oa-route="root" hidden={!isRoot}>
        {Root ? (
          <RouteBoundary extra={false} {...boundary}>
            <Root />
          </RouteBoundary>
        ) : null}
      </div>
      {extra !== null && Extra ? (
        <div data-oa-route="extra">
          <RouteBoundary key={extra} extra {...boundary}>
            <Extra />
          </RouteBoundary>
        </div>
      ) : null}
    </main>
  )
}

export function ToolShell({
  page,
  pages,
  seed,
  scheme,
  reduceMotion = false,
  host = NO_HOST,
}: ToolShellProps): JSX.Element {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 0, staleTime: 60_000, refetchOnWindowFocus: false } },
      }),
  )
  // The app's scheme, live: the same seed again keeps the page and its picks (seed.ts).
  useEffect(() => seedStores(seed, scheme, page), [seed, scheme, page])
  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduce-motion', reduceMotion)
  }, [reduceMotion])
  useEffect(() => installHelpers(window), [])
  useViewportUnit()

  const position = useAlertStore((s) => s.position)
  const visibleToasts = useAlertStore((s) => s.maxVisibleToasts)
  const duration = useAlertStore((s) => s.duration)

  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[TOOL_ROUTES[page].path]}>
        <ToolRoutes page={page} pages={pages} host={host} />
      </MemoryRouter>
      <Toaster
        theme={scheme}
        position={position}
        richColors
        visibleToasts={visibleToasts}
        duration={duration}
        closeButton
        style={TOAST_STYLE}
      />
    </QueryClientProvider>
  )
}
