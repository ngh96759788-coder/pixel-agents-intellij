package com.pixelagents.intellij

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TerminalDetectorTest {

    private class Tab

    @Test
    fun `a title change on an open tab is not a close`() {
        val tab = Tab()
        val tracked = HashMap<Tab, Pair<String, String>>()
        TerminalDetector.applySnapshot(tracked, mapOf(tab to "◐ fix billing"))
        assertTrue(TerminalDetector.applySnapshot(tracked, mapOf(tab to "◑ fix billing")).isEmpty())
        assertTrue(TerminalDetector.applySnapshot(tracked, mapOf(tab to "✳ fix billing")).isEmpty())
    }

    @Test
    fun `closing a renamed tab reports the name it was launched under`() {
        val tab = Tab()
        val tracked = HashMap<Tab, Pair<String, String>>()
        TerminalDetector.applySnapshot(tracked, mapOf(tab to "Pixel Agents #3"))
        TerminalDetector.applySnapshot(tracked, mapOf(tab to "◐ fix billing"))
        TerminalDetector.applySnapshot(tracked, mapOf(tab to "◑ fix billing"))
        val closed = TerminalDetector.applySnapshot(tracked, emptyMap())
        assertEquals(listOf(setOf("Pixel Agents #3", "◑ fix billing")), closed)
        assertTrue(tracked.isEmpty())
    }

    @Test
    fun `only the tab that disappeared is reported when two share a title`() {
        val a = Tab()
        val b = Tab()
        val tracked = HashMap<Tab, Pair<String, String>>()
        TerminalDetector.applySnapshot(tracked, mapOf(a to "zsh", b to "zsh"))
        assertEquals(listOf(setOf("zsh")), TerminalDetector.applySnapshot(tracked, mapOf(b to "zsh")))
        assertEquals(setOf(b), tracked.keys)
    }
}
