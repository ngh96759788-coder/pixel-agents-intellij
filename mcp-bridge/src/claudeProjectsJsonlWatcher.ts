/**
 * Watcher for Claude Code's JSONL transcripts at
 *   ~/.claude/projects/<project-hash>/<session-uuid>.jsonl
 *
 * Modern Claude Desktop offloads tool execution to a Claude Code
 * subprocess for many features (Skills, project mode, Code-tab tasks).
 * Those tool calls bypass `claude.ai-web.log`'s tool_approval_gate and
 * land in the CLI JSONL instead. Without this watcher, "I ran 3 bash
 * commands in Desktop chat" produces no characters because the events
 * never reach our log channel.
 *
 * Format mirrors the audit.jsonl already parsed by
 * `claudeAuditJsonlWatcher`, so the event handling logic is identical
 * (assistant turn → tool_use blocks → main/sub agent activity, Task
 * tool → sub-agent spawn). We pick the freshest project's freshest
 * session and tail it; that matches "I'm working on this thing right
 * now" intuition.
 *
 * Coexists peacefully with the IntelliJ plugin's TranscriptParser:
 * both can tail the same JSONL file (read-only, append-only writes).
 * Plugin renders in the IDE panel; we render in the Desktop widget.
 */

import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execSync } from "node:child_process"
import type { OfficeStore } from "./office.js"
import { contextTokensFromUsage, shortInputSummary, type AssistantUsage } from "./usage.js"
import { bumpTokenGrowth } from "./index.js"

/** How this bridge was spawned, which decides what activity it should
 *  show. Keeping CLI and Desktop offices fully separate was an explicit
 *  user request: a Desktop window must not fill with characters from
 *  every terminal claude on the box, and a CLI window must not echo
 *  another session's tool calls.
 *
 *  - `cli-scoped`  — spawned by `claude` CLI; we have a session UUID, so
 *                    the projects-jsonl watcher narrows to ONLY that
 *                    session's transcript file.
 *  - `desktop`     — spawned by Claude Desktop (`Claude.app`). Desktop
 *                    activity reaches us through `main.log`, the audit
 *                    JSONLs, and `claude.ai-web.log`; the
 *                    projects-jsonl watcher is skipped entirely so it
 *                    can't leak other terminals' claudes into the
 *                    widget. Skills/agent-mode workflows are still
 *                    visible via audit.jsonl.
 *  - `global`      — fallback for env override or detection failure;
 *                    behaves like the pre-scoping default (watch every
 *                    .jsonl in ~/.claude/projects).
 *
 *  Override: `PIXEL_OFFICE_SHOW_ALL_SESSIONS=1` forces `global` even
 *  when detection succeeds, restoring the original "multi-terminal
 *  office" view for users who liked it. */
type BridgeMode =
  | { kind: "cli-scoped"; sessionId: string }
  | { kind: "desktop" }
  | { kind: "global" }

// Exported so other modules (notably the office_diagnose MCP tool) can
// surface the current scope without re-running PPID detection.
export const BRIDGE_MODE: BridgeMode = detectBridgeMode()
export const OWN_SESSION_ID: string | null =
  BRIDGE_MODE.kind === "cli-scoped" ? BRIDGE_MODE.sessionId : null

