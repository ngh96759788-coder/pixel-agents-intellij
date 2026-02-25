package com.pixelagents.intellij

import com.google.gson.Gson
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import javax.swing.JLabel

class PixelAgentsToolWindowFactory : ToolWindowFactory, DumbAware {

    companion object {
        private val LOG = Logger.getInstance(PixelAgentsToolWindowFactory::class.java)
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        LOG.info("Creating Pixel Agents tool window content")

        if (!JBCefApp.isSupported()) {
            LOG.warn("JCEF is not supported in this environment")
            val label = JLabel("JCEF is not supported in this environment. Pixel Agents requires a Chromium-based browser.")
            val content = toolWindow.contentManager.factory.createContent(label, "Pixel Agents", false)
            toolWindow.contentManager.addContent(content)
            return
        }

        try {
            val panel = PixelAgentsPanel(project)
            val content = toolWindow.contentManager.factory.createContent(
                panel.browser.component, "Pixel Agents", false
            )
            toolWindow.contentManager.addContent(content)
            Disposer.register(content, panel)
            LOG.info("Pixel Agents tool window created successfully")
        } catch (e: Exception) {
            LOG.error("Failed to create Pixel Agents panel", e)
            val label = JLabel("Failed to initialize Pixel Agents: ${e.message}")
            val content = toolWindow.contentManager.factory.createContent(label, "Pixel Agents", false)
            toolWindow.contentManager.addContent(content)
        }
    }
}

