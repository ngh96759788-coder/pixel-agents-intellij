# Changelog

## 1.0.6 (+ mcp-bridge 0.8.7)

### 5h 토큰 칩을 가중합으로 (BEHAVIOR_SPEC §3 변경 — 사용자 승인 2026-09-21)
- **버킷을 그냥 더하면 합계의 98.8%가 cache read 였다** (실측: 330.6M 중 326.7M). 즉 그 숫자는 「리미트까지 얼마나 썼나」가 아니라 「히스토리를 몇 번 다시 읽었나」를 세고 있었고, 화면에는 늘 세 자리 M 이 떠서 눈금 구실도 못 했다
- **공개 과금 배수와 같은 가중치를 적용한다** — input ×1.0 / cache write ×1.25 / **cache read ×0.10** / output ×1.0. 같은 5h 창 기준 174.2M → 23.4M(13.5%)
- **가중합은 일률적 할인이 아니다.** 세션 첫 턴처럼 프롬프트 전체를 캐시에 쓰는 턴은 ×1.25라 raw 보다 **커진다**(실측 151,598 → 162,300). 이 성질을 테스트로 고정해 뒀다 — "가중치를 걸면 항상 작아진다"는 틀린 믿음이 나중에 코드로 들어가지 않도록
- 가중치 상수는 `Constants.QUOTA_WEIGHT_*`(Kotlin)와 `spec.ts`의 `QUOTA_WEIGHTS`(bridge) 두 곳이고 **같은 값을 유지해야 한다**. 회귀 테스트 `QuotaWindowTrackerTest`
- `office_diagnose`의 `quotaWindow.tokensUsed5h` → `weightedTokens5h` 로 개명 — 더 이상 토큰 개수가 아니라서
- HUD 칩 툴팁이 가중치를 설명한다. 세션 누적/비용 추정에는 가중치를 적용하지 않는다 (`estimateCost()`가 자기 배수를 따로 적용하므로 이중 적용이 된다)

### 하단 HUD 토큰 표시 수정 (사용자 신고: "잔여 토큰 체크가 동작 안 한다")
- **컨텍스트 막대가 엉뚱한 값을 보고 있었다** — `BottomHUD`가 세션 누적 처리량(`agentCumulative`, 평생 input+cache+output 합)을 컨텍스트 윈도우로 나누고 있었다. 누적값은 윈도우를 몇 배씩 넘기므로 조금만 긴 세션이면 무조건 100%(빨강)로 고정됐다. 캐릭터 머리 위 HP 바가 이미 쓰고 있던 올바른 신호(`agentUsage` = 직전 턴의 prompt-side 토큰 = 지금 컨텍스트가 얼마나 찼는가)로 교체했다. 실측: 이 세션 기준 100% → 30%
- **`claude-opus-5`의 컨텍스트 윈도우가 200K로 잡혀 있었다** — `contextWindowFor()`가 `/opus-4/` 정규식으로만 1M을 인정해서, 현재 Claude Code 기본 모델인 Opus 5가 구세대 취급을 받았다. 최근 30일 트랜스크립트의 어시스턴트 레코드 42,186건이 `claude-opus-5`다. 티어+버전을 파싱하는 `parseModelId()`로 바꿔 Opus 4 이상·Sonnet 5 이상·Fable/Mythos 5 이상을 1M으로 처리한다. webview와 mcp-bridge 양쪽(`usage.ts` × 2)
- **5h 토큰 합계가 1.9배 부풀려져 있었다** — Claude Code는 API 응답 하나를 `assistant` 줄 여러 개(text / thinking / tool_use)로 쓰고 **모든 줄이 같은 `message.usage`와 같은 `message.id`를 반복**한다. 줄 단위로 더하면 도구를 쓴 턴이 전부 두 번 세어진다. `message.id`로 중복을 걷어냈다 — `QuotaWindowTracker`(IntelliJ), `quotaWindow.ts`(bridge), 그리고 세션 누적/비용 추정을 망치던 `TranscriptParser`까지 세 곳. 실측: 5h 합계 620M → 324M
- **모델 칩의 구세대 id 파싱** — `claude-3-opus-20240229`가 `OPUS 20240229`로 렌더링됐다(현대 표기 정규식이 날짜 접미사를 버전으로 먹음). `parseModelId()`를 공유해 `OPUS 3` / `SON 3.5`로 정정
- **요율표** — Sonnet 5는 $2/$10로 Sonnet 4.6($3/$15)보다 싸다. 한 칸이던 sonnet 요율을 갈랐다
- **HUD 기본 모델 폴백** — `claude-opus-4-8` → `claude-opus-5`
- **`/compact` 뒤에도 컨텍스트 값이 줄지 않았다** — IntelliJ `TranscriptParser`가 `lastContextTokens`를 최댓값으로만 갱신해서, 웹뷰를 다시 열면 압축 전의 큰 값이 재전송됐다. 직전 턴 값을 그대로 저장하도록 바꿨다. HUD 막대 계산은 `fullestContext()`로 분리해 테스트로 막았다
- 회귀 테스트 추가: `CumulativeUsageTest`(중복 줄 1회만 집계), `usage.test.ts`/`toolOverlay.test.ts`에 Opus 5·Fable 5.1·구세대 id 케이스
- `BottomHUD`에서 쓰지 않던 비용 합계(`totalCost`)와 그것만 읽던 `agentCumulative` prop을 제거했다. 1.0.5에서 비용 표시를 뺄 때 계산만 남아 eslint 오류가 나던 것이다

