import { memoryKV } from '../../../test/helpers/memoryKV'
import { createProfileRepo, newProfileId, type ServerProfile } from './profile'

const base: ServerProfile = {
  id: 'p1',
  restOrigin: 'https://algo.example.com',
  wsUrl: 'wss://algo.example.com/ws',
  feedMode: 'live',
  httpWarningAcked: false,
  serverVersion: '2.0.3.5',
  broker: 'zerodha',
  createdAt: 1,
  lastFeedRetryAt: null,
}

test('newProfileId is p plus 12 hex characters', () => {
  expect(newProfileId('123e4567-e89b-42d3-a456-426614174000')).toMatch(/^p[0-9a-f]{12}$/)
  expect(newProfileId('123E4567-E89B-42D3-A456-426614174000')).toBe('p123e4567e89b')
})

test('load is null before anything is saved', async () => {
  expect(await createProfileRepo(memoryKV()).load()).toBeNull()
})

test('save then load round-trips through oa.profiles.v1', async () => {
  const kv = memoryKV()
  const repo = createProfileRepo(kv)
  await repo.save(base)
  expect(await repo.load()).toEqual(base)
  expect(JSON.parse(kv.data.get('oa.profiles.v1') ?? '')).toEqual({
    activeId: 'p1',
    profiles: [base],
  })
})

test('update patches the active profile and keeps its id', async () => {
  const repo = createProfileRepo(memoryKV())
  await repo.save(base)
  const next = await repo.update({ restOrigin: 'https://other.example.com' })
  expect(next).toMatchObject({ id: 'p1', restOrigin: 'https://other.example.com' })
  expect(await repo.load()).toEqual(next)
})

test('update with no active profile does nothing', async () => {
  const kv = memoryKV()
  expect(await createProfileRepo(kv).update({ broker: 'x' })).toBeNull()
  expect(kv.data.size).toBe(0)
})

test('unreadable stored data loads as no profile', async () => {
  expect(await createProfileRepo(memoryKV({ 'oa.profiles.v1': '{not json' })).load()).toBeNull()
  expect(
    await createProfileRepo(
      memoryKV({ 'oa.profiles.v1': '{"activeId":"p1","profiles":[{}]}' }),
    ).load(),
  ).toBeNull()
})
