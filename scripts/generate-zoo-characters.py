#!/usr/bin/env python3
"""
Generate zoo character sprites using procedural pixel art.
Each character is 112x96 PNG: 7 frames x 16px wide, 3 direction rows x 32px tall.
Row 0 = down (front), Row 1 = up (back), Row 2 = right (side).
Frame order: walk1, walk2(idle), walk3, type1, type2, read1, read2.
Content area: 16x24 with 8px top padding.

Design: quadrupeds have wide horizontal bodies with 4 clearly visible legs.
Cute style: big heads, consistent 2px legs everywhere.
Walk animation uses Y height changes (leg lift) instead of X spread.
"""

from PIL import Image
import os

FRAME_W = 16
FRAME_H = 32
TOP_PAD = 8
NUM_FRAMES = 7
NUM_ROWS = 3

TRANSPARENT = (0, 0, 0, 0)

def hex_to_rgba(h: str) -> tuple:
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)

class Palette:
    def __init__(self, outline, dark, mid, light, accent=None, accent2=None):
        self.outline = hex_to_rgba(outline)
        self.dark = hex_to_rgba(dark)
        self.mid = hex_to_rgba(mid)
        self.light = hex_to_rgba(light)
        self.accent = hex_to_rgba(accent) if accent else self.light
        self.accent2 = hex_to_rgba(accent2) if accent2 else self.dark
        self.eye = hex_to_rgba('101018')

# ─── Palettes ─── #
LION = Palette('3f2610', '8b5a2b', 'd4a030', 'f0c848', '5c3310', '7a4420')
BEAR = Palette('2a1a0c', '5c3820', '8b5e3c', 'b8845c', 'd8a878', '3c2410')
PENGUIN = Palette('101020', '2a2a48', '505878', 'e8e8f0', 'e87830', 'f89848')
FOX = Palette('4a1808', 'b04020', 'e06830', 'f09048', 'f0e8d8', 'f8f0e0')
DEER = Palette('302010', '6b4830', 'a07850', 'c8a070', 'e8d8c0', '483020')
RABBIT = Palette('303040', '707888', 'a0a8b8', 'c8d0d8', 'e0b0b8', 'f0e0e0')

# ─── Drawing Helpers ─── #

def create_frame():
    return Image.new('RGBA', (FRAME_W, FRAME_H), TRANSPARENT)

def sp(img, x, y, color):
    py = y + TOP_PAD
    if 0 <= x < FRAME_W and 0 <= py < FRAME_H:
        img.putpixel((x, py), color)

def fill_rect(img, x, y, w, h, color):
    for dy in range(h):
        for dx in range(w):
            sp(img, x+dx, y+dy, color)

def fill_ellipse(img, cx, cy, rx, ry, color):
    for dy in range(-ry, ry+1):
        for dx in range(-rx, rx+1):
            if rx > 0 and ry > 0 and (dx*dx)/(rx*rx) + (dy*dy)/(ry*ry) <= 1.0:
                sp(img, cx+dx, cy+dy, color)

def add_outline(img, outline_color):
    w, h = img.size
    to_set = []
    for y in range(h):
        for x in range(w):
            if img.getpixel((x, y))[3] == 0:
                for dx, dy in [(-1,0),(1,0),(0,-1),(0,1)]:
                    nx, ny = x+dx, y+dy
                    if 0 <= nx < w and 0 <= ny < h and img.getpixel((nx, ny))[3] > 0:
                        to_set.append((x, y))
                        break
    for x, y in to_set:
        img.putpixel((x, y), outline_color)

def draw_side_legs_2px(img, hx, fx, top_y, leg_h, lo, dark, mid, paw_color):
    """Draw 4 side-view legs as 2 visible pairs (2px wide each) with forward paws.
    hx = hind pair x, fx = fore pair x.
    lo = [(fx_off, fh_adj), (fx_off2, fh_adj2), (hx_off, hh_adj), (hx_off2, hh_adj2)]
    All paws point forward (right, +1 direction)."""
    # Hind pair (behind, darker) — drawn first so forelegs overlap
    h1 = leg_h + lo[2][1]
    fill_rect(img, hx+lo[2][0], top_y, 2, h1, dark)
    sp(img, hx+lo[2][0]+2, top_y+h1-1, paw_color)  # paw forward
    # Fore pair (in front, lighter)
    f1 = leg_h + lo[0][1]
    fill_rect(img, fx+lo[0][0], top_y, 2, f1, mid)
    sp(img, fx+lo[0][0]+2, top_y+f1-1, paw_color)  # paw forward

def walk_offsets_front(walk_phase, anim):
    """Return leg offsets for front/back view walk.
    Uses Y height changes (lift) instead of X spread.
    lo[i] = (x_offset, height_adjust). Negative = shorter = lifted.
    Order: [front-left, front-right, back-left, back-right]"""
    if anim != 'walk':
        return [(0,0)]*4
    if walk_phase == 0:
        # Diagonal pair A lifted: front-left + back-right
        return [(0,-1),(0,0),(0,0),(0,-1)]
    elif walk_phase == 2:
        # Diagonal pair B lifted: front-right + back-left
        return [(0,0),(0,-1),(0,-1),(0,0)]
    return [(0,0)]*4

