package com.pixelagents.intellij

import com.intellij.openapi.Disposable
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.*
import java.util.concurrent.*

class FileWatcher(
    private val sendToWebview: (String, Map<String, Any?>) -> Unit,
    private val agents: ConcurrentHashMap<Int, AgentState>,
    private val knownJsonlFiles: ConcurrentHashMap.KeySetView<String, Boolean>,
    private val activeAgentIdRef: () -> Int?,
    var onNewAgentFile: ((String) -> Unit)?,
    private val persistAgents: () -> Unit,
    timerManager: TimerManager,
) : Disposable {

    private val executor = Executors.newScheduledThreadPool(3) { r ->
        Thread(r, "PixelAgents-FileWatcher").apply { isDaemon = true }
    }

    private val watchServices = ConcurrentHashMap<Int, WatchService>()
    private val pollingTimers = ConcurrentHashMap<Int, ScheduledFuture<*>>()
    private val jsonlPollTimers = ConcurrentHashMap<Int, ScheduledFuture<*>>()
    private var projectScanTimer: ScheduledFuture<*>? = null

    /** Async sub-agent file watchers keyed by "agentId:parentToolId". */
    private val subagentPollTimers = ConcurrentHashMap<String, ScheduledFuture<*>>()

    /** Start time of each sub-agent watcher for detecting JSONL-never-appeared timeouts. */
    private val subagentStartTimes = ConcurrentHashMap<String, Long>()

    /** Last time each sub-agent watcher observed file growth (or saw the file exist). */
    private val subagentLastActivity = ConcurrentHashMap<String, Long>()

    /** Callback invoked when a sub-agent watcher gives up (timeout). Set by caller. */
    var onSubagentTimeout: ((agentId: Int, parentToolId: String) -> Unit)? = null

    val transcriptParser = TranscriptParser(sendToWebview, agents, timerManager).also { parser ->
        parser.onAsyncSubagentDetected = { agentId, parentToolId, path ->
            startSubagentWatching(agentId, parentToolId, path)
        }
        parser.onAsyncSubagentFinished = { agentId, parentToolId ->
            stopSubagentWatching(agentId, parentToolId)
        }
    }
    val timerMgr = timerManager

    fun startFileWatching(agentId: Int, filePath: String) {
        // NIO WatchService for directory containing the JSONL file
        try {
            val path = Paths.get(filePath)
            val dir = path.parent
            if (dir != null && Files.exists(dir)) {
                val ws = FileSystems.getDefault().newWatchService()
                dir.register(ws, StandardWatchEventKinds.ENTRY_MODIFY)
                watchServices[agentId] = ws

                executor.submit {
                    try {
                        while (!Thread.currentThread().isInterrupted) {
                            val key = ws.poll(500, TimeUnit.MILLISECONDS) ?: continue
                            for (event in key.pollEvents()) {
                                val changed = event.context() as? Path ?: continue
                                if (changed.fileName.toString() == path.fileName.toString()) {
                                    readNewLines(agentId)
                                }
                            }
                            if (!key.reset()) break
                        }
                    } catch (_: ClosedWatchServiceException) {
                    } catch (_: InterruptedException) {
                    }
                }
            }
        } catch (e: Exception) {
            println("[Pixel Agents] WatchService failed for agent $agentId: $e")
        }

        // Backup polling every 2s
        val pollFuture = executor.scheduleAtFixedRate({
            if (agents.containsKey(agentId)) {
                readNewLines(agentId)
            }
        }, Constants.FILE_WATCHER_POLL_INTERVAL_MS, Constants.FILE_WATCHER_POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
        pollingTimers[agentId] = pollFuture
    }

    fun readNewLines(agentId: Int) {
        val agent = agents[agentId] ?: return
        try {
            val file = File(agent.jsonlFile)
            if (!file.exists()) return
            val size = file.length()
            if (size <= agent.fileOffset) return

            val bytesToRead = (size - agent.fileOffset).toInt()
            val buf = ByteArray(bytesToRead)
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(agent.fileOffset)
                raf.readFully(buf)
            }
            agent.fileOffset = size

            val text = agent.lineBuffer + String(buf, Charsets.UTF_8)
            val lines = text.split("\n")
            agent.lineBuffer = lines.last()
            val completeLines = lines.dropLast(1)

            val hasLines = completeLines.any { it.isNotBlank() }
            if (hasLines) {
                timerMgr.cancelWaitingTimer(agentId)
                timerMgr.cancelPermissionTimer(agentId)
                if (agent.permissionSent) {
                    agent.permissionSent = false
                    sendToWebview("agentToolPermissionClear", mapOf("id" to agentId))
                }
            }

            for (line in completeLines) {
                if (line.isBlank()) continue
                transcriptParser.processTranscriptLine(agentId, line)
            }
        } catch (e: Exception) {
            println("[Pixel Agents] Read error for agent $agentId: $e")
        }
    }

    fun startJsonlPoll(agentId: Int, agent: AgentState) {
        val future = executor.scheduleAtFixedRate({
            try {
                val file = File(agent.jsonlFile)
                if (file.exists()) {
                    println("[Pixel Agents] Agent $agentId: found JSONL file ${file.name}")
                    jsonlPollTimers.remove(agentId)?.cancel(false)
                    startFileWatching(agentId, agent.jsonlFile)
                    readNewLines(agentId)
                }
            } catch (_: Exception) {
            }
        }, 0, Constants.JSONL_POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
        jsonlPollTimers[agentId] = future
    }

    fun ensureProjectScan(projectDir: String) {
        if (projectScanTimer != null) return

        // Seed known files
        try {
            File(projectDir).listFiles { f -> f.extension == "jsonl" }?.forEach {
                knownJsonlFiles.add(it.absolutePath)
            }
        } catch (_: Exception) {
        }

        projectScanTimer = executor.scheduleAtFixedRate({
            scanForNewJsonlFiles(projectDir)
        }, Constants.PROJECT_SCAN_INTERVAL_MS, Constants.PROJECT_SCAN_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun scanForNewJsonlFiles(projectDir: String) {
        val files = try {
            File(projectDir).listFiles { f -> f.extension == "jsonl" }
                ?.map { it.absolutePath } ?: return
        } catch (_: Exception) {
            return
        }

        for (file in files) {
            if (knownJsonlFiles.add(file)) {
                // Check if file is actively being written to (recent modification)
                val jsonlFile = File(file)
                val ageMs = System.currentTimeMillis() - jsonlFile.lastModified()
                if (ageMs > Constants.ADOPTION_MAX_AGE_MS) continue

                val activeId = activeAgentIdRef()
                if (activeId != null) {
                    // Active agent focused → /clear reassignment
                    println("[Pixel Agents] New JSONL detected: ${jsonlFile.name}, reassigning to agent $activeId")
                    reassignAgentToFile(activeId, file)
                } else {
                    // No active agent → adopt as new agent (terminal started without --session-id)
                    println("[Pixel Agents] Adopting new JSONL: ${jsonlFile.name}")
                    onNewAgentFile?.invoke(file)
                }
            }
        }
    }

    fun reassignAgentToFile(agentId: Int, newFilePath: String) {
        val agent = agents[agentId] ?: return
        stopWatching(agentId)
        timerMgr.clearAgentActivity(agent, agentId)
        agent.jsonlFile = newFilePath
        agent.fileOffset = 0
        agent.lineBuffer = ""
        persistAgents()
        startFileWatching(agentId, newFilePath)
        readNewLines(agentId)
    }

    fun stopWatching(agentId: Int) {
        jsonlPollTimers.remove(agentId)?.cancel(false)
        watchServices.remove(agentId)?.close()
        pollingTimers.remove(agentId)?.cancel(false)
        timerMgr.cancelWaitingTimer(agentId)
        timerMgr.cancelPermissionTimer(agentId)

        // Stop any async sub-agent watchers tied to this agent
        val prefix = "$agentId:"
        val keysToStop = subagentPollTimers.keys.filter { it.startsWith(prefix) }
        for (key in keysToStop) {
            subagentPollTimers.remove(key)?.cancel(false)
        }
    }

    // ── Async sub-agent file watching ──────────────────────────────────

    private fun subKey(agentId: Int, parentToolId: String): String = "$agentId:$parentToolId"

    /**
     * Start watching an async sub-agent's JSONL at `<sessionDir>/<sessionId>/subagents/agent-<id>.jsonl`.
     * The file may not exist yet — poll until it does, then tail new lines.
     */
    fun startSubagentWatching(agentId: Int, parentToolId: String, filePath: String) {
        val key = subKey(agentId, parentToolId)
        if (subagentPollTimers.containsKey(key)) return

        val now = System.currentTimeMillis()
        subagentStartTimes[key] = now
        subagentLastActivity[key] = now

        val future = executor.scheduleAtFixedRate({
            try {
                readSubagentNewLines(agentId, parentToolId, filePath)
                checkSubagentTimeout(agentId, parentToolId, filePath)
            } catch (_: Exception) {
            }
        }, 0, Constants.FILE_WATCHER_POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
        subagentPollTimers[key] = future
    }

    fun stopSubagentWatching(agentId: Int, parentToolId: String) {
        val key = subKey(agentId, parentToolId)
        subagentPollTimers.remove(key)?.cancel(false)
        subagentStartTimes.remove(key)
        subagentLastActivity.remove(key)
    }

    /** Give up if the JSONL never appears, or if it hasn't grown in a long time. */
    private fun checkSubagentTimeout(agentId: Int, parentToolId: String, filePath: String) {
        val key = subKey(agentId, parentToolId)
        val started = subagentStartTimes[key] ?: return
        val lastActive = subagentLastActivity[key] ?: started
        val now = System.currentTimeMillis()
        val file = File(filePath)

        val shouldGiveUp = if (!file.exists()) {
            // File never created
            now - started > Constants.SUBAGENT_JSONL_WAIT_TIMEOUT_MS
        } else {
            // File exists but is stale — no new writes for SUBAGENT_IDLE_TIMEOUT_MS
            now - lastActive > Constants.SUBAGENT_IDLE_TIMEOUT_MS &&
                now - file.lastModified() > Constants.SUBAGENT_IDLE_TIMEOUT_MS
        }

        if (shouldGiveUp) {
            println("[Pixel Agents] Sub-agent watcher timeout $agentId/$parentToolId")
            stopSubagentWatching(agentId, parentToolId)
            onSubagentTimeout?.invoke(agentId, parentToolId)
        }
    }

    private fun readSubagentNewLines(agentId: Int, parentToolId: String, filePath: String) {
        val agent = agents[agentId] ?: run {
            stopSubagentWatching(agentId, parentToolId)
            return
        }
        val sub = agent.asyncSubagents[parentToolId] ?: run {
            stopSubagentWatching(agentId, parentToolId)
            return
        }

        val file = File(filePath)
        if (!file.exists()) return
        val size = file.length()
        if (size <= sub.fileOffset) return

        // Mark activity for timeout tracking
        subagentLastActivity[subKey(agentId, parentToolId)] = System.currentTimeMillis()

        try {
            val bytesToRead = (size - sub.fileOffset).toInt()
            val buf = ByteArray(bytesToRead)
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(sub.fileOffset)
                raf.readFully(buf)
            }
            sub.fileOffset = size

            val text = sub.lineBuffer + String(buf, Charsets.UTF_8)
            val lines = text.split("\n")
            sub.lineBuffer = lines.last()
            val completeLines = lines.dropLast(1)

            for (line in completeLines) {
                if (line.isBlank()) continue
                transcriptParser.processSubagentLine(agentId, parentToolId, line)
            }
        } catch (e: Exception) {
            println("[Pixel Agents] Subagent read error $agentId/$parentToolId: $e")
        }
    }

    override fun dispose() {
        projectScanTimer?.cancel(false)
        for (id in agents.keys.toList()) {
            stopWatching(id)
        }
        for (timer in subagentPollTimers.values) timer.cancel(false)
        subagentPollTimers.clear()
        transcriptParser.dispose()
        executor.shutdownNow()
    }
}