function detectBridgeMode(): BridgeMode {
  if (process.env["PIXEL_OFFICE_SHOW_ALL_SESSIONS"] === "1") return { kind: "global" }
  // Walk up the process tree a few levels — Claude Code on macOS spawns
  // through a `disclaimer` shim and sometimes a wrapper, so the actual
  // `claude --resume <uuid>` argv may be a grandparent, not the direct
  // parent. 5 levels is enough for any realistic launcher chain without
  // climbing all the way to launchd.
  let pid = process.ppid
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    try {
      const argv = execSync(`ps -p ${pid} -o command=`, {
        encoding: "utf8",
        timeout: 1000,
      })
      // CLI ancestor: `claude --resume <uuid>` or `--session-id <uuid>`.
      const m = /--(?:resume|session-id)\s+([a-f0-9-]{36})/i.exec(argv)
      if (m) return { kind: "cli-scoped", sessionId: m[1] }
      // Desktop ancestor: the Claude.app main binary. Matching the
      // full path keeps us from confusing the Claude Code CLI shim
      // (`claude-code/<ver>/claude.app/...`) with Desktop proper —
      // CLI's `--resume` is checked first above, so by the time we
      // reach the desktop test the CLI case has already been ruled
      // out for this PID.
      if (/\/Claude\.app\/Contents\/MacOS\/Claude(\s|$)/.test(argv)) {
        return { kind: "desktop" }
      }
      // Climb one level — `ps -p <pid> -o ppid=` gives the parent.
      const ppidStr = execSync(`ps -p ${pid} -o ppid=`, {
        encoding: "utf8",
        timeout: 1000,
      }).trim()
      const ppid = parseInt(ppidStr, 10)
      if (!Number.isFinite(ppid) || ppid <= 1 || ppid === pid) break
      pid = ppid
    } catch {
      break
    }
  }
  return { kind: "global" }
}

interface JsonlEvent {
  type?: string
  subtype?: string
  session_id?: string
  uuid?: string
  parent_tool_use_id?: string | null
  isSidechain?: boolean
  message?: {
    role?: "user" | "assistant"
    content?: unknown
    /** Real model id (e.g. "claude-opus-4-7") — Claude writes it on
     *  every assistant turn alongside the response. Used to pick the
     *  correct context-window scale for the HUD percentage. */
    model?: string
    /** Anthropic API usage block written on every assistant turn —
     *  used to auto-fill the office HUD's token bar without needing
     *  Claude to call `office_status` manually. */
    usage?: AssistantUsage
    /** Reason the assistant stopped generating. Claude Code CLI does
     *  NOT emit `system.subtype="turn_duration"` (only Desktop's audit
     *  flow does), so the CLI watcher uses this field as the turn-end
     *  signal instead:
     *    - "end_turn" / "stop_sequence" → model is done, mark idle
     *    - "tool_use" → more activity coming, don't mark idle
     *    - "max_tokens" → cut off mid-stream, treat as end-of-turn so
     *      the character doesn't hang. */
    stop_reason?: string
  }
}

interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input?: Record<string, unknown>
}

/** How long a non-exempt tool_use can sit without ANY subsequent JSONL
 *  activity before we flag the agent as awaiting approval. Matches
 *  `Constants.PERMISSION_TIMER_DELAY_MS` (30000) in the IntelliJ
 *  plugin's `TimerManager` so the MCP bridge and the plugin flip the
 *  yellow bubble at exactly the same wait threshold. */
const PERMISSION_DELAY_MS = 30_000

/** Tools that don't trigger the approval bubble even when they sit
 *  for a long time. Matches `TimerManager.PERMISSION_EXEMPT_TOOLS` in
 *  the plugin:
 *  - `Task`: spawns a sub-agent; the sub's own activity drives its
 *    permission state, so the parent's wait isn't an approval pause.
 *  - `AskUserQuestion`: deliberately waiting on the user; the wait
 *    IS the design, not an approval prompt.
 */
const PERMISSION_EXEMPT_TOOLS = new Set(["Task", "AskUserQuestion"])

