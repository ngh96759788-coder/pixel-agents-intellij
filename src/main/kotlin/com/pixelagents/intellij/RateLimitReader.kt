package com.pixelagents.intellij

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File

/**
 * Real 5h / 7d rate-limit usage for the HUD (BEHAVIOR_SPEC §3). Mirrors
 * mcp-bridge's `rateLimits.ts`.
 *
 * The CLI reading (`~/.pixel-agents/rate-limits.json`, written by the
 * statusline script) carries `resetsAt` and stays valid until then: usage
 * cannot drop before a reset, so an old value is still a lower bound. Claude
 * Desktop's `plan-usage-history.json` has no reset time, so only a recent
 * sample is trusted. When both are valid the more recently measured one wins.
 */
object RateLimitReader {

    data class Reading(
        val fiveHourPct: Double,
        val sevenDayPct: Double?,
        val resetsAtMs: Long?,
        val sevenDayResetsAtMs: Long?,
        val source: String,
        val sampledAtMs: Long,
    ) {
        fun toMessage(): Map<String, Any?> = mapOf(
            "fiveHourPct" to fiveHourPct,
            "sevenDayPct" to sevenDayPct,
            "resetsAt" to resetsAtMs,
            "sevenDayResetsAt" to sevenDayResetsAtMs,
            "source" to source,
            "sampledAt" to sampledAtMs,
        )
    }

    private fun JsonObject.number(key: String): Double? =
        get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asDouble

    private fun JsonObject.obj(key: String): JsonObject? =
        get(key)?.takeIf { it.isJsonObject }?.asJsonObject

    fun parseCli(raw: String, nowMs: Long): Reading? = try {
        val d = JsonParser.parseString(raw).asJsonObject
        val five = d.obj("fiveHour")
        val pct = five?.number("usedPercentage")
        val resetsSec = five?.number("resetsAt")
        val updatedAt = d.number("updatedAt")
        if (pct == null || resetsSec == null || updatedAt == null) {
            null
        } else {
            val resetsAtMs = (resetsSec * 1000).toLong()
            if (resetsAtMs <= nowMs) {
                null
            } else {
                val sevenDay = d.obj("sevenDay")
                Reading(
                    fiveHourPct = pct,
                    sevenDayPct = sevenDay?.number("usedPercentage"),
                    resetsAtMs = resetsAtMs,
                    sevenDayResetsAtMs = sevenDay?.number("resetsAt")?.let { (it * 1000).toLong() },
                    source = "cli",
                    sampledAtMs = updatedAt.toLong(),
                )
            }
        }
    } catch (_: Exception) {
        null
    }

    fun parseDesktop(raw: String, nowMs: Long): Reading? = try {
        val samples = JsonParser.parseString(raw).asJsonObject.get("samples")
            ?.takeIf { it.isJsonArray }?.asJsonArray
        var latest: Reading? = null
        samples?.forEach { el ->
            val s = el.takeIf { it.isJsonObject }?.asJsonObject ?: return@forEach
            val t = s.number("t")?.toLong() ?: return@forEach
            val u = s.obj("u") ?: return@forEach
            val fh = u.number("fh") ?: return@forEach
            if (latest == null || t > latest!!.sampledAtMs) {
                latest = Reading(fh, u.number("sd"), null, null, "desktop", t)
            }
        }
        latest?.takeIf { nowMs - it.sampledAtMs <= Constants.DESKTOP_USAGE_SAMPLE_MAX_AGE_MS }
    } catch (_: Exception) {
        null
    }

    fun pick(cli: Reading?, desktop: Reading?): Reading? = when {
        cli == null -> desktop
        desktop == null -> cli
        desktop.sampledAtMs > cli.sampledAtMs -> desktop
        else -> cli
    }

    private fun desktopHistoryFile(home: String): File? {
        val os = System.getProperty("os.name").lowercase()
        return when {
            os.contains("mac") -> File(home, "Library/Application Support/Claude/${Constants.DESKTOP_USAGE_HISTORY_FILE_NAME}")
            os.contains("win") -> System.getenv("APPDATA")?.let { File(it, "Claude/${Constants.DESKTOP_USAGE_HISTORY_FILE_NAME}") }
            else -> File(home, ".config/Claude/${Constants.DESKTOP_USAGE_HISTORY_FILE_NAME}")
        }
    }

    private fun readOrNull(file: File?): String? = try {
        file?.takeIf { it.isFile }?.readText()
    } catch (_: Exception) {
        null
    }

    fun read(nowMs: Long = System.currentTimeMillis()): Reading? {
        val home = System.getProperty("user.home")
        val cliRaw = readOrNull(File(home, "${Constants.LAYOUT_FILE_DIR}/${Constants.RATE_LIMITS_FILE_NAME}"))
        val desktopRaw = readOrNull(desktopHistoryFile(home))
        return pick(cliRaw?.let { parseCli(it, nowMs) }, desktopRaw?.let { parseDesktop(it, nowMs) })
    }
}
