import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import { DEMO_CAST_HINTS } from '../hints'
import type { Aspect, FilmConfig, TraceScene } from '../types'
import { heroOcclusion, makeCam, pinReach, project, sampleShot } from './camera'
import { boardPoints, silhouette } from './lockup'
import { buildTraceScene, markingAxis } from './scene'
import { boardModel } from '../../test/helpers'

const TITLES: Record<string, string> = { glasgow: 'Glasgow', icebreaker: 'iCEBreaker', StickHub: 'StickHub', 'ecc83-pp': 'ECC83 PP', video: 'Video', 'kit-dev-coldfire-xilinx_5213': 'ColdFire Xilinx Dev Kit' }
const ASPECTS: Aspect[] = ['4:5', '1:1', '9:16', '16:9']
const B = 1 / 24

function scene(name: string, aspect: Aspect): { s: TraceScene; W: number; H: number } {
  const config: FilmConfig = { style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, title: { name: TITLES[name] ?? name }, ...(DEMO_CAST_HINTS[name] === undefined ? {} : { cast: DEMO_CAST_HINTS[name] }) }
  const r = resolveConfig(config)
  return { s: buildTraceScene(boardModel(`${name}.kicad_pcb`), r, 42).scene, W: r.width, H: r.height }
}

function rightward(s: TraceScene, W: number, H: number, p: number, at: { x: number; y: number }, d: { x: number; y: number }): number {
  const cam = makeCam(sampleShot(s.shots, p), W, H)
  const a = project(cam, at.x, at.y, 0)
  if (a.w <= 0 || Math.abs(a.x) > 1 || Math.abs(a.y) > 1) return 1
  const b = project(cam, at.x + d.x * 4, at.y + d.y * 4, 0)
  const dx = (b.x - a.x) * W
  const dy = (b.y - a.y) * H
  return dx / Math.max(1e-9, Math.hypot(dx, dy))
}

