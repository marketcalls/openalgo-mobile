// What a tool page could reach the network with (design 7.7), replaced before the page's code
// runs: fetch, XMLHttpRequest and WebSocket cross the bridge; EventSource is removed and
// sendBeacon sends nothing (the CSP refuses both as well); window.open opens nothing, since a
// link the page opens goes through guardLinks (links.ts), which hands https to native.
import type { DomClient } from './client'
import { createBridgedFetch } from './fetch'
import { createBridgedWebSocket } from './websocket'
import { createBridgedXhr } from './xhr'

export function installNetworkShims(win: Window, client: DomClient): void {
  const page = win as Window & typeof globalThis
  page.fetch = createBridgedFetch(client)
  page.XMLHttpRequest = createBridgedXhr(client)
  page.WebSocket = createBridgedWebSocket(client)
  delete (page as Partial<Window & typeof globalThis>).EventSource
  page.open = () => null
  // sendBeacon is the navigator's prototype's; the page's own navigator takes this one first
  Object.defineProperty(page.navigator, 'sendBeacon', { configurable: true, value: () => false })
}
