#!/usr/bin/env node
/**
 * Import Antea Office Furniture Set into Pixel Agents.
 * - Copies PNGs to webview-ui/public/assets/furniture/
 * - Generates furniture-catalog.json
 * - Generates a new default-layout.json using the imported assets
 *
 * Usage: node scripts/import-antea-assets.js <source-dir>
 */

const fs = require('fs')
const path = require('path')

const sourceDir = process.argv[2] || '/tmp/antea-office/Office-Furniture-Pixel-Art/Office-Furniture-Pixel-Art'
const assetsDir = path.join(__dirname, '..', 'webview-ui', 'public', 'assets')
const furnitureDir = path.join(assetsDir, 'furniture')

// Asset metadata: filename → { label, category, isDesk, footprintW, footprintH, canPlaceOnSurfaces, canPlaceOnWalls, groupId, orientation, state }
const ASSET_META = {
  'Desk.png':              { label: 'Desk', category: 'desks', isDesk: true },
  'Desk-2.png':            { label: 'Desk 2', category: 'desks', isDesk: true },
  'Boss-Desk.png':         { label: 'Boss Desk', category: 'desks', isDesk: true },
  'Big-Round-Table.png':   { label: 'Round Table', category: 'desks', isDesk: true },
  'Small-Table.png':       { label: 'Small Table', category: 'desks', isDesk: true },

  'Chair.png':             { label: 'Chair', category: 'chairs', isDesk: false },
  'Chair-2.png':           { label: 'Chair 2', category: 'chairs', isDesk: false },
  'Boss-Chair.png':        { label: 'Boss Chair', category: 'chairs', isDesk: false },

  'Big-Sofa.png':          { label: 'Sofa', category: 'chairs', isDesk: false },
  'Big-Sofa-2.png':        { label: 'Sofa 2', category: 'chairs', isDesk: false },
  'Small-Sofa.png':        { label: 'Small Sofa', category: 'chairs', isDesk: false },

  'Bookshelf.png':         { label: 'Bookshelf', category: 'storage', isDesk: false },
  'Tall-Bookshelf.png':    { label: 'Tall Bookshelf', category: 'storage', isDesk: false },
  'Filing-Cabinet-Small.png': { label: 'Small Cabinet', category: 'storage', isDesk: false },
  'Filing-Cabinet-Tall.png':  { label: 'Tall Cabinet', category: 'storage', isDesk: false },
  'Big-Filing-Cabinet.png':   { label: 'Big Cabinet', category: 'storage', isDesk: false },
  'Wide-Filing-Cabinet.png':  { label: 'Wide Cabinet', category: 'storage', isDesk: false },
  'Filing-Cabinet-Open.png':  { label: 'Open Cabinet', category: 'storage', isDesk: false },

  'Printer.png':           { label: 'Printer', category: 'electronics', isDesk: false },
  'Big-Office-Printer.png':{ label: 'Office Printer', category: 'electronics', isDesk: false },
  'Printer-Furniture.png': { label: 'Printer Stand', category: 'electronics', isDesk: false },
  'Coffee-Machine.png':    { label: 'Coffee Machine', category: 'electronics', isDesk: false },

  'Small-Plant.png':       { label: 'Small Plant', category: 'decor', isDesk: false },
  'Big-Plant.png':         { label: 'Big Plant', category: 'decor', isDesk: false },
  'Bin.png':               { label: 'Bin', category: 'decor', isDesk: false },
  'Vending-Machine.png':   { label: 'Vending Machine', category: 'misc', isDesk: false },
  'Water-Dispenser.png':   { label: 'Water Dispenser', category: 'misc', isDesk: false },

  'Books.png':             { label: 'Books', category: 'decor', isDesk: false, canPlaceOnSurfaces: true },
  'Folders.png':           { label: 'Folders', category: 'decor', isDesk: false, canPlaceOnSurfaces: true },
  'Folders-2.png':         { label: 'Folders 2', category: 'decor', isDesk: false, canPlaceOnSurfaces: true },
  'Papers.png':            { label: 'Papers', category: 'decor', isDesk: false, canPlaceOnSurfaces: true },

  'Board.png':             { label: 'Board', category: 'wall', isDesk: false, canPlaceOnWalls: true },
  'Mirror.png':            { label: 'Mirror', category: 'wall', isDesk: false, canPlaceOnWalls: true },
  'Wall-Clock.png':        { label: 'Clock', category: 'wall', isDesk: false, canPlaceOnWalls: true },
  'Wall-Graph.png':        { label: 'Graph', category: 'wall', isDesk: false, canPlaceOnWalls: true },
  'Wall-Note.png':         { label: 'Note', category: 'wall', isDesk: false, canPlaceOnWalls: true },
  'Wall-Note-2.png':       { label: 'Note 2', category: 'wall', isDesk: false, canPlaceOnWalls: true },
  'Wall-Shelf.png':        { label: 'Wall Shelf', category: 'wall', isDesk: false, canPlaceOnWalls: true },

  'Toilet-Closed.png':     { label: 'Toilet', category: 'misc', isDesk: false, groupId: 'toilet', state: 'off' },
  'Toilet-Open.png':       { label: 'Toilet Open', category: 'misc', isDesk: false, groupId: 'toilet', state: 'on' },
  'WC-Paper.png':          { label: 'WC Paper', category: 'misc', isDesk: false },
  'WC-Sink.png':           { label: 'WC Sink', category: 'misc', isDesk: false },
}

