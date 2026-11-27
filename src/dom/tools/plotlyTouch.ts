// Plotly made touch-safe for the option tool pages (design 7.7 "Phone layout"; ux-bar T11-04..06).
// The pages draw through `@/lib/Plot2D`, whose react-plotly component calls `Plotly.react` on the
// core module; importing this module wraps both drawing calls of that same core. On a phone the
// trader scrolls the page with a vertical swipe that starts on a chart, and taps for a value: no
// drag, no zoom, no mode bar, hover kept. The page's figure objects are never written.
import { EN_IN, type Figure, phoneFigure } from './phoneFigure'

type PlotFn = (gd: unknown, ...rest: unknown[]) => unknown
export type PlotlyDraw = { react: PlotFn; newPlot: PlotFn }
type Obj = Record<string, unknown>

const TOUCH_CONFIG = {
  displayModeBar: false,
  scrollZoom: false,
  doubleClick: false,
  showTips: false,
  responsive: true,
} as const

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

// One copy per source object, so a page that passes the same layout again gives Plotly the same
// object (its react diff then sees nothing new), and a new one gives a new copy.
const layouts = new WeakMap<object, { width: number; data: unknown; out: Obj }>()
const configs = new WeakMap<object, { scene: boolean; out: Obj }>()
const adapted = new WeakSet<object>()

/** The plot's width: its element's, or the window's before it is laid out. */
function widthOf(gd: unknown): number {
  const el = typeof gd === 'string' ? document.getElementById(gd) : gd
  const w =
    typeof el === 'object' && el !== null ? (el as { clientWidth?: unknown }).clientWidth : 0
  return typeof w === 'number' && w > 0 ? w : window.innerWidth
}

function touchLayout(fig: Figure, width: number): Obj {
  const src = fig.layout
  const hit = isObj(src) ? layouts.get(src) : undefined
  if (hit && hit.width === width && hit.data === fig.data) return hit.out
  const phone = phoneFigure({ data: fig.data, layout: isObj(src) ? src : {} }, width).layout
  const out: Obj = { ...(phone as Obj), dragmode: false }
  if (isObj(src)) layouts.set(src, { width, data: fig.data, out })
  return out
}

function touchConfig(fig: Figure): Obj {
  const src = isObj(fig.config) ? fig.config : null
  // Plan F's Vol Surface: a 3D scene whose page chose its own buttons keeps them (V4).
  const scene = isObj(fig.layout) && isObj(fig.layout.scene)
  const hit = src ? configs.get(src) : undefined
  if (hit && hit.scene === scene) return hit.out
  const keepBar = scene && Array.isArray(src?.modeBarButtons)
  const out: Obj = {
    ...src,
    ...TOUCH_CONFIG,
    ...(keepBar ? { displayModeBar: true } : {}),
    locale: src?.locale ?? EN_IN.name,
  }
  if (src) configs.set(src, { scene, out })
  return out
}

/** Wraps P.react and P.newPlot, in both of Plotly's call forms, once per P. */
export function adaptPlotly(P: PlotlyDraw): void {
  if (adapted.has(P)) return
  adapted.add(P)
  for (const name of ['react', 'newPlot'] as const) {
    const draw = P[name]
    P[name] = function (this: unknown, gd: unknown, ...rest: unknown[]) {
      const width = widthOf(gd)
      const [first] = rest
      // react-plotly's form (factory.js:89): (gd, {data, layout, config, frames})
      if (isObj(first)) {
        const fig = first as Figure
        return draw.call(this, gd, {
          ...fig,
          layout: touchLayout(fig, width),
          config: touchConfig(fig),
        })
      }
      const [data, layout, config, ...more] = rest
      const fig = { data, layout, config }
      return draw.call(this, gd, data, touchLayout(fig, width), touchConfig(fig), ...more)
    }
  }
}

// The one Plotly core every Plot2D page draws with.
const core = require('plotly.js/lib/core') as PlotlyDraw & { register(m: unknown): void }
core.register(EN_IN)
adaptPlotly(core)
