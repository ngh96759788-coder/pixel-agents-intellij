# Pixel Office — 개선 / 보완 로드맵

작성: 2026-04-29 · 마지막 갱신: 2026-05-06 (1.0.4까지 적용 항목 제거)

이 문서는 다음 릴리스 후보를 정리한 것이며, 비슷한 컨셉의 도구들을
벤치마킹해 우리에게 없는 부분과 가져올 만한 아이디어를 포함한다.
**완료된 항목은 CHANGELOG.md를 참고**.

---

## 1. 비슷한 컨셉 — 벤치마킹 대상

### 픽셀/캐릭터 시각화 카테고리

| 도구 | 플랫폼 | 우리에게 없는 강점 |
|---|---|---|
| **Claude Pixel Quest** | VS Code | RPG 콘셉트(채광/낚시/벌목 등 직업·활동 다양화) |
| **pixel-agents-opencode** | VS Code & OpenCode | OpenCode 등 비-Claude AI 도구 호환 |

### 실시간 모니터링 / 대시보드

| 도구 | 강점 |
|---|---|
| **agents-observe** (simple10) | Hook 이벤트 실시간 스트리밍, 멀티에이전트 관계 시각화 |
| **Claude-Code-Agent-Monitor** (hoangsonww) | Kanban 상태 보드, 라이브 분석 |
| **Agent Flow** (patoles) | Orchestration 트리 + 타임라인 + transcript 패널 |

### 코딩 통계

| 도구 | 강점 |
|---|---|
| **WakaTime / Wakapi / Hackatime** | 일/주/월 코딩 시간, 언어/프로젝트별 분포 |

---

## 2. 가져올 만한 핵심 아이디어 (벤치마킹 → 우리)

### 🌟 이벤트 effect (commit / test / build)
- 캐릭터 머리 위 ✨/💯/❌ 같은 효과
- git commit, npm test 같은 Bash 결과를 감지해 효과 trigger
- **선결조건**: 픽셀 아트 스프라이트 (16x16) 직접 디자인 필수. system emoji는 픽셀 미감 깸
- **노력**: 중 (sprite 작업)
- **임팩트**: 중. 분위기 살아남

### 🌟 "직업/활동" 다양화
- **출처**: Claude Pixel Quest
- 현재는 typing/reading 두 모션. 확장:
  - debugging 모션 (망치 들기?)
  - searching 모션 (돋보기)
  - thinking 모션 (말풍선 ?)
- 이미 tool 별로 분류돼 있어 sprite만 추가하면 됨
- **노력**: 중 (sprite 추가 노동)
- **임팩트**: 중

### 🌟 활동 통계 보드
- **출처**: WakaTime, Claude-Code-Agent-Monitor
- Office 벽에 픽셀 보드 — "오늘 3시간 24분 / Edit 87회 / Read 153회"
- 가장 많이 쓴 툴, top 파일, 누적 토큰
- 클릭 시 차트 모달 열림
- 토큰/비용 누적은 1.0.4에 풍선 hover 정보로 들어갔으나 **벽 보드 형태는 미구현**
- **노력**: 큼 (디자인 + 데이터 수집 인프라)
- **임팩트**: 큼 (재방문 동기 생김)

### 🌱 에이전트 간 상호작용
- 두 캐릭터가 가까워지면 짧게 인사 / 회의실 타일에서 잠깐 대화
- 분위기 차원의 디테일
- **노력**: 작음
- **임팩트**: 작음~중

### 🌱 외부 LLM CLI 지원
- **출처**: pixel-agents-opencode
- OpenCode, Cursor, Aider 등도 추적
- JSONL 포맷이 다르면 별도 어댑터 인터페이스
- **노력**: 큼
- **임팩트**: 큼 (사용자층 확대)

### 🌱 zoo 테마 정식 등록
- 이미 에셋·layout 있으나 README/Themes 미등록, 스크린샷 없음
- 등록 + 스크린샷 추가만으로 완성
- **노력**: 작음
- **임팩트**: 작음

---

## 2-A. 벤치마킹 깊이 분석 (2026-05-13 추가)

ROADMAP §1 출처 도구들의 README/스크린샷을 깊이 분석해서 추출한 신규 항목.

