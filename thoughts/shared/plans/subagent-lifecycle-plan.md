# Feature Plan: Sub-Agent Lifecycle & Max Character Limit
Created: 2026-03-18
Author: architect-agent

## Overview

Refine the sub-agent (Task/Agent tool) character lifecycle so that: main agents never auto-despawn, sub-agents auto-despawn 60 seconds after their work completes, and a maximum of 6 visible character sprites are enforced on screen. This requires fixing the current idle despawn logic which incorrectly applies to main agents and does NOT apply to sub-agents.

## Current Behavior Analysis (VERIFIED)

### 1. How sub-agents are currently created and destroyed

**Creation flow:**
- Backend (`TranscriptParser.kt:98-102`): When a `tool_use` block with name "Task" or "Agent" is detected, `agentToolStart` is sent to webview with status prefixed `"Subtask: ..."`.
- Webview (`useExtensionMessages.ts:178-186`): On `agentToolStart`, if `status.startsWith('Subtask:')`, calls `os.addSubagent(parentAgentId, toolId)` which creates a Character with negative ID, `isSubagent=true`, diverse palette, spawn effect, and closest seat to parent.
- Sub-agent gets tool updates via `subagentToolStart`/`subagentToolDone` messages.

**Destruction flow:**
- Backend (`TranscriptParser.kt:128-134`): When `tool_result` for a Task/Agent tool arrives in `processUserRecord`, sends `subagentClear` message.
- Webview (`useExtensionMessages.ts:310-328`): On `subagentClear`, calls `os.removeSubagent(parentAgentId, parentToolId)` which triggers despawn animation, then character is deleted.
- Also destroyed when parent agent closes (`agentClosed` handler calls `os.removeAllSubagents(id)`) or all tools clear (`agentToolsClear`).

**Key finding:** Sub-agents are **immediately despawned** when their Task tool completes — there is NO 60-second delay. They get the matrix despawn animation (~0.3s) and vanish.

### 2. Is there a max character limit?

**NO.** There is no maximum character limit anywhere in the codebase. Characters are added without any cap check. The `CHAR_COUNT = 6` constant in `Constants.kt:29` only refers to the number of pre-colored character sprite PNGs (char_0 to char_5), not a display limit.

### 3. Current despawn logic — differentiation between main vs sub-agents

In `characters.ts:97-105`:
```typescript
if (ch.isActive) {
    ch.idleTimer = 0
} else if (!ch.isSubagent && ch.matrixEffect === null) {
    ch.idleTimer += dt
    if (ch.idleTimer >= IDLE_DESPAWN_SEC) {
        return 'despawn'
    }
}
```

**BUG FOUND:** The idle despawn timer (`IDLE_DESPAWN_SEC = 60s`) applies to **main agents** (`!ch.isSubagent`), NOT to sub-agents. This is backwards from the requirements:
- Main agents (positive IDs) WILL auto-despawn after 60s idle — **WRONG**, they should never despawn.
- Sub-agents (negative IDs, `isSubagent=true`) are EXCLUDED from idle despawn — **WRONG**, they should despawn after completion.

However, sub-agents are already immediately removed when `subagentClear` fires, so the idle timer never matters for them in practice.

### 4. Where does the idle/despawn timer live?

- `idleTimer` field: `Character` interface (`types.ts:199`), initialized to 0 in `createCharacter()` (`characters.ts:77`).
- Timer logic: `updateCharacter()` in `characters.ts:97-105`.
- Despawn constant: `IDLE_DESPAWN_SEC = 60.0` in `webview-ui/src/constants.ts:20`.
- Despawn handling: `OfficeState.update()` (`officeState.ts:660-665`) catches `'despawn'` return and triggers matrix effect.

### 5. Bugs found in current sub-agent lifecycle

