/**
 * Pixel Office MCP Bridge — entry point.
 *
 * The bridge ships as a Claude Desktop extension (.mcpb). When Claude
 * Desktop spawns this process and Claude invokes one of our tools, we:
 *
 *  1. Update an in-memory OfficeStore (the source of truth for "who is
 *     currently working in the Claude Desktop office").
 *  2. Push the diff to any browser tabs subscribed via WebSocket.
 *
 * The HTTP + WS server is lazy. Nothing is bound until Claude (or the
 * user) invokes the `office_open` tool, at which point we boot the
 * listener and pop open a browser tab pointed at it.
 *
 * Critical channel hygiene: stdout is reserved for the MCP JSON-RPC
 * stream. Diagnostics MUST go to stderr or Claude Desktop will drop the
 * connection with a parse error.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { OfficeStore } from "./office.js"
import { startOfficeServer, openBrowser } from "./server.js"
import { startDesktopLogWatcher } from "./claudeDesktopLogWatcher.js"
import { startAuditJsonlWatcher } from "./claudeAuditJsonlWatcher.js"
import { startProjectsJsonlWatcher, BRIDGE_MODE, OWN_SESSION_ID } from "./claudeProjectsJsonlWatcher.js"
import { startMainLogWatcher } from "./claudeMainLogWatcher.js"
import { calculateQuotaWindow } from "./quotaWindow.js"
import { DESPAWN_SUB_MS, DESPAWN_MAIN_MS, SWEEPER_INTERVAL_MS, QUOTA_TICK_MS } from "./spec.js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Boot-line diagnostic: prints version + PID + start timestamp to stderr
// the moment this process starts. Lets the user (or a verify script)
// grep `mcp-server-Pixel Office Bridge.log` to confirm:
//   1. WHICH version is actually running (not just what's on disk)
//   2. WHEN it started (so they can tell if a Cmd+Q restart actually
//      spawned a new process)
// Past incidents: Extension Dir got rolled back to an old .mcpb on
// Desktop restart, but we had no easy way to confirm new vs old code
// was loaded — this line closes that gap.
const BRIDGE_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"))
    return String(pkg.version ?? "unknown")
  } catch {
    return "unknown"
  }
})()
console.error(
  `[pixel-bridge] boot v${BRIDGE_VERSION} pid=${process.pid} started=${new Date().toISOString()}`,
)

const store = new OfficeStore()
// Despawn-only cleanup. Per BEHAVIOR_SPEC §2 there is ONE threshold per
// character class (idle/wander is event-driven, not a separate timer):
//   - sub-agent: 30s of silence → despawn
//   - main:      60s of silence → despawn
// These values are spec-fixed. Earlier code repeatedly drifted them
// (15s/30s, 5min/10min, …) which caused regression after regression —
// see BEHAVIOR_SPEC §"자주 틀리는 지점". Do not change without updating
// the spec and getting user sign-off.
store.startStaleSweeper({
  subDespawnMs: DESPAWN_SUB_MS,
  mainDespawnMs: DESPAWN_MAIN_MS,
  intervalMs: SWEEPER_INTERVAL_MS,
})

// Auto-reset HUD token bars after the Anthropic 5-hour quota window
// has lapsed with no token growth. Without this, the HP bar stays
// pegged at "85%" forever after a long conversation ends, even though
// the next session starts fresh. `lastTokenGrowthAt` is bumped from
// every channel that grows contextTokens — JSONL watcher, office_open,
// office_status. Plain setInterval, no API calls, zero token cost.
let lastTokenGrowthAt = Date.now()
const QUOTA_WINDOW_MS =
  (parseInt(process.env["PIXEL_OFFICE_QUOTA_WINDOW_MIN"] ?? "", 10) || 300) * 60_000
const LIMIT_CHECK_INTERVAL_MS =
  (parseInt(process.env["PIXEL_OFFICE_LIMIT_TICK_MIN"] ?? "", 10) || 1) * 60_000

export function bumpTokenGrowth(): void {
  lastTokenGrowthAt = Date.now()
}

function autoLimitCheck(): void {
  const idleFor = Date.now() - lastTokenGrowthAt
  if (idleFor < QUOTA_WINDOW_MS) return
  let cleared = 0
  for (const rec of store.list()) {
    const ctx = rec.contextTokens ?? 0
    if (ctx > 0) {
      store.updateUsage(rec.id, 0, rec.model)
      cleared++
    }
  }
  if (cleared > 0) {
    console.error(
      `[pixel-bridge] auto-reset after ${(idleFor / 3_600_000).toFixed(1)}h idle (cleared ${cleared})`,
    )
    lastTokenGrowthAt = Date.now()
  }
}

const limitTimer = setInterval(autoLimitCheck, LIMIT_CHECK_INTERVAL_MS)
limitTimer.unref?.()
console.error(
  `[pixel-bridge] auto-limit: tick=${LIMIT_CHECK_INTERVAL_MS / 60_000}min, quota-window=${QUOTA_WINDOW_MS / 3_600_000}h`,
)

// Auto-detect Claude Desktop tool activity via its log file (~/Library/
// Logs/Claude/claude.ai-web.log on macOS). Gives us CLI-style parity
// for regular chat: the office reacts to ANY tool Claude calls, not
// just our office_* helpers. No-op when the log isn't found.
startDesktopLogWatcher(store)

// In addition, watch the audit.jsonl files Claude Desktop writes for
// "local agent mode" sessions (scheduled tasks, autonomous Skills, …).
// Those files match the CLI JSONL format — when present, we get real
// Task-spawn / sub-agent / turn-duration signals, no heuristics needed.
// No-op for users who never run agent-mode workflows.
startAuditJsonlWatcher(store)

// Also watch ~/.claude/projects/<hash>/<uuid>.jsonl. Modern Claude
// Desktop delegates tool execution to a Claude Code subprocess for
// many features (Skills, project mode, the new Code-tab work, etc.)
// — those tool calls bypass `claude.ai-web.log` entirely and write
// only to the CLI-style JSONL. Without this watcher, "I ran 3 bash
// commands in Desktop" produces no widget characters because the
// log channel never sees the events. This watcher is also what the
// IntelliJ plugin uses, but read-only tailing is contention-free.
startProjectsJsonlWatcher(store)

// Instant approval-bubble signal: Claude Desktop writes "Emitted tool
// permission request …" the moment its UI shows the approval prompt,
// and "Received permission response …" when the user clicks
// Allow/Deny. Tailing that gives us a sub-second yellow bubble for
// genuine human approvals, instead of relying on the 30s JSONL
// fallback (which never fires for typical "click Allow within a few
// seconds" workflows). The fallback stays in place for hosts that
// don't write this log.
startMainLogWatcher(store)

// Rolling 5h token-usage indicator — sums assistant-turn `message.usage`
// entries inside the last 5 hours across every ~/.claude/projects
// session, divided by the configured plan budget. Fires once on boot
// so the HUD has a value immediately, then re-samples on a 60s tick.
function pushQuota(): void {
  const w = calculateQuotaWindow()
  store.setQuotaWindow(w.tokensUsed, w.budget, w.pct)
}
pushQuota()
const quotaTimer = setInterval(pushQuota, QUOTA_TICK_MS)
quotaTimer.unref?.()

let server: Awaited<ReturnType<typeof startOfficeServer>> | null = null

async function ensureServer(): Promise<typeof server> {
  if (server) return server
  server = await startOfficeServer(store)
  console.error(`[pixel-bridge] viewer listening on ${server.url}`)
  return server
}

/** Resolved widget window placement. Defaults come from manual tuning on
 *  the user's primary display; any axis can be overridden via env vars
 *  for users on different screen layouts or those who want a custom
 *  spot. Defaults: 830×630 at (196, 773). */
