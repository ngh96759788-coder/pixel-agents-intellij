package com.pixelagents.intellij

data class AgentState(
    val id: Int,
    val terminalName: String,
    val projectDir: String,
    var jsonlFile: String,
    var fileOffset: Long = 0,
    var lineBuffer: String = "",
    val activeToolIds: MutableSet<String> = mutableSetOf(),
    val activeToolStatuses: MutableMap<String, String> = mutableMapOf(),
    val activeToolNames: MutableMap<String, String> = mutableMapOf(),
    val activeSubagentToolIds: MutableMap<String, MutableSet<String>> = mutableMapOf(),
    val activeSubagentToolNames: MutableMap<String, MutableMap<String, String>> = mutableMapOf(),
    /** Async sub-agents keyed by parent Agent tool_use id (e.g. "toolu_..."). */
    val asyncSubagents: MutableMap<String, AsyncSubagent> = mutableMapOf(),
    var isWaiting: Boolean = false,
    var permissionSent: Boolean = false,
    var hadToolsInTurn: Boolean = false,
)

/**
 * Tracks one async sub-agent whose work lives in a separate JSONL file
 * at `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`.
 */
data class AsyncSubagent(
    val parentToolId: String,
    val subagentId: String,
    val jsonlFile: String,
    var fileOffset: Long = 0,
    var lineBuffer: String = "",
)

data class PersistedAgent(
    val id: Int,
    val terminalName: String,
    val jsonlFile: String,
    val projectDir: String,
    val asyncSubagents: List<PersistedAsyncSubagent> = emptyList(),
)

data class PersistedAsyncSubagent(
    val parentToolId: String,
    val subagentId: String,
    val jsonlFile: String,
)
