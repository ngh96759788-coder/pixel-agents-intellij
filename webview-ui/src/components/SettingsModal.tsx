import { useState } from 'react'
import { vscode } from '../vscodeApi.js'
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js'

interface OverlayDefaultsView {
  identityDot: boolean
  tokenBar: boolean
  status: boolean
  tether: boolean
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  currentTheme: string
  overlayDefaults: OverlayDefaultsView
  onOverlayDefaultChange: (kind: keyof OverlayDefaultsView, enabled: boolean) => void
  sharedLayoutAcrossProjects: boolean
  onToggleSharedLayout: (enabled: boolean) => void
  /** Unified view (BEHAVIOR_SPEC §4): show external-source agents (other
   *  windows / Desktop / CLI) at 85% opacity. Default OFF = own work only. */
  unifiedView: boolean
  onToggleUnifiedView: (enabled: boolean) => void
}

const OVERLAY_ITEMS: Array<{ key: keyof OverlayDefaultsView; label: string }> = [
  { key: 'identityDot', label: 'Show identity dot' },
  { key: 'tokenBar', label: 'Show token bar' },
  { key: 'status', label: 'Show status label' },
  { key: 'tether', label: 'Show sub-agent line' },
]

const menuItemBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '6px 10px',
  fontSize: '24px',
  color: 'rgba(255, 255, 255, 0.8)',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  cursor: 'pointer',
  textAlign: 'left',
}

const THEMES = [
  { id: 'default', label: 'Office' },
  { id: 'alien', label: 'UFO' },
  { id: 'cat', label: 'Cat Cafe' },
]