// Read image dimensions using pngjs
const { PNG } = require(path.join(__dirname, '..', 'node_modules', 'pngjs'))

function getImageDimensions(filePath) {
  const data = fs.readFileSync(filePath)
  const png = PNG.sync.read(data)
  return { width: png.width, height: png.height }
}

// Create furniture directory
fs.mkdirSync(furnitureDir, { recursive: true })

const catalog = { assets: [] }
let imported = 0

for (const [filename, meta] of Object.entries(ASSET_META)) {
  const srcFile = path.join(sourceDir, filename)
  if (!fs.existsSync(srcFile)) {
    console.warn(`SKIP: ${filename} not found`)
    continue
  }

  const { width, height } = getImageDimensions(srcFile)
  const id = filename.replace('.png', '').replace(/-/g, '_').toUpperCase()
  const footprintW = Math.ceil(width / 16)
  const footprintH = Math.ceil(height / 16)

  // Copy PNG to furniture dir
  const destFile = path.join(furnitureDir, filename)
  fs.copyFileSync(srcFile, destFile)

  const entry = {
    id,
    label: meta.label,
    category: meta.category,
    file: `furniture/${filename}`,
    width,
    height,
    footprintW,
    footprintH,
    isDesk: meta.isDesk || false,
  }

  if (meta.canPlaceOnSurfaces) entry.canPlaceOnSurfaces = true
  if (meta.canPlaceOnWalls) entry.canPlaceOnWalls = true
  if (meta.groupId) entry.groupId = meta.groupId
  if (meta.state) entry.state = meta.state

  catalog.assets.push(entry)
  imported++
}

// Write catalog
const catalogPath = path.join(furnitureDir, 'furniture-catalog.json')
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
console.log(`Imported ${imported} furniture assets → ${furnitureDir}`)
console.log(`Catalog: ${catalogPath}`)

// === Generate default-layout.json ===
// Floor patterns (updated to match new generate-floors.js):
//   FLOOR_1 = smooth solid, FLOOR_2 = wood plank horizontal, FLOOR_3 = herringbone wood
//   FLOOR_4 = clean tile, FLOOR_5 = offset tile, FLOOR_6 = carpet, FLOOR_7 = parquet
const WALL = 0, FLOOR_1 = 1, FLOOR_2 = 2, FLOOR_3 = 3, FLOOR_4 = 4, FLOOR_5 = 5, FLOOR_6 = 6, VOID = 8
const COLS = 26, ROWS = 18

const tiles = []
const tileColors = []

