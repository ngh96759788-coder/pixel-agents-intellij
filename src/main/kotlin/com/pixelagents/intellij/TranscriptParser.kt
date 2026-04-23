package com.pixelagents.intellij

import com.google.gson.Gson
import java.io.File
import java.util.concurrent.*

class TranscriptParser(
    private val sendToWebview: (String, Map<String, Any?>) -> Unit,
    private val agents: ConcurrentHashMap<Int, AgentState>,
    private val timerManager: TimerManager,
) {
    companion object {
        /** Tool names that spawn sub-agent characters (Claude Code uses "Agent", legacy uses "Task") */
        val SUBAGENT_TOOL_NAMES = setOf("Task", "Agent")
    }

    private val gson = Gson()
    private val delayScheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-ToolDoneDelay").apply { isDaemon = true }
    }

    /** Callback to start watching an async sub-agent's separate JSONL file. Set by FileWatcher. */
    var onAsyncSubagentDetected: ((agentId: Int, parentToolId: String, jsonlPath: String) -> Unit)? = null

    /** Callback to stop watching an async sub-agent's file once it finishes. */
    var onAsyncSubagentFinished: ((agentId: Int, parentToolId: String) -> Unit)? = null

    /**
     * Callback fired when a parent agent launches an Agent/Task sub-agent tool.
     * Claude Code no longer writes an `isAsync:true` marker, so we start watching
     * the `<sessionId>/subagents/` folder immediately to catch the newly-created
     * agent-<subId>.jsonl and bind it FIFO to pending parent tool_use ids.
     */
    var onSubagentToolUseStarted: ((agentId: Int, parentToolId: String) -> Unit)? = null

    /**
     * "Last-chance" synchronous binding hook. parent JSONL can arrive in
     * bursts so a tool_result may reach processUserRecord before the folder
     * watcher's next tick; calling this gives the binder one more chance to
     * pair new sub-JSONL files with pending parent tool_use ids.
     */
    var onTryBindSubagentFiles: ((agentId: Int) -> Unit)? = null

    fun formatToolStatus(toolName: String, input: Map<String, Any?>): String {
        fun base(p: Any?): String = if (p is String) File(p).name else ""
        return when (toolName) {
            "Read" -> "Reading ${base(input["file_path"])}"
            "Edit" -> "Editing ${base(input["file_path"])}"
            "Write" -> "Writing ${base(input["file_path"])}"
            "Bash" -> {
                val cmd = (input["command"] as? String) ?: ""
                "Running: ${if (cmd.length > Constants.BASH_COMMAND_DISPLAY_MAX_LENGTH) cmd.take(Constants.BASH_COMMAND_DISPLAY_MAX_LENGTH) + "\u2026" else cmd}"
            }
            "Glob" -> "Searching files"
            "Grep" -> "Searching code"
            "WebFetch" -> "Fetching web content"
            "WebSearch" -> "Searching the web"
            "Task", "Agent" -> {
                val desc = input["description"] as? String ?: ""
                val subType = input["subagent_type"] as? String ?: ""
                val prefix = if (subType.isNotEmpty()) "Subtask[$subType]: " else "Subtask: "
                if (desc.isNotEmpty()) "$prefix${if (desc.length > Constants.TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) desc.take(Constants.TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + "\u2026" else desc}"
                else "Running subtask"
            }
            "AskUserQuestion" -> "Waiting for your answer"
            "EnterPlanMode" -> "Planning"
            "NotebookEdit" -> "Editing notebook"
            else -> "Using $toolName"
        }
    }

    @Suppress("UNCHECKED_CAST")
    fun processTranscriptLine(agentId: Int, line: String) {
        val agent = agents[agentId] ?: return
        try {
            val record = gson.fromJson(line, Map::class.java) as Map<String, Any?>
            val type = record["type"] as? String ?: return

            when (type) {
                "assistant" -> processAssistantRecord(agentId, agent, record)
                "progress" -> processProgressRecord(agentId, agent, record)
                "user" -> processUserRecord(agentId, agent, record)
                "system" -> {
                    if (record["subtype"] == "turn_duration") {
                        processTurnDuration(agentId, agent)
                    }
                }
            }
        } catch (_: Exception) {
            // Ignore malformed lines
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun processAssistantRecord(agentId: Int, agent: AgentState, record: Map<String, Any?>) {
        val message = record["message"] as? Map<String, Any?> ?: return
        val content = message["content"] as? List<Map<String, Any?>> ?: return
        val hasToolUse = content.any { it["type"] == "tool_use" }

        if (hasToolUse) {
            timerManager.cancelWaitingTimer(agentId)
            agent.isWaiting = false
            agent.hadToolsInTurn = true
            sendToWebview("agentStatus", mapOf("id" to agentId, "status" to "active"))

            var hasNonExemptTool = false
            for (block in content) {
                if (block["type"] == "tool_use" && block["id"] != null) {
                    val toolName = (block["name"] as? String) ?: ""
                    val input = (block["input"] as? Map<String, Any?>) ?: emptyMap()
                    val status = formatToolStatus(toolName, input)
                    val blockId = block["id"] as String

                    agent.activeToolIds.add(blockId)
                    agent.activeToolStatuses[blockId] = status
                    agent.activeToolNames[blockId] = toolName

                    if (toolName !in TimerManager.PERMISSION_EXEMPT_TOOLS) {
                        hasNonExemptTool = true
                    }

                    sendToWebview("agentToolStart", mapOf(
                        "id" to agentId,
                        "toolId" to blockId,
                        "status" to status,
                    ))

                    // Register this Agent/Task tool_use so the folder watcher can
                    // bind the next agent-*.jsonl file that appears under
                    // <sessionId>/subagents/ — current Claude Code stopped emitting
                    // the isAsync marker, so we must watch the directory ourselves.
                    if (toolName in SUBAGENT_TOOL_NAMES) {
                        agent.pendingSubagentIds.offer(blockId)
                        onSubagentToolUseStarted?.invoke(agentId, blockId)
                    }
                }
            }
            if (hasNonExemptTool) {
                timerManager.startPermissionTimer(agentId)
            }
        } else if (content.any { it["type"] == "text" } && !agent.hadToolsInTurn) {
            timerManager.startWaitingTimer(agentId, Constants.TEXT_IDLE_DELAY_MS)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun processUserRecord(agentId: Int, agent: AgentState, record: Map<String, Any?>) {
        val message = record["message"] as? Map<String, Any?> ?: return
        val content = message["content"]

        if (content is List<*>) {
            val blocks = content as List<Map<String, Any?>>
            val hasToolResult = blocks.any { it["type"] == "tool_result" }

            if (hasToolResult) {
                // Detect async Agent launch: tool_result arrives immediately with {isAsync: true, agentId: "..."}
                // but the real sub-agent work happens in a separate JSONL file.
                val toolUseResult = record["toolUseResult"] as? Map<String, Any?>
                val isAsyncLaunch = (toolUseResult?.get("isAsync") as? Boolean) == true
                val asyncAgentId = toolUseResult?.get("agentId") as? String

                for (block in blocks) {
                    if (block["type"] == "tool_result" && block["tool_use_id"] != null) {
                        val completedToolId = block["tool_use_id"] as String
                        val wasSubagentTool = agent.activeToolNames[completedToolId] in SUBAGENT_TOOL_NAMES

                        // Last-chance binding: parent JSONL may arrive in a single burst
                        // (Agent tool_use + tool_result both in one readNewLines tick),
                        // so the folder-watcher thread hasn't bound this sub yet. Give
                        // the binder one more synchronous shot before we decide whether
                        // to despawn the character.
                        if (wasSubagentTool) {
                            onTryBindSubagentFiles?.invoke(agentId)
                        }

                        val alreadyBoundAsync = agent.asyncSubagents.containsKey(completedToolId)
                        if (isAsyncLaunch && !asyncAgentId.isNullOrBlank() && wasSubagentTool) {
                            // Legacy path: Claude Code used to set isAsync=true here.
                            registerAsyncSubagent(agentId, agent, completedToolId, asyncAgentId)
                        } else if (wasSubagentTool && alreadyBoundAsync) {
                            // Current Claude Code: tool_result arrives after sub finished. The
                            // sub's own end_turn in its JSONL will despawn the character via
                            // clearAsyncSubagent, so do nothing here — just let it proceed.
                        } else if (wasSubagentTool) {
                            // Sub-agent tool completed but we never bound a sub-JSONL for it.
                            // Drop the pending placeholder (if any) and clear immediately.
                            agent.pendingSubagentIds.remove(completedToolId)
                            agent.activeSubagentToolIds.remove(completedToolId)
                            agent.activeSubagentToolNames.remove(completedToolId)
                            sendToWebview("subagentClear", mapOf(
                                "id" to agentId,
                                "parentToolId" to completedToolId,
                            ))
                        }

                        // Do NOT call clearAsyncSubagent here: if the sub-JSONL watcher
                        // is still running we want its end_turn (or idle timeout) to
                        // trigger despawn. Calling it here would kill the character
                        // mid-work when the parent tool_result is what's delayed, not
                        // the sub's actual completion.

                        agent.activeToolIds.remove(completedToolId)
                        agent.activeToolStatuses.remove(completedToolId)
                        agent.activeToolNames.remove(completedToolId)

                        val toolId = completedToolId
                        delayScheduler.schedule({
                            sendToWebview("agentToolDone", mapOf(
                                "id" to agentId,
                                "toolId" to toolId,
                            ))
                        }, Constants.TOOL_DONE_DELAY_MS, TimeUnit.MILLISECONDS)
                    }
                }
                if (agent.activeToolIds.isEmpty()) {
                    agent.hadToolsInTurn = false
                }
            } else {
                // New user text prompt — new turn starting
                timerManager.cancelWaitingTimer(agentId)
                timerManager.clearAgentActivity(agent, agentId)
                agent.hadToolsInTurn = false
            }
        } else if (content is String && content.trim().isNotEmpty()) {
            // New user text prompt — new turn starting
            timerManager.cancelWaitingTimer(agentId)
            timerManager.clearAgentActivity(agent, agentId)
            agent.hadToolsInTurn = false
        }
    }

    private fun processTurnDuration(agentId: Int, agent: AgentState) {
        timerManager.cancelWaitingTimer(agentId)
        timerManager.cancelPermissionTimer(agentId)

        if (agent.activeToolIds.isNotEmpty()) {
            agent.activeToolIds.clear()
            agent.activeToolStatuses.clear()
            agent.activeToolNames.clear()
            // Preserve tool state for async sub-agents (they keep running in background)
            val preservedSubIds = agent.asyncSubagents.keys.toSet()
            agent.activeSubagentToolIds.keys.retainAll(preservedSubIds)
            agent.activeSubagentToolNames.keys.retainAll(preservedSubIds)

            // Preserve sub-agent characters when EITHER an async sub-agent is
            // already bound OR a parent Agent tool_use is still waiting for
            // its sub-JSONL to appear (folder watcher is racing with the
            // parent's turn_duration record — see FileWatcher.ensureSubagentFolderWatch).
            val hasLiveOrPendingSubs =
                agent.asyncSubagents.isNotEmpty() || agent.pendingSubagentIds.isNotEmpty()
            if (hasLiveOrPendingSubs) {
                sendToWebview("agentToolsClearParentOnly", mapOf("id" to agentId))
            } else {
                sendToWebview("agentToolsClear", mapOf("id" to agentId))
            }
        }

        agent.isWaiting = true
        agent.permissionSent = false
        agent.hadToolsInTurn = false
        sendToWebview("agentStatus", mapOf("id" to agentId, "status" to "waiting"))
    }

    @Suppress("UNCHECKED_CAST")
    private fun processProgressRecord(agentId: Int, agent: AgentState, record: Map<String, Any?>) {
        val parentToolId = record["parentToolUseID"] as? String ?: return
        val data = record["data"] as? Map<String, Any?> ?: return

        // bash_progress / mcp_progress: tool is actively executing
        val dataType = data["type"] as? String
        if (dataType == "bash_progress" || dataType == "mcp_progress") {
            if (parentToolId in agent.activeToolIds) {
                timerManager.startPermissionTimer(agentId)
            }
            return
        }

        // Verify parent is an active Task/Agent tool
        if (agent.activeToolNames[parentToolId] !in SUBAGENT_TOOL_NAMES) return

        val msg = data["message"] as? Map<String, Any?> ?: return
        val msgType = msg["type"] as? String ?: return
        val innerMsg = msg["message"] as? Map<String, Any?> ?: return
        val content = innerMsg["content"] as? List<Map<String, Any?>> ?: return

        if (msgType == "assistant") {
            var hasNonExemptSubTool = false
            for (block in content) {
                if (block["type"] == "tool_use" && block["id"] != null) {
                    val toolName = (block["name"] as? String) ?: ""
                    val input = (block["input"] as? Map<String, Any?>) ?: emptyMap()
                    val status = formatToolStatus(toolName, input)
                    val blockId = block["id"] as String

                    // computeIfAbsent: atomic on ConcurrentHashMap, prevents lost updates
                    // when two threads race to initialize the same parentToolId bucket.
                    val subTools = (agent.activeSubagentToolIds as java.util.concurrent.ConcurrentHashMap<String, MutableSet<String>>)
                        .computeIfAbsent(parentToolId) { ConcurrentHashMap.newKeySet() }
                    subTools.add(blockId)

                    val subNames = (agent.activeSubagentToolNames as java.util.concurrent.ConcurrentHashMap<String, MutableMap<String, String>>)
                        .computeIfAbsent(parentToolId) { ConcurrentHashMap() }
                    subNames[blockId] = toolName

                    if (toolName !in TimerManager.PERMISSION_EXEMPT_TOOLS) {
                        hasNonExemptSubTool = true
                    }

                    sendToWebview("subagentToolStart", mapOf(
                        "id" to agentId,
                        "parentToolId" to parentToolId,
                        "toolId" to blockId,
                        "status" to status,
                    ))
                }
            }
            if (hasNonExemptSubTool) {
                timerManager.startPermissionTimer(agentId)
            }
        } else if (msgType == "user") {
            for (block in content) {
                if (block["type"] == "tool_result" && block["tool_use_id"] != null) {
                    val toolUseId = block["tool_use_id"] as String

                    agent.activeSubagentToolIds[parentToolId]?.remove(toolUseId)
                    agent.activeSubagentToolNames[parentToolId]?.remove(toolUseId)

                    val toolId = toolUseId
                    delayScheduler.schedule({
                        sendToWebview("subagentToolDone", mapOf(
                            "id" to agentId,
                            "parentToolId" to parentToolId,
                            "toolId" to toolId,
                        ))
                    }, Constants.TOOL_DONE_DELAY_MS, TimeUnit.MILLISECONDS)
                }
            }
            // Check if there are still non-exempt sub-agent tools
            var stillHasNonExempt = false
            for ((_, subNames) in agent.activeSubagentToolNames) {
                for ((_, toolName) in subNames) {
                    if (toolName !in TimerManager.PERMISSION_EXEMPT_TOOLS) {
                        stillHasNonExempt = true
                        break
                    }
                }
                if (stillHasNonExempt) break
            }
            if (stillHasNonExempt) {
                timerManager.startPermissionTimer(agentId)
            }
        }
    }

    /**
     * Register an async sub-agent whose work lives in `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl`.
     * Starts FileWatcher polling for that file (via callback) so we can stream its tool activity.
     */
    private fun registerAsyncSubagent(
        agentId: Int,
        agent: AgentState,
        parentToolId: String,
        subagentId: String,
    ) {
        if (agent.asyncSubagents.containsKey(parentToolId)) return

        val sessionFile = File(agent.jsonlFile)
        val sessionId = sessionFile.nameWithoutExtension
        val subagentPath = File(
            File(sessionFile.parentFile, sessionId),
            "subagents/agent-$subagentId.jsonl"
        ).absolutePath

        agent.asyncSubagents[parentToolId] = AsyncSubagent(
            parentToolId = parentToolId,
            subagentId = subagentId,
            jsonlFile = subagentPath,
        )
        onAsyncSubagentDetected?.invoke(agentId, parentToolId, subagentPath)
    }

    /** Clear async sub-agent tracking + tell webview to despawn. */
    private fun clearAsyncSubagent(agentId: Int, agent: AgentState, parentToolId: String) {
        val sub = agent.asyncSubagents.remove(parentToolId) ?: return
        agent.activeSubagentToolIds.remove(parentToolId)
        agent.activeSubagentToolNames.remove(parentToolId)
        sendToWebview("subagentClear", mapOf(
            "id" to agentId,
            "parentToolId" to parentToolId,
        ))
        onAsyncSubagentFinished?.invoke(agentId, parentToolId)
        // Silence unused warning on `sub` — referenced for future debugging
        @Suppress("UNUSED_VARIABLE") val _unused = sub
    }

    /**
     * Parse a single line from an async sub-agent's JSONL file.
     * Emits `subagentToolStart` / `subagentToolDone` / `subagentClear` based on content.
     */
    @Suppress("UNCHECKED_CAST")
    fun processSubagentLine(agentId: Int, parentToolId: String, line: String) {
        val agent = agents[agentId] ?: return
        val sub = agent.asyncSubagents[parentToolId] ?: return
        try {
            val record = gson.fromJson(line, Map::class.java) as Map<String, Any?>
            val type = record["type"] as? String

            when (type) {
                "assistant" -> processSubagentAssistant(agentId, agent, parentToolId, record)
                "user" -> processSubagentUser(agentId, agent, parentToolId, record)
                else -> {
                    // Top-level "type" may be absent on some records; check nested message shape
                    val message = record["message"] as? Map<String, Any?>
                    if (message != null) {
                        val role = message["role"] as? String
                        when (role) {
                            "assistant" -> processSubagentAssistantMessage(agentId, agent, parentToolId, message)
                            "user" -> {
                                val content = message["content"]
                                if (content is List<*>) {
                                    processSubagentToolResults(agentId, agent, parentToolId, content as List<Map<String, Any?>>)
                                }
                            }
                        }
                    }
                }
            }
        } catch (_: Exception) {
            // Ignore malformed lines
        }
        // Silence unused
        @Suppress("UNUSED_VARIABLE") val _unused = sub
    }

    @Suppress("UNCHECKED_CAST")
    private fun processSubagentAssistant(
        agentId: Int, agent: AgentState, parentToolId: String, record: Map<String, Any?>
    ) {
        val message = record["message"] as? Map<String, Any?> ?: return
        processSubagentAssistantMessage(agentId, agent, parentToolId, message)
    }

    @Suppress("UNCHECKED_CAST")
    private fun processSubagentAssistantMessage(
        agentId: Int, agent: AgentState, parentToolId: String, message: Map<String, Any?>
    ) {
        val content = message["content"] as? List<Map<String, Any?>> ?: return
        val stopReason = message["stop_reason"] as? String

        var hasNonExemptSubTool = false
        for (block in content) {
            if (block["type"] == "tool_use" && block["id"] != null) {
                val toolName = (block["name"] as? String) ?: ""
                val input = (block["input"] as? Map<String, Any?>) ?: emptyMap()
                val status = formatToolStatus(toolName, input)
                val blockId = block["id"] as String

                val subTools = (agent.activeSubagentToolIds as java.util.concurrent.ConcurrentHashMap<String, MutableSet<String>>)
                    .computeIfAbsent(parentToolId) { ConcurrentHashMap.newKeySet() }
                subTools.add(blockId)

                val subNames = (agent.activeSubagentToolNames as java.util.concurrent.ConcurrentHashMap<String, MutableMap<String, String>>)
                    .computeIfAbsent(parentToolId) { ConcurrentHashMap() }
                subNames[blockId] = toolName

                if (toolName !in TimerManager.PERMISSION_EXEMPT_TOOLS) {
                    hasNonExemptSubTool = true
                }

                sendToWebview("subagentToolStart", mapOf(
                    "id" to agentId,
                    "parentToolId" to parentToolId,
                    "toolId" to blockId,
                    "status" to status,
                ))
            }
        }
        if (hasNonExemptSubTool) {
            timerManager.startPermissionTimer(agentId)
        }

        // Sub-agent signaled end of its turn → it's done.
        // Treat any non-tool stop reason as completion so a sub-agent that
        // exits via stop_sequence / max_tokens doesn't linger until the 2min
        // idle watchdog.
        if (stopReason != null && stopReason != "tool_use") {
            clearAsyncSubagent(agentId, agent, parentToolId)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun processSubagentUser(
        agentId: Int, agent: AgentState, parentToolId: String, record: Map<String, Any?>
    ) {
        val message = record["message"] as? Map<String, Any?> ?: return
        val content = message["content"] as? List<Map<String, Any?>> ?: return
        processSubagentToolResults(agentId, agent, parentToolId, content)
    }

    private fun processSubagentToolResults(
        agentId: Int, agent: AgentState, parentToolId: String, content: List<Map<String, Any?>>
    ) {
        for (block in content) {
            if (block["type"] == "tool_result" && block["tool_use_id"] != null) {
                val toolUseId = block["tool_use_id"] as String
                agent.activeSubagentToolIds[parentToolId]?.remove(toolUseId)
                agent.activeSubagentToolNames[parentToolId]?.remove(toolUseId)

                delayScheduler.schedule({
                    sendToWebview("subagentToolDone", mapOf(
                        "id" to agentId,
                        "parentToolId" to parentToolId,
                        "toolId" to toolUseId,
                    ))
                }, Constants.TOOL_DONE_DELAY_MS, TimeUnit.MILLISECONDS)
            }
        }
    }

    fun dispose() {
        delayScheduler.shutdownNow()
    }
}
