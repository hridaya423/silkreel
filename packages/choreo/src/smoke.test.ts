import { describe, expect, it } from 'vitest'
import { GLYPH_FILM_BEATS, GLYPH_LOOP_BEATS } from './config'
import { compileTimeline } from './index'
import { decodeAlpha } from './decode'
import { boardModel } from '../test/helpers'

describe('choreo package smoke', () => {
  for (const name of [
    'ecc83-pp.kicad_pcb',
    'StickHub.kicad_pcb',
    'video.kicad_pcb',
    'icebreaker.kicad_pcb',
    'glasgow.kicad_pcb'
  ]) {
    it(`compiles ${name} to a glyph timeline`, () => {
      const tl = compileTimeline(boardModel(name), {
        style: 'glyph',
        knobs: {},
        seed: 42,
        duration: 'auto',
        output: { width: 1080, height: 1350, fps: 15 }
      })
      if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
      expect(tl.totalFrames).toBe(7 * GLYPH_FILM_BEATS)
      expect(tl.steps).toBe(7 * GLYPH_LOOP_BEATS)
      expect(tl.cast.length).toBeGreaterThan(0)
      // every cast member is placed at least once — dead cast was trimmed
      for (const g of tl.cast) {
        expect(tl.placements.some((p) => p.glyphId === g.id), `${g.id} never placed`).toBe(true)
      }
      const ids = tl.formations.map((f) => f.id)
      expect([...ids].sort()).toEqual(['cluster', 'diagonal', 'field', 'name', 'plan', 'route'])
      for (const f of tl.formations) {
        expect(f.endPhase).toBeGreaterThan(f.startPhase)
      }
      // the field is the last scene — its window is lit, and the main chip stands in it
      const frame = tl.formations.find((f) => f.id === 'field')
      expect(frame).toBeDefined()
      if (frame === undefined) return
      const start = Math.round(frame.startPhase * tl.steps)
      const end = Math.round(frame.endPhase * tl.steps)
      const lit = tl.placements.filter((p) => {
        for (let s = start; s < end; s++) {
          if (decodeAlpha(s % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.05) return true
        }
        return false
      })
      expect(lit.length).toBeGreaterThan(0)
      // the last scene crowns one chip: its own pads, all one mark
      const heroes = tl.placements.filter((p) => p.role === 'hero' && p.formation === frame.beat)
      expect(heroes.length).toBeGreaterThan(0)
      expect(new Set(heroes.map((p) => p.glyphId)).size).toBe(1)
      const heroLit = heroes.some((p) => {
        for (let s = start; s < end; s++) {
          if (decodeAlpha(s % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.05) return true
        }
        return false
      })
      expect(heroLit).toBe(true)
    })
  }

  it('different seeds change the placement score', () => {
    const board = boardModel('glasgow.kicad_pcb')
    const sig = (seed: number): string => {
      const tl = compileTimeline(board, {
        style: 'glyph',
        knobs: {},
        seed,
        duration: 'auto',
        output: { width: 1080, height: 1350, fps: 15 }
      })
      if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
      return JSON.stringify(tl.placements.map((p) => [p.glyphId, p.inStep, p.outStep]))
    }
    const seen = new Set([1, 2, 3, 4, 5, 6].map(sig))
    expect(seen.size).toBeGreaterThan(1)
  })
})