def walk_offsets_side(walk_phase, anim):
    """Return leg offsets for side view walk.
    lo[i] = (x_offset, height_adjust).
    Order: [fore1, fore2, hind1, hind2]"""
    if anim != 'walk':
        return [(0,0)]*4
    if walk_phase == 0:
        return [(1,0),(-1,1),(-1,0),(1,1)]
    elif walk_phase == 2:
        return [(-1,1),(1,0),(1,1),(-1,0)]
    return [(0,0)]*4


# ═══════════════════════════════════════
# LION — golden body, prominent dark mane
# ═══════════════════════════════════════

def draw_lion_front(walk_phase=0, anim='walk'):
    img = create_frame()
    p = LION

    # Mane halo
    for dy in range(-5, 6):
        for dx in range(-5, 6):
            if dx*dx + dy*dy <= 28:
                c = p.accent if (dx+dy) % 2 == 0 else p.accent2
                sp(img, 8+dx, 5+dy, c)

    # Head
    fill_ellipse(img, 8, 5, 4, 3, p.mid)
    fill_ellipse(img, 8, 5, 3, 2, p.light)
    # Rounded ears (2x2 instead of single pixel)
    fill_rect(img, 3, 1, 2, 2, p.dark); fill_rect(img, 12, 1, 2, 2, p.dark)
    sp(img, 4, 1, p.mid); sp(img, 12, 1, p.mid)  # inner ear
    sp(img, 7, 5, p.eye); sp(img, 9, 5, p.eye)
    sp(img, 8, 6, p.accent2); sp(img, 7, 7, p.dark); sp(img, 9, 7, p.dark)

    # Body
    fill_ellipse(img, 8, 13, 5, 4, p.mid)
    fill_ellipse(img, 8, 12, 4, 3, p.light)

    # 4 legs — 2px wide, with Y lift walk
    lo = walk_offsets_front(walk_phase, anim)
    fill_rect(img, 5, 17, 2, 4+lo[2][1], p.dark)    # back-left
    fill_rect(img, 10, 17, 2, 4+lo[3][1], p.dark)   # back-right
    fill_rect(img, 6, 17, 2, 4+lo[0][1], p.light)   # front-left
    fill_rect(img, 9, 17, 2, 4+lo[1][1], p.light)   # front-right
    # Paws
    sp(img, 6, 20+lo[0][1], p.dark); sp(img, 7, 20+lo[0][1], p.dark)
    sp(img, 9, 20+lo[1][1], p.dark); sp(img, 10, 20+lo[1][1], p.dark)

    add_outline(img, p.outline)
    return img

def draw_lion_back(walk_phase=0, anim='walk'):
    img = create_frame()
    p = LION

    for dy in range(-5, 5):
        for dx in range(-5, 6):
            if dx*dx + dy*dy <= 28:
                c = p.accent if (dx+dy) % 2 == 0 else p.accent2
                sp(img, 8+dx, 5+dy, c)

    fill_ellipse(img, 8, 5, 4, 3, p.accent2)
    fill_ellipse(img, 8, 5, 3, 2, p.accent)
    sp(img, 4, 1, p.dark); sp(img, 12, 1, p.dark)

    fill_ellipse(img, 8, 13, 5, 4, p.dark)
    fill_ellipse(img, 8, 12, 4, 3, p.mid)

    # Tail
    tx = 8
    if walk_phase == 0: tx = 12
    elif walk_phase == 2: tx = 4
    sp(img, tx, 17, p.mid); sp(img, tx, 16, p.mid)
    sp(img, tx, 15, p.dark); sp(img, tx, 14, p.dark)

    # 4 legs — 2px wide, Y lift
    lo = walk_offsets_front(walk_phase, anim)
    fill_rect(img, 5, 17, 2, 4+lo[0][1], p.dark)
    fill_rect(img, 10, 17, 2, 4+lo[1][1], p.dark)
    fill_rect(img, 6, 17, 2, 4+lo[2][1], p.dark)
    fill_rect(img, 9, 17, 2, 4+lo[3][1], p.dark)

    add_outline(img, p.outline)
    return img

def draw_lion_side(walk_phase=0, anim='walk'):
    img = create_frame()
    p = LION

    # Tail
    ty = 10 + walk_phase
    sp(img, 1, ty, p.mid); sp(img, 0, ty-1, p.dark)
    sp(img, 1, ty-1, p.mid); sp(img, 2, ty, p.dark)

    # Body (thicker front-to-back)
    fill_ellipse(img, 7, 12, 5, 4, p.mid)
    fill_ellipse(img, 7, 11, 4, 3, p.light)

    # Mane — fuller on back (left), extends above head
    for dy in range(-6, 5):
        for dx in range(-6, 4):
            if dx*dx/(36) + dy*dy/(30) <= 1.0:
                c = p.accent if (dx+dy) % 2 == 0 else p.accent2
                sp(img, 12+dx, 5+dy, c)

    # Head (inside mane)
    fill_ellipse(img, 12, 5, 3, 3, p.mid)
    fill_ellipse(img, 12, 5, 2, 2, p.light)
    sp(img, 11, 1, p.dark); sp(img, 12, 1, p.mid)  # ear tip above mane
    sp(img, 13, 4, p.eye)
    sp(img, 14, 6, p.dark); sp(img, 14, 7, p.accent2)

    # 4 legs — 2px wide with forward paws
    lo = walk_offsets_side(walk_phase, anim)
    draw_side_legs_2px(img, 4, 9, 15, 4, lo, p.dark, p.mid, p.dark)

    add_outline(img, p.outline)
    return img