### 🌟 파일 attention heatmap
- **출처**: Agent Flow
- 어느 파일을 자주 읽고 수정하는지 office 한쪽 벽 / 캐릭터 뒤 배경에 히트맵 표시
- 핫 파일 top N 만 픽셀 책장에 배치 — 자주 만진 파일은 책 크기/색상으로 가시화
- **노력**: 중 (이벤트 집계 + 시각화)
- **임팩트**: 큼 (코딩 패턴 자기 인지 + 재미)

### 🌟 에이전트 hierarchy / spawn 트리
- **출처**: agents-observe, Agent Flow
- subagent 가 parent agent 에 의해 spawn 된 관계를 시각화
- pixel-agents 에서는 부모 캐릭터 → 자식 캐릭터 사이에 연결선 (실, 그림자 등) 으로 표현
- "부모 캐릭터가 자식을 부를 때" 살짝 이동 / 손짓 모션
- **노력**: 큼 (parent_session_id 추적 + 렌더링)
- **임팩트**: 큼 (멀티에이전트 사용 시 핵심)

### 🌟 활동 필터 / 검색 패널
- **출처**: agents-observe
- Office 상단에 작은 필터 패널 — 특정 agent / tool 타입 / 키워드로 좁히기
- 필터링되면 해당 agent 캐릭터만 강조 + 나머지는 흐림
- 활동 통계 보드 (§2) 와 통합 — 필터 적용된 데이터 기준 통계
- **노력**: 중
- **임팩트**: 중 (많은 에이전트 운영 시 유용)

### 🌱 historical sessions 브라우저
- **출처**: agents-observe
- 과거 세션을 human-readable 이름 ("twinkly-hugging-dragon" 같이) 으로 저장 + 브라우저
- 클릭 시 그 세션을 office 에서 replay (캐릭터들이 그때 활동 재현)
- **노력**: 중 (이벤트 영구 저장소 + 재생 엔진)
- **임팩트**: 중 (어제 뭐 했지? 회고용)

### 🌱 JSONL 이벤트 로그 replay
- **출처**: Agent Flow
- 외부 JSONL 파일 경로를 설정에 지정하면 그 이벤트를 office 에서 재생
- 다른 사용자의 세션 공유 → 같이 보기 가능
- **노력**: 중 (이벤트 파서 + 재생 컨트롤)
- **임팩트**: 작음~중 (공유 / 디버깅 용)

### 🌱 MCP server (introspection)
- **출처**: Claude-Code-Agent-Monitor
- pixel-agents 자체의 상태 / 통계 / 이력을 외부 도구가 query 할 수 있는 MCP 서버 노출
- 예: Claude Code 가 "오늘 내가 가장 많이 만진 파일 알려줘" 라고 물으면 pixel-agents 가 답
- **노력**: 중
- **임팩트**: 작음~중 (생태계 통합)

### 🌱 상태별 캐릭터 시각 신호 (running / needs-input / done)
- **출처**: tmux-agent-indicator
- 현재는 typing 모션 정도. 더 명확한 상태 신호:
  - **running**: 살짝 진동 / Knight Rider 식 빛이 흐르는 효과
  - **needs-input**: 캐릭터 위 노란 ! 말풍선
  - **done**: 캐릭터 위 초록 ✓ + 잠시 후 소멸
- 사용자가 IDE 다른 화면 봐도 office 슬쩍 보면 "지금 입력 필요" 즉시 파악
- **노력**: 중 (sprite + 상태 머신)
- **임팩트**: 큼 (실용성 ↑)

### 🌱 멀티-runtime 캐릭터 외형 차별화
- **출처**: Agent Flow (Claude + Codex 동시 지원), tmux-agent-indicator (per-agent 아이콘)
- 한 office 에 Claude / Codex / OpenCode / Cursor 캐릭터가 서로 다른 외형 / 색상
- "외부 LLM CLI 지원" (§2) 의 시각적 차별화 보강
- **노력**: 작음 (외부 LLM 지원 완료 후 sprite 추가만)
- **임팩트**: 중

