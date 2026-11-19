import { DECODE_IN, GLYPH_LOOP_BEATS } from '@silk-reel/choreo'
import type { GlyphTimeline } from '@silk-reel/choreo'

export interface GlyphLight {
  /** the whole picture's lift at a frame, 0 to 1 */
  lift: (frame: number) => number
  /** the lift a mark gets at a frame from the pulse that runs through its formation, 0 to 1 */
  sweep: (frame: number, index: number) => number
  /** a field mark's raised tone at a frame, 0 to 1: the front of its stage's wave as it lands, the button's ring, and the lit connector pads */
  raise: (frame: number, index: number) => number
  /** a field mark's warm glow at a frame, 0 to 1 */
  shine: (frame: number, index: number) => number
  /** a mark's size at a frame, 1 at rest, larger while a front or the ring passes it */
  swell: (frame: number, index: number) => number
  /** the frames the field's build starts something: each stage's wave, the lock, the button */
  starts: number[]
  /** the lock's flash at a frame: 1 on the lock, falling to 0 */
  flash: (frame: number) => number
}

const LIFT_AT_TURN = 0.22
const SWEEP_SHARE_AND_HEIGHT: ReadonlyArray<readonly [number, number]> = [[4, 0.45], [3, 0.7], [2, 1]]
const SWEEP_WIDTH_IN_WRITE_ORDER = 0.18
const HELD_AFTER_PULSE = 0.8
const TOP_ENDS_FRAMES_BEFORE_NEXT = 16
const FALL_FRAMES = 12
const FLASH_FRAMES = 10
const LOOP_BEATS = GLYPH_LOOP_BEATS
const DECODE_IN_STEPS = DECODE_IN[0]?.length ?? 5
const FRONT_FRAMES = 3
const FRONT_SHINE = 0.8
const FRONT_SWELL = 0.35
const RING_FRAMES = 16
const RING_WIDTH = 0.07
const RING_SWELL = 0.35
const HERO_SHINE = 0.75
const FIRE_SETTLE_FRAMES = 12
const EXIT_SHINE = 0.65
const EXIT_SWELL = 0.7

const smooth = (u: number): number => {
  const t = Math.min(1, Math.max(0, u))
  return t * t * (3 - 2 * t)
}
const none = (): number => 0
const dark: GlyphLight = { lift: none, sweep: none, raise: none, shine: none, swell: () => 1, starts: [], flash: none }

/**
 * The film's one peak of light, and the field's build. Pulses run through the
 * formation before the named one, in the order its marks wrote in, each
 * faster and higher, from a beat before it locks until it starts to leave; each
 * leaves the marks it passed glowing at most of its height until the turn. From the turn the whole picture rises, faster as it
 * goes, and reaches full on the frame the named formation locks; it holds and
 * falls as that formation leaves. The named formation is the field: its main
 * chip fires at full glow as it lands on the scene's first beat, and each of
 * its marks is at full tone and size as its stage's wave lands it, then
 * settles. One beat after the name a ring leaves the main chip and crosses
 * the field, and the connector pads where the chip's nets leave the board
 * light as it reaches them and stay lit. It only adds light.
 */
