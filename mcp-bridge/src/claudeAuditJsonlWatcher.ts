/**
 * Audit-log watcher for Claude Desktop "local agent mode" sessions.
 *
 * Claude Desktop writes a CLI-style JSONL transcript to
 *   ~/Library/Application Support/Claude/local-agent-mode-sessions/
 *     <session-id>/<org-id>/<local-id>/audit.jsonl
 * whenever it runs a scheduled task, a Skill in autonomous mode, or
 * a local agent session. The format mirrors `~/.claude/projects/.../*.jsonl`
 * (Claude Code CLI), so we can extract:
 *
 *   - `assistant` events with `tool_use` blocks   → main agent activity
 *   - `tool_use { name: "Task" }`                  → spawn sub-agent
 *   - nested `tool_use` with `parent_tool_use_id` → sub-agent activity
 *   - `system.subtype === "turn_duration"`        → idle transition
 *
 * Normal Desktop chat does NOT produce these files; only agent-mode
 * workflows do. We're a strict reader — Anthropic owns the writer.
 *
 * Regular chat activity is still picked up by the simpler
 * `tool_approval_gate` log watcher (`claudeDesktopLogWatcher.ts`).
 * These two channels are disjoint: agent-mode events land in
 * audit.jsonl only; regular tool gates land in claude.ai-web.log only.
 */

import { createReadStream, existsSync, readdirSync, statSync, watch } from "node:fs"
import { join } from "node:path"
import { homedir, platform } from "node:os"
import type { OfficeStore } from "./office.js"
import { contextTokensFromUsage, shortInputSummary, type AssistantUsage } from "./usage.js"
import { bumpTokenGrowth } from "./index.js"

interface AuditEvent {
  type?: string
  subtype?: string
  session_id?: string
  uuid?: string
  parent_tool_use_id?: string | null
  message?: {
    role?: "user" | "assistant"
    content?: unknown
    /** Real model id (e.g. "claude-opus-4-7") — written on every
     *  assistant turn. Used to pick the right context-window scale
     *  for the HUD percentage. */
    model?: string
    /** Anthropic API usage block written on every assistant turn —
     *  used to auto-fill the office HUD's token bar without needing
     *  Claude to call `office_status` manually. */
    usage?: AssistantUsage
  }
}

interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input?: Record<string, unknown>
}

/** Match the IntelliJ plugin's `Constants.PERMISSION_TIMER_DELAY_MS`
 *  so both UIs flip the yellow approval bubble at the same wait
 *  threshold. 30s is wide enough to absorb a long blocking Bash; a
 *  genuine approval prompt persists past it. */
const PERMISSION_DELAY_MS = 30_000

/** Mirrors `TimerManager.PERMISSION_EXEMPT_TOOLS` — these tools wait
 *  on the user by design, so we don't treat their pause as approval-
 *  pending. */
const PERMISSION_EXEMPT_TOOLS = new Set(["Task", "AskUserQuestion"])

interface SessionState {
  filePath: string
  offset: number
  buffer: string
  mainSpawned: boolean
  /** tool_use id (from JSONL) → our internal sub-agent id */
  toolToSubAgent: Map<string, string>
  /** Outstanding `Bash(run_in_background:true)` tool_use ids that
   *  haven't received a matching tool_result yet. While non-empty:
   *    1. `turn_duration` skips `markIdle` — the turn ended on the
   *       model's side but a real process is still running, so the
   *       character should stay visibly active.
   *    2. The 2s permission-scan tick `touch()`es the main agent so
   *       the stale sweeper's despawn cutoff never elapses while
   *       background work is pending. */
  activeBackgroundTools: Set<string>
  /** Timestamp at which the current permission timer was (re)started,
   *  or 0 when no timer is running. Same semantics as in the projects
   *  watcher: cancelled by any subsequent JSONL line, re-armed by a
   *  non-exempt `tool_use` in an assistant message. */
  permTimerStartedAt: number
  /** Last-reported permissionPending state — debounces repeat emits. */
  permissionFlagged: boolean
  /** Cached internal main-agent id (`audit-main-${sessionKey}`). Set
   *  on first event so the permission scan can patch it without
   *  rebuilding the key. */
  mainAgentId: string | null
  lastSeen: number
}

