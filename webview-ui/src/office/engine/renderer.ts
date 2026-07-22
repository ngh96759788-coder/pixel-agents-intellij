import { TileType, TILE_SIZE, CharacterState } from '../types.js'
import type { TileType as TileTypeVal, FurnitureInstance, Character, SpriteData, Seat, FloorColor } from '../types.js'
import { getCachedSprite, getOutlineSprite } from '../sprites/spriteCache.js'
import { getCharacterSprites, BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js'
import { getCharacterSprite } from './characters.js'
import { renderMatrixEffect } from './matrixEffect.js'
import { getColorizedFloorSprite, hasFloorSprites, WALL_COLOR } from '../floorTiles.js'
import { hasWallSprites, getWallInstances, wallColorToHex } from '../wallTiles.js'
import { contextWindowFor } from '../usage.js'
import {
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  EXTERNAL_AGENT_ALPHA,
  OUTLINE_Z_SORT_OFFSET,
  SELECTED_OUTLINE_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  GHOST_PREVIEW_SPRITE_ALPHA,
  GHOST_PREVIEW_TINT_ALPHA,
  SELECTION_DASH_PATTERN,
  BUTTON_MIN_RADIUS,
  BUTTON_RADIUS_ZOOM_FACTOR,
  BUTTON_ICON_SIZE_FACTOR,
  BUTTON_LINE_WIDTH_MIN,
  BUTTON_LINE_WIDTH_ZOOM_FACTOR,
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  FALLBACK_FLOOR_COLOR,
  SEAT_OWN_COLOR,
  SEAT_AVAILABLE_COLOR,
  SEAT_BUSY_COLOR,
  GRID_LINE_COLOR,
  VOID_TILE_OUTLINE_COLOR,
  VOID_TILE_DASH_PATTERN,
  GHOST_BORDER_HOVER_FILL,
  GHOST_BORDER_HOVER_STROKE,
  GHOST_BORDER_STROKE,
  GHOST_VALID_TINT,
  GHOST_INVALID_TINT,
  SELECTION_HIGHLIGHT_COLOR,
  DELETE_BUTTON_BG,
  ROTATE_BUTTON_BG,
  MAP_TOP_OFFSET_PX,
} from '../../constants.js'

// ── Render functions ────────────────────────────────────────────

export function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<FloorColor | null>,
  cols?: number,
): void {
  const s = TILE_SIZE * zoom
  const useSpriteFloors = hasFloorSprites()
  const tmRows = tileMap.length
  const tmCols = tmRows > 0 ? tileMap[0].length : 0
  const layoutCols = cols ?? tmCols

  // Floor tiles + wall base color
  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c]

      // Skip VOID tiles entirely (transparent)
      if (tile === TileType.VOID) continue

      if (tile === TileType.WALL || !useSpriteFloors) {
        // Wall tiles or fallback: solid color
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c
          const wallColor = tileColors?.[colorIdx]
          ctx.fillStyle = wallColor ? wallColorToHex(wallColor) : WALL_COLOR
        } else {
          ctx.fillStyle = FALLBACK_FLOOR_COLOR
        }
        ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s)
        continue
      }

      // Floor tile: get colorized sprite
      const colorIdx = r * layoutCols + c
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 }
      const sprite = getColorizedFloorSprite(tile, color)
      const cached = getCachedSprite(sprite, zoom)
      ctx.drawImage(cached, offsetX + c * s, offsetY + r * s)
    }
  }

}

interface ZDrawable {
  zY: number
  draw: (ctx: CanvasRenderingContext2D) => void
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
): void {
  const drawables: ZDrawable[] = []

  // Furniture
  for (const f of furniture) {
    const cached = getCachedSprite(f.sprite, zoom)
    const fx = offsetX + f.x * zoom
    const fy = offsetY + f.y * zoom
    drawables.push({
      zY: f.zY,
      draw: (c) => {
        c.drawImage(cached, fx, fy)
      },
    })
  }

  // Characters
  for (const ch of characters) {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift)
    const spriteData = getCharacterSprite(ch, sprites)
    const cached = getCachedSprite(spriteData, zoom)
    // Sitting offset: shift character down when seated so they visually sit in the chair
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
    // Anchor at bottom-center of character — round to integer device pixels
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height)

    // Sort characters by bottom of their tile (not center) so they render
    // in front of same-row furniture (e.g. chairs) but behind furniture
    // at lower rows (e.g. desks, bookshelves that occlude from below).
    // We used to subtract TILE_SIZE*2 when the character was typing facing
    // UP so the desk above them visually occluded their torso — that hack
    // is gone now because (a) workstations carry `zSortBoost: 24` so they
    // already render in front of the character, and (b) the hack made
    // top-row consoles cover characters too aggressively (the user only
    // wants workstations in front, not the small wall consoles).
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET

    // Matrix spawn/despawn effect — skip outline, use per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX
      const mDrawY = drawY
      const mSpriteData = spriteData
      const mCh = ch
      drawables.push({
        zY: charZY,
        draw: (c) => {
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom)
        },
      })
      continue
    }

    // White outline: full opacity for selected, 50% for hover
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA
      const outlineData = getOutlineSprite(spriteData)
      const outlineCached = getCachedSprite(outlineData, zoom)
      const olDrawX = drawX - zoom  // 1 sprite-pixel offset, scaled
      const olDrawY = drawY - zoom  // outline follows sitting offset via drawY
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET, // sort just before character
        draw: (c) => {
          c.save()
          c.globalAlpha = outlineAlpha
          c.drawImage(outlineCached, olDrawX, olDrawY)
          c.restore()
        },
      })
    }

    // Unified view (BEHAVIOR_SPEC §4): external-source characters render at
    // 85% opacity so they're visually distinct from this window's own work.
    const charAlpha = ch.isExternal ? EXTERNAL_AGENT_ALPHA : 1
    drawables.push({
      zY: charZY,
      draw: (c) => {
        if (charAlpha < 1) {
          c.save()
          c.globalAlpha = charAlpha
          c.drawImage(cached, drawX, drawY)
          c.restore()
        } else {
          c.drawImage(cached, drawX, drawY)
        }
      },
    })
  }

  // Sort by Y (lower = in front = drawn later)
  drawables.sort((a, b) => a.zY - b.zY)

  for (const d of drawables) {
    d.draw(ctx)
  }
}