### 🌱 이벤트 timeline + transcript 패널
- **출처**: agents-observe, Agent Flow
- Office 하단 또는 사이드에 시간 순으로 어떤 tool 호출 / 어떤 응답이 있었는지 스크롤 가능한 패널
- "활동 통계 보드" 의 클릭 시 모달 형태로 확장 가능
- **노력**: 중
- **임팩트**: 중~큼 (디버깅용)

---

## 3. 사용자 경험 (UX) 개선

| 항목 | 노력 | 비고 |
|---|---|---|
| 첫 실행 안내 (onboarding tooltip) | 작음 | "+ Agent" 버튼 강조 |
| 캐릭터 hover 시 활동 요약 | — | **1.0.3에서 활동 풍선 항상 표시로 자연 해결** |
| 다크/라이트 IDE 테마 자동 전환 | 중 | layout 색상도 따라 |
| 한국어/영어 토글 | 중 | i18n 도입 |
| "포커스 모드" — 한 캐릭터 클릭 시 카메라 줌 + 다른 캐릭터 흐림 | 중 | 이미 카메라 follow는 됨. 다중 에이전트 시 dimming 효과 추가 여부는 사용자가 보류 결정 |

---

## 4. 기술 부채 / 안정성

| 항목 | 상태 |
|---|---|
| `FileSaverDescriptor` 생성자 deprecated 교체 | **보류** — 2024.2 SDK엔 새 API 없음. sinceBuild 251로 올리면 가능 |
| (기타 deprecated API 교체) | 발견 시 케이스별 평가 |

> 1.0.3~1.0.4에서 처리 완료된 부채 항목들(`createLocalShellWidget` 교체, verifyPlugin CI, 단위 테스트 인프라, println 정리, .gitignore 정리, README Attribution, CHANGELOG/change-notes)은 본 표에서 제거됨.

---

## 5. 다음 릴리스 (1.0.5 / 1.1) 후보

### 1.0.5 작은 작업
- **이벤트 effect** (#1) — 픽셀 sprite 작업 후 진행
- **에이전트 별 이름 / 이모지 커스터마이징** — 컨텍스트 메뉴
- **HP 바 색상 미세 조정** — 더 픽셀 게임스러운 팔레트로 추가 손질

### 1.1 중간 작업
- **활동 통계 대시보드** — 사무실 벽 보드 + 모달
- **diff 알림** — 에이전트 Edit/Write 후 변경 라인 수 표시
- **다크/라이트 IDE 테마 자동 전환**
- **첫 실행 onboarding**

---

## 6. 장기 로드맵 (1.2+ 또는 별도 트랙)

- 캐릭터 외형 커스터마이징 UI
- 외부 LLM CLI 지원 (OpenCode, Cursor, Aider 등)
- 미니게임 / 아이템 unlock (가챠형)
- multi-IDE 동기화 옵션 (현재 의도적으로 분리됨, 명시적 toggle 추가)
- 클라우드 leaderboard (커뮤니티 요소)
- Canvas 직접 픽셀 폰트 렌더링 (mcufont 류 비트맵 폰트 활용) — 에이전트 명패 등 픽셀 레벨 정합 필요해질 때

---

## 출처 (벤치마킹 검색)

- [Pixel Agents (VS Code)](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents)
- [pablodelucca/pixel-agents (GitHub)](https://github.com/pablodelucca/pixel-agents)
- [Claude Pixel Quest](https://marketplace.visualstudio.com/items?itemName=DaniloTrebjesanin.claude-pixel-quest)
- [pixel-agents-opencode](https://github.com/Caffa/pixel-agents-opencode)
- [agents-observe](https://github.com/simple10/agents-observe)
- [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor)
- [Agent Flow](https://github.com/patoles/agent-flow)
- [Claude HUD](https://aitoolly.com/ai-news/article/2026-03-22-claude-hud-a-new-monitoring-plugin-for-claude-code-tracking-context-and-agent-activity)
- [Claude Code Status Bar Monitor (VS Code)](https://marketplace.visualstudio.com/items?itemName=bartosz-warzocha.claude-statusbar)
- [tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator)
- [Wakapi](https://github.com/muety/wakapi)
- [Hackatime](https://hackatime.hackclub.com/)