interface SessionState {
  filePath: string
  /** Session UUID parsed from the .jsonl filename. Used as the
   *  character-id suffix so parallel sessions in the same project
   *  each get their own character instead of stomping each other. */
  sessionId: string
  offset: number
  buffer: string
  mainSpawned: boolean
  /** Id we use in the OfficeStore for this session's main character.
   *  Defaults to `cli-main-<sessionId>` to keep parallel sessions
   *  visually distinct, but the FIRST session to attach adopts the
   *  generic "main" placeholder that `office_open` creates so the
   *  user doesn't see two characters representing the same chat. */
  mainAgentId: string | null
  /** Timestamp at which the current permission timer was (re)started,
   *  or 0 when no timer is running. Mirrors the plugin's
   *  `TimerManager.startPermissionTimer` lifecycle:
   *    - Any new JSONL line cancels the timer (sets back to 0) — the
   *      mere fact that lines are still being appended means the tool
   *      hasn't gotten stuck on an approval prompt.
   *    - A fresh assistant-turn `tool_use` for a non-exempt tool
   *      restarts the timer.
   *    - If `Date.now() - permTimerStartedAt >= PERMISSION_DELAY_MS`
   *      with no intervening lines, the scan flips
   *      `permissionFlagged` true. */
  permTimerStartedAt: number
  /** Last value we pushed to `store.setPermissionPending()` — debounces
   *  repeat emissions and lets us emit the matching "clear" when
   *  activity resumes. */
  permissionFlagged: boolean
  /** tool_use id from JSONL → our internal sub-agent id. Lets us route
   *  subsequent nested tool calls to the right sub character. */
  toolToSubAgent: Map<string, string>
  /** Outstanding `Bash(run_in_background:true)` tool_use ids that
   *  haven't received a matching tool_result yet. While non-empty:
   *    1. `stop_reason !== "tool_use"` skips `markIdle` — the turn
   *       ended on the model's side but a real process is still
   *       running, so the character should stay visibly active.
   *    2. The 2s permission-scan tick `touch()`es the main agent so
   *       the stale sweeper's idle/despawn cutoff never elapses while
   *       background work is pending. */
  activeBackgroundTools: Set<string>
  /** Set once per session when we first decide whether this transcript
   *  belongs to our own bridge or an external one (different terminal /
   *  IntelliJ window / Desktop Code subprocess). Propagated to the
   *  webview via every `upsert`/`patch` on the main agent so the
   *  renderer can apply 85% opacity and the integrated-view toggle can
   *  filter. Decision rule:
   *    - OWN_SESSION_ID set AND filename starts with it → false
   *    - otherwise → true */
  isExternal: boolean
  lastSeen: number
  /** Cached `entrypoint` field from the session's first few lines.
   *  "claude-desktop" → Desktop UI chat (track), "cli" → user opened
   *  a separate terminal `claude` (skip — that activity belongs to
   *  the IntelliJ plugin's domain, not the Desktop widget). */
  entrypoint: string | null
}

/** How recent a .jsonl file's mtime must be for us to consider it a
 *  live session worth tailing. Older files are stale resumes that the
 *  user isn't actively writing to. Keeps scan work bounded as the
 *  ~/.claude/projects directory grows over months. */
const ACTIVE_WINDOW_MS = 10 * 60_000

/** Peek at the head of a JSONL file (default 16 KB) for the
 *  `entrypoint` field that Claude writes on attachment/user events.
 *  Returns "claude-desktop", "cli", or null when not found yet. */
function detectEntrypoint(filePath: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, "r")
    const buf = Buffer.alloc(16384)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const content = buf.toString("utf8", 0, n)
    const m = /"entrypoint":"([^"]+)"/.exec(content)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    if (fd != null) {
      try { closeSync(fd) } catch { /* */ }
    }
  }
}

const sessions = new Map<string, SessionState>()

export interface ProjectsWatcher {
  stop: () => void
}

