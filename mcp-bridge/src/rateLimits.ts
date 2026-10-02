/**
 * Real 5h / 7d rate-limit usage for the HUD (BEHAVIOR_SPEC §3).
 *
 * Two sources report the account's actual usage percentage:
 *   - Claude Code statusline input (`rate_limits.*`), which
 *     `~/.claude/scripts/status.py` copies to `~/.pixel-agents/rate-limits.json`.
 *     Carries `resetsAt`, so a reading stays valid until its window resets:
 *     usage cannot drop before then, so an old value is still a lower bound.
 *   - Claude Desktop's own `plan-usage-history.json`, sampled every 15 min
 *     (`u.fh` = 5h %, `u.sd` = 7d %). No reset time, so only a recent sample
 *     is trusted.
 * When both are valid the more recently measured one wins. When neither is,
 * the HUD falls back to the weighted JSONL token sum (`quotaWindow.ts`).
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, platform } from "node:os"
import { DESKTOP_USAGE_SAMPLE_MAX_AGE_MS } from "./spec.js"

export interface RateLimitReading {
  fiveHourPct: number
  sevenDayPct: number | null
  /** Epoch ms when the 5h window resets; null when the source doesn't say. */
  resetsAt: number | null
  /** Epoch ms when the 7d window resets — the HUD derives its pace baseline
   *  from it. Null when the source doesn't say (Desktop). */
  sevenDayResetsAt: number | null
  source: "cli" | "desktop"
  /** Epoch ms when the source measured this value. */
  sampledAt: number
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

export function parseCliRateLimits(raw: string, now: number): RateLimitReading | null {
  let d: { updatedAt?: unknown; fiveHour?: { usedPercentage?: unknown; resetsAt?: unknown }; sevenDay?: { usedPercentage?: unknown; resetsAt?: unknown } | null }
  try {
    d = JSON.parse(raw)
  } catch {
    return null
  }
  const pct = d.fiveHour?.usedPercentage
  const resetsSec = d.fiveHour?.resetsAt
  if (!isNum(pct) || !isNum(resetsSec) || !isNum(d.updatedAt)) return null
  const resetsAt = resetsSec * 1000
  if (resetsAt <= now) return null
  const seven = d.sevenDay?.usedPercentage
  const sevenResetsSec = d.sevenDay?.resetsAt
  return {
    fiveHourPct: pct,
    sevenDayPct: isNum(seven) ? seven : null,
    resetsAt,
    sevenDayResetsAt: isNum(sevenResetsSec) ? sevenResetsSec * 1000 : null,
    source: "cli",
    sampledAt: d.updatedAt,
  }
}

export function parseDesktopUsageHistory(raw: string, now: number): RateLimitReading | null {
  let d: { samples?: Array<{ t?: unknown; u?: { fh?: unknown; sd?: unknown } }> }
  try {
    d = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(d.samples)) return null
  let latest: { t: number; fh: number; sd: unknown } | null = null
  for (const s of d.samples) {
    if (!isNum(s?.t) || !isNum(s.u?.fh)) continue
    if (!latest || s.t > latest.t) latest = { t: s.t, fh: s.u.fh, sd: s.u.sd }
  }
  if (!latest || now - latest.t > DESKTOP_USAGE_SAMPLE_MAX_AGE_MS) return null
  return {
    fiveHourPct: latest.fh,
    sevenDayPct: isNum(latest.sd) ? latest.sd : null,
    resetsAt: null,
    sevenDayResetsAt: null,
    source: "desktop",
    sampledAt: latest.t,
  }
}

export function pickRateLimit(
  cli: RateLimitReading | null,
  desktop: RateLimitReading | null,
): RateLimitReading | null {
  if (!cli) return desktop
  if (!desktop) return cli
  return desktop.sampledAt > cli.sampledAt ? desktop : cli
}

function desktopUsageHistoryPath(): string | null {
  const home = homedir()
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Claude", "plan-usage-history.json")
  if (platform() === "win32") {
    const appData = process.env["APPDATA"]
    return appData ? join(appData, "Claude", "plan-usage-history.json") : null
  }
  if (platform() === "linux") return join(home, ".config", "Claude", "plan-usage-history.json")
  return null
}

function readOrNull(path: string | null): string | null {
  if (!path) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export function readRateLimit(now: number = Date.now()): RateLimitReading | null {
  const cliRaw = readOrNull(join(homedir(), ".pixel-agents", "rate-limits.json"))
  const desktopRaw = readOrNull(desktopUsageHistoryPath())
  return pickRateLimit(
    cliRaw ? parseCliRateLimits(cliRaw, now) : null,
    desktopRaw ? parseDesktopUsageHistory(desktopRaw, now) : null,
  )
}
