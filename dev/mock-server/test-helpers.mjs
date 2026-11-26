// Shared by rest.test.mjs and feed.test.mjs. Not a test file itself: test:scripts runs
// only *.test.mjs.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Rejects after `ms`, so a regression fails its test instead of hanging the run. */
export function within(promise, ms, what) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

/** Spawns main.mjs with `env` added and resolves with its MOCK_READY line; `t` kills it after. */
export function runMain(t, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.mjs', import.meta.url))], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  const readyLine = async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith('MOCK_READY')) return line
    }
    throw new Error('main.mjs exited without MOCK_READY')
  }
  return within(readyLine(), 5000, 'MOCK_READY')
}
