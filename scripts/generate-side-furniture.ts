/**
 * Generate side-facing furniture sprites by transforming front-facing ones.
 *
 * For isometric/3-4 top-down pixel art, a "side" view means:
 * - Narrower width (depth becomes width)
 * - The sprite is horizontally compressed or rearranged
 *
 * Strategy: horizontally flip the sprite to create a "right-facing" variant.
 * For desks/shelves that are symmetric, we create a narrower footprint variant.
 *
 * Run: npx tsx scripts/generate-side-furniture.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { PNG } from 'pngjs'

const ASSETS_DIR = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'furniture')

interface SideVariant {
  sourceFile: string
  outputFile: string
  id: string
  label: string
  category: string
  /** 'left' or 'right' */
  orientation: string
  footprintW: number
  footprintH: number
  isDesk: boolean
  groupId: string
  sourceOrientation: string
  /** Transform: 'flip' = horizontal flip, 'rotate90ccw' = 90° counter-clockwise */
  transform: 'flip' | 'rotate90ccw'
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
  renderOffsetY?: number
}

const variants: SideVariant[] = [
  // Desk left/right variants (flip the sprite for a different angle)
  {
    sourceFile: 'Desk.png', outputFile: 'Desk-Left.png',
    id: 'DESK_LEFT', label: 'Desk - Left', category: 'desks',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: true,
    groupId: 'desk1', sourceOrientation: 'front', transform: 'flip',
  },
  {
    sourceFile: 'Desk-2.png', outputFile: 'Desk-2-Left.png',
    id: 'DESK_2_LEFT', label: 'Desk 2 - Left', category: 'desks',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: true,
    groupId: 'desk2', sourceOrientation: 'front', transform: 'flip',
  },
  {
    sourceFile: 'Boss-Desk.png', outputFile: 'Boss-Desk-Left.png',
    id: 'BOSS_DESK_LEFT', label: 'Boss Desk - Left', category: 'desks',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: true,
    groupId: 'bossdesk', sourceOrientation: 'front', transform: 'flip',
  },
  // Sofa left variants
  {
    sourceFile: 'Big-Sofa.png', outputFile: 'Big-Sofa-Left.png',
    id: 'BIG_SOFA_LEFT', label: 'Sofa - Left', category: 'chairs',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: false,
    groupId: 'bigsofa', sourceOrientation: 'front', transform: 'flip',
  },
  {
    sourceFile: 'Big-Sofa-2.png', outputFile: 'Big-Sofa-2-Left.png',
    id: 'BIG_SOFA_2_LEFT', label: 'Sofa 2 - Left', category: 'chairs',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: false,
    groupId: 'bigsofa2', sourceOrientation: 'front', transform: 'flip',
  },
  {
    sourceFile: 'Small-Sofa.png', outputFile: 'Small-Sofa-Left.png',
    id: 'SMALL_SOFA_LEFT', label: 'Small Sofa - Left', category: 'chairs',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: false,
    groupId: 'smallsofa', sourceOrientation: 'front', transform: 'flip',
  },
  // Chair left variant
  {
    sourceFile: 'Chair.png', outputFile: 'Chair-Left.png',
    id: 'CHAIR_LEFT', label: 'Chair - Left', category: 'chairs',
    orientation: 'left', footprintW: 1, footprintH: 1, isDesk: false,
    groupId: 'chair1', sourceOrientation: 'front', transform: 'flip',
  },
  {
    sourceFile: 'Chair-2.png', outputFile: 'Chair-2-Left.png',
    id: 'CHAIR_2_LEFT', label: 'Chair 2 - Left', category: 'chairs',
    orientation: 'left', footprintW: 1, footprintH: 1, isDesk: false,
    groupId: 'chair2', sourceOrientation: 'front', transform: 'flip',
  },
  // Bookshelf left variant
  {
    sourceFile: 'Bookshelf.png', outputFile: 'Bookshelf-Left.png',
    id: 'BOOKSHELF_LEFT', label: 'Bookshelf - Left', category: 'storage',
    orientation: 'left', footprintW: 1, footprintH: 2, isDesk: false,
    groupId: 'bookshelf1', sourceOrientation: 'front', transform: 'flip',
  },
  // Tall bookshelf left variant
  {
    sourceFile: 'Tall-Bookshelf.png', outputFile: 'Tall-Bookshelf-Left.png',
    id: 'TALL_BOOKSHELF_LEFT', label: 'Tall Bookshelf - Left', category: 'storage',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: false,
    groupId: 'tallbookshelf', sourceOrientation: 'front', transform: 'flip',
    backgroundTiles: 1, renderOffsetY: -6,
  },
  // Filing cabinet left variants
  {
    sourceFile: 'Filing-Cabinet-Tall.png', outputFile: 'Filing-Cabinet-Tall-Left.png',
    id: 'FILING_CABINET_TALL_LEFT', label: 'Tall Cabinet - Left', category: 'storage',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: false,
    groupId: 'filingcabinettall', sourceOrientation: 'front', transform: 'flip',
    backgroundTiles: 1, renderOffsetY: -6,
  },
  {
    sourceFile: 'Big-Filing-Cabinet.png', outputFile: 'Big-Filing-Cabinet-Left.png',
    id: 'BIG_FILING_CABINET_LEFT', label: 'Big Cabinet - Left', category: 'storage',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: false,
    groupId: 'bigfilingcabinet', sourceOrientation: 'front', transform: 'flip',
    backgroundTiles: 1, renderOffsetY: -6,
  },
  {
    sourceFile: 'Wide-Filing-Cabinet.png', outputFile: 'Wide-Filing-Cabinet-Left.png',
    id: 'WIDE_FILING_CABINET_LEFT', label: 'Wide Cabinet - Left', category: 'storage',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: false,
    groupId: 'widefilingcabinet', sourceOrientation: 'front', transform: 'flip',
    backgroundTiles: 1, renderOffsetY: -6,
  },
  {
    sourceFile: 'Filing-Cabinet-Open.png', outputFile: 'Filing-Cabinet-Open-Left.png',
    id: 'FILING_CABINET_OPEN_LEFT', label: 'Open Cabinet - Left', category: 'storage',
    orientation: 'left', footprintW: 2, footprintH: 2, isDesk: false,
    groupId: 'filingcabinetopen', sourceOrientation: 'front', transform: 'flip',
    backgroundTiles: 1, renderOffsetY: -6,
  },
]

