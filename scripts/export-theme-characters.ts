/**
 * Export themed character sprites (alien + zoo) to PNG files.
 *
 * Uses the same templates as human characters but with different palettes.
 * Alien: grey/green skin, black eyes, silver/dark clothes
 * Zoo: animal-inspired color schemes (orange fox, brown bear, white rabbit, etc.)
 *
 * Run: npx tsx scripts/export-theme-characters.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { PNG } from 'pngjs'
import { CHARACTER_TEMPLATES } from '../webview-ui/src/office/sprites/spriteData.js'

const FRAME_W = 16
const FRAME_H = 32
const SPRITE_H = 24 // actual template height — bottom-aligned in frame
const FRAMES_PER_ROW = 7
const DIRECTIONS = ['down', 'up', 'right'] as const

interface CharPalette {
  skin: string
  shirt: string
  pants: string
  hair: string
  shoes: string
  eyes?: string // override eye color (default '#FFFFFF')
}

// ── Alien palettes (6 variations of grey/green aliens) ──
const ALIEN_PALETTES: CharPalette[] = [
  { skin: '#99AA99', shirt: '#334433', pants: '#222233', hair: '#556655', shoes: '#111111', eyes: '#44FF44' },
  { skin: '#88AA88', shirt: '#443355', pants: '#222222', hair: '#445544', shoes: '#111111', eyes: '#44FF44' },
  { skin: '#AABBAA', shirt: '#224444', pants: '#1A1A2A', hair: '#667766', shoes: '#0A0A0A', eyes: '#66FF66' },
  { skin: '#77AA77', shirt: '#553344', pants: '#222233', hair: '#445544', shoes: '#111111', eyes: '#33FF33' },
  { skin: '#99BB99', shirt: '#333355', pants: '#1A1A22', hair: '#557755', shoes: '#0A0A0A', eyes: '#55FF55' },
  { skin: '#88BB88', shirt: '#444433', pants: '#222222', hair: '#668866', shoes: '#111111', eyes: '#44FF44' },
]

// ── Zoo palettes (6 animal-inspired color schemes) ──
const ZOO_PALETTES: CharPalette[] = [
  // Orange tabby cat
  { skin: '#FF9944', shirt: '#FFCC88', pants: '#DD7722', hair: '#CC6600', shoes: '#553311' },
  // Brown bear
  { skin: '#8B6B3D', shirt: '#A07850', pants: '#6B4D2D', hair: '#5C3A1D', shoes: '#3D2810' },
  // White rabbit
  { skin: '#EEEEFF', shirt: '#DDDDEE', pants: '#CCCCDD', hair: '#FFFFFF', shoes: '#AAAABB' },
  // Grey wolf
  { skin: '#888899', shirt: '#999AAA', pants: '#666677', hair: '#555566', shoes: '#333344' },
  // Green frog
  { skin: '#66BB55', shirt: '#88DD77', pants: '#449933', hair: '#338822', shoes: '#225511' },
  // Pink pig
  { skin: '#FFAAAA', shirt: '#FFCCCC', pants: '#EE8888', hair: '#FF8899', shoes: '#CC5566' },
]

/** Template cell → palette key mapping */
const TEMPLATE_CELL_MAP: Record<string, keyof CharPalette> = {
  'hair': 'hair',
  'skin': 'skin',
  'shirt': 'shirt',
  'pants': 'pants',
  'shoes': 'shoes',
}

/** Parse a hex color string like '#RRGGBB' into [r, g, b] */
function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return [r, g, b]
}

function buildCharacterPng(pal: CharPalette): Buffer {
  const width = FRAME_W * FRAMES_PER_ROW
  const height = FRAME_H * DIRECTIONS.length
  const png = new PNG({ width, height })
  const padTop = FRAME_H - SPRITE_H

  for (let dirIdx = 0; dirIdx < DIRECTIONS.length; dirIdx++) {
    const dir = DIRECTIONS[dirIdx]
    const frames = CHARACTER_TEMPLATES[dir]
    const rowOffsetY = dirIdx * FRAME_H

    for (let f = 0; f < frames.length; f++) {
      const frame = frames[f]
      const frameOffsetX = f * FRAME_W

      for (let y = 0; y < SPRITE_H; y++) {
        const row = frame[y]
        if (!row) continue
        for (let x = 0; x < FRAME_W; x++) {
          const cell = row[x]
          const idx = (((rowOffsetY + padTop + y) * width) + (frameOffsetX + x)) * 4

          if (!cell || cell === '') {
            png.data[idx] = 0
            png.data[idx + 1] = 0
            png.data[idx + 2] = 0
            png.data[idx + 3] = 0
          } else {
            const paletteKey = TEMPLATE_CELL_MAP[cell]
            if (paletteKey) {
              const colorVal = pal[paletteKey]
              if (colorVal) {
                const [r, g, b] = hexToRgb(colorVal)
                png.data[idx] = r
                png.data[idx + 1] = g
                png.data[idx + 2] = b
                png.data[idx + 3] = 0xFF
              }
            } else {
              // Direct color (eyes = #FFFFFF by default, or custom)
              const eyeColor = pal.eyes || cell
              const [r, g, b] = hexToRgb(eyeColor)
              png.data[idx] = r
              png.data[idx + 1] = g
              png.data[idx + 2] = b
              png.data[idx + 3] = 0xFF
            }
          }
        }
      }
    }
  }

  return PNG.sync.write(png)
}

// ── Generate alien characters ──
const alienDir = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'characters-alien')
fs.mkdirSync(alienDir, { recursive: true })

for (let i = 0; i < ALIEN_PALETTES.length; i++) {
  const buffer = buildCharacterPng(ALIEN_PALETTES[i])
  const outPath = path.join(alienDir, `char_${i}.png`)
  fs.writeFileSync(outPath, buffer)
  console.log(`✓ Wrote ${outPath} (alien palette ${i})`)
}

// ── Generate zoo characters ──
const zooDir = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'characters-zoo')
fs.mkdirSync(zooDir, { recursive: true })

for (let i = 0; i < ZOO_PALETTES.length; i++) {
  const buffer = buildCharacterPng(ZOO_PALETTES[i])
  const outPath = path.join(zooDir, `char_${i}.png`)
  fs.writeFileSync(outPath, buffer)
  console.log(`✓ Wrote ${outPath} (zoo palette ${i})`)
}

console.log(`\nGenerated ${ALIEN_PALETTES.length} alien + ${ZOO_PALETTES.length} zoo character PNGs`)
