/**
 * Port of the IntelliJ-side AssetLoader.kt to TypeScript so the standalone
 * MCP bridge browser surface can show the same themed sprites/furniture as
 * the IDE plugin. Loads PNGs from the bundled `web/assets/` folder and
 * pre-parses them into the hex-string grid the React webview expects
 * (matching the contract in spriteData.ts).
 *
 * Stays dependency-light: only `pngjs` for decoding (also used by the
 * main extension). Synchronous reads only — boot is tiny and the bridge
 * holds the parsed buffers in memory for the lifetime of the process.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { PNG } from "pngjs"

const PNG_ALPHA_THRESHOLD = 128
const CHARACTER_DIRECTIONS = ["down", "up", "right"] as const
const CHAR_FRAME_W = 24
const CHAR_FRAME_H = 32
const CHAR_FRAMES_PER_ROW = 7
const FLOOR_PATTERN_COUNT = 7
const FLOOR_TILE_SIZE = 16
const WALL_BITMASK_COUNT = 16
const WALL_GRID_COLS = 4
const WALL_PIECE_WIDTH = 16
const WALL_PIECE_HEIGHT = 32

export type ThemeName = "default" | "alien" | "cat" | "zoo"

interface ThemePaths {
  chars: string
  floors: string
  walls: string
  furniture: string
  defaultLayout: string
}

const THEMES: Record<ThemeName, ThemePaths> = {
  default: { chars: "characters", floors: "floors.png", walls: "walls.png", furniture: "furniture", defaultLayout: "default-layout.json" },
  alien: { chars: "characters-alien", floors: "floors-alien.png", walls: "walls-alien.png", furniture: "furniture-alien", defaultLayout: "default-layout-alien.json" },
  cat: { chars: "characters-cat", floors: "floors-cat.png", walls: "walls-cat.png", furniture: "furniture-cat", defaultLayout: "default-layout-cat.json" },
  zoo: { chars: "characters-zoo", floors: "floors-zoo.png", walls: "walls-zoo.png", furniture: "furniture-zoo", defaultLayout: "default-layout-zoo.json" },
}

/** 2D array of hex color strings ("" = transparent pixel). Matches the
 *  shape used by spriteData.ts in the webview. */
export type SpriteData = string[][]

export interface LoadedAssets {
  theme: ThemeName
  characters: Record<string, SpriteData[]>[]      // [charIdx]{direction: [frame...]}
  floors: SpriteData[]                            // 7 patterns
  walls: SpriteData[]                             // 16 auto-tile pieces
  furnitureCatalog: unknown[]                     // raw catalog entries
  furnitureSprites: Record<string, SpriteData>    // id → sprite
  layout: unknown | null                          // user layout or themed default
  layoutCols: number | null                       // cols extracted from layout
  layoutRows: number | null                       // rows extracted from layout
  /** Head-overlay identity badges (main vs sub agent). Loaded from
   *  webview-ui/public/assets/icons/. SpriteData arrays preserve
   *  original colors — the renderer composites them over a 9-slice
   *  frame for a card-style look. */
  identityMain: SpriteData | null
  identitySub: SpriteData | null
  /** Head-overlay status badges (what the agent is doing). */
  statusActive: SpriteData | null
  statusWait: SpriteData | null
  statusIdle: SpriteData | null
  /** Kenney 9-slice frame applied behind every head-overlay icon. */
  frame: SpriteData | null
}

/** Top-level helper used by the WS bootstrap path. */
export function loadAssetsForTheme(webRoot: string, theme: ThemeName): LoadedAssets {
  const assetsDir = join(webRoot, "assets")
  const paths = THEMES[theme]

  const characters = loadCharacterSprites(join(assetsDir, paths.chars))
  const floors = loadFloorTiles(join(assetsDir, paths.floors))
  const walls = loadWallTiles(join(assetsDir, paths.walls))
  const { catalog, sprites } = loadFurnitureAssets(assetsDir, paths.furniture)
  const layout = loadLayout(assetsDir, paths.defaultLayout)

  const dims = extractLayoutDims(layout)
  const iconsDir = join(assetsDir, "icons")
  const identityMain = loadIconSprite(join(iconsDir, "identity-main.png"))
  const identitySub = loadIconSprite(join(iconsDir, "identity-sub.png"))
  const statusActive = loadIconSprite(join(iconsDir, "status-active.png"))
  const statusWait = loadIconSprite(join(iconsDir, "status-wait.png"))
  const statusIdle = loadIconSprite(join(iconsDir, "status-idle.png"))
  const frame = loadIconSprite(join(iconsDir, "frame.png"))
  return {
    theme,
    characters,
    floors,
    walls,
    furnitureCatalog: catalog,
    furnitureSprites: sprites,
    layout,
    layoutCols: dims.cols,
    layoutRows: dims.rows,
    identityMain,
    identitySub,
    statusActive,
    statusWait,
    statusIdle,
    frame,
  }
}

