/**
 * Draw west-facing (side view) cabinet and bookshelf sprites.
 *
 * In 3/4 top-down perspective, a cabinet facing west shows:
 * - Its right side panel (flat, minimal detail)
 * - Narrower than the front-facing version (depth < width)
 * - Top surface visible as a narrow horizontal strip
 * - Drawer divider lines visible as subtle horizontal marks
 *
 * Run: npx tsx scripts/draw-side-cabinets.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { PNG } from 'pngjs'

const ASSETS_DIR = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'furniture')

function setPixel(png: PNG, x: number, y: number, r: number, g: number, b: number, a = 255) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return
  const idx = (y * png.width + x) * 4
  png.data[idx] = r
  png.data[idx + 1] = g
  png.data[idx + 2] = b
  png.data[idx + 3] = a
}

function fillRect(png: PNG, x1: number, y1: number, x2: number, y2: number, r: number, g: number, b: number) {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      setPixel(png, x, y, r, g, b)
    }
  }
}

function fillRow(png: PNG, x1: number, x2: number, y: number, r: number, g: number, b: number) {
  for (let x = x1; x <= x2; x++) {
    setPixel(png, x, y, r, g, b)
  }
}

type Color = [number, number, number]

interface CabinetColors {
  topCap: Color       // top surface
  topCapDark: Color   // top edge
  body: Color         // main side panel
  bodyLight: Color    // lighter side panel accent
  bodyDark: Color     // darker detail
  divider: Color      // drawer divider line
  edgeFront: Color    // front edge (left side, visible thin strip)
  edgeRight: Color    // right edge highlight
  bottom: Color       // bottom shadow/base
}

interface SideCabinetConfig {
  outputFile: string
  id: string
  label: string
  /** Width of the side view sprite (cabinet depth) in pixels */
  sideWidth: number
  /** Height of the cabinet sprite in pixels */
  height: number
  /** Y offset from top of 32x32 canvas */
  yOffset: number
  /** Number of drawer sections */
  drawers: number
  /** Colors from the original cabinet */
  colors: CabinetColors
  /** Height of each drawer section in pixels */
  drawerHeight: number
  groupId: string
  backgroundTiles?: number
  renderOffsetY?: number
}

// Color palettes extracted from original sprites
const tallCabinetColors: CabinetColors = {
  topCap: [0x2c, 0x2f, 0x43],
  topCapDark: [0x34, 0x38, 0x4b],
  body: [0x4a, 0x4e, 0x68],
  bodyLight: [0x55, 0x59, 0x77],
  bodyDark: [0x40, 0x44, 0x55],
  divider: [0x55, 0x59, 0x77],
  edgeFront: [0x34, 0x38, 0x4b],
  edgeRight: [0x5f, 0x63, 0x7e],
  bottom: [0x2c, 0x00, 0x00],
}

const bigCabinetColors: CabinetColors = { ...tallCabinetColors }
const wideCabinetColors: CabinetColors = { ...tallCabinetColors }
const openCabinetColors: CabinetColors = { ...tallCabinetColors }

// Tall Bookshelf colors (different - brown/wood tones)
const bookshelfColors: CabinetColors = {
  topCap: [0x42, 0x2d, 0x1a],
  topCapDark: [0x35, 0x24, 0x15],
  body: [0x5c, 0x3e, 0x24],
  bodyLight: [0x6e, 0x4c, 0x2e],
  bodyDark: [0x42, 0x2d, 0x1a],
  divider: [0x35, 0x24, 0x15],
  edgeFront: [0x35, 0x24, 0x15],
  edgeRight: [0x6e, 0x4c, 0x2e],
  bottom: [0x2a, 0x1c, 0x10],
}

const cabinets: SideCabinetConfig[] = [
  {
    outputFile: 'Filing-Cabinet-Tall-Side.png',
    id: 'FILING_CABINET_TALL_SIDE', label: 'Tall Cabinet - Side',
    sideWidth: 7, height: 24, yOffset: 8,
    drawers: 3, drawerHeight: 6,
    colors: tallCabinetColors,
    groupId: 'filingcabinettall',
    backgroundTiles: 1, renderOffsetY: -6,
  },
  {
    outputFile: 'Big-Filing-Cabinet-Side.png',
    id: 'BIG_FILING_CABINET_SIDE', label: 'Big Cabinet - Side',
    sideWidth: 8, height: 25, yOffset: 7,
    drawers: 4, drawerHeight: 5,
    colors: bigCabinetColors,
    groupId: 'bigfilingcabinet',
    backgroundTiles: 1, renderOffsetY: -6,
  },
  {
    outputFile: 'Wide-Filing-Cabinet-Side.png',
    id: 'WIDE_FILING_CABINET_SIDE', label: 'Wide Cabinet - Side',
    sideWidth: 8, height: 25, yOffset: 7,
    drawers: 3, drawerHeight: 7,
    colors: wideCabinetColors,
    groupId: 'widefilingcabinet',
    backgroundTiles: 1, renderOffsetY: -6,
  },
  {
    outputFile: 'Filing-Cabinet-Open-Side.png',
    id: 'FILING_CABINET_OPEN_SIDE', label: 'Open Cabinet - Side',
    sideWidth: 8, height: 25, yOffset: 7,
    drawers: 3, drawerHeight: 7,
    colors: openCabinetColors,
    groupId: 'filingcabinetopen',
    backgroundTiles: 1, renderOffsetY: -6,
  },
  {
    outputFile: 'Tall-Bookshelf-Side.png',
    id: 'TALL_BOOKSHELF_SIDE', label: 'Tall Bookshelf - Side',
    sideWidth: 7, height: 25, yOffset: 7,
    drawers: 4, drawerHeight: 5,
    colors: bookshelfColors,
    groupId: 'tallbookshelf',
    backgroundTiles: 1, renderOffsetY: -6,
  },
]

