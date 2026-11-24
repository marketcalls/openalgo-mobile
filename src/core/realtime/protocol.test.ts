import {
  authMsg,
  depthRestToPatch,
  multiquoteToPatch,
  parseInbound,
  pingMsg,
  quoteKey,
  subscribeMsg,
  subscribeOrdersMsg,
  tickToPatch,
  unsubscribeMsg,
} from './protocol'

const parse = (o: unknown) => parseInbound(JSON.stringify(o))

describe('parseInbound', () => {
  test('auth success', () => {
    const m = parse({
      type: 'auth',
      status: 'success',
      message: 'Authentication successful',
      broker: 'zerodha',
      user_id: 'u1',
      supported_features: { ltp: true, quote: true, depth: true },
    })
    expect(m).toMatchObject({ t: 'auth_ok', broker: 'zerodha' })
  })

  test('errors have no type', () => {
    expect(
      parse({ status: 'error', code: 'AUTHENTICATION_ERROR', message: 'Invalid API key' }),
    ).toEqual({ t: 'error', code: 'AUTHENTICATION_ERROR', message: 'Invalid API key' })
    expect(parse({ status: 'error', message: 'boom' })).toEqual({
      t: 'error',
      code: '',
      message: 'boom',
    })
  })

  test('subscribe ack with entries, partial and failed', () => {
    const m = parse({
      type: 'subscribe',
      status: 'partial',
      subscriptions: [
        { symbol: 'RELIANCE', exchange: 'NSE', status: 'success', mode: 'Depth', depth: 20 },
        { symbol: 'BAD', exchange: 'NSE', status: 'error', message: 'nope' },
      ],
      message: 'Subscription processing complete',
      broker: 'angel',
    })
    expect(m).toEqual({
      t: 'sub_ack',
      entries: [
        { symbol: 'RELIANCE', exchange: 'NSE', ok: true, depth: 20 },
        { symbol: 'BAD', exchange: 'NSE', ok: false },
      ],
    })
  })

  test('a 2.0.0.0 ack echoes a numeric mode', () => {
    const m = parse({
      type: 'subscribe',
      status: 'success',
      subscriptions: [{ symbol: 'A', exchange: 'NSE', status: 'success', mode: 2 }],
    })
    expect(m).toEqual({ t: 'sub_ack', entries: [{ symbol: 'A', exchange: 'NSE', ok: true }] })
  })

  test('unsubscribe ack', () => {
    expect(
      parse({ type: 'unsubscribe', status: 'partial', successful: [], failed: [], broker: 'x' }),
    ).toMatchObject({ t: 'unsub_ack', status: 'partial' })
  })

  test('tick with numbers sent as strings', () => {
    const m = parse({
      type: 'market_data',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      mode: 3,
      data: {
        ltp: '1424.5',
        volume: '100000',
        depth: { buy: [{ price: '1423.9', quantity: '10', orders: 2 }], sell: [] },
      },
    })
    expect(m).toMatchObject({ t: 'tick', symbol: 'RELIANCE', exchange: 'NSE', mode: 3 })
    if (m?.t !== 'tick') throw new Error('not a tick')
    expect(m.data.ltp).toBe(1424.5)
    expect(m.data.volume).toBe(100000)
    expect(m.data.depth?.buy[0]).toEqual({ price: 1423.9, quantity: 10, orders: 2 })
  })

  test('orders ack, pong and order_update', () => {
    expect(parse({ type: 'subscribe_orders', status: 'success' })).toEqual({ t: 'orders_ack' })
    expect(parse({ type: 'pong', status: 'success', server_timestamp: 1 })).toEqual({ t: 'pong' })
    const m = parse({
      type: 'order_update',
      orderid: 123,
      symbol: 'SBIN',
      exchange: 'NSE',
      order_status: 'complete',
      quantity: '10',
      mode: 'live',
    })
    expect(m).toMatchObject({
      t: 'order_update',
      orderid: '123',
      symbol: 'SBIN',
      order_status: 'complete',
      quantity: 10,
    })
  })

  test('garbage returns null', () => {
    expect(parseInbound('not json')).toBeNull()
    expect(parseInbound('42')).toBeNull()
    expect(parseInbound('null')).toBeNull()
    expect(parse({ type: 'something_else' })).toBeNull()
    expect(parse({ type: 'market_data', symbol: 'A' })).toBeNull()
  })
})

