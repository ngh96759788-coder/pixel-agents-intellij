import { useState, useEffect, Fragment } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../types.js'
import {
  TOOL_OVERLAY_VERTICAL_OFFSET,
  CHARACTER_SITTING_OFFSET_PX,
  SUBAGENT_DISPLAY_NAMES,
  SPINNER_FLASH_CYCLE_MS,
  SPINNER_FLASH_DURATION_MS,
  SPINNER_FLASH_PHASE_STEP_MS,
  AMBIENT_LABEL_MAX_LEN,
} from '../../constants.js'
import { contextWindowFor, formatTokens } from '../usage.js'
import { spinnerVerbFor } from '../spinnerVerbs.js'

/** Extra vertical lift (CSS px) above the character so the two-line popup
 *  doesn't crowd the head sprite. Tuned to clear the sprite at zoom 2x —
 *  ratcheted between 66 (too high) and 36 (too low, label overlapped the
 *  head plate); 42 sits just above the head-overlay strip (identity dot
 *  + HP bar + status icon) without a dead gap. */
const OVERLAY_LIFT_PX = 42

interface ToolOverlayProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  agentUsage: Record<number, number>
  agentModel: Record<number, string>
  agentCumulative: Record<number, { input: number; cacheCreate: number; cacheRead: number; output: number }>
  /** Optional human-readable display name (IDE terminal tab) per main agent.
   *  Falls back to `main {id}` when unset (typically for sessions adopted
   *  from a user-launched `claude` in a terminal — we can't reliably tie
   *  those back to a specific IDE terminal tab). */
  agentDisplayNames: Record<number, string>
  /** Per-agent git branch for sessions adopted from a worktree of the open repo.
   *  Shown as a "↳branch" suffix on the identity label. */
  agentWorktreeBranches: Record<number, string>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: number) => void
}

/** Extract the major.minor version from a Claude model id so the chip
 *  reads as e.g. "OPUS 4.7" instead of just "OPUS". Supports both the
 *  modern naming (`claude-opus-4-7`) and the older inverted form
 *  (`claude-3-5-sonnet-…`). Returns "" when no version is detectable so
 *  callers can skip the suffix gracefully. */
