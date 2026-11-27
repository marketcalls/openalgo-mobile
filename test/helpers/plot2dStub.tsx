// The tool pages' `@/lib/Plot2D` in the compat suite (jest.compat.config.js): Plotly draws nothing
// in jsdom, so the plot is a div that records how many traces it was given.
import { createElement } from 'react'

export default function Plot2D(p: { style?: object; data?: unknown[] }) {
  return createElement('div', {
    'data-testid': 'plot',
    'data-traces': p.data?.length ?? 0,
    style: p.style,
  })
}