export function SettingsModal({ isOpen, onClose, isDebugMode, onToggleDebugMode, currentTheme, overlayDefaults, onOverlayDefaultChange, sharedLayoutAcrossProjects, onToggleSharedLayout, unifiedView, onToggleUnifiedView }: SettingsModalProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled)
  const [themeLocal, setThemeLocal] = useState(currentTheme)

  if (!isOpen) return null

  return (
    <>
      {/* Dark backdrop — click to close */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 49,
        }}
      />
      {/* Centered modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 50,
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          padding: '4px',
          boxShadow: 'var(--pixel-shadow)',
          minWidth: 240,
        }}
      >
        {/* Header with title and X button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 10px',
            borderBottom: '1px solid var(--pixel-border)',
            marginBottom: '4px',
          }}
        >
          <span style={{ fontSize: '24px', color: 'rgba(255, 255, 255, 0.9)' }}>Settings</span>
          <button
            onClick={onClose}
            onMouseEnter={() => setHovered('close')}
            onMouseLeave={() => setHovered(null)}
            style={{
              background: hovered === 'close' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
              border: 'none',
              borderRadius: 0,
              // × (U+00D7) + shared close-button vars — same glyph/colors as
              // ToolOverlay's close button so every "close" affordance matches.
              color: hovered === 'close' ? 'var(--pixel-close-hover)' : 'var(--pixel-close-text)',
              fontSize: '24px',
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        {/* Menu items */}
        <button
          onClick={() => {
            vscode.postMessage({ type: 'openSessionsFolder' })
            onClose()
          }}
          onMouseEnter={() => setHovered('sessions')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'sessions' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          Open Sessions Folder
        </button>
        <button
          onClick={() => {
            vscode.postMessage({ type: 'exportLayout' })
            onClose()
          }}
          onMouseEnter={() => setHovered('export')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'export' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          Export Layout
        </button>
        <button
          onClick={() => {
            vscode.postMessage({ type: 'importLayout' })
            onClose()
          }}
          onMouseEnter={() => setHovered('import')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'import' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          Import Layout
        </button>
        {/* Theme selector */}
        <div
          style={{
            ...menuItemBase,
            justifyContent: 'flex-start',
            cursor: 'default',
            gap: 2,
          }}
        >
          <span style={{ flexShrink: 0, marginRight: 4 }}>Theme</span>
          <div style={{ display: 'flex', gap: 1 }}>
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setThemeLocal(t.id)
                  vscode.postMessage({ type: 'setTheme', theme: t.id })
                }}
                onMouseEnter={() => setHovered(`theme-${t.id}`)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  padding: '2px 6px',
                  fontSize: '18px',
                  background: themeLocal === t.id
                    ? 'rgba(90, 140, 255, 0.8)'
                    : hovered === `theme-${t.id}`
                      ? 'rgba(255, 255, 255, 0.12)'
                      : 'rgba(255, 255, 255, 0.05)',
                  color: themeLocal === t.id ? '#fff' : 'rgba(255, 255, 255, 0.7)',
                  border: themeLocal === t.id ? '2px solid rgba(90, 140, 255, 0.6)' : '2px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: 0,
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => {
            const newVal = !isSoundEnabled()
            setSoundEnabled(newVal)
            setSoundLocal(newVal)
            vscode.postMessage({ type: 'setSoundEnabled', enabled: newVal })
          }}
          onMouseEnter={() => setHovered('sound')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'sound' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          <span>Sound Notifications</span>
          <span
            style={{
              width: 14,
              height: 14,
              border: '2px solid rgba(255, 255, 255, 0.5)',
              borderRadius: 0,
              background: soundLocal ? 'rgba(90, 140, 255, 0.8)' : 'transparent',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              lineHeight: 1,
              color: '#fff',
            }}
          >
            {soundLocal ? 'X' : ''}
          </span>
        </button>
        {/* Cross-project layout sharing toggle. OFF (default): each
            IntelliJ project keeps its own scope dir. ON: all windows
            read/write ~/.pixel-agents/shared/ so layout edits propagate. */}
        <button
          onClick={() => onToggleSharedLayout(!sharedLayoutAcrossProjects)}
          onMouseEnter={() => setHovered('sharedLayout')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'sharedLayout' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          <span>Share Layout Across Projects</span>
          <span
            style={{
              width: 14,
              height: 14,
              border: '2px solid rgba(255, 255, 255, 0.5)',
              borderRadius: 0,
              background: sharedLayoutAcrossProjects ? 'rgba(90, 140, 255, 0.8)' : 'transparent',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              lineHeight: 1,
              color: '#fff',
            }}
          >
            {sharedLayoutAcrossProjects ? 'X' : ''}
          </span>
        </button>
        {/* Unified view toggle (BEHAVIOR_SPEC §4). OFF (default): only this
            window's own agents. ON: agents from other sources (other IDE
            windows / Desktop / CLI) also appear, at 85% opacity. */}
        <button
          onClick={() => onToggleUnifiedView(!unifiedView)}
          onMouseEnter={() => setHovered('unifiedView')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'unifiedView' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          <span>Unified View (Show Other Sources)</span>
          <span
            style={{
              width: 14,
              height: 14,
              border: '2px solid rgba(255, 255, 255, 0.5)',
              borderRadius: 0,
              background: unifiedView ? 'rgba(90, 140, 255, 0.8)' : 'transparent',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              lineHeight: 1,
              color: '#fff',
            }}
          >
            {unifiedView ? 'X' : ''}
          </span>
        </button>
        {/* Always-on overlay toggles — each defaults to off (hover-only) so
            the canvas stays clean. Flipping a row makes that element render
            above every character regardless of hover/selection. */}
        <div
          style={{
            margin: '4px 10px',
            padding: '4px 0',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            fontSize: '14px',
            color: 'rgba(255, 255, 255, 0.55)',
            letterSpacing: 0.4,
          }}
        >
          ALWAYS-ON OVERLAYS
        </div>
        {OVERLAY_ITEMS.map((item) => {
          const checked = overlayDefaults[item.key]
          const hoverKey = `overlay-${item.key}`
          return (
            <button
              key={item.key}
              onClick={() => onOverlayDefaultChange(item.key, !checked)}
              onMouseEnter={() => setHovered(hoverKey)}
              onMouseLeave={() => setHovered(null)}
              style={{
                ...menuItemBase,
                background: hovered === hoverKey ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
              }}
            >
              <span>{item.label}</span>
              <span
                style={{
                  width: 14,
                  height: 14,
                  border: '2px solid rgba(255, 255, 255, 0.5)',
                  borderRadius: 0,
                  background: checked ? 'rgba(90, 140, 255, 0.8)' : 'transparent',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  lineHeight: 1,
                  color: '#fff',
                }}
              >
                {checked ? 'X' : ''}
              </span>
            </button>
          )
        })}
        <button
          onClick={onToggleDebugMode}
          onMouseEnter={() => setHovered('debug')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'debug' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          <span>Debug View</span>
          {isDebugMode && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'rgba(90, 140, 255, 0.8)',
                flexShrink: 0,
              }}
            />
          )}
        </button>
      </div>
    </>
  )
}
