// What every tool entry does (design 7.7, 7.8), shared by the three 'use dom' files: the bridge
// client and its imperative handle, the network shims, link guard and download hand-off in place
// before any page code runs, CSP violations reported, then 'loaded'. On tool.init the stores are
// seeded and the shell renders; two frames after that first commit the page is ready.
import { useDOMImperativeHandle } from 'expo/dom'
import { type JSX, useEffect, useMemo, useRef, useState } from 'react'
import {
  type DomEntryProps,
  type DomEvent,
  type JSONValue,
  TOOL_PAGE_IDS,
  TOOL_TOPICS,
  type ToolDomProps,
  type ToolInit,
} from '~/dom/bridge/protocol'
import { createDomClient } from '~/dom/web/client'
import { probeCsp } from '~/dom/web/csp'
import { installDownloads } from '~/dom/web/downloads'
import { guardLinks } from '~/dom/web/links'
import { installNetworkShims } from '~/dom/web/network'
import { probeWebGl } from '~/dom/web/webgl'
import { createLayoutProbe, type LayoutProbe } from './layoutProbe'
import { TOOL_MARKER } from './marker'
import type { PageSet } from './pages'
import { seedStores } from './seed'
import { type ShellHost, ToolShell } from './shell'

/** A page's life reports at most this many CSP violations. */
const MAX_VIOLATIONS = 20
/** The bridge's caps (dom/bridge/schemas.ts, native only). */
const MAX_DIRECTIVE = 64
/** The host csp.ts probes with: its refusal is the CSP working, not a violation. */
const PROBE_HOST = 'csp-probe.invalid'
const BAD_INIT = "openalgo-mobile: tool.init is not this page's ToolInit"
const ignore = () => {}

export type ToolEntryProps = ToolDomProps &
  DomEntryProps & {
    pages: PageSet
    /** `oa-entry:<path>`, the literal the preview manifest finds the entry's page by. */
    entry: string
  }

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/** The fields of tool.init the page reads before it seeds anything. */
function isToolInit(x: unknown): x is ToolInit {
  if (!isObj(x) || !(TOOL_PAGE_IDS as readonly unknown[]).includes(x.page) || !isObj(x.seed)) {
    return false
  }
  const { broker, capabilities: c } = x.seed
  return (
    (broker === null || typeof broker === 'string') &&
    isObj(c) &&
    typeof c.broker_name === 'string' &&
    (c.broker_type === 'IN_stock' || c.broker_type === 'crypto') &&
    Array.isArray(c.supported_exchanges) &&
    c.supported_exchanges.every((e) => typeof e === 'string') &&
    typeof c.leverage_config === 'boolean'
  )
}

/** Two frames: the first paints the page, the second runs after that paint. */
const twoFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

/** Each CSP violation the page sees as an event with its directive (never the blocked URL). */
function reportViolations(win: Window, send: (e: DomEvent) => void): () => void {
  let count = 0
  const onViolation = (e: Event) => {
    const v = e as Partial<SecurityPolicyViolationEvent>
    if (String(v.blockedURI ?? '').includes(PROBE_HOST) || count >= MAX_VIOLATIONS) return
    count += 1
    const directive = String(v.effectiveDirective ?? v.violatedDirective ?? '')
    send({ v: 1, kind: 'event', name: 'violation', directive: directive.slice(0, MAX_DIRECTIVE) })
  }
  win.addEventListener('securitypolicyviolation', onViolation)
  return () => win.removeEventListener('securitypolicyviolation', onViolation)
}

export function ToolEntry({
  scheme,
  page,
  reduceMotion,
  bridge,
  ref,
  pages,
  entry,
}: ToolEntryProps): JSX.Element | null {
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  const schemeRef = useRef(scheme)
  schemeRef.current = scheme
  const expected = useRef({ page, pages })
  expected.current = { page, pages }
  const [client] = useState(() => createDomClient((m: JSONValue) => bridgeRef.current(m)))
  const [init, setInit] = useState<ToolInit | null>(null)
  const initRef = useRef<ToolInit | null>(null)
  const probeRef = useRef<LayoutProbe | null>(null)

  useDOMImperativeHandle(ref ?? null, () => ({ deliver: client.deliver }), [client])

  const send = useMemo(() => (e: DomEvent) => void client.call(e).catch(ignore), [client])
  const host = useMemo<ShellHost>(
    () => ({
      send(e) {
        send(e)
        // a new route lays out anew: measure it
        if (e.name === 'route') probeRef.current?.start()
      },
      onPush: client.onPush,
    }),
    [client, send],
  )

  // Declared after the handle, so its registration reaches native before 'loaded' does (as on
  // the chart, preflight conflict 12 of plan D).
  useEffect(() => {
    document.title = TOOL_MARKER
    document.documentElement.dataset.oaEntry = entry
    // First, before any page code adds a listener of its own (links.ts).
    const stopLinks = guardLinks(document, (url) =>
      send({ v: 1, kind: 'event', name: 'link', url }),
    )
    installNetworkShims(window, client)
    const stopDownloads = installDownloads(window, (intent) => {
      void client.call({ v: 1, kind: 'intent', intent }).catch(ignore)
    })
    const stopViolations = reportViolations(window, send)
    const probe = createLayoutProbe(window, (overflow) =>
      send({ v: 1, kind: 'event', name: 'layout', overflow }),
    )
    probeRef.current = probe
    const offInit = client.onPush(TOOL_TOPICS.init, (p) => {
      if (initRef.current !== null) return
      const want = expected.current
      if (!isToolInit(p) || p.page !== want.page || want.pages[p.page] === undefined) {
        send({ v: 1, kind: 'event', name: 'error', message: BAD_INIT, load: true })
        return
      }
      initRef.current = p
      // Seeded before the shell's first render: a page never reads an empty store.
      seedStores(p.seed, schemeRef.current, p.page)
      setInit(p)
    })
    send({ v: 1, kind: 'event', name: 'loaded' })
    return () => {
      offInit()
      probe.stop()
      probeRef.current = null
      stopViolations()
      stopDownloads()
      stopLinks()
    }
  }, [client, entry, send])

  useEffect(() => {
    if (init === null) return
    let live = true
    twoFrames()
      .then(() => (live ? probeCsp(window) : null))
      .then((csp) => {
        if (csp === null || !live) return
        const info = { page: init.page, csp, webgl: probeWebGl(document) }
        send({ v: 1, kind: 'event', name: 'toolReady', info })
        probeRef.current?.start()
      }, ignore)
    return () => {
      live = false
    }
  }, [init, send])

  if (init === null) return null
  return (
    <ToolShell
      page={init.page}
      pages={pages}
      seed={init.seed}
      scheme={scheme}
      reduceMotion={reduceMotion}
      host={host}
    />
  )
}
