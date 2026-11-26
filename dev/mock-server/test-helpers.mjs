// Shared by the mock's test files. Not a test file itself: test:scripts runs only *.test.mjs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { startMockServer } from './server.mjs'

/** The mock's default API key. */
export const KEY = 'ab'.repeat(32)

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

/** An in-process mock without the WS proxy; `t` closes it after. */
export async function mock(t, o = {}) {
  const m = await startMockServer({ wsPort: 'off', ...o })
  t.after(() => m.close())
  return m
}

/** One request; `json` is the parsed body, or undefined when it is not JSON. */
export async function call(m, method, path, body) {
  const res = await fetch(m.origin + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json }
}

/** POSTs an /api/v1 endpoint with the key added. */
export const post = (m, endpoint, body = {}) =>
  call(m, 'POST', `/api/v1/${endpoint}`, { apikey: KEY, ...body })

/** Applies a control patch, which must be accepted, and resolves with the new snapshot. */
export async function control(m, patch) {
  const r = await call(m, 'POST', '/__mock/control', patch)
  assert.equal(r.status, 200, `${JSON.stringify(patch)}: ${r.text}`)
  return r.json
}

export const stats = async (m) => (await call(m, 'GET', '/__mock/control')).json.stats
