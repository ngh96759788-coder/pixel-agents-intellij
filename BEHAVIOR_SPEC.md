# Pixel Office — 의도된 동작 명세 (Behavioral Spec)

> **이 문서는 single source of truth다. 여기 적힌 값/동작을 임의로 바꾸지 마라.**
> 과거에 같은 버그를 반복 수정하면서 매번 임계값을 멋대로(15s/30s, 5min/10min 등)
> 바꾸거나 한 증상만 국소 수정해서 다른 동작을 깨뜨리는 whack-a-mole이 발생했다.
> 코드를 고치기 전에 반드시 이 명세와 대조하고, 명세 자체를 바꿔야 하면
> 사용자 확인을 먼저 받은 뒤 이 문서를 갱신하라.

---

## 1. 환경별 — 누가 무엇을 보여주나

| 환경 | 위젯 | 활동 감지 소스 | 보여줄 범위 (기본) |
|---|---|---|---|
| **Claude Desktop** | Chrome `--app` (mcp-bridge가 spawn) | `main.log`(approval) + `claude.ai-web.log`(tool) + `audit.jsonl`(agent-mode). `~/.claude/projects` JSONL watcher는 **돌지만 전부 `isExternal`로 태깅** — 기본값(통합 보기 OFF)에선 웹뷰가 숨기므로 표시 범위는 Desktop 활동만. 통합 보기 ON 시에만 §4대로 85% 투명 표시 (2026-07-15 문구를 실제 구현에 맞게 갱신) | Desktop 활동만 |
| **Claude Code (CLI)** | 같은 mcp-bridge의 별도 인스턴스 | `~/.claude/projects` JSONL — **own session만** (`--resume`/`--session-id` argv로 PID 추적) | 그 CLI 세션만 |
| **IntelliJ 플러그인** | IDE 툴윈도우 (JCEF, mcp-bridge와 무관) | 자체 file watcher — 그 프로젝트 디렉토리의 JSONL **+ 그 레포의 git worktree 디렉토리들** | 그 프로젝트 + 그 worktree들의 CLI만 |

**원칙: 세 환경은 서로 활동을 섞지 않는다 (기본값).** 통합 보기는 아래 §4 옵션으로만.

---

## 2. 캐릭터 lifecycle (active / idle / despawn)

```
작업 중            →  active (타이핑/읽기 등 작업 모션, 자리에 앉음)
  - tool_use 진행
  - turn 진행 중
  - background Bash(run_in_background:true)가 아직 실행 중      ← 진행 중이면 계속 active

작업 종료          →  idle (wander, 자리 주변 배회)

idle 지속          →  despawn (제거)
  - 서브(sub-agent) 캐릭터:  30초
  - 메인 캐릭터:            60초
```

**핵심 규칙 (절대 변경 금지):**
- **despawn 임계값 = 서브 30초 / 메인 60초.** 그 외 값(15s, 5min 등)은 명세 위반.
- **idle과 despawn을 별도 임계값으로 분리하지 마라.** idle은 그냥 "작업 안 하는 표시 상태"이고, 그 상태가 위 시간만큼 지속되면 despawn한다. 단일 타이머.
- background Bash가 진행 중인 동안은 idle로 떨어지지 않는다 (turn이 `end_turn`으로 끝나도).

---

## 3. 글로벌 HUD (하단)

