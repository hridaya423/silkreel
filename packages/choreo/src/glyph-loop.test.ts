import { describe, expect, it, vi } from 'vitest'
import { boardModel } from '../test/helpers'
import { compileTimeline } from './compile'
import { DECODE_IN, DECODE_OUT, blinkAlpha, decodeAlpha, steadyAlpha } from './decode'
import { GLYPH_FILM_BEATS, GLYPH_LOOP_BEATS } from './config'
import { DEMO_CAST_HINTS } from './hints'
import type { Aspect, GlyphTimeline } from './types'
import { ASPECT_SIZE } from './layout'
import { HERO_HALF } from './cells'
import { GLYPH_CLEAR, GLYPH_INK, glide } from './composer'
import { pickHero } from './trace/hero'

vi.mock('./trace/scene', async (original) => ({
  ...(await original<typeof import('./trace/scene')>()),
  buildTraceScene: () => {
    throw new Error('the glyph film built the trace scene')
  }
}))

const BOARDS = [
  ['glasgow.kicad_pcb', 'glasgow'],
  ['icebreaker.kicad_pcb', 'icebreaker'],
  ['kit-dev-coldfire-xilinx_5213.kicad_pcb', 'kit-dev-coldfire-xilinx_5213']
] as const
const ASPECTS: Aspect[] = ['4:5', '9:16', '16:9', '1:1']
const DECODED = DECODE_IN[0]?.length ?? 5
const LEFT = DECODE_OUT[0]?.length ?? 6

const loop = (tl: GlyphTimeline): number => (tl.steps * tl.fps) / 15

function glyph(file: string, hints: string, aspect: Aspect): GlyphTimeline {
  const cast = DEMO_CAST_HINTS[hints]
  const tl = compileTimeline(boardModel(file), {
    style: 'glyph',
    knobs: {},
    seed: 42,
    duration: 'auto',
    output: { ...ASPECT_SIZE[aspect], fps: 30 },
    title: { name: 'Board' },
    ...(cast === undefined ? {} : { cast })
  })
  if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
  return tl
}

const within = (s: number, a: number, b: number, n: number): boolean => ((s - a + n) % n) < ((b - a + n) % n)