export function startProjectsJsonlWatcher(store: OfficeStore): ProjectsWatcher {
  // BEHAVIOR_SPEC §4: the watcher always runs, but sessions other than
  // OWN_SESSION_ID are tagged `isExternal: true` so the webview can
  // render them at 85% opacity (and the integrated-view toggle can
  // hide them entirely). Previously we skipped this watcher in
  // `desktop` mode, which produced a clean Desktop-only view but
  // removed any way to surface concurrent CLI work — the integrated
  // toggle now subsumes both behaviours.
  const baseDir = projectsBaseDir()
  if (!baseDir || !existsSync(baseDir)) {
    console.error("[pixel-bridge] no ~/.claude/projects — skipping projects-jsonl watcher")
    return { stop: () => {} }
  }
  console.error(
    OWN_SESSION_ID
      ? `[pixel-bridge] watching project JSONLs under ${baseDir} (scoped to own session ${OWN_SESSION_ID.slice(0, 8)}…; set PIXEL_OFFICE_SHOW_ALL_SESSIONS=1 to see all)`
      : `[pixel-bridge] watching project JSONLs under ${baseDir} (global — no --resume in parent argv, or env override)`,
  )
  const interval = setInterval(() => {
    scanAll(baseDir, store)
    scanPermissions(store)
  }, 2_000)
  interval.unref?.()
  scanAll(baseDir, store)  // populate offsets without replaying history
  return { stop: () => clearInterval(interval) }
}

function projectsBaseDir(): string {
  return join(homedir(), ".claude", "projects")
}

/** Walk every project folder and poll EVERY recently-touched .jsonl
 *  inside it. Previously we picked the single newest file per project,
 *  but that breaks when the user runs more than one Claude Code session
 *  against the same workspace (e.g. two terminals at `~`): the loser
 *  session's tool calls were silently dropped because the watcher only
 *  tailed the freshest mtime. Now each active jsonl gets its own
 *  SessionState keyed by filePath, so parallel sessions each spawn
 *  their own character. */