export function glyphLight(tl: GlyphTimeline): GlyphLight {
  const turn = tl.events.find((e) => e.kind === 'turn')?.at
  const at = tl.pulls.findIndex(([a]) => a === turn)
  const pull = tl.pulls[at]
  if (turn === undefined || pull === undefined) return dark
  const lock = pull[1]
  const loop = Math.round((tl.steps * tl.fps) / 15)
  const leaves = tl.events.find((e) => e.kind === 'form' && e.at > lock)?.at ?? Infinity
  const top = Math.max(lock, leaves - TOP_ENDS_FRAMES_BEFORE_NEXT)
  const before = tl.pulls[at - 1]?.[1]
  const order = [...tl.formations].sort((a, b) => a.startPhase - b.startPhase)
  const named = order.findIndex((f) => Math.abs(Math.round(f.startPhase * loop) - turn) <= 1)
  const prior = order[named - 1]

  const rank = new Map<number, number>()
  const spans: Array<[number, number, number]> = []
  if (before !== undefined && prior !== undefined && before < turn) {
    const start = Math.round(prior.startPhase * tl.steps)
    const late = tl.placements.map((p, i) => [i, p.formation === prior.beat ? (p.inStep - start + tl.steps) % tl.steps : -1] as const).filter(([, s]) => s >= 0 && s < tl.steps / 2)
    const far = (i: number): number => Math.hypot(tl.placements[i]?.atoms[0]?.x ?? 0, tl.placements[i]?.atoms[0]?.y ?? 0)
    late.sort((a, b) => a[1] - b[1] || far(a[0]) - far(b[0]))
    late.forEach(([i], k) => rank.set(i, k / Math.max(1, late.length - 1)))
    const whole = SWEEP_SHARE_AND_HEIGHT.reduce((n, [w]) => n + w, 0)
    const leaves = Math.min(turn, ...tl.placements.filter((p) => p.formation === prior.beat).map((p) => Math.round((p.outStep * tl.fps) / 15)).filter((f) => f > before))
    const from = before - Math.round(loop / LOOP_BEATS)
    let a = from
    for (const [w, height] of SWEEP_SHARE_AND_HEIGHT) {
      const b = spans.length === SWEEP_SHARE_AND_HEIGHT.length - 1 ? leaves : a + ((leaves - from) * w) / whole
      spans.push([a, b, height])
      a = b
    }
  }
  const rises = before ?? turn

  const frameOf = (step: number): number => Math.round((step * tl.fps) / 15)
  const lands = tl.placements.map((p) => (p.stage === undefined ? Infinity : frameOf(p.inStep + DECODE_IN_STEPS)))
  const stageStarts = [...new Set(tl.placements.filter((p) => p.stage !== undefined && p.stage < 4).map((p) => p.stage as number))]
    .map((st) => frameOf(Math.min(...tl.placements.filter((p) => p.stage === st).map((p) => p.inStep))))
    .sort((a, b) => a - b)
  const button = tl.events.find((e) => e.kind === 'button')?.at ?? Infinity
  const head = (frame: number): number => -RING_WIDTH + ((1 + 2 * RING_WIDTH) * (frame - button)) / RING_FRAMES
  const ring = (frame: number, r: number): number => (frame < button ? 0 : Math.exp(-(((head(frame) - r) / RING_WIDTH) ** 2)))
  const behind = (frame: number, r: number): number => (frame < button ? 0 : smooth((head(frame) - r) / RING_WIDTH + 0.5))
  const front = (frame: number, index: number): number => {
    const land = lands[index] ?? Infinity
    return frame < land - FRONT_FRAMES || frame > land + 3 * FRONT_FRAMES ? 0 : Math.exp(-(((frame - land) / FRONT_FRAMES) ** 2))
  }
  const exit = (frame: number, index: number): number => {
    const p = tl.placements[index]
    return p?.link === 'exit' ? behind(frame, p.reach ?? 0) : 0
  }
  const sweeping = (frame: number, index: number): number => ring(frame, tl.placements[index]?.reach ?? 0)
  const fired = (stageStarts[0] ?? Infinity) + Math.round((DECODE_IN_STEPS * tl.fps) / 15)
  const fire = (frame: number): number => (frame < turn ? 0 : frame <= fired ? 1 : 1 - smooth((frame - fired) / FIRE_SETTLE_FRAMES))

  return {
    lift: (frame) => {
      if (frame < rises) return 0
      if (frame < turn) return LIFT_AT_TURN * smooth((frame - rises) / (turn - rises))
      if (frame < lock) return LIFT_AT_TURN + (1 - LIFT_AT_TURN) * ((frame - turn) / (lock - turn)) ** 2
      if (frame < top) return 1
      return 1 - smooth((frame - top) / FALL_FRAMES)
    },
    sweep: (frame, index) => {
      const r = rank.get(index)
      if (r === undefined) return 0
      let best = 0
      spans.forEach(([a, b, height]) => {
        if (frame < a || frame >= turn) return
        const h = -2 * SWEEP_WIDTH_IN_WRITE_ORDER + (1 + 4 * SWEEP_WIDTH_IN_WRITE_ORDER) * (Math.min(frame, b) - a) / (b - a)
        if (frame < b) best = Math.max(best, height * Math.exp(-(((h - r) / SWEEP_WIDTH_IN_WRITE_ORDER) ** 2)))
        best = Math.max(best, height * HELD_AFTER_PULSE * smooth((h - r) / SWEEP_WIDTH_IN_WRITE_ORDER))
      })
      return best
    },
    raise: (frame, index) => {
      const p = tl.placements[index]
      if (p?.stage === undefined) return 0
      if (p.role === 'hero') return 1
      return Math.max(front(frame, index), sweeping(frame, index), exit(frame, index))
    },
    shine: (frame, index) => {
      const p = tl.placements[index]
      if (p?.stage === undefined) return 0
      if (p.role === 'hero') return Math.max(HERO_SHINE, fire(frame), sweeping(frame, index))
      return Math.max(FRONT_SHINE * front(frame, index), sweeping(frame, index), EXIT_SHINE * exit(frame, index))
    },
    swell: (frame, index) => {
      const p = tl.placements[index]
      if (p?.stage === undefined || p.role === 'hero') return 1
      return 1 + Math.max(FRONT_SWELL * front(frame, index), RING_SWELL * sweeping(frame, index), EXIT_SWELL * exit(frame, index))
    },
    starts: stageStarts.length === 0 ? [] : [...stageStarts, lock, button],
    flash: (frame) => (frame < lock || frame >= lock + FLASH_FRAMES ? 0 : (1 - (frame - lock) / FLASH_FRAMES) ** 2)
  }
}
