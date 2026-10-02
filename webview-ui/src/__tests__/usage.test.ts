import { describe, it, expect } from 'vitest'
import { estimateCost, formatTokens, formatCost, totalTokens, contextWindowFor, parseModelId, fullestContext, quotaChip, hudParts } from '../office/usage.js'
import { HUD_MAX_TIER } from '../constants.js'

describe('totalTokens', () => {
  it('sums all four buckets', () => {
    expect(totalTokens({ input: 10, cacheCreate: 20, cacheRead: 30, output: 40 })).toBe(100)
  })
})

describe('formatTokens', () => {
  it('formats < 1K as raw integer', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('formats 1K-100K with one decimal', () => {
    expect(formatTokens(1234)).toBe('1.2K')
    expect(formatTokens(52_300)).toBe('52.3K')
  })

  it('formats >= 100K without decimal', () => {
    expect(formatTokens(123_456)).toBe('123K')
    expect(formatTokens(999_999)).toBe('1000K')
  })

  it('formats >= 1M with one decimal', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(12_345_678)).toBe('12.3M')
  })
})

describe('formatCost', () => {
  it('zero-or-negative renders as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(-1)).toBe('$0.00')
  })

  it('sub-cent collapses to <$0.01', () => {
    expect(formatCost(0.001)).toBe('<$0.01')
    expect(formatCost(0.009999)).toBe('<$0.01')
  })

  it('cents to dollars use 2 decimals', () => {
    expect(formatCost(0.01)).toBe('$0.01')
    expect(formatCost(0.42)).toBe('$0.42')
    expect(formatCost(99.99)).toBe('$99.99')
  })

  it('triple-digits drop decimals', () => {
    expect(formatCost(123.45)).toBe('$123')
  })
})

describe('estimateCost', () => {
  it('Sonnet rates: 1M input = $3, 1M output = $15', () => {
    const cost = estimateCost(
      { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 },
      'claude-sonnet-4-6',
    )
    // 1M * $3 (input) + 1M * $15 (output) = $18
    expect(cost).toBeCloseTo(18, 5)
  })

  it('Sonnet 5 is cheaper than Sonnet 4.6: 1M input = $2, 1M output = $10', () => {
    const cost = estimateCost(
      { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 },
      'claude-sonnet-5',
    )
    expect(cost).toBeCloseTo(12, 5)
  })

  it('Opus 5 uses Opus rates', () => {
    const cost = estimateCost(
      { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 },
      'claude-opus-5',
    )
    expect(cost).toBeCloseTo(30, 5)
  })

  it('Opus rates: 1M input = $5, 1M output = $25', () => {
    const cost = estimateCost(
      { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 },
      'claude-opus-4-7',
    )
    expect(cost).toBeCloseTo(30, 5)
  })

  it('Fable 5 rates: 1M input = $10, 1M output = $50', () => {
    const cost = estimateCost(
      { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 },
      'claude-fable-5',
    )
    expect(cost).toBeCloseTo(60, 5)
  })

  it('Mythos 5 uses Fable rates', () => {
    const cost = estimateCost(
      { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 },
      'claude-mythos-5',
    )
    expect(cost).toBeCloseTo(60, 5)
  })

  it('Haiku rates: 1M input = $1, 1M output = $5', () => {
    const cost = estimateCost(
      { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 },
      'claude-haiku-4-5',
    )
    expect(cost).toBeCloseTo(6, 5)
  })

  it('cache_creation costs 1.25x input rate', () => {
    const cost = estimateCost(
      { input: 0, cacheCreate: 1_000_000, cacheRead: 0, output: 0 },
      'claude-sonnet-4-6',
    )
    // 1M * $3 * 1.25 = $3.75
    expect(cost).toBeCloseTo(3.75, 5)
  })

  it('cache_read costs 0.10x input rate', () => {
    const cost = estimateCost(
      { input: 0, cacheCreate: 0, cacheRead: 1_000_000, output: 0 },
      'claude-sonnet-4-6',
    )
    // 1M * $3 * 0.10 = $0.30
    expect(cost).toBeCloseTo(0.3, 5)
  })

  it('unknown model falls back to Sonnet rates', () => {
    const tokens = { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 }
    const cost = estimateCost(tokens, 'claude-mystery-9-9')
    expect(cost).toBeCloseTo(18, 5)
  })

  it('combined buckets sum correctly for Opus', () => {
    const cost = estimateCost(
      { input: 100_000, cacheCreate: 50_000, cacheRead: 200_000, output: 30_000 },
      'claude-opus-4-7',
    )
    // input:    100K * $5 = $0.50
    // create:   50K  * $5 * 1.25 = $0.3125
    // read:     200K * $5 * 0.10 = $0.10
    // output:   30K  * $25 = $0.75
    // total = $1.6625
    expect(cost).toBeCloseTo(1.6625, 4)
  })
})

describe('parseModelId', () => {
  it('reads the modern tier-major-minor form', () => {
    expect(parseModelId('claude-opus-5')).toEqual({ tier: 'opus', major: 5, minor: 0 })
    expect(parseModelId('claude-fable-5-1')).toEqual({ tier: 'fable', major: 5, minor: 1 })
    expect(parseModelId('claude-sonnet-4-6')).toEqual({ tier: 'sonnet', major: 4, minor: 6 })
  })

  it('ignores a trailing date suffix', () => {
    expect(parseModelId('claude-haiku-4-5-20251001')).toEqual({ tier: 'haiku', major: 4, minor: 5 })
  })

  it('reads the legacy major-minor-tier form without eating the date', () => {
    expect(parseModelId('claude-3-opus-20240229')).toEqual({ tier: 'opus', major: 3, minor: 0 })
    expect(parseModelId('claude-3-5-sonnet-20241022')).toEqual({ tier: 'sonnet', major: 3, minor: 5 })
  })

  it('returns an empty tier for unknown families', () => {
    expect(parseModelId('claude-mystery-9-9').tier).toBe('')
    expect(parseModelId(null).tier).toBe('')
  })
})

