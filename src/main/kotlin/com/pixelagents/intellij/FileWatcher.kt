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
    private val onNewAgentFile: ((String) -> Unit)?,
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

    val transcriptParser = TranscriptParser(sendToWebview, agents, timerManager)
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
                val activeId = activeAgentIdRef()
                if (activeId != null) {
                    // Active agent focused → /clear reassignment
                    println("[Pixel Agents] New JSONL detected: ${File(file).name}, reassigning to agent $activeId")
                    reassignAgentToFile(activeId, file)
                }
                // Terminal adoption for IntelliJ would go here
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
    }

    override fun dispose() {
        projectScanTimer?.cancel(false)
        for (id in agents.keys.toList()) {
            stopWatching(id)
        }
        transcriptParser.dispose()
        executor.shutdownNow()
    }
}
