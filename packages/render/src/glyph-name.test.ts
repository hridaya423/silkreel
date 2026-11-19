import './test-recorder.js'
import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, DEMO_CAST_HINTS, compileTimeline } from '@silk-reel/choreo'
import type { Aspect, GlyphEnding, GlyphTimeline } from '@silk-reel/choreo'
import { boardModel } from '../../choreo/test/helpers.js'
import { buildScene } from './film.js'
import { drawGlyphFrame } from './glyph-draw.js'
import { glyphDepth, glyphPose } from './glyph-cam.js'
import { asCtx, currentRecorder } from './test-recorder.js'

const BOARDS = [
  ['glasgow.kicad_pcb', 'glasgow', 'Glasgow'],
  ['icebreaker.kicad_pcb', 'icebreaker', 'iCEBreaker'],
  ['kit-dev-coldfire-xilinx_5213.kicad_pcb', 'kit-dev-coldfire-xilinx_5213', 'ColdFire Xilinx Dev Kit']
] as const
const ASPECTS: Aspect[] = ['16:9', '4:5', '9:16', '1:1']
const MARGIN = 0.06
const STAND = 45

const films = new Map<string, GlyphTimeline>()
function film(file: string, hints: string, name: string, aspect: Aspect, ending?: GlyphEnding): GlyphTimeline {
  const key = `${file} ${aspect} ${ending ?? 'default'}`
  const known = films.get(key)
  if (known !== undefined) return known
  const cast = DEMO_CAST_HINTS[hints]
  const tl = compileTimeline(boardModel(file), { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name }, ...(ending === undefined ? {} : { ending }), ...(cast === undefined ? {} : { cast }) })
  if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
  films.set(key, tl)
  return tl
}

type M = [number, number, number, number, number, number]
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

interface Drawn { placement: number; alpha: number; lines: Array<Array<[number, number]>> }

function record(tl: GlyphTimeline, frame: number, keep: (index: number) => boolean): Drawn[] {
  const rec = currentRecorder()
  const scene = buildScene(tl)
  const { view, driftX, driftY, roll } = glyphPose(tl, frame)
  const out: Drawn[] = []
  for (const z of [-1, 0, 0.4, 1]) {
    rec.reset()
    const ctx = asCtx(rec)
    const s = view.scale * (1 + 0.09 * z)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.translate(tl.width / 2 + driftX * (1 + 0.9 * z), tl.height / 2 + driftY * (1 + 0.9 * z))
    ctx.rotate(roll)
    ctx.scale(s, s)
    ctx.translate(-tl.width / 2 - view.dx, -tl.height / 2 - view.dy)
    drawGlyphFrame(ctx, { ...tl, title: undefined }, scene, frame, { alpha: (i) => {
      const p = tl.placements[i] as GlyphTimeline['placements'][number]
      if (glyphDepth(p) !== z || !keep(i)) return 0
      rec.calls.push({ method: 'placement', args: [i] })
      return 1
    } })
    let m: M = [1, 0, 0, 1, 0, 0]
    const stack: M[] = []
    let alpha = 1
    let placement = -1
    for (const c of rec.calls) {
      const a = c.args as number[]
      if (c.method === 'setTransform') m = [a[0], a[1], a[2], a[3], a[4], a[5]] as M
      else if (c.method === 'translate') m = mul(m, [1, 0, 0, 1, a[0] as number, a[1] as number])
      else if (c.method === 'rotate') m = mul(m, [Math.cos(a[0] as number), Math.sin(a[0] as number), -Math.sin(a[0] as number), Math.cos(a[0] as number), 0, 0])
      else if (c.method === 'scale') m = mul(m, [a[0] as number, 0, 0, a[1] as number, 0, 0])
      else if (c.method === 'placement') placement = c.args[0] as number
      else if (c.method === 'save') stack.push(m)
      else if (c.method === 'restore') m = stack.pop() ?? m
      else if (c.method === 'set:globalAlpha') alpha = c.args[0] as number
      else if (c.method === 'stroke' || c.method === 'fill') {
        const path = c.args[0] as { ops: Array<{ op: string; args: number[] }> } | undefined
        const lines: Array<Array<[number, number]>> = []
        for (const op of path?.ops ?? []) {
          if (op.op === 'moveTo') lines.push([apply(m, op.args[0] as number, op.args[1] as number)])
          else if (op.op === 'lineTo') lines[lines.length - 1]?.push(apply(m, op.args[0] as number, op.args[1] as number))
          else if (op.op === 'arc') lines.push([apply(m, (op.args[0] as number) - (op.args[2] as number), op.args[1] as number), apply(m, (op.args[0] as number) + (op.args[2] as number), op.args[1] as number)])
        }
        out.push({ placement, alpha, lines })
      }
    }
  }
  return out
}

