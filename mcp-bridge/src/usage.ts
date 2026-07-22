/**
 * Helpers for extracting context-window usage from JSONL `assistant`
 * events. Anthropic writes a `usage` block alongside every assistant
 * turn that contains the exact token counts the model saw — far more
 * accurate than file-size heuristics, and shared by both Claude
 * Desktop audit logs and Claude Code project transcripts.
 *
 * Used by the JSONL watchers to auto-fill the office HUD without
 * relying on Claude to self-report via the `office_status` MCP tool.
 */

export interface AssistantUsage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

/**
 * Sum of cached + non-cached input tokens — the number that counts
 * toward the model's context budget at this turn. Returns null when
 * the usage block is missing or empty (partial events, streaming
 * artefacts) so callers can skip the patch.
 */
export function contextTokensFromUsage(
  usage: AssistantUsage | undefined | null,
): number | null {
  if (!usage) return null
  const total =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  return total > 0 ? total : null
}

/**
 * Truncate a single-line summary of a tool's input parameters to fit
 * inside the per-character status overlay. Keeps the leading
 * tool-identifying field (command, file path, query, etc.) and clips
 * the rest with an ellipsis when it would overflow the typical
 * `${toolName}: ${summary}` budget (~60 chars total).
 */
export function shortInputSummary(
  input: Record<string, unknown> | undefined | null,
  maxLen = 50,
): string {
  if (!input) return ""
  // Priority order tuned for the common Claude tool surface — pick
  // whichever lands first so Bash shows the command, Read/Write shows
  // the path, Task shows its description, etc.
  const KEYS = [
    "command",        // Bash
    "file_path",      // Read / Write / Edit / NotebookEdit
    "path",           // Grep / Glob
    "pattern",        // Grep / Glob (when path absent)
    "url",            // WebFetch
    "query",          // WebSearch
    "description",    // Task
    "prompt",         // Task (when description absent)
  ]
  let raw = ""
  for (const k of KEYS) {
    const v = input[k]
    if (typeof v === "string" && v.trim()) {
      raw = v.trim()
      break
    }
  }
  if (!raw) return ""
  // Collapse internal whitespace so multi-line bash heredocs and long
  // prompts render as a single readable line.
  const flat = raw.replace(/\s+/g, " ").trim()
  if (flat.length <= maxLen) return flat
  return `${flat.slice(0, maxLen - 1)}…`
}

/**
 * Approximate context-window cap (tokens) for a given Anthropic model
 * id. Used to scale the HUD percentage so Opus 4.x's 1M window doesn't
 * read as "90% full" when only 18% is used. Returns 200K as the safe
 * default — accurate for Sonnet/Haiku 4.x and Claude 3.x.
 */
export function contextWindowFor(modelId: string | undefined | null): number {
  if (!modelId) return 200_000
  const id = modelId.toLowerCase()
  // Claude 5 family (Fable/Mythos/Sonnet 5) ships a 1M context window.
  if (id.includes("fable") || id.includes("mythos")) return 1_000_000
  // Opus 4.x ships with a 1M context window. Older Opus models keep
  // the 200K default.
  if (id.includes("opus") && /opus-4/.test(id)) return 1_000_000
  // Sonnet 5 / Sonnet 4.6 ship 1M; older Sonnets stay conservative 200K.
  if (/sonnet-5/.test(id) || /sonnet-4-6/.test(id)) return 1_000_000
  return 200_000
}
