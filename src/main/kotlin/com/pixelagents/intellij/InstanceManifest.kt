package com.pixelagents.intellij

import com.google.gson.Gson
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Cooperative manifest so multiple Pixel Agents instances (different IntelliJ
 * windows / IDEs on the same workspace) don't fight over each other's Claude
 * Code sessions.
 *
 * Each instance writes `~/.pixel-agents/instances/<instanceId>.json`:
 * ```
 * { pid, instanceId, lastHeartbeat, ownedSessions: [<jsonl path>, ...] }
 * ```
 *
 * - `lastHeartbeat` is updated every [HEARTBEAT_MS]; peers older than
 *   [STALE_MS] are treated as dead and pruned.
 * - `ownedSessions` is the set of JSONL files this instance launched (via
 *   `+ Agent`) or restored from persistence — sessions it considers "mine".
 * - Other instances consult [isOwnedByPeer] before adopting an unknown
 *   JSONL: if any live peer claims it, this instance ignores the file.
 *
 * The manifest is best-effort. Atomic file writes (`tmp` + rename) keep
 * peers from reading half-written content.
 */
class InstanceManifest {
    companion object {
        private val LOG = Logger.getInstance(InstanceManifest::class.java)

        /** Heartbeat cadence — bumped from 30s to 60s after research showed
         *  shorter intervals misfire on every laptop suspend. AWS DynamoDB lock
         *  client and HashiCorp Vault both use minute-scale heartbeats for
         *  similar adoption decisions. */
        private const val HEARTBEAT_MS = 60_000L
        /** Stale = no heartbeat in 3× heartbeat (180s). Combined with a kill-style
         *  liveness probe so a frozen-but-alive IDE isn't wrongly pruned. */
        private const val STALE_MS = 180_000L

        private val gson = Gson()

        fun manifestRoot(): Path =
            Paths.get(System.getProperty("user.home"), ".pixel-agents", "instances")
    }

    data class ManifestData(
        val pid: Long,
        val instanceId: String,
        /** Process start time as epoch millis. Used together with [pid] to
         *  detect PID reuse — if the OS has reassigned the PID to an unrelated
         *  process after our crash, the start time will not match. Postgres
         *  uses the same trick in postmaster.pid. */
        val pidStartTime: Long,
        val lastHeartbeat: Long,
        val ownedSessions: List<String> = emptyList(),
    )

