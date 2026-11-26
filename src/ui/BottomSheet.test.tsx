import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Text } from 'react-native'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'
import { withSpring, withTiming } from 'react-native-reanimated'
import { BottomSheet } from './BottomSheet'
import { SHEET_CLOSE_MS, sheetOffsets, snapIndexFor } from './sheetMath'

// The mock's shared values reset on every render, so a snap is checked by where it sends the panel.
jest.mock('react-native-reanimated', () => {
  const mock = require('react-native-reanimated/mock')
  return { ...mock, withSpring: jest.fn(mock.withSpring), withTiming: jest.fn(mock.withTiming) }
})
const springTo = () => jest.mocked(withSpring).mock.lastCall?.[0]

describe('sheet math', () => {
  test('a snap point is the translateY that shows that share of the height', () => {
    expect(sheetOffsets([0.5, 1], 800)).toEqual([400, 0])
  })

  test('a release snaps to the offset nearest where its fling would carry it', () => {
    expect(snapIndexFor(390, 0, [400, 0])).toBe(0)
    expect(snapIndexFor(100, 0, [400, 0])).toBe(1)
    expect(snapIndexFor(300, -900, [400, 0])).toBe(1)
    expect(snapIndexFor(500, 0, [400, 0])).toBe(0)
  })

  test('a release carried more than SHEET_CLOSE_PX below the lowest offset closes', () => {
    expect(snapIndexFor(400, 1200, [400, 0])).toBe('close')
    expect(snapIndexFor(530, 0, [400, 0])).toBe('close')
  })
})

type Props = Partial<Parameters<typeof BottomSheet>[0]>

async function renderSheet(p: Props = {}) {
  const onClose = jest.fn()
  const onSnap = jest.fn()
  const view = await render(
    <BottomSheet testID="s" header={<Text>H</Text>} onClose={onClose} onSnap={onSnap} {...p}>
      <Text>B</Text>
    </BottomSheet>,
  )
  return { onClose, onSnap, ...view }
}

/** Lays out the sheet's container and its header as the device would. */
async function layOut(height: number, header: number) {
  const layout = (h: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: h } } })
  await fireEvent(screen.getByTestId('s'), 'layout', layout(height))
  await fireEvent(screen.getByTestId('s-header'), 'layout', layout(header))
}

/** Where the panel opens: its translateY as rendered. */
const openedAt = () => {
  const style = [screen.getByTestId('s-panel').props.style].flat(Infinity)
  const transform = style.find((s) => s?.transform)?.transform as { translateY?: number }[]
  return transform.find((t) => 'translateY' in t)?.translateY
}

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

test('it renders the header and the body', async () => {
  await renderSheet()
  expect(screen.getByText('H')).toBeOnTheScreen()
  expect(screen.getByText('B')).toBeOnTheScreen()
})

test('(RF 5) the handle is a button that toggles half and full height', async () => {
  const { onSnap } = await renderSheet()
  const handle = () => screen.getByTestId('s-handle')
  expect(screen.getByRole('button', { name: 'Expand' })).toBe(handle())

  await fireEvent.press(handle())
  expect(onSnap).toHaveBeenLastCalledWith(1)
  expect(springTo()).toBe(0)
  expect(handle()).toHaveAccessibleName('Collapse')

  await fireEvent.press(handle())
  expect(onSnap).toHaveBeenLastCalledWith(0)
  expect(handle()).toHaveAccessibleName('Expand')
  expect(onSnap).toHaveBeenCalledTimes(2)
})

test('the handle goes to the last snap point and back to the first', async () => {
  const { onSnap } = await renderSheet({ snapPoints: [0.3, 0.6, 1] })
  await fireEvent.press(screen.getByTestId('s-handle'))
  expect(onSnap).toHaveBeenLastCalledWith(2)
  await fireEvent.press(screen.getByTestId('s-handle'))
  expect(onSnap).toHaveBeenLastCalledWith(0)
})

