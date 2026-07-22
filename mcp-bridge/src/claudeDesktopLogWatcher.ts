/**
 * Tails Claude Desktop's own log file to detect EVERY tool call Claude
 * makes — not just the office_* calls Claude Desktop forwards to us
 * over MCP stdio. This is the bridge's CLI-parity story: Claude Code
 * exposes its activity via JSONL, Claude Desktop doesn't, but the
 * Desktop app does emit a `[MCP] tool_approval_gate` log line per
 * tool invocation. Tailing that file gives us roughly the same signal
 * Claude Code's transcript parser gets from JSONL.
 *
 * Caveats vs JSONL parity:
 *   - No "tool completed" event — we only see the gate. Active vs idle
 *     is reconstructed via the existing stale-sweeper timeout.
 *   - No conversation text. Status = toolName.
 *   - macOS path only for v1 (Windows/Linux Claude Desktop log paths
 *     differ; not yet investigated).
 *   - File rotates when oversized (`claude.ai-web.log` →
 *     `claude.ai-web1.log`). We watch the live file; on rotation we
 *     re-open at offset 0 to catch fresh writes.
 */

import { createReadStream, existsSync, statSync } from "node:fs"
import { watch } from "node:fs"
import { join } from "node:path"
import { homedir, platform } from "node:os"
import type { OfficeStore } from "./office.js"

// `2026-05-14 16:03:06 [warn] [MCP] tool_approval_gate {"toolId":"...","toolName":"bash_tool",...}`
const TOOL_GATE_RE = /\[MCP\]\s+tool_approval_gate\s+(\{.*\})\s*$/

interface ToolGateEvent {
  toolId: string
  toolName: string
}

export interface DesktopLogWatcher {
  stop: () => void
}

/** Start watching the Claude Desktop log file. Each non-Pixel-Office
 *  tool call is reflected on the "main" agent so it lights up whenever
 *  Claude is doing anything at all. Returns a no-op watcher on
 *  platforms where the log doesn't exist. */
export function startDesktopLogWatcher(store: OfficeStore): DesktopLogWatcher {
  const path = claudeDesktopLogPath()
  if (!path || !existsSync(path)) {
    console.error(`[pixel-bridge] desktop log not found, auto-detect off`)
    return { stop: () => {} }
  }

  // Start tailing from the current end of the file — we don't want to
  // replay weeks of historical tool calls into the office on boot.
  let offset = 0
  try {
    offset = statSync(path).size
  } catch { /* keep 0 */ }
  let buffer = ""
  let reading = false

  function readNew(): void {
    if (reading) return
    reading = true
    let size = offset
    try {
      size = statSync(path!).size
    } catch {
      reading = false
      return
    }
    if (size < offset) {
      // File truncated/rotated — restart from the new start.
      offset = 0
    }
    if (size === offset) {
      reading = false
      return
    }
    const stream = createReadStream(path!, { start: offset, end: size })
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) handleLogLine(line, store)
    })
    stream.on("end", () => {
      offset = size
      reading = false
    })
    stream.on("error", (err) => {
      console.error("[pixel-bridge] desktop log read error", err)
      reading = false
    })
  }

  // Hybrid fs.watch + 2s poll — same belt-and-suspenders pattern the
  // IntelliJ FileWatcher uses, because fs.watch is unreliable on
  // macOS Spotlight-indexed paths and across atomic rename rotation.
  let fsWatcher: ReturnType<typeof watch> | null = null
  try {
    fsWatcher = watch(path, () => readNew())
  } catch (err) {
    console.error("[pixel-bridge] fs.watch on desktop log failed", err)
  }
  const poll = setInterval(readNew, 2_000)
  poll.unref?.()

  console.error(`[pixel-bridge] watching ${path} for tool calls`)
  return {
    stop: () => {
      try { fsWatcher?.close() } catch { /* */ }
      clearInterval(poll)
    },
  }
}

