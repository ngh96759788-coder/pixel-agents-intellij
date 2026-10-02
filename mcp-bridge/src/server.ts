/**
 * Tiny HTTP + WebSocket server bundled into the MCP bridge.
 * Serves the pixel-office viewer (single static HTML page) on /office and
 * broadcasts office state changes over /ws so the browser tab can animate
 * characters in real time while Claude Desktop drives them via tool calls.
 *
 * The server is started lazily by the `office_open` MCP tool and lives for
 * the rest of the Claude Desktop session. Subsequent `office_open` calls
 * just re-open the same URL — they don't double-boot the listener.
 *
 * No external HTTP framework — `http` + `ws` only — to keep the .mcpb
 * bundle small and dependency-free.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import { spawn, execSync } from "node:child_process"
import { existsSync, readFileSync, statSync, rmSync } from "node:fs"
import { join, dirname, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { platform } from "node:os"
import type { OfficeStore, AgentRecord } from "./office.js"
import { loadAssetsForTheme, detectTheme, type LoadedAssets } from "./assetLoader.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface OfficeServer {
  port: number
  url: string
  /** Loaded layout dimensions (tiles), used by office_open to size the
   *  widget window to match the office canvas. Either may be null if
   *  the layout couldn't be parsed. */
  layoutCols: number | null
  layoutRows: number | null
  stop: () => Promise<void>
}

/** Process-wide "unified view" toggle state shared by every connected
 *  WebSocket client. `enabled` is the current flag (BEHAVIOR_SPEC §4,
 *  default false). `clients` holds one callback per live socket; a
 *  `setUnifiedView` message from any tab flips `enabled` then invokes
 *  every callback so each client re-materialises or tears down its own
 *  external-source characters. */
interface UnifiedViewHub {
  enabled: boolean
  clients: Set<(enabled: boolean) => void>
}

/** Start the HTTP + WS server on the first available port at or above
 *  `preferredPort`. Resolves once the listener is bound and the URL is
 *  reachable. */
export async function startOfficeServer(
  store: OfficeStore,
  preferredPort = 7456,
): Promise<OfficeServer> {
  const webRoot = locateWebRoot()
  // Theme + sprites + layout are all process-lifetime constants; parse the
  // PNGs once at boot so reconnects don't repeat the work.
  const theme = detectTheme()
  const assets = loadAssetsForTheme(webRoot, theme)
  const iconFlags = [
    assets.identityMain && "main", assets.identitySub && "sub",
    assets.statusActive && "active", assets.statusWait && "wait", assets.statusIdle && "idle",
  ].filter(Boolean).join("+") || "none"
  console.error(
    `[pixel-bridge] loaded theme=${assets.theme} chars=${assets.characters.length} ` +
    `floors=${assets.floors.length} walls=${assets.walls.length} ` +
    `furniture=${Object.keys(assets.furnitureSprites).length} ` +
    `icons=${iconFlags} ` +
    `layout=${assets.layout ? "yes" : "no"}`,
  )

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res, webRoot)
  })

  // Bind the listener BEFORE attaching the WebSocketServer. If we wire
  // WSS up first and httpServer.listen fails with EADDRINUSE during the
  // port-fallback loop, WSS re-emits the error with no handler and
  // crashes the whole process.
  const port = await listenWithFallback(httpServer, preferredPort)
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" })
  wss.on("error", (err) => console.error("[pixel-bridge] wss error:", err))
  // Shared "unified view" (통합 보기, BEHAVIOR_SPEC §4) state. In-memory
  // only — default OFF ("내 작업만 보기"), not persisted across bridge
  // restarts. The flag is process-wide so a toggle from one browser tab
  // takes effect on every connected tab; each client registers a
  // callback that replays/closes the external-source characters for its
  // own id mapping when the flag flips.
  const unifiedView: UnifiedViewHub = { enabled: false, clients: new Set() }
  wss.on("connection", (socket) => attachWsClient(socket, store, assets, unifiedView))

  const url = `http://localhost:${port}/`

  return {
    port,
    url,
    layoutCols: assets.layoutCols,
    layoutRows: assets.layoutRows,
    stop: () =>
      new Promise<void>((resolve) => {
        wss.close()
        httpServer.close(() => resolve())
      }),
  }
}