# ═══════════════════════════════════════
# BEAR — big round brown body, round ears
# ═══════════════════════════════════════

def draw_bear_front(walk_phase=0, anim='walk'):
    img = create_frame()
    p = BEAR

    fill_ellipse(img, 8, 5, 5, 4, p.mid)
    fill_ellipse(img, 8, 5, 4, 3, p.light)
    fill_ellipse(img, 4, 1, 1, 1, p.mid); sp(img, 4, 1, p.dark)
    fill_ellipse(img, 12, 1, 1, 1, p.mid); sp(img, 12, 1, p.dark)
    sp(img, 7, 5, p.eye); sp(img, 9, 5, p.eye)
    fill_rect(img, 7, 6, 3, 2, p.accent)
    sp(img, 8, 6, p.accent2)

    fill_ellipse(img, 8, 13, 6, 5, p.mid)
    fill_ellipse(img, 8, 13, 5, 4, p.light)
    fill_ellipse(img, 8, 14, 3, 3, p.accent)

    lo = walk_offsets_front(walk_phase, anim)
    fill_rect(img, 4, 17, 2, 4+lo[2][1], p.dark)
    fill_rect(img, 11, 17, 2, 4+lo[3][1], p.dark)
    fill_rect(img, 6, 17, 2, 4+lo[0][1], p.mid)
    fill_rect(img, 6, 17, 2, 3+lo[0][1], p.light)
    fill_rect(img, 9, 17, 2, 4+lo[1][1], p.mid)
    fill_rect(img, 9, 17, 2, 3+lo[1][1], p.light)
    for ox in [6, 9]:
        fill_rect(img, ox, 20, 2, 1, p.dark)

    add_outline(img, p.outline)
    return img

def draw_bear_back(walk_phase=0, anim='walk'):
    img = create_frame()
    p = BEAR

    fill_ellipse(img, 8, 5, 5, 4, p.dark)
    fill_ellipse(img, 8, 5, 4, 3, p.mid)
    fill_ellipse(img, 4, 1, 1, 1, p.dark)
    fill_ellipse(img, 12, 1, 1, 1, p.dark)

    fill_ellipse(img, 8, 13, 6, 5, p.dark)
    fill_ellipse(img, 8, 12, 5, 4, p.mid)
    sp(img, 8, 17, p.mid)

    lo = walk_offsets_front(walk_phase, anim)
    fill_rect(img, 4, 17, 2, 4+lo[0][1], p.dark)
    fill_rect(img, 11, 17, 2, 4+lo[1][1], p.dark)
    fill_rect(img, 6, 17, 2, 4+lo[2][1], p.accent2)
    fill_rect(img, 9, 17, 2, 4+lo[3][1], p.accent2)

    add_outline(img, p.outline)
    return img

def draw_bear_side(walk_phase=0, anim='walk'):
    img = create_frame()
    p = BEAR

    sp(img, 2, 12, p.mid)

    fill_ellipse(img, 7, 12, 5, 4, p.mid)
    fill_ellipse(img, 7, 11, 4, 3, p.light)
    fill_ellipse(img, 8, 14, 3, 2, p.accent)

    fill_ellipse(img, 12, 6, 4, 4, p.mid)
    fill_ellipse(img, 12, 6, 3, 3, p.light)
    sp(img, 11, 3, p.mid); sp(img, 12, 3, p.dark)
    sp(img, 13, 5, p.eye)
    fill_rect(img, 14, 7, 2, 2, p.accent)
    sp(img, 15, 7, p.accent2)

    lo = walk_offsets_side(walk_phase, anim)
    draw_side_legs_2px(img, 3, 9, 16, 4, lo, p.dark, p.mid, p.dark)

    add_outline(img, p.outline)
    return img


# ═══════════════════════════════════════
# PENGUIN — biped, black/white, round & adorable
# ═══════════════════════════════════════

