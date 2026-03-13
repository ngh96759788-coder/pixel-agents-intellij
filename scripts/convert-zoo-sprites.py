"""
Build 6 zoo animal character PNGs from Tiny Creatures (CC0, Kenney/clintbellanger).

  char_0: Lion     — [15,6] golden, front-facing
  char_1: Giraffe  — [15,9] front-facing, tallest
  char_2: Bear     — [16,3] brown, stocky front-facing
  char_3: Penguin  — [17,9] front-facing, distinctive
  char_4: Gorilla  — [16,6] dark, front-facing
  char_5: Tiger    — [15,7] orange striped, front-facing

Source: Tiny Creatures tileset (16x16, CC0)
  Tilemap: 170x306, 10x18 grid, stride 17px (16px tile + 1px gap)

Output: webview-ui/public/assets/characters-zoo/char_0.png ~ char_5.png
Format: 112x96 RGBA PNG (7 frames x 3 directions, each 16x32)

Key features:
  - Native 16x16 tiles (no aspect distortion)
  - Smooth vertical stretch via NEAREST resize
  - Outline color neutralized from maroon to dark neutral
  - Quadruped walk: 4-legged trot with alternating leg pairs
  - Biped walk: foot shift + bounce (penguin, gorilla)
  - Type anim: head bob / lowering head (animal-like)
  - Read anim: head tilt / looking around (animal-like)
  - Side view: subtle lean for directional feel

Usage: python3 scripts/convert-zoo-sprites.py
"""

import os
from PIL import Image
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_DIR = os.path.join(PROJECT_DIR, 'webview-ui', 'public', 'assets', 'characters-zoo')
SOURCE_DIR = os.path.join(SCRIPT_DIR, 'source-sprites')

FRAME_W = 16
FRAME_H = 32
SPRITE_H = 24
PAD_TOP = FRAME_H - SPRITE_H  # 8px
FRAMES_PER_ROW = 7
OUT_W = FRAME_W * FRAMES_PER_ROW  # 112
OUT_H = FRAME_H * 3               # 96

# Tiny Creatures tilemap layout
TILE_SIZE = 16
TILE_STRIDE = 17  # 16px + 1px gap

# Original maroon outline color used by Tiny Creatures tileset
OUTLINE_OLD = (63, 38, 49)
# How much to darken body colors for adaptive outlines (0.0 = black, 1.0 = same)
OUTLINE_DARKEN = 0.35

# Which animals are bipeds vs quadrupeds
BIPEDS = {"Penguin", "Gorilla"}


def extract_tile(tilemap: Image.Image, row: int, col: int) -> Image.Image:
    """Extract a 16x16 tile from the tilemap (no scaling)."""
    x = col * TILE_STRIDE
    y = row * TILE_STRIDE
    return tilemap.crop((x, y, x + TILE_SIZE, y + TILE_SIZE))


def fix_outline_color(tile: Image.Image) -> Image.Image:
    """Replace all maroon outlines with nearest body color (no outline added).

    The silhouette outline is added later by add_silhouette() AFTER stretching,
    so it stays exactly 1px thin on the final sprite.
    """
    arr = np.array(tile).astype(np.int32)

    outline_mask = (
        (arr[:, :, 0] == OUTLINE_OLD[0]) &
        (arr[:, :, 1] == OUTLINE_OLD[1]) &
        (arr[:, :, 2] == OUTLINE_OLD[2]) &
        (arr[:, :, 3] > 0)
    )

    body_mask = (arr[:, :, 3] > 0) & ~outline_mask
    body_coords = np.array(list(zip(*np.where(body_mask))))

    outline_coords = list(zip(*np.where(outline_mask)))
    if not outline_coords:
        return Image.fromarray(arr.astype(np.uint8), 'RGBA')

    # Fill ALL outline pixels with nearest body color
    if len(body_coords) > 0:
        for r, c in outline_coords:
            dists = np.abs(body_coords[:, 0] - r) + np.abs(body_coords[:, 1] - c)
            nearest_idx = np.argmin(dists)
            br, bc = body_coords[nearest_idx]
            arr[r, c, 0] = arr[br, bc, 0]
            arr[r, c, 1] = arr[br, bc, 1]
            arr[r, c, 2] = arr[br, bc, 2]

    return Image.fromarray(arr.astype(np.uint8), 'RGBA')