function flipHorizontal(source: PNG): PNG {
  const result = new PNG({ width: source.width, height: source.height })
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const srcIdx = (y * source.width + x) * 4
      const dstIdx = (y * source.width + (source.width - 1 - x)) * 4
      result.data[dstIdx] = source.data[srcIdx]
      result.data[dstIdx + 1] = source.data[srcIdx + 1]
      result.data[dstIdx + 2] = source.data[srcIdx + 2]
      result.data[dstIdx + 3] = source.data[srcIdx + 3]
    }
  }
  return result
}

/** 90° counter-clockwise rotation: front (bottom) → left side */
function rotate90ccw(source: PNG): PNG {
  // For square sprites: (x, y) → (y, width-1-x)
  const result = new PNG({ width: source.height, height: source.width })
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const srcIdx = (y * source.width + x) * 4
      const dstX = y
      const dstY = source.width - 1 - x
      const dstIdx = (dstY * result.width + dstX) * 4
      result.data[dstIdx] = source.data[srcIdx]
      result.data[dstIdx + 1] = source.data[srcIdx + 1]
      result.data[dstIdx + 2] = source.data[srcIdx + 2]
      result.data[dstIdx + 3] = source.data[srcIdx + 3]
    }
  }
  return result
}

// Generate variants
for (const v of variants) {
  const srcPath = path.join(ASSETS_DIR, v.sourceFile)
  if (!fs.existsSync(srcPath)) {
    console.log(`⚠️  Source not found: ${v.sourceFile}`)
    continue
  }

  const srcPng = PNG.sync.read(fs.readFileSync(srcPath))
  let outPng: PNG

  if (v.transform === 'flip') {
    outPng = flipHorizontal(srcPng)
  } else if (v.transform === 'rotate90ccw') {
    outPng = rotate90ccw(srcPng)
  } else {
    outPng = srcPng // fallback
  }

  const outPath = path.join(ASSETS_DIR, v.outputFile)
  fs.writeFileSync(outPath, PNG.sync.write(outPng))
  console.log(`✓ ${v.outputFile} (${v.orientation} variant of ${v.sourceFile})`)
}

// Now update furniture-catalog.json
const catalogPath = path.join(ASSETS_DIR, 'furniture-catalog.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))

// First, add groupId and orientation to existing front-facing items
const frontGroupMap: Record<string, string> = {}
for (const v of variants) {
  // Find the source asset in catalog
  const sourceId = v.sourceFile.replace('.png', '').replace(/-/g, '_').toUpperCase()
    .replace(/^BIG_SOFA_2$/, 'BIG_SOFA_2')
  frontGroupMap[v.sourceFile] = v.groupId
}

// Map source filenames to catalog IDs
const fileToId: Record<string, string> = {}
for (const a of catalog.assets) {
  const fname = a.file.replace('furniture/', '')
  fileToId[fname] = a.id
}

// Add groupId + orientation:'front' to source items
for (const v of variants) {
  const sourceId = fileToId[v.sourceFile]
  if (!sourceId) continue
  const asset = catalog.assets.find((a: Record<string, unknown>) => a.id === sourceId)
  if (asset && !asset.groupId) {
    asset.groupId = v.groupId
    asset.orientation = 'front'
  }
}

// Add new side-facing variants to catalog
for (const v of variants) {
  // Check if already exists
  if (catalog.assets.find((a: Record<string, unknown>) => a.id === v.id)) continue

  const sourceAsset = catalog.assets.find((a: Record<string, unknown>) => a.id === fileToId[v.sourceFile])
  const entry: Record<string, unknown> = {
    id: v.id,
    label: v.label,
    category: v.category,
    file: `furniture/${v.outputFile}`,
    width: sourceAsset?.width ?? 32,
    height: sourceAsset?.height ?? 32,
    footprintW: v.footprintW,
    footprintH: v.footprintH,
    isDesk: v.isDesk,
    groupId: v.groupId,
    orientation: v.orientation,
  }
  if (v.canPlaceOnSurfaces) entry.canPlaceOnSurfaces = true
  if (v.backgroundTiles) entry.backgroundTiles = v.backgroundTiles
  if (v.renderOffsetY) entry.renderOffsetY = v.renderOffsetY

  catalog.assets.push(entry)
}

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
console.log(`\n✅ Updated catalog with ${variants.length} side-facing variants`)
console.log(`Total assets: ${catalog.assets.length}`)
