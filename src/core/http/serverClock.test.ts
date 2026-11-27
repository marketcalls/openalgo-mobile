import { createServerClock } from './serverClock'

const T0 = Date.UTC(2026, 10, 24, 4, 0)
const date = (ms: number) => new Date(ms).toUTCString()

function make() {
  let t = T0
  const clock = createServerClock(() => t)
  return { clock, at: (ms: number) => (t = ms) }
}

test('before any sample the server clock is the device clock', () => {
  const { clock } = make()
  expect(clock.offsetMs()).toBe(0)
  expect(clock.now()).toBe(T0)
})

test('server_ts sets the offset; a Date header is ignored after it; a 3-minute skew from Date alone is corrected (RF 4)', () => {
  // Date alone: the phone is 3 minutes slow.
  const a = make()
  a.clock.noteDate(date(T0 + 180_000), T0)
  expect(a.clock.offsetMs()).toBe(180_000)
  expect(a.clock.now()).toBe(T0 + 180_000)

  // server_ts wins, and a later Date within 10 minutes does not move it.
  const b = make()
  b.clock.noteServerTs((T0 + 60_000) / 1000, T0)
  expect(b.clock.offsetMs()).toBe(60_000)
  b.at(T0 + 599_000)
  b.clock.noteDate(date(T0 + 599_000 + 180_000), T0 + 599_000)
  expect(b.clock.offsetMs()).toBe(60_000)

  // Once the server_ts sample is 10 minutes old, Date may correct it again.
  b.at(T0 + 600_000)
  b.clock.noteDate(date(T0 + 600_000 + 5_000), T0 + 600_000)
  expect(b.clock.offsetMs()).toBe(5_000)
})

test('a later server_ts replaces an earlier one', () => {
  const { clock } = make()
  clock.noteServerTs((T0 + 1_000) / 1000, T0)
  clock.noteServerTs((T0 + 2_000) / 1000, T0)
  expect(clock.offsetMs()).toBe(2_000)
})

test('an absurd offset is ignored', () => {
  const { clock } = make()
  clock.noteServerTs((T0 + 43_200_001) / 1000, T0)
  clock.noteDate(date(T0 - 43_200_001), T0)
  expect(clock.offsetMs()).toBe(0)
  clock.noteServerTs((T0 + 43_200_000) / 1000, T0)
  expect(clock.offsetMs()).toBe(43_200_000)
})

test('a missing, unparsable or NaN sample changes nothing', () => {
  const { clock } = make()
  clock.noteDate(undefined, T0)
  clock.noteDate('not a date', T0)
  clock.noteServerTs(Number.NaN, T0)
  expect(clock.offsetMs()).toBe(0)
})

test('a Date sample stamps the middle of the exchange, and a request over 2 s is skipped', () => {
  const { clock } = make()
  // Received at T0 after 2 s: the server stamped about 1 s earlier.
  clock.noteDate(date(T0 - 1_000 + 60_000), T0, 2_000)
  expect(clock.offsetMs()).toBe(60_000)
  clock.noteDate(date(T0 + 999_000), T0, 2_001)
  expect(clock.offsetMs()).toBe(60_000)
})
