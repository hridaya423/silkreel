import { mod, smooth01 } from './curves'

/**
 * Decode flicker: a unit blinks on through a 5-step pattern, holds, then blinks
 * out through a 6-step one. Values are only ever 0, 0.35, or 1 — the reference's
 * hard blink, never a fade.
 */
export const DECODE_IN: number[][] = [
  [0.35, 0, 1, 0, 1],
  [1, 0, 0.35, 1, 1],
  [0.35, 1, 0, 1, 1],
  [1, 0.35, 0, 1, 1],
  [0, 1, 0, 0.35, 1],
  [0.35, 0.35, 1, 0, 1]
]
export const DECODE_OUT: number[][] = [
  [1, 0.35, 1, 0, 0.35, 0],
  [0.35, 1, 0, 0.35, 0, 0],
  [1, 0, 1, 0, 0.35, 0],
  [0.35, 0, 0.35, 1, 0, 0],
  [1, 1, 0, 0.35, 0, 0],
  [0, 1, 0.35, 0, 0, 0]
]

const IN_LEN = DECODE_IN[0]?.length ?? 0
const OUT_LEN = DECODE_OUT[0]?.length ?? 0


/**
 * visibility 0..1 of a unit at loop step `step` (integer for twos; fractional
 * allowed for smooth). inStep/outStep mark where decode-in and decode-out
 * begin; both wrap around the loop.
 */
export function decodeAlpha(
  step: number,
  inStep: number,
  outStep: number,
  pattern: number,
  steps: number,
  smooth = false
): number {
  const p = pattern % DECODE_IN.length
  const local = mod(step - inStep, steps)
  const hold = mod(outStep - inStep, steps)
  if (local < IN_LEN) {
    if (smooth) return smooth01(local / IN_LEN)
    return DECODE_IN[p]?.[Math.floor(local)] ?? 0
  }
  if (local < hold) return 1
  if (local < hold + OUT_LEN) {
    if (smooth) return 1 - smooth01((local - hold) / OUT_LEN)
    return DECODE_OUT[p]?.[Math.floor(local - hold)] ?? 0
  }
  return 0
}

/** a write-in that never falls back: each step of the decode holds the brightest level it has reached, so a mark that has landed whole stays whole */
export function steadyAlpha(step: number, inStep: number, outStep: number, pattern: number, steps: number, smooth = false): number {
  const local = Math.floor(mod(step - inStep, steps))
  if (smooth || local >= IN_LEN || local >= mod(outStep - inStep, steps)) return decodeAlpha(step, inStep, outStep, pattern, steps, smooth)
  return Math.max(...(DECODE_IN[pattern % DECODE_IN.length] ?? [0]).slice(0, local + 1))
}

/** the signal head: full ink while decoding in and for `flare` steps after, then `tone` */
export function flareTone(step: number, inStep: number, flare: number | undefined, tone: number, steps: number): number {
  if (flare === undefined) return tone
  return mod(Math.floor(step) - inStep, steps) < IN_LEN + flare ? 1 : tone
}

/** a hold breath: out for one step, half back for one, then whole again */
const BLINK = [0, 0.35]

export function blinkAlpha(step: number, blinks: readonly number[] | undefined, steps: number): number {
  if (blinks === undefined) return 1
  const s = Math.floor(step)
  for (const b of blinks) {
    const k = mod(s - b, steps)
    if (k < BLINK.length) return BLINK[k] as number
  }
  return 1
}