def draw_penguin_front(walk_phase=0, anim='walk'):
    img = create_frame()
    p = PENGUIN

    # ── DARK CAP (rounded with corner pixels) ──
    fill_rect(img, 7, 2, 3, 1, p.dark)            # top narrow
    fill_rect(img, 5, 3, 7, 1, p.dark)            # wider
    fill_rect(img, 6, 3, 5, 1, p.mid)             # mid inside
    fill_rect(img, 5, 4, 7, 1, p.dark)
    fill_rect(img, 5, 4, 7, 1, p.mid)             # full mid row

    # ── HEAD (seamless into body, 9px wide) ──
    fill_rect(img, 4, 5, 9, 4, p.dark)            # dark shell
    fill_rect(img, 5, 5, 7, 4, p.mid)             # mid fill
    # Rounded cap-to-face: soften corners
    sp(img, 4, 5, p.dark)                          # keep dark corner for rounding
    sp(img, 12, 5, p.dark)
    # White face
    fill_rect(img, 6, 6, 5, 2, p.light)
    fill_rect(img, 7, 8, 3, 1, p.light)           # narrow chin

    # Eyes, beak, cheek
    sp(img, 6, 6, p.eye); sp(img, 10, 6, p.eye)
    sp(img, 8, 7, p.accent)
    sp(img, 5, 7, p.accent2); sp(img, 11, 7, p.accent2)

    # ── BODY (11px wide, seamless from head → pear shape) ──
    fill_rect(img, 3, 9, 11, 7, p.dark)
    fill_rect(img, 4, 9, 9, 7, p.mid)
    # Rounded bottom corners
    fill_rect(img, 4, 16, 9, 1, p.dark)
    fill_rect(img, 5, 16, 7, 1, p.mid)
    # Corner rounding: remove sharp corners at bottom
    sp(img, 3, 15, TRANSPARENT); sp(img, 13, 15, TRANSPARENT)

    # White belly shield (narrow→wide→narrow)
    fill_rect(img, 6, 9, 5, 1, p.light)           # chest top
    fill_rect(img, 5, 10, 7, 3, p.light)          # belly wide
    fill_rect(img, 6, 13, 5, 2, p.light)          # belly narrow
    fill_rect(img, 7, 15, 3, 1, p.light)          # belly tip

    # ── FLIPPERS (angled, tapering down) ──
    wo = [-1, 0, 1][walk_phase] if anim == 'walk' else 0
    sp(img, 2, 10+wo, p.dark); sp(img, 2, 11+wo, p.mid)
    sp(img, 1, 11+wo, p.dark); sp(img, 2, 12+wo, p.dark)
    sp(img, 14, 10-wo, p.dark); sp(img, 14, 11-wo, p.mid)
    sp(img, 15, 11-wo, p.dark); sp(img, 14, 12-wo, p.dark)

    # ── FEET ──
    fo = [-1, 0, 1][walk_phase] if anim == 'walk' else 0
    fill_rect(img, 5+fo, 17, 3, 1, p.accent)
    fill_rect(img, 9-fo, 17, 3, 1, p.accent)

    add_outline(img, p.outline)
    return img

def draw_penguin_back(walk_phase=0, anim='walk'):
    img = create_frame()
    p = PENGUIN

    # ── CAP ──
    fill_rect(img, 7, 2, 3, 1, p.dark)
    fill_rect(img, 5, 3, 7, 1, p.dark)
    fill_rect(img, 6, 3, 5, 1, p.mid)
    fill_rect(img, 5, 4, 7, 1, p.mid)

    # ── HEAD ──
    fill_rect(img, 4, 5, 9, 4, p.dark)
    fill_rect(img, 5, 5, 7, 4, p.mid)

    # ── BODY ──
    fill_rect(img, 3, 9, 11, 7, p.dark)
    fill_rect(img, 4, 9, 9, 7, p.mid)
    fill_rect(img, 4, 16, 9, 1, p.dark)
    fill_rect(img, 5, 16, 7, 1, p.mid)
    sp(img, 3, 15, TRANSPARENT); sp(img, 13, 15, TRANSPARENT)

    # ── FLIPPERS ──
    wo = [-1, 0, 1][walk_phase] if anim == 'walk' else 0
    sp(img, 2, 10+wo, p.dark); sp(img, 2, 11+wo, p.mid)
    sp(img, 1, 11+wo, p.dark); sp(img, 2, 12+wo, p.dark)
    sp(img, 14, 10-wo, p.dark); sp(img, 14, 11-wo, p.mid)
    sp(img, 15, 11-wo, p.dark); sp(img, 14, 12-wo, p.dark)

    # ── FEET ──
    fo = [-1, 0, 1][walk_phase] if anim == 'walk' else 0
    fill_rect(img, 5+fo, 17, 3, 1, p.accent)
    fill_rect(img, 9-fo, 17, 3, 1, p.accent)

    add_outline(img, p.outline)
    return img

def draw_penguin_side(walk_phase=0, anim='walk'):
    img = create_frame()
    p = PENGUIN

    # ── HEAD (profile, seamless into body) ──
    fill_rect(img, 8, 3, 4, 1, p.dark)
    fill_rect(img, 7, 4, 6, 1, p.dark)
    fill_rect(img, 8, 4, 4, 1, p.mid)
    fill_rect(img, 6, 5, 7, 2, p.dark)
    fill_rect(img, 7, 5, 5, 2, p.mid)

    # White face patch (front/right)
    fill_rect(img, 10, 6, 2, 2, p.light)

    # Eye, beak, cheek
    sp(img, 10, 5, p.eye)
    sp(img, 13, 5, p.accent); sp(img, 13, 6, p.accent2)
    sp(img, 11, 7, p.accent2)

    # ── HEAD→BODY transition (seamless) ──
    fill_rect(img, 5, 7, 8, 1, p.dark)
    fill_rect(img, 6, 7, 6, 1, p.mid)

    # ── BODY (wider, offset left) ──
    fill_rect(img, 4, 8, 9, 7, p.dark)
    fill_rect(img, 5, 8, 7, 7, p.mid)
    fill_rect(img, 5, 15, 7, 1, p.dark)
    fill_rect(img, 6, 15, 5, 1, p.mid)
    # Round bottom-back corner
    sp(img, 4, 14, TRANSPARENT)

    # White belly (front/right)
    fill_rect(img, 9, 8, 3, 1, p.light)
    fill_rect(img, 8, 9, 4, 3, p.light)
    fill_rect(img, 9, 12, 3, 1, p.light)
    fill_rect(img, 9, 13, 2, 1, p.light)

    # ── FLIPPER (angled, back side) ──
    wo = [-1, 0, 1][walk_phase] if anim == 'walk' else 0
    sp(img, 3, 9+wo, p.dark); sp(img, 3, 10+wo, p.mid)
    sp(img, 2, 10+wo, p.dark); sp(img, 3, 11+wo, p.dark)

    # ── TAIL NUB ──
    sp(img, 4, 15, p.dark); sp(img, 3, 14, p.mid)

    # ── FEET ──
    fo = [1, 0, -1][walk_phase] if anim == 'walk' else 0
    fill_rect(img, 6+fo, 16, 3, 1, p.accent)
    fill_rect(img, 8, 16, 3, 1, p.accent)

    add_outline(img, p.outline)
    return img


