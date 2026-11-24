import { z } from 'zod'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { profileStorage } from './storage'

test('values are stored under oa.<pid>.<name> and validated on read', async () => {
  const kv = memoryKV()
  const s = profileStorage(kv, 'p1')
  await s.setJSON('caps', { a: 1 })
  expect(kv.data.get('oa.p1.caps')).toBe('{"a":1}')
  expect(await s.getJSON('caps', z.object({ a: z.number() }))).toEqual({ a: 1 })
  expect(await s.getJSON('caps', z.object({ a: z.string() }))).toBeNull()
  expect(await s.getJSON('missing', z.any())).toBeNull()
})

test('corrupt JSON reads as null', async () => {
  const s = profileStorage(memoryKV({ 'oa.p1.caps': '{oops' }), 'p1')
  expect(await s.getJSON('caps', z.any())).toBeNull()
})

test('clearAll({ keepUserContent: true }) keeps user content and drops the rest', async () => {
  const kv = memoryKV({
    'oa.p1.watchlists': '[]',
    'oa.p1.caps': '{}',
    'oa.p2.caps': '{}',
    'oa.prefs.v1': '{}',
  })
  await profileStorage(kv, 'p1').clearAll({ keepUserContent: true })
  expect([...kv.data.keys()].sort()).toEqual(['oa.p1.watchlists', 'oa.p2.caps', 'oa.prefs.v1'])
})

test('clearAll({ keepUserContent: false }) drops everything of the profile', async () => {
  const kv = memoryKV({ 'oa.p1.watchlists': '[]', 'oa.p1.caps': '{}', 'oa.p10.caps': '{}' })
  await profileStorage(kv, 'p1').clearAll({ keepUserContent: false })
  expect([...kv.data.keys()]).toEqual(['oa.p10.caps'])
})

test('del removes one name', async () => {
  const kv = memoryKV({ 'oa.p1.caps': '{}' })
  await profileStorage(kv, 'p1').del('caps')
  expect(kv.data.size).toBe(0)
})
