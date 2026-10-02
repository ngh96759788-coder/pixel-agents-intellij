import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { modelChip } from '../office/components/ToolOverlay.js'
import { formatTokens, fullestContext, hudParts, quotaChip, type RateLimit } from '../office/usage.js'
import { HUD_CLOCK_TICK_MS, HUD_MAX_TIER, HUD_SCALE, HUD_SCALE_COMPACT, HUD_TOOLBAR_GAP_PX, MAX_VISIBLE_CHARACTERS, QUOTA_CHIP_AHEAD_BG, QUOTA_CHIP_AHEAD_BORDER, QUOTA_CHIP_BG, QUOTA_CHIP_BORDER } from '../constants.js'
import type { ToolActivity } from '../office/types.js'

// Shown on the HUD's single model chip when an agent is active but no
// real model id has arrived (pure Desktop chat — model lives in
// unreadable IndexedDB). "At least show the main character's model"
// per user request; the current default Claude Code model.
const DEFAULT_MODEL_FALLBACK = 'claude-opus-5'

interface BottomHUDProps {
  agents: number[]
  agentModel: Record<number, string>
  /** Prompt-side context tokens (input + cache_creation + cache_read) of each
   *  agent's most recent assistant turn — i.e. how full that conversation's
   *  context window currently is. This is what the context bar scales against. */
  agentUsage: Record<number, number>
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  /** Rolling 5h account-wide token usage, summed by the bridge from every
   *  ~/.claude/projects assistant turn within the window and weighted per
   *  bucket (cache reads 0.10x, cache writes 1.25x) so the figure tracks
   *  quota spend rather than how much history got re-read. 0 when the bridge
   *  hasn't pushed a value yet. Per BEHAVIOR_SPEC §3 we show the absolute
   *  count, not a % of an estimated plan budget. */
  quotaTokens: number
  /** Real 5h / 7d usage from the CLI statusline or Claude Desktop. When
   *  present it replaces the weighted token count on the chip. */
  rateLimit: RateLimit | null
  /** The office container and the bottom-left toolbar. Measured so the HUD
   *  can shed detail instead of sliding under the toolbar on narrow widths. */
  containerRef: RefObject<HTMLDivElement | null>
  toolbarRef: RefObject<HTMLDivElement | null>
}

// costColor removed with the dollar estimate column (per user request —
// the cost number was noisy and the percentage is more useful for them).

/** Approval-queue urgency. Even one pending approval is "careful"; multiple
 *  pending = warning. The pulsing pulse animation handles drawing eye on top
 *  of color, so we just shift hue slightly with count. */
function approvalColor(count: number): string {
  if (count >= 3) return '#b85050'
  return 'var(--pixel-status-permission, #c89a3a)'
}

interface ChipBucket {
  label: string
  fill: string
  outline: string
  count: number
}

// `bucketModels` removed: it rendered one chip per unique model tier
// across all sessions, which contradicted the single-model-display
// architectural decision. The single-chip selection logic now lives
// inline inside BottomHUD() tied to the MAX-pct token winner so the
// chip and the token bar always represent the same session.

/** Aggregated session-wide HUD: model summary + context bar + 5h token chip.
 *  Sits in the bottom-right; intentionally minimal so it never competes with the
 *  per-character activity bubbles for visual weight. */
