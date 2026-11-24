import { memoryKV } from '../../../test/helpers/memoryKV'
import { createKeyStore } from './keyStore'

const KEY = 'ab'.repeat(32)

function setup() {
  const secure = memoryKV()
  const kv = memoryKV()
  const store = createKeyStore(secure, kv, 'p1')
  return { secure, kv, store }
}

test('save stores the key as oa.p1.apikey in the secure store and the marker oa.p1.hasKey in kv', async () => {
  const { secure, kv, store } = setup()
  await store.save(KEY)
  expect([...secure.data]).toEqual([['oa.p1.apikey', KEY]])
  expect([...kv.data.keys()]).toEqual(['oa.p1.hasKey'])
  expect(kv.data.get('oa.p1.hasKey')).not.toContain(KEY)
  expect(await store.load()).toBe(KEY)
})

test('hasKey() reads only the marker and never calls secureKV.get', async () => {
  const { secure, store } = setup()
  const get = jest.spyOn(secure, 'get')
  expect(await store.hasKey()).toBe(false)
  await store.save(KEY)
  expect(await store.hasKey()).toBe(true)
  expect(get).not.toHaveBeenCalled()
})

test('hasKey() trusts the marker alone, even when the secure entry is missing', async () => {
  const kv = memoryKV({ 'oa.p1.hasKey': '1' })
  const store = createKeyStore(memoryKV(), kv, 'p1')
  expect(await store.hasKey()).toBe(true)
  expect(await store.load()).toBeNull()
})

test('clear() removes both the key and the marker', async () => {
  const { secure, kv, store } = setup()
  await store.save(KEY)
  await store.clear()
  expect(secure.data.size).toBe(0)
  expect(kv.data.size).toBe(0)
  expect(await store.hasKey()).toBe(false)
  expect(await store.load()).toBeNull()
})

test('profiles do not share keys', async () => {
  const secure = memoryKV()
  const kv = memoryKV()
  await createKeyStore(secure, kv, 'p1').save(KEY)
  const other = createKeyStore(secure, kv, 'p2')
  expect(await other.hasKey()).toBe(false)
  expect(await other.load()).toBeNull()
})
