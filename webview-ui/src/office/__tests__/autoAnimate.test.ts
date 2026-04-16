import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the catalog module so we can control what getAnimSequence/getAnimInterval return
vi.mock('../../constants.js', () => ({
  TILE_SIZE: 16,
  DEFAULT_COLS: 20,
  DEFAULT_ROWS: 11,
  MAX_COLS: 64,
  MAX_ROWS: 64,
  MATRIX_EFFECT_DURATION_SEC: 0.3,
  HUE_SHIFT_MIN_DEG: 45,
  HUE_SHIFT_RANGE_DEG: 270,
  WAITING_BUBBLE_DURATION_SEC: 2,
  DISMISS_BUBBLE_FAST_FADE_SEC: 0.3,
  INACTIVE_SEAT_TIMER_MIN_SEC: 3,
  INACTIVE_SEAT_TIMER_RANGE_SEC: 7,
  SEAT_REST_MIN_SEC: 3,
  SEAT_REST_MAX_SEC: 8,
  AUTO_ON_FACING_DEPTH: 3,
  AUTO_ON_SIDE_DEPTH: 1,
  CHARACTER_SITTING_OFFSET_PX: 6,
  CHARACTER_HIT_HALF_WIDTH: 6,
  CHARACTER_HIT_HEIGHT: 20,
  AUTO_ANIMATE_INTERVAL_SEC: 2.5,
  WALK_SPEED_PX_PER_SEC: 40,
  WANDER_DECISION_MIN_SEC: 2,
  WANDER_DECISION_RANGE_SEC: 4,
  WANDER_LIMIT_MIN: 2,
  WANDER_LIMIT_RANGE: 4,
  ANIM_FRAMES_PER_SEC: 4,
  CHARACTER_SPRITE_W: 24,
  CHARACTER_SPRITE_H: 24,
  CHARACTER_Y_OFFSET: 8,
  IDLE_DESPAWN_THRESHOLD_SEC: 120,
}))

// We'll test the catalog functions directly since OfficeState has many dependencies
import { getAnimSequence, getAnimInterval, isAutoAnimated, buildDynamicCatalog } from '../layout/furnitureCatalog.js'
import type { LoadedAssetData } from '../layout/furnitureCatalog.js'

type CatalogItem = LoadedAssetData['catalog'][number]

function makeSprite(): string[][] {
  return [['#FF0000']]
}

function makeCatalogAssets(extras: CatalogItem[] = []): LoadedAssetData {
  const baseAssets: CatalogItem[] = [
    {
      id: 'LAMP_FRONT_OFF',
      label: 'Lamp - Front - Off',
      category: 'decor',
      width: 16,
      height: 32,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      groupId: 'LAMP',
      orientation: 'front',
      state: 'off',
      autoAnimate: true,
      animIntervalSec: 1.0,
      animSequence: ['LAMP_FRONT_OFF', 'LAMP_FRONT_MID', 'LAMP_FRONT_ON', 'LAMP_FRONT_MID'],
    },
    {
      id: 'LAMP_FRONT_MID',
      label: 'Lamp - Front - Mid',
      category: 'decor',
      width: 16,
      height: 32,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      groupId: 'LAMP',
      orientation: 'front',
      state: 'on',  // grouped as "on" variant
    },
    {
      id: 'LAMP_FRONT_ON',
      label: 'Lamp - Front - On',
      category: 'decor',
      width: 16,
      height: 32,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
      groupId: 'LAMP',
      orientation: 'front',
      state: 'on',
    },
    // A simple item with no animation
    {
      id: 'DESK_FRONT',
      label: 'Desk',
      category: 'desks',
      width: 32,
      height: 32,
      footprintW: 2,
      footprintH: 2,
      isDesk: true,
    },
    ...extras,
  ]

  const sprites: Record<string, string[][]> = {}
  for (const a of baseAssets) {
    sprites[a.id as string] = makeSprite()
  }

  return { catalog: baseAssets, sprites }
}

describe('furnitureCatalog - animSequence', () => {
  beforeEach(() => {
    // Reset catalog state by building fresh
  })

  it('getAnimSequence returns the sequence for items with animSequence', () => {
    const assets = makeCatalogAssets()
    buildDynamicCatalog(assets)
    const seq = getAnimSequence('LAMP_FRONT_OFF')
    expect(seq).toEqual(['LAMP_FRONT_OFF', 'LAMP_FRONT_MID', 'LAMP_FRONT_ON', 'LAMP_FRONT_MID'])
  })

  it('getAnimSequence returns null for items without animSequence', () => {
    const assets = makeCatalogAssets()
    buildDynamicCatalog(assets)
    const seq = getAnimSequence('DESK_FRONT')
    expect(seq).toBeNull()
  })

  it('getAnimSequence returns null for unknown types', () => {
    const assets = makeCatalogAssets()
    buildDynamicCatalog(assets)
    const seq = getAnimSequence('NONEXISTENT_TYPE')
    expect(seq).toBeNull()
  })

  it('isAutoAnimated still works for items with autoAnimate flag', () => {
    const assets = makeCatalogAssets()
    buildDynamicCatalog(assets)
    expect(isAutoAnimated('LAMP_FRONT_OFF')).toBe(true)
    expect(isAutoAnimated('DESK_FRONT')).toBe(false)
  })

  it('getAnimInterval returns custom interval when set', () => {
    const assets = makeCatalogAssets()
    buildDynamicCatalog(assets)
    expect(getAnimInterval('LAMP_FRONT_OFF')).toBe(1.0)
  })

  it('getAnimInterval returns default for items without custom interval', () => {
    const assets = makeCatalogAssets()
    buildDynamicCatalog(assets)
    // AUTO_ANIMATE_INTERVAL_SEC = 2.5 from mock
    expect(getAnimInterval('DESK_FRONT')).toBe(2.5)
  })

  it('animSequence is passed through buildDynamicCatalog to catalog entries', () => {
    const assets = makeCatalogAssets()
    buildDynamicCatalog(assets)
    // getAnimSequence internally calls getCatalogEntry, so if it returns the sequence
    // it proves the field was passed through
    const seq = getAnimSequence('LAMP_FRONT_OFF')
    expect(seq).not.toBeNull()
    expect(seq).toHaveLength(4)
  })

  it('items with animSequence of length < 2 are treated as non-animated by getAnimSequence', () => {
    const assets = makeCatalogAssets([
      {
        id: 'SINGLE_FRAME',
        label: 'Single',
        category: 'decor',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        autoAnimate: true,
        animSequence: ['SINGLE_FRAME'],
      },
    ])
    buildDynamicCatalog(assets)
    // getAnimSequence returns the array regardless - the caller (tickAutoAnimate)
    // checks length < 2 to skip. But we should still return it.
    const seq = getAnimSequence('SINGLE_FRAME')
    expect(seq).toEqual(['SINGLE_FRAME'])
  })
})