function widgetPlacement(): { width: number; height: number; x: number; y: number } {
  const intEnv = (name: string, fallback: number): number => {
    const v = process.env[name]
    const n = v ? parseInt(v, 10) : NaN
    return Number.isFinite(n) ? n : fallback
  }
  return {
    width: intEnv("PIXEL_OFFICE_WIDTH", 830),
    height: intEnv("PIXEL_OFFICE_HEIGHT", 630),
    x: intEnv("PIXEL_OFFICE_X", 196),
    y: intEnv("PIXEL_OFFICE_Y", 773),
  }
}

const TOOLS: Tool[] = [
  {
    name: "office_open",
    description:
      "Pixel Office 위젯 창을 엽니다 / Opens the Pixel Office widget window. " +
      "한국어 트리거: '픽셀 오피스 열어줘', '오피스 보여줘', '캐릭터 띄워줘', '에이전트 켜줘'. " +
      "English triggers: 'open the pixel office', 'show the widget', 'launch the agents'. " +
      "사용자가 위 의도를 보이면 즉시 호출. 파일/메모리/셸 탐색 금지. " +
      "Chrome/Edge/Brave --app 모드로 chrome-less 윈도우 spawn (없으면 일반 탭 fallback). " +
      "Safe to call multiple times — 중복 호출 시 기존 윈도우 re-focus. " +
      "HUD 토큰 바는 ~/.claude/projects JSONL의 `message.usage`(API 실측치)에서 자동으로 채워지므로 contextPercent는 보낼 필요 없습니다 — Claude의 자체 추정은 ±수% 오차가 있어 JSONL ground truth와 어긋납니다.",
    inputSchema: {
      type: "object",
      properties: {
        skipBrowserLaunch: {
          type: "boolean",
          description:
            "If true, return the URL but don't try to open a browser. Useful when the user just wants the address for a phone or a different machine.",
        },
        regularTab: {
          type: "boolean",
          description:
            "If true, open in the user's default browser as a regular tab instead of a frameless widget window. Default false.",
        },
        contextPercent: {
          type: "number",
          description:
            "OPTIONAL bootstrap-only estimate of your context-window usage 0-100. The server already auto-fills the HUD from ~/.claude/projects JSONL `message.usage` (the real API-reported token count) on every assistant turn — that data is ground truth. This argument is only used as a fallback BEFORE the first JSONL turn lands; once authoritative tokens have been received, your estimate here is IGNORED to prevent ±%-error guesses from clobbering real values. In Claude Code (where JSONL is always available), you can omit this entirely.",
        },
      },
    },
  },
  {
    name: "office_status",
    description:
      "Legacy/fallback self-report for context-window usage. The HUD is populated automatically from ~/.claude/projects JSONL `message.usage` (real API token counts) on every assistant turn, so you normally do NOT need to call this. The server will IGNORE this call if a recent JSONL-derived value exists (because the JSONL count is ground truth and your estimate has ±%-error). Only useful in environments without JSONL access (some Claude Desktop modes) or before the first assistant turn has been written to disk.",
    inputSchema: {
      type: "object",
      properties: {
        contextPercent: {
          type: "number",
          description: "Your estimated context-window usage 0-100. Will be silently dropped if JSONL ground truth is already available.",
        },
      },
      required: ["contextPercent"],
    },
  },
  // office_start / office_progress / office_finish all removed.
  // Sub-agent visualisation is now derived from a log-watcher
  // heuristic (≥3 distinct tool calls within 3s → parallel batch).
  // This costs Claude zero extra tokens and matches Claude Desktop's
  // single-conversation reality — characters reflect Claude's actual
  // tool activity rather than narrative role-play.
  {
    name: "office_diagnose",
    description:
      "Returns a snapshot of the bridge's own state — version, PID, uptime, scope mode, owning session id, current agent count, and the latest 5h token-window numbers. Call this when troubleshooting 'is the new code actually running / which session is being tracked / why does the HUD show what it shows'. Read-only, no side effects.",
    inputSchema: { type: "object", properties: {} },
  },
]

