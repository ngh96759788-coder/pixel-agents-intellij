import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { weekdayPaceBaseline } from '../office/usage.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'pace-cases.json'), 'utf8')) as {
  sevenDayResetsAt: string
  cases: { at: string; pace: number; note: string }[]
}
const hook = join(here, '..', '..', '..', 'hooks', 'usage-pace.py')
const resetsAt = new Date(fixture.sevenDayResetsAt).getTime()

function python(...args: string[]): string {
  return execFileSync('python3', [hook, ...args], { encoding: 'utf8' }).trim()
}

describe('weekday pace baseline (shared golden cases)', () => {
  for (const c of fixture.cases) {
    it(`webview: ${c.note}`, () => {
      expect(weekdayPaceBaseline(resetsAt, new Date(c.at).getTime())).toBeCloseTo(c.pace, 6)
    })
    it(`hook: ${c.note}`, () => {
      expect(Number(python('--pace', String(resetsAt), String(new Date(c.at).getTime())))).toBeCloseTo(c.pace, 6)
    })
  }
})

describe('usage-pace hook line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pace-'))
  const at = new Date('2026-10-02T15:00').getTime()
  const cache = (sevenDay: unknown): string => {
    const file = join(dir, `cache-${Math.random()}.json`)
    writeFileSync(file, JSON.stringify({ updatedAt: at, fiveHour: { usedPercentage: 10, resetsAt: resetsAt / 1000 }, sevenDay }))
    return file
  }

  it('speaks up when 7d usage is ahead of the weekday pace', () => {
    const line = python('--line', cache({ usedPercentage: 52, resetsAt: resetsAt / 1000 }), String(at))
    expect(line).toContain('7일 사용률 52%')
    expect(line).toContain('평일 기준선 35%')
    expect(line).toContain('17%p')
    expect(line).toContain('리셋 수 21:00')
  })

  it('stays silent at or under the pace, so it costs no tokens', () => {
    expect(python('--line', cache({ usedPercentage: 35, resetsAt: resetsAt / 1000 }), String(at))).toBe('')
    expect(python('--line', cache({ usedPercentage: 20, resetsAt: resetsAt / 1000 }), String(at))).toBe('')
  })

  it('stays silent once the window has reset or when the 7d reading is missing', () => {
    const afterReset = String(resetsAt + 60_000)
    expect(python('--line', cache({ usedPercentage: 99, resetsAt: resetsAt / 1000 }), afterReset)).toBe('')
    expect(python('--line', cache(null), String(at))).toBe('')
  })
})
