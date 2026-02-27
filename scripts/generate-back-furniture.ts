/**
 * Generate back-facing desk variants by vertically flipping front-facing sprites.
 *
 * For top-down pixel art desks:
 * - Front-facing: monitor/items face DOWN (viewer sees front of monitor)
 * - Back-facing: monitor/items face UP (viewer sees back of monitor)
 *
 * This lets characters sit BELOW the desk facing UP toward it,
 * so the player sees the character's face while they work.
 *
 * Run: npx tsx scripts/generate-back-furniture.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { PNG } from 'pngjs'

const ASSETS_DIR = path.join(__dirname, '..', 'webview-ui', 'public', 'assets', 'furniture')

interface BackVariant {
  sourceFile: string
  outputFile: string
  id: string
  label: string
  category: string
  orientation: string
  footprintW: number
  footprintH: number
  isDesk: boolean
  groupId: string
}

const variants: BackVariant[] = [
  {
    sourceFile: 'Desk.png', outputFile: 'Desk-Back.png',
    id: 'DESK_BACK', label: 'Desk - Back', category: 'desks',
    orientation: 'back', footprintW: 2, footprintH: 2, isDesk: true,
    groupId: 'desk1',
  },
  {
    sourceFile: 'Desk-2.png', outputFile: 'Desk-2-Back.png',
    id: 'DESK_2_BACK', label: 'Desk 2 - Back', category: 'desks',
    orientation: 'back', footprintW: 2, footprintH: 2, isDesk: true,
    groupId: 'desk2',
  },
  {
    sourceFile: 'Boss-Desk.png', outputFile: 'Boss-Desk-Back.png',
    id: 'BOSS_DESK_BACK', label: 'Boss Desk - Back', category: 'desks',
    orientation: 'back', footprintW: 2, footprintH: 2, isDesk: true,
    groupId: 'bossdesk',
  },
]

/** Rotate 180°: flip both horizontal and vertical (physical rotation) */
function rotate180(source: PNG): PNG {
  const result = new PNG({ width: source.width, height: source.height })
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const srcIdx = (y * source.width + x) * 4
      const dstX = source.width - 1 - x
      const dstY = source.height - 1 - y
      const dstIdx = (dstY * source.width + dstX) * 4
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
  const outPng = rotate180(srcPng)

  const outPath = path.join(ASSETS_DIR, v.outputFile)
  fs.writeFileSync(outPath, PNG.sync.write(outPng))
  console.log(`✓ ${v.outputFile} (back variant of ${v.sourceFile})`)
}

// Update furniture-catalog.json
const catalogPath = path.join(ASSETS_DIR, 'furniture-catalog.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'))

// Map source filenames to catalog IDs
const fileToId: Record<string, string> = {}
for (const a of catalog.assets) {
  const fname = (a.file as string).replace('furniture/', '')
  fileToId[fname] = a.id as string
}

// Add new back-facing variants to catalog
for (const v of variants) {
  // Check if already exists
  if (catalog.assets.find((a: Record<string, unknown>) => a.id === v.id)) {
    console.log(`⏭️  ${v.id} already in catalog`)
    continue
  }

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

  catalog.assets.push(entry)
  console.log(`➕ Added ${v.id} to catalog`)
}

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
console.log(`\n✅ Updated catalog with ${variants.length} back-facing desk variants`)
console.log(`Total assets: ${catalog.assets.length}`)