/** Read a single small sprite PNG (e.g. 16×16 identity badge) into the
 *  same hex-grid shape used elsewhere. Trims trailing transparency
 *  rows/cols isn't necessary — the renderer ignores "" cells. */
function loadIconSprite(file: string): SpriteData | null {
  const img = readPng(file)
  if (!img) return null
  return regionToSpriteData(img, 0, 0, img.width, img.height)
}

function extractLayoutDims(layout: unknown): { cols: number | null; rows: number | null } {
  if (layout && typeof layout === "object") {
    const obj = layout as { cols?: unknown; rows?: unknown }
    const cols = typeof obj.cols === "number" ? Math.round(obj.cols) : null
    const rows = typeof obj.rows === "number" ? Math.round(obj.rows) : null
    return { cols, rows }
  }
  return { cols: null, rows: null }
}

/** Detect the theme from the bundled MCP server. Honors:
 *   1. PIXEL_OFFICE_THEME env var (explicit override)
 *   2. ~/.pixel-agents/theme.txt (single-line theme name)
 *   3. fallback to "default"
 *  Returns a guaranteed-valid ThemeName. */
export function detectTheme(): ThemeName {
  const env = process.env["PIXEL_OFFICE_THEME"]?.trim().toLowerCase()
  if (env && env in THEMES) return env as ThemeName
  try {
    const file = join(homedir(), ".pixel-agents", "theme.txt")
    if (existsSync(file)) {
      const t = readFileSync(file, "utf8").trim().toLowerCase()
      if (t in THEMES) return t as ThemeName
    }
  } catch { /* ignore */ }
  return "default"
}

/** Find the user's most recently saved layout. The IntelliJ plugin now
 *  scopes layouts per project at `~/.pixel-agents/<project-hash>/layout.json`
 *  (the bare ~/.pixel-agents/layout.json is the legacy global path, which
 *  may be stale). We pick the freshest one so a user who hopped between
 *  projects still sees the layout they were just editing.
 *
 *  Override: PIXEL_OFFICE_PROJECT=<hash> picks a specific project's
 *  layout. Useful when the user wants the office to mirror a particular
 *  IDE window. */
export function loadUserLayout(): unknown | null {
  try {
    const base = join(homedir(), ".pixel-agents")
    if (!existsSync(base)) return null

    const override = process.env["PIXEL_OFFICE_PROJECT"]?.trim()
    if (override) {
      const file = join(base, override, "layout.json")
      if (existsSync(file)) return parseJsonFile(file)
    }

    // Scan per-project directories + the legacy global file for freshness.
    type Candidate = { path: string; mtime: number }
    const candidates: Candidate[] = []
    for (const name of readdirSync(base)) {
      // Skip the bridge's own metadata directories so they can't shadow a
      // real project layout.
      if (name === "instances" || name === "runtime") continue
      const dir = join(base, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      const file = join(dir, "layout.json")
      if (!existsSync(file)) continue
      try {
        candidates.push({ path: file, mtime: statSync(file).mtimeMs })
      } catch { /* skip unreadable */ }
    }
    const legacy = join(base, "layout.json")
    if (existsSync(legacy)) {
      try {
        candidates.push({ path: legacy, mtime: statSync(legacy).mtimeMs })
      } catch { /* skip */ }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.mtime - a.mtime)
    const winner = candidates[0]
    console.error(`[pixel-bridge] using layout: ${winner.path}`)
    return parseJsonFile(winner.path)
  } catch (err) {
    console.error("[pixel-bridge] could not read user layout:", err)
    return null
  }
}

function parseJsonFile(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (err) {
    console.error(`[pixel-bridge] parse failed for ${file}:`, err)
    return null
  }
}

function readPng(path: string): PNG | null {
  try {
    if (!existsSync(path)) return null
    const buf = readFileSync(path)
    return PNG.sync.read(buf)
  } catch (err) {
    console.error(`[pixel-bridge] PNG read failed: ${path}`, err)
    return null
  }
}

/** Walk a rectangular region of an RGBA PNG buffer and emit a hex-string
 *  grid. Pixels below alpha threshold come out as "" so the webview
 *  treats them as transparent. */
function regionToSpriteData(img: PNG, ox: number, oy: number, w: number, h: number): SpriteData {
  const out: SpriteData = []
  const data = img.data
  const stride = img.width * 4
  for (let y = 0; y < h; y++) {
    const row: string[] = []
    const rowOff = (oy + y) * stride
    for (let x = 0; x < w; x++) {
      const i = rowOff + (ox + x) * 4
      const a = data[i + 3]
      if (a < PNG_ALPHA_THRESHOLD) {
        row.push("")
      } else {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        row.push("#" + toHex(r) + toHex(g) + toHex(b))
      }
    }
    out.push(row)
  }
  return out
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0").toUpperCase()
}

function loadCharacterSprites(charDir: string): LoadedAssets["characters"] {
  const characters: LoadedAssets["characters"] = []
  if (!existsSync(charDir)) return characters

  // Auto-detect char_0.png .. char_N.png
  let count = 0
  while (existsSync(join(charDir, `char_${count}.png`))) count++

  for (let idx = 0; idx < count; idx++) {
    const img = readPng(join(charDir, `char_${idx}.png`))
    if (!img) continue
    const charData: Record<string, SpriteData[]> = {}
    for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
      const rowY = dirIdx * CHAR_FRAME_H
      const frames: SpriteData[] = []
      for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
        const frameX = f * CHAR_FRAME_W
        frames.push(regionToSpriteData(img, frameX, rowY, CHAR_FRAME_W, CHAR_FRAME_H))
      }
      charData[CHARACTER_DIRECTIONS[dirIdx]] = frames
    }
    characters.push(charData)
  }
  return characters
}