### bridge 버전 보고 수정
- **`office_diagnose`가 0.8.7 코드에서 `version: 0.8.2`를 돌려줬다.** 버전을 `server/../package.json`에서 실행 중에 읽는데, `deploy.sh`는 `server/index.mjs`와 `web/`만 복사하므로 Extension Dir에는 마지막으로 정식 설치한 .mcpb(0.8.2)의 `package.json`이 남아 있었다. 그래서 CLAUDE.md 규칙 8의 버전 확인은 직접 복사로 배포하는 한 통과할 수 없었다
- 빌드할 때 esbuild `--define:__BRIDGE_VERSION__`로 버전을 `index.mjs`에 넣는다. 버전이 코드와 함께 이동한다. `tsx` 개발 실행은 기존처럼 `package.json`을 읽는다

### 실제 5h 사용률 표시 (BEHAVIOR_SPEC §3 변경 — 사용자 승인 2026-09-30)
- HUD 5h 칩이 실제 사용률(`5h 14%`)을 보여 준다. 출처는 Claude Code statusline의 `rate_limits`(statusline 스크립트가 `~/.pixel-agents/rate-limits.json`에 씀)와 Claude Desktop의 `plan-usage-history.json`(15분마다 쓰는 `fh`/`sd` 표본) 두 가지다. 툴팁에 7d %, 초기화 시각, 출처, 잰 시각이 나온다
- CLI 값은 `resets_at` 전까지 유효하고(사용률은 초기화 전에는 줄지 않으므로 오래된 값도 하한으로 맞다), Desktop 값은 20분 이내 표본만 쓴다. 둘 다 유효하면 더 최근에 잰 값을 쓰고, 둘 다 없으면 이전처럼 가중합 토큰(`23.4M / 5h`)을 보여 준다
- bridge `rateLimits.ts`와 IntelliJ `RateLimitReader.kt`에 같은 규칙을 구현했다. `office_diagnose`에 `rateLimit` 필드를 추가했다. 회귀 테스트 `RateLimitReaderTest`, `usage.test.ts`의 `quotaChip`

