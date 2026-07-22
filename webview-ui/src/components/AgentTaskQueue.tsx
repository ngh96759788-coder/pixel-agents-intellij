import { useEffect, useState } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { ToolActivity } from '../office/types.js'

interface AgentTaskQueueProps {
  officeState: OfficeState
  agentTools: Record<number, ToolActivity[]>
}

/** Max cards rendered. Anything beyond this collapses into a "+N" footer
 *  so we never paper the viewport with a long queue. */
const MAX_CARDS = 3

function elapsedLabel(startedAt: number | undefined, now: number): string {
  if (!startedAt) return ''
  const sec = Math.floor((now - startedAt) / 1000)
  if (sec < 1) return 'just now'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

/** Right-side stack of pending/in-flight task cards for the currently
 *  selected or hovered agent. Surfaces the *queue* that the office canvas
 *  hides — characters only animate one tool at a time, but `agentTools`
 *  often holds several concurrent calls (parallel Bash, multi-file Edit,
 *  long-running shell). The panel collapses when no agent is targeted. */
export function AgentTaskQueue({ officeState, agentTools }: AgentTaskQueueProps) {
  // rAF tick so the elapsed-time labels live-update + we react to imperative
  // hover/select changes in officeState (which don't go through React state).
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const loop = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [])
  void tick

  const id = officeState.selectedAgentId ?? officeState.hoveredAgentId
  if (id === null) return null
  // Sub-agents don't have entries in agentTools (their tools live in
  // subagentTools); the office canvas already labels them.
  const ch = officeState.characters.get(id)
  if (!ch || ch.isSubagent) return null

  // Drop Task/Agent tool_uses that delegate to a sub-agent — those are
  // already represented as their own characters (with their own popups
  // and tethers to the parent). Showing them in the main agent's queue
  // double-counts the work; the user reads the chair-row spawn as the
  // "this is happening" signal, not a queue line.
  //
  // Drop completed tools too — when the turn wraps up the cards used to
  // linger as faded entries, which made the queue panel look busy even
  // when the agent was idle. The queue should only show what's actually
  // *in flight*; history belongs in the JSONL.
  const tools = (agentTools[id] ?? []).filter(
    (t) => !t.done && !t.status.startsWith('Subtask'),
  )
  // Newest-first so a fresh tool surfaces at the top of the stack.
  const sorted = [...tools].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  if (sorted.length === 0) return null
  const visible = sorted.slice(0, MAX_CARDS)
  const overflow = sorted.length - visible.length

  const now = Date.now()
  const isFocused = officeState.selectedAgentId === id

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        pointerEvents: 'none',
        zIndex: 'var(--pixel-overlay-z)',
        maxWidth: 220,
      }}
    >
      <div
        style={{
          fontSize: '10px',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: 'var(--pixel-text-dim, rgba(255,255,255,0.65))',
          padding: '0 2px',
        }}
      >
        Queue · {isFocused ? 'selected' : 'hover'}
      </div>
      {visible.map((t) => {
        const elapsed = elapsedLabel(t.startedAt, now)
        const accent = t.permissionWait
          ? 'var(--pixel-status-permission)'
          : t.done
            ? 'var(--pixel-border)'
            : 'var(--pixel-status-active)'
        return (
          <div
            key={t.toolId}
            style={{
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderLeft: `4px solid ${accent}`,
              borderRadius: 0,
              padding: '4px 6px',
              boxShadow: 'var(--pixel-shadow)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              opacity: t.done ? 0.55 : 1,
            }}
          >
            <div
              style={{
                fontSize: '12px',
                color: 'var(--vscode-foreground, var(--pixel-text))',
                lineHeight: 1.25,
                wordBreak: 'break-word',
              }}
            >
              {t.status}
            </div>
            {(elapsed || t.outputTokens) && (
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  fontSize: '10px',
                  color: 'var(--pixel-text-dim, rgba(255,255,255,0.6))',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {elapsed && <span>{elapsed}</span>}
                {t.outputTokens && t.outputTokens > 0 && (
                  <span>+{t.outputTokens.toLocaleString()}t</span>
                )}
                {t.permissionWait && <span style={{ color: accent }}>wait</span>}
              </div>
            )}
          </div>
        )
      })}
      {overflow > 0 && (
        <div
          style={{
            fontSize: '10px',
            color: 'var(--pixel-text-dim, rgba(255,255,255,0.55))',
            padding: '0 2px',
          }}
        >
          +{overflow} more
        </div>
      )}
    </div>
  )
}
