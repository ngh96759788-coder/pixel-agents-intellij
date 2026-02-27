/**
 * Create bigger office chair sprites (16x24) from existing 16x16 chairs.
 * - Scales up seat/back area for better proportion with 16x32 characters
 * - All face DOWN (front orientation)
 *
 * Run: npx tsx scripts/draw-bigger-chairs.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { PNG } from 'pngjs'

const ASSETS_DIR = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'furniture')

function setPixel(png: PNG, x: number, y: number, r: number, g: number, b: number, a = 255) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return
  const idx = (y * png.width + x) * 4
  png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = a
}

// Chair color palette (from Chair.png)
const C = {
  borderDark:  { r: 0x59, g: 0x17, b: 0x28 },
  borderMed:   { r: 0x62, g: 0x1e, b: 0x30 },
  maroon:      { r: 0x6f, g: 0x22, b: 0x36 },
  maroonAlt:   { r: 0x6b, g: 0x22, b: 0x35 },
  cushion:     { r: 0x82, g: 0x2b, b: 0x41 },
  cushionHi:   { r: 0x8b, g: 0x2f, b: 0x46 },
  metalLight:  { r: 0xc2, g: 0xcf, b: 0xcb },
  metalMed:    { r: 0xba, g: 0xc9, b: 0xc5 },
  metalDark:   { r: 0x9d, g: 0xae, b: 0xaa },
  legDark:     { r: 0x3a, g: 0x3a, b: 0x3a },
  legMed:      { r: 0x4c, g: 0x4c, b: 0x4c },
  black:       { r: 0x00, g: 0x00, b: 0x00 },
}

function drawBigChair(filename: string) {
  const png = new PNG({ width: 16, height: 24 })

  // Helper
  const s = (x: number, y: number, c: typeof C.cushion) => setPixel(png, x, y, c.r, c.g, c.b)

  // Chair back (y0-7) - wider and taller than original
  // Top edge
  for (let x = 4; x <= 11; x++) s(x, 0, C.borderDark)
  // Back cushion rows
  for (let y = 1; y <= 2; y++) {
    s(3, y, C.borderDark)
    for (let x = 4; x <= 11; x++) s(x, y, y === 1 ? C.borderMed : C.maroonAlt)
    s(12, y, C.borderDark)
  }
  for (let y = 3; y <= 6; y++) {
    s(3, y, C.maroonAlt)
    for (let x = 4; x <= 11; x++) s(x, y, C.cushion)
    s(12, y, C.maroonAlt)
  }
  // Back bottom edge
  s(4, 7, C.maroon); s(5, 7, C.cushion); s(6, 7, C.cushion); s(7, 7, C.cushion)
  s(8, 7, C.cushion); s(9, 7, C.cushion); s(10, 7, C.cushion); s(11, 7, C.maroon)

  // Gap / metal post (y8)
  s(7, 8, C.metalDark); s(8, 8, C.metalLight)

  // Seat cushion (y9-14) - wider
  for (let x = 4; x <= 11; x++) s(x, 9, C.borderDark)
  for (let y = 10; y <= 11; y++) {
    s(3, y, C.borderDark)
    for (let x = 4; x <= 11; x++) s(x, y, y === 10 ? C.borderMed : C.maroonAlt)
    s(12, y, C.borderDark)
  }
  for (let y = 12; y <= 14; y++) {
    s(3, y, C.maroonAlt)
    for (let x = 4; x <= 11; x++) s(x, y, C.cushion)
    s(12, y, C.maroonAlt)
  }
  // Seat front edge
  for (let x = 4; x <= 11; x++) s(x, 15, C.cushion)
  s(5, 15, C.maroon); s(10, 15, C.maroon)

  // Post (y16)
  s(7, 16, C.metalDark); s(8, 16, C.metalLight)

  // Base cross (y17)
  s(5, 17, C.metalMed); s(6, 17, C.metalDark)
  s(7, 17, C.metalMed); s(8, 17, C.metalLight)
  s(9, 17, C.metalDark); s(10, 17, C.metalMed)

  // Legs (y18-19)
  for (const [lx, rx] of [[3, 12], [4, 11]]) {
    s(lx, 18, C.metalDark); s(rx, 18, C.metalDark)
    s(lx, 19, C.metalMed); s(rx, 19, C.metalMed)
  }
  s(7, 18, C.metalDark); s(8, 18, C.metalLight)
  s(7, 19, C.metalDark); s(8, 19, C.metalLight)

  // Wheels (y20)
  s(3, 20, C.legMed); s(4, 20, C.legDark)
  s(7, 20, C.legDark); s(8, 20, C.legDark)
  s(11, 20, C.legDark); s(12, 20, C.legMed)

  const outPath = path.join(ASSETS_DIR, filename)
  fs.writeFileSync(outPath, PNG.sync.write(png))
  console.log(`✓ ${filename} (16x24)`)
}

// Generate both chair variants as bigger down-facing chairs
drawBigChair('Chair-Big.png')

// Chair-2 variant: slightly different cushion style
function drawBigChair2(filename: string) {
  const png = new PNG({ width: 16, height: 24 })
  const s = (x: number, y: number, c: typeof C.cushion) => setPixel(png, x, y, c.r, c.g, c.b)

  // Chair back with slight curve (y0-7)
  for (let x = 5; x <= 10; x++) s(x, 0, C.borderDark)
  s(4, 1, C.borderDark); s(11, 1, C.borderDark)
  for (let x = 5; x <= 10; x++) s(x, 1, C.borderMed)
  for (let y = 2; y <= 5; y++) {
    s(3, y, C.maroonAlt)
    for (let x = 4; x <= 11; x++) s(x, y, C.cushion)
    s(12, y, C.maroonAlt)
  }
  // Back highlight
  s(5, 3, C.cushionHi); s(6, 3, C.cushionHi); s(9, 3, C.cushionHi); s(10, 3, C.cushionHi)
  // Back bottom
  s(4, 6, C.maroon); s(5, 6, C.cushion); s(6, 6, C.cushion); s(7, 6, C.cushion)
  s(8, 6, C.cushion); s(9, 6, C.cushion); s(10, 6, C.cushion); s(11, 6, C.maroon)

  // Armrests + gap (y7-8)
  s(3, 7, C.maroonAlt); s(4, 7, C.maroon)
  s(11, 7, C.maroon); s(12, 7, C.maroonAlt)
  s(7, 7, C.metalDark); s(8, 7, C.metalLight)
  s(3, 8, C.maroon); s(12, 8, C.maroon)
  s(7, 8, C.metalDark); s(8, 8, C.metalLight)

  // Seat (y9-15)
  for (let x = 3; x <= 12; x++) s(x, 9, C.borderDark)
  for (let y = 10; y <= 13; y++) {
    s(3, y, C.maroonAlt)
    for (let x = 4; x <= 11; x++) s(x, y, C.cushion)
    s(12, y, C.maroonAlt)
  }
  // Seat highlight
  s(5, 11, C.cushionHi); s(6, 11, C.cushionHi); s(9, 11, C.cushionHi); s(10, 11, C.cushionHi)
  // Seat front
  for (let x = 4; x <= 11; x++) s(x, 14, C.maroon)
  s(3, 14, C.maroonAlt); s(12, 14, C.maroonAlt)
  s(5, 15, C.maroon); s(6, 15, C.cushion); s(7, 15, C.cushion)
  s(8, 15, C.cushion); s(9, 15, C.cushion); s(10, 15, C.maroon)

  // Post (y16)
  s(7, 16, C.metalDark); s(8, 16, C.metalLight)

  // Base cross (y17)
  s(5, 17, C.metalMed); s(6, 17, C.metalDark)
  s(7, 17, C.metalMed); s(8, 17, C.metalLight)
  s(9, 17, C.metalDark); s(10, 17, C.metalMed)

  // Legs (y18-19)
  for (const [lx, rx] of [[3, 12], [4, 11]]) {
    s(lx, 18, C.metalDark); s(rx, 18, C.metalDark)
    s(lx, 19, C.metalMed); s(rx, 19, C.metalMed)
  }
  s(7, 18, C.metalDark); s(8, 18, C.metalLight)
  s(7, 19, C.metalDark); s(8, 19, C.metalLight)

  // Wheels (y20)
  s(3, 20, C.legMed); s(4, 20, C.legDark)
  s(7, 20, C.legDark); s(8, 20, C.legDark)
  s(11, 20, C.legDark); s(12, 20, C.legMed)

  const outPath = path.join(ASSETS_DIR, filename)
  fs.writeFileSync(outPath, PNG.sync.write(png))
  console.log(`✓ ${filename} (16x24)`)
}

drawBigChair2('Chair-2-Big.png')

// Update catalog
const catalogPath = path.join(ASSETS_DIR, 'furniture-catalog.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))

// Add new bigger chair entries
const newChairs = [
  { id: 'CHAIR_BIG', label: 'Office Chair', file: 'furniture/Chair-Big.png', width: 16, height: 24, groupId: 'chair1big' },
  { id: 'CHAIR_2_BIG', label: 'Office Chair 2', file: 'furniture/Chair-2-Big.png', width: 16, height: 24, groupId: 'chair2big' },
]

for (const nc of newChairs) {
  if (catalog.assets.find((a: Record<string, unknown>) => a.id === nc.id)) {
    // Update existing
    const existing = catalog.assets.find((a: Record<string, unknown>) => a.id === nc.id)
    existing.width = nc.width
    existing.height = nc.height
    existing.file = nc.file
    continue
  }
  catalog.assets.push({
    id: nc.id, label: nc.label, category: 'chairs',
    file: nc.file,
    width: nc.width, height: nc.height,
    footprintW: 1, footprintH: 1,
    orientation: 'front',
    groupId: nc.groupId,
  })
}

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
console.log('\n✅ Bigger chairs created and catalog updated')
