import { useState, useEffect, useRef } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfficeLayout, ToolActivity } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { clearColorizeCache } from '../office/colorize.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { clearSpriteCache } from '../office/sprites/spriteCache.js'
import { setIdentityIcons, setStatusIcons, setHeadFrame } from '../office/engine/renderer.js'
import { vscode } from '../vscodeApi.js'
import { playDoneSound, playSpawnSound, playDespawnSound, playThemeSwitchSound, setSoundEnabled } from '../notificationSound.js'
import { debug } from '../debug.js'

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  label: string
  subagentType?: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
  animSequence?: string[]
}

/** Always-on visibility for the four per-character overlay elements.
 *  Default = all false → user only sees these on hover/select. Each can
 *  be flipped from the settings modal; the extension persists the flags. */
export interface OverlayDefaults {
  identityDot: boolean
  tokenBar: boolean
  status: boolean
  tether: boolean
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  agentUsage: Record<number, number>
  agentModel: Record<number, string>
  agentCumulative: Record<number, { input: number; cacheCreate: number; cacheRead: number; output: number }>
  /** Per-agent display name — IDE terminal-tab name for +Agent-launched
   *  sessions, empty string for sessions adopted from a freestanding `claude`
   *  in a user terminal (in that case ToolOverlay falls back to `main {id}`). */
  agentDisplayNames: Record<number, string>
  /** Per-agent git branch for sessions adopted from a worktree of the open repo.
   *  ToolOverlay shows it as a "↳branch" suffix. Absent for main-worktree agents. */
  agentWorktreeBranches: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
  currentTheme: string
  overlayDefaults: OverlayDefaults
  setOverlayDefault: (kind: keyof OverlayDefaults, enabled: boolean) => void
  /** Cross-project layout sharing toggle (Application-level setting on
   *  the Kotlin side). True = all IntelliJ windows share one layout file. */
  sharedLayoutAcrossProjects: boolean
  setSharedLayoutAcrossProjects: (enabled: boolean) => void
  /** Unified view (BEHAVIOR_SPEC §4): show external-source agents at 85%
   *  opacity. Persisted backend-side; default OFF (own work only). */
  unifiedView: boolean
  setUnifiedView: (enabled: boolean) => void
  /** Rolling 5h absolute token usage summed across every
   *  ~/.claude/projects session. Pushed by the bridge every 60s. */
  quotaTokens: number
  /** True when the host is the MCP bridge widget (Claude Desktop). Used
   *  by UI to hide IDE-only affordances like + Agent. */
  bridgeMode: boolean
  /** Extra padding-top (CSS px) applied to the root container. Bridge
   *  widget sends a small offset (default 15) so the canvas doesn't
   *  hug the window title bar. IDE host leaves this at 0. */
  topOffset: number
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({})
  const [agentUsage, setAgentUsage] = useState<Record<number, number>>({})
  const [agentModel, setAgentModel] = useState<Record<number, string>>({})
  const [agentCumulative, setAgentCumulative] = useState<Record<number, { input: number; cacheCreate: number; cacheRead: number; output: number }>>({})
  const [agentDisplayNames, setAgentDisplayNames] = useState<Record<number, string>>({})
  const [agentWorktreeBranches, setAgentWorktreeBranches] = useState<Record<number, string>>({})
  const [subagentTools, setSubagentTools] = useState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()
  const [currentTheme, setCurrentTheme] = useState('default')
  // True when the host is the MCP bridge (Claude Desktop standalone widget)
  // rather than the full IDE plugin. The bridge can't spawn IDE terminals
  // so we hide affordances that wouldn't work.
  const [bridgeMode, setBridgeMode] = useState(false)
  // Extra padding-top on the root container — useful for the bridge
  // widget where the chrome-less window sticks to the title bar.
  const [topOffset, setTopOffset] = useState(0)
  const [overlayDefaults, setOverlayDefaults] = useState<OverlayDefaults>({
    identityDot: false,
    tokenBar: false,
    status: false,
    tether: false,
  })
  const [sharedLayoutAcrossProjects, setSharedLayoutAcrossProjectsState] = useState(false)
  // Unified view (BEHAVIOR_SPEC §4): OFF (default) = only this window's own
  // agents; ON = external-source agents are also shown, at 85% opacity.
  // A ref mirrors the state for the message-handler closure ([] deps effect).
  const [unifiedView, setUnifiedViewState] = useState(false)
  const unifiedViewRef = useRef(false)
  // Rolling 5h token-usage indicator from the MCP bridge's
  // calculateQuotaWindow tick. Per BEHAVIOR_SPEC §3 we display the
  // ABSOLUTE token count (not a % of an estimated budget), so we track
  // tokensUsed rather than pct.
  const [quotaTokens, setQuotaTokens] = useState(0)

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)

  // Per-agent cooldown for done-sound to prevent overlap from:
  // (a) double-fire when text-idle timer + turn_duration both send `waiting` for one turn
  // (b) JSONL replay during adoption where N historical turn_durations stack into a sound burst
  const lastDoneSoundAtRef = useRef<Record<number, number>>({})
  const DONE_SOUND_COOLDOWN_MS = 800

  useEffect(() => {
    // Bridge the gap between Kotlin's display-change detection and the
    // full webview reload it then triggers. The reload wipes everything
    // including the sprite cache, but there's a ~0.5–2s window before
    // it completes where the canvas would otherwise keep painting from
    // wrong-DPR cached sprites. Clearing the cache on the same event
    // forces those few frames to re-rasterise at the new size.
    const onDisplayChange = (): void => {
      try {
        clearSpriteCache()
      } catch (err) {
        console.error('[PixelAgents] clearSpriteCache on display change failed', err)
      }
    }
    window.addEventListener('pixel-agent:display-change', onDisplayChange)
    return () => window.removeEventListener('pixel-agent:display-change', onDisplayChange)
  }, [])

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string }> = []
    // Per-window independence (unified view OFF, the default): other sources'
    // agents are hidden entirely from this view. We track their ids so any
    // subsequent tool/status messages for them are silently dropped (no
    // character, no sub-agent, no overlay).
    const ignoredExternalIds = new Set<number>()
    // Unified view ON: external agents that ARE shown (flagged so the
    // renderer draws them at 85% opacity and their sub-agents inherit it).
    const visibleExternalIds = new Set<number>()

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          debug('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true)
          if (visibleExternalIds.has(p.id)) os.setAgentExternal(p.id, true)
        }
        pendingAgents = []
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        const isExternal = msg.isExternal === true
        if (isExternal && !unifiedViewRef.current) {
          // Unified view OFF: hide other sources' agents completely.
          ignoredExternalIds.add(id)
          return
        }
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        // Externals never steal selection/camera — they're background context.
        if (!isExternal) setSelectedAgent(id)
        os.addAgent(id)
        if (isExternal) {
          ignoredExternalIds.delete(id)
          visibleExternalIds.add(id)
          os.setAgentExternal(id, true)
        }
        const displayName = typeof msg.displayName === 'string' ? msg.displayName : ''
        if (displayName) {
          setAgentDisplayNames((prev) =>
            prev[id] === displayName ? prev : { ...prev, [id]: displayName },
          )
        }
        const worktreeBranch = typeof msg.worktreeBranch === 'string' ? msg.worktreeBranch : ''
        if (worktreeBranch) {
          setAgentWorktreeBranches((prev) =>
            prev[id] === worktreeBranch ? prev : { ...prev, [id]: worktreeBranch },
          )
        }
        saveAgentSeats(os)
        // External spawns stay quiet — chimes for other windows' activity
        // would be noise.
        if (!isExternal) playSpawnSound()
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) {
          ignoredExternalIds.delete(id)
          return
        }
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentDisplayNames((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentWorktreeBranches((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Intentionally preserve agentUsage / agentModel / agentCumulative
        // across despawn. Anthropic's 5-hour quota is account-wide — a
        // session that just despawned still counts against the user's
        // running quota. Clearing the bottom-HUD's token totals every
        // time a character vanished produced two visible bugs:
        //   (a) HUD flips to 0% when all characters briefly despawn
        //       between turns (stale sweeper 60s).
        //   (b) HUD value jitters as sessions take turns appearing —
        //       each new spawn re-populates state from scratch.
        // The server's autoLimitCheck (5h idle) propagates an explicit
        // tokens=0 signal that resets these maps cleanly when the quota
        // window actually rolls over; that's the correct reset point.
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
        // Persist the now-shrunk seat map so the removed agent's stale
        // palette/seatId can't be inherited by a future agent that happens
        // to be assigned the same numeric id (e.g. after IDE restart).
        saveAgentSeats(os)
        playDespawnSound()
      } else if (msg.type === 'existingAgents') {
        const incomingRaw = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<number, { palette?: number; hueShift?: number; seatId?: string }>
        const externalIds = (msg.externalIds as number[] | undefined) ?? []
        // String-keyed map from the Kotlin side (Gson serializes Map<Int,…> with
        // stringified keys), so we parse back to numbers when reading.
        const incomingDisplayNames = (msg.displayNames as Record<string, string> | undefined) ?? {}
        const externalSet = new Set(externalIds)
        const unified = unifiedViewRef.current
        if (unified) {
          // Unified view ON: externals become visible (85% opacity) characters.
          for (const id of externalIds) {
            ignoredExternalIds.delete(id)
            visibleExternalIds.add(id)
          }
        } else {
          // Per-window independence (default): drop external agents up front so
          // no character, sub-agent, or overlay state is ever created for them.
          // The ghost-reconciliation below also removes any that were visible
          // before the toggle flipped off.
          for (const id of externalIds) {
            ignoredExternalIds.add(id)
            visibleExternalIds.delete(id)
          }
        }
        const incoming = unified ? [...incomingRaw] : incomingRaw.filter((id) => !externalSet.has(id))
        const incomingSet = new Set(incoming)
        // Treat extension's list as authoritative: any character/state we hold
        // for an id NOT in `incoming` is a ghost (e.g. webview missed an
        // `agentClosed` message) and must be reconciled away.
        for (const ch of Array.from(os.characters.values())) {
          if (ch.isSubagent) continue
          if (!incomingSet.has(ch.id)) {
            os.removeAllSubagents(ch.id)
            os.removeAgent(ch.id)
          }
        }
        // Drop any pendingAgents that didn't survive into `incoming` either.
        pendingAgents = pendingAgents.filter((p) => incomingSet.has(p.id))
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[id]
          if (pendingAgents.some((p) => p.id === id)) continue
          pendingAgents.push({
            id,
            palette: m?.palette,
            hueShift: m?.hueShift,
            seatId: m?.seatId,
          })
        }
        // Initial load buffers into pendingAgents and flushes on layoutLoaded.
        // RESYNCS (e.g. unified-view toggle, backend re-broadcast) arrive after
        // layout is already up and get no follow-up layoutLoaded — flush now.
        if (layoutReadyRef.current && pendingAgents.length > 0) {
          for (const p of pendingAgents) {
            os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true)
            if (visibleExternalIds.has(p.id)) os.setAgentExternal(p.id, true)
          }
          pendingAgents = []
          saveAgentSeats(os)
        }
        // Re-flag survivors: reconciliation keeps existing characters, so a
        // toggle-driven resync must (re)apply the external flag in place.
        for (const ch of Array.from(os.characters.values())) {
          if (ch.isSubagent) continue
          os.setAgentExternal(ch.id, visibleExternalIds.has(ch.id))
        }
        setAgents(() => [...incoming].sort((a, b) => a - b))
        setAgentTools((prev) => {
          const next: typeof prev = {}
          for (const id of Object.keys(prev) as unknown as number[]) {
            if (incomingSet.has(Number(id))) next[Number(id)] = prev[Number(id)]
          }
          return next
        })
        setAgentStatuses((prev) => {
          const next: typeof prev = {}
          for (const id of Object.keys(prev) as unknown as number[]) {
            if (incomingSet.has(Number(id))) next[Number(id)] = prev[Number(id)]
          }
          return next
        })
        setSubagentTools((prev) => {
          const next: typeof prev = {}
          for (const id of Object.keys(prev) as unknown as number[]) {
            if (incomingSet.has(Number(id))) next[Number(id)] = prev[Number(id)]
          }
          return next
        })
        setAgentUsage((prev) => {
          const next: typeof prev = {}
          for (const id of Object.keys(prev) as unknown as number[]) {
            if (incomingSet.has(Number(id))) next[Number(id)] = prev[Number(id)]
          }
          return next
        })
        setAgentModel((prev) => {
          const next: typeof prev = {}
          for (const id of Object.keys(prev) as unknown as number[]) {
            if (incomingSet.has(Number(id))) next[Number(id)] = prev[Number(id)]
          }
          return next
        })
        setAgentDisplayNames(() => {
          const next: Record<number, string> = {}
          for (const id of incoming) {
            const name = incomingDisplayNames[String(id)]
            if (name) next[id] = name
          }
          return next
        })
        const incomingWorktreeBranches = (msg.worktreeBranches as Record<string, string> | undefined) ?? {}
        setAgentWorktreeBranches(() => {
          const next: Record<number, string> = {}
          for (const id of incoming) {
            const branch = incomingWorktreeBranches[String(id)]
            if (branch) next[id] = branch
          }
          return next
        })
        setAgentCumulative((prev) => {
          const next: typeof prev = {}
          for (const id of Object.keys(prev) as unknown as number[]) {
            if (incomingSet.has(Number(id))) next[Number(id)] = prev[Number(id)]
          }
          return next
        })
        setSubagentCharacters((prev) => prev.filter((s) => incomingSet.has(s.parentAgentId)))
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        const toolId = msg.toolId as string
        const status = msg.status as string
        const outputTokens = typeof msg.outputTokens === 'number' && msg.outputTokens > 0
          ? (msg.outputTokens as number)
          : undefined
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false, outputTokens, startedAt: Date.now() }] }
        })
        const toolName = extractToolName(status)
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.clearPermissionBubble(id)
        // Create sub-agent character for Task tool subtasks
        if (status.startsWith('Subtask')) {
          // Parse "Subtask[type]: desc" or "Subtask: desc"
          let subagentType: string | undefined
          let label: string
          const bracketMatch = status.match(/^Subtask\[(\w+)\]:\s*(.*)$/)
          if (bracketMatch) {
            subagentType = bracketMatch[1]
            label = bracketMatch[2]
          } else {
            label = status.slice('Subtask:'.length).trim()
          }
          const subId = os.addSubagent(id, toolId)
          // Sub-agents of an external parent inherit the 85% external opacity
          // (they belong to the same external source as their parent).
          if (subId !== 0 && visibleExternalIds.has(id)) os.setAgentExternal(subId, true)
          // addSubagent returns 0 when at MAX_VISIBLE_CHARACTERS capacity. Real
          // sub-agent IDs are negative (nextSubagentId-- starting at -1), so 0
          // is a sentinel — don't push a phantom character.
          if (subId !== 0) {
            setSubagentCharacters((prev) => {
              if (prev.some((s) => s.id === subId)) return prev
              return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label, subagentType }]
            })
            playSpawnSound()
          }
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        const toolId = msg.toolId as string
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const updated = list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t))
          // If all tools are done, clear the character's tool state
          if (updated.every((t) => t.done)) {
            os.setAgentTool(id, null)
          }
          return { ...prev, [id]: updated }
        })
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentToolsClearParentOnly') {
        // Parent's turn ended but async sub-agents are still running in background.
        // Clear the parent's own tool bubble but keep sub-agent characters alive.
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        const status = msg.status as string
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.setAgentTool(id, null)
          os.showWaitingBubble(id)
          // Clear stale permission bubble: when turn ends with no active tools at the
          // turn_duration moment (tool already finished earlier in turn), the extension
          // never sends agentToolsClear, so any "..." bubble shown by the 7s permission
          // timer would otherwise persist forever. Waiting state is mutually exclusive
          // with permission-pending, so this clear is always semantically correct.
          os.clearPermissionBubble(id)
          // Also clear permission bubbles on this agent's sub-agent characters
          for (const [subId, meta] of os.subagentMeta) {
            if (meta.parentAgentId === id) {
              os.clearPermissionBubble(subId)
            }
          }
          // Drop permissionWait flag from the tool list so the per-tool indicator clears too
          setAgentTools((prev) => {
            const list = prev[id]
            if (!list || !list.some((t) => t.permissionWait)) return prev
            return {
              ...prev,
              [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
            }
          })
          // Cooldown to suppress overlap (text-idle + turn_duration double-fire, replay bursts).
          const now = Date.now()
          const lastAt = lastDoneSoundAtRef.current[id] ?? 0
          if (now - lastAt >= DONE_SOUND_COOLDOWN_MS) {
            lastDoneSoundAtRef.current[id] = now
            playDoneSound()
          }
        }
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        os.showPermissionBubble(id)
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          const updated = list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t))
          // When all sub-agent tools are done, stop the typing/reading
          // animation. Without this the character keeps animating with its
          // last tool forever, even if the sub-agent is now idle.
          if (updated.every((t) => t.done)) {
            const subId = os.getSubagentId(id, parentToolId)
            if (subId !== null) {
              os.setAgentTool(subId, null)
              os.setAgentActive(subId, false)
            }
          }
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: updated },
          }
        })
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Mark sub-agent as completed — it will wander and auto-despawn after
        // SUBAGENT_DESPAWN_DELAY_SEC (30s per BEHAVIOR_SPEC §2)
        os.markSubagentCompleted(id, parentToolId)
        // Drop the React record too: markSubagentCompleted detaches the
        // OfficeState character from subagentMeta immediately, leaving the
        // React record orphaned (stale label, no character). Without this,
        // overlay/toolbar may render a label for a character that no longer
        // exists in OfficeState.
        setSubagentCharacters((prev) =>
          prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId))
        )
      } else if (msg.type === 'agentUsage') {
        const id = msg.id as number
        if (ignoredExternalIds.has(id)) return
        const tokens = msg.contextTokens as number | undefined
        const model = msg.model as string | undefined
        if (typeof tokens === 'number') {
          // Update even when tokens === 0 so the server's 5-hour quota
          // reset (autoLimitCheck broadcasts tokens=0) propagates and
          // clears the lingering HUD values. The old `tokens > 0`
          // guard meant resets silently dropped — quota indicator was
          // stuck at the last nonzero value forever.
          setAgentUsage((prev) => (prev[id] === tokens ? prev : { ...prev, [id]: tokens }))
          os.setAgentContextTokens(id, tokens)
        }
        // Reject the legacy "claude-desktop" sentinel: older bridge
        // builds emitted it when a JSONL watcher hadn't resolved the
        // real model yet, which the HUD chip renderer drew as a
        // ghostly "DES" chip next to OPUS/SON/HAI. The current bridge
        // omits `model` entirely in that case, but keeping the guard
        // here means an out-of-date bridge talking to this webview
        // still won't pollute the HUD.
        if (typeof model === 'string' && model.length > 0 && model !== 'claude-desktop') {
          setAgentModel((prev) => (prev[id] === model ? prev : { ...prev, [id]: model }))
          // Mirror onto the canvas character so the HP-bar renderer can
          // pick the right context-window cap without round-tripping
          // through React props.
          os.setAgentModel(id, model)
        }
        const cumIn = msg.cumulativeInput as number | undefined
        const cumCC = msg.cumulativeCacheCreate as number | undefined
        const cumCR = msg.cumulativeCacheRead as number | undefined
        const cumOut = msg.cumulativeOutput as number | undefined
        if (typeof cumIn === 'number' || typeof cumCC === 'number' || typeof cumCR === 'number' || typeof cumOut === 'number') {
          const next = {
            input: cumIn ?? 0,
            cacheCreate: cumCC ?? 0,
            cacheRead: cumCR ?? 0,
            output: cumOut ?? 0,
          }
          setAgentCumulative((prev) => {
            const cur = prev[id]
            if (cur && cur.input === next.input && cur.cacheCreate === next.cacheCreate
              && cur.cacheRead === next.cacheRead && cur.output === next.output) return prev
            return { ...prev, [id]: next }
          })
        }
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        debug(`[Webview] Received ${characters.length} pre-colored character sprites`)
        const theme = (msg.theme as string) ?? 'default'
        setCharacterTemplates(characters, theme)
        // Force all existing characters to refresh their cached sprites
        os.refreshCharacterSprites()
        // Update theme (characterSpritesLoaded fires on theme change)
        if (msg.theme) {
          setCurrentTheme(theme)
        }
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        debug(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        debug(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'identityIconsLoaded') {
        // Legacy single-message format (kept for backward compat).
        const main = (msg.main as string[][] | null | undefined) ?? null
        const sub = (msg.sub as string[][] | null | undefined) ?? null
        setIdentityIcons(main, sub)
      } else if (msg.type === 'headIconsLoaded') {
        // Combined head-overlay badges. Identity = chaicon
        // user-profile/users, status = pencil/bell/clock. Each badge
        // gets composited over a Kenney 9-slice frame for the card
        // look.
        const identityMain = (msg.identityMain as string[][] | null | undefined) ?? null
        const identitySub = (msg.identitySub as string[][] | null | undefined) ?? null
        const statusActive = (msg.statusActive as string[][] | null | undefined) ?? null
        const statusWait = (msg.statusWait as string[][] | null | undefined) ?? null
        const statusIdle = (msg.statusIdle as string[][] | null | undefined) ?? null
        const frame = (msg.frame as string[][] | null | undefined) ?? null
        setIdentityIcons(identityMain, identitySub)
        setStatusIcons(statusActive, statusWait, statusIdle)
        setHeadFrame(frame)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
        if (msg.theme) {
          const theme = msg.theme as string
          setCurrentTheme(theme)
        }
        if (typeof msg.bridgeMode === 'boolean') {
          setBridgeMode(msg.bridgeMode)
        }
        if (typeof msg.topOffset === 'number') {
          setTopOffset(msg.topOffset)
        }
        // Always-on overlay toggles — each defaults to false (hover-only).
        // The extension echoes the saved values; we only update fields the
        // payload actually carries so older builds without these keys keep
        // the cleaner hover-only default.
        setOverlayDefaults((prev) => ({
          identityDot: typeof msg.alwaysShowIdentityDot === 'boolean' ? msg.alwaysShowIdentityDot : prev.identityDot,
          tokenBar: typeof msg.alwaysShowTokenBar === 'boolean' ? msg.alwaysShowTokenBar : prev.tokenBar,
          status: typeof msg.alwaysShowStatus === 'boolean' ? msg.alwaysShowStatus : prev.status,
          tether: typeof msg.alwaysShowTether === 'boolean' ? msg.alwaysShowTether : prev.tether,
        }))
        if (typeof msg.sharedLayoutAcrossProjects === 'boolean') {
          setSharedLayoutAcrossProjectsState(msg.sharedLayoutAcrossProjects)
        }
        if (typeof msg.unifiedView === 'boolean') {
          unifiedViewRef.current = msg.unifiedView
          setUnifiedViewState(msg.unifiedView)
        }
      } else if (msg.type === 'quotaWindow') {
        // Rolling 5h absolute token usage from the bridge (BEHAVIOR_SPEC
        // §3). pct/budget are also on the wire but we display the raw
        // token count to avoid the inaccurate budget-estimate divisor.
        const tokens = msg.tokensUsed as number | undefined
        if (typeof tokens === 'number') {
          setQuotaTokens((prev) => (prev === tokens ? prev : tokens))
        }
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          debug(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
          // Rebuild blocked tiles if layout was already loaded (fixes race where
          // layoutLoaded arrives before furnitureAssetsLoaded, causing zoo fences
          // to be skipped because getCatalogEntry returned null)
          const currentLayout = os.getLayout()
          if (currentLayout && currentLayout.furniture.length > 0) {
            os.rebuildFromLayout(currentLayout)
          }
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      } else if (msg.type === 'themeChanged') {
        const theme = msg.theme as string
        debug(`[Webview] Theme changed to: ${theme}, forcing cache clear + layout rebuild`)
        setCurrentTheme(theme)
        // Nuclear cache clear — ensure all colorized tiles use the new sprites
        clearColorizeCache()
        // Force rebuild to re-render with new floor/wall sprites
        const currentLayout = os.getLayout()
        if (currentLayout) {
          os.rebuildFromLayout(currentLayout)
          onLayoutLoaded?.(currentLayout)
        }
        playThemeSwitchSound()
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState])

  return { agents, selectedAgent, agentTools, agentStatuses, agentUsage, agentModel, agentCumulative, agentDisplayNames, agentWorktreeBranches, subagentTools, subagentCharacters, layoutReady, loadedAssets, currentTheme, overlayDefaults, setOverlayDefault, sharedLayoutAcrossProjects, setSharedLayoutAcrossProjects, unifiedView, setUnifiedView, quotaTokens, bridgeMode, topOffset }

  /** Toggle one overlay default both locally (optimistic) and in the
   *  extension settings (durable). Defined inside the hook so it closes
   *  over the setter without exposing it. */
  function setOverlayDefault(kind: keyof OverlayDefaults, enabled: boolean): void {
    setOverlayDefaults((prev) => (prev[kind] === enabled ? prev : { ...prev, [kind]: enabled }))
    vscode.postMessage({ type: 'setOverlayDefault', kind, enabled })
  }

  /** Toggle cross-project layout sharing. Optimistically updates local
   *  state, then asks the extension to persist + migrate the layout into
   *  the new scope. The extension echoes back a `layoutLoaded` so the
   *  office repaints with the new scope's content. */
  function setSharedLayoutAcrossProjects(enabled: boolean): void {
    setSharedLayoutAcrossProjectsState((prev) => (prev === enabled ? prev : enabled))
    vscode.postMessage({ type: 'setSharedLayoutAcrossProjects', enabled })
  }

  /** Toggle unified view (BEHAVIOR_SPEC §4). Optimistically updates local
   *  state, then asks the backend to persist and re-broadcast agents; the
   *  backend's replay (existingAgents resync / agentCreated / agentClosed)
   *  is what actually adds or removes the external characters. */
  function setUnifiedView(enabled: boolean): void {
    unifiedViewRef.current = enabled
    setUnifiedViewState((prev) => (prev === enabled ? prev : enabled))
    vscode.postMessage({ type: 'setUnifiedView', enabled })
  }
}