### 7일 사용량 기준선(pace)과 메시지 훅 (BEHAVIOR_SPEC §3 변경 — 사용자 승인 2026-10-02)
- HUD 칩이 `5h 14% · 7d 23% (pace 35%)`처럼 7일 사용률과 기준선을 같이 보여 준다. 기준선은 "이번 주 한도를 평일 시간에 고르게 나눠 썼다면 지금 몇 %여야 하나"이고, 주말은 시간이 흘러도 오르지 않는다. 7일 사용률이 기준선을 넘으면 칩이 노란색이 된다
- 평일만 세는 근거: 최근 28일 실측에서 주말 사용량 0%, 평일 비중 17–24%. 단순 7등분은 월 09:00에 64%로 뛰어 여유를 실제보다 크게 보이게 한다(평일 기준 50%). 9월 22~23일에는 리셋 전에 100%를 썼다
- 기준선을 구하려면 7일 리셋 시각이 필요해서 bridge `rateLimits.ts`와 IntelliJ `RateLimitReader.kt`가 `sevenDayResetsAt`을 넘긴다. Desktop 출처에는 리셋 시각이 없어서 기준선을 빼고 보여 준다
- `hooks/usage-pace.py`: Claude Code `UserPromptSubmit` 훅. 같은 캐시를 읽어 7일 사용률이 기준선을 넘었을 때만 메시지 앞에 한 줄을 붙이고, 그 밖에는 아무것도 붙이지 않는다. 사용량을 새로 조회하지 않는다
- 기준선 계산은 webview(TypeScript)와 훅(Python) 두 곳에 있어서, 같은 정답표(`fixtures/pace-cases.json`)로 둘 다 검사한다(`pace.test.ts`). 테스트가 node 모듈을 쓰게 되어 웹뷰 테스트를 `tsconfig.test.json`으로 분리했다(앱 코드는 여전히 node 타입 없이 검사한다)
- 칩 글자는 영어다. FS Pixel Sans에 한글 글리프가 없다

### 좁은 창에서 HUD가 툴바와 겹치던 문제
- HUD가 툴바와 자기 위치를 재서, 겹치면 `N tok` 숫자 → 모델 칩 → 컨텍스트 막대 → 배율 축소 → 숨김 순서로 한 단계씩 줄인다. 툴바는 그대로 둔다. 폭이 다시 넓어지면 전체 HUD로 돌아온다
- 1100·700·560·420·360·300px 창에서 단계가 바뀌는 것과 900px로 되돌렸을 때 복구되는 것을 브라우저로 확인했다

### Ctrl/Cmd + 휠 줌이 브라우저 줌과 같이 걸리던 문제
- React의 `onWheel`은 passive 리스너라서 캔버스에서 부르던 `preventDefault()`가 무시됐다. 그래서 Chrome 위젯과 JCEF에서 Ctrl/Cmd + 휠을 돌리면 오피스 줌과 함께 페이지 전체(버튼·HUD)도 커졌다. 리스너가 캔버스에만 있어서 HUD나 툴바 위에서는 오피스 줌이 아예 걸리지 않았다
- Ctrl/Cmd + 휠(트랙패드 핀치 포함)을 `window`의 `passive: false` 리스너로 옮겼다. 창 어디서든 오피스 줌만 바뀌고 브라우저 줌은 막힌다. 캔버스의 휠 처리는 이동(pan)만 남겼다
- MCP 뷰어 번들에서 캔버스·HUD·툴바 위 Ctrl/Cmd + 휠이 모두 한 단계씩 바뀌고 기본 동작이 막히는 것, 그냥 휠은 줌을 건드리지 않는 것, Cmd+`=`/`-`/`0`이 동작하는 것을 브라우저로 확인했다