// ── Seat indicators ─────────────────────────────────────────────

export function renderSeatIndicators(
  ctx: CanvasRenderingContext2D,
  seats: Map<string, Seat>,
  characters: Map<number, Character>,
  selectedAgentId: number | null,
  hoveredTile: { col: number; row: number } | null,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (selectedAgentId === null || !hoveredTile) return
  const selectedChar = characters.get(selectedAgentId)
  if (!selectedChar) return

  // Only show indicator for the hovered seat tile
  for (const [uid, seat] of seats) {
    if (seat.seatCol !== hoveredTile.col || seat.seatRow !== hoveredTile.row) continue

    const s = TILE_SIZE * zoom
    const x = offsetX + seat.seatCol * s
    const y = offsetY + seat.seatRow * s

    if (selectedChar.seatId === uid) {
      // Selected agent's own seat — blue
      ctx.fillStyle = SEAT_OWN_COLOR
    } else if (!seat.assigned) {
      // Available seat — green
      ctx.fillStyle = SEAT_AVAILABLE_COLOR
    } else {
      // Busy (assigned to another agent) — red
      ctx.fillStyle = SEAT_BUSY_COLOR
    }
    ctx.fillRect(x, y, s, s)
    break
  }
}

// ── Edit mode overlays ──────────────────────────────────────────

export function renderGridOverlay(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  tileMap?: TileTypeVal[][],
): void {
  const s = TILE_SIZE * zoom
  ctx.strokeStyle = GRID_LINE_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  // Vertical lines — offset by 0.5 for crisp 1px lines
  for (let c = 0; c <= cols; c++) {
    const x = offsetX + c * s + 0.5
    ctx.moveTo(x, offsetY)
    ctx.lineTo(x, offsetY + rows * s)
  }
  // Horizontal lines
  for (let r = 0; r <= rows; r++) {
    const y = offsetY + r * s + 0.5
    ctx.moveTo(offsetX, y)
    ctx.lineTo(offsetX + cols * s, y)
  }
  ctx.stroke()

  // Draw faint dashed outlines on VOID tiles
  if (tileMap) {
    ctx.save()
    ctx.strokeStyle = VOID_TILE_OUTLINE_COLOR
    ctx.lineWidth = 1
    ctx.setLineDash(VOID_TILE_DASH_PATTERN)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tileMap[r]?.[c] === TileType.VOID) {
          ctx.strokeRect(offsetX + c * s + 0.5, offsetY + r * s + 0.5, s - 1, s - 1)
        }
      }
    }
    ctx.restore()
  }
}

/** Draw faint expansion placeholders 1 tile outside grid bounds (ghost border). */
export function renderGhostBorder(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  ghostHoverCol: number,
  ghostHoverRow: number,
): void {
  const s = TILE_SIZE * zoom
  ctx.save()

  // Collect ghost border tiles: one ring around the grid
  const ghostTiles: Array<{ c: number; r: number }> = []
  // Top and bottom rows
  for (let c = -1; c <= cols; c++) {
    ghostTiles.push({ c, r: -1 })
    ghostTiles.push({ c, r: rows })
  }
  // Left and right columns (excluding corners already added)
  for (let r = 0; r < rows; r++) {
    ghostTiles.push({ c: -1, r })
    ghostTiles.push({ c: cols, r })
  }

  for (const { c, r } of ghostTiles) {
    const x = offsetX + c * s
    const y = offsetY + r * s
    const isHovered = c === ghostHoverCol && r === ghostHoverRow
    if (isHovered) {
      ctx.fillStyle = GHOST_BORDER_HOVER_FILL
      ctx.fillRect(x, y, s, s)
    }
    ctx.strokeStyle = isHovered ? GHOST_BORDER_HOVER_STROKE : GHOST_BORDER_STROKE
    ctx.lineWidth = 1
    ctx.setLineDash(VOID_TILE_DASH_PATTERN)
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1)
  }

  ctx.restore()
}

export function renderGhostPreview(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  col: number,
  row: number,
  valid: boolean,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const cached = getCachedSprite(sprite, zoom)
  const x = offsetX + col * TILE_SIZE * zoom
  const y = offsetY + row * TILE_SIZE * zoom
  ctx.save()
  ctx.globalAlpha = GHOST_PREVIEW_SPRITE_ALPHA
  ctx.drawImage(cached, x, y)
  // Tint overlay
  ctx.globalAlpha = GHOST_PREVIEW_TINT_ALPHA
  ctx.fillStyle = valid ? GHOST_VALID_TINT : GHOST_INVALID_TINT
  ctx.fillRect(x, y, cached.width, cached.height)
  ctx.restore()
}

export function renderSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const s = TILE_SIZE * zoom
  const x = offsetX + col * s
  const y = offsetY + row * s
  ctx.save()
  ctx.strokeStyle = SELECTION_HIGHLIGHT_COLOR
  ctx.lineWidth = 2
  ctx.setLineDash(SELECTION_DASH_PATTERN)
  ctx.strokeRect(x + 1, y + 1, w * s - 2, h * s - 2)
  ctx.restore()
}

