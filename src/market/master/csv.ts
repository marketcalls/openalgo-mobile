// The instruments CSV (GET /api/v1/instruments?format=csv), as services/instruments_service.py
// writes it with csv.DictWriter: a header row, CRLF line ends, and cells quoted only when they hold
// a comma, a quote or a line break. Read in batches, each awaited, so a 100,000-row NFO master
// never holds the JS thread for long (design 7.8).
import type { MasterRow } from './db'
import { extractUnderlying } from './underlying'

const BATCH = 2000

/**
 * The records of `text`, each an array of cells: RFC 4180, with "" for a quote inside a quoted
 * cell. A blank line is no record.
 */
function* records(text: string): Generator<string[]> {
  let i = 0
  const n = text.length
  while (i < n) {
    const row: string[] = []
    for (;;) {
      let cell = ''
      if (text[i] === '"') {
        i++
        for (;;) {
          const q = text.indexOf('"', i)
          if (q < 0) {
            cell += text.slice(i)
            i = n
            break
          }
          cell += text.slice(i, q)
          i = q + 1
          if (text[i] !== '"') break
          cell += '"'
          i++
        }
      }
      // the rest of an unquoted cell (or anything after a closing quote) runs to , or a line end
      let j = i
      while (j < n && text[j] !== ',' && text[j] !== '\r' && text[j] !== '\n') j++
      cell += text.slice(i, j)
      i = j
      row.push(cell)
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === '\r') i++
      if (text[i] === '\n') i++
      break
    }
    if (row.length > 1 || row[0] !== '') yield row
  }
}

/** A finite number, or 0 for an empty or unreadable cell. */
const numberOf = (cell: string | undefined): number => {
  const v = cell === undefined || cell.trim() === '' ? 0 : Number(cell)
  return Number.isFinite(v) ? v : 0
}

/**
 * Parses `text` and hands its rows to `onBatch`, `batch` (2,000) at a time, awaiting each before
 * reading on. Columns are found by their header names; a row without a symbol or an exchange is
 * skipped. Resolves to the number of rows handed over.
 */
export async function parseInstrumentsCsv(
  text: string,
  onBatch: (rows: MasterRow[]) => Promise<void>,
  o: { batch?: number } = {},
): Promise<number> {
  const size = Math.max(1, o.batch ?? BATCH)
  const it = records(text)
  const header = it.next()
  if (header.done) return 0
  const at = new Map(header.value.map((name, k) => [name.trim().toLowerCase(), k]))
  const col = (row: string[], name: string) => {
    const k = at.get(name)
    return k === undefined ? '' : (row[k] ?? '').trim()
  }
  let count = 0
  let rows: MasterRow[] = []
  for (const r of it) {
    const symbol = col(r, 'symbol')
    const exchange = col(r, 'exchange')
    if (!symbol || !exchange) continue
    rows.push({
      symbol,
      name: col(r, 'name'),
      exchange,
      expiry: col(r, 'expiry'),
      strike: numberOf(col(r, 'strike')),
      lotsize: numberOf(col(r, 'lotsize')),
      tick: numberOf(col(r, 'tick_size')),
      itype: col(r, 'instrumenttype'),
      underlying: extractUnderlying(symbol, exchange),
    })
    if (rows.length >= size) {
      count += rows.length
      await onBatch(rows)
      rows = []
    }
  }
  if (rows.length > 0) {
    count += rows.length
    await onBatch(rows)
  }
  return count
}
