#!/usr/bin/env python3
"""Claude Code UserPromptSubmit hook: warn Claude when 7-day usage runs ahead
of the weekday pace (BEHAVIOR_SPEC §3).

Reads the cache the status line writes (~/.pixel-agents/rate-limits.json) and
never queries usage itself. Prints one line only when 7d usage is above the
weekday pace; otherwise prints nothing, so it costs no tokens. Any error is
swallowed: a usage hint must never block a prompt.

The pace is also computed in webview-ui/src/office/usage.ts
(weekdayPaceBaseline). Both are checked against
webview-ui/src/__tests__/fixtures/pace-cases.json by pace.test.ts.

Test entry points:
  usage-pace.py --pace RESETS_AT_MS NOW_MS   print the pace (0-100)
  usage-pace.py --line CACHE_FILE NOW_MS     print the hook line, if any
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta

CACHE_FILE = os.path.join(os.path.expanduser("~"), ".pixel-agents", "rate-limits.json")
WINDOW_SECONDS = 7 * 24 * 3600
WEEKDAY_NAMES = ["월", "화", "수", "목", "금", "토", "일"]


def weekday_seconds(start: float, end: float) -> float:
    """Seconds of Monday-Friday local time inside [start, end), stepping by
    local calendar day so daylight-saving days count as their real length."""
    total = 0.0
    cursor = datetime.fromtimestamp(start)
    end_dt = datetime.fromtimestamp(end)
    while cursor < end_dt:
        next_midnight = datetime(cursor.year, cursor.month, cursor.day) + timedelta(days=1)
        stop = min(next_midnight, end_dt)
        if cursor.weekday() < 5:
            total += stop.timestamp() - cursor.timestamp()
        cursor = next_midnight
    return total


def weekday_pace(resets_at: float, now: float) -> float:
    start = resets_at - WINDOW_SECONDS
    total = weekday_seconds(start, resets_at)
    if total <= 0:
        return 0.0
    clamped = min(max(now, start), resets_at)
    return weekday_seconds(start, clamped) / total * 100


def hook_line(cache: dict, now: float) -> str | None:
    seven = cache.get("sevenDay") or {}
    used = seven.get("usedPercentage")
    resets_at = seven.get("resetsAt")
    if not isinstance(used, (int, float)) or not isinstance(resets_at, (int, float)):
        return None
    # A reading whose window has already reset needs no separate check: the
    # pace is pinned at 100 then, and a rate-limit percentage never exceeds it.
    pace = weekday_pace(resets_at, now)
    if used <= pace:
        return None
    reset = datetime.fromtimestamp(resets_at)
    return (
        f"[사용량] 7일 사용률 {round(used)}%가 평일 기준선 {round(pace)}%보다 "
        f"{round(used - pace)}%p 앞서 있습니다 (리셋 {WEEKDAY_NAMES[reset.weekday()]} {reset:%H:%M}). "
        "이 속도면 리셋 전에 한도가 바닥날 수 있으니 서브에이전트와 대량 읽기를 줄이고 "
        "꼭 필요한 작업부터 하십시오."
    )


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "--pace":
        print(f"{weekday_pace(int(argv[2]) / 1000, int(argv[3]) / 1000):.6f}")
        return 0
    if len(argv) == 4 and argv[1] == "--line":
        with open(argv[2]) as f:
            line = hook_line(json.load(f), int(argv[3]) / 1000)
        if line:
            print(line)
        return 0
    try:
        sys.stdin.read()
        with open(CACHE_FILE) as f:
            line = hook_line(json.load(f), time.time())
        if line:
            print(line)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
