/**
 * Whimsical "spinner verbs" shown ambiently above an actively-working
 * character — the same playful gerunds Claude Code's CLI flashes while
 * it thinks ("Cogitating…", "Flibbertigibbeting…").
 *
 * NOTE: the real word the CLI is showing at any instant is rendered
 * client-side and never written to the JSONL transcript, so the bridge
 * can't read it. We pick from our own curated list instead — the effect
 * is the same playful ambient signal, just not byte-for-byte the CLI's.
 *
 * Selection is deterministic from (character id, wall-clock time) so the
 * label stays stable for a cycle instead of flickering every frame, and
 * concurrent characters generally show different verbs at the same moment.
 */

export const SPINNER_VERBS: readonly string[] = [
  'Flibbertigibbeting',
  'Cogitating',
  'Pondering',
  'Ruminating',
  'Noodling',
  'Percolating',
  'Marinating',
  'Conjuring',
  'Finagling',
  'Frobnicating',
  'Spelunking',
  'Tinkering',
  'Mulling',
  'Wrangling',
  'Bamboozling',
  'Hornswoggling',
  'Discombobulating',
  'Schlepping',
  'Vibing',
  'Scheming',
  'Brewing',
  'Whirring',
  'Tessellating',
  'Bewitching',
  'Galumphing',
  'Kerfuffling',
]

/**
 * Pick a verb for a given character at a given moment. `seed` (the
 * character id) offsets the index so neighbouring characters don't all
 * land on the same word; `now` advances the index once per `cycleMs`.
 */
export function spinnerVerbFor(seed: number, now: number, cycleMs: number): string {
  const step = Math.floor(now / cycleMs)
  // `seed` may be negative for sub-agents (ids count down from -1); the
  // double-modulo keeps the index in range for either sign.
  const idx = (((step + seed) % SPINNER_VERBS.length) + SPINNER_VERBS.length) % SPINNER_VERBS.length
  return SPINNER_VERBS[idx]
}
