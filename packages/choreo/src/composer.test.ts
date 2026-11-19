import { describe, expect, it } from 'vitest'
import { compileTimeline } from './index'
import { blinkAlpha, decodeAlpha } from './decode'
import { buildCast } from './glyphs'
import { safeArea } from './layout'
import { makeRng } from './rng'
import type { FilmConfig, GlyphTimeline } from './types'
import type { BoardModel } from '@silk-reel/ingest'
import { boardModel } from '../test/helpers'
import { syntheticBoardWithFootprints } from '../test/synthetic'
import { makeSyntheticBoard } from '../test/synthetic'

const BOARDS = [
  'ecc83-pp.kicad_pcb',
  'kit-dev-coldfire-xilinx_5213.kicad_pcb',
  'video.kicad_pcb',
  'StickHub.kicad_pcb',
  'icebreaker.kicad_pcb',
  'glasgow.kicad_pcb'
]

function cfg(overrides: Partial<FilmConfig> = {}): FilmConfig {
  return {
    style: 'glyph',
    knobs: {},
    seed: 42,
    duration: 'auto',
    output: { width: 1080, height: 1350, fps: 15 },
    ...overrides
  }
}

function compile(board: BoardModel, overrides: Partial<FilmConfig> = {}): GlyphTimeline {
  const tl = compileTimeline(board, cfg(overrides))
  if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
  return tl
}

/** atoms film.ts would actually ink at this loop step (integer steps — the twos grid) */
function visibleAtoms(tl: GlyphTimeline, step: number): number {
  let n = 0
  for (const p of tl.placements) {
    const base =
      decodeAlpha(step, p.inStep, p.outStep, p.pattern, tl.steps) * blinkAlpha(step, p.blinks, tl.steps)
    if (base <= 0.004) continue
    for (const [i] of p.atoms.entries()) {
      if (base * (p.tones[i] ?? 1) > 0.004) n += 1
    }
  }
  return n
}

