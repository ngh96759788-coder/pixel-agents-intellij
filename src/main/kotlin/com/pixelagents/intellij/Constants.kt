package com.pixelagents.intellij

object Constants {
    // Timing (ms)
    const val JSONL_POLL_INTERVAL_MS = 1000L
    const val FILE_WATCHER_POLL_INTERVAL_MS = 2000L
    const val SUBAGENT_FOLDER_POLL_INTERVAL_MS = 500L
    const val PROJECT_SCAN_INTERVAL_MS = 1000L
    const val TOOL_DONE_DELAY_MS = 300L
    /** Delay before a "needs approval" speech bubble pops on a non-exempt tool
     *  that hasn't reported back. Originally 7s, bumped to 30s after the
     *  sleep-10s false-positive: Bash with no stdout (sleep, polling waits)
     *  emits no `bash_progress` records, so 7s of JSONL silence looked
     *  indistinguishable from a real permission pause. 30s covers most short
     *  blocking commands; genuine approval prompts remain visible after that. */
    const val PERMISSION_TIMER_DELAY_MS = 30000L
    const val TEXT_IDLE_DELAY_MS = 5000L
    const val ADOPTION_MAX_AGE_MS = 10000L  // Only adopt JSONL files modified within last 10s
    const val PROJECT_DISCOVERY_AGE_MS = 60_000L  // Discover claude project subdirs with JSONL activity within last 60s
    const val PROJECT_DISCOVERY_INTERVAL_MS = 15_000L  // Re-run discovery every 15s to catch claude sessions spawned after IDE open
    /** How often to re-enumerate git worktrees of the open repo. Worktrees can be
     *  created at runtime when IntelliJ hands a task off to an agent (2026.1+), so
     *  the office must pick them up without an IDE restart. Scoped to THIS repo only. */
    const val WORKTREE_SCAN_INTERVAL_MS = 5_000L

    // Session alive check
    const val SESSION_CHECK_INTERVAL_MS = 10_000L  // Check every 10s
    // Stale threshold for MAIN agents (BEHAVIOR_SPEC §2: main despawns after 60s
    // of JSONL silence). If the JSONL hasn't moved for this long, remove the agent.
    const val SESSION_STALE_THRESHOLD_MS = 60_000L
    // Stale threshold for SUB-AGENT watchers (BEHAVIOR_SPEC §2: sub despawns after
    // 30s). Applies to both "sub JSONL never appeared" and "sub JSONL stopped
    // growing" give-up checks in FileWatcher.checkSubagentTimeout.
    const val SUBAGENT_STALE_THRESHOLD_MS = 30_000L

    // Rolling token-usage window for the global HUD (BEHAVIOR_SPEC §3:
    // absolute weighted tokens over a 5h window, refreshed every minute).
    const val QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000L
    const val QUOTA_TICK_MS = 60_000L

    // Per-bucket weights for the 5h window sum (BEHAVIOR_SPEC §3). A raw sum is
    // dominated by cache reads — measured 98.8% of the total on this machine —
    // which makes the number a cache-read counter rather than a quota signal.
    // These are the published billing multipliers relative to fresh input, the
    // same ones `estimateCost()` applies webview-side. Keep in sync with
    // mcp-bridge/src/spec.ts.
    const val QUOTA_WEIGHT_INPUT = 1.0
    const val QUOTA_WEIGHT_CACHE_CREATE = 1.25
    const val QUOTA_WEIGHT_CACHE_READ = 0.10
    const val QUOTA_WEIGHT_OUTPUT = 1.0

    // Real 5h / 7d usage percentage (BEHAVIOR_SPEC §3). The CLI reading is
    // written by the statusline script and stays valid until its resets_at;
    // Desktop's own history has no reset time, so a sample is trusted only up
    // to its measured 15-minute cadence plus 5 minutes. Keep in sync with
    // mcp-bridge/src/spec.ts.
    const val DESKTOP_USAGE_SAMPLE_MAX_AGE_MS = 20 * 60 * 1000L
    const val RATE_LIMITS_FILE_NAME = "rate-limits.json"
    const val DESKTOP_USAGE_HISTORY_FILE_NAME = "plan-usage-history.json"

    // Webview watchdog. The plugin pushes a ping and the webview answers; any
    // webview message counts as alive. Pinging from the plugin side (rather
    // than a webview timer) matters because Chromium throttles timers in hidden
    // pages to once a minute, which would read as a stall. Each STALE window
    // without an answer escalates: reload, recreate the browser, give up and
    // ask for an IDE restart.
    const val WEBVIEW_PING_INTERVAL_MS = 30_000L
    const val WEBVIEW_STALE_MS = 90_000L
    // After a reload or a recreate, how long to wait for an answer before the
    // next step. A live JCEF reloads the local page and answers in ~100 ms
    // (measured 90–100 ms on 2024.2 and on 2026.1), so this is generous.
    const val WEBVIEW_RECOVERY_WAIT_MS = 15_000L

    // Display truncation
    const val BASH_COMMAND_DISPLAY_MAX_LENGTH = 30
    const val TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40

    // PNG / Asset parsing
    const val PNG_ALPHA_THRESHOLD = 128
    const val WALL_PIECE_WIDTH = 16
    const val WALL_PIECE_HEIGHT = 32
    const val WALL_GRID_COLS = 4
    const val WALL_BITMASK_COUNT = 16
    const val FLOOR_PATTERN_COUNT = 7
    const val FLOOR_TILE_SIZE = 16
    val CHARACTER_DIRECTIONS = listOf("down", "up", "right")
    const val CHAR_FRAME_W = 24
    const val CHAR_FRAME_H = 32
    const val CHAR_FRAMES_PER_ROW = 7
    const val CHAR_COUNT = 6

    // Layout persistence
    const val LAYOUT_FILE_DIR = ".pixel-agents"
    const val LAYOUT_FILE_NAME = "layout.json"
    const val LAYOUT_FILE_POLL_INTERVAL_MS = 2000L

    // Terminal
    const val TERMINAL_NAME_PREFIX = "Claude Code"

    // Themes
    const val THEME_DEFAULT = "default"
    val VALID_THEMES = listOf("default", "alien", "cat")
    val THEME_CHAR_DIRS = mapOf(
        "default" to "characters",
        "alien" to "characters-alien",
        "cat" to "characters-cat",
    )
    val THEME_FLOOR_FILES = mapOf(
        "default" to "floors.png",
        "alien" to "floors-alien.png",
        "cat" to "floors-cat.png",
    )
    val THEME_WALL_FILES = mapOf(
        "default" to "walls.png",
        "alien" to "walls-alien.png",
        "cat" to "walls-cat.png",
    )
    val THEME_FURNITURE_DIRS = mapOf(
        "default" to "furniture",
        "alien" to "furniture-alien",
        "cat" to "furniture-cat",
    )
    val THEME_DEFAULT_LAYOUTS = mapOf(
        "default" to "default-layout.json",
        "alien" to "default-layout-alien.json",
        "cat" to "default-layout-cat.json",
    )
    val THEME_LAYOUT_FILES = mapOf(
        "default" to "layout-default.json",
        "alien" to "layout-alien.json",
        "cat" to "layout-cat.json",
    )
}
