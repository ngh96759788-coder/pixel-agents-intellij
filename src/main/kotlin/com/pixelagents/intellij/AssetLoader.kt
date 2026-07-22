package com.pixelagents.intellij

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.intellij.openapi.diagnostic.Logger
import java.awt.image.BufferedImage
import java.io.File
import java.io.InputStream
import javax.imageio.ImageIO

class AssetLoader {

    companion object {
        private val LOG = Logger.getInstance(AssetLoader::class.java)
    }

    private val gson = Gson()
    var defaultLayout: Map<String, Any?>? = null
        private set

    fun loadAllAssets(
        assetsDir: File,
        charSubdir: String = "characters",
        floorFilename: String = "floors.png",
        wallFilename: String = "walls.png",
        theme: String = Constants.THEME_DEFAULT,
        furnitureDir: String = "furniture",
        defaultLayoutFile: String = "default-layout.json",
        onAssetReady: (type: String, payload: Map<String, Any?>) -> Unit
    ) {
        // Load default layout (themed)
        defaultLayout = loadDefaultLayout(assetsDir, defaultLayoutFile)

        // Load character sprites
        val charSprites = loadCharacterSprites(assetsDir, charSubdir)
        if (charSprites != null) {
            onAssetReady("characterSpritesLoaded", mapOf("characters" to charSprites, "theme" to theme))
        }

        // Load floor tiles
        val floorTiles = loadFloorTiles(assetsDir, floorFilename)
        if (floorTiles != null) {
            onAssetReady("floorTilesLoaded", mapOf("sprites" to floorTiles))
        }

        // Load wall tiles
        val wallTiles = loadWallTiles(assetsDir, wallFilename)
        if (wallTiles != null) {
            onAssetReady("wallTilesLoaded", mapOf("sprites" to wallTiles))
        }

        // Load furniture assets (themed)
        val furniture = loadFurnitureAssets(assetsDir, furnitureDir)
        if (furniture != null) {
            onAssetReady("furnitureAssetsLoaded", furniture)
        }
    }

