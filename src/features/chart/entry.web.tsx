// Web preview only (Metro picks this file for platform web; never in a release bundle): the
// chart's exported DOM page in an iframe (dom/bridge/webEntry.web.tsx), instead of ChartDom inline
// in the app's own document, where its CSP and shims would take over the app.
import type { JSX } from 'react'
import type { ChartDomProps, DomEntryProps } from '~/dom/bridge/protocol'
import { WebEntry } from '~/dom/bridge/webEntry.web'

export function ChartDom(p: ChartDomProps & DomEntryProps): JSX.Element {
  return <WebEntry entry="src/dom/chart/ChartDom.tsx" {...p} />
}
