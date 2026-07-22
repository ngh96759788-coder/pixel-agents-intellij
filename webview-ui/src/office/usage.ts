/** Cumulative token totals for one agent across the session. */
export interface CumulativeTokens {
  input: number
  cacheCreate: number
  cacheRead: number
  output: number
}

/** Per-million-token rates in USD. Cache creation costs ~25% more than fresh
 *  input; cache reads cost ~10% of input. Sources: Anthropic public pricing
 *  pages as of mid-2026. Rates change — keep this map current. Unknown models
 *  fall back to Sonnet rates. */
const RATE_TABLE: Record<string, { input: number; output: number }> = {
  fable: { input: 10.0, output: 50.0 },   // Claude Fable 5 / Mythos 5
  opus: { input: 5.0, output: 25.0 },     // Opus 4.6–4.8
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 1.0, output: 5.0 },     // Haiku 4.5
}

function rateFor(modelId: string): { input: number; output: number } {
  const id = modelId.toLowerCase()
  if (id.includes('fable') || id.includes('mythos')) return RATE_TABLE.fable
  if (id.includes('opus')) return RATE_TABLE.opus
  if (id.includes('sonnet')) return RATE_TABLE.sonnet
  if (id.includes('haiku')) return RATE_TABLE.haiku
  return RATE_TABLE.sonnet
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

/** Approximate context-window cap (tokens) for a given Anthropic model.
 *  The Claude 5 family (Fable/Mythos/Sonnet 5), Opus 4.x, and Sonnet 4.6
 *  all ship a 1M window; Haiku 4.5 and older models stay at 200K.
 *  Used by the HUD percentage + the head HP bar so a 180K Opus session
 *  reads as ~18% rather than the misleading "90% of 200K". Empty/unknown
 *  model ids fall back to 200K (safe legacy default). */
export function contextWindowFor(modelId: string | undefined | null): number {
  if (!modelId) return 200_000
  const id = modelId.toLowerCase()
  if (id.includes('fable') || id.includes('mythos')) return 1_000_000
  if (id.includes('opus') && /opus-4/.test(id)) return 1_000_000
  if (/sonnet-5/.test(id) || /sonnet-4-6/.test(id)) return 1_000_000
  return 200_000
}
