import { memoryKV } from '../../../test/helpers/memoryKV'
import { createKeyStore } from './keyStore'
import { createKeyVault, LockedError } from './vault'

const KEY = 'ab'.repeat(32)
const NEW_KEY = 'cd'.repeat(32)

function setup(o: { stored?: boolean } = {}) {
  const secure = memoryKV(o.stored ? { 'oa.p1.apikey': KEY } : {})
  const kv = memoryKV(o.stored ? { 'oa.p1.hasKey': '1' } : {})
  const store = createKeyStore(secure, kv, 'p1')
  return { secure, kv, store, vault: createKeyVault(store) }
}

test('get() before unlocking throws LockedError', () => {
  const { vault } = setup({ stored: true })
  expect(vault.has()).toBe(false)
  expect(() => vault.get()).toThrow(LockedError)
})

test('unlock() reads the stored key into memory', async () => {
  const { vault } = setup({ stored: true })
  expect(await vault.unlock()).toBe(true)
  expect(vault.has()).toBe(true)
  expect(vault.get()).toBe(KEY)
})

test('lock() drops the key', async () => {
  const { vault } = setup({ stored: true })
  await vault.unlock()
  vault.lock()
  expect(vault.has()).toBe(false)
  expect(() => vault.get()).toThrow(LockedError)
})

test('the LockedError message never carries the key', async () => {
  const { vault } = setup({ stored: true })
  await vault.unlock()
  vault.lock()
  try {
    vault.get()
  } catch (e) {
    expect(e).toBeInstanceOf(LockedError)
    expect((e as Error).name).toBe('LockedError')
    expect((e as Error).message).not.toContain(KEY)
  }
  expect.assertions(3)
})

test('unlock() with no stored key returns false and drops the marker', async () => {
  const { secure, kv, vault } = setup()
  kv.data.set('oa.p1.hasKey', '1')
  expect(await vault.unlock()).toBe(false)
  expect(vault.has()).toBe(false)
  expect(kv.data.has('oa.p1.hasKey')).toBe(false)
  expect(secure.data.size).toBe(0)
})

test('a failed secure read rejects unlock() and leaves the vault locked', async () => {
  const { secure, kv, vault } = setup({ stored: true })
  secure.get = async () => {
    throw new Error('keystore unavailable')
  }
  await expect(vault.unlock()).rejects.toThrow('keystore unavailable')
  expect(vault.has()).toBe(false)
  expect(kv.data.has('oa.p1.hasKey')).toBe(true)
})

test('replace() saves through the store, marker included, and holds the new key', async () => {
  const { secure, kv, vault } = setup({ stored: true })
  await vault.unlock()
  await vault.replace(NEW_KEY)
  expect(vault.get()).toBe(NEW_KEY)
  expect(secure.data.get('oa.p1.apikey')).toBe(NEW_KEY)
  expect(kv.data.has('oa.p1.hasKey')).toBe(true)
})

test('replace() on a fresh profile writes the key and the marker', async () => {
  const { secure, kv, vault } = setup()
  await vault.replace(NEW_KEY)
  expect(vault.get()).toBe(NEW_KEY)
  expect(secure.data.get('oa.p1.apikey')).toBe(NEW_KEY)
  expect(kv.data.has('oa.p1.hasKey')).toBe(true)
})

test('a failed save rejects replace() and keeps the old key in memory', async () => {
  const { secure, vault } = setup({ stored: true })
  await vault.unlock()
  secure.set = async () => {
    throw new Error('disk full')
  }
  await expect(vault.replace(NEW_KEY)).rejects.toThrow('disk full')
  expect(vault.get()).toBe(KEY)
})

test('wipe() drops the key and deletes both the key and the marker', async () => {
  const { secure, kv, vault } = setup({ stored: true })
  await vault.unlock()
  await vault.wipe()
  expect(vault.has()).toBe(false)
  expect(() => vault.get()).toThrow(LockedError)
  expect(secure.data.size).toBe(0)
  expect(kv.data.size).toBe(0)
})
