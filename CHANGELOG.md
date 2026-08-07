# Changelog

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
