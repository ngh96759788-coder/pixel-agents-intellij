package com.pixelagents.intellij

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue

/**
 * Pure-function tests for [TranscriptParser] companion helpers. These don't touch
 * IntelliJ Platform APIs or instantiate the parser, so they run in plain JUnit
 * without a test fixture.
 */
class TranscriptParserTest {

    // ── formatToolStatus ─────────────────────────────────────────────

    @Test
    fun `Read shows file basename only`() {
        val out = TranscriptParser.formatToolStatus("Read", mapOf("file_path" to "/abs/path/to/Foo.kt"))
        assertEquals("Reading Foo.kt", out)
    }

    @Test
    fun `Write and Edit reuse the same basename rule`() {
        assertEquals("Editing bar.ts",
            TranscriptParser.formatToolStatus("Edit", mapOf("file_path" to "/x/y/bar.ts")))
        assertEquals("Writing baz.json",
            TranscriptParser.formatToolStatus("Write", mapOf("file_path" to "/x/y/baz.json")))
    }

    @Test
    fun `Bash truncates very long commands with ellipsis`() {
        val cmd = "x".repeat(Constants.BASH_COMMAND_DISPLAY_MAX_LENGTH + 5)
        val out = TranscriptParser.formatToolStatus("Bash", mapOf("command" to cmd))
        assertTrue(out.startsWith("Running: "), "should start with Running:")
        assertTrue(out.endsWith("…"), "long command should end with ellipsis")
        assertEquals(
            "Running: ${"x".repeat(Constants.BASH_COMMAND_DISPLAY_MAX_LENGTH)}…",
            out
        )
    }

    @Test
    fun `Bash short command is not truncated`() {
        val out = TranscriptParser.formatToolStatus("Bash", mapOf("command" to "ls -la"))
        assertEquals("Running: ls -la", out)
    }

    @Test
    fun `Task with subagent_type uses bracketed prefix`() {
        val out = TranscriptParser.formatToolStatus(
            "Task",
            mapOf("description" to "Find bugs", "subagent_type" to "general-purpose"),
        )
        assertEquals("Subtask[general-purpose]: Find bugs", out)
    }

    @Test
    fun `Task without subagent_type falls back to plain Subtask prefix`() {
        val out = TranscriptParser.formatToolStatus(
            "Task",
            mapOf("description" to "Investigate"),
        )
        assertEquals("Subtask: Investigate", out)
    }

    @Test
    fun `Agent and Task tools route to the same Subtask formatter`() {
        val a = TranscriptParser.formatToolStatus("Agent", mapOf("description" to "X"))
        val b = TranscriptParser.formatToolStatus("Task", mapOf("description" to "X"))
        assertEquals(a, b)
    }

    @Test
    fun `Empty description renders as Running subtask`() {
        val out = TranscriptParser.formatToolStatus("Task", emptyMap())
        assertEquals("Running subtask", out)
    }

    @Test
    fun `Unknown tool falls through to Using prefix`() {
        val out = TranscriptParser.formatToolStatus("MysteryTool", emptyMap())
        assertEquals("Using MysteryTool", out)
    }

    @Test
    fun `Static-text tools ignore input map`() {
        assertEquals("Searching files",
            TranscriptParser.formatToolStatus("Glob", mapOf("pattern" to "**")))
        assertEquals("Searching code",
            TranscriptParser.formatToolStatus("Grep", mapOf("pattern" to "x")))
        assertEquals("Fetching web content",
            TranscriptParser.formatToolStatus("WebFetch", mapOf("url" to "https://example.com")))
        assertEquals("Searching the web",
            TranscriptParser.formatToolStatus("WebSearch", emptyMap()))
        assertEquals("Waiting for your answer",
            TranscriptParser.formatToolStatus("AskUserQuestion", emptyMap()))
        assertEquals("Planning",
            TranscriptParser.formatToolStatus("EnterPlanMode", emptyMap()))
        assertEquals("Editing notebook",
            TranscriptParser.formatToolStatus("NotebookEdit", emptyMap()))
    }

    // ── extractContextTokens ─────────────────────────────────────────

    @Test
    fun `extractContextTokens returns 0 for null usage`() {
        assertEquals(0L, TranscriptParser.extractContextTokens(null))
    }

    @Test
    fun `extractContextTokens returns 0 when all fields missing`() {
        assertEquals(0L, TranscriptParser.extractContextTokens(emptyMap()))
    }

    @Test
    fun `extractContextTokens sums input plus cache_creation plus cache_read`() {
        val usage = mapOf(
            "input_tokens" to 100,
            "cache_creation_input_tokens" to 35_000,
            "cache_read_input_tokens" to 17_200,
            "output_tokens" to 250, // intentionally excluded
        )
        // 100 + 35000 + 17200 == 52300; output_tokens (250) is excluded
        assertEquals(52_300L, TranscriptParser.extractContextTokens(usage))
    }

    @Test
    fun `extractContextTokens accepts Long Number values from gson`() {
        // gson can decode integers as Double — verify Number coercion handles both
        val usage = mapOf<String, Any?>(
            "input_tokens" to 5L,
            "cache_creation_input_tokens" to 100.0,
            "cache_read_input_tokens" to 10,
        )
        assertEquals(115L, TranscriptParser.extractContextTokens(usage))
    }

    @Test
    fun `extractContextTokens missing partial fields counted as zero`() {
        val usage = mapOf<String, Any?>(
            "input_tokens" to 50,
            // cache_* missing
        )
        assertEquals(50L, TranscriptParser.extractContextTokens(usage))
    }
}