### IntelliJ 내장 브라우저(JCEF)가 죽었을 때 감지·복구·안내
- **증상:** IDE는 멀쩡한데 Pixel Agents 화면만 멈췄다. 2026.1은 JCEF를 `cef_server`라는 별도 프로세스로 돌리는데, 이 프로세스가 통째로 사라졌고 플러그인은 그것을 알 방법이 없었다. 원인은 플랫폼 버그로 보인다. JBR-10027(미해결)에 같은 환경(macOS·Apple Silicon·플러그인 웹뷰)에서 한동안 쉬면 `cef_server`가 종료되고 `idea.log`에 아무것도 남지 않는다는 분석이 올라와 있다
- **렌더러가 죽으면 바로 다시 읽는다.** `onRenderProcessTerminated`를 받아 종료 사유를 WARN으로 남기고 페이지를 다시 읽는다. 이 콜백은 2024.2(인자 2개)와 2026.1(인자 4개)의 시그니처가 달라서 둘 다 구현했다. 2024.2 기준으로 빌드한 2인자 override만 두면 2026.1에서는 한 번도 불리지 않는다
- **응답이 끊기면 단계적으로 복구한다.** 플러그인이 30초마다 ping을 보내고 웹뷰가 pong으로 답한다(웹뷰 타이머는 숨겨진 페이지에서 크롬이 1분 간격까지 늦추므로 플러그인 쪽에서 보낸다). 전달된 ping에 90초 동안 답이 없으면 다시 읽고, 15초 뒤에도 없으면 브라우저를 새로 만들고, 그래도 없으면 포기한다
- **IDE가 멈춘 시간은 침묵으로 세지 않는다.** 침묵은 실제로 전달된 ping부터 센다. 판단과 실행은 EDT에서 한 번에 하나씩만 한다. 시계만 보고 판단하면 EDT가 2분 넘게 멈췄을 때 ping이 나가지도 않았는데 다시 읽기·재생성·포기가 줄줄이 예약되고, IDE가 풀리는 순간 멀쩡한 브라우저에 "재시작하라" 안내가 뜬다
- **포기하면 알린다.** 툴윈도우에 안내 문구와 [Restart IDE]·[Try again] 버튼을 띄우고 IDE 알림을 한 번 보낸다. `cef_server`가 죽으면 플랫폼이 다시 띄우지 않고 새 브라우저도 붙을 곳이 없어서, IDE 재시작만이 복구 방법이다
- **샌드박스에서 확인했다.** 2024.2.1: 렌더러를 죽이면 2ms 뒤 다시 읽기, 90ms 뒤 `webviewReady`. 렌더러를 `SIGSTOP`으로 얼리면 다시 읽기 → 브라우저 재생성으로 복구되고, 얼린 렌더러는 남지 않는다. 2026.1.3: 렌더러를 죽이면 4인자 콜백(`code=9`)이 불려 복구된다. `cef_server`를 죽이면 다시 읽기·재생성으로는 복구되지 않고 안내 화면과 알림이 뜬다
- 회귀 테스트 `WebviewWatchdogTest`(복구 단계·포기·재시도·응답 시 초기화)

### 터미널 탭 제목이 바뀔 때마다 "닫힘"으로 판정하던 문제
- TerminalDetector가 탭을 표시 이름으로 추적해서, Claude Code가 제목 앞 회전 표시(◐ ◑ ✳)를 바꿀 때마다 "닫힘"을 기록했다. 하루 로그의 22%가 이 한 줄이었다. 플러그인이 띄운 터미널(`Pixel Agents #N`)은 제목이 바뀌는 순간 에이전트가 잘못 제거될 수도 있었다
- 탭을 객체 자체로 추적하고, 탭이 실제로 사라지면 처음 이름과 마지막 이름으로 닫힘을 알린다. 회귀 테스트 `TerminalDetectorTest`

### 빌드
- `verifyPlugin`이 삭제 예정·내부·override 전용·확장 금지 API 사용을 실패로 처리한다. JetBrains가 우리가 쓰는 API를 이렇게 바꾸면 마켓플레이스 검증 메일보다 먼저 릴리스가 여기서 멈춘다. deprecated 2건(`FileSaverDescriptor`, `createShellWidget`)은 2024.2에도 있는 대체 API가 없어서 경고로 둔다. 실패 기준이 실제로 적용되는지는 deprecated를 일시로 실패 기준에 넣어 빌드가 실패하는 것으로 확인했다
- 플러그인 jar와 Desktop Extension Dir에 예전 웹뷰 번들이 쌓이고 있었다(각각 `index-*.js` 7개, 하나에 약 337KB). Gradle `copyWebview`를 `Copy`에서 `Sync`로, `deploy.sh`의 `cp -rf`를 `rsync -a --delete`로 바꿔 지금 번들 하나만 남긴다

### 문서
- README에 5h 사용량 칩의 출처 세 가지와, 다른 사용자가 자기 statusline 스크립트에 붙여 넣을 `jq` 스니펫을 추가했다. 값이 없을 때 기존 파일을 덮어쓰지 않고 exit 0으로 끝나는 것을 확인했다
- `Types.kt`의 worktree 라벨 KDoc이 아직 옛 글자 `⑂`를 적고 있던 것을 실제 렌더링과 같은 `↳`로 정정

## 1.0.5 (+ mcp-bridge 0.8.6)

