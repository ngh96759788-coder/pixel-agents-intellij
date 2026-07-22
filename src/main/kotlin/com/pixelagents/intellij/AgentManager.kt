package com.pixelagents.intellij

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.intellij.ide.actions.RevealFileAction
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
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
    private val instanceManifest: InstanceManifest,
) : Disposable {

    companion object {
        private val LOG = Logger.getInstance(AgentManager::class.java)
    }

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

    fun launchNewTerminal() {
        val idx = nextTerminalIndex.getAndIncrement()
        val terminalName = "${Constants.TERMINAL_NAME_PREFIX} #$idx"
        val cwd = project.basePath
        val sessionId = UUID.randomUUID().toString()

        val projectDir = getProjectDirPath(cwd) ?: run {
            LOG.warn("No project dir, cannot track agent")
            return
        }

        // Reserve the JSONL path BEFORE launching claude. If a project scanner
        // is already running for this dir, it could otherwise see the new file
        // and mis-adopt it as a separate agent before we register it here.
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
        // Claim ownership in the cross-IDE manifest so peer plugin instances
        // don't try to adopt this session as their own.
        instanceManifest.registerSession(expectedFile)
        sendToWebview("agentCreated", mapOf(
            "id" to id,
            "isExternal" to false,
            "displayName" to terminalName, // real IDE terminal tab we just created
        ))

        // Now safe to launch — any JSONL writes will see this file as known.
        try {
            val terminalManager = TerminalToolWindowManager.getInstance(project)
            val widget = terminalManager.createShellWidget(cwd, terminalName, true, true)
            // Unset CLAUDECODE to prevent "nested session" error when IDE was launched from Claude
            val shellWidget = widget as? org.jetbrains.plugins.terminal.ShellTerminalWidget
            shellWidget?.executeCommand("env -u CLAUDECODE claude --session-id $sessionId")
                ?: LOG.warn("Terminal widget is not a ShellTerminalWidget; cannot send claude command")
        } catch (e: Exception) {
            LOG.warn("Failed to create terminal", e)
        }

        fileWatcher.ensureProjectScan(projectDir)
        fileWatcher.startJsonlPoll(id, agent)
    }

    /** Adopt a Claude session that this window's terminal launched directly
     *  (`claude` typed without going through + Agent). Peer-owned sessions are
     *  filtered upstream in FileWatcher; anything reaching here is genuinely
     *  ours — claim it in the manifest and surface it as a normal character,
     *  not faded/external. */
    fun adoptAgent(jsonlFilePath: String) {
        if (instanceManifest.isOwnedByPeer(jsonlFilePath)) {
            LOG.info("adoptAgent: skipping peer-owned JSONL ${File(jsonlFilePath).name}")
            return
        }
        val id = nextAgentId.getAndIncrement()
        val idx = nextTerminalIndex.getAndIncrement()
        val terminalName = "${Constants.TERMINAL_NAME_PREFIX} #$idx"
        // Use the JSONL's actual parent dir as projectDir — for a worktree
        // session this is its own project-hash dir, not the IDE basePath. Falls
        // back to basePath only if the path somehow has no parent.
        val projectDir = File(jsonlFilePath).parent ?: getProjectDirPath() ?: return
        // Branch label if this session lives in a known worktree of the open repo.
        val worktreeBranch = fileWatcher.worktreeBranchForFile(jsonlFilePath)

        val agent = AgentState(
            id = id,
            terminalName = terminalName,
            projectDir = projectDir,
            jsonlFile = jsonlFilePath,
            isExternal = false,
            isAdopted = true,
            worktreeBranch = worktreeBranch,
        )
        agents[id] = agent
        knownJsonlFiles.add(jsonlFilePath)
        instanceManifest.registerSession(jsonlFilePath)
        persistAgents()
        // Adopted: displayName left empty so the webview falls back to
        // `main ${id}` instead of showing the synthetic internal name.
        sendToWebview("agentCreated", mapOf(
            "id" to id,
            "isExternal" to false,
            "displayName" to "",
            "worktreeBranch" to worktreeBranch,
        ))
        fileWatcher.startFileWatching(id, jsonlFilePath)
        fileWatcher.readNewLines(id)
        LOG.info("Adopted agent $id from ${java.io.File(jsonlFilePath).name}")
    }

    /** Adopt an EXTERNAL Claude session surfaced by unified-view discovery
     *  (BEHAVIOR_SPEC §4) — a peer IntelliJ window's CLI or any other
     *  ~/.claude/projects activity. Unlike [adoptAgent], this deliberately
     *  KEEPS peer-owned sessions (that's the whole point of unified view):
     *   - `isExternal = true` → webview renders the character at 85% opacity.
     *   - `isAdopted = true`, no terminalRef → no synthetic name shown, and
     *     terminal-focus/close logic skips it.
     *   - NOT claimed in the instance manifest (it isn't ours).
     *   - NOT persisted (transient; never restored across IDE restarts).
     *   - Normal JSONL watching so status/tools animate like any agent. */
    fun adoptExternalAgent(jsonlFilePath: String) {
        // Never double-adopt, and never shadow a session we already track
        // (own or external). The discovery scanner also guards on
        // knownJsonlFiles, but re-check here since adoption may race.
        if (jsonlFilePath in knownJsonlFiles) return
        if (agents.values.any { it.jsonlFile == jsonlFilePath }) return

        val id = nextAgentId.getAndIncrement()
        // Use the JSONL's own parent dir as projectDir (a foreign project-hash
        // dir, not this IDE's basePath).
        val projectDir = File(jsonlFilePath).parent ?: return
        // Synthetic internal name that can never collide with a real IDE
        // terminal tab, so onTerminalClosed / focusAgent tab-matching ignore it.
        val terminalName = "external:${File(jsonlFilePath).nameWithoutExtension}"

        val agent = AgentState(
            id = id,
            terminalName = terminalName,
            projectDir = projectDir,
            jsonlFile = jsonlFilePath,
            isExternal = true,
            isAdopted = true,
        )
        agents[id] = agent
        knownJsonlFiles.add(jsonlFilePath)
        // NOTE: no instanceManifest.registerSession — externals are peer-owned.
        // NOTE: no persistAgents — externals are transient (see persistAgents filter).
        sendToWebview("agentCreated", mapOf(
            "id" to id,
            "isExternal" to true,
            // Adopted → empty displayName so the webview falls back to its own
            // label instead of a synthetic internal name.
            "displayName" to "",
        ))
        fileWatcher.startFileWatching(id, jsonlFilePath)
        fileWatcher.readNewLines(id)
        LOG.info("Adopted EXTERNAL agent $id from ${File(jsonlFilePath).name}")
    }

    /** Close every currently-tracked external agent (unified view toggled OFF).
     *  Uses the normal close path (which kills no terminal — externals have
     *  none) so each despawns in the webview and frees its file watcher. */
    fun closeAllExternalAgents() {
        for (id in agents.values.filter { it.isExternal }.map { it.id }) {
            closeAgent(id)
        }
    }

    fun focusAgent(agentId: Int) {
        val agent = agents[agentId] ?: return
        try {
            val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                .getToolWindow("Terminal")
            // Try to find the specific terminal tab matching this agent's terminalName.
            // Falls back to revealing the JSONL file for adopted cross-project agents
            // whose terminal lives in another IntelliJ window (or no terminal at all).
            val matchingContent = toolWindow?.contentManager?.contents
                ?.firstOrNull { it.displayName == agent.terminalName }
            if (matchingContent != null) {
                toolWindow.show {
                    toolWindow.contentManager.setSelectedContent(matchingContent)
                }
            } else {
                val jsonlFile = File(agent.jsonlFile)
                if (jsonlFile.exists()) {
                    RevealFileAction.openFile(jsonlFile)
                } else {
                    toolWindow?.show()
                }
            }
        } catch (e: Exception) {
            LOG.warn("Failed to focus agent terminal", e)
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
        val agent = agents[agentId]
        fileWatcher.stopWatching(agentId)
        agents.remove(agentId)
        if (activeAgentIdRef() == agentId) {
            setActiveAgentId(null)
        }
        // Forget this JSONL so that if the user keeps talking to the same
        // Claude CLI after a 60s idle disconnect, the next JSONL write
        // re-adopts the session as a new agent instead of being ignored.
        if (agent != null) {
            knownJsonlFiles.remove(agent.jsonlFile)
            // Release manifest claim so a peer instance can take over if it
            // wants to (e.g. user closed this agent here, then resumed work
            // from another IntelliJ window).
            instanceManifest.unregisterSession(agent.jsonlFile)
        }
        persistAgents()
    }

    fun persistAgents() {
        // External (unified-view) agents are transient peer sessions — never
        // persist them. restoreAgents also drops any legacy isExternal entry,
        // but excluding them here keeps the stored set clean.
        val persisted = agents.values.filter { !it.isExternal }.map { agent ->
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
                        taskStatus = it.taskStatus,
                    )
                },
                isExternal = agent.isExternal,
                isAdopted = agent.isAdopted,
                worktreeBranch = agent.worktreeBranch,
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
            LOG.warn("Failed to parse persisted agents", e)
            return
        }
        if (persisted.isEmpty()) return

        var maxId = 0
        var maxIdx = 0
        var restoredProjectDir: String? = null

        for (p in persisted) {
            // Per-window independence: external (adopted) agents are no
            // longer supported. Any persisted entry flagged isExternal is a
            // leftover from the old adoption logic — drop it so this window
            // only restores agents it actually launched itself.
            if (p.isExternal) {
                LOG.info("restoreAgents: dropping legacy external agent ${p.id} (${File(p.jsonlFile).name})")
                continue
            }
            val agent = AgentState(
                id = p.id,
                terminalName = p.terminalName,
                projectDir = p.projectDir,
                jsonlFile = p.jsonlFile,
                isExternal = p.isExternal,
                isAdopted = p.isAdopted,
                worktreeBranch = p.worktreeBranch,
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
                    taskStatus = ps.taskStatus,
                    fileOffset = if (subFile.exists()) subFile.length() else 0L,
                )
                agent.asyncSubagents[ps.parentToolId] = sub
                fileWatcher.startSubagentWatching(p.id, ps.parentToolId, ps.jsonlFile)
            }

            agents[p.id] = agent
            knownJsonlFiles.add(p.jsonlFile)
            // Re-claim ownership in the manifest. Adopted (external) agents
            // are excluded — they were never ours to begin with, and re-
            // claiming them would defeat isolation across IDE restarts.
            if (!agent.isExternal) {
                instanceManifest.registerSession(p.jsonlFile)
            }

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

        // Surface which restored agents are external so the webview can render
        // them faded immediately on reload (rather than waiting for the next
        // adoption event, which would be too late for restored sessions).
        val externalIds = agents.values.filter { it.isExternal }.map { it.id }.sorted()
        // Per-agent display names — empty for adopted agents (so the webview
        // falls back to `main ${id}` instead of the synthetic "Claude Code #N"
        // label the user never sees in their IDE).
        val displayNames = agents.values.associate { agent ->
            agent.id.toString() to (if (agent.isAdopted) "" else agent.terminalName)
        }
        // Branch labels for restored worktree agents, so the badge survives reload.
        val worktreeBranches = agents.values
            .filter { it.worktreeBranch != null }
            .associate { it.id.toString() to it.worktreeBranch }
        sendToWebview("existingAgents", mapOf(
            "agents" to agentIds,
            "agentMeta" to agentMeta,
            "externalIds" to externalIds,
            "displayNames" to displayNames,
            "worktreeBranches" to worktreeBranches,
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
            // Replay sub-agent characters for any async sub-agent whose parent
            // Task entry has already been removed from activeToolStatuses (the
            // parent received tool_result but the sub is still running on its
            // own JSONL). Without this, sub-agent characters disappear on
            // webview reload until the next sub-agent activity.
            for ((parentToolId, sub) in agent.asyncSubagents) {
                if (parentToolId in agent.activeToolStatuses) continue  // already replayed above
                if (sub.taskStatus.isEmpty()) continue                   // nothing to label with
                sendToWebview("agentToolStart", mapOf(
                    "id" to agentId, "toolId" to parentToolId, "status" to sub.taskStatus
                ))
            }
            if (agent.isWaiting) {
                sendToWebview("agentStatus", mapOf(
                    "id" to agentId, "status" to "waiting"
                ))
            }
            // Replay last context-window usage, model, and cumulative tokens so
            // the HP gauge / model chip / session-total tooltip are all correct
            // immediately after webview reload (no need to wait for the next
            // assistant record).
            val cumulativeAny = agent.cumulativeInput + agent.cumulativeCacheCreate +
                agent.cumulativeCacheRead + agent.cumulativeOutput > 0L
            if (agent.lastContextTokens > 0L || agent.lastModel.isNotEmpty() || cumulativeAny) {
                val payload = mutableMapOf<String, Any?>("id" to agentId)
                if (agent.lastContextTokens > 0L) payload["contextTokens"] = agent.lastContextTokens
                if (agent.lastModel.isNotEmpty()) payload["model"] = agent.lastModel
                if (cumulativeAny) {
                    payload["cumulativeInput"] = agent.cumulativeInput
                    payload["cumulativeCacheCreate"] = agent.cumulativeCacheCreate
                    payload["cumulativeCacheRead"] = agent.cumulativeCacheRead
                    payload["cumulativeOutput"] = agent.cumulativeOutput
                }
                sendToWebview("agentUsage", payload)
            }
        }
    }

    /** Remove agent when its terminal is closed/terminated */
    fun onTerminalClosed(terminalName: String) {
        // External agents have no IDE terminal; their synthetic terminalName
        // never appears in the terminal tab list, but guard defensively so a
        // name collision can never despawn a peer session here.
        val agent = agents.values.find { it.terminalName == terminalName && !it.isExternal } ?: return
        LOG.info("Terminal closed, removing agent ${agent.id}: $terminalName")
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
                LOG.warn("Session check error", e)
            }
        }, Constants.SESSION_CHECK_INTERVAL_MS, Constants.SESSION_CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun checkDeadSessions() {
        if (agents.isEmpty()) return

        val now = System.currentTimeMillis()
        // Capture the path used for the staleness decision so we can re-verify
        // it right before removal. This protects against a /clear reassignment
        // racing the check: reassignAgentToFile may swap agent.jsonlFile mid-loop,
        // and we must not remove an agent based on the OLD file's mtime once it
        // points at a new (just-created, not-yet-stale) session.
        val candidates = mutableListOf<Pair<Int, String>>()

        for ((id, agent) in agents) {
            // Skip agents whose async sub-agents are still running in background —
            // those have their own JSONLs and will survive even when the parent
            // file is quiet.
            if (agent.asyncSubagents.isNotEmpty()) continue

            // Skip agents with a background Bash (run_in_background) still
            // outstanding — BEHAVIOR_SPEC §2 says they stay active even when
            // the JSONL is quiet (a silent long-running shell writes nothing).
            // The exemption is released by the tool_result, or cleared by
            // clearAgentActivity on the next user prompt / /clear, so it
            // can't strand an agent forever.
            if (agent.backgroundToolIds.isNotEmpty()) continue

            val capturedPath = agent.jsonlFile
            val file = File(capturedPath)
            if (!file.exists()) continue

            val staleDuration = now - file.lastModified()
            if (staleDuration < Constants.SESSION_STALE_THRESHOLD_MS) continue

            // No skips for permissionSent / activeToolIds / isWaiting — these
            // flags get stuck forever when Claude is Ctrl+C'd or killed mid-turn.
            // JSONL lastModified is the authoritative "still working" signal.
            // If the user genuinely takes >60s to respond to a permission prompt,
            // the character disappears and re-adopts on the next JSONL write.
            candidates.add(id to capturedPath)
        }

        if (candidates.isEmpty()) return

        for ((id, capturedPath) in candidates) {
            // Re-verify the agent still points at the same JSONL we judged stale.
            // If reassignAgentToFile swapped jsonlFile in the meantime, skip —
            // the new path may have fresh activity that the next tick will see.
            val agent = agents[id] ?: continue
            if (agent.jsonlFile != capturedPath) continue
            LOG.info("JSONL stale for ${Constants.SESSION_STALE_THRESHOLD_MS / 1000}s, removing agent $id")
            closeAgent(id)
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