// Parallel-batch detection state. A "batch" is ≥PARALLEL_THRESHOLD
// distinct tool_approval_gate events that fire within
// PARALLEL_WINDOW_MS of each other. Each tool in the batch gets its
// own sub-agent character (parentId: "main"), named after the tool.
const PARALLEL_WINDOW_MS = 3_000
const PARALLEL_THRESHOLD = 3
const recentTools = new Map<string, { name: string; time: number }>()

/** Drop tool-ids whose last sighting fell outside the parallel
 *  window. Called on every event to keep `recentTools.size` honest. */
function pruneStaleTools(now: number): void {
  for (const [id, info] of recentTools) {
    if (now - info.time > PARALLEL_WINDOW_MS) recentTools.delete(id)
  }
}

/** Shorten a tool name into a 1–2 word sub-agent label. Strips
 *  protocol prefixes ("github:list_pull_requests" → "github") and
 *  the common "_tool" suffix ("bash_tool" → "bash"). */
function simplifyToolName(name: string): string {
  const head = name.split(":")[0] ?? name
  return head.replace(/_tool$/i, "")
}

function handleLogLine(line: string, store: OfficeStore): void {
  const m = TOOL_GATE_RE.exec(line)
  if (!m) return
  let evt: ToolGateEvent
  try {
    evt = JSON.parse(m[1]) as ToolGateEvent
  } catch {
    return
  }
  // Skip our own MCP tools — they're already accounted for through the
  // stdio handler (which produces richer state). Double-counting would
  // make the office_open call itself flash as "main agent doing
  // office_open" which is meaningless to the user.
  if (evt.toolName?.startsWith("Pixel Office Bridge:")) return

  // Cross-channel dedup turned out NOT to be needed: each channel
  // (web.log / projects.jsonl / audit.jsonl / subagents/*.jsonl)
  // operates on an independent toolId space. The same `toolu_*` never
  // appears in two real tool_use records — only as substring matches
  // when an ID gets echoed into conversation text. Adding a dedup
  // would actually drop legitimate activity.

  const now = Date.now()

  // 1. Main agent always reflects current Claude activity.
  const existing = store.list().find((r) => r.id === "main")
  if (!existing) {
    store.upsert({
      id: "main",
      name: "Claude",
      status: evt.toolName,
      startedAt: now,
      updatedAt: now,
      done: false,
    })
  } else {
    store.patch("main", { status: evt.toolName })
  }

  // 2. Parallel-batch detection — when ≥N distinct tools fire within
  //    a short window, spawn sub-agent characters for each so the
  //    office visually represents the burst as a team. This replaces
  //    the old explicit office_start/office_progress tool calls.
  pruneStaleTools(now)
  recentTools.set(evt.toolId, { name: evt.toolName, time: now })
  if (recentTools.size >= PARALLEL_THRESHOLD) {
    for (const [toolId, info] of recentTools) {
      const subId = `auto-sub-${toolId}`
      const cleanName = simplifyToolName(info.name)
      const subExisting = store.list().find((r) => r.id === subId)
      if (!subExisting) {
        store.upsert({
          id: subId,
          name: cleanName,
          status: info.name,
          startedAt: info.time,
          updatedAt: info.time,
          done: false,
          parentId: "main",
        })
      } else if (toolId === evt.toolId) {
        // Only refresh the sub for the tool that just fired — other
        // batch members keep their existing timestamps.
        store.patch(subId, { status: info.name })
      }
    }
  }
}

function claudeDesktopLogPath(): string | null {
  const home = homedir()
  if (platform() === "darwin") {
    return join(home, "Library", "Logs", "Claude", "claude.ai-web.log")
  }
  if (platform() === "win32") {
    // Best-guess Windows location; needs verification on a real box.
    const appData = process.env["APPDATA"]
    if (!appData) return null
    return join(appData, "Claude", "logs", "claude.ai-web.log")
  }
  if (platform() === "linux") {
    // Standard XDG location.
    return join(home, ".config", "Claude", "logs", "claude.ai-web.log")
  }
  return null
}
