import {
  NOTIFICATION_NOTE_1_HZ,
  NOTIFICATION_NOTE_2_HZ,
  NOTIFICATION_NOTE_1_START_SEC,
  NOTIFICATION_NOTE_2_START_SEC,
  NOTIFICATION_NOTE_DURATION_SEC,
  NOTIFICATION_VOLUME,
  SPAWN_NOTE_FREQUENCIES_HZ,
  SPAWN_NOTE_INTERVAL_SEC,
  SPAWN_NOTE_DURATION_SEC,
  SPAWN_VOLUME,
  DESPAWN_NOTE_FREQUENCIES_HZ,
  DESPAWN_NOTE_INTERVAL_SEC,
  DESPAWN_NOTE_DURATION_SEC,
  DESPAWN_VOLUME,
  THEME_SWITCH_SWEEP_START_HZ,
  THEME_SWITCH_SWEEP_END_HZ,
  THEME_SWITCH_DURATION_SEC,
  THEME_SWITCH_VOLUME,
} from './constants.js'

let soundEnabled = true
let audioCtx: AudioContext | null = null

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled
}

export function isSoundEnabled(): boolean {
  return soundEnabled
}

function playNote(ctx: AudioContext, freq: number, startOffset: number): void {
  playNoteGeneral(ctx, freq, startOffset, NOTIFICATION_VOLUME, NOTIFICATION_NOTE_DURATION_SEC)
}

function playNoteGeneral(ctx: AudioContext, freq: number, startOffset: number, volume: number, duration: number): void {
  const t = ctx.currentTime + startOffset
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, t)

  gain.gain.setValueAtTime(volume, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration)

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.start(t)
  osc.stop(t + duration)
}

export async function playDoneSound(): Promise<void> {
  if (!soundEnabled) return
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
    }
    // Resume suspended context (webviews suspend until user gesture)
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume()
    }
    // Ascending two-note chime: E5 → B5
    playNote(audioCtx, NOTIFICATION_NOTE_1_HZ, NOTIFICATION_NOTE_1_START_SEC)
    playNote(audioCtx, NOTIFICATION_NOTE_2_HZ, NOTIFICATION_NOTE_2_START_SEC)
  } catch {
    // Audio may not be available
  }
}

export async function playSpawnSound(): Promise<void> {
  if (!soundEnabled) return
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    for (let i = 0; i < SPAWN_NOTE_FREQUENCIES_HZ.length; i++) {
      playNoteGeneral(audioCtx, SPAWN_NOTE_FREQUENCIES_HZ[i], i * SPAWN_NOTE_INTERVAL_SEC, SPAWN_VOLUME, SPAWN_NOTE_DURATION_SEC)
    }
  } catch { /* Audio may not be available */ }
}

export async function playDespawnSound(): Promise<void> {
  if (!soundEnabled) return
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    for (let i = 0; i < DESPAWN_NOTE_FREQUENCIES_HZ.length; i++) {
      playNoteGeneral(audioCtx, DESPAWN_NOTE_FREQUENCIES_HZ[i], i * DESPAWN_NOTE_INTERVAL_SEC, DESPAWN_VOLUME, DESPAWN_NOTE_DURATION_SEC)
    }
  } catch { /* Audio may not be available */ }
}

export async function playThemeSwitchSound(): Promise<void> {
  if (!soundEnabled) return
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    const t = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(THEME_SWITCH_SWEEP_START_HZ, t)
    osc.frequency.exponentialRampToValueAtTime(THEME_SWITCH_SWEEP_END_HZ, t + THEME_SWITCH_DURATION_SEC)
    gain.gain.setValueAtTime(THEME_SWITCH_VOLUME, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + THEME_SWITCH_DURATION_SEC)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(t)
    osc.stop(t + THEME_SWITCH_DURATION_SEC)
  } catch { /* Audio may not be available */ }
}

/** Call from any user-gesture handler to ensure AudioContext is unlocked */
export function unlockAudio(): void {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume()
    }
  } catch {
    // ignore
  }
}
