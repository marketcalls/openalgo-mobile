import {
  BROKER_DEPTH,
  confirmLevels,
  type DepthMap,
  depthChoices,
  downgradeKey,
  supportedDepth,
} from './depthSupport'

describe('supportedDepth (C8)', () => {
  test('dhan sends 20 levels on NSE', () => {
    expect(supportedDepth('dhan', 'NSE')).toEqual([5, 20])
  })

  test.each([
    ['dhan', 'BSE'],
    ['angel', 'NSE'],
    ['zerodha', 'NFO'],
    [null, 'NSE'],
  ] as const)('%s on %s: 5 only', (broker, ex) => {
    expect(supportedDepth(broker, ex)).toEqual([5])
  })

  test.each([
    'compositedge',
    'fivepaisaxts',
    'ibulls',
    'iifl',
    'jainamxts',
    'rmoney',
    'wisdom',
    'dhan',
  ])('%s: 20 on NSE and NFO, 5 on BSE, BFO, MCX and CDS', (broker) => {
    expect(supportedDepth(broker, 'NSE')).toEqual([5, 20])
    expect(supportedDepth(broker, 'NFO')).toEqual([5, 20])
    for (const ex of ['BSE', 'BFO', 'MCX', 'CDS']) expect(supportedDepth(broker, ex)).toEqual([5])
  })

  test('no broker offers 30 levels today', () => {
    const all = Object.values(BROKER_DEPTH).flatMap((byEx) => Object.values(byEx).flat())
    expect(all).not.toContain(30)
  })

  test('a map entry always includes 5, sorted and without repeats', () => {
    const map: DepthMap = { x: { NSE: [20, 5, 20] }, y: { NSE: [20] } }
    expect(supportedDepth('x', 'NSE', map)).toEqual([5, 20])
    expect(supportedDepth('y', 'NSE', map)).toEqual([5, 20])
  })
})

describe('depthChoices', () => {
  const map: DepthMap = { x: { NSE: [5, 20, 30] } }
  const none: ReadonlySet<string> = new Set()

  test('live: every level the map offers', () => {
    expect(
      depthChoices({ map, broker: 'x', exchange: 'NSE', live: true, downgraded: none }),
    ).toEqual([5, 20, 30])
  })

  test('not live: 5 only', () => {
    expect(
      depthChoices({ map, broker: 'x', exchange: 'NSE', live: false, downgraded: none }),
    ).toEqual([5])
  })

  test('a broker and exchange downgraded this session: 5 only', () => {
    const downgraded = new Set([downgradeKey('x', 'NSE')])
    expect(depthChoices({ map, broker: 'x', exchange: 'NSE', live: true, downgraded })).toEqual([5])
    expect(downgradeKey('x', 'NSE')).toBe('x:NSE')
  })

  test('an exchange or broker the map does not list, or no broker: 5 only', () => {
    expect(
      depthChoices({ map, broker: 'x', exchange: 'BSE', live: true, downgraded: none }),
    ).toEqual([5])
    expect(
      depthChoices({ map, broker: null, exchange: 'NSE', live: true, downgraded: none }),
    ).toEqual([5])
  })

  test('the bundled map by default', () => {
    expect(depthChoices({ broker: 'dhan', exchange: 'NFO', live: true, downgraded: none })).toEqual(
      [5, 20],
    )
  })
})

describe('confirmLevels (ruling 10)', () => {
  const wired = { requested: 20, feedLive: true, wired: true, wsLevels: [] } as const

  test('an ack depth of 5 for a request of 20 downgrades', () => {
    expect(confirmLevels({ ...wired, confirmedDepth: 5 })).toEqual({ downgraded: true })
  })

  test('two 5-level ticks downgrade; one does not yet', () => {
    expect(confirmLevels({ ...wired, wsLevels: [5] })).toEqual({ downgraded: false })
    expect(confirmLevels({ ...wired, wsLevels: [5, 4] })).toEqual({ downgraded: true })
  })

  test('20-level ticks do not downgrade', () => {
    expect(confirmLevels({ ...wired, confirmedDepth: 20, wsLevels: [20, 20] })).toEqual({
      downgraded: false,
    })
  })

  test('a first tick past 5 levels confirms, whatever follows', () => {
    expect(confirmLevels({ ...wired, confirmedDepth: 20, wsLevels: [20, 5, 5] })).toEqual({
      downgraded: false,
    })
  })

  test('the refused subscribe (an error ack) downgrades while the feed is live', () => {
    expect(confirmLevels({ ...wired, wired: false })).toEqual({ downgraded: true })
  })

  test('not wired because the feed is down does not downgrade', () => {
    expect(confirmLevels({ ...wired, feedLive: false, wired: false })).toEqual({
      downgraded: false,
    })
  })

  test('confirmed depth 0 (no levels yet, the padded book off hours) does not downgrade', () => {
    expect(confirmLevels({ ...wired, confirmedDepth: 0 })).toEqual({ downgraded: false })
  })

  test('a request of 5 never downgrades', () => {
    expect(confirmLevels({ requested: 5, feedLive: true, wired: false, wsLevels: [1, 1] })).toEqual(
      { downgraded: false },
    )
  })
})
