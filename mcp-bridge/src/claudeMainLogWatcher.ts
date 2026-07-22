/**
 * Watcher for Claude Desktop's `main.log`, which records every tool
 * permission prompt and response in real time:
 *
 *   YYYY-MM-DD HH:MM:SS [info] Emitted tool permission request <reqId>
 *                              for <tool> in session <sessionId>
 *   YYYY-MM-DD HH:MM:SS [info] Received permission response for <reqId>:
 *                              <once|always|deny> (tool: <tool>)
 *
 * This is the only place outside Claude's own UI that captures the
 * "waiting for the user to click Allow" state — neither the JSONL
 * transcripts nor `claude.ai-web.log`'s `tool_approval_gate` rows fire
 * for Claude Code subprocess tools. By tailing this log we get an
 * instant signal so the webview's yellow approval bubble flips the
 * moment the prompt appears (matching the responsiveness the IntelliJ
 * plugin gets via its in-process timer), rather than waiting out the
 * 30s JSONL-based fallback.
 *
 * The 30s `claudeProjectsJsonlWatcher` timer is left in place as a
 * safety net for hosts that don't write this log (Linux, future
 * Claude builds, or anyone running the bridge against a non-Desktop
 * Claude Code instance).
 */

import { createReadStream, existsSync, statSync, watch } from "node:fs"
import { join } from "node:path"
import { homedir, platform } from "node:os"
import type { OfficeStore } from "./office.js"

/** Skip flipping the bubble on for prompts answered faster than this —
 *  with `always` rules set the Emitted→Received round-trip takes ~1s
 *  even for auto-approved tools, and a sub-second visual flicker is
 *  more annoying than useful. Lined up with the typical human "see
 *  prompt → click Allow" reaction time so genuine waits still register. */
const APPROVAL_FLICKER_GUARD_MS = 700

/** Once the bubble IS shown, keep it on for at least this long even if
 *  the user clicks Allow immediately afterward. Without this, a quick
 *  human response (~1-2s) leaves the bubble flashing on screen for
 *  half a heartbeat — long enough to register as "something happened"
 *  but too short to read. Padding the display ensures the user sees
 *  "Wait" clearly before the agent transitions back to working. */
const APPROVAL_MIN_VISIBLE_MS = 1500

const EMIT_RE = /Emitted tool permission request ([a-f0-9-]+) for (\S+) in session (\S+)/
const RECV_RE = /Received permission response for ([a-f0-9-]+):/
// NOTE: `[oauth] looking up token … api.anthropic.com` was tried as a
// "new turn / streaming heartbeat" signal, but it turns out Desktop
// writes that line on a *fixed 60-second background token refresh*,
// not in lockstep with model requests. Treating it as activity caused
// `store.touch("main")` to fire every 60s, which kept `updatedAt`
// fresh and prevented the stale sweeper from ever despawning the
// character. EMIT/RECV remain the only main.log-derived activity
// signals; text-only Desktop turns rely on the JSONL watcher's
// `markIdle` + the stale sweeper's `idleAfterMs` budget to handle
// the gap (short visible-idle during long text turns is acceptable;
// permanent never-despawning was not).

export interface MainLogWatcher {
  stop: () => void
}

/** Resolve the platform's Claude Desktop main.log path. Returns null
 *  on unsupported platforms (the watcher then no-ops, letting the
 *  30s JSONL fallback do its job). */
function mainLogPath(): string | null {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Logs", "Claude", "main.log")
  }
  if (platform() === "linux") {
    // Common Electron/Chromium log location — exact path may vary by
    // distro packaging. Best-effort; users on Linux who don't see
    // instant bubbles can rely on the 30s JSONL fallback.
    return join(homedir(), ".config", "Claude", "logs", "main.log")
  }
  if (platform() === "win32") {
    const appData = process.env["APPDATA"]
    if (!appData) return null
    return join(appData, "Claude", "logs", "main.log")
  }
  return null
}