export function renderDeleteButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): DeleteButtonBounds {
  const s = TILE_SIZE * zoom
  // Position at top-right corner of selected furniture
  const cx = offsetX + (col + w) * s + 1
  const cy = offsetY + row * s - 1
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR)

  // Circle background
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = DELETE_BUTTON_BG
  ctx.fill()

  // X mark
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR)
  ctx.lineCap = 'round'
  const xSize = radius * BUTTON_ICON_SIZE_FACTOR
  ctx.beginPath()
  ctx.moveTo(cx - xSize, cy - xSize)
  ctx.lineTo(cx + xSize, cy + xSize)
  ctx.moveTo(cx + xSize, cy - xSize)
  ctx.lineTo(cx - xSize, cy + xSize)
  ctx.stroke()
  ctx.restore()

  return { cx, cy, radius }
}

export function renderRotateButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  _w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): RotateButtonBounds {
  const s = TILE_SIZE * zoom
  // Position to the left of the delete button (which is at top-right corner)
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR)
  const cx = offsetX + col * s - 1
  const cy = offsetY + row * s - 1

  // Circle background
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = ROTATE_BUTTON_BG
  ctx.fill()

  // Circular arrow icon
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(BUTTON_LINE_WIDTH_MIN, zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR)
  ctx.lineCap = 'round'
  const arcR = radius * BUTTON_ICON_SIZE_FACTOR
  ctx.beginPath()
  // Draw a 270-degree arc
  ctx.arc(cx, cy, arcR, -Math.PI * 0.8, Math.PI * 0.7)
  ctx.stroke()
  // Draw arrowhead at the end of the arc
  const endAngle = Math.PI * 0.7
  const endX = cx + arcR * Math.cos(endAngle)
  const endY = cy + arcR * Math.sin(endAngle)
  const arrowSize = radius * 0.35
  ctx.beginPath()
  ctx.moveTo(endX + arrowSize * 0.6, endY - arrowSize * 0.3)
  ctx.lineTo(endX, endY)
  ctx.lineTo(endX + arrowSize * 0.7, endY + arrowSize * 0.5)
  ctx.stroke()
  ctx.restore()

  return { cx, cy, radius }
}

// ── Parent → sub-agent tether lines ────────────────────────────
//
// A short pixel-art "string" between each sub-agent and its parent main
// agent so the family relationship is visible on the floor even when the
// two characters wander apart. Drawn under furniture/characters in the
// scene order so it never occludes sprites. Dashed by skipping every other
// pixel along the line for that hand-stippled pixel feel.
// Soft yellow-green so the dashed thread reads against both warm wood
// and cool sci-fi floors without screaming for attention. Bumped alpha
// over the first iteration's barely-visible parchment yellow.
const TETHER_COLOR = 'rgba(150, 220, 130, 0.85)'
const TETHER_DASH = 2 // sprite-pixel dash length

export function renderParentTethers(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  shouldDraw?: (subId: number, parentId: number) => boolean,
): void {
  const charById = new Map<number, Character>()
  for (const ch of characters) charById.set(ch.id, ch)

  ctx.save()
  ctx.fillStyle = TETHER_COLOR
  for (const ch of characters) {
    if (!ch.isSubagent) continue
    if (ch.parentAgentId == null) continue
    if (ch.matrixEffect === 'despawn') continue
    const parent = charById.get(ch.parentAgentId)
    if (!parent) continue
    if (parent.matrixEffect === 'despawn') continue
    if (shouldDraw && !shouldDraw(ch.id, parent.id)) continue

    // Anchor at each character's torso (slightly above the foot anchor).
    const x1 = offsetX + ch.x * zoom
    const y1 = offsetY + (ch.y - 8) * zoom
    const x2 = offsetX + parent.x * zoom
    const y2 = offsetY + (parent.y - 8) * zoom

    // Step along the line in sprite-pixel units, drawing 1-sprite-pixel
    // squares scaled by zoom — keeps the dash pattern crisp at any zoom.
    const dxPx = (x2 - x1) / zoom
    const dyPx = (y2 - y1) / zoom
    const lenPx = Math.hypot(dxPx, dyPx)
    if (lenPx < 1) continue
    const stepX = dxPx / lenPx
    const stepY = dyPx / lenPx
    for (let i = 0; i < lenPx; i++) {
      // dash on/off pattern: TETHER_DASH on, TETHER_DASH off
      const phase = Math.floor(i / TETHER_DASH) % 2
      if (phase !== 0) continue
      const px = Math.round(x1 + stepX * i * zoom)
      const py = Math.round(y1 + stepY * i * zoom)
      ctx.fillRect(px, py, zoom, zoom)
    }
  }
  ctx.restore()
}

// ── HP-style context-window bar above each character ────────────
//
// Always-visible pixel bar that mimics classic RPG nameplate gauges:
// fills as the agent burns context tokens, color-shifts green→amber→red
// as it approaches the model window limit. Replaces "user has to hover
// to know how much room is left" with an at-a-glance signal.
const HP_BAR_WIDTH_PX = 8    // matches the 8×8 badge slot width
const HP_BAR_HEIGHT_PX = 3
/** Fallback when no model has been resolved on the character yet.
 *  Real per-character scale comes from `contextWindowFor(ch.model)`. */
const FALLBACK_CONTEXT_LIMIT = 200_000

function hpBarColor(ratio: number): string {
  if (ratio >= 0.85) return '#d05050' // muted brick red
  if (ratio >= 0.65) return '#d6b25a' // muted gold
  return '#6fb87a'                     // muted forest green
}