test('a press on the backdrop closes once, after the slide down', async () => {
  jest.useFakeTimers()
  const { onClose } = await renderSheet()
  await layOut(800, 60)
  await fireEvent.press(screen.getByTestId('s-backdrop'))
  await fireEvent.press(screen.getByTestId('s-backdrop'))
  expect(withTiming).toHaveBeenCalledTimes(1)
  expect(withTiming).toHaveBeenCalledWith(800, { duration: SHEET_CLOSE_MS })
  await act(async () => jest.advanceTimersByTime(SHEET_CLOSE_MS - 1))
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => jest.advanceTimersByTime(1))
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('a sheet that is gone before the slide ends never calls onClose', async () => {
  jest.useFakeTimers()
  const { onClose, unmount } = await renderSheet()
  await fireEvent.press(screen.getByTestId('s-backdrop'))
  await unmount()
  await act(async () => jest.advanceTimersByTime(SHEET_CLOSE_MS))
  expect(onClose).not.toHaveBeenCalled()
})

test('under reduce motion a snap and the close are not animated', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValueOnce(true)
  jest.useFakeTimers()
  const { onClose, onSnap } = await renderSheet()
  await fireEvent.press(screen.getByTestId('s-handle'))
  expect(onSnap).toHaveBeenLastCalledWith(1)
  expect(withSpring).not.toHaveBeenCalled()
  await fireEvent.press(screen.getByTestId('s-backdrop'))
  expect(withTiming).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledTimes(1)
})

test("VoiceOver's escape gesture closes it", async () => {
  jest.useFakeTimers()
  const { onClose } = await renderSheet()
  await fireEvent(screen.getByTestId('s'), 'accessibilityEscape')
  await act(async () => jest.advanceTimersByTime(SHEET_CLOSE_MS))
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('(RF 5) only the header drags: the body is outside the gesture detector', async () => {
  await renderSheet()
  const detectors = screen.root?.queryAll((n) => 'handlerTags' in n.props) ?? []
  expect(detectors).toHaveLength(1)
  const inside = detectors.flatMap((d) => d.queryAll((n) => !!n.props.testID))
  const ids = inside.map((n) => n.props.testID)
  expect(ids).toContain('s-handle')
  expect(ids).not.toContain('s-body')
  expect(screen.getByTestId('s-body')).toBeOnTheScreen()
})

test('the body fits what each snap point shows below the header', async () => {
  await renderSheet()
  await layOut(800, 60)
  expect(screen.getByTestId('s-body')).toHaveStyle({ maxHeight: 340 })
  expect(openedAt()).toBe(400)

  await fireEvent.press(screen.getByTestId('s-handle'))
  expect(screen.getByTestId('s-body')).toHaveStyle({ maxHeight: 740 })
})

test('it opens at the initial snap point', async () => {
  await renderSheet({ initial: 1 })
  await layOut(800, 60)
  expect(screen.getByTestId('s-handle')).toHaveAccessibleName('Collapse')
  expect(openedAt()).toBe(0)
})

describe('a drag on the header', () => {
  const drag = (translationY: number, velocityY: number) =>
    act(async () =>
      fireGestureHandler(getByGestureTestId('s-pan'), [
        { translationY: 0, velocityY: 0 },
        { translationY, velocityY },
        { translationY, velocityY },
      ]),
    )

  test('up past the middle snaps to full height', async () => {
    const { onSnap } = await renderSheet()
    await layOut(800, 60)
    await drag(-300, 0)
    expect(onSnap).toHaveBeenLastCalledWith(1)
    expect(springTo()).toBe(0)
    expect(screen.getByTestId('s-handle')).toHaveAccessibleName('Collapse')
  })

  test('a short drag down springs back to half height', async () => {
    const { onSnap, onClose } = await renderSheet()
    await layOut(800, 60)
    await drag(100, 0)
    expect(onSnap).toHaveBeenLastCalledWith(0)
    expect(springTo()).toBe(400)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('a fling down closes it after the slide', async () => {
    // The release reaches JS in a microtask (scheduleOnRN); only the close's timer is faked.
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] })
    const { onClose, onSnap } = await renderSheet()
    await layOut(800, 60)
    await drag(40, 1200)
    expect(onSnap).not.toHaveBeenCalled()
    expect(withTiming).toHaveBeenCalledWith(800, { duration: SHEET_CLOSE_MS })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => jest.advanceTimersByTime(SHEET_CLOSE_MS))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