/** Cross-platform browser launcher. When `widgetMode` is true (the default
 *  for office_open), we try the user's local Chromium-family browser in
 *  `--app=URL` mode so the office shows up as a chrome-less window
 *  instead of a regular tab — that's the closest "widget" feel we can
 *  give without bundling Electron/Tauri. Falls back to the OS default
 *  browser if no Chromium is found. */
export function openBrowser(
  url: string,
  opts: { widgetMode?: boolean; width?: number; height?: number; x?: number; y?: number } = {},
): void {
  const widgetMode = opts.widgetMode ?? true
  if (widgetMode) {
    const launched = tryAppMode(url, opts.width ?? 830, opts.height ?? 630, opts.x, opts.y)
    if (launched) return
  }
  openWithSystemHandler(url)
}

/** Try to launch a Chromium-family browser in --app mode for the widget
 *  experience. Returns true if a spawn was attempted, false if no
 *  candidate browser was found on disk. */
function tryAppMode(
  url: string,
  width: number,
  height: number,
  x: number | undefined,
  y: number | undefined,
): boolean {
  // Chrome --app mode reuses any existing instance for the same
  // user-data-dir AND persists window geometry there, so a stale
  // running widget will ignore `--window-size`. Kill any running
  // process matching our profile path, then wipe the cached state
  // files so the new size/position take effect on relaunch.
  const dir = userDataDir()
  try {
    // pgrep on macOS/Linux. Match anything with our user-data-dir
    // value in argv so this only hits OUR widget instance, not the
    // user's main Chrome. (macOS xargs lacks -r, so parse pids in
    // Node and SIGKILL each via process.kill.)
    const out = execSync(`pgrep -f ${JSON.stringify("user-data-dir=" + dir)}`,
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 2000 })
    for (const line of out.split("\n")) {
      const pid = parseInt(line.trim(), 10)
      if (!Number.isFinite(pid)) continue
      try { process.kill(pid, "SIGKILL") } catch { /* gone already */ }
    }
  } catch { /* pgrep returns 1 when no matches — that's fine */ }
  try {
    rmSync(join(dir, "Default", "Preferences"), { force: true })
    rmSync(join(dir, "Local State"), { force: true })
  } catch { /* fresh profile is fine */ }

  const candidates = chromeAppCandidates()
  for (const cmd of candidates) {
    try {
      const args = [
        `--app=${url}`,
        `--window-size=${width},${height}`,
        // Isolate the widget profile so it doesn't interfere with the
        // user's main Chrome session (cookies, extensions, etc).
        `--user-data-dir=${userDataDir()}`,
        "--no-first-run",
        "--no-default-browser-check",
        // Suppress Chrome's Google Translate offer that kept popping a
        // language-detection banner over the office widget. Also kills
        // a few other noisy default features that aren't useful for a
        // single-page chrome-less canvas.
        "--disable-features=Translate,TranslateUI,LanguageDetection,DialogScrollback",
        "--disable-translate",
        "--disable-extensions",
        "--no-pings",
      ]
      if (x != null && y != null) {
        args.push(`--window-position=${x},${y}`)
      }
      spawn(cmd, args, { detached: true, stdio: "ignore" }).unref()
      return true
    } catch {
      // Keep trying the next candidate.
    }
  }
  return false
}

function chromeAppCandidates(): string[] {
  const p = platform()
  if (p === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Arc.app/Contents/MacOS/Arc",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ].filter(existsSync)
  }
  if (p === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files"
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
    return [
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ].filter(existsSync)
  }
  // Linux — rely on PATH so we don't try to guess every distro's layout.
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]
}

function userDataDir(): string {
  const p = platform()
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "."
  if (p === "darwin") return join(home, "Library", "Application Support", "pixel-office-widget")
  if (p === "win32") return join(home, "AppData", "Local", "pixel-office-widget")
  return join(home, ".pixel-office-widget")
}

function openWithSystemHandler(url: string): void {
  const p = platform()
  const cmd = p === "darwin" ? "open" : p === "win32" ? "start" : "xdg-open"
  const args = p === "win32" ? ["", url] : [url]
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref()
  } catch (err) {
    // Don't crash the MCP server if the helper isn't available; the user
    // can always copy the URL manually from the tool result text.
    console.error("[pixel-bridge] failed to open browser:", err)
  }
}

