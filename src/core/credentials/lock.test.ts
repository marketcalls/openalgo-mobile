import { clearLogs, getLogLines } from '~/core/log/logger'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { createKeyStore } from './keyStore'
import { confirmLiveWrite, createLockController, type LockState } from './lock'
import { createKeyVault, LockedError } from './vault'

const KEY = 'ab'.repeat(32)
const T0 = Date.UTC(2026, 10, 24, 4, 0)
const S = 1000

function setup(
  o: {
    enabled?: boolean
    usable?: boolean
    lockAfterMs?: number
    stored?: boolean
    /** Gives the controller a monotonic clock, which a date change does not move. */
    monotonic?: boolean
  } = {},
) {
  let t = T0
  /** The monotonic clock: it moves with `advance`, never with `setClock`. */
  let mono = 0
  const settings = { enabled: o.enabled ?? true, lockAfterMs: o.lockAfterMs ?? 300 * S }
  const secure = memoryKV(o.stored === false ? {} : { 'oa.p1.apikey': KEY })
  const kv = memoryKV({ 'oa.p1.hasKey': '1' })
  const vault = createKeyVault(createKeyStore(secure, kv, 'p1'))
  const authenticate = jest.fn(async () => true)
  /** Stands in for canUseAppLock(): false when the phone has no passcode or biometrics. */
  const device = { usable: o.usable ?? true }
  const available = jest.fn(async () => device.usable)
  const lock = createLockController({
    now: () => t,
    ...(o.monotonic ? { monotonicNow: () => mono } : {}),
    settings: () => settings,
    authenticate,
    available,
    vault,
  })
  const states: LockState[] = []
  lock.subscribe((s) => states.push(s))
  const advance = (ms: number) => {
    t += ms
    mono += ms
  }
  /** Moves the device's date and time, as the user can in Settings, without time passing. */
  const setClock = (by: number) => {
    t += by
  }
  /** Spends `ms` in the background, then comes back to the foreground. */
  const awayFor = (ms: number) => {
    lock.handleAppState('background')
    advance(ms)
    lock.handleAppState('active')
  }
  return {
    lock,
    vault,
    secure,
    kv,
    authenticate,
    available,
    device,
    settings,
    states,
    advance,
    setClock,
    awayFor,
  }
}

afterEach(() => jest.restoreAllMocks())