describe('one board, one look in every aspect', () => {
  for (const name of Object.keys(TITLES)) {
    const films = ASPECTS.map((a) => scene(name, a))
    it(`${name}: every take is the same take in all four aspects, re-framed for each: the cuts land on the same beats, each take holds its angle (grazing or straight down), and the spark keeps its heading within 24° (the whole-board take turns per aspect to fill the frame; the skyline and the ride's arrival turn so nothing stands in front of the main chip)`, () => {
      const takes = (f: (typeof films)[number]): Array<[number, number]> => {
        const cuts = f.s.shots.filter((k) => k.cut === true).map((k) => k.t)
        const b = [0, ...cuts, 1]
        return b.slice(0, -1).map((a, i) => [a, b[i + 1] as number])
      }
      const [first, ...rest] = films
      if (first === undefined) return
      const ref = takes(first)
      for (const f of rest) {
        const own = takes(f)
        expect(own.map(([a]) => a * 24)).toEqual(ref.map(([a]) => a * 24))
        own.forEach(([a, b], i) => {
          const k = sampleShot(f.s.shots, (a + b) / 2)
          const r = sampleShot(first.s.shots, (a + b) / 2)
          expect(k.tilt <= (5 * Math.PI) / 180, `${f.W}x${f.H} take ${i + 1}`).toBe(r.tilt <= (5 * Math.PI) / 180)
          if (i > 0) return
          const turn = Math.atan2(Math.sin(k.yaw - r.yaw), Math.cos(k.yaw - r.yaw))
          expect(Math.abs(turn), `${f.W}x${f.H} take ${i + 1}`).toBeLessThanOrEqual((24 * Math.PI) / 180 + 1e-6)
        })
      }
    })

    it(`${name}: the hero's marking reads upright in the held last frame (from beat 21 on), whose heading is set by the marking; the silk lies as the board has it`, () => {
      for (const { s, W, H } of films) {
        const hero = s.parts.find((pt) => pt.hero === true && pt.label !== undefined && pt.kind !== 'valve')
        for (let p = 14 * B; p <= 1; p += 0.25 * B) {
          if (p >= 14 * B - 1e-9 && p < 21 * B) continue
          if (hero !== undefined && p >= hero.t - (hero.fall ?? 0)) {
            const d = markingAxis(hero)
            const sign = hero.turn === true ? -1 : 1
            expect(rightward(s, W, H, p, hero, { x: sign * d.x, y: sign * d.y }), `${W}x${H} marking at beat ${(p * 24).toFixed(2)}`).toBeGreaterThan(W <= 1.05 * H ? -0.2 : -0.02)
          }
        }
      }
    })

    it(`${name}: through the breath (beats 11–12) and the ride's arrival (the wake to the cut) at most 12% of the hero and its pin rows is hidden (unless the power-on is a shot of the board's lamps)`, () => {
      for (const { s, W, H } of films) {
        const hero = s.parts.find((pt) => pt.hero === true)
        if (hero === undefined) continue
        if (s.power === 'lamps' && s.parts.some((pt) => pt.led !== undefined && pt.led.at >= 0)) continue
        const bodies = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
        const top = s.shots.find((k) => k.cut === true && k.t > 12 * B && k.tilt === 0)?.t ?? 1
        const beats = [11, 11.25, 11.5, 11.75, ...(s.wake === undefined ? [] : [s.wake * 24, (s.wake * 24 + top * 24) / 2, top * 24 - 0.01])]
        for (const b of beats) {
          const cam = makeCam(sampleShot(s.shots, b * B), W, H)
          const o = heroOcclusion(cam, W, H, hero, bodies, pinReach(hero, s.pads.filter((pd) => pd.hero === true)))
          expect(o.covered, `${W}x${H} beat ${b.toFixed(2)}: the hero or its pin rows are covered`).toBeLessThanOrEqual(0.12)
        }
      }
    })

    it(`${name}: the hero's box (its footprint until the place shot, a valve's height capped at its width) is wholly inside the frame at the start, middle and end of every shot from the place shot on (the copper and the coat are the subjects before it; the lamps macro, which holds the board's own lamps with the chip soft behind, until the crane is halfway; an opening on another part, which keeps that part in frame, or its densest edge when the part's large plain pad stays off the first frame; the travel in from the power connector, until the hero wakes)`, () => {
      for (const { s, W, H } of films) {
        const hero = s.parts.find((pt) => pt.hero === true)
        if (hero === undefined) continue
        const bounds = [0, ...s.shots.filter((k) => k.cut === true).map((k) => k.t), 1]
        for (let i = 0; i + 1 < bounds.length; i++) {
          const a = bounds[i] as number
          const b = bounds[i + 1] as number
          const rise = s.power === 'lamps' ? s.shots.findIndex((k) => k.t > 12 * B && k.ease === 'rise') : -1
          const macroEnd = rise > 0 && s.shots.some((k) => k.cut === true && Math.abs(k.t - 12 * B) < 1e-6 && k.light === 'power') ? s.shots[rise + 2]?.t ?? 0 : 0
          for (const p of [a, (a + b) / 2, b - 1e-4]) {
            if (p >= 12 * B - 1e-9 && p < macroEnd) continue
            if (p < s.acts.silk[0] - 1e-9) continue
            if (s.wake !== undefined && p >= 12 * B - 1e-9 && p < s.wake) continue
            const cam = makeCam(sampleShot(s.shots, p), W, H)
            for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [0, p >= s.acts.silk[0] ? Math.min(hero.z, Math.max(hero.w, hero.h)) : 0]) {
              const q = project(cam, hero.x + Math.cos(hero.rot) * sx * hero.w / 2 - Math.sin(hero.rot) * sy * hero.h / 2, hero.y + Math.sin(hero.rot) * sx * hero.w / 2 + Math.cos(hero.rot) * sy * hero.h / 2, z)
              expect(q.w, `${W}x${H} shot ${i + 1} at beat ${(p * 24).toFixed(2)}`).toBeGreaterThan(0)
              expect(Math.max(Math.abs(q.x), Math.abs(q.y)), `${W}x${H} shot ${i + 1} at beat ${(p * 24).toFixed(2)}`).toBeLessThanOrEqual(1)
            }
          }
        }
      }
    })

    it(`${name}: at beat 13.5, in the power-on that holds the hero and its first LED, the hero's marking never reads upside down`, () => {
      for (const { s, W, H } of films) {
        const hero = s.parts.find((pt) => pt.hero === true && pt.label !== undefined && pt.kind !== 'valve')
        if (hero === undefined) continue
        const d = markingAxis(hero)
        const sign = hero.turn === true ? -1 : 1
        if (s.wake !== undefined && 13.5 * B < s.wake) continue
        expect(rightward(s, W, H, 13.5 * B, { x: hero.x, y: hero.y }, { x: sign * d.x, y: sign * d.y })).toBeGreaterThanOrEqual(-0.2)
      }
    })

    it(`${name}: on tall and square frames the end frame's board stands at least 35% (9:16) or 32% (4:5, 1:1) of the frame high, or spans at least 72% of its width`, () => {
      for (const { s, W, H } of films) {
        if (W > 1.05 * H) continue
        const pts = boardPoints(s.board, s.parts.filter((p) => p.kind !== 'pin'), Math.max(1.5, s.material.thicknessPx))
        const hull = silhouette(makeCam(sampleShot(s.shots, 1), W, H), pts, W, H)
        const ys = hull.map((q) => q[1])
        const xs = hull.map((q) => q[0])
        expect((Math.max(...ys) - Math.min(...ys)) / H >= (H > 1.5 * W ? 0.35 : 0.32) || (Math.max(...xs) - Math.min(...xs)) / W >= 0.72).toBe(true)
      }
    })

    it(`${name}: the end frame's board fills at least half the frame's limiting dimension (beside the title: of the room the title leaves)`, () => {
      for (const { s, W, H } of films) {
        const pts = boardPoints(s.board, s.parts.filter((p) => p.kind !== 'pin'), Math.max(1.5, s.material.thicknessPx))
        const hull = silhouette(makeCam(sampleShot(s.shots, 1), W, H), pts, W, H)
        const xs = hull.map((q) => Math.min(W, Math.max(0, q[0])))
        const ys = hull.map((q) => Math.min(H, Math.max(0, q[1])))
        const L = s.lockup
        const room = L !== undefined && L.side === 'beside' ? W - (L.box.x1 - L.box.x0) - 0.04 * W : W
        expect(Math.max((Math.max(...xs) - Math.min(...xs)) / room, (Math.max(...ys) - Math.min(...ys)) / H)).toBeGreaterThanOrEqual(0.5)
      }
    })
  }
})