    private fun imageRegionToSpriteData(
        img: BufferedImage, ox: Int, oy: Int, w: Int, h: Int
    ): List<List<String>> {
        val sprite = mutableListOf<List<String>>()
        for (y in 0 until h) {
            val row = mutableListOf<String>()
            for (x in 0 until w) {
                val pixel = img.getRGB(ox + x, oy + y)
                val a = (pixel shr 24) and 0xFF
                if (a < Constants.PNG_ALPHA_THRESHOLD) {
                    row.add("")
                } else {
                    val r = (pixel shr 16) and 0xFF
                    val g = (pixel shr 8) and 0xFF
                    val b = pixel and 0xFF
                    row.add(
                        "#${r.toString(16).padStart(2, '0')}${
                            g.toString(16).padStart(2, '0')
                        }${b.toString(16).padStart(2, '0')}".uppercase()
                    )
                }
            }
            sprite.add(row)
        }
        return sprite
    }

    fun loadDefaultLayout(assetsDir: File, layoutFilename: String = "default-layout.json"): Map<String, Any?>? {
        try {
            val layoutFile = File(assetsDir, layoutFilename)
            if (!layoutFile.exists()) {
                LOG.warn("No default-layout.json found at: ${layoutFile.absolutePath}")
                return null
            }
            val content = layoutFile.readText()
            @Suppress("UNCHECKED_CAST")
            val layout = gson.fromJson(content, Map::class.java) as Map<String, Any?>
            LOG.info("Loaded default layout")
            return layout
        } catch (e: Exception) {
            LOG.warn("loading default layout", e)
            return null
        }
    }

    fun loadCharacterSprites(assetsDir: File, charSubdir: String = "characters"): List<Map<String, Any>>? {
        try {
            val charDir = File(assetsDir, charSubdir)
            val characters = mutableListOf<Map<String, Any>>()

            // Dynamically detect available character files (char_0.png, char_1.png, ...)
            var ci = 0
            while (true) {
                val file = File(charDir, "char_$ci.png")
                if (!file.exists()) break
                ci++
            }
            val charCount = ci
            if (charCount == 0) {
                LOG.info("No character sprites found in: ${charDir.absolutePath}")
                return null
            }

            for (charIdx in 0 until charCount) {
                val file = File(charDir, "char_$charIdx.png")

                // ImageIO.read returns null (not throws) for unrecognized/corrupt PNGs.
                // Without this guard, a broken theme PNG crashes the whole asset load
                // and no characters ever appear in the webview (sleuth H3).
                val img = ImageIO.read(file)
                if (img == null) {
                    LOG.warn("Invalid character PNG, skipping: ${file.absolutePath}")
                    continue
                }
                val charData = mutableMapOf<String, Any>()

                for ((dirIdx, dir) in Constants.CHARACTER_DIRECTIONS.withIndex()) {
                    val rowOffsetY = dirIdx * Constants.CHAR_FRAME_H
                    val frames = mutableListOf<List<List<String>>>()

                    for (f in 0 until Constants.CHAR_FRAMES_PER_ROW) {
                        val frameOffsetX = f * Constants.CHAR_FRAME_W
                        val sprite = imageRegionToSpriteData(
                            img, frameOffsetX, rowOffsetY,
                            Constants.CHAR_FRAME_W, Constants.CHAR_FRAME_H
                        )
                        frames.add(sprite)
                    }
                    charData[dir] = frames
                }
                characters.add(charData)
            }

            LOG.info("Loaded ${characters.size} character sprites")
            return characters
        } catch (e: Exception) {
            LOG.warn("loading character sprites", e)
            return null
        }
    }

    fun loadFloorTiles(assetsDir: File, floorFilename: String = "floors.png"): List<List<List<String>>>? {
        try {
            val floorFile = File(assetsDir, floorFilename)
            if (!floorFile.exists()) {
                LOG.warn("No floors.png found")
                return null
            }

            val img = ImageIO.read(floorFile) ?: run {
                LOG.warn("Invalid floors PNG, skipping: ${floorFile.absolutePath}")
                return null
            }
            val sprites = mutableListOf<List<List<String>>>()

            for (t in 0 until Constants.FLOOR_PATTERN_COUNT) {
                val sprite = imageRegionToSpriteData(
                    img, t * Constants.FLOOR_TILE_SIZE, 0,
                    Constants.FLOOR_TILE_SIZE, Constants.FLOOR_TILE_SIZE
                )
                sprites.add(sprite)
            }

            LOG.info("Loaded ${sprites.size} floor tile patterns")
            return sprites
        } catch (e: Exception) {
            LOG.warn("loading floor tiles", e)
            return null
        }
    }

    fun loadWallTiles(assetsDir: File, wallFilename: String = "walls.png"): List<List<List<String>>>? {
        try {
            val wallFile = File(assetsDir, wallFilename)
            if (!wallFile.exists()) {
                LOG.warn("No walls.png found")
                return null
            }

            val img = ImageIO.read(wallFile) ?: run {
                LOG.warn("Invalid walls PNG, skipping: ${wallFile.absolutePath}")
                return null
            }
            val sprites = mutableListOf<List<List<String>>>()

            for (mask in 0 until Constants.WALL_BITMASK_COUNT) {
                val ox = (mask % Constants.WALL_GRID_COLS) * Constants.WALL_PIECE_WIDTH
                val oy = (mask / Constants.WALL_GRID_COLS) * Constants.WALL_PIECE_HEIGHT
                val sprite = imageRegionToSpriteData(
                    img, ox, oy,
                    Constants.WALL_PIECE_WIDTH, Constants.WALL_PIECE_HEIGHT
                )
                sprites.add(sprite)
            }

            LOG.info("Loaded ${sprites.size} wall tile pieces")
            return sprites
        } catch (e: Exception) {
            LOG.warn("loading wall tiles", e)
            return null
        }
    }

    @Suppress("UNCHECKED_CAST")
    fun loadFurnitureAssets(assetsDir: File, furnitureDir: String = "furniture"): Map<String, Any?>? {
        try {
            var effectiveDir = furnitureDir
            val catalogFile = File(assetsDir, "$effectiveDir/furniture-catalog.json")
            if (!catalogFile.exists()) {
                if (effectiveDir != "furniture") {
                    LOG.info("No furniture catalog for theme dir '$effectiveDir', falling back to 'furniture'")
                    effectiveDir = "furniture"
                    val fallbackCatalog = File(assetsDir, "$effectiveDir/furniture-catalog.json")
                    if (!fallbackCatalog.exists()) {
                        LOG.info("No furniture catalog found at: ${fallbackCatalog.absolutePath}")
                        return null
                    }
                } else {
                    LOG.info("No furniture catalog found at: ${catalogFile.absolutePath}")
                    return null
                }
            }

            val effectiveCatalogFile = File(assetsDir, "$effectiveDir/furniture-catalog.json")
            val catalogContent = effectiveCatalogFile.readText()
            val catalogData = gson.fromJson(catalogContent, Map::class.java) as Map<String, Any?>
            val catalog = catalogData["assets"] as? List<Map<String, Any?>> ?: emptyList()

            val sprites = mutableMapOf<String, List<List<String>>>()

            for (asset in catalog) {
                try {
                    val id = asset["id"] as? String ?: continue
                    val width = (asset["width"] as? Number)?.toInt() ?: continue
                    val height = (asset["height"] as? Number)?.toInt() ?: continue
                    var filePath = asset["file"] as? String ?: continue
                    if (!filePath.startsWith("assets/")) {
                        filePath = "assets/$filePath"
                    }

                    // assetsDir is the 'assets' folder, so we need to go up one level
                    val assetFile = File(assetsDir.parentFile, filePath)
                    if (!assetFile.exists()) {
                        LOG.info("Asset file not found: $filePath")
                        continue
                    }

                    val img = ImageIO.read(assetFile)
                    if (img == null) {
                        LOG.warn("Invalid furniture PNG, skipping: ${assetFile.absolutePath}")
                        continue
                    }
                    val spriteData = imageRegionToSpriteData(img, 0, 0, width, height)
                    sprites[id] = spriteData
                } catch (e: Exception) {
                    LOG.warn("loading furniture asset", e)
                }
            }

            LOG.info("Loaded ${sprites.size} / ${catalog.size} furniture assets")
            return mapOf("catalog" to catalog, "sprites" to sprites)
        } catch (e: Exception) {
            LOG.warn("loading furniture assets", e)
            return null
        }
    }
}
