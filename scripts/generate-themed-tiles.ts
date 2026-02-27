/**
 * Generate themed wall and floor tile variants.
 *
 * - Alien theme: green/cyan metallic tint
 * - Zoo theme: warm brown/wood tint
 *
 * Run: npx tsx scripts/generate-themed-tiles.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { PNG } from 'pngjs'

const ASSETS_DIR = path.join(__dirname, '..', 'webview-ui', 'public', 'assets')

interface ThemeConfig {
  name: string
  wallSuffix: string
  floorSuffix: string
  /** Hue rotation in degrees (0-360) applied to walls */
  wallHueShift: number
  /** Saturation boost for walls (0-1) */
  wallSatBoost: number
  /** Tint color [r, g, b] blended at given strength */
  wallTint: [number, number, number]
  wallTintStrength: number
  /** Floor tint */
  floorTint: [number, number, number]
  floorTintStrength: number
}

const themes: ThemeConfig[] = [
  {
    name: 'alien',
    wallSuffix: '-alien',
    floorSuffix: '-alien',
    wallHueShift: 0,
    wallSatBoost: 0,
    wallTint: [0x30, 0x80, 0x60], // green/cyan
    wallTintStrength: 0.35,
    floorTint: [0x20, 0x60, 0x50],
    floorTintStrength: 0.3,
  },
  {
    name: 'zoo',
    wallSuffix: '-zoo',
    floorSuffix: '-zoo',
    wallHueShift: 0,
    wallSatBoost: 0,
    wallTint: [0x80, 0x60, 0x30], // warm brown
    wallTintStrength: 0.35,
    floorTint: [0x60, 0x50, 0x20],
    floorTintStrength: 0.3,
  },
]

function applyTint(
  src: PNG,
  tint: [number, number, number],
  strength: number,
): PNG {
  const dst = new PNG({ width: src.width, height: src.height })
  for (let i = 0; i < src.data.length; i += 4) {
    const r = src.data[i]
    const g = src.data[i + 1]
    const b = src.data[i + 2]
    const a = src.data[i + 3]

    if (a === 0) {
      dst.data[i] = 0
      dst.data[i + 1] = 0
      dst.data[i + 2] = 0
      dst.data[i + 3] = 0
      continue
    }

    // Blend with tint color
    dst.data[i] = Math.round(r * (1 - strength) + tint[0] * strength)
    dst.data[i + 1] = Math.round(g * (1 - strength) + tint[1] * strength)
    dst.data[i + 2] = Math.round(b * (1 - strength) + tint[2] * strength)
    dst.data[i + 3] = a
  }
  return dst
}

// Generate themed variants
for (const theme of themes) {
  // Walls
  const wallSrc = PNG.sync.read(fs.readFileSync(path.join(ASSETS_DIR, 'walls.png')))
  const wallOut = applyTint(wallSrc, theme.wallTint, theme.wallTintStrength)
  const wallPath = path.join(ASSETS_DIR, `walls${theme.wallSuffix}.png`)
  fs.writeFileSync(wallPath, PNG.sync.write(wallOut))
  console.log(`✓ walls${theme.wallSuffix}.png`)

  // Floors
  const floorSrc = PNG.sync.read(fs.readFileSync(path.join(ASSETS_DIR, 'floors.png')))
  const floorOut = applyTint(floorSrc, theme.floorTint, theme.floorTintStrength)
  const floorPath = path.join(ASSETS_DIR, `floors${theme.floorSuffix}.png`)
  fs.writeFileSync(floorPath, PNG.sync.write(floorOut))
  console.log(`✓ floors${theme.floorSuffix}.png`)
}

console.log('\n✅ Generated themed tile variants')
