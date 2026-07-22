package com.pixelagents.intellij

import com.google.gson.JsonParser
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Rolling 5-hour token-usage window for the global HUD (BEHAVIOR_SPEC §3).
 *
 * Mirrors mcp-bridge's `quotaWindow.ts`: neither the CLI nor Desktop expose a
 * "% of 5h quota" API, but every assistant turn's exact token usage is written
 * to `~/.claude/projects/<proj>/<session>.jsonl` (`message.usage`). We sum the
 * usage of assistant records whose `timestamp` falls inside the last 5 hours,
 * across ALL projects on this machine (the quota is account-level, not
 * per-project), and push the absolute number to the webview once a minute as
 * a `quotaWindow` message — the HUD renders it as e.g. "1.2M / 5h".
 *
 * Per the spec we deliberately show absolute tokens, not a percentage: the
 * plan budget (denominator) can't be probed from disk.
 *
 * Unlike the bridge (which re-reads every recent file each tick), we keep a
 * per-file cache keyed by (size, mtime) holding the parsed
 * (timestampMs, tokens) pairs, so a quiet minute costs only directory stats.
 */
class QuotaWindowTracker(
    private val sendToWebview: (String, Map<String, Any?>) -> Unit,
) {
    companion object {
        private val LOG = Logger.getInstance(QuotaWindowTracker::class.java)
    }

    private data class FileCache(val size: Long, val mtime: Long, val entries: List<Pair<Long, Long>>)

    private val cache = ConcurrentHashMap<String, FileCache>()

    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "pixel-agents-quota-window").apply { isDaemon = true }
    }

    fun start() {
        scheduler.scheduleAtFixedRate({ tick() }, 0, Constants.QUOTA_TICK_MS, TimeUnit.MILLISECONDS)
    }

    /** Push the current window sum immediately (used on webview reload so the
     *  HUD doesn't show 0 for up to a minute until the next tick). */
    fun pushNow() {
        scheduler.execute { tick() }
    }

    private fun tick() {
        try {
            val tokens = calculateWindowTokens()
            sendToWebview("quotaWindow", mapOf("tokensUsed" to tokens))
        } catch (e: Exception) {
            // Never let a parse/IO hiccup kill the scheduled task.
            LOG.warn("quota window scan failed", e)
        }
    }

    private fun calculateWindowTokens(): Long {
        val cutoff = System.currentTimeMillis() - Constants.QUOTA_WINDOW_MS
        val baseDir = File(System.getProperty("user.home"), ".claude/projects")
        val projects = baseDir.listFiles() ?: return 0L
        var total = 0L
        for (proj in projects) {
            if (!proj.isDirectory) continue
            val files = proj.listFiles { f -> f.isFile && f.name.endsWith(".jsonl") } ?: continue
            for (file in files) {
                // A file untouched since the cutoff can't contribute in-window
                // rows — skip the read and drop any stale cache entry.
                if (file.lastModified() < cutoff) {
                    cache.remove(file.path)
                    continue
                }
                for ((ts, tokens) in entriesFor(file)) {
                    if (ts >= cutoff) total += tokens
                }
            }
        }
        return total
    }

    /** Parsed (timestampMs, tokens) pairs for one JSONL, cached by size+mtime. */
    private fun entriesFor(file: File): List<Pair<Long, Long>> {
        val size = file.length()
        val mtime = file.lastModified()
        cache[file.path]?.let { if (it.size == size && it.mtime == mtime) return it.entries }

        val entries = ArrayList<Pair<Long, Long>>()
        try {
            file.forEachLine { line ->
                if (line.isEmpty() || !line.contains("\"assistant\"")) return@forEachLine
                try {
                    val obj = JsonParser.parseString(line).asJsonObject
                    if (obj.get("type")?.asString != "assistant") return@forEachLine
                    val ts = obj.get("timestamp")?.asString ?: return@forEachLine
                    val usage = obj.getAsJsonObject("message")
                        ?.getAsJsonObject("usage") ?: return@forEachLine
                    val tokens =
                        (usage.get("input_tokens")?.asLong ?: 0L) +
                            (usage.get("cache_creation_input_tokens")?.asLong ?: 0L) +
                            (usage.get("cache_read_input_tokens")?.asLong ?: 0L) +
                            (usage.get("output_tokens")?.asLong ?: 0L)
                    if (tokens > 0L) entries.add(Instant.parse(ts).toEpochMilli() to tokens)
                } catch (_: Exception) {
                    // Partial line / unexpected shape — skip, never throw.
                }
            }
        } catch (e: Exception) {
            LOG.warn("failed reading ${file.path}", e)
            return entries
        }
        cache[file.path] = FileCache(size, mtime, entries)
        return entries
    }

    fun dispose() {
        scheduler.shutdownNow()
        cache.clear()
    }
}
