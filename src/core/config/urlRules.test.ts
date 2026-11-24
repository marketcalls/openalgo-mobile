import {
  checkWsUrl,
  classifyHost,
  deriveWsUrl,
  normalizeServerUrl,
  pollNetwork,
  sameHost,
} from './urlRules'

const rel = { allowDevHosts: false }
const dev = { allowDevHosts: true }

describe('normalizeServerUrl', () => {
  test('lowercases, trims and drops a lone slash without flagging it', () => {
    expect(normalizeServerUrl('  HTTPS://Algo.Example.COM/  ', rel)).toMatchObject({
      ok: true,
      url: 'https://algo.example.com',
      hostClass: 'public',
      stripped: false,
    })
  })

  test.each([
    ['algo.example.com', 'https://algo.example.com', 'public'],
    ['192.168.1.20', 'http://192.168.1.20:5000', 'home'],
    ['pc.local', 'http://pc.local:5000', 'home'],
    ['http://100.64.0.9:5000', 'http://100.64.0.9:5000', 'home'],
    ['http://pc.local:5000', 'http://pc.local:5000', 'home'],
    ['https://algo.example.com:443', 'https://algo.example.com', 'public'],
    ['https://algo.example.com:8443', 'https://algo.example.com:8443', 'public'],
  ])('%s -> %s', (input, url, hostClass) => {
    expect(normalizeServerUrl(input, rel)).toMatchObject({ ok: true, url, hostClass })
  })

  test('drops path, query and fragment and says so', () => {
    expect(normalizeServerUrl('https://x.ngrok-free.app/login?next=/', rel)).toMatchObject({
      ok: true,
      url: 'https://x.ngrok-free.app',
      stripped: true,
    })
    expect(normalizeServerUrl('https://x.com#top', rel)).toMatchObject({ stripped: true })
    expect(normalizeServerUrl('https://x.com:443', rel)).toMatchObject({ stripped: true })
  })

  test.each([
    ['http://algo.example.com', 'cleartext_public'],
    ['http://172.32.0.1:5000', 'cleartext_public'],
    ['http://localhost:5000', 'dev_host_in_release'],
    ['http://127.0.0.1:5000', 'dev_host_in_release'],
    ['https://u:p@x.com', 'has_credentials'],
    ['ftp://x.com', 'invalid'],
    ['http://', 'invalid'],
    ['https://x.com:99999', 'invalid'],
    ['999.1.1.1', 'invalid'],
    ['', 'empty'],
    ['   ', 'empty'],
  ])('%j is refused as %s', (input, reason) => {
    expect(normalizeServerUrl(input, rel)).toEqual({ ok: false, reason })
  })

  test('dev hosts are accepted when allowed', () => {
    expect(normalizeServerUrl('localhost', dev)).toMatchObject({
      ok: true,
      url: 'http://localhost:5000',
      hostClass: 'dev',
    })
  })
})

describe('classifyHost', () => {
  test.each([
    ['10.1.2.3', 'home'],
    ['172.16.0.1', 'home'],
    ['172.31.255.1', 'home'],
    ['172.32.0.1', 'public'],
    ['192.168.0.1', 'home'],
    ['169.254.1.1', 'home'],
    ['100.64.0.1', 'home'],
    ['100.128.0.1', 'public'],
    ['pc.local', 'home'],
    ['localhost', 'dev'],
    ['127.0.0.2', 'dev'],
    ['8.8.8.8', 'public'],
    ['0.0.0.0', 'public'],
  ])('%s is %s', (host, cls) => {
    expect(classifyHost(host)).toBe(cls)
  })
})

describe('ws urls', () => {
  test('deriveWsUrl', () => {
    expect(deriveWsUrl('https://algo.example.com')).toBe('wss://algo.example.com/ws')
    expect(deriveWsUrl('http://192.168.1.20:5000')).toBe('ws://192.168.1.20:8765')
    expect(deriveWsUrl('nonsense://')).toBeNull()
  })

  test('checkWsUrl enforces the same rules and keeps the path', () => {
    expect(checkWsUrl('ws://algo.example.com/ws', rel)).toEqual({
      ok: false,
      reason: 'cleartext_public',
    })
    expect(checkWsUrl('wss://algo.example.com/ws', rel)).toMatchObject({
      ok: true,
      url: 'wss://algo.example.com/ws',
    })
    expect(checkWsUrl('ws://192.168.1.20:8765', rel)).toMatchObject({
      ok: true,
      url: 'ws://192.168.1.20:8765',
      hostClass: 'home',
    })
    expect(checkWsUrl('https://algo.example.com/ws', rel)).toEqual({
      ok: false,
      reason: 'wrong_scheme',
    })
    expect(checkWsUrl('ws://localhost:8765', rel)).toEqual({
      ok: false,
      reason: 'dev_host_in_release',
    })
    expect(checkWsUrl('', rel)).toEqual({ ok: false, reason: 'empty' })
  })
})

test('sameHost compares hostnames only', () => {
  expect(sameHost('https://Algo.com', 'wss://algo.com/ws')).toBe(true)
  expect(sameHost('http://192.168.1.2:5000', 'ws://192.168.1.2:8765')).toBe(true)
  expect(sameHost('https://a.com', 'wss://b.com/ws')).toBe(false)
})

test('pollNetwork: home and dev hosts are home, the rest tunnel', () => {
  expect(pollNetwork('http://192.168.1.20:5000')).toBe('home')
  expect(pollNetwork('http://localhost:5000')).toBe('home')
  expect(pollNetwork('https://x.ngrok-free.app')).toBe('tunnel')
})