- **active 캐릭터 수만 카운트한다.** idle 캐릭터는 카운트에서 제외.
- **idle을 나타내는 별도 아이콘(연보라 점 등)을 띄우지 마라.** HUD는 "지금 일하는 수"만.
- **좁은 폭에서 툴바와 겹치지 않는다 (2026-09-30, 사용자 요청).** 하단 왼쪽 툴바(+ Agent / Layout / Settings)는 줄이지 않는다. HUD가 툴바 오른쪽 끝 + 8px 안으로 들어오면 한 단계씩 줄인다: ① `N tok` 숫자 → ② 모델 칩 → ③ 컨텍스트 막대 → ④ 배율 1.6→1.0 → ⑤ HUD 숨김. 폭이나 내용이 바뀌면 전체 HUD부터 다시 맞춘다. 숨겨져도 승인 대기는 캐릭터의 노란 버블(§5)로 보인다. (`hudParts()`, `BottomHUD.tsx`)
- **5h 사용량 표시**: 분마다 갱신. 실제 사용률을 얻을 수 있으면 %로, 없으면 JSONL 가중합을 절대 토큰으로 보여 준다 (2026-09-30, 사용자 승인으로 변경).
  - **실제 사용률 출처 두 가지.** (1) Claude Code statusline 입력의 `rate_limits.five_hour` / `seven_day` (`used_percentage` 0–100, `resets_at` Unix epoch 초). statusline 스크립트(`~/.claude/scripts/status.py`)가 이 값을 `~/.pixel-agents/rate-limits.json`에 쓴다. (2) Claude Desktop이 15분마다 쓰는 `plan-usage-history.json`의 마지막 표본 `u.fh`(5h %) / `u.sd`(7d %). 초기화 시각은 없다. 비공개 파일이라 형식이 바뀌면 읽기를 포기하고 다음 출처로 넘어간다.
  - **유효 조건.** CLI 값은 `resets_at`이 지나지 않았으면 유효하다(나이 제한 없음 — 사용률은 초기화 전에는 줄지 않으므로 오래된 값도 하한으로 맞다). Desktop 값은 표본 나이가 **20분 이하**일 때만 유효하다(측정한 표본 간격 15분 + 여유 5분). 둘 다 유효하면 **더 최근에 잰 값**을 쓴다.
  - **표시 형식: 실제 사용률이 있으면 `5h 14% · 7d 23% (pace 35%)`**, 툴팁에 초기화 시각, 출처, 잰 시각. 7d 값이 없으면 `5h 14%`만, 7d 초기화 시각이 없으면(Desktop 출처) `(pace …)`를 뺀다. **실제 사용률이 없으면 절대 토큰** (예: `1.2M / 5h`). 칩 글자는 영어다(FS Pixel Sans에 한글이 없다).
  - **7d 기준선(pace) = 평일만 센 경과 비율 (2026-10-02, 사용자 승인).** 창 시작 = 7d `resets_at` − 7일. 기준선 = (창 시작부터 지금까지의 월–금 시간) ÷ (창 전체의 월–금 시간) × 100, 로컬 시간 기준. 주말은 시간이 흘러도 기준선이 오르지 않는다. 근거: 2026-09-04~10-01 28일 실측에서 주말 사용량 0%, 평일 비중 17–24%로 고르다. 단순 7등분은 월 09:00에 64%로 뛰어 여유를 실제보다 크게 보인다(평일 기준 50%). 공휴일은 따지지 않는다.
  - **기준선을 넘으면(7d % > pace) 칩을 노란색으로 바꾼다.** 기준선 이하이거나 pace를 못 구하면 기본 파란색.
  - **메시지 훅**: Claude Code `UserPromptSubmit` 훅(`~/.claude/hooks/usage-pace.py`)이 같은 캐시 파일을 읽어, **7d %가 기준선을 넘었을 때만** 메시지 앞에 한 줄을 붙인다. 기준선 이하이면 아무것도 붙이지 않는다(토큰 0). 사용량을 새로 조회하지 않는다 — 조회는 statusline 한 곳, 나머지는 캐시를 읽는다. 기준선 계산은 webview `usage.ts`와 이 훅 두 곳에 있고, 같은 정답표 테스트로 묶여 있다.
  - 이하 가중합 규칙은 폴백 표시에 적용된다.
  - **합산은 버킷별 가중합이다 (2026-09-21, 사용자 승인으로 변경).** 가중치는 공개 과금 배수와 같다 — input ×1.0 / cache write ×1.25 / **cache read ×0.10** / output ×1.0. 상수는 `Constants.QUOTA_WEIGHT_*`(Kotlin)와 `spec.ts`의 `QUOTA_WEIGHTS`(bridge) 두 곳에 있고 **두 값은 같아야 한다**.
  - **가중치 없이 더하면 안 되는 이유(실측 2026-09-17)**: 5h 합계 330.6M 중 cache read 가 **326.7M(98.8%)**, cache write 3.2M(1.0%), output 0.8M(0.2%), input 0.0M. raw 합계는 「리미트까지 얼마나 썼나」가 아니라 「히스토리를 몇 번 다시 읽었나」를 세는 숫자였고, 화면에는 늘 세 자리 M 이 떠서 눈금 구실도 못 했다. 같은 창을 가중합으로 다시 재면 174.2M → 23.4M(13.5%)이다.
  - **폴백이 필요한 이유**: CLI/Desktop JSONL `message.usage`에는 per-turn 사용 토큰만 있고 **5h rate limit 잔여량 필드가 없다** (확인함 — usage 키: input/output/cache_*/service_tier/iterations/speed 등, rate limit 없음). Claude Code는 응답 헤더 `anthropic-ratelimit-unified-*`로 런타임에만 받고 디스크에 안 남김. mcp-bridge는 그 헤더 접근 불가.
  - 따라서 ground truth로 가능한 건 `~/.claude/projects` JSONL의 5h 윈도우 토큰 **가중합**뿐. plan budget(분모)은 정확히 알 수 없어 % 대신 절대 토큰을 표시한다. (`quotaWindow.ts`, `QuotaWindowTracker.kt`)
  - **한 API 응답은 `assistant` 줄 여러 개(text / thinking / tool_use)로 기록되고 모든 줄이 같은 `message.usage`와 같은 `message.id`를 반복한다.** 줄 단위로 더하면 도구를 쓴 턴이 전부 두 번 세어진다(실측 1.9배). `message.id`로 응답당 1회만 셀 것. 이어받기(`--resume`)는 옛 응답을 새 파일에 같은 id로 다시 쓰므로 중복 제거 범위는 파일 하나가 아니라 **스캔 전체**여야 한다.
  - budget을 굳이 쓰려면 `PIXEL_OFFICE_5H_TOKEN_BUDGET` env var. 기본 표시는 절대값.
  - **알려진 한계 (검증 완료, 2026-05-27)**: 순수 Claude Desktop chat(도구 없는 일반 대화)은 `~/.claude/projects`가 아니라 **IndexedDB(`~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb`, 바이너리 LevelDB)**에 기록된다. 따라서 5h 합산에서 **순수 Desktop chat 사용량은 누락**된다. IndexedDB는 바이너리라 안정적 파싱이 불가능(Desktop 업데이트 시 스키마 변동)하므로 이 누락은 의도적으로 수용한다. CLI 활동 + Desktop의 Code subprocess(Skills/project mode) 활동은 `~/.claude/projects`에 쌓이므로 정상 집계된다.

