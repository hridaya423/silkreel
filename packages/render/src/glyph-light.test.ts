import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, compileTimeline, DECODE_IN, GLYPH_LOOP_BEATS } from '@silk-reel/choreo'
import type { Aspect, GlyphTimeline } from '@silk-reel/choreo'
import { boardModel } from '../../choreo/test/helpers'
import { glyphLight } from './glyph-light'

const DECODED = DECODE_IN[0]?.length ?? 5

function glyph(file: string, aspect: Aspect): GlyphTimeline {
  const tl = compileTimeline(boardModel(file), { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name: 'Board' } })
  if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
  return tl
}

describe('the glyph film\'s light', () => {
  for (const file of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb']) {
    for (const aspect of ['4:5', '16:9'] as Aspect[]) {
      it(`${file} ${aspect}: rises once, full on the frame the field locks, and holds full until the field leaves`, () => {
        const tl = glyph(file, aspect)
        const light = glyphLight(tl)
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const lock = (tl.pulls.find(([a]) => a === turn) as [number, number])[1]
        const lifts = Array.from({ length: tl.totalFrames }, (_, f) => light.lift(f))
        expect(lifts[0]).toBe(0)
        const exit = Math.min(...tl.placements.filter((p) => p.stage !== undefined && p.role !== 'hero').map((p) => Math.round((p.outStep * tl.fps) / 15)))
        expect(lifts[lock]).toBe(1)
        expect(lifts[turn] as number).toBeLessThan(0.3)
        for (let f = 1; f <= lock; f++) expect(lifts[f] as number).toBeGreaterThanOrEqual(lifts[f - 1] as number)
        for (let f = lock; f < exit; f++) expect(lifts[f], `frame ${f}`).toBe(1)
        expect(light.flash(lock)).toBe(1)
        expect(light.flash(lock - 1)).toBe(0)
      })

      it(`${file} ${aspect}: runs three pulses through the formation before the named one, each higher, finished before it starts to leave, each held as a glow until the turn, and through no other formation`, () => {
        const tl = glyph(file, aspect)
        const light = glyphLight(tl)
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const at = tl.pulls.findIndex(([a]) => a === turn)
        const before = (tl.pulls[at - 1] as [number, number])[1]
        const order = [...tl.formations].sort((a, b) => a.startPhase - b.startPhase)
        const prior = order[order.findIndex((f) => f.id === 'field') - 1]
        const heights: number[] = []
        tl.placements.forEach((p, i) => {
          const run = Array.from({ length: tl.totalFrames }, (_, f) => light.sweep(f, i))
          if (p.formation !== prior?.beat) {
            expect(Math.max(...run)).toBe(0)
            return
          }
          const leaves = Math.min(turn, ...tl.placements.filter((q) => q.formation === prior.beat).map((q) => Math.round((q.outStep * tl.fps) / 15)).filter((f) => f > before))
          expect(Math.max(...run.slice(0, before - Math.round((tl.steps * tl.fps) / 15 / GLYPH_LOOP_BEATS)), ...run.slice(turn)), 'the light plays inside the hold').toBe(0)
          for (let f = leaves + 1; f < turn; f++) expect(run[f] as number, 'only a held glow after the pulses').toBeLessThanOrEqual(run[f - 1] as number)
          const peaks = run.filter((v, f) => f < leaves && v > 0.3 && v >= (run[f - 1] ?? 0) && v > (run[f + 1] ?? 0))
          if (peaks.length === 3) heights.push(...peaks)
          if (peaks.length === 3) expect(run[turn - 1] as number, 'the plan holds its glow until the turn').toBeGreaterThan(0.5)
        })
        expect(heights.length).toBeGreaterThan(0)
        for (let k = 0; k < heights.length; k += 3) {
          expect(heights[k + 1] as number).toBeGreaterThan(heights[k] as number)
          expect(heights[k + 2] as number).toBeGreaterThan(heights[k + 1] as number)
        }
      })

      it(`${file} ${aspect}: each field mark is at full tone and size as its stage's wave lands it, then settles; the light touches no other formation`, () => {
        const tl = glyph(file, aspect)
        const light = glyphLight(tl)
        const frameOf = (step: number): number => Math.round((step * tl.fps) / 15)
        tl.placements.forEach((p, i) => {
          if (p.stage === undefined) {
            for (let f = 0; f < tl.totalFrames; f += 7) {
              expect(light.raise(f, i)).toBe(0)
              expect(light.shine(f, i)).toBe(0)
              expect(light.swell(f, i)).toBe(1)
            }
            return
          }
          if (p.role === 'hero' || p.link === 'exit') return
          const land = frameOf(p.inStep + DECODED)
          expect(light.raise(land, i)).toBe(1)
          expect(light.swell(land, i)).toBeGreaterThan(1.3)
          if (land + 12 < (light.starts[light.starts.length - 1] as number)) expect(light.raise(land + 12, i)).toBeLessThan(0.05)
        })
      })

      it(`${file} ${aspect}: one beat after the field locks the button's ring crosses the field outward from the main chip, readable for at least six frames`, () => {
        const tl = glyph(file, aspect)
        const light = glyphLight(tl)
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const lock = (tl.pulls.find(([a]) => a === turn) as [number, number])[1]
        const button = light.starts[light.starts.length - 1] as number
        expect(button - lock).toBe(Math.round((tl.steps * tl.fps) / 15 / GLYPH_LOOP_BEATS))
        const field = tl.placements.flatMap((p, i) => (p.stage !== undefined && p.role !== 'hero' ? [i] : []))
        const fronts: number[] = []
        for (let f = button; f < button + 24; f++) {
          const ring = field.filter((i) => light.swell(f, i) > 1.25 && light.swell(f + 4, i) < light.swell(f, i))
          if (ring.length < 8) continue
          const reach = ring.map((i) => tl.placements[i]?.reach as number)
          expect(Math.max(...reach) - Math.min(...reach)).toBeLessThan(0.3)
          fronts.push(reach.reduce((a, b) => a + b, 0) / reach.length)
        }
        expect(fronts.length).toBeGreaterThanOrEqual(6)
        for (let k = 1; k < fronts.length; k++) expect(fronts[k] as number).toBeGreaterThan(fronts[k - 1] as number)
      })

      it(`${file} ${aspect}: the connector pads on the main chip's nets light as the ring reaches them and stay lit`, () => {
        const tl = glyph(file, aspect)
        const light = glyphLight(tl)
        const button = light.starts[light.starts.length - 1] as number
        const exits = tl.placements.flatMap((p, i) => (p.link === 'exit' ? [i] : []))
        expect(exits.length).toBeGreaterThan(0)
        const strip = Math.min(...exits.map((i) => Math.round(((tl.placements[i]?.outStep ?? 0) * tl.fps) / 15)))
        for (const i of exits) {
          expect(light.shine(button - 1, i)).toBe(0)
          for (let f = button + 24; f < strip; f += 2) {
            expect(light.raise(f, i)).toBe(1)
            expect(light.swell(f, i)).toBeGreaterThan(1.5)
          }
        }
      })

      it(`${file} ${aspect}: between the lock's flash and the button no other mark in the field glows as warm as the main chip`, () => {
        const tl = glyph(file, aspect)
        const light = glyphLight(tl)
        const field = tl.placements.flatMap((p, i) => (p.stage !== undefined ? [i] : []))
        const hero = field.find((i) => tl.placements[i]?.role === 'hero') as number
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const lock = (tl.pulls.find(([a]) => a === turn) as [number, number])[1]
        const button = light.starts[light.starts.length - 1] as number
        for (let f = lock + 12; f < button; f++) {
          for (const i of field) if (tl.placements[i]?.role !== 'hero') expect(light.shine(f, i)).toBeLessThan(light.shine(f, hero))
        }
      })
    }
  }
})
