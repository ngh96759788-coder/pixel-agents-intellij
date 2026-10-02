package com.pixelagents.intellij

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * BEHAVIOR_SPEC §3: the 5h window is a WEIGHTED sum. Summed raw, the figure is
 * ~99% cache reads (measured 326.7M of 330.6M on a real 5h window), which makes
 * it a "how much history got re-read" counter rather than a quota signal.
 */
class QuotaWindowTrackerTest {

    @Test
    fun `each bucket carries its billing multiplier`() {
        assertEquals(1_000L, QuotaWindowTracker.weightedTokens(1_000, 0, 0, 0))
        assertEquals(1_250L, QuotaWindowTracker.weightedTokens(0, 1_000, 0, 0))
        assertEquals(100L, QuotaWindowTracker.weightedTokens(0, 0, 1_000, 0))
        assertEquals(1_000L, QuotaWindowTracker.weightedTokens(0, 0, 0, 1_000))
    }

    @Test
    fun `a steady-state turn shrinks because cache reads dominate it`() {
        // Shape of a mid-session turn: a little fresh input, a small cache
        // top-up, a large cache read, a modest completion. This is the shape
        // that made the raw sum ~99% cache reads.
        val raw = 2L + 1_000L + 150_000L + 500L
        val weighted = QuotaWindowTracker.weightedTokens(2, 1_000, 150_000, 500)
        assertEquals(16_752L, weighted)
        assertTrue(weighted < raw / 5, "a cache-read-heavy turn should shrink sharply")
    }

    @Test
    fun `a cache-writing turn is NOT discounted`() {
        // Weighting is not a blanket discount: the first turn of a session
        // writes the whole prompt into the cache at 1.25x, so it weighs MORE
        // than its raw token count. Asserting "weighted < raw" universally
        // would encode a false belief about this feature.
        val raw = 2L + 127_832L + 23_618L + 146L
        val weighted = QuotaWindowTracker.weightedTokens(2, 127_832, 23_618, 146)
        assertEquals(162_300L, weighted)
        assertTrue(weighted > raw, "cache writes cost 1.25x and must not be discounted")
    }

    @Test
    fun `zero usage weighs nothing`() {
        assertEquals(0L, QuotaWindowTracker.weightedTokens(0, 0, 0, 0))
    }
}