function modelVersion(modelId: string): string {
  const id = modelId.toLowerCase()
  // Modern: tier-major-minor (claude-opus-4-7, claude-fable-5, claude-haiku-4-5, …)
  const modern = /(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(id)
  if (modern) return modern[2] ? `${modern[1]}.${modern[2]}` : modern[1]
  // Legacy: major-minor-tier (claude-3-5-sonnet, claude-3-opus, …)
  const legacy = /(\d+)(?:-(\d+))?-(?:opus|sonnet|haiku)/.exec(id)
  if (legacy) return legacy[2] ? `${legacy[1]}.${legacy[2]}` : legacy[1]
  return ""
}

/** Map a Claude model id to a short tier label + accent color.
 *  Colors are picked from the project's pixel palette (matching the dark office
 *  vibe) rather than vivid web colors so the chip blends with the rest of the UI.
 *  `outline` is used as a 1px outline + hard shadow, giving the chip a true
 *  pixel-art look (no rounded corners, no smooth gradients). The label tacks on
 *  the model's version ("OPUS 4.7", "SON 4.6") so users at a glance can see
 *  not just the tier but exactly which release the agent is running. */
export function modelChip(modelId: string): { label: string; fill: string; outline: string } | null {
  if (!modelId) return null
  const id = modelId.toLowerCase()
  const v = modelVersion(modelId)
  const suffix = v ? ` ${v}` : ""
  if (id.includes('fable')) return { label: `FABLE${suffix}`, fill: '#4a9e8e', outline: '#255048' }   // muted teal — Mythos-class tier above Opus
  if (id.includes('mythos')) return { label: `MYTH${suffix}`, fill: '#4a9e8e', outline: '#255048' }   // same tier/color family as Fable
  if (id.includes('opus')) return { label: `OPUS${suffix}`, fill: '#7a5aaa', outline: '#3a2a5a' }     // muted royal purple
  if (id.includes('sonnet')) return { label: `SON${suffix}`, fill: '#5a8cff', outline: '#28427a' }    // matches --pixel-accent
  if (id.includes('haiku')) return { label: `HAI${suffix}`, fill: '#c8a85a', outline: '#6a522a' }     // muted gold
  return { label: (modelId.split('-')[1] ?? '?').toUpperCase().slice(0, 3), fill: '#7a7a8a', outline: '#3a3a4a' }
}

/** Legacy fallback when no model id has been reported yet. Real scale
 *  comes from `contextWindowFor(modelId)` in `../usage.ts` so Opus 4.x
 *  (1M window) doesn't render as 90% full when only ~18% is used. */
const FALLBACK_CONTEXT_LIMIT = 200_000

/** Pick a HP-bar color based on usage ratio.
 *  Muted, slightly desaturated tones to match the pixel-art office palette
 *  (avoids the Bootstrap-style vivid #27ae60 / #e74c3c / #f39c12 web look). */
export function gaugeColor(ratio: number): string {
  if (ratio >= 0.85) return '#b85050' // muted brick red
  if (ratio >= 0.65) return '#c8a85a' // muted gold (matches Haiku chip)
  return '#5fa86b' // muted forest green
}

/** Derive a short human-readable activity string from tools/status, plus the
 *  output_tokens of the assistant turn that triggered the active tool (if any).
 *  The token delta is surfaced as a small badge next to the activity label so
 *  users can see which operations are expensive. */
function getActivityInfo(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
): { text: string; outputTokens?: number; startedAt?: number; ongoing: boolean } {
  const tools = agentTools[agentId]
  if (tools && tools.length > 0) {
    const activeTool = [...tools].reverse().find((t) => !t.done)
    if (activeTool) {
      if (activeTool.permissionWait) {
        return { text: 'Needs approval', startedAt: activeTool.startedAt, ongoing: true }
      }
      return { text: activeTool.status, outputTokens: activeTool.outputTokens, startedAt: activeTool.startedAt, ongoing: true }
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1]
      if (lastTool) {
        return { text: lastTool.status, outputTokens: lastTool.outputTokens, startedAt: lastTool.startedAt, ongoing: false }
      }
    }
  }

  return { text: 'Idle', ongoing: false }
}

