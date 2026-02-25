#!/usr/bin/env node
/**
 * Generate floors.png — 7 grayscale 16×16 floor patterns in a 112×16 strip.
 * These patterns are colorized at runtime by the webview's Colorize pipeline.
 * Output: webview-ui/public/assets/floors.png
 */

const { PNG } = require('pngjs')
const fs = require('fs')
const path = require('path')

const TILE = 16
const PATTERNS = 7
const WIDTH = TILE * PATTERNS
const HEIGHT = TILE

const png = new PNG({ width: WIDTH, height: HEIGHT })

function setPixel(x, y, gray, alpha = 255) {
  const idx = (y * WIDTH + x) * 4
  png.data[idx] = gray
  png.data[idx + 1] = gray
  png.data[idx + 2] = gray
  png.data[idx + 3] = alpha
}

function drawPattern(patternIdx, fn) {
  const ox = patternIdx * TILE
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const gray = fn(x, y)
      setPixel(ox + x, y, gray)
    }
  }
}

// Pattern 0: Smooth solid (subtle gradient feel)
drawPattern(0, (x, y) => {
  const noise = ((x * 3 + y * 5) % 7) - 3
  return 160 + noise
})

// Pattern 1: Wood plank (horizontal, wide planks with subtle grain)
drawPattern(1, (x, y) => {
  // Wide planks every 5px
  if (y % 5 === 0) return 135 // plank seam
  // Subtle wood grain
  const grain = Math.abs(((x * 13 + y * 7) % 19) - 9)
  return 150 + grain
})

// Pattern 2: Wood plank (diagonal herringbone)
drawPattern(2, (x, y) => {
  const d = (x + y) % 8
  if (d === 0) return 130 // seam
  const grain = ((x * 11 + y * 3) % 13) > 7 ? 5 : 0
  return 150 + grain + (d > 4 ? 8 : 0)
})

// Pattern 3: Clean tile (large squares with thin grout)
drawPattern(3, (x, y) => {
  if (x === 0 || y === 0) return 140 // thin grout line
  return 170
})

// Pattern 4: Offset tile (brick-style floor tile)
drawPattern(4, (x, y) => {
  const row = Math.floor(y / 8)
  const offset = (row % 2) * 8
  const tx = (x + offset) % 16
  if (y % 8 === 0 || tx === 0) return 138 // grout
  return 168
})

// Pattern 5: Carpet (soft, low-contrast texture)
drawPattern(5, (x, y) => {
  // Deterministic soft noise
  const a = ((x * 1337 + y * 7919 + 42) % 256)
  const b = (((x + 1) * 991 + (y + 1) * 6173) % 256)
  const avg = (a + b) / 2
  return 145 + Math.floor((avg % 16)) // range 145-160
})

// Pattern 6: Parquet (alternating 4x4 blocks, horizontal/vertical grain)
drawPattern(6, (x, y) => {
  const bx = Math.floor(x / 4)
  const by = Math.floor(y / 4)
  const horizontal = (bx + by) % 2 === 0
  if (horizontal) {
    if (x % 4 === 0) return 135
    return 155 + ((y * 3) % 7)
  } else {
    if (y % 4 === 0) return 135
    return 155 + ((x * 3) % 7)
  }
})

// Write output
const outDir = path.join(__dirname, '..', 'webview-ui', 'public', 'assets')
const outPath = path.join(outDir, 'floors.png')

fs.mkdirSync(outDir, { recursive: true })

const buffer = PNG.sync.write(png)
fs.writeFileSync(outPath, buffer)
console.log(`Generated floors.png (${WIDTH}×${HEIGHT}) at ${outPath}`)