// Softer, more natural floor colors
const MAIN_FLOOR    = { h: 30, s: 25, b: 12, c: 0 }   // warm beige wood
const MEETING_FLOOR = { h: 25, s: 35, b: 8, c: 5 }    // darker warm wood
const LOUNGE_FLOOR  = { h: 260, s: 25, b: -5, c: 0 }  // muted blue carpet
const HALLWAY       = { h: 30, s: 20, b: 15, c: 0 }   // light tan tile
const KITCHEN_FLOOR = { h: 35, s: 15, b: 8, c: 5 }    // clean tile

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    // Outer walls
    if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
      tiles.push(WALL); tileColors.push(null); continue
    }
    // Dividing wall at col 14 (doorway rows 6-8)
    if (c === 14) {
      if (r >= 6 && r <= 8) { tiles.push(FLOOR_4); tileColors.push(HALLWAY) }
      else { tiles.push(WALL); tileColors.push(null) }
      continue
    }
    // Dividing wall at col 20 (doorway rows 6-8)
    if (c === 20) {
      if (r >= 6 && r <= 8) { tiles.push(FLOOR_4); tileColors.push(HALLWAY) }
      else { tiles.push(WALL); tileColors.push(null) }
      continue
    }
    // Left work area (cols 1-13): wood plank floor
    if (c >= 1 && c <= 13) { tiles.push(FLOOR_2); tileColors.push(MAIN_FLOOR); continue }
    // Meeting room (cols 15-19)
    if (c >= 15 && c <= 19) {
      if (r >= 11 && r <= 15) { tiles.push(FLOOR_6); tileColors.push(LOUNGE_FLOOR) }
      else { tiles.push(FLOOR_3); tileColors.push(MEETING_FLOOR) }
      continue
    }
    // Break room (cols 21-24): clean tile
    if (c >= 21 && c <= 24) { tiles.push(FLOOR_5); tileColors.push(KITCHEN_FLOOR); continue }
    tiles.push(FLOOR_2); tileColors.push(MAIN_FLOOR)
  }
}

let uid = 0
const u = (prefix) => `${prefix}-${++uid}`

