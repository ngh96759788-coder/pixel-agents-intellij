import { describe, it, expect } from 'vitest'
import { estimateCost, formatTokens, formatCost, totalTokens, contextWindowFor } from '../office/usage.js'

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

describe('contextWindowFor', () => {
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
    expect(contextWindowFor('')).toBe(200_000)
    expect(contextWindowFor(null)).toBe(200_000)
    expect(contextWindowFor(undefined)).toBe(200_000)
  })
})
