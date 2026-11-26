// Trading hours for the widget (design 7.9.3): native builds one calendar spec per exchange from
// the server's market calendar (src/market/chart/calendar.ts) and pushes them, at init and again
// when they change.
//
// The widget asks for an instrument's calendar once per symbol and applies what it got again on
// every symbol change (preflight conflict 23), so a later push must not hand it new objects. Each
// exchange keeps one source for the page's life, and the source reads the calendars in force.
import { SessionCalendar, type SessionCalendarSource } from 'openalgo-charts'
import type { CalendarSpecJson } from '~/dom/bridge/protocol'

type InstrumentKey = { readonly symbol: string; readonly exchange: string }

/** The widget's `sessionCalendar`, and `replace` for a push. */
export type SessionCalendars = ((inst: InstrumentKey) => SessionCalendarSource | null) & {
  replace(calendars: Record<string, CalendarSpecJson>): void
}

/** The exchange whose calendar an instrument follows: an index trades the hours of its exchange
 *  (as calendarExchange in src/market/chart/calendar.ts). */
const calendarExchange = (exchange: string): string =>
  exchange.endsWith('_INDEX') ? exchange.slice(0, -'_INDEX'.length) : exchange

/** One calendar per exchange. A spec the library refuses leaves that exchange without hours,
 *  which the axis and the status line handle, rather than the page without a chart. */
function build(calendars: Record<string, CalendarSpecJson>): Map<string, SessionCalendar> {
  const out = new Map<string, SessionCalendar>()
  for (const [exchange, spec] of Object.entries(calendars)) {
    try {
      out.set(exchange, new SessionCalendar(spec))
    } catch {
      // No hours for this exchange.
    }
  }
  return out
}

export function sessionCalendarOf(calendars: Record<string, CalendarSpecJson>): SessionCalendars {
  let current = build(calendars)
  const sources = new Map<string, SessionCalendarSource>()

  const sourceOf = (exchange: string): SessionCalendarSource => {
    let source = sources.get(exchange)
    if (source === undefined) {
      source = {
        sessionFrom: (t) => current.get(exchange)?.sessionFrom(t) ?? null,
        phaseSpans: (from, to) => current.get(exchange)?.phaseSpans(from, to) ?? [],
      }
      sources.set(exchange, source)
    }
    return source
  }

  const forInstrument = (inst: InstrumentKey): SessionCalendarSource | null => {
    const exchange = calendarExchange(inst.exchange)
    return current.has(exchange) ? sourceOf(exchange) : null
  }
  return Object.assign(forInstrument, {
    replace(next: Record<string, CalendarSpecJson>) {
      current = build(next)
    },
  })
}
