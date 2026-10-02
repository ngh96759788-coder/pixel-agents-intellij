import { describe, it, expect } from 'vitest'
import { modelChip, gaugeColor } from '../office/components/ToolOverlay.js'

describe('modelChip', () => {
  it('returns null for empty model id', () => {
    expect(modelChip('')).toBeNull()
  })

  it('detects Opus with version suffix', () => {
    expect(modelChip('claude-opus-4-7')).toEqual({
      label: 'OPUS 4.7',
      fill: '#7a5aaa',
      outline: '#3a2a5a',
    })
    expect(modelChip('claude-opus-4-8')!.label).toBe('OPUS 4.8')
    expect(modelChip('claude-opus-5')!.label).toBe('OPUS 5')
    expect(modelChip('Claude-Opus-4-6')).not.toBeNull()
  })

  it('detects Sonnet', () => {
    const chip = modelChip('claude-sonnet-4-6')
    expect(chip).not.toBeNull()
    expect(chip!.label).toBe('SON 4.6')
    expect(chip!.fill).toBe('#5a8cff') // matches --pixel-accent
    expect(modelChip('claude-sonnet-5')!.label).toBe('SON 5')
  })

  it('detects Haiku', () => {
    const chip = modelChip('claude-haiku-4-5-20251001')
    expect(chip).not.toBeNull()
    expect(chip!.label).toBe('HAI 4.5')
    expect(chip!.fill).toBe('#c8a85a')
  })

  it('renders the legacy major-minor-tier ids without their date suffix', () => {
    expect(modelChip('claude-3-opus-20240229')!.label).toBe('OPUS 3')
    expect(modelChip('claude-3-5-sonnet-20241022')!.label).toBe('SON 3.5')
  })

  it('detects Fable 5 (Mythos-class tier)', () => {
    const chip = modelChip('claude-fable-5')
    expect(chip).not.toBeNull()
    expect(chip!.label).toBe('FABLE 5')
    expect(modelChip('claude-fable-5-1')!.label).toBe('FABLE 5.1')
    expect(chip!.fill).toBe('#4a9e8e')
  })

  it('detects Mythos 5 with the same tier color as Fable', () => {
    const chip = modelChip('claude-mythos-5')
    expect(chip).not.toBeNull()
    expect(chip!.label).toBe('MYTH 5')
    expect(chip!.fill).toBe('#4a9e8e')
  })

  it('falls back to a neutral chip for unknown families', () => {
    const chip = modelChip('claude-mystery-9-9')
    expect(chip).not.toBeNull()
    expect(chip!.label).toBe('MYS') // first 3 chars of split
    expect(chip!.fill).toBe('#7a7a8a')
  })

  it('handles ids without dashes gracefully', () => {
    const chip = modelChip('weirdmodel')
    expect(chip).not.toBeNull()
    // No "-1" segment to split on, so split('-')[1] is undefined → falls back to '?'
    expect(chip!.label).toBe('?')
  })
})

describe('gaugeColor', () => {
  it('returns muted green below 65%', () => {
    expect(gaugeColor(0)).toBe('#5fa86b')
    expect(gaugeColor(0.3)).toBe('#5fa86b')
    expect(gaugeColor(0.6499)).toBe('#5fa86b')
  })

  it('returns muted gold between 65% and 85%', () => {
    expect(gaugeColor(0.65)).toBe('#c8a85a')
    expect(gaugeColor(0.7)).toBe('#c8a85a')
    expect(gaugeColor(0.8499)).toBe('#c8a85a')
  })

  it('returns muted brick red at and above 85%', () => {
    expect(gaugeColor(0.85)).toBe('#b85050')
    expect(gaugeColor(0.95)).toBe('#b85050')
    expect(gaugeColor(1.0)).toBe('#b85050')
  })

  it('boundary values are inclusive on the upper threshold', () => {
    // Confirms thresholds use >= not >, so a snap to exactly 0.65 / 0.85 picks
    // the warmer color rather than staying on the cooler one.
    expect(gaugeColor(0.65)).not.toBe('#5fa86b')
    expect(gaugeColor(0.85)).not.toBe('#c8a85a')
  })
})
