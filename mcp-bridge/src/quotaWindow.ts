/**
 * Rolling 5-hour token-usage window — what the user calls "the rate
 * limit %" in the office HUD.
 *
 * Anthropic's account-level quota resets on a sliding 5h window, but
 * neither the CLI nor Desktop expose a clean "% of quota used" API.
 * What they DO expose, free of charge, is per-turn token usage in
 * `~/.claude/projects/<proj>/<session>.jsonl`. We scan every recently
 * touched .jsonl on a 1-minute tick, sum the assistant-turn usage for
 * timestamps inside the last 5 hours, and divide by a configurable
 * plan budget (default 1M tokens, override via
 * `PIXEL_OFFICE_5H_TOKEN_BUDGET`).
 *
 * Why not call Anthropic's rate-limit API directly? Would require an
 * Anthropic key in the bridge's environment, key-management UX, and
 * another network egress path — the user explicitly asked for the
 * "script-like" version that just reads the files we already have.
 *
 * Accuracy notes:
 *   - The sum reflects every CLI + Desktop session on this machine
 *     under one Anthropic account, which is the right granularity
 *     for "how close am I to the 5h cutoff".
 *   - Budget is a per-plan constant we can't probe — Pro/Team/
 *     Enterprise differ. The default is the published Pro figure;
 *     users on other plans set the env var.
 *   - Output tokens count too (Anthropic bills them against quota).
 *   - Buckets are weighted by `QUOTA_WEIGHTS` (cache reads 0.10x, cache
 *     writes 1.25x). A raw sum is ~99% cache reads and describes how much
 *     history is being re-read, not how much quota is being spent.
 *   - One API response is written as SEVERAL `assistant` lines (one per
 *     content-block group), each repeating the same `message.usage` and the
 *     same `message.id`. Summing lines double-counts most turns, so we key on
 *     `message.id` and count each response once — across the whole scan, since
 *     a resumed session replays earlier responses into a new file.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { QUOTA_WINDOW_MS, DEFAULT_5H_TOKEN_BUDGET, QUOTA_WEIGHTS } from "./spec.js"

const FIVE_HOURS_MS = QUOTA_WINDOW_MS
const DEFAULT_5H_BUDGET = DEFAULT_5H_TOKEN_BUDGET

export interface QuotaWindow {
  tokensUsed: number
  budget: number
  pct: number
}

function parseBudget(): number {
  const raw = process.env["PIXEL_OFFICE_5H_TOKEN_BUDGET"]
  if (!raw) return DEFAULT_5H_BUDGET
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_5H_BUDGET
}

/** Scan every project's recent .jsonl files, sum assistant-turn usage
 *  whose `timestamp` falls inside the last 5h. Resilient to partial
 *  files / unreadable lines — anything that fails to parse is just
 *  skipped, never thrown. Synchronous so the caller's tick stays a
 *  simple `setInterval(fn, 60_000)` — the I/O is local fs and the
 *  whole scan is well under a frame on a typical workstation. */
export function calculateQuotaWindow(): QuotaWindow {
  const cutoff = Date.now() - FIVE_HOURS_MS
  const baseDir = join(homedir(), ".claude", "projects")
  const budget = parseBudget()
  const counted = new Set<string>()
  let tokensUsed = 0

  let projects: string[]
  try {
    projects = readdirSync(baseDir)
  } catch {
    return { tokensUsed: 0, budget, pct: 0 }
  }

  for (const proj of projects) {
    const projDir = join(baseDir, proj)
    let files: string[]
    try {
      files = readdirSync(projDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const path = join(projDir, file)
      // Cheap early-exit: an entire file whose mtime is older than the
      // cutoff can't contribute any in-window rows. Saves the read for
      // sessions the user touched days ago.
      try {
        if (statSync(path).mtimeMs < cutoff) continue
      } catch {
        continue
      }
      let content: string
      try {
        content = readFileSync(path, "utf8")
      } catch {
        continue
      }
      for (const line of content.split("\n")) {
        if (!line) continue
        let d: {
          type?: string
          timestamp?: string
          uuid?: string
          message?: { id?: string; usage?: Record<string, number> }
        }
        try {
          d = JSON.parse(line)
        } catch {
          continue
        }
        if (d.type !== "assistant") continue
        const ts = d.timestamp ? Date.parse(d.timestamp) : NaN
        if (!Number.isFinite(ts) || ts < cutoff) continue
        const u = d.message?.usage
        if (!u) continue
        const key = d.message?.id ?? d.uuid
        if (!key || counted.has(key)) continue
        counted.add(key)
        tokensUsed +=
          (u.input_tokens ?? 0) * QUOTA_WEIGHTS.input_tokens +
          (u.cache_creation_input_tokens ?? 0) * QUOTA_WEIGHTS.cache_creation_input_tokens +
          (u.cache_read_input_tokens ?? 0) * QUOTA_WEIGHTS.cache_read_input_tokens +
          (u.output_tokens ?? 0) * QUOTA_WEIGHTS.output_tokens
      }
    }
  }

  const weighted = Math.round(tokensUsed)
  const pct = budget > 0 ? Math.min(100, (weighted / budget) * 100) : 0
  return { tokensUsed: weighted, budget, pct }
}
