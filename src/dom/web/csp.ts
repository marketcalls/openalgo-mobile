// The Content Security Policy every DOM bundle runs under (design 7.7). The bridge carries fetch
// and the socket, so the page itself reaches no network: images, fonts and styles come from the
// bundle or data:/blob: URLs, and nothing connects anywhere. Installed as a <meta> by the prelude,
// before any other module loads; the page reports `probeCsp` in its ready event.

export const DOM_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; " +
  "form-action 'none'; base-uri 'none'"

/** Dev builds only (the prelude picks it under `__DEV__`, which a release build inlines as false):
 *  Metro serves the page and talks to it over the page's own origin, and both Metro's HMR client
 *  (metro-runtime HMRClient.js) and Expo's dev split-bundle loader (fetchThenEvalJs) run the code
 *  they fetch with eval. The release policy allows neither. */
export const DOM_CSP_DEV = DOM_CSP.replace(
  "script-src 'self'",
  "script-src 'self' 'unsafe-eval'",
).replace("connect-src 'none'", "connect-src 'self'")

const HTTP_EQUIV = 'Content-Security-Policy'
const PROBE_URL = 'https://csp-probe.invalid/p.png'
const PROBE_MS = 1000

/** Puts the policy first in <head>. A second call finds the same element: a policy cannot be
 *  loosened once a page holds it, so there is nothing to update. */
export function installCsp(doc: Document, dev: boolean): HTMLMetaElement {
  const policy = dev ? DOM_CSP_DEV : DOM_CSP
  const head = doc.head
  for (const m of Array.from(head.querySelectorAll<HTMLMetaElement>('meta[http-equiv]'))) {
    if (m.httpEquiv === HTTP_EQUIV && m.content === policy) return m
  }
  const meta = doc.createElement('meta')
  meta.httpEquiv = HTTP_EQUIV
  meta.content = policy
  head.insertBefore(meta, head.firstChild)
  return meta
}

/** Whether the page enforces a policy: an image from a host no policy of ours allows must be
 *  refused. True on the violation; false if none comes within `timeoutMs`. */
export function probeCsp(win: Window, timeoutMs: number = PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (enforced: boolean) => {
      win.removeEventListener('securitypolicyviolation', onViolation)
      clearTimeout(timer)
      resolve(enforced)
    }
    const onViolation = () => done(true)
    const timer = setTimeout(() => done(false), timeoutMs)
    win.addEventListener('securitypolicyviolation', onViolation)
    const probe = new (win as typeof window).Image()
    probe.src = PROBE_URL
  })
}
