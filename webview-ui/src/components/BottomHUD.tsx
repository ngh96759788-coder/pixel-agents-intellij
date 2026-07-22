import { modelChip } from '../office/components/ToolOverlay.js'
import { contextWindowFor, estimateCost, formatTokens, totalTokens } from '../office/usage.js'
import { MAX_VISIBLE_CHARACTERS } from '../constants.js'
import type { ToolActivity } from '../office/types.js'

// Shown on the HUD's single model chip when an agent is active but no
// real model id has arrived (pure Desktop chat — model lives in
// unreadable IndexedDB). "At least show the main character's model"
// per user request; the current default Claude Code model.
const DEFAULT_MODEL_FALLBACK = 'claude-opus-4-8'

interface BottomHUDProps {
  agents: number[]
  agentModel: Record<number, string>
  agentCumulative: Record<number, { input: number; cacheCreate: number; cacheRead: number; output: number }>
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  /** Rolling 5h account-wide absolute token usage, summed by the bridge
   *  from every ~/.claude/projects assistant turn within the window.
   *  0 when the bridge hasn't pushed a value yet. Per BEHAVIOR_SPEC §3
   *  we show the raw count (not a % of an estimated plan budget). */
  quotaTokens: number
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

/** Aggregated session-wide HUD: model summary + total tokens + total estimated cost.
 *  Sits in the bottom-right; intentionally minimal so it never competes with the
 *  per-character activity bubbles for visual weight. */
export function BottomHUD({ agents, agentModel, agentCumulative, agentTools, agentStatuses, quotaTokens }: BottomHUDProps) {
  let totalCost = 0
  let activeCount = 0
  let approvalCount = 0
  // Active/idle/approval counts stay scoped to currently-visible agents —
  // those are character-state signals, not account-wide quota signals.
  for (const id of agents) {
    const cum = agentCumulative[id]
    if (cum) {
      totalCost += estimateCost(cum, agentModel[id] ?? '')
    }
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

  // Account-wide quota indicator: Anthropic's 5-hour quota is per-account,
  // not per-session. So iterate over every cumulative entry we know of
  // (including agents that just despawned — useExtensionMessages now keeps
  // their entries) and pick the MAX of per-session (tokens / model-cap).
  // Why MAX and not SUM?
  //   - SUM-of-tokens / SUM-of-caps produces meaningless averages when
  //     sessions have different model tiers (Opus 1M + Sonnet 200K).
  //   - MAX answers "how close is my most-loaded conversation to its
  //     own context limit" — a stable, intuitive single number.
  //   - When a new session is added, the displayed value only changes
  //     if that session is bigger than the current max — no jitter as
  //     sessions take turns.
  // Server's autoLimitCheck broadcasts tokens=0 after 5h idle, which
  // propagates here and resets the indicator cleanly.
  let totalTok = 0
  let effectiveCap = 200_000
  let maxPctRaw = 0
  let winnerAgentId: number | null = null
  for (const idStr of Object.keys(agentCumulative)) {
    const id = Number(idStr)
    const cum = agentCumulative[id]
    if (!cum) continue
    const tok = totalTokens(cum)
    const cap = contextWindowFor(agentModel[id])
    if (cap <= 0) continue
    const pct = tok / cap
    if (pct > maxPctRaw) {
      maxPctRaw = pct
      totalTok = tok
      effectiveCap = cap
      winnerAgentId = id
    }
  }

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

  // Burn-rate sparkline removed — the tiny blue bars next to the token
  // count read as confusing visual noise more than informative trend
  // indicator. The progress bar below carries the same "how full is
  // the context" signal in a clearer form.

  // Always render. Earlier versions hid the HUD when no agents were
  // currently connected, but that produced the "flashing in/out"
  // effect the user complained about every time a character briefly
  // despawned between turns. Cost is one tiny <div> on screen even
  // when the office is empty — well worth the visual stability.

  return (
    <div
      title={`Session totals across ${agents.length} agent${agents.length === 1 ? '' : 's'}.\nCost is an estimate based on each agent's last observed model.`}
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
        transform: 'scale(1.6)',
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
      {/* Rolling 5h account token usage — sums every assistant turn
          across all sessions in ~/.claude/projects/. Per BEHAVIOR_SPEC
          §3 we show the absolute token count (e.g. "1.2M / 5h"), not a
          % of an estimated budget. Shown only after the bridge reports
          a nonzero value so the chip doesn't flash in at 0 before the
          first 60s tick. */}
      {quotaTokens > 0 && (
        <>
          <span style={{ opacity: 0.4 }}>·</span>
          <span
            title={`Tokens used in the last 5 hours across all ~/.claude/projects sessions`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '1px 6px',
              fontSize: '13px',
              color: '#fff',
              background: '#4a6a8a',
              border: '1px solid #2a3a4a',
              boxShadow: 'var(--pixel-shadow-sm)',
              letterSpacing: 0.3,
            }}
          >
            {formatTokens(quotaTokens)} / 5h
          </span>
        </>
      )}
      {buckets.length > 0 && (
        <span style={{ opacity: 0.4 }}>·</span>
      )}
      {buckets.map((b) => (
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
        const pct = totalTok > 0
          ? Math.min(100, Math.round((totalTok / effectiveCap) * 100))
          : 0
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
            <span style={{ color: 'var(--pixel-text)' }}>{formatTokens(totalTok)} tok</span>
          </>
        )
      })()}
    </div>
  )
}
