// The app log's lines on the console in a test (logger.ts prints each one in __DEV__). Only the
// lines a test expects are kept off the console; any other call goes through, so an unexpected
// log, a library's warning or a React error still shows (pristine output, no blanket silencing).

type Level = 'debug' | 'info' | 'warn'

type Expected = { level: Level; pattern: RegExp; lines: string[] }

let expected: Expected[] = []

/**
 * For `beforeEach`: spies on the console's debug, info and warn, and keeps off it the lines
 * `every` names, those every test in the file makes (such as the http client's line for each
 * request). A test that expects another line says so with `expectLog`. `jest.restoreAllMocks()`
 * in `afterEach` takes the spies away.
 */
export function keepExpectedLogs(every: Partial<Record<Level, RegExp>> = {}): void {
  expected = []
  for (const level of ['debug', 'info', 'warn'] as const) {
    const through = console[level].bind(console)
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      const [line] = args
      if (typeof line === 'string') {
        if (every[level]?.test(line)) return
        const e = expected.find((x) => x.level === level && x.pattern.test(line))
        if (e) {
          e.lines.push(line)
          return
        }
      }
      through(...args)
    })
  }
}

/**
 * A line this test expects: kept off the console. Returns the lines it matched, in order, for the
 * test to assert on.
 */
export function expectLog(level: Level, pattern: RegExp): string[] {
  const e: Expected = { level, pattern, lines: [] }
  expected.push(e)
  return e.lines
}