/** Resolve the directory holding the built React webview (`dist/webview/`
 *  output of the parent project's Vite build, copied into `web/` by the
 *  bridge's pack script). Falls back to the previous minimal viewer
 *  location if the full bundle isn't packaged yet. */
function locateWebRoot(): string {
  const candidates = [
    join(__dirname, "..", "web"),
    join(__dirname, "..", "..", "web"),
  ]
  for (const p of candidates) {
    try {
      if (statSync(p).isDirectory()) return p
    } catch { /* keep trying */ }
  }
  return candidates[0]
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}
function mimeFor(path: string): string {
  const i = path.lastIndexOf(".")
  return i < 0 ? "application/octet-stream" : MIME_TYPES[path.slice(i).toLowerCase()] ?? "application/octet-stream"
}

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  webRoot: string,
): void {
  // CSP loose enough for the React app's inline styles + WS connection,
  // strict enough to block remote scripts.
  res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self' ws: wss:")
  res.setHeader("X-Content-Type-Options", "nosniff")

  if (req.method === "GET" && req.url === "/healthz") {
    res.end("ok")
    return
  }

  // Map URL → file under webRoot. Path traversal defended by normalize +
  // startsWith check.
  let urlPath = (req.url ?? "/").split("?")[0]
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html"
  const candidate = normalize(join(webRoot, urlPath))
  if (!candidate.startsWith(webRoot)) {
    res.statusCode = 403
    res.end("forbidden")
    return
  }

  if (!existsSync(candidate)) {
    res.statusCode = 404
    res.end("not found")
    return
  }
  try {
    const body = readFileSync(candidate)
    res.setHeader("Content-Type", mimeFor(candidate))
    res.end(body)
  } catch (err) {
    res.statusCode = 500
    res.end("read error")
    console.error("[pixel-bridge] static read error", err)
  }
}

/** When a fresh browser tab connects, replay the messages the React app
 *  expects on boot (the same set the IntelliJ Kotlin bridge sends in
 *  `onWebviewReady`). Then map every subsequent OfficeStore change into
 *  the matching webview message so the canvas animates as if the agents
 *  had been running there all along. */
