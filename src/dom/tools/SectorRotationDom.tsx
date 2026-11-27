'use dom'
// Sector Rotation (design 7.8): the web's relative-rotation map on the provider shell. Its routes
// pass through to /api/v1; its PNG save is a blob link the download shim hands to native.
//
// A 'use dom' file exports only its default component; the lifecycle is ToolEntry's.
import '~/dom/web/prelude'
import './tool.css'
import './rotation.phone.css'

import type { DomEntryProps, ToolDomProps } from '~/dom/bridge/protocol'
import { ToolEntry } from './entry'
import { type PageSet, pageOf } from './pages'
import { ToolShell } from './shell'

const ENTRY = 'oa-entry:src/dom/tools/SectorRotationDom.tsx'

const PAGES: PageSet = {
  'sector-rotation': { '/sector-rotation': pageOf(require('@/pages/SectorRotation')) },
}

export default function SectorRotationDom(p: ToolDomProps & DomEntryProps) {
  return <ToolEntry {...p} pages={PAGES} entry={ENTRY} shell={ToolShell} />
}
