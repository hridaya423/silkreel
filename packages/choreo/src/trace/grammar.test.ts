import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import type { Aspect, FilmConfig, TraceScene } from '../types'
import { inSight, makeCam, nearCover, project, sampleShot } from './camera'
import { buildTraceScene } from './scene'
import { TAKE_TALL } from './shots'
import { boardModel } from '../../test/helpers'

const BOARDS = ['glasgow', 'icebreaker', 'kit-dev-coldfire-xilinx_5213', 'StickHub']
const ASPECTS: Aspect[] = ['16:9', '4:5', '9:16', '1:1']
const DEG = 180 / Math.PI
const STEP = 1 / (24 * 8)
const BEAT = 1 / 24

function build(name: string, aspect: Aspect): { s: TraceScene; W: number; H: number } {
  const config: FilmConfig = {
    style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', title: { name: name.slice(0, 8) }, output: { width: 1080, height: 1350, fps: 30 }
  }
  const r = resolveConfig(config)
  return { s: buildTraceScene(boardModel(`${name}.kicad_pcb`), r, 42).scene, W: r.width, H: r.height }
}

function tallInFrame(s: TraceScene, p: number, W: number, H: number): number {
  const cam = makeCam(sampleShot(s.shots, p), W, H)
  const ys = s.board.flatMap((loop) => Array.from({ length: loop.length / 2 }, (_, i) => project(cam, loop[2 * i] as number, loop[2 * i + 1] as number, 0))).filter((q) => q.w > 0).map((q) => q.y)
  return (Math.min(1, Math.max(...ys)) - Math.max(-1, Math.min(...ys))) / 2
}

function wholeInFrame(s: TraceScene, p: number, W: number, H: number): boolean {
  const cam = makeCam(sampleShot(s.shots, p), W, H)
  return s.board.every((loop) => {
    for (let i = 0; i + 1 < loop.length; i += 2) {
      const q = project(cam, loop[i] as number, loop[i + 1] as number, 0)
      if (q.w <= 0 || Math.abs(q.x) > 1 || Math.abs(q.y) > 1) return false
    }
    return true
  })
}

function takes(s: TraceScene): Array<[number, number]> {
  const cuts = s.shots.filter((k) => k.cut === true).map((k) => k.t)
  const bounds = [0, ...cuts, 1]
  return bounds.slice(0, -1).map((a, i) => [a, bounds[i + 1] as number])
}

/** over the ride's first 45 frames: the lit copper in sight past every part box (frame widths) every second frame, and the longest run of frames where one part nearer than the lens's target covers a quarter of the frame */
export function rideSight(s: TraceScene, W: number, H: number): { seen: Array<[number, number]>; wall: number } {
  const hero = s.parts.find((pt) => pt.hero === true)
  const others = s.parts.filter((pt) => pt.hero !== true && (hero === undefined || pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
  const from = Math.round(s.acts.power[0] * 360)
  const seen: Array<[number, number]> = []
  let run = 0
  let wall = 0
  for (let f = from; f < from + 45; f++) {
    const p = f / 360
    const cam = makeCam(sampleShot(s.shots, p), W, H)
    run = nearCover(cam, W, H, others, 0.85 * cam.dist) > 0.25 ? run + 1 : 0
    wall = Math.max(wall, run)
    if ((f - from) % 2 === 1) continue
    let sum = 0
    for (const l of s.layers) {
      if (l.side !== 'F') continue
      for (let i = 0; i < l.groups.length; i++) {
        const e = Math.min(l.energy[2 * i] as number, l.energy[2 * i + 1] as number)
        if (e < 0 || e > p) continue
        const o = 7 * i
        const [x0, y0, x1, y1] = [l.segs[o], l.segs[o + 1], l.segs[o + 2], l.segs[o + 3]] as [number, number, number, number]
        const a = project(cam, x0, y0, 0)
        const b = project(cam, x1, y1, 0)
        if (a.w <= 0 || b.w <= 0 || Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)) > 1) continue
        if (inSight(cam, (x0 + x1) / 2, (y0 + y1) / 2, 0, s.parts)) sum += Math.hypot(((a.x - b.x) * W) / 2, ((a.y - b.y) * H) / 2) / W
      }
    }
    seen.push([f, sum])
  }
  return { seen, wall }
}