describe('start and unlock', () => {
  test('locked at start, with the vault shut and no prompt yet', () => {
    const { lock, vault, authenticate } = setup()
    expect(lock.isLocked()).toBe(true)
    expect(vault.has()).toBe(false)
    expect(() => vault.get()).toThrow(LockedError)
    expect(authenticate).not.toHaveBeenCalled()
  })

  test('unlock() prompts, then reads the key into the vault', async () => {
    const { lock, vault, authenticate, states } = setup()
    expect(await lock.unlock()).toBe(true)
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(lock.isLocked()).toBe(false)
    expect(vault.get()).toBe(KEY)
    expect(states).toEqual(['unlocked'])
  })

  test('a refused prompt stays locked and never reads the key', async () => {
    const { lock, vault, secure, authenticate, states } = setup()
    const get = jest.spyOn(secure, 'get')
    authenticate.mockResolvedValueOnce(false)
    expect(await lock.unlock()).toBe(false)
    expect(lock.isLocked()).toBe(true)
    expect(vault.has()).toBe(false)
    expect(get).not.toHaveBeenCalled()
    expect(states).toEqual([])
  })

  test('a prompt that throws stays locked and is logged', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    clearLogs()
    const { lock, vault, authenticate } = setup()
    authenticate.mockRejectedValueOnce(new Error('not_available'))
    expect(await lock.unlock()).toBe(false)
    expect(lock.isLocked()).toBe(true)
    expect(vault.has()).toBe(false)
    expect(getLogLines().filter((l) => l.includes('unlock failed'))).toHaveLength(1)
  })

  test('a failed secure read stays locked, and a later unlock() can still succeed', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { lock, vault, secure, states } = setup()
    const get = secure.get
    secure.get = async () => {
      throw new Error('keystore unavailable')
    }
    expect(await lock.unlock()).toBe(false)
    expect(lock.isLocked()).toBe(true)
    secure.get = get
    expect(await lock.unlock()).toBe(true)
    expect(vault.get()).toBe(KEY)
    expect(states).toEqual(['unlocked'])
  })

  test('two failed secure reads in a row make the key unreadable; a cancelled prompt does not count', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { lock, secure, authenticate } = setup()
    const get = secure.get
    secure.get = async () => {
      throw new Error('keystore unavailable')
    }
    expect(await lock.unlock()).toBe(false)
    expect(lock.keyUnreadable()).toBe(false)
    authenticate.mockResolvedValueOnce(false)
    expect(await lock.unlock()).toBe(false)
    expect(lock.keyUnreadable()).toBe(false)
    expect(await lock.unlock()).toBe(false)
    expect(lock.keyUnreadable()).toBe(true)
    secure.get = get
    expect(await lock.unlock()).toBe(true)
    expect(lock.keyUnreadable()).toBe(false)
  })

  test('concurrent unlock() calls share one prompt', async () => {
    const { lock, authenticate } = setup()
    let answer: (ok: boolean) => void = () => {}
    const prompt = new Promise<boolean>((r) => {
      answer = r
    })
    authenticate.mockImplementationOnce(() => prompt)
    const calls = [lock.unlock(), lock.unlock(), lock.unlock()]
    answer(true)
    expect(await Promise.all(calls)).toEqual([true, true, true])
    expect(authenticate).toHaveBeenCalledTimes(1)
  })

  test('unlock() while unlocked resolves true with no prompt', async () => {
    const { lock, authenticate } = setup()
    await lock.unlock()
    expect(await lock.unlock()).toBe(true)
    expect(authenticate).toHaveBeenCalledTimes(1)
  })

  test('no stored key: unlock() is false, listeners hear no-key, and the marker is dropped', async () => {
    const { lock, kv, authenticate, states } = setup({ stored: false })
    expect(await lock.unlock()).toBe(false)
    expect(states).toEqual(['no-key'])
    expect(lock.isLocked()).toBe(true)
    expect(kv.data.has('oa.p1.hasKey')).toBe(false)
    expect(await lock.unlock()).toBe(false)
    expect(authenticate).toHaveBeenCalledTimes(1)
  })

  test('a listener that throws is logged, and the others still hear', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    clearLogs()
    const { lock, states } = setup()
    lock.subscribe(() => {
      throw new Error('boom')
    })
    const after: LockState[] = []
    lock.subscribe((s) => after.push(s))
    expect(await lock.unlock()).toBe(true)
    expect(states).toEqual(['unlocked'])
    expect(after).toEqual(['unlocked'])
    expect(getLogLines().filter((l) => l.includes('a lock listener failed'))).toHaveLength(1)
  })

  test('listeners stop hearing after they unsubscribe', async () => {
    const { lock } = setup()
    const heard: LockState[] = []
    const off = lock.subscribe((s) => heard.push(s))
    off()
    await lock.unlock()
    expect(heard).toEqual([])
  })
})

