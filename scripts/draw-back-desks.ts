/**
 * Draw back-facing desk sprites.
 *
 * Strategy:
 * 1. Replace monitor SCREEN pixels (blue tones) with gray back panel — keep frame/bezel as-is
 * 2. Keep keyboard in original position (don't relocate)
 * 3. Draw monitor stand post extending down through keyboard center (depth occlusion)
 * 4. Remove mouse
 * 5. Fill leg opening with solid back panel
 *
 * Run: npx tsx scripts/draw-back-desks.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { PNG } from 'pngjs'

const ASSETS_DIR = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'furniture')

// Monitor screen colors to replace with back panel
const SCREEN_COLORS = new Set(['54617d', '5f6c8a', '6f7d9d', '8f9ab3'])

// Back panel colors — match bezel (#9baaae) so it reads as same plastic shell
const BACK_PANEL = { r: 0x9b, g: 0xaa, b: 0xae }         // same as bezel
const BACK_PANEL_LIGHT = { r: 0x9b, g: 0xaa, b: 0xae }   // unused, kept for compat
const BACK_PANEL_DARK = { r: 0x88, g: 0x92, b: 0x98 }     // small recessed panel detail
const BACK_VENT = { r: 0x80, g: 0x88, b: 0x90 }           // bottom vent lines

// Stand post color
const STAND_POST = { r: 0x8d, g: 0x99, b: 0x9d }
const STAND_POST_DARK = { r: 0x6a, g: 0x74, b: 0x78 }
const STAND_POST_HIGHLIGHT = { r: 0xa0, g: 0xac, b: 0xb0 }

// Solid desk back panel (fills leg opening)
const SOLID_PANEL = { r: 0x2c, g: 0x2f, b: 0x43 }
const SOLID_PANEL_EDGE = { r: 0x35, g: 0x38, b: 0x4c }

// Desk surface color (to fill where mouse was)
const DESK_SURFACE = { r: 0x4a, g: 0x4e, b: 0x68 }

// Mouse colors to remove
const MOUSE_COLORS = new Set(['c2cfcb', 'bdced3'])

// Paper/note colors to remove (not visible from behind)
const PAPER_COLORS = new Set(['eae6da'])

// Coffee cup colors to remove
const CUP_COLORS = new Set(['c09068', '976944'])

function hexColor(r: number, g: number, b: number): string {
  return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
}

function setPixel(png: PNG, x: number, y: number, r: number, g: number, b: number, a = 255) {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return
  const idx = (y * png.width + x) * 4
  png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = a
}

function getPixel(png: PNG, x: number, y: number) {
  const idx = (y * png.width + x) * 4
  return { r: png.data[idx], g: png.data[idx + 1], b: png.data[idx + 2], a: png.data[idx + 3] }
}

function clonePng(src: PNG): PNG {
  const dst = new PNG({ width: src.width, height: src.height })
  src.data.copy(dst.data)
  return dst
}

interface DeskBackConfig {
  sourceFile: string
  outputFile: string
  /** Monitor area to convert screen→back panel */
  monitorArea: { x1: number; y1: number; x2: number; y2: number } | null
  /** Mouse area to clear */
  mouseRect: { x1: number; y1: number; x2: number; y2: number } | null
  /** Paper area to clear */
  paperRect: { x1: number; y1: number; x2: number; y2: number } | null
  /** Stand post center X range (the post extending down from monitor) */
  standX: { x1: number; x2: number } | null
  /** Y range for the stand post extending through keyboard area */
  standExtendY: { y1: number; y2: number } | null
  /** Rows with leg opening to fill */
  legRows: { y1: number; y2: number }
}