interface PendingRequest {
  /** When `Emitted` was seen — used to dedupe rapid auto-allow
   *  prompts that resolve faster than the flicker guard. */
  emittedAt: number
  /** ms-epoch when the bubble actually became visible. Used to enforce
   *  `APPROVAL_MIN_VISIBLE_MS` — a Received arriving sooner than that
   *  defers `flipBubbleOff` until the minimum has elapsed. 0 means
   *  the bubble hasn't been flipped on yet. */
  shownAt: number
  /** Scheduled timer that will flip the bubble on after the flicker
   *  guard elapses. Cleared if the matching `Received` arrives first. */
  showTimer: NodeJS.Timeout | null
  /** The tool name for log/debug purposes. */
  toolName: string
}

export function startMainLogWatcher(store: OfficeStore): MainLogWatcher {
  const resolved = mainLogPath()
  if (!resolved || !existsSync(resolved)) {
    console.error("[pixel-bridge] no Claude main.log — skipping instant-approval watcher")
    return { stop: () => {} }
  }
  // Capture into a non-nullable local so closures below don't trip
  // `string | null` narrowing — TS can't carry the `!= null` guard
  // through the nested callbacks otherwise.
  const path: string = resolved
  console.error(`[pixel-bridge] watching ${path} for tool approval prompts`)

  /** Open permission prompts keyed by request id. Emitted adds an
   *  entry (with a delayed-show timer); Received removes it (cancelling
   *  the timer if it hasn't fired yet, or clearing the bubble if it
   *  has). Tracking per-id lets parallel tool calls coexist without
   *  one's Received clearing another's still-open prompt. */
  const pending = new Map<string, PendingRequest>()
  /** Count of currently-shown prompts. The webview's `agentToolPermission`
   *  is per-agent, not per-tool, so we only emit on the 0→1 transition
   *  (and Clear on 1→0). Otherwise approving one of three parallel
   *  prompts would prematurely drop the bubble. */
  let shownCount = 0

  /** Resolve the top-level agent ID at flip time. The CLI projects
   *  watcher uses `cli-main-<sessionId>` when no "main" record exists
   *  at first activity, and Desktop watchers use the literal `"main"`.
   *  Hard-coding "main" here previously meant approval flags landed on
   *  a non-existent record in CLI mode → `setPermissionPending` was a
   *  no-op and the yellow bubble never fired. Picking the first
   *  top-level live record makes the watcher work uniformly. */
  function resolveMainAgentId(): string {
    const existing = store.list().find((r) => !r.parentId && !r.done)
    return existing?.id ?? "main"
  }

  function flipBubbleOn(): void {
    if (shownCount === 0) {
      // Ensure SOME top-level agent exists — an `Emitted tool
      // permission request` line is itself a strong "Claude is active
      // right now" signal. Without this guard, the first approval
      // prompt of a fresh session is silently dropped when no other
      // watcher has gotten around to upserting yet.
      let targetId = resolveMainAgentId()
      if (!store.has(targetId)) {
        const now = Date.now()
        store.upsert({
          id: "main",
          name: "Claude",
          status: "Working",
          startedAt: now,
          updatedAt: now,
          done: false,
        })
        targetId = "main"
      }
      bubbleAgentId = targetId
      store.setPermissionPending(targetId, "mainlog", true)
    }
    shownCount += 1
  }

  function flipBubbleOff(): void {
    if (shownCount <= 0) return
    shownCount -= 1
    if (shownCount === 0) {
      // Use the same record the on-flip landed on — looking up "main"
      // again would miss the cli-main-… case.
      const targetId = bubbleAgentId ?? resolveMainAgentId()
      store.setPermissionPending(targetId, "mainlog", false)
      // main.log's Received is the authoritative "approval resolved"
      // signal — also release the JSONL 30s-fallback claim so the
      // bubble disappears the instant the user clicks Allow, instead
      // of lingering until the tool_result line eventually surfaces
      // and the JSONL watcher gets around to clearing its own state.
      store.setPermissionPending(targetId, "jsonl", false)
      bubbleAgentId = null
    }
  }

  /** Caches the record id that the current on/off cycle is flagging,
   *  so a `Received` that arrives after a `cli-main-…` watcher has
   *  meanwhile renamed the agent doesn't strand the bubble on the
   *  wrong record. Reset to null on the 1→0 transition. */
  let bubbleAgentId: string | null = null

  let offset = 0
  try { offset = statSync(path).size } catch { /* race with rotation */ }
  let buffer = ""
  let reading = false

  function readNew(): void {
    if (reading) return
    reading = true
    let size = offset
    try { size = statSync(path).size } catch { reading = false; return }
    if (size < offset) {
      // Log rotated underneath us — start over from the new file head.
      offset = 0
    }
    if (size === offset) { reading = false; return }
    const stream = createReadStream(path, { start: offset, end: size, encoding: "utf8" })
    stream.on("data", (chunk) => { buffer += chunk })
    stream.on("end", () => {
      offset = size
      reading = false
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) handleLine(line)
    })
    stream.on("error", () => { reading = false })
  }

  function handleLine(line: string): void {
    const emit = EMIT_RE.exec(line)
    const recv = !emit ? RECV_RE.exec(line) : null

    // EMIT/RECV are the only real activity signals on main.log — both
    // map to actual UI events (Desktop showing/clearing an approval
    // prompt), so they're safe to use as a heartbeat. Use the same
    // dynamic id resolver as `flipBubbleOn` so CLI sessions
    // (`cli-main-<sessionId>`) get heartbeated correctly instead of
    // landing on a non-existent literal "main".
    if (emit || recv) {
      const targetId = resolveMainAgentId()
      if (store.has(targetId)) store.touch(targetId)
    }

    if (emit) {
      const [, reqId, toolName] = emit
      // Cancel any stale entry under the same id (shouldn't happen
      // but defensive against duplicate-line corner cases).
      const prev = pending.get(reqId)
      if (prev?.showTimer) clearTimeout(prev.showTimer)
      const entry: PendingRequest = {
        emittedAt: Date.now(),
        shownAt: 0,
        toolName,
        showTimer: setTimeout(() => {
          // Only flip on if this request is still pending (Received
          // could have raced in but missed the timer's fire instant).
          if (pending.has(reqId)) {
            entry.showTimer = null
            entry.shownAt = Date.now()
            flipBubbleOn()
          }
        }, APPROVAL_FLICKER_GUARD_MS),
      }
      pending.set(reqId, entry)
      return
    }
    if (recv) {
      const [, reqId] = recv
      const entry = pending.get(reqId)
      if (!entry) return
      pending.delete(reqId)
      if (entry.showTimer) {
        // Resolved before the flicker guard fired — never flipped on,
        // nothing to flip off.
        clearTimeout(entry.showTimer)
        return
      }
      // Bubble was already flipped on — enforce the minimum visible
      // window so a 1-2s human reaction time doesn't render the chip
      // as a half-second flash. If the user clicked early, defer the
      // clear until APPROVAL_MIN_VISIBLE_MS has elapsed from `shownAt`.
      const visibleFor = Date.now() - entry.shownAt
      const remaining = APPROVAL_MIN_VISIBLE_MS - visibleFor
      if (remaining > 0) setTimeout(flipBubbleOff, remaining)
      else flipBubbleOff()
    }
  }

  // Hybrid notify path: fs.watch is instant but unreliable on macOS
  // (and across log rotation), so back it up with a 2s poll.
  let fsWatcher: ReturnType<typeof watch> | null = null
  try {
    fsWatcher = watch(path, () => readNew())
  } catch { /* fall back to polling alone */ }
  const interval = setInterval(readNew, 2_000)
  interval.unref?.()

  return {
    stop: () => {
      try { fsWatcher?.close() } catch { /* */ }
      clearInterval(interval)
      // Clean up any still-pending timers so the process can exit
      // promptly on bridge teardown.
      for (const entry of pending.values()) {
        if (entry.showTimer) clearTimeout(entry.showTimer)
      }
      pending.clear()
    },
  }
}
