// The error model (design 7.5) for the stock server's replies (contract S3-S7).

export type ApiErrorKind =
  | 'KeyInvalid'
  | 'BrokerLoggedOut'
  | 'IpBanned'
  | 'Unsupported'
  | 'SemiAutoBlocked'
  | 'RateLimited'
  | 'Validation'
  | 'Server'
  | 'Network'
  | 'MaybePlaced'

/** Which of the two ban replies the server sent (S4). */
export type BanForm = 'text' | 'json'

/** One contract a request named. */
export type SymbolRef = { exchange: string; symbol: string }

export type ApiErrorInit = {
  kind: ApiErrorKind
  /** The HTTP status, or 0 when no response arrived. */
  status: number
  /** The endpoint id, or the path for a public GET. */
  endpoint: string
  serverMessage?: string
  unknownFields?: string[]
  /** A multiquotes 400 when no symbol was valid: the contracts the server does not list. */
  invalidSymbols?: SymbolRef[]
  banForm?: BanForm
  /** A RateLimited order the scheduler refused unsent: the seconds until its 429 gate opens. */
  retryInSec?: number
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number
  readonly endpoint: string
  readonly serverMessage?: string
  readonly unknownFields?: string[]
  readonly invalidSymbols?: SymbolRef[]
  readonly banForm?: BanForm
  readonly retryInSec?: number

  constructor(init: ApiErrorInit) {
    super(`${init.endpoint}: ${init.kind} (${init.status})`)
    this.name = 'ApiError'
    this.kind = init.kind
    this.status = init.status
    this.endpoint = init.endpoint
    this.serverMessage = init.serverMessage
    this.unknownFields = init.unknownFields
    this.invalidSymbols = init.invalidSymbols
    this.banForm = init.banForm
    this.retryInSec = init.retryInSec
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const UNKNOWN_FIELD = 'Unknown field.'
// One `'field': [...]` entry of Python's repr() of marshmallow's error dict.
const REPR_ENTRY = /'([^']+)':\s*\[([^\]]*)\]/g

function fromDict(v: unknown, out: string[]): void {
  if (!isRecord(v)) return
  for (const [k, x] of Object.entries(v)) {
    if (Array.isArray(x)) {
      if (x.includes(UNKNOWN_FIELD)) out.push(k)
    } else fromDict(x, out)
  }
}

/**
 * The fields a 400 rejects as unknown, from any of the four S7 shapes: a repr string
 * `message`, a dict `message`, or `errors`, which is read whenever it is present.
 */
export function unknownFields(body: unknown): string[] | undefined {
  if (!isRecord(body)) return undefined
  const out: string[] = []
  if (body.errors !== undefined) fromDict(body.errors, out)
  else if (typeof body.message === 'string') {
    for (const [, field = '', list = ''] of body.message.matchAll(REPR_ENTRY)) {
      if (list.includes(`'${UNKNOWN_FIELD}'`)) out.push(field)
    }
  } else fromDict(body.message, out)
  return out.length ? out : undefined
}

/**
 * The contracts a multiquotes 400 names when none was valid (services/quotes_service.py:237-253):
 * `invalid_symbols[{symbol, exchange, error}]`. Entries without both strings are skipped.
 */
export function invalidSymbols(body: unknown): SymbolRef[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.invalid_symbols)) return undefined
  const out: SymbolRef[] = []
  for (const x of body.invalid_symbols) {
    if (isRecord(x) && typeof x.exchange === 'string' && typeof x.symbol === 'string') {
      out.push({ exchange: x.exchange, symbol: x.symbol })
    }
  }
  return out.length ? out : undefined
}

const FIXED: Record<ApiErrorKind, string> = {
  MaybePlaced: 'Status unknown: checking order book',
  IpBanned:
    "This server has banned your IP address. Unban it in OpenAlgo's Security page from another network, then try again.",
  KeyInvalid: 'Your API key no longer works on this server. Enter it again.',
  BrokerLoggedOut: 'Your broker session has ended. Log in to your broker on the OpenAlgo web.',
  Unsupported: "This server's version of OpenAlgo does not support this.",
  RateLimited: 'The server is busy. Wait a few seconds and try again.',
  Server: 'The server ran into a problem. Try again in a moment.',
  Network: "Can't reach the server. Check your connection and try again.",
  // Used only when the server sent no message:
  SemiAutoBlocked: 'This server uses Semi-Auto mode, so the web Action Center must approve this.',
  Validation: 'The server did not accept this request.',
}

/**
 * The text to show for `e`. SemiAutoBlocked and Validation show the server's reason; an order
 * refused behind a 429 gate says when to try again.
 */
export function userMessage(e: ApiError): string {
  if ((e.kind === 'SemiAutoBlocked' || e.kind === 'Validation') && e.serverMessage) {
    return e.serverMessage
  }
  if (e.kind === 'RateLimited' && e.retryInSec !== undefined) {
    return `The server is busy. Try again in ${e.retryInSec} s.`
  }
  return FIXED[e.kind]
}