| Bug | Location | Impact |
|-----|----------|--------|
| **Main agents auto-despawn after 60s idle** | `characters.ts:100-104` | Main agents disappear from screen when idle for 60s. They should NEVER despawn — they persist as long as their terminal/session exists. |
| **No max character limit** | `officeState.ts:addAgent/addSubagent` | Unlimited characters can be created, no enforcement of 6-character max |
| **Sub-agents despawn instantly, not after 60s** | `useExtensionMessages.ts:326` | `subagentClear` immediately removes the sub-agent. Requirement says 60s delay after work completes. |
| **Idle timer skips sub-agents** | `characters.ts:100` | The `!ch.isSubagent` condition prevents sub-agents from ever accumulating idle time |
| **No queue for excess agents** | N/A | When 6 characters are visible, new agents/sub-agents have nowhere to go |

## Requirements Checklist

- [ ] Sub-agents (from Task/Agent tool) behave as full agent characters on screen (ALREADY WORKS - they get sprites, seats, tool animations, bubbles)
- [ ] Maximum 6 character sprites visible on screen at once
- [ ] Main agents NEVER auto-despawn — persist as long as terminal/session exists
- [ ] Sub-agents auto-despawn 60 seconds after work completes (tool_result received)
- [ ] Fix the current idle despawn bug (applies to main agents instead of sub-agents)

## Design

### Architecture

```
Backend (Kotlin)                    Webview (TypeScript)
─────────────────                   ────────────────────
TranscriptParser                    useExtensionMessages
  ├─ agentToolStart ──────────────→  creates sub-agent character
  ├─ subagentToolStart ───────────→  updates sub-agent tool/active state
  ├─ subagentToolDone ────────────→  marks tool done
  └─ subagentClear ──────────────→  marks sub-agent COMPLETED (NEW: starts 60s timer)
                                         │
                                    OfficeState.update() (each frame)
                                      ├─ Main agents: NEVER despawn (idleTimer removed)
                                      ├─ Sub-agents: despawn after 60s post-completion
                                      └─ Character cap: queue new agents when at 6
```

### Data Flow: Sub-agent 60s delayed despawn

1. `subagentClear` message received
2. Instead of calling `os.removeSubagent()` immediately, call new `os.markSubagentCompleted(parentId, toolId)`
3. `markSubagentCompleted()` sets `ch.isActive = false` and `ch.completedAt = Date.now()` (or starts `ch.idleTimer` from 0)
4. In `updateCharacter()`, sub-agents with `isSubagent && !isActive` accumulate `idleTimer`
5. When `idleTimer >= IDLE_DESPAWN_SEC`, return `'despawn'`
6. `OfficeState.update()` triggers matrix despawn effect, then deletes character

### Data Flow: Max 6 character enforcement

1. Before adding any character (agent or sub-agent), check `characters.size`
2. If at max, queue the request
3. When a character despawns, dequeue and create the next pending character
4. Main agents take priority over sub-agents in the queue

## Dependencies

| Dependency | Type | Reason |
|------------|------|--------|
| Character interface | Internal | Add `completedAt` or reuse `idleTimer` |
| constants.ts | Internal | Already has `IDLE_DESPAWN_SEC = 60` |
| OfficeState | Internal | Core changes to add/remove logic |
| characters.ts | Internal | Fix idle timer logic |
| useExtensionMessages.ts | Internal | Change subagentClear handling |

## Implementation Phases

### Phase 1: Fix main agent despawn bug (CRITICAL)
**Files to modify:**
- `webview-ui/src/office/engine/characters.ts` — Remove idle despawn for main agents

**Change:**
```typescript
// characters.ts, updateCharacter(), lines 97-105
// BEFORE:
if (ch.isActive) {
    ch.idleTimer = 0
} else if (!ch.isSubagent && ch.matrixEffect === null) {
    ch.idleTimer += dt
    if (ch.idleTimer >= IDLE_DESPAWN_SEC) {
        return 'despawn'
    }
}

// AFTER:
if (ch.isActive) {
    ch.idleTimer = 0
} else if (ch.isSubagent && ch.isCompleted && ch.matrixEffect === null) {
    // Only sub-agents despawn after idle timeout post-completion
    ch.idleTimer += dt
    if (ch.idleTimer >= IDLE_DESPAWN_SEC) {
        return 'despawn'
    }
}
```

**Acceptance:**
- [ ] Main agents never auto-despawn regardless of idle time
- [ ] Sub-agents still subject to timed despawn

