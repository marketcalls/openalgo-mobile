// The Tools tab's model (design 7.8): which tools this build hosts and how, the groups the tab
// lists them in, whether a tile opens on this server, and the tool screen's copy. A held order a
// tool page sends is read here too, strictly: only an order the review can show as it will go.
import { z } from 'zod'
import { type Capabilities, type FeatureId, gate, VERSION_GATES } from '~/core/capabilities/gates'
import { atLeast } from '~/core/config/version'
import { TOOL_PAGE_IDS, type ToolPageId } from '~/dom/bridge/protocol'
import { ALL_EXCHANGES, isQuoteOnly } from '~/market/instruments/exchanges'
import { TOOLS, type ToolEntry } from '~/market/tools/registry'

export type TileState =
  | { kind: 'open' }
  | { kind: 'needs'; version: string; reason: string }
  | { kind: 'later' }

/**
 * How each registry tool is built: Option Chain natively, the ten tool pages as DOM pages (the
 * portfolio three and Sector Rotation behind their feature gates), the rest after this build
 * (plan F flips them).
 */
export const TOOL_BUILD: Readonly<
  Record<string, { build: 'native' | 'dom' | 'later'; feature?: FeatureId }>
> = {
  optionchain: { build: 'native' },
  oitracker: { build: 'dom' },
  oirange: { build: 'dom' },
  maxpain: { build: 'dom' },
  ivsmile: { build: 'dom' },
  gex: { build: 'dom' },
  gammadensity: { build: 'dom' },
  'portfolio-backtester': { build: 'dom', feature: 'portfolioTools' },
  'sip-backtester': { build: 'dom', feature: 'portfolioTools' },
  'portfolio-analyzer': { build: 'dom', feature: 'portfolioTools' },
  'sector-rotation': { build: 'dom', feature: 'sectorRotation' },
  strategybuilder: { build: 'later' },
  'strategybuilder-portfolio': { build: 'later' },
  ivchart: { build: 'later' },
  straddle: { build: 'later' },
  straddlepnl: { build: 'later' },
  volsurface: { build: 'later' },
  strikeprofile: { build: 'later' },
  oiprofile: { build: 'later' },
  arbitrage: { build: 'later' },
}

/** The tab's sections, ours (not the web's order): Option Chain first, as a trader looks for it. */
export const TOOL_GROUPS: readonly { title: string; ids: readonly string[] }[] = [
  {
    title: 'Option chain & trading',
    ids: ['optionchain', 'arbitrage', 'strategybuilder', 'strategybuilder-portfolio'],
  },
  {
    title: 'Options analytics',
    ids: [
      'oitracker',
      'oirange',
      'maxpain',
      'ivsmile',
      'gex',
      'gammadensity',
      'strikeprofile',
      'volsurface',
      'ivchart',
      'oiprofile',
      'straddle',
      'straddlepnl',
    ],
  },
  {
    title: 'Portfolio & research',
    ids: ['portfolio-backtester', 'sip-backtester', 'portfolio-analyzer', 'sector-rotation'],
  },
]

const BY_ID: ReadonlyMap<string, ToolEntry> = new Map(TOOLS.map((t) => [t.id, t]))

/** The registry's entry for `id`; undefined for an id the web frontend does not list. */
export const toolOf = (id: string): ToolEntry | undefined => BY_ID.get(id)

export const isToolPage = (id: string): id is ToolPageId =>
  (TOOL_PAGE_IDS as readonly string[]).includes(id)

/**
 * Whether a tile opens on this server. A gated tool with no capabilities read yet needs its
 * version, as `gate` says of a server whose version is unknown.
 */
export function tileState(id: string, caps: Capabilities | null): TileState {
  const b = TOOL_BUILD[id]
  if (!b || b.build === 'later') return { kind: 'later' }
  if (!b.feature) return { kind: 'open' }
  const min = VERSION_GATES[b.feature as keyof typeof VERSION_GATES]
  if (!caps) return { kind: 'needs', version: min, reason: 'server version unknown' }
  const g = gate(caps, b.feature)
  return g.on ? { kind: 'open' } : { kind: 'needs', version: g.needs ?? min, reason: g.reason }
}

export const LATER_NOTE = 'Not in this build yet'
export const needsNote = (version: string) => `Needs OpenAlgo ${version}`

/**
 * What a tap on a tile that does not open says: both versions, and why when the server is new
 * enough yet lacks the tool (a main-branch build, design 5.8).
 */
export function gatedToast(state: Exclude<TileState, { kind: 'open' }>, server: string | null) {
  if (state.kind === 'later') return `${LATER_NOTE}. It arrives in the next update.`
  const head = `${needsNote(state.version)}.`
  if (server === null) return `${head} This server's version is unknown.`
  return atLeast(server, state.version)
    ? `${head} This server is ${server}, but ${state.reason}.`
    : `${head} This server is ${server}.`
}

/** The path the page opens at (the shell's TOOL_ROUTES, dom/tools/pages.ts): its tool's id. */
export const mainPath = (page: ToolPageId) => `/${page}`

/** The route each option tool's figures come from: its reply is what "Updated" times. */
export const PRIMARY_ROUTE: Readonly<Partial<Record<ToolPageId, string>>> = {
  oitracker: '/oitracker/api/oi-data',
  oirange: '/oitracker/api/oi-data',
  maxpain: '/oitracker/api/maxpain',
  ivsmile: '/ivsmile/api/iv-smile-data',
  gex: '/gex/api/gex-data',
  gammadensity: '/gammadensity/api/gamma-data',
}

export const TOOL_READY_TIMEOUT_MS = 20_000
export const TOOL_TIMEOUT_COPY = "The tool didn't load."
export const TOOL_GONE_COPY = 'The tool was closed to free memory.'
export const TOOL_LINK_INCOMPLETE = 'This tool link is incomplete.'
export const UNREADABLE_ORDER = "This order couldn't be read, so it wasn't sent."
export const SHARE_FAILED = "Couldn't open the share sheet. Try again."
export const STOP_BACKTEST = 'Stop the backtest?'
export const STOP_BACKTEST_BODY = 'It is still running. Leaving stops it.'

const MAX_TEXT = 64
const nonNegative = z.number().finite().min(0)

/**
 * The placeorder body a page may send, its `apikey` placeholder aside (the HTTP client adds the
 * real key): every field the review shows, and nothing it does not. The prices default to 0, as
 * the server's OrderSchema does; the type and product never default, so the review shows what
 * the page chose.
 */
const HeldOrderSchema = z.strictObject({
  strategy: z.string().min(1).max(MAX_TEXT),
  exchange: z.string().refine((e) => ALL_EXCHANGES.includes(e)),
  symbol: z.string().min(1).max(MAX_TEXT),
  action: z.enum(['BUY', 'SELL']),
  quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pricetype: z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']),
  product: z.enum(['MIS', 'CNC', 'NRML']),
  price: nonNegative.default(0),
  trigger_price: nonNegative.default(0),
  disclosed_quantity: z.number().int().min(0).default(0),
})

export type HeldOrder = z.output<typeof HeldOrderSchema>

/**
 * The order a held placeorder carries, or null when it cannot be read: then it is answered
 * without a send. An index cannot be traded, whatever the page says (the server would take it:
 * its VALID_EXCHANGES lists the index exchanges).
 */
export function readHeldOrder(body: Record<string, unknown>): HeldOrder | null {
  const { apikey: _placeholder, ...rest } = body
  const r = HeldOrderSchema.safeParse(rest)
  if (!r.success || isQuoteOnly(r.data.exchange)) return null
  return r.data
}
