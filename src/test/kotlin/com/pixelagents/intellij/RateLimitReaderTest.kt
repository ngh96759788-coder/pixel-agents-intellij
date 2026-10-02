package com.pixelagents.intellij

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class RateLimitReaderTest {

    private val now = 1_790_000_000_000L
    private val minute = 60_000L

    private fun cli(updatedAt: Long, resetsAtSec: Long) =
        """{"updatedAt":$updatedAt,"fiveHour":{"usedPercentage":30,"resetsAt":$resetsAtSec},"sevenDay":{"usedPercentage":12,"resetsAt":1790500000}}"""

    private fun desktop(ageMin: Long) =
        """{"version":2,"samples":[{"t":${now - 90 * minute},"u":{"fh":1,"sd":1}},{"t":${now - ageMin * minute},"u":{"fh":9,"sd":4}}]}"""

    @Test
    fun `an old CLI reading stays valid until its window resets`() {
        val r = RateLimitReader.parseCli(cli(now - 180 * minute, now / 1000 + 60), now)
        assertEquals(30.0, r?.fiveHourPct)
        assertEquals(12.0, r?.sevenDayPct)
        assertEquals(1_790_500_000_000L, r?.sevenDayResetsAtMs)
    }

    @Test
    fun `a Desktop sample carries no 7d reset time, so no pace can be derived from it`() {
        assertNull(RateLimitReader.parseDesktop(desktop(2), now)?.sevenDayResetsAtMs)
    }

    @Test
    fun `a CLI reading whose window already reset is dropped`() {
        assertNull(RateLimitReader.parseCli(cli(now - minute, now / 1000 - 1), now))
    }

    @Test
    fun `a Desktop sample is trusted for 20 minutes and no longer`() {
        assertEquals(9.0, RateLimitReader.parseDesktop(desktop(20), now)?.fiveHourPct)
        assertNull(RateLimitReader.parseDesktop(desktop(21), now))
    }

    @Test
    fun `an unexpected Desktop format falls through instead of throwing`() {
        assertNull(RateLimitReader.parseDesktop("""{"samples":[{"t":$now,"u":{}}]}""", now))
        assertNull(RateLimitReader.parseDesktop("not json", now))
        assertNull(RateLimitReader.parseCli("{bad", now))
    }

    @Test
    fun `the more recently measured source wins`() {
        val c = RateLimitReader.parseCli(cli(now - 10 * minute, now / 1000 + 60), now)
        val d = RateLimitReader.parseDesktop(desktop(2), now)
        assertEquals("desktop", RateLimitReader.pick(c, d)?.source)
        assertEquals("cli", RateLimitReader.pick(c, null)?.source)
        assertNull(RateLimitReader.pick(null, null))
    }
}