export function renderHpBars(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  shouldDraw?: (chId: number) => boolean,
): void {
  ctx.save()
  for (const ch of characters) {
    if (ch.matrixEffect === 'despawn') continue
    if (shouldDraw && !shouldDraw(ch.id)) continue

    // Progress-bar treatment: always draw the empty track full-width so the
    // bar reads as "0% full" instead of "missing" when contextTokens isn't
    // known yet. Fill grows from the left as tokens accumulate.
    const tokens = ch.contextTokens > 0 ? ch.contextTokens : 0
    const limit = ch.model ? contextWindowFor(ch.model) : FALLBACK_CONTEXT_LIMIT
    const ratio = Math.min(1, tokens / limit)
    const sittingOff = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
    // Sit in the right slot of the head-plate strip, vertically centered
    // with the 7-tall identity/status icons so the bar reads as part of
    // the same row instead of dangling above/below it.
    const headTop = ch.y + sittingOff - 24
    const topY = headTop - HEADPLATE_OFFSET_ABOVE_HEAD + Math.floor((ICON_H - HP_BAR_HEIGHT_PX) / 2)
    const leftX = ch.x + HP_LEFT_OFFSET

    const barX = Math.round(offsetX + leftX * zoom)
    const barY = Math.round(offsetY + topY * zoom)
    const barW = HP_BAR_WIDTH_PX * zoom
    const barH = HP_BAR_HEIGHT_PX * zoom

    // 1px pixel border (no anti-aliasing — use fillRect quad).
    ctx.fillStyle = '#1a1a24'
    ctx.fillRect(barX - zoom, barY - zoom, barW + 2 * zoom, barH + 2 * zoom)
    // empty track — always visible
    ctx.fillStyle = '#3a3a4a'
    ctx.fillRect(barX, barY, barW, barH)
    // filled portion (zero when no tokens reported yet)
    if (ratio > 0) {
      const fillW = Math.max(zoom, Math.floor(barW * ratio))
      ctx.fillStyle = hpBarColor(ratio)
      ctx.fillRect(barX, barY, fillW, barH)
    }
  }
  ctx.restore()
}

// ── 5×7 pixel-letter icons for status & identity ───────────────
//
// Hand-coded monochrome masks. Rectangular (5 wide × 7 tall) so they
// stack in a horizontal nameplate strip next to the HP bar — game-UI
// convention rather than the vertical totem the first iteration had.
// Each character cell becomes a 1-zoom-pixel square at render time.
type IconMask = ReadonlyArray<string>
const ICON_H = 7
// Width is implicit in each mask row length (5); reserved here for any
// future layout helper that wants symbolic width.

// Active — small gear fallback. Used until host loads a PNG asset.
const DEFAULT_ICON_ACTIVE: IconMask = [
  '.X.X.',
  'XXXXX',
  'X...X',
  'X...X',
  'X...X',
  'XXXXX',
  '.X.X.',
]
let ICON_ACTIVE: IconMask = DEFAULT_ICON_ACTIVE
// Default fallback masks — used when no PNG sprites have been loaded.
// The host (IntelliJ plugin or MCP bridge) overrides these via
// `setStatusIcons` with real assets (chaicon, MIT).
const DEFAULT_ICON_IDLE: IconMask = [
  '.XXX.',
  'XX...',
  'XX...',
  'XX...',
  'XX...',
  'XX...',
  '.XXX.',
]
const DEFAULT_ICON_WAIT: IconMask = [
  '..X..',
  '..X..',
  '..X..',
  '..X..',
  '.....',
  '..X..',
  '..X..',
]
let ICON_IDLE: IconMask = DEFAULT_ICON_IDLE
let ICON_WAIT: IconMask = DEFAULT_ICON_WAIT
// Default identity icons — fallback when no PNG assets have been loaded
// from the extension/bridge (block letters M and S). The host overrides
// these via `setIdentityIcons()` with CC0 pixel-art sprites from
// tstamborski/pixelart-icons (star for main, diamond for sub).
const DEFAULT_ICON_MAIN: IconMask = [
  'X...X',
  'XX.XX',
  'X.X.X',
  'X.X.X',
  'X...X',
  'X...X',
  'X...X',
]
const DEFAULT_ICON_SUB: IconMask = [
  '.XXXX',
  'X....',
  'X....',
  '.XXX.',
  '....X',
  '....X',
  'XXXX.',
]
let ICON_MAIN: IconMask = DEFAULT_ICON_MAIN
let ICON_SUB: IconMask = DEFAULT_ICON_SUB

/** Convert a loaded PNG sprite (2D hex-string array with "" for
 *  transparency) to the simple X/. mask format `drawPixelIcon`
 *  expects. Trims transparent borders so the badge sits compactly
 *  in its head-plate slot. */
