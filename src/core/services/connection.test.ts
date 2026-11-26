import { asyncStorageKV as kv } from '~/core/config/bindings'
import { ApiError } from '~/core/http/errors'
import {
  CONNECTION_DEFAULTS,
  markSemiAuto,
  markSemiAutoError,
  transportOf,
  useConnection,
} from './connection'

beforeEach(async () => {
  for (const k of await kv.keys('oa.')) await kv.del(k)
  useConnection.getState().reset()
})

test('defaults', () => {
  expect(useConnection.getState()).toMatchObject(CONNECTION_DEFAULTS)
})

test('set patches and reset restores the defaults', () => {
  useConnection.getState().set({ broker: 'zerodha', feed: 'live', banned: 'text' })
  expect(useConnection.getState()).toMatchObject({
    broker: 'zerodha',
    feed: 'live',
    banned: 'text',
  })
  useConnection.getState().reset()
  expect(useConnection.getState()).toMatchObject(CONNECTION_DEFAULTS)
})

test('transport comes from the scheme of the origin', () => {
  expect(transportOf('https://algo.example.com')).toBe('https')
  expect(transportOf('http://192.168.1.5:5000')).toBe('http')
  expect(transportOf('HTTP://openalgo.local')).toBe('http')
})

test('markSemiAuto sees mode semi_auto and a Semi-Auto refusal', () => {
  markSemiAuto({ status: 'success', data: { mode: 'live' } })
  markSemiAuto({ status: 'error', message: 'Something else' })
  markSemiAuto('semi_auto')
  expect(useConnection.getState().semiAutoSeen).toBe(false)

  markSemiAuto({ status: 'success', data: { mode: 'semi_auto' } })
  expect(useConnection.getState().semiAutoSeen).toBe(true)

  useConnection.getState().reset()
  markSemiAuto({ status: 'error', message: 'Cancel order is not allowed in Semi-Auto mode.' })
  expect(useConnection.getState().semiAutoSeen).toBe(true)
})

test('a SemiAutoBlocked error marks it; other errors do not', () => {
  markSemiAutoError(new ApiError({ kind: 'Validation', status: 400, endpoint: 'placeorder' }))
  markSemiAutoError(new Error('x'))
  expect(useConnection.getState().semiAutoSeen).toBe(false)
  markSemiAutoError(new ApiError({ kind: 'SemiAutoBlocked', status: 403, endpoint: 'placeorder' }))
  expect(useConnection.getState().semiAutoSeen).toBe(true)
})

test('only semiAutoSeen is persisted, and it survives a reload', async () => {
  useConnection.getState().set({ broker: 'angel', feed: 'live', semiAutoSeen: true })
  const raw = (await kv.get('oa.connection.v1')) ?? ''
  expect(JSON.parse(raw).state).toEqual({ semiAutoSeen: true })

  useConnection.setState({ ...CONNECTION_DEFAULTS, semiAutoSeen: false })
  await kv.set('oa.connection.v1', raw)
  await useConnection.persist.rehydrate()
  expect(useConnection.getState()).toMatchObject({ semiAutoSeen: true, broker: null, feed: 'idle' })
})

test('a corrupt stored value loads as false', async () => {
  await kv.set('oa.connection.v1', JSON.stringify({ state: { semiAutoSeen: 'yes' }, version: 0 }))
  await useConnection.persist.rehydrate()
  expect(useConnection.getState().semiAutoSeen).toBe(false)
})