---

## 4. 통합 보기 옵션 (설정) (구현됨 — 2026-07-14, Settings > "Unified View (Show Other Sources)")

"내 작업만 보기" vs "통합 보기" 토글. **외부 출처 캐릭터는 투명도 85%로 구분 표시.**

| 환경 | 토글 OFF (기본) | 토글 ON (통합) |
|---|---|---|
| **IntelliJ 플러그인** | 본인 IntelliJ에서 작업 중인 것만 | + 다른 창 IntelliJ의 Claude CLI, Claude Desktop 작업도 **85% 투명 캐릭터**로 표시 |
| **MCP (Desktop / CLI-연결)** | Claude Desktop(또는 해당 IntelliJ)만 | 마찬가지로 통합, 외부 출처는 85% 투명 |

---

## 5. need approval (승인 대기)

- tool permission prompt가 뜨면 해당 캐릭터에 **노란 버블** 표시.
- 사용자가 Allow/Deny 하면 버블 해제.

---

## 6. layout 공유 (구현됨)

- 기본: 프로젝트별 독립 layout (`~/.pixel-agents/<project-slug>/`)
- "Share Layout Across Projects" 체크박스 ON: 모든 IntelliJ 창이 `~/.pixel-agents/shared/` 공유

---

## 부록: 코드 ↔ 명세 대조 시 자주 틀리는 지점