function scanAll(baseDir: string, store: OfficeStore): void {
  let projects: string[]
  try {
    projects = readdirSync(baseDir)
  } catch {
    return
  }
  const now = Date.now()
  for (const proj of projects) {
    const projDir = join(baseDir, proj)
    let projStat: ReturnType<typeof statSync>
    try {
      projStat = statSync(projDir)
    } catch {
      continue
    }
    if (!projStat.isDirectory()) continue

    let entries: string[]
    try {
      entries = readdirSync(projDir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue
      // BEHAVIOR_SPEC §4: every session is processed; sessions other
      // than OWN_SESSION_ID become `isExternal: true` characters
      // (rendered at 85% opacity, hidden when the integrated-view
      // toggle is off). The old "filter at scan time" approach removed
      // any way to show external work; tagging downstream keeps both
      // the default-only view and the integrated view in one watcher.
      const p = join(projDir, name)
      let s: ReturnType<typeof statSync>
      try {
        s = statSync(p)
      } catch {
        continue
      }
      // Skip stale files we know nothing about. If we already track this
      // file, keep polling it regardless of mtime so an in-flight append
      // we haven't read yet still gets processed.
      if (!sessions.has(p) && now - s.mtimeMs > ACTIVE_WINDOW_MS) continue
      processFile(p, store)
    }
  }
  pruneClosedSessions()
}

/** Forget projects whose tracked file hasn't grown in 10 minutes. */
function pruneClosedSessions(): void {
  const now = Date.now()
  for (const [key, state] of sessions) {
    if (now - state.lastSeen > 10 * 60_000) sessions.delete(key)
  }
}

function processFile(filePath: string, store: OfficeStore): void {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return
  }
  let state = sessions.get(filePath)
  if (!state) {
    // First sighting — figure out whether this is a Desktop session
    // (track) or a terminal-CLI session (skip). Skip historical
    // content either way; the watcher only reports new activity.
    const entrypoint = detectEntrypoint(filePath)
    const sid = sessionIdFromPath(filePath)
    // Decide once whether this session belongs to our bridge or to
    // someone else (another CLI window, IntelliJ window, Desktop Code
    // subprocess). All subsequent upsert/patch calls forward this flag
    // so the webview can fade external work to 85% opacity (§4).
    const isExternal = !(OWN_SESSION_ID && sid === OWN_SESSION_ID)
    state = {
      filePath,
      sessionId: sid,
      offset: size,
      buffer: "",
      mainSpawned: false,
      mainAgentId: null,
      permTimerStartedAt: 0,
      permissionFlagged: false,
      toolToSubAgent: new Map(),
      activeBackgroundTools: new Set(),
      isExternal,
      lastSeen: Date.now(),
      entrypoint,
    }
    sessions.set(filePath, state)
    return
  }
  // Refresh the cached entrypoint if we couldn't read it on first sighting
  // (file was too short, race with creation, …). Kept around for diagnostics
  // and so future per-entrypoint logic has the value to dispatch on, but no
  // longer used to filter — the bridge gets installed in BOTH Claude Desktop
  // (.mcpb) and Claude Code CLI (`claude mcp add`), and the CLI install case
  // means the user explicitly wants their CLI sessions visualised. The old
  // hard-filter on `entrypoint !== "claude-desktop"` would silently drop every
  // CLI session's tokens + tool activity, leaving the HUD empty for half the
  // user base. Multiple concurrent sessions (Desktop + several CLI terminals)
  // each spawn their own character via `cli-main-<sessionId>` already, so
  // tracking them all here is safe.
  if (state.entrypoint === null) {
    state.entrypoint = detectEntrypoint(filePath)
  }
  if (size <= state.offset) return
  state.lastSeen = Date.now()
  const stream = createReadStream(filePath, { start: state.offset, end: size })
  stream.setEncoding("utf8")
  let scratch = ""
  stream.on("data", (chunk) => {
    scratch += chunk
  })
  stream.on("end", () => {
    state!.offset = size
    state!.buffer += scratch
    const lines = state!.buffer.split("\n")
    state!.buffer = lines.pop() ?? ""
    // Cancel-on-real-activity: mirrors the plugin's FileWatcher
    // (`readNewLines` line 140-147), with one important refinement.
    // The original "any new line cancels" assumption broke when Claude
    // Code started emitting `attachment` events (deferred_tools_delta,
    // mcp_instructions_delta, hook_success, tools_changed, …) a few
    // milliseconds after every assistant `tool_use`. Those are
    // bookkeeping side-effects of Claude's own machinery, NOT user
    // activity — so treating them as "activity" reset the permission
    // timer immediately after it was armed and the yellow approval
    // bubble effectively never fired anywhere. JSONL ground truth on
    // the live session showed 18 of 19 long-gap stalls (>=30s, all
    // genuine approval waits) had `attachment` as their last event
    // before the silence.
    //
    // Fix: only count "real activity" types as cancellation triggers.
    // That's the subset that genuinely proves the agent isn't stuck —
    // assistant turns (model produced output), user turns (user
    // responded), and explicit progress/system events. Attachments and
    // hook bookkeeping are excluded.
    const isActivityLine = (line: string): boolean => {
      const trimmed = line.trim()
      if (!trimmed) return false
      // Cheap prefix match instead of full JSON.parse — these are huge
      // lines and we hit them on every chunk. The downstream `for`
      // loop does the actual parsing for events we care about.
      const m = /"type":"([a-z_]+)"/.exec(trimmed)
      if (!m) return true // unknown shape, fall back to "yes, activity"
      const t = m[1]
      // Real activity: someone (model or user) said something or a
      // progress/turn signal landed. These genuinely prove the agent
      // is not blocked on an approval prompt.
      return t === "assistant" || t === "user" || t === "system" || t === "progress"
    }
    const hasActivity = lines.some(isActivityLine)
    // Heartbeat keeps using the loose "any non-blank line" definition
    // — keeping the character alive during attachment-only chunks is
    // still desirable, we just don't want those to clear the approval
    // timer. Separate booleans for separate concerns.
    const hasAnyContent = lines.some((l) => l.trim().length > 0)
    if (hasActivity) {
      state!.permTimerStartedAt = 0
      if (state!.permissionFlagged && state!.mainAgentId !== null) {
        state!.permissionFlagged = false
        store.setPermissionPending(state!.mainAgentId, "jsonl", false)
      }
    }
    if (hasAnyContent && state!.mainAgentId !== null) {
      // Heartbeat: any new line keeps the character alive against the
      // sweeper despawn so long user-composition gaps don't leave an
      // empty office between turns. No-op when the agent hasn't been
      // spawned yet (the first event below upserts it).
      store.touch(state!.mainAgentId)
    }
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let evt: JsonlEvent
      try {
        evt = JSON.parse(trimmed) as JsonlEvent
      } catch {
        continue
      }
      handleEvent(evt, state!, store)
    }
  })
  stream.on("error", (err) => {
    console.error("[pixel-bridge] projects-jsonl read error", err)
  })
}