describe('contextWindowFor', () => {
  it('1M window for the Claude 5 family (the default Claude Code model)', () => {
    expect(contextWindowFor('claude-opus-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-fable-5-1')).toBe(1_000_000)
    expect(contextWindowFor('claude-mythos-5-1')).toBe(1_000_000)
  })

  it('1M window for Fable 5 / Mythos 5 / Opus 4.x / Sonnet 5 / Sonnet 4.6', () => {
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-mythos-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-4-8')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-4-6')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(1_000_000)
  })

  it('200K for Haiku 4.5, older models, and unknown/empty ids', () => {
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(contextWindowFor('claude-sonnet-4-5-20250929')).toBe(200_000)
    expect(contextWindowFor('claude-3-opus-20240229')).toBe(200_000)
    expect(contextWindowFor('claude-3-5-sonnet-20241022')).toBe(200_000)
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000)
    expect(contextWindowFor('')).toBe(200_000)
    expect(contextWindowFor(null)).toBe(200_000)
    expect(contextWindowFor(undefined)).toBe(200_000)
  })
})

describe('fullestContext', () => {
  it('uses the last turn context size, so a long session reads well under 100%', () => {
    const r = fullestContext({ 1: 180_000 }, { 1: 'claude-opus-5-5' })
    expect(r).toEqual({ tokens: 180_000, cap: 1_000_000, agentId: 1 })
    expect(Math.round((r.tokens / r.cap) * 100)).toBe(18)
  })

  it('picks the session closest to its own window', () => {
    const r = fullestContext(
      { 1: 400_000, 2: 150_000 },
      { 1: 'claude-opus-5-5', 2: 'claude-haiku-4-5-20251001' },
    )
    expect(r.agentId).toBe(2)
    expect(r.cap).toBe(200_000)
  })

  it('returns an empty result when nothing has reported', () => {
    expect(fullestContext({ 1: 0 }, {})).toEqual({ tokens: 0, cap: 200_000, agentId: null })
  })
})

describe('quotaChip', () => {
  const sevenReset = new Date('2026-10-07T21:00').getTime()
  const at = new Date('2026-10-02T15:00').getTime()
  const rl = {
    fiveHourPct: 14.4,
    sevenDayPct: 23,
    resetsAt: new Date('2026-10-02T17:00').getTime(),
    sevenDayResetsAt: sevenReset,
    source: 'cli' as const,
    sampledAt: new Date('2026-10-02T14:55').getTime(),
  }

  it('shows 5h, 7d and the weekday pace, and stays blue under the pace', () => {
    const chip = quotaChip(rl, 23_400_000, at)
    expect(chip?.label).toBe('5h 14% · 7d 23% (pace 35%)')
    expect(chip?.ahead).toBe(false)
    expect(chip?.title).toContain('5-hour usage 14%, resets at 17:00')
    expect(chip?.title).toContain('7-day usage 23%, weekday pace 35% (12 pts under), resets Wed 21:00')
    expect(chip?.title).toContain('Claude Code statusline, measured at 14:55')
  })

  it('flags 7d usage that is ahead of the weekday pace', () => {
    const chip = quotaChip({ ...rl, sevenDayPct: 52 }, 0, at)
    expect(chip?.ahead).toBe(true)
    expect(chip?.title).toContain('(ahead by 17 pts)')
  })

  it('drops the pace for a Desktop sample, which has no 7d reset time', () => {
    const chip = quotaChip({ ...rl, source: 'desktop', resetsAt: null, sevenDayResetsAt: null }, 0, at)
    expect(chip?.label).toBe('5h 14% · 7d 23%')
    expect(chip?.ahead).toBe(false)
    expect(chip?.title).toContain('reset time unknown')
  })

  it('drops the pace once the 7d window has reset', () => {
    const chip = quotaChip({ ...rl, sevenDayPct: 99 }, 0, sevenReset + 1)
    expect(chip?.label).toBe('5h 14% · 7d 99%')
    expect(chip?.ahead).toBe(false)
  })

  it('shows only 5h when no 7d reading exists', () => {
    expect(quotaChip({ ...rl, sevenDayPct: null }, 0, at)?.label).toBe('5h 14%')
  })

  it('falls back to the weighted token count without a real percentage', () => {
    const chip = quotaChip(null, 23_400_000, at)
    expect(chip?.label).toBe('23.4M / 5h')
    expect(chip?.ahead).toBe(false)
  })

  it('renders nothing before either value exists', () => {
    expect(quotaChip(null, 0, at)).toBeNull()
  })
})

describe('hudParts', () => {
  it('drops detail one step at a time and hides only at the last tier', () => {
    expect(hudParts(0)).toEqual({ tokText: true, modelChip: true, contextBar: true, compactScale: false, visible: true })
    expect(hudParts(1)).toEqual({ tokText: false, modelChip: true, contextBar: true, compactScale: false, visible: true })
    expect(hudParts(2)).toEqual({ tokText: false, modelChip: false, contextBar: true, compactScale: false, visible: true })
    expect(hudParts(3)).toEqual({ tokText: false, modelChip: false, contextBar: false, compactScale: false, visible: true })
    expect(hudParts(4)).toEqual({ tokText: false, modelChip: false, contextBar: false, compactScale: true, visible: true })
    expect(hudParts(HUD_MAX_TIER).visible).toBe(false)
  })
})