def add_silhouette(sprite: Image.Image) -> Image.Image:
    """Add 1px darkened outline on the outer silhouette of a sprite.

    Uses darkened body color (not pure black) for each edge pixel,
    matching the office character style where outlines are tinted.
    Called AFTER stretching so the outline stays exactly 1px thin.
    """
    arr = np.array(sprite).astype(np.int32)
    h, w = arr.shape[:2]

    opaque = arr[:, :, 3] > 0

    for r in range(h):
        for c in range(w):
            if not opaque[r, c]:
                continue
            is_edge = False
            for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nr, nc = r + dr, c + dc
                if nr < 0 or nr >= h or nc < 0 or nc >= w or not opaque[nr, nc]:
                    is_edge = True
                    break
            if is_edge:
                # Find nearest non-edge body pixel for color reference
                best_dist = 999
                ref_r, ref_c = r, c
                for dr2 in range(-2, 3):
                    for dc2 in range(-2, 3):
                        nr2, nc2 = r + dr2, c + dc2
                        if 0 <= nr2 < h and 0 <= nc2 < w and opaque[nr2, nc2]:
                            # Check if this neighbor is NOT an edge pixel
                            neighbor_is_edge = False
                            for dr3, dc3 in [(-1,0),(1,0),(0,-1),(0,1)]:
                                nnr, nnc = nr2+dr3, nc2+dc3
                                if nnr < 0 or nnr >= h or nnc < 0 or nnc >= w or not opaque[nnr, nnc]:
                                    neighbor_is_edge = True
                                    break
                            if not neighbor_is_edge:
                                d = abs(dr2) + abs(dc2)
                                if d < best_dist:
                                    best_dist = d
                                    ref_r, ref_c = nr2, nc2

                # Darken the reference color
                arr[r, c, 0] = int(arr[ref_r, ref_c, 0] * OUTLINE_DARKEN)
                arr[r, c, 1] = int(arr[ref_r, ref_c, 1] * OUTLINE_DARKEN)
                arr[r, c, 2] = int(arr[ref_r, ref_c, 2] * OUTLINE_DARKEN)

    return Image.fromarray(arr.astype(np.uint8), 'RGBA')


def stretch_tile(tile: Image.Image, target_h: int) -> Image.Image:
    """Stretch tile vertically using NEAREST resize."""
    return tile.resize((tile.width, target_h), Image.NEAREST)


def place_in_frame(tile: Image.Image) -> Image.Image:
    """Place a tile into 16x24 frame, full-width, bottom-aligned."""
    result = Image.new('RGBA', (FRAME_W, SPRITE_H), (0, 0, 0, 0))

    bbox = tile.getbbox()
    if not bbox:
        return result

    ch = tile.height
    y_off = SPRITE_H - ch - 1  # 1px ground gap

    if y_off < 0:
        tile = tile.crop((0, -y_off, tile.width, ch))
        y_off = 0

    result.paste(tile, (0, y_off), tile)
    return result


def shift_h(sprite: Image.Image, dx: int) -> Image.Image:
    """Shift sprite horizontally."""
    result = Image.new('RGBA', sprite.size, (0, 0, 0, 0))
    if dx > 0:
        content = sprite.crop((0, 0, sprite.width - dx, sprite.height))
        result.paste(content, (dx, 0), content)
    elif dx < 0:
        content = sprite.crop((-dx, 0, sprite.width, sprite.height))
        result.paste(content, (0, 0), content)
    else:
        result.paste(sprite, (0, 0), sprite)
    return result


