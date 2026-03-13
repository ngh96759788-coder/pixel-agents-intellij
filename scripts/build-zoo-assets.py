"""
Build zoo theme environment assets from Puny World Tileset (CC0).

All sprites are extracted directly from the source tileset — no procedural generation.
Colors are preserved from the original artist's work.

Source: Puny World Tileset (CC0, OpenGameArt)
  - Tilemap: 432×1040, 27×65 grid of 16×16 tiles (no gaps)

Output:
  - floors-zoo.png      (112×16, 7 colored floor patterns)
  - walls-zoo.png        (64×128, 4×4 auto-tile wooden fence)
  - furniture-zoo/       (PNGs + furniture-catalog.json)
  - default-layout-zoo.json

Usage: python3 scripts/build-zoo-assets.py
"""

import json
import os
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
ASSETS_DIR = os.path.join(PROJECT_DIR, 'webview-ui', 'public', 'assets')
SOURCE_DIR = os.path.join(SCRIPT_DIR, 'source-sprites')
FURNITURE_DIR = os.path.join(ASSETS_DIR, 'furniture-zoo')

PW_PATH = os.path.join(SOURCE_DIR, 'puny-world', 'punyworld-overworld-tileset.png')

TILE = 16


def pw(img, row, col):
    """Extract 16×16 tile from Puny World."""
    return img.crop((col * TILE, row * TILE, col * TILE + TILE, row * TILE + TILE))


def pw_block(img, row, col, w, h):
    """Extract w×h tiles as one image from Puny World."""
    return img.crop((col * TILE, row * TILE, (col + w) * TILE, (row + h) * TILE))


# ═══════════════════════════════════════════════════════════════
# FLOORS: 7 colored nature patterns (112×16)
# colorize=false in tileColors preserves original colors
# ═══════════════════════════════════════════════════════════════

def build_floors(src):
    out = Image.new('RGBA', (7 * TILE, TILE), (0, 0, 0, 0))

    # 0: Plain grass — solid green [0,0]
    out.paste(pw(src, 0, 0), (0, 0))

    # 1: Textured grass — grass with subtle variation [0,1]
    out.paste(pw(src, 0, 1), (TILE, 0))

    # 2: Dirt/sand — solid sandy-brown [1,8]
    out.paste(pw(src, 1, 8), (2 * TILE, 0))

    # 3: Grass-dirt mixed — natural transition feel [0,15]
    out.paste(pw(src, 0, 15), (3 * TILE, 0))

    # 4: Dark grass — textured darker shade [0,13]
    out.paste(pw(src, 0, 13), (4 * TILE, 0))

    # 5: Sandy variation [0,20]
    out.paste(pw(src, 0, 20), (5 * TILE, 0))

    # 6: Grass-sand blend [0,25]
    out.paste(pw(src, 0, 25), (6 * TILE, 0))

    return out


# ═══════════════════════════════════════════════════════════════
# WALLS: Wooden fence auto-tiles (64×128)
# Built from actual Puny World wooden building tiles
# ═══════════════════════════════════════════════════════════════

def build_walls(src):
    """Build 4×4 auto-tile grid from PW wooden fence/building tiles.

    Each piece is 16×32 (top=face above, bottom=base level).
    Bitmask: N=1, E=2, S=4, W=8.
    """
    W, H = 16, 32
    out = Image.new('RGBA', (4 * W, 4 * H), (0, 0, 0, 0))

    # Source wooden plank tile from PW row 28 (building walls)
    # [28,4] is a wooden plank wall section — good base
    plank = pw(src, 28, 5)  # Wooden building wall
    plank_top = pw(src, 28, 6)  # Top section of wooden wall

    # Build each bitmask variant
    for bitmask in range(16):
        has_n = bool(bitmask & 1)
        has_e = bool(bitmask & 2)
        has_s = bool(bitmask & 4)
        has_w = bool(bitmask & 8)

        piece = Image.new('RGBA', (W, H), (0, 0, 0, 0))

        # Face portion (top 16px): use wooden plank texture
        piece.paste(plank_top, (0, 0))
        # Base portion (bottom 16px): use plank
        piece.paste(plank, (0, 16))

        # Trim edges where there's no connection
        # (make the piece look like it connects only where neighbors exist)
        if not has_n:
            # Clear top 3px of face
            for y in range(3):
                for x in range(W):
                    piece.putpixel((x, y), (0, 0, 0, 0))
        if not has_s:
            # Clear bottom 3px of base
            for y in range(H - 3, H):
                for x in range(W):
                    piece.putpixel((x, y), (0, 0, 0, 0))
        if not has_w:
            # Clear left 3px
            for y in range(H):
                for x in range(3):
                    piece.putpixel((x, y), (0, 0, 0, 0))
        if not has_e:
            # Clear right 3px
            for y in range(H):
                for x in range(W - 3, W):
                    piece.putpixel((x, y), (0, 0, 0, 0))

        col = bitmask % 4
        row = bitmask // 4
        out.paste(piece, (col * W, row * H))

    return out


