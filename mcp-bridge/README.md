# Pixel Office MCP Bridge

Claude (Desktop / Code / CLI)의 tool 호출 활동을 픽셀 아트 오피스 위젯으로 시각화하는
MCP 서버. 로컬에서만 동작하고, 네트워크/API 키 없음.

```
[Claude Desktop / Claude Code] ──tool call──▶ [this MCP server]
                                                      │
                                                      ▼
                          http+ws viewer at localhost:7456
                                                      │
                                                      ▼
                          Chrome --app 위젯 윈도우 (830×630)
```

## Tools

| Tool | Use |
|---|---|
| `office_open` | 위젯 윈도우 띄움 — `contextPercent`(0-100) 인자 **필수**로 HUD 토큰 바 채움 |
| `office_status` | 컨텍스트 사용량(%) 갱신. HP 바 + 하단 HUD 토큰 % 표시 |

서브 에이전트 캐릭터는 Claude의 tool-call 로그를 자동 감지해 표시 (추가 호출 불필요).

## Claude 자동 행동 (MCP `instructions` 명세)

이 MCP가 등록된 클라이언트에서 Claude는 다음을 **자동**으로 수행합니다 — 별도 시스템 프롬프트 불필요:

1. 한국어 "픽셀오피스 열어/보여/띄워줘" / 영어 "open/show/launch the pixel office"
   같은 의도 감지 → 즉시 `office_open` 호출 (파일/메모리/셸 탐색 안 함)
2. `office_open` 호출 시 `contextPercent`를 항상 함께 보냄 → HUD 토큰 바 즉시 차오름
3. 컨텍스트가 늘어나면 (긴 tool 결과 직후, 약 5메시지마다, 25/50/75/90% 임계) `office_status`로 갱신

> **HUD 토큰 % 안 차는 증상이 보이면**: 클라이언트 측 cache된 옛 instructions를 쓰는 중일 가능성.
> 이 MCP 버전(0.8.1+)을 재설치하고 클라이언트를 재시작하세요.

## Build

```bash
npm install
npm run build      # → server/index.mjs (bundled)
npm run pack       # → pixel-agents-bridge-<version>.mcpb
```

## Install — Claude Desktop

`.mcpb` 파일을 Claude Desktop에 드래그-드롭. Settings → Connectors / Extensions에서
토글 ON. 끝.

## Install — Claude Code (CLI)

`.mcpb`는 Desktop 전용이라 Claude Code 세션에서는 인식 안 됨. 다음 둘 중 하나로 등록:

### A. `claude mcp add` (권장)

```bash
# 1. mcpb 풀어서 영구 경로에 둠
mkdir -p ~/.local/share/pixel-office-bridge
unzip -o ~/Downloads/pixel-agents-bridge-*.mcpb -d ~/.local/share/pixel-office-bridge

# 2. user scope로 등록 (모든 프로젝트에서 사용)
claude mcp add pixel-agents-bridge --scope user -- \
  node ~/.local/share/pixel-office-bridge/server/index.mjs
```

### B. `~/.claude.json` 직접 편집

> **참고**: `~/.claude.json`은 Claude **Code (CLI)** 설정. Claude **Desktop**은
> `~/Library/Application Support/Claude/claude_desktop_config.json` (또는 OS별 동등 경로)을 사용 — 두 설정 파일은 별개.

`~/.claude.json`의 글로벌 `mcpServers` 블록에 추가:

```json
{
  "mcpServers": {
    "pixel-agents-bridge": {
      "command": "node",
      "args": ["/Users/<you>/.local/share/pixel-office-bridge/server/index.mjs"]
    }
  }
}
```

저장 후 새 Claude Code 세션을 띄우면 tool 목록에 `mcp__pixel-agents-bridge__office_open`,
`mcp__pixel-agents-bridge__office_status`가 나타남.

## Verify

```bash
# MCP 서버가 떴는지
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7456/
# 200이면 viewer 정상

# 등록 확인
claude mcp list 2>/dev/null | grep pixel
```

## Troubleshooting — HUD 토큰 % 안 나옴

1. `office_open` 호출 로그에 `contextPercent` 인자가 있었는지 확인
   (없으면 HP 바/HUD 0% 고정)
2. 이 README 기준 버전(>=0.8.1)의 `.mcpb`로 재설치
3. Claude Desktop은 MCP `instructions` 캐시가 있을 수 있음 — 완전 재시작
4. Chrome 위젯 창에서 우클릭 → 검사 → Console에 WS 에러 있는지 확인

## Troubleshooting — Chrome Translate 배너가 위젯 위에 뜸

이미 코드에서 `--disable-features=Translate,TranslateUI,LanguageDetection,DialogScrollback` +
`--disable-translate` 플래그를 박아둠. 그래도 뜨면:
- 다른 Chrome 인스턴스가 같은 user-data-dir을 점유 중일 수 있음 →
  `~/Library/Application Support/pixel-office-widget` 닫고 재시도
- 수동으로 Chrome `--app=`을 직접 띄울 때는 위 플래그를 빠뜨리지 말 것

## Log format (legacy desktop-activity.jsonl)

IntelliJ 플러그인과 페어링할 때 쓰던 옛날 포맷. 현재 버전은 Claude의 native log
(`~/Library/Logs/Claude/`, `~/.claude/projects/`) 직접 watching으로 대체.

## License

MIT
