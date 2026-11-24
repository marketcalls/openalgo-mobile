import { WebSocket } from 'ws'

describe('compat environment', () => {
  test('fetch exists', () => {
    expect(typeof fetch).toBe('function')
  })

  test('the ws WebSocket exists', () => {
    expect(typeof WebSocket).toBe('function')
  })
})
