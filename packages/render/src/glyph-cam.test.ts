import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, GLYPH_CUT_EARLY, GLYPH_INK, GLYPH_INK_SCALE, GLYPH_LOOP_BEATS, compileTimeline, decodeAlpha, safeArea } from '@silk-reel/choreo'
import type { Aspect, GlyphTimeline } from '@silk-reel/choreo'
import { boardModel } from '../../choreo/test/helpers'
import { camScale, glide, glyphView } from './glyph-cam'
import type { GlyphView } from './glyph-cam'

describe('the glyph camera', () => {
  const total = GLYPH_LOOP_BEATS * 14
  const pulls: Array<[number, number]> = [[56, 114], [168, 228], [228, 270]]
  const at = (f: number): number => camScale(f, total, pulls)

  it('is never wider than the approved glide', () => {
    for (let f = 0; f < total; f++) expect(at(f), `${f}`).toBeGreaterThanOrEqual(glide(f / total) * (1 - 1e-6))
  })

  it('lands each pull on the frame its formation locks, then holds until the next pull moves', () => {
    for (const [i, [, lock]] of pulls.entries()) {
      expect(Math.abs(at(lock) - at(lock - 1)) / at(lock), `pull ${i} has stopped at its lock`).toBeLessThan(0.002)
      expect(at(lock - 12) / at(lock), `pull ${i} was still moving half a second before`).toBeGreaterThan(1.004)
      const next = pulls[i + 1]
      const until = next === undefined ? total : next[0] + Math.floor(0.3 * (next[1] - next[0]))
      for (let f = lock + 13; f <= until; f++) expect(at(f), `${f} holds`).toBeCloseTo(at(lock + 13), 9)
    }
  })

  it('opens close on the chip', () => {
    expect(at(0)).toBeCloseTo(3.1, 9)
  })
})