def shift_v(sprite: Image.Image, dy: int) -> Image.Image:
    """Shift sprite vertically."""
    result = Image.new('RGBA', sprite.size, (0, 0, 0, 0))
    if dy > 0:
        content = sprite.crop((0, 0, sprite.width, sprite.height - dy))
        result.paste(content, (0, dy), content)
    elif dy < 0:
        content = sprite.crop((0, -dy, sprite.width, sprite.height))
        result.paste(content, (0, 0), content)
    else:
        result.paste(sprite, (0, 0), sprite)
    return result


def flip_h(sprite: Image.Image) -> Image.Image:
    return sprite.transpose(Image.FLIP_LEFT_RIGHT)


def find_content_bounds(arr: np.ndarray):
    """Find top and bottom rows of non-transparent content in numpy array."""
    top = 0
    for r in range(arr.shape[0]):
        if np.any(arr[r, :, 3] > 0):
            top = r
            break
    bottom = arr.shape[0] - 1
    for r in range(arr.shape[0] - 1, -1, -1):
        if np.any(arr[r, :, 3] > 0):
            bottom = r
            break
    return top, bottom


# ── Biped walk (Penguin, Gorilla) ──────────────────────────────────────

def build_biped_walk_frame(base: Image.Image, leg_dir: int) -> Image.Image:
    """Biped walk: foot shift at bottom + body bounce.

    leg_dir: -1 = step left, +1 = step right
    """
    arr = np.array(base).copy()
    h, w = arr.shape[:2]
    result = arr.copy()

    top, bottom = find_content_bounds(arr)
    content_h = bottom - top + 1
    if content_h <= 0:
        return base

    # Shift bottom 15% (feet) horizontally
    foot_start = top + int(content_h * 0.85)

    for r in range(foot_start, h):
        if not np.any(arr[r, :, 3] > 0):
            continue

        row = arr[r].copy()
        new_row = np.zeros_like(row)

        if leg_dir > 0:
            new_row[1:] = row[:w - 1]
            new_row[0] = row[0]
        else:
            new_row[:w - 1] = row[1:]
            new_row[w - 1] = row[w - 1]

        result[r] = new_row

    img = Image.fromarray(result, 'RGBA')
    img = shift_v(img, -1)
    return img


def build_biped_walk_frames(base: Image.Image) -> list:
    """Biped 7-frame set: walk1, idle, walk3, type1, type2, read1, read2."""
    walk1 = build_biped_walk_frame(base, leg_dir=-1)
    idle = base
    walk3 = build_biped_walk_frame(base, leg_dir=1)

    type1 = build_head_bob(base, dy=1)
    type2 = build_head_bob(base, dy=1, dx=-1)
    read1 = build_head_tilt(base, dx=1)
    read2 = build_head_tilt(base, dx=-1)

    return [walk1, idle, walk3, type1, type2, read1, read2]


# ── Quadruped walk (Lion, Tiger, Bear, Giraffe) ───────────────────────

def build_quadruped_trot_frame(base: Image.Image, phase: int) -> Image.Image:
    """Quadruped trot from front view: alternate raising left/right leg pairs.

    phase: 1 = left pair stepping (left half of feet raised), -1 = right pair

    Creates a subtle rocking/trotting motion visible from the front.
    """
    arr = np.array(base).copy()
    h, w = arr.shape[:2]

    top, bottom = find_content_bounds(arr)
    content_h = bottom - top + 1
    if content_h <= 0:
        return base

    # Bottom 20% = leg area
    leg_start = top + int(content_h * 0.80)
    mid = w // 2

    result = arr.copy()

    # Raise one side of the feet area by 1px (shift up)
    for r in range(leg_start, bottom + 1):
        if phase > 0:
            # Left side: shift up 1px
            if r > leg_start:
                has_left = np.any(arr[r, :mid, 3] > 0)
                if has_left:
                    result[r - 1, :mid] = arr[r, :mid]
                    result[r, :mid] = 0
        else:
            # Right side: shift up 1px
            if r > leg_start:
                has_right = np.any(arr[r, mid:, 3] > 0)
                if has_right:
                    result[r - 1, mid:] = arr[r, mid:]
                    result[r, mid:] = 0

    img = Image.fromarray(result, 'RGBA')
    # Body bounce up 1px on stepping frames
    img = shift_v(img, -1)
    return img


