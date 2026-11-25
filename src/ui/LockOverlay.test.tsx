import {
  act,
  isHiddenFromAccessibility,
  render,
  screen,
  userEvent,
  waitFor,
} from '@testing-library/react-native'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { createKeyStore } from '~/core/credentials/keyStore'
import { createLockController } from '~/core/credentials/lock'
import { createKeyVault } from '~/core/credentials/vault'
import { memoryKV } from '../../test/helpers/memoryKV'
import { LockLayer, LockOverlay } from './LockOverlay'
import { tokens } from './tokens'

const KEY = 'ab'.repeat(32)

function setup(o: { usable?: boolean; unreadable?: boolean } = {}) {
  const secure = memoryKV({ 'oa.p1.apikey': KEY })
  if (o.unreadable) {
    secure.get = async () => {
      throw new Error('keystore unavailable')
    }
  }
  const store = createKeyStore(secure, memoryKV({ 'oa.p1.hasKey': '1' }), 'p1')
  const vault = createKeyVault(store)
  const authenticate = jest.fn(async () => false)
  const controller = createLockController({
    now: () => 0,
    settings: () => ({ enabled: true, lockAfterMs: 300_000 }),
    authenticate,
    available: async () => o.usable ?? true,
    vault,
  })
  const unlock = jest.spyOn(controller, 'unlock')
  return { controller, vault, authenticate, unlock }
}

/** A prompt the test answers by hand: `answer(true)` unlocks, `answer(false)` cancels. */
function heldPrompt() {
  const answers: ((ok: boolean) => void)[] = []
  const prompt = () =>
    new Promise<boolean>((r) => {
      answers.push(r)
    })
  const answer = (ok: boolean) => answers.shift()?.(ok)
  return { prompt, answer, waiting: () => answers.length }
}

