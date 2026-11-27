// Web preview only (Metro picks this file for platform web; never in a release bundle): each tool
// page's exported DOM page in an iframe (dom/bridge/webEntry.web.tsx), instead of the entry
// inline in the app's own document, where its CSP and network shims would take over the app.
// The same keys as entries.tsx, and the same .tsx extension (a .ts/.web.tsx pair bundles the real
// entry on web).
import type { ComponentType, JSX } from 'react'
import type { DomEntryProps, ToolDomProps, ToolPageId } from '~/dom/bridge/protocol'
import { WebEntry } from '~/dom/bridge/webEntry.web'

function OptionToolsDom(p: ToolDomProps & DomEntryProps): JSX.Element {
  return <WebEntry entry="src/dom/tools/OptionToolsDom.tsx" {...p} />
}

function PortfolioToolsDom(p: ToolDomProps & DomEntryProps): JSX.Element {
  return <WebEntry entry="src/dom/tools/PortfolioToolsDom.tsx" {...p} />
}

function SectorRotationDom(p: ToolDomProps & DomEntryProps): JSX.Element {
  return <WebEntry entry="src/dom/tools/SectorRotationDom.tsx" {...p} />
}

export const TOOL_ENTRY: Readonly<Record<ToolPageId, ComponentType<ToolDomProps & DomEntryProps>>> =
  {
    oitracker: OptionToolsDom,
    oirange: OptionToolsDom,
    maxpain: OptionToolsDom,
    ivsmile: OptionToolsDom,
    gex: OptionToolsDom,
    gammadensity: OptionToolsDom,
    'portfolio-backtester': PortfolioToolsDom,
    'sip-backtester': PortfolioToolsDom,
    'portfolio-analyzer': PortfolioToolsDom,
    'sector-rotation': SectorRotationDom,
  }