class PixelAgentsPanel(
    private val project: Project,
) : Disposable {

    companion object {
        private val LOG = Logger.getInstance(PixelAgentsPanel::class.java)
    }

    val browser: JBCefBrowser
    private val bridge: WebviewBridge
    private lateinit var agentManager: AgentManager
    private val fileWatcher: FileWatcher
    private val assetLoader = AssetLoader()
    private val layoutPersistence = LayoutPersistence()
    private val settings = PixelAgentsSettings.getInstance()
    private val gson = Gson()

    val nextAgentId = AtomicInteger(1)
    val nextTerminalIndex = AtomicInteger(1)
    val agents = ConcurrentHashMap<Int, AgentState>()
    val knownJsonlFiles: ConcurrentHashMap.KeySetView<String, Boolean> = ConcurrentHashMap.newKeySet()

    @Volatile
    var activeAgentId: Int? = null

    private var webviewDir: File? = null

    init {
        LOG.info("Initializing PixelAgentsPanel")
        browser = JBCefBrowser()

        bridge = WebviewBridge(browser) { message ->
            handleWebviewMessage(message)
        }

        val timerManager = TimerManager(
            sendToWebview = { type, payload -> bridge.sendToWebview(type, payload) },
            agents = agents,
        )

        fileWatcher = FileWatcher(
            sendToWebview = { type, payload -> bridge.sendToWebview(type, payload) },
            agents = agents,
            knownJsonlFiles = knownJsonlFiles,
            activeAgentIdRef = { activeAgentId },
            onNewAgentFile = null,
            persistAgents = { agentManager.persistAgents() },
            timerManager = timerManager,
        )

        agentManager = AgentManager(
            project = project,
            agents = agents,
            knownJsonlFiles = knownJsonlFiles,
            nextAgentId = nextAgentId,
            nextTerminalIndex = nextTerminalIndex,
            activeAgentIdRef = { activeAgentId },
            setActiveAgentId = { activeAgentId = it },
            sendToWebview = { type, payload -> bridge.sendToWebview(type, payload) },
            fileWatcher = fileWatcher,
            settings = settings,
        )

        // Extract webview resources from JAR to temp directory and load
        webviewDir = extractWebviewResources()
        if (webviewDir != null) {
            val indexFile = File(webviewDir, "index.html")
            // Pass real OS DPR as URL parameter so the inline <script> in index.html
            // can override window.devicePixelRatio BEFORE React initializes.
            // JCEF often reports devicePixelRatio=1 on HiDPI displays.
            val osScale = java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment()
                .defaultScreenDevice.defaultConfiguration.defaultTransform.scaleX
            val url = "${indexFile.toURI()}?dpr=$osScale"
            LOG.info("Loading webview from: $url (OS DPR=$osScale)")
            browser.loadURL(url)
        } else {
            LOG.warn("Failed to extract webview resources, showing error page")
            browser.loadHTML("<html><body><h1>Failed to load Pixel Agents webview</h1></body></html>")
        }
    }

    private fun extractWebviewResources(): File? {
        try {
            val classLoader = javaClass.classLoader

            // Check if webview/index.html exists in classpath
            val indexUrl = classLoader.getResource("webview/index.html")
            if (indexUrl != null) {
                LOG.info("Found webview resource at: $indexUrl (protocol: ${indexUrl.protocol})")

                if (indexUrl.protocol == "file") {
                    // Development mode: resources are on disk
                    val indexFile = File(indexUrl.toURI())
                    return indexFile.parentFile
                }

                if (indexUrl.protocol == "jar") {
                    // JAR mode: extract resources to temp directory
                    val tempDir = Files.createTempDirectory("pixel-agents-webview").toFile()
                    tempDir.deleteOnExit()

                    val jarPath = java.net.URLDecoder.decode(
                        indexUrl.path.substringAfter("file:").substringBefore("!"), "UTF-8"
                    )
                    val jarFile = java.util.jar.JarFile(jarPath)
                    val entries = jarFile.entries()
                    while (entries.hasMoreElements()) {
                        val entry = entries.nextElement()
                        if (entry.name.startsWith("webview/") && !entry.isDirectory) {
                            val targetFile = File(tempDir, entry.name.removePrefix("webview/"))
                            targetFile.parentFile?.mkdirs()
                            jarFile.getInputStream(entry).use { input ->
                                Files.copy(input, targetFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
                            }
                        }
                    }
                    jarFile.close()
                    LOG.info("Extracted webview resources to: $tempDir")
                    return tempDir
                }
            }

            // Fallback: check project directory for development builds
            val projectBase = project.basePath
            if (projectBase != null) {
                val distWebview = File(projectBase, "dist/webview/index.html")
                if (distWebview.exists()) {
                    LOG.info("Using development webview from: ${distWebview.parentFile}")
                    return distWebview.parentFile
                }
            }

            LOG.warn("Could not find webview resources anywhere")
            return null
        } catch (e: Exception) {
            LOG.error("Failed to extract webview resources", e)
            return null
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun handleWebviewMessage(message: Map<String, Any?>) {
        val type = message["type"] as? String ?: return

        when (type) {
            "webviewReady" -> onWebviewReady()
            "openClaude" -> agentManager.launchNewTerminal()
            "focusAgent" -> {
                val id = (message["id"] as? Number)?.toInt() ?: return
                agentManager.focusAgent(id)
            }
            "closeAgent" -> {
                val id = (message["id"] as? Number)?.toInt() ?: return
                agentManager.closeAgent(id)
            }
            "saveAgentSeats" -> {
                val seats = message["seats"]
                settings.agentSeats = gson.toJson(seats)
            }
            "saveLayout" -> {
                val layout = message["layout"] as? Map<String, Any?>
                if (layout != null) {
                    layoutPersistence.markOwnWrite()
                    layoutPersistence.writeLayoutToFile(layout)
                }
            }
            "setSoundEnabled" -> {
                val enabled = message["enabled"] as? Boolean ?: true
                settings.soundEnabled = enabled
            }
            "openSessionsFolder" -> {
                agentManager.openSessionsFolder()
            }
            "exportLayout" -> {
                layoutPersistence.exportLayout(project)
            }
            "importLayout" -> {
                layoutPersistence.importLayout(project) { msgType, payload ->
                    bridge.sendToWebview(msgType, payload)
                }
            }
        }
    }

    private fun onWebviewReady() {
        // 1. Send settings
        bridge.sendToWebview("settingsLoaded", mapOf("soundEnabled" to settings.soundEnabled))

        // 2. Restore agents
        agentManager.restoreAgents()

        // 3. Load and send assets (on background thread)
        ApplicationManager.getApplication().executeOnPooledThread {
            loadAndSendAssets()
        }

        // 4. Start project scan
        val projectDir = agentManager.getProjectDirPath()
        if (projectDir != null) {
            fileWatcher.ensureProjectScan(projectDir)
        }

        // 5. Send existing agents
        agentManager.sendExistingAgents()

        // 6. Start layout watcher
        layoutPersistence.startWatching { layout ->
            bridge.sendToWebview("layoutLoaded", mapOf("layout" to layout))
        }
    }

    private fun loadAndSendAssets() {
        // Find assets directory
        val assetsDir = findAssetsDirectory()
        if (assetsDir != null) {
            assetLoader.loadAllAssets(assetsDir) { type, payload ->
                bridge.sendToWebview(type, payload)
            }
        }

        // Send layout
        val layout = layoutPersistence.migrateAndLoadLayout(settings, assetLoader.defaultLayout)
        bridge.sendToWebview("layoutLoaded", mapOf("layout" to layout))
    }

    private fun findAssetsDirectory(): File? {
        // Check extracted webview directory first (works for both JAR and file modes)
        val extractedAssets = webviewDir?.let { File(it, "assets") }
        if (extractedAssets != null && extractedAssets.exists()) {
            LOG.info("Found assets in extracted webview dir: ${extractedAssets.absolutePath}")
            return extractedAssets
        }

        // Check plugin resources (classpath, development mode)
        val resourceUrl = javaClass.classLoader.getResource("webview/assets")
        if (resourceUrl != null) {
            try {
                if (resourceUrl.protocol == "file") {
                    return File(resourceUrl.toURI())
                }
            } catch (_: Exception) {
            }
        }

        // Check dist/webview/assets in project (development mode fallback)
        val projectBase = project.basePath
        if (projectBase != null) {
            val devAssets = File(projectBase, "dist/webview/assets")
            if (devAssets.exists()) return devAssets

            // Also check webview-ui/public/assets
            val publicAssets = File(projectBase, "webview-ui/public/assets")
            if (publicAssets.exists()) return publicAssets
        }

        LOG.warn("Could not find assets directory anywhere")
        return null
    }

    override fun dispose() {
        layoutPersistence.dispose()
        fileWatcher.dispose()
        agentManager.dispose()
        bridge.dispose()
    }
}
