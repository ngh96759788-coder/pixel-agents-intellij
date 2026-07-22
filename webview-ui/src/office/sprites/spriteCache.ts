import type { SpriteData } from '../types.js'

// LRU on zoom-level keys so users who toggle through many zooms (or
// trigger a DPR-driven zoom shift on display change) don't accumulate
// canvas sets indefinitely. Sprite-level eviction is already automatic
// via the inner WeakMap.
const MAX_ZOOM_CACHES = 3
const zoomCaches = new Map<number, WeakMap<SpriteData, HTMLCanvasElement>>()

// ── Outline sprite generation ─────────────────────────────────

const outlineCache = new WeakMap<SpriteData, SpriteData>()

/** Generate a 1px white outline SpriteData (2px larger in each dimension) */
export function getOutlineSprite(sprite: SpriteData): SpriteData {
  const cached = outlineCache.get(sprite)
  if (cached) return cached

  const rows = sprite.length
  const cols = sprite[0].length
  // Expanded grid: +2 in each dimension for 1px border
  const outline: string[][] = []
  for (let r = 0; r < rows + 2; r++) {
    outline.push(new Array<string>(cols + 2).fill(''))
  }

  // For each opaque pixel, mark its 4 cardinal neighbors as white
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] === '') continue
      const er = r + 1
      const ec = c + 1
      if (outline[er - 1][ec] === '') outline[er - 1][ec] = '#FFFFFF'
      if (outline[er + 1][ec] === '') outline[er + 1][ec] = '#FFFFFF'
      if (outline[er][ec - 1] === '') outline[er][ec - 1] = '#FFFFFF'
      if (outline[er][ec + 1] === '') outline[er][ec + 1] = '#FFFFFF'
    }
  }

  // Clear pixels that overlap with original opaque pixels
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c] !== '') {
        outline[r + 1][c + 1] = ''
      }
    }
  }

  outlineCache.set(sprite, outline)
  return outline
}

export function getCachedSprite(sprite: SpriteData, zoom: number): HTMLCanvasElement {
  let cache = zoomCaches.get(zoom)
  if (!cache) {
    cache = new WeakMap()
    zoomCaches.set(zoom, cache)
    // Evict oldest zoom keys when over the cap. Map preserves insertion
    // order so the first key is the least-recently-added.
    while (zoomCaches.size > MAX_ZOOM_CACHES) {
      const oldest = zoomCaches.keys().next().value
      if (oldest === undefined) break
      zoomCaches.delete(oldest)
    }
  } else {
    // Bump this zoom key to "most recently used" by re-inserting it.
    zoomCaches.delete(zoom)
    zoomCaches.set(zoom, cache)
  }

  const cached = cache.get(sprite)
  if (cached) return cached

  const rows = sprite.length
  const cols = sprite[0].length
  const canvas = document.createElement('canvas')
  canvas.width = cols * zoom
  canvas.height = rows * zoom
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = sprite[r][c]
      if (color === '') continue
      ctx.fillStyle = color
      ctx.fillRect(c * zoom, r * zoom, zoom, zoom)
    }
  }

  cache.set(sprite, canvas)
  return canvas
}

/** Drop every cached canvas. Called on display-change events (DPR
 *  shifts under the same logical zoom level produce wrong-size
 *  canvases otherwise) and after a JCEF context restore. */
export function clearSpriteCache(): void {
  zoomCaches.clear()
}