/** longest cyclic run of steps where nothing is visible */
function longestDarkRun(tl: GlyphTimeline): number {
  const lit: boolean[] = []
  for (let s = 0; s < tl.steps; s++) lit.push(visibleAtoms(tl, s) > 0)
  const anchor = lit.indexOf(true)
  if (anchor < 0) return tl.steps
  let best = 0
  let run = 0
  for (let i = 1; i <= tl.steps; i++) {
    if (lit[(anchor + i) % tl.steps] === false) {
      run++
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best
}

describe('composeFilm cast', () => {
  it('extracts package, text and mark glyphs from a real board', () => {
    // icebreaker carries real silk words (PMOD, FLASH, RGBLED) — ecc83-pp's
    // texts are all refdes, which text hygiene rejects
    const tl = compile(boardModel('icebreaker.kicad_pcb'))
    const kinds = new Set(tl.cast.map((g) => g.kind))
    expect(kinds.has('package')).toBe(true)
    expect(kinds.has('text')).toBe(true)
    expect(kinds.has('mark')).toBe(true)
    const ids = new Set(tl.cast.map((g) => g.id))
    expect(ids.size).toBe(tl.cast.length)
    for (const g of tl.cast) {
      if (g.kind === 'text') expect(typeof g.text).toBe('string')
      else expect(g.strokes.length).toBeGreaterThan(0)
    }
  })

  it('keeps package glyphs unit-normalized and centered', () => {
    const tl = compile(boardModel('ecc83-pp.kicad_pcb'))
    for (const g of tl.cast.filter((g) => g.kind === 'package')) {
      let maxAbs = 0
      let minX = Infinity
      let maxX = -Infinity
      for (const s of g.strokes) {
        for (const p of s) {
          maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y))
          minX = Math.min(minX, p.x)
          maxX = Math.max(maxX, p.x)
        }
      }
      expect(maxAbs).toBeLessThanOrEqual(0.5 + 1e-9)
      expect(Math.abs(minX + maxX)).toBeLessThan(0.05)
    }
  })

  it('warns when a board exposes too few package outlines', () => {
    const tl = compile(makeSyntheticBoard(40))
    expect(tl.warnings.some((w) => w.code === 'thin-cast')).toBe(true)
  })

  it('cast hints promote the listed refs and texts into the cast', () => {
    // compileTimeline's cast is trimmed to placed glyphs — the hint contract
    // lives in buildCast
    const { cast } = buildCast(boardModel('icebreaker.kicad_pcb'), true, makeRng(42, 'cast'), {
      preferRefs: ['P1', 'J31'],
      preferTexts: ['iCEBreaker', 'FPGA']
    })
    const ids = cast.map((g) => g.id)
    expect(ids).toContain('pkg:P1')
    expect(ids).toContain('pkg:J31')
    expect(cast.some((g) => g.kind === 'text' && g.text === 'iCEBreaker')).toBe(true)
    expect(cast.some((g) => g.kind === 'text' && g.text === 'FPGA')).toBe(true)
  })

  it('cast hints that miss produce a warning, not an error', () => {
    const tl = compile(boardModel('ecc83-pp.kicad_pcb'), {
      cast: { preferRefs: ['NOPE99'], preferTexts: ['NOT_A_LABEL'] }
    })
    const misses = tl.warnings.filter((w) => w.code === 'cast-hint-miss')
    expect(misses.length).toBe(2)
    expect(tl.cast.length).toBeGreaterThan(0)
  })

  it('rejects malformed cast hints', () => {
    expect(() =>
      compileTimeline(boardModel('ecc83-pp.kicad_pcb'), cfg({ cast: { hero: ['U1'] } as unknown as NonNullable<FilmConfig['cast']> }))
    ).toThrow(/cast/i)
    expect(() =>
      compileTimeline(
        boardModel('ecc83-pp.kicad_pcb'),
        cfg({ cast: { preferRefs: 'U1' } as unknown as NonNullable<FilmConfig['cast']> })
      )
    ).toThrow(/preferRefs/i)
  })

  it('embeds silkscreen labels inside package glyphs', () => {
    // label embedding lives in buildCast — the timeline's cast is trimmed to
    // placed glyphs, and pkg:* silhouettes are not placed by the cell score
    const { cast } = buildCast(boardModel('icebreaker.kicad_pcb'), true, makeRng(42, 'cast'))
    const labelled = cast.filter((g) => g.kind === 'package' && (g.labels?.length ?? 0) > 0)
    expect(labelled.length).toBeGreaterThan(0)
    for (const g of labelled) {
      for (const label of g.labels ?? []) {
        expect(label.text.length).toBeGreaterThan(0)
        expect(Math.abs(label.x)).toBeLessThanOrEqual(1.4)
        expect(Math.abs(label.y)).toBeLessThanOrEqual(1.4)
        expect(label.size).toBeGreaterThan(0)
      }
    }
  })
})

