// Each tool page's DOM entry (design 7.8): three 'use dom' bundles, one per family. The web
// preview build takes entries.web.tsx instead (dev only); both files share the .tsx extension, so
// Metro never pairs a .ts native file with the web one and bundles the real entry on web.
import type { ComponentType } from 'react'
import type { DomEntryProps, ToolDomProps, ToolPageId } from '~/dom/bridge/protocol'
import OptionToolsDom from '~/dom/tools/OptionToolsDom'
import PortfolioToolsDom from '~/dom/tools/PortfolioToolsDom'
import SectorRotationDom from '~/dom/tools/SectorRotationDom'

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
