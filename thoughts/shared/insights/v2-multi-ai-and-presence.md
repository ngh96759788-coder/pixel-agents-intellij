# V2 Insight — Multi-AI Detection & Cross-Machine Presence

Captured 2026-05-14. Defer to Pixel Office **v2**. Volume is significant;
not a v1 scope item.

## Problem

Today the office only visualizes **Claude Code** sessions on the **local
machine** that are descendants of the current IDE process. Two adjacent
axes are unaddressed:

1. **Other AI tools on the same PC** — Aider, Codex (OpenAI), Continue.dev,
   Cursor, Cline, Copilot Chat. A developer using two AI tools side by
   side only sees one in the office.
2. **Other people's AI usage** — teammates running Claude (or anything
   else) on their own machines. Pixel Office is single-player.

If we want the office metaphor to scale to "team workspace at a glance",
both axes need answers.

## Axis 1 — Local multi-AI detection

Each tool stores its conversation somewhere on disk or in IDE-local
state. Adopting the same JSONL-watcher pattern is feasible for some:

| Tool          | Transcript location                                       | Difficulty |
|---------------|-----------------------------------------------------------|------------|
| Claude Code   | `~/.claude/projects/<hash>/*.jsonl`                       | ✅ shipped |
| Aider         | `<project>/.aider.chat.history.md`                        | Easy — markdown parser |
| Codex (OpenAI)| `~/.codex/sessions/*.jsonl`                               | Easy |
| Continue.dev  | `<project>/.continue/sessions/`                           | Medium |
| Cursor        | IDE-local SQLite (proprietary schema)                     | Hard — schema drift |
| Cline / Roo   | VS Code globalStorage                                     | Hard — needs VS Code API |
| Copilot Chat  | IDE-local, no public file API                             | Effectively impossible without IDE-level hook |

**Process-tree fallback** as a secondary signal: list processes whose
basename matches `claude|aider|codex|cursor|…` and whose ancestry passes
through this IDE. Surface them as characters even without a transcript
(label = tool name; activity = unknown).

### Open design questions

- **Per-tool character art**: shared palette + per-tool prop (a coffee
  cup for Aider, a wrench for Codex), or distinct palettes?
- **Unifying status**: each tool's "Active / Idle / Wait" semantics
  differ. Map to a shared 3-state model?
- **Cost rollup**: do we aggregate token spend across tools in the
  BottomHUD, or keep per-tool sections?

## Axis 2 — Cross-machine presence

No way to see another machine without a coordination layer. Three
choices, ordered by complexity:

### Option A — LAN broadcast (mDNS / Bonjour)

Plugin instances announce themselves on the local network. Each
discovers peers via `_pixel-agents._tcp.local`. Faded "remote" avatars
appear in the office; clicking opens read-only summary.

- Pros: zero backend, zero auth, works in WFH meeting rooms / office.
- Cons: dead the moment people leave the LAN (remote work majority).
  Multicast often blocked on corp VPNs.

### Option B — Lightweight presence relay

A tiny server (e.g. Fly.io / Cloudflare Workers) that accepts heartbeat
posts from plugins:

```
POST /presence
{ user, machine, project, agentSummary: [...] }
```

Plugins poll/SSE-subscribe to teammate updates. Renders remote agents
as muted characters seated in a "remote desk" section of the office.

- Pros: works across machines / networks.
- Cons: server to host, auth needed, latency budget.
- Effort: ~1 week PoC if no auth, 2–3 weeks with SSO.

### Option C — AI Gateway (the most powerful path)

Route ALL AI CLI traffic (Claude Code, Aider, Codex…) through a
self-hosted gateway (LiteLLM / Portkey / Helicone). The gateway sees
every API call regardless of which tool emitted it. Plugin subscribes
to gateway events:

```
[Claude CLI Alice] ┐
[Aider Bob]        ├─→ [Gateway] ──→ [Anthropic / OpenAI / …]
[Cursor Carol]     ┘     │
                         ↓ SSE / WS
                  [Pixel Office plugins]
                  "Alice typing on Opus"
                  "Bob's sub-agent #3 waiting on Bash"
```

- Pros: solves BOTH axes simultaneously. Multi-tool + cross-machine in
  one stroke. Also unlocks team-wide cost/usage dashboards.
- Cons: heaviest infra. Self-hosted server, auth, scaling. Every dev
  has to re-point their CLI base URL. Privacy review (gateway sees
  prompts/responses).
- Effort: ~2-week PoC with LiteLLM stack. Ongoing ops cost.

### Existing gateways to evaluate