const desks: DeskBackConfig[] = [
  {
    sourceFile: 'Desk.png', outputFile: 'Desk-Back.png',
    monitorArea: { x1: 0, y1: 0, x2: 31, y2: 12 },
    mouseRect: { x1: 17, y1: 16, x2: 19, y2: 19 },
    paperRect: { x1: 20, y1: 15, x2: 28, y2: 19 },
    standX: { x1: 8, x2: 11 },
    standExtendY: { y1: 12, y2: 19 },
    legRows: { y1: 25, y2: 28 },
  },
  {
    sourceFile: 'Desk-2.png', outputFile: 'Desk-2-Back.png',
    monitorArea: { x1: 0, y1: 0, x2: 31, y2: 12 },
    mouseRect: { x1: 27, y1: 16, x2: 29, y2: 19 },
    paperRect: { x1: 2, y1: 15, x2: 12, y2: 19 },
    standX: { x1: 18, x2: 21 },
    standExtendY: { y1: 12, y2: 19 },
    legRows: { y1: 25, y2: 28 },
  },
  {
    sourceFile: 'Boss-Desk.png', outputFile: 'Boss-Desk-Back.png',
    monitorArea: null,
    mouseRect: null,
    paperRect: null,
    standX: null,
    standExtendY: null,
    legRows: { y1: 26, y2: 31 },
  },
]

for (const desk of desks) {
  const srcPath = path.join(ASSETS_DIR, desk.sourceFile)
  if (!fs.existsSync(srcPath)) {
    console.log(`⚠️  Source not found: ${desk.sourceFile}`)
    continue
  }

  const src = PNG.sync.read(fs.readFileSync(srcPath))
  const out = clonePng(src)

  // Step 1: Trim top of monitor and replace screen with back panel
  // Make top portion transparent to reduce visual height (character-desk gap fix)
  // Keep only the bottom part of the monitor visible as the back panel
  if (desk.monitorArea) {
    const ma = desk.monitorArea
    const trimY = 3 // make y0-2 transparent, keep y3-12 as monitor back
    for (let y = ma.y1; y <= ma.y2; y++) {
      for (let x = ma.x1; x <= ma.x2; x++) {
        const px = getPixel(src, x, y)
        if (px.a === 0) continue

        if (y < trimY) {
          // Make top portion fully transparent
          setPixel(out, x, y, 0, 0, 0, 0)
        } else {
          const hex = hexColor(px.r, px.g, px.b)
          if (SCREEN_COLORS.has(hex)) {
            // Replace screen with bezel-matching back + small panel left of stand
            const relY = y - trimY
            const visibleH = ma.y2 - trimY
            // Panel position: always LEFT of stand center, consistent across all desks
            const panelX1 = desk.standX ? desk.standX.x1 - 4 : 5
            const panelX2 = desk.standX ? desk.standX.x1 - 1 : 8
            if (relY >= visibleH - 1 && x % 2 === 0) {
              // Bottom row: subtle vent dots
              setPixel(out, x, y, BACK_VENT.r, BACK_VENT.g, BACK_VENT.b)
            } else if (relY >= 3 && relY <= 5 && x >= panelX1 && x <= panelX2) {
              // Small recessed panel (consistent position relative to stand)
              setPixel(out, x, y, BACK_PANEL_DARK.r, BACK_PANEL_DARK.g, BACK_PANEL_DARK.b)
            } else {
              // Everything else: match bezel color exactly
              setPixel(out, x, y, BACK_PANEL.r, BACK_PANEL.g, BACK_PANEL.b)
            }
          } else if (y === trimY) {
            // Top edge of visible monitor: ensure frame is visible
            // Keep existing bezel/frame pixel
          }
        }
      }
    }
  }

  // Step 2: Remove mouse
  if (desk.mouseRect) {
    const mr = desk.mouseRect
    for (let y = mr.y1; y <= mr.y2; y++) {
      for (let x = mr.x1; x <= mr.x2; x++) {
        const px = getPixel(out, x, y)
        if (px.a === 0) continue
        const hex = hexColor(px.r, px.g, px.b)
        if (MOUSE_COLORS.has(hex)) {
          setPixel(out, x, y, DESK_SURFACE.r, DESK_SURFACE.g, DESK_SURFACE.b)
        }
      }
    }
  }

  // Step 3: Remove papers/notes (not visible from behind)
  if (desk.paperRect) {
    const pr = desk.paperRect
    for (let y = pr.y1; y <= pr.y2; y++) {
      for (let x = pr.x1; x <= pr.x2; x++) {
        const px = getPixel(out, x, y)
        if (px.a === 0) continue
        const hex = hexColor(px.r, px.g, px.b)
        if (PAPER_COLORS.has(hex) || CUP_COLORS.has(hex)) {
          setPixel(out, x, y, DESK_SURFACE.r, DESK_SURFACE.g, DESK_SURFACE.b)
        }
      }
    }
  }

  // Step 4: Draw monitor stand post extending down through desk surface
  // This creates the depth effect — the stand occludes the center of the keyboard
  if (desk.standX && desk.standExtendY) {
    const sx = desk.standX
    const sy = desk.standExtendY
    // Draw post (4px wide with shading: dark | main | main | highlight)
    for (let y = sy.y1; y <= sy.y2 - 1; y++) {
      for (let x = sx.x1; x <= sx.x2; x++) {
        const px = getPixel(out, x, y)
        if (px.a === 0) continue
        if (x === sx.x1) {
          setPixel(out, x, y, STAND_POST_DARK.r, STAND_POST_DARK.g, STAND_POST_DARK.b)
        } else if (x === sx.x2) {
          setPixel(out, x, y, STAND_POST_HIGHLIGHT.r, STAND_POST_HIGHLIGHT.g, STAND_POST_HIGHLIGHT.b)
        } else {
          setPixel(out, x, y, STAND_POST.r, STAND_POST.g, STAND_POST.b)
        }
      }
    }
    // Stand base plate (wider, flat base at the bottom)
    const baseY = sy.y2
    for (let x = sx.x1 - 2; x <= sx.x2 + 2; x++) {
      const px = getPixel(out, x, baseY)
      if (px.a === 0) continue
      if (x <= sx.x1) {
        setPixel(out, x, baseY, STAND_POST_DARK.r, STAND_POST_DARK.g, STAND_POST_DARK.b)
      } else if (x >= sx.x2) {
        setPixel(out, x, baseY, STAND_POST_HIGHLIGHT.r, STAND_POST_HIGHLIGHT.g, STAND_POST_HIGHLIGHT.b)
      } else {
        setPixel(out, x, baseY, STAND_POST.r, STAND_POST.g, STAND_POST.b)
      }
    }
  }

  // Step 5: Fill leg opening with solid back panel
  for (let y = desk.legRows.y1; y <= desk.legRows.y2; y++) {
    for (let x = 0; x < 32; x++) {
      const px = getPixel(src, x, y)
      if (px.a === 0) continue
      if (hexColor(px.r, px.g, px.b) === '000000') {
        if (y === desk.legRows.y1) {
          setPixel(out, x, y, SOLID_PANEL_EDGE.r, SOLID_PANEL_EDGE.g, SOLID_PANEL_EDGE.b)
        } else {
          setPixel(out, x, y, SOLID_PANEL.r, SOLID_PANEL.g, SOLID_PANEL.b)
        }
      }
    }
  }

  const outPath = path.join(ASSETS_DIR, desk.outputFile)
  fs.writeFileSync(outPath, PNG.sync.write(out))
  console.log(`✓ ${desk.outputFile}`)
}

