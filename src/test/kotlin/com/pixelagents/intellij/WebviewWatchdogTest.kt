package com.pixelagents.intellij

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class WebviewWatchdogTest {

    private val stale = 90_000L
    private val wait = 15_000L

    private fun watchdog() = WebviewWatchdog(stale, wait)

    @Test
    fun `a webview that answers its pings is only pinged`() {
        val w = watchdog()
        w.onPingDelivered(0L)
        w.onAlive()
        w.onPingDelivered(30_000L)
        w.onAlive()
        assertEquals(WebviewWatchdog.Action.PING, w.tick(500_000L))
    }

    @Test
    fun `a frozen IDE that delivers no pings is never treated as a dead browser`() {
        val w = watchdog()
        w.onPingDelivered(0L)
        w.onAlive()
        assertEquals(WebviewWatchdog.Action.PING, w.tick(10 * stale))
    }

    @Test
    fun `silence is counted from the first unanswered ping, not the latest`() {
        val w = watchdog()
        w.onPingDelivered(0L)
        w.onPingDelivered(30_000L)
        w.onPingDelivered(60_000L)
        assertEquals(WebviewWatchdog.Action.RELOAD, w.tick(stale + 1))
    }

    @Test
    fun `a silent webview is reloaded, then recreated, then given up on`() {
        val w = watchdog()
        w.onPingDelivered(0L)
        assertEquals(WebviewWatchdog.Action.PING, w.tick(stale))
        val reloadAt = stale + 1
        assertEquals(WebviewWatchdog.Action.RELOAD, w.tick(reloadAt))
        assertEquals(WebviewWatchdog.Action.PING, w.tick(reloadAt + wait - 1))
        val recreateAt = reloadAt + wait
        assertEquals(WebviewWatchdog.Action.RECREATE, w.tick(recreateAt))
        assertEquals(WebviewWatchdog.Action.PING, w.tick(recreateAt + wait - 1))
        assertEquals(WebviewWatchdog.Action.GIVE_UP, w.tick(recreateAt + wait))
    }

    @Test
    fun `after giving up nothing more is attempted`() {
        val w = watchdog()
        w.onPingDelivered(0L)
        w.tick(stale + 1)
        w.tick(stale + 1 + wait)
        w.tick(stale + 1 + 2 * wait)
        assertEquals(WebviewWatchdog.Action.IDLE, w.tick(10 * stale))
        assertEquals(WebviewWatchdog.Action.IDLE, w.onRenderProcessGone(10 * stale))
    }

    @Test
    fun `an answer after recovery resets the escalation`() {
        val w = watchdog()
        w.onPingDelivered(0L)
        w.tick(stale + 1)
        w.tick(stale + 1 + wait)
        w.onAlive()
        val pingAt = stale + 1 + wait + 30_000
        w.onPingDelivered(pingAt)
        assertEquals(WebviewWatchdog.Action.PING, w.tick(pingAt + stale))
        assertEquals(WebviewWatchdog.Action.RELOAD, w.tick(pingAt + stale + 1))
    }

    @Test
    fun `a renderer termination recovers at once and a still-silent page is recreated later`() {
        val w = watchdog()
        assertEquals(WebviewWatchdog.Action.RELOAD, w.onRenderProcessGone(2_000L))
        assertEquals(WebviewWatchdog.Action.PING, w.tick(2_000L + stale))
        assertEquals(WebviewWatchdog.Action.RECREATE, w.tick(2_000L + stale + 1))
    }

    @Test
    fun `a manual retry after giving up gets a stale window before giving up again`() {
        val w = watchdog()
        w.onPingDelivered(0L)
        w.tick(stale + 1)
        w.tick(stale + 1 + wait)
        w.tick(stale + 1 + 2 * wait)
        val retryAt = 20 * stale
        w.onManualRetry(retryAt)
        assertEquals(WebviewWatchdog.Action.PING, w.tick(retryAt + stale))
        assertEquals(WebviewWatchdog.Action.GIVE_UP, w.tick(retryAt + stale + 1))
    }
}
