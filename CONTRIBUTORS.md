# Contributing to Pixel Agents for IntelliJ

Thanks for your interest in contributing! All contributions are welcome — features, bug fixes, documentation improvements, refactors, and more.

This project is licensed under the [MIT License](LICENSE), so your contributions will be too. No CLA or DCO is required.

## Getting Started

### Prerequisites

- JDK 21+
- [Node.js](https://nodejs.org/) (LTS recommended)
- IntelliJ IDEA (Community or Ultimate)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### Setup

```bash
git clone https://github.com/ngh96759788-coder/pixel-agents-intellij.git
cd pixel-agents-intellij

# Build the webview first (required before Gradle build)
cd webview-ui && npm install && npm run build && cd ..

# Build the plugin
./gradlew buildPlugin
```

### Running for Development

```bash
# Launch a sandboxed IDE instance with the plugin loaded
./gradlew runIde
```

Or open the project in IntelliJ IDEA and use the built-in Run Configuration.

### Running Tests

```bash
# Webview unit tests (Vitest)
cd webview-ui && npx vitest run
```

## Project Structure

| Directory | Description |
|---|---|
| `src/main/kotlin/` | Plugin backend — Kotlin, IntelliJ Platform SDK |
| `webview-ui/` | React + TypeScript frontend (separate Vite project) |
| `webview-ui/public/assets/` | Sprites, catalog JSON, default layouts per theme |
| `scripts/` | Asset extraction and generation tooling |

### Build Pipeline

1. `cd webview-ui && npm run build` — TypeScript check + Vite build to `dist/webview/`
2. `./gradlew buildPlugin` — compiles Kotlin, copies webview from `dist/webview/`, packages ZIP

Gradle alone does NOT rebuild webview assets. Always rebuild webview first after frontend changes.

## Code Guidelines

### Constants

All magic numbers and strings are centralized:

- **Plugin backend:** `src/main/kotlin/.../Constants.kt`
- **Webview:** `webview-ui/src/constants.ts`
- **CSS variables:** `webview-ui/src/index.css` `:root` block (`--pixel-*` properties)

### TypeScript Constraints

- No `enum` (`erasableSyntaxOnly`) — use `as const` objects
- `import type` required for type-only imports
- `noUnusedLocals` / `noUnusedParameters` enabled

### UI Styling

Pixel art aesthetic throughout:

- Sharp corners (`border-radius: 0`)
- Solid backgrounds and `2px solid` borders
- Hard offset shadows (`2px 2px 0px`, no blur)
- FS Pixel Sans font (loaded in `index.css`)

## Submitting a Pull Request

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Rebuild and test:
   ```bash
   cd webview-ui && npm run build && cd ..
   ./gradlew buildPlugin
   ```
4. Open a pull request against `main` with:
   - A clear description of what changed and why
   - How you tested the changes
   - **Screenshots or GIFs for any UI changes**

## Reporting Bugs

[Open an issue](https://github.com/ngh96759788-coder/pixel-agents-intellij/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- IDE version and OS

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
