#!/usr/bin/env node
/**
 * Generate default-layout.json using built-in FurnitureType IDs.
 * This creates a cozy office layout that works WITHOUT the paid tileset.
 * Output: webview-ui/public/assets/default-layout.json
 */

const fs = require('fs')
const path = require('path')

// TileType values (from types.ts)
const WALL = 0
const FLOOR_1 = 1
const FLOOR_2 = 2
const FLOOR_3 = 3
const FLOOR_4 = 4
const FLOOR_5 = 5
const FLOOR_6 = 6
const VOID = 8

const COLS = 24
const ROWS = 16

// Build tile grid
const tiles = []
const tileColors = []

// Floor colors
const MAIN_FLOOR = { h: 35, s: 30, b: 15, c: 0 }       // warm beige
const MEETING_FLOOR = { h: 25, s: 45, b: 5, c: 10 }     // warm brown
const LOUNGE_FLOOR = { h: 280, s: 40, b: -5, c: 0 }     // purple carpet
const HALLWAY = { h: 35, s: 25, b: 10, c: 0 }           // tan
const KITCHEN_FLOOR = { h: 200, s: 20, b: 10, c: 0 }    // cool gray-blue

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    // Outer walls
    if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
      tiles.push(WALL)
      tileColors.push(null)
      continue
    }

    // Dividing wall at col 12 (with doorway at rows 5-7)
    if (c === 12) {
      if (r >= 5 && r <= 7) {
        tiles.push(FLOOR_4)
        tileColors.push(HALLWAY)
      } else {
        tiles.push(WALL)
        tileColors.push(null)
      }
      continue
    }

    // Dividing wall at col 18 (with doorway at rows 5-7)
    if (c === 18) {
      if (r >= 5 && r <= 7) {
        tiles.push(FLOOR_4)
        tileColors.push(HALLWAY)
      } else {
        tiles.push(WALL)
        tileColors.push(null)
      }
      continue
    }

    // Left section: main work area (cols 1-11)
    if (c >= 1 && c <= 11) {
      tiles.push(FLOOR_1)
      tileColors.push(MAIN_FLOOR)
      continue
    }

    // Middle section: meeting/collaboration area (cols 13-17)
    if (c >= 13 && c <= 17) {
      // Lounge area in bottom-right of middle section
      if (r >= 10 && r <= 13) {
        tiles.push(FLOOR_3)
        tileColors.push(LOUNGE_FLOOR)
      } else {
        tiles.push(FLOOR_2)
        tileColors.push(MEETING_FLOOR)
      }
      continue
    }

    // Right section: break room (cols 19-22)
    if (c >= 19 && c <= 22) {
      tiles.push(FLOOR_5)
      tileColors.push(KITCHEN_FLOOR)
      continue
    }

    tiles.push(FLOOR_1)
    tileColors.push(MAIN_FLOOR)
  }
}

// Build furniture list using built-in FurnitureType IDs
let uidCounter = 0
function uid(prefix) {
  return `${prefix}-${++uidCounter}`
}