# ═══════════════════════════════════════
# FOX — orange/white, pointy ears, bushy tail
# ═══════════════════════════════════════

def draw_fox_front(walk_phase=0, anim='walk'):
    img = create_frame()
    p = FOX

    fill_ellipse(img, 8, 6, 4, 3, p.mid)
    fill_ellipse(img, 8, 6, 3, 2, p.light)
    fill_rect(img, 7, 7, 3, 2, p.accent)
    sp(img, 8, 7, p.outline)

    fill_rect(img, 3, 0, 2, 4, p.mid)
    sp(img, 3, 0, p.dark); sp(img, 4, 1, p.accent); sp(img, 4, 2, p.accent)
    fill_rect(img, 12, 0, 2, 4, p.mid)
    sp(img, 13, 0, p.dark); sp(img, 12, 1, p.accent); sp(img, 12, 2, p.accent)

    sp(img, 7, 5, p.eye); sp(img, 9, 5, p.eye)

    fill_ellipse(img, 8, 13, 4, 3, p.mid)
    fill_ellipse(img, 8, 12, 3, 2, p.light)
    fill_ellipse(img, 8, 14, 2, 2, p.accent)

    lo = walk_offsets_front(walk_phase, anim)
    fill_rect(img, 5, 16, 2, 4+lo[2][1], p.dark)
    fill_rect(img, 10, 16, 2, 4+lo[3][1], p.dark)
    fill_rect(img, 6, 16, 2, 4+lo[0][1], p.mid)
    fill_rect(img, 9, 16, 2, 4+lo[1][1], p.mid)
    sp(img, 6, 19+lo[0][1], p.dark); sp(img, 7, 19+lo[0][1], p.dark)
    sp(img, 9, 19+lo[1][1], p.dark); sp(img, 10, 19+lo[1][1], p.dark)

    if walk_phase == 0:
        sp(img, 14, 13, p.light); sp(img, 15, 12, p.accent)
    elif walk_phase == 2:
        sp(img, 1, 13, p.light); sp(img, 0, 12, p.accent)

    add_outline(img, p.outline)
    return img

def draw_fox_back(walk_phase=0, anim='walk'):
    img = create_frame()
    p = FOX

    fill_rect(img, 3, 0, 2, 4, p.dark)
    sp(img, 4, 1, p.mid); sp(img, 4, 2, p.mid)
    fill_rect(img, 12, 0, 2, 4, p.dark)
    sp(img, 12, 1, p.mid); sp(img, 12, 2, p.mid)

    fill_ellipse(img, 8, 6, 4, 3, p.dark)
    fill_ellipse(img, 8, 6, 3, 2, p.mid)

    fill_ellipse(img, 8, 13, 4, 3, p.dark)
    fill_ellipse(img, 8, 12, 3, 2, p.mid)

    to = [2, 0, -2][walk_phase]
    fill_ellipse(img, 8+to, 16, 3, 2, p.light)
    fill_ellipse(img, 8+to, 17, 2, 1, p.accent)

    lo = walk_offsets_front(walk_phase, anim)
    fill_rect(img, 5, 16, 2, 4+lo[0][1], p.dark)
    fill_rect(img, 10, 16, 2, 4+lo[1][1], p.dark)
    fill_rect(img, 6, 16, 2, 4+lo[2][1], p.accent2)
    fill_rect(img, 9, 16, 2, 4+lo[3][1], p.accent2)

    add_outline(img, p.outline)
    return img

def draw_fox_side(walk_phase=0, anim='walk'):
    img = create_frame()
    p = FOX

    ty = 10 + walk_phase
    fill_ellipse(img, 2, ty, 2, 2, p.light)
    sp(img, 0, ty+1, p.accent); sp(img, 1, ty+2, p.accent)

    fill_ellipse(img, 7, 11, 4, 3, p.mid)
    fill_ellipse(img, 7, 10, 3, 2, p.light)
    sp(img, 7, 13, p.accent); sp(img, 8, 13, p.accent)

    fill_ellipse(img, 12, 6, 3, 3, p.mid)
    fill_ellipse(img, 12, 6, 2, 2, p.light)
    sp(img, 14, 7, p.accent); sp(img, 15, 7, p.outline)
    sp(img, 13, 5, p.eye)

    fill_rect(img, 11, 2, 2, 3, p.mid)
    sp(img, 12, 2, p.accent); sp(img, 12, 3, p.accent)

    lo = walk_offsets_side(walk_phase, anim)
    draw_side_legs_2px(img, 3, 9, 14, 4, lo, p.dark, p.mid, p.dark)

    add_outline(img, p.outline)
    return img