const furniture = [
  // ═══ LEFT WORK AREA (cols 1-13, rows 1-16) ═══

  // Desk pair 1 (top-left, with space)
  { uid: u('desk'), type: 'DESK', col: 2, row: 3 },
  { uid: u('chair'), type: 'CHAIR', col: 2, row: 2 },
  { uid: u('chair'), type: 'CHAIR_2', col: 3, row: 5 },

  // Desk pair 2 (top-center)
  { uid: u('desk'), type: 'DESK_2', col: 6, row: 3 },
  { uid: u('chair'), type: 'CHAIR', col: 6, row: 2 },
  { uid: u('chair'), type: 'CHAIR', col: 8, row: 4 },

  // Desk pair 3 (bottom-left)
  { uid: u('desk'), type: 'DESK', col: 2, row: 10 },
  { uid: u('chair'), type: 'CHAIR_2', col: 2, row: 9 },
  { uid: u('chair'), type: 'CHAIR', col: 4, row: 11 },

  // Desk pair 4 (bottom-center)
  { uid: u('desk'), type: 'DESK_2', col: 6, row: 10 },
  { uid: u('chair'), type: 'CHAIR', col: 6, row: 9 },
  { uid: u('chair'), type: 'CHAIR_2', col: 8, row: 11 },

  // Boss desk (top-right of left section)
  { uid: u('boss'), type: 'BOSS_DESK', col: 10, row: 3 },
  { uid: u('boss-chair'), type: 'BOSS_CHAIR', col: 10, row: 2 },

  // Surface items on desks
  { uid: u('papers'), type: 'PAPERS', col: 3, row: 3 },
  { uid: u('folders'), type: 'FOLDERS', col: 7, row: 3 },
  { uid: u('books'), type: 'BOOKS', col: 3, row: 10 },
  { uid: u('folders'), type: 'FOLDERS_2', col: 7, row: 10 },

  // Storage row along right side
  { uid: u('bookshelf'), type: 'TALL_BOOKSHELF', col: 12, row: 1 },
  { uid: u('filing'), type: 'FILING_CABINET_TALL', col: 12, row: 3 },
  { uid: u('printer'), type: 'PRINTER_FURNITURE', col: 12, row: 6 },
  { uid: u('filing'), type: 'WIDE_FILING_CABINET', col: 12, row: 9 },

  // Plants and decor
  { uid: u('plant'), type: 'SMALL_PLANT', col: 1, row: 1 },
  { uid: u('plant'), type: 'BIG_PLANT', col: 1, row: 14 },
  { uid: u('plant'), type: 'SMALL_PLANT', col: 5, row: 1 },
  { uid: u('bin'), type: 'BIN', col: 5, row: 6 },
  { uid: u('bin'), type: 'BIN', col: 9, row: 13 },

  // Wall items
  { uid: u('clock'), type: 'WALL_CLOCK', col: 1, row: 0 },
  { uid: u('board'), type: 'BOARD', col: 4, row: 0 },
  { uid: u('note'), type: 'WALL_NOTE', col: 7, row: 0 },
  { uid: u('graph'), type: 'WALL_GRAPH', col: 10, row: 0 },

  // ═══ MEETING ROOM (cols 15-19) ═══

  // Conference table + chairs
  { uid: u('table'), type: 'BIG_ROUND_TABLE', col: 16, row: 3 },
  { uid: u('chair'), type: 'BOSS_CHAIR', col: 16, row: 2 },
  { uid: u('chair'), type: 'CHAIR', col: 18, row: 3 },
  { uid: u('chair'), type: 'CHAIR_2', col: 16, row: 5 },
  { uid: u('chair'), type: 'CHAIR', col: 15, row: 4 },

  // Meeting room wall items
  { uid: u('board'), type: 'BOARD', col: 16, row: 0 },
  { uid: u('note'), type: 'WALL_NOTE_2', col: 15, row: 0 },
  { uid: u('shelf'), type: 'WALL_SHELF', col: 19, row: 0 },

  // Meeting room decor
  { uid: u('plant'), type: 'SMALL_PLANT', col: 19, row: 1 },
  { uid: u('cabinet'), type: 'FILING_CABINET_SMALL', col: 15, row: 1 },

  // Lounge corner (bottom of meeting room)
  { uid: u('sofa'), type: 'BIG_SOFA', col: 15, row: 12 },
  { uid: u('table'), type: 'SMALL_TABLE', col: 17, row: 13 },
  { uid: u('sofa'), type: 'SMALL_SOFA', col: 18, row: 12 },
  { uid: u('plant'), type: 'BIG_PLANT', col: 15, row: 15 },
  { uid: u('bookshelf'), type: 'BOOKSHELF', col: 19, row: 11 },
  { uid: u('lamp'), type: 'SMALL_PLANT', col: 19, row: 15 },

  // ═══ BREAK ROOM (cols 21-24) ═══

  // Vending & drinks
  { uid: u('vending'), type: 'VENDING_MACHINE', col: 21, row: 1 },
  { uid: u('coffee'), type: 'COFFEE_MACHINE', col: 23, row: 1 },
  { uid: u('water'), type: 'WATER_DISPENSER', col: 21, row: 3 },

  // Small eating area
  { uid: u('table'), type: 'SMALL_TABLE', col: 22, row: 7 },
  { uid: u('chair'), type: 'CHAIR', col: 22, row: 6 },
  { uid: u('chair'), type: 'CHAIR_2', col: 23, row: 8 },

  // Break room storage/decor
  { uid: u('cabinet'), type: 'FILING_CABINET_SMALL', col: 24, row: 1 },
  { uid: u('plant'), type: 'SMALL_PLANT', col: 24, row: 3 },
  { uid: u('bin'), type: 'BIN', col: 21, row: 16 },
  { uid: u('printer'), type: 'PRINTER', col: 24, row: 5 },

  // Break room wall
  { uid: u('mirror'), type: 'MIRROR', col: 21, row: 0 },
  { uid: u('clock'), type: 'WALL_CLOCK', col: 24, row: 0 },
  { uid: u('note'), type: 'WALL_NOTE', col: 23, row: 0 },
]

const layout = { version: 1, cols: COLS, rows: ROWS, tiles, tileColors, furniture }
const layoutPath = path.join(assetsDir, 'default-layout.json')
fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2))
console.log(`Generated default-layout.json (${COLS}×${ROWS}, ${furniture.length} items) → ${layoutPath}`)
