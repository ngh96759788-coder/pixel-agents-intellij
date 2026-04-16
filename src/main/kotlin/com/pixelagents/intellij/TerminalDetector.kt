package com.pixelagents.intellij

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Tracks IDE terminal lifecycle for agent cleanup.
 * Does NOT create agents — only detects when terminals close
 * so their associated agents can be removed.
 */
class TerminalDetector(
    private val project: Project,
    private val onTerminalClosed: (terminalName: String) -> Unit,
) : Disposable {

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-TerminalDetector").apply { isDaemon = true }
    }
    private var scanTimer: ScheduledFuture<*>? = null
    private val trackedTerminals = ConcurrentHashMap.newKeySet<String>()

    fun startScanning() {
        // Snapshot all currently-open terminals so we can detect future closes
        snapshotExistingTerminals()

        scanTimer = executor.scheduleAtFixedRate({
            try {
                scanTerminals()
            } catch (_: Exception) {
            }
        }, INITIAL_DELAY_MS, SCAN_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun snapshotExistingTerminals() {
        for (name in getCurrentTerminalNames()) {
            trackedTerminals.add(name)
        }
    }

    private fun scanTerminals() {
        val currentNames = getCurrentTerminalNames()

        // Track any new terminals (for close detection later)
        for (name in currentNames) {
            trackedTerminals.add(name)
        }

        // Detect closed terminals
        val closed = trackedTerminals.filter { it !in currentNames }
        for (name in closed) {
            trackedTerminals.remove(name)
            println("[Pixel Agents] Terminal closed: $name")
            onTerminalClosed(name)
        }
    }

    private fun getCurrentTerminalNames(): Set<String> {
        val names = mutableSetOf<String>()
        try {
            val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                .getToolWindow("Terminal") ?: return names
            for (content in toolWindow.contentManager.contents) {
                content.displayName?.let { names.add(it) }
            }
        } catch (_: Exception) {
        }
        return names
    }

    override fun dispose() {
        scanTimer?.cancel(false)
        executor.shutdownNow()
    }

    companion object {
        private const val INITIAL_DELAY_MS = 2000L
        private const val SCAN_INTERVAL_MS = 1500L
    }
}
