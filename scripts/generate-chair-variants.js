/**
 * Generate BACK and RIGHT chair sprite variants.
 *
 * - CHAIR_BACK / CHAIR_2_BACK: backrest area darkened to show "back panel"
 * - CHAIR_RIGHT / CHAIR_2_RIGHT: horizontal flip of LEFT variants
 *
 * Run: node scripts/generate-chair-variants.js
 */

const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')

const ASSETS_DIR = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'furniture')

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(path.join(ASSETS_DIR, file)))
}

function writePng(file, png) {
  fs.writeFileSync(path.join(ASSETS_DIR, file), PNG.sync.write(png))
}

function clonePng(src) {
  const dst = new PNG({ width: src.width, height: src.height })
  src.data.copy(dst.data)
  return dst
}

function getPixel(png, x, y) {
  const idx = (y * png.width + x) * 4
  return { r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2], a: png.data[idx + 3] }
}

function setPixel(png, x, y, r, g, b, a = 255) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return
  const idx = (y * png.width + x) * 4
  png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = a
}

function hexColor(r, g, b) {
  return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
}

/** Flip a PNG horizontally */
function flipH(src) {
  const dst = new PNG({ width: src.width, height: src.height })
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const srcIdx = (y * src.width + x) * 4
      const dstIdx = (y * src.width + (src.width - 1 - x)) * 4
      dst.data[dstIdx] = src.data[srcIdx]
      dst.data[dstIdx + 1] = src.data[srcIdx + 1]
      dst.data[dstIdx + 2] = src.data[srcIdx + 2]
      dst.data[dstIdx + 3] = src.data[srcIdx + 3]
    }
  }
  return dst
}

// Actual cushion colors (burgundy tones) found in chair sprites
const CUSHION_COLORS = new Set([
  '591728', '621e30', '622031', '6b2235', '6f2236', '822b41', '8b2f46',
])

// Back panel replacement: dark burgundy (same color family as front cushion)
const BACK_PANEL = { r: 0x4e, g: 0x1a, b: 0x2c }
const BACK_PANEL_DARK = { r: 0x40, g: 0x14, b: 0x24 }

/**
 * Create a BACK variant:
 * 1. flipH the sprite (armrest mirrors when viewed from behind)
 * 2. Replace ALL cushion colors with flat back-panel color
 *    (covers entire sprite, not just backrest area)
 */
function createBackVariant(src) {
  const flipped = flipH(src)
  const out = clonePng(flipped)
  for (let y = 0; y < flipped.height; y++) {
    for (let x = 0; x < flipped.width; x++) {
      const px = getPixel(flipped, x, y)
      if (px.a === 0) continue
      const hex = hexColor(px.r, px.g, px.b)
      if (CUSHION_COLORS.has(hex)) {
        // Top rows darker for depth, rest uniform back panel
        if (y <= 4) {
          setPixel(out, x, y, BACK_PANEL_DARK.r, BACK_PANEL_DARK.g, BACK_PANEL_DARK.b)
        } else {
          setPixel(out, x, y, BACK_PANEL.r, BACK_PANEL.g, BACK_PANEL.b)
        }
      }
    }
  }
  return out
}

// --- Generate RIGHT variants (flip of LEFT) ---
console.log('Generating RIGHT variants...')

const chairLeft = readPng('Chair-Left.png')
const chairRight = flipH(chairLeft)
writePng('Chair-Right.png', chairRight)
console.log('  ✓ Chair-Right.png')

const chair2Left = readPng('Chair-2-Left.png')
const chair2Right = flipH(chair2Left)
writePng('Chair-2-Right.png', chair2Right)
console.log('  ✓ Chair-2-Right.png')

// --- Generate BACK variants ---
console.log('Generating BACK variants...')

// Chair.png: symmetric, so flipH doesn't change shape, but darkening does
const chairFront = readPng('Chair.png')
const chairBack = createBackVariant(chairFront)
writePng('Chair-Back.png', chairBack)
console.log('  ✓ Chair-Back.png')

// Chair-2.png: asymmetric armrest — flipH moves armrest to other side (correct for back view)
const chair2Front = readPng('Chair-2.png')
const chair2Back = createBackVariant(chair2Front)
writePng('Chair-2-Back.png', chair2Back)
console.log('  ✓ Chair-2-Back.png')

// --- Update catalog ---
console.log('\nUpdating catalog...')
const catalogPath = path.join(ASSETS_DIR, 'furniture-catalog.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))

const newEntries = [
  { id: 'CHAIR_BACK', label: 'Chair - Back', file: 'furniture/Chair-Back.png', groupId: 'chair1', orientation: 'back' },
  { id: 'CHAIR_RIGHT', label: 'Chair - Right', file: 'furniture/Chair-Right.png', groupId: 'chair1', orientation: 'right' },
  { id: 'CHAIR_2_BACK', label: 'Chair 2 - Back', file: 'furniture/Chair-2-Back.png', groupId: 'chair2', orientation: 'back' },
  { id: 'CHAIR_2_RIGHT', label: 'Chair 2 - Right', file: 'furniture/Chair-2-Right.png', groupId: 'chair2', orientation: 'right' },
]

for (const entry of newEntries) {
  if (catalog.assets.find(a => a.id === entry.id)) {
    console.log('  (skip existing) ' + entry.id)
    continue
  }
  catalog.assets.push({
    id: entry.id,
    label: entry.label,
    category: 'chairs',
    file: entry.file,
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
    groupId: entry.groupId,
    orientation: entry.orientation,
  })
  console.log('  + ' + entry.id)
}

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
console.log('\n✅ Done')
