package com.pixelagents.intellij

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
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

    companion object {
        private val LOG = Logger.getInstance(TerminalDetector::class.java)
        private const val INITIAL_DELAY_MS = 2000L
        /** Bumped from 1.5s after profiling showed EDT pressure from the prior
         *  cadence (terminal contents read requires EDT and runs alongside
         *  other plugins doing the same). 3s is plenty for "user closed a
         *  terminal" UX and halves the EDT hops we cause. */
        private const val SCAN_INTERVAL_MS = 3000L
    }

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-TerminalDetector").apply { isDaemon = true }
    }
    private var scanTimer: ScheduledFuture<*>? = null
    private val trackedTerminals = ConcurrentHashMap.newKeySet<String>()
    /** Latest snapshot the EDT helper produced. Background thread reads this
     *  without blocking — `null` until the first EDT pass completes. */
    @Volatile private var cachedNames: Set<String>? = null
    @Volatile private var snapshotPending = false

    fun startScanning() {
        // Kick an initial EDT pass to seed the cache. Subsequent passes are
        // triggered from the background tick.
        requestSnapshotIfIdle()

        scanTimer = executor.scheduleWithFixedDelay({
            try {
                scanTerminals()
            } catch (_: Exception) {
            }
        }, INITIAL_DELAY_MS, SCAN_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun scanTerminals() {
        // Always request a fresh snapshot from the EDT for the *next* tick.
        // Then compare the cache from the previous EDT pass against our tracked
        // set. This is the key win versus the previous design: we never block
        // the background thread waiting for the EDT — we work on data that's
        // at most one scan interval (3s) stale.
        requestSnapshotIfIdle()
        val currentNames = cachedNames ?: return  // first pass hasn't landed yet

        // On the very first scan tick, just seed the tracked set without
        // emitting close events — those names existed before we started watching.
        if (trackedTerminals.isEmpty()) {
            trackedTerminals.addAll(currentNames)
            return
        }

        for (name in currentNames) trackedTerminals.add(name)

        val closed = trackedTerminals.filter { it !in currentNames }
        for (name in closed) {
            trackedTerminals.remove(name)
            LOG.info("Terminal closed: $name")
            onTerminalClosed(name)
        }
    }

    /**
     * Asynchronously asks the EDT for a fresh list of Terminal tool-window tabs.
     * The result lands in [cachedNames] when the EDT runs the runnable —
     * possibly several ms or seconds later under EDT pressure. We never block
     * waiting for it; the background tick reads whatever's there.
     *
     * `snapshotPending` prevents queueing a second EDT runnable if the previous
     * one hasn't finished — relevant only on a wedged EDT, where invokeAndWait
     * would have hung the scheduler indefinitely. The async pattern lets us
     * survive that scenario without our own thread starving.
     */
    private fun requestSnapshotIfIdle() {
        if (snapshotPending) return
        snapshotPending = true
        val app = ApplicationManager.getApplication()
        val collect = Runnable {
            val names = mutableSetOf<String>()
            try {
                val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                    .getToolWindow("Terminal")
                if (toolWindow != null) {
                    for (content in toolWindow.contentManager.contents) {
                        content.displayName?.let { names.add(it) }
                    }
                }
            } catch (e: Exception) {
                LOG.debug("Terminal snapshot read failed", e)
            } finally {
                cachedNames = names
                snapshotPending = false
            }
        }
        try {
            if (app.isDispatchThread) {
                collect.run()
            } else {
                app.invokeLater(collect, com.intellij.openapi.application.ModalityState.any())
            }
        } catch (e: Exception) {
            LOG.debug("invokeLater failed for terminal scan", e)
            snapshotPending = false
        }
    }

    override fun dispose() {
        scanTimer?.cancel(false)
        executor.shutdownNow()
    }
}
