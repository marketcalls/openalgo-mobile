// A tool page's file downloads, handed to native (design 7.7): the WebView cannot save a file, so
// a page's save (a link with `download` on a blob: URL, clicked) becomes a save intent. The blob
// is the one the page made the URL from: createObjectURL is wrapped to remember it, as long as
// the URL lives. A blob of an unlisted MIME or over MAX_SAVE_BYTES is not saved, and neither is
// the gateway's OPENED_IN_APP answer to a download native has saved itself (the tearsheet).
import { MAX_SAVE_BASE64, OPENED_IN_APP, SAVE_MIMES, type ToolIntent } from '~/dom/bridge/protocol'

/** The largest blob saved: the bytes whose base64 is MAX_SAVE_BASE64 characters (3,000,000). */
export const MAX_SAVE_BYTES = (MAX_SAVE_BASE64 / 4) * 3

type SaveMime = ToolIntent['mime']
const NAME_LENGTH = 128
const FALLBACK_NAME = 'download'

/** The MIME without parameters ('text/csv;charset=utf-8' is text/csv), if it is saved at all. */
function saveMime(type: string): SaveMime | null {
  const essence = type.split(';')[0]?.trim().toLowerCase() ?? ''
  return (SAVE_MIMES as readonly string[]).includes(essence) ? (essence as SaveMime) : null
}

/** A name native keeps as it is (the bridge's ^[A-Za-z0-9._ -]{1,128}$): every other character
 *  becomes '_', and a name with no letter or digit (empty, '.', '..') becomes 'download'. */
function saveName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, NAME_LENGTH)
  return /[A-Za-z0-9]/.test(safe) ? safe : FALLBACK_NAME
}

/** Saves the page's blob links through `onSave` until the returned function is called. Install it
 *  before the page's code runs, so every object URL the page makes is seen. */
export function installDownloads(win: Window, onSave: (i: ToolIntent) => void): () => void {
  const page = win as Window & typeof globalThis
  const urls = page.URL
  const create = urls.createObjectURL
  const revoke = urls.revokeObjectURL
  const blobs = new Map<string, Blob>()
  const opened = page.btoa(OPENED_IN_APP)

  urls.createObjectURL = (obj: Blob | MediaSource): string => {
    const url = create.call(urls, obj)
    if (obj instanceof page.Blob && obj.size <= MAX_SAVE_BYTES) blobs.set(url, obj)
    return url
  }
  urls.revokeObjectURL = (url: string): void => {
    blobs.delete(url)
    revoke.call(urls, url)
  }

  // On the window in the capture phase, as guardLinks (links.ts), which cancels the same click.
  // The blob is taken now: a page may revoke its URL as soon as click() returns.
  const onClick = (e: Event) => {
    const target = e.target as Element | null
    const link = typeof target?.closest === 'function' ? target.closest('a[download]') : null
    const blob = link ? blobs.get(link.getAttribute('href') ?? '') : undefined
    if (link === null || blob === undefined) return
    e.preventDefault()
    const mime = saveMime(blob.type)
    if (mime === null) return
    const name = saveName(link.getAttribute('download') ?? '')
    const reader = new page.FileReader()
    reader.onload = () => {
      // a data: URL, 'data:<type>;base64,<base64>'
      const url = typeof reader.result === 'string' ? reader.result : ''
      const comma = url.indexOf(',')
      if (comma < 0) return
      const base64 = url.slice(comma + 1)
      if (base64 === opened || base64.length > MAX_SAVE_BASE64) return
      onSave({ type: 'save', name, mime, base64 })
    }
    reader.readAsDataURL(blob)
  }
  page.addEventListener('click', onClick, true)

  return () => {
    page.removeEventListener('click', onClick, true)
    urls.createObjectURL = create
    urls.revokeObjectURL = revoke
    blobs.clear()
  }
}
