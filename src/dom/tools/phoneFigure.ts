// A web Plotly figure made readable on a phone (ux-bar T11-05): the web lays its charts out for a
// desktop card, with 10-11 px ticks, a 45° strike axis and wide margins. Below 768 px the layout is
// copied and adjusted; the page's own objects are never written. Data and shapes are kept, so an
// ATM or Max Pain line stays at its index and is always labelled.

export const PHONE_MAX_WIDTH = 768
/** The room one strike label takes on the axis, in px. */
const LABEL_PX = 56
const MARGIN = { l: 48, r: 8 } as const
const MIN_TOP = 30
const PHONE_BOTTOM = 64
const MIN_FONT = 12
const HOVER_FONT = 13
const TITLE_FONT = 13
/** Where a legend from above the plot goes: below it. */
const LEGEND_BELOW = -0.15
const AXIS = /^[xy]axis\d*$/

/** Plotly's en-IN locale: lakh and crore grouping for every `,` number format (hover text). */
export const EN_IN = {
  moduleType: 'locale',
  name: 'en-IN',
  dictionary: {},
  format: {
    decimal: '.',
    thousands: ',',
    // d3-format cycles this list from the right: 3 digits, then 2s (enough for 17 digits)
    grouping: [3, 2, 2, 2, 2, 2, 2, 2],
    currency: ['₹', ''],
  },
} as const

type Obj = Record<string, unknown>
export type Figure = { data?: unknown; layout?: unknown; config?: unknown; frames?: unknown }

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const objOf = (x: unknown): Obj => (isObj(x) ? x : {})
const num = (x: unknown): number | undefined => (typeof x === 'number' ? x : undefined)

/** `font` with its size at least `min` (Plotly's default size is 12). */
const atLeast = (font: unknown, min: number): Obj => {
  const f = objOf(font)
  return { ...f, size: Math.max(num(f.size) ?? MIN_FONT, min) }
}
const sized = (font: unknown, size: number): Obj => ({ ...objOf(font), size })

/** Strike labels for an index axis of `n` bars: at most `max`, evenly spaced on a grid through the
 *  first line's index, and every line's index among them. */
export function thinTicks(n: number, max: number, lines: number[]): number[] {
  if (n <= 0) return []
  const required = [...new Set(lines.filter((i) => Number.isInteger(i) && i >= 0 && i < n))].sort(
    (a, b) => a - b,
  )
  const room = Math.max(1, max)
  const step = Math.max(1, Math.ceil(n / room))
  const grid: number[] = []
  for (let i = (required[0] ?? 0) % step; i < n; i += step) {
    // a line's own label takes the place of the grid labels within half a step of it
    if (required.some((r) => r !== i && Math.abs(r - i) <= step / 2)) continue
    grid.push(i)
  }
  const out = new Set([...required, ...grid])
  // a second line can leave one label too many: drop grid labels from the far end
  const extra = [...grid].reverse()
  while (out.size > Math.max(room, required.length) && extra.length > 0) {
    out.delete(extra.shift() as number)
  }
  return [...out].sort((a, b) => a - b)
}

/** An index bar chart (OI Tracker, OI Range, Max Pain, GEX): x is 0..n-1 and `text` the strikes. */
function indexBars(data: unknown, xaxis: Obj): { n: number; labels: string[] } | null {
  if (xaxis.tickmode !== 'array' || !Array.isArray(data)) return null
  for (const t of data) {
    if (!isObj(t) || t.type !== 'bar' || !Array.isArray(t.x) || !Array.isArray(t.text)) continue
    const x = t.x as unknown[]
    if (x.length === 0 || t.text.length !== x.length || !x.every((v, i) => v === i)) continue
    return { n: x.length, labels: (t.text as unknown[]).map(String) }
  }
  return null
}

/** The vertical lines drawn at an x-axis index (the ATM and Max Pain strikes). */
function lineIndexes(shapes: unknown): number[] {
  if (!Array.isArray(shapes)) return []
  return shapes.flatMap((s) => {
    if (!isObj(s) || s.type !== 'line' || s.x0 !== s.x1 || (s.xref ?? 'x') !== 'x') return []
    return typeof s.x0 === 'number' ? [s.x0] : []
  })
}

function phoneAxis(key: string, axis: unknown): Obj {
  const { title, ...rest } = objOf(axis)
  const out: Obj = {
    ...rest,
    tickfont: atLeast(rest.tickfont, MIN_FONT),
    exponentformat: 'none',
    tickangle: 0,
    automargin: true,
  }
  // The strikes say what the x axis is; a y title carries its unit and stays.
  if (key.startsWith('y') && title !== undefined) {
    out.title =
      isObj(title) && isObj(title.font) ? { ...title, font: atLeast(title.font, MIN_FONT) } : title
  }
  return out
}

/** The figure for a plot `width` px wide: the page's own at 768 px and up, else a phone copy. */
export function phoneFigure<F extends Figure>(fig: F, width: number): F {
  if (width >= PHONE_MAX_WIDTH) return fig
  const src = objOf(fig.layout)
  const layout: Obj = { ...src }

  for (const key of Object.keys(src)) {
    if (AXIS.test(key)) layout[key] = phoneAxis(key, src[key])
  }

  const legend = isObj(src.legend) ? src.legend : null
  const legendBelow = (num(legend?.y) ?? 0) < 0
  if (legend) {
    const moved = (num(legend.y) ?? 0) > 1
    layout.legend = {
      ...legend,
      font: atLeast(legend.font, MIN_FONT),
      ...(moved ? { y: LEGEND_BELOW, yanchor: 'top' } : {}),
    }
  }

  const margin = objOf(src.margin)
  layout.margin = {
    ...margin,
    ...MARGIN,
    t: Math.max(num(margin.t) ?? MIN_TOP, MIN_TOP),
    // a legend already below the plot sized its own bottom margin (plan F's payoff from its height)
    ...(legendBelow ? {} : { b: PHONE_BOTTOM }),
  }

  if (Array.isArray(src.annotations)) {
    layout.annotations = src.annotations.map((a) =>
      isObj(a) ? { ...a, font: atLeast(a.font, MIN_FONT) } : a,
    )
  }
  if (src.hoverlabel !== undefined) {
    const hl = objOf(src.hoverlabel)
    layout.hoverlabel = { ...hl, font: sized(hl.font, HOVER_FONT) }
  }
  if (src.title !== undefined) {
    const t = typeof src.title === 'string' ? { text: src.title } : objOf(src.title)
    layout.title = { ...t, font: sized(t.font, TITLE_FONT), x: 0, xanchor: 'left', xref: 'paper' }
  }

  const xaxis = isObj(layout.xaxis) ? layout.xaxis : null
  const bars = xaxis ? indexBars(fig.data, xaxis) : null
  if (xaxis && bars) {
    const plotWidth = width - MARGIN.l - MARGIN.r
    const ticks = thinTicks(bars.n, Math.floor(plotWidth / LABEL_PX), lineIndexes(src.shapes))
    layout.xaxis = { ...xaxis, tickvals: ticks, ticktext: ticks.map((i) => bars.labels[i]) }
    layout.bargap = 0.08
    layout.bargroupgap = 0
  }

  const traces = Array.isArray(fig.data) ? fig.data.filter(isObj) : []
  const visible = traces.filter((t) => t.visible !== false && t.visible !== 'legendonly')
  if (visible.length === 1) layout.showlegend = false
  if (src.hovermode === undefined && traces.some((t) => t.type === 'bar')) layout.hovermode = 'x'

  return { ...fig, layout } as F
}