describe('the last scene\'s camera', () => {
  const cases: Array<[string, Aspect]> = [['glasgow.kicad_pcb', '4:5'], ['glasgow.kicad_pcb', '16:9'], ['icebreaker.kicad_pcb', '4:5'], ['icebreaker.kicad_pcb', '9:16'], ['kit-dev-coldfire-xilinx_5213.kicad_pcb', '16:9'], ['kit-dev-coldfire-xilinx_5213.kicad_pcb', '1:1']]
  const glyph = (file: string, aspect: Aspect): GlyphTimeline => {
    const tl = compileTimeline(boardModel(file), { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name: 'Board' } })
    if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
    return tl
  }
  const screen = (tl: GlyphTimeline, frame: number) => {
    const safe = safeArea(tl.width, tl.height, false)
    const stage = 0.5 * Math.min(safe.w, safe.h)
    const v = glyphView(frame, tl)
    return (x: number, y: number): [number, number] => [
      tl.width / 2 + v.scale * (safe.x + safe.w / 2 + x * stage - tl.width / 2 - v.dx),
      tl.height / 2 + v.scale * (safe.y + safe.h / 2 + y * stage - tl.height / 2 - v.dy)
    ]
  }

  for (const [file, aspect] of cases) {
    it(`${file} ${aspect}: shows no mark alone in black on any frame but the breath's point`, () => {
      const tl = glyph(file, aspect)
      const last = tl.placements.find((p) => p.stage !== undefined)?.formation
      const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
      for (let f = 0; f < tl.totalFrames; f++) {
        const scene = glyphView(f, tl).scene
        const atoms = tl.placements.filter((p) => (!scene || p.formation === last) && decodeAlpha(Math.floor((f * 15) / tl.fps) % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.05).reduce((n, p) => n + p.atoms.length, 0)
        if (scene && f < turn) continue
        expect(atoms === 0 || atoms > 2, `frame ${f} shows ${atoms}`).toBe(true)
      }
    })

    it(`${file} ${aspect}: holds a breath of three or four frames between the plan and the field, dark but for the chip's first point`, () => {
      const tl = glyph(file, aspect)
      const last = tl.placements.find((p) => p.stage !== undefined)?.formation
      const lit = (f: number): number => {
        const scene = glyphView(f, tl).scene
        return tl.placements.filter((p) => (!scene || p.formation === last) && decodeAlpha(Math.floor((f * 15) / tl.fps) % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.05).length
      }
      const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
      const dark = Array.from({ length: 24 }, (_, i) => turn - 16 + i).filter((f) => lit(f) <= 1)
      expect(dark.length).toBeGreaterThanOrEqual(3)
      expect(dark.length).toBeLessThanOrEqual(4)
      expect(dark.every((f, i) => i === 0 || f === (dark[i - 1] as number) + 1)).toBe(true)
    })

    it(`${file} ${aspect}: is never wider than the glide, and cuts at most once, in the dark, to the chip's pad grid at a third of the frame's width at its centre`, () => {
      const tl = glyph(file, aspect)
      const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
      const views = Array.from({ length: tl.totalFrames + 1 }, (_, f) => glyphView(f, tl))
      const loop = (tl.steps * tl.fps) / 15
      for (let f = 0; f < tl.totalFrames; f++) expect((views[f] as GlyphView).scale, `${f}`).toBeGreaterThanOrEqual(glide(f / loop) * (1 - 1e-6))
      const jumps = views.slice(1).flatMap((v, i) => (Math.abs(v.scale / (views[i] as GlyphView).scale - 1) > 0.15 || Math.hypot(v.dx - (views[i] as GlyphView).dx, v.dy - (views[i] as GlyphView).dy) > 0.02 * tl.width ? [i + 1] : []))
      const cut = views.findIndex((v) => v.scene)
      expect(jumps.length, 'at most one jump, and only on the cut').toBeLessThanOrEqual(1)
      if (jumps.length === 1) expect(jumps[0]).toBe(cut)
      expect(cut).toBeLessThan(turn)
      const lit = (f: number): number => tl.placements.filter((p) => p.formation === tl.placements.find((q) => q.stage !== undefined)?.formation && decodeAlpha(Math.floor((f * 15) / tl.fps) % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.05).length
      expect(lit(cut), 'the field has not started at the cut').toBeLessThanOrEqual(2)
      expect((views[cut] as GlyphView).scene).toBe(true)
      expect((views[cut - 1] as GlyphView).scene).toBe(false)
      const pads = tl.placements.filter((p) => p.stage !== undefined && p.role === 'hero').flatMap((p) => p.atoms)
      const at = screen(tl, turn)
      const xs = pads.map((a) => at(a.x, a.y)[0])
      const ys = pads.map((a) => at(a.x, a.y)[1])
      expect((Math.max(...xs) - Math.min(...xs)) / tl.width).toBeGreaterThan(0.27)
      expect((Math.max(...xs) - Math.min(...xs)) / tl.width).toBeLessThan(0.36)
      expect(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - tl.width / 2)).toBeLessThan(0.02 * tl.width)
      expect(Math.abs((Math.max(...ys) + Math.min(...ys)) / 2 - tl.height / 2)).toBeLessThan(0.02 * tl.height)
    })

    it(`${file} ${aspect}: frames the whole field and the name at the lock, and is on the chip as the dive ends`, () => {
      const tl = glyph(file, aspect)
      const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
      const lock = (tl.pulls.find(([a]) => a === turn) as [number, number])[1]
      const at = screen(tl, lock)
      for (const p of tl.placements.filter((q) => q.stage !== undefined || q.glyphId === 'txt:title')) {
        for (const a of p.atoms) {
          const [x, y] = at(a.x, a.y)
          expect(x, `${p.glyphId} x`).toBeGreaterThan(0)
          expect(x, `${p.glyphId} x`).toBeLessThan(tl.width)
          expect(y, `${p.glyphId} y`).toBeGreaterThan(0)
          expect(y, `${p.glyphId} y`).toBeLessThan(tl.height)
        }
      }
      const pads = tl.placements.filter((p) => p.stage !== undefined && p.role === 'hero').flatMap((p) => p.atoms)
      const route = tl.placements.find((p) => p.role === 'hero' && p.stage === undefined)
      expect(route?.atoms[0]?.x).toBeCloseTo(0, 6)
      expect(route?.atoms[0]?.y).toBeCloseTo(0, 6)
      expect(Math.hypot((pads.reduce((n, a) => n + a.x, 0) / pads.length), (pads.reduce((n, a) => n + a.y, 0) / pads.length)), 'the field\'s chip stands where the routes\' chip writes in').toBeLessThan(0.05)
    })
  }
})

describe('the push through the formation before the field', () => {
  const boards = ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']
  for (const file of boards) {
    for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
      it(`${file} ${aspect}: ends on the breath with the chip's body where, and as large as, the field's chip pads open the last scene`, () => {
        const tl = compileTimeline(boardModel(file), { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name: 'Board' } })
        if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
        const safe = safeArea(tl.width, tl.height, false)
        const stage = 0.5 * Math.min(safe.w, safe.h)
        const at = (f: number, x: number, y: number): [number, number] => {
          const v = glyphView(f, tl)
          return [tl.width / 2 + v.scale * (safe.x + safe.w / 2 + x * stage - tl.width / 2 - v.dx), tl.height / 2 + v.scale * (safe.y + safe.h / 2 + y * stage - tl.height / 2 - v.dy)]
        }
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const before = turn - GLYPH_CUT_EARLY - 1
        const prior = [...tl.formations].sort((a, b) => a.startPhase - b.startPhase).find((f, i, all) => all[i + 1]?.id === 'field')?.beat
        const plan = tl.placements.find((p) => p.role === 'hero' && p.stage === undefined && p.formation === prior)
        const part = plan?.atoms[0]
        if (part === undefined) throw new Error('no chip before the field')
        const outline = tl.cast.find((g) => g.id === plan?.glyphId)?.strokes[0] ?? []
        const w = Math.max(...outline.map((q) => q.x)) - Math.min(...outline.map((q) => q.x))
        const h = Math.max(...outline.map((q) => q.y)) - Math.min(...outline.map((q) => q.y))
        const half = ((Math.abs(Math.cos(part.rot)) * w + Math.abs(Math.sin(part.rot)) * h) * part.scale) / 2
        const [l] = at(before, part.x - half, part.y)
        const [r, cy] = at(before, part.x + half, part.y)
        const pads = tl.placements.filter((p) => p.stage !== undefined && p.role === 'hero').flatMap((p) => p.atoms).map((a) => at(turn, a.x, a.y))
        const px = pads.map(([x]) => x)
        const py = pads.map(([, y]) => y)
        const grid = Math.max(...px) - Math.min(...px)
        expect(Math.abs((r - l) / grid - 1), 'the same size').toBeLessThan(0.08)
        expect(Math.abs((l + r) / 2 - (Math.min(...px) + Math.max(...px)) / 2) / tl.width, 'the same place across').toBeLessThan(0.03)
        expect(Math.abs(cy - (Math.min(...py) + Math.max(...py)) / 2) / tl.height, 'the same place down').toBeLessThan(0.03)
        const held = (tl.pulls[tl.pulls.findIndex(([f]) => f === turn) - 1] as [number, number])[1]
        const scales = Array.from({ length: before - held }, (_, i) => glyphView(held + i, tl).scale)
        for (let i = 1; i < scales.length; i++) expect(scales[i] as number).toBeGreaterThanOrEqual((scales[i - 1] as number) - 1e-9)
      })
    }
  }
})

