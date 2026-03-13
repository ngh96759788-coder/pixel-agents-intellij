"""
Generate floors-zoo.png: 7 grayscale 16x16 tiles with natural grass texture.
Colorized at runtime via HSL. "Let's Build a Zoo" style — small tuft clusters.

Tile 1-2: Light grass (2 variants, alternated in layout)
Tile 3:   Dirt path
Tile 4-5: Enclosure grass (2 variants, slightly darker)
Tile 6-7: Extra variants
"""

import os
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
ASSETS_DIR = os.path.join(PROJECT_DIR, 'webview-ui', 'public', 'assets')
TILE = 16


def hash_noise(x, y, seed):
    """Deterministic pseudo-random per-pixel noise."""
    n = (x * 374761393 + y * 668265263 + seed * 1274126177) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1103515245 + 12345) & 0xFFFFFFFF
    return (n >> 16) & 0xFF


def make_grass_tile(seed, base, tuft_chance=0.08, tuft_dark=20, tuft_light=12, noise_range=4):
    """Natural grass tile using small tuft clusters instead of vertical blades.

    Tufts are 2-3 pixel clusters (like short grass patches viewed from above).
    Much more natural than individual vertical lines.
    """
    img = Image.new('RGBA', (TILE, TILE))
    px = img.load()

    # Pass 1: base + gentle noise
    for y in range(TILE):
        for x in range(TILE):
            noise = (hash_noise(x, y, seed) % (noise_range * 2 + 1)) - noise_range
            px[x, y] = (max(0, min(255, base + noise)),) * 3 + (255,)

    # Pass 2: tuft clusters — small dark patches (2-3 connected pixels)
    for y in range(TILE):
        for x in range(TILE):
            h = hash_noise(x, y, seed + 100)
            if h < int(tuft_chance * 256):
                # Dark tuft center
                r = px[x, y][0]
                px[x, y] = (max(0, r - tuft_dark),) * 3 + (255,)

                # Extend tuft in a random direction (1-2 neighbors)
                direction = hash_noise(x, y, seed + 200) % 4
                dx, dy = [(1, 0), (0, 1), (-1, 0), (0, -1)][direction]
                nx, ny = (x + dx) % TILE, (y + dy) % TILE
                r2 = px[nx, ny][0]
                px[nx, ny] = (max(0, r2 - int(tuft_dark * 0.7)),) * 3 + (255,)

                # Sometimes extend one more pixel
                if hash_noise(x, y, seed + 300) < 100:
                    nx2, ny2 = (nx + dx) % TILE, (ny + dy) % TILE
                    r3 = px[nx2, ny2][0]
                    px[nx2, ny2] = (max(0, r3 - int(tuft_dark * 0.4)),) * 3 + (255,)

    # Pass 3: bright highlight spots (light catching grass tips)
    for y in range(TILE):
        for x in range(TILE):
            h = hash_noise(x, y, seed + 400)
            if h < int(tuft_chance * 0.5 * 256):
                r = px[x, y][0]
                px[x, y] = (min(255, r + tuft_light),) * 3 + (255,)

    return img


def make_dirt_tile(seed, base=162):
    """Dirt/path tile with subtle sandy texture."""
    img = Image.new('RGBA', (TILE, TILE))
    px = img.load()

    for y in range(TILE):
        for x in range(TILE):
            noise = (hash_noise(x, y, seed) % 9) - 4
            v = base + noise

            # Small pebbles
            if hash_noise(x, y, seed + 3000) < 15:
                v += 10
            # Dark specks
            if hash_noise(x, y, seed + 4000) < 8:
                v -= 12

            px[x, y] = (max(0, min(255, v)),) * 3 + (255,)

    return img


def main():
    tiles = [
        # Tile 1-2: Light grass (general area)
        make_grass_tile(seed=42, base=158, tuft_chance=0.09, tuft_dark=18, tuft_light=10),
        make_grass_tile(seed=137, base=160, tuft_chance=0.08, tuft_dark=16, tuft_light=11),
        # Tile 3: Dirt path
        make_dirt_tile(seed=73),
        # Tile 4-5: Enclosure grass (slightly denser tufts, slightly darker base)
        make_grass_tile(seed=201, base=152, tuft_chance=0.12, tuft_dark=22, tuft_light=10),
        make_grass_tile(seed=314, base=154, tuft_chance=0.11, tuft_dark=20, tuft_light=10),
        # Tile 6-7: Extra variants
        make_grass_tile(seed=88, base=159, tuft_chance=0.07, tuft_dark=15, tuft_light=12),
        make_grass_tile(seed=55, base=153, tuft_chance=0.10, tuft_dark=19, tuft_light=10),
    ]

    # Combine into 112x16 strip
    result = Image.new('RGBA', (TILE * 7, TILE))
    for i, tile in enumerate(tiles):
        result.paste(tile, (i * TILE, 0))

    out = os.path.join(ASSETS_DIR, 'floors-zoo.png')
    result.save(out)
    print(f"Saved: {out}")

    # Generate colorized tiled preview
    from colorsys import hls_to_rgb

    def colorize(base_img, h, s, b):
        res = base_img.copy()
        pi, po = base_img.load(), res.load()
        hn, sn = h / 360, s / 100
        for y in range(base_img.height):
            for x in range(base_img.width):
                r, g, bl, a = pi[x, y]
                if a < 128: continue
                lum = max(0, min(1, (r * 0.299 + g * 0.587 + bl * 0.114) / 255 + b / 100))
                nr, ng, nb = hls_to_rgb(hn, lum, sn)
                po[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
        return res

    # Colors: reduced contrast between grass and enclosure grass
    grass_color = {'h': 108, 's': 50, 'b': -3}      # lighter, less saturated
    enc_color = {'h': 112, 's': 55, 'b': -8}         # only slightly darker
    path_color = {'h': 38, 's': 30, 'b': 12}

    scale = 4
    grid = 8
    sections = [
        ("Grass 1+2", (0, 1), grass_color),
        ("Enclosure 4+5", (3, 4), enc_color),
        ("Path 3", (2,), path_color),
    ]

    pw = TILE * grid * scale
    ph = TILE * grid * scale
    preview = Image.new('RGBA', (pw * 3 + 40, ph), (30, 30, 46, 255))

    for si, (label, tile_indices, color) in enumerate(sections):
        ox = si * (pw + 20)
        for gy in range(grid):
            for gx in range(grid):
                ti = tile_indices[(gx + gy) % len(tile_indices)]
                colored = colorize(tiles[ti], color['h'], color['s'], color['b'])
                big = colored.resize((TILE * scale, TILE * scale), Image.NEAREST)
                preview.paste(big, (ox + gx * TILE * scale, gy * TILE * scale), big)

    prev_path = os.path.join(PROJECT_DIR, 'zoo_floors_preview.png')
    preview.save(prev_path)
    print(f"Preview: {prev_path}")


if __name__ == '__main__':
    main()
