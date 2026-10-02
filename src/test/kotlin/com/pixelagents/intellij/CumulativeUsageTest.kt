package com.pixelagents.intellij

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentHashMap

/**
 * Claude Code writes one API response as SEVERAL `assistant` lines — one per
 * content-block group (text / thinking / tool_use) — and every one of them
 * repeats the same `message.id` and the same `message.usage` object. The
 * cumulative counters must fold each response in once; summing the lines
 * inflated every tool-using turn (measured 1.9x on real transcripts) and fed
 * that inflation straight into the HUD cost total.
 */
class CumulativeUsageTest {

    private fun assistantLine(messageId: String, blockType: String): String = """
        {"type":"assistant","timestamp":"2026-09-17T08:38:09.269Z",
         "message":{"id":"$messageId","model":"claude-opus-5",
           "content":[{"type":"$blockType","id":"toolu_x","name":"Read","input":{"file_path":"/a/b.kt"}}],
           "usage":{"input_tokens":2,"cache_creation_input_tokens":100,
                    "cache_read_input_tokens":1000,"output_tokens":50}}}
    """.trimIndent().replace("\n", "")

    private fun parserWith(agent: AgentState): TranscriptParser {
        val agents = ConcurrentHashMap<Int, AgentState>().apply { put(agent.id, agent) }
        val sink: (String, Map<String, Any?>) -> Unit = { _, _ -> }
        return TranscriptParser(sink, agents, TimerManager(sink, agents))
    }

    private fun newAgent() = AgentState(
        id = 1,
        terminalName = "test",
        projectDir = "/tmp",
        jsonlFile = "/tmp/session.jsonl",
    )

    @Test
    fun `split lines of one response are counted once`() {
        val agent = newAgent()
        val parser = parserWith(agent)
        parser.processTranscriptLine(agent.id, assistantLine("msg_A", "text"))
        parser.processTranscriptLine(agent.id, assistantLine("msg_A", "tool_use"))

        assertEquals(2L, agent.cumulativeInput)
        assertEquals(100L, agent.cumulativeCacheCreate)
        assertEquals(1000L, agent.cumulativeCacheRead)
        assertEquals(50L, agent.cumulativeOutput)
    }

    @Test
    fun `distinct responses still accumulate`() {
        val agent = newAgent()
        val parser = parserWith(agent)
        parser.processTranscriptLine(agent.id, assistantLine("msg_A", "tool_use"))
        parser.processTranscriptLine(agent.id, assistantLine("msg_B", "tool_use"))

        assertEquals(4L, agent.cumulativeInput)
        assertEquals(200L, agent.cumulativeCacheCreate)
        assertEquals(2000L, agent.cumulativeCacheRead)
        assertEquals(100L, agent.cumulativeOutput)
    }

    @Test
    fun `context size follows the latest turn after it shrinks`() {
        val agent = newAgent()
        val parser = parserWith(agent)
        parser.processTranscriptLine(agent.id, assistantLine("msg_A", "tool_use"))
        val compacted = assistantLine("msg_B", "text")
            .replace("\"cache_read_input_tokens\":1000", "\"cache_read_input_tokens\":10")
        parser.processTranscriptLine(agent.id, compacted)

        assertEquals(112L, agent.lastContextTokens)
    }
}
