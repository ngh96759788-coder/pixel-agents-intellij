package com.pixelagents.intellij

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue

/**
 * Pure-function tests for [WorktreeDetector.parseWorktrees]. Fixtures are real
 * `git worktree list --porcelain` output captured from this repo (main worktree
 * + an added `pa-worktree-test` worktree), so the parser is verified against the
 * exact format git emits rather than an assumed one.
 */
class WorktreeDetectorTest {

    @Test
    fun `parses main plus added worktree, stripping refs heads`() {
        // Note: no trailing blank line after the final block — matches git's
        // actual output (a regression here would drop the last worktree).
        val porcelain = """
            worktree /Users/me/Downloads/pixel-agents-intellij
            HEAD 2af35f87d1089bda028fc7563be3250a9a40cf34
            branch refs/heads/main

            worktree /private/tmp/pa-wt-test
            HEAD 2af35f87d1089bda028fc7563be3250a9a40cf34
            branch refs/heads/pa-worktree-test
        """.trimIndent()

        val out = WorktreeDetector.parseWorktrees(porcelain)

        assertEquals(2, out.size)
        assertEquals("/Users/me/Downloads/pixel-agents-intellij", out[0].path)
        assertEquals("main", out[0].branch)
        assertEquals("/private/tmp/pa-wt-test", out[1].path)
        assertEquals("pa-worktree-test", out[1].branch)
    }

    @Test
    fun `detached HEAD worktree has null branch`() {
        val porcelain = """
            worktree /repo/main
            HEAD abc123
            branch refs/heads/main

            worktree /repo/.worktrees/detached
            HEAD def456
            detached
        """.trimIndent()

        val out = WorktreeDetector.parseWorktrees(porcelain)

        assertEquals(2, out.size)
        assertEquals("/repo/.worktrees/detached", out[1].path)
        assertNull(out[1].branch)
    }

    @Test
    fun `branch names with slashes keep everything after refs heads`() {
        val porcelain = """
            worktree /repo/feat
            HEAD abc
            branch refs/heads/feature/nested/name
        """.trimIndent()

        val out = WorktreeDetector.parseWorktrees(porcelain)

        assertEquals("feature/nested/name", out[0].branch)
    }

    @Test
    fun `trailing blank line does not emit an empty entry`() {
        val porcelain = "worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n"
        val out = WorktreeDetector.parseWorktrees(porcelain)
        assertEquals(1, out.size)
        assertEquals("/repo/main", out[0].path)
    }

    @Test
    fun `empty output yields empty list`() {
        assertTrue(WorktreeDetector.parseWorktrees("").isEmpty())
        assertTrue(WorktreeDetector.parseWorktrees("\n\n").isEmpty())
    }
}