test('an opaque full-screen cover with the unlock button', async () => {
  const { controller } = setup()
  await render(<LockOverlay controller={controller} />)
  const cover = screen.getByTestId('lock-overlay')
  expect(cover).toHaveStyle({
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: tokens.light.background,
  })
  expect(StyleSheet.flatten(cover.props.style).backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
  // the first prompt is cancelled, so the title and the button appear
  expect(await screen.findByText('OpenAlgo is locked')).toBeOnTheScreen()
  expect(screen.getByRole('button', { name: 'Unlock' })).toHaveProp('testID', 'lock-unlock')
})

test('while the first attempt runs only the cover shows, and a success never shows the title', async () => {
  const { controller, authenticate, vault } = setup()
  const held = heldPrompt()
  authenticate.mockImplementation(held.prompt)
  await render(<LockOverlay controller={controller} />)
  await waitFor(() => expect(held.waiting()).toBe(1))
  expect(screen.getByTestId('lock-overlay')).toBeOnTheScreen()
  expect(screen.queryByText('OpenAlgo is locked')).toBeNull()
  expect(screen.queryByTestId('lock-unlock')).toBeNull()

  await act(async () => held.answer(true))
  await waitFor(() => expect(controller.isLocked()).toBe(false))
  expect(vault.get()).toBe(KEY)
  expect(screen.queryByText('OpenAlgo is locked')).toBeNull()
  expect(screen.queryByTestId('lock-unlock')).toBeNull()
})

test('the button appears only after a cancelled attempt, and a retry blanks the cover again', async () => {
  const { controller, authenticate } = setup()
  const held = heldPrompt()
  authenticate.mockImplementation(held.prompt)
  const user = userEvent.setup()
  await render(<LockOverlay controller={controller} />)
  await waitFor(() => expect(held.waiting()).toBe(1))
  expect(screen.queryByTestId('lock-unlock')).toBeNull()

  await act(async () => held.answer(false))
  expect(await screen.findByText('OpenAlgo is locked')).toBeOnTheScreen()
  await user.press(screen.getByTestId('lock-unlock'))
  await waitFor(() => expect(held.waiting()).toBe(1))
  expect(screen.queryByText('OpenAlgo is locked')).toBeNull()
  expect(screen.queryByTestId('lock-unlock')).toBeNull()

  await act(async () => held.answer(false))
  expect(await screen.findByTestId('lock-unlock')).toBeOnTheScreen()
  expect(controller.isLocked()).toBe(true)
  expect(authenticate).toHaveBeenCalledTimes(2)
})

test('what it covers is hidden from assistive technology', async () => {
  const { controller } = setup()
  await render(
    <View>
      <Text>Available cash 320.66</Text>
      <LockOverlay controller={controller} />
    </View>,
  )
  const beneath = screen.getByText('Available cash 320.66', { includeHiddenElements: true })
  expect(isHiddenFromAccessibility(beneath)).toBe(true)
  expect(isHiddenFromAccessibility(await screen.findByTestId('lock-unlock'))).toBe(false)
})

test('it prompts once on mount, and not again on a re-render', async () => {
  const { controller, authenticate, unlock } = setup()
  const view = await render(<LockOverlay controller={controller} />)
  await view.rerender(<LockOverlay controller={controller} />)
  expect(unlock).toHaveBeenCalledTimes(1)
  expect(authenticate).toHaveBeenCalledTimes(1)
})

test('the button calls controller.unlock, which can open the vault', async () => {
  const { controller, vault, authenticate, unlock } = setup()
  const user = userEvent.setup()
  await render(<LockOverlay controller={controller} />)
  const button = await screen.findByTestId('lock-unlock')
  authenticate.mockResolvedValueOnce(true)
  await user.press(button)
  expect(unlock).toHaveBeenCalledTimes(2)
  expect(authenticate).toHaveBeenCalledTimes(2)
  expect(controller.isLocked()).toBe(false)
  expect(vault.get()).toBe(KEY)
})

test('on a phone with no passcode or biometrics, mounting opens the vault with no prompt', async () => {
  const { controller, vault, authenticate } = setup({ usable: false })
  await render(<LockOverlay controller={controller} />)
  await waitFor(() => expect(controller.isLocked()).toBe(false))
  expect(authenticate).not.toHaveBeenCalled()
  expect(vault.get()).toBe(KEY)
})

test('after a retry fails to read the key, it offers to forget the key', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  const { controller, authenticate } = setup({ unreadable: true })
  authenticate.mockResolvedValue(true)
  const onForgetKey = jest.fn()
  const user = userEvent.setup()
  await render(<LockOverlay controller={controller} onForgetKey={onForgetKey} />)
  await waitFor(() => expect(authenticate).toHaveBeenCalledTimes(1))
  const button = await screen.findByTestId('lock-unlock')
  expect(screen.queryByTestId('lock-forget')).toBeNull()
  await user.press(button)
  const forget = await screen.findByRole('button', { name: 'Forget key and set up again' })
  expect(forget).toHaveProp('testID', 'lock-forget')
  await user.press(forget)
  expect(onForgetKey).toHaveBeenCalledTimes(1)
})

describe('LockLayer', () => {
  test('on iOS the cover goes in a window above every presented sheet', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios')
    await render(
      <LockLayer>
        <View testID="cover" />
      </LockLayer>,
    )
    const cover = screen.getByTestId('cover')
    // an ancestor is the native full-window overlay, not the React Native root
    let n = cover.parent
    const names: string[] = []
    while (n) {
      names.push(String(typeof n.type === 'string' ? n.type : (n.type as { name?: string }).name))
      n = n.parent
    }
    expect(names.some((x) => /FullWindowOverlay/.test(x))).toBe(true)
    jest.restoreAllMocks()
  })

  test("on Android the cover is the root's last child, already above its screens", async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await render(
      <LockLayer>
        <View testID="cover" />
      </LockLayer>,
    )
    let n = screen.getByTestId('cover').parent
    while (n) {
      expect(String((n.type as { name?: string }).name ?? n.type)).not.toMatch(/FullWindowOverlay/)
      n = n.parent
    }
    jest.restoreAllMocks()
  })
})