const sessions = new Map<string, SessionState>()

export interface AuditWatcher {
  stop: () => void
}

export function startAuditJsonlWatcher(store: OfficeStore): AuditWatcher {
  const baseDir = auditBaseDir()
  if (!baseDir || !existsSync(baseDir)) {
    console.error("[pixel-bridge] no audit.jsonl base dir on this platform — skipping agent-mode watcher")
    return { stop: () => {} }
  }
  console.error(`[pixel-bridge] watching audit JSONLs under ${baseDir}`)
  const interval = setInterval(() => {
    scanAll(baseDir, store)
    scanPermissions(store)
  }, 2_000)
  interval.unref?.()
  // Initial scan — populates offsets (without replaying historical lines).
  scanAll(baseDir, store)
  return { stop: () => clearInterval(interval) }
}

function auditBaseDir(): string | null {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions")
  }
  if (platform() === "linux") {
    return join(homedir(), ".config", "Claude", "local-agent-mode-sessions")
  }
  if (platform() === "win32") {
    const appData = process.env["APPDATA"]
    if (!appData) return null
    return join(appData, "Claude", "local-agent-mode-sessions")
  }
  return null
}

/** Walk the 3-level session tree (session-id / org-id / local-id) and
 *  poll each audit.jsonl for new lines. Cheap: O(N sessions) per tick,
 *  and we cap how many sessions we actively watch. */
function scanAll(baseDir: string, store: OfficeStore): void {
  let topDirs: string[]
  try {
    topDirs = readdirSync(baseDir)
  } catch { return }
  for (const sessId of topDirs) {
    const sessDir = join(baseDir, sessId)
    if (!isDir(sessDir)) continue
    let orgs: string[]
    try { orgs = readdirSync(sessDir) } catch { continue }
    for (const orgId of orgs) {
      const orgDir = join(sessDir, orgId)
      if (!isDir(orgDir)) continue
      let locals: string[]
      try { locals = readdirSync(orgDir) } catch { continue }
      for (const localId of locals) {
        const auditFile = join(orgDir, localId, "audit.jsonl")
        if (!existsSync(auditFile)) continue
        processFile(auditFile, `${sessId}/${localId}`, store)
      }
    }
  }
  pruneClosedSessions()
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** Forget sessions whose file hasn't grown in 10 minutes — keeps the
 *  state map bounded as users accumulate scheduled-task history. */
function pruneClosedSessions(): void {
  const now = Date.now()
  for (const [key, state] of sessions) {
    if (now - state.lastSeen > 10 * 60_000) sessions.delete(key)
  }
}

function processFile(filePath: string, sessionKey: string, store: OfficeStore): void {
  let size: number
  try { size = statSync(filePath).size } catch { return }
  let state = sessions.get(sessionKey)
  if (!state) {
    // First sighting — start at the END so we don't replay historical
    // events. (Plugin parity isn't worth showing weeks-old work.)
    state = {
      filePath,
      offset: size,
      buffer: "",
      mainSpawned: false,
      toolToSubAgent: new Map(),
      activeBackgroundTools: new Set(),
      permTimerStartedAt: 0,
      permissionFlagged: false,
      mainAgentId: null,
      lastSeen: Date.now(),
    }
    sessions.set(sessionKey, state)
    return
  }
  if (size <= state.offset) {
    // No new content; record-keeping only.
    return
  }
  state.lastSeen = Date.now()
  const stream = createReadStream(filePath, { start: state.offset, end: size })
  stream.setEncoding("utf8")
  let scratch = ""
  stream.on("data", (chunk) => { scratch += chunk })
  stream.on("end", () => {
    state!.offset = size
    state!.buffer += scratch
    const lines = state!.buffer.split("\n")
    state!.buffer = lines.pop() ?? ""
    // Cancel-on-real-activity (same refinement as projects watcher).
    // Claude Code interleaves `attachment` / hook / tools_changed lines
    // between real activity. Treating those as "the agent did
    // something" reset the approval timer immediately after it armed,
    // killing the yellow bubble feature. Now only assistant / user /
    // system / progress lines cancel the timer. Heartbeat (touch)
    // still fires on any content so the character doesn't despawn
    // during attachment-only chunks.
    const isActivityLine = (line: string): boolean => {
      const trimmed = line.trim()
      if (!trimmed) return false
      const m = /"type":"([a-z_]+)"/.exec(trimmed)
      if (!m) return true
      const t = m[1]
      return t === "assistant" || t === "user" || t === "system" || t === "progress"
    }
    const hasActivity = lines.some(isActivityLine)
    const hasAnyContent = lines.some((l) => l.trim().length > 0)
    if (hasActivity) {
      state!.permTimerStartedAt = 0
      if (state!.permissionFlagged && state!.mainAgentId !== null) {
        state!.permissionFlagged = false
        store.setPermissionPending(state!.mainAgentId, "jsonl", false)
      }
    }
    if (hasAnyContent && state!.mainAgentId !== null) {
      // Heartbeat against the stale-sweeper — any new audit line keeps
      // the character on screen between scheduled-task bursts.
      store.touch(state!.mainAgentId)
    }
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let evt: AuditEvent
      try { evt = JSON.parse(trimmed) as AuditEvent } catch { continue }
      handleEvent(evt, sessionKey, state!, store)
    }
  })
  stream.on("error", (err) => {
    console.error("[pixel-bridge] audit read error", err)
  })
}