def build_quadruped_walk_frames(base: Image.Image) -> list:
    """Quadruped 7-frame set with trotting walk and animal-like work anims."""
    walk1 = build_quadruped_trot_frame(base, phase=1)
    idle = base
    walk3 = build_quadruped_trot_frame(base, phase=-1)

    # Type = head dip (animal lowering head, like drinking/eating)
    type1 = build_head_bob(base, dy=2)
    type2 = build_head_bob(base, dy=2, dx=-1)

    # Read = alert looking around
    read1 = build_head_tilt(base, dx=1)
    read2 = build_head_tilt(base, dx=-1)

    return [walk1, idle, walk3, type1, type2, read1, read2]


# ── Animal-like work animations ──────────────────────────────────────

def build_head_bob(base: Image.Image, dy: int = 1, dx: int = 0) -> Image.Image:
    """Lower/shift the top portion of the sprite (head bob).

    Simulates an animal dipping its head to eat, drink, or work.
    Only moves the top ~40% of content; bottom (legs) stays put.
    """
    arr = np.array(base).copy()
    h, w = arr.shape[:2]
    top, bottom = find_content_bounds(arr)
    content_h = bottom - top + 1
    if content_h <= 0:
        return base

    # Split at ~40% from top = head portion
    split_row = top + int(content_h * 0.40)
    result = arr.copy()

    # Shift head portion down by dy and sideways by dx
    for r in range(split_row, top - 1, -1):
        for c in range(w):
            if arr[r, c, 3] > 0:
                nr = min(r + dy, h - 1)
                nc = max(0, min(c + dx, w - 1))
                if nr >= 0 and nc >= 0 and nr < h and nc < w:
                    result[nr, nc] = arr[r, c]
                    if nr != r or nc != c:
                        result[r, c] = 0

    return Image.fromarray(result, 'RGBA')


def build_head_tilt(base: Image.Image, dx: int = 1) -> Image.Image:
    """Shift the top portion horizontally (looking left/right).

    Simulates an animal turning its head to look around.
    """
    arr = np.array(base).copy()
    h, w = arr.shape[:2]
    top, bottom = find_content_bounds(arr)
    content_h = bottom - top + 1
    if content_h <= 0:
        return base

    split_row = top + int(content_h * 0.45)
    result = arr.copy()

    # Clear head area first, then redraw shifted
    head_rows = arr[top:split_row + 1].copy()
    result[top:split_row + 1] = 0

    for r in range(head_rows.shape[0]):
        for c in range(w):
            if head_rows[r, c, 3] > 0:
                nc = c + dx
                if 0 <= nc < w:
                    result[top + r, nc] = head_rows[r, c]

    return Image.fromarray(result, 'RGBA')


# ── Side view lean ────────────────────────────────────────────────────

def build_side_lean(base: Image.Image) -> Image.Image:
    """Create subtle side-view feel: lean upper body 1px right (facing direction).

    Preserves the cute front-facing art but suggests directionality.
    """
    arr = np.array(base).copy()
    h, w = arr.shape[:2]
    top, bottom = find_content_bounds(arr)
    content_h = bottom - top + 1
    if content_h <= 0:
        return base

    # Top 55% leans 1px right
    split_row = top + int(content_h * 0.55)
    result = arr.copy()

    # Clear upper portion, redraw shifted 1px right
    upper = arr[top:split_row + 1].copy()
    result[top:split_row + 1] = 0

    for r in range(upper.shape[0]):
        for c in range(w):
            if upper[r, c, 3] > 0:
                nc = c + 1
                if 0 <= nc < w:
                    result[top + r, nc] = upper[r, c]

    return Image.fromarray(result, 'RGBA')


# ── Assembly ──────────────────────────────────────────────────────────

