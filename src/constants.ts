// ── Timing (ms) ──────────────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 2000;
export const PROJECT_SCAN_INTERVAL_MS = 1000;
export const TOOL_DONE_DELAY_MS = 300;
export const PERMISSION_TIMER_DELAY_MS = 7000;
export const TEXT_IDLE_DELAY_MS = 5000;

// ── Display Truncation ──────────────────────────────────────
export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── PNG / Asset Parsing ─────────────────────────────────────
export const PNG_ALPHA_THRESHOLD = 128;
export const WALL_PIECE_WIDTH = 16;
export const WALL_PIECE_HEIGHT = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;
export const FLOOR_PATTERN_COUNT = 7;
export const FLOOR_TILE_SIZE = 16;
export const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;
export const CHAR_FRAMES_PER_ROW = 7;
export const CHAR_COUNT = 6;

// ── User-Level Layout Persistence ─────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;

// ── Settings Persistence ────────────────────────────────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
export const GLOBAL_KEY_THEME = 'pixel-agents.theme';

// ── Theme Definitions ──────────────────────────────────────
export const THEME_DEFAULT = 'default';
export const THEME_ALIEN = 'alien';
export const THEME_ZOO = 'zoo';
export const VALID_THEMES = [THEME_DEFAULT, THEME_ALIEN, THEME_ZOO] as const;
export type ThemeId = typeof VALID_THEMES[number];

/** Maps theme ID to the characters subdirectory name */
export const THEME_CHAR_DIRS: Record<string, string> = {
  [THEME_DEFAULT]: 'characters',
  [THEME_ALIEN]: 'characters-alien',
  [THEME_ZOO]: 'characters-zoo',
};

/** Maps theme ID to floors PNG filename */
export const THEME_FLOOR_FILES: Record<string, string> = {
  [THEME_DEFAULT]: 'floors.png',
  [THEME_ALIEN]: 'floors-alien.png',
  [THEME_ZOO]: 'floors-zoo.png',
};

/** Maps theme ID to walls PNG filename */
export const THEME_WALL_FILES: Record<string, string> = {
  [THEME_DEFAULT]: 'walls.png',
  [THEME_ALIEN]: 'walls-alien.png',
  [THEME_ZOO]: 'walls-zoo.png',
};

/** Maps theme ID to furniture subdirectory */
export const THEME_FURNITURE_DIRS: Record<string, string> = {
  [THEME_DEFAULT]: 'furniture',
  [THEME_ALIEN]: 'furniture-alien',
  [THEME_ZOO]: 'furniture',
};

/** Maps theme ID to bundled default layout filename */
export const THEME_DEFAULT_LAYOUTS: Record<string, string> = {
  [THEME_DEFAULT]: 'default-layout.json',
  [THEME_ALIEN]: 'default-layout-alien.json',
  [THEME_ZOO]: 'default-layout.json',
};

/** Maps theme ID to user-level layout filename in ~/.pixel-agents/ */
export const THEME_LAYOUT_FILES: Record<string, string> = {
  [THEME_DEFAULT]: 'layout.json',
  [THEME_ALIEN]: 'layout-alien.json',
  [THEME_ZOO]: 'layout-zoo.json',
};

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'pixel-agents.exportDefaultLayout';
export const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
export const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';
export const WORKSPACE_KEY_LAYOUT = 'pixel-agents.layout';
export const TERMINAL_NAME_PREFIX = 'Claude Code';
