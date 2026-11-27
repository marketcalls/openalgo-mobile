// Plotly on a phone (ux-bar T11-04..06): touch-safe flags for every figure, and below 768 px the
// phone figure (fonts, margins, legends, a thinned strike axis that keeps the ATM label).
import { EN_IN, PHONE_MAX_WIDTH, phoneFigure, thinTicks } from './phoneFigure'

type Obj = Record<string, unknown>

/** Freezes a fixture all the way down, so a write to the page's own figure throws. */
function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null) {
    for (const v of Object.values(x)) deepFreeze(v)
    Object.freeze(x)
  }
  return x
}

/** OI Tracker's figure (OITracker.tsx:196-318): two index bar traces, the ATM line at an index. */
function oiTracker(strikes: number[], atm: number) {
  const x = strikes.map((_, i) => i)
  const text = strikes.map(String)
  const step = Math.max(1, Math.floor(strikes.length / 15))
  const atmIndex = strikes.indexOf(atm)
  return deepFreeze({
    data: [
      { x, y: x, type: 'bar', name: 'Call Options OI (lots)', text, textposition: 'none' },
      { x, y: x, type: 'bar', name: 'Put Options OI (lots)', text, textposition: 'none' },
    ],
    layout: {
      title: { text: 'NIFTY 02DEC26 - current', font: { color: '#e0e0e0', size: 14 } },
      barmode: 'group',
      bargap: 0.15,
      hovermode: 'x unified',
      hoverlabel: { bgcolor: '#1e293b', font: { color: '#e0e0e0', size: 12 } },
      showlegend: true,
      legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.15, font: { size: 11 } },
      margin: { l: 70, r: 30, t: 50, b: 80 },
      xaxis: {
        tickmode: 'array',
        tickvals: x.filter((i) => i % step === 0),
        ticktext: text.filter((_, i) => i % step === 0),
        title: { text: 'Strike Price', font: { size: 12 } },
        tickfont: { size: 10 },
        tickangle: -45,
      },
      yaxis: { title: { text: 'Open Interest', font: { size: 12 } }, tickfont: { size: 10 } },
      annotations: [
        { x: atmIndex, y: 1, yref: 'paper', text: `ATM Strike ${atm}`, font: { size: 12 } },
      ],
      shapes: [{ type: 'line', x0: atmIndex, x1: atmIndex, y0: 0, y1: 1, yref: 'paper' }],
    },
  })
}

const range = (from: number, n: number, step: number) =>
  Array.from({ length: n }, (_, i) => from + i * step)