1. **임계값을 코드에서 읽고 "현재 이 값이 맞나" 확인** — 서브 30s / 메인 60s 인지.
2. **여러 watcher가 같은 캐릭터 상태(status/idle/permission)를 제각각 건드리는 충돌** — main.log / desktop-log / audit / projects watcher가 동시에 "main" 레코드를 수정. 신호 우선순위 또는 단일 상태 결정 경로가 필요.
3. **git worktree 입양은 의도된 동작 — 버그로 오인해 되돌리지 마라.** IntelliJ 플러그인은 열린 레포의 worktree 디렉토리(`git worktree list --porcelain`)를 각자의 `~/.claude/projects/<hash>/`로 매핑해 스캔한다 (IntelliJ 2026.1의 "에이전트에게 작업 위임" = worktree 흐름 대응). 이 worktree 디렉토리들은 `trusted`로 등록되어, 입양 시 `hasOwnClaudeDescendant()` 프로세스-자손 검사를 **건너뛴다** — worktree에 위임된 에이전트가 IDE 프로세스 트리 밖에서 돌 수 있기 때문. 단 `instanceManifest` peer-ownership 검사는 그대로 유지되어 같은 레포를 연 다른 IDE 창과의 중복 입양은 막는다. (글로벌 cross-project 디스커버리를 다시 켠 게 아님 — 열린 레포의 worktree로만 스코프 한정.) worktree 에이전트는 캐릭터 식별 라벨에 `↳branch` 접미사로 어느 브랜치 작업인지 표시 (원래 `⑂`였으나 FS Pixel Sans 폰트에 없어 OS 폴백 폰트로 렌더링되는 문제로 `↳` U+21B3으로 교체, 2026-07-14).
4. **배포 검증 — 가장 많이 당한 지점**: 코드를 고쳐도 Desktop이 도는 bridge는 Extension Dir(`~/Library/Application Support/Claude/Claude Extensions/local.mcpb.pixel-agents.../`)의 복사본이다. 두 가지 함정:
   - **`deploy.sh`의 직접 파일 sync는 Desktop 재시작 시 롤백된다.** Desktop은 자기 설치 레지스트리(마지막으로 *정식 설치한* .mcpb)를 기준으로 재시작 때 Extension Dir을 복원한다. 즉 직접 복사한 새 코드는 다음 Cmd+Q 한 번에 옛 .mcpb로 덮어써진다. (2026-05-28 확인: 9c65afe1 직접 sync가 재시작 후 21a4b2a4로 롤백됨.)
   - **버전 번호를 안 올리면 정식 재설치도 무시된다.** 같은 버전이면 Desktop이 "이미 설치됨"으로 보고 Extension Dir을 갱신하지 않는다.
   - **영구 적용 절차 (유일하게 신뢰 가능):** ① `package.json` + `manifest.json` 버전 bump → ② `npm run pack`으로 새 .mcpb 생성 → ③ Desktop Settings에서 기존 확장 **Remove** → ④ 새 .mcpb **더블클릭으로 정식 설치** → ⑤ Desktop 완전 재시작. 이래야 레지스트리가 갱신되어 재시작에도 롤백되지 않는다.
   - **검증**: 재시작 후 Extension Dir의 `server/index.mjs` SHA가 방금 빌드한 source와 일치하는지, 그리고 bridge 프로세스 시작 시각이 설치 이후인지 확인한다. 둘 다 맞아야 새 코드가 실제로 도는 것.
