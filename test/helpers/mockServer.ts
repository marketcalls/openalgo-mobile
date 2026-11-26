// Runs dev/mock-server as a child process for the compat suite: `npm run mock` with
// PORT=0 WS_PORT=0 on 127.0.0.1, ready once it prints MOCK_READY.
import { spawn } from 'node:child_process'
import path from 'node:path'

const MAIN = path.resolve(__dirname, '../../dev/mock-server/main.mjs')
const READY = /^MOCK_READY rest=(\S+) ws=(\S+)$/m
const START_TIMEOUT_MS = 10_000

export type MockStats = {
  requests: Record<string, number>
  wsConnections: number
  wsAuthAttempts: number
  /** Orders in the engine's book, by status. */
  orders: Record<string, number>
  /** The last body that reached each endpoint, without the apikey. */
  lastBody: Record<string, Record<string, unknown>>
}

export type MockServerProcess = {
  origin: string
  /** Null with WS_PORT=off. */
  wsUrl: string | null
  /** POST /__mock/control: merges the patch and returns the state. */
  control(patch: Record<string, unknown>): Promise<Record<string, unknown>>
  stats(): Promise<MockStats>
  stop(): Promise<void>
}

/** Starts the mock with `env` over PORT=0 WS_PORT=0 HOST=127.0.0.1. */
export function startMockServerProcess(
  env: Record<string, string> = {},
): Promise<MockServerProcess> {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, PORT: '0', WS_PORT: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = false
  let onEarlyExit: ((code: number | null) => void) | null = null
  const exit = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      exited = true
      onEarlyExit?.(code)
      resolve()
    })
  })
  const stop = async () => {
    if (!exited) child.kill('SIGTERM')
    await exit
  }

  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const fail = (why: string) => {
      clearTimeout(timer)
      onEarlyExit = null
      void stop()
      reject(new Error(`the mock did not start: ${why}${err ? `\n${err}` : ''}`))
    }
    const timer = setTimeout(
      () => fail(`no MOCK_READY in ${START_TIMEOUT_MS} ms`),
      START_TIMEOUT_MS,
    )
    onEarlyExit = (code) => fail(`it exited with ${code}`)
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8')
    })
    child.stdout.on('data', (b: Buffer) => {
      if (!onEarlyExit) return
      out += b.toString('utf8')
      const m = READY.exec(out)
      if (!m?.[1] || !m[2]) return
      clearTimeout(timer)
      onEarlyExit = null
      const origin = m[1]
      const call = async (method: 'GET' | 'POST', body?: unknown) => {
        const res = await fetch(`${origin}/__mock/control`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`mock control ${res.status}: ${await res.text()}`)
        return (await res.json()) as Record<string, unknown> & { stats: MockStats }
      }
      resolve({
        origin,
        wsUrl: m[2] === 'off' ? null : m[2],
        control: (patch) => call('POST', patch),
        stats: async () => (await call('GET')).stats,
        stop,
      })
    })
  })
}
