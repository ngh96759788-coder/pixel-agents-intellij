export {
  TILE_SIZE,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
} from '../constants.js'

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  VOID: 8,
} as const
export type TileType = (typeof TileType)[keyof typeof TileType]

/** Per-tile color settings for floor pattern colorization */
export interface FloorColor {
  /** Hue: 0-360 in colorize mode, -180 to +180 in adjust mode */
  h: number
  /** Saturation: 0-100 in colorize mode, -100 to +100 in adjust mode */
  s: number
  /** Brightness -100 to 100 */
  b: number
  /** Contrast -100 to 100 */
  c: number
  /** When true, use Photoshop-style Colorize (grayscale → fixed HSL). Default: adjust mode. */
  colorize?: boolean
}

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
} as const
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState]

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const
export type Direction = (typeof Direction)[keyof typeof Direction]

/** 2D array of hex color strings (or '' for transparent). [row][col] */
export type SpriteData = string[][]

export interface Seat {
  /** Chair furniture uid */
  uid: string
  /** Tile col where agent sits */
  seatCol: number
  /** Tile row where agent sits */
  seatRow: number
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction
  assigned: boolean
}

export interface FurnitureInstance {
  sprite: SpriteData
  /** Pixel x (top-left) */
  x: number
  /** Pixel y (top-left) */
  y: number
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number
}

export interface ToolActivity {
  toolId: string
  status: string
  done: boolean
  permissionWait?: boolean
  /** output_tokens of the assistant turn that emitted this tool_use, when available.
   *  Approximates the model-side cost of *deciding to make this call* (not the tool's
   *  return payload). Multiple tool_uses in one turn share this delta. */
  outputTokens?: number
  /** Date.now() when the tool started, used for elapsed-time display. */
  startedAt?: number
}

export const FurnitureType = {
  // Original hand-drawn sprites (kept for backward compat)
  DESK: 'desk',
  BOOKSHELF: 'bookshelf',
  PLANT: 'plant',
  COOLER: 'cooler',
  WHITEBOARD: 'whiteboard',
  CHAIR: 'chair',
  PC: 'pc',
  LAMP: 'lamp',
} as const
export type FurnitureType = (typeof FurnitureType)[keyof typeof FurnitureType]

export const EditTool = {
  TILE_PAINT: 'tile_paint',
  WALL_PAINT: 'wall_paint',
  FURNITURE_PLACE: 'furniture_place',
  FURNITURE_PICK: 'furniture_pick',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
  ERASE: 'erase',
} as const
export type EditTool = (typeof EditTool)[keyof typeof EditTool]

export interface FurnitureCatalogEntry {
  type: string // FurnitureType enum or asset ID
  label: string
  footprintW: number
  footprintH: number
  sprite: SpriteData
  isDesk: boolean
  category?: string
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number
  /** Pixel offset for rendering (negative = up). Shifts sprite visually without changing footprint or depth sort. */
  renderOffsetY?: number
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean
  /** Optional z-sort offset added to the computed zY. Positive values push the
   *  sprite IN FRONT of other entities at the same row (e.g. a panel that the
   *  character should appear to be *operating* — character renders behind the
   *  panel face). Negative values push it BEHIND (e.g. background fixtures). */
  zSortBoost?: number
  /** Whether this furniture auto-animates (periodic state toggle) */
  autoAnimate?: boolean
  /** Animation interval in seconds (default from constants) */
  animIntervalSec?: number
  /** Ordered list of type IDs forming the animation loop (ping-pong or cyclic) */
  animSequence?: string[]
}

export interface PlacedFurniture {
  uid: string
  type: string // FurnitureType enum or asset ID
  col: number
  row: number
  /** Optional color override for furniture */
  color?: FloorColor
  /** Optional explicit facing direction for chairs — overrides both the
   *  adjacent-desk heuristic and the chair's catalog orientation. Use when
   *  the visual you want disagrees with the auto-derived facing (e.g. a
   *  character at a console who should face the camera even though the desk
   *  sits north of them). One of 'up' | 'down' | 'left' | 'right'. */
  facing?: string
}

export interface OfficeLayout {
  version: 1
  cols: number
  rows: number
  tiles: TileType[]
  furniture: PlacedFurniture[]
  /** Per-tile color settings, parallel to tiles array. null = wall/no color */
  tileColors?: Array<FloorColor | null>
}

export interface Character {
  id: number
  state: CharacterState
  dir: Direction
  /** Pixel position */
  x: number
  y: number
  /** Current tile column */
  tileCol: number
  /** Current tile row */
  tileRow: number
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null
  /** Palette index (0-5) */
  palette: number
  /** Hue shift in degrees (0 = no shift, ≥45 for repeated palettes) */
  hueShift: number
  /** Animation frame index */
  frame: number
  /** Time accumulator for animation */
  frameTimer: number
  /** Timer for idle wander decisions */
  wanderTimer: number
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number
  /** Whether the agent is actively working */
  isActive: boolean
  /** Assigned seat uid, or null if no seat */
  seatId: string | null
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | null
  /** Countdown timer for bubble (waiting: 2→0, permission: unused) */
  bubbleTimer: number
  /** Timer to stay seated while inactive after seat reassignment (counts down to 0) */
  seatTimer: number
  /** Whether this character represents a sub-agent (spawned by Task tool) */
  isSubagent: boolean
  /** True for sessions adopted from disk (started outside this IDE — e.g. another
   *  IntelliJ window on the same project). Renderer fades the sprite, ToolOverlay
   *  draws a corner badge. */
  isExternal: boolean
  /** Whether this sub-agent has completed its work (Task tool returned result) */
  isCompleted: boolean
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null
  /** Cumulative idle time in seconds — triggers despawn when exceeding threshold */
  idleTimer: number
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: 'spawn' | 'despawn' | null
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[]
  /** Last reported prompt-side context token count (input + cache_create +
   *  cache_read). Drives the always-on HP bar above the character. -1 means
   *  no data yet → bar is hidden. Sub-agents inherit zero since their tokens
   *  are not separately tracked. */
  contextTokens: number
  /** performance.now() timestamp of the last contextTokens update. The HP-bar
   *  fades out after a short quiet period so an idle character isn't perma-
   *  stamped with a stale value. 0 = never updated. */
  contextTokensUpdatedAt: number
  /** Last reported model id (e.g. "claude-opus-4-7"). Drives the HP-bar
   *  scale via `contextWindowFor()` — Opus 4.x uses a 1M window, others
   *  default to 200K. Undefined when no usage event has resolved the
   *  model yet (bar falls back to 200K cap). */
  model?: string
}