# ═══════════════════════════════════════
# DEER — slender, antlers, spotted
# ═══════════════════════════════════════

def draw_deer_front(walk_phase=0, anim='walk'):
    img = create_frame()
    p = DEER

    sp(img, 3, 0, p.accent2); sp(img, 4, 0, p.accent2); sp(img, 2, 1, p.accent2)
    sp(img, 5, 1, p.accent2); sp(img, 5, 2, p.accent2); sp(img, 6, 3, p.dark)
    sp(img, 12, 0, p.accent2); sp(img, 13, 0, p.accent2); sp(img, 14, 1, p.accent2)
    sp(img, 11, 1, p.accent2); sp(img, 11, 2, p.accent2); sp(img, 10, 3, p.dark)

    fill_ellipse(img, 8, 6, 3, 3, p.mid)
    fill_ellipse(img, 8, 6, 2, 2, p.light)
    sp(img, 4, 4, p.mid); sp(img, 5, 4, p.light)
    sp(img, 11, 4, p.light); sp(img, 12, 4, p.mid)
    sp(img, 7, 5, p.eye); sp(img, 9, 5, p.eye)
    sp(img, 8, 8, p.dark)

    fill_ellipse(img, 8, 14, 4, 4, p.mid)
    fill_ellipse(img, 8, 13, 3, 3, p.light)
    fill_ellipse(img, 8, 15, 2, 2, p.accent)
    sp(img, 6, 12, p.accent); sp(img, 10, 11, p.accent); sp(img, 7, 16, p.accent)

    lo = walk_offsets_front(walk_phase, anim)
    fill_rect(img, 5, 17, 2, 4+lo[2][1], p.dark)
    fill_rect(img, 10, 17, 2, 4+lo[3][1], p.dark)
    fill_rect(img, 6, 17, 2, 4+lo[0][1], p.mid)
    fill_rect(img, 9, 17, 2, 4+lo[1][1], p.mid)
    sp(img, 6, 20+lo[0][1], p.accent2); sp(img, 7, 20+lo[0][1], p.accent2)
    sp(img, 9, 20+lo[1][1], p.accent2); sp(img, 10, 20+lo[1][1], p.accent2)

    add_outline(img, p.outline)
    return img

def draw_deer_back(walk_phase=0, anim='walk'):
    img = create_frame()
    p = DEER

    sp(img, 3, 0, p.accent2); sp(img, 4, 0, p.accent2); sp(img, 2, 1, p.accent2)
    sp(img, 5, 1, p.accent2); sp(img, 5, 2, p.accent2)
    sp(img, 12, 0, p.accent2); sp(img, 13, 0, p.accent2); sp(img, 14, 1, p.accent2)
    sp(img, 11, 1, p.accent2); sp(img, 11, 2, p.accent2)

    fill_ellipse(img, 8, 6, 3, 3, p.dark)
    fill_ellipse(img, 8, 6, 2, 2, p.mid)
    sp(img, 4, 4, p.dark); sp(img, 12, 4, p.dark)

    fill_ellipse(img, 8, 14, 4, 4, p.dark)
    fill_ellipse(img, 8, 13, 3, 3, p.mid)
    sp(img, 7, 12, p.accent); sp(img, 10, 13, p.accent); sp(img, 6, 15, p.accent)
    fill_rect(img, 7, 18, 3, 1, p.accent)

    lo = walk_offsets_front(walk_phase, anim)
    fill_rect(img, 5, 17, 2, 4+lo[0][1], p.dark)
    fill_rect(img, 10, 17, 2, 4+lo[1][1], p.dark)
    fill_rect(img, 6, 17, 2, 4+lo[2][1], p.dark)
    fill_rect(img, 9, 17, 2, 4+lo[3][1], p.dark)
    sp(img, 6, 20+lo[2][1], p.accent2); sp(img, 7, 20+lo[2][1], p.accent2)
    sp(img, 9, 20+lo[3][1], p.accent2); sp(img, 10, 20+lo[3][1], p.accent2)

    add_outline(img, p.outline)
    return img