const furniture = [
  // === LEFT WORK AREA (cols 1-11) ===

  // Desk cluster 1 (top-left): 2 desks with 4 chairs each
  { uid: uid('desk'), type: 'desk', col: 2, row: 2 },
  { uid: uid('chair'), type: 'chair', col: 2, row: 1 },
  { uid: uid('chair'), type: 'chair', col: 3, row: 1 },
  { uid: uid('chair'), type: 'chair', col: 2, row: 4 },
  { uid: uid('chair'), type: 'chair', col: 3, row: 4 },

  // Desk cluster 2 (top-right of left section)
  { uid: uid('desk'), type: 'desk', col: 6, row: 2 },
  { uid: uid('chair'), type: 'chair', col: 6, row: 1 },
  { uid: uid('chair'), type: 'chair', col: 7, row: 1 },
  { uid: uid('chair'), type: 'chair', col: 6, row: 4 },
  { uid: uid('chair'), type: 'chair', col: 7, row: 4 },

  // Desk cluster 3 (bottom-left)
  { uid: uid('desk'), type: 'desk', col: 2, row: 8 },
  { uid: uid('chair'), type: 'chair', col: 2, row: 7 },
  { uid: uid('chair'), type: 'chair', col: 3, row: 7 },
  { uid: uid('chair'), type: 'chair', col: 2, row: 10 },
  { uid: uid('chair'), type: 'chair', col: 3, row: 10 },

  // Desk cluster 4 (bottom-right of left section)
  { uid: uid('desk'), type: 'desk', col: 6, row: 8 },
  { uid: uid('chair'), type: 'chair', col: 6, row: 7 },
  { uid: uid('chair'), type: 'chair', col: 7, row: 7 },
  { uid: uid('chair'), type: 'chair', col: 6, row: 10 },
  { uid: uid('chair'), type: 'chair', col: 7, row: 10 },

  // PCs on desks (surface items)
  { uid: uid('pc'), type: 'pc', col: 2, row: 2 },
  { uid: uid('pc'), type: 'pc', col: 6, row: 2 },
  { uid: uid('pc'), type: 'pc', col: 2, row: 8 },
  { uid: uid('pc'), type: 'pc', col: 6, row: 8 },

  // Bookshelf along left wall
  { uid: uid('bookshelf'), type: 'bookshelf', col: 10, row: 1 },
  { uid: uid('bookshelf'), type: 'bookshelf', col: 10, row: 3 },

  // Plants in corners
  { uid: uid('plant'), type: 'plant', col: 1, row: 1 },
  { uid: uid('plant'), type: 'plant', col: 11, row: 1 },
  { uid: uid('plant'), type: 'plant', col: 1, row: 14 },
  { uid: uid('plant'), type: 'plant', col: 11, row: 14 },

  // Lamps
  { uid: uid('lamp'), type: 'lamp', col: 1, row: 6 },
  { uid: uid('lamp'), type: 'lamp', col: 11, row: 6 },

  // Whiteboard on bottom wall of left section
  { uid: uid('whiteboard'), type: 'whiteboard', col: 4, row: 13 },

  // === MIDDLE MEETING AREA (cols 13-17) ===

  // Meeting table
  { uid: uid('desk'), type: 'desk', col: 14, row: 3 },
  { uid: uid('chair'), type: 'chair', col: 14, row: 2 },
  { uid: uid('chair'), type: 'chair', col: 15, row: 2 },
  { uid: uid('chair'), type: 'chair', col: 14, row: 5 },
  { uid: uid('chair'), type: 'chair', col: 15, row: 5 },
  { uid: uid('chair'), type: 'chair', col: 13, row: 3 },
  { uid: uid('chair'), type: 'chair', col: 16, row: 4 },

  // Whiteboard in meeting room
  { uid: uid('whiteboard'), type: 'whiteboard', col: 14, row: 1 },

  // Plants in meeting room
  { uid: uid('plant'), type: 'plant', col: 13, row: 1 },
  { uid: uid('plant'), type: 'plant', col: 17, row: 1 },

  // Lounge area (bottom of meeting section)
  { uid: uid('plant'), type: 'plant', col: 13, row: 10 },
  { uid: uid('plant'), type: 'plant', col: 17, row: 13 },
  { uid: uid('lamp'), type: 'lamp', col: 17, row: 10 },
  { uid: uid('bookshelf'), type: 'bookshelf', col: 13, row: 12 },

  // === RIGHT BREAK ROOM (cols 19-22) ===

  // Cooler
  { uid: uid('cooler'), type: 'cooler', col: 20, row: 1 },

  // Small table
  { uid: uid('desk'), type: 'desk', col: 20, row: 5 },
  { uid: uid('chair'), type: 'chair', col: 20, row: 4 },
  { uid: uid('chair'), type: 'chair', col: 21, row: 4 },
  { uid: uid('chair'), type: 'chair', col: 20, row: 7 },
  { uid: uid('chair'), type: 'chair', col: 21, row: 7 },

  // Bookshelf in break room
  { uid: uid('bookshelf'), type: 'bookshelf', col: 22, row: 1 },

  // Plants in break room
  { uid: uid('plant'), type: 'plant', col: 19, row: 1 },
  { uid: uid('plant'), type: 'plant', col: 19, row: 14 },
  { uid: uid('plant'), type: 'plant', col: 22, row: 14 },

  // Lamp in break room
  { uid: uid('lamp'), type: 'lamp', col: 22, row: 10 },
]

const layout = {
  version: 1,
  cols: COLS,
  rows: ROWS,
  tiles,
  tileColors,
  furniture,
}

// Write output
const outPath = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'default-layout.json')
fs.writeFileSync(outPath, JSON.stringify(layout, null, 2))
console.log(`Generated default-layout.json (${COLS}×${ROWS}, ${furniture.length} furniture items) at ${outPath}`)
