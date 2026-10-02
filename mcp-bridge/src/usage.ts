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
 * Tier + major/minor version parsed out of a Claude model id. Handles the
 * modern `claude-<tier>-<major>[-<minor>]` form and the legacy inverted
 * `claude-<major>[-<minor>]-<tier>` form. A 3+ digit segment is a date
 * suffix, not a version, so it is rejected.
 *
 * Kept in sync with `webview-ui/src/office/usage.ts` — the bridge does not
 * import the webview module.
 */
export interface ParsedModel {
  tier: "fable" | "mythos" | "opus" | "sonnet" | "haiku" | ""
  major: number
  minor: number
}

const TIER_RE = /(fable|mythos|opus|sonnet|haiku)/
const MODERN_RE = /(?:fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2})(?!\d))?/
const LEGACY_RE = /(\d{1,2})(?:-(\d{1,2}))?-(?:fable|mythos|opus|sonnet|haiku)/

export function parseModelId(modelId: string | undefined | null): ParsedModel {
  const none: ParsedModel = { tier: "", major: 0, minor: 0 }
  if (!modelId) return none
  const id = modelId.toLowerCase()
  const tierMatch = TIER_RE.exec(id)
  if (!tierMatch) return none
  const tier = tierMatch[1] as ParsedModel["tier"]
  const legacy = LEGACY_RE.exec(id)
  if (legacy) return { tier, major: Number(legacy[1]), minor: Number(legacy[2] ?? 0) }
  const modern = MODERN_RE.exec(id)
  if (modern) return { tier, major: Number(modern[1]), minor: Number(modern[2] ?? 0) }
  return { tier, major: 0, minor: 0 }
}

/**
 * Context-window cap (tokens) for a Claude model id. Fable/Mythos 5.x,
 * Opus 4.6-4.8, Opus 5, Sonnet 5 and Sonnet 4.6 ship 1M; Haiku, the Claude
 * 3.x generation and anything unrecognised stay at the 200K default.
 */
export function contextWindowFor(modelId: string | undefined | null): number {
  const { tier, major, minor } = parseModelId(modelId)
  switch (tier) {
    case "fable":
    case "mythos":
      return major >= 5 ? 1_000_000 : 200_000
    case "opus":
      return major >= 4 ? 1_000_000 : 200_000
    case "sonnet":
      if (major >= 5) return 1_000_000
      return major === 4 && minor >= 6 ? 1_000_000 : 200_000
    default:
      return 200_000
  }
}
