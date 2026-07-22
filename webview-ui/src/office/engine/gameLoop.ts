import { MAX_DELTA_TIME_SEC } from '../../constants.js'

export interface GameLoopCallbacks {
  update: (dt: number) => void
  render: (ctx: CanvasRenderingContext2D) => void
}

/**
 * Visibility-aware rAF loop.
 *
 * Pauses when the document is hidden, when the embedding tool window pushes a
 * `pixel-agent:set-active=false` event, or when the canvas's 2D context is
 * lost. Resumes on the inverse signals. Each resume resets `lastTime` so the
 * first frame after a long pause doesn't see a `dt` measured in seconds
 * (which would teleport every character across the office).
 *
 * Context-loss handlers re-acquire the 2D context once Chromium restores it;
 * historically Canvas2D rarely loses context, but the GPU process crash that
 * preceded our 1차 freeze report suggests we cannot assume it stays alive
 * forever. The loop pauses for the duration of the loss to avoid drawing into
 * a stale handle.
 */
export function startGameLoop(
  canvas: HTMLCanvasElement,
  callbacks: GameLoopCallbacks,
): () => void {
  let ctx: CanvasRenderingContext2D | null = canvas.getContext('2d')
  if (ctx) ctx.imageSmoothingEnabled = false

  let lastTime = 0
  let rafId = 0
  let stopped = false
  /** Combined gate: paused when any of (document hidden, tool window inactive,
   *  canvas context lost) is true. */
  let paused = document.hidden
  let active = true
  let contextLost = false

  const requestNext = () => {
    if (stopped) return
    rafId = requestAnimationFrame(frame)
  }

  const frame = (time: number) => {
    if (stopped) return
    if (paused || !active || contextLost || !ctx) {
      // Keep the loop "running" so resume() is a single rAF away, but skip
      // update + render so we burn no CPU while idle.
      rafId = requestAnimationFrame(frame)
      return
    }
    // First frame after resume — clamp dt to one frame so characters don't
    // teleport based on real-world elapsed time during the pause.
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC)
    lastTime = time

    // Wrap update+render so a single bad frame doesn't sever the rAF
    // chain (which used to leave the canvas permanently frozen until
    // the webview was reloaded). The underlying error still gets
    // logged so the root cause is visible during development.
    try {
      callbacks.update(dt)
      ctx.imageSmoothingEnabled = false
      callbacks.render(ctx)
    } catch (err) {
      console.error('[PixelAgents gameLoop] frame error (continuing)', err)
    }

    requestNext()
  }

  const resetTimer = () => {
    // Forces the next frame to compute dt = 0 instead of (now - paused_at).
    lastTime = 0
  }

  const onVisibility = () => {
    if (document.hidden) {
      paused = true
    } else {
      paused = false
      resetTimer()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  // Kotlin → JS bridge for tool-window-level visibility (covers cases where
  // the IDE hides the tool window but the document.hidden flag stays false
  // because the JCEF browser is still attached to the Swing tree).
  const onSetActive = (e: Event) => {
    const detail = (e as CustomEvent).detail as { active?: boolean } | undefined
    const next = detail?.active ?? true
    if (next === active) return
    active = next
    if (active) resetTimer()
  }
  window.addEventListener('pixel-agent:set-active', onSetActive)

  // Canvas context-loss / restore. Pause the loop while lost so we don't
  // attempt to draw into an invalid handle.
  const onContextLost = (e: Event) => {
    e.preventDefault()  // required for Chromium to ever attempt a restore
    contextLost = true
    ctx = null
    console.warn('[PixelAgents gameLoop] canvas context lost')
  }
  const onContextRestored = () => {
    ctx = canvas.getContext('2d')
    if (ctx) ctx.imageSmoothingEnabled = false
    contextLost = false
    resetTimer()
    console.warn('[PixelAgents gameLoop] canvas context restored')
  }
  canvas.addEventListener('contextlost', onContextLost as EventListener)
  canvas.addEventListener('contextrestored', onContextRestored as EventListener)

  rafId = requestAnimationFrame(frame)

  return () => {
    stopped = true
    cancelAnimationFrame(rafId)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pixel-agent:set-active', onSetActive)
    canvas.removeEventListener('contextlost', onContextLost as EventListener)
    canvas.removeEventListener('contextrestored', onContextRestored as EventListener)
  }
}
