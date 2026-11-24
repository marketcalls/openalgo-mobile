// The diagnostics report (design 7.2): what the app knows about the server and itself, for the
// screen and for "Copy diagnostics". Pure: the app version is an input, and the output is
// redacted, so it never holds the API key.
import { type Capabilities, type FeatureId, gate, VERSION_GATES } from '~/core/capabilities/gates'
import type { SchedulerStats } from '~/core/http/scheduler'
import { redact } from '~/core/log/logger'
import type { FeedStatus } from '~/core/realtime/wsClient'

export type CapabilityRow = { feature: string; on: boolean; reason: string }

const FEATURES: readonly FeatureId[] = [
  ...(Object.keys(VERSION_GATES) as (keyof typeof VERSION_GATES)[]),
  'historySource',
]

/** Every feature gate with its state and why. */
export function capabilityReport(c: Capabilities): CapabilityRow[] {
  return FEATURES.map((feature) => {
    const g = gate(c, feature)
    return { feature, on: g.on, reason: g.reason }
  })
}

export type DiagnosticsInput = {
  appVersion: string
  server: {
    origin: string
    version: string | null
    broker: string | null
    feedMode: 'live' | 'polling'
    wsUrl: string | null
  }
  caps: Capabilities | null
  feed: FeedStatus
  scheduler: SchedulerStats
  store: { ticksIn: number; flushes: number; keysPublished: number; keys: number }
  logs: string[]
}

export const DIAGNOSTIC_LOG_LINES = 200

export function buildDiagnostics(i: DiagnosticsInput) {
  return {
    appVersion: i.appVersion,
    server: i.server,
    capabilities: i.caps ? capabilityReport(i.caps) : [],
    feed: i.feed,
    scheduler: i.scheduler,
    store: i.store,
    logs: i.logs.slice(-DIAGNOSTIC_LOG_LINES),
  }
}

export type DiagnosticsReport = ReturnType<typeof buildDiagnostics>

export const serializeDiagnostics = (r: DiagnosticsReport): string =>
  JSON.stringify(redact(r), null, 2)