function spriteToMask(sprite: string[][]): IconMask {
  if (sprite.length === 0) return ['.']
  let minX = sprite[0].length, minY = sprite.length, maxX = -1, maxY = -1
  for (let y = 0; y < sprite.length; y++) {
    const row = sprite[y]
    for (let x = 0; x < row.length; x++) {
      if (row[x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return ['.']
  const mask: string[] = []
  for (let y = minY; y <= maxY; y++) {
    let row = ''
    for (let x = minX; x <= maxX; x++) row += sprite[y][x] ? 'X' : '.'
    mask.push(row)
  }
  return mask
}

// Untrimmed source sprites (preserves original aspect/positioning).
let SPRITE_MAIN: string[][] | null = null
let SPRITE_SUB: string[][] | null = null
let SPRITE_ACTIVE: string[][] | null = null
let SPRITE_WAIT: string[][] | null = null
let SPRITE_IDLE: string[][] | null = null
// Kenney 9-slice frame asset. When loaded, every head badge is
// composited as: 9-slice frame back → icon centered on top.
let SPRITE_FRAME: string[][] | null = null

/** Trim transparent borders from a sprite. Currently unused (we pass
 *  full sprites through so the 9-slice frame centering still works on
 *  the native 16×16 canvas), but kept around for cases where a host
 *  ships icons with large transparent padding. */
// @ts-expect-error retained for future host-side trimming use
function trimSprite(sprite: string[][]): string[][] | null {
  if (sprite.length === 0) return null
  let minX = sprite[0].length, minY = sprite.length, maxX = -1, maxY = -1
  for (let y = 0; y < sprite.length; y++) {
    const row = sprite[y]
    for (let x = 0; x < row.length; x++) {
      if (row[x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  const out: string[][] = []
  for (let y = minY; y <= maxY; y++) {
    const row: string[] = []
    for (let x = minX; x <= maxX; x++) row.push(sprite[y][x] || '')
    out.push(row)
  }
  return out
}

/** Replace the fallback identity icons with sprites loaded by the
 *  host. Pass `null` to keep the existing fallback in that slot. */
export function setIdentityIcons(main: string[][] | null, sub: string[][] | null): void {
  if (main && main.length > 0) {
    ICON_MAIN = spriteToMask(main)
    // Keep untrimmed so framed compositing can rely on the native 16×16
    // canvas placement.
    SPRITE_MAIN = main
  }
  if (sub && sub.length > 0) {
    ICON_SUB = spriteToMask(sub)
    SPRITE_SUB = sub
  }
}

/** Provide the Kenney 9-slice frame asset (untrimmed). When set,
 *  every head badge gets the frame composited behind the icon. */
export function setHeadFrame(frame: string[][] | null): void {
  SPRITE_FRAME = (frame && frame.length > 0) ? frame : null
}

/** Replace the fallback status icons (active / wait / idle). Pass
 *  `null` for any slot to keep the existing fallback there. */
export function setStatusIcons(
  active: string[][] | null,
  wait: string[][] | null,
  idle: string[][] | null,
): void {
  if (active && active.length > 0) {
    ICON_ACTIVE = spriteToMask(active)
    SPRITE_ACTIVE = active
  }
  if (wait && wait.length > 0) {
    ICON_WAIT = spriteToMask(wait)
    SPRITE_WAIT = wait
  }
  if (idle && idle.length > 0) {
    ICON_IDLE = spriteToMask(idle)
    SPRITE_IDLE = idle
  }
}

// Target output size for a head badge in sprite-pixels. Sized down to
// 8×8 so two badges + HP bar fit neatly above a 24-px character head
// without dwarfing the character art. 9-slice corner=2 keeps the
// rounded edge from the source Kenney frame.
const BADGE_PX = 8
const FRAME_CORNER = 2

/** Resize a sprite via 9-slice — corners preserved, edges stretched/
 *  tiled, centre filled. Returns a `target×target` sprite. */
function nineSliceResize(src: string[][], target: number, corner: number): string[][] {
  const H = src.length
  const W = H > 0 ? src[0].length : 0
  const out: string[][] = []
  const srcEdge = W - 2 * corner
  const dstEdge = target - 2 * corner
  for (let dy = 0; dy < target; dy++) {
    const row: string[] = []
    let sy: number
    if (dy < corner) sy = dy
    else if (dy >= target - corner) sy = H - (target - dy)
    else sy = corner + Math.floor(((dy - corner) / dstEdge) * srcEdge)
    sy = Math.max(0, Math.min(H - 1, sy))
    const srcRow = src[sy] ?? []
    for (let dx = 0; dx < target; dx++) {
      let sx: number
      if (dx < corner) sx = dx
      else if (dx >= target - corner) sx = W - (target - dx)
      else sx = corner + Math.floor(((dx - corner) / dstEdge) * srcEdge)
      sx = Math.max(0, Math.min(W - 1, sx))
      row.push(srcRow[sx] ?? '')
    }
    out.push(row)
  }
  return out
}

/** Bbox-trim a sprite then nearest-neighbor sample to a target size,
 *  preserving original hex colors. Used when the source icon (e.g.
 *  16×16 chaicon) is larger than the inner area of the frame. */
function downsampleSprite(sprite: string[][], target: number): string[][] {
  // Trim transparent borders to maximize useful pixels in the result.
  let minX = sprite[0]?.length ?? 0, minY = sprite.length, maxX = -1, maxY = -1
  for (let y = 0; y < sprite.length; y++) {
    const row = sprite[y]
    for (let x = 0; x < row.length; x++) {
      if (row[x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return Array.from({ length: target }, () => Array(target).fill(''))
  const srcW = maxX - minX + 1, srcH = maxY - minY + 1
  const out: string[][] = []
  for (let y = 0; y < target; y++) {
    const row: string[] = []
    const sy = minY + Math.floor(y * srcH / target)
    for (let x = 0; x < target; x++) {
      const sx = minX + Math.floor(x * srcW / target)
      row.push(sprite[sy]?.[sx] ?? '')
    }
    out.push(row)
  }
  return out
}

/** Composite icon centered onto frame (returns new sprite). If the icon
 *  is larger than the frame's inner area (frame size minus 2-px padding),
 *  the icon is bbox-trimmed and nearest-neighbor downsampled to fit. */
function compositeFramedBadge(frame: string[][], icon: string[][]): string[][] {
  const target = frame.length
  const innerSize = Math.max(1, target - 2)  // 1-px padding each side
  const out: string[][] = frame.map((row) => row.slice())
  // Downsample the icon if it's bigger than the inner area.
  const iconH = icon.length
  const iconW = iconH > 0 ? icon[0].length : 0
  const useIcon = (iconW > innerSize || iconH > innerSize)
    ? downsampleSprite(icon, innerSize)
    : icon
  const ih = useIcon.length
  const iw = ih > 0 ? useIcon[0].length : 0
  const offX = Math.floor((target - iw) / 2)
  const offY = Math.floor((target - ih) / 2)
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const c = useIcon[y][x]
      if (!c) continue
      const tx = offX + x, ty = offY + y
      if (tx < 0 || ty < 0 || tx >= target || ty >= target) continue
      out[ty][tx] = c
    }
  }
  return out
}

// Cached 9-slice resized frame so we don't recompute every frame.
let CACHED_FRAME: string[][] | null = null
let CACHED_FRAME_SOURCE: string[][] | null = null
function getResizedFrame(): string[][] | null {
  if (!SPRITE_FRAME) return null
  if (CACHED_FRAME_SOURCE === SPRITE_FRAME && CACHED_FRAME) return CACHED_FRAME
  CACHED_FRAME = nineSliceResize(SPRITE_FRAME, BADGE_PX, FRAME_CORNER)
  CACHED_FRAME_SOURCE = SPRITE_FRAME
  return CACHED_FRAME
}

/** Render a multi-color sprite (hex strings per cell, "" = transparent)
 *  preserving the original palette. Three layers for visibility on any
 *  background:
 *    1. dark silhouette edge (bottom/right) — anchors the shape
 *    2. original-color fill
 *    3. light highlight edge (top/left) — adds a soft "lit" rim that
 *       pops the icon out of the grey Kenney frame without enlarging
 *       it or distorting the colours. */
function drawSpriteIcon(
  ctx: CanvasRenderingContext2D,
  sprite: string[][],
  originX: number,
  originY: number,
  zoom: number,
): void {
  const lit = (r: number, c: number): boolean => {
    const row = sprite[r]
    return !!row && !!row[c]
  }
  // 1. Dark silhouette (bottom + right only, so the highlight pass has
  //    room to brighten the top + left).
  ctx.fillStyle = '#1a1a24'
  for (let row = 0; row < sprite.length; row++) {
    const line = sprite[row]
    for (let col = 0; col < line.length; col++) {
      if (!line[col]) continue
      const px = Math.round(originX * zoom + col * zoom)
      const py = Math.round(originY * zoom + row * zoom)
      if (!lit(row + 1, col)) ctx.fillRect(px, py + zoom, zoom, 1)
      if (!lit(row, col + 1)) ctx.fillRect(px + zoom, py, 1, zoom)
    }
  }
  // 2. Original-color fill.
  for (let row = 0; row < sprite.length; row++) {
    const line = sprite[row]
    for (let col = 0; col < line.length; col++) {
      const c = line[col]
      if (!c) continue
      const px = Math.round(originX * zoom + col * zoom)
      const py = Math.round(originY * zoom + row * zoom)
      ctx.fillStyle = c
      ctx.fillRect(px, py, zoom, zoom)
    }
  }
  // 3. Light highlight edge (top + left). Cream-white reads as a soft
  //    rim-light against the grey Kenney frame without overpowering
  //    the icon's own colours.
  ctx.fillStyle = '#f5efd9'
  for (let row = 0; row < sprite.length; row++) {
    const line = sprite[row]
    for (let col = 0; col < line.length; col++) {
      if (!line[col]) continue
      const px = Math.round(originX * zoom + col * zoom)
      const py = Math.round(originY * zoom + row * zoom)
      if (!lit(row - 1, col)) ctx.fillRect(px, py - 1, zoom, 1)
      if (!lit(row, col - 1)) ctx.fillRect(px - 1, py, 1, zoom)
    }
  }
}

/** Pixel-rasterise a mask into the canvas at the given sprite-pixel
 *  origin. Draws a SILHOUETTE outline (only on the outer edge of the
 *  mask, not around each pixel) followed by the fill. The per-pixel
 *  outline approach was producing "circle cluster" halos around
 *  disconnected pixels (e.g. stars) because each lit pixel got its
 *  own dark blob; cells only get an outline edge facing a transparent
 *  neighbour now. */
function drawPixelIcon(
  ctx: CanvasRenderingContext2D,
  icon: IconMask,
  originX: number, // sprite-pixel
  originY: number, // sprite-pixel
  zoom: number,
  fill: string,
): void {
  const lit = (r: number, c: number): boolean => {
    const row = icon[r]
    return !!row && row[c] === 'X'
  }
  ctx.fillStyle = '#1a1a24'
  for (let row = 0; row < icon.length; row++) {
    const line = icon[row]
    for (let col = 0; col < line.length; col++) {
      if (line[col] !== 'X') continue
      const px = Math.round(originX * zoom + col * zoom)
      const py = Math.round(originY * zoom + row * zoom)
      // Draw outline edges only on sides facing a transparent neighbour,
      // producing a single shared silhouette around the whole shape.
      if (!lit(row - 1, col)) ctx.fillRect(px, py - 1, zoom, 1)         // top
      if (!lit(row + 1, col)) ctx.fillRect(px, py + zoom, zoom, 1)      // bottom
      if (!lit(row, col - 1)) ctx.fillRect(px - 1, py, 1, zoom)         // left
      if (!lit(row, col + 1)) ctx.fillRect(px + zoom, py, 1, zoom)      // right
    }
  }
  ctx.fillStyle = fill
  for (let row = 0; row < icon.length; row++) {
    const line = icon[row]
    for (let col = 0; col < line.length; col++) {
      if (line[col] !== 'X') continue
      const px = Math.round(originX * zoom + col * zoom)
      const py = Math.round(originY * zoom + row * zoom)
      ctx.fillRect(px, py, zoom, zoom)
    }
  }
}

// Horizontal "nameplate" strip floats this many sprite-pixels above the
// character's head — chosen to clear the head silhouette completely so
// the bar/icons never overlap the character art. Single row, side-by-
// side layout (RPG-style): identity letter → status icon → HP bar.
const HEADPLATE_OFFSET_ABOVE_HEAD = 4
// Fixed horizontal slots relative to character.x (sprite-pixel units).
// Character is anchored bottom-CENTER at (ch.x, ch.y) with a 16-wide
// sprite, so ch.x IS the visual centre line. With three 8-wide slots
// (24 total) centred on ch.x: leftmost slot starts at -12.
//   identity at -12 (−12..−4), status at -4 (−4..+4), hp at +4 (+4..+12).
const IDENTITY_LEFT_OFFSET = -12
const STATUS_LEFT_OFFSET = -4
const HP_LEFT_OFFSET = 4

const COLOR_MAIN = '#5fb8c8'
const COLOR_SUB = '#a888d8'
const COLOR_ACTIVE = '#6fb87a'
const COLOR_WAIT = '#d6b25a'
const COLOR_IDLE = '#7a7a8a'

export function renderIdentityDots(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  shouldDraw?: (chId: number) => boolean,
): void {
  ctx.save()
  for (const ch of characters) {
    if (ch.matrixEffect === 'despawn') continue
    if (shouldDraw && !shouldDraw(ch.id)) continue
    const sittingOff = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
    const topY = ch.y + sittingOff - 24 - HEADPLATE_OFFSET_ABOVE_HEAD
    const leftX = ch.x + IDENTITY_LEFT_OFFSET
    const originX = offsetX / zoom + leftX
    const originY = offsetY / zoom + topY
    const sprite = ch.isSubagent ? SPRITE_SUB : SPRITE_MAIN
    const frame = getResizedFrame()
    if (sprite && frame) {
      const badge = compositeFramedBadge(frame, sprite)
      drawSpriteIcon(ctx, badge, originX, originY, zoom)
    } else if (sprite) {
      drawSpriteIcon(ctx, sprite, originX, originY, zoom)
    } else {
      drawPixelIcon(
        ctx,
        ch.isSubagent ? ICON_SUB : ICON_MAIN,
        originX, originY, zoom,
        ch.isSubagent ? COLOR_SUB : COLOR_MAIN,
      )
    }
  }
  ctx.restore()
}

export function renderStatusBadges(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  shouldDraw?: (chId: number) => boolean,
): void {
  ctx.save()
  for (const ch of characters) {
    if (ch.matrixEffect === 'despawn') continue
    if (shouldDraw && !shouldDraw(ch.id)) continue
    const isPermission = ch.bubbleType === 'permission'
    const icon = isPermission ? ICON_WAIT : ch.isActive ? ICON_ACTIVE : ICON_IDLE
    const sprite = isPermission ? SPRITE_WAIT : ch.isActive ? SPRITE_ACTIVE : SPRITE_IDLE
    const color = isPermission ? COLOR_WAIT : ch.isActive ? COLOR_ACTIVE : COLOR_IDLE
    const sittingOff = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
    const topY = ch.y + sittingOff - 24 - HEADPLATE_OFFSET_ABOVE_HEAD
    const leftX = ch.x + STATUS_LEFT_OFFSET
    const originX = offsetX / zoom + leftX
    const originY = offsetY / zoom + topY
    const frame = getResizedFrame()
    if (sprite && frame) {
      const badge = compositeFramedBadge(frame, sprite)
      drawSpriteIcon(ctx, badge, originX, originY, zoom)
    } else if (sprite) {
      drawSpriteIcon(ctx, sprite, originX, originY, zoom)
    } else {
      drawPixelIcon(ctx, icon, originX, originY, zoom, color)
    }
  }
  ctx.restore()
}

// ── Speech bubbles ──────────────────────────────────────────────

export function renderBubbles(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType) continue

    const sprite = ch.bubbleType === 'permission'
      ? BUBBLE_PERMISSION_SPRITE
      : BUBBLE_WAITING_SPRITE

    // Compute opacity: permission = full, waiting = fade in last 0.5s
    let alpha = 1.0
    if (ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
    }

    const cached = getCachedSprite(sprite, zoom)
    // Position: centered above the character's head
    // Character is anchored bottom-center at (ch.x, ch.y), sprite is 16x24
    // Place bubble above head with a small gap; follow sitting offset
    const sittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0
    const bubbleX = Math.round(offsetX + ch.x * zoom - cached.width / 2)
    const bubbleY = Math.round(offsetY + (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) * zoom - cached.height - 1 * zoom)

    ctx.save()
    if (alpha < 1.0) ctx.globalAlpha = alpha
    ctx.drawImage(cached, bubbleX, bubbleY)
    ctx.restore()
  }
}

export interface ButtonBounds {
  /** Center X in device pixels */
  cx: number
  /** Center Y in device pixels */
  cy: number
  /** Radius in device pixels */
  radius: number
}

export type DeleteButtonBounds = ButtonBounds
export type RotateButtonBounds = ButtonBounds

export interface EditorRenderState {
  showGrid: boolean
  ghostSprite: SpriteData | null
  ghostCol: number
  ghostRow: number
  ghostValid: boolean
  selectedCol: number
  selectedRow: number
  selectedW: number
  selectedH: number
  hasSelection: boolean
  isRotatable: boolean
  /** Updated each frame by renderDeleteButton */
  deleteButtonBounds: DeleteButtonBounds | null
  /** Updated each frame by renderRotateButton */
  rotateButtonBounds: RotateButtonBounds | null
  /** Whether to show ghost border (expansion tiles outside grid) */
  showGhostBorder: boolean
  /** Hovered ghost border tile col (-1 to cols) */
  ghostBorderHoverCol: number
  /** Hovered ghost border tile row (-1 to rows) */
  ghostBorderHoverRow: number
}

export interface SelectionRenderState {
  selectedAgentId: number | null
  hoveredAgentId: number | null
  hoveredTile: { col: number; row: number } | null
  seats: Map<string, Seat>
  characters: Map<number, Character>
}

/** Per-overlay "always-on" preferences mirrored from extension settings.
 *  Each element renders for every character when its flag is true; when
 *  false the element only appears for the currently hovered or selected
 *  character (so the canvas stays clean while still letting the user dig
 *  into a specific agent). */
export interface OverlayDefaults {
  identityDot: boolean
  tokenBar: boolean
  status: boolean
  tether: boolean
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selection?: SelectionRenderState,
  editor?: EditorRenderState,
  tileColors?: Array<FloorColor | null>,
  layoutCols?: number,
  layoutRows?: number,
  overlayDefaults?: OverlayDefaults,
): { offsetX: number; offsetY: number } {
  const overlays: OverlayDefaults = overlayDefaults ?? {
    identityDot: false,
    tokenBar: false,
    status: false,
    tether: false,
  }
  const focusId = selection?.selectedAgentId ?? selection?.hoveredAgentId ?? null
  /** Return true when this character should show a "non-default" overlay
   *  element: either the user toggled it always-on, or the character is
   *  currently the focus. For tether the rule is slightly broader (focus
   *  on EITHER endpoint surfaces the line). */
  const showFor = (chId: number, alwaysOn: boolean): boolean =>
    alwaysOn || (focusId !== null && focusId === chId)
  // Use layout dimensions (fallback to tileMap size)
  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0)
  const rows = layoutRows ?? tileMap.length

  // Clear
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)

  // Center map horizontally, top-align vertically + pan offset (integer device pixels)
  const mapW = cols * TILE_SIZE * zoom
  const offsetX = Math.floor((canvasWidth - mapW) / 2) + Math.round(panX)
  const offsetY = MAP_TOP_OFFSET_PX * zoom + Math.round(panY)

  // Draw tiles (floor + wall base color)
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols)

  // Seat indicators (below furniture/characters, on top of floor)
  if (selection) {
    renderSeatIndicators(ctx, selection.seats, selection.characters, selection.selectedAgentId, selection.hoveredTile, offsetX, offsetY, zoom)
  }

  // Parent → sub-agent tether lines — drawn on the floor, below sprites.
  // Toggle on → always; off → only when sub OR its parent is focused.
  renderParentTethers(ctx, characters, offsetX, offsetY, zoom,
    (subId, parentId) => overlays.tether || showFor(subId, false) || showFor(parentId, false),
  )

  // Build wall instances for z-sorting with furniture and characters
  const wallInstances = hasWallSprites()
    ? getWallInstances(tileMap, tileColors, layoutCols)
    : []
  const allFurniture = wallInstances.length > 0
    ? [...wallInstances, ...furniture]
    : furniture

  // Draw walls + furniture + characters (z-sorted)
  const selectedId = selection?.selectedAgentId ?? null
  const hoveredId = selection?.hoveredAgentId ?? null
  renderScene(ctx, allFurniture, characters, offsetX, offsetY, zoom, selectedId, hoveredId)

  // Speech bubbles disabled — per-character status is conveyed in the hover
  // overlay (see ToolOverlay.tsx). The pixel bubble sprites cluttered the head
  // area and duplicated information the popup already shows.
  void renderBubbles

  // Per-character head-area overlays. Each respects its always-on flag
  // (settings modal) and falls back to "only the hovered/selected agent
  // gets it" otherwise — that's the contract the user asked for so the
  // canvas is clean by default but a single hover still reveals everything.
  renderIdentityDots(ctx, characters, offsetX, offsetY, zoom,
    (chId) => showFor(chId, overlays.identityDot))
  renderHpBars(ctx, characters, offsetX, offsetY, zoom,
    (chId) => showFor(chId, overlays.tokenBar))
  renderStatusBadges(ctx, characters, offsetX, offsetY, zoom,
    (chId) => showFor(chId, overlays.status))

  // Editor overlays
  if (editor) {
    if (editor.showGrid) {
      renderGridOverlay(ctx, offsetX, offsetY, zoom, cols, rows, tileMap)
    }
    if (editor.showGhostBorder) {
      renderGhostBorder(ctx, offsetX, offsetY, zoom, cols, rows, editor.ghostBorderHoverCol, editor.ghostBorderHoverRow)
    }
    if (editor.ghostSprite && editor.ghostCol >= 0) {
      renderGhostPreview(ctx, editor.ghostSprite, editor.ghostCol, editor.ghostRow, editor.ghostValid, offsetX, offsetY, zoom)
    }
    if (editor.hasSelection) {
      renderSelectionHighlight(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      editor.deleteButtonBounds = renderDeleteButton(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      if (editor.isRotatable) {
        editor.rotateButtonBounds = renderRotateButton(ctx, editor.selectedCol, editor.selectedRow, editor.selectedW, editor.selectedH, offsetX, offsetY, zoom)
      } else {
        editor.rotateButtonBounds = null
      }
    } else {
      editor.deleteButtonBounds = null
      editor.rotateButtonBounds = null
    }
  }

  return { offsetX, offsetY }
}
