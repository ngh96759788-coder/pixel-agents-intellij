package com.pixelagents.intellij

import com.google.gson.Gson
import com.intellij.openapi.Disposable
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.project.Project
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.concurrent.*

class LayoutPersistence(projectBasePath: String?) : Disposable {

    private val gson = Gson()
    @Volatile
    private var skipNextChange = false
    @Volatile
    private var lastMtime = 0L
    private var pollTimer: ScheduledFuture<*>? = null
    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-LayoutWatch").apply { isDaemon = true }
    }

    /**
     * Per-project scope directory so multiple IntelliJ windows (each opened
     * on a different project) don't stomp on each other's layout / theme via
     * the shared ~/.pixel-agents/layout.json file. Falls back to "default"
     * when no base path is available.
     */
    private val scopeDir: String =
        projectBasePath?.replace(Regex("[:\\\\/]"), "-")?.ifBlank { null } ?: "default"

    private fun getLayoutFilePath(): String {
        return Paths.get(
            System.getProperty("user.home"),
            Constants.LAYOUT_FILE_DIR,
            scopeDir,
            Constants.LAYOUT_FILE_NAME
        ).toString()
    }

    fun readLayoutFromFile(): Map<String, Any?>? {
        val file = File(getLayoutFilePath())
        return try {
            if (!file.exists()) null
            else {
                @Suppress("UNCHECKED_CAST")
                gson.fromJson(file.readText(), Map::class.java) as? Map<String, Any?>
            }
        } catch (e: Exception) {
            println("[Pixel Agents] Failed to read layout file: $e")
            null
        }
    }

    fun writeLayoutToFile(layout: Map<String, Any?>) {
        val filePath = getLayoutFilePath()
        val file = File(filePath)
        try {
            file.parentFile?.mkdirs()
            val tmpFile = File("$filePath.tmp")
            tmpFile.writeText(gson.toJson(layout))
            atomicReplace(tmpFile, file)
        } catch (e: Exception) {
            println("[Pixel Agents] Failed to write layout file: $e")
        }
    }

    /**
     * Atomically replace `dst` with `src`.
     *
     * On Windows, `File.renameTo` returns false when the destination already
     * exists, which silently dropped the user's layout edits (sleuth C4).
     * We use `Files.move` with ATOMIC_MOVE + REPLACE_EXISTING; if the
     * filesystem can't do an atomic move, fall back to a plain replacing move
     * so the write at least succeeds.
     */
    private fun atomicReplace(src: File, dst: File) {
        val srcPath = src.toPath()
        val dstPath = dst.toPath()
        try {
            Files.move(
                srcPath, dstPath,
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(srcPath, dstPath, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    fun migrateAndLoadLayout(
        settings: PixelAgentsSettings,
        defaultLayout: Map<String, Any?>?
    ): Map<String, Any?>? {
        // 1. Try file (project-scoped path)
        readLayoutFromFile()?.let { return it }

        // NOTE: we intentionally do NOT fall back to the legacy global
        // ~/.pixel-agents/layout.json. Doing so shadowed the bundled default
        // (which ships with each release and reflects the author's latest
        // office layout) with a potentially stale user-saved copy. Users who
        // want to import an old layout can still do so via Import Layout.

        // 2. Try migrating from old settings
        val fromSettings = settings.savedLayout
        if (fromSettings != null) {
            @Suppress("UNCHECKED_CAST")
            val layout = try {
                gson.fromJson(fromSettings, Map::class.java) as? Map<String, Any?>
            } catch (_: Exception) {
                null
            }
            if (layout != null) {
                writeLayoutToFile(layout)
                settings.savedLayout = null
                return layout
            }
        }

        // 3. Use bundled default
        if (defaultLayout != null) {
            writeLayoutToFile(defaultLayout)
            return defaultLayout
        }

        return null
    }

    private fun getThemeLayoutFilePath(layoutFileName: String): String {
        return Paths.get(
            System.getProperty("user.home"),
            Constants.LAYOUT_FILE_DIR,
            scopeDir,
            layoutFileName
        ).toString()
    }

    fun readThemeLayoutFromFile(layoutFileName: String): Map<String, Any?>? {
        val file = File(getThemeLayoutFilePath(layoutFileName))
        return try {
            if (!file.exists()) null
            else {
                @Suppress("UNCHECKED_CAST")
                gson.fromJson(file.readText(), Map::class.java) as? Map<String, Any?>
            }
        } catch (e: Exception) {
            println("[Pixel Agents] Failed to read theme layout file: $e")
            null
        }
    }

    fun writeThemeLayoutToFile(layout: Map<String, Any?>, layoutFileName: String) {
        val filePath = getThemeLayoutFilePath(layoutFileName)
        val file = File(filePath)
        try {
            file.parentFile?.mkdirs()
            val tmpFile = File("$filePath.tmp")
            tmpFile.writeText(gson.toJson(layout))
            atomicReplace(tmpFile, file)
        } catch (e: Exception) {
            println("[Pixel Agents] Failed to write theme layout file: $e")
        }
    }

    fun markOwnWrite() {
        skipNextChange = true
        try {
            val file = File(getLayoutFilePath())
            if (file.exists()) lastMtime = file.lastModified()
        } catch (_: Exception) {
        }
    }

    fun startWatching(onExternalChange: (Map<String, Any?>) -> Unit) {
        try {
            val file = File(getLayoutFilePath())
            if (file.exists()) lastMtime = file.lastModified()
        } catch (_: Exception) {
        }

        pollTimer = executor.scheduleAtFixedRate({
            try {
                val file = File(getLayoutFilePath())
                if (!file.exists()) return@scheduleAtFixedRate
                val mtime = file.lastModified()
                if (mtime <= lastMtime) return@scheduleAtFixedRate
                lastMtime = mtime

                if (skipNextChange) {
                    skipNextChange = false
                    return@scheduleAtFixedRate
                }

                @Suppress("UNCHECKED_CAST")
                val layout = gson.fromJson(file.readText(), Map::class.java) as? Map<String, Any?>
                    ?: return@scheduleAtFixedRate
                println("[Pixel Agents] External layout change detected")
                onExternalChange(layout)
            } catch (e: Exception) {
                println("[Pixel Agents] Error checking layout file: $e")
            }
        }, Constants.LAYOUT_FILE_POLL_INTERVAL_MS, Constants.LAYOUT_FILE_POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    fun exportLayout(project: Project) {
        val layout = readLayoutFromFile() ?: return
        val descriptor = FileSaverDescriptor("Export Layout", "Export pixel agents layout", "json")
        val wrapper = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project)
        val result = wrapper.save("pixel-agents-layout.json") ?: return
        result.file.writeText(gson.toJson(layout))
    }

    @Suppress("UNCHECKED_CAST")
    fun importLayout(project: Project, sendToWebview: (String, Map<String, Any?>) -> Unit) {
        val descriptor = FileChooserDescriptor(true, false, false, false, false, false)
            .withFileFilter { it.extension == "json" }
        val files = FileChooser.chooseFiles(descriptor, project, null)
        if (files.isEmpty()) return
        try {
            val raw = File(files[0].path).readText()
            val imported = gson.fromJson(raw, Map::class.java) as? Map<String, Any?> ?: return
            if (imported["version"] != 1.0 || imported["tiles"] !is List<*>) return
            markOwnWrite()
            writeLayoutToFile(imported)
            sendToWebview("layoutLoaded", mapOf("layout" to imported))
        } catch (_: Exception) {
        }
    }

    override fun dispose() {
        pollTimer?.cancel(false)
        executor.shutdownNow()
    }
}
