# Pixel Agents for IntelliJ

An IntelliJ plugin that turns your Claude Code terminal sessions into animated pixel art characters in a virtual office.

Each Claude Code terminal you open spawns a character that walks around, sits at desks, and visually reflects what the agent is doing — typing when writing code, reading when searching files, waiting when it needs your attention.

Ported from [Pixel Agents for VS Code](https://github.com/pablodelucca/pixel-agents) by Pablo De Lucca, with additional features for the IntelliJ Platform.

![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Themes

### Office (Default)
<p align="center">
  <img src="webview-ui/public/preview-default.png" alt="Office theme characters" height="48" style="image-rendering: pixelated;">
</p>

<!-- 스크린샷: webview-ui/public/screenshot-office.png -->

### Alien (UFO)
<p align="center">
  <img src="webview-ui/public/preview-alien.png" alt="Alien theme characters" height="48" style="image-rendering: pixelated;">
</p>

<!-- 스크린샷: webview-ui/public/screenshot-alien.png -->

### Cat Tower
<p align="center">
  <img src="webview-ui/public/preview-cat.png" alt="Cat theme characters" height="48" style="image-rendering: pixelated;">
</p>

<!-- 스크린샷: webview-ui/public/screenshot-cat.png -->

## Features

- **One agent, one character** — every Claude Code terminal gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Sub-agent visualization** — Task/Agent sub-agents spawn as separate characters, including async background agents with independent JSONL tracking
- **Office layout editor** — design your office with floors, walls, and 80+ furniture items
- **Multiple themes** — default office, alien, and cat themes with unique characters and furniture
- **Speech bubbles** — visual indicators when an agent is waiting for input or needs permission
- **Sound notifications** — optional chime when an agent finishes its turn
- **Animated furniture** — wall clocks tick, desk fans spin, water coolers bubble
- **Persistent layouts** — your office design is saved across IDE restarts
- **External session adoption** — automatically detects Claude Code sessions started outside the plugin
- **Diverse characters** — 6 unique characters per theme with automatic palette diversity for sub-agents

## Requirements

- IntelliJ IDEA 2024.2+ (or any JetBrains IDE based on IntelliJ Platform 2024.2+)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured
- JBR (JetBrains Runtime) with JCEF support (included by default)

## Installation

### From JetBrains Marketplace

Search for **Pixel Agents** in Settings > Plugins > Marketplace.

### From ZIP

1. Download the latest `pixel-agents-intellij-x.x.x.zip` from [Releases](https://github.com/ngh96759788-coder/pixel-agents-intellij/releases)
2. Settings > Plugins > Gear icon > Install Plugin from Disk
3. Select the ZIP file and restart the IDE

## Usage

1. Open the **Pixel Agents** tool window (bottom panel)
2. Click **+ Agent** to spawn a new Claude Code terminal and its character
3. Start coding with Claude — watch the character react in real time
4. Click a character to select it, then click a seat to reassign it
5. Click **Layout** to open the office editor and customize your space

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — 7 patterns with full HSBC color control
- **Walls** — Auto-tiling walls with color customization
- **Furniture** — 80+ items across desks, chairs, electronics, decor, and wall items
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

The grid is expandable up to 64x64 tiles. Click the ghost border outside the current grid to grow it.

## Building from Source

### Prerequisites

- JDK 21+
- Node.js (LTS recommended)
- Gradle (wrapper included)

### Build

```bash
git clone https://github.com/ngh96759788-coder/pixel-agents-intellij.git
cd pixel-agents-intellij

# Build webview (must run before Gradle)
cd webview-ui && npm install && npm run build && cd ..

# Build plugin
./gradlew buildPlugin
```

The plugin ZIP will be at `build/distributions/pixel-agents-intellij-x.x.x.zip`.

### Development

```bash
# Run the IDE with plugin loaded for testing
./gradlew runIde
```

Or open the project in IntelliJ IDEA and use the pre-configured Run Configuration.

### Tests

```bash
# Webview unit tests
cd webview-ui && npx vitest run
```

## How It Works

Pixel Agents watches Claude Code's JSONL transcript files at `~/.claude/projects/<project-hash>/` to track what each agent is doing. When an agent uses a tool (like writing a file or running a command), the plugin detects it and updates the character's animation accordingly. No modifications to Claude Code are needed — it's purely observational.

For async sub-agents (background Agent tool), the plugin also monitors separate JSONL files at `<session-id>/subagents/agent-<id>.jsonl` to track their independent tool activity.

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle -> walk -> type/read). Everything is pixel-perfect at integer zoom levels.

## Tech Stack

- **Plugin**: Kotlin, IntelliJ Platform SDK, JCEF (Chromium Embedded Framework)
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Office Assets

The office tileset is [Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset) by **Donarg** on itch.io. This tileset is not included in the repository due to its license. The plugin works without it using built-in default assets. To use the full furniture catalog, purchase the tileset and run the asset import pipeline:

```bash
npm run import-tileset
```

## Attribution

This project is an IntelliJ Platform port of [Pixel Agents](https://github.com/pablodelucca/pixel-agents) by [Pablo De Lucca](https://github.com/pablodelucca), originally built as a VS Code extension. The core concepts — JSONL transcript watching, pixel art office rendering, character state machine — originate from the original project.

## Contributing

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for instructions on how to contribute.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## License

This project is licensed under the [MIT License](LICENSE).
