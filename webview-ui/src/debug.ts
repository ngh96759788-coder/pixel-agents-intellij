/**
 * Lightweight debug-log gate. Diagnostic console output stays out of production
 * unless `localStorage.pixelAgentsDebug = '1'` is set in the JCEF console.
 *
 * Replaces ad-hoc `console.log(...)` calls so the JS console stays quiet during
 * normal operation. Real warnings/errors should still use `console.warn` /
 * `console.error` directly.
 */

let cachedEnabled: boolean | null = null

function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled
  try {
    cachedEnabled = typeof localStorage !== 'undefined'
      && localStorage.getItem('pixelAgentsDebug') === '1'
  } catch {
    cachedEnabled = false
  }
  return cachedEnabled!
}

export function debug(...args: unknown[]): void {
  if (isEnabled()) console.log(...args)
}
