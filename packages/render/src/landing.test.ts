import { describe, expect, it } from 'vitest'
import { compileTimeline, DESCENT, RIPPLE_ROW, RIPPLE_STEP } from '@silk-reel/choreo'
import type { FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import { partPose } from './trace-maps.js'
import { boardModel } from '../../choreo/test/helpers.js'

const BOARDS = ['glasgow', 'icebreaker', 'StickHub', 'ecc83-pp', 'video', 'kit-dev-coldfire-xilinx_5213']

describe('a part lands once and never moves again', () => {
  for (const name of BOARDS) {
    it(`${name}: every part's drawn pose from its landing to the last frame equals its final pose exactly`, () => {
      const config: FilmConfig = { style: 'trace', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } }
      const tl = compileTimeline(boardModel(`${name}.kicad_pcb`), config) as TraceTimeline
      const frames = tl.totalFrames
      for (const part of tl.scene.parts) {
        const rest = partPose(part, 1, tl.durationSeconds, 100)
        expect(rest.lift).toBe(0)
        expect(rest.grow).toBe(1)
        expect(rest.rot).toBe(part.rot)
        expect([rest.x, rest.y]).toEqual([part.x, part.y])
        for (let f = Math.ceil(part.t * frames); f <= frames; f++) {
          for (const sub of [0, 0.25, 0.5, 0.75]) {
            const p = (f + sub) / frames
            if (p < part.t || p > 1) continue
            expect(partPose(part, p, tl.durationSeconds, 100)).toEqual(rest)
          }
        }
      }
    }, 60_000)
  }

  it('the hero eases out, fastest at the start; other parts ease in and out; both arrive at rest and slide in along a straight line', () => {
    const part = { x: 0, y: 0, w: 10, h: 10, rot: 0, t: 0.5, kind: 'ic' as const, hero: true, fall: 9.5 / 360, enter: { x: 40, y: -20 } }
    const at = (frame: number, hero = true): { x: number; y: number; lift: number } => partPose({ ...part, hero }, 0.5 + frame / 360, 12, 100)
    const steps = [-9, -8, -7, -6, -5, -4, -3, -2, -1].map((f) => at(f).lift - at(f + 1).lift)
    for (let i = 1; i < steps.length; i++) expect(steps[i] as number).toBeLessThan(steps[i - 1] as number)
    expect(at(0).lift).toBe(0)
    expect(at(-9).lift).toBeCloseTo(100 * (9 / 9.5) ** 2, 6)
    const u = 9 / 9.5
    expect(at(-9, false).lift).toBeCloseTo(100 * u * u * (3 - 2 * u), 6)
    expect(at(-9, false).lift - at(-8, false).lift).toBeLessThan(at(-5, false).lift - at(-4, false).lift)
    for (const f of [-9, -5, -1, 0]) expect(at(f).x * 100).toBeCloseTo(at(f).lift * 40, 6)
    expect([at(0).x, at(0).y]).toEqual([0, 0])
  })

  for (const name of ['icebreaker', 'glasgow']) {
    it(`${name}: every descent starts on a whole or half frame; no fall is longer than one beat, and one longer than the hero's is exactly one beat; small parts rain in rows of 12 that overlap, so a frame holds at most 4 per row; the second chip and the hero each land alone; the hero lands last with 8 clear frames before it`, () => {
      const config: FilmConfig = { style: 'trace', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } }
      const tl = compileTimeline(boardModel(`${name}.kicad_pcb`), config) as TraceTimeline
      const frames = tl.totalFrames
      const bodies = tl.scene.parts.filter((pt) => pt.kind !== 'pin')
      const perFrame = new Map<number, number>()
      for (const pt of bodies) {
        const start = (pt.t - (pt.fall ?? 0)) * frames
        expect(Math.abs(start * 2 - Math.round(start * 2))).toBeLessThan(1e-6)
        const len = (pt.fall ?? 0) * frames
        expect(len).toBeGreaterThanOrEqual(3)
        expect(len).toBeLessThanOrEqual(frames / 24 + 1e-6)
        if (len > DESCENT.hero * frames + 1e-6) expect(len).toBeCloseTo(frames / 24, 6)
        const f = Math.round(pt.t * frames)
        perFrame.set(f, (perFrame.get(f) ?? 0) + 1)
      }
      const small = bodies.filter((pt) => pt.fall === DESCENT.small || (pt.kind !== 'conn' && Math.abs((pt.fall ?? 0) - 1 / 24) < 1e-9))
      const smallPerFrame = new Map<number, number>()
      for (const pt of small) smallPerFrame.set(Math.round(pt.t * frames), (smallPerFrame.get(Math.round(pt.t * frames)) ?? 0) + 1)
      const rows = Math.ceil(small.length / RIPPLE_ROW)
      expect(Math.max(...smallPerFrame.values())).toBeLessThanOrEqual(rows * Math.ceil(1 / RIPPLE_STEP))
      const hero = bodies.find((pt) => pt.hero === true)
      if (hero === undefined) return
      expect(hero.fall).toBe(DESCENT.hero)
      for (const lone of bodies.filter((pt) => pt.fall === DESCENT.hero)) expect(perFrame.get(Math.round(lone.t * frames))).toBe(1)
      const others = bodies.filter((pt) => pt !== hero).map((pt) => pt.t * frames)
      expect(Math.max(...others)).toBeLessThanOrEqual(hero.t * frames - 8)
    })
  }
})