function attachWsClient(
  socket: WebSocket,
  store: OfficeStore,
  assets: LoadedAssets,
  unifiedView: UnifiedViewHub,
): void {
  const send = (type: string, payload: Record<string, unknown> = {}) => {
    try { socket.send(JSON.stringify({ type, ...payload })) } catch { /* socket closing */ }
  }

  // Per-agent state we need to remember to translate OfficeEvent → webview
  // contract. `webviewIds` maps the bridge's string agentId to the
  // positive integer the React canvas expects everywhere. `toolIds`
  // remembers the synthetic toolId we last emitted per agent so we can
  // send a matching `agentToolDone` before opening a new one on
  // progress. `idleState` tracks the last-known idle flag we propagated
  // so we can detect active↔idle transitions when the stale sweeper
  // flips an agent without Claude calling office_progress.
  const webviewIds = new Map<string, number>()
  const toolIds = new Map<number, string>()
  const idleState = new Map<number, boolean>()
  // Per-sub-agent translation state. `office_start` records carry
  // `parentId: "main"` so they materialise on the webview as Subtask
  // tools on the parent — that triggers the webview's sub-character
  // spawn flow (SUB identity badge, smaller character nested under
  // the parent) instead of yet another standalone main-style worker.
  const subState = new Map<string, {
    parentWebviewId: number
    parentToolId: string
    subToolId: string | null
  }>()
  let nextId = 1
  let nextToolSeq = 1

  function ensureAgentId(rec: AgentRecord): number {
    const existing = webviewIds.get(rec.id)
    if (existing != null) return existing
    const id = nextId++
    webviewIds.set(rec.id, id)
    send("agentCreated", {
      id,
      // Forward the per-record external flag (BEHAVIOR_SPEC §4) so the
      // webview can fade non-own characters to 85% opacity and the
      // integrated-view toggle can filter them out.
      isExternal: rec.isExternal === true,
      displayName: rec.name,
    })
    // Reset the hover popup's token count so it shows 0/x instead of
    // last-session's leftover number while we wait for the first
    // assistant turn. We deliberately omit `model` here — emitting the
    // generic "claude-desktop" fallback caused the HUD chip to flash
    // "DES" / "DES 0%" for a second or two before the real model
    // ("OPUS 4.7" etc.) gets resolved from JSONL. The webview's chip
    // is keyed on a non-empty model string, so leaving it undefined
    // simply hides the chip until we know what to render.
    send("agentUsage", { id, contextTokens: 0 })
    return id
  }

  function emitTool(id: number, status: string): void {
    const prev = toolIds.get(id)
    if (prev) send("agentToolDone", { id, toolId: prev })
    const toolId = `desktop-${nextToolSeq++}`
    toolIds.set(id, toolId)
    send("agentToolStart", { id, toolId, status })
  }

  function handleSubUpsert(rec: AgentRecord): void {
    if (!rec.parentId) return
    const parentRec = store.list().find((r) => r.id === rec.parentId)
    if (!parentRec) return
    const parentWebviewId = ensureAgentId(parentRec)
    let state = subState.get(rec.id)
    if (!state) {
      // First time we see this sub — emit a Subtask tool on the parent
      // which causes the webview to spawn a sub-character (SUB badge,
      // child of parent's position).
      const parentToolId = `subtask-${nextToolSeq++}`
      state = { parentWebviewId, parentToolId, subToolId: null }
      subState.set(rec.id, state)
      send("agentToolStart", {
        id: parentWebviewId,
        toolId: parentToolId,
        status: `Subtask: ${rec.name}: ${rec.status}`,
      })
    }
    if (rec.done || rec.idle) {
      if (state.subToolId) {
        send("subagentToolDone", {
          id: parentWebviewId,
          parentToolId: state.parentToolId,
          toolId: state.subToolId,
        })
        state.subToolId = null
      }
      return
    }
    // Active path — emit a fresh sub-tool. The webview animates the
    // sub character based on the tool name (typing vs reading).
    if (state.subToolId) {
      send("subagentToolDone", {
        id: parentWebviewId,
        parentToolId: state.parentToolId,
        toolId: state.subToolId,
      })
    }
    const subToolId = `subtask-tool-${nextToolSeq++}`
    state.subToolId = subToolId
    send("subagentToolStart", {
      id: parentWebviewId,
      parentToolId: state.parentToolId,
      toolId: subToolId,
      status: rec.status,
    })
  }

  function handleSubRemove(recId: string): void {
    const state = subState.get(recId)
    if (!state) return
    if (state.subToolId) {
      send("subagentToolDone", {
        id: state.parentWebviewId,
        parentToolId: state.parentToolId,
        toolId: state.subToolId,
      })
    }
    // Close the parent's Subtask tool. The webview's subagentClear
    // handler tears down the sub character on this signal.
    send("subagentClear", {
      id: state.parentWebviewId,
      parentToolId: state.parentToolId,
    })
    send("agentToolDone", {
      id: state.parentWebviewId,
      toolId: state.parentToolId,
    })
    subState.delete(recId)
  }

  // 1. Bootstrap — match the IntelliJ panel's `onWebviewReady` payloads.
  //    `bridgeMode: true` tells the webview to hide IDE-only affordances
  //    (e.g. + Agent, since Claude Desktop can't spawn IDE terminals).
  //    `topOffset` adds vertical breathing room so the office canvas
  //    isn't flush with the window top (overridable via env var).
  const topOffsetEnv = process.env["PIXEL_OFFICE_TOP_OFFSET"]
  const topOffset = topOffsetEnv ? parseInt(topOffsetEnv, 10) : 15
  send("settingsLoaded", {
    soundEnabled: false,
    theme: assets.theme,
    bridgeMode: true,
    topOffset: Number.isFinite(topOffset) ? topOffset : 15,
    alwaysShowIdentityDot: false,
    alwaysShowTokenBar: false,
    alwaysShowStatus: false,
    alwaysShowTether: false,
    // Current unified-view (통합 보기, BEHAVIOR_SPEC §4) flag so the
    // webview's Settings toggle boots in sync with the backend. When
    // this is true the external-source characters the boot replay
    // below emits (isExternal:true) are rendered at 85% opacity; when
    // false the webview drops them and waits for a setUnifiedView →
    // agentCreated replay to resurrect them.
    unifiedView: unifiedView.enabled,
  })
  // Stream the pre-parsed PNG sprites in the same order the IntelliJ
  // Kotlin bridge uses so the webview's load-order assumptions hold.
  if (assets.characters.length > 0) {
    send("characterSpritesLoaded", { characters: assets.characters, theme: assets.theme })
  }
  if (assets.floors.length > 0) {
    send("floorTilesLoaded", { sprites: assets.floors })
  }
  if (assets.walls.length > 0) {
    send("wallTilesLoaded", { sprites: assets.walls })
  }
  if (assets.furnitureCatalog.length > 0) {
    send("furnitureAssetsLoaded", { catalog: assets.furnitureCatalog, sprites: assets.furnitureSprites })
  }
  // Pre-baked head-overlay badge sprites (chaicon, MIT). The renderer
  // falls back to its own pixel masks for any slot left null so older
  // bundles still render something.
  if (assets.identityMain || assets.identitySub || assets.statusActive || assets.statusWait || assets.statusIdle) {
    send("headIconsLoaded", {
      identityMain: assets.identityMain,
      identitySub: assets.identitySub,
      statusActive: assets.statusActive,
      statusWait: assets.statusWait,
      statusIdle: assets.statusIdle,
      frame: assets.frame,
    })
  }
  // If user has a saved ~/.pixel-agents/layout.json we use it; otherwise
  // fall back to the themed bundled default. Either way the webview
  // doesn't have to fabricate a layout from scratch.
  send("layoutLoaded", { layout: assets.layout })
  // Replay a top-level agent's current active/finished/idle state to the
  // webview. Shared by the initial-connection replay (below) and the
  // unified-view toggle handler (which resurrects external characters).
  // A webview that reconnects mid-session — or that just flipped the
  // unified-view toggle ON — needs to know whether each agent is
  // currently active, finished, or wandering idle. Without this
  // branching, idle-marked agents would arrive looking active (orange
  // icon) until the next sweeper tick or new tool_use ticked their state.
  function replayTopLevelState(rec: AgentRecord, id: number): void {
    if (rec.done) {
      send("agentStatus", { id, status: "waiting" })
    } else if (rec.idle === true) {
      send("agentStatus", { id, status: "idle" })
      idleState.set(id, true)
    } else {
      emitTool(id, rec.status)
    }
  }

  // Replay any agents that were already alive before this tab connected.
  const existing = store.list()
  for (const rec of existing) {
    if (rec.parentId) {
      handleSubUpsert(rec)
      continue
    }
    const id = ensureAgentId(rec)
    replayTopLevelState(rec, id)
  }
  send("existingAgents", {
    agents: Array.from(webviewIds.values()).sort((a, b) => a - b),
    agentMeta: {},
    externalIds: [],
    displayNames: Object.fromEntries(
      Array.from(webviewIds.entries()).map(([raw, num]) => {
        const rec = existing.find((r) => r.id === raw)
        return [String(num), rec?.name ?? "desktop"]
      }),
    ),
  })

  // Helper used by both the upsert branch (initial / changed status)
  // and the usage-only branch (assistant turn produced fresh token
  // counts without state change). Centralised so the HUD payload stays
  // consistent across both flows.
  //
  // We OMIT `model` from the payload when it hasn't been resolved yet.
  // The previous behaviour emitted `model: "claude-desktop"` as a
  // sentinel, which the webview's `modelChip()` rendered as a "DES"
  // chip — i.e. a ghost chip would appear next to the real model
  // whenever self-report (office_open / office_status) wrote
  // contextTokens before a JSONL turn could supply the real model id.
  // Matches the `ensureAgentId` payload (which already deliberately
  // omits `model`); the webview's agentUsage handler ignores empty
  // model strings so the chip simply stays hidden until ground truth
  // arrives.
  const sendUsage = (id: number, contextTokens: number, model?: string): void => {
    const payload: Record<string, unknown> = {
      id,
      contextTokens,
      // Bottom HUD reads cumulative totals; we only know the
      // overall context usage so park it all under "input" (the
      // dominant bucket for self-reported context anyway).
      cumulativeInput: contextTokens,
      cumulativeCacheCreate: 0,
      cumulativeCacheRead: 0,
      cumulativeOutput: 0,
    }
    if (model) payload.model = model
    send("agentUsage", payload)
  }

  // 2. Subscribe — translate every state change into the webview contract.
  const unsubscribe = store.subscribe((evt) => {
    if (evt.type === "snapshot") {
      // Subscribe sends snapshot first; we already replayed manually above,
      // so just ignore this one to avoid double-emitting agentCreated.
      return
    }
    if (evt.type === "usage") {
      // Usage-only update from a JSONL watcher — forward the new
      // token count to the HUD without touching tool animations or
      // the agent's active/idle state. The agent must already exist
      // (we don't create it here); if the upsert hasn't arrived yet
      // the next one will carry the same contextTokens.
      const rec = evt.agent
      if (rec.parentId) return // HUD belongs to top-level agents only
      const id = webviewIds.get(rec.id)
      if (id == null) return
      if (typeof rec.contextTokens === "number") sendUsage(id, rec.contextTokens, rec.model)
      return
    }
    if (evt.type === "permission") {
      // Permission-pending transition from a JSONL watcher — flip the
      // yellow approval bubble on the matching webview character.
      // Per-character (not per-tool) because the JSONL signal is "this
      // session has an outstanding tool_use older than the approval
      // threshold" rather than "this specific toolId timed out"; the
      // webview tags the agent's most recent active tool with the wait
      // flag, which is the visual we want.
      const rec = evt.agent
      if (rec.parentId) return // sub-agent permissions ride on parent's flow
      const id = webviewIds.get(rec.id)
      if (id == null) return
      if (rec.permissionPending) send("agentToolPermission", { id })
      else send("agentToolPermissionClear", { id })
      return
    }
    if (evt.type === "upsert") {
      const rec = evt.agent
      // Sub-agent path — diverts to Subtask-on-parent flow.
      if (rec.parentId) {
        handleSubUpsert(rec)
        return
      }
      const id = ensureAgentId(rec)
      // Propagate context usage (whether self-reported via office_status
      // or auto-filled by a JSONL watcher) so the webview HP bar AND
      // the bottom HUD fill up. Stays attached even when the sweeper
      // flips the agent to idle (that's just animation state).
      if (typeof rec.contextTokens === "number") sendUsage(id, rec.contextTokens, rec.model)
      if (rec.done) {
        // Match the IntelliJ flow: close out the active tool, mark
        // the turn as waiting, then despawn after the office's own
        // idle animation has had time to play.
        const prev = toolIds.get(id)
        if (prev) send("agentToolDone", { id, toolId: prev })
        send("agentStatus", { id, status: "waiting" })
        toolIds.delete(id)
        idleState.delete(id)
        return
      }
      // Stale-sweeper / turn-end transition: agent went silent → flip
      // to idle so the webview character drops out of work motion and
      // starts wandering. Mirror the IntelliJ plugin's behaviour and
      // emit `agentStatus: "waiting"` too — that flips the head-overlay
      // to the green "✓ Waiting" bubble so the user can tell at a
      // glance that Claude finished its turn, instead of having to
      // intuit it from the wandering animation alone.
      const wasIdle = idleState.get(id) === true
      if (rec.idle === true) {
        if (!wasIdle) {
          const prev = toolIds.get(id)
          if (prev) send("agentToolDone", { id, toolId: prev })
          send("agentStatus", { id, status: "waiting" })
          // Also flip the head icon to status-idle.png. "waiting" alone
          // triggers showWaitingBubble (green ✓) but leaves isActive
          // unchanged in some viewer paths — sending "idle" after it
          // forces agentStatuses[id]='idle' so the renderer picks the
          // pink Z sprite. Order matters: waiting bubble plays first,
          // then transitions to idle once the bubble auto-fades.
          send("agentStatus", { id, status: "idle" })
          toolIds.delete(id)
          idleState.set(id, true)
        }
        return
      }
      // Active path — either fresh activity, or idle agent that just
      // resumed because Claude called office_progress again. The
      // agentToolStart inside emitTool implicitly drops the green
      // waiting bubble; we re-emit `agentStatus: "active"` too so
      // useExtensionMessages clears its `agentStatuses[id]` map entry
      // (left over from the previous turn-end) and the BottomHUD's
      // active/idle counter updates.
      if (wasIdle) {
        idleState.set(id, false)
        send("agentStatus", { id, status: "active" })
      }
      emitTool(id, rec.status)
    } else if (evt.type === "remove") {
      // Sub-agent path — tear down the Subtask tool on the parent.
      if (subState.has(evt.id)) {
        handleSubRemove(evt.id)
        return
      }
      const id = webviewIds.get(evt.id)
      if (id == null) return
      send("agentClosed", { id })
      webviewIds.delete(evt.id)
      toolIds.delete(id)
      idleState.delete(id)
    } else if (evt.type === "quota") {
      // Rolling 5h token-usage window. Broadcast verbatim — the webview
      // HUD picks the display (bar / %).
      send("quotaWindow", {
        tokensUsed: evt.tokensUsed,
        budget: evt.budget,
        pct: evt.pct,
        rateLimit: evt.rateLimit,
      })
    }
  })

  // Unified-view (통합 보기, BEHAVIOR_SPEC §4) toggle handler for THIS
  // client. Invoked for every connected tab whenever any tab flips the
  // flag. On enable we (re)materialise every external-source character
  // for this socket's id mapping — forcing a fresh `agentCreated` even
  // when we already assigned the record an id, because while the toggle
  // was OFF the webview dropped those characters and cannot resurrect
  // them on its own. On disable we send `agentClosed` for each external
  // but keep the id mapping so a later re-enable reuses the same ids.
  // Sub-agent records (parentId set) never carry isExternal — they ride
  // on their external parent's Subtask flow — so the filter below skips
  // them and they re-materialise from their parent's next progress event.
  function applyUnifiedView(enabled: boolean): void {
    const externals = store.list().filter((r) => r.isExternal === true)
    for (const rec of externals) {
      if (rec.parentId) continue // defensive: subs ride on their parent
      if (enabled) {
        let id = webviewIds.get(rec.id)
        if (id == null) {
          // No mapping yet — ensureAgentId assigns one and emits the
          // agentCreated + zeroed usage bootstrap.
          id = ensureAgentId(rec)
        } else {
          // Already mapped but the webview dropped it while OFF; force
          // the create replay so it reappears at 85% opacity.
          send("agentCreated", { id, isExternal: true, displayName: rec.name })
          send("agentUsage", { id, contextTokens: 0 })
        }
        if (typeof rec.contextTokens === "number") sendUsage(id, rec.contextTokens, rec.model)
        replayTopLevelState(rec, id)
      } else {
        const id = webviewIds.get(rec.id)
        if (id == null) continue
        send("agentClosed", { id })
        // Retain the webviewIds entry so a re-enable resurrects the same
        // character; just clear transient per-tool/idle state.
        toolIds.delete(id)
        idleState.delete(id)
      }
    }
  }
  unifiedView.clients.add(applyUnifiedView)

  socket.on("close", () => {
    unsubscribe()
    unifiedView.clients.delete(applyUnifiedView)
  })
  socket.on("error", () => { /* swallow — store should keep working */ })

  // `webviewReady` is the signal the IntelliJ side waits for before
  // sending these messages; the React app emits it on mount. We don't
  // need to wait — our bootstrap above is unconditional — but we do
  // listen so the message protocol stays symmetric. We also accept the
  // `setUnifiedView` toggle: flip the process-wide flag then notify every
  // connected client so each replays/closes its external characters.
  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg?.type === "webviewReady") {
        // Already sent the bootstrap; nothing more to do.
      } else if (msg?.type === "setUnifiedView") {
        unifiedView.enabled = msg.enabled === true
        for (const notify of unifiedView.clients) notify(unifiedView.enabled)
      }
    } catch { /* ignore malformed inbound messages */ }
  })
}

async function listenWithFallback(
  server: http.Server,
  preferredPort: number,
): Promise<number> {
  for (let port = preferredPort; port < preferredPort + 20; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListen)
          if (err.code === "EADDRINUSE") reject(err)
          else reject(err)
        }
        const onListen = () => {
          server.off("error", onError)
          resolve()
        }
        server.once("error", onError)
        server.once("listening", onListen)
        server.listen(port, "127.0.0.1")
      })
      return port
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err
      // Otherwise iterate to the next port.
    }
  }
  throw new Error(`No free port in range ${preferredPort}-${preferredPort + 20}`)
}