**Estimated effort:** Small

### Phase 2: Add `isCompleted` field to Character
**Files to modify:**
- `webview-ui/src/office/types.ts` — Add `isCompleted: boolean` to `Character` interface
- `webview-ui/src/office/engine/characters.ts` — Initialize `isCompleted: false` in `createCharacter()`

**Change in types.ts:**
```typescript
// Add to Character interface:
/** Whether this sub-agent has completed its work (Task tool returned result) */
isCompleted: boolean
```

**Acceptance:**
- [ ] Field added, initialized to `false`
- [ ] TypeScript compiles

**Estimated effort:** Small

### Phase 3: Delayed sub-agent despawn
**Files to modify:**
- `webview-ui/src/office/engine/officeState.ts` — Add `markSubagentCompleted()` method
- `webview-ui/src/hooks/useExtensionMessages.ts` — Change `subagentClear` handler

**New method in OfficeState:**
```typescript
/** Mark a sub-agent as completed — it will auto-despawn after IDLE_DESPAWN_SEC */
markSubagentCompleted(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`
    const id = this.subagentIdMap.get(key)
    if (id === undefined) return
    const ch = this.characters.get(id)
    if (!ch) return
    ch.isCompleted = true
    ch.isActive = false
    ch.idleTimer = 0 // Start counting from completion
    ch.currentTool = null
    // Clean up tracking maps so the key can be reused
    this.subagentIdMap.delete(key)
    this.subagentMeta.delete(id)
}
```

**Change in useExtensionMessages.ts `subagentClear` handler:**
```typescript
// BEFORE (line 326):
os.removeSubagent(id, parentToolId)

// AFTER:
os.markSubagentCompleted(id, parentToolId)
```

**Also need to update `OfficeState.update()`** to clean up completed sub-agents after despawn:
- When a despawned character is deleted, if it was a sub-agent, also clean up `subagentIdMap` and `subagentMeta` entries (already handled since `markSubagentCompleted` cleans those maps immediately).

**Acceptance:**
- [ ] Sub-agents stay visible for 60s after task completion
- [ ] Sub-agents wander/idle during the 60s delay
- [ ] After 60s, matrix despawn animation plays
- [ ] Despawn sound plays when animation completes

**Estimated effort:** Medium

### Phase 4: Max 6 character limit
**Files to modify:**
- `webview-ui/src/constants.ts` — Add `MAX_VISIBLE_CHARACTERS = 6`
- `webview-ui/src/office/engine/officeState.ts` — Add queue logic to `addAgent()` and `addSubagent()`

**New constant:**
```typescript
export const MAX_VISIBLE_CHARACTERS = 6
```

**Queue design in OfficeState:**
```typescript
// New fields:
private pendingAgentQueue: Array<{
    type: 'main' | 'sub'
    // For main agents:
    id?: number
    palette?: number
    hueShift?: number
    seatId?: string | null
    skipSpawnEffect?: boolean
    // For sub-agents:
    parentAgentId?: number
    parentToolId?: string
}> = []

// In addAgent() — gate on character count:
addAgent(id, ...): void {
    const visibleCount = this.countVisibleCharacters()
    if (visibleCount >= MAX_VISIBLE_CHARACTERS) {
        this.pendingAgentQueue.push({ type: 'main', id, palette, ... })
        return
    }
    // ... existing logic
}

// In addSubagent() — gate on character count:
addSubagent(parentAgentId, parentToolId): number {
    const visibleCount = this.countVisibleCharacters()
    if (visibleCount >= MAX_VISIBLE_CHARACTERS) {
        this.pendingAgentQueue.push({ type: 'sub', parentAgentId, parentToolId })
        return -999 // sentinel: queued, not yet created
    }
    // ... existing logic
}

// Count only non-despawning characters:
private countVisibleCharacters(): number {
    let count = 0
    for (const ch of this.characters.values()) {
        if (ch.matrixEffect !== 'despawn') count++
    }
    return count
}