const formation = (tl: GlyphTimeline, id: string): number | undefined => tl.formations.find((f) => f.id === id)?.beat
const ofName = (tl: GlyphTimeline): (i: number) => boolean => {
  const beat = formation(tl, 'name')
  return (i) => tl.placements[i]?.formation === beat
}
const exitOf = (tl: GlyphTimeline): number => Math.min(...tl.placements.filter((p) => p.stage !== undefined && p.role !== 'hero').map((p) => Math.round((p.outStep * tl.fps) / 15)))

function whole(tl: GlyphTimeline, keep: (i: number) => boolean, from: number, to: number, ref: number): number[] {
  const held = record(tl, ref, keep).map((d) => d.alpha)
  const frames: number[] = []
  for (let f = from; f < to; f++) {
    const now = record(tl, f, keep).map((d) => d.alpha)
    if (now.length === held.length && now.every((a, k) => a >= (held[k] as number) - 1e-6)) frames.push(f)
  }
  return frames
}

const cross = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean => {
  const o = (p: [number, number], q: [number, number], r: [number, number]): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = o(c, d, a)
  const d2 = o(c, d, b)
  const d3 = o(a, b, c)
  const d4 = o(a, b, d)
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6))
}

describe('the name ending', () => {
  it('has two versions, parts by default and routes on request', () => {
    const plain = film('glasgow.kicad_pcb', 'glasgow', 'Glasgow', '4:5')
    const parts = film('glasgow.kicad_pcb', 'glasgow', 'Glasgow', '4:5', 'parts')
    const routes = film('glasgow.kicad_pcb', 'glasgow', 'Glasgow', '4:5', 'routes')
    expect(JSON.stringify(plain)).toBe(JSON.stringify(parts))
    const named = (tl: GlyphTimeline): string[] => tl.placements.filter((_, i) => ofName(tl)(i)).map((p) => p.glyphId)
    expect(named(parts).every((g) => g.startsWith('cell:'))).toBe(true)
    expect(named(routes).some((g) => g.startsWith('name:trace:'))).toBe(true)
    expect(named(routes).some((g) => g.startsWith('name:letter:'))).toBe(true)
  })

  for (const ending of ['parts', 'routes'] as const) {
    for (const [file, hints, name] of BOARDS) {
      for (const aspect of ['4:5', '16:9'] as Aspect[]) {
        it(`${ending}, ${hints} ${aspect}: the field is drawn whole at least ${STAND} frames before it leaves, and the name at least ${STAND} frames to the last frame`, { timeout: 60000 }, () => {
          const tl = film(file, hints, name, aspect, ending)
          const exit = exitOf(tl)
          const field = formation(tl, 'field')
          const fieldWhole = whole(tl, (i) => tl.placements[i]?.formation === field, exit - STAND - 4, exit, exit - 1)
          expect(fieldWhole.length, `${ending}: frames the field stands whole before ${exit}`).toBeGreaterThanOrEqual(STAND)
          const nameWhole = whole(tl, ofName(tl), tl.totalFrames - STAND - 6, tl.totalFrames, tl.totalFrames - 1)
          expect(nameWhole.length, `${ending}: frames the name stands whole`).toBeGreaterThanOrEqual(STAND)
          expect(nameWhole[nameWhole.length - 1]).toBe(tl.totalFrames - 1)
        })
      }
    }
  }

  for (const [file, hints, name] of BOARDS) {
    for (const aspect of ['4:5', '9:16'] as Aspect[]) {
      it(`${hints} ${aspect}: the two versions draw the same frames until the field leaves`, { timeout: 60000 }, () => {
        const a = film(file, hints, name, aspect, 'parts')
        const b = film(file, hints, name, aspect, 'routes')
        const exit = exitOf(a)
        expect(exitOf(b)).toBe(exit)
        const seen = (tl: GlyphTimeline, f: number): string => JSON.stringify(record(tl, f, () => true).map((d) => ({ glyph: tl.placements[d.placement]?.glyphId, alpha: d.alpha, lines: d.lines })))
        for (let f = 0; f < exit; f += 3) expect(seen(b, f), `frame ${f}`).toBe(seen(a, f))
      })
    }
  }

  for (const [file, hints, name] of BOARDS) {
    for (const aspect of ASPECTS) {
      it(`routes, ${hints} ${aspect}: no trace crosses a letter or another trace`, () => {
        const tl = film(file, hints, name, aspect, 'routes')
        const drawn = record(tl, tl.totalFrames - 1, ofName(tl)).filter((d) => (tl.placements[d.placement] ?? { glyphId: '' }).glyphId.startsWith('name:'))
        const segs = drawn.flatMap((d, k) => d.lines.flatMap((l) => l.slice(1).map((q, i) => ({ k, a: l[i] as [number, number], b: q }))))
        let crossings = 0
        for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
          const s = segs[i] as (typeof segs)[number]
          const t = segs[j] as (typeof segs)[number]
          if (s.k !== t.k && cross(s.a, s.b, t.a, t.b)) crossings++
        }
        expect(crossings).toBe(0)
      })

      it(`routes, ${hints} ${aspect}: the chip's traces reach every line of the name`, () => {
        const tl = film(file, hints, name, aspect, 'routes')
        const drawn = record(tl, tl.totalFrames - 1, ofName(tl)).map((d) => ({ ...d, id: (tl.placements[d.placement] ?? { glyphId: '' }).glyphId }))
        const letters = drawn.filter((d) => d.id.startsWith('name:letter:'))
        const traces = drawn.filter((d) => d.id.startsWith('name:trace:'))
        const onSeg = (p: [number, number], a: [number, number], b: [number, number]): boolean => {
          const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2))
          return Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])) < 0.5
        }
        const touches = (p: [number, number], d: (typeof drawn)[number]): boolean => d.lines.some((l) => l.slice(1).some((q, k) => onSeg(p, l[k] as [number, number], q)))
        const ends = (d: (typeof drawn)[number]): Array<[number, number]> => d.lines.flatMap((l) => [l[0] as [number, number], l[l.length - 1] as [number, number]])
        const reached = new Set<string>()
        let grew = true
        while (grew) {
          grew = false
          for (const t of traces) {
            const hit = letters.filter((l) => ends(t).some((p) => touches(p, l)))
            const fromChip = ends(t).some((p) => !letters.some((l) => touches(p, l)))
            if (!fromChip && !hit.some((l) => reached.has(l.id))) continue
            for (const l of hit) if (!reached.has(l.id)) {
              reached.add(l.id)
              grew = true
            }
          }
        }
        const line = (d: (typeof drawn)[number]): number => Math.round(Math.min(...d.lines.flat().map(([, y]) => y)))
        const lines = [...new Set(letters.map(line))]
        const fed = new Set(letters.filter((l) => reached.has(l.id)).map(line))
        expect(lines.length).toBeGreaterThan(0)
        expect(lines.filter((y) => !fed.has(y)), 'lines no trace reaches').toEqual([])
      })

      for (const ending of ['parts', 'routes'] as const) {
        it(`${ending}, ${hints} ${aspect}: the name stands inside the film's margin on its last frame and fills at least 80% of the frame's width or height`, () => {
          const tl = film(file, hints, name, aspect, ending)
          const pts = record(tl, tl.totalFrames - 1, ofName(tl)).flatMap((d) => d.lines.flat())
          const xs = pts.map(([x]) => x)
          const ys = pts.map(([, y]) => y)
          expect(pts.length).toBeGreaterThan(0)
          expect(Math.min(...xs)).toBeGreaterThanOrEqual(MARGIN * tl.width)
          expect(Math.max(...xs)).toBeLessThanOrEqual((1 - MARGIN) * tl.width)
          expect(Math.min(...ys)).toBeGreaterThanOrEqual(MARGIN * tl.height)
          expect(Math.max(...ys)).toBeLessThanOrEqual((1 - MARGIN) * tl.height)
          const fill = Math.max((Math.max(...xs) - Math.min(...xs)) / tl.width, (Math.max(...ys) - Math.min(...ys)) / tl.height)
          expect(fill).toBeGreaterThanOrEqual(0.8)
        })
      }
    }
  }
})
