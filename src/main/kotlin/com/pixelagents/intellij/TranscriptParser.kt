package com.pixelagents.intellij

import com.google.gson.Gson
import java.io.File
import java.util.concurrent.*

class TranscriptParser(
    private val sendToWebview: (String, Map<String, Any?>) -> Unit,
    private val agents: ConcurrentHashMap<Int, AgentState>,
    private val timerManager: TimerManager,
) {
    private val gson = Gson()
    private val delayScheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-ToolDoneDelay").apply { isDaemon = true }
    }

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
            "Task" -> {
                val desc = input["description"] as? String ?: ""
                if (desc.isNotEmpty()) "Subtask: ${if (desc.length > Constants.TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) desc.take(Constants.TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + "\u2026" else desc}"
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
                for (block in blocks) {
                    if (block["type"] == "tool_result" && block["tool_use_id"] != null) {
                        val completedToolId = block["tool_use_id"] as String

                        // If completed tool was a Task, clear its subagent tools
                        if (agent.activeToolNames[completedToolId] == "Task") {
                            agent.activeSubagentToolIds.remove(completedToolId)
                            agent.activeSubagentToolNames.remove(completedToolId)
                            sendToWebview("subagentClear", mapOf(
                                "id" to agentId,
                                "parentToolId" to completedToolId,
                            ))
                        }

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
            agent.activeSubagentToolIds.clear()
            agent.activeSubagentToolNames.clear()
            sendToWebview("agentToolsClear", mapOf("id" to agentId))
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

        // Verify parent is an active Task tool
        if (agent.activeToolNames[parentToolId] != "Task") return

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

                    val subTools = agent.activeSubagentToolIds.getOrPut(parentToolId) { mutableSetOf() }
                    subTools.add(blockId)

                    val subNames = agent.activeSubagentToolNames.getOrPut(parentToolId) { mutableMapOf() }
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

    fun dispose() {
        delayScheduler.shutdownNow()
    }
}
