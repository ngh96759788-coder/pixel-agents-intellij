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

    fun openSessionsFolder() {
        val projectDir = getProjectDirPath()
        if (projectDir != null && File(projectDir).exists()) {
            RevealFileAction.openDirectory(File(projectDir))
        }
    }

    override fun dispose() {
        // Cleanup handled by panel
    }
}