describe('the hold, the push\'s first second and the one chip', () => {
  const boards = ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']
  for (const file of boards) {
    for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
      const film = (): GlyphTimeline => {
        const tl = compileTimeline(boardModel(file), { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name: 'Board' } })
        if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
        return tl
      }
      it(`${file} ${aspect}: the chip before the field carries its own turn, so its body's corners at the last frame before the breath lie on the bounds of the pads that open the last scene`, () => {
        const tl = film()
        const safe = safeArea(tl.width, tl.height, false)
        const stage = 0.5 * Math.min(safe.w, safe.h)
        const at = (f: number, x: number, y: number): [number, number] => {
          const v = glyphView(f, tl)
          return [tl.width / 2 + v.scale * (safe.x + safe.w / 2 + x * stage - tl.width / 2 - v.dx), tl.height / 2 + v.scale * (safe.y + safe.h / 2 + y * stage - tl.height / 2 - v.dy)]
        }
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const before = turn - GLYPH_CUT_EARLY - 1
        const prior = [...tl.formations].sort((a, b) => a.startPhase - b.startPhase).find((f, i, all) => all[i + 1]?.id === 'field')?.beat
        const plan = tl.placements.find((p) => p.role === 'hero' && p.stage === undefined && p.formation === prior)
        const a = plan?.atoms[0]
        if (plan === undefined || a === undefined) throw new Error('no chip before the field')
        const raw = tl.cast.find((g) => g.id === plan.glyphId)?.strokes[0] ?? []
        const corners = [Math.min(...raw.map((q) => q.x)), Math.max(...raw.map((q) => q.x))].flatMap((x) => [Math.min(...raw.map((q) => q.y)), Math.max(...raw.map((q) => q.y))].map((y) => at(before, a.x + (x * Math.cos(a.rot) - y * Math.sin(a.rot)) * a.scale, a.y + (x * Math.sin(a.rot) + y * Math.cos(a.rot)) * a.scale)))
        const pads = tl.placements.filter((p) => p.stage !== undefined && p.role === 'hero').flatMap((p) => p.atoms).map((q) => at(turn, q.x, q.y))
        const box = (ps: Array<[number, number]>): number[] => [Math.min(...ps.map((p) => p[0])), Math.min(...ps.map((p) => p[1])), Math.max(...ps.map((p) => p[0])), Math.max(...ps.map((p) => p[1]))]
        const pb = box(pads)
        box(corners).forEach((v, i) => {
          expect(Math.abs(v - (pb[i] as number)), `bound ${i}`).toBeLessThan(0.012 * tl.width)
        })
        const area = (t: number): number => {
          const xs = pads.map(([x, y]) => x * Math.cos(t) + y * Math.sin(t))
          const ys = pads.map(([x, y]) => -x * Math.sin(t) + y * Math.cos(t))
          return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
        }
        const angles = Array.from({ length: 180 }, (_, k) => (k * Math.PI) / 360)
        const grid = angles.reduce((best, t) => (area(t) < area(best) ? t : best), 0)
        const off = (((a.rot - grid) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)
        expect(Math.min(off, Math.PI / 2 - off), 'the outline turns with the pad grid').toBeLessThan((3 * Math.PI) / 180)
      })

      it(`${file} ${aspect}: holds still on the field from the button until it leaves, glides at one scale to the name in the dark, and holds still on the name from its first letter to the last frame`, () => {
        const tl = film()
        const button = tl.events.find((e) => e.kind === 'button')?.at as number
        const exit = Math.min(...tl.placements.filter((p) => p.stage !== undefined && p.role !== 'hero').map((p) => Math.round((p.outStep * tl.fps) / 15)))
        const letter = tl.events.find((e) => e.kind === 'letter')?.at as number
        const held = glyphView(button, tl)
        for (let f = button; f <= exit; f++) expect(glyphView(f, tl), `frame ${f}`).toEqual(held)
        for (let f = exit; f <= letter; f++) expect(glyphView(f, tl).scale, `frame ${f} keeps the scale`).toBe(held.scale)
        const named = glyphView(letter, tl)
        for (let f = letter; f < tl.totalFrames; f++) expect(glyphView(f, tl), `frame ${f}`).toEqual(named)
      })

      it(`${file} ${aspect}: the push is felt in the first second after the formation before the field is whole, and at the last frame before the breath nothing else of the chip's size is in the frame`, () => {
        const tl = film()
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const lock = (tl.pulls[tl.pulls.findIndex(([a]) => a === turn) - 1] as [number, number])[1]
        expect(glyphView(lock + tl.fps, tl).scale / glyphView(lock, tl).scale, 'the push creeps from the lock').toBeGreaterThan(1.04)
        const before = turn - GLYPH_CUT_EARLY - 1
        const safe = safeArea(tl.width, tl.height, false)
        const stage = 0.5 * Math.min(safe.w, safe.h)
        const v = glyphView(before, tl)
        const at = (x: number, y: number): [number, number] => [tl.width / 2 + v.scale * (safe.x + safe.w / 2 + x * stage - tl.width / 2 - v.dx), tl.height / 2 + v.scale * (safe.y + safe.h / 2 + y * stage - tl.height / 2 - v.dy)]
        const plan = [...tl.formations].sort((a, b) => a.startPhase - b.startPhase).find((f, i, all) => all[i + 1]?.id === 'field')?.beat
        const span = (p: { glyphId: string }): number => {
          const pts = tl.cast.find((g) => g.id === p.glyphId)?.strokes.flat() ?? []
          return pts.length === 0 ? 0 : Math.max(Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y)))
        }
        const chip = tl.placements.find((p) => p.formation === plan && p.role === 'hero')
        const part = chip?.atoms[0]
        if (chip === undefined || part === undefined) throw new Error('no chip before the field')
        const size = span(chip) * part.scale
        for (const p of tl.placements.filter((q) => q.formation === plan && q !== chip)) {
          for (const a of p.atoms) {
            const half = (span(p) * a.scale) / 2
            if (2 * half < 0.7 * size) continue
            const [x0, y0] = at(a.x - half, a.y - half)
            const [x1, y1] = at(a.x + half, a.y + half)
            const inside = x1 > 0 && x0 < tl.width && y1 > 0 && y0 < tl.height && decodeAlpha(Math.floor((before * 15) / tl.fps) % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.05
            expect(inside, `${p.glyphId} at ${a.x.toFixed(2)},${a.y.toFixed(2)} is as large as the chip and in the frame`).toBe(false)
          }
        }
      })
    }
  }
})

