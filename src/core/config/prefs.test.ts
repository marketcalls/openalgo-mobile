import { asyncStorageKV as kv } from './bindings'
import { DEFAULT_LOCK_AFTER_MS } from './constants'
import { PREFS_DEFAULTS, usePrefs } from './prefs'

beforeEach(async () => {
  for (const k of await kv.keys('oa.')) await kv.del(k)
  usePrefs.setState(PREFS_DEFAULTS)
})

test('defaults', () => {
  expect(PREFS_DEFAULTS).toEqual({
    theme: 'system',
    appLock: true,
    lockAfterMs: DEFAULT_LOCK_AFTER_MS,
    hideContentAndroid: false,
    confirmLiveWrites: false,
    updateCheck: true,
  })
})

test('a stored pref without updateCheck loads as on', async () => {
  await kv.set('oa.prefs.v1', JSON.stringify({ state: { theme: 'dark' }, version: 0 }))
  await usePrefs.persist.rehydrate()
  expect(usePrefs.getState().updateCheck).toBe(true)
})

test('setPrefs persists under oa.prefs.v1 and survives a reload', async () => {
  usePrefs.getState().setPrefs({ theme: 'dark', lockAfterMs: 900_000 })
  const stored = JSON.parse((await kv.get('oa.prefs.v1')) ?? '{}')
  expect(stored.state).toMatchObject({ theme: 'dark', lockAfterMs: 900_000 })
  expect(stored.state.setPrefs).toBeUndefined()

  const raw = (await kv.get('oa.prefs.v1')) ?? ''
  usePrefs.setState(PREFS_DEFAULTS)
  await kv.set('oa.prefs.v1', raw) // setState above also persisted the defaults
  await usePrefs.persist.rehydrate()
  expect(usePrefs.getState()).toMatchObject({ theme: 'dark', lockAfterMs: 900_000 })
})

test('invalid saved values load back as the defaults', async () => {
  await kv.set(
    'oa.prefs.v1',
    JSON.stringify({ state: { theme: 'neon', lockAfterMs: 7, appLock: false }, version: 0 }),
  )
  await usePrefs.persist.rehydrate()
  expect(usePrefs.getState()).toMatchObject({
    theme: 'system',
    lockAfterMs: DEFAULT_LOCK_AFTER_MS,
    appLock: false,
  })
})
