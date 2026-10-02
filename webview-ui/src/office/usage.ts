import { QUOTA_SEVEN_DAY_WINDOW_MS } from '../constants.js'

/** Cumulative token totals for one agent across the session. */
export interface CumulativeTokens {
  input: number
  cacheCreate: number
  cacheRead: number
  output: number
}

/** Per-million-token rates in USD. Cache creation costs ~25% more than fresh
 *  input; cache reads cost ~10% of input. Sources: Anthropic public pricing,
 *  verified 2026-09-17. Rates change — keep this map current. Unknown models
 *  fall back to Sonnet 4.x rates. */
const RATE_TABLE = {
  fable: { input: 10.0, output: 50.0 },     // Fable / Mythos 5.x
  opus: { input: 5.0, output: 25.0 },       // Opus 4.6–4.8, Opus 5
  sonnet5: { input: 2.0, output: 10.0 },    // Sonnet 5 — cheaper than Sonnet 4.6
  sonnet: { input: 3.0, output: 15.0 },     // Sonnet 4.6 and older
  haiku: { input: 1.0, output: 5.0 },       // Haiku 4.5
} as const

function rateFor(modelId: string): { input: number; output: number } {
  const { tier, major } = parseModelId(modelId)
  switch (tier) {
    case 'fable':
    case 'mythos':
      return RATE_TABLE.fable
    case 'opus':
      return RATE_TABLE.opus
    case 'sonnet':
      return major >= 5 ? RATE_TABLE.sonnet5 : RATE_TABLE.sonnet
    case 'haiku':
      return RATE_TABLE.haiku
    default:
      return RATE_TABLE.sonnet
  }
}

/** Estimate USD cost for cumulative tokens against a given model.
 *  Cache creation is billed at 1.25x input rate; cache reads at 0.10x. */
export function estimateCost(tokens: CumulativeTokens, modelId: string): number {
  const r = rateFor(modelId)
  const inPrice = (
    tokens.input * r.input
    + tokens.cacheCreate * r.input * 1.25
    + tokens.cacheRead * r.input * 0.10
  ) / 1_000_000
  const outPrice = (tokens.output * r.output) / 1_000_000
  return inPrice + outPrice
}

/** Compact human-readable token count: 1234 → "1.2K", 1_234_567 → "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(n)
}

/** Format a USD amount: <$0.01 collapses to "<$0.01"; otherwise 2 decimals. */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `$${usd.toFixed(2)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(0)}`
}

/** Sum of all four cumulative buckets — total tokens that flowed through the API. */
export function totalTokens(t: CumulativeTokens): number {
  return t.input + t.cacheCreate + t.cacheRead + t.output
}

/** Tier + major/minor version parsed out of a Claude model id.
 *  Handles the modern `claude-<tier>-<major>[-<minor>]` form and the legacy
 *  inverted `claude-<major>[-<minor>]-<tier>` form. Date suffixes
 *  (`claude-3-opus-20240229`, `claude-haiku-4-5-20251001`) are not versions:
 *  a segment of 3+ digits is rejected, which is what keeps the legacy form
 *  from parsing its date as a major version. */
export interface ParsedModel {
  tier: 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku' | ''
  major: number
  minor: number
}

const TIER_RE = /(fable|mythos|opus|sonnet|haiku)/
const MODERN_RE = /(?:fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2})(?!\d))?/
const LEGACY_RE = /(\d{1,2})(?:-(\d{1,2}))?-(?:fable|mythos|opus|sonnet|haiku)/

export function parseModelId(modelId: string | undefined | null): ParsedModel {
  const none: ParsedModel = { tier: '', major: 0, minor: 0 }
  if (!modelId) return none
  const id = modelId.toLowerCase()
  const tierMatch = TIER_RE.exec(id)
  if (!tierMatch) return none
  const tier = tierMatch[1] as ParsedModel['tier']
  const legacy = LEGACY_RE.exec(id)
  if (legacy) return { tier, major: Number(legacy[1]), minor: Number(legacy[2] ?? 0) }
  const modern = MODERN_RE.exec(id)
  if (modern) return { tier, major: Number(modern[1]), minor: Number(modern[2] ?? 0) }
  return { tier, major: 0, minor: 0 }
}

/** Context-window cap (tokens) for a Claude model id.
 *  The Claude 5 family (Fable/Mythos 5.x, Opus 5, Sonnet 5), Opus 4.6–4.8 and
 *  Sonnet 4.6 ship a 1M window. Haiku, the Claude 3.x generation and anything
 *  unrecognised stay at the safe 200K default. */
export function contextWindowFor(modelId: string | undefined | null): number {
  const { tier, major, minor } = parseModelId(modelId)
  switch (tier) {
    case 'fable':
    case 'mythos':
      return major >= 5 ? 1_000_000 : 200_000
    case 'opus':
      return major >= 4 ? 1_000_000 : 200_000
    case 'sonnet':
      if (major >= 5) return 1_000_000
      return major === 4 && minor >= 6 ? 1_000_000 : 200_000
    default:
      return 200_000
  }
}

export interface ContextFullness {
  tokens: number
  cap: number
  agentId: number | null
}