describe('the glyph loop', () => {
  it('compiles with no trace scene', () => {
    const tl = glyph('glasgow.kicad_pcb', 'glasgow', '4:5')
    expect('scene' in tl).toBe(false)
    expect('film' in tl).toBe(false)
  })

  for (const [file, hints] of BOARDS) {
    for (const aspect of ASPECTS) {
      it(`${hints} ${aspect}: no formation is drawn over another: once a formation starts to write in, none of its marks lands beside a mark of the one before that has not left (before the last scene, the camera's cut ends the plan where its write-out would start), the main chip it shares excepted`, () => {
        const tl = glyph(file, hints, aspect)
        const order = [...tl.formations].sort((a, b) => a.startPhase - b.startPhase)
        let checked = 0
        for (const [i, f] of order.entries()) {
          const next = order[(i + 1) % order.length] as (typeof order)[number]
          const starts = Math.round(next.startPhase * tl.steps) % tl.steps
          const comes = tl.placements.filter((p) => p.formation === next.beat)
          const handedOver = (p: (typeof comes)[number]): boolean => p.role === 'hero' && comes.some((q) => q.glyphId === p.glyphId && JSON.stringify(q.atoms) === JSON.stringify(p.atoms))
          const before = tl.placements.filter((p) => p.formation === f.beat && !handedOver(p))
          const arriving = comes.filter((p) => (p.inStep - starts + tl.steps) % tl.steps < tl.steps / 2)
          for (const q of arriving) {
            for (const p of before) {
              if (!p.atoms.some((a) => q.atoms.some((b) => Math.hypot(a.x - b.x, a.y - b.y) <= GLYPH_CLEAR - 1e-9))) continue
              checked++
              const gone = next.id === 'field' ? p.outStep : (p.outStep + LEFT) % tl.steps
              expect(within(q.inStep, p.inStep, gone, tl.steps), `${next.id} mark at step ${q.inStep} over ${f.id} mark ${p.glyphId} standing ${p.inStep} to ${p.outStep}`).toBe(false)
            }
          }
        }
        expect(checked).toBeGreaterThan(0)
      })
    }
  }

  for (const [file, hints] of BOARDS) {
    it(`${hints}: the main chip never floats: routes start within a pitch of its body, and it is never drawn at two sizes at once`, () => {
      const tl = glyph(file, hints, '4:5')
      const of = (id: string): typeof tl.placements => tl.placements.filter((p) => tl.formations.find((f) => f.beat === p.formation)?.id === id)
      const chip = of('route').find((p) => p.role === 'hero')
      const pads = of('field').filter((p) => p.role === 'hero')
      if (chip === undefined || pads.length === 0) throw new Error('no main chip')
      const body = HERO_HALF * (chip.atoms[0]?.scale ?? 0)
      const reach = (glyphId: string): number => Math.max(...(tl.cast.find((g) => g.id === glyphId)?.strokes ?? []).flat().map((v) => Math.max(Math.abs(v.x), Math.abs(v.y))))
      const beside = of('route').filter((p) => p.role !== 'hero' && p.atoms.some((a) => {
        const gap = Math.max(Math.abs(a.x), Math.abs(a.y)) - reach(p.glyphId) * a.scale - body
        return gap > 0 && gap < GLYPH_CLEAR / 2
      }))
      expect(beside.length, 'marks beside the chip').toBeGreaterThanOrEqual(2)
      const lit = (s: number, p: GlyphTimeline['placements'][number]): boolean => decodeAlpha(s, p.inStep, p.outStep, p.pattern, tl.steps) > 0.05
      for (let s = 0; s < tl.steps; s++) {
        expect(lit(s, chip) && pads.some((p) => lit(s, p)), `step ${s}: the chip at two sizes`).toBe(false)
      }
    })
  }

  it('gives the camera one pull for each formation the film shows writing in before the name, ending on the frame the formation locks, none starting before the last has landed', { timeout: 20000 }, () => {
    for (const [file, key] of BOARDS) {
      for (const aspect of ASPECTS) {
        const tl = glyph(file, key, aspect)
        const at = (kind: string): number[] => tl.events.filter((e) => e.kind === kind).map((e) => e.at)
        expect(tl.pulls).toHaveLength(at('form').length - 1)
        expect(tl.pulls[0]?.[0]).toBe(Math.min(...at('form')))
        for (const lock of at('lock').filter((f) => f < (at('letter')[0] ?? Infinity))) expect(tl.pulls.map(([, b]) => b), `${key} ${aspect}`).toContain(lock)
        tl.pulls.forEach(([a, b], i) => {
          expect(b - a >= 42 || glide(a / loop(tl)) / glide((b - 6) / loop(tl)) - 1 <= 0.03, 'no pull is a snap').toBe(true)
          expect(b).toBeLessThan(tl.totalFrames)
          if (i > 0) expect(a).toBeGreaterThanOrEqual((tl.pulls[i - 1] as [number, number])[1])
        })
      }
    }
  })

  it('the field stands whole at least 45 frames and leaves; the name writes in letter by letter and stands whole at least 45 frames to the last frame', () => {
    for (const ending of ['parts', 'routes'] as const) {
      const tl = compileTimeline(boardModel('glasgow.kicad_pcb'), { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE['4:5'], fps: 30 }, title: { name: 'Glasgow' }, ending, ...(DEMO_CAST_HINTS.glasgow === undefined ? {} : { cast: DEMO_CAST_HINTS.glasgow }) })
      if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
      expect(tl.totalFrames).toBe(GLYPH_FILM_BEATS * 14)
      const at = (kind: string): number[] => tl.events.filter((e) => e.kind === kind).map((e) => e.at)
      expect(at('open')).toEqual([0])
      expect(at('form')).toHaveLength(5)
      for (const lock of at('lock')) {
        expect(lock).toBeLessThan(tl.totalFrames)
        for (const other of [...at('form'), ...at('name')]) expect(Math.abs(other - lock)).toBeGreaterThan(0.4 * tl.fps)
      }
      const frame = (step: number): number => (step * tl.fps) / 15
      const field = tl.placements.filter((p) => p.stage !== undefined)
      const whole = Math.max(...field.map((p) => frame(p.inStep + DECODED)))
      const leaves = Math.min(...field.filter((p) => p.role !== 'hero').map((p) => frame(p.outStep)))
      expect(leaves - whole, `${ending}: the field stands whole`).toBeGreaterThanOrEqual(45)
      expect(at('turn')[0]).toBe(at('form')[3])
      const beat = tl.formations.find((f) => f.id === 'name')?.beat
      const name = tl.placements.filter((p) => p.formation === beat)
      const letters = at('letter')
      expect(letters.length, `${ending}: one event a letter`).toBeGreaterThanOrEqual(5)
      expect(letters[0], `${ending}: the name writes after the field has gone`).toBeGreaterThan(leaves)
      const named = Math.max(...name.map((p) => frame(p.inStep + DECODED)))
      expect(at('name'), `${ending}: the name's event is its lock`).toEqual([named])
      expect(tl.totalFrames - named, `${ending}: the name stands whole`).toBeGreaterThanOrEqual(45)
      for (const p of name) expect(frame(p.outStep), `${ending}: the name stands to the last frame`).toBeGreaterThanOrEqual(tl.totalFrames)
    }
  })
})

