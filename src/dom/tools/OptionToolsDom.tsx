'use dom'
// The six option analytics tools (design 7.8): the web's own pages, unchanged, on the provider
// shell, with their session routes answered on the phone (dom/routes) through the bridge. Plotly
// is made touch-safe before any page draws (plotlyTouch). None of the six pages, nor anything they
// import, uses a router or query hook, so they mount on the bare shell: no MemoryRouter and no
// QueryClientProvider, and neither package in this bundle (design 17.6; ruling 12a).
//
// A 'use dom' file exports only its default component; the lifecycle is ToolEntry's.
import { PRELUDE } from '~/dom/web/prelude'
import './tool.css'
import './options.phone.css'
import './plotlyTouch'

import type { DomEntryProps, ToolDomProps } from '~/dom/bridge/protocol'
import { ToolEntry } from './entry'
import { type PageSet, pageOf } from './pages'
import { BareToolShell } from './shellCore'

const ENTRY = 'oa-entry:src/dom/tools/OptionToolsDom.tsx'

const PAGES: PageSet = {
  oitracker: { '/oitracker': pageOf(require('@/pages/OITracker')) },
  oirange: { '/oirange': pageOf(require('@/pages/OIRange')) },
  maxpain: { '/maxpain': pageOf(require('@/pages/MaxPain')) },
  ivsmile: { '/ivsmile': pageOf(require('@/pages/IVSmile')) },
  gex: { '/gex': pageOf(require('@/pages/GEXDashboard')) },
  gammadensity: { '/gammadensity': pageOf(require('@/pages/GammaDensity')) },
}

export default function OptionToolsDom(p: ToolDomProps & DomEntryProps) {
  return <ToolEntry {...p} pages={PAGES} entry={ENTRY} shell={BareToolShell} prelude={PRELUDE} />
}
