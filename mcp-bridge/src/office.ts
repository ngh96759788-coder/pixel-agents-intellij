/**
 * In-memory office state owned by the MCP server. Single source of truth
 * for every Claude Desktop work item the bridge currently knows about.
 * The HTTP/WS server reads from here on demand and pushes patches to
 * connected browser tabs as Claude calls our tools.
 *
 * Deliberately tiny — no character sprites or layout decisions live here.
 * The browser-side renderer turns the state into the actual pixel office.
 */

export interface AgentRecord {
  /** Stable id we generate at office_start and reuse on progress/finish. */
  id: string
  /** User-facing name. Defaults to "desktop" when Claude doesn't pass one. */
  name: string
  /** Current status string (what Claude says it's doing). */
  status: string
  /** ms-epoch when the character spawned. */
  startedAt: number
  /** ms-epoch of the most recent progress update — drives "last seen" UI. */
  updatedAt: number
  /** True after office_finish; the character stays in state for a short
   *  while so the browser can play its goodbye animation. */
  done: boolean
  /** True after the stale-sweeper notices no progress for `idleAfterMs`.
   *  Used by the WS layer to flip the webview character from work motion
   *  to idle wandering even though Claude never called office_finish. */
  idle?: boolean
  /** Optional one-line summary attached at office_finish time. */
  summary?: string
  /** Claude's context-window usage in tokens. Updated by JSONL
   *  watchers (auto-fill from `message.usage`) or by Claude itself
   *  via the `office_status` MCP tool. Drives the webview HP bar
   *  and the bottom HUD token count. */
  contextTokens?: number
  /** Real model id picked out of the assistant message (e.g.
   *  "claude-opus-4-7") — lets the webview pick the right context-
   *  window scale and render an accurate model chip instead of
   *  defaulting to the generic "claude-desktop" placeholder. */
  model?: string
  /** True when the agent's most recent tool_use has been outstanding
   *  for longer than the permission-detection threshold (default 5s)
   *  without a matching tool_result — i.e. Claude is paused waiting
   *  for the user to approve/deny the tool call. Drives the yellow
   *  permission bubble + status chip on the webview. Cleared as soon
   *  as the result arrives or the tool finishes. */
  permissionPending?: boolean
  /** ID of the parent agent (typically "main"). When set, the WS
   *  layer emits this record as a Subtask on the parent rather than
   *  as a standalone top-level agent — produces a sub-character with
   *  the SUB identity badge. */
  parentId?: string
  /** True when this character represents activity from OUTSIDE the
   *  bridge's "own scope" — a different terminal's CLI session, a
   *  different IntelliJ window's chat, etc. Per BEHAVIOR_SPEC §4 the
   *  webview renders these at 85% opacity to visually distinguish
   *  them from the user's own work, and the integrated-view toggle
   *  controls whether they're shown at all. */
  isExternal?: boolean
}

export type OfficeEvent =
  | { type: "snapshot"; agents: AgentRecord[] }
  | { type: "upsert"; agent: AgentRecord }
  /** Usage-only update — emitted by `updateUsage()` when the JSONL
   *  watcher learns the assistant's per-turn token counts. Carries the
   *  same record shape as `upsert` so the WS layer can route the
   *  contextTokens to the webview HUD without re-triggering the
   *  agent's current tool animation (which an `upsert` would). */
  | { type: "usage"; agent: AgentRecord }
  /** Permission-pending transition — emitted when a JSONL watcher
   *  detects that a tool_use has been outstanding for longer than the
   *  approval threshold (or that the wait has cleared). The WS layer
   *  translates this into `agentToolPermission` / `agentToolPermissionClear`
   *  messages so the webview can flip the yellow permission bubble
   *  without restarting tool animations. */
  | { type: "permission"; agent: AgentRecord }
  | { type: "remove"; id: string }
  /** Rolling 5h token-usage window — emitted from index.ts's
   *  1-minute calculateQuotaWindow tick. The WS layer broadcasts this
   *  as `quotaWindow` to the webview HUD. */
  | { type: "quota"; tokensUsed: number; budget: number; pct: number }

type Listener = (evt: OfficeEvent) => void

export interface StaleSweeperOptions {
  /** Despawn a sub-agent (parentId set) character after this many ms
   *  of silence. Per BEHAVIOR_SPEC §2: 30s. */
  subDespawnMs: number
  /** Despawn a main (top-level) character after this many ms of
   *  silence. Per BEHAVIOR_SPEC §2: 60s. */
  mainDespawnMs: number
  /** How often to scan the store for stale agents. */
  intervalMs?: number
}