def process_tile(tile: Image.Image, target_h: int) -> Image.Image:
    """Fix outline, stretch, place in frame, then add thin silhouette."""
    fixed = fix_outline_color(tile)
    stretched = stretch_tile(fixed, target_h)
    placed = place_in_frame(stretched)
    return add_silhouette(placed)


def build_direction_frames(front_tile: Image.Image,
                           name: str,
                           target_h: int = 20) -> dict:
    """Build frames for all 3 directions with animal-specific motion."""
    front = process_tile(front_tile, target_h)
    is_biped = name in BIPEDS

    # Down (front-facing) frames
    if is_biped:
        down_frames = build_biped_walk_frames(front)
    else:
        down_frames = build_quadruped_walk_frames(front)

    # Up (back-facing) — same as front (no back tile in tileset)
    if is_biped:
        up_frames = build_biped_walk_frames(front)
    else:
        up_frames = build_quadruped_walk_frames(front)

    # Right (side-facing) — lean + flip for directionality
    side_base = build_side_lean(front)
    side_r = flip_h(side_base)
    if is_biped:
        right_frames = build_biped_walk_frames(side_r)
    else:
        right_frames = build_quadruped_walk_frames(side_r)

    return {0: down_frames, 1: up_frames, 2: right_frames}


def build_output(frames_by_dir: dict) -> Image.Image:
    """Assemble 112x96 output from direction frames."""
    output = Image.new('RGBA', (OUT_W, OUT_H), (0, 0, 0, 0))
    for dir_idx in range(3):
        frames = frames_by_dir[dir_idx]
        for fi in range(FRAMES_PER_ROW):
            sprite = frames[fi]
            output.paste(sprite,
                         (fi * FRAME_W, dir_idx * FRAME_H + PAD_TOP),
                         sprite)
    return output


# Animal definitions:
# (front_row, front_col, name, target_h)
# target_h: stretched height in pixels (original is 16, humans are ~22)
ANIMALS = [
    (15, 6, "Lion",     20),
    (15, 9, "Giraffe",  20),
    (16, 3, "Bear",     20),
    (17, 9, "Penguin",  26),
    (16, 6, "Gorilla",  20),
    (15, 7, "Tiger",    20),
]


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    tilemap_path = os.path.join(SOURCE_DIR, 'tiny-creatures', 'tiny-creatures',
                                'Tilemap', 'tilemap.png')

    if not os.path.exists(tilemap_path):
        print(f"ERROR: Missing tilemap: {tilemap_path}")
        return

    tilemap = Image.open(tilemap_path).convert('RGBA')
    print(f"Tilemap loaded: {tilemap.size}")

    for i, (fr, fc, name, th) in enumerate(ANIMALS):
        locomotion = "biped" if name in BIPEDS else "quadruped"
        print(f"Building char_{i}: {name} ({locomotion}, target_h={th})...")

        front_tile = extract_tile(tilemap, fr, fc)
        frames = build_direction_frames(front_tile, name, th)
        output = build_output(frames)

        out_path = os.path.join(OUTPUT_DIR, f'char_{i}.png')
        output.save(out_path)

        bbox = output.getbbox()
        content_h = bbox[3] - bbox[1] if bbox else 0
        print(f"  -> char_{i}.png -- {name} (content_h={content_h}px)")

    print(f"\nVerifying...")
    all_ok = True
    for i in range(len(ANIMALS)):
        path = os.path.join(OUTPUT_DIR, f'char_{i}.png')
        img = Image.open(path)
        ok = img.size == (OUT_W, OUT_H) and img.mode == 'RGBA'
        symbol = "OK" if ok else "FAIL"
        if not ok:
            all_ok = False
        print(f"  {symbol} char_{i}.png: {img.size[0]}x{img.size[1]} {img.mode}")

    print(f"\nDone!")
    print("Credits:")
    print("  - Tiny Creatures: CC0 (clintbellanger / Kenney, OpenGameArt)")


if __name__ == '__main__':
    main()