for (const cab of cabinets) {
  const png = new PNG({ width: 32, height: 32 })
  // All pixels start transparent (default)

  const c = cab.colors
  // Right-align: these cabinets sit against the right wall (col 13 = x=16-31)
  const cx = 32 - cab.sideWidth // flush with right edge of 2-tile footprint
  const left = cx
  const right = cx + cab.sideWidth - 1
  const top = cab.yOffset
  const bottom = top + cab.height - 1

  // === Draw cabinet structure ===

  // 1. Top cap (2px tall)
  fillRect(png, left, top, right, top + 1, ...c.topCap)
  // Top edge (transition)
  fillRow(png, left, right, top + 2, ...c.topCapDark)

  // 2. Front edge (leftmost column) - thin strip showing front face
  for (let y = top; y <= bottom; y++) {
    setPixel(png, left, y, ...c.edgeFront)
  }

  // 3. Right edge highlight (rightmost column)
  for (let y = top + 2; y <= bottom - 1; y++) {
    setPixel(png, right, y, ...c.edgeRight)
  }

  // 4. Main body (side panel)
  fillRect(png, left + 1, top + 3, right - 1, bottom - 1, ...c.body)

  // 5. Drawer divider lines (subtle horizontal marks)
  const bodyStart = top + 3
  for (let d = 1; d < cab.drawers; d++) {
    const divY = bodyStart + d * cab.drawerHeight
    if (divY < bottom) {
      // Divider: full width highlight line
      fillRow(png, left + 1, right, divY, ...c.divider)
      // Groove below divider
      if (divY + 1 < bottom) {
        fillRow(png, left + 1, right - 1, divY + 1, ...c.bodyDark)
      }
    }
  }

  // 6. Light accent stripe on side panel (vertical, 1px from right edge)
  for (let y = top + 3; y <= bottom - 1; y++) {
    setPixel(png, right - 1, y, ...c.bodyLight)
  }
  // Re-draw dividers over the light stripe
  for (let d = 1; d < cab.drawers; d++) {
    const divY = bodyStart + d * cab.drawerHeight
    if (divY < bottom) {
      setPixel(png, right - 1, divY, ...c.divider)
      if (divY + 1 < bottom) {
        setPixel(png, right - 1, divY + 1, ...c.bodyDark)
      }
    }
  }

  // 7. Bottom edge
  fillRow(png, left, right, bottom, ...c.bottom)

  const outPath = path.join(ASSETS_DIR, cab.outputFile)
  fs.writeFileSync(outPath, PNG.sync.write(png))
  console.log(`✓ ${cab.outputFile} (side-facing variant, ${cab.sideWidth}px wide)`)
}

// Update catalog
const catalogPath = path.join(ASSETS_DIR, 'furniture-catalog.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))

for (const cab of cabinets) {
  // Check if already exists
  if (catalog.assets.find((a: Record<string, unknown>) => a.id === cab.id)) {
    console.log(`⏭️  ${cab.id} already in catalog`)
    continue
  }

  const entry: Record<string, unknown> = {
    id: cab.id,
    label: cab.label,
    category: 'storage',
    file: `furniture/${cab.outputFile}`,
    width: 32,
    height: 32,
    footprintW: 2,
    footprintH: 2,
    isDesk: false,
    groupId: cab.groupId,
    orientation: 'left',
  }
  if (cab.backgroundTiles) entry.backgroundTiles = cab.backgroundTiles
  if (cab.renderOffsetY) entry.renderOffsetY = cab.renderOffsetY

  catalog.assets.push(entry)
  console.log(`➕ Added ${cab.id} to catalog`)
}

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
console.log(`\n✅ Generated ${cabinets.length} side-facing cabinet/bookshelf sprites`)