function handleEvent(
  evt: AuditEvent,
  sessionKey: string,
  state: SessionState,
  store: OfficeStore,
): void {
  const mainId = `audit-main-${sessionKey}`
  state.mainAgentId = mainId
  if (!state.mainSpawned) {
    const now = Date.now()
    store.upsert({
      id: mainId,
      name: "Agent",
      status: "starting",
      startedAt: now,
      updatedAt: now,
      done: false,
    })
    state.mainSpawned = true
  }

  if (evt.type === "assistant") {
    // Auto-fill the HUD token bar from the per-turn usage Anthropic
    // writes on every assistant message. Routed via `updateUsage`
    // (not `patch`) so it doesn't fight with the idle sweeper or
    // restart the active tool animation on every update. The model
    // id rides along so the webview can scale the HUD percentage to
    // the correct context-window cap.
    const tokens = contextTokensFromUsage(evt.message?.usage)
    const model = evt.message?.model
    if (tokens != null) {
      store.updateUsage(mainId, tokens, model)
      bumpTokenGrowth()
    }

    let sawNonExemptToolUse = false
    if (evt.message?.content && Array.isArray(evt.message.content)) {
      for (const block of evt.message.content as ToolUseBlock[]) {
        if (block?.type !== "tool_use") continue
        if (!PERMISSION_EXEMPT_TOOLS.has(block.name)) sawNonExemptToolUse = true
        handleToolUse(block, evt.parent_tool_use_id ?? null, sessionKey, mainId, state, store)
      }
    }
    // Only the assistant launching a non-exempt tool re-arms the
    // permission timer — same trigger as the plugin's
    // `TimerManager.startPermissionTimer` call site.
    if (sawNonExemptToolUse) state.permTimerStartedAt = Date.now()
  } else if (evt.type === "system" && evt.subtype === "turn_duration") {
    // End-of-turn: drop any pending permission timer so the bubble
    // doesn't strand across turns.
    state.permTimerStartedAt = 0
    // Don't mark idle while background Bash calls are still in flight —
    // the assistant turn ended but a real process is still running and
    // the user expects the character to reflect that. The scan-
    // permissions tick keeps `updatedAt` fresh so the sweeper doesn't
    // despawn it either.
    if (state.activeBackgroundTools.size === 0) {
      store.markIdle(mainId)
    }
  } else if (evt.type === "user" && evt.message?.content && Array.isArray(evt.message.content)) {
    // tool_result line — clear any matching background Bash entries
    // so the keepalive stops once Claude has BashOutput-ed the result.
    for (const block of evt.message.content as Array<{ type?: string; tool_use_id?: string }>) {
      if (block?.type === "tool_result" && block.tool_use_id) {
        state.activeBackgroundTools.delete(block.tool_use_id)
      }
    }
  }
}

