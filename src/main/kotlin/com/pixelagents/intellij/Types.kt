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
    /**
     * tool_use ids of Bash tools launched with `run_in_background: true` whose
     * tool_result hasn't arrived yet. BEHAVIOR_SPEC §2: while a background Bash
     * is still running the character must stay active — these ids survive
     * `turn_duration` clearing and suppress the waiting/idle transition and the
     * stale-session despawn until the matching tool_result lands.
     */
    val backgroundToolIds: MutableSet<String> = ConcurrentHashMap.newKeySet(),
    @Volatile var subagentFolderWatched: Boolean = false,
    @Volatile var isWaiting: Boolean = false,
    @Volatile var permissionSent: Boolean = false,
    @Volatile var hadToolsInTurn: Boolean = false,
    /** Last observed prompt-side context tokens (input + cache_creation + cache_read).
     *  Updated whenever an assistant record carries a `message.usage` block. -1 = unknown. */
    @Volatile var lastContextTokens: Long = -1L,
    /** Last observed model id from `message.model` (e.g. "claude-opus-4-7"). Empty = unknown. */
    @Volatile var lastModel: String = "",
    /** `message.id` of the assistant record whose usage was last folded into the
     *  cumulative counters. Claude Code writes one API response as several
     *  `assistant` lines (text / thinking / tool_use), each repeating the same
     *  usage block — without this guard every such turn is counted twice. */
    @Volatile var lastUsageMessageId: String = "",
    /** Cumulative API throughput across all turns in this session.
     *  Each field accumulates from `message.usage` on every assistant record:
     *  - cumulativeInput / cacheCreate / cacheRead / output
     *  These are NOT context window measurements — they're the total billable
     *  throughput so far. Cost is estimated webview-side using model rates. */
    @Volatile var cumulativeInput: Long = 0L,
    @Volatile var cumulativeCacheCreate: Long = 0L,
    @Volatile var cumulativeCacheRead: Long = 0L,
    @Volatile var cumulativeOutput: Long = 0L,
    /** True when this session was started outside this IDE instance (e.g. another
     *  IntelliJ window or a CLI on the same project) and adopted via folder scan.
     *  Used by the webview to render the character at reduced opacity with an
     *  external badge so users can tell at a glance which work belongs to *this*
     *  IDE versus shared peers. */
    @Volatile var isExternal: Boolean = false,
    /** True when this agent was discovered via JSONL adoption (user typed
     *  `claude` directly in a terminal) rather than launched through the
     *  + Agent button. The webview uses this to skip showing the synthetic
     *  "Claude Code #N" name for adopted sessions — that internal label is
     *  meaningless to the user, who only knows their real terminal tab
     *  ("local", "local(2)", etc). Falls back to `main ${id}` in the UI. */
    @Volatile var isAdopted: Boolean = false,
    /** Git branch of the worktree this session runs in, when the session was
     *  adopted from a worktree of the open repo (IntelliJ 2026.1 task hand-off).
     *  null for the main worktree / non-worktree sessions. The webview shows it
     *  as a "↳branch" suffix so users can tell which branch each agent works on. */
    @Volatile var worktreeBranch: String? = null,
)

/**
 * Tracks one async sub-agent whose work lives in a separate JSONL file
 * at `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`.
 */
data class AsyncSubagent(
    val parentToolId: String,
    val subagentId: String,
    val jsonlFile: String,
    /** The parent's "Subtask[type]: desc" status at bind time. Preserved so the
     *  sub-agent character can be respawned with the correct label after a
     *  webview reload, even if the parent's Task tool_result has already
     *  arrived and removed activeToolStatuses[parentToolId]. */
    val taskStatus: String = "",
    @Volatile var fileOffset: Long = 0,
    @Volatile var lineBuffer: String = "",
)

data class PersistedAgent(
    val id: Int,
    val terminalName: String,
    val jsonlFile: String,
    val projectDir: String,
    val asyncSubagents: List<PersistedAsyncSubagent> = emptyList(),
    val isExternal: Boolean = false,
    val isAdopted: Boolean = false,
    val worktreeBranch: String? = null,
)

data class PersistedAsyncSubagent(
    val parentToolId: String,
    val subagentId: String,
    val jsonlFile: String,
    val taskStatus: String = "",
)