/** Pull the session UUID out of `<uuid>.jsonl`. Falls back to the
 *  basename if the filename doesn't match the usual pattern, which
 *  still gives us a unique-per-file key. */
function sessionIdFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.replace(/\.jsonl$/i, "")
}

function handleEvent(
  evt: JsonlEvent,
  state: SessionState,
  store: OfficeStore,
): void {
  // Skip sidechains — those are sub-conversations the plugin/CLI uses
  // for things like "summarize this" callouts and they pollute the
  // main agent's activity feed.
  if (evt.isSidechain) return

  // Resolve the agent id for this session. First time through, prefer
  // adopting `office_open`'s generic "main" placeholder if it exists
  // and no other JSONL session has claimed it — this prevents the
  // common case (open Desktop → projects watcher fires) from rendering
  // two characters for one conversation. Cached on SessionState so the
  // same id is reused for the lifetime of the session even if "main"
  // is removed later by the stale sweeper.
  if (state.mainAgentId === null) {
    // External sessions never adopt the generic "main" id — that one
    // belongs to the bridge's own session (or whichever other watcher
    // upserted it first). Forcing `cli-main-<sessionId>` for externals
    // keeps the own-vs-external distinction intact downstream.
    const otherAdopted = Array.from(sessions.values()).some(
      (s) => s !== state && s.mainAgentId === "main",
    )
    state.mainAgentId = !state.isExternal && store.has("main") && !otherAdopted
      ? "main"
      : `cli-main-${state.sessionId}`
  }
  const mainId = state.mainAgentId
  // Re-upsert if the main character was despawned by the stale sweeper
  // (60s of silence). Without this the local `mainSpawned` flag stays
  // true forever and subsequent patch() calls silently no-op against a
  // missing agent record, leaving the user staring at an empty office.
  if (!state.mainSpawned || !store.has(mainId)) {
    const now = Date.now()
    store.upsert({
      id: mainId,
      name: "Claude",
      status: "starting",
      startedAt: now,
      updatedAt: now,
      done: false,
      isExternal: state.isExternal,
    })
    state.mainSpawned = true
  }

  if (evt.type === "assistant") {
    // Auto-fill the HUD token bar from the per-turn usage Anthropic
    // writes on every assistant message. Done before tool dispatch so
    // the HUD stays current even on text-only turns (no tool_use
    // blocks). Routed via `updateUsage` rather than `patch` so it
    // doesn't reset the stale sweeper or restart tool animations.
    // The model id is captured alongside so the webview can pick the
    // correct context-window scale (Opus 4.x: 1M, others: 200K).
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
        handleToolUse(block, evt.parent_tool_use_id ?? null, mainId, state, store)
      }
    }
    // Restart the permission timer when the assistant just kicked off
    // a non-exempt tool. Any other line type (text-only assistant,
    // tool_result, system) doesn't start a timer — only fresh non-
    // exempt tool_use does, matching the plugin's `startPermissionTimer`
    // call site in `TranscriptParser.processAssistantRecord`.
    if (sawNonExemptToolUse) state.permTimerStartedAt = Date.now()

    // Turn-end detection for Claude Code CLI. CLI sessions do NOT emit
    // `system.subtype="turn_duration"` (only Desktop's audit.jsonl flow
    // does), so the only reliable end-of-turn signal here is the
    // assistant message's `stop_reason`:
    //   - "end_turn" / "stop_sequence" → model finished its response
    //   - "max_tokens" → cut off but conceptually still a turn boundary
    //   - "tool_use" → more activity coming, do NOT mark idle (the
    //     model produced tool_use blocks and is waiting on their results)
    // Without this branch the main character was stuck "active" with
    // the last tool name ("office_open", "Bash", …) as its status for
    // the entire conversation because the stale sweeper's 30s silence
    // counter kept getting reset by `touch()` on every line.
    const stopReason = evt.message?.stop_reason
    if (stopReason && stopReason !== "tool_use") {
      state.permTimerStartedAt = 0
      // Don't mark idle while background Bash calls are still in
      // flight — the assistant turn ended but a real process is
      // still running and the user expects the character to reflect
      // that. The scan-permissions tick will keep `updatedAt` fresh
      // so the sweeper doesn't despawn it either.
      if (state.activeBackgroundTools.size === 0) {
        store.markIdle(mainId)
      }
    }
  } else if (evt.type === "system" && evt.subtype === "turn_duration") {
    // End-of-turn — the model said its piece, anything outstanding was
    // implicitly resolved. Drop any latent permission timer so we
    // don't strand a yellow bubble across turns. Desktop audit.jsonl
    // path only; CLI uses the `stop_reason` branch above.
    state.permTimerStartedAt = 0
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

/** Periodic permission-timer scan. Mirrors the fire path of the
 *  plugin's `TimerManager.startPermissionTimer`: when a session's
 *  permTimer has been running uninterrupted for `PERMISSION_DELAY_MS`,
 *  flip the agent's permissionPending flag (which the WS layer turns
 *  into `agentToolPermission`). Cancellation is handled in
 *  `processFile`'s line handler — by the time the scan fires, any
 *  intervening JSONL activity has already zeroed `permTimerStartedAt`. */
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
    // tool_use is still outstanding, bump the agent's `updatedAt`
    // so the stale sweeper's single 30s sub-agent despawn timer
    // (spec: sub 30s / main 60s) never cuts in. Cleared by the
    // user/tool_result branch in handleEvent.
    if (state.activeBackgroundTools.size > 0) {
      store.touch(state.mainAgentId)
    }
  }
}

