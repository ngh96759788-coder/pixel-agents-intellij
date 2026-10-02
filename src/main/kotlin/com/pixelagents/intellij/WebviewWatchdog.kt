package com.pixelagents.intellij

/**
 * Decides what to do about a silent webview. Pure state so the policy can be
 * tested without JCEF.
 *
 * Silence is counted from the first ping that was actually delivered and not
 * answered, never from wall-clock time since the last answer. Pings are sent
 * from the EDT, so while the IDE itself is frozen no ping goes out and nothing
 * counts as silence; otherwise a two-minute freeze would read as a dead
 * browser and end in a false "restart the IDE" message.
 *
 * Silence longer than [staleMs] starts recovery, and each step waits
 * [recoveryWaitMs] for an answer before escalating: reload (brings back a
 * crashed renderer), then recreate the browser (gets past a renderer that is
 * stuck rather than dead), then give up. Giving up is the honest end state when
 * the whole JCEF process is gone — on IntelliJ 2026.1 `cef_server` is not
 * restarted by the platform, and a new browser has nothing to connect to, so
 * only an IDE restart helps. Any answer from the page resets the escalation.
 */
class WebviewWatchdog(
    private val staleMs: Long,
    private val recoveryWaitMs: Long,
) {
    enum class Action { PING, RELOAD, RECREATE, GIVE_UP, IDLE }

    private var unansweredSinceMs: Long? = null
    private var failures = 0
    private var nextRecoveryAtMs = 0L
    private var gaveUp = false

    fun onPingDelivered(nowMs: Long) {
        if (unansweredSinceMs == null) unansweredSinceMs = nowMs
    }

    fun onAlive() {
        unansweredSinceMs = null
        failures = 0
        nextRecoveryAtMs = 0L
        gaveUp = false
    }

    fun tick(nowMs: Long): Action {
        if (gaveUp) return Action.IDLE
        val since = unansweredSinceMs ?: return Action.PING
        if (nowMs - since <= staleMs || nowMs < nextRecoveryAtMs) return Action.PING
        return recover(nowMs)
    }

    /** The renderer reported its own termination: recover now instead of
     *  waiting out the stale window. */
    fun onRenderProcessGone(nowMs: Long): Action {
        if (gaveUp) return Action.IDLE
        if (unansweredSinceMs == null) unansweredSinceMs = nowMs
        return recover(nowMs)
    }

    /** The user asked to try again after a give-up: the caller recreates the
     *  browser, and if that stays silent too the watchdog gives up again. */
    fun onManualRetry(nowMs: Long) {
        gaveUp = false
        failures = 2
        unansweredSinceMs = nowMs
        nextRecoveryAtMs = nowMs + recoveryWaitMs
    }

    private fun recover(nowMs: Long): Action {
        failures += 1
        nextRecoveryAtMs = nowMs + recoveryWaitMs
        return when (failures) {
            1 -> Action.RELOAD
            2 -> Action.RECREATE
            else -> {
                gaveUp = true
                Action.GIVE_UP
            }
        }
    }
}