describe('the trace film is shot, not orbited', () => {
  for (const name of BOARDS) {
    for (const aspect of ASPECTS) {
      describe(`${name} @ ${aspect}`, () => {
        const { s, W, H } = build(name, aspect)
        const samples = Array.from({ length: Math.round(1 / STEP) }, (_, i) => i * STEP)
        const tilt = (p: number): number => sampleShot(s.shots, p).tilt * DEG
        const look = takes(s).at(-2) as [number, number]
        const looking = (p: number): boolean => p >= look[0] - 1e-6 && p < look[1] + 1e-6

        it('is seen from above only in its one look at the whole lit board: every other frame is at least 60° from the vertical (54° in a tall frame, where the whole board would be a sliver)', () => {
          expect(tilt(look[0])).toBeLessThan(5)
          const high = samples.filter((p) => !looking(p) && tilt(p) < (H > W ? 54 : 60) - 1e-6)
          expect(high.map((p) => (p * 360).toFixed(0))).toEqual([])
        })

        it('opens low and close in the dark: the first frame is at a grazing angle on a long lens and does not show the board whole', () => {
          const k = sampleShot(s.shots, 0)
          expect(k.tilt * DEG).toBeGreaterThanOrEqual(65)
          expect(k.fov * DEG).toBeLessThanOrEqual(16)
          expect(s.shots[0]?.light).toBe('spark')
        })

        it('shows the whole board twice, under its coat before the power-on (or the coat moved in to TAKE_TALL of the height) and lit from above before the last frame, and nowhere else', () => {
          const [from, to] = takes(s)[1] as [number, number]
          expect(wholeInFrame(s, from + 1e-4, W, H) || tallInFrame(s, from + 1e-4, W, H) >= TAKE_TALL.sheen).toBe(true)
          expect(to).toBeLessThanOrEqual(s.acts.power[0])
          expect(wholeInFrame(s, look[1] - 1e-3, W, H)).toBe(true)
          expect(samples.filter((p) => wholeInFrame(s, p, W, H) && !looking(p) && (p < from - 1e-6 || p > to + 1e-6)).map((p) => (p * 360).toFixed(0))).toEqual([])
        })

        it('ends on a held low frame of the main chip: no more than 15° above the board, the chip whole in frame under its name and at least a quarter of the frame wide, held for the reading time', () => {
          const hero = s.parts.find((pt) => pt.hero === true)
          const a = sampleShot(s.shots, s.acts.hold[0])
          const b = sampleShot(s.shots, 1 - 1e-4)
          expect(tilt(s.acts.hold[0])).toBeGreaterThanOrEqual(75)
          expect(tilt(1 - 1e-4)).toBeGreaterThanOrEqual(75)
          expect(Math.abs(Math.log(b.zoom / a.zoom))).toBeLessThan(0.05)
          expect(s.acts.hold[0]).toBeLessThanOrEqual(1 - 1.7 / 12)
          if (hero === undefined) return
          const cam = makeCam(b, W, H)
          const c = Math.cos(hero.rot)
          const sn = Math.sin(hero.rot)
          const top = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => project(cam, hero.x + ((u as number) * hero.w * c - (v as number) * hero.h * sn) / 2, hero.y + ((u as number) * hero.w * sn + (v as number) * hero.h * c) / 2, hero.z))
          for (const q of top) {
            expect(q.w).toBeGreaterThan(0)
            expect(Math.abs(q.x)).toBeLessThanOrEqual(1)
            expect(Math.abs(q.y)).toBeLessThanOrEqual(1)
            if (s.lockup !== undefined) expect(((1 - q.y) * H) / 2, 'the chip sits under the name').toBeGreaterThanOrEqual(s.lockup.box.y1)
          }
          expect((Math.max(...top.map((q) => q.x)) - Math.min(...top.map((q) => q.x))) / 2).toBeGreaterThanOrEqual(0.25)
        })

        it('cuts twice after the power-on: to the whole lit board from above two beats after the wake, when the highlight has crossed the lid, and two beats later to the last frame', () => {
          const late = s.shots.filter((k) => k.cut === true && k.t > s.acts.power[0] + 1e-9)
          expect(late.map((k) => k.light)).toEqual(['power', 'hero'])
          expect((late[0] as { t: number }).t).toBeGreaterThanOrEqual((s.wake ?? 0) + 2 * BEAT - 1e-9)
          expect((late[1] as { t: number }).t - (late[0] as { t: number }).t).toBeCloseTo(2 * BEAT, 9)
          expect((late[1] as { t: number }).t).toBeLessThan(s.acts.hold[0])
          expect(s.shots.filter((k) => k.light !== undefined).at(-1)?.light).toBe('hero')
        })

        it('rides low into the main chip as it wakes: at the wake the camera is grazing, the chip is in frame and in focus', () => {
          const hero = s.parts.find((pt) => pt.hero === true)
          if (hero === undefined || s.wake === undefined) return
          const k = sampleShot(s.shots, s.wake)
          expect(k.tilt * DEG).toBeGreaterThanOrEqual(65)
          const q = project(makeCam(k, W, H), hero.x, hero.y, 0)
          expect(q.w).toBeGreaterThan(0)
          expect(Math.max(Math.abs(q.x), Math.abs(q.y))).toBeLessThan(0.85)
          expect(Math.hypot(k.focus.x - hero.x, k.focus.y - hero.y)).toBeLessThan(Math.max(hero.w, hero.h))
        })

        it('has a long lens: at least one take at or under 16°, nothing before the ride wider than 30°, and the ride no wider than 51° (a wide lens, so the board reads as a large place)', () => {
          const fovs = samples.map((p) => sampleShot(s.shots, p).fov * DEG)
          expect(Math.min(...fovs)).toBeLessThanOrEqual(16 + 1e-6)
          expect(Math.max(...samples.filter((p) => p < s.acts.power[0]).map((p) => sampleShot(s.shots, p).fov * DEG))).toBeLessThanOrEqual(30 + 1e-6)
          expect(Math.max(...fovs)).toBeLessThanOrEqual(51 + 1e-6)
          expect(Math.max(...samples.filter((p) => p >= s.acts.power[0]).map((p) => sampleShot(s.shots, p).fov * DEG))).toBeGreaterThan(44)
        })

        const dense = name !== 'StickHub'

        it('rides: from the power-on to the wake the camera covers at least a third of the board\'s longer side and tightens its lens as it arrives', () => {
          if (!dense) return
          const start = s.shots.find((k) => k.light === 'ride')
          expect(start?.cut).toBe(true)
          const t0 = start?.t ?? 0
          const t1 = s.wake ?? t0 + 3 * BEAT
          let run = 0
          let prev: number[] | undefined
          for (let f = Math.ceil(t0 * 360); f < t1 * 360; f++) {
            const c = makeCam(sampleShot(s.shots, f / 360), W, H).pos
            if (prev !== undefined) run += Math.hypot((c[0]) - (prev[0] as number), (c[1]) - (prev[1] as number))
            prev = c
          }
          const xs = s.board.flatMap((l) => l.filter((_, i) => i % 2 === 0))
          const ys = s.board.flatMap((l) => l.filter((_, i) => i % 2 === 1))
          const long = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
          expect(run, `the ride covers ${(run / long).toFixed(2)} of the board`).toBeGreaterThanOrEqual(long / 3)
          expect(sampleShot(s.shots, t1 - 1e-4).fov).toBeLessThan(sampleShot(s.shots, t0).fov)
        })

        it('holds the last frame between 1.5 and 2.2 seconds', () => {
          if (!dense) return
          const hold = (1 - s.acts.hold[0]) * 12
          expect(hold).toBeGreaterThanOrEqual(1.5)
          expect(hold).toBeLessThanOrEqual(2.2)
        })

        it('is never dark: every frame holds lit copper 40% of a frame wide (drawn copper before the coat, energised copper from the power-on), or, between them, the board across a fifth of the frame', () => {
          if (!dense) return
          const lit = (p: number): number => {
            const cam = makeCam(sampleShot(s.shots, p), W, H)
            let sum = 0
            for (const l of s.layers) {
              if (l.side !== 'F') continue
              for (let i = 0; i < l.groups.length; i++) {
                const o = 7 * i
                const on = p < s.acts.mask[0] ? (l.segs[o + 5] as number) <= p : p >= s.acts.power[0] && Math.min(l.energy[2 * i] as number, l.energy[2 * i + 1] as number) >= 0 && Math.min(l.energy[2 * i] as number, l.energy[2 * i + 1] as number) <= p
                if (!on) continue
                const pts = Array.from({ length: 9 }, (_, k) => project(cam, (l.segs[o] as number) + (((l.segs[o + 2] as number) - (l.segs[o] as number)) * k) / 8, (l.segs[o + 1] as number) + (((l.segs[o + 3] as number) - (l.segs[o + 1] as number)) * k) / 8, 0))
                for (let k = 1; k < pts.length; k++) {
                  const a = pts[k - 1] as { x: number; y: number; w: number }
                  const b = pts[k] as { x: number; y: number; w: number }
                  if (a.w > 0 && b.w > 0 && Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)) <= 1) sum += Math.hypot(((a.x - b.x) * W) / 2, ((a.y - b.y) * H) / 2)
                }
              }
            }
            return sum / W
          }
          const xs = s.board.flatMap((l) => l.filter((_, i) => i % 2 === 0))
          const ys = s.board.flatMap((l) => l.filter((_, i) => i % 2 === 1))
          const covered = (p: number): number => {
            const cam = makeCam(sampleShot(s.shots, p), W, H)
            const hit = new Set<string>()
            for (let gx = 0; gx <= 60; gx++) {
              for (let gy = 0; gy <= 60; gy++) {
                const q = project(cam, Math.min(...xs) + ((Math.max(...xs) - Math.min(...xs)) * gx) / 60, Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * gy) / 60, 0)
                if (q.w > 0 && Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1) hit.add(`${Math.floor((q.x + 1) * 10)},${Math.floor((q.y + 1) * 10)}`)
              }
            }
            return hit.size / 400
          }
          const dark = Array.from({ length: 120 }, (_, i) => (i * 3) / 360).filter((p) => (p >= s.acts.mask[0] && p < s.acts.power[0] ? covered(p) < 0.2 : lit(p) < 0.4))
          expect(dark.map((p) => `${Math.round(p * 360)}:${(p >= s.acts.mask[0] && p < s.acts.power[0] ? covered(p) : lit(p)).toFixed(2)}`).join(' ')).toEqual('')
        })

        it('rides in sight of its light: from the ride\'s first frame, lit copper the lens sees past every part spans at least a fifth of the frame\'s width, and no one part nearer than what the lens looks at covers a quarter of the frame for more than four frames', () => {
          if (!dense) return
          const { seen, wall } = rideSight(s, W, H)
          expect(seen.filter(([, v]) => v < 0.2).map(([f, v]) => `${f}:${v.toFixed(2)}`).join(' ')).toEqual('')
          expect(wall, 'the longest run of frames behind one part').toBeLessThanOrEqual(4)
        })

        it('cuts on beats, holds at most nine takes, and lands an event on the beat grid inside every take but the look at the whole board, which is its own event', () => {
          const ts = takes(s)
          expect(ts.length).toBeLessThanOrEqual(9)
          for (const [a] of ts.slice(1)) expect(Math.abs(a * 24 - Math.round(a * 24)), `a cut at beat ${(a * 24).toFixed(3)}`).toBeLessThan(1e-6)
          const events = [
            ...(Object.values(s.acts) as Array<[number, number]>).map(([a]) => a),
            ...s.parts.map((pt) => pt.t),
            ...s.groups.filter((g) => g.t >= 0).map((g) => g.t),
            ...(s.wake === undefined ? [] : [s.wake]),
            ...(s.lockup?.build === undefined ? [] : [s.lockup.build.t0])
          ].filter((t) => Math.abs(t * 48 - Math.round(t * 48)) < 1e-6)
          for (const [a, b] of ts.filter(([a]) => a !== look[0])) expect(events.some((t) => t >= a - 1e-9 && t < b - 1e-9), `the take at beats ${(a * 24).toFixed(1)}–${(b * 24).toFixed(1)}`).toBe(true)
        })

        it('the lens changes class across every cut: a different angle, lens or scale', () => {
          for (const k of s.shots.filter((q) => q.cut === true)) {
            const k0 = sampleShot(s.shots, k.t - 1e-4)
            const k1 = sampleShot(s.shots, k.t)
            const changed = Math.abs(k1.tilt - k0.tilt) * DEG > 10 || Math.abs(Math.log(k1.fov / k0.fov)) > Math.log(1.3) || Math.abs(Math.log(k1.zoom / k0.zoom)) > Math.log(1.3)
            expect(changed, `the cut at beat ${(k.t * 24).toFixed(2)} changes too little`).toBe(true)
          }
        })
      })
    }
  }
})
