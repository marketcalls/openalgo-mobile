const SECRET_KEY = /^(apikey|api_key|api-key|password|secret|auth_token)$/i
const MAX_LINES = 500
const MAX_DEPTH = 6

function redactString(s: string): string {
  return s
    .replace(/(api[_-]?key=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-key]')
}

/** Returns a copy with key values, `apikey=` query values and bare 64-hex strings masked. */
export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redactString(v)
  if (v === null || typeof v !== 'object') return v
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (v instanceof Error) return { name: v.name, message: redactString(v.message) }
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x, depth + 1)
  }
  return out
}

type Level = 'debug' | 'info' | 'warn' | 'error'

let lines: string[] = []

function emit(level: Level, tag: string, msg: string, data?: unknown) {
  let line = `${new Date().toISOString()} ${level.toUpperCase()} [${tag}] ${redactString(msg)}`
  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(redact(data))}`
    } catch {
      line += ' [unserializable]'
    }
  }
  lines.push(line)
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES)
  if (typeof __DEV__ !== 'undefined' && __DEV__) console[level](line)
}

export const log = {
  debug: (tag: string, msg: string, data?: unknown) => emit('debug', tag, msg, data),
  info: (tag: string, msg: string, data?: unknown) => emit('info', tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => emit('warn', tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => emit('error', tag, msg, data),
}

export function getLogLines(limit = MAX_LINES): string[] {
  return limit >= lines.length ? [...lines] : lines.slice(-limit)
}

export function clearLogs(): void {
  lines = []
}