export function ToolOverlay({
  officeState,
  agentTools,
  agentStatuses,
  agentUsage,
  agentModel,
  agentDisplayNames,
  agentWorktreeBranches,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
}: ToolOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  const selectedId = officeState.selectedAgentId
  const hoveredId = officeState.hoveredAgentId

  // All character IDs — pulled directly from the imperative OfficeState so
  // hover/select work for sub-agents even if the React `subagentCharacters`
  // list hasn't caught up yet (sub-agents spawn synchronously into
  // officeState.characters; the React mirror is a separate setState).
  const allIds = Array.from(officeState.characters.keys())

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        const isSelected = selectedId === id
        const isHovered = hoveredId === id
        const isSub = ch.isSubagent

        // Visibility policy: the activity bubble would otherwise cover the
        // character art itself, so we hide it by default and only surface it
        // when the user *asks* (hover/click) or when there's something
        // actionable they must respond to (permission).
        //
        // Canvas-rendered sprite bubbles (waiting checkmark, permission "...")
        // already convey urgency, so we don't need an HTML label for ambient
        // work. The 'waiting' state in particular is auto-fading so we never
        // duplicate it here.
        const isPermission = ch.bubbleType === 'permission'
        const isFocused = isSelected || isHovered

        // Position above character (shared by the ambient verb chip and the
        // full overlay). ch.x is already the sprite bottom-CENTER (sprite is
        // 16-wide, anchored at its centre line); translate(-50%, -100%) below
        // recentres the overlay over it.
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr

        // Ambient state — not hovered/selected and nothing to approve.
        // Base label is the REAL activity (tool name / summary) so we never
        // blanket the art with the full detail popup yet still convey what's
        // happening. While work drags on we intermittently flash a whimsical
        // "thinking" bubble with a spinner gerund, then revert. Idle → nothing.
        if (!isFocused && !isPermission) {
          const ambientTools = agentTools[id]
          const working = isSub
            ? (ch.isActive || (ambientTools?.some((t) => !t.done) ?? false))
            : (agentStatuses[id] !== 'waiting'
                && agentStatuses[id] !== 'idle'
                && (ch.isActive || (ambientTools?.length ?? 0) > 0))
          if (!working) return null

          // Real activity text (truncated). Empty when we have no tool detail.
          const rawActivity = isSub
            ? (subagentCharacters.find((s) => s.id === id)?.label ?? '')
            : getActivityInfo(id, agentTools, ch.isActive).text
          const activity = rawActivity && rawActivity !== 'Idle'
            ? (rawActivity.length > AMBIENT_LABEL_MAX_LEN
                ? `${rawActivity.slice(0, AMBIENT_LABEL_MAX_LEN - 1)}…`
                : rawActivity)
            : ''

          // Intermittent "thinking" flash: each SPINNER_FLASH_CYCLE_MS window
          // shows the spinner gerund for SPINNER_FLASH_DURATION_MS, then the
          // real activity for the remainder. Per-id phase offset staggers
          // concurrent agents. Also used as the sole content when there's no
          // real activity text to show.
          const now = performance.now()
          const phase = (now + id * SPINNER_FLASH_PHASE_STEP_MS) % SPINNER_FLASH_CYCLE_MS
          const thinking = !activity || phase < SPINNER_FLASH_DURATION_MS

          const wrapStyle: React.CSSProperties = {
            position: 'absolute',
            left: screenX,
            top: screenY - OVERLAY_LIFT_PX,
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'none',
            zIndex: 'var(--pixel-overlay-z)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }

          if (thinking) {
            const verb = spinnerVerbFor(id, now, SPINNER_FLASH_CYCLE_MS)
            // Rounded "thought bubble" with a two-dot tail pointing at the
            // head — visually distinct from the square activity chip so the
            // whimsical flash reads as "thinking", not real status.
            return (
              <div key={id} style={wrapStyle}>
                <div
                  style={{
                    fontSize: '11px',
                    fontStyle: 'italic',
                    letterSpacing: 0.3,
                    color: 'var(--pixel-text-dim, rgba(255,255,255,0.8))',
                    background: 'var(--pixel-bg)',
                    border: '1px solid var(--pixel-border)',
                    borderRadius: 9,
                    padding: '3px 9px',
                    whiteSpace: 'nowrap',
                    opacity: 0.9,
                  }}
                >
                  {verb}…
                </div>
                {[4, 2].map((d, i) => (
                  <span
                    key={i}
                    style={{
                      width: d,
                      height: d,
                      marginTop: 1,
                      borderRadius: '50%',
                      background: 'var(--pixel-bg)',
                      border: '1px solid var(--pixel-border)',
                    }}
                  />
                ))}
              </div>
            )
          }

          // Real activity chip — sharp-cornered to match the pixel aesthetic.
          return (
            <div key={id} style={wrapStyle}>
              <div
                style={{
                  fontSize: '11px',
                  letterSpacing: 0.3,
                  color: 'var(--pixel-text-dim, rgba(255,255,255,0.8))',
                  background: 'var(--pixel-bg)',
                  border: '1px solid var(--pixel-border)',
                  borderRadius: 0,
                  padding: '2px 6px',
                  whiteSpace: 'nowrap',
                  opacity: 0.85,
                }}
              >
                {activity}
              </div>
            </div>
          )
        }
        const subdued = !isSelected && !isHovered  // ambient (permission-only) — toned down

        const subHasPermission = isSub && ch.bubbleType === 'permission'

        // Determine dot color + status label.
        // "active" status removes the agent from agentStatuses entirely (the
        // map only stores explicit non-active states like 'waiting'), so the
        // canonical check for "this agent is currently working on a turn" is
        // `agentStatuses[id] !== 'waiting'`. Relying on `hasActiveTools` alone
        // mis-flagged the brief window between a Bash tool_result and the
        // next tool/text inside the same turn — e.g. `sleep 5` would render
        // as Idle even though the agent's turn was still in progress.
        const tools = agentTools[id]
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done)
        const status = isSub ? undefined : agentStatuses[id]
        // Sweeper sends `agentStatus: "idle"` (after the initial
        // "waiting") when 30s of JSONL silence elapses. Without
        // excluding 'idle' here, lingering tool entries (or a stale
        // ch.isActive flag) make the popup say "Active" + blue dot
        // while the character is visibly wandering — contradictory UI.
        const isWorking = !isSub && status !== 'waiting' && status !== 'idle' && (ch.isActive || (tools?.length ?? 0) > 0)
        const isActive = ch.isActive
        const hasActiveTools = tools?.some((t) => !t.done)

        let dotColor: string | null = null
        let statusLabel: string = 'Idle'
        if (hasPermission) {
          dotColor = 'var(--pixel-status-permission)'
          statusLabel = 'Wait'
        } else if (isSub ? (isActive || hasActiveTools) : isWorking) {
          dotColor = 'var(--pixel-status-active)'
          statusLabel = 'Active'
        }

        // Identity chip (row 1) — ALWAYS visible so main vs sub is at a glance,
        // even when the agent is mid-task. Avoids the earlier "main: foo / main: foo /
        // main: foo" spam by keeping the badge tiny + separating it from the activity.
        //
        // For main agents we append the agent id (e.g. `main 1`, `main 2`) so
        // multiple concurrent main agents within the same IDE are visually
        // distinct beyond their character sprite — otherwise the chip alone
        // wouldn't help users pick which terminal a popup belongs to.
        const sub = isSub ? subagentCharacters.find((s) => s.id === id) : null
        let identityLabel: string
        if (isSub) {
          if (sub?.subagentType) {
            identityLabel = SUBAGENT_DISPLAY_NAMES[sub.subagentType] ?? sub.subagentType
          } else {
            identityLabel = 'sub'
          }
        } else {
          // Prefer the real IDE terminal-tab name when we have one (e.g.
          // "Claude Code #3"). Fall back to `main {id}` for agents adopted
          // from a freestanding user `claude` — those have no reliable
          // terminal-tab name to surface.
          const tabName = agentDisplayNames[id]
          identityLabel = tabName && tabName.length > 0 ? tabName : `main ${id}`
          // Suffix the worktree branch so users can tell which branch an
          // agent handed off to a git worktree (IntelliJ 2026.1) works on.
          // ↳ (U+21B3) is used instead of ⑂ (U+2442): the fork glyph is not
          // in FS Pixel Sans' cmap, so it rendered in the OS fallback font.
          const branch = agentWorktreeBranches[id]
          if (branch) identityLabel = `${identityLabel} ↳${branch}`
        }

        // Activity text shown on row 2.
        //   • Active → real tool/task text (e.g. "Running: sleep 10",
        //     sub-task description).
        //   • Idle → empty; the identity chip already conveys "this is X".
        //     Row 2 just disappears, keeping the popup compact.
        const isIdleSlot = statusLabel === 'Idle'
        let activityText: string
        if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval'
          } else if (isIdleSlot) {
            activityText = ''
          } else if (sub) {
            activityText = sub.label
          } else {
            activityText = ''
          }
        } else {
          activityText = isIdleSlot
            ? ''
            : getActivityInfo(id, agentTools, ch.isActive).text
        }

        const contextTokens = isSub ? 0 : (agentUsage[id] ?? 0)
        const contextLimit = contextWindowFor(agentModel[id]) || FALLBACK_CONTEXT_LIMIT
        const contextRatio = contextTokens > 0
          ? Math.min(1, contextTokens / contextLimit)
          : 0

        return (
          <Fragment key={id}>
          <div
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - OVERLAY_LIFT_PX,
              transform: 'translate(-50%, -100%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isSelected ? 'auto' : 'none',
              zIndex: isSelected ? 'var(--pixel-overlay-selected-z)' : 'var(--pixel-overlay-z)',
              opacity: subdued ? 0.78 : 1,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 2,
                background: 'var(--pixel-bg)',
                border: isSelected
                  ? '2px solid var(--pixel-border-light)'
                  : subdued
                    ? '1px solid var(--pixel-border)'
                    : '2px solid var(--pixel-border)',
                borderRadius: 0,
                padding: subdued ? '3px 6px' : '4px 8px',
                boxShadow: subdued ? 'none' : 'var(--pixel-shadow)',
                maxWidth: 240,
                minWidth: 80,
              }}
            >
              {/* Row 1: status icon + token usage */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  justifyContent: isSub ? 'flex-start' : 'space-between',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    flexShrink: 0,
                  }}
                >
                  <span
                    className={isActive && !hasPermission ? 'pixel-agents-pulse' : undefined}
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: dotColor ?? 'var(--pixel-border)',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: '11px',
                      letterSpacing: 0.3,
                      color: 'var(--pixel-text-dim, rgba(255,255,255,0.7))',
                      textTransform: 'uppercase',
                    }}
                  >
                    {statusLabel}
                  </span>
                  {/* Identity chip — always shown so main vs sub is obvious
                      regardless of work state. Tiny, dim, pill-styled to
                      avoid duplicating the activity text below. */}
                  <span
                    title={isSub ? `Sub-agent type: ${identityLabel}` : 'Main agent'}
                    style={{
                      display: 'inline-block',
                      flexShrink: 0,
                      padding: '0 4px',
                      fontSize: '10px',
                      lineHeight: 1.2,
                      letterSpacing: 0.4,
                      color: 'var(--pixel-text-dim, rgba(255,255,255,0.85))',
                      background: isSub
                        ? 'rgba(120, 90, 170, 0.25)'
                        : 'rgba(60, 110, 180, 0.25)',
                      border: '1px solid var(--pixel-border)',
                      borderRadius: 0,
                      maxWidth: 96,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {identityLabel}
                  </span>
                </span>
                {!isSub && contextTokens > 0 && (
                  <span
                    title={`Context: ${formatTokens(contextTokens)} / ${formatTokens(contextLimit)} (${Math.round(contextRatio * 100)}%)`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      flexShrink: 0,
                      marginLeft: 8,
                    }}
                  >
                    <span
                      style={{
                        width: 36,
                        height: 5,
                        background: 'var(--pixel-border)',
                        position: 'relative',
                        flexShrink: 0,
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          height: '100%',
                          width: `${contextRatio * 100}%`,
                          background: gaugeColor(contextRatio),
                        }}
                      />
                    </span>
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'var(--pixel-text-dim, rgba(255,255,255,0.7))',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatTokens(contextTokens)}
                    </span>
                  </span>
                )}
                {isSelected && !isSub && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onCloseAgent(id)
                    }}
                    title="Close agent"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--pixel-close-text)',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '20px',
                      lineHeight: 1,
                      marginLeft: 4,
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)'
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)'
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              {/* Row 2: task content (hidden when idle/empty) */}
              {activityText && (
                <div
                  style={{
                    fontSize: isSub ? '13px' : '14px',
                    fontStyle: isSub ? 'italic' : undefined,
                    color: 'var(--vscode-foreground, var(--pixel-text))',
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                    lineHeight: 1.25,
                  }}
                >
                  {activityText}
                </div>
              )}
            </div>
          </div>
          </Fragment>
        )
      })}
    </>
  )
}