def draw_deer_side(walk_phase=0, anim='walk'):
    img = create_frame()
    p = DEER

    # Tail
    sp(img, 2, 11, p.accent); sp(img, 3, 11, p.accent)

    # Body
    fill_ellipse(img, 7, 11, 5, 3, p.mid)
    fill_ellipse(img, 7, 10, 4, 2, p.light)
    sp(img, 5, 10, p.accent); sp(img, 8, 9, p.accent); sp(img, 6, 12, p.accent)

    # Neck
    fill_rect(img, 11, 8, 2, 3, p.mid)

    # Head — with muzzle extending forward, not droopy
    fill_ellipse(img, 12, 5, 3, 3, p.mid)
    fill_ellipse(img, 12, 5, 2, 2, p.light)
    # Muzzle — protruding forward at head center height
    fill_rect(img, 14, 5, 2, 2, p.mid)
    sp(img, 15, 7, p.dark)  # nose tip
    sp(img, 13, 4, p.eye)
    # Ears
    sp(img, 12, 3, p.mid); sp(img, 11, 3, p.light)

    # Antlers — curving backward (left) from head top
    sp(img, 11, 2, p.accent2); sp(img, 10, 1, p.accent2)  # main stem back
    sp(img, 9, 0, p.accent2); sp(img, 8, 0, p.accent2)    # tip curves back
    sp(img, 10, 0, p.accent2)                               # small branch up

    # 4 legs — 2px wide with forward hooves
    lo = walk_offsets_side(walk_phase, anim)
    draw_side_legs_2px(img, 3, 9, 14, 5, lo, p.dark, p.mid, p.accent2)

    add_outline(img, p.outline)
    return img


# ═══════════════════════════════════════
# RABBIT — gray/white, LONG ears, puffy tail, cute chibi
# ═══════════════════════════════════════

def draw_rabbit_front(walk_phase=0, anim='walk'):
    img = create_frame()
    p = RABBIT

    # LONG ears
    fill_rect(img, 4, 0, 2, 5, p.mid)
    sp(img, 4, 0, p.light); sp(img, 5, 1, p.accent); sp(img, 5, 2, p.accent)
    sp(img, 5, 3, p.accent)
    fill_rect(img, 11, 0, 2, 5, p.mid)
    sp(img, 12, 0, p.light); sp(img, 11, 1, p.accent); sp(img, 11, 2, p.accent)
    sp(img, 11, 3, p.accent)

    # Head (very big & round for max cuteness)
    fill_ellipse(img, 8, 7, 5, 4, p.mid)
    fill_ellipse(img, 8, 7, 4, 3, p.light)
    # Rosy cheeks
    sp(img, 5, 8, p.accent); sp(img, 11, 8, p.accent)
    # Eyes — 2px tall
    sp(img, 7, 6, p.eye); sp(img, 7, 7, p.eye)
    sp(img, 9, 6, p.eye); sp(img, 9, 7, p.eye)
    sp(img, 7, 6, p.light)  # highlight
    sp(img, 9, 6, p.light)  # highlight
    # Tiny pink nose
    sp(img, 8, 8, p.accent)
    # Small mouth
    sp(img, 8, 9, p.accent2)

    # Body (compact, below big head)
    fill_ellipse(img, 8, 15, 3, 3, p.mid)
    fill_ellipse(img, 8, 15, 2, 2, p.light)

    # Legs (hopping)
    hop = [0, 0, -1][walk_phase] if anim == 'walk' else 0
    fill_rect(img, 4, 18+hop, 3, 2, p.dark)
    fill_rect(img, 10, 18+hop, 3, 2, p.dark)
    fill_rect(img, 6, 17+hop, 2, 2, p.mid)
    fill_rect(img, 9, 17+hop, 2, 2, p.mid)

    add_outline(img, p.outline)
    return img

def draw_rabbit_back(walk_phase=0, anim='walk'):
    img = create_frame()
    p = RABBIT

    fill_rect(img, 4, 0, 2, 5, p.dark)
    fill_rect(img, 4, 0, 1, 5, p.mid)
    fill_rect(img, 11, 0, 2, 5, p.dark)
    fill_rect(img, 12, 0, 1, 5, p.mid)

    fill_ellipse(img, 8, 7, 5, 4, p.dark)
    fill_ellipse(img, 8, 7, 4, 3, p.mid)

    fill_ellipse(img, 8, 15, 3, 3, p.dark)
    fill_ellipse(img, 8, 15, 2, 2, p.mid)

    # PUFFY TAIL
    fill_ellipse(img, 8, 18, 2, 2, p.accent2)
    sp(img, 8, 18, p.light)

    hop = [0, 0, -1][walk_phase] if anim == 'walk' else 0
    fill_rect(img, 4, 18+hop, 3, 2, p.dark)
    fill_rect(img, 10, 18+hop, 3, 2, p.dark)
    fill_rect(img, 6, 17+hop, 2, 2, p.accent2)
    fill_rect(img, 9, 17+hop, 2, 2, p.accent2)

    add_outline(img, p.outline)
    return img

def draw_rabbit_side(walk_phase=0, anim='walk'):
    img = create_frame()
    p = RABBIT

    # Puffy tail
    fill_ellipse(img, 3, 14, 2, 2, p.accent2)
    sp(img, 2, 14, p.light); sp(img, 3, 14, p.light)

    # Body (connected to head with thick neck)
    fill_ellipse(img, 7, 14, 3, 3, p.mid)
    fill_ellipse(img, 7, 13, 2, 2, p.light)
    # Neck — fill gap between body and head
    fill_rect(img, 8, 10, 3, 3, p.mid)
    fill_rect(img, 9, 10, 2, 2, p.light)

    # Head (big and round — wider rx for side view)
    fill_ellipse(img, 10, 7, 4, 4, p.mid)
    fill_ellipse(img, 10, 7, 3, 3, p.light)
    # Rosy cheek
    sp(img, 12, 9, p.accent)
    # Eye (2px tall with highlight)
    sp(img, 12, 6, p.eye); sp(img, 12, 7, p.eye)
    sp(img, 12, 6, p.light)
    # Nose
    sp(img, 13, 8, p.accent)

    # Long ear
    fill_rect(img, 8, 0, 2, 5, p.mid)
    sp(img, 9, 0, p.accent); sp(img, 9, 1, p.accent); sp(img, 9, 2, p.accent)
    sp(img, 8, 0, p.light)

    # Legs
    hop = [0, 0, -1][walk_phase] if anim == 'walk' else 0
    fill_rect(img, 4, 17+hop, 2, 3, p.dark)
    fill_rect(img, 3, 19+hop, 3, 1, p.dark)
    fill_rect(img, 10, 17+hop, 2, 2, p.mid)
    fill_rect(img, 11, 18+hop, 2, 1, p.mid)

    add_outline(img, p.outline)
    return img


