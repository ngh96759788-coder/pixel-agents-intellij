package com.pixelagents.intellij

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Enumerates the git worktrees of the IDE's open repo and maps each to its
 * `~/.claude/projects/<hash>/` dir, so Claude agents launched in a worktree
 * (IntelliJ 2026.1's "hand off task to agent" flow) appear in the same office.
 *
 * Deliberately scoped to THIS repo's worktrees only — it does NOT re-enable the
 * global cross-project discovery that was disabled for adopting unrelated
 * sessions. Worktree membership is the trust signal: the derived dirs are
 * registered as `trusted` so adoption skips the process-ancestry heuristic
 * (a handed-off agent may run outside this IDE's process tree) while the
 * cross-window peer-ownership check still applies.
 */
class WorktreeDetector(
    private val basePath: String?,
    /** Maps a worktree cwd to its `~/.claude/projects/<hash>/` dir (= AgentManager::getProjectDirPath). */
    private val projectDirForCwd: (String) -> String?,
    private val onWorktreeProjectDir: (projectDir: String, worktreePath: String, branch: String?) -> Unit,
) : Disposable {

    companion object {
        private val LOG = Logger.getInstance(WorktreeDetector::class.java)
        private const val GIT_TIMEOUT_SEC = 5L

        /** One worktree entry from `git worktree list --porcelain`. [branch] is the
         *  short name (refs/heads/ stripped) or null for a detached HEAD. */
        data class ParsedWorktree(val path: String, val branch: String?)

        /**
         * Parse `git worktree list --porcelain`. Pure — no git, no IO — so it's
         * unit-testable. Porcelain emits one block per worktree:
         *   worktree <abs-path>
         *   HEAD <sha>
         *   branch refs/heads/<name>   (absent for detached HEAD)
         * Blocks are blank-line separated; the final block has no trailing blank.
         * Flushing on each new `worktree ` line (in addition to blank lines) makes
         * the parse robust to either delimiter.
         */
        fun parseWorktrees(porcelain: String): List<ParsedWorktree> {
            val result = mutableListOf<ParsedWorktree>()
            var path: String? = null
            var branch: String? = null
            fun flush() {
                val p = path ?: return
                result.add(ParsedWorktree(p, branch?.removePrefix("refs/heads/")))
                path = null
                branch = null
            }
            for (line in porcelain.lineSequence()) {
                when {
                    line.startsWith("worktree ") -> {
                        flush()
                        path = line.removePrefix("worktree ").trim()
                    }
                    line.startsWith("branch ") -> branch = line.removePrefix("branch ").trim()
                    line.isBlank() -> flush()
                }
            }
            flush()
            return result
        }
    }

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-WorktreeDetector").apply { isDaemon = true }
    }
    private var timer: ScheduledFuture<*>? = null

    /** Worktree paths already reported, so we don't re-emit them every tick. */
    private val seen = HashSet<String>()

    fun start() {
        timer = executor.scheduleWithFixedDelay({
            try {
                scan()
            } catch (e: Exception) {
                LOG.debug("worktree scan failed", e)
            }
        }, 0, Constants.WORKTREE_SCAN_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun scan() {
        val base = basePath ?: return
        // Cheap gate: skip non-git projects. `.git` is a dir in a normal repo and
        // a file in a worktree/submodule — either way its presence means git here.
        if (!File(base, ".git").exists()) return

        val out = runGit(base, "worktree", "list", "--porcelain") ?: return
        for (wt in parseWorktrees(out)) emit(wt.path, wt.branch)
    }

    private fun emit(worktreePath: String, branch: String?) {
        val base = basePath ?: return
        // Skip the main worktree — basePath is already scanned by ensureProjectScan.
        try {
            if (File(worktreePath).canonicalPath == File(base).canonicalPath) return
        } catch (_: Exception) {
            // canonicalPath can throw on a stale/removed worktree path; fall back
            // to a plain string compare rather than dropping the entry.
            if (worktreePath == base) return
        }
        if (!seen.add(worktreePath)) return
        val dir = projectDirForCwd(worktreePath) ?: return
        LOG.info("Worktree detected: $worktreePath -> $dir (branch=$branch)")
        onWorktreeProjectDir(dir, worktreePath, branch)
    }

    private fun runGit(cwd: String, vararg args: String): String? = try {
        val p = ProcessBuilder(listOf("git", "-C", cwd) + args)
            .redirectErrorStream(true)
            .start()
        val text = p.inputStream.bufferedReader().readText()
        if (p.waitFor(GIT_TIMEOUT_SEC, TimeUnit.SECONDS) && p.exitValue() == 0) {
            text
        } else {
            p.destroyForcibly()
            null
        }
    } catch (_: Exception) {
        // git missing from PATH, or any spawn failure — best-effort, no-op.
        null
    }

    override fun dispose() {
        timer?.cancel(false)
        executor.shutdownNow()
    }
}