export function fullestContext(
  agentUsage: Record<number, number>,
  agentModel: Record<number, string>,
): ContextFullness {
  let best: ContextFullness = { tokens: 0, cap: 200_000, agentId: null }
  let bestRatio = 0
  for (const idStr of Object.keys(agentUsage)) {
    const id = Number(idStr)
    const tok = agentUsage[id] ?? 0
    if (tok <= 0) continue
    const cap = contextWindowFor(agentModel[id])
    if (cap <= 0) continue
    const ratio = tok / cap
    if (ratio > bestRatio) {
      bestRatio = ratio
      best = { tokens: tok, cap, agentId: id }
    }
  }
  return best
}

/** Real 5h / 7d usage pushed on `quotaWindow.rateLimit` (BEHAVIOR_SPEC §3). */
export interface RateLimit {
  fiveHourPct: number
  sevenDayPct: number | null
  /** Epoch ms of the 5h reset; null for Desktop samples, which carry none. */
  resetsAt: number | null
  /** Epoch ms of the 7d reset; the pace baseline is derived from it. */
  sevenDayResetsAt?: number | null
  source: 'cli' | 'desktop'
  /** Epoch ms when the source measured the value. */
  sampledAt: number
}

const RATE_LIMIT_SOURCE_LABEL: Record<RateLimit['source'], string> = {
  cli: 'Claude Code statusline',
  desktop: 'Claude Desktop usage history',
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Milliseconds of Monday–Friday local time inside [from, to). Steps by
 *  local calendar day so daylight-saving days count as their real length. */
function weekdayMs(from: number, to: number): number {
  let sum = 0
  let cursor = new Date(from)
  while (cursor.getTime() < to) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    const end = Math.min(nextMidnight.getTime(), to)
    const day = cursor.getDay()
    if (day !== 0 && day !== 6) sum += end - cursor.getTime()
    cursor = nextMidnight
  }
  return sum
}

/** Where 7-day usage would be now if the week's limit were spread evenly over
 *  its weekday hours (BEHAVIOR_SPEC §3). Weekends add nothing: measured usage
 *  on weekends was 0%, and a plain 7-way split jumps to 64% by Monday 09:00,
 *  making the remaining headroom look far larger than the half week left. */
export function weekdayPaceBaseline(sevenDayResetsAt: number, now: number): number {
  const start = sevenDayResetsAt - QUOTA_SEVEN_DAY_WINDOW_MS
  const total = weekdayMs(start, sevenDayResetsAt)
  if (total <= 0) return 0
  const clamped = Math.min(Math.max(now, start), sevenDayResetsAt)
  return (weekdayMs(start, clamped) / total) * 100
}

/** HUD 5h chip text + tooltip, and whether 7d usage is ahead of the weekday
 *  pace. Real usage % when a source reported one, otherwise the weighted JSONL
 *  token count; null while neither exists. */
export function quotaChip(
  rateLimit: RateLimit | null,
  weightedTokens: number,
  now: number,
): { label: string; title: string; ahead: boolean } | null {
  if (rateLimit) {
    const fiveHour = `5h ${Math.round(rateLimit.fiveHourPct)}%`
    const sevenDay = rateLimit.sevenDayPct
    const sevenReset = rateLimit.sevenDayResetsAt ?? null
    const pace = sevenDay !== null && sevenReset !== null && sevenReset > now
      ? weekdayPaceBaseline(sevenReset, now)
      : null
    const ahead = pace !== null && sevenDay !== null && sevenDay > pace
    let label = fiveHour
    if (sevenDay !== null) {
      label += ` · 7d ${Math.round(sevenDay)}%`
      if (pace !== null) label += ` (pace ${Math.round(pace)}%)`
    }
    const lines = [
      `5-hour usage ${Math.round(rateLimit.fiveHourPct)}%` +
        (rateLimit.resetsAt !== null ? `, resets at ${clockTime(rateLimit.resetsAt)}` : ', reset time unknown'),
    ]
    if (sevenDay !== null) {
      let line = `7-day usage ${Math.round(sevenDay)}%`
      if (pace !== null && sevenReset !== null) {
        const gap = Math.round(sevenDay - pace)
        line += `, weekday pace ${Math.round(pace)}%` +
          (gap > 0 ? ` (ahead by ${gap} pts)` : gap < 0 ? ` (${-gap} pts under)` : ' (on pace)') +
          `, resets ${WEEKDAY_NAMES[new Date(sevenReset).getDay()]} ${clockTime(sevenReset)}`
      }
      lines.push(line)
    }
    lines.push(`From ${RATE_LIMIT_SOURCE_LABEL[rateLimit.source]}, measured at ${clockTime(rateLimit.sampledAt)}`)
    return { label, title: lines.join('\n'), ahead }
  }
  if (weightedTokens > 0) {
    return {
      label: `${formatTokens(weightedTokens)} / 5h`,
      title: 'Weighted tokens used in the last 5 hours across all ~/.claude/projects sessions.\nCache reads count 0.10x and cache writes 1.25x, matching how they are billed — a raw sum would be ~99% cache reads.\nShown because no real usage % is available (no statusline reading, no recent Claude Desktop sample).',
      ahead: false,
    }
  }
  return null
}

/** Which HUD parts survive at each compaction tier. When the HUD would
 *  overlap the bottom-left toolbar it steps up one tier at a time, dropping
 *  the least important detail first; the toolbar itself never changes. */
export function hudParts(tier: number): {
  tokText: boolean
  modelChip: boolean
  contextBar: boolean
  compactScale: boolean
  visible: boolean
} {
  return {
    tokText: tier < 1,
    modelChip: tier < 2,
    contextBar: tier < 3,
    compactScale: tier >= 4,
    visible: tier < 5,
  }
}
