// A route is typed by the web API module: an import type is erased, so allowed.
import type { GexData } from '@/api/gex'

export const strike = (d: GexData) => d.strike