### IDE 호환 범위 (마켓플레이스 delist 대응)
- **`until-build` 상한 제거** — 마켓플레이스에 올라가 있던 1.0.0~1.0.2가 `until-build = 253.*`라서 IDE 262(2026.2) 사용자에게 노출되지 않던 문제. `gradle.properties`의 `untilBuild`를 비우면 `provider { null }`로 속성 자체가 빠지며, 값을 넣으면 다시 상한이 걸린다
- **verifier 대상에 Ultimate 2026.2 추가** — IntelliJ IDEA **Community는 2025.3(빌드 253)이 마지막**이라 `recommended()`만으로는 261/262를 아예 검증할 수 없었음. `ide(IntellijIdeaUltimate, "2026.2")`를 명시해 실제 사용자 빌드를 검증 대상에 포함
- **IntelliJ Platform Gradle Plugin 2.2.1 → 2.9.0** — 2.12.0부터 Gradle 9를 요구하므로 현재 래퍼(8.10)에서 쓸 수 있는 최신 계열로 상향
- **루트 `npm run build` 복구** — 루트 `tsconfig.json`이 나중에 추가된 `mcp-bridge/`(자체 tsconfig 보유)를 제외하지 않아 `check-types`가 `TS6059 rootDir`로 실패하던 것을 수정. CI의 빌드 단계도 같은 이유로 깨져 있었음

### Claude 5 패밀리 / 신규 모델 대응
- **모델 칩** — `claude-fable-5` → `FABLE 5`(뮤트 틸), `claude-mythos-5` → `MYTH 5`, `claude-opus-4-8` → `OPUS 4.8`, `claude-sonnet-5` → `SON 5`. 기존엔 Fable/Mythos 세션이 회색 폴백 칩(`FAB`)으로 표시됐음
- **컨텍스트 윈도우 스케일** — Fable 5 / Mythos 5 / Sonnet 5 / Sonnet 4.6 → 1M (HP 게이지·HUD % 정확화). webview + mcp-bridge 양쪽 (`usage.ts` × 2)
- **비용 요율표 갱신** — Opus $5/$25 (구세대 $15/$75에서 정정), Haiku 4.5 $1/$5, Fable/Mythos $10/$50 추가
- **HUD 기본 모델 폴백** — `claude-opus-4-7` → `claude-opus-4-8`

### 스펙 위반 버그 수정 (BEHAVIOR_SPEC 감사)
- **background Bash 유지** — `run_in_background: true` Bash가 실행 중이면 turn 종료 후에도 캐릭터가 active 유지 (§2). IntelliJ 플러그인(`TranscriptParser`/`AgentManager`)에 신규 구현, mcp-bridge는 Desktop `audit.jsonl` watcher에 누락돼 있던 동일 로직 포팅
- **서브에이전트 워처 타임아웃 30s** — `FileWatcher.checkSubagentTimeout`이 메인용 60s 상수를 재사용하던 것을 스펙값 30s(`SUBAGENT_STALE_THRESHOLD_MS`)로 분리 (§2)
- **5h 토큰 HUD (IntelliJ)** — `quotaWindow` 메시지를 보내는 백엔드가 없어 HUD 토큰 칩이 영구 미표시되던 것을 `QuotaWindowTracker.kt` 신설로 구현: 분마다 `~/.claude/projects` JSONL usage를 5h 윈도우로 합산(파일별 size+mtime 캐시), 절대 토큰 표시 (§3)
- **mcp-bridge MCP 프로토콜 버전 드리프트** — `Server` 메타데이터에 하드코딩된 `0.8.2`를 `BRIDGE_VERSION`(package.json)으로 교체

### 통합 보기 구현 (BEHAVIOR_SPEC §4)
- **Settings > "Unified View (Show Other Sources)" 토글 신설** — 기본 OFF(내 작업만). ON 시 외부 출처(다른 IntelliJ 창의 CLI, 기타 `~/.claude/projects` 활동) 캐릭터를 **85% 투명도**로 표시. 서브에이전트도 부모의 외부 투명도 상속
- **IntelliJ 백엔드** — 앱 레벨 설정 영속화 + 토글 ON일 때만 도는 외부 세션 디스커버리(15s 주기, 자기 프로젝트/worktree 디렉토리 제외, peer-ownership 검사는 의도적으로 통과). 외부 에이전트는 영속화·터미널 포커스에서 제외, OFF 시 일괄 제거
- **mcp-bridge 서버** — `setUnifiedView` 메시지 처리(외부 레코드 replay/close), `settingsLoaded`에 `unifiedView` 포함. Desktop 위젯에서 CLI 세션을 통합 표시 가능
- 죽은 코드 `AgentLabels.tsx` 삭제

