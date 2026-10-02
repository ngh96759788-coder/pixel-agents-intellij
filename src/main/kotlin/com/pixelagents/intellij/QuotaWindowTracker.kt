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
 * The buckets are weighted (`Constants.QUOTA_WEIGHT_*`) rather than summed
 * raw. Raw, the total is ~99% cache reads and tracks how much history gets
 * re-read rather than how much quota is being consumed.
 *
 * Unlike the bridge (which re-reads every recent file each tick), we keep a
 * per-file cache keyed by (size, mtime) holding the parsed entries, so a quiet
 * minute costs only directory stats.
 *
 * One API response is written to the JSONL as SEVERAL `assistant` lines — one
 * per content-block group (text / thinking / tool_use) — and every one of them
 * repeats the SAME `message.usage` object and the same `message.id`. Summing
 * the lines therefore counts most turns twice (measured: 1.8x). We key on
 * `message.id` and count each response once.
 */
class QuotaWindowTracker(
    private val sendToWebview: (String, Map<String, Any?>) -> Unit,
) {
    companion object {
        private val LOG = Logger.getInstance(QuotaWindowTracker::class.java)

        /**
         * Weighted token cost of one assistant turn's `message.usage`, rounded
         * to a whole token. Exposed at the companion level so unit tests can
         * call it without touching the filesystem or the scheduler.
         */
        fun weightedTokens(
            input: Long,
            cacheCreate: Long,
            cacheRead: Long,
            output: Long,
        ): Long = Math.round(
            input * Constants.QUOTA_WEIGHT_INPUT +
                cacheCreate * Constants.QUOTA_WEIGHT_CACHE_CREATE +
                cacheRead * Constants.QUOTA_WEIGHT_CACHE_READ +
                output * Constants.QUOTA_WEIGHT_OUTPUT
        )
    }

    private data class UsageEntry(val messageId: String, val timestampMs: Long, val tokens: Long)

    private data class FileCache(val size: Long, val mtime: Long, val entries: List<UsageEntry>)

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
            sendToWebview(
                "quotaWindow",
                mapOf("tokensUsed" to tokens, "rateLimit" to RateLimitReader.read()?.toMessage()),
            )
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
        // A resumed/forked session replays earlier responses into a new file
        // with their original ids, so this must be scoped to the whole scan,
        // not per file.
        val counted = HashSet<String>()
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
                for (entry in entriesFor(file)) {
                    if (entry.timestampMs < cutoff) continue
                    if (!counted.add(entry.messageId)) continue
                    total += entry.tokens
                }
            }
        }
        return total
    }

    /** Parsed usage entries for one JSONL, cached by size+mtime. */
    private fun entriesFor(file: File): List<UsageEntry> {
        val size = file.length()
        val mtime = file.lastModified()
        cache[file.path]?.let { if (it.size == size && it.mtime == mtime) return it.entries }

        val entries = ArrayList<UsageEntry>()
        try {
            file.forEachLine { line ->
                if (line.isEmpty() || !line.contains("\"assistant\"")) return@forEachLine
                try {
                    val obj = JsonParser.parseString(line).asJsonObject
                    if (obj.get("type")?.asString != "assistant") return@forEachLine
                    val ts = obj.get("timestamp")?.asString ?: return@forEachLine
                    val message = obj.getAsJsonObject("message") ?: return@forEachLine
                    val usage = message.getAsJsonObject("usage") ?: return@forEachLine
                    // Fall back to the record uuid when the response carries no
                    // id: without a key we would rather count it than drop it.
                    val messageId = message.get("id")?.asString
                        ?: obj.get("uuid")?.asString
                        ?: return@forEachLine
                    val tokens = weightedTokens(
                        input = usage.get("input_tokens")?.asLong ?: 0L,
                        cacheCreate = usage.get("cache_creation_input_tokens")?.asLong ?: 0L,
                        cacheRead = usage.get("cache_read_input_tokens")?.asLong ?: 0L,
                        output = usage.get("output_tokens")?.asLong ?: 0L,
                    )
                    if (tokens > 0L) {
                        entries.add(UsageEntry(messageId, Instant.parse(ts).toEpochMilli(), tokens))
                    }
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
