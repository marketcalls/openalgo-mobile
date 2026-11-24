import * as Haptics from 'expo-haptics'
import { notifySuccess, notifyWarning, tapLight } from './haptics'

jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
}))

const h = jest.mocked(Haptics)

afterEach(() => jest.clearAllMocks())

test('tapLight is a light impact', () => {
  tapLight()
  expect(h.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light)
})

test('notifySuccess and notifyWarning are the matching notifications', () => {
  notifySuccess()
  notifyWarning()
  expect(h.notificationAsync.mock.calls).toEqual([
    [Haptics.NotificationFeedbackType.Success],
    [Haptics.NotificationFeedbackType.Warning],
  ])
})

test('a device without haptics is ignored quietly', async () => {
  h.impactAsync.mockRejectedValueOnce(new Error('no vibrator'))
  h.notificationAsync
    .mockRejectedValueOnce(new Error('no vibrator'))
    .mockRejectedValueOnce(new Error('no vibrator'))
  expect(tapLight()).toBeUndefined()
  expect(notifySuccess()).toBeUndefined()
  expect(notifyWarning()).toBeUndefined()
  // Let the swallowed rejections settle; an unhandled one would fail the run.
  await new Promise((r) => setTimeout(r, 0))
})