describe('placements', () => {
  for (const name of BOARDS) {
    for (const aspect of ['4:5', '9:16'] as const) {
      it(`${name} @ ${aspect}: every placement is a valid timed symmetry set`, () => {
        const tl = compile(boardModel(name), { aspect })
        expect(tl.placements.length).toBeGreaterThan(0)
        const acts = new Set<number>()
        for (const p of tl.placements) {
          const glyph = tl.cast.find((g) => g.id === p.glyphId)
          expect(glyph, `${p.glyphId} missing from cast`).toBeDefined()
          expect(p.atoms.length).toBeGreaterThanOrEqual(1)
          expect(p.atoms.length).toBeLessThanOrEqual(4)
          expect(p.tones.length).toBe(p.atoms.length)
          for (const t of p.tones) {
            expect(t).toBeGreaterThan(0)
            expect(t).toBeLessThanOrEqual(1)
          }
          for (const step of [p.inStep, p.outStep]) {
            expect(Number.isInteger(step)).toBe(true)
            expect(step).toBeGreaterThanOrEqual(0)
            expect(step).toBeLessThan(tl.steps)
          }
          expect(Number.isInteger(p.pattern)).toBe(true)
          expect(p.pattern).toBeGreaterThanOrEqual(0)
          expect(p.pattern).toBeLessThan(6)
          // placement.formation is the act index — it joins formations via beat
          acts.add(p.formation)
          expect(
            tl.formations.some((f) => f.beat === p.formation),
            `no formation carries act ${p.formation}`
          ).toBe(true)
          for (const b of p.blinks ?? []) {
            expect(Number.isInteger(b)).toBe(true)
            expect(b).toBeGreaterThanOrEqual(0)
            expect(b).toBeLessThan(tl.steps)
          }
          for (const a of p.atoms) {
            expect(Number.isFinite(a.x)).toBe(true)
            expect(Number.isFinite(a.y)).toBe(true)
            expect(Number.isFinite(a.rot)).toBe(true)
            expect(a.scale).toBeGreaterThan(0)
            // every off-axis atom has a symmetry twin (mirror across Y, or the
            // rot2 180° partner); authored single cells all sit on the axis,
            // except the field's, which stand at the board's true places, and the
            // plan's main chip, drawn once
            if (Math.abs(a.x) < 1e-9 || p.stage !== undefined || (p.role === 'hero' && p.glyphId.startsWith('cell:')) || tl.formations.find((f) => f.beat === p.formation)?.id === 'name') continue
            const twin = p.atoms.some(
              (b) =>
                b !== a &&
                Math.abs(b.x + a.x) < 1e-9 &&
                (Math.abs(b.y - a.y) < 1e-9 || Math.abs(b.y + a.y) < 1e-9)
            )
            expect(twin, `atom (${a.x.toFixed(2)},${a.y.toFixed(2)}) lacks a symmetry twin`).toBe(true)
          }
        }
        // every act contributes placements
        expect([...acts].sort()).toEqual([0, 1, 2, 3, 4, 5])
      })

      it(`${name} @ ${aspect}: formations are the five acts — sorted, non-empty windows`, () => {
        const tl = compile(boardModel(name), { aspect })
        const ids = tl.formations.map((f) => f.id)
        expect([...ids].sort()).toEqual(['cluster', 'diagonal', 'field', 'name', 'plan', 'route'])
        for (const [i, f] of tl.formations.entries()) {
          expect(f.startPhase).toBeGreaterThanOrEqual(0)
          expect(f.startPhase).toBeLessThan(1)
          expect(f.endPhase).toBeGreaterThan(f.startPhase)
          // a window, not the whole loop; the routes' wraps past 1
          expect(f.endPhase - f.startPhase).toBeLessThan(1)
          if (i > 0) expect(f.startPhase).toBeGreaterThan(tl.formations[i - 1]?.startPhase ?? 0)
        }
        for (const f of tl.formations) {
          expect(tl.placements.some((p) => p.formation === f.beat), `act ${f.id} has no placements`).toBe(true)
        }
        // every placement is lit at some step inside its act's window
        for (const p of tl.placements) {
          const f = tl.formations.find((x) => x.beat === p.formation)
          if (f === undefined) continue
          const start = Math.round(f.startPhase * tl.steps)
          const end = Math.round(f.endPhase * tl.steps)
          let lit = false
          for (let s = start; s < end && !lit; s++) {
            lit = decodeAlpha(s % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.004
          }
          expect(lit, `${p.glyphId} (act ${f.id}) never lit inside its window`).toBe(true)
        }
      })

      it(`${name} @ ${aspect}: no dead air — never 4+ unlit steps, and the hero is seen`, () => {
        const tl = compile(boardModel(name), { aspect })
        expect(visibleAtoms(tl, 0), 'step 0 must be lit — the routes hold across the wrap').toBeGreaterThan(0)
        const run = longestDarkRun(tl)
        expect(run, `longest dark run is ${run} steps`).toBeLessThanOrEqual(3)
        const heroes = tl.placements.filter((p) => p.role === 'hero')
        expect(heroes.length, 'no hero placement on the loop').toBeGreaterThanOrEqual(1)
        const heroSeen = heroes.some((p) => {
          for (let s = 0; s < tl.steps; s++) {
            if (decodeAlpha(s, p.inStep, p.outStep, p.pattern, tl.steps) > 0.004) return true
          }
          return false
        })
        expect(heroSeen, 'no hero glyph is ever visible').toBe(true)
      })

      it(`${name} @ ${aspect}: every atom stays inside the stage`, () => {
        const tl = compile(boardModel(name), { aspect })
        // film.ts: stage ±1 maps to half the safe area's short side
        const safe = safeArea(tl.width, tl.height, tl.title !== undefined)
        const stagePx = Math.min(safe.w, safe.h) * 0.5
        const cx = safe.x + safe.w / 2
        const cy = safe.y + safe.h / 2
        const byId = new Map(tl.cast.map((g) => [g.id, g]))
        // the field stands with its chip at the origin and the camera centres it at its lock; glyph-cam.test.ts holds it in frame there
        for (const p of tl.placements.filter((q) => q.stage === undefined && q.glyphId !== 'txt:title')) {
          const g = byId.get(p.glyphId)
          // the glyph's own extent around the atom centre — words run wide
          const word = g?.kind === 'text' ? (g.text ?? '') : ''
          for (const a of p.atoms) {
            const px = cx + a.x * stagePx
            const py = cy + a.y * stagePx
            const hw =
              word === ''
                ? a.scale * stagePx * 0.6
                : a.scale * stagePx * 0.35 * Math.max(1, word.length)
            const hh = a.scale * stagePx * 0.6
            expect(px - hw, `${p.glyphId} atom x=${a.x.toFixed(3)}`).toBeGreaterThanOrEqual(safe.x - 1e-6)
            expect(px + hw, `${p.glyphId} atom x=${a.x.toFixed(3)}`).toBeLessThanOrEqual(safe.x + safe.w + 1e-6)
            expect(py - hh, `${p.glyphId} atom y=${a.y.toFixed(3)}`).toBeGreaterThanOrEqual(safe.y - 1e-6)
            expect(py + hh, `${p.glyphId} atom y=${a.y.toFixed(3)}`).toBeLessThanOrEqual(safe.y + safe.h + 1e-6)
          }
        }
      })

      it(`${name} @ ${aspect}: the same seed compiles a deep-equal timeline`, () => {
        const a = compile(boardModel(name), { aspect })
        const b = compile(boardModel(name), { aspect })
        expect(b).toEqual(a)
      })
    }
  }

  it('board-seeded scores vary across the fixture set', () => {
    const sigs = new Set<string>()
    for (const name of BOARDS) {
      const tl = compile(boardModel(name))
      sigs.add(JSON.stringify(tl.placements.map((p) => [p.glyphId, p.inStep, p.outStep])))
    }
    expect(sigs.size).toBeGreaterThan(1)
  })

  it('keeps atoms finite and positive-scale everywhere', () => {
    const tl = compile(syntheticBoardWithFootprints(10))
    for (const p of tl.placements) {
      for (const a of p.atoms) {
        expect(Number.isFinite(a.x)).toBe(true)
        expect(Number.isFinite(a.y)).toBe(true)
        expect(Number.isFinite(a.rot)).toBe(true)
        expect(a.scale).toBeGreaterThan(0)
      }
    }
  })
})

describe('every act is the board', () => {
  // a fixed template reads as the same picture on every board; each act's
  // layout must come from the board's own geometry
  const layout = (tl: GlyphTimeline, act: number): string =>
    tl.placements
      .filter((p) => p.formation === act)
      .flatMap((p) => p.atoms.map((a) => `${a.x.toFixed(3)},${a.y.toFixed(3)}`))
      .sort()
      .join(' ')

  it.each([0, 1, 2])('act %i differs across all six boards', (act) => {
    const layouts = new Set(BOARDS.map((name) => layout(compile(boardModel(name)), act)))
    expect(layouts.size).toBe(BOARDS.length)
  })
})