function handleToolUse(
  block: ToolUseBlock,
  parentToolId: string | null,
  mainId: string,
  state: SessionState,
  store: OfficeStore,
): void {
  const toolName = block.name
  const toolId = block.id
  const now = Date.now()

  // Track Bash launches that won't produce a matching tool_result for
  // a long time — Claude immediately ends the assistant turn after
  // a `run_in_background:true` Bash, so the default stop_reason path
  // would mark the character idle and the sweeper would despawn it
  // within 30s even though a real process is still running. The
  // 2s permission scan keeps the agent's `updatedAt` fresh while
  // this set is non-empty.
  if (toolName === "Bash" && block.input?.["run_in_background"] === true) {
    state.activeBackgroundTools.add(toolId)
  }

  if (toolName === "Task") {
    const subType = (block.input?.["subagent_type"] as string | undefined) ?? "task"
    const desc = (block.input?.["description"] as string | undefined) ?? toolName
    const subId = `cli-sub-${state.sessionId}-${toolId}`
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

  // Build a richer status string: `${toolName}: ${shortInputSummary}`
  // so the overlay shows e.g. "Bash: ls -la /tmp" or "Read: server.ts"
  // instead of just the bare tool name. Falls back to the tool name
  // when no useful input field is present.
  const summary = shortInputSummary(block.input)
  const status = summary ? `${toolName}: ${summary}` : toolName

  if (parentToolId && state.toolToSubAgent.has(parentToolId)) {
    const subId = state.toolToSubAgent.get(parentToolId)!
    store.patch(subId, { status })
  } else {
    store.patch(mainId, { status })
  }
}