# ─── Frame Assembly ─── #

ANIMALS = [
    ('lion', draw_lion_front, draw_lion_back, draw_lion_side),
    ('bear', draw_bear_front, draw_bear_back, draw_bear_side),
    ('penguin', draw_penguin_front, draw_penguin_back, draw_penguin_side),
    ('fox', draw_fox_front, draw_fox_back, draw_fox_side),
    ('deer', draw_deer_front, draw_deer_back, draw_deer_side),
    ('rabbit', draw_rabbit_front, draw_rabbit_back, draw_rabbit_side),
]

def shift_frame_up(img, pixels):
    """Shift all non-transparent content up by N pixels to fill more of the frame."""
    new = Image.new('RGBA', img.size, TRANSPARENT)
    for y in range(img.height):
        for x in range(img.width):
            p = img.getpixel((x, y))
            if p[3] > 0:
                ny = y - pixels
                if 0 <= ny < img.height:
                    new.putpixel((x, ny), p)
    return new

# Shift zoo characters up 3px to match default theme size (default top≈3, zoo top≈7)
ZOO_SHIFT_UP = 3

def generate_frames(draw_fn):
    return [
        shift_frame_up(draw_fn(walk_phase=0, anim='walk'), ZOO_SHIFT_UP),
        shift_frame_up(draw_fn(walk_phase=1, anim='walk'), ZOO_SHIFT_UP),
        shift_frame_up(draw_fn(walk_phase=2, anim='walk'), ZOO_SHIFT_UP),
        shift_frame_up(draw_fn(walk_phase=0, anim='type'), ZOO_SHIFT_UP),
        shift_frame_up(draw_fn(walk_phase=1, anim='type'), ZOO_SHIFT_UP),
        shift_frame_up(draw_fn(walk_phase=0, anim='read'), ZOO_SHIFT_UP),
        shift_frame_up(draw_fn(walk_phase=1, anim='read'), ZOO_SHIFT_UP),
    ]

def assemble_character(front_fn, back_fn, side_fn):
    sheet = Image.new('RGBA', (NUM_FRAMES * FRAME_W, NUM_ROWS * FRAME_H), TRANSPARENT)
    for i, frame in enumerate(generate_frames(front_fn)):
        sheet.paste(frame, (i * FRAME_W, 0))
    for i, frame in enumerate(generate_frames(back_fn)):
        sheet.paste(frame, (i * FRAME_W, FRAME_H))
    for i, frame in enumerate(generate_frames(side_fn)):
        sheet.paste(frame, (i * FRAME_W, 2 * FRAME_H))
    return sheet

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(script_dir, '..', 'webview-ui', 'public', 'assets', 'characters-zoo')
    os.makedirs(out_dir, exist_ok=True)
    preview_dir = os.path.join(script_dir, 'source-sprites', 'preview')
    os.makedirs(preview_dir, exist_ok=True)

    for i, (name, front_fn, back_fn, side_fn) in enumerate(ANIMALS):
        print(f'Generating char_{i} ({name})...')
        sheet = assemble_character(front_fn, back_fn, side_fn)
        out_path = os.path.join(out_dir, f'char_{i}.png')
        sheet.save(out_path)
        print(f'  Saved {out_path}')

        idle = sheet.crop((FRAME_W, 0, 2*FRAME_W, FRAME_H))
        preview = idle.resize((FRAME_W*4, FRAME_H*4), Image.NEAREST)
        preview.save(os.path.join(preview_dir, f'zoo_{i}_8x.png'))

    compare = Image.new('RGBA', (FRAME_W * len(ANIMALS), FRAME_H), TRANSPARENT)
    for i, (_, front_fn, _, _) in enumerate(ANIMALS):
        compare.paste(front_fn(1, 'walk'), (i*FRAME_W, 0))
    compare.resize((compare.width*4, compare.height*4), Image.NEAREST).save(
        os.path.join(preview_dir, 'zoo_idle_compare.png'))

    side_compare = Image.new('RGBA', (FRAME_W * len(ANIMALS), FRAME_H), TRANSPARENT)
    for i, (_, _, _, side_fn) in enumerate(ANIMALS):
        side_compare.paste(side_fn(1, 'walk'), (i*FRAME_W, 0))
    side_compare.resize((side_compare.width*4, side_compare.height*4), Image.NEAREST).save(
        os.path.join(preview_dir, 'zoo_side_compare.png'))

    print('\nDone!')

if __name__ == '__main__':
    main()