- [LiteLLM](https://github.com/BerriAI/litellm) — OSS, multi-provider,
  hooks/callbacks for observability. Strong starting point.
- [Portkey](https://portkey.ai/) — commercial, team dashboards built-in.
- [Helicone](https://www.helicone.ai/) — observability-focused, OSS core.
- [LangSmith](https://smith.langchain.com/) — observability, not a true
  gateway.

## Recommended v2 path

Three milestones, smallest first:

1. **M1 (1-2 weeks)** — Local multi-AI: Aider + Codex transcript watchers
   added alongside Claude Code. Same office, multiple character types.
   No new infra. Validates the metaphor extension.
2. **M2 (2-3 weeks)** — LAN presence via mDNS. Office shows in-LAN
   teammates as muted characters. Tests appetite for cross-machine view.
3. **M3 (4-6 weeks)** — Self-hosted LiteLLM gateway + plugin subscription.
   Replaces both file watching and LAN broadcast with a single
   authoritative event stream. The "team workspace" vision.

M3 is the destination; M1/M2 are stepping stones that ship value
incrementally and de-risk the gateway investment.

## Bonus axis — Browser-shareable office (HTTP/WS surface)

Same data, additional output surface. The IntelliJ plugin already hosts
the React webview in JCEF; add a sibling **embedded HTTP server**
(Ktor or NanoHTTPD) that serves the SAME bundle to any browser that hits
the URL.

```
[IntelliJ Plugin]
   ├─ JCEF webview (in IDE)
   └─ Embedded HTTP server (e.g. localhost:7456)
         ├─ Serves the React bundle as-is
         └─ WebSocket / SSE channel for live events
                ↓
       [Browser / phone / another laptop]
       Identical office, identical animations
```

### What enables this cheaply

- The React app reads everything through a single `postMessage` shim.
  Replace that with a thin WS adapter and ~90% of webview code is
  reused (sprites, layout, gameLoop, ToolOverlay…) without modification.
- Kotlin side already has every event the webview needs; just fan it
  out to additional listeners (the HTTP server's WS connections).
- No backend infra: the plugin IS the server.

### Concrete UX additions

- New `+ Share Office` toggle in `BottomToolbar`. Activated → embedded
  server starts, modal shows URL + QR code (for phone).
- Settings: bind address (`127.0.0.1` default, "LAN visible" opt-in
  toggle which binds to `0.0.0.0` + generates a short access token).
- For external sharing, recommend `cloudflared tunnel` / `ngrok` in the
  README — we don't reverse-tunnel ourselves.

### Use cases this unlocks

- Long-running build / agent task → close the laptop and watch on the
  phone next to coffee.
- Pair-programming demo → second person opens the URL, sees the same
  office without needing the IDE.
- Meetings → fullscreen browser tab on a TV, the team sees real-time
  agent activity instead of dashboards.

### Risks / open questions

- **Auth model**: even on `127.0.0.1`, malicious local processes could
  hit the port. Bind + same-origin policy + per-session token in URL
  fragment.
- **Multi-IDE-window**: if two IDE windows both run servers, picking a
  port (port range scan) and surfacing which is active in the URL list.
- **Read-only vs interactive**: browser view should NOT be able to
  trigger `+Agent` / layout edits without explicit auth. Default
  read-only.

### Effort

PoC ~1–2 weeks (Ktor embedded + WS bridge + URL/QR modal). Production
hardening (auth, multi-window, tunnel docs) another 1–2 weeks.

## MCP Apps iframe — split the role, don't reject

Initial reflex was to reject the iframe path because Pixel Office is
*ambient* and the iframe pattern in shipped MCP Apps (Figma, Shopify,
Three.js, Hex …) is **moment-bound** — a widget that decorates one
tool result, then the conversation moves on. Cramming the live office
into that frame fights the pattern.

But the iframe is still useful for *different* slices of the office —
just at the granularity of "Claude said something, here's a visual to
back it up". Live continuous view stays on the standalone app
(below); the iframe specializes in **inline visual punctuation**:

### Pattern A — Sub-agent / agent name-card

When Claude reports a sub-agent finishing, attach a small card with
the character's bust, status, and a 1-line activity summary. Like a
Spotify "Now Playing" tile inline with the response.

```
┌─────────────────────────────────────┐
│ [bust 32×32]                        │
│  kraken                              │
│  ✓ Edited 3 files · 12.3k tokens    │
│  2m14s Bash · 8s Read · 1m Edit     │
└─────────────────────────────────────┘
```

Iframe ~100×360 px, fits chat column fine. Static.

### Pattern B — Office snapshot (Polaroid)

`show_office()` tool returns one frozen frame of the current canvas at
zoom 1x, plus a small caption. Useful when the user asks "who's
working on what right now?" inside Claude Desktop — visual answer
instead of bullet list.

```
┌──────────────────────────────────┐
│ [pixel office snapshot 320×180]  │
│ 4 agents · 1 idle · 0 waiting    │
│ taken at 14:23:05                │
└──────────────────────────────────┘
```

Can also be rendered to PNG via `canvas.toDataURL()` and returned as
an `ImageContent` block — no iframe needed at all in that case.

### Pattern C — Short replay clip

`replay_recent(seconds=5)` returns a 3–5 second loop of the last few
seconds in the office. Iframe with a one-shot canvas timeline that
replays-once and freezes on the last frame. Either:
- Pre-baked GIF from server-side rendering, or
- iframe that ships the React canvas in *replay mode* — it consumes
  a recorded event list and plays it through rAF once.

Discord-style: hover the card and it plays; gives "what just happened"
context without forcing the user to alt-tab to the standalone window.

### Pattern D — Inline character portrait emojis

8×8 pixel busts as inline images mixed into Claude's text:

> `main 1` [▣] delegated to `kraken` [▢] who edited `foo.ts`. Now
> back to `main 1` [▣].

Implemented with MCP `ImageContent` content blocks, not an iframe at
all. Lightest possible touch.

### Why this works while live-office-in-chat doesn't

| | Live office in iframe | Snapshot / card / clip patterns |
|---|---|---|
| Time axis | continuous | one moment / short loop |
| Sync need | server push every frame | rendered at the tool call |
| Width budget | wants full canvas | a card fits |
| Persistence | needs always-on | tied to one chat message |
| Conceptual role | working environment | **visual punctuation** in Claude's prose |

### Synergy with the standalone app

The two are complementary, not competing:

- Standalone app = ambient live view, scroll-free, multi-window.
- MCP App iframe + image content = visual decoration on Claude
  Desktop replies, scrollable history of "what happened when".
- Clicking a card in chat could time-scrub the standalone app to that
  moment ("camera snap to t=14:23:05") — closes the loop between the
  punctuation and the continuous view.

This is the right place to land. Both surfaces, each doing what it's
best at.

## Better fit — Standalone ambient companion surface

Pixel Office should run as its **own desktop window**, separate from
any host LLM client. It's a Slack-mini-player / Spotify-mini-player
pattern: small, persistent, glanceable, lives outside the chat flow.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ STANDALONE PIXEL OFFICE (Electron or Tauri)                       │
│   ├─ Owns the React canvas, OfficeState, transcriptParser         │
│   ├─ Watches ~/.claude/projects/**/*.jsonl directly               │
│   └─ Optional embedded HTTP server → browser/phone view           │
└──────────────────────────────────────────────────────────────────┘
        ▲                ▲                       ▲
        │                │                       │
[IntelliJ plugin]    [Claude Desktop]    [Claude Code in any IDE]
 thin JCEF embed      MCP server (text   transcripts are picked up
 over standalone      tools only, no     transparently by the file
 React module         iframe needed)     watcher
```

### What each surface contributes

| Surface | Role |
|---|---|
| **Standalone app** (Electron / Tauri) | The UI. Always-on companion window, resizable, optionally always-on-top. Watches every JSONL on disk. |
| **IntelliJ plugin** | Thin wrapper that JCEF-embeds the *same* React module the standalone app ships. User can pick "show in IDE panel" vs "show in standalone window". |
| **MCP server bundled with the app** | Exposed to Claude Desktop. UI-less. Tools: `whoIsActive()`, `getAgentDigest(id)`, `open_office()` (launches/focuses the standalone window). Used as a Claude-aware *signal source*, not a UI host. |
| **Browser / phone view** | Embedded HTTP server on the standalone app exposes the same React bundle. Mobile / second-screen viewers connect via URL or QR. Read-only by default. |

### Why this beats every alternative we sketched

- One React module → three surfaces (IDE panel, standalone window,
  browser). No port-by-port reimplementation.
- Works for Claude Desktop users **without** the iframe constraints —
  Claude Desktop's MCP can ask the office text questions; if the user
  wants to see the office, the standalone app's own window opens.
- Cross-machine presence (Axis 2) plugs into the same standalone app;
  no need to wire it into each host's plugin model separately.
- Multi-AI (Axis 1) is just adding more transcript watchers to the
  standalone app; not an IDE-plugin retrofit.

### Phasing

1. **v2.x** — Extract the React module into a standalone package
   (currently `webview-ui/`). IntelliJ plugin imports it as a peer.
2. **v3.0** — Standalone Electron / Tauri shell + same React module.
   First release: read-only of local JSONLs. Browser/phone share via
   embedded HTTP.
3. **v3.x** — MCP server bundled with the app. Claude Desktop tool
   surface (no iframe, just text queries + open-window).
4. **v4** — Cross-machine presence relay or AI Gateway integration
   plugs into the standalone app's data layer.

## Legacy section (kept for reference) — Claude Desktop port via `.mcpb` Extension

Anthropic added a packaged extension format for Claude Desktop in 2025
(originally `.dxt`, renamed `.mcpb` / "MCP Bundle" in 2026). Each
extension is a zipped MCP server + manifest. Anthropic runs an in-app
curated store; individual developers can submit via the [Connectors /
Desktop Extension submission flow](https://claude.com/docs/connectors/building/submission).
Free only, automated test + security review, queue-dependent timing.
Sideloading (drag `.mcpb` onto Claude Desktop) also works.

### Key enabler — **MCP Apps** (formerly `mcp-ui`)

Tool result can reference a `ui://<id>` resource with MIME
`text/html;profile=mcp-app`. Host (Claude Desktop, VS Code Copilot,
Goose, Postman, MCPJam) renders it in a **sandboxed iframe** in the
chat. Bidirectional `postMessage` between iframe and MCP server.

→ **The same React canvas we already render in JCEF can render inside
Claude Desktop chat verbatim.** Same OfficeState, same sprites, same
gameLoop — just behind a different transport.

### What's possible vs blocked

| Capability                                | In Claude Desktop |
|-------------------------------------------|-------------------|
| Pixel-art canvas via MCP Apps iframe       | ✅ Full fidelity |
| Inline image / base64 content blocks       | ✅ |
| Streaming frame updates (`postMessage`)    | ✅ Real animation |
| Pop a separate native window               | ❌ Sandboxed iframe only |
| Auto-launch on Claude Desktop startup      | ❌ User has to invoke a tool first |
| Slash-command / button to invoke tool      | ⚠ Closest: iframe buttons call back via `postMessage`; no true `/slash` for tools |
| Read same JSONL as IDE plugin              | ✅ Same files under `~/.claude/projects/` |

### Reference precedents

- **[Claude Buddy](https://claudefa.st/blog/guide/mechanics/claude-buddy)** —
  Anthropic's own April Fools 2026 terminal pet inside Claude Code.
  Not MCP; baked into CLI.
- **[claude-code-tamagotchi](https://github.com/Ido-Levi/claude-code-tamagotchi)** —
  pet rendered by a **statusline command** that Claude Code re-invokes
  each render. State on disk, frame per tick. Mechanism is Claude Code-
  specific (no Claude Desktop statusline equivalent).
- **[codachi](https://github.com/vincent-k2026/codachi)** — same
  statusline-pet pattern.

### Recommended v3 path

Single `.mcpb` extension that watches `~/.claude/projects/**/*.jsonl`
and serves an `ui://office` MCP App. The iframe runs our existing canvas.

Outcome: **one office state across surfaces** — IntelliJ panel + browser
URL (from the HTTP/WS axis above) + Claude Desktop chat embed. The same
character animates across all three when the user works in any of them.

### Fallback — ASCII pet via tool text

If MCP Apps proves unreliable (the [iframe handshake bug
#165](https://github.com/anthropics/claude-ai-mcp/issues/165) is still
open as of writing), degrade to a tamagotchi-style ASCII pet returned
as plain text from a tool call. Static one frame per invocation, no
real-time animation, but still surfaces "an agent is alive here"
context inside Claude Desktop conversations.

### Effort

- MCP Apps path PoC: 1–2 weeks (reuses 90% of current React canvas
  + transcript parser).
- ASCII fallback: a few days.
- Marketplace submission + review: queue-dependent, weeks not months.

### Things to confirm before committing

- MCP Apps iframe reliability across Claude Desktop versions (test
  on macOS + Windows builds; the bug #165 thread suggests Windows
  edge cases).
- Marketplace policy on third-party local file watchers — our
  extension reads JSONL transcripts of all the user's Claude sessions.
- Whether we can ship a single artifact that works as IntelliJ plugin
  AND `.mcpb` — likely not (different runtimes); plan as separate
  artifacts sharing the same React module via a monorepo.

## Things to verify before committing

- License / TOS for routing Anthropic traffic through a self-hosted
  gateway. Anthropic terms have changed over time; assume okay for
  internal infra, but confirm.
- Privacy posture: prompts often contain proprietary code. Gateway
  must be on-prem or under company-controlled cloud. Vendor-hosted
  gateways (Portkey SaaS) likely blocked at most companies.
- IntelliJ plugin marketplace policy on background network calls (we
  already do localhost-only; SSE to a team relay is a different posture).
