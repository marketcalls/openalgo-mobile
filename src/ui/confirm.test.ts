import { Alert, type AlertButton } from 'react-native'
import { confirm } from './confirm'

afterEach(() => jest.restoreAllMocks())

type Answer = (buttons: AlertButton[], options: { onDismiss?: () => void }) => void

const answering = (answer: Answer) =>
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons, options) =>
      answer(buttons ?? [], options ?? {}),
    )

describe('confirm', () => {
  test('true when the user taps the ok button, which comes after Cancel', async () => {
    const alert = answering((b) => b[1]?.onPress?.())
    await expect(confirm('Remove RELIANCE from Watchlist?', '', 'Remove')).resolves.toBe(true)
    expect(alert).toHaveBeenCalledWith(
      'Remove RELIANCE from Watchlist?',
      undefined,
      [
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Remove', style: 'default' }),
      ],
      expect.objectContaining({ cancelable: true }),
    )
  })

  test('false on Cancel or a dismissal', async () => {
    answering((b) => b[0]?.onPress?.())
    await expect(confirm('Title', 'Body', 'OK')).resolves.toBe(false)
    answering((_b, o) => o.onDismiss?.())
    await expect(confirm('Title', 'Body', 'OK')).resolves.toBe(false)
  })

  test('a destructive ok button is styled so, and the body is passed on', async () => {
    const alert = answering((b) => b[1]?.onPress?.())
    await confirm('Delete Swing and its 3 symbols?', 'This cannot be undone.', 'Delete', {
      destructive: true,
    })
    expect(alert.mock.calls[0]?.[1]).toBe('This cannot be undone.')
    expect(alert.mock.calls[0]?.[2]?.[1]).toMatchObject({ text: 'Delete', style: 'destructive' })
  })
})
