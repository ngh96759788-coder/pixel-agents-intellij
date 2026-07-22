package com.pixelagents.intellij

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
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
    private val instanceManifest: InstanceManifest,
) : Disposable {

    companion object {
        private val LOG = Logger.getInstance(FileWatcher::class.java)
        /** Maximum bytes read per polling tick. Prevents OOM on historical JSONL adoption. */
        private const val READ_CHUNK_BYTES: Long = 8L * 1024 * 1024 // 8 MiB
    }

    private val executor = Executors.newScheduledThreadPool(3) { r ->
        Thread(r, "PixelAgents-FileWatcher").apply { isDaemon = true }
    }

    /**
     * Callback to adopt a session surfaced by unified-view external discovery
     * (BEHAVIOR_SPEC §4). Distinct from [onNewAgentFile] (the normal, own-scope
     * adoption) so the caller can flag the resulting agent `isExternal = true`.
     */
    var onExternalAgentFile: ((String) -> Unit)? = null

    /** ~/.claude/projects root, captured when external discovery starts. */
    @Volatile private var externalDiscoveryRoot: String? = null

    /** Periodic timer that scans ~/.claude/projects for foreign active sessions
     *  while unified view is ON. Null when unified view is OFF. */
    private var externalDiscoveryTimer: ScheduledFuture<*>? = null

    private val watchServices = ConcurrentHashMap<Int, WatchService>()
    private val pollingTimers = ConcurrentHashMap<Int, ScheduledFuture<*>>()
    private val jsonlPollTimers = ConcurrentHashMap<Int, ScheduledFuture<*>>()
    /** One scan timer per project hash dir. Plugin can watch multiple Claude projects in parallel
     *  (e.g. an external `claude` started in a different cwd than the IntelliJ basePath). */
    private val projectScanTimers = ConcurrentHashMap<String, ScheduledFuture<*>>()

    /** Project-hash dirs derived from git worktrees of the IDE's open repo.
     *  Membership proves the session belongs to the open project, so adoption
     *  skips the `hasOwnClaudeDescendant` heuristic for these (a worktree agent
     *  handed off by IntelliJ 2026.1 may run in a detached process tree). The
     *  peer-ownership check is still enforced to avoid cross-window duplication. */
    private val trustedDirs = ConcurrentHashMap.newKeySet<String>()

    /** projectDir → git branch, for worktree-derived dirs. Used to label adopted
     *  worktree agents with the branch they're working on. */
    private val worktreeBranches = ConcurrentHashMap<String, String>()

    /** Periodic timer that re-runs discovery to pick up claude sessions started after IDE open. */
    private var discoveryTimer: ScheduledFuture<*>? = null

    /** Async sub-agent file watchers keyed by "agentId:parentToolId". */
    private val subagentPollTimers = ConcurrentHashMap<String, ScheduledFuture<*>>()

    /** Folder watchers that discover new agent-*.jsonl files under <sessionId>/subagents/ */
    private val subagentFolderTimers = ConcurrentHashMap<Int, ScheduledFuture<*>>()
    private val knownSubagentFiles = ConcurrentHashMap<Int, MutableSet<String>>()

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
        parser.onSubagentToolUseStarted = { agentId, _ ->
            ensureSubagentFolderWatch(agentId)
        }
        parser.onTryBindSubagentFiles = { agentId ->
            try { tryBindSubagentFiles(agentId) } catch (_: Exception) {}
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
            LOG.warn("WatchService failed for agent $agentId", e)
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

            // Cap a single read at CHUNK bytes so that adopting a large historical
            // JSONL does not attempt a 2GB ByteArray allocation (sleuth H2:
            // `(size - offset).toInt()` could overflow to a negative value and
            // throw NegativeArraySizeException, silently freezing the agent).
            val available = size - agent.fileOffset
            val toRead = minOf(available, READ_CHUNK_BYTES).toInt()
            val buf = ByteArray(toRead)
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(agent.fileOffset)
                raf.readFully(buf)
            }
            agent.fileOffset += toRead

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
            LOG.warn("Read error for agent $agentId", e)
        }
    }

    fun startJsonlPoll(agentId: Int, @Suppress("UNUSED_PARAMETER") agent: AgentState) {
        val future = executor.scheduleAtFixedRate({
            try {
                // Re-fetch the live agent each tick. The agent passed in may have
                // been removed (closeAgent) or have its jsonlFile swapped
                // (reassignAgentToFile / /clear) in the meantime — using the
                // captured reference would re-open the old session file.
                val live = agents[agentId] ?: run {
                    jsonlPollTimers.remove(agentId)?.cancel(false)
                    return@scheduleAtFixedRate
                }
                val file = File(live.jsonlFile)
                if (file.exists()) {
                    LOG.info("Agent $agentId: found JSONL file ${file.name}")
                    jsonlPollTimers.remove(agentId)?.cancel(false)
                    // Re-verify the agent is still live before kicking off
                    // a watcher — concurrent stopWatching could orphan it.
                    if (agents.containsKey(agentId)) {
                        startFileWatching(agentId, live.jsonlFile)
                        readNewLines(agentId)
                    }
                }
            } catch (_: Exception) {
            }
        }, 0, Constants.JSONL_POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
        jsonlPollTimers[agentId] = future
    }

    /** Record the git branch for a worktree-derived project dir. */
    fun registerWorktreeBranch(projectDir: String, branch: String) {
        worktreeBranches[projectDir] = branch
    }

    /** Branch label for a JSONL file based on its parent dir, or null if the
     *  file isn't in a known worktree dir. */
    fun worktreeBranchForFile(filePath: String): String? =
        File(filePath).parent?.let { worktreeBranches[it] }

    fun ensureProjectScan(projectDir: String, trusted: Boolean = false) {
        if (trusted) trustedDirs.add(projectDir)
        if (projectScanTimers.containsKey(projectDir)) return

        // Don't seed knownJsonlFiles here. scanForNewJsonlFiles handles each
        // file individually: peer-owned ones get marked known + ignored, old
        // ones are skipped without marking (cheap re-check), and recent
        // unowned ones get adopted. Seeding everything up front would prevent
        // adopting a `claude` session that was launched seconds before this
        // IDE window opened.
        val future = executor.scheduleAtFixedRate({
            scanForNewJsonlFiles(projectDir)
        }, Constants.PROJECT_SCAN_INTERVAL_MS, Constants.PROJECT_SCAN_INTERVAL_MS, TimeUnit.MILLISECONDS)
        projectScanTimers[projectDir] = future
    }

    /**
     * Discover Claude project subdirs under [claudeProjectsRoot] with recent JSONL activity
     * (within [maxAgeMs] ms) and start a project scanner for each. Lets the plugin auto-pick up
     * sessions that were started in a cwd other than the IntelliJ project basePath.
     */
    fun discoverActiveProjectScans(claudeProjectsRoot: String, maxAgeMs: Long) {
        val root = File(claudeProjectsRoot)
        if (!root.isDirectory) return
        val now = System.currentTimeMillis()
        val subDirs = root.listFiles { f -> f.isDirectory } ?: return
        for (subDir in subDirs) {
            val path = subDir.absolutePath
            if (projectScanTimers.containsKey(path)) continue
            val jsonls = subDir.listFiles { f -> f.extension == "jsonl" } ?: continue
            val hasRecent = jsonls.any { now - it.lastModified() <= maxAgeMs }
            if (hasRecent) {
                LOG.info("Auto-discovered active Claude project: ${subDir.name}")
                ensureProjectScan(path)
            }
        }
    }

    /**
     * Periodically re-run [discoverActiveProjectScans] so claude sessions started after IDE open
     * are picked up without requiring +Agent or restart. Idempotent — only one discovery timer.
     */
    fun startPeriodicDiscovery(claudeProjectsRoot: String, maxAgeMs: Long, intervalMs: Long) {
        if (discoveryTimer != null) return
        discoveryTimer = executor.scheduleAtFixedRate({
            try {
                discoverActiveProjectScans(claudeProjectsRoot, maxAgeMs)
            } catch (_: Exception) {
            }
        }, intervalMs, intervalMs, TimeUnit.MILLISECONDS)
    }

    // ── Unified-view external discovery (BEHAVIOR_SPEC §4) ─────────────
    //
    // When the "통합 보기" toggle is ON, periodically enumerate every
    // ~/.claude/projects/<hash>/ dir and surface RECENTLY ACTIVE sessions that
    // this window doesn't already track as EXTERNAL agents (rendered faded by
    // the webview). This is the cross-project discovery that was intentionally
    // removed for the default path (see the "4b" comment in the tool-window
    // factory) — it is re-enabled here ONLY behind the toggle AND ONLY as
    // external/faded agents, never as normal opaque characters.

    /** Start periodic external discovery. Idempotent — a second call while a
     *  timer already runs is a no-op. [claudeProjectsRoot] is ~/.claude/projects. */
    fun startExternalDiscovery(claudeProjectsRoot: String) {
        externalDiscoveryRoot = claudeProjectsRoot
        if (externalDiscoveryTimer != null) return
        // Initial delay = one full interval so the own-project scan (step 4) and
        // the git-worktree scans (step 4a) have registered their projectScanTimers
        // before we run — otherwise a worktree session could be briefly adopted
        // as external before the worktree detector claims its dir.
        externalDiscoveryTimer = executor.scheduleAtFixedRate({
            try {
                scanForExternalSessions()
            } catch (_: Exception) {
            }
        }, Constants.PROJECT_DISCOVERY_INTERVAL_MS, Constants.PROJECT_DISCOVERY_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    /** Stop periodic external discovery (unified view toggled OFF). Does NOT
     *  remove already-adopted external agents — the caller closes those. */
    fun stopExternalDiscovery() {
        externalDiscoveryTimer?.cancel(false)
        externalDiscoveryTimer = null
    }

    private fun scanForExternalSessions() {
        val rootPath = externalDiscoveryRoot ?: return
        val root = File(rootPath)
        if (!root.isDirectory) return
        val now = System.currentTimeMillis()
        val subDirs = root.listFiles { f -> f.isDirectory } ?: return
        for (subDir in subDirs) {
            // Skip dirs handled by the normal (own/opaque) path. The IDE's own
            // project dir (step 4) and each git-worktree dir of the open repo
            // (step 4a) both register a projectScanTimer via ensureProjectScan;
            // their sessions must render as normal agents, not faded externals.
            if (projectScanTimers.containsKey(subDir.absolutePath)) continue

            val jsonls = subDir.listFiles { f -> f.extension == "jsonl" } ?: continue
            for (file in jsonls) {
                val path = file.absolutePath
                // Already tracked: an own launched/adopted/restored session, or
                // an external we already adopted. adoptExternalAgent adds to
                // knownJsonlFiles, so this also prevents double-adoption.
                if (path in knownJsonlFiles) continue
                // Only surface RECENTLY ACTIVE sessions (mtime within the main
                // stale threshold, 60s). Older ones despawn / never spawn.
                if (now - file.lastModified() > Constants.SESSION_STALE_THRESHOLD_MS) continue
                // Deliberately SKIP hasOwnClaudeDescendant() and
                // instanceManifest.isOwnedByPeer() here: peer-owned / foreign
                // sessions are exactly what unified view wants to show.
                onExternalAgentFile?.invoke(path)
            }
        }
    }

    private fun scanForNewJsonlFiles(projectDir: String) {
        val files = try {
            File(projectDir).listFiles { f -> f.extension == "jsonl" }
                ?.map { it.absolutePath } ?: return
        } catch (_: Exception) {
            return
        }

        for (file in files) {
            if (file in knownJsonlFiles) continue

            val jsonlFile = File(file)
            val ageMs = System.currentTimeMillis() - jsonlFile.lastModified()
            if (ageMs > Constants.ADOPTION_MAX_AGE_MS) {
                // Too old to adopt right now. Do NOT add to knownJsonlFiles —
                // if the user types again later, lastModified updates and the
                // next scan tick will re-evaluate this file for adoption.
                continue
            }

            // Cross-IDE isolation: defence in depth.
            // 1) If another live plugin instance already CLAIMED this path in
            //    the shared manifest, it's definitively theirs. (Best signal,
            //    but only works when the other side has had a chance to
            //    register — first-tick races would otherwise let us steal it.)
            if (instanceManifest.isOwnedByPeer(file)) {
                LOG.info("New JSONL detected but owned by peer IDE: ${jsonlFile.name}, ignoring")
                knownJsonlFiles.add(file)
                continue
            }
            // 2) No manifest claim — fall back to process ancestry. A `claude`
            //    process launched in another IDE's terminal is a descendant of
            //    THAT IDE's PID, not ours. If we can't find any descendant
            //    claude process here, the JSONL almost certainly belongs to
            //    another window or a bare external shell — don't claim it.
            //    (When we ourselves spawn claude through `+ Agent`, the
            //    AgentManager flow registers the path immediately so this
            //    branch isn't reached.)
            //    Exception: worktree-derived dirs are TRUSTED — worktree
            //    membership already proves the session belongs to the open
            //    repo, and a handed-off agent may live outside our process
            //    tree. Peer-ownership (above) still prevents cross-window
            //    double-adoption.
            if (projectDir !in trustedDirs && !hasOwnClaudeDescendant()) {
                LOG.info("New JSONL detected but no claude descendant of this IDE: ${jsonlFile.name}, ignoring")
                knownJsonlFiles.add(file)
                continue
            }

            knownJsonlFiles.add(file)

            val activeId = activeAgentIdRef()
            if (activeId != null && agents.containsKey(activeId)) {
                // Active agent focused → treat as /clear reassignment of that
                // agent's session, so the user's current character follows
                // them across `claude` restarts in the same terminal.
                LOG.info("New JSONL detected: ${jsonlFile.name}, reassigning to agent $activeId")
                reassignAgentToFile(activeId, file)
            } else {
                // No active agent → adopt as a new agent for THIS window.
                // Covers the "user opens a terminal and types `claude`
                // directly" path. Peer-owned files were filtered above; this
                // file is genuinely unclaimed and a claude proc lives under us.
                LOG.info("New JSONL detected: ${jsonlFile.name}, adopting as new agent for this window")
                onNewAgentFile?.invoke(file)
            }
        }
    }

    /** True iff any currently-running `claude` process is a descendant of this
     *  IDE process. Used as a secondary ownership signal when the cross-IDE
     *  manifest has no claim yet for a freshly-created JSONL. The check walks
     *  the parent chain with a small depth cap; matches the binary by basename
     *  to avoid false positives like `claude-foo`. */
    private fun hasOwnClaudeDescendant(): Boolean {
        val myPid = ProcessHandle.current().pid()
        return try {
            ProcessHandle.allProcesses().anyMatch { p ->
                val cmd = p.info().command().orElse("")
                if (cmd.isEmpty()) return@anyMatch false
                val name = cmd.substringAfterLast('/')
                if (name != "claude" && name != "claude.exe") return@anyMatch false
                var cur: ProcessHandle? = p.parent().orElse(null)
                var depth = 0
                while (cur != null && depth++ < 32) {
                    if (cur.pid() == myPid) return@anyMatch true
                    cur = cur.parent().orElse(null)
                }
                false
            }
        } catch (e: Exception) {
            // ProcessHandle can throw on locked-down environments. Best-effort:
            // fall back to treating it as "unknown" → don't adopt.
            LOG.debug("hasOwnClaudeDescendant probe failed", e)
            false
        }
    }

    fun reassignAgentToFile(agentId: Int, newFilePath: String) {
        val agent = agents[agentId] ?: return
        stopWatching(agentId)
        // Clear async sub-agents tied to the previous session so their characters
        // don't linger as ghosts after /clear reassignment.
        for (parentToolId in agent.asyncSubagents.keys.toList()) {
            agent.asyncSubagents.remove(parentToolId)
            sendToWebview("subagentClear", mapOf(
                "id" to agentId,
                "parentToolId" to parentToolId,
            ))
        }
        timerMgr.clearAgentActivity(agent, agentId)
        // Migrate manifest ownership: drop the old JSONL claim, take the new one.
        // Adopted external agents stay external — peers were never claiming the
        // pre-/clear JSONL anyway, so we leave the manifest untouched.
        val oldFile = agent.jsonlFile
        if (!agent.isExternal) {
            instanceManifest.unregisterSession(oldFile)
            instanceManifest.registerSession(newFilePath)
        }
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

        // Stop any async sub-agent watchers tied to this agent. Clean up the
        // start-time / last-activity bookkeeping in the same loop so the maps
        // don't grow unboundedly across many agents over a long session.
        val prefix = "$agentId:"
        for (key in subagentPollTimers.keys.filter { it.startsWith(prefix) }) {
            subagentPollTimers.remove(key)?.cancel(false)
            subagentStartTimes.remove(key)
            subagentLastActivity.remove(key)
        }
        stopSubagentFolderWatch(agentId)
    }

    // ── Sub-agent folder discovery ─────────────────────────────────────
    //
    // Current Claude Code no longer emits an isAsync marker on the parent's
    // tool_result, so we can't rely on the parent JSONL to find sub-agent
    // files. Instead we watch <sessionId>/subagents/ for any new agent-*.jsonl
    // and FIFO-bind them to the agent's pendingSubagentIds queue.

    fun ensureSubagentFolderWatch(agentId: Int) {
        val agent = agents[agentId] ?: return
        if (!agent.subagentFolderWatched) {
            agent.subagentFolderWatched = true
            val future = executor.scheduleAtFixedRate({
                try { tryBindSubagentFiles(agentId) } catch (_: Exception) {}
            }, 0, Constants.SUBAGENT_FOLDER_POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
            subagentFolderTimers[agentId] = future
        }
        // Always do an immediate synchronous scan on the caller's thread so that
        // bindings land before the same readNewLines batch processes a follow-up
        // tool_result record (parent JSONL can be flushed in bursts — e.g. 10s
        // Agent task records all arrive in one readNewLines call).
        try { tryBindSubagentFiles(agentId) } catch (_: Exception) {}
    }

    /** Scan <sessionId>/subagents/ and bind any new agent-*.jsonl to pending parent tool_use ids (FIFO). */
    fun tryBindSubagentFiles(agentId: Int) {
        val agent = agents[agentId] ?: return
        // Serialize binding per agent: otherwise the scheduled 500ms task and
        // the in-thread sync calls race — one thread polls a parent toolId
        // while the other marks the remaining files "known" and drops them,
        // leaving 4 of 5 sub-agents permanently unbound.
        synchronized(agent) {
            val sessionFile = File(agent.jsonlFile)
            val sessionId = sessionFile.nameWithoutExtension
            val subagentFolder = File(File(sessionFile.parentFile, sessionId), "subagents")
            if (!subagentFolder.exists()) return

            val known = knownSubagentFiles.computeIfAbsent(agentId) {
                ConcurrentHashMap.newKeySet<String>()
            }
            val files = subagentFolder.listFiles { f -> f.extension == "jsonl" } ?: return
            val sorted = files.sortedBy { it.lastModified() }
            for (file in sorted) {
                val path = file.absolutePath
                if (known.contains(path)) continue

                // Pop a pending parent BEFORE marking the file known. If no
                // pending parent is available yet, leave the file alone so a
                // later call (once offer() runs) can still pair with it.
                val parentToolId = agent.pendingSubagentIds.pollFirst() ?: break

                known.add(path)
                val subagentId = file.nameWithoutExtension.removePrefix("agent-")
                agent.asyncSubagents[parentToolId] = AsyncSubagent(
                    parentToolId = parentToolId,
                    subagentId = subagentId,
                    jsonlFile = path,
                    taskStatus = agent.activeToolStatuses[parentToolId] ?: "",
                )
                startSubagentWatching(agentId, parentToolId, path)
            }
        }
    }

    private fun stopSubagentFolderWatch(agentId: Int) {
        subagentFolderTimers.remove(agentId)?.cancel(false)
        knownSubagentFiles.remove(agentId)
        agents[agentId]?.subagentFolderWatched = false
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

        val threshold = Constants.SUBAGENT_STALE_THRESHOLD_MS
        val shouldGiveUp = if (!file.exists()) {
            // File never created — give up if Task tool fired but sub-agent JSONL never appeared
            now - started > threshold
        } else {
            // File exists but no new writes for the threshold
            now - lastActive > threshold &&
                now - file.lastModified() > threshold
        }

        if (shouldGiveUp) {
            LOG.info("Sub-agent watcher timeout $agentId/$parentToolId")
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
            val available = size - sub.fileOffset
            val toRead = minOf(available, READ_CHUNK_BYTES).toInt()
            val buf = ByteArray(toRead)
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(sub.fileOffset)
                raf.readFully(buf)
            }
            sub.fileOffset += toRead

            val text = sub.lineBuffer + String(buf, Charsets.UTF_8)
            val lines = text.split("\n")
            sub.lineBuffer = lines.last()
            val completeLines = lines.dropLast(1)

            for (line in completeLines) {
                if (line.isBlank()) continue
                transcriptParser.processSubagentLine(agentId, parentToolId, line)
            }
        } catch (e: Exception) {
            LOG.warn("Subagent read error $agentId/$parentToolId", e)
        }
    }

    override fun dispose() {
        discoveryTimer?.cancel(false)
        discoveryTimer = null
        externalDiscoveryTimer?.cancel(false)
        externalDiscoveryTimer = null
        for (timer in projectScanTimers.values) timer.cancel(false)
        projectScanTimers.clear()
        for (id in agents.keys.toList()) {
            stopWatching(id)
        }
        for (timer in subagentPollTimers.values) timer.cancel(false)
        subagentPollTimers.clear()
        for (timer in subagentFolderTimers.values) timer.cancel(false)
        subagentFolderTimers.clear()
        knownSubagentFiles.clear()
        transcriptParser.dispose()
        executor.shutdownNow()
    }
}
