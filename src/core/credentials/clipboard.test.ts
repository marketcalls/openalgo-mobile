import { clearLogs, getLogLines } from '~/core/log/logger'
import { type ClipboardLike, clearClipboardIfPasted } from './clipboard'

const KEY = 'ab'.repeat(32)

function fakeClipboard(initial: string) {
  let text = initial
  return {
    text: () => text,
    getStringAsync: jest.fn(async () => text),
    setStringAsync: jest.fn(async (next: string) => {
      text = next
      return true
    }),
  } satisfies ClipboardLike & { text: () => string }
}

afterEach(() => jest.restoreAllMocks())

test("clearClipboardIfPasted(true) sets '' when the clipboard holds the key", async () => {
  const c = fakeClipboard(KEY)
  await clearClipboardIfPasted(true, KEY, c)
  expect(c.setStringAsync).toHaveBeenCalledWith('')
  expect(c.text()).toBe('')
})

test('the key as scanned (uppercase, spaced, broken over lines) is cleared too', async () => {
  const upper = KEY.toUpperCase()
  const c = fakeClipboard(`${upper.slice(0, 32)}\n${upper.slice(32)} `)
  await clearClipboardIfPasted(true, KEY, c)
  expect(c.text()).toBe('')
})

test('other clipboard text is left alone', async () => {
  const c = fakeClipboard('meeting at 5')
  await clearClipboardIfPasted(true, KEY, c)
  expect(c.setStringAsync).not.toHaveBeenCalled()
  expect(c.text()).toBe('meeting at 5')
})

test('a different key on the clipboard is left alone', async () => {
  const c = fakeClipboard('cd'.repeat(32))
  await clearClipboardIfPasted(true, KEY, c)
  expect(c.setStringAsync).not.toHaveBeenCalled()
})

test('a typed key never touches the clipboard', async () => {
  const c = fakeClipboard(KEY)
  await clearClipboardIfPasted(false, KEY, c)
  expect(c.getStringAsync).not.toHaveBeenCalled()
  expect(c.setStringAsync).not.toHaveBeenCalled()
})

test('a clipboard failure is logged without the key and does not throw', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  clearLogs()
  const c = fakeClipboard(KEY)
  c.getStringAsync.mockRejectedValueOnce(new Error(`denied ${KEY}`))
  await expect(clearClipboardIfPasted(true, KEY, c)).resolves.toBeUndefined()
  const lines = getLogLines().filter((l) => l.includes('could not clear the clipboard'))
  expect(lines).toHaveLength(1)
  expect(lines[0]).not.toContain(KEY)
})