### 상태 버튼/아이콘 디자인 정리
- **폰트 미지원 글리프 교체** — FS Pixel Sans cmap에 없어 OS 폴백 폰트/이모지로 렌더링되던 글리프 정리: HUD 승인 배지 `⚠`→`!`, DebugView 닫기 `✕`→`×`, worktree 브랜치 접미사 `⑂`→`↳`(U+21B3, 폰트 커버 확인)
- **닫기 버튼 통일** — SettingsModal(`X`)/DebugView(`✕`)/ToolOverlay(`×`) 3종이던 닫기 글리프를 `×` + `--pixel-close-*` 변수로 통일
- **EditorToolbar 팔레트 통일** — 유일하게 하드코딩 색(`#1e1e2e`/`#4a4a6a`/`#181828`/`#2A2A3A`)을 쓰던 패널을 공용 `--pixel-*` 변수로 교체. `--pixel-bg-inset`, `--pixel-shadow-sm` 변수 신설
- **네이티브 폼 컨트롤 픽셀화** — 레이아웃 에디터의 `<input type=range>`/`<input type=checkbox>`(둥근 OS 크롬)를 CSS로 각진 픽셀 스타일로 교체

## 1.0.4

### Features — git worktree 지원 (IntelliJ 2026.1 대응)
- **worktree 에이전트 감지** — 열린 레포의 git worktree(`git worktree list --porcelain`)를 각자의 `~/.claude/projects/<hash>/`로 매핑해 스캔 대상에 추가. IntelliJ 2026.1의 "에이전트에게 작업 위임"(worktree 흐름)으로 다른 worktree에서 도는 Claude 세션도 같은 오피스에 캐릭터로 등장. 5초 주기로 재스캔해 런타임에 생성된 worktree도 IDE 재시작 없이 포착. (`WorktreeDetector.kt` 신설)
- **trusted-dir 입양** — worktree 디렉토리는 `trusted`로 등록되어 입양 시 `hasOwnClaudeDescendant()` 프로세스-자손 검사를 건너뜀(위임된 에이전트가 IDE 프로세스 트리 밖에서 돌 수 있으므로). `instanceManifest` peer-ownership 검사는 유지해 타 IDE 창과 중복 입양 방지. 글로벌 cross-project 디스커버리를 다시 켠 게 아니라 열린 레포의 worktree로만 스코프 한정
- **브랜치 라벨** — worktree에서 입양된 에이전트는 캐릭터 식별 라벨에 `⑂branch` 접미사로 어느 브랜치 작업인지 표시. persist/restore로 IDE 재시작 후에도 유지

## 1.0.3

### UX
- 활동 풍선 항상 표시 — 작업 중인 모든 캐릭터 위에 현재 도구 상태가 작은 반투명 라벨로 떠있음. 호버/선택 시에는 기존처럼 강조된 풀 스타일로 전환
- Context window HP 게이지 — 라벨 옆에 작은 색상 바로 200K 윈도우 사용률 표시 (녹색 → 황색 65%↑ → 적색 85%↑). 호버/선택 시 % 숫자도 함께 표시. JSONL `usage` 필드의 `input + cache_creation + cache_read` 합계 기반. 색상은 muted 톤 (forest-green / gold / brick-red)
- 모델 인디케이터 chip — 활동 풍선에 `OPUS` / `SON` / `HAI` 픽셀 스타일 색상 칩 표시 (muted 팔레트 + 1px outline + hard offset shadow). JSONL `message.model`에서 추출, 웹뷰 리로드 시 즉시 복원
- 세션 토큰/비용 누적 — 호버/선택 시 풍선 아래 작은 라인으로 `12.4K tok • $0.18 est`. 모델별 요율표(Opus/Sonnet/Haiku) 기반 비용 추정 (cache_create 1.25x, cache_read 0.10x). 알 수 없는 모델은 Sonnet 요율 fallback. 정확한 청구는 Anthropic 콘솔 확인
- 줌 단축키 — `+` / `-` (modifier 무관)으로 한 단계씩 in/out, `Ctrl/Cmd+0`로 auto-fit 기본값 복원. 입력 필드 포커스 시 무시
- 60초 타임아웃 임계값을 메인/서브 에이전트 모두 60초로 통일 (기존 30/60/120 → 60 단일)