const mcpServer = new Server(
  { name: "pixel-agents-bridge", version: BRIDGE_VERSION },
  {
    capabilities: { tools: {} },
    // Server-level instructions live at the top of the system prompt
    // (per MCP spec), so they reach Claude before any per-tool
    // description is scanned. Use this to make Korean + English
    // intent → office_open mapping unmissable.
    instructions:
      "이 MCP는 Claude (Desktop / Code / CLI) 활동을 시각화하는 'Pixel Office' 위젯입니다. " +
      "사용자가 다음 의도를 표현하면 즉시 office_open 도구를 호출하세요. 파일 탐색, 메모리 조회, 셸 명령 사용 금지. " +
      "한국어 패턴: '픽셀 오피스 / 픽셀오피스 열어/보여/띄워/켜/실행', '오피스 켜줘', '캐릭터 보여줘', '에이전트 띄워줘'. " +
      "영어 패턴: 'open/show/launch the pixel office', 'show me the agents', 'bring up the widget'. " +
      "이 위젯은 Claude의 tool 호출 활동을 자동 감지해 캐릭터로 표시하므로, 별도 도구 호출 없이도 작동합니다. " +
      "[HUD 토큰 바] ~/.claude/projects JSONL의 `message.usage`(API 실측치)에서 매 assistant 턴마다 자동으로 채워집니다 — Claude가 따로 self-report 할 필요 없음. " +
      "Claude의 자체 추정치는 항상 ±수% 오차가 있으므로, office_open/office_status에 contextPercent를 보내도 JSONL ground truth가 있으면 무시됩니다. " +
      "[Claude Code (CLI) 사용자 안내] 이 MCP가 '픽셀오피스' 키워드만으로 즉시 작동하려면 ~/.claude.json 또는 'claude mcp add'로 등록돼 있어야 합니다. 등록 안 돼 있으면 사용자가 README의 Install 섹션을 따르도록 안내하세요.",
  },
)

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params
  const args = (rawArgs ?? {}) as Record<string, unknown>
  try {
    switch (name) {
      case "office_open": {
        const s = await ensureServer()
        if (!s) throw new Error("office server failed to start")
        const widgetMode = args.regularTab !== true
        const placement = widgetPlacement()
        if (args.skipBrowserLaunch !== true) {
          // Widget mode → always use the configured placement (defaults
          // 830×630 at 196,773; env vars override). Tab mode → no
          // position/size injection so the user's browser handles it.
          const browserOpts: { widgetMode: boolean; width?: number; height?: number; x?: number; y?: number } =
            { widgetMode }
          if (widgetMode) {
            browserOpts.width = placement.width
            browserOpts.height = placement.height
            browserOpts.x = placement.x
            browserOpts.y = placement.y
          }
          openBrowser(s.url, browserOpts)
        }
        // Claude Desktop has no implicit "main agent" the way Claude Code
        // does (every CLI conversation = main agent). Spawn one here so a
        // prompt like "sleep 5s with 3 agents" shows main + 3 subs rather
        // than just the 3 sub-tasks Claude explicitly called office_start
        // for.
        if (!store.list().some((r) => r.id === "main")) {
          const now = Date.now()
          store.upsert({
            id: "main",
            name: "Claude",
            // Start in idle — the stale sweeper and incoming tool
            // activity (via the log watcher) will update this. The
            // previous "thinking" sentinel made the hover tooltip
            // claim Claude was busy even on a fresh empty session.
            status: "idle",
            startedAt: now,
            updatedAt: now,
            done: false,
            idle: true,
          })
        }
        // Optional initial context-usage hint. The JSONL watcher on
        // ~/.claude/projects/ provides authoritative tokens on every
        // assistant turn (from the real `message.usage` the API
        // returned), so this self-reported number is only useful as a
        // BOOTSTRAP — when called before the first assistant turn has
        // landed in the JSONL. Once JSONL has fired we ignore it; the
        // earlier "always overwrite" path let Claude's ±%-error guess
        // clobber ground truth (e.g. UI shows 21% real but Claude
        // reports 18% estimate).
        const openContextPct = Number(args.contextPercent)
        if (Number.isFinite(openContextPct) && !store.hasRecentJsonlUsage("main")) {
          const clamped = Math.max(0, Math.min(100, openContextPct))
          const tokens = Math.round((clamped / 100) * 200_000)
          store.patch("main", { contextTokens: tokens })
          bumpTokenGrowth()
        }
        const verb =
          args.skipBrowserLaunch === true
            ? "Open it manually."
            : widgetMode
            ? `Opening it as a chrome-less widget window (${placement.width}×${placement.height} at ${placement.x},${placement.y}) now.`
            : "Opening it as a browser tab now."
        return {
          content: [
            { type: "text", text: `Pixel Office viewer is at ${s.url}. ${verb}` },
          ],
        }
      }
      case "office_status": {
        // Legacy self-report path. The JSONL watcher on
        // ~/.claude/projects/ fills `contextTokens` automatically from
        // the real `message.usage` the API returned — that's the
        // ground truth and is wired in via store.updateUsage(). The
        // self-report below is a fallback for hosts where JSONL isn't
        // available (some Claude Desktop modes) or for the brief
        // window before the first assistant turn has been written to
        // disk. If JSONL has produced an authoritative value for this
        // agent recently, we drop the self-report on the floor instead
        // of overwriting truth with an estimate.
        const pct = Number(args.contextPercent)
        if (!Number.isFinite(pct)) throw new Error("contextPercent required (0-100)")
        const clamped = Math.max(0, Math.min(100, pct))
        if (store.hasRecentJsonlUsage("main")) {
          return {
            content: [{
              type: "text",
              text: `Self-report ignored (${clamped.toFixed(0)}%): JSONL provides authoritative usage. The HUD already reflects the real token count from the API; you don't need to estimate.`,
            }],
          }
        }
        // 200k context window — match webview's CONTEXT_WINDOW_LIMIT.
        const tokens = Math.round((clamped / 100) * 200_000)
        const existing = store.list().find((r) => r.id === "main")
        if (!existing) {
          const now = Date.now()
          store.upsert({
            id: "main", name: "Claude",
            status: "thinking", startedAt: now, updatedAt: now, done: false,
          })
        }
        store.patch("main", { contextTokens: tokens })
        bumpTokenGrowth()
        return {
          content: [{ type: "text", text: `Context usage (self-report) set to ${clamped.toFixed(0)}% (${tokens} tokens). Will be replaced by JSONL ground truth on the next assistant turn.` }],
        }
      }
      case "office_diagnose": {
        // Self-check snapshot. Lets a troubleshooting agent confirm
        // which code is actually running, what scope mode it's in,
        // who owns the session, how many characters are alive, and
        // the latest quota numbers — all in one call. Read-only.
        const q = calculateQuotaWindow()
        const agents = store.list()
        const snapshot = {
          version: BRIDGE_VERSION,
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          bootedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          bridgeMode: BRIDGE_MODE.kind,
          ownSessionId: OWN_SESSION_ID,
          agentCount: agents.length,
          agents: agents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            idle: a.idle === true,
            isExternal: a.isExternal === true,
            parentId: a.parentId ?? null,
            contextTokens: a.contextTokens ?? null,
            model: a.model ?? null,
          })),
          quotaWindow: {
            tokensUsed5h: q.tokensUsed,
            budget: q.budget,
            pct: Number(q.pct.toFixed(2)),
          },
        }
        return {
          content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        }
      }
      // office_start / office_progress / office_finish all removed
      // — sub-agent visualisation now comes from the log watcher's
      // parallel-batch heuristic, costing Claude zero extra tokens.
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await mcpServer.connect(transport)
console.error("[pixel-bridge] MCP server connected. Call office_open to launch the viewer.")
