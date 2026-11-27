// Web preview only: the stand-in for a 'use dom' entry in the web build, so the pages can be
// checked at 360 px in a desktop browser (design 7.7 "Phone layout"). Only `*.web.tsx` modules
// import it, and Metro bundles those for platform web only, so no android or ios bundle contains
// it, and no DOM bundle either (no 'use dom' file imports it). Release size impact: zero.
//
// Why not render the entry itself, as expo does on web: it would run inline in the app's own
// document, where its prelude's CSP (connect-src 'none'), its shims for fetch, XHR and WebSocket,
// and its Tailwind stylesheet would take over the app. Merely importing it installs the CSP. So the
// preview never imports the entry: it loads the entry's exported page (www.bundle/<md5>.html, the
// very file the APK ships, from an `expo export --platform android`, served as its .frame.html
// copy with the bridge boot first) into a same-origin iframe and speaks expo's DOM protocol (expo/src/dom, SDK 58.1) to it, as the native WebView does:
//   page → host: window.ReactNativeWebView.postMessage, injectedObjectJson;
//   host → page: '$$dom_event' CustomEvents, and window._domRefProxy for the imperative handle.
// The page keeps its own document, CSP, shims and viewport, sized like the WebView.
import { type JSX, type Ref, useEffect, useMemo, useRef, useState } from 'react'
import type { DomEntryProps, DomHandle, JSONValue } from './protocol'

type Bridge = { postMessage(raw: string): void; injectedObjectJson(): string }
type FrameWindow = Window & {
  _domRefProxy?: Record<string, (...args: unknown[]) => void>
  CustomEvent: typeof CustomEvent
  JSON: JSON
}
type Host = Window & { __oaDomFrames?: Record<string, Bridge> }
type Msg = {
  type: string
  data: { uid?: string; actionId?: string; args?: JSONValue[] } | string[] | null
}

/** What dom-manifest.mjs names each page's served copy, and the query its boot reads the frame's
 *  id from (both dev/preview/dom-manifest.mjs). */
const FRAME_SUFFIX = '.frame.html'
const FRAME_PARAM = 'oaframe'

/** Written by the preview recipe (dom-manifest.mjs): entry path → its html in www.bundle. */
const MANIFEST = '/www.bundle/entries.json'
let manifest: Promise<Record<string, string>> | null = null
function loadManifest(): Promise<Record<string, string>> {
  manifest ??= fetch(MANIFEST, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`${MANIFEST}: HTTP ${r.status}`)
    return r.json() as Promise<Record<string, string>>
  })
  return manifest
}

let frames = 0
const copyInto = (w: FrameWindow, x: unknown) => w.JSON.parse(JSON.stringify(x ?? null))

export type WebEntryProps = DomEntryProps & {
  /** The 'use dom' file from the project root, e.g. 'src/dom/chart/ChartDom.tsx'. */
  entry: string
  [prop: string]: unknown
}

/** Hosts the exported page of `entry` in an iframe; the other props are the page's props. */
export function WebEntry({ entry, bridge, dom: _dom, ref, ...page }: WebEntryProps): JSX.Element {
  const id = useMemo(() => `oa-dom-${++frames}`, [])
  const frame = useRef<HTMLIFrameElement>(null)
  const [doc, setDoc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const json = JSON.stringify(page)
  const latest = useRef({ json, bridge, ref })
  latest.current = { json, bridge, ref }

  // Host → page, as expo's getInjectEventScript does: a '$$dom_event' carrying a JSON copy.
  const emit = useMemo(
    () => (detail: unknown) => {
      const w = frame.current?.contentWindow as FrameWindow | null | undefined
      if (w) w.dispatchEvent(new w.CustomEvent('$$dom_event', { detail: copyInto(w, detail) }))
    },
    [],
  )

  useEffect(() => {
    const props = () => ({ names: ['bridge'], props: JSON.parse(latest.current.json) })
    const host = window as Host
    host.__oaDomFrames ??= {}
    host.__oaDomFrames[id] = {
      injectedObjectJson: () =>
        JSON.stringify({ EXPO_DOM_HOST_OS: 'android', initialProps: props() }),
      postMessage(raw: string) {
        const { type, data } = JSON.parse(raw) as Msg
        if (type === '$$dom_ready') emit({ type: '$$props', data: props() })
        else if (type === '$$register_dom_imperative_handle_props' && Array.isArray(data)) {
          // Expo's proxy calls the page through injectJavaScript: later, with JSON copies.
          const handle: Record<string, (...args: unknown[]) => void> = {}
          for (const name of data) {
            handle[name] = (...args) =>
              setTimeout(() => {
                const w = frame.current?.contentWindow as FrameWindow | null | undefined
                w?._domRefProxy?.[name]?.(...args.map((a) => copyInto(w, a)))
              }, 0)
          }
          const r = latest.current.ref as Ref<DomHandle> | undefined
          if (r && typeof r === 'object') (r as { current: unknown }).current = handle
        } else if (type === '$$native_action' && data && !Array.isArray(data)) {
          const reply = (r: object) =>
            emit({
              type: '$$native_action_result',
              data: { uid: data.uid, actionId: data.actionId, ...r },
            })
          if (data.actionId !== 'bridge') return reply({ error: { message: 'unknown action' } })
          Promise.resolve()
            .then(() => latest.current.bridge((data.args ?? [null])[0] as JSONValue))
            .then(
              (result) => reply({ result }),
              (e: unknown) =>
                reply({ error: { message: e instanceof Error ? e.message : String(e) } }),
            )
        }
      },
    }
    return () => {
      delete host.__oaDomFrames?.[id]
    }
  }, [id, emit])

  // Props after the first load reach the page as '$$props', as on the phone.
  useEffect(() => {
    emit({ type: '$$props', data: { names: ['bridge'], props: JSON.parse(json) } })
  }, [json, emit])

  useEffect(() => {
    let live = true
    loadManifest()
      .then((m) => {
        const file = m[entry]
        if (!file) throw new Error(`${entry} is not in ${MANIFEST}`)
        // A served copy of the page with the bridge boot first (dom-manifest.mjs writes it): a
        // srcdoc page's location is about:srcdoc, against which the frontend's axios cannot
        // resolve a relative URL, so every option tool's request failed in the preview.
        const frame = file.replace(/\.html$/, FRAME_SUFFIX)
        if (live) setDoc(`/www.bundle/${frame}?${FRAME_PARAM}=${encodeURIComponent(id)}`)
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [entry, id])

  if (error !== null) {
    // biome-ignore lint/correctness/noReactNativeRawText: a web-only DOM element, not a RN view
    return <div style={{ color: '#e7000b', padding: 16 }}>DOM preview: {error}</div>
  }
  if (doc === null) return <div style={{ flex: 1 }} />
  return (
    <iframe
      ref={frame}
      title={entry}
      src={doc}
      style={{
        flex: 1,
        width: '100%',
        height: '100%',
        minHeight: 0,
        border: 0,
        display: 'block',
      }}
    />
  )
}
