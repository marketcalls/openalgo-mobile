const IST_OFFSET_MS = 19_800_000 // UTC+5:30, no DST

/** Day of week (0 = Sunday) and minutes since midnight in IST, whatever the device time zone. */
export const istParts = (now: Date | number): { day: number; minutes: number } => {
  const t = (typeof now === 'number' ? now : now.getTime()) + IST_OFFSET_MS
  const d = new Date(t)
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }
}

const at = (h: number, m: number) => h * 60 + m

type Window = readonly [open: number, close: number] | 'always'

// Server defaults (database/market_calendar_db.py:57-73). No holidays in M1.
const WINDOWS: Record<string, Window> = {
  NSE: [at(9, 15), at(15, 30)],
  BSE: [at(9, 15), at(15, 30)],
  NSE_INDEX: [at(9, 15), at(15, 30)],
  BSE_INDEX: [at(9, 15), at(15, 30)],
  NFO: [at(9, 15), at(15, 40)],
  BFO: [at(9, 15), at(15, 40)],
  CDS: [at(9, 0), at(17, 0)],
  BCD: [at(9, 0), at(17, 0)],
  MCX: [at(9, 0), at(23, 55)],
  NCO: [at(9, 0), at(23, 55)],
  MCX_INDEX: [at(9, 0), at(23, 55)],
  CRYPTO: 'always',
}

export const isExchangeOpen = (exchange: string, now: Date | number): boolean => {
  const w = WINDOWS[exchange]
  if (!w) return false
  if (w === 'always') return true
  const { day, minutes } = istParts(now)
  if (day === 0 || day === 6) return false
  return minutes >= w[0] && minutes < w[1]
}

export const isAnyMarketOpen = (now: Date | number): boolean =>
  Object.keys(WINDOWS).some((ex) => isExchangeOpen(ex, now))
