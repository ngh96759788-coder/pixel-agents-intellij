package com.pixelagents.intellij

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedDeque

data class AgentState(
    val id: Int,
    val terminalName: String,
    val projectDir: String,
    var jsonlFile: String,
    @Volatile var fileOffset: Long = 0,
    @Volatile var lineBuffer: String = "",
    // Concurrent collections: touched from TranscriptParser (FileWatcher thread pool),
    // TimerManager scheduler, and AgentManager session-alive checker. Replacing the
    // default mutable collections prevents ConcurrentModificationException when
    // multiple executors read/write the same agent's state.
    val activeToolIds: MutableSet<String> = ConcurrentHashMap.newKeySet(),
    val activeToolStatuses: MutableMap<String, String> = ConcurrentHashMap(),
    val activeToolNames: MutableMap<String, String> = ConcurrentHashMap(),
    val activeSubagentToolIds: MutableMap<String, MutableSet<String>> = ConcurrentHashMap(),
    val activeSubagentToolNames: MutableMap<String, MutableMap<String, String>> = ConcurrentHashMap(),
    /** Async sub-agents keyed by parent Agent tool_use id (e.g. "toolu_..."). */
    val asyncSubagents: MutableMap<String, AsyncSubagent> = ConcurrentHashMap(),
    /**
     * Parent Agent tool_use ids whose sub JSONL has not appeared yet.
     * Folder watcher dequeues in FIFO order as new agent-*.jsonl files
     * are created under <sessionId>/subagents/.
     */
    val pendingSubagentIds: ConcurrentLinkedDeque<String> = ConcurrentLinkedDeque(),
    @Volatile var subagentFolderWatched: Boolean = false,
    @Volatile var isWaiting: Boolean = false,
    @Volatile var permissionSent: Boolean = false,
    @Volatile var hadToolsInTurn: Boolean = false,
)

/**
 * Tracks one async sub-agent whose work lives in a separate JSONL file
 * at `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`.
 */
data class AsyncSubagent(
    val parentToolId: String,
    val subagentId: String,
    val jsonlFile: String,
    @Volatile var fileOffset: Long = 0,
    @Volatile var lineBuffer: String = "",
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