function loadFloorTiles(file: string): SpriteData[] {
  const img = readPng(file)
  if (!img) return []
  const out: SpriteData[] = []
  for (let t = 0; t < FLOOR_PATTERN_COUNT; t++) {
    out.push(regionToSpriteData(img, t * FLOOR_TILE_SIZE, 0, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE))
  }
  return out
}

function loadWallTiles(file: string): SpriteData[] {
  const img = readPng(file)
  if (!img) return []
  const out: SpriteData[] = []
  for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
    const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH
    const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT
    out.push(regionToSpriteData(img, ox, oy, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT))
  }
  return out
}

interface CatalogEntry {
  id?: string
  width?: number
  height?: number
  file?: string
  [k: string]: unknown
}

function loadFurnitureAssets(
  assetsDir: string,
  furnitureSubdir: string,
): { catalog: unknown[]; sprites: Record<string, SpriteData> } {
  let effective = furnitureSubdir
  let catalogFile = join(assetsDir, effective, "furniture-catalog.json")
  if (!existsSync(catalogFile)) {
    if (effective !== "furniture") {
      effective = "furniture"
      catalogFile = join(assetsDir, effective, "furniture-catalog.json")
    }
    if (!existsSync(catalogFile)) return { catalog: [], sprites: {} }
  }

  let catalogData: { assets?: CatalogEntry[] }
  try {
    catalogData = JSON.parse(readFileSync(catalogFile, "utf8"))
  } catch (err) {
    console.error("[pixel-bridge] catalog parse failed", err)
    return { catalog: [], sprites: {} }
  }
  const catalog = catalogData.assets ?? []

  const sprites: Record<string, SpriteData> = {}
  for (const asset of catalog) {
    const id = asset.id
    const w = asset.width
    const h = asset.height
    let filePath = asset.file
    if (!id || !w || !h || !filePath) continue
    if (!filePath.startsWith("assets/")) filePath = "assets/" + filePath
    // The catalog `file` is relative to the webRoot (web/assets/...), but
    // we have `assetsDir` = web/assets, so strip the leading "assets/".
    const relUnderAssets = filePath.replace(/^assets\//, "")
    const fullPath = join(assetsDir, relUnderAssets)
    const img = readPng(fullPath)
    if (!img) continue
    sprites[id] = regionToSpriteData(img, 0, 0, w, h)
  }
  return { catalog, sprites }
}

function loadLayout(assetsDir: string, defaultLayoutFile: string): unknown | null {
  // Prefer the user's saved layout — that's what shows in their IDE plugin.
  const user = loadUserLayout()
  if (user) return user
  try {
    const file = join(assetsDir, defaultLayoutFile)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (err) {
    console.error("[pixel-bridge] default layout parse failed", err)
    return null
  }
}