// Update catalog (entries may already exist)
const catalogPath = path.join(ASSETS_DIR, 'furniture-catalog.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))

const fileToId: Record<string, string> = {}
for (const a of catalog.assets) {
  const fname = (a.file as string).replace('furniture/', '')
  fileToId[fname] = a.id as string
}

const backVariants = [
  { sourceFile: 'Desk.png', id: 'DESK_BACK', label: 'Desk - Back', file: 'furniture/Desk-Back.png', groupId: 'desk1' },
  { sourceFile: 'Desk-2.png', id: 'DESK_2_BACK', label: 'Desk 2 - Back', file: 'furniture/Desk-2-Back.png', groupId: 'desk2' },
  { sourceFile: 'Boss-Desk.png', id: 'BOSS_DESK_BACK', label: 'Boss Desk - Back', file: 'furniture/Boss-Desk-Back.png', groupId: 'bossdesk' },
]

for (const v of backVariants) {
  if (catalog.assets.find((a: Record<string, unknown>) => a.id === v.id)) continue
  const sourceAsset = catalog.assets.find((a: Record<string, unknown>) => a.id === fileToId[v.sourceFile])
  catalog.assets.push({
    id: v.id, label: v.label, category: 'desks',
    file: v.file,
    width: sourceAsset?.width ?? 32, height: sourceAsset?.height ?? 32,
    footprintW: 2, footprintH: 2, isDesk: true,
    groupId: v.groupId, orientation: 'back',
  })
}

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
console.log(`\n✅ Done`)
