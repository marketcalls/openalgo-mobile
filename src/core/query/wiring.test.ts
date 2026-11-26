import { focusManager, onlineManager } from '@tanstack/react-query'
import { AppState } from 'react-native'
import { wireQueryManagers } from './wiring'

describe('wireQueryManagers', () => {
  afterEach(() => jest.restoreAllMocks())

  it('feeds AppState to focusManager and cleans up', () => {
    let handler: ((s: string) => void) | undefined
    const remove = jest.fn()
    const add = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _t: string,
      h: (s: string) => void,
    ) => {
      handler = h
      return { remove }
    }) as never)
    const cleanup = wireQueryManagers()
    expect(add).toHaveBeenCalledWith('change', expect.any(Function))
    handler?.('background')
    expect(focusManager.isFocused()).toBe(false)
    handler?.('active')
    expect(focusManager.isFocused()).toBe(true)
    cleanup()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('feeds NetInfo to onlineManager', () => {
    const NetInfo = require('@react-native-community/netinfo')
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never)
    const unsub = jest.fn()
    let listener: ((s: { isConnected: boolean | null }) => void) | undefined
    jest.spyOn(NetInfo, 'addEventListener').mockImplementation(((l: typeof listener) => {
      listener = l
      return unsub
    }) as never)
    const cleanup = wireQueryManagers()
    listener?.({ isConnected: false })
    expect(onlineManager.isOnline()).toBe(false)
    listener?.({ isConnected: true })
    expect(onlineManager.isOnline()).toBe(true)
    cleanup()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})
