package com.pixelagents.intellij

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.ui.scale.JBUIScale
import java.awt.GraphicsConfiguration
import java.awt.GraphicsEnvironment
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.event.HierarchyEvent
import java.awt.event.HierarchyListener
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.swing.JComponent

/**
 * Detects display reconfigurations that the JCEF browser must respond to:
 *
 *  1. Window moved to a different monitor with a different DPR.
 *  2. Monitor disconnect/reconnect that changes the OS-reported screen count.
 *  3. Resolution change on the current monitor.
 *
 * JCEF in OSR (off-screen rendering) mode pins its backbuffer to the GraphicsConfiguration
 * of the screen the browser was created on. When the underlying display changes, the
 * backbuffer stays at the old DPR — the canvas renders fuzzy or freezes entirely until
 * the browser is reloaded. Reloading rebinds JCEF to the new GraphicsConfiguration and
 * lets our webview pick up the fresh `window.devicePixelRatio` on initial layout.
 *
 * We pair two signals because Swing's HierarchyListener fires reliably for window moves
 * but is silent on cable-swap (the window stays put while the OS reassigns it to a
 * different physical screen). A low-frequency poll catches that case.
 */
class DisplayChangeWatcher(
    private val component: JComponent,
    private val onChange: (GraphicsConfiguration?) -> Unit,
) : Disposable {

    companion object {
        private val LOG = Logger.getInstance(DisplayChangeWatcher::class.java)
        private const val POLL_INTERVAL_MS = 10_000L
    }

    @Volatile private var lastGc: GraphicsConfiguration? = component.graphicsConfiguration
    @Volatile private var lastDpr: Float = runCatching { JBUIScale.sysScale(component) }.getOrDefault(1f)
    @Volatile private var lastScreenCount: Int = screenCountSafe()
    /** Window drag across monitors triggers a hierarchy/component event burst —
     *  10+ events over ~200ms is typical. We coalesce them by only allowing one
     *  in-flight EDT check at a time. The check runs once the EDT picks it up,
     *  reading the *current* GraphicsConfiguration / DPR, so we lose nothing by
     *  dropping intermediate events. */
    @Volatile private var pendingCheck = false

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-DisplayWatcher").apply { isDaemon = true }
    }
    private var pollTimer: ScheduledFuture<*>? = null
    private val hierarchyListener = HierarchyListener { e ->
        val flags = e.changeFlags
        if ((flags and HierarchyEvent.SHOWING_CHANGED.toLong()) != 0L
            || (flags and HierarchyEvent.PARENT_CHANGED.toLong()) != 0L
            || (flags and HierarchyEvent.DISPLAYABILITY_CHANGED.toLong()) != 0L) {
            checkOnEdt()
        }
    }
    private val componentListener = object : ComponentAdapter() {
        override fun componentMoved(e: ComponentEvent) = checkOnEdt()
        override fun componentResized(e: ComponentEvent) = checkOnEdt()
    }

    fun start() {
        component.addHierarchyListener(hierarchyListener)
        component.addComponentListener(componentListener)
        // 10s poll catches cable-swap cases where neither hierarchy nor component
        // listeners fire (the window stays put but the OS reassigns the physical screen).
        pollTimer = executor.scheduleWithFixedDelay(
            { runCatching { checkOnEdt() } },
            POLL_INTERVAL_MS, POLL_INTERVAL_MS, TimeUnit.MILLISECONDS,
        )
        LOG.info("DisplayChangeWatcher started: dpr=$lastDpr, screens=$lastScreenCount")
    }

    private fun checkOnEdt() {
        if (pendingCheck) return
        pendingCheck = true
        ApplicationManager.getApplication().invokeLater(
            {
                try {
                    check()
                } finally {
                    pendingCheck = false
                }
            },
            ModalityState.any(),
        ) { false }
    }

    private fun check() {
        // Hiding the tool window detaches the browser, so its configuration
        // reads null, and showing it attaches it again. Treating that as a
        // display change reloaded the whole webview on every hide/show and
        // threw away its state (camera, zoom). A detached browser has nothing
        // to rebind, so wait until it is shown and compare then; the first
        // configuration ever seen is only recorded.
        val gc = component.graphicsConfiguration ?: return
        if (lastGc == null) lastGc = gc
        val dpr = runCatching { JBUIScale.sysScale(component) }.getOrDefault(lastDpr)
        val screens = screenCountSafe()

        val gcChanged = gc != lastGc
        val dprChanged = dpr != lastDpr
        val screensChanged = screens != lastScreenCount

        if (gcChanged || dprChanged || screensChanged) {
            LOG.info(
                "Display change detected: gc=${if (gcChanged) "changed" else "same"}, " +
                "dpr=$lastDpr→$dpr, screens=$lastScreenCount→$screens"
            )
            lastGc = gc
            lastDpr = dpr
            lastScreenCount = screens
            onChange(gc)
        }
    }

    private fun screenCountSafe(): Int = try {
        GraphicsEnvironment.getLocalGraphicsEnvironment().screenDevices.size
    } catch (_: Exception) {
        1
    }

    override fun dispose() {
        try {
            component.removeHierarchyListener(hierarchyListener)
            component.removeComponentListener(componentListener)
        } catch (_: Exception) {
        }
        pollTimer?.cancel(false)
        executor.shutdownNow()
    }
}