# ═══════════════════════════════════════════════════════════════
# FURNITURE: Real sprites from Puny World
# ═══════════════════════════════════════════════════════════════

def build_furniture(src):
    os.makedirs(FURNITURE_DIR, exist_ok=True)
    catalog = []

    def save(name, img):
        path = os.path.join(FURNITURE_DIR, f'{name}.png')
        img.save(path)
        return f'furniture-zoo/{name}.png'

    def add(entry_id, label, category, fp, w, h, fw, fh, **kw):
        e = {'id': entry_id, 'label': label, 'category': category,
             'file': fp, 'width': w, 'height': h,
             'footprintW': fw, 'footprintH': fh}
        e.update(kw)
        catalog.append(e)

    # ── Large deciduous tree (2×2 tiles from rows 4-5, cols 0-1) ──
    tree_big = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    tree_big.paste(pw(src, 4, 0), (0, 0))
    tree_big.paste(pw(src, 4, 1), (16, 0))
    tree_big.paste(pw(src, 5, 0), (0, 16))
    tree_big.paste(pw(src, 5, 1), (16, 16))
    fp = save('ZOO-TREE-OAK', tree_big)
    add('ZOO_TREE_OAK', 'Oak Tree', 'decor', fp, 32, 32, 2, 2,
        groupId='zoo_tree_oak', orientation='front', backgroundTiles=1)

    # ── Second deciduous tree (cols 5-7 area) ──
    tree2 = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    tree2.paste(pw(src, 4, 5), (0, 0))
    tree2.paste(pw(src, 4, 6), (16, 0))
    tree2.paste(pw(src, 5, 5), (0, 16))
    tree2.paste(pw(src, 5, 6), (16, 16))
    fp = save('ZOO-TREE-MAPLE', tree2)
    add('ZOO_TREE_MAPLE', 'Maple Tree', 'decor', fp, 32, 32, 2, 2,
        groupId='zoo_tree_maple', orientation='front', backgroundTiles=1)

    # ── Pine tree cluster (row 7 — conifer forest) ──
    # Single pine (1 tile wide, 2 tall using row 6+7)
    pine = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    pine.paste(pw(src, 6, 12), (0, 0))   # top canopy
    pine.paste(pw(src, 7, 12), (0, 16))   # trunk/base
    fp = save('ZOO-PINE', pine)
    add('ZOO_PINE', 'Pine Tree', 'decor', fp, 16, 32, 1, 1,
        groupId='zoo_pine', orientation='front', backgroundTiles=1)

    # Pine forest cluster (2×2 from row 7 area)
    pine_cluster = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    pine_cluster.paste(pw(src, 6, 3), (0, 0))
    pine_cluster.paste(pw(src, 6, 4), (16, 0))
    pine_cluster.paste(pw(src, 7, 3), (0, 16))
    pine_cluster.paste(pw(src, 7, 4), (16, 16))
    fp = save('ZOO-PINE-CLUSTER', pine_cluster)
    add('ZOO_PINE_CLUSTER', 'Pine Cluster', 'decor', fp, 32, 32, 2, 2,
        groupId='zoo_pine_cluster', orientation='front', backgroundTiles=1)

    # ── Palm tree (row 28, cols 0-1 + row 29 cols 0-1) ──
    palm = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    palm.paste(pw(src, 28, 0), (0, 0))
    palm.paste(pw(src, 29, 0), (0, 16))
    fp = save('ZOO-PALM', palm)
    add('ZOO_PALM', 'Palm Tree', 'decor', fp, 16, 32, 1, 1,
        groupId='zoo_palm', orientation='front', backgroundTiles=1)

    # ── Small pine tree (row 30, col 0) ──
    small_pine = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    small_pine.paste(pw(src, 30, 0), (0, 16))  # Bottom-aligned
    fp = save('ZOO-SMALL-PINE', small_pine)
    add('ZOO_SMALL_PINE', 'Small Pine', 'decor', fp, 16, 32, 1, 1)

    # ── Bush/hedge (row 6 has hedge tiles) ──
    bush = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    bush.paste(pw(src, 6, 0), (0, 16))
    fp = save('ZOO-BUSH', bush)
    add('ZOO_BUSH', 'Bush', 'decor', fp, 16, 32, 1, 1)

    # Large hedge (2-wide)
    hedge = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    hedge.paste(pw(src, 6, 0), (0, 16))
    hedge.paste(pw(src, 6, 1), (16, 16))
    fp = save('ZOO-HEDGE', hedge)
    add('ZOO_HEDGE', 'Hedge', 'decor', fp, 32, 32, 2, 1)

    # ── Mushroom (row 30, col 1) ──
    mushroom = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    mushroom.paste(pw(src, 30, 1), (0, 16))
    fp = save('ZOO-MUSHROOM', mushroom)
    add('ZOO_MUSHROOM', 'Mushroom', 'decor', fp, 16, 32, 1, 1)

    # ── Well (row 29, col 2 — stone well) ──
    well = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    well.paste(pw(src, 29, 2), (0, 16))
    fp = save('ZOO-WELL', well)
    add('ZOO_WELL', 'Stone Well', 'decor', fp, 16, 32, 1, 1)

    # ── Wooden barrel (row 30, col 10-11) ──
    barrel = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    barrel.paste(pw(src, 30, 10), (0, 16))
    fp = save('ZOO-BARREL', barrel)
    add('ZOO_BARREL', 'Barrel', 'decor', fp, 16, 32, 1, 1)

    # Large barrel (row 30, col 12)
    big_barrel = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    big_barrel.paste(pw(src, 30, 12), (0, 16))
    fp = save('ZOO-BARREL-LARGE', big_barrel)
    add('ZOO_BARREL_LARGE', 'Large Barrel', 'decor', fp, 16, 32, 1, 1)

    # ── Sign posts (row 30, cols 6-9) ──
    sign1 = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    sign1.paste(pw(src, 30, 6), (0, 16))
    fp = save('ZOO-SIGN', sign1)
    add('ZOO_SIGN', 'Sign Post', 'decor', fp, 16, 32, 1, 1)

    sign2 = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    sign2.paste(pw(src, 30, 7), (0, 16))
    fp = save('ZOO-SIGN-ALT', sign2)
    add('ZOO_SIGN_ALT', 'Sign Post Alt', 'decor', fp, 16, 32, 1, 1)

    # ── Well with gem/water (row 30, col 13) ──
    well2 = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    well2.paste(pw(src, 30, 13), (0, 16))
    fp = save('ZOO-FOUNTAIN', well2)
    add('ZOO_FOUNTAIN', 'Fountain', 'decor', fp, 16, 32, 1, 1)

    # ── Mining cart (row 30, col 4-5) — can serve as feed cart ──
    cart = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    cart.paste(pw(src, 30, 4), (0, 16))
    fp = save('ZOO-CART', cart)
    add('ZOO_CART', 'Feed Cart', 'decor', fp, 16, 32, 1, 1)

    # ── Wooden table/desk (row 29 area — workstation equivalent) ──
    # Wooden building section serves as a desk (2-wide)
    desk = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    desk.paste(pw(src, 29, 4), (0, 16))
    desk.paste(pw(src, 29, 5), (16, 16))
    fp = save('ZOO-TABLE-FRONT', desk)
    add('ZOO_TABLE_FRONT', 'Wooden Table', 'desks', fp, 32, 32, 2, 1,
        isDesk=True, groupId='zoo_table', orientation='front')

    desk_back = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    desk_back.paste(pw(src, 28, 4), (0, 8))
    desk_back.paste(pw(src, 28, 5), (16, 8))
    fp = save('ZOO-TABLE-BACK', desk_back)
    add('ZOO_TABLE_BACK', 'Wooden Table Back', 'desks', fp, 32, 32, 2, 1,
        isDesk=True, groupId='zoo_table', orientation='back', backgroundTiles=1)

    # ── Chair / stump (small wooden structure from PW) ──
    stump = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    stump.paste(pw(src, 29, 3), (0, 16))
    fp = save('ZOO-STUMP-FRONT', stump)
    add('ZOO_STUMP_FRONT', 'Log Seat', 'chairs', fp, 16, 32, 1, 1,
        groupId='zoo_stump', orientation='front')

    stump_back = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    stump_back.paste(pw(src, 29, 3), (0, 8))
    fp = save('ZOO-STUMP-BACK', stump_back)
    add('ZOO_STUMP_BACK', 'Log Seat Back', 'chairs', fp, 16, 32, 1, 1,
        groupId='zoo_stump', orientation='back')

    # ── Fence segments (from PW wooden building edges) ──
    fence_h = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    fence_h.paste(pw(src, 29, 25), (0, 16))
    fence_h.paste(pw(src, 29, 26), (16, 16))
    fp = save('ZOO-FENCE-FRONT', fence_h)
    add('ZOO_FENCE_FRONT', 'Fence', 'decor', fp, 32, 32, 2, 1,
        groupId='zoo_fence', orientation='front')

    fence_v = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    fence_v.paste(pw(src, 28, 25), (0, 0))
    fence_v.paste(pw(src, 29, 25), (0, 16))
    fp = save('ZOO-FENCE-LEFT', fence_v)
    add('ZOO_FENCE_LEFT', 'Fence Side', 'decor', fp, 16, 32, 1, 1,
        groupId='zoo_fence', orientation='left')

    # ── Stone structure (row 29, cols 14-15) ──
    stone = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    stone.paste(pw(src, 29, 14), (0, 16))
    stone.paste(pw(src, 29, 15), (16, 16))
    fp = save('ZOO-STONE-WALL', stone)
    add('ZOO_STONE_WALL', 'Stone Wall', 'decor', fp, 32, 32, 2, 1)

    # ── Wooden cabin (4×2 from building area) ──
    cabin = Image.new('RGBA', (64, 32), (0, 0, 0, 0))
    for c in range(4):
        cabin.paste(pw(src, 28, 7 + c), (c * 16, 0))
        cabin.paste(pw(src, 29, 7 + c), (c * 16, 16))
    fp = save('ZOO-CABIN', cabin)
    add('ZOO_CABIN', 'Wooden Cabin', 'storage', fp, 64, 32, 4, 2,
        groupId='zoo_cabin', orientation='front', backgroundTiles=1)

    # ── Stone cabin (from stone section) ──
    stone_cabin = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    for c in range(3):
        stone_cabin.paste(pw(src, 28, 14 + c), (c * 16, 0))
        stone_cabin.paste(pw(src, 29, 14 + c), (c * 16, 16))
    fp = save('ZOO-STONE-CABIN', stone_cabin)
    add('ZOO_STONE_CABIN', 'Stone Cabin', 'storage', fp, 48, 32, 3, 2,
        groupId='zoo_stone_cabin', orientation='front', backgroundTiles=1)

    # ── Water pond (assembled from water edge tiles) ──
    # Use actual water tiles from PW rows 10-11
    pond = Image.new('RGBA', (48, 48), (0, 0, 0, 0))
    # Top edge
    pond.paste(pw(src, 10, 0), (0, 0))
    pond.paste(pw(src, 10, 1), (16, 0))
    pond.paste(pw(src, 10, 2), (32, 0))
    # Middle (water body)
    pond.paste(pw(src, 11, 0), (0, 16))
    pond.paste(pw(src, 11, 8), (16, 16))  # Solid water center
    pond.paste(pw(src, 11, 2), (32, 16))
    # Bottom edge
    pond.paste(pw(src, 12, 0), (0, 32))
    pond.paste(pw(src, 12, 1), (16, 32))
    pond.paste(pw(src, 12, 2), (32, 32))
    fp = save('ZOO-POND', pond)
    add('ZOO_POND', 'Pond', 'decor', fp, 48, 48, 3, 3)

    # ── Flower patch (grass with decoration from row 0 area) ──
    flowers = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    flowers.paste(pw(src, 0, 6), (0, 16))  # Grass-dirt decorative tile
    fp = save('ZOO-FLOWERS', flowers)
    add('ZOO_FLOWERS', 'Flower Patch', 'decor', fp, 16, 32, 1, 1)

    # ── Gate (wide opening from wooden building tops) ──
    gate = Image.new('RGBA', (48, 32), (0, 0, 0, 0))
    gate.paste(pw(src, 28, 11), (0, 0))
    gate.paste(pw(src, 28, 12), (16, 0))
    gate.paste(pw(src, 28, 11), (32, 0))
    gate.paste(pw(src, 29, 11), (0, 16))
    # Middle is open (transparent = gate opening)
    gate.paste(pw(src, 29, 12), (32, 16))
    fp = save('ZOO-GATE', gate)
    add('ZOO_GATE', 'Zoo Gate', 'decor', fp, 48, 32, 3, 1, backgroundTiles=1)

    # Write catalog
    with open(os.path.join(FURNITURE_DIR, 'furniture-catalog.json'), 'w') as f:
        json.dump({'assets': catalog}, f, indent=2)

    return catalog


