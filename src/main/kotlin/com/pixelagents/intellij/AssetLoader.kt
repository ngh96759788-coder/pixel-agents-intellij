package com.pixelagents.intellij

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.awt.image.BufferedImage
import java.io.File
import java.io.InputStream
import javax.imageio.ImageIO

class AssetLoader {

    private val gson = Gson()
    var defaultLayout: Map<String, Any?>? = null
        private set

    fun loadAllAssets(
        assetsDir: File,
        onAssetReady: (type: String, payload: Map<String, Any?>) -> Unit
    ) {
        // Load default layout
        defaultLayout = loadDefaultLayout(assetsDir)

        // Load character sprites
        val charSprites = loadCharacterSprites(assetsDir)
        if (charSprites != null) {
            onAssetReady("characterSpritesLoaded", mapOf("characters" to charSprites))
        }

        // Load floor tiles
        val floorTiles = loadFloorTiles(assetsDir)
        if (floorTiles != null) {
            onAssetReady("floorTilesLoaded", mapOf("sprites" to floorTiles))
        }

        // Load wall tiles
        val wallTiles = loadWallTiles(assetsDir)
        if (wallTiles != null) {
            onAssetReady("wallTilesLoaded", mapOf("sprites" to wallTiles))
        }

        // Load furniture assets
        val furniture = loadFurnitureAssets(assetsDir)
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

    private fun loadDefaultLayout(assetsDir: File): Map<String, Any?>? {
        try {
            val layoutFile = File(assetsDir, "default-layout.json")
            if (!layoutFile.exists()) {
                println("[AssetLoader] No default-layout.json found at: ${layoutFile.absolutePath}")
                return null
            }
            val content = layoutFile.readText()
            @Suppress("UNCHECKED_CAST")
            val layout = gson.fromJson(content, Map::class.java) as Map<String, Any?>
            println("[AssetLoader] Loaded default layout")
            return layout
        } catch (e: Exception) {
            println("[AssetLoader] Error loading default layout: $e")
            return null
        }
    }

    private fun loadCharacterSprites(assetsDir: File): List<Map<String, Any>>? {
        try {
            val charDir = File(assetsDir, "characters")
            val characters = mutableListOf<Map<String, Any>>()

            for (ci in 0 until Constants.CHAR_COUNT) {
                val file = File(charDir, "char_$ci.png")
                if (!file.exists()) {
                    println("[AssetLoader] No character sprite found at: ${file.absolutePath}")
                    return null
                }

                val img = ImageIO.read(file)
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

            println("[AssetLoader] Loaded ${characters.size} character sprites")
            return characters
        } catch (e: Exception) {
            println("[AssetLoader] Error loading character sprites: $e")
            return null
        }
    }

    private fun loadFloorTiles(assetsDir: File): List<List<List<String>>>? {
        try {
            val floorFile = File(assetsDir, "floors.png")
            if (!floorFile.exists()) {
                println("[AssetLoader] No floors.png found")
                return null
            }

            val img = ImageIO.read(floorFile)
            val sprites = mutableListOf<List<List<String>>>()

            for (t in 0 until Constants.FLOOR_PATTERN_COUNT) {
                val sprite = imageRegionToSpriteData(
                    img, t * Constants.FLOOR_TILE_SIZE, 0,
                    Constants.FLOOR_TILE_SIZE, Constants.FLOOR_TILE_SIZE
                )
                sprites.add(sprite)
            }

            println("[AssetLoader] Loaded ${sprites.size} floor tile patterns")
            return sprites
        } catch (e: Exception) {
            println("[AssetLoader] Error loading floor tiles: $e")
            return null
        }
    }

    private fun loadWallTiles(assetsDir: File): List<List<List<String>>>? {
        try {
            val wallFile = File(assetsDir, "walls.png")
            if (!wallFile.exists()) {
                println("[AssetLoader] No walls.png found")
                return null
            }

            val img = ImageIO.read(wallFile)
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

            println("[AssetLoader] Loaded ${sprites.size} wall tile pieces")
            return sprites
        } catch (e: Exception) {
            println("[AssetLoader] Error loading wall tiles: $e")
            return null
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun loadFurnitureAssets(assetsDir: File): Map<String, Any?>? {
        try {
            val catalogFile = File(assetsDir, "furniture/furniture-catalog.json")
            if (!catalogFile.exists()) {
                println("[AssetLoader] No furniture catalog found at: ${catalogFile.absolutePath}")
                return null
            }

            val catalogContent = catalogFile.readText()
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
                        println("[AssetLoader] Asset file not found: $filePath")
                        continue
                    }

                    val img = ImageIO.read(assetFile)
                    val spriteData = imageRegionToSpriteData(img, 0, 0, width, height)
                    sprites[id] = spriteData
                } catch (e: Exception) {
                    println("[AssetLoader] Error loading furniture asset: $e")
                }
            }

            println("[AssetLoader] Loaded ${sprites.size} / ${catalog.size} furniture assets")
            return mapOf("catalog" to catalog, "sprites" to sprites)
        } catch (e: Exception) {
            println("[AssetLoader] Error loading furniture assets: $e")
            return null
        }
    }
}
