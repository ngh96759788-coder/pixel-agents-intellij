package com.pixelagents.intellij

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.intellij.ide.actions.RevealFileAction
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import org.jetbrains.plugins.terminal.TerminalToolWindowManager
import java.io.File
import java.nio.file.Paths
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AgentManager(
    private val project: Project,
    private val agents: ConcurrentHashMap<Int, AgentState>,
    private val knownJsonlFiles: ConcurrentHashMap.KeySetView<String, Boolean>,
    private val nextAgentId: AtomicInteger,
    private val nextTerminalIndex: AtomicInteger,
    private val activeAgentIdRef: () -> Int?,
    private val setActiveAgentId: (Int?) -> Unit,
    private val sendToWebview: (String, Map<String, Any?>) -> Unit,
    private val fileWatcher: FileWatcher,
    private val settings: PixelAgentsSettings,
) : Disposable {

    private val gson = Gson()
    private val sessionCheckExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-SessionCheck").apply { isDaemon = true }
    }
    private var sessionCheckTimer: ScheduledFuture<*>? = null

    fun getProjectDirPath(cwd: String? = null): String? {
        val workspacePath = cwd ?: project.basePath ?: return null
        val dirName = workspacePath.replace(Regex("[:\\\\/]"), "-")
        return Paths.get(System.getProperty("user.home"), ".claude", "projects", dirName).toString()
    }

    @Suppress("DEPRECATION")
    fun launchNewTerminal() {
        val idx = nextTerminalIndex.getAndIncrement()
        val terminalName = "${Constants.TERMINAL_NAME_PREFIX} #$idx"
        val cwd = project.basePath
        val sessionId = UUID.randomUUID().toString()

        // Create terminal and send claude command
        try {
            val terminalManager = TerminalToolWindowManager.getInstance(project)
            val widget = terminalManager.createLocalShellWidget(cwd, terminalName)
            // Unset CLAUDECODE to prevent "nested session" error when IDE was launched from Claude
            widget.executeCommand("env -u CLAUDECODE claude --session-id $sessionId")
        } catch (e: Exception) {
            println("[Pixel Agents] Failed to create terminal: $e")
        }

        val projectDir = getProjectDirPath(cwd) ?: run {
            println("[Pixel Agents] No project dir, cannot track agent")
            return
        }

        val expectedFile = Paths.get(projectDir, "$sessionId.jsonl").toString()
        knownJsonlFiles.add(expectedFile)

        val id = nextAgentId.getAndIncrement()
        val agent = AgentState(
            id = id,
            terminalName = terminalName,
            projectDir = projectDir,
            jsonlFile = expectedFile,
        )
        agents[id] = agent
        setActiveAgentId(id)
        persistAgents()
        sendToWebview("agentCreated", mapOf("id" to id))

        fileWatcher.ensureProjectScan(projectDir)
        fileWatcher.startJsonlPoll(id, agent)
    }

    /** Adopt an externally-started Claude session (no --session-id) as a new agent */
    fun adoptAgent(jsonlFilePath: String) {
        val id = nextAgentId.getAndIncrement()
        val idx = nextTerminalIndex.getAndIncrement()
        val terminalName = "${Constants.TERMINAL_NAME_PREFIX} #$idx"
        val projectDir = getProjectDirPath() ?: return

        val agent = AgentState(
            id = id,
            terminalName = terminalName,
            projectDir = projectDir,
            jsonlFile = jsonlFilePath,
        )
        agents[id] = agent
        persistAgents()
        sendToWebview("agentCreated", mapOf("id" to id))
        fileWatcher.startFileWatching(id, jsonlFilePath)
        fileWatcher.readNewLines(id)
        println("[Pixel Agents] Adopted agent $id from ${java.io.File(jsonlFilePath).name}")
    }

    fun focusAgent(agentId: Int) {
        agents[agentId] ?: return
        // Focus the terminal tool window
        try {
            val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                .getToolWindow("Terminal")
            toolWindow?.show()
        } catch (e: Exception) {
            println("[Pixel Agents] Failed to focus agent terminal: $e")
        }
    }

    fun closeAgent(agentId: Int) {
        removeAgent(agentId)
        sendToWebview("agentClosed", mapOf("id" to agentId))
    }

    /** Called by FileWatcher when an async sub-agent's JSONL polling times out. */
    fun clearOrphanedSubagent(agentId: Int, parentToolId: String) {
        val agent = agents[agentId] ?: return
        agent.asyncSubagents.remove(parentToolId) ?: return
        agent.activeSubagentToolIds.remove(parentToolId)
        agent.activeSubagentToolNames.remove(parentToolId)
        persistAgents()
        sendToWebview("subagentClear", mapOf(
            "id" to agentId,
            "parentToolId" to parentToolId,
        ))
    }

    fun removeAgent(agentId: Int) {
        fileWatcher.stopWatching(agentId)
        agents.remove(agentId)
        persistAgents()
    }

    fun persistAgents() {
        val persisted = agents.values.map { agent ->
            PersistedAgent(
                id = agent.id,
                terminalName = agent.terminalName,
                jsonlFile = agent.jsonlFile,
                projectDir = agent.projectDir,
                asyncSubagents = agent.asyncSubagents.values.map {
                    PersistedAsyncSubagent(
                        parentToolId = it.parentToolId,
                        subagentId = it.subagentId,
                        jsonlFile = it.jsonlFile,
                    )
                },
            )
        }
        settings.persistedAgents = gson.toJson(persisted)
    }

    fun restoreAgents() {
        val json = settings.persistedAgents
        if (json.isNullOrBlank()) return

        val type = object : TypeToken<List<PersistedAgent>>() {}.type
        val persisted: List<PersistedAgent> = try {
            gson.fromJson(json, type)
        } catch (e: Exception) {
            println("[Pixel Agents] Failed to parse persisted agents: $e")
            return
        }
        if (persisted.isEmpty()) return

        var maxId = 0
        var maxIdx = 0
        var restoredProjectDir: String? = null

        for (p in persisted) {
            val agent = AgentState(
                id = p.id,
                terminalName = p.terminalName,
                projectDir = p.projectDir,
                jsonlFile = p.jsonlFile,
            )

            // Skip to end of file for restored agents
            val file = File(p.jsonlFile)
            if (file.exists()) {
                agent.fileOffset = file.length()
                fileWatcher.startFileWatching(p.id, p.jsonlFile)
            } else {
                fileWatcher.startJsonlPoll(p.id, agent)
            }

            // Rehydrate async sub-agents and resume file watchers. Skip to EOF on existing
            // files so we don't replay finished history; poll until created otherwise.
            for (ps in p.asyncSubagents) {
                val subFile = File(ps.jsonlFile)
                val sub = AsyncSubagent(
                    parentToolId = ps.parentToolId,
                    subagentId = ps.subagentId,
                    jsonlFile = ps.jsonlFile,
                    fileOffset = if (subFile.exists()) subFile.length() else 0L,
                )
                agent.asyncSubagents[ps.parentToolId] = sub
                fileWatcher.startSubagentWatching(p.id, ps.parentToolId, ps.jsonlFile)
            }

            agents[p.id] = agent
            knownJsonlFiles.add(p.jsonlFile)

            if (p.id > maxId) maxId = p.id
            val match = Regex("#(\\d+)$").find(p.terminalName)
            if (match != null) {
                val idx = match.groupValues[1].toInt()
                if (idx > maxIdx) maxIdx = idx
            }
            restoredProjectDir = p.projectDir
        }

        if (maxId >= nextAgentId.get()) nextAgentId.set(maxId + 1)
        if (maxIdx >= nextTerminalIndex.get()) nextTerminalIndex.set(maxIdx + 1)

        persistAgents()

        if (restoredProjectDir != null) {
            fileWatcher.ensureProjectScan(restoredProjectDir)
        }
    }

    fun sendExistingAgents() {
        val agentIds = agents.keys.sorted()
        val metaJson = settings.agentSeats
        @Suppress("UNCHECKED_CAST")
        val agentMeta = if (!metaJson.isNullOrBlank()) {
            try {
                gson.fromJson(metaJson, Map::class.java) as Map<String, Any?>
            } catch (_: Exception) {
                emptyMap()
            }
        } else emptyMap<String, Any?>()

        sendToWebview("existingAgents", mapOf(
            "agents" to agentIds,
            "agentMeta" to agentMeta,
        ))
        sendCurrentAgentStatuses()
    }

    private fun sendCurrentAgentStatuses() {
        for ((agentId, agent) in agents) {
            for ((toolId, status) in agent.activeToolStatuses) {
                sendToWebview("agentToolStart", mapOf(
                    "id" to agentId, "toolId" to toolId, "status" to status
                ))
            }
            if (agent.isWaiting) {
                sendToWebview("agentStatus", mapOf(
                    "id" to agentId, "status" to "waiting"
                ))
            }
        }
    }

    /** Remove agent when its terminal is closed/terminated */
    fun onTerminalClosed(terminalName: String) {
        val agent = agents.values.find { it.terminalName == terminalName } ?: return
        println("[Pixel Agents] Terminal closed, removing agent ${agent.id}: $terminalName")
        closeAgent(agent.id)
    }

    /** Check if a terminal name belongs to an existing agent */
    fun isTerminalKnown(terminalName: String): Boolean {
        return agents.values.any { it.terminalName == terminalName }
    }

    // ── Session alive detection ──────────────────────────────────────

    /** Start periodic check for dead Claude sessions */
    fun startSessionAliveCheck() {
        sessionCheckTimer = sessionCheckExecutor.scheduleAtFixedRate({
            try {
                checkDeadSessions()
            } catch (e: Exception) {
                println("[Pixel Agents] Session check error: $e")
            }
        }, Constants.SESSION_CHECK_INTERVAL_MS, Constants.SESSION_CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun checkDeadSessions() {
        if (agents.isEmpty()) return

        val now = System.currentTimeMillis()
        val candidates = mutableListOf<Int>()

        for ((id, agent) in agents) {
            // Skip agents with active tools (clearly alive)
            if (agent.activeToolIds.isNotEmpty()) continue
            // Skip agents with active sub-agent tools
            if (agent.activeSubagentToolIds.isNotEmpty()) continue
            // Skip agents with async sub-agents still running in background
            if (agent.asyncSubagents.isNotEmpty()) continue
            // Skip agents in waiting/permission state
            if (agent.isWaiting || agent.permissionSent) continue

            val file = File(agent.jsonlFile)
            if (!file.exists()) continue

            val staleDuration = now - file.lastModified()
            if (staleDuration < Constants.SESSION_STALE_THRESHOLD_MS) continue

            candidates.add(id)
        }

        if (candidates.isEmpty()) return

        // Only remove agents if NO Claude process is running on the system.
        // This avoids false removal when:
        //   - Adopted agents don't have --session-id in their command line
        //   - Claude is waiting idle at the prompt for user input
        //   - Sub-agent work happens in separate files not tracked by main JSONL
        if (isAnyClaudeRunning()) return

        for (id in candidates) {
            println("[Pixel Agents] No claude processes running, removing idle agent $id")
            closeAgent(id)
        }
    }

    /** Check if any Claude CLI process is currently running on the system */
    private fun isAnyClaudeRunning(): Boolean {
        return try {
            // Match the claude executable in any process's command line
            val proc = ProcessBuilder("pgrep", "-f", "[c]laude")
                .redirectErrorStream(true)
                .start()
            proc.inputStream.readBytes()
            val finished = proc.waitFor(5, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroyForcibly()
                return true // Timeout → assume alive (safe default)
            }
            proc.exitValue() == 0
        } catch (_: Exception) {
            true // Can't check → assume alive
        }
    }

    fun openSessionsFolder() {
        val projectDir = getProjectDirPath()
        if (projectDir != null && File(projectDir).exists()) {
            RevealFileAction.openDirectory(File(projectDir))
        }
    }

    override fun dispose() {
        sessionCheckTimer?.cancel(false)
        sessionCheckExecutor.shutdownNow()
    }
}
