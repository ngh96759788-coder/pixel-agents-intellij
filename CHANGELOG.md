# Changelog

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
