// No link navigates the page (design 7.7: links open in the system browser). Every click on a link
// is cancelled before any of the page's own handlers can stop it; an https link goes to native,
// which opens only https. Everything else is cancelled in the page with no bridge message: http,
// javascript:, data: and every other scheme, and a relative link, which resolves to the bundle's
// own file:// URL.

function httpsUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Guards `doc`'s links until the returned function is called.
 *
 *  The guard listens on the window in the capture phase, the first stop of every click, so no
 *  handler on the document or below can stop the click before the guard sees it, and a window
 *  listener's stopPropagation leaves the guard running. Only a window capture listener added
 *  before the guard could skip it, with stopImmediatePropagation: the page installs the guard
 *  before its other code adds listeners. */
export function guardLinks(doc: Document, onLink: (url: string) => void): () => void {
  const onClick = (e: Event) => {
    const target = e.target as Element | null
    const link = typeof target?.closest === 'function' ? target.closest('a[href]') : null
    if (link === null) return
    e.preventDefault()
    const url = httpsUrl(link.getAttribute('href') ?? '', doc.baseURI)
    if (url !== null) onLink(url)
  }
  // A document with no window (one made by DOMParser) navigates nothing; guard it all the same.
  const at: EventTarget = doc.defaultView ?? doc
  at.addEventListener('click', onClick, true)
  return () => at.removeEventListener('click', onClick, true)
}