# ═══════════════════════════════════════════════════════════════
# DEFAULT LAYOUT
# ═══════════════════════════════════════════════════════════════

def build_layout():
    COLS, ROWS = 22, 15
    VOID, WALL = 0, 8
    # Floor patterns 1-7 map to floors-zoo.png indices 0-6
    GRASS1 = 1   # Plain grass
    GRASS2 = 2   # Textured grass
    DIRT = 3     # Dirt/sand
    MIX = 4      # Grass-dirt mixed
    DARK = 5     # Dark grass
    SAND = 6     # Sandy
    BLEND = 7    # Grass-sand blend

    tiles = [VOID] * (COLS * ROWS)

    def fill(r1, c1, r2, c2, t):
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                if 0 <= r < ROWS and 0 <= c < COLS:
                    tiles[r * COLS + c] = t

    def border(r1, c1, r2, c2, t):
        for c in range(c1, c2 + 1):
            tiles[r1 * COLS + c] = t
            tiles[r2 * COLS + c] = t
        for r in range(r1, r2 + 1):
            tiles[r * COLS + c1] = t
            tiles[r * COLS + c2] = t

    # Main grass area
    fill(0, 0, ROWS - 1, COLS - 1, GRASS1)

    # Outer fence
    border(0, 0, ROWS - 1, COLS - 1, WALL)

    # Central stone path (horizontal)
    fill(7, 1, 7, COLS - 2, DIRT)

    # Vertical paths
    fill(1, 10, ROWS - 2, 11, DIRT)

    # Entrances (break fence)
    tiles[0 * COLS + 10] = DIRT; tiles[0 * COLS + 11] = DIRT
    tiles[(ROWS-1) * COLS + 10] = DIRT; tiles[(ROWS-1) * COLS + 11] = DIRT
    tiles[7 * COLS + 0] = DIRT; tiles[7 * COLS + (COLS-1)] = DIRT

    # Left enclosures - textured grass
    fill(1, 1, 6, 9, GRASS2)
    fill(8, 1, ROWS - 2, 9, GRASS2)

    # Right enclosures - also textured
    fill(1, 12, 6, COLS - 2, GRASS2)
    fill(8, 12, ROWS - 2, COLS - 2, GRASS2)

    # Dirt patches inside enclosures
    fill(2, 2, 4, 5, MIX)
    fill(9, 2, 11, 5, SAND)
    fill(2, 15, 4, 18, DARK)
    fill(9, 15, 11, 18, BLEND)

    # Inner fences (enclosure dividers)
    for c in range(1, 10):
        tiles[6 * COLS + c] = WALL
    for c in range(12, COLS - 1):
        tiles[6 * COLS + c] = WALL

    # Openings in inner fences
    tiles[6 * COLS + 5] = DIRT
    tiles[6 * COLS + 6] = DIRT
    tiles[6 * COLS + 15] = DIRT
    tiles[6 * COLS + 16] = DIRT

    # Tile colors: colorize=false with neutral values (preserves original Puny World colors)
    preserve = {"h": 0, "s": 0, "b": 0, "c": 0, "colorize": False}
    wall_color = {"h": 30, "s": 40, "b": -5, "c": 10, "colorize": True}

    tile_colors = []
    for t in tiles:
        if t == WALL:
            tile_colors.append(wall_color)
        elif t == VOID:
            tile_colors.append(None)
        else:
            tile_colors.append(preserve)

    # Furniture
    furniture = []
    uid = [0]
    def add_f(ftype, row, col, **kw):
        uid[0] += 1
        f = {"type": ftype, "row": row, "col": col, "uid": f"z-{uid[0]}"}
        f.update(kw)
        furniture.append(f)

    # Trees (decorative, along paths and edges)
    add_f("ZOO_TREE_OAK", 1, 1)
    add_f("ZOO_TREE_OAK", 8, 1)
    add_f("ZOO_TREE_MAPLE", 1, 19)
    add_f("ZOO_TREE_MAPLE", 8, 19)
    add_f("ZOO_PINE", 3, 8)
    add_f("ZOO_PINE", 10, 8)
    add_f("ZOO_PINE", 3, 13)
    add_f("ZOO_PINE", 10, 13)

    # Pine clusters
    add_f("ZOO_PINE_CLUSTER", 1, 7)
    add_f("ZOO_PINE_CLUSTER", 11, 19)

    # Palms
    add_f("ZOO_PALM", 1, 12)
    add_f("ZOO_PALM", 8, 12)

    # Bushes and hedges
    add_f("ZOO_BUSH", 5, 1)
    add_f("ZOO_BUSH", 5, 9)
    add_f("ZOO_BUSH", 12, 1)
    add_f("ZOO_BUSH", 12, 9)
    add_f("ZOO_HEDGE", 5, 12)

    # Tables (desks for agents)
    add_f("ZOO_TABLE_FRONT", 3, 3)
    add_f("ZOO_TABLE_FRONT", 10, 3)
    add_f("ZOO_TABLE_FRONT", 3, 16)
    add_f("ZOO_TABLE_FRONT", 10, 16)

    # Seats (chairs for agents) — 6 seats total
    add_f("ZOO_STUMP_FRONT", 4, 3)
    add_f("ZOO_STUMP_FRONT", 4, 4)
    add_f("ZOO_STUMP_FRONT", 11, 3)
    add_f("ZOO_STUMP_FRONT", 11, 4)
    add_f("ZOO_STUMP_FRONT", 4, 16)
    add_f("ZOO_STUMP_FRONT", 4, 17)

    # Signs
    add_f("ZOO_SIGN", 6, 4)
    add_f("ZOO_SIGN_ALT", 6, 14)

    # Barrels and carts
    add_f("ZOO_BARREL", 2, 6)
    add_f("ZOO_BARREL_LARGE", 9, 6)
    add_f("ZOO_CART", 9, 18)

    # Well and fountain
    add_f("ZOO_WELL", 5, 20)
    add_f("ZOO_FOUNTAIN", 12, 20)

    # Mushrooms
    add_f("ZOO_MUSHROOM", 2, 9)
    add_f("ZOO_MUSHROOM", 11, 9)

    # Stone walls and fences
    add_f("ZOO_STONE_WALL", 8, 14)
    add_f("ZOO_FENCE_FRONT", 5, 3)

    # Flowers
    add_f("ZOO_FLOWERS", 1, 5)
    add_f("ZOO_FLOWERS", 8, 5)

    # Small pines
    add_f("ZOO_SMALL_PINE", 1, 14)
    add_f("ZOO_SMALL_PINE", 12, 14)

    return {
        "version": 1,
        "cols": COLS,
        "rows": ROWS,
        "tiles": tiles,
        "furniture": furniture,
        "tileColors": tile_colors,
    }


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    if not os.path.exists(PW_PATH):
        print(f"ERROR: Missing {PW_PATH}")
        return

    src = Image.open(PW_PATH).convert('RGBA')
    print(f"Puny World: {src.size}")

    # Floors
    print("\n── floors-zoo.png ──")
    floors = build_floors(src)
    floors.save(os.path.join(ASSETS_DIR, 'floors-zoo.png'))
    print(f"  ✓ {floors.size[0]}×{floors.size[1]} (7 colored patterns)")

    # Walls
    print("\n── walls-zoo.png ──")
    walls = build_walls(src)
    walls.save(os.path.join(ASSETS_DIR, 'walls-zoo.png'))
    print(f"  ✓ {walls.size[0]}×{walls.size[1]} (16 auto-tile variants)")

    # Furniture
    print("\n── furniture-zoo/ ──")
    catalog = build_furniture(src)
    print(f"  ✓ {len(catalog)} items")
    for item in catalog:
        print(f"    {item['id']}: {item['label']} [{item['category']}]")

    # Layout
    print("\n── default-layout-zoo.json ──")
    layout = build_layout()
    out = os.path.join(ASSETS_DIR, 'default-layout-zoo.json')
    with open(out, 'w') as f:
        json.dump(layout, f, indent=2)
    print(f"  ✓ {layout['cols']}×{layout['rows']} grid, {len(layout['furniture'])} furniture items")

    print("\n✓ Done! Credits: Puny World Tileset (CC0, OpenGameArt)")


if __name__ == '__main__':
    main()