describe('the field: the last scene, built in stages', () => {
  const drawnR = (tl: GlyphTimeline, p: GlyphTimeline['placements'][number]): number => {
    const pts = (tl.cast.find((g) => g.id === p.glyphId)?.strokes ?? []).flat()
    const k = p.atoms[0]?.scale ?? 0
    if (!p.glyphId.startsWith('cell:bar:')) return k * Math.max(...pts.map((v) => Math.hypot(v.x, v.y)))
    const thin = Math.max(...pts.map((v) => v.y)) - Math.min(...pts.map((v) => v.y))
    return k * Math.sqrt(thin / Math.PI)
  }
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

  for (const [file, hints] of BOARDS) {
    it(`${hints}: every act is about the trace film's main chip, and the field holds exactly its pads`, () => {
      const tl = glyph(file, hints, '4:5')
      const ref = pickHero(boardModel(file), DEMO_CAST_HINTS[hints])?.ref
      const chips = new Set(tl.placements.filter((p) => p.role === 'hero' && !p.glyphId.startsWith('cell:')).map((p) => p.glyphId))
      expect([...chips]).toEqual([`hero:${ref}`])
      const board = boardModel(file)
      const pads = new Set([...Object.values(board.copper).flatMap((l) => l.pads), ...board.footprints.flatMap((f) => f.offCopper ?? []).map((o) => o.pad)].filter((p) => p.footprintRef === ref).map((p) => `${p.pos.x},${p.pos.y}`))
      expect(tl.placements.filter((p) => p.stage !== undefined && p.role === 'hero').length).toBe(pads.size)
    })

    for (const aspect of ASPECTS) {
      it(`${hints} ${aspect}: the field's marks arrive in stages of rising size, each stage on the beat, and only the closing marks land on the lock`, () => {
        const tl = glyph(file, hints, aspect)
        const field = tl.placements.filter((p) => p.stage !== undefined && p.role !== 'hero')
        const frame = (step: number): number => (step * tl.fps) / 15
        const sizes = [1, 2, 3].map((st) => median(field.filter((p) => p.stage === st).map((p) => drawnR(tl, p))))
        expect(sizes[1] as number, 'stage 2 is larger than stage 1').toBeGreaterThan(sizes[0] as number)
        expect(sizes[2] as number, 'stage 3 is larger than stage 2').toBeGreaterThan(sizes[1] as number)
        const beat = loop(tl) / GLYPH_LOOP_BEATS
        const starts = [1, 2, 3].map((st) => frame(Math.min(...tl.placements.filter((p) => p.stage === st).map((p) => p.inStep))))
        for (const f of starts) expect(Math.abs(f / beat - Math.round(f / beat)) * beat, `a stage starts at frame ${f}`).toBeLessThanOrEqual(1)
        expect(starts[1] as number).toBeGreaterThan(starts[0] as number)
        expect(starts[2] as number).toBeGreaterThan(starts[1] as number)
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const lock = (tl.pulls.find(([a]) => a === turn) as [number, number])[1]
        expect(Math.abs(lock / beat - Math.round(lock / beat)) * beat, 'the lock is on the beat').toBeLessThanOrEqual(1)
        const landsOnLock = field.filter((p) => Math.abs(frame(p.inStep + DECODED) - lock) < 1)
        expect(landsOnLock.length).toBeGreaterThan(0)
        expect(landsOnLock.every((p) => p.stage === 4), 'only the closing marks land on the lock').toBe(true)
        expect(field.filter((p) => p.stage === 4).every((p) => Math.abs(frame(p.inStep + DECODED) - lock) < 1), 'the closing marks land together').toBe(true)
        const before = Math.max(...field.filter((p) => p.stage !== 4).map((p) => frame(p.inStep + DECODED)))
        expect(lock - before, 'a stop before the lock').toBeGreaterThanOrEqual(0.6 * beat)
      })

      it(`${hints} ${aspect}: the field's chip never lights alone`, () => {
        const tl = glyph(file, hints, aspect)
        const start = Math.round((tl.formations.find((f) => f.id === 'field')?.startPhase ?? 0) * tl.steps)
        const lit = (s: number) => (p: GlyphTimeline['placements'][number]): boolean => decodeAlpha(s % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.3
        let seen = 0
        for (let s = start; s < start + 10; s++) {
          if (!tl.placements.some((p) => p.stage !== undefined && p.role === 'hero' && lit(s)(p))) continue
          seen++
          expect(tl.placements.filter((p) => p.role !== 'hero' && lit(s)(p)).length, `step ${s}`).toBeGreaterThanOrEqual(12)
        }
        expect(seen).toBeGreaterThan(0)
      })
    }
  }

  const quarter = (a: number): number => ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)
  const apart = (a: number, b: number): number => {
    const d = Math.abs(quarter(a) - quarter(b))
    return Math.min(d, Math.PI / 2 - d)
  }
  for (const [file, hints] of BOARDS) {
    for (const aspect of ASPECTS) {
      it(`${hints} ${aspect}: the routes draw the main chip at the turn the field gives its pads, so the last scene hands the same chip to the first`, () => {
        const tl = glyph(file, hints, aspect)
        const chip = tl.placements.find((p) => p.stage === undefined && p.role === 'hero' && p.glyphId.startsWith('hero:'))
        const pads = tl.placements.filter((p) => p.stage === 1 && p.role === 'hero').map((p) => p.atoms[0] as { x: number; y: number })
        expect(chip).toBeDefined()
        expect(pads.length).toBeGreaterThan(8)
        const turns = pads.map((a) => {
          const near = pads.filter((b) => b !== a).sort((b, c) => Math.hypot(b.x - a.x, b.y - a.y) - Math.hypot(c.x - a.x, c.y - a.y))[0] as { x: number; y: number }
          return quarter(Math.atan2(near.y - a.y, near.x - a.x))
        }).sort((a, b) => a - b)
        const field = turns[Math.floor(turns.length / 2)] as number
        expect(apart(chip?.atoms[0]?.rot ?? 0, field)).toBeLessThan(0.05)
      })

      it(`${hints} ${aspect}: marks the start of each of the last scene's stages and the button among the events, for the sound to land on`, () => {
        const tl = glyph(file, hints, aspect)
        const frameOf = (step: number): number => Math.round((step * tl.fps) / 15)
        const stages = tl.events.filter((e) => e.kind === 'stage')
        expect(stages.map((e) => e.stage)).toEqual([1, 2, 3, 4])
        for (const e of stages) expect(e.at).toBe(frameOf(Math.min(...tl.placements.filter((p) => p.stage === e.stage).map((p) => p.inStep))))
        expect(stages.map((e) => e.at)).toEqual([...stages.map((e) => e.at)].sort((a, b) => a - b))
        const lock = Math.max(...tl.placements.filter((p) => p.stage !== undefined).map((p) => frameOf(p.inStep + DECODED)))
        expect(tl.events.filter((e) => e.kind === 'button').map((e) => e.at)).toEqual([lock + Math.round(loop(tl) / GLYPH_LOOP_BEATS)])
      })
    }
  }

  for (const [file, hints] of BOARDS) {
    for (const aspect of ASPECTS) {
      it(`${hints} ${aspect}: the routes leave as one move, the dark before the plan is at most four frames, and the plan opens on its centre part with a quarter of its parts round it, whole within twelve frames`, () => {
        const tl = glyph(file, hints, aspect)
        const routes = tl.formations.find((f) => f.id === 'route')?.beat
        const plan = tl.formations.find((f) => f.id === 'plan')?.beat
        const step = (f: number): number => Math.floor((f * 15) / tl.fps) % tl.steps
        const lit = (beat: number | undefined, f: number): number => tl.placements.filter((p) => p.formation === beat && decodeAlpha(step(f), p.inStep, p.outStep, p.pattern, tl.steps) > 0.05).length
        const start = tl.events.filter((e) => e.kind === 'form')[0]?.at as number
        const held = lit(routes, start - 24)
        const leaving = Array.from({ length: 24 }, (_, i) => start - 24 + i).filter((f) => lit(routes, f) < 0.95 * held && lit(routes, f) > 0)
        expect(leaving.length, 'the routes are gone within about twelve frames of starting to leave').toBeLessThanOrEqual(12)
        const dark = Array.from({ length: 12 }, (_, i) => start - 8 + i).filter((f) => lit(routes, f) === 0 && lit(plan, f) === 0)
        expect(dark.length).toBeLessThanOrEqual(4)
        const first = Array.from({ length: 12 }, (_, i) => start - 4 + i).find((f) => lit(plan, f) > 0) as number
        const mine = tl.placements.filter((p) => p.formation === plan)
        expect(lit(plan, first), 'the plan never opens on one part alone').toBeGreaterThanOrEqual(0.2 * mine.length)
        expect(mine.filter((p) => p.role === 'hero').every((p) => decodeAlpha(step(first), p.inStep, p.outStep, p.pattern, tl.steps) > 0.05), 'the centre part is in the first frame').toBe(true)
        const ins = mine.map((p) => (p.inStep - step(first) + tl.steps) % tl.steps)
        expect(Math.max(...ins) * 2, 'the whole plan has started within twelve frames').toBeLessThanOrEqual(12)
        const shown = (f: number): number => mine.filter((p) => (p.steady === true ? steadyAlpha : decodeAlpha)(step(f), p.inStep, p.outStep, p.pattern, tl.steps) > 0.05).length
        for (let f = first + 1; f < first + 24; f++) expect(shown(f), `the plan never falls back as it arrives, frame ${f}`).toBeGreaterThanOrEqual(shown(f - 1))
      })

      it(`${hints} ${aspect}: the name has written out before the first route of the return draws`, () => {
        const tl = glyph(file, hints, aspect)
        const name = tl.placements.find((p) => p.formation === tl.formations.find((f) => f.id === 'name')?.beat)
        const routes = tl.formations.find((f) => f.id === 'route')?.beat
        const back = Math.min(...tl.placements.filter((p) => p.formation === routes).map((p) => (p.inStep - (name?.inStep ?? 0) + tl.steps) % tl.steps))
        const gone = ((name?.outStep ?? 0) - (name?.inStep ?? 0) + tl.steps) % tl.steps + LEFT
        expect(gone).toBeLessThanOrEqual(back)
      })
    }
  }
})