export class OfficeStore {
  private agents = new Map<string, AgentRecord>()
  private listeners = new Set<Listener>()
  private sweeper: NodeJS.Timeout | null = null
  /** ms-epoch of the last JSONL-sourced usage update per agent id.
   *  JSONL `message.usage` is ground truth (it's literally what the
   *  Anthropic API returned); Claude's self-report via office_status
   *  is a guess with ±several-% error. Once JSONL has fired for an
   *  agent, we ignore self-report so guesses can't overwrite truth. */
  private lastJsonlUsageAt = new Map<string, number>()
  /** Most recent rolling-5h quota window snapshot. Cached so the
   *  WS layer can replay it on new connections instead of waiting up
   *  to a minute for the next tick. */
  private quota: { tokensUsed: number; budget: number; pct: number } = {
    tokensUsed: 0,
    budget: 0,
    pct: 0,
  }

  list(): AgentRecord[] {
    return Array.from(this.agents.values())
  }

  has(id: string): boolean {
    return this.agents.has(id)
  }

  /** True when JSONL has produced an authoritative contextTokens value
   *  for this agent within `withinMs` (default 5 min). Used by the
   *  office_open / office_status tool handlers to suppress Claude's
   *  self-report estimate once we have ground truth from the API. */
  hasRecentJsonlUsage(id: string, withinMs: number = 5 * 60_000): boolean {
    const ts = this.lastJsonlUsageAt.get(id)
    if (ts == null) return false
    return Date.now() - ts < withinMs
  }

  upsert(record: AgentRecord): void {
    this.agents.set(record.id, record)
    this.emit({ type: "upsert", agent: record })
  }

  patch(id: string, patch: Partial<AgentRecord>): AgentRecord | null {
    const existing = this.agents.get(id)
    if (!existing) return null
    // Clear `idle` on any new activity so the webview flips back to work
    // motion. Callers that explicitly want to set idle pass it in `patch`
    // and our spread above honors it.
    const next: AgentRecord = { ...existing, idle: false, ...patch, updatedAt: Date.now() }
    this.agents.set(id, next)
    this.emit({ type: "upsert", agent: next })
    return next
  }

  /** Push a new contextTokens value (and optionally the resolved
   *  model id) without touching `updatedAt` or `idle`. Usage data
   *  arrives on every assistant turn (often more frequently than
   *  tool activity), so routing it through `patch()` would fight
   *  with the stale sweeper's idle transitions and cause the WS
   *  layer to restart the active tool's animation on every update.
   *  Emits a `"usage"` event so listeners can forward the number to
   *  the webview HUD in isolation. No-op when nothing has changed. */
  updateUsage(id: string, contextTokens: number, model?: string): AgentRecord | null {
    const existing = this.agents.get(id)
    if (!existing) return null
    // Mark JSONL-sourced ground truth regardless of whether the value
    // changed — even a "still 21%" tick proves JSONL is live and lets
    // hasRecentJsonlUsage() keep blocking self-report overwrites.
    this.lastJsonlUsageAt.set(id, Date.now())
    const nextModel = model ?? existing.model
    if (existing.contextTokens === contextTokens && existing.model === nextModel) return existing
    const next: AgentRecord = { ...existing, contextTokens, model: nextModel }
    this.agents.set(id, next)
    this.emit({ type: "usage", agent: next })
    return next
  }

  /** Bump `updatedAt` on an existing agent without touching any other
   *  field and without emitting a webview event. Used by JSONL
   *  watchers as a heartbeat — any line arriving for the session
   *  (text-only turn, user message, system event) keeps the stale
   *  sweeper at bay so the character doesn't despawn during long
   *  user-composition gaps. No-op when the agent is missing (the
   *  next real event will re-upsert it). */
  touch(id: string): void {
    const existing = this.agents.get(id)
    if (!existing) return
    existing.updatedAt = Date.now()
  }

  /** Per-agent set of sources currently claiming permission-pending.
   *  Several independent detectors can race for the same yellow bubble
   *  ("mainlog" = instant signal from Claude Desktop's main.log,
   *  "jsonl" = 30s no-activity fallback, possibly more later); the
   *  bubble is on when ANY source says so, off only when ALL sources
   *  release. Without this, a slow-to-respond detector clearing its
   *  own state would prematurely drop the bubble that another detector
   *  is still holding open. */
  private permissionSources = new Map<string, Set<string>>()