### Stability — peer isolation
- 다른 IntelliJ 창이 소유한 Claude 세션은 캐릭터로 표시하지 않도록 입양 진입 경로 3곳에 `isOwnedByPeer` 가드 추가 — `FileWatcher.ensureProjectScan` 초기 시드, `AgentManager.adoptAgent` (단일 chokepoint 방어선), `AgentManager.restoreAgents` (IDE 재시작 시 peer 소유로 넘어간 옛 external 항목 드랍). 이전엔 흐릿한 "유령" 캐릭터로 떠 있었지만 작업 라벨이 안 보이는 부작용이 있었음 — peer가 active writer라서 우리는 패시브 관찰자였고, 입양 시 전체 JSONL 히스토리 재생이 `turn_duration`으로 끝나면서 idle로 수렴했기 때문

### Stability — agent lifecycle
- 메인 에이전트가 60초 안 사라지던 버그 수정 — `permissionSent` 플래그가 Ctrl+C 후 stuck되어 dead-session 검사를 무한 스킵하던 문제 해소. JSONL `lastModified`을 단일 진실 소스로 채택
- `+ Agent` 클릭 시 race로 캐릭터 두 개 보이던 케이스 수정 — `knownJsonlFiles` 등록을 `claude` 명령 실행보다 먼저 수행
- 웹뷰 패널 토글/리로드 시 진행 중인 sub-agent 캐릭터가 사라지던 문제 — `taskStatus`를 `AsyncSubagent`에 보존해 리로드 시 재spawn
- `/clear` 후 `pendingSubagentIds` / `hadToolsInTurn` 플래그가 stuck → 새 세션의 sub-agent가 옛 parentToolId에 잘못 바인딩되거나 text-idle 타이머 안 시작되던 문제 해소
- 에이전트 제거 시 `agentSeats`(좌석/팔레트 메타)에 stale 엔트리 잔류 → IDE 재시작 후 새 에이전트가 옛 좌석 상속하던 drift 차단
- 웹뷰 ↔ extension 사이의 ghost 캐릭터 reconciliation — `existingAgents` 메시지를 권위적 진실 소스로 처리, incoming에 없는 캐릭터/state 자동 정리
- `/clear` reassignment과 dead-session 검사의 race 방어 — checkDeadSessions에서 TOCTOU 재확인
- `startJsonlPoll`이 stale `agent` 참조 사용하던 race — 매 tick `agents[agentId]?.jsonlFile` live 재조회

### Stability — webview
- `addSubagent` capacity 도달 시 반환되는 `0` sentinel을 phantom 캐릭터로 처리하던 버그 수정
- `subagentToolDone` 후 sub-agent 캐릭터가 영영 타이핑/리딩 애니메이션 유지하던 문제 — 모든 도구 done이면 `setAgentTool(null)` + `setAgentActive(false)`
- `subagentClear` 시 React `subagentCharacters` 상태가 정리 안 돼 라벨만 남는 phantom record 차단

### Resource leaks
- `onWebviewReady`가 JCEF 패널 토글마다 재호출되며 `TerminalDetector` / `sessionAliveCheck` / `periodicDiscovery` 타이머가 중복 누적되던 버그 — `AtomicBoolean` 게이트로 인프라는 단 한 번만 시작, 이후 호출은 state resync만
- `stopWatching` 시 `subagentStartTimes` / `subagentLastActivity` 메타맵이 정리 안 돼 장기 세션에서 메모리 누수되던 문제 해소

### API & Build
- Scheduled-for-removal API 교체: `TerminalToolWindowManager.createLocalShellWidget` → `createShellWidget` (2026.x 호환성 안전판)
- Kotlin 컴파일 경고 정리 (shadowed name, unused param)
- `WebviewBridge`의 매 메시지마다 stdout으로 가던 `println` → `LOG.debug` (idle 시 noise 제거)
- `AssetLoader` / `LayoutPersistence`에 잔재하던 35개 `println`도 IntelliJ `Logger`로 교체 — IDE 로그 카테고리에서 일관 추적
- `assetsDir` `@Volatile` — `setTheme`와 `loadAndSendAssets` 사이 가시성 보장