describe('lock timing', () => {
  test('still unlocked after 299 s in the background; locked, vault included, at 300 s', async () => {
    const { lock, vault, awayFor, states } = setup()
    await lock.unlock()

    awayFor(299 * S)
    expect(lock.isLocked()).toBe(false)
    expect(vault.get()).toBe(KEY)

    awayFor(300 * S)
    expect(lock.isLocked()).toBe(true)
    expect(vault.has()).toBe(false)
    expect(() => vault.get()).toThrow(LockedError)
    expect(states).toEqual(['unlocked', 'locked'])
  })

  test('inactive never locks', async () => {
    const { lock, vault, advance } = setup()
    await lock.unlock()
    lock.handleAppState('inactive')
    advance(3600 * S)
    lock.handleAppState('active')
    expect(lock.isLocked()).toBe(false)
    expect(vault.get()).toBe(KEY)
  })

  test('inactive on the way back keeps the background clock running', async () => {
    const { lock, advance } = setup()
    await lock.unlock()
    lock.handleAppState('background')
    advance(200 * S)
    lock.handleAppState('inactive')
    advance(100 * S)
    lock.handleAppState('active')
    expect(lock.isLocked()).toBe(true)
  })

  test('a repeated background event does not restart the clock', async () => {
    const { lock, advance } = setup()
    await lock.unlock()
    lock.handleAppState('background')
    advance(200 * S)
    lock.handleAppState('background')
    advance(100 * S)
    lock.handleAppState('active')
    expect(lock.isLocked()).toBe(true)
  })

  test('after locking, unlock() prompts again', async () => {
    const { lock, vault, authenticate, awayFor, states } = setup()
    await lock.unlock()
    awayFor(300 * S)
    expect(await lock.unlock()).toBe(true)
    expect(authenticate).toHaveBeenCalledTimes(2)
    expect(vault.get()).toBe(KEY)
    expect(states).toEqual(['unlocked', 'locked', 'unlocked'])
  })

  test('a clock set back while away locks (fails closed)', async () => {
    const { lock, vault, advance, setClock } = setup()
    await lock.unlock()
    lock.handleAppState('background')
    advance(301 * S)
    setClock(-3600 * S)
    lock.handleAppState('active')
    expect(lock.isLocked()).toBe(true)
    expect(vault.has()).toBe(false)
  })

  test('a clock set back by exactly the time away is caught by the monotonic clock', async () => {
    const { lock, advance, setClock } = setup({ monotonic: true })
    await lock.unlock()
    lock.handleAppState('background')
    advance(301 * S)
    setClock(-300 * S) // the wall clock shows 1 s away
    lock.handleAppState('active')
    expect(lock.isLocked()).toBe(true)
  })

  test('a monotonic clock that stopped while the phone slept does not keep it unlocked', async () => {
    const { lock, setClock } = setup({ monotonic: true })
    await lock.unlock()
    lock.handleAppState('background')
    setClock(301 * S) // the wall clock moved; the monotonic one did not
    lock.handleAppState('active')
    expect(lock.isLocked()).toBe(true)
  })

  test('with the monotonic clock, a short time away still stays unlocked', async () => {
    const { lock, awayFor } = setup({ monotonic: true })
    await lock.unlock()
    awayFor(299 * S)
    expect(lock.isLocked()).toBe(false)
  })

  test('lockAfterMs is read on each return', async () => {
    const { lock, settings, awayFor } = setup()
    await lock.unlock()
    settings.lockAfterMs = 60 * S
    awayFor(60 * S)
    expect(lock.isLocked()).toBe(true)
  })
})