/** Periodic permission scan — fire path of the plugin's
 *  `TimerManager.startPermissionTimer`. The cancel path lives in
 *  `processFile`'s line handler (any incoming line resets
 *  `permTimerStartedAt`), so by the time this runs, a still-set
 *  timestamp means the agent has been silent past the threshold. */
function scanPermissions(store: OfficeStore): void {
  const now = Date.now()
  for (const state of sessions.values()) {
    if (!state.mainSpawned || state.mainAgentId === null) continue
    const shouldFlag = state.permTimerStartedAt > 0
      && now - state.permTimerStartedAt >= PERMISSION_DELAY_MS
    if (shouldFlag !== state.permissionFlagged) {
      state.permissionFlagged = shouldFlag
      store.setPermissionPending(state.mainAgentId, "jsonl", shouldFlag)
    }
    // Background-Bash keepalive: while any `run_in_background:true`
    // tool_use is still outstanding, bump the agent's `updatedAt` so
    // the stale sweeper never despawns it mid-run. Cleared by the
    // user/tool_result branch in handleEvent.
    if (state.activeBackgroundTools.size > 0) {
      store.touch(state.mainAgentId)
    }
  }
}

function handleToolUse(
  block: ToolUseBlock,
  parentToolId: string | null,
  sessionKey: string,
  mainId: string,
  state: SessionState,
  store: OfficeStore,
): void {
  const toolName = block.name
  const toolId = block.id
  const now = Date.now()

  // Track Bash launches that won't produce a matching tool_result for
  // a long time — Claude immediately ends the assistant turn after a
  // `run_in_background:true` Bash, so the turn_duration path would mark
  // the character idle and the sweeper would despawn it even though a
  // real process is still running. The 2s permission scan keeps the
  // agent's `updatedAt` fresh while this set is non-empty.
  if (toolName === "Bash" && block.input?.["run_in_background"] === true) {
    state.activeBackgroundTools.add(toolId)
  }

  if (toolName === "Task") {
    // Spawn a sub-agent character. The Task tool's `input.subagent_type`
    // and `input.description` give us a useful label.
    const subType = (block.input?.["subagent_type"] as string | undefined) ?? "task"
    const desc = (block.input?.["description"] as string | undefined) ?? toolName
    const subId = `audit-sub-${sessionKey}-${toolId}`
    state.toolToSubAgent.set(toolId, subId)
    const parentInternalId = parentToolId
      ? state.toolToSubAgent.get(parentToolId) ?? mainId
      : mainId
    store.upsert({
      id: subId,
      name: subType,
      status: desc,
      startedAt: now,
      updatedAt: now,
      done: false,
      parentId: parentInternalId,
    })
    return
  }

  // Non-Task tool — attach activity to either the parent sub-agent
  // (when nested inside a Task) or the main agent. Status includes a
  // short summary of the tool's input so the overlay shows useful
  // detail (command / file path / query) rather than just the bare
  // tool name.
  const summary = shortInputSummary(block.input)
  const status = summary ? `${toolName}: ${summary}` : toolName
  if (parentToolId && state.toolToSubAgent.has(parentToolId)) {
    const subId = state.toolToSubAgent.get(parentToolId)!
    store.patch(subId, { status })
  } else {
    store.patch(mainId, { status })
  }
}

// Silence unused-import warning until we actually use fs.watch.
void watch
