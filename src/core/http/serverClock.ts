// The server's clock as the phone sees it (design 7.8): `server_ts` from the option chain
// (1 s resolution, exact to the request) wins; the HTTP `Date` header is the fallback for a
// server before 2.0.2.0. Option expiry and Greeks time-to-expiry read `now()`.

/** An offset beyond this (12 h) is a bad sample, not a skewed clock. */
const MAX_OFFSET_MS = 43_200_000
/** A `Date` sample is ignored while a `server_ts` sample is younger than this. */
const SERVER_TS_FRESH_MS = 600_000
/** A reply this slow says little about when the server stamped its `Date`. */
const MAX_DATE_ELAPSED_MS = 2_000

export type ServerClock = {
  /** The server's time, epoch ms. */
  now(): number
  /** Server minus device, ms; 0 until a sample is taken. */
  offsetMs(): number
  /** `server_ts` (epoch seconds) read from a reply received at `receivedAt` (device ms). */
  noteServerTs(sec: number, receivedAt: number): void
  /**
   * A `Date` header. `elapsedMs`, the request's duration, puts the sample at the middle of
   * the exchange; a request over 2 s is skipped.
   */
  noteDate(header: string | undefined, receivedAt: number, elapsedMs?: number): void
}

export function createServerClock(deviceNow: () => number): ServerClock {
  let offset = 0
  // Device time of the last accepted `server_ts` sample.
  let tsAt: number | null = null

  return {
    now: () => deviceNow() + offset,
    offsetMs: () => offset,

    noteServerTs(sec, receivedAt) {
      if (!Number.isFinite(sec) || !Number.isFinite(receivedAt)) return
      const next = sec * 1000 - receivedAt
      if (Math.abs(next) > MAX_OFFSET_MS) return
      offset = next
      tsAt = receivedAt
    },

    noteDate(header, receivedAt, elapsedMs = 0) {
      if (!header || elapsedMs > MAX_DATE_ELAPSED_MS) return
      if (tsAt !== null && deviceNow() - tsAt < SERVER_TS_FRESH_MS) return
      const server = Date.parse(header)
      if (Number.isNaN(server)) return
      const next = server - (receivedAt - elapsedMs / 2)
      if (Math.abs(next) > MAX_OFFSET_MS) return
      offset = next
    },
  }
}