### Tech debt
- JUnit 5 + vitest 단위 테스트 인프라 셋업 — Kotlin 15개 (`formatToolStatus`, `extractContextTokens`, `extractTurnTokens`) + webview 45개 (`modelChip`, `gaugeColor`, `extractToolName`, `estimateCost`, `formatTokens`, `formatCost`, `totalTokens`, 기존 `autoAnimate`) → 전체 **60개 테스트**
- IntelliJ Plugin Verifier task 구성 (`./gradlew verifyPlugin`) — deprecated/제거 예정 API 자동 감지
- GitHub Actions CI workflow 추가 (`.github/workflows/build.yml`) — push/PR 시 빌드 + 구조 검증 + 양쪽 테스트 자동 실행, main 브랜치에서 verifier 자동 실행
- 웹뷰의 14개 `console.log` 잔재를 `debug()` 헬퍼로 게이팅 — 정상 사용 시 dev console 조용. `localStorage.pixelAgentsDebug = '1'` 시에만 출력
- `.gitignore`에 `.tldr/`, `_workspace/` 추가
- README Attribution 섹션에 테마별 에셋 출처 표(default/alien/cat/zoo)와 폰트 출처 보강

## 1.0.0

Initial release of Pixel Agents for IntelliJ Platform.

### Core
- IntelliJ Platform port using JCEF-based webview (Kotlin + React/Canvas)
- Claude Code JSONL transcript watching with hybrid `WatchService` + polling
- One-agent-per-terminal binding with automatic session ID tracking
- Agent persistence across IDE restarts (state serialized to application settings)
- External session adoption — detects Claude Code sessions started outside the plugin
- Dead session detection — removes stale agents when no Claude process is running

### Sub-agents
- Synchronous sub-agent visualization (Task/Agent tool progress records)
- Async sub-agent file tracking — monitors separate `<sessionId>/subagents/agent-<id>.jsonl` files
- Sub-agent persistence across plugin reload
- Polling timeout — orphaned sub-agent watchers auto-cleanup after 30s (no file) or 2m (idle)
- Sub-agents spawn at unoccupied walkable tiles near parent, avoiding overlap

### Themes
- 4 themes: default office, alien, cat, zoo
- Per-theme characters (6 per theme), floor tiles, wall tiles, and furniture catalogs
- Theme switching with matrix-style spawn/despawn effect

### Office & Editor
- Layout editor with floor painting, wall painting, furniture placement, and erase tools
- 80+ furniture items across desks, chairs, storage, electronics, decor, and wall categories
- Furniture rotation groups, on/off state toggles, surface placement, wall mounting
- Auto-animated furniture (wall clocks, desk fans, water coolers) via `animSequence`
- Auto-state electronics (monitors/lamps turn ON when agent faces desk)
- HSBC color controls for floors, walls, and individual furniture items
- Expandable grid up to 64x64 tiles with ghost-border expansion UI
- 50-level undo/redo
- Export/import layouts as JSON files
- Per-theme layout persistence at `~/.pixel-agents/layout-<theme>.json`

### Characters
- 4-directional sprites with walk, type, and read animations
- Diverse palette assignment — first 6 agents each get unique skin; beyond 6, hue-shifted variants
- Sub-agents always get diverse palettes distinct from siblings
- BFS pathfinding with per-character seat unblocking
- Camera follow on character click with smooth tracking
- Sitting offset for natural desk posture
- Idle wandering with configurable limits

### UI
- Speech bubbles: permission (amber dots), waiting (green checkmark with auto-fade)
- Sound notifications via Web Audio API (ascending two-note chime)
- Zoom controls (1x-10x, pixel-perfect integer scaling)
- Middle-mouse pan
- Tool overlay showing current activity above hovered/selected character
- Settings modal with sound toggle, debug view, export/import

### Attribution
- Based on [Pixel Agents for VS Code](https://github.com/pablodelucca/pixel-agents) by Pablo De Lucca
