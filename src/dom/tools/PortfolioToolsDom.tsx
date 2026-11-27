'use dom'
// The portfolio tools (design 7.8): Portfolio Backtester and SIP Backtester, each with its report
// page, and Portfolio Analyzer, on the provider shell. Their routes pass through to /api/v1. No page
// here draws with Plotly: their charts are openalgo-charts, whose vertical swipe portfolio.phone.css
// gives to the page.
//
// A 'use dom' file exports only its default component; the lifecycle is ToolEntry's.
import '~/dom/web/prelude'
import './tool.css'
import './portfolio.phone.css'

import type { DomEntryProps, ToolDomProps } from '~/dom/bridge/protocol'
import { ToolEntry } from './entry'
import { type PageSet, pageOf } from './pages'

const ENTRY = 'oa-entry:src/dom/tools/PortfolioToolsDom.tsx'

const PAGES: PageSet = {
  'portfolio-backtester': {
    '/portfolio-backtester': pageOf(require('@/pages/PortfolioBacktester')),
    '/portfolio-backtester/results': pageOf(require('@/pages/PortfolioBacktesterResults')),
  },
  'sip-backtester': {
    '/sip-backtester': pageOf(require('@/pages/SipBacktester')),
    '/sip-backtester/results': pageOf(require('@/pages/SipBacktesterResults')),
  },
  'portfolio-analyzer': { '/portfolio-analyzer': pageOf(require('@/pages/PortfolioAnalyzer')) },
}

export default function PortfolioToolsDom(p: ToolDomProps & DomEntryProps) {
  return <ToolEntry {...p} pages={PAGES} entry={ENTRY} />
}