    val instanceId: String = UUID.randomUUID().toString()
    private val pid: Long = ProcessHandle.current().pid()
    private val pidStartTime: Long =
        ProcessHandle.current().info().startInstant().map { it.toEpochMilli() }.orElse(0L)
    private val ownedSessions = ConcurrentHashMap.newKeySet<String>()
    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PixelAgents-Manifest").apply { isDaemon = true }
    }
    private var heartbeatTimer: ScheduledFuture<*>? = null
    /** OS-level lock on a sibling `.lock` file. The kernel auto-releases this
     *  on process death (including SIGKILL), giving us crash-proof liveness
     *  detection independent of heartbeat freshness. Best-effort: some
     *  filesystems don't support advisory locking, in which case we fall back
     *  to heartbeat + liveness-probe alone. */
    private var lockChannel: FileChannel? = null
    private var fileLock: FileLock? = null

    fun start() {
        try {
            Files.createDirectories(manifestRoot())
        } catch (e: Exception) {
            LOG.warn("Failed to create manifest dir", e)
            return
        }
        writeManifestSafely()
        // Acquire an OS-level lock on a sibling .lock file. We never read this
        // file's contents — the lock state itself signals "this instance is
        // alive". Crash-proof because the kernel releases all locks held by a
        // process on exit, even on SIGKILL.
        try {
            val lockFile = manifestRoot().resolve("$instanceId.lock").toFile()
            val raf = RandomAccessFile(lockFile, "rw")
            lockChannel = raf.channel
            fileLock = lockChannel?.tryLock()
            if (fileLock == null) {
                LOG.warn("Could not acquire instance lock (file already locked)")
            }
        } catch (e: Exception) {
            // Some filesystems (Windows network mounts, older NFS) refuse
            // advisory locks. Tolerable — heartbeat + liveness probe still work.
            LOG.warn("File lock unavailable; falling back to heartbeat-only liveness", e)
        }
        // scheduleWithFixedDelay (vs scheduleAtFixedRate) means delays accumulate
        // after a sleep; on wake the OS fires this immediately, refreshing our
        // heartbeat before peers can prune us.
        heartbeatTimer = executor.scheduleWithFixedDelay(
            { writeManifestSafely() },
            HEARTBEAT_MS, HEARTBEAT_MS, TimeUnit.MILLISECONDS,
        )
        LOG.info("InstanceManifest started: instanceId=$instanceId pid=$pid pidStartTime=$pidStartTime")
    }

    /** Public hook for IDE wake-up listeners to immediately bump our heartbeat
     *  on resume from sleep — closes the race where a peer might prune us
     *  before our next scheduled heartbeat fires post-wake. */
    fun touchHeartbeat() {
        writeManifestSafely()
    }

    fun stop() {
        heartbeatTimer?.cancel(false)
        executor.shutdownNow()
        try {
            fileLock?.release()
            lockChannel?.close()
        } catch (_: Exception) {
        }
        try {
            Files.deleteIfExists(manifestFile())
            Files.deleteIfExists(manifestRoot().resolve("$instanceId.lock"))
        } catch (_: Exception) {
        }
    }

    /** Mark a JSONL file as owned by this instance. */
    fun registerSession(jsonlPath: String) {
        if (ownedSessions.add(jsonlPath)) writeManifestSafely()
    }

    /** Drop ownership (e.g. when the agent is closed). */
    fun unregisterSession(jsonlPath: String) {
        if (ownedSessions.remove(jsonlPath)) writeManifestSafely()
    }

    /**
     * True if any LIVE peer instance claims this JSONL. Stale peer files are
     * pruned as a side effect. Returns false for our own JSONLs (they're in
     * `ownedSessions`, but our own manifest is excluded from the scan).
     */
    fun isOwnedByPeer(jsonlPath: String): Boolean {
        val now = System.currentTimeMillis()
        val files = try {
            manifestRoot().toFile().listFiles { f -> f.name.endsWith(".json") } ?: return false
        } catch (_: Exception) {
            return false
        }
        val ownPath = manifestFile().toFile().absolutePath
        for (f in files) {
            if (f.absolutePath == ownPath) continue
            val data = readManifest(f) ?: continue
            // Two-step liveness: only treat a peer as dead when BOTH the
            // heartbeat is stale AND the OS confirms the PID is gone (or has
            // been reused by an unrelated process).
            //
            // - Heartbeat alone: misfires on frozen-but-alive IDEs (long GC
            //   pause, OS suspend, single-threaded IDE blocked on a dialog).
            // - kill(pid,0) alone: misfires on PID reuse (the OS recycled the
            //   number to an unrelated process).
            // Together: Postgres' postmaster.pid pattern.
            val heartbeatStale = now - data.lastHeartbeat > STALE_MS
            if (heartbeatStale && !isProcessAlive(data.pid, data.pidStartTime)) {
                // Best-effort prune. If another instance is recreating it
                // concurrently, we just lose this race — harmless.
                runCatching { f.delete() }
                runCatching {
                    Files.deleteIfExists(manifestRoot().resolve("${data.instanceId}.lock"))
                }
                continue
            }
            if (jsonlPath in data.ownedSessions) return true
        }
        return false
    }

    /** kill(pid,0) equivalent + start-time double-check. Returns true only
     *  when a process with [pid] exists AND its start time matches (i.e. it's
     *  actually the same process we recorded, not a PID-reuse imposter). */
    private fun isProcessAlive(peerPid: Long, peerStartTime: Long): Boolean {
        val handle = ProcessHandle.of(peerPid).orElse(null) ?: return false
        if (!handle.isAlive) return false
        // Older manifests written before we tracked startTime stored 0 — accept
        // them as a transitional best-effort signal (alive PID, unknown match).
        if (peerStartTime == 0L) return true
        val actualStart = handle.info().startInstant().map { it.toEpochMilli() }.orElse(0L)
        if (actualStart == 0L) return true  // OS didn't tell us; trust the PID alone
        // Allow ±2s drift — process info caches sometimes round.
        return Math.abs(actualStart - peerStartTime) < 2_000L
    }

    private fun manifestFile(): Path = manifestRoot().resolve("$instanceId.json")

    private fun writeManifestSafely() {
        try {
            writeManifest()
        } catch (e: Exception) {
            LOG.warn("Failed to write manifest", e)
        }
    }

    private fun writeManifest() {
        val data = ManifestData(
            pid = pid,
            instanceId = instanceId,
            pidStartTime = pidStartTime,
            lastHeartbeat = System.currentTimeMillis(),
            ownedSessions = ownedSessions.toList(),
        )
        val target = manifestFile()
        val tmp = target.resolveSibling("$instanceId.json.tmp")
        Files.writeString(tmp, gson.toJson(data))
        try {
            Files.move(
                tmp, target,
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (_: Exception) {
            // Some filesystems (Windows network mounts) don't support ATOMIC_MOVE
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun readManifest(f: File): ManifestData? = try {
        gson.fromJson(f.readText(), ManifestData::class.java)
    } catch (_: Exception) {
        null
    }
}
