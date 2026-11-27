// What the shell routes (design 7.8): each tool's web path, as the web App.tsx routes it, and the
// pages an entry brings. An entry keeps its PageSet to itself; the shell shows the root path's page
// always (kept alive) and an extra path's page over it.
import type { ComponentType } from 'react'
import { TOOL_TOPICS, type ToolPageId, type ToolTopics } from '~/dom/bridge/protocol'

export const TOOL_ROUTES: Record<ToolPageId, { path: string; extra?: string[] }> = {
  oitracker: { path: '/oitracker' },
  oirange: { path: '/oirange' },
  maxpain: { path: '/maxpain' },
  ivsmile: { path: '/ivsmile' },
  gex: { path: '/gex' },
  gammadensity: { path: '/gammadensity' },
  'portfolio-backtester': {
    path: '/portfolio-backtester',
    extra: ['/portfolio-backtester/results'],
  },
  'sip-backtester': { path: '/sip-backtester', extra: ['/sip-backtester/results'] },
  'portfolio-analyzer': { path: '/portfolio-analyzer' },
  'sector-rotation': { path: '/sector-rotation' },
}

/** An entry's pages: for each tool it hosts, path → page. */
export type PageSet = Partial<Record<ToolPageId, Record<string, ComponentType>>>

/** A web page module loaded through a typed require (tsc never checks the page's closure). */
export const pageOf = (module: unknown): ComponentType =>
  (module as { default: ComponentType }).default

/** What native pushes to the page (the same values as schemas.ts TOOL_PUSH_TOPICS, by type). */
export const TOOL_PUSH_TOPICS: ToolTopics = { ...TOOL_TOPICS, back: 'tool.back', top: 'tool.top' }