export function BottomHUD({ agents, agentModel, agentUsage, agentTools, agentStatuses, quotaTokens, rateLimit, containerRef, toolbarRef }: BottomHUDProps) {
  const hudRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ key: '', tier: 0 })
  const [viewport, setViewport] = useState('')
  const [now, setNow] = useState(() => Date.now())
  let activeCount = 0
  let approvalCount = 0
  // Active/idle/approval counts stay scoped to currently-visible agents —
  // those are character-state signals, not account-wide quota signals.
  for (const id of agents) {
    // Both 'waiting' (turn-end ✓ bubble) and 'idle' (sweeper-marked
    // 30s silence) are non-active states. The map only stored 'waiting'
    // historically, but server.ts now also sends 'idle' — without
    // excluding it, idle-wandering agents inflated the active counter.
    const st = agentStatuses[id]
    if (st !== 'waiting' && st !== 'idle') activeCount += 1
    const tools = agentTools[id]
    if (tools?.some((t) => t.permissionWait && !t.done)) approvalCount += 1
  }
  const idleCount = Math.max(0, agents.length - activeCount)

  // Context-fullness indicator: pick the session whose context window is
  // closest to full and show that one. MAX (not SUM) because context windows
  // are per-conversation — summing a 1M Opus session with a 200K Haiku one
  // produces a ratio that describes neither. The numerator is the last turn's
  // prompt-side token count (`agentUsage`), NOT cumulative throughput: a long
  // session's lifetime total passes the window many times over and would peg
  // the bar at 100% forever. This is the same pair of values the per-character
  // HP bar in ToolOverlay renders, so the two now agree.
  const { tokens: totalTok, cap: effectiveCap, agentId: winnerAgentId } = fullestContext(agentUsage, agentModel)

  // Single model chip — represents the same session that wins the MAX
  // token % calculation above. Only shown when at least one agent is
  // currently active: the HUD's job is to summarise live work, and a
  // lavender OPUS chip floating next to "0/6" while every character
  // is idle was reading as a "permanent idle indicator" (user
  // complaint). Hiding it when activeCount===0 keeps the HUD
  // genuinely active-only, in line with the policy that "the HUD
  // shows active counts."
  let chipModel: string | undefined
  if (activeCount > 0) {
    if (winnerAgentId !== null) {
      chipModel = agentModel[winnerAgentId]
    } else {
      for (const id of agents) {
        if (agentModel[id]) { chipModel = agentModel[id]; break }
      }
    }
    // Fallback: a character is active but we never received a model id
    // for it. This happens in pure Claude Desktop chat — the model
    // isn't in ~/.claude/projects JSONL (it's in IndexedDB, unreadable)
    // and office_status doesn't carry it. Rather than show a blank HUD,
    // display a default model chip so "the main character at least has
    // a model" (per user request). Inaccurate if Desktop is actually on
    // a different tier, but better than nothing; override with
    // PIXEL_OFFICE_DEFAULT_MODEL via the bridge if needed.
    if (!chipModel) chipModel = DEFAULT_MODEL_FALLBACK
  }
  const winnerChip = chipModel ? modelChip(chipModel) : null
  const buckets: ChipBucket[] = winnerChip ? [{ ...winnerChip, count: 1 }] : []

  const quota = quotaChip(rateLimit, quotaTokens, now)
  const ctxPct = totalTok > 0 ? Math.min(100, Math.round((totalTok / effectiveCap) * 100)) : 0
  const contentKey = [approvalCount > 0, activeCount, quota?.label, winnerChip?.label, ctxPct, formatTokens(totalTok)].join('|')

  // The weekday pace moves with the clock, not only when a quota push lands.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), HUD_CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    const toolbar = toolbarRef.current
    if (!container || !toolbar) return
    const update = () => setViewport(`${container.clientWidth}x${toolbar.offsetWidth}`)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(container)
    ro.observe(toolbar)
    return () => ro.disconnect()
  }, [containerRef, toolbarRef])

  // A tier is only valid for the space and content it was fitted to; when
  // either changes the HUD starts again from the full layout, then steps up
  // one tier per layout pass until it clears the toolbar. Layout effects run
  // before paint, so the intermediate tiers are never visible.
  const fitKey = `${viewport}|${contentKey}`
  const tier = fit.key === fitKey ? fit.tier : 0
  useLayoutEffect(() => {
    if (tier >= HUD_MAX_TIER) return
    const hud = hudRef.current
    const toolbar = toolbarRef.current
    if (!hud || !toolbar) return
    if (hud.getBoundingClientRect().left < toolbar.getBoundingClientRect().right + HUD_TOOLBAR_GAP_PX) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- layout measured before paint must feed back into the render
      setFit({ key: fitKey, tier: tier + 1 })
    }
  }, [fitKey, tier, toolbarRef])

  const parts = hudParts(tier)
  if (!parts.visible) return null

  return (
    <div
      ref={hudRef}
      title={`Session totals across ${agents.length} agent${agents.length === 1 ? '' : 's'}.`}
      style={{
        position: 'absolute',
        bottom: 10,
        right: 10,
        zIndex: 'var(--pixel-controls-z)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border)',
        borderRadius: 0,
        padding: '4px 10px',
        boxShadow: 'var(--pixel-shadow)',
        fontSize: '14px',
        color: 'var(--pixel-text-dim, rgba(255,255,255,0.78))',
        whiteSpace: 'nowrap',
        // 1.6× scale (was 2×, dialed back ~20% per follow-up) — keeps
        // existing pixel-tight layout but enlarges every value
        // uniformly. Anchored to bottom-right so it doesn't drift
        // offscreen.
        transform: `scale(${parts.compactScale ? HUD_SCALE_COMPACT : HUD_SCALE})`,
        transformOrigin: 'bottom right',
      }}
    >
      {approvalCount > 0 && (
        <span
          className="pixel-agents-pulse"
          title={`${approvalCount} agent${approvalCount === 1 ? '' : 's'} waiting for approval`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 6px',
            fontSize: '13px',
            color: '#fff',
            background: approvalColor(approvalCount),
            border: '1px solid #6a522a',
            boxShadow: 'var(--pixel-shadow-sm)',
            letterSpacing: 0.3,
          }}
        >
          {/* "!" instead of ⚠ — the warning-sign glyph is not in FS Pixel
              Sans' cmap and rendered as an OS-fallback emoji. */}
          ! {approvalCount}
        </span>
      )}
      <span
        title={`${agents.length} of ${MAX_VISIBLE_CHARACTERS} character slots in use · ${activeCount} active · ${idleCount} idle`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          color: 'var(--pixel-text)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span
          className={activeCount > 0 ? 'pixel-agents-pulse' : undefined}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: activeCount > 0
              ? 'var(--pixel-status-active, #5fa86b)'
              : 'var(--pixel-border)',
            flexShrink: 0,
          }}
        />
        {/* Active slots filled / max capacity. Earlier iterations:
              - `active/total-spawned` (e.g. "1/1" with 6 slots) — looked
                broken because the denominator collapsed to whatever was
                spawned.
              - `total-spawned/MAX` (e.g. "2/6") — included idle agents
                in the numerator, which surprised users who'd just seen
                a character go to sleep ("why is it still counted?").
            Settled on `active/MAX`: numerator excludes idle/waiting so
            the dot indicator and the count agree, denominator stays
            anchored to the office capacity so "1/6 active" is obvious.
            Idle/total breakdown lives in the tooltip for the curious. */}
        <span>{activeCount}/{MAX_VISIBLE_CHARACTERS}</span>
      </span>
      {/* 5h account usage (BEHAVIOR_SPEC §3): the real % ("5h 14%") when
          the CLI statusline or Claude Desktop reported one, otherwise the
          weighted ~/.claude/projects token count ("1.2M / 5h"). Absent
          until either value exists so the chip doesn't flash in at 0. */}
      {quota && (
        <>
          <span style={{ opacity: 0.4 }}>·</span>
          <span
            title={quota.title}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '1px 6px',
              fontSize: '13px',
              color: '#fff',
              background: quota.ahead ? QUOTA_CHIP_AHEAD_BG : QUOTA_CHIP_BG,
              border: `1px solid ${quota.ahead ? QUOTA_CHIP_AHEAD_BORDER : QUOTA_CHIP_BORDER}`,
              boxShadow: 'var(--pixel-shadow-sm)',
              letterSpacing: 0.3,
            }}
          >
            {quota.label}
          </span>
        </>
      )}
      {parts.modelChip && buckets.length > 0 && (
        <span style={{ opacity: 0.4 }}>·</span>
      )}
      {parts.modelChip && buckets.map((b) => (
        <span key={b.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              display: 'inline-block',
              padding: '1px 5px',
              fontSize: '13px',
              lineHeight: 1.1,
              color: '#fff',
              background: b.fill,
              border: `1px solid ${b.outline}`,
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow-sm)',
              letterSpacing: 0.5,
              textShadow: `1px 1px 0 ${b.outline}`,
            }}
          >
            {b.label}
          </span>
          {b.count > 1 && (
            <span style={{ fontSize: '14px', color: 'var(--pixel-text)' }}>×{b.count}</span>
          )}
        </span>
      ))}
      {(() => {
        // Context window usage — scaled to the model's actual window
        // (Opus 4.x = 1M, others = 200K). Rendered as a proper progress
        // bar with the % overlaid in the centre so a long-running
        // session can be glanced at without parsing two separate text
        // chunks. Color crosses thresholds the user requested:
        //   <90%   → green   (normal)
        //   90-99% → yellow  (close to full)
        //   100%   → red     (out of room — clamped here, so any value
        //                     >= 100 maps to the same warn state)
        //
        // The bar frame ALWAYS renders (even at 0%) so the HUD stays
        // visually stable across turns — the empty track to the right
        // of the fill stays put instead of vanishing when the agent
        // briefly despawns or a fresh session starts.
        if (!parts.contextBar) return null
        const pct = ctxPct
        const fill = pct >= 100
          ? '#d05050' // muted brick red — matches gaugeColor() red
          : pct >= 90
            ? '#d6b25a' // muted gold — matches Haiku chip / gauge amber
            : '#5fa86b' // muted forest green — normal
        return (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span
              title={`${formatTokens(totalTok)} of ~${formatTokens(effectiveCap)} context tokens (${pct}%)`}
              style={{
                position: 'relative',
                display: 'inline-block',
                width: 64,
                height: 14,
                // Darker empty-track so the unfilled portion reads as a
                // proper hollow box rather than blending into the HUD
                // background.
                background: '#23232e',
                border: '1px solid var(--pixel-border)',
                boxShadow: 'var(--pixel-shadow-sm)',
                flexShrink: 0,
              }}
            >
              {/* Fill — clipped to pct width so visual ratio matches
                  the number we render on top of it. Stays at 0 width
                  when no tokens have been reported yet (instead of
                  disappearing entirely) so the box frame remains a
                  consistent landmark. */}
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${pct}%`,
                  background: fill,
                }}
              />
              {/* Centered % label — sits above the fill via z-index so
                  the digits stay readable regardless of which color the
                  bar is currently rendering. */}
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  lineHeight: 1,
                  letterSpacing: 0.3,
                  color: '#fff',
                  textShadow: '1px 1px 0 #0a0a14',
                  fontVariantNumeric: 'tabular-nums',
                  pointerEvents: 'none',
                }}
              >
                {pct}%
              </span>
            </span>
            {parts.tokText && <span style={{ color: 'var(--pixel-text)' }}>{formatTokens(totalTok)} tok</span>}
          </>
        )
      })()}
    </div>
  )
}
