package com.pixelagents.intellij

import com.google.gson.Gson
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
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
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.awt.BorderLayout
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants

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
                panel.component, "Pixel Agents", false
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

    /** Hosts the browser component. The browser itself can be replaced when
     *  JCEF dies, so the tool window holds this wrapper rather than it. */
    val component = JPanel(BorderLayout())
    @Volatile private lateinit var browser: JBCefBrowser
    @Volatile private lateinit var bridge: WebviewBridge
    private val webviewWatchdog = WebviewWatchdog(
        staleMs = Constants.WEBVIEW_STALE_MS,
        recoveryWaitMs = Constants.WEBVIEW_RECOVERY_WAIT_MS,
    )
    @Volatile private var watchdogTickPending = false
    @Volatile private var disposed = false
    private val watchdogExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-WebviewWatchdog").apply { isDaemon = true }
    }
    private val timerManager: TimerManager
    private lateinit var agentManager: AgentManager
    private val fileWatcher: FileWatcher
    private lateinit var instanceManifest: InstanceManifest
    private var displayWatcher: DisplayChangeWatcher? = null
    /** Last URL passed to JCEF — kept so we can reload with a fresh cache-buster
     *  on display change without rebuilding the path from scratch. */
    @Volatile private var lastLoadedUrl: String? = null
    /** Last `active` value pushed to the webview. The ToolWindowManagerListener
     *  fires on EVERY tool window in the project (Project view, Terminal, etc.),
     *  so without this guard we'd spam executeJavaScript with redundant events. */
    @Volatile private var lastNotifiedActive: Boolean? = null
    private val assetLoader = AssetLoader()
    private val layoutPersistence = LayoutPersistence(project.basePath)
    private lateinit var terminalDetector: TerminalDetector
    private var worktreeDetector: WorktreeDetector? = null
    private var quotaTracker: QuotaWindowTracker? = null
    private val settings = PixelAgentsSettings.getInstance(project)
    private val gson = Gson()

    val nextAgentId = AtomicInteger(1)
    val nextTerminalIndex = AtomicInteger(1)
    val agents = ConcurrentHashMap<Int, AgentState>()
    val knownJsonlFiles: ConcurrentHashMap.KeySetView<String, Boolean> = ConcurrentHashMap.newKeySet()

    @Volatile
    var activeAgentId: Int? = null

    private var webviewDir: File? = null
    @Volatile private var assetsDir: File? = null
    private val assetLoadLock = Object() // Prevents race between loadAndSendAssets and setTheme
    /** True after first onWebviewReady. Subsequent webview reloads only resync state — they
     *  must NOT spawn new schedulers, periodic discoveries, or terminal detectors. */
    private val infrastructureStarted = java.util.concurrent.atomic.AtomicBoolean(false)

    init {
        LOG.info("Initializing PixelAgentsPanel")
        attachNewBrowser()

        timerManager = TimerManager(
            sendToWebview = { type, payload -> bridge.sendToWebview(type, payload) },
            agents = agents,
        )

        instanceManifest = InstanceManifest()
        instanceManifest.start()

        // After laptop suspend/resume, the heartbeat thread may not fire for a
        // while, leaving us looking dead to peers. Hook the IDE's "frame
        // activated" event so we re-stamp our heartbeat the moment the user
        // touches the IDE again. Cheap and closes the wake-up race window.
        try {
            val connection = ApplicationManager.getApplication().messageBus.connect(this)
            connection.subscribe(
                com.intellij.openapi.application.ApplicationActivationListener.TOPIC,
                object : com.intellij.openapi.application.ApplicationActivationListener {
                    override fun applicationActivated(ideFrame: com.intellij.openapi.wm.IdeFrame) {
                        instanceManifest.touchHeartbeat()
                    }
                },
            )
        } catch (e: Exception) {
            LOG.warn("Failed to register activation listener for manifest heartbeat", e)
        }

        // Tool-window visibility bridge: when the user collapses the Pixel
        // Agents tool window or switches to a different one, push a
        // pixel-agent:set-active=false event into the webview so its gameLoop
        // can pause. Resume when visible again. Saves CPU + reduces the
        // window where a frozen JCEF compositor matters.
        try {
            val projectBus = project.messageBus.connect(this)
            projectBus.subscribe(
                com.intellij.openapi.wm.ex.ToolWindowManagerListener.TOPIC,
                object : com.intellij.openapi.wm.ex.ToolWindowManagerListener {
                    override fun stateChanged(toolWindowManager: com.intellij.openapi.wm.ToolWindowManager) {
                        val tw = toolWindowManager.getToolWindow("Pixel Agents") ?: return
                        notifyActiveToJs(tw.isVisible)
                    }
                },
            )
        } catch (e: Exception) {
            LOG.warn("Failed to register tool window visibility listener", e)
        }

        fileWatcher = FileWatcher(
            sendToWebview = { type, payload -> bridge.sendToWebview(type, payload) },
            agents = agents,
            knownJsonlFiles = knownJsonlFiles,
            activeAgentIdRef = { activeAgentId },
            onNewAgentFile = null,
            persistAgents = { agentManager.persistAgents() },
            timerManager = timerManager,
            instanceManifest = instanceManifest,
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
            instanceManifest = instanceManifest,
        )

        // Adopt unowned JSONLs (e.g. user typed `claude` directly in this
        // window's terminal) as own agents. Peer-owned sessions are filtered
        // upstream in FileWatcher so we never accidentally claim work that
        // belongs to another IDE window.
        fileWatcher.onNewAgentFile = { path -> agentManager.adoptAgent(path) }
        // Unified view (BEHAVIOR_SPEC §4): sessions discovered outside this
        // window's own project/worktree dirs are adopted as EXTERNAL (faded)
        // agents. Only ever fires while the toggle is ON (external discovery
        // timer is stopped otherwise).
        fileWatcher.onExternalAgentFile = { path -> agentManager.adoptExternalAgent(path) }
        // Clean up orphaned async sub-agents when their file watcher times out
        fileWatcher.onSubagentTimeout = { agentId, parentToolId ->
            agentManager.clearOrphanedSubagent(agentId, parentToolId)
        }

        // Extract webview resources from JAR to temp directory and load
        webviewDir = extractWebviewResources()
        if (webviewDir != null) {
            val indexFile = File(webviewDir, "index.html")
            // Pass real OS DPR as URL parameter so the inline <script> in index.html
            // can override window.devicePixelRatio BEFORE React initializes.
            // JCEF often reports devicePixelRatio=1 on HiDPI displays.
            val osScale = java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment()
                .defaultScreenDevice.defaultConfiguration.defaultTransform.scaleX
            val url = "${indexFile.toURI()}?dpr=$osScale&_cb=${System.currentTimeMillis()}"
            LOG.info("Loading webview from: $url (OS DPR=$osScale)")
            lastLoadedUrl = url
            browser.loadURL(url)
            watchDisplayChanges()
            watchdogExecutor.scheduleWithFixedDelay(
                { checkWebviewAlive() },
                Constants.WEBVIEW_PING_INTERVAL_MS,
                Constants.WEBVIEW_PING_INTERVAL_MS,
                TimeUnit.MILLISECONDS,
            )
        } else {
            LOG.warn("Failed to extract webview resources, showing error page")
            browser.loadHTML("<html><body><h1>Failed to load Pixel Agents webview</h1></body></html>")
        }
    }

    /** Creates the browser and its JS bridge and puts the browser in [component].
     *  Used at start-up and again when a dead JCEF has to be replaced. */
    private fun attachNewBrowser() {
        val newBrowser = JBCefBrowser()
        val newBridge = WebviewBridge(
            browser = newBrowser,
            onMessage = { message -> handleWebviewMessage(message) },
            onAlive = { webviewAlive() },
            onRenderProcessGone = { reason -> onRenderProcessGone(reason) },
        )
        browser = newBrowser
        bridge = newBridge
        component.removeAll()
        component.add(newBrowser.component, BorderLayout.CENTER)
        component.revalidate()
        component.repaint()
    }

    // Reload the webview when the user drags the IDE window to a different
    // monitor or unplugs/replugs a display. JCEF OSR caches a backbuffer at
    // the DPR of the GraphicsConfiguration it was created on; a fresh load
    // is the simplest way to make it pick up the new DPR. We also tell the
    // JS side via a CustomEvent so the canvas can resize immediately
    // (without waiting for the reload round trip) for the common case
    // where the JCEF backbuffer is still usable.
    private fun watchDisplayChanges() {
        displayWatcher?.dispose()
        displayWatcher = DisplayChangeWatcher(browser.component) { _ ->
            notifyDprChangeToJs()
            reloadWebview("display change")
        }.also { it.start() }
    }

    private fun webviewAlive() {
        synchronized(webviewWatchdog) { webviewWatchdog.onAlive() }
    }

    /** Runs the watchdog on the EDT, one tick at a time. While the EDT is
     *  frozen no tick runs and no ping goes out, so a frozen IDE cannot pile up
     *  reload/recreate/give-up decisions that fire the moment it unfreezes. */
    private fun checkWebviewAlive() {
        if (disposed || watchdogTickPending) return
        watchdogTickPending = true
        ApplicationManager.getApplication().invokeLater({
            try {
                tickWebviewWatchdog()
            } finally {
                watchdogTickPending = false
            }
        }, com.intellij.openapi.application.ModalityState.any())
    }

    private fun tickWebviewWatchdog() {
        if (disposed) return
        try {
            val now = System.currentTimeMillis()
            val action = synchronized(webviewWatchdog) { webviewWatchdog.tick(now) }
            when (action) {
                WebviewWatchdog.Action.PING -> if (bridge.ping()) {
                    synchronized(webviewWatchdog) { webviewWatchdog.onPingDelivered(now) }
                }
                WebviewWatchdog.Action.RELOAD -> {
                    LOG.warn("Webview silent for ${Constants.WEBVIEW_STALE_MS / 1000}s, reloading")
                    reloadWebview("webview silent")
                }
                WebviewWatchdog.Action.RECREATE -> {
                    LOG.warn("Webview still silent after reloading, recreating the browser")
                    recreateBrowser()
                }
                WebviewWatchdog.Action.GIVE_UP -> {
                    LOG.warn("Webview still silent after recreating the browser; JCEF looks gone, asking for an IDE restart")
                    showJcefGone()
                }
                WebviewWatchdog.Action.IDLE -> {}
            }
        } catch (e: Exception) {
            LOG.warn("Webview watchdog tick failed", e)
        }
    }

    private fun onRenderProcessGone(reason: String) {
        if (disposed) return
        LOG.warn("Webview renderer process terminated: $reason")
        val action = synchronized(webviewWatchdog) { webviewWatchdog.onRenderProcessGone(System.currentTimeMillis()) }
        when (action) {
            WebviewWatchdog.Action.RELOAD -> reloadWebview("renderer terminated")
            WebviewWatchdog.Action.RECREATE -> recreateBrowser()
            WebviewWatchdog.Action.GIVE_UP -> showJcefGone()
            WebviewWatchdog.Action.PING, WebviewWatchdog.Action.IDLE -> {}
        }
    }

    /** Shown in place of the dead browser once recovery has failed. The IDE
     *  does not restart its JCEF process, so a restart is the real fix; "Try
     *  again" covers the cases where recreating does help. */
    private fun showJcefGone() {
        ApplicationManager.getApplication().invokeLater({
            if (disposed) return@invokeLater
            val message = JLabel(
                "<html><center>The IDE's built-in browser (JCEF) stopped, so Pixel Agents cannot draw.<br>" +
                    "Restarting the IDE brings it back.</center></html>",
                SwingConstants.CENTER,
            )
            val restart = JButton("Restart IDE").apply {
                addActionListener { ApplicationManager.getApplication().restart() }
            }
            val retry = JButton("Try again").apply {
                addActionListener {
                    synchronized(webviewWatchdog) { webviewWatchdog.onManualRetry(System.currentTimeMillis()) }
                    recreateBrowser()
                }
            }
            val buttons = JPanel().apply {
                add(restart)
                add(retry)
            }
            val fallback = JPanel(BorderLayout()).apply {
                add(message, BorderLayout.CENTER)
                add(buttons, BorderLayout.SOUTH)
            }
            // Detaching the browser looks like a display change to the watcher,
            // which would reload the dead browser; stop it first.
            displayWatcher?.dispose()
            displayWatcher = null
            component.removeAll()
            component.add(fallback, BorderLayout.CENTER)
            component.revalidate()
            component.repaint()
            NotificationGroupManager.getInstance().getNotificationGroup("Pixel Agents")
                .createNotification(
                    "Pixel Agents stopped drawing",
                    "The IDE's built-in browser (JCEF) stopped. Restart the IDE to bring the office back.",
                    NotificationType.WARNING,
                )
                .addAction(NotificationAction.createSimpleExpiring("Restart IDE") {
                    ApplicationManager.getApplication().restart()
                })
                .notify(project)
        }, com.intellij.openapi.application.ModalityState.any())
    }

    /** Replaces the browser with a new one. A reload cannot help once the whole
     *  JCEF process is gone (seen on 2026.1: `cef_server` exited while the IDE
     *  kept running), because the old browser has nothing left to talk to. */
    private fun recreateBrowser() {
        val baseUrl = lastLoadedUrl ?: return
        ApplicationManager.getApplication().invokeLater({
            if (disposed) return@invokeLater
            val oldBrowser = browser
            val oldBridge = bridge
            try {
                attachNewBrowser()
                lastNotifiedActive = null
                val url = "${baseUrl.substringBefore('?')}?dpr=${currentOsScale()}&_cb=${System.currentTimeMillis()}"
                lastLoadedUrl = url
                browser.loadURL(url)
                watchDisplayChanges()
                LOG.info("Recreated the webview browser")
            } catch (e: Exception) {
                LOG.warn("Recreating the webview browser failed", e)
            }
            try {
                oldBridge.dispose()
                oldBrowser.dispose()
            } catch (e: Exception) {
                LOG.warn("Disposing the dead webview browser failed", e)
            }
        }, com.intellij.openapi.application.ModalityState.any())
    }

    private fun currentOsScale(): Double = java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment()
        .defaultScreenDevice.defaultConfiguration.defaultTransform.scaleX

    /** Push a tool-window visibility hint into the webview. gameLoop pauses
     *  while inactive, saving CPU when the user has the panel collapsed. */
    private fun notifyActiveToJs(active: Boolean) {
        if (lastNotifiedActive == active) return
        lastNotifiedActive = active
        try {
            val js = "window.dispatchEvent(new CustomEvent('pixel-agent:set-active',{detail:{active:$active}}));"
            browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
        } catch (e: Exception) {
            LOG.warn("notifyActiveToJs failed", e)
        }
    }

    /** Push a CustomEvent into the webview so the canvas + overlays can rescale
     *  to the new devicePixelRatio without waiting for a full reload. The JS
     *  side reads `window.devicePixelRatio` directly at handler time. */
    private fun notifyDprChangeToJs() {
        try {
            val js = "window.dispatchEvent(new CustomEvent('pixel-agent:display-change',{detail:{ts:${System.currentTimeMillis()}}}));"
            browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
        } catch (e: Exception) {
            LOG.warn("notifyDprChangeToJs failed", e)
        }
    }

    /** Recompute the OS DPR and reload the webview with a fresh cache-buster.
     *  Re-binds JCEF OSR to the current GraphicsConfiguration so its backbuffer
     *  picks up the new DPR. */
    private fun reloadWebview(reason: String) {
        val baseUrl = lastLoadedUrl ?: return
        ApplicationManager.getApplication().invokeLater({
            if (disposed) return@invokeLater
            try {
                val osScale = currentOsScale()
                // Strip any prior query and rebuild — the URL fragment holds the path,
                // we just refresh the dpr + cache buster.
                val base = baseUrl.substringBefore('?')
                val url = "$base?dpr=$osScale&_cb=${System.currentTimeMillis()}"
                lastLoadedUrl = url
                lastNotifiedActive = null
                LOG.info("Reloading webview ($reason): dpr=$osScale")
                browser.loadURL(url)
            } catch (e: Exception) {
                LOG.warn("reloadWebview failed", e)
            }
        }, com.intellij.openapi.application.ModalityState.any())
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
                    // use {} ensures the JarFile handle is always closed even if an
                    // extraction throws — avoids leaking a file descriptor for the
                    // lifetime of the JVM (M9 / reviewer Top 5 #3).
                    java.util.jar.JarFile(jarPath).use { jarFile ->
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
                    }
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
                @Suppress("UNCHECKED_CAST")
                val layout = message["layout"] as? Map<String, Any?>
                if (layout != null) {
                    val currentTheme = settings.theme
                    if (currentTheme == Constants.THEME_DEFAULT) {
                        // Default theme: write to layout.json (the canonical file)
                        layoutPersistence.markOwnWrite()
                        layoutPersistence.writeLayoutToFile(layout)
                    }
                    // Always save to theme-specific file
                    val themeLayoutFile = Constants.THEME_LAYOUT_FILES[currentTheme]
                    if (themeLayoutFile != null) {
                        layoutPersistence.writeThemeLayoutToFile(layout, themeLayoutFile)
                    }
                }
            }
            "setSoundEnabled" -> {
                val enabled = message["enabled"] as? Boolean ?: true
                settings.soundEnabled = enabled
            }
            "setSharedLayoutAcrossProjects" -> {
                // Toggles the cross-project layout sharing switch.
                // - OFF (default): each IntelliJ project has its own scope
                //   dir, so layouts/themes don't stomp each other.
                // - ON: every project reads/writes ~/.pixel-agents/shared/…
                //   so changes propagate across all open IntelliJ windows.
                // When flipping ON for the first time, migrate the project's
                // current layout into the shared scope (only if shared is
                // empty) so the user doesn't see an unexpected blank office.
                val enabled = message["enabled"] as? Boolean ?: false
                val app = PixelAgentsAppSettings.getInstance()
                if (app.sharedLayoutAcrossProjects == enabled) return

                val previousLayout = layoutPersistence.readLayoutFromFile()
                app.sharedLayoutAcrossProjects = enabled
                layoutPersistence.refreshAfterScopeChange()

                val newScopeLayout = layoutPersistence.readLayoutFromFile()
                val finalLayout = if (newScopeLayout == null && previousLayout != null) {
                    // New scope is empty — seed it with the previous one so
                    // the visible office doesn't go blank on toggle.
                    layoutPersistence.markOwnWrite()
                    layoutPersistence.writeLayoutToFile(previousLayout)
                    previousLayout
                } else {
                    newScopeLayout
                }

                if (finalLayout != null) {
                    bridge.sendToWebview("layoutLoaded", mapOf("layout" to finalLayout))
                }
            }
            "setUnifiedView" -> {
                // BEHAVIOR_SPEC §4 "통합 보기" toggle.
                // - ON:  start periodic external discovery so peer / foreign
                //        ~/.claude/projects sessions surface as faded agents.
                // - OFF: stop discovery and close every external agent already
                //        adopted (no terminal is killed — externals have none),
                //        then resync so the webview drops them.
                val enabled = message["enabled"] as? Boolean ?: false
                PixelAgentsAppSettings.getInstance().unifiedView = enabled
                if (enabled) {
                    startExternalDiscovery()
                } else {
                    fileWatcher.stopExternalDiscovery()
                    agentManager.closeAllExternalAgents()
                }
                agentManager.sendExistingAgents()
            }
            "setOverlayDefault" -> {
                // Single message dispatches the 4 always-on overlay toggles.
                // Webview sends { kind: 'identityDot' | 'tokenBar' | 'status' | 'tether', enabled: Boolean }.
                val kind = message["kind"] as? String ?: return
                val enabled = message["enabled"] as? Boolean ?: false
                when (kind) {
                    "identityDot" -> settings.alwaysShowIdentityDot = enabled
                    "tokenBar" -> settings.alwaysShowTokenBar = enabled
                    "status" -> settings.alwaysShowStatus = enabled
                    "tether" -> settings.alwaysShowTether = enabled
                    else -> LOG.warn("Unknown overlay toggle kind: $kind")
                }
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
            "setTheme" -> {
                val theme = message["theme"] as? String ?: Constants.THEME_DEFAULT
                val validTheme = if (theme in Constants.VALID_THEMES) theme else Constants.THEME_DEFAULT
                val previousTheme = settings.theme
                if (validTheme == previousTheme) return
                LOG.info("Theme changed: $previousTheme -> $validTheme")

                // 1. Save current layout to previous theme's file SYNCHRONOUSLY
                //    (before changing settings.theme, so saveLayout messages still write
                //    to the correct theme file during the async asset reload)
                val prevLayoutFile = Constants.THEME_LAYOUT_FILES[previousTheme] ?: "layout-default.json"
                // Read from the correct source for the previous theme:
                // - Default theme: layout.json is canonical
                // - Other themes: use their own theme file (NOT layout.json, which has office data)
                val currentLayout = if (previousTheme == Constants.THEME_DEFAULT) {
                    layoutPersistence.readLayoutFromFile()
                } else {
                    layoutPersistence.readThemeLayoutFromFile(prevLayoutFile)
                }
                if (currentLayout != null) {
                    layoutPersistence.writeThemeLayoutToFile(currentLayout, prevLayoutFile)
                    LOG.info("Saved layout to $prevLayoutFile")
                }

                // 2. NOW change the theme setting
                settings.theme = validTheme

                // 3. Reload all themed assets on background thread
                // Fallback: if initial loadAndSendAssets hasn't completed yet (rare), retry the lookup.
                val dir = assetsDir ?: findAssetsDirectory()?.also { this.assetsDir = it }
                if (dir == null) {
                    LOG.warn("setTheme: assets directory not available — visual theme will not update until reload. settings.theme is still persisted as $validTheme.")
                } else {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        synchronized(assetLoadLock) {
                            val charSubdir = Constants.THEME_CHAR_DIRS[validTheme] ?: "characters"
                            val floorFile = Constants.THEME_FLOOR_FILES[validTheme] ?: "floors.png"
                            val wallFile = Constants.THEME_WALL_FILES[validTheme] ?: "walls.png"
                            val furnitureDir = Constants.THEME_FURNITURE_DIRS[validTheme] ?: "furniture"

                            val charSprites = assetLoader.loadCharacterSprites(dir, charSubdir)
                            if (charSprites != null) {
                                bridge.sendToWebview("characterSpritesLoaded", mapOf("characters" to charSprites, "theme" to validTheme))
                            }

                            val floorTiles = assetLoader.loadFloorTiles(dir, floorFile)
                            if (floorTiles != null) {
                                bridge.sendToWebview("floorTilesLoaded", mapOf("sprites" to floorTiles))
                            }

                            val wallTiles = assetLoader.loadWallTiles(dir, wallFile)
                            if (wallTiles != null) {
                                bridge.sendToWebview("wallTilesLoaded", mapOf("sprites" to wallTiles))
                            }

                            val furniture = assetLoader.loadFurnitureAssets(dir, furnitureDir)
                            if (furniture != null) {
                                bridge.sendToWebview("furnitureAssetsLoaded", furniture)
                            }

                            // 4. Load theme layout (user-saved -> bundled default)
                            val themeLayoutFile = Constants.THEME_LAYOUT_FILES[validTheme] ?: "layout-default.json"
                            var themeLayout = layoutPersistence.readThemeLayoutFromFile(themeLayoutFile)
                            if (themeLayout == null) {
                                val defaultLayoutFile = Constants.THEME_DEFAULT_LAYOUTS[validTheme] ?: "default-layout.json"
                                themeLayout = assetLoader.loadDefaultLayout(dir, defaultLayoutFile)
                                if (themeLayout != null) {
                                    layoutPersistence.writeThemeLayoutToFile(themeLayout, themeLayoutFile)
                                }
                            }
                            LOG.info("Loaded layout for theme $validTheme from ${if (themeLayout != null) themeLayoutFile else "bundled default"}")

                            // 5. For default theme, sync to layout.json; for others, only use theme file
                            if (validTheme == Constants.THEME_DEFAULT && themeLayout != null) {
                                layoutPersistence.markOwnWrite()
                                layoutPersistence.writeLayoutToFile(themeLayout)
                            }

                            // 6. Send layout + themeChanged to webview
                            if (themeLayout != null) {
                                bridge.sendToWebview("layoutLoaded", mapOf("layout" to themeLayout))
                            }
                            bridge.sendToWebview("themeChanged", mapOf("theme" to validTheme))
                        }
                    }
                }
            }
        }
    }

    /** Kick off unified-view external discovery over ~/.claude/projects.
     *  Idempotent — FileWatcher no-ops if a discovery timer is already running. */
    private fun startExternalDiscovery() {
        val root = Paths.get(System.getProperty("user.home"), ".claude", "projects").toString()
        fileWatcher.startExternalDiscovery(root)
    }

    private fun onWebviewReady() {
        // Steps 1, 3, 5: state resync — safe to repeat on every webview reload.
        // 1. Send settings
        bridge.sendToWebview("settingsLoaded", mapOf(
            "soundEnabled" to settings.soundEnabled,
            "theme" to settings.theme,
            "alwaysShowIdentityDot" to settings.alwaysShowIdentityDot,
            "alwaysShowTokenBar" to settings.alwaysShowTokenBar,
            "alwaysShowStatus" to settings.alwaysShowStatus,
            "alwaysShowTether" to settings.alwaysShowTether,
            "sharedLayoutAcrossProjects" to PixelAgentsAppSettings.getInstance().sharedLayoutAcrossProjects,
            "unifiedView" to PixelAgentsAppSettings.getInstance().unifiedView,
        ))

        // 3. Load and send assets (on background thread)
        ApplicationManager.getApplication().executeOnPooledThread {
            loadAndSendAssets()
        }

        // 5. Send existing agents (empty on fresh start; fileWatcher may adopt running terminals)
        agentManager.sendExistingAgents()

        // A reloaded or recreated page starts out active; tell it the real
        // tool-window visibility so a hidden panel does not keep animating.
        com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
            .getToolWindow("Pixel Agents")?.let { notifyActiveToJs(it.isVisible) }

        // Refresh the 5h token HUD immediately on webview (re)load — a fresh
        // webview starts at 0 and would otherwise wait up to a minute for the
        // next scheduled tick. No-op before infrastructure start.
        quotaTracker?.pushNow()

        // Infrastructure (steps 4, 6, 7, 8) — start ONCE per IDE session. JCEF can fire
        // webviewReady multiple times (panel toggle, IDE repaint), and re-running these
        // would leak schedulers, file watchers, and TerminalDetector instances each time.
        if (!infrastructureStarted.compareAndSet(false, true)) return

        // 3a. Rolling 5h token-usage HUD (BEHAVIOR_SPEC §3): scan
        // ~/.claude/projects JSONL usage once a minute, push absolute tokens.
        quotaTracker = QuotaWindowTracker { type, payload ->
            bridge.sendToWebview(type, payload)
        }.also { it.start() }

        // 4. Start project scan (detects running Claude terminals)
        val projectDir = agentManager.getProjectDirPath()
        if (projectDir != null) {
            fileWatcher.ensureProjectScan(projectDir)
        }

        // 4a. Watch git worktrees of THIS repo (IntelliJ 2026.1 hands tasks off
        //     to agents running in worktrees, whose cwd → a different Claude
        //     project-hash dir than basePath). Scoped to the open repo only —
        //     NOT the global cross-project discovery disabled in 4b. Worktree
        //     dirs are registered as `trusted` so adoption skips the
        //     process-ancestry check (handed-off agents may run detached) while
        //     peer-ownership still guards against cross-window duplicates.
        worktreeDetector = WorktreeDetector(
            basePath = project.basePath,
            projectDirForCwd = { cwd -> agentManager.getProjectDirPath(cwd) },
            onWorktreeProjectDir = { dir, _, branch ->
                fileWatcher.ensureProjectScan(dir, trusted = true)
                if (branch != null) fileWatcher.registerWorktreeBranch(dir, branch)
            },
        ).also { it.start() }

        // 4b. Cross-project discovery is intentionally OFF. The previous
        //     implementation iterated every subdir of ~/.claude/projects/ and
        //     spun up a scanner for any with recent activity — which meant the
        //     pixel-agents window happily adopted JSONLs from totally
        //     unrelated projects (e.g. a billing-backend session running in
        //     another IntelliJ window). `hasOwnClaudeDescendant` only proves
        //     *some* claude is descendant of this IDE, not that THIS JSONL is
        //     written by it, so it lets the foreign sessions through. Sticking
        //     to the IDE basePath project + instance manifest peer-ownership
        //     is the per-window-isolated behavior the user actually wants.

        // 4c. Unified view (BEHAVIOR_SPEC §4): the toggle-gated re-enablement of
        //     cross-project discovery from 4b. When the persisted setting is ON,
        //     start external discovery now that the own-project (step 4) and
        //     worktree (step 4a) scanners are registered — they define the dirs
        //     external discovery must SKIP (their sessions stay normal/opaque).
        if (PixelAgentsAppSettings.getInstance().unifiedView) {
            startExternalDiscovery()
        }

        // 6. Start layout watcher
        layoutPersistence.startWatching { layout ->
            bridge.sendToWebview("layoutLoaded", mapOf("layout" to layout))
        }

        // 7. Start terminal detector (detect closed terminals only — no auto-creation)
        terminalDetector = TerminalDetector(
            project = project,
            onTerminalClosed = { name -> agentManager.onTerminalClosed(name) },
        )
        terminalDetector.startScanning()

        // Note: Claude Desktop activity is intentionally NOT mirrored into
        // this IntelliJ window. Each surface (IDE plugin, future standalone
        // app, the MCP-bridge browser view) owns its own office and only
        // shows the agents born in that surface. The mcp-bridge module
        // serves Claude Desktop's office to a localhost browser tab; this
        // window only renders Claude Code work from ~/.claude/projects.

        // 8. Start session alive check (removes agents when Claude process exits)
        agentManager.startSessionAliveCheck()
    }

    private fun loadAndSendAssets() {
        synchronized(assetLoadLock) {
            // Find assets directory
            val dir = findAssetsDirectory()
            this.assetsDir = dir

            // Capture theme ONCE to avoid race with setTheme
            val currentTheme = settings.theme

            if (dir != null) {
                // Load with themed assets
                val charSubdir = Constants.THEME_CHAR_DIRS[currentTheme] ?: "characters"
                val floorFile = Constants.THEME_FLOOR_FILES[currentTheme] ?: "floors.png"
                val wallFile = Constants.THEME_WALL_FILES[currentTheme] ?: "walls.png"
                val furnitureDir = Constants.THEME_FURNITURE_DIRS[currentTheme] ?: "furniture"
                val defaultLayoutFile = Constants.THEME_DEFAULT_LAYOUTS[currentTheme] ?: "default-layout.json"
                assetLoader.loadAllAssets(dir, charSubdir, floorFile, wallFile, currentTheme, furnitureDir, defaultLayoutFile) { type, payload ->
                    bridge.sendToWebview(type, payload)
                }
            }

            // Send layout — theme-aware (using same captured currentTheme)
            var layout: Map<String, Any?>? = null

            // For non-default themes: try theme-specific saved layout → bundled themed default
            if (currentTheme != Constants.THEME_DEFAULT) {
                val themeLayoutFile = Constants.THEME_LAYOUT_FILES[currentTheme] ?: "layout-default.json"
                layout = layoutPersistence.readThemeLayoutFromFile(themeLayoutFile)
                if (layout != null) {
                    val rows = (layout["rows"] as? Number)?.toInt()
                    val cols = (layout["cols"] as? Number)?.toInt()
                    LOG.info("[Zoo Debug] Loaded SAVED layout from $themeLayoutFile: ${cols}x${rows}")
                }
                if (layout == null) {
                    // Use the themed bundled default (e.g. default-layout-alien.json)
                    layout = assetLoader.defaultLayout
                    if (layout != null) {
                        val rows = (layout["rows"] as? Number)?.toInt()
                        val cols = (layout["cols"] as? Number)?.toInt()
                        LOG.info("[Zoo Debug] Using BUNDLED default layout: ${cols}x${rows}")
                        layoutPersistence.writeThemeLayoutToFile(layout, themeLayoutFile)
                    }
                }
                // NOTE: Do NOT write themed layout to layout.json — it corrupts the office layout.
                // Each theme has its own file (layout-zoo.json, layout-alien.json, etc.)
            }

            // Default theme or fallback: use standard migration path
            if (layout == null) {
                layout = layoutPersistence.migrateAndLoadLayout(settings, assetLoader.defaultLayout)
            }

            bridge.sendToWebview("layoutLoaded", mapOf("layout" to layout))
        }
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
        disposed = true
        watchdogExecutor.shutdownNow()
        displayWatcher?.dispose()
        if (::terminalDetector.isInitialized) terminalDetector.dispose()
        worktreeDetector?.dispose()
        quotaTracker?.dispose()
        if (::instanceManifest.isInitialized) instanceManifest.stop()
        layoutPersistence.dispose()
        fileWatcher.dispose()
        agentManager.dispose()
        timerManager.dispose()
        bridge.dispose()
        // Dispose the JCEF browser LAST — after bridge.dispose() has torn down
        // its JBCefJSQuery (which holds a handle into this browser). Without
        // this, each tool-window recreation leaks an off-heap Chromium renderer.
        browser.dispose()
    }
}