describe('app lock off or unusable', () => {
  test('unlock() opens the vault with no prompt', async () => {
    const { lock, vault, authenticate } = setup({ enabled: false })
    expect(await lock.unlock()).toBe(true)
    expect(authenticate).not.toHaveBeenCalled()
    expect(vault.get()).toBe(KEY)
  })

  test('it never locks, however long in the background', async () => {
    const { lock, vault, awayFor } = setup({ enabled: false })
    await lock.unlock()
    awayFor(24 * 3600 * S)
    expect(lock.isLocked()).toBe(false)
    expect(vault.get()).toBe(KEY)
  })

  test('switched on mid-session, the next long absence locks', async () => {
    const { lock, settings, awayFor } = setup({ enabled: false })
    await lock.unlock()
    settings.enabled = true
    awayFor(300 * S)
    expect(lock.isLocked()).toBe(true)
  })

  test('off: whether the device can lock is not even asked', async () => {
    const { lock, available } = setup({ enabled: false })
    await lock.unlock()
    expect(available).not.toHaveBeenCalled()
  })

  test('enabled but unusable (no passcode or biometrics): unlock() opens the vault with no prompt', async () => {
    const { lock, vault, authenticate, available, states } = setup({ usable: false })
    expect(lock.isLocked()).toBe(true)
    expect(await lock.unlock()).toBe(true)
    expect(available).toHaveBeenCalledTimes(1)
    expect(authenticate).not.toHaveBeenCalled()
    expect(lock.isLocked()).toBe(false)
    expect(vault.get()).toBe(KEY)
    expect(states).toEqual(['unlocked'])
  })

  test('enabled but unusable: concurrent unlock() calls share one check and open the vault', async () => {
    const { lock, authenticate, available } = setup({ usable: false })
    expect(await Promise.all([lock.unlock(), lock.unlock()])).toEqual([true, true])
    expect(available).toHaveBeenCalledTimes(1)
    expect(authenticate).not.toHaveBeenCalled()
  })

  test('passcode removed mid-session: the next lock reopens with no prompt', async () => {
    const { lock, vault, authenticate, device, awayFor, states } = setup()
    await lock.unlock()
    expect(authenticate).toHaveBeenCalledTimes(1)
    device.usable = false
    awayFor(300 * S)
    expect(lock.isLocked()).toBe(true)
    expect(await lock.unlock()).toBe(true)
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(vault.get()).toBe(KEY)
    expect(states).toEqual(['unlocked', 'locked', 'unlocked'])
  })

  test('passcode set mid-session: availability is asked again, so the next unlock prompts', async () => {
    const { lock, authenticate, available, device, awayFor } = setup({ usable: false })
    await lock.unlock()
    device.usable = true
    awayFor(300 * S)
    expect(lock.isLocked()).toBe(true)
    authenticate.mockResolvedValueOnce(false)
    expect(await lock.unlock()).toBe(false)
    expect(available).toHaveBeenCalledTimes(2)
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(lock.isLocked()).toBe(true)
  })

  test('an availability check that throws still prompts (fails closed), and is logged', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    clearLogs()
    const { lock, vault, authenticate, available } = setup()
    available.mockRejectedValueOnce(new Error('getEnrolledLevelAsync failed'))
    authenticate.mockResolvedValueOnce(false)
    expect(await lock.unlock()).toBe(false)
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(lock.isLocked()).toBe(true)
    expect(vault.has()).toBe(false)
    expect(getLogLines().filter((l) => l.includes('app lock check failed'))).toHaveLength(1)
  })
})

describe('confirmLiveWrite', () => {
  const available = async () => true

  test('disabled: ok without a prompt', async () => {
    const prompt = jest.fn(async () => 'failed' as const)
    expect(await confirmLiveWrite({ enabled: false, available, prompt })).toBe('ok')
    expect(prompt).not.toHaveBeenCalled()
  })

  test('enabled: the prompt decides', async () => {
    for (const r of ['ok', 'cancelled', 'failed'] as const) {
      expect(await confirmLiveWrite({ enabled: true, available, prompt: async () => r })).toBe(r)
    }
  })

  test('enabled on a phone with no passcode or biometrics: ok without a prompt, as the app lock', async () => {
    const prompt = jest.fn(async () => 'failed' as const)
    const none = async () => false
    expect(await confirmLiveWrite({ enabled: true, available: none, prompt })).toBe('ok')
    expect(prompt).not.toHaveBeenCalled()
  })

  test('a device check that throws still prompts (fails closed)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const prompt = jest.fn(async () => 'cancelled' as const)
    const broken = async (): Promise<boolean> => {
      throw new Error('getEnrolledLevelAsync failed')
    }
    expect(await confirmLiveWrite({ enabled: true, available: broken, prompt })).toBe('cancelled')
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  test('enabled: a prompt that throws refuses the write', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const prompt = async (): Promise<'ok'> => {
      throw new Error('lockout')
    }
    expect(await confirmLiveWrite({ enabled: true, available, prompt })).toBe('failed')
  })
})
