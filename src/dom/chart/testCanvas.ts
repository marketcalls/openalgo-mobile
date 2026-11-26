// Test helper for the "dom" jest project (preflight conflict 2): jsdom has no 2D canvas, no
// ResizeObserver and no matchMedia, and openalgo-charts needs all three to build a widget. The
// stubs draw nothing; every context call is a no-op, and the reads the engine makes return the
// shapes it expects.

type Restore = () => void

/** A 2D context whose every method is a no-op and whose properties keep what is set. */
function fakeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const state: Record<PropertyKey, unknown> = {
    canvas,
    measureText: (text: string) => ({
      width: text.length * 6,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3,
    }),
    getImageData: (_x: number, _y: number, w = 1, h = 1) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(Math.max(1, w * h) * 4),
    }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => null,
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  }
  const noop = () => {}
  return new Proxy(state, {
    get: (target, prop) => (prop in target ? target[prop] : noop),
    set: (target, prop, value) => {
      target[prop] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Installs the stubs on jsdom's window; the returned function puts back what was there. */
export function stubCanvas(): Restore {
  const proto = HTMLCanvasElement.prototype
  const getContext = Object.getOwnPropertyDescriptor(proto, 'getContext')
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>()
  Object.defineProperty(proto, 'getContext', {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement, kind: string) {
      if (kind !== '2d') return null
      let ctx = contexts.get(this)
      if (ctx === undefined) {
        ctx = fakeContext(this)
        contexts.set(this, ctx)
      }
      return ctx
    },
  })
  const g = globalThis as { ResizeObserver?: unknown; matchMedia?: unknown }
  const resizeObserver = g.ResizeObserver
  const matchMedia = g.matchMedia
  g.ResizeObserver = FakeResizeObserver
  g.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
  return () => {
    if (getContext) Object.defineProperty(proto, 'getContext', getContext)
    g.ResizeObserver = resizeObserver
    g.matchMedia = matchMedia
  }
}
