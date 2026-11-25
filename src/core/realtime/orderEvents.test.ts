import { clearLogs, getLogLines } from '~/core/log/logger'
import { createOrderEventBus } from './orderEvents'
import type { OrderUpdate } from './protocol'

const update = (orderid: string): OrderUpdate => ({
  t: 'order_update',
  orderid,
  order_status: 'complete',
})

beforeEach(() => {
  clearLogs()
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('createOrderEventBus', () => {
  test('an emit reaches every subscriber with the update', () => {
    const bus = createOrderEventBus()
    const a = jest.fn()
    const b = jest.fn()
    bus.subscribe(a)
    bus.subscribe(b)
    const u = update('A1')
    bus.emit(u)
    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(u)
    expect(b).toHaveBeenCalledWith(u)
  })

  test('an unsubscribed listener hears nothing more', () => {
    const bus = createOrderEventBus()
    const a = jest.fn()
    const off = bus.subscribe(a)
    bus.emit(update('A1'))
    off()
    off()
    bus.emit(update('A2'))
    expect(a).toHaveBeenCalledTimes(1)
  })

  test('a listener that throws does not keep the update from the others', () => {
    const bus = createOrderEventBus()
    const after = jest.fn()
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe(after)
    expect(() => bus.emit(update('A1'))).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(getLogLines().join('\n')).toContain('an order event listener failed')
  })

  test('a listener may unsubscribe another during an emit; that one still hears this emit', () => {
    const bus = createOrderEventBus()
    const second = jest.fn()
    let offSecond = () => {}
    bus.subscribe(() => offSecond())
    offSecond = bus.subscribe(second)
    bus.emit(update('A1'))
    bus.emit(update('A2'))
    expect(second).toHaveBeenCalledTimes(1)
  })
})
