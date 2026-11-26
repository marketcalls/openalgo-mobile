// DOM content imports this file (dom/chart/ok.ts, dom/web/env.ts), so whatever it imports at run
// time would ride into a DOM page. The type-only import is erased and stays allowed.
import type { DOMProps } from 'expo/dom'
import { z } from 'zod'
import { x } from '../../market/x'
export const BRIDGE_VERSION = 1
export type Props = DOMProps
export const carried = [z, x]
