// No link navigates the page (design 7.7: links open in the system browser). Every click on a link
// is cancelled before the page's own handlers run; a web link goes to native, which opens only
// https. A relative link resolves to the bundle's own file:// URL and is dropped, as are
// javascript:, data: and every other scheme.

const WEB = new Set(['https:', 'http:'])

function webUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    return WEB.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** Guards `doc`'s links until the returned function is called. */
export function guardLinks(doc: Document, onLink: (url: string) => void): () => void {
  const onClick = (e: Event) => {
    const target = e.target as Element | null
    const link = typeof target?.closest === 'function' ? target.closest('a[href]') : null
    if (link === null) return
    e.preventDefault()
    const url = webUrl(link.getAttribute('href') ?? '', doc.baseURI)
    if (url !== null) onLink(url)
  }
  doc.addEventListener('click', onClick, true)
  return () => doc.removeEventListener('click', onClick, true)
}