  /** Mark a permission-pending claim from `source` on agent `id`. The
   *  effective `permissionPending` flag flips on at the 0→1 transition
   *  and off only when the LAST source releases. Source identity lets
   *  detectors clear only their own claim and never clobber a peer.
   *  Routed through its own event type so the WS layer can emit the
   *  matching `agentToolPermission` / `agentToolPermissionClear`
   *  message without restarting the agent's active tool animation. */
  setPermissionPending(id: string, source: string, pending: boolean): AgentRecord | null {
    const existing = this.agents.get(id)
    if (!existing) return null
    const sources = this.permissionSources.get(id) ?? new Set<string>()
    const had = sources.has(source)
    if (pending) sources.add(source)
    else sources.delete(source)
    if (sources.size === 0) this.permissionSources.delete(id)
    else this.permissionSources.set(id, sources)
    // Bail when the source's claim was already what we got passed —
    // avoids emit storms from repeat-set calls.
    if (had === pending) return existing
    const effective = sources.size > 0
    if ((existing.permissionPending ?? false) === effective) return existing
    const next: AgentRecord = { ...existing, permissionPending: effective }
    this.agents.set(id, next)
    this.emit({ type: "permission", agent: next })
    return next
  }

  /** Mark an agent idle WITHOUT bumping updatedAt so the despawn timer
   *  keeps counting toward auto-removal. Idempotent. */
  markIdle(id: string): AgentRecord | null {
    const existing = this.agents.get(id)
    if (!existing || existing.idle === true) return null
    const next: AgentRecord = { ...existing, idle: true }
    this.agents.set(id, next)
    this.emit({ type: "upsert", agent: next })
    return next
  }

  remove(id: string): void {
    if (!this.agents.delete(id)) return
    // Drop permission claims so a respawned agent under the same id
    // starts fresh instead of inheriting a stale "still pending"
    // state from before despawn.
    this.permissionSources.delete(id)
    // Also drop the JSONL-usage timestamp so a respawn (e.g. a new
    // conversation under the same "main" id) goes back to allowing
    // self-report bootstrap until the next assistant turn lands.
    this.lastJsonlUsageAt.delete(id)
    this.emit({ type: "remove", id })
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    // Immediately send the current snapshot so a freshly-connected client
    // has the right state without waiting for the next mutation.
    listener({ type: "snapshot", agents: this.list() })
    // Replay the most recent quota window too so the HUD doesn't sit at
    // 0% for up to a minute on every webview reload.
    if (this.quota.budget > 0) {
      listener({ type: "quota", ...this.quota })
    }
    return () => this.listeners.delete(listener)
  }

  /** Push a new rolling-5h token usage snapshot. Called from the
   *  bridge's 1-minute calculateQuotaWindow tick. No-op when the
   *  numbers haven't changed so we don't spam idle WS clients. */
  setQuotaWindow(tokensUsed: number, budget: number, pct: number): void {
    if (
      this.quota.tokensUsed === tokensUsed
      && this.quota.budget === budget
      && this.quota.pct === pct
    ) {
      return
    }
    this.quota = { tokensUsed, budget, pct }
    this.emit({ type: "quota", tokensUsed, budget, pct })
  }

  /** Despawn-only sweeper. Per BEHAVIOR_SPEC §2 there is a SINGLE
   *  threshold per character class — not separate idle/despawn knobs.
   *  Going idle (wander) is an event-driven transition handled by the
   *  watchers' `markIdle` calls (CLI `stop_reason`, Desktop
   *  `turn_duration`); this sweeper's only job is to remove a character
   *  once it's been silent long enough:
   *    - sub-agent (parentId set): 30s
   *    - main (top-level):         60s
   *  Required because Claude Desktop has no office_finish guarantee —
   *  without despawn a character could linger forever after a chat ends. */
  startStaleSweeper(opts: StaleSweeperOptions): void {
    const interval = opts.intervalMs ?? 5_000
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = setInterval(() => {
      const now = Date.now()
      for (const rec of this.agents.values()) {
        if (rec.done) continue
        const silentFor = now - rec.updatedAt
        const despawnMs = rec.parentId ? opts.subDespawnMs : opts.mainDespawnMs
        if (silentFor >= despawnMs) {
          this.remove(rec.id)
        }
      }
    }, interval)
    // Don't keep the Node event loop alive just for sweeping — when the
    // MCP server exits we want the process to die immediately.
    this.sweeper.unref?.()
  }

  stopStaleSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  private emit(evt: OfficeEvent): void {
    for (const fn of this.listeners) {
      try { fn(evt) } catch { /* one bad listener mustn't kill the rest */ }
    }
  }
}