describe('the return and the plan', () => {
  for (const [file, hints] of BOARDS) {
    for (const aspect of ASPECTS) {
      it(`${hints} ${aspect}: after the button the field holds at full strength until it leaves, the name from its lock to the last frame, and the film is a whole number of beats`, () => {
        const tl = glyph(file, hints, aspect)
        const field = tl.formations.find((f) => f.id === 'field')?.beat
        const step = (f: number): number => Math.floor((f * 15) / tl.fps) % tl.steps
        const button = tl.events.find((e) => e.kind === 'button')?.at as number
        const mine = tl.placements.filter((p) => p.formation === field)
        const level = (f: number): number[] => mine.map((p) => (p.steady === true ? steadyAlpha : decodeAlpha)(step(f), p.inStep, p.outStep, p.pattern, tl.steps) * blinkAlpha(step(f), p.blinks, tl.steps))
        const held = level(button)
        const exit = Math.min(...mine.filter((p) => p.role !== 'hero').map((p) => Math.round((p.outStep * tl.fps) / 15)))
        for (let f = button; f < exit; f++) expect(level(f), `frame ${f}`).toEqual(held)
        expect(held.every((v) => v === 0 || v === 1), 'every mark of the field stands whole or has gone').toBe(true)
        const named = tl.events.find((e) => e.kind === 'name')?.at as number
        const name = tl.placements.filter((p) => p.formation === tl.formations.find((f) => f.id === 'name')?.beat)
        const shown = (f: number): number[] => name.map((p) => (p.steady === true ? steadyAlpha : decodeAlpha)(step(f), p.inStep, p.outStep, p.pattern, tl.steps) * blinkAlpha(step(f), p.blinks, tl.steps))
        for (let f = named; f < tl.totalFrames; f++) expect(shown(f).every((v) => v === 1), `the name stands whole at frame ${f}`).toBe(true)
        expect(held.filter((v) => v === 1).length, 'most of the field stands').toBeGreaterThan(0.8 * mine.length)
        const beat = loop(tl) / GLYPH_LOOP_BEATS
        expect(tl.totalFrames / beat).toBe(GLYPH_FILM_BEATS)
        expect(tl.events.every((e) => e.at < tl.totalFrames)).toBe(true)
        expect(tl.events.filter((e) => e.kind === 'form').length, 'the routes do not return').toBe(5)
      })

      it(`${hints} ${aspect}: every pad of the field keeps a dark gap to its nearest neighbour: its drawn half-width across the pitch is at most 0.3 of their distance, and a bar's half-length at most 0.3 of the distance to a pad in its lane`, () => {
        const tl = glyph(file, hints, aspect)
        const half = (id: string): number => {
          const pts = tl.cast.find((g) => g.id === id)?.strokes.flat() ?? []
          return pts.length === 0 ? 0 : Math.min(Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y))) / 2
        }
        const field = tl.placements.filter((p) => p.stage !== undefined && p.glyphId !== 'txt:title')
        const all = field.flatMap((p) => p.atoms.map((a) => ({ x: a.x, y: a.y, r: p.role === 'hero' ? 0 : half(p.glyphId) * a.scale, id: p.glyphId })))
        for (const a of all) {
          if (a.r === 0) continue
          const d = Math.min(...all.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y)))
          expect(a.r, `${a.id} at ${a.x.toFixed(3)},${a.y.toFixed(3)}`).toBeLessThanOrEqual(0.3 * d + 1e-9)
        }
        for (const p of field.filter((q) => q.glyphId.startsWith('cell:bar:'))) {
          for (const a of p.atoms) {
            const half = a.scale / 2
            const across = half * (Math.max(...(tl.cast.find((g) => g.id === p.glyphId)?.strokes.flat() ?? []).map((q) => q.y)) * 2)
            const ux = Math.cos(a.rot)
            const uy = Math.sin(a.rot)
            for (const b of all) {
              if (b.x === a.x && b.y === a.y) continue
              const dx = b.x - a.x
              const dy = b.y - a.y
              if (Math.abs(-dx * uy + dy * ux) >= across + 0.3 * Math.hypot(dx, dy)) continue
              if (half <= across + 1e-9) continue
              expect(half, `${p.glyphId} at ${a.x.toFixed(3)},${a.y.toFixed(3)} keeps its end clear of the pad in its lane`).toBeLessThanOrEqual(0.3 * Math.abs(dx * ux + dy * uy) + 1e-9)
            }
          }
        }
      })

      it(`${hints} ${aspect}: a fine-pitch rectangular pad keeps its own long side: where its point would be capped it draws as a bar in its own direction, no longer than itself`, () => {
        const tl = glyph(file, hints, aspect)
        const board = boardModel(file)
        const ref = pickHero(board, DEMO_CAST_HINTS[hints])?.ref
        const key = (q: { x: number; y: number }): string => `${Math.round(q.x * 100)},${Math.round(q.y * 100)}`
        const heroPads = [...new Map(Object.values(board.copper).flatMap((l) => l.pads).filter((q) => q.footprintRef === ref).map((q) => [key(q.pos), q.pos])).values()]
        const atoms = tl.placements.filter((q) => q.stage !== undefined && q.role === 'hero').map((q) => q.atoms[0] as { x: number; y: number })
        const n = Math.min(heroPads.length, atoms.length)
        const A = heroPads.slice(0, n)
        const B = atoms.slice(0, n)
        const ca = { x: A.reduce((t, q) => t + q.x, 0) / n, y: A.reduce((t, q) => t + q.y, 0) / n }
        const cb = { x: B.reduce((t, q) => t + q.x, 0) / n, y: B.reduce((t, q) => t + q.y, 0) / n }
        let sxx = 0
        let sxy = 0
        let na = 0
        A.forEach((q, i) => {
          const ax = q.x - ca.x
          const ay = q.y - ca.y
          const bx = (B[i] as { x: number }).x - cb.x
          const by = (B[i] as { y: number }).y - cb.y
          sxx += ax * bx + ay * by
          sxy += ax * by - ay * bx
          na += ax * ax + ay * ay
        })
        const k = Math.hypot(sxx, sxy) / na
        const th = Math.atan2(sxy, sxx)
        const place = (q: { x: number; y: number }): [number, number] => [cb.x + k * (Math.cos(th) * (q.x - ca.x) - Math.sin(th) * (q.y - ca.y)), cb.y + k * (Math.sin(th) * (q.x - ca.x) + Math.cos(th) * (q.y - ca.y))]
        const bars = tl.placements.filter((q) => q.stage !== undefined && q.glyphId.startsWith('cell:bar:')).flatMap((q) => q.atoms)
        expect(bars.length, 'fine-pitch pads draw as bars').toBeGreaterThan(0)
        for (const pad of Object.values(board.copper).flatMap((l) => l.pads)) {
          const [x, y] = place(pad.pos)
          const bar = bars.find((a) => Math.hypot(a.x - x, a.y - y) < 1e-6)
          if (bar === undefined) continue
          const long = Math.max(pad.size.x, pad.size.y)
          expect(bar.scale, `${pad.footprintRef} ${pad.num ?? ''} is no longer than itself`).toBeLessThanOrEqual(long * k + 1e-9)
          const axis = (-pad.rot * Math.PI) / 180 + (pad.size.y > pad.size.x ? Math.PI / 2 : 0) + th
          const off = Math.abs((((bar.rot - axis) % Math.PI) + Math.PI) % Math.PI)
          expect(Math.min(off, Math.PI - off), `${pad.footprintRef} ${pad.num ?? ''} lies along its own long side`).toBeLessThan(1e-6)
        }
      })

      it(`${hints} ${aspect}: the plan draws its main chip's part once`, () => {
        const tl = glyph(file, hints, aspect)
        const plan = tl.formations.find((f) => f.id === 'plan')?.beat
        const chips = tl.placements.filter((p) => p.formation === plan && p.role === 'hero')
        expect(chips).toHaveLength(1)
        expect(chips[0]?.atoms).toHaveLength(1)
      })

      it(`${hints} ${aspect}: the plan's and the routes' hairline is at least 0.7 px when the film plays 390 px wide`, () => {
        const tl = glyph(file, hints, aspect)
        const plan = new Set(tl.formations.filter((f) => f.id !== 'field').map((f) => f.beat))
        const hair = (GLYPH_INK * Math.min(tl.width, tl.height)) / 1080
        for (const p of tl.placements.filter((q) => plan.has(q.formation))) expect(((p.weight ?? 1) * hair * 390) / tl.width, p.glyphId).toBeGreaterThanOrEqual(0.7 - 1e-9)
      })
    }
  }
})