describe('phoneFigure', () => {
  test("OI Tracker's 47 bars at 336 px: at most 6 strike labels, the ATM strike among them", () => {
    const fig = oiTracker(range(23_000, 47, 50), 24_150)
    const out = phoneFigure(fig, 336).layout as Obj
    const xaxis = out.xaxis as Obj
    const vals = xaxis.tickvals as number[]
    expect(vals.length).toBeLessThanOrEqual(6)
    expect(vals.length).toBeGreaterThanOrEqual(4)
    expect(vals).toContain(23)
    expect(xaxis.ticktext).toEqual(vals.map((i) => String(23_000 + i * 50)))
    expect(xaxis.ticktext).toContain('24150')
    // the index axis stays: the line and its label keep their x
    expect(xaxis.tickmode).toBe('array')
    expect(out.shapes).toEqual(fig.layout.shapes)
    expect((out.annotations as Obj[])[0]?.x).toBe(23)
    // evenly spaced, in order
    const gaps = vals.slice(1).map((v, i) => v - (vals[i] as number))
    expect(new Set(gaps).size).toBe(1)
    expect(out.bargap).toBe(0.08)
    expect(out.bargroupgap).toBe(0)
  })

  test('a chain whose strikes are 1 to 47 keeps its index axis and the ATM label too', () => {
    const fig = oiTracker(range(1, 47, 1), 9)
    const xaxis = phoneFigure(fig, 336).layout.xaxis as Obj
    expect(xaxis.tickvals).toContain(8)
    expect(xaxis.ticktext).toContain('9')
    expect((xaxis.ticktext as string[]).length).toBeLessThanOrEqual(6)
  })

  test('fonts, margins, axes and the title for a phone', () => {
    const fig = oiTracker(range(23_000, 47, 50), 24_150)
    const out = phoneFigure(fig, 360).layout as Obj
    const xaxis = out.xaxis as Obj
    const yaxis = out.yaxis as Obj
    // the x title goes (the strikes say what they are); the y title carries the unit
    expect(xaxis.title).toBeUndefined()
    expect(yaxis.title).toEqual({ text: 'Open Interest', font: { size: 12 } })
    for (const ax of [xaxis, yaxis]) {
      expect((ax.tickfont as Obj).size).toBe(12)
      expect(ax.tickangle).toBe(0)
      expect(ax.exponentformat).toBe('none')
      expect(ax.automargin).toBe(true)
    }
    expect(((out.legend as Obj).font as Obj).size).toBe(12)
    expect(((out.hoverlabel as Obj).font as Obj).size).toBe(13)
    expect((out.hoverlabel as Obj).bgcolor).toBe('#1e293b')
    expect((out.annotations as Obj[])[0]?.font).toEqual({ size: 12 })
    expect(out.title).toEqual({
      text: 'NIFTY 02DEC26 - current',
      font: { color: '#e0e0e0', size: 13 },
      x: 0,
      xanchor: 'left',
      xref: 'paper',
    })
    // its legend already sits below the plot: it keeps its own bottom margin and legend y
    expect(out.margin).toEqual({ l: 48, r: 8, t: 50, b: 80 })
    expect((out.legend as Obj).y).toBe(-0.15)
    expect(out.hovermode).toBe('x unified')
  })

  test("IV Smile's numeric strike axis keeps its ticks", () => {
    const fig = deepFreeze({
      data: [{ x: [24000, 24100], y: [12, 13], type: 'scatter', name: 'Call IV' }],
      layout: {
        xaxis: { title: { text: 'Strike Price' }, tickfont: { size: 10 }, tickangle: -45 },
        legend: { y: -0.15 },
      },
    })
    const xaxis = phoneFigure(fig, 360).layout.xaxis as Obj
    expect(xaxis.tickmode).toBeUndefined()
    expect(xaxis.tickvals).toBeUndefined()
    expect(xaxis.range).toBeUndefined()
    expect(xaxis.tickangle).toBe(0)
  })

  test("Gamma Density's legend above the plot moves below it", () => {
    const fig = deepFreeze({
      data: [
        { x: [1, 2], y: [1, 2], type: 'scatter', name: 'Convexity' },
        { x: [1, 2], y: [2, 1], type: 'bar', name: 'Density' },
      ],
      layout: {
        legend: { orientation: 'h', x: 0.5, y: 1.08, font: { size: 11 } },
        margin: { l: 50, r: 20, t: 30, b: 40 },
        xaxis: { range: [1, 2], title: { text: 'Strike / Price' } },
        yaxis: { range: [0, 1.08] },
        hovermode: 'x unified',
      },
    })
    const out = phoneFigure(fig, 360).layout as Obj
    const legend = out.legend as Obj
    expect(legend.y).toBeLessThan(0)
    expect(legend.yanchor).toBe('top')
    expect(out.margin).toEqual({ l: 48, r: 8, t: 30, b: 64 })
    expect((out.xaxis as Obj).range).toEqual([1, 2])
  })

  test('a payoff-shaped figure keeps the bottom margin and legend y it derived from its height', () => {
    const fig = deepFreeze({
      data: [{ x: [1, 2], y: [1, -1], type: 'scatter', name: 'Payoff' }],
      layout: { legend: { y: -0.32 }, margin: { l: 60, r: 20, t: 20, b: 132 } },
    })
    const out = phoneFigure(fig, 360).layout as Obj
    expect((out.margin as Obj).b).toBe(132)
    expect((out.legend as Obj).y).toBe(-0.32)
    expect((out.margin as Obj).t).toBe(30)
  })

  test('one visible trace hides its legend; bars with no hovermode hover by x (MP-2)', () => {
    const fig = deepFreeze({
      data: [
        { x: [0, 1], y: [3, 4], type: 'bar', name: 'Max Pain', text: ['1', '2'] },
        { x: [0, 1], y: [1, 1], type: 'bar', visible: false },
      ],
      layout: { showlegend: true, legend: { y: -0.15 } },
    })
    const out = phoneFigure(fig, 360).layout as Obj
    expect(out.showlegend).toBe(false)
    expect(out.hovermode).toBe('x')
  })

  test('at 800 px the figure is the page own, and no input is written', () => {
    const fig = oiTracker(range(23_000, 47, 50), 24_150)
    expect(PHONE_MAX_WIDTH).toBe(768)
    expect(phoneFigure(fig, 800)).toBe(fig)
    expect(() => phoneFigure(fig, 360)).not.toThrow()
    expect(fig.layout.xaxis.tickangle).toBe(-45)
  })
})

describe('thinTicks', () => {
  test('evenly spaced on a grid through the first line, never more than the room', () => {
    expect(thinTicks(47, 5, [23])).toEqual([3, 13, 23, 33, 43])
    expect(thinTicks(47, 5, [])).toEqual([0, 10, 20, 30, 40])
    expect(thinTicks(3, 5, [])).toEqual([0, 1, 2])
    expect(thinTicks(0, 5, [])).toEqual([])
  })

  test('a second line takes the place of the grid labels beside it', () => {
    const t = thinTicks(47, 5, [23, 28])
    expect(t).toContain(23)
    expect(t).toContain(28)
    expect(t.length).toBeLessThanOrEqual(5)
    expect(t).toEqual([...t].sort((a, b) => a - b))
  })
})

describe('en-IN', () => {
  test('groups in lakhs and crores, as an Indian trader reads OI', () => {
    const { formatLocale } = require('d3-format') as {
      formatLocale(f: object): { format(spec: string): (n: number) => string }
    }
    const f = formatLocale(EN_IN.format).format(',')
    expect(f(123456)).toBe('1,23,456')
    expect(f(123456789)).toBe('12,34,56,789')
    expect(f(999)).toBe('999')
    expect(EN_IN).toEqual(expect.objectContaining({ moduleType: 'locale', name: 'en-IN' }))
  })
})