// In update() after deleting despawned characters, try to dequeue:
private tryDequeue(): void {
    while (this.pendingAgentQueue.length > 0 && this.countVisibleCharacters() < MAX_VISIBLE_CHARACTERS) {
        // Prioritize main agents
        const mainIdx = this.pendingAgentQueue.findIndex(p => p.type === 'main')
        const idx = mainIdx >= 0 ? mainIdx : 0
        const pending = this.pendingAgentQueue.splice(idx, 1)[0]
        if (pending.type === 'main') {
            this.addAgent(pending.id!, pending.palette, pending.hueShift, pending.seatId ?? undefined, pending.skipSpawnEffect)
        } else {
            this.addSubagent(pending.parentAgentId!, pending.parentToolId!)
        }
    }
}
```

**Edge case:** When a main agent is queued and its terminal closes, remove it from the queue too.

**Acceptance:**
- [ ] Never more than 6 non-despawning characters visible
- [ ] Main agents prioritized over sub-agents in queue
- [ ] Queued agents appear as slots open up
- [ ] Closing a queued main agent removes it from queue

**Estimated effort:** Medium-Large

### Phase 5: Edge case handling & cleanup
**Files to modify:**
- `webview-ui/src/hooks/useExtensionMessages.ts` — Handle `agentClosed` for queued agents
- `webview-ui/src/office/engine/officeState.ts` — Handle `agentToolsClear` for completed sub-agents

**Edge cases:**
1. Parent agent closes while sub-agent is in 60s completion period → sub-agent should immediately despawn (already handled by `removeAllSubagents`)
2. `agentToolsClear` fires while sub-agent is in completion period → should force immediate despawn
3. Multiple sub-agents from same parent → each gets independent 60s timer
4. Agent closes while queued → remove from queue, don't create character

**Also:** The `subagentCharacters` React state array should NOT remove the entry on `subagentClear` anymore (since the character is still visible). Remove it when the character actually despawns. This requires a new message or callback from `OfficeState.update()` when completed sub-agents finish despawning.

**Acceptance:**
- [ ] Parent close triggers immediate sub-agent despawn
- [ ] No zombie characters in edge cases
- [ ] React state stays in sync with OfficeState

**Estimated effort:** Small-Medium

### Phase 6: Testing & verification
**Manual test scenarios:**
- [ ] Create 1 main agent, idle 120s → should NOT despawn
- [ ] Create main agent, run Task tool → sub-agent appears with spawn effect
- [ ] Sub-agent completes → stays visible, wanders for ~60s → despawns with matrix effect
- [ ] Create 7 agents → 7th is queued, appears when one despawns
- [ ] Close main agent while sub-agent in 60s window → sub-agent despawns immediately
- [ ] Create 6 main agents + trigger sub-agent → sub-agent queued → close 1 main → sub-agent appears

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Queue sentinel ID (-999) conflicts with sub-agent ID space | Medium | Use a separate "queued" flag/set instead of sentinel ID; return null from addSubagent when queued |
| React state desync when sub-agents linger | Medium | Add callback/event when completed sub-agents actually despawn to update `subagentCharacters` state |
| Completed sub-agents still respond to tool messages | Low | The `subagentIdMap` is already cleaned on completion, so no toolId→subId lookup possible |
| Performance with many queued agents | Low | Queue is small (realistically <10 items); dequeue is O(n) which is fine |

## Open Questions

- [ ] Should queued agents show in the UI somehow? (e.g., a counter "2 agents queued")
- [ ] Should there be a setting to configure MAX_VISIBLE_CHARACTERS? (probably not for v1)
- [ ] When a completed sub-agent is wandering, should clicking it focus the parent terminal? (current behavior: yes, via parentAgentId)
- [ ] Should the 60s timer reset if the parent agent starts a new turn? (probably not — sub-agent's work is done)

## Success Criteria

1. Main agents never auto-despawn regardless of how long they are idle
2. Sub-agents remain visible for exactly 60 seconds after Task tool completes, then despawn with matrix effect
3. At most 6 character sprites are visible (non-despawning) at any time
4. No visual glitches or state desync during sub-agent completion → despawn transition
5. All edge cases (parent close, tools clear, queue overflow) handled gracefully