describe('builders', () => {
  const pairs = [{ symbol: 'RELIANCE', exchange: 'NSE' }]
  test('auth, ping, orders', () => {
    expect(authMsg('k')).toBe('{"action":"authenticate","api_key":"k"}')
    expect(pingMsg()).toBe('{"action":"ping"}')
    expect(subscribeOrdersMsg()).toBe('{"action":"subscribe_orders"}')
  })
  test('subscribe sends depth only in mode 3, default 5', () => {
    expect(subscribeMsg(pairs, 2)).toBe(
      '{"action":"subscribe","symbols":[{"symbol":"RELIANCE","exchange":"NSE"}],"mode":2}',
    )
    expect(subscribeMsg(pairs, 3)).toBe(
      '{"action":"subscribe","symbols":[{"symbol":"RELIANCE","exchange":"NSE"}],"mode":3,"depth":5}',
    )
    expect(subscribeMsg(pairs, 3, 20)).toBe(
      '{"action":"subscribe","symbols":[{"symbol":"RELIANCE","exchange":"NSE"}],"mode":3,"depth":20}',
    )
  })
  test('unsubscribe carries the numeric mode on each symbol', () => {
    expect(unsubscribeMsg(pairs, 3)).toBe(
      '{"action":"unsubscribe","symbols":[{"symbol":"RELIANCE","exchange":"NSE","mode":3}],"mode":3}',
    )
  })
  test('quoteKey', () => {
    expect(quoteKey('NSE', 'RELIANCE')).toBe('NSE:RELIANCE')
  })
})

describe('patches', () => {
  test('tickToPatch drops close 0 and ltp 0, keeps volume 0', () => {
    expect(tickToPatch({ ltp: 0, close: 0, open: 5, volume: 0, oi: 0 })).toEqual({
      open: 5,
      volume: 0,
      oi: 0,
    })
  })

  test('tickToPatch maps names and copies depth', () => {
    const p = tickToPatch({
      ltp: 10,
      average_price: 9.5,
      total_buy_quantity: 100,
      total_sell_quantity: 200,
      depth: {
        buy: [{ price: 9.9, quantity: 1, orders: 1 }],
        sell: [{ price: 10.1, quantity: 2 }],
      },
    })
    expect(p).toMatchObject({ ltp: 10, avgPrice: 9.5, totalBuyQty: 100, totalSellQty: 200 })
    expect(p.depth).toEqual({
      buy: [{ price: 9.9, quantity: 1, orders: 1 }],
      sell: [{ price: 10.1, quantity: 2 }],
      levels: 1,
    })
  })

  const padded = (n: number) => [
    ...Array.from({ length: n }, (_, i) => ({ price: 100 - i, quantity: 1 })),
    { price: 0, quantity: 0 },
    { price: 0, quantity: 0 },
  ]

  test('a WS depth tick with 2 zero-price rows keeps 3 bids', () => {
    const p = tickToPatch({ depth: { buy: padded(3), sell: padded(2) } })
    expect(p.depth?.buy).toHaveLength(3)
    expect(p.depth?.sell).toHaveLength(2)
    expect(p.depth?.levels).toBe(3)
    expect(p.depth?.buy.map((l) => l.price)).toEqual([100, 99, 98])
  })

  test('depthRestToPatch maps every field and drops padding', () => {
    const p = depthRestToPatch({
      ltp: '1424',
      ltq: 5,
      open: 1,
      high: 2,
      low: 0.5,
      prev_close: 1418,
      volume: 7,
      oi: 3,
      totalbuyqty: 11,
      totalsellqty: 12,
      bids: padded(3),
      asks: padded(5),
    })
    expect(p).toMatchObject({
      ltp: 1424,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1418,
      volume: 7,
      oi: 3,
      totalBuyQty: 11,
      totalSellQty: 12,
    })
    expect(p.depth?.buy).toHaveLength(3)
    expect(p.depth?.sell).toHaveLength(5)
    expect(p.depth?.levels).toBe(5)
  })

  test('multiquoteToPatch maps prev_close to close', () => {
    expect(
      multiquoteToPatch({
        ltp: 5,
        prev_close: 4,
        open: 1,
        high: 6,
        low: 0,
        volume: 9,
        oi: 0,
        bid: 4.9,
        ask: 5.1,
      }),
    ).toEqual({ ltp: 5, close: 4, open: 1, high: 6, volume: 9, oi: 0, bid: 4.9, ask: 5.1 })
  })
})