describe('the part plan\'s outlines', () => {
  const boards = ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']
  for (const file of boards) {
    for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
      it(`${file} ${aspect}: keep three line weights of dark between any two, the board's edge apart, while the plan stands`, () => {
        const tl = compileTimeline(boardModel(file), { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name: 'Board' } })
        if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
        const plan = tl.formations.find((f) => f.id === 'plan')?.beat
        const first = tl.events.filter((e) => e.kind === 'form').map((e) => e.at).sort((a, b) => a - b)[0] as number
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const shown = (f: number): boolean => tl.placements.some((p) => p.formation === plan && decodeAlpha(Math.floor((f * 15) / tl.fps) % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0.004)
        const scale = Math.min(...Array.from({ length: turn - GLYPH_CUT_EARLY - first }, (_, i) => first + i).filter(shown).map((f) => glyphView(f, tl).scale))
        const safe = safeArea(tl.width, tl.height, false)
        const px = 0.5 * Math.min(safe.w, safe.h) * scale
        const ink = (GLYPH_INK_SCALE * GLYPH_INK * Math.min(tl.width, tl.height)) / 1080
        const hull = (ps: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
          const sorted = [...ps].sort((p, q) => p.x - q.x || p.y - q.y)
          const cross = (o: { x: number; y: number }, p: { x: number; y: number }, q: { x: number; y: number }): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
          const half = (list: typeof ps): typeof ps => list.reduce<typeof ps>((out, p) => {
            while (out.length >= 2 && cross(out[out.length - 2] as (typeof ps)[number], out[out.length - 1] as (typeof ps)[number], p) <= 0) out.pop()
            return [...out, p]
          }, []).slice(0, -1)
          return [...half(sorted), ...half([...sorted].reverse())]
        }
        const gapOf = (a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>): number => {
          const axes = [a, b].flatMap((h) => h.map((p, i) => {
            const q = h[(i + 1) % h.length] as { x: number; y: number }
            const l = Math.hypot(q.x - p.x, q.y - p.y) || 1
            return { x: -(q.y - p.y) / l, y: (q.x - p.x) / l }
          }))
          return Math.max(...[{ x: 1, y: 0 }, { x: 0, y: 1 }, ...axes].map((n) => {
            const pa = a.map((p) => p.x * n.x + p.y * n.y)
            const pb = b.map((p) => p.x * n.x + p.y * n.y)
            return Math.max(Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb))
          }))
        }
        const outlines = tl.placements.filter((p) => p.formation === plan && p.glyphId.startsWith('cell:')).flatMap((p) => {
          const pts = tl.cast.find((g) => g.id === p.glyphId)?.strokes.flat() ?? []
          return p.atoms.map((a) => {
            const fx = a.flipX === true ? -1 : 1
            const fy = a.flipY === true ? -1 : 1
            const drawn = pts.map((q) => ({ x: a.x + (fx * q.x * Math.cos(a.rot) - fy * q.y * Math.sin(a.rot)) * a.scale, y: a.y + (fx * q.x * Math.sin(a.rot) + fy * q.y * Math.cos(a.rot)) * a.scale }))
            return { name: `${p.glyphId} at ${a.x.toFixed(2)},${a.y.toFixed(2)}`, edge: p.glyphId === 'cell:tick' || p.glyphId === 'cell:dash', hull: hull(drawn), lw: ink * (p.weight ?? 1) }
          })
        })
        expect(outlines.filter((o) => !o.edge).length, 'the plan has parts').toBeGreaterThan(8)
        for (const [i, a] of outlines.entries()) {
          for (const b of outlines.slice(i + 1)) {
            if (a.edge && b.edge) continue
            expect(gapOf(a.hull, b.hull) * px, `${a.name} and ${b.name}`).toBeGreaterThanOrEqual(3 * Math.max(a.lw, b.lw) + (a.lw + b.lw) / 2 - 1e-6)
          }
        }
      })
    }
  }
})

describe('the routes scene\'s words', () => {
  const boards = ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']
  for (const file of boards) {
    for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
      it(`${file} ${aspect}: never name ground, and name only the main chip's own named nets`, () => {
        const board = boardModel(file)
        const tl = compileTimeline(board, { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name: 'Board' } })
        if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
        const words = tl.placements.filter((p) => p.glyphId.startsWith('net:')).map((p) => p.glyphId.slice(4))
        const nets = new Set(board.nets.map((n) => (n.name.split('/').pop() ?? '').replace(/[{}~]/g, '')))
        for (const w of words) {
          expect(w, 'ground').not.toMatch(/^(?:[ADPSC]|SIG|CHASSIS|SYS)?[_-]?GND|GND[A-Z0-9]?$|^GROUND|^VSS|^EARTH|^0V$/i)
          expect(nets.has(w), `${w} is a net of the board`).toBe(true)
        }
      })
    }
  }
})
