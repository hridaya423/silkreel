import './test-recorder.js'
import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, compileTimeline, nameStrip, plotClock, plotFrame } from '@silk-reel/choreo'
import type { FilmConfig, PlotScore, TracePart, TraceTimeline } from '@silk-reel/choreo'
import { axoPoint, chipCover, CHIP_HIDE, inkClock, lightEnd, RIDE_PACE, SIGNAL_HEAVY, sampleShot, CAP, cleanLeaders, hullBox, READ_CAP, rectHits, SECTION_TITLE } from '@silk-reel/choreo'
import type { PlotAxo } from '@silk-reel/choreo'
import { drawPlotFrame, flatView, heroFrame, revealed, sheetInk, signalInk, stackBox } from './plot-draw.js'
import { axoAff } from './plot-object.js'
import { apply, geo, invert } from './plot-plan.js'
import { asCtx, currentRecorder } from './test-recorder.js'
import { boardModel } from '../../choreo/test/helpers.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseKicadPcb } from '../../ingest/src/index.js'
import { parseCliArgs } from '../../cli/src/args.js'

function plotTimeline(boardName: string, extra: Partial<FilmConfig> = {}): TraceTimeline {
  const config: FilmConfig = { style: 'plot', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, ...extra }
  const tl = compileTimeline(boardModel(boardName), config)
  if (tl.style !== 'plot') throw new Error('expected a plot timeline')
  return tl
}

const lidWords = (value: string): string[] => ((core) => [core, core.split('_').at(-1) ?? core])(value.split(/[-\s/]/)[0] ?? '')

const onBoard = (plot: PlotScore): Set<string> => {
  return new Set([plot.hero.label, ...(plot.section === undefined ? [] : ['A', SECTION_TITLE, ...plot.section.layers.map((l) => l.name)]), ...plot.bodies.filter((b) => b.lone).flatMap((b) => lidWords(b.value))].filter((t) => t.length > 0))
}

type Xy = [number, number]
const inPoly = (q: Xy, poly: Xy[]): boolean => poly.reduce((v, a, k) => {
  const b = poly[(k + 1) % poly.length] as Xy
  return (a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]) ? !v : v
}, false)
const polyArea = (poly: Xy[]): number => Math.abs(poly.reduce((t, a, k) => { const b = poly[(k + 1) % poly.length] as Xy; return t + a[0] * b[1] - b[0] * a[1] }, 0)) / 2

const lidCovered = (tl: TraceTimeline, hp: TracePart, f: number): number => {
  const view = heroFrame(tl, f).view
  const co = Math.cos(hp.rot)
  const si = Math.sin(hp.rot)
  const at = (lx: number, ly: number, z = hp.z): Xy => axoPoint(view, [hp.x + lx * co - ly * si, hp.y + lx * si + ly * co], z)
  const rec = currentRecorder()
  rec.reset()
  drawPlotFrame(asCtx(rec), tl, f)
  const stock = tl.palette.bg.toLowerCase()
  let m = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  let fill = ''
  let path: Xy[] = []
  const polys: Xy[][] = []
  for (const c of rec.calls) {
    if (c.method === 'setTransform') m = c.args.map(Number)
    else if (c.method === 'save') stack.push(m)
    else if (c.method === 'restore') m = stack.pop() ?? m
    else if (c.method === 'set:fillStyle') fill = String(c.args[0]).toLowerCase()
    else if (c.method === 'beginPath') path = []
    else if (c.method === 'moveTo' || c.method === 'lineTo') {
      const [x, y] = c.args.map(Number) as Xy
      path.push([(m[0] as number) * x + (m[2] as number) * y + (m[4] as number), (m[1] as number) * x + (m[3] as number) * y + (m[5] as number)])
    } else if (c.method === 'fill' && c.args.length === 0 && fill === stock && path.length >= 3) polys.push(path)
  }
  const grid = Array.from({ length: 64 }, (_, k) => at(((k % 8) + 0.5) / 8 * hp.w - hp.w / 2, (Math.floor(k / 8) + 0.5) / 8 * hp.h - hp.h / 2))
  const own = polys.reduce((best, poly, k) => (grid.filter((q) => inPoly(q, poly)).length >= 58 && (best < 0 || polyArea(poly) < polyArea(polys[best] as Xy[])) ? k : best), -1)
  if (own < 0) return 0
  const ownPoly = polys[own] as Xy[]
  const lid = [at(-hp.w / 2, -hp.h / 2), at(hp.w / 2, -hp.h / 2), at(hp.w / 2, hp.h / 2), at(-hp.w / 2, hp.h / 2)]
  const span = (pts: Xy[], i: 0 | 1): [number, number] => [Math.min(...pts.map((q) => q[i])), Math.max(...pts.map((q) => q[i]))]
  const prism = [...lid, at(-hp.w / 2, -hp.h / 2, 0), at(hp.w / 2, -hp.h / 2, 0), at(hp.w / 2, hp.h / 2, 0), at(-hp.w / 2, hp.h / 2, 0)]
  const [lx, ly] = [span(lid, 0), span(lid, 1)]
  const chipOwn = polyArea(ownPoly) <= 3 * (lx[1] - lx[0]) * (ly[1] - ly[0])
  const shift = (i: 0 | 1): number => (chipOwn ? (span(ownPoly, i)[0] + span(ownPoly, i)[1] - span(prism, i)[0] - span(prism, i)[1]) / 2 : 0)
  const [dx, dy] = [shift(0), shift(1)]
  const front = polys.slice(own + 1)
  const n = 40
  let hit = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const q = at(((i + 0.5) / n - 0.5) * hp.w, ((j + 0.5) / n - 0.5) * hp.h)
      if (front.some((poly) => inPoly([q[0] + dx, q[1] + dy], poly))) hit++
    }
  }
  return hit / (n * n)
}

/** a film as scripts/render-strobe.sh compiles it: the CLI's own config, with the title each film is rendered under */
const filmTimeline = (board: string, aspect: string): TraceTimeline => {
  const input = path.resolve(import.meta.dirname, '../../../fixtures/boards', `${board}.kicad_pcb`)
  const titled: Record<string, string[]> = { glasgow: ['--title', 'Glasgow'], icebreaker: ['--title', 'iCEBreaker', '--version', 'v1.0e'], 'kit-dev-coldfire-xilinx_5213': ['--title', 'ColdFire Xilinx Dev Kit'] }
  const { config } = parseCliArgs([input, ...(titled[board] ?? []), '--style', 'plot', '--aspect', aspect, '-o', 'film.mp4'])
  const tl = compileTimeline(parseKicadPcb(readFileSync(input, 'utf8'), path.basename(input)), config)
  if (tl.style !== 'plot') throw new Error('expected a plot timeline')
  return tl
}

/** the line a frame draws in any colour but the paper's, inside the frame above the name strip, px per 1000 px²: strokes of paths and of Path2D alike */
const drawnLine = (tl: TraceTimeline, f: number): number => {
  const rec = currentRecorder()
  rec.reset()
  drawPlotFrame(asCtx(rec), tl, f)
  const stock = tl.palette.bg.toLowerCase()
  const floor = nameStrip(tl.width, tl.height).y
  let m = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  let ink = ''
  let path: Array<[string, number, number]> = []
  let total = 0
  const add = (ops: Array<[string, number, number]>): void => {
    let last: Xy | undefined
    for (const [op, x, y] of ops) {
      const q: Xy = [(m[0] as number) * x + (m[2] as number) * y + (m[4] as number), (m[1] as number) * x + (m[3] as number) * y + (m[5] as number)]
      const mid: Xy | undefined = last === undefined ? undefined : [(last[0] + q[0]) / 2, (last[1] + q[1]) / 2]
      if (op === 'lineTo' && last !== undefined && mid !== undefined && mid[0] > 0 && mid[0] < tl.width && mid[1] > 0 && mid[1] < floor) total += Math.hypot(q[0] - last[0], q[1] - last[1])
      last = q
    }
  }
  for (const c of rec.calls) {
    if (c.method === 'setTransform') m = c.args.map(Number)
    else if (c.method === 'save') stack.push(m)
    else if (c.method === 'restore') m = stack.pop() ?? m
    else if (c.method === 'set:strokeStyle') ink = String(c.args[0]).toLowerCase()
    else if (c.method === 'beginPath') path = []
    else if (c.method === 'moveTo' || c.method === 'lineTo') path.push([c.method, Number(c.args[0]), Number(c.args[1])])
    else if (c.method === 'stroke' && ink !== stock) {
      const p2 = typeof c.args[0] === 'object' && c.args[0] !== null ? (c.args[0] as { ops: Array<{ op: string; args: number[] }> }) : undefined
      add(p2 !== undefined ? p2.ops.map((o): [string, number, number] => [o.op, o.args[o.args.length - 2] as number, o.args[o.args.length - 1] as number]) : path)
    }
  }
  return (1000 * total) / (tl.width * floor)
}

const atBeat = (tl: TraceTimeline, beat: number): number => Math.round(plotFrame(beat / 24, tl.totalFrames))

const draw = (tl: TraceTimeline, frame: number): { drawn: number; accent: number; fills: number } => {
  const rec = currentRecorder()
  rec.reset()
  const drawn = drawPlotFrame(asCtx(rec), tl, frame)
  const accent = rec.calls.filter((c) => (c.method === 'set:strokeStyle' || c.method === 'set:fillStyle') && (c.args[0] === tl.palette.head || c.args[0] === signalInk(tl.palette))).length
  return { drawn, accent, fills: rec.calls.filter((c) => c.method === 'fillRect').length }
}

const texts = (tl: TraceTimeline, frame: number): string[] => {
  const rec = currentRecorder()
  rec.reset()
  drawPlotFrame(asCtx(rec), tl, frame)
  return rec.calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]))
}

interface Box { x: number; y: number; w: number; h: number; text: string; size: number; cut?: boolean }

type Calls = ReturnType<typeof currentRecorder>['calls']

const record = (tl: TraceTimeline, frame: number): Calls => {
  const rec = currentRecorder()
  rec.reset()
  drawPlotFrame(asCtx(rec), tl, frame)
  return [...rec.calls]
}

const textBoxes = (tl: TraceTimeline, frame: number): Box[] => boxesOf(record(tl, frame))

/** the clips that only break one stroke at the lettering's bands: a save, clips, the stroke, a restore */
const bandClips = (calls: Calls): Set<number> => {
  const out = new Set<number>()
  calls.forEach((c, i) => {
    if (c.method !== 'save') return
    let k = i + 1
    while (calls[k]?.method === 'clip' && calls[k]?.args[1] === 'evenodd') k += 1
    if (k > i + 1 && (calls[k]?.method === 'stroke' || calls[k]?.method === 'strokeRect') && calls[k + 1]?.method === 'restore') for (let j = i + 1; j < k; j++) out.add(j)
  })
  return out
}

const boxesOf = (calls: Calls): Box[] => {
  const rec = { calls }
  let m = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  let size = 10
  let align = 'left'
  let spacing = 0
  let baseline = 'alphabetic'
  const out: Box[] = []
  type Rect = { x0: number; y0: number; x1: number; y1: number }
  let clips: Rect[] = []
  const clipStack: Rect[][] = []
  let pending: Rect | undefined
  for (const c of rec.calls) {
    if (c.method === 'setTransform') m = c.args.map(Number)
    else if (c.method === 'save') {
      stack.push(m)
      clipStack.push(clips)
    } else if (c.method === 'restore') {
      m = stack.pop() ?? m
      clips = clipStack.pop() ?? clips
    } else if (c.method === 'beginPath') pending = undefined
    else if (c.method === 'rect') {
      const [x, y, w, h] = c.args.map(Number) as [number, number, number, number]
      const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([a, b]) => [(m[0] as number) * (a as number) + (m[2] as number) * (b as number) + (m[4] as number), (m[1] as number) * (a as number) + (m[3] as number) * (b as number) + (m[5] as number)])
      pending = { x0: Math.min(...pts.map((q) => q[0] as number)), y0: Math.min(...pts.map((q) => q[1] as number)), x1: Math.max(...pts.map((q) => q[0] as number)), y1: Math.max(...pts.map((q) => q[1] as number)) }
    } else if (c.method === 'clip' && c.args.length === 0 && pending !== undefined) clips = [...clips, pending]
    else if (c.method === 'translate') {
      const [tx, ty] = c.args.map(Number) as [number, number]
      m = [m[0] as number, m[1] as number, m[2] as number, m[3] as number, (m[0] as number) * tx + (m[2] as number) * ty + (m[4] as number), (m[1] as number) * tx + (m[3] as number) * ty + (m[5] as number)]
    } else if (c.method === 'rotate') {
      const a = Number(c.args[0])
      const [co, si] = [Math.cos(a), Math.sin(a)]
      m = [(m[0] as number) * co + (m[2] as number) * si, (m[1] as number) * co + (m[3] as number) * si, (m[2] as number) * co - (m[0] as number) * si, (m[3] as number) * co - (m[1] as number) * si, m[4] as number, m[5] as number]
    } else if (c.method === 'set:font') size = Number(/([\d.]+)px/.exec(String(c.args[0]))?.[1] ?? 10)
    else if (c.method === 'set:textAlign') align = String(c.args[0])
    else if (c.method === 'set:letterSpacing') spacing = parseFloat(String(c.args[0]))
    else if (c.method === 'set:textBaseline') baseline = String(c.args[0])
    else if (c.method === 'fillText') {
      const text = String(c.args[0])
      const k = Math.sqrt(Math.abs((m[0] as number) * (m[3] as number) - (m[1] as number) * (m[2] as number)))
      const w = text.length * (0.66 * size + spacing)
      const start = align === 'center' ? -w / 2 : align === 'right' ? -w : 0
      const capH = 0.73 * size
      const drop = baseline === 'middle' ? capH / 2 : baseline === 'top' ? capH : 0
      const x = Number(c.args[1])
      const y = Number(c.args[2])
      const corners = [[start, drop], [start + w, drop], [start, drop - capH], [start + w, drop - capH]].map(([a, b]) => [(m[0] as number) * (x + (a as number)) + (m[2] as number) * (y + (b as number)) + (m[4] as number), (m[1] as number) * (x + (a as number)) + (m[3] as number) * (y + (b as number)) + (m[5] as number)])
      const xs = corners.map((q) => q[0] as number)
      const ys = corners.map((q) => q[1] as number)
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), text, size: size * k }
      const cut = clips.some((r) => box.x < r.x1 && box.x + box.w > r.x0 && box.y < r.y1 && box.y + box.h > r.y0 && !(box.x >= r.x0 - 1 && box.x + box.w <= r.x1 + 1 && box.y >= r.y0 - 1 && box.y + box.h <= r.y1 + 1))
      out.push({ ...box, cut })
    }
  }
  return out
}

const silhouetteOf = (view: PlotAxo, hull: number[]): Array<[number, number]> => {
  const pts = Array.from({ length: hull.length / 3 }, (_, i) => axoPoint(view, [hull[3 * i] as number, hull[3 * i + 1] as number], hull[3 * i + 2] as number)).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: Array<[number, number]>): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2] as [number, number], out[out.length - 1] as [number, number], q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(pts), ...half([...pts].reverse())]
}

const hits = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const BOARDS = ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'StickHub.kicad_pcb', 'ecc83-pp.kicad_pcb', 'video.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']

describe('drawPlotFrame', () => {
  it('draws something in every shot of the score', () => {
    const tl = plotTimeline('glasgow.kicad_pcb')
    for (const beat of [1, 4.5, 7.5, 8.5, 10.5, 14, 18, 20.5, 23.9]) expect(draw(tl, atBeat(tl, beat)).drawn, `beat ${beat}`).toBeGreaterThan(0)
  }, 60000)

  it('keeps a long board upright in a portrait frame through the tilt and lift, its exploded stack over 60% of the height', () => {
    for (const name of ['StickHub.kicad_pcb', 'video.kicad_pcb']) {
      for (const aspect of ['4:5', '9:16'] as const) {
        const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot
        if (plot === undefined) throw new Error('no plot')
        for (let beat = 9; beat <= 17; beat += 0.5) {
          const box = hullBox(heroFrame(tl, atBeat(tl, beat)).view, plot.object.hull)
          expect(box.h, `${name} ${aspect} beat ${beat} upright`).toBeGreaterThanOrEqual(box.w)
        }
        const span = Math.max(...[10, 10.5, 11].map((b) => stackBox(tl, atBeat(tl, b)).h)) / tl.height
        expect(span, `${name} ${aspect} stack span`).toBeGreaterThanOrEqual(0.6)
      }
    }
  }, 120000)

  it('lets no two sheet texts touch, panel titles included (the drawing\'s own lettering lies on the board and is checked by the persistence tests)', () => {
    const bad: string[] = []
    for (const name of BOARDS) {
      for (const aspect of ['4:5', '1:1', '9:16', '16:9'] as const) {
        const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot
        if (plot === undefined) throw new Error('no plot')
        const boxes = textBoxes(tl, tl.totalFrames - 1)
        const drawing = onBoard(plot)
        boxes.forEach((a, i) => {
          for (const b of boxes.slice(i + 1)) if (hits(a, b) && !(drawing.has(a.text) && drawing.has(b.text))) bad.push(`${name} ${aspect}: "${a.text}" on "${b.text}"`)
        })
      }
    }
    expect(bad).toEqual([])
  }, 240000)

  it('lets no two labels touch on any frame of the pull-back, apart from the drawing\'s own lettering', () => {
    const bad: string[] = []
    for (const name of BOARDS) {
      for (const aspect of ['4:5', '1:1', '9:16', '16:9'] as const) {
        const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const drawing = tl.scene.plot === undefined ? new Set<string>() : onBoard(tl.scene.plot)
        for (let f = atBeat(tl, 17); f <= atBeat(tl, 18); f++) {
          const boxes = textBoxes(tl, f)
          boxes.forEach((a, i) => {
            for (const b of boxes.slice(i + 1)) if (hits(a, b) && !(drawing.has(a.text) && drawing.has(b.text))) bad.push(`${name} ${aspect} frame ${f}: "${a.text}" on "${b.text}"`)
          })
        }
      }
    }
    expect(bad).toEqual([])
  }, 240000)

  it('puts every leader dot on a visible point of its own part, clear of the other labelled parts, in the film', () => {
    type P = [number, number]
    const bad: string[] = []
    const hull = (pts: P[]): P[] => {
      const ps = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
      const cross = (o: P, a: P, b: P): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
      const half = (list: P[]): P[] => {
        const out: P[] = []
        for (const q of list) {
          while (out.length >= 2 && cross(out[out.length - 2] as P, out[out.length - 1] as P, q) <= 0) out.pop()
          out.push(q)
        }
        out.pop()
        return out
      }
      return [...half(ps), ...half([...ps].reverse())]
    }
    const inPoly = (q: P, poly: P[]): boolean => poly.length >= 3 && poly.every((a, i) => {
      const b = poly[(i + 1) % poly.length] as P
      return (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) >= -1e-9
    })
    const side = (p: P, q: P, r: P): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    const hits = (a: P, b: P, poly: P[]): boolean => inPoly(a, poly) || inPoly(b, poly) || poly.some((p, i) => {
      const q = poly[(i + 1) % poly.length] as P
      return side(a, b, p) * side(a, b, q) < 0 && side(p, q, a) * side(p, q, b) < 0
    })
    for (const name of BOARDS) {
      for (const aspect of ['4:5', '1:1', '9:16', '16:9'] as const) {
        const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot
        if (plot === undefined) throw new Error('no plot')
        const parts = tl.scene.parts.filter((q) => q.kind !== 'pin')
        const inside = (b: (typeof parts)[number], x: number, y: number): boolean => {
          const c = Math.cos(-b.rot)
          const sn = Math.sin(-b.rot)
          return Math.abs(c * (x - b.x) - sn * (y - b.y)) <= b.w / 2 + 1e-6 && Math.abs(sn * (x - b.x) + c * (y - b.y)) <= b.h / 2 + 1e-6
        }
        const ownOf = (f: { x: number; y: number; z?: number | undefined }): number => parts.findIndex((b) => inside(b, f.x, f.y) && Math.abs(b.z - (f.z ?? 0)) < 1e-6)
        const shots = [{ tag: 'film', frame: atBeat(tl, 16.9) }]
        for (const { tag, frame } of shots) {
          const { view, callouts: calls } = heroFrame(tl, frame)
          const feats = calls.map((c) => plot.features.find((f) => f.text === c.text && f.sub === c.sub))
          const owns = feats.map((f) => (f === undefined ? -1 : ownOf(f)))
          const proj = (x: number, y: number, z: number): P => {
            const c = Math.cos(view.psi)
            const sn = Math.sin(view.psi)
            const dx = x - view.mx
            const dy = y - view.my
            return [view.x + view.k * (c * dx - sn * dy), view.y + view.k * (Math.sin(view.e) * (sn * dx + c * dy) - Math.cos(view.e) * z)]
          }
          const sil = (i: number): P[] => {
            const b = parts[i] as (typeof parts)[number]
            const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, d]) => [b.x + ((a as number) * b.w / 2) * Math.cos(b.rot) - ((d as number) * b.h / 2) * Math.sin(b.rot), b.y + ((a as number) * b.w / 2) * Math.sin(b.rot) + ((d as number) * b.h / 2) * Math.cos(b.rot)] as P)
            return hull(cs.flatMap((q) => [proj(q[0], q[1], 0), proj(q[0], q[1], b.z)]))
          }
          calls.forEach((c, i) => {
            const f = feats[i]
            const own = owns[i] as number
            const label = `${name} ${aspect} ${tag} "${c.text}"`
            if (f === undefined) { bad.push(`${label}: not a feature`); return }
            if (c.text.endsWith('LAYERS') && (f.z ?? 0) >= 0) bad.push(`${label}: not on the cut edge`)
            if (own >= 0) {
              const tall = Math.max(...parts.map((b) => b.z))
              const k = Math.cos(view.e) / Math.sin(view.e)
              for (let dz = tall / 64; (f.z ?? 0) + dz <= tall; dz += tall / 32) {
                const x = f.x + Math.sin(view.psi) * k * dz
                const y = f.y + Math.cos(view.psi) * k * dz
                if (parts.some((b, j) => j !== own && (f.z ?? 0) + dz <= b.z && inside(b, x, y))) { bad.push(`${label}: dot hidden`); break }
              }
            }
            const end: P = [Math.min(c.rect.x + c.rect.w, Math.max(c.rect.x, c.at[0])), Math.min(c.rect.y + c.rect.h, Math.max(c.rect.y, c.at[1]))]
            owns.forEach((j, n) => { if (n !== i && j >= 0 && j !== own && hits(c.at, end, sil(j))) bad.push(`${label}: leader crosses "${calls[n]?.text ?? ''}"`) })
          })
        }
      }
    }
    expect(bad).toEqual([])
  }, 240000)


  it('prints no hole schedule in any aspect: the board model keeps a slot\'s length but not its width', () => {
    for (const name of BOARDS) {
      for (const aspect of ['4:5', '1:1', '9:16', '16:9'] as const) {
        const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot
        if (plot === undefined) throw new Error('no plot')
        for (const f of [Math.round(plot.shots.outline[1] * tl.totalFrames) - 1, tl.totalFrames - 1]) expect(texts(tl, f).some((t) => t.includes('SCHEDULE') || t.includes('Ø')), `${name} ${aspect} frame ${f}`).toBe(false)
      }
    }
  }, 240000)

  it('writes every vertical factor one way, as the factor the elevation draws with', () => {
    const bad: string[] = []
    for (const name of BOARDS) {
      for (const aspect of ['4:5', '1:1', '9:16', '16:9'] as const) {
        const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const v = tl.scene.plot?.sheet.elevationAt.v ?? 1
        const notes = texts(tl, tl.totalFrames - 1).filter((t) => t.includes('VERT'))
        if (v !== 1 && !notes.some((t) => t.includes(`VERT. ×${Number(v.toFixed(2))}`))) bad.push(`${name} ${aspect} misses VERT. ×${v}: ${notes.join(' | ')}`)
        if (notes.some((t) => /SCALE|\d:\d/.test(t))) bad.push(`${name} ${aspect} writes a ratio: ${notes.join(' | ')}`)
      }
    }
    expect(bad).toEqual([])
  }, 240000)

  it('keeps every text at least half a cap height inside the frame on every frame, except a lettering of the travel, or one lying on the board, already read whole that the camera has moved past, or the chip\'s name inside its outline on a film that rides a net', () => {
    const bad: string[] = []
    for (const name of BOARDS) {
      for (const aspect of ['4:5', '1:1', '9:16', '16:9'] as const) {
        const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const travel = tl.scene.plot?.film.shots.find((q) => q.kind === 'outline')
        const turned = travel === undefined ? -1 : atBeat(tl, tl.scene.plot?.beats.pull[0] ?? 0)
        const read = new Set<string>()
        const drawing = tl.scene.plot === undefined ? new Set<string>() : onBoard(tl.scene.plot)
        for (let f = 0; f < tl.totalFrames; f += 2) {
          for (const t of textBoxes(tl, f)) {
            const m = 0.5 * CAP * t.size
            if (tl.scene.plot?.signal !== undefined && t.text === tl.scene.plot.hero.label) continue
            const inside = t.cut === true || (t.x >= m && t.y >= m && t.x + t.w <= tl.width - m && t.y + t.h <= tl.height - m)
            if (inside) read.add(t.text)
            else if (!((f < turned || drawing.has(t.text)) && read.has(t.text))) bad.push(`${name} ${aspect} "${t.text}" frame ${f}`)
          }
        }
      }
    }
    expect([...new Set(bad)]).toEqual([])
  }, 900000)

  it('stamps the revision on the sheet on the beat the stamp sounds and not before, and no revision when the board has none', () => {
    const tl = plotTimeline('glasgow.kicad_pcb', { title: { name: 'Glasgow', version: 'revC3' } })
    const land = atBeat(tl, 24 * (tl.scene.plot?.events.find((e) => e.kind === 'stamp')?.t0 ?? 0))
    expect(texts(tl, tl.totalFrames - 1)).toContain('REV C3')
    expect(texts(tl, land)).toContain('REV C3')
    for (const f of [0, land - 30, land - 1]) expect(texts(tl, f).join(' '), `frame ${f}`).not.toContain('REV')
    const bare = plotTimeline('ecc83-pp.kicad_pcb')
    expect(texts(bare, bare.totalFrames - 1)).not.toContain('REV')
  }, 60000)

  it('strikes the stamp clear of the board\'s drawing where a corner of the panel is free: no corner of its lettering lies inside the drawn outline on a long board drawn on the diagonal, nor on two boards whose old corner lay on the board', () => {
    for (const [name, aspect] of [['video.kicad_pcb', '16:9'], ['icebreaker.kicad_pcb', '9:16'], ['StickHub.kicad_pcb', '16:9'], ['glasgow.kicad_pcb', '16:9']] as const) {
      const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name: 'Board', version: 'rev1.A' } })
      const plot = tl.scene.plot
      if (plot === undefined) throw new Error('no plot')
      const mark = textBoxes(tl, tl.totalFrames - 1).find((b) => b.text.startsWith('REV'))
      if (mark === undefined) throw new Error(`${name} ${aspect}: no stamp`)
      const view = heroFrame(tl, tl.totalFrames - 1).view
      const drawn = Array.from({ length: plot.object.hull.length / 3 }, (_, i) => axoPoint(view, [plot.object.hull[3 * i] as number, plot.object.hull[3 * i + 1] as number], plot.object.hull[3 * i + 2] as number))
      const onBoard = (x: number, y: number): boolean => {
        const turns = drawn.map((d) => Math.atan2(d[1] - y, d[0] - x)).sort((p, q) => p - q)
        return turns.every((t, i) => (turns[(i + 1) % turns.length] as number) - t + (i === turns.length - 1 ? 2 * Math.PI : 0) < Math.PI)
      }
      const corners = [[mark.x, mark.y], [mark.x + mark.w, mark.y], [mark.x, mark.y + mark.h], [mark.x + mark.w, mark.y + mark.h], [mark.x + mark.w / 2, mark.y + mark.h / 2]]
      expect(corners.filter(([x, y]) => onBoard(x as number, y as number)).length, `${name} ${aspect}: the stamp's lettering on the board's drawing`).toBe(0)
    }
  }, 120000)

  it('letters the name once, at the end: on no frame before the pull lands, then one glyph after another in the drafting face, each set whole, complete when its sound ends and kept to the last frame', () => {
    const tl = plotTimeline('glasgow.kicad_pcb', { aspect: '16:9', output: { ...ASPECT_SIZE['16:9'], fps: 30 } })
    const plot = tl.scene.plot
    if (plot === undefined) throw new Error('no plot')
    const named = (f: number): Box[] => textBoxes(tl, f).filter((b) => b.text.length > 0 && 'GLASGOW'.startsWith(b.text) && b.size > 0.08 * tl.height)
    const event = plot.events.find((e) => e.kind === 'title')
    if (event === undefined) throw new Error('no title event')
    const [from, to] = [atBeat(tl, event.t0 * 24), atBeat(tl, event.t1 * 24)]
    for (let f = 0; f <= from; f += 6) expect(texts(tl, f).filter((t) => t === 'GLASGOW' || t === 'DRAWING'), `frame ${f}`).toEqual([])
    expect(from).toBeGreaterThanOrEqual(atBeat(tl, plot.beats.pull[1]))
    const counts = Array.from({ length: to - from + 2 }, (_, i) => named(from + i)[0]?.text.length ?? 0)
    counts.slice(1).forEach((c, i) => { expect(c, `frame ${from + i + 1}`).toBeGreaterThanOrEqual(counts[i] as number) })
    expect(new Set(counts).size, 'glyphs arrive one after another').toBeGreaterThanOrEqual(5)
    expect(counts.at(-1)).toBe('GLASGOW'.length)
    const last = named(tl.totalFrames - 1)
    expect(last.map((b) => b.text)).toEqual(['GLASGOW'])
    expect((last[0] as Box).size).toBeCloseTo(plot.sheet.name.size, 3)
    const rec = currentRecorder()
    rec.reset()
    drawPlotFrame(asCtx(rec), tl, tl.totalFrames - 1)
    const at = rec.calls.findIndex((c) => c.method === 'fillText' && c.args[0] === 'GLASGOW')
    expect(String(rec.calls.slice(0, at).reverse().find((c) => c.method === 'set:font')?.args[0])).toContain('SilkDraft')
  }, 120000)

  it('draws on paper when the paper palette is chosen', () => {
    const tl = plotTimeline('icebreaker.kicad_pcb', { palette: 'paper' })
    expect(tl.palette.id).toBe('paper')
    expect(draw(tl, atBeat(tl, (tl.scene.plot?.sheet.at ?? 18) + 0.5)).accent).toBeGreaterThan(1)
  }, 120000)

  it('lays no stock when the film is transparent', () => {
    const tl = plotTimeline('glasgow.kicad_pcb', { transparent: true })
    const rec = currentRecorder()
    rec.reset()
    for (const beat of [1, 7.5, 23]) {
      rec.reset()
      drawPlotFrame(asCtx(rec), tl, atBeat(tl, beat))
      expect(rec.calls.some((c) => c.method === 'clearRect'), `beat ${beat}`).toBe(true)
      expect(rec.calls.some((c, i) => c.method === 'fillRect' && rec.calls.slice(0, i).reverse().find((d) => d.method === 'set:fillStyle')?.args[0] === tl.palette.bg && rec.calls.slice(0, i).reverse().find((d) => d.method === 'set:globalCompositeOperation')?.args[0] !== 'destination-out'), `beat ${beat}`).toBe(false)
    }
  })
})

const SLICE: Array<[string, '4:5' | '1:1' | '9:16' | '16:9']> = [['icebreaker.kicad_pcb', '4:5'], ['glasgow.kicad_pcb', '16:9'], ['StickHub.kicad_pcb', '9:16'], ['ecc83-pp.kicad_pcb', '4:5']]
const sliced = (name: string, aspect: '4:5' | '1:1' | '9:16' | '16:9'): TraceTimeline => plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
const accentTexts = (tl: TraceTimeline, frame: number): string[] => {
  let fill: unknown
  const out: string[] = []
  for (const c of record(tl, frame)) {
    if (c.method === 'set:fillStyle') fill = c.args[0]
    else if (c.method === 'fillText' && (fill === tl.palette.head || fill === signalInk(tl.palette))) out.push(String(c.args[0]))
  }
  return out
}

describe('blueprint round 13: leaders', () => {
  it('drops a callout whose leader runs deep across the object or crosses a leader already kept', () => {
    const board = { x: 100, y: 100, w: 400, h: 300 }
    const keep = cleanLeaders([
      { at: [120, 120], rect: { x: 0, y: 0, w: 80, h: 20 } },
      { at: [300, 250], rect: { x: 600, y: 240, w: 80, h: 20 } },
      { at: [480, 380], rect: { x: 520, y: 420, w: 80, h: 20 } },
      { at: [490, 395], rect: { x: 540, y: 340, w: 40, h: 20 } }
    ], board)
    expect(keep).toEqual([true, false, true, false])
  })
})

describe('the section through the main chip', () => {
  it('leaves the frame only as the camera moves off it and is never drawn after: no panel lettering from the time it has left, wholly out of the frame on every flat frame from then to the turn, and gone by the turn on every aspect, whichever side of the chip it lies on', () => {
    const bad: string[] = []
    for (const [name, aspect] of [['glasgow.kicad_pcb', '16:9'], ['glasgow.kicad_pcb', '9:16'], ['icebreaker.kicad_pcb', '9:16'], ['icebreaker.kicad_pcb', '4:5']] as const) {
      const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
      const plot = tl.scene.plot
      const sc = plot?.section
      if (plot === undefined || sc === undefined) throw new Error(`${name} ${aspect}: no section`)
      const panelText = new Set([SECTION_TITLE, ...sc.layers.map((l) => l.name)])
      const [a0, s0, a1, s1] = sc.panel
      const corners = ([[a0, s0], [a1, s0], [a1, s1], [a0, s1]] as Array<[number, number]>).map(([a, b]): [number, number] => [sc.at[0] + a * sc.dir[0] - b * sc.dir[1], sc.at[1] + a * sc.dir[1] + b * sc.dir[0]])
      const out = (q: number): boolean => {
        const v = flatView(tl.scene, q, tl.width, tl.height)
        const c = corners.map(([x, y]) => apply(v, x, y))
        return c.every((r) => r[0] < 0) || c.every((r) => r[0] > tl.width) || c.every((r) => r[1] < 0) || c.every((r) => r[1] > tl.height)
      }
      if (sc.t.gone > plot.shots.object[0] + 1e-9) bad.push(`${name} ${aspect}: the panel is still in frame at the turn`)
      if (!out(Math.min(sc.t.gone, plot.shots.object[0] - 0.0011))) bad.push(`${name} ${aspect}: the panel is still in frame when it stops being drawn`)
      const f0 = Math.floor(plotFrame(sc.t.whole, tl.totalFrames))
      for (let f = f0; f < tl.totalFrames; f += f < f0 + 90 ? 1 : 5) {
        const p = plotClock(f, tl.totalFrames)
        const lettered = texts(tl, f).some((t) => panelText.has(t))
        if (p < sc.t.gone) {
          if (!lettered) bad.push(`${name} ${aspect} frame ${f}: the panel is lost before it leaves`)
          continue
        }
        if (lettered) bad.push(`${name} ${aspect} frame ${f}: the panel is drawn after it has left`)
        if (p < plot.shots.object[0] && !out(p)) bad.push(`${name} ${aspect} frame ${f}: the panel is in frame after it stopped being drawn`)
      }
    }
    expect(bad.slice(0, 10)).toEqual([])
  }, 900000)
})

describe('the section\'s panel', () => {
  it('keeps every other lettering clear of the panel on every frame the panel is drawn, on the boards where notes once touched it', () => {
    const bad: string[] = []
    for (const [name, aspect] of [['icebreaker.kicad_pcb', '4:5'], ['icebreaker.kicad_pcb', '9:16'], ['glasgow.kicad_pcb', '9:16'], ['kit-dev-coldfire-xilinx_5213.kicad_pcb', '1:1']] as const) {
      const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
      const plot = tl.scene.plot
      const sc = plot?.section
      if (plot === undefined || sc === undefined) throw new Error(`${name} ${aspect}: no section`)
      const own = new Set(['A', SECTION_TITLE, ...sc.layers.map((l) => l.name)])
      const [a0, s0, a1, s1] = sc.panel
      const corners = ([[a0, s0], [a1, s0], [a1, s1], [a0, s1]] as Array<[number, number]>).map(([a, b]): [number, number] => [sc.at[0] + a * sc.dir[0] - b * sc.dir[1], sc.at[1] + a * sc.dir[1] + b * sc.dir[0]])
      for (let f = Math.ceil(plotFrame(sc.t.panel, tl.totalFrames)); f < plotFrame(sc.t.gone, tl.totalFrames); f += 2) {
        const v = flatView(tl.scene, plotClock(f, tl.totalFrames), tl.width, tl.height)
        const c = corners.map(([x, y]) => apply(v, x, y))
        const [x0, x1, y0, y1] = [Math.min(...c.map((q) => q[0])), Math.max(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[1]))]
        for (const t of textBoxes(tl, f)) {
          if (own.has(t.text)) continue
          if (t.x < x1 && t.x + t.w > x0 && t.y < y1 && t.y + t.h > y0) bad.push(`${name} ${aspect} frame ${f}: "${t.text}" on the panel`)
        }
      }
    }
    expect([...new Set(bad)].slice(0, 10)).toEqual([])
  }, 900000)
})

describe('blueprint round 11 hard faults', () => {
  it('letters every text at one of two sizes, the smaller a cap height of at least 2.6% of the frame\'s short side, as it is written and on every frame the camera is still (the travel and the turn scale the paper, and the drawing\'s lettering scales with the board)', () => {
    const bad: string[] = []
    for (const [name, aspect] of SLICE) {
      const tl = sliced(name, aspect)
      const plot = tl.scene.plot
      if (plot === undefined) throw new Error('no plot')
      const travel = plot.film.shots.find((q) => q.kind === 'outline')
      const moving = (f: number): boolean => travel !== undefined && f >= atBeat(tl, travel.t0 * 24) && f < Math.ceil(plot.shots.sheet[0] * tl.totalFrames)
      const sizes = new Set<number>()
      const written = new Set<string>()
      const drawing = onBoard(plot)
      for (let f = 0; f < tl.totalFrames; f += 3) {
        const here = new Set<number>()
        for (const t of textBoxes(tl, f)) {
          if (plot.bodies.some((b) => b.lone && lidWords(b.value).some((w) => w.startsWith(t.text)))) continue
          const first = !written.has(t.text)
          written.add(t.text)
          if ((moving(f) || drawing.has(t.text)) && !first) continue
          here.add(Math.round(t.size))
          if (t.size * CAP < READ_CAP * Math.min(tl.width, tl.height) - 0.01) bad.push(`${name} ${aspect} "${t.text}" cap ${((100 * t.size * CAP) / Math.min(tl.width, tl.height)).toFixed(2)}%`)
        }
        if (here.size > 2) bad.push(`${name} ${aspect} frame ${f} sizes ${[...here].join(',')}`)
        if (f === tl.totalFrames - 1 - ((tl.totalFrames - 1) % 3)) for (const s of here) sizes.add(s)
      }
      if (sizes.size > 2) bad.push(`${name} ${aspect} last frame sizes ${[...sizes].join(',')}`)
    }
    expect([...new Set(bad.map((b) => b.replace(/ frame \d+/, '')))]).toEqual([])
  }, 900000)

  it('prints at most six callouts, no pin counts or part counts outside the film\'s sentence or the drawing\'s own notes, and no sheet size in the border', () => {
    for (const [name, aspect] of SLICE) {
      const tl = sliced(name, aspect)
      const plot = tl.scene.plot
      if (plot === undefined) throw new Error('no plot')
      expect(plot.sheet.callouts.length + plot.tier.length, `${name} ${aspect}`).toBeLessThanOrEqual(6)
      const last = texts(tl, tl.totalFrames - 1)
      const drawing = onBoard(plot)
      expect(last.filter((t) => !drawing.has(t) && !plot.film.sentence.includes(t) && /\d+ PINS$|CAPACITORS|RESISTORS|^SHEET A\d/.test(t)), `${name} ${aspect}`).toEqual([])
    }
  }, 300000)

  it('keeps every label off the board\'s silhouette on the sheet, and every label 1.5% of the width inside the frame from the drop to the end; the drawing\'s own lettering lies on the board', () => {
    const bad: string[] = []
    for (const [name, aspect] of SLICE) {
      const tl = sliced(name, aspect)
      const plot = tl.scene.plot
      if (plot === undefined) throw new Error('no plot')
      for (let f = atBeat(tl, plot.beats.tilt[1] + 0.5); f < tl.totalFrames; f += 4) {
        const sil = f >= atBeat(tl, plot.beats.sheet) ? silhouetteOf(heroFrame(tl, f).view, plot.object.hull.slice(0, 3 * plot.object.hullBoard)) : []
        for (const t of textBoxes(tl, f)) {
          if (t.cut === true) continue
          const lid = onBoard(plot).has(t.text)
          if (!lid && sil.length > 0 && rectHits({ x: t.x, y: t.y, w: t.w, h: t.h }, sil)) bad.push(`${name} ${aspect} "${t.text}" on the board, frame ${f}`)
          const m = 0.015 * tl.width
          if (!lid && (t.x < m || t.y < m || t.x + t.w > tl.width - m || t.y + t.h > tl.height - m)) bad.push(`${name} ${aspect} "${t.text}" in the margin, frame ${f}`)
        }
      }
    }
    expect([...new Set(bad.map((b) => b.replace(/, frame \d+/, '')))]).toEqual([])
  }, 900000)

  it('shows at most three accent labels at a time, or one per header where the film counts each header\'s signals', () => {
    for (const [name, aspect] of SLICE) {
      const tl = sliced(name, aspect)
      const most = Math.max(3, tl.scene.plot?.flow.ends.length ?? 0)
      for (let f = 0; f < tl.totalFrames; f += 5) expect(accentTexts(tl, f).length, `${name} ${aspect} frame ${f}`).toBeLessThanOrEqual(most)
    }
  }, 600000)

  it('letters no name strip: the body of every slice film carries no strip label and not the board\'s name', () => {
    for (const [name, aspect] of SLICE) {
      const tl = sliced(name, aspect)
      const plot = tl.scene.plot
      if (plot === undefined) throw new Error('no plot')
      const body = atBeat(tl, plot.beats.pull[1])
      for (let f = 0; f < body; f += 12) {
        const shown = texts(tl, f)
        for (const word of ['DRAWING', 'SIDE', 'SCALE', ...plot.sheet.name.lines]) expect(shown, `${name} ${aspect} frame ${f}`).not.toContain(word)
      }
      expect(texts(tl, tl.totalFrames - 1), `${name} ${aspect} last frame`).toEqual(expect.arrayContaining(plot.sheet.name.lines))
    }
  }, 600000)

  it('letters a turned-plan note only on a plan turned from the file, and an isometric title only over an isometric view', () => {
    for (const name of BOARDS) {
      for (const aspect of ['4:5', '1:1', '9:16', '16:9'] as const) {
        const tl = sliced(name, aspect)
        const plot = tl.scene.plot
        if (plot === undefined) throw new Error('no plot')
        const last = texts(tl, tl.totalFrames - 1).join(' ')
        const turn = (plot.sheet.planAt.r ?? 0) + (plot.facts.turned ? Math.PI / 2 : 0)
        if (last.includes('TURNED 90')) expect(Math.abs(Math.cos(turn)), `${name} ${aspect} turned note`).toBeLessThan(0.1)
        if (last.includes('ISOMETRIC')) expect(Math.abs(plot.sheet.iso.e - Math.asin(Math.tan(Math.PI / 6))), `${name} ${aspect} isometric title`).toBeLessThan(0.09)
      }
    }
  }, 900000)

  it('letters a two-layer stack by its layers, and opens every stack at least 6% of the frame\'s short side', () => {
    for (const [name, aspect] of [...SLICE, ['video.kicad_pcb', '9:16'] as ['video.kicad_pcb', '9:16']]) {
      const tl = sliced(name, aspect)
      const plot = tl.scene.plot
      if (plot === undefined) throw new Error('no plot')
      if (!plot.film.shots.some((q) => q.kind === 'stack')) continue
      const all = new Set<string>()
      for (let f = atBeat(tl, plot.beats.lift[0]); f < atBeat(tl, plot.beats.parts + 0.5); f += 2) for (const t of texts(tl, f)) all.add(t)
      expect([...all].filter((t) => /PARTS/.test(t)), `${name} ${aspect}`).toEqual([])
      for (const layer of plot.stack) expect([...all].some((t) => t.startsWith(layer.name.split('.')[0] as string)), `${name} ${aspect} ${layer.name}`).toBe(true)
      const v = heroFrame(tl, atBeat(tl, plot.beats.lift[1] + 0.5)).view
      const a = axoPoint(v, [plot.object.x, plot.object.y], 0)
      const b = axoPoint(v, [plot.object.x, plot.object.y], plot.object.gap)
      expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.min(tl.width, tl.height), `${name} ${aspect} gap`).toBeGreaterThanOrEqual(0.06)
    }
  }, 600000)

  it('eases every move of the board out: its last fifth takes at least five frames', () => {
    const bad: string[] = []
    for (const [name, aspect] of SLICE) {
      const tl = sliced(name, aspect)
      const plot = tl.scene.plot
      if (plot === undefined) throw new Error('no plot')
      const probe = (f: number): Array<[number, number]> => {
        const v = heroFrame(tl, f).view
        return [[0, 0], [3, 4], [6, 1]].map((i) => axoPoint(v, [plot.object.hull[3 * (i[0] as number)] as number, plot.object.hull[3 * (i[0] as number) + 1] as number], 0))
      }
      const from = atBeat(tl, 8)
      const d: number[] = []
      let prev = probe(from)
      for (let f = from + 1; f < tl.totalFrames; f++) {
        const cur = probe(f)
        d.push(Math.max(...cur.map((q, i) => Math.hypot(q[0] - (prev[i] as [number, number])[0], q[1] - (prev[i] as [number, number])[1]))))
        prev = cur
      }
      const still = 0.0006 * tl.width
      let i = 0
      while (i < d.length) {
        if ((d[i] as number) <= still) { i++; continue }
        let j = i
        while (j < d.length && (d[j] as number) > still) j++
        const run = d.slice(i, j)
        const total = run.reduce((a, b) => a + b, 0)
        let tail = 0
        let n = 0
        for (let k = run.length - 1; k >= 0 && tail < 0.2 * total; k--) { tail += run[k] as number; n++ }
        if (total > 0.02 * tl.width && n < 5) bad.push(`${name} ${aspect} move ending frame ${from + j}: last fifth in ${n} frames`)
        i = j
      }
    }
    expect(bad).toEqual([])
  }, 600000)
})

describe('the hero lid marking', () => {
  const films: Array<[string, '16:9' | '9:16' | '4:5']> = [['glasgow.kicad_pcb', '16:9'], ['glasgow.kicad_pcb', '9:16'], ['glasgow.kicad_pcb', '4:5'], ['icebreaker.kicad_pcb', '4:5'], ['icebreaker.kicad_pcb', '9:16'], ['StickHub.kicad_pcb', '9:16'], ['kit-dev-coldfire-xilinx_5213.kicad_pcb', '4:5']]
  it.each(films)('%s %s reads along one lid axis, one way, on every frame the lid carries its marking', (name, aspect) => {
    const tl = plotTimeline(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
    const plot = tl.scene.plot
    const hero = tl.scene.parts.find((q) => q.hero === true)
    if (plot === undefined || hero === undefined) throw new Error('expected a hero')
    const body = [...plot.bodies].sort((a, b) => Math.hypot(a.x - hero.x, a.y - hero.y) - Math.hypot(b.x - hero.x, b.y - hero.y))[0]
    const words = new Set([...lidWords(body?.value ?? ''), plot.hero.label])
    const labels = new Set<number>()
    let seen = 0
    const lid = plot.beats.pull[0] / 24
    for (let f = Math.ceil(plot.shots.object[0] * (tl.totalFrames - 1)); f < tl.totalFrames; f++) {
      if (plotClock(f, tl.totalFrames) < lid) continue
      const calls = record(tl, f)
      let m = [1, 0, 0, 1, 0, 0]
      let align: unknown
      let base: unknown
      const view = heroFrame(tl, f).view
      const z = hero.z
      const o = axoPoint(view, [hero.x, hero.y], z)
      const ax = (dx: number, dy: number): number[] => {
        const q = axoPoint(view, [hero.x + dx * Math.cos(hero.rot) - dy * Math.sin(hero.rot), hero.y + dx * Math.sin(hero.rot) + dy * Math.cos(hero.rot)], z)
        const v = [q[0] - o[0], q[1] - o[1]]
        const l = Math.hypot(v[0] as number, v[1] as number) || 1
        return [(v[0] as number) / l, (v[1] as number) / l]
      }
      const axes = [ax(1, 0), ax(-1, 0), ax(0, 1), ax(0, -1)]
      for (const c of calls) {
        if (c.method === 'setTransform') m = c.args as number[]
        if (c.method === 'set:textAlign') align = c.args[0]
        if (c.method === 'set:textBaseline') base = c.args[0]
        if (c.method !== 'fillText' || align !== 'center' || base !== 'middle' || !words.has(String(c.args[0]))) continue
        const l = Math.hypot(m[0] as number, m[1] as number) || 1
        const e = [(m[0] as number) / l, (m[1] as number) / l]
        const k = axes.reduce((b, a, i) => ((a[0] as number) * (e[0] as number) + (a[1] as number) * (e[1] as number) > (axes[b]?.[0] as number) * (e[0] as number) + (axes[b]?.[1] as number) * (e[1] as number) ? i : b), 0)
        labels.add(k)
        seen++
      }
    }
    expect(seen).toBeGreaterThan(0)
    expect([...labels]).toHaveLength(1)
  }, 600000)
})

describe('blueprint fix round 1: one drawing on one sheet', () => {
  const tl = plotTimeline('glasgow.kicad_pcb', { aspect: '16:9', output: { ...ASPECT_SIZE['16:9'], fps: 30 } })
  const plot = tl.scene.plot
  if (plot === undefined) throw new Error('no plot')
  const N = tl.totalFrames
  const ink = sheetInk(tl.palette)
  const signal = signalInk(tl.palette)
  const paper = tl.palette.bg
  const filmEnd = Math.floor(plot.beats.sheet / 24 * N)
  const boardPts = tl.scene.board.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i) => [l[2 * i] as number, l[2 * i + 1] as number] as [number, number]))

  it('keeps every mark it has drawn, counted on what the renderer draws on every frame, through the travel, the turn and the sheet (a camera cut starts a new view): each lettering but the section panel once the camera has left it stays whole or grows and never fades, no layer is faded in or out, and no line of the copper is drawn twice in one frame outside an inset panel', () => {
    const front = new Set<unknown>(geo(tl.scene).front.map((b) => b.path))
    const from = atBeat(tl, plot.shots.outline[0] * 24)
    const seen = new Map<string, { f: number; alpha: number }>()
    const before = new Map<string, Box>()
    const bad: string[] = []
    for (let f = 0; f < N; f++) {
      const calls = record(tl, f)
      let alpha = 1
      let at = '1,0,0,1,0,0'
      const now = new Map<string, number>()
      const through = new Map<unknown, Set<string>>()
      const clips: boolean[] = []
      let inset = false
      for (const c of calls) {
        if (c.method === 'save') clips.push(inset)
        else if (c.method === 'restore') inset = clips.pop() ?? false
        else if (c.method === 'clip') inset = true
        else if (c.method === 'set:globalAlpha') alpha = Number(c.args[0])
        else if (c.method === 'setTransform') at = c.args.map((v) => Number(v).toFixed(3)).join(',')
        else if (c.method === 'fillText') now.set(String(c.args[0]), Math.max(now.get(String(c.args[0])) ?? 0, alpha))
        else if (f >= from && c.method === 'set:filter' && /opacity\((0\.|0\))/.test(String(c.args[0]))) bad.push(`frame ${f}: a layer drawn at ${String(c.args[0])}`)
        else if (f >= from && !inset && c.method === 'stroke' && front.has(c.args[0])) through.set(c.args[0], (through.get(c.args[0]) ?? new Set()).add(at))
      }
      if (f > 0 && tl.scene.shots.some((q) => q.cut === true && q.t > plotClock(f - 1, N) && q.t <= plotClock(f, N))) {
        seen.clear()
        before.clear()
      }
      const left = plot.section !== undefined && plotClock(f, N) >= plot.section.t.gone ? new Set([SECTION_TITLE, ...plot.section.layers.map((l) => l.name)]) : new Set<string>()
      for (const [text, was] of seen) {
        if (left.has(text)) continue
        const keep = [...now].filter(([t]) => t.startsWith(text))
        const last = before.get(text)
        const edged = last !== undefined && (last.x < 0.1 * tl.width || last.y < 0.1 * tl.height || last.x + last.w > 0.9 * tl.width || last.y + last.h > 0.9 * tl.height)
        if (keep.length === 0 && !edged) bad.push(`"${text}" from frame ${was.f} gone at frame ${f}`)
        else if (!edged && Math.max(...keep.map(([, a]) => a)) < was.alpha - 0.02) bad.push(`"${text}" from frame ${was.f} fades at frame ${f}`)
      }
      for (const b of boxesOf(calls)) before.set(b.text, b)
      for (const [text, a] of now) seen.set(text, { f: seen.get(text)?.f ?? f, alpha: Math.max(a, seen.get(text)?.alpha ?? 0) })
      const twice = [...through.values()].filter((v) => v.size > 1).length
      if (twice > 0) bad.push(`frame ${f}: ${twice} copper lines drawn through two views`)
    }
    expect(bad.slice(0, 12)).toEqual([])
  }, 900000)

  it('letters the main chip\'s name on the board and keeps it through the section, the sheet and the last frame', () => {
    for (const f of [186, 200, atBeat(tl, plot.beats.sheet), N - 1]) expect(texts(tl, f), `frame ${f}`).toContain(plot.hero.label)
  }, 300000)

  it('holds the sheet flat until one turn into the drawing, then never turns again', () => {
    const e = Array.from({ length: N }, (_, f) => heroFrame(tl, f).view.e)
    const t0 = Math.floor(plot.beats.tilt[0] / 24 * N)
    for (let f = 0; f < t0; f++) expect(e[f], `frame ${f}`).toBeCloseTo(Math.PI / 2, 9)
    const moving = e.slice(1).map((v, i) => Math.abs(v - (e[i] as number)) > 1e-9)
    const runs = moving.filter((m, i) => m && !moving[i - 1]).length
    expect(runs).toBe(1)
  }, 600000)

  it('never shows the whole board: the travel stays close and the ending crops it', () => {
    const whole = (f: number): boolean => {
      const p = plotClock(f, N)
      const m = p < plot.shots.object[0] ? flatView(tl.scene, p, tl.width, tl.height) : axoAff(heroFrame(tl, f).view, 0)
      return boardPts.every((q) => ((s) => s[0] >= 0 && s[0] <= tl.width && s[1] >= 0 && s[1] <= tl.height)(apply(m, q[0], q[1])))
    }
    expect(Array.from({ length: N }, (_, f) => f).filter(whole)).toEqual([])
  }, 600000)

  it('keeps the signal the brightest and the heaviest line on the sheet once its ink is dry: on the fan-out, through the turn and to the last frame no other stroke is as bright over the paper, or as wide (strokes cut by the ink front\'s clip are not counted; a wide stroke later hollowed with the paper along the same path counts as the outline it leaves)', () => {
    const luma = (hex: string): number => [0.299, 0.587, 0.114].reduce((t, k, i) => t + (k * Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)) / 255, 0)
    const over = (hex: string, alpha: number): number => luma(paper) + alpha * (luma(hex) - luma(paper))
    const dry = atBeat(tl, ((plot.ink?.fan.t ?? 0) + 1 / 24) * 24) + 20
    const bad: string[] = []
    for (const f of [dry, atBeat(tl, plot.beats.tilt[0]), atBeat(tl, (plot.beats.tilt[0] + plot.beats.tilt[1]) / 2), atBeat(tl, plot.beats.tilt[1]), atBeat(tl, plot.beats.pull[0]), atBeat(tl, plot.beats.pull[1]), N - 1]) {
      let state = { style: '', alpha: 1, lw: 1, m: [1, 0, 0, 1, 0, 0], clipped: false }
      const saved: Array<typeof state> = []
      const strokes: Array<{ style: string; alpha: number; w: number; path: unknown }> = []
      const calls = record(tl, f)
      const banding = bandClips(calls)
      for (const [i, c] of calls.entries()) {
        if (c.method === 'save') saved.push({ ...state })
        else if (c.method === 'restore') state = saved.pop() ?? state
        else if (c.method === 'set:strokeStyle') state.style = String(c.args[0])
        else if (c.method === 'set:globalAlpha') state.alpha = Number(c.args[0])
        else if (c.method === 'set:lineWidth') state.lw = Number(c.args[0])
        else if (c.method === 'setTransform') state.m = c.args.map(Number)
        else if (c.method === 'clip' && !banding.has(i)) state.clipped = true
        else if ((c.method === 'stroke' || c.method === 'strokeRect') && !state.clipped) strokes.push({ style: state.style, alpha: state.alpha, path: c.args[0], w: state.lw * Math.sqrt(Math.abs((state.m[0] as number) * (state.m[3] as number) - (state.m[1] as number) * (state.m[2] as number))) })
      }
      strokes.forEach((q, i) => {
        const hollow = q.style === paper || q.path === undefined ? undefined : strokes.slice(i + 1).find((r) => r.style === paper && r.path === q.path && r.w < q.w)
        if (hollow !== undefined) q.w = (q.w - hollow.w) / 2
      })
      const pair = strokes.filter((q) => q.style === signal)
      expect(pair.length, `frame ${f}: the signal is drawn`).toBeGreaterThan(0)
      const bright = Math.max(...pair.map((q) => over(q.style, q.alpha)))
      const heavy = Math.max(...pair.map((q) => q.w))
      for (const q of strokes) {
        if (q.style === signal || q.style === paper || !q.style.startsWith('#')) continue
        if (over(q.style, q.alpha) >= bright - 0.02) bad.push(`frame ${f}: ${q.style} at ${q.alpha.toFixed(2)} is as bright as the signal`)
        if (q.w >= heavy) bad.push(`frame ${f}: ${q.style} ${q.w.toFixed(1)} px is as wide as the signal's ${heavy.toFixed(1)} px`)
      }
    }
    expect([...new Set(bad)].slice(0, 8)).toEqual([])
  }, 600000)

  it('draws the main chip\'s hidden wiring as round dots, a kind no pencil line uses, from the last half beat before the turn to the last frame, never as bright or as wide as the signal', () => {
    const luma = (hex: string): number => [0.299, 0.587, 0.114].reduce((t, k, i) => t + (k * Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)) / 255, 0)
    const over = (hex: string, alpha: number): number => luma(paper) + alpha * (luma(hex) - luma(paper))
    const first = Math.min(...(plot.hidden ?? []).flatMap((h) => h.segs.filter((_, i) => i % 6 === 4)))
    expect(first * 24).toBeCloseTo(plot.beats.tilt[0] - 0.5, 5)
    let from = atBeat(tl, first * 24) + 2
    while (plotClock(from - 1, N) >= first) from--
    const bad: string[] = []
    for (const f of [from - 1, from + 3, atBeat(tl, plot.beats.tilt[0]), atBeat(tl, plot.beats.tilt[1]), N - 1]) {
      let state = { style: '', alpha: 1, lw: 1, cap: 'butt', dash: [] as number[], m: [1, 0, 0, 1, 0, 0] }
      const saved: Array<typeof state> = []
      const dots: Array<{ style: string; alpha: number; w: number; cap: string }> = []
      const signal: Array<{ alpha: number; w: number }> = []
      for (const c of record(tl, f)) {
        if (c.method === 'save') saved.push({ ...state })
        else if (c.method === 'restore') state = saved.pop() ?? state
        else if (c.method === 'set:strokeStyle') state.style = String(c.args[0])
        else if (c.method === 'set:globalAlpha') state.alpha = Number(c.args[0])
        else if (c.method === 'set:lineWidth') state.lw = Number(c.args[0])
        else if (c.method === 'set:lineCap') state.cap = String(c.args[0])
        else if (c.method === 'setLineDash') state.dash = (c.args[0] as number[]).map(Number)
        else if (c.method === 'setTransform') state.m = c.args.map(Number)
        else if (c.method === 'stroke') {
          const w = state.lw * Math.sqrt(Math.abs((state.m[0] as number) * (state.m[3] as number) - (state.m[1] as number) * (state.m[2] as number)))
          if (state.style === signalInk(tl.palette)) signal.push({ alpha: state.alpha, w })
          else if (state.dash.length > 0 && state.dash[0] === 0) dots.push({ style: state.style, alpha: state.alpha, w, cap: state.cap })
        }
      }
      if (f < from) { if (dots.length > 0) bad.push(`frame ${f}: dots before their half beat`) } else if (dots.length === 0) bad.push(`frame ${f}: no hidden wiring`)
      const bright = Math.max(...signal.map((q) => over(signalInk(tl.palette), q.alpha)))
      const heavy = Math.max(...signal.map((q) => q.w))
      for (const d of dots) {
        if (d.cap !== 'round') bad.push(`frame ${f}: dots with ${d.cap} caps`)
        if (over(d.style, d.alpha) >= bright - 0.02) bad.push(`frame ${f}: dots as bright as the signal`)
        if (d.w >= heavy) bad.push(`frame ${f}: dots ${d.w.toFixed(1)} px as wide as the signal's ${heavy.toFixed(1)} px`)
      }
    }
    expect([...new Set(bad)].slice(0, 8)).toEqual([])
  }, 300000)

  it('puts no background behind any lettering: every filled rectangle is the paper\'s own colour', () => {
    const bad: string[] = []
    for (let f = 0; f < N; f += 6) {
      let fill = ''
      for (const c of record(tl, f)) {
        if (c.method === 'set:fillStyle') fill = String(c.args[0])
        if (c.method === 'fillRect' && fill !== paper) bad.push(`frame ${f}: a ${fill} rectangle`)
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  }, 600000)

  it('draws copper as outlines in one weight family from the end of the approved opening to the sheet: no white shape wider than 2% of the short side unless paper is cut back inside it, no white line heavier than 2.5 times the heavy pen unless it is an outline', () => {
    const minWH = Math.min(tl.width, tl.height)
    const heavy = 4.8 * (minWH / 1080)
    const bad: string[] = []
    type Op = { op: string; args: number[] }
    const boxes = (ops: Op[], m: number[]): Array<{ cx: number; cy: number; w: number }> => {
      const out: Array<{ cx: number; cy: number; w: number }> = []
      let xs: number[] = []
      let ys: number[] = []
      const flush = (): void => {
        if (xs.length > 0) out.push({ cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2, w: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) })
        xs = []
        ys = []
      }
      const add = (x: number, y: number): void => {
        xs.push((m[0] as number) * x + (m[2] as number) * y + (m[4] as number))
        ys.push((m[1] as number) * x + (m[3] as number) * y + (m[5] as number))
      }
      for (const o of ops) {
        if (o.op === 'moveTo') flush()
        if (o.op === 'arc') { add((o.args[0] as number) - (o.args[2] as number), (o.args[1] as number) - (o.args[2] as number)); add((o.args[0] as number) + (o.args[2] as number), (o.args[1] as number) + (o.args[2] as number)) } else if (o.op === 'rect') { add(o.args[0] as number, o.args[1] as number); add((o.args[0] as number) + (o.args[2] as number), (o.args[1] as number) + (o.args[3] as number)) } else for (let i = 0; i + 1 < o.args.length; i += 2) add(o.args[i] as number, o.args[i + 1] as number)
      }
      flush()
      return out
    }
    for (let f = Math.ceil(plot.shots.outline[0] * N); f < filmEnd; f += 10) {
      const calls = record(tl, f)
      let fill = ''
      let stroke = ''
      let lw = 1
      let m = [1, 0, 0, 1, 0, 0]
      const white: Array<{ cx: number; cy: number; w: number }> = []
      const cut: Array<{ cx: number; cy: number; w: number }> = []
      const wide: unknown[] = []
      const outlined = new Set<unknown>()
      for (const c of calls) {
        if (c.method === 'set:fillStyle') fill = String(c.args[0])
        else if (c.method === 'set:strokeStyle') stroke = String(c.args[0])
        else if (c.method === 'set:lineWidth') lw = Number(c.args[0])
        else if (c.method === 'setTransform') m = c.args.map(Number)
        else if (c.method === 'fill' && c.args[0] !== undefined && typeof c.args[0] === 'object') {
          const ops = (c.args[0] as { ops: Op[] }).ops
          if (fill === ink) white.push(...boxes(ops, m))
          if (fill === paper) cut.push(...boxes(ops, m))
        } else if (c.method === 'stroke' && c.args[0] !== undefined) {
          const w = lw * Math.hypot(m[0] as number, m[1] as number)
          if (stroke === ink && w > 2.5 * heavy) wide.push(c.args[0])
          if (stroke === paper) outlined.add(c.args[0])
        }
      }
      for (const b of white) if (b.w > 0.02 * minWH && !cut.some((k) => Math.hypot(k.cx - b.cx, k.cy - b.cy) < 2)) bad.push(`frame ${f}: a white shape ${b.w.toFixed(0)} px wide at ${b.cx.toFixed(0)},${b.cy.toFixed(0)}`)
      for (const w of wide) if (!outlined.has(w)) bad.push(`frame ${f}: a heavy white line that is not an outline`)
    }
    expect(bad.slice(0, 8)).toEqual([])
  }, 600000)

  it('letters every text wholly inside the frame or not at all, on every frame of twelve films, the camera moving or not (on a film that rides a net, the chip\'s name inside its outline is drawing, cut by the frame like its outline)', () => {
    const bad: string[] = []
    for (const board of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as const) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        for (let f = 0; f < tl.totalFrames; f++) {
          const panel = new Set([SECTION_TITLE, 'A', ...(tl.scene.plot?.section?.layers ?? []).map((l) => l.name)])
          const all = textBoxes(tl, f)
          for (const b of all) {
            if (b.cut || b.w <= 0 || (tl.scene.plot?.section !== undefined && panel.has(b.text)) || (tl.scene.plot?.signal !== undefined && b.text === tl.scene.plot.hero.label)) continue
            if (b.x < -1 || b.y < -1 || b.x + b.w > tl.width + 1 || b.y + b.h > tl.height + 1) bad.push(`${board} ${aspect} f${f} "${b.text}" ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)} s${Math.round(b.size)}`)
          }
        }
      }
    }
    expect(bad.slice(0, 8)).toEqual([])
  }, 1800000)

  it('keeps the signal\'s yellow on the sheet from the first frame to the last on a board with a pair and on one without', () => {
    const bad: string[] = []
    for (const board of ['glasgow.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as const) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        for (let f = 0; f < tl.totalFrames; f += 15) if (draw(tl, f).accent === 0) bad.push(`${board} ${aspect} f${f}`)
        if (draw(tl, tl.totalFrames - 1).accent === 0) bad.push(`${board} ${aspect} last`)
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  const RIDES = ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']
  const ASPECTS4 = ['16:9', '4:5', '9:16', '1:1'] as const
  const arrival = (tl: TraceTimeline): number => Math.floor(plotFrame(tl.scene.plot?.ink?.hold[0] ?? 0, tl.totalFrames))
  const drawnYellow = (plot: PlotScore, t: number): Array<{ q: [number, number]; t: number }> => {
    const tip = (path: number[], t0: number, t1: number): { q: [number, number]; t: number } => {
      const k = Math.min(1, (t - t0) / Math.max(1e-9, t1 - t0))
      const n = path.length / 2
      const at = k * (n - 1)
      const i = Math.min(n - 2, Math.floor(at))
      const f = at - i
      return { q: [(path[2 * i] as number) + ((path[2 * i + 2] as number) - (path[2 * i] as number)) * f, (path[2 * i + 1] as number) + ((path[2 * i + 3] as number) - (path[2 * i + 1] as number)) * f], t: t0 + k * (t1 - t0) }
    }
    if (plot.film.signature.kind === 'pair') return plot.bus.strokes.filter((st) => t >= st.t0).map((st) => tip(st.path, st.t0, st.t1))
    if (t < plot.shots.outline[0]) return [...plot.bus.strokes.filter((st) => st.accent === true), ...plot.bus.line].filter((st) => t >= st.t0).map((st) => tip(st.path, st.t0, st.t1))
    return plot.flow.path.filter((sg) => t >= sg.p0).map((sg) => tip([...sg.a, ...sg.b], sg.p0, sg.p1))
  }

  it('keeps the signal in the frame and yellow on every frame from frame 0 to the chip\'s arrival: the ride\'s head, or before the ride its yellow line, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot as PlotScore
        for (let f = 0; f <= arrival(tl); f++) {
          const t = plotClock(f, tl.totalFrames)
          const m = flatView(tl.scene, t, tl.width, tl.height)
          const seen = (q: [number, number]): boolean => {
            const [x, y] = apply(m, q[0], q[1])
            return x >= 0 && x <= tl.width && y >= 0 && y <= tl.height
          }
          const ys = drawnYellow(plot, t)
          const head = ys.reduce<(typeof ys)[number] | undefined>((a, q) => (a === undefined || q.t > a.t ? q : a), undefined)
          const ok = head !== undefined && (t < plot.shots.outline[0] ? ys.some((q) => seen(q.q)) : ys.some((q) => q.t >= head.t - 1e-9 && seen(q.q)))
          if (!ok) { bad.push(`${board} ${aspect} f${f}`); break }
        }
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('rides at most half the frame\'s width a second: on every frame of the ride to the chip\'s arrival but a cut, the paper at the frame\'s middle moves no faster, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot as PlotScore
        let worst = 0
        let at = 0
        for (let f = Math.ceil(plotFrame(plot.shots.outline[0], tl.totalFrames)) + 1; f <= arrival(tl); f++) {
          const m0 = flatView(tl.scene, plotClock(f - 1, tl.totalFrames), tl.width, tl.height)
          const c = apply(invert(m0), tl.width / 2, tl.height / 2)
          const [x, y] = apply(flatView(tl.scene, plotClock(f, tl.totalFrames), tl.width, tl.height), c[0], c[1])
          const v = (Math.hypot(x - tl.width / 2, y - tl.height / 2) * 30) / tl.width
          const cut = tl.scene.shots.some((q) => q.cut === true && q.t > plotClock(f - 1, tl.totalFrames) && q.t <= plotClock(f, tl.totalFrames))
          if (!cut && v > worst) { worst = v; at = f }
        }
        if (worst > RIDE_PACE) bad.push(`${board} ${aspect} f${at}: ${worst.toFixed(2)} W/s`)
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('never turns the main chip\'s name over: from the first frame it stands to the last, its angle steps at most 8° between two frames and stays within 90° of the frame\'s reading direction, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const label = (tl.scene.plot as PlotScore).hero.label
        let prev: number | undefined
        for (let f = 0; f < tl.totalFrames; f++) {
          let m = [1, 0, 0, 1, 0, 0]
          let at: number | undefined
          for (const c of record(tl, f)) {
            if (c.method === 'setTransform') m = c.args as number[]
            if (c.method !== 'fillText' || at !== undefined) continue
            const text = String(c.args[0])
            if (text.length > 0 && label.startsWith(text)) at = (Math.atan2(m[1] as number, m[0] as number) * 180) / Math.PI
          }
          if (at === undefined) continue
          const step = prev === undefined ? 0 : Math.abs(((at - prev + 540) % 360) - 180)
          if (step > 8 || Math.abs(at) > 90.01) { bad.push(`${board} ${aspect} f${f}: ${at.toFixed(1)}°, a step of ${step.toFixed(1)}°`); break }
          prev = at
        }
      }
    }
    expect(bad).toEqual([])
  }, 3600000)

  it('never holds the main chip wide without its name: before the tilt, no run of more than 33 frames on which its drawn outline spans over half the frame\'s width, stands wholly in the frame, and no letter of its name is in the frame, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot as PlotScore
        const tilt = Math.floor(plotFrame(plot.shots.object[0], tl.totalFrames))
        const at = drawnOutline(tl)
        let run = 0
        let most = 0
        let from = -1
        for (let f = 0; f < tilt; f++) {
          const poly = bodyOnScreen(tl, f)
          const xs = poly.map((q) => q[0])
          const ys = poly.map((q) => q[1])
          const wide = at(f).drawn && Math.min(...xs) >= 0 && Math.min(...ys) >= 0 && Math.max(...xs) <= tl.width && Math.max(...ys) <= tl.height && Math.max(...xs) - Math.min(...xs) > 0.5 * tl.width
          const lettered = wide && textBoxes(tl, f).some((b) => b.text.length > 0 && plot.hero.label.startsWith(b.text) && b.x < tl.width && b.x + b.w > 0 && b.y < tl.height && b.y + b.h > 0)
          run = wide && !lettered ? run + 1 : 0
          if (run > most) { most = run; from = f - run + 1 }
        }
        if (most > 33) bad.push(`${board} ${aspect}: ${most} frames from f${from}`)
      }
    }
    expect(bad).toEqual([])
  }, 3600000)

  it('letters no line over another: before the tilt no two lines of lettering cover the same paper on any frame, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const tilt = Math.floor(plotFrame((tl.scene.plot as PlotScore).shots.object[0], tl.totalFrames))
        for (let f = 0; f < tilt; f++) {
          const boxes = textBoxes(tl, f).filter((b) => b.text.trim().length > 0)
          const hit = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => {
            const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
            const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
            return w > 0 && h > 0 && w * h > 0.1 * Math.min(a.w * a.h, b.w * b.h)
          }).map((b) => `"${a.text}" and "${b.text}"`))
          if (hit.length > 0) { bad.push(`${board} ${aspect} f${f}: ${hit[0] as string}`); break }
        }
      }
    }
    expect(bad).toEqual([])
  }, 1800000)

  const rideFrom = (tl: TraceTimeline): number => Math.ceil(plotFrame((tl.scene.plot as PlotScore).shots.outline[0], tl.totalFrames))
  const shortMm = (tl: TraceTimeline, f: number): number => Math.min(tl.width, tl.height) / (sampleShot(tl.scene.shots, plotClock(f, tl.totalFrames)).zoom * tl.scene.material.pxPerMm)
  const glasgowSpan = new Map<string, [number, number]>()
  const glasgowMm = (aspect: (typeof ASPECTS4)[number]): [number, number] => {
    const hit = glasgowSpan.get(aspect)
    if (hit !== undefined) return hit
    const tl = plotTimeline('glasgow.kicad_pcb', { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
    const a = rideFrom(tl)
    const spans = Array.from({ length: arrival(tl) - a + 1 }, (_, i) => shortMm(tl, a + i)).sort((x, y) => x - y)
    const range: [number, number] = [spans[0] as number, spans.at(-1) as number]
    glasgowSpan.set(aspect, range)
    return range
  }

  it('rides at one scale from frame 0 until it eases into the chip: the frame\'s short side spans no more than 1.25 times the widest span Glasgow\'s ride holds in that aspect and the scale moves less than a tenth, on the eight films that ride a net', () => {
    const bad: string[] = []
    for (const board of RIDES.filter((b) => !b.startsWith('glasgow'))) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const close = Math.floor(0.75 * arrival(tl))
        const spans = Array.from({ length: close + 1 }, (_, f) => shortMm(tl, f))
        const g = glasgowMm(aspect)
        const [lo, hi] = [Math.min(...spans), Math.max(...spans)]
        if (hi > 1.25 * g[1] || hi / lo > 1.1) bad.push(`${board} ${aspect}: ${lo.toFixed(1)}–${hi.toFixed(1)} mm against Glasgow's ${g[0].toFixed(1)}–${g[1].toFixed(1)}`)
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  const inkReach = (ink: NonNullable<PlotScore['ink']>, x: number, y: number): number => {
    let t = ink.far.t + Math.hypot(x - ink.far.x, y - ink.far.y) / ink.far.v
    for (let i = 0; i + 3 < ink.src.length; i += 4) t = Math.min(t, (ink.src[i + 2] as number) + Math.hypot(x - (ink.src[i] as number), y - (ink.src[i + 1] as number)) / (ink.src[i + 3] as number))
    return t
  }

  it('opens in the middle of the ride: at frame 0 the drawn run spans 40% of the frame\'s long side, the head is already moving, and the copper the wake has passed is inked, on the eight films that ride a net', () => {
    const bad: string[] = []
    for (const board of RIDES.filter((b) => !b.startsWith('glasgow'))) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot as PlotScore
        const ink = plot.ink
        if (ink === undefined) { bad.push(`${board} ${aspect}: no ink`); continue }
        const t = plotClock(0, tl.totalFrames)
        const m = flatView(tl.scene, t, tl.width, tl.height)
        const pts: Array<[number, number]> = []
        let bare = 0
        for (const sg of plot.flow.path.filter((q) => q.p0 < t)) {
          const k = Math.min(1, (t - sg.p0) / Math.max(1e-9, sg.p1 - sg.p0))
          for (let i = 0; i <= 20; i++) {
            const q: [number, number] = [sg.a[0] + ((sg.b[0] - sg.a[0]) * k * i) / 20, sg.a[1] + ((sg.b[1] - sg.a[1]) * k * i) / 20]
            const [x, y] = apply(m, q[0], q[1])
            if (x < 0 || x > tl.width || y < 0 || y > tl.height) continue
            pts.push([x, y])
            if (k >= 1 && inkReach(ink, q[0], q[1]) > inkClock(ink, t) + 1e-6) bare += 1
          }
        }
        const span = pts.length === 0 ? 0 : Math.max(Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]))) / Math.max(tl.width, tl.height)
        const moving = plot.flow.path.some((sg) => sg.p0 < t && t < sg.p1)
        if (span < 0.4 || !moving || bare > 0) bad.push(`${board} ${aspect}: run ${(100 * span).toFixed(0)}% of the long side, ${moving ? 'moving' : 'still'}, ${bare} passed points uninked`)
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  it('rides a stretch at least one and a half times the frame\'s long side, or the longest the signal\'s net has to the chip, on the eight films that ride a net', () => {
    const bad: string[] = []
    for (const board of RIDES.filter((b) => !b.startsWith('glasgow'))) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const sig = (tl.scene.plot as PlotScore).signal
        if (sig === undefined) { bad.push(`${board} ${aspect}: no ride`); continue }
        const longMm = Math.max(tl.width, tl.height) / (sampleShot(tl.scene.shots, plotClock(0, tl.totalFrames)).zoom * tl.scene.material.pxPerMm)
        if (sig.mm < 1.5 * longMm && sig.mm < sig.longest - 0.5) bad.push(`${board} ${aspect}: ${sig.mm.toFixed(1)} mm from ${sig.from}, the frame's long side ${longMm.toFixed(1)} mm, the net's longest ${sig.longest.toFixed(1)} mm`)
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  const RIDERS = RIDES.filter((b) => !b.startsWith('glasgow'))
  const bodyOnScreen = (tl: TraceTimeline, f: number): Array<[number, number]> => {
    const hp = tl.scene.parts.find((q) => q.hero === true)
    if (hp === undefined) return []
    const m = flatView(tl.scene, plotClock(f, tl.totalFrames), tl.width, tl.height)
    return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([u, v]) => apply(m, hp.x + (Math.cos(hp.rot) * u * hp.w - Math.sin(hp.rot) * v * hp.h) / 2, hp.y + (Math.sin(hp.rot) * u * hp.w + Math.cos(hp.rot) * v * hp.h) / 2))
  }
  const wholeIn = (tl: TraceTimeline, poly: Array<[number, number]>): boolean => poly.every(([x, y]) => x >= 0 && x <= tl.width && y >= 0 && y <= tl.height)
  const shareOf = (tl: TraceTimeline, poly: Array<[number, number]>): number => {
    let out = poly
    const edges: Array<[(q: [number, number]) => number]> = [[(q) => q[0]], [(q) => tl.width - q[0]], [(q) => q[1]], [(q) => tl.height - q[1]]]
    for (const [d] of edges) {
      const next: Array<[number, number]> = []
      out.forEach((a, i) => {
        const b = out[(i + 1) % out.length] as [number, number]
        if (d(a) >= 0) next.push(a)
        if ((d(a) >= 0) !== (d(b) >= 0)) {
          const k = d(a) / (d(a) - d(b))
          next.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k])
        }
      })
      out = next
    }
    return Math.abs(out.reduce((t, a, i) => { const b = out[(i + 1) % out.length] as [number, number]; return t + a[0] * b[1] - b[0] * a[1] }, 0)) / 2 / (tl.width * tl.height)
  }

  it('holds the main chip\'s whole outline in the frame only in the ride\'s last second: never before 30 frames ahead of the arrival, on the eight films that ride a net', () => {
    const bad: string[] = []
    for (const board of RIDERS) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const first = Array.from({ length: arrival(tl) - 30 }, (_, f) => f).find((f) => wholeIn(tl, bodyOnScreen(tl, f)))
        if (first !== undefined) bad.push(`${board} ${aspect}: whole at f${first}, the arrival f${arrival(tl)}`)
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  const drawnOutline = (tl: TraceTimeline): ((f: number) => { drawn: boolean; inFrame: boolean }) => {
    const plot = tl.scene.plot as PlotScore
    const ink = plot.ink
    const hp = tl.scene.parts.find((q) => q.hero === true)
    if (ink === undefined || hp === undefined) return () => ({ drawn: false, inFrame: false })
    const rim = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).flatMap(([a, b], i, all) => Array.from({ length: 8 }, (_, k): [number, number] => {
      const [c, d] = all[(i + 1) % 4] as readonly [number, number]
      const u = a + ((c - a) * k) / 8
      const v = b + ((d - b) * k) / 8
      return [hp.x + (u * hp.w * Math.cos(hp.rot) - v * hp.h * Math.sin(hp.rot)) / 2, hp.y + (u * hp.w * Math.sin(hp.rot) + v * hp.h * Math.cos(hp.rot)) / 2]
    }))
    return (f) => {
      const p = plotClock(f, tl.totalFrames)
      const m = flatView(tl.scene, p, tl.width, tl.height)
      const inside = (x: number, y: number): boolean => { const [a, b] = apply(m, x, y); return a >= 0 && a <= tl.width && b >= 0 && b <= tl.height }
      const fresh = revealed(tl.scene, ink, inkClock(ink, p))
      return {
        drawn: fresh.s.parts.some((q) => q.hero === true),
        inFrame: rim.some(([x, y]) => inside(x, y))
      }
    }
  }

  const ownPadsDrawn = (tl: TraceTimeline, f: number): Set<number> => {
    const own = tl.scene.pads.map((q, i) => ({ q, i })).filter(({ q }) => q.hero === true && q.side !== 'B')
    const stock = tl.palette.bg.toLowerCase()
    let m = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    let fill = ''
    const at = new Map<number, Array<[number, number]>>()
    const on = (x: number, y: number): [number, number] => [(m[0] as number) * x + (m[2] as number) * y + (m[4] as number), (m[1] as number) * x + (m[3] as number) * y + (m[5] as number)]
    const inside = (q: [number, number], poly: Array<[number, number]>): boolean => poly.reduce((v, a, k) => {
      const b = poly[(k + 1) % poly.length] as [number, number]
      return (a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]) ? !v : v
    }, false)
    const cover = (polys: Array<Array<[number, number]>>): void => {
      for (const [i, pts] of [...at]) if (pts.every((q) => polys.some((poly) => poly.length >= 3 && inside(q, poly)))) at.delete(i)
    }
    for (const c of record(tl, f)) {
      if (c.method === 'setTransform') m = c.args as number[]
      else if (c.method === 'save') stack.push(m)
      else if (c.method === 'restore') m = stack.pop() ?? m
      else if (c.method === 'set:fillStyle') fill = String(c.args[0]).toLowerCase()
      else if (c.method === 'fillRect' && fill === stock) {
        const [x, y, w, h] = c.args as [number, number, number, number]
        cover([[on(x, y), on(x + w, y), on(x + w, y + h), on(x, y + h)]])
      } else if (c.method === 'fill' && typeof c.args[0] === 'object' && c.args[0] !== null) {
        const ops = (c.args[0] as { ops: Array<{ op: string; args: number[] }> }).ops
        if (fill === stock) {
          const polys: Array<Array<[number, number]>> = []
          for (const o of ops) {
            if (o.op === 'moveTo') polys.push([on(o.args[0] as number, o.args[1] as number)])
            else if (o.op === 'lineTo') polys.at(-1)?.push(on(o.args[0] as number, o.args[1] as number))
          }
          cover(polys)
          continue
        }
        const starts = ops.filter((o) => o.op === 'moveTo').map((o) => o.args as [number, number])
        for (const { q, i } of own) if (starts.some(([x, y]) => Math.hypot(x - q.x, y - q.y) <= 0.75 * Math.hypot(q.w, q.h))) at.set(i, [on(q.x, q.y), ...([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([u, v]) => on(q.x + (Math.cos(q.rot) * u * q.w - Math.sin(q.rot) * v * q.h) / 2, q.y + (Math.sin(q.rot) * u * q.w + Math.cos(q.rot) * v * q.h) / 2))])
      }
    }
    return new Set([...at].filter(([, pts]) => { const q = pts[0] as [number, number]; return q[0] > 0 && q[0] < tl.width && q[1] > 0 && q[1] < tl.height }).map(([i]) => i))
  }

  const strokesUnder = (tl: TraceTimeline, f: number): number => {
    const hp = tl.scene.parts.find((q) => q.hero === true)
    if (hp === undefined) return 0
    const mv = flatView(tl.scene, plotClock(f, tl.totalFrames), tl.width, tl.height)
    const body = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([u, v]) => apply(mv, hp.x + 0.45 * (Math.cos(hp.rot) * u * hp.w - Math.sin(hp.rot) * v * hp.h), hp.y + 0.45 * (Math.sin(hp.rot) * u * hp.w + Math.cos(hp.rot) * v * hp.h)))
    const inside = (q: [number, number], poly: Array<[number, number]>): boolean => poly.reduce((v, a, k) => {
      const b = poly[(k + 1) % poly.length] as [number, number]
      return (a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]) ? !v : v
    }, false)
    const stock = tl.palette.bg.toLowerCase()
    let m = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    let ink = ''
    let fill = ''
    let marks: Array<[number, number]> = []
    let clips: Array<(q: [number, number]) => boolean> = []
    const clipStack: Array<Array<(q: [number, number]) => boolean>> = []
    const polysOf = (path: unknown): Array<Array<[number, number]>> => {
      const out: Array<Array<[number, number]>> = []
      for (const o of (path as { ops: Array<{ op: string; args: number[] }> }).ops) {
        if (o.op === 'moveTo') out.push([on(o.args[0] as number, o.args[1] as number)])
        else if (o.op === 'lineTo') out.at(-1)?.push(on(o.args[0] as number, o.args[1] as number))
        else if (o.op === 'rect') { const [x, y, w, h] = o.args as [number, number, number, number]; out.push([on(x, y), on(x + w, y), on(x + w, y + h), on(x, y + h)]) }
      }
      return out
    }
    const on = (x: number, y: number): [number, number] => [(m[0] as number) * x + (m[2] as number) * y + (m[4] as number), (m[1] as number) * x + (m[3] as number) * y + (m[5] as number)]
    for (const c of record(tl, f)) {
      if (c.method === 'setTransform') m = c.args as number[]
      else if (c.method === 'save') { stack.push(m); clipStack.push(clips) }
      else if (c.method === 'restore') { m = stack.pop() ?? m; clips = clipStack.pop() ?? clips }
      else if (c.method === 'clip' && typeof c.args[0] === 'object' && c.args[0] !== null) {
        const polys = polysOf(c.args[0]).filter((poly) => poly.length >= 3)
        const odd = c.args[1] === 'evenodd'
        clips = [...clips, (q) => { const k = polys.filter((poly) => inside(q, poly)).length; return odd ? k % 2 === 1 : k > 0 }]
      }
      else if (c.method === 'set:strokeStyle') ink = String(c.args[0]).toLowerCase()
      else if (c.method === 'set:fillStyle') fill = String(c.args[0]).toLowerCase()
      else if (c.method === 'fillRect' && fill === stock) {
        const [x, y, w, h] = c.args as [number, number, number, number]
        const r = [on(x, y), on(x + w, y), on(x + w, y + h), on(x, y + h)]
        marks = marks.filter((q) => !inside(q, r))
      } else if (c.method === 'fill' && fill === stock && typeof c.args[0] === 'object' && c.args[0] !== null) {
        const polys: Array<Array<[number, number]>> = []
        for (const o of (c.args[0] as { ops: Array<{ op: string; args: number[] }> }).ops) {
          if (o.op === 'moveTo') polys.push([on(o.args[0] as number, o.args[1] as number)])
          else if (o.op === 'lineTo') polys.at(-1)?.push(on(o.args[0] as number, o.args[1] as number))
        }
        marks = marks.filter((q) => !polys.some((poly) => poly.length >= 3 && inside(q, poly)))
      } else if (c.method === 'stroke' && ink !== stock && typeof c.args[0] === 'object' && c.args[0] !== null) {
        let last: [number, number] | undefined
        for (const o of (c.args[0] as { ops: Array<{ op: string; args: number[] }> }).ops) {
          const q = on(o.args[o.args.length - 2] as number, o.args[o.args.length - 1] as number)
          const mid: [number, number] = last === undefined ? q : [(last[0] + q[0]) / 2, (last[1] + q[1]) / 2]
          if (o.op === 'lineTo' && last !== undefined && inside(mid, body) && clips.every((k) => k(mid))) marks.push(mid)
          last = q
        }
      }
    }
    return marks.length
  }

  const inkHalves = (tl: TraceTimeline, f: number): [number, number] => {
    const stock = tl.palette.bg.toLowerCase()
    const floor = nameStrip(tl.width, tl.height).y
    let m = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    let ink = ''
    const halves: [number, number] = [0, 0]
    const on = (x: number, y: number): [number, number] => [(m[0] as number) * x + (m[2] as number) * y + (m[4] as number), (m[1] as number) * x + (m[3] as number) * y + (m[5] as number)]
    for (const c of record(tl, f)) {
      if (c.method === 'setTransform') m = c.args as number[]
      else if (c.method === 'save') stack.push(m)
      else if (c.method === 'restore') m = stack.pop() ?? m
      else if (c.method === 'set:strokeStyle') ink = String(c.args[0]).toLowerCase()
      else if (c.method === 'stroke' && ink !== stock && typeof c.args[0] === 'object' && c.args[0] !== null) {
        let last: [number, number] | undefined
        for (const o of (c.args[0] as { ops: Array<{ op: string; args: number[] }> }).ops) {
          const q = on(o.args[o.args.length - 2] as number, o.args[o.args.length - 1] as number)
          if (o.op === 'lineTo' && last !== undefined) {
            const mid = [(last[0] + q[0]) / 2, (last[1] + q[1]) / 2] as [number, number]
            if (mid[0] > 0 && mid[0] < tl.width && mid[1] > 0 && mid[1] < floor) halves[mid[1] < floor / 2 ? 0 : 1] += Math.hypot(q[0] - last[0], q[1] - last[1])
          }
          last = q
        }
      }
    }
    return [(2000 * halves[0]) / (tl.width * floor), (2000 * halves[1]) / (tl.width * floor)]
  }

  /** the dev kit 9:16's lid on its last frame in round 13, a share of the frame: round 14 raises its poster clear of a header pin without shrinking it */
  const KIT_TALL_LID = 0.01481

  it('keeps the main chip\'s lid clear through the tilt: from its first frame to the last, the bodies the renderer draws in front of the chip cover at most CHIP_HIDE of its lid, on every frame but the main chip\'s rise (from the frame before its body leaves the plan to the frame it stands at full height), on the twelve films as they are rendered', () => {
    const bad: string[] = []
    for (const board of ['glasgow', 'icebreaker', 'kit-dev-coldfire-xilinx_5213']) {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as const) {
        const tl = filmTimeline(board, aspect)
        const plot = tl.scene.plot
        const hp = tl.scene.parts.find((q) => q.hero === true)
        if (plot === undefined || hp === undefined) throw new Error('no plot')
        const rows = handOff(board, aspect)
        const up = rows.find((r) => r.rise > 1e-3)?.f ?? tl.totalFrames
        const full = rows.find((r) => r.f > up && r.rise >= 0.999)?.f ?? tl.totalFrames
        for (let f = atBeat(tl, plot.beats.tilt[0]); f < tl.totalFrames; f++) {
          if (f >= up - 1 && f < full) continue
          const cover = lidCovered(tl, hp, f)
          if (cover > CHIP_HIDE) bad.push(`${board} ${aspect} f${f}: ${(100 * cover).toFixed(1)}%`)
        }
      }
    }
    expect(bad.slice(0, 12)).toEqual([])
  }, 3600000)

  it('keeps the main chip large on the poster: on the last frame its lid takes at least 0.5% of the frame (the smallest of round 12\'s twelve is 0.56%), the dev kit 9:16\'s no smaller than round 13\'s 1.4819%, so keeping the chip clear in the tilt never shrinks it on the sheet, on the twelve films as they are rendered', () => {
    const bad: string[] = []
    for (const board of ['glasgow', 'icebreaker', 'kit-dev-coldfire-xilinx_5213']) {
      for (const aspect of ASPECTS4) {
        const tl = filmTimeline(board, aspect)
        const hp = tl.scene.parts.find((q) => q.hero === true)
        if (hp === undefined) throw new Error('no chip')
        const v = heroFrame(tl, tl.totalFrames - 1).view
        const lid = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]): Xy => axoPoint(v, [hp.x + (((a as number) * hp.w) / 2) * Math.cos(hp.rot) - (((b as number) * hp.h) / 2) * Math.sin(hp.rot), hp.y + (((a as number) * hp.w) / 2) * Math.sin(hp.rot) + (((b as number) * hp.h) / 2) * Math.cos(hp.rot)], hp.z))
        const share = polyArea(lid) / (tl.width * tl.height)
        if (share < (board === 'kit-dev-coldfire-xilinx_5213' && aspect === '9:16' ? KIT_TALL_LID : 0.005)) bad.push(`${board} ${aspect}: ${(100 * share).toFixed(2)}%`)
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('letters the main chip\'s name once: from f200 to the last frame no frame holds two copies of it, the lid\'s and the plan\'s, and from eight frames into the tilt none between two that hold it goes without it, counting a copy at half strength or more, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const core = (tl.scene.plot as PlotScore).hero.label.split(/[-\s/_]/)[0] ?? ''
        const twice: number[] = []
        const copies: number[] = []
        for (let f = 200; f < tl.totalFrames; f++) {
          let m = [1, 0, 0, 1, 0, 0]
          let alpha = 1
          const saved: number[] = []
          const at = new Set<string>()
          for (const c of record(tl, f)) {
            if (c.method === 'setTransform') m = c.args as number[]
            else if (c.method === 'set:globalAlpha') alpha = Number(c.args[0])
            else if (c.method === 'save') saved.push(alpha)
            else if (c.method === 'restore') alpha = saved.pop() ?? alpha
            if (c.method !== 'fillText' || alpha < 0.5 || !String(c.args[0]).includes(core)) continue
            const [x, y] = [c.args[1] as number, c.args[2] as number]
            at.add(`${Math.round((m[0] as number) * x + (m[2] as number) * y + (m[4] as number))},${Math.round((m[1] as number) * x + (m[3] as number) * y + (m[5] as number))}`)
          }
          if (at.size > 1) twice.push(f)
          copies.push(at.size)
        }
        if (twice.length > 0) bad.push(`${board} ${aspect}: two from f${twice[0]} to f${twice.at(-1)}, ${twice.length} frames`)
        const first = copies.findIndex((n) => n > 0)
        const last = copies.length - 1 - [...copies].reverse().findIndex((n) => n > 0)
        const settled = atBeat(tl, (tl.scene.plot as PlotScore).beats.tilt[0]) + 8
        const gaps = copies.flatMap((n, i) => (i > first && i < last && n === 0 && 200 + i >= settled ? [200 + i] : []))
        if (gaps.length > 0) bad.push(`${board} ${aspect}: none from f${gaps[0]} to f${gaps.at(-1)}, ${gaps.length} frames`)
      }
    }
    expect(bad).toEqual([])
  }, 3600000)

  it('drafts the arrival\'s copper in: before the tilt no frame of iCEBreaker\'s four films adds more drawn line than the most one frame adds on the eight Glasgow and dev kit films', () => {
    const rise = (board: string, aspect: string): { most: number; at: number } => {
      const tl = filmTimeline(board, aspect)
      const end = atBeat(tl, (tl.scene.plot as PlotScore).beats.tilt[0])
      const ink = Array.from({ length: end }, (_, f) => drawnLine(tl, f))
      return ink.slice(1).reduce((b, v, i) => (v - (ink[i] as number) > b.most ? { most: v - (ink[i] as number), at: i + 1 } : b), { most: 0, at: 0 })
    }
    const bound = Math.max(...['glasgow', 'kit-dev-coldfire-xilinx_5213'].flatMap((b) => ASPECTS4.map((a) => rise(b, a).most)))
    const bad = ASPECTS4.map((a) => ({ a, r: rise('icebreaker', a) })).filter(({ r }) => r.most > bound).map(({ a, r }) => `icebreaker ${a} f${r.at}: ${r.most.toFixed(1)} over ${bound.toFixed(1)}`)
    expect(bad).toEqual([])
  }, 3600000)

  it('opens the arrival on drawn copper: on the second after the ride arrives, each half of the frame above the name strip holds at least 4.5 px of line per 1000 px², on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        for (const f of [arrival(tl) + 8, arrival(tl) + 20]) {
          const [up, low] = inkHalves(tl, f)
          if (Math.min(up, low) < 4.5) bad.push(`${board} ${aspect} f${f}: ${up.toFixed(1)} up, ${low.toFixed(1)} low`)
        }
      }
    }
    expect(bad).toEqual([])
  }, 1800000)

  it('never erases copper under the main chip: the strokes inside its body\'s outline are as many on the frame its outline arrives as on the frame before, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const at = drawnOutline(tl)
        const tilt = Math.floor(plotFrame((tl.scene.plot as PlotScore).shots.object[0], tl.totalFrames))
        const f = Array.from({ length: tilt }, (_, k) => k).find((k) => k > 0 && at(k).drawn && !at(k - 1).drawn)
        if (f === undefined) continue
        const [a, b] = [strokesUnder(tl, f - 1), strokesUnder(tl, f)]
        if (a !== b) bad.push(`${board} ${aspect} f${f - 1} ${a}, f${f} ${b}`)
      }
    }
    expect(bad).toEqual([])
  }, 1800000)

  it('never covers the main chip\'s own pads: from the first frame they are in the frame to the tilt, no pad that stood leaves while the camera holds it in the frame, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const tilt = Math.floor(plotFrame((tl.scene.plot as PlotScore).shots.object[0], tl.totalFrames))
        const inFrame = (f: number): Set<number> => {
          const mv = flatView(tl.scene, plotClock(f, tl.totalFrames), tl.width, tl.height)
          return new Set(tl.scene.pads.map((q, i) => ({ q, i })).filter(({ q }) => q.hero === true && q.side !== 'B').filter(({ q }) => { const [x, y] = apply(mv, q.x, q.y); return x > 0 && x < tl.width && y > 0 && y < tl.height }).map(({ i }) => i))
        }
        let prev = ownPadsDrawn(tl, 0)
        let held = inFrame(0)
        let worst = 0
        let at = -1
        for (let f = 1; f < tilt; f++) {
          const now = ownPadsDrawn(tl, f)
          const still = inFrame(f)
          const lost = [...prev].filter((i) => held.has(i) && still.has(i) && !now.has(i)).length
          if (lost > worst) { worst = lost; at = f }
          prev = now
          held = still
        }
        if (worst > 0) bad.push(`${board} ${aspect} f${at}: ${worst} pads lost`)
      }
    }
    expect(bad).toEqual([])
  }, 3600000)

  it('draws the main chip\'s outline into the frame only in the ride\'s last second and a half, never before 45 frames ahead of the arrival, on the four iCEBreaker films', () => {
    const bad: string[] = []
    for (const aspect of ASPECTS4) {
      const tl = plotTimeline('icebreaker.kicad_pcb', { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
      const at = drawnOutline(tl)
      const first = Array.from({ length: arrival(tl) - 45 }, (_, f) => f).find((f) => { const q = at(f); return q.drawn && q.inFrame })
      if (first !== undefined) bad.push(`${aspect}: drawn in the frame at f${first}, the arrival f${arrival(tl)}`)
    }
    expect(bad).toEqual([])
  }, 900000)

  it('never fills the frame with the main chip\'s body: from frame 0 to the tilt the body covers at most 40% of the frame unless its whole outline, and so its whole name, is in the frame, on the eight films that ride a net', () => {
    const bad: string[] = []
    for (const board of RIDERS) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const tilt = Math.floor(plotFrame((tl.scene.plot as PlotScore).shots.object[0], tl.totalFrames))
        for (let f = 0; f < tilt; f++) {
          const poly = bodyOnScreen(tl, f)
          const share = shareOf(tl, poly)
          if (!wholeIn(tl, poly) && share > 0.4) { bad.push(`${board} ${aspect} f${f}: ${(100 * share).toFixed(0)}%`); break }
        }
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  it('keeps the main chip large from the arrival to the tilt: its body spans at least 45% of the frame\'s short side, on the eight films that ride a net', () => {
    const bad: string[] = []
    for (const board of RIDERS) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const tilt = Math.floor(plotFrame((tl.scene.plot as PlotScore).shots.object[0], tl.totalFrames))
        for (let f = arrival(tl); f < tilt; f++) {
          const poly = bodyOnScreen(tl, f)
          const span = Math.max(Math.max(...poly.map((q) => q[0])) - Math.min(...poly.map((q) => q[0])), Math.max(...poly.map((q) => q[1])) - Math.min(...poly.map((q) => q[1]))) / Math.min(tl.width, tl.height)
          if (span < 0.45) { bad.push(`${board} ${aspect} f${f}: ${(100 * span).toFixed(0)}%`); break }
        }
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  it('keeps a turned main chip as large as a square one: from the arrival to the tilt its body\'s shorter side spans at least 43% of the frame\'s short side, on the eight films that ride a net', () => {
    const bad: string[] = []
    for (const board of RIDERS) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const tilt = Math.floor(plotFrame((tl.scene.plot as PlotScore).shots.object[0], tl.totalFrames))
        for (let f = arrival(tl); f < tilt; f++) {
          const poly = bodyOnScreen(tl, f)
          const side = Math.min(...poly.map((q, i) => { const r = poly[(i + 1) % poly.length] as [number, number]; return Math.hypot(r[0] - q[0], r[1] - q[1]) })) / Math.min(tl.width, tl.height)
          if (side < 0.43) { bad.push(`${board} ${aspect} f${f}: ${(100 * side).toFixed(0)}%`); break }
        }
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  it('letters the main chip\'s name in the plan reading from the bottom or the right: its baseline within 90° of the frame\'s reading direction, a vertical one reading upward, on every frame it is lettered before the tilt, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot as PlotScore
        const tilt = Math.floor(plotFrame(plot.shots.object[0], tl.totalFrames))
        let seen = 0
        let turned = false
        for (let f = arrival(tl); f < tilt && !turned; f += 6) {
          let m = [1, 0, 0, 1, 0, 0]
          for (const c of record(tl, f)) {
            if (c.method === 'setTransform') m = c.args as number[]
            if (c.method !== 'fillText' || String(c.args[0]) !== plot.hero.label) continue
            seen++
            const [bx, by] = [m[0] as number, m[1] as number]
            if (Math.abs(bx) > 1e-6 * Math.hypot(bx, by) ? bx < 0 : by > 0) { bad.push(`${board} ${aspect} f${f}: ${(Math.atan2(m[1] as number, m[0] as number) * 180 / Math.PI).toFixed(0)}°`); turned = true; break }
          }
        }
        if (seen === 0) bad.push(`${board} ${aspect}: never lettered`)
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  const lineThroughLettering = (calls: Calls, stock: string): string[] => {
    type V = [number, number]
    let m = [1, 0, 0, 1, 0, 0]
    const stack: Array<{ m: number[]; clips: V[][][]; props: Record<string, string> }> = []
    let clips: V[][][] = []
    let props: Record<string, string> = { font: '10px', textAlign: 'left', textBaseline: 'alphabetic', fillStyle: '', strokeStyle: '', globalCompositeOperation: 'source-over' }
    const at = (x: number, y: number): V => [(m[0] as number) * x + (m[2] as number) * y + (m[4] as number), (m[1] as number) * x + (m[3] as number) * y + (m[5] as number)]
    const mulT = (n: number[]): void => {
      const [a, b, c, d, e, f] = m as [number, number, number, number, number, number]
      m = [a * (n[0] as number) + c * (n[1] as number), b * (n[0] as number) + d * (n[1] as number), a * (n[2] as number) + c * (n[3] as number), b * (n[2] as number) + d * (n[3] as number), a * (n[4] as number) + c * (n[5] as number) + e, b * (n[4] as number) + d * (n[5] as number) + f]
    }
    const inPoly = (q: V, poly: V[]): boolean => {
      let inside = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i] as V
        const [xj, yj] = poly[j] as V
        if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside
      }
      return inside
    }
    const loops = (ops: Array<{ op: string; args: number[] }>): V[][] => {
      const out: V[][] = []
      let cur: V[] = []
      const end = (): void => { if (cur.length > 0) out.push(cur); cur = [] }
      for (const { op, args } of ops) {
        if (op === 'moveTo') { end(); cur = [at(args[0] as number, args[1] as number)] }
        else if (op === 'lineTo' || op === 'quadraticCurveTo') cur.push(at(args.at(-2) as number, args.at(-1) as number))
        else if (op === 'arc') {
          const [x, y, r, a0, a1] = args as [number, number, number, number, number]
          for (let i = 0; i <= 16; i++) cur.push(at(x + r * Math.cos(a0 + ((a1 - a0) * i) / 16), y + r * Math.sin(a0 + ((a1 - a0) * i) / 16)))
        } else if (op === 'rect' || op === 'roundRect') {
          end()
          const [x, y, w, h] = args as [number, number, number, number]
          out.push([at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h), at(x, y)])
        } else if (op === 'closePath' && cur.length > 0) cur.push(cur[0] as V)
      }
      end()
      return out
    }
    let path: Array<{ op: string; args: number[] }> = []
    const bands: V[][] = []
    const strokes: Array<{ q: V; i: number }> = []
    const knocks: Array<{ poly: V[]; i: number }> = []
    const bad: string[] = []
    const excluded = (q: V): boolean => clips.some((loopsOf) => loopsOf.filter((l) => inPoly(q, l)).length % 2 === 0)
    calls.forEach((c, i) => {
      const a = c.args
      if (c.method === 'setTransform') m = a.map(Number)
      else if (c.method === 'save') stack.push({ m, clips, props: { ...props } })
      else if (c.method === 'restore') ({ m, clips, props } = stack.pop() ?? { m, clips, props })
      else if (c.method === 'translate') mulT([1, 0, 0, 1, Number(a[0]), Number(a[1])])
      else if (c.method === 'scale') mulT([Number(a[0]), 0, 0, Number(a[1]), 0, 0])
      else if (c.method === 'rotate') mulT([Math.cos(Number(a[0])), Math.sin(Number(a[0])), -Math.sin(Number(a[0])), Math.cos(Number(a[0])), 0, 0])
      else if (c.method.startsWith('set:')) props[c.method.slice(4)] = String(a[0])
      else if (c.method === 'beginPath') path = []
      else if (['moveTo', 'lineTo', 'quadraticCurveTo', 'arc', 'rect', 'roundRect', 'closePath'].includes(c.method)) path.push({ op: c.method, args: a.map(Number) })
      else if (c.method === 'clip') {
        const src = a[0] as { ops?: Array<{ op: string; args: number[] }> } | undefined
        if (src?.ops !== undefined && a[1] === 'evenodd') clips = [...clips, loops(src.ops)]
      } else if ((c.method === 'fillRect' || c.method === 'fill') && (props.fillStyle === stock || props.globalCompositeOperation === 'destination-out')) {
        const [x, y, w, h] = a.map(Number) as [number, number, number, number]
        if (c.method === 'fillRect') knocks.push({ poly: [at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h)], i })
      } else if ((((c.method === 'stroke' || c.method === 'strokeRect') && props.strokeStyle !== stock) || ((c.method === 'fill' || c.method === 'fillRect') && props.fillStyle !== stock)) && props.globalCompositeOperation !== 'destination-out' && Number(props.globalAlpha ?? 1) > 0) {
        const src = a[0] as { ops?: Array<{ op: string; args: number[] }> } | undefined
        const ls = c.method === 'strokeRect' || c.method === 'fillRect' ? loops([{ op: 'rect', args: a.map(Number) }]) : loops(src?.ops ?? path)
        for (const l of ls) {
          for (let k = 1; k < l.length; k++) {
            const [p0, p1] = [l[k - 1] as V, l[k] as V]
            const n = Math.min(60, Math.max(1, Math.ceil(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 2)))
            for (let j = 0; j <= n; j++) {
              const q: V = [p0[0] + ((p1[0] - p0[0]) * j) / n, p0[1] + ((p1[1] - p0[1]) * j) / n]
              if (excluded(q)) continue
              if (bands.some((b) => inPoly(q, b))) { bad.push(`a line through lettering at ${q.map((v) => v.toFixed(0)).join(',')}`); return }
              strokes.push({ q, i })
            }
          }
        }
      } else if (c.method === 'fillText') {
        const text = String(a[0])
        const size = Number(/([\d.]+)px/.exec(props.font ?? '')?.[1] ?? 10)
        const w = text.length * 0.6 * size
        const [x, y] = [Number(a[1]), Number(a[2])]
        const x0 = props.textAlign === 'center' ? x - w / 2 : props.textAlign === 'right' || props.textAlign === 'end' ? x - w : x
        const [t0, t1] = props.textBaseline === 'middle' ? [y - 0.55 * size, y + 0.55 * size] : props.textBaseline === 'top' || props.textBaseline === 'hanging' ? [y, y + size] : props.textBaseline === 'bottom' ? [y - size, y] : [y - 0.8 * size, y + 0.25 * size]
        const pad = 0.8 * 0.25 * 0.72 * size
        const band: V[] = [at(x0 - pad, t0 - pad), at(x0 + w + pad, t0 - pad), at(x0 + w + pad, t1 + pad), at(x0 - pad, t1 + pad)]
        const under = strokes.filter((st) => inPoly(st.q, band) && !knocks.some((kn) => kn.i > st.i && inPoly(st.q, kn.poly)))
        if (under.length > 0) bad.push(`"${text}" lettered over a line at ${(under[0] as { q: V }).q.map((v) => v.toFixed(0)).join(',')}`)
        bands.push(band)
      }
    })
    return bad
  }

  it('breaks every line at a clear band round lettering: no stroke after a lettering runs inside its band, and every line under one is cleared before it, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        for (const f of [0, 60, 120, 200, 260, 300, 359]) {
          const found = lineThroughLettering(record(tl, f), tl.palette.bg)
          if (found.length > 0) bad.push(`${board} ${aspect} f${f}: ${found[0] as string}${found.length > 1 ? ` (+${found.length - 1})` : ''}`)
        }
      }
    }
    expect(bad).toEqual([])
  }, 1800000)

  it('names the main chip inside its outline on every frame its outline is drawn wholly in the frame, a third of its body wide along its longer side, with a pin 1 dot, and keeps its marking on the lid through the tilt, the pull and the last frame, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot as PlotScore
        const hp = tl.scene.parts.find((q) => q.hero === true)
        if (hp === undefined) { bad.push(`${board} ${aspect}: no main chip`); continue }
        const label = plot.hero.label
        const [long, short] = hp.w >= hp.h ? [hp.w, hp.h] : [hp.h, hp.w]
        for (let f = 0; f < atBeat(tl, plot.beats.tilt[0]) - 2; f += 8) {
          const t = plotClock(f, tl.totalFrames)
          const m = flatView(tl.scene, t, tl.width, tl.height)
          const k = Math.hypot(m[0], m[1])
          const c = apply(m, hp.x, hp.y)
          const r = 0.5 * Math.hypot(hp.w, hp.h) * k
          if (c[0] - r < 0 || c[0] + r > tl.width || c[1] - r < 0 || c[1] + r > tl.height || short * k < 40 * tl.width / 1080) continue
          const calls = record(tl, f)
          const outline = calls.some((q) => q.method === 'stroke' && (q.args[0] as { ops?: Array<{ op: string }> } | undefined)?.ops?.length === 5)
          if (!outline) continue
          const boxes = boxesOf(calls).filter((b) => b.text === label)
          const inside = boxes.find((b) => Math.hypot(b.x + b.w / 2 - c[0], b.y + b.h / 2 - c[1]) < 0.25 * short * k)
          if (inside === undefined) { bad.push(`${board} ${aspect} f${f}: the outline stands empty`); break }
          const cap = 0.73 * inside.size
          if (cap > 0.4 * short * k || (cap < 0.25 * short * k && label.length * 0.6 * inside.size < 0.7 * long * k)) { bad.push(`${board} ${aspect} f${f}: lettering ${(cap / (short * k)).toFixed(2)} of the body wide`); break }
          const dot = calls.findIndex((q, i) => q.method === 'arc' && Number(q.args[2]) > 0 && Math.abs(Number(q.args[2]) - 0.045 * short) < 1e-6 && calls.slice(i, i + 4).some((z) => z.method === 'fill'))
          if (plot.hero.pin1 !== undefined && dot < 0) { bad.push(`${board} ${aspect} f${f}: no pin 1 mark`); break }
        }
        for (const f of [atBeat(tl, plot.beats.tilt[0]) + 12, atBeat(tl, plot.beats.pull[1]), tl.totalFrames - 1]) {
          const words = texts(tl, f)
          if (!words.some((w) => w.length >= 3 && (label.includes(w) || w.includes(label)))) bad.push(`${board} ${aspect} f${f}: the lid carries no marking`)
        }
      }
    }
    expect(bad).toEqual([])
  }, 1800000)

  it('moves the signal at once: its head has drawn 3% of its ride by frame 10 and is never still for more than 12 frames before it arrives, on the eight films that ride a net', () => {
    const bad: string[] = []
    for (const board of RIDES.filter((b) => !b.startsWith('glasgow'))) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot as PlotScore
        const headAt = (f: number): [number, number] | undefined => {
          const t = plotClock(f, tl.totalFrames)
          const ys = drawnYellow(plot, t)
          const head = ys.reduce<(typeof ys)[number] | undefined>((a, q) => (a === undefined || q.t > a.t ? q : a), undefined)
          return head === undefined ? undefined : apply(flatView(tl.scene, t, tl.width, tl.height), head.q[0], head.q[1])
        }
        const ppm = tl.scene.material.pxPerMm
        const start = headAt(0)
        const t10 = plotClock(10, tl.totalFrames)
        const lens = plot.flow.path.map((sg) => Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]))
        const done = plot.flow.path.reduce((t, sg, i) => t + (lens[i] as number) * Math.min(1, Math.max(0, (t10 - sg.p0) / Math.max(1e-9, sg.p1 - sg.p0))), 0) / Math.max(1e-9, lens.reduce((t, l) => t + l, 0))
        const left = start !== undefined && done >= 0.03
        let still = 0
        let most = 0
        let at = 0
        let prev = plot.film.signature.kind === 'pair' ? undefined : (plot.flow.path.filter((sg) => plotClock(0, tl.totalFrames) >= sg.p0).at(-1)?.p1 ?? 0)
        for (let f = 1; f <= arrival(tl) - 6; f++) {
          const ys = drawnYellow(plot, plotClock(f, tl.totalFrames))
          const far = ys.reduce((a, q) => Math.max(a, q.t), -1)
          if (prev !== undefined && far <= prev + 1e-9) still += 1
          else still = 0
          prev = far
          if (still > most) at = f
          most = Math.max(most, still)
        }
        if (!left || most > 12) bad.push(`${board} ${aspect}: ${left ? 'left' : 'not left'} by f10, still ${most} frames to f${at} (${ppm.toFixed(0)} px/mm)`)
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  it('draws the ink along the strokes and never through a mask: no circle clips the plan on the ride, and every line drawn so far is one run along itself that the wave has reached, on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot as PlotScore
        const ink = plot.ink
        if (ink === undefined) continue
        for (const f of [20, 40, 60, 80]) {
          let arc = false
          for (const c of record(tl, f)) {
            if (c.method === 'beginPath') arc = false
            else if (c.method === 'arc') arc = true
            else if (c.method === 'clip' && c.args.length === 0 && arc) { bad.push(`${board} ${aspect} f${f}: clipped by a circle`); break }
          }
          const now = inkClock(ink, plotClock(f, tl.totalFrames))
          for (const l of revealed(tl.scene, ink, now).s.layers) {
            for (let i = 0; i + 6 < l.segs.length; i += 7) {
              const [x0, y0, x1, y1] = [l.segs[i] as number, l.segs[i + 1] as number, l.segs[i + 2] as number, l.segs[i + 3] as number]
              if (inkReach(ink, x0, y0) > now + 1e-6 || inkReach(ink, x1, y1) > now + 1e-6) { bad.push(`${board} ${aspect} f${f}: a line runs ahead of the wave`); break }
            }
          }
        }
      }
    }
    expect([...new Set(bad)]).toEqual([])
  }, 900000)

  it('draws the signal dashed where a body hides it, in the same heavy pen, so its run can be followed to the chip in the tilt, the pull and the last frame, on the four iCEBreaker films', () => {
    const bad: string[] = []
    for (const aspect of ASPECTS4) {
      const tl = plotTimeline('icebreaker.kicad_pcb', { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
      const plot = tl.scene.plot as PlotScore
      const yellow = signalInk(tl.palette)
      for (const f of [atBeat(tl, (plot.beats.tilt[0] + plot.beats.tilt[1]) / 2), atBeat(tl, plot.beats.pull[1]), tl.totalFrames - 1]) {
        let style = ''
        let lw = 1
        let dashed = false
        let n = 0
        for (const c of record(tl, f)) {
          if (c.method === 'set:strokeStyle') style = String(c.args[0])
          else if (c.method === 'set:lineWidth') lw = Number(c.args[0])
          else if (c.method === 'setLineDash') dashed = Array.isArray(c.args[0]) && (c.args[0] as unknown[]).length > 0
          else if (c.method === 'stroke' && style === yellow && dashed && lw >= SIGNAL_HEAVY * tl.width) n += 1
        }
        if (n === 0) bad.push(`icebreaker ${aspect} f${f}: no hidden run`)
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('takes a part for an LED by what it is, not by a D reference: a protection diode is no light, an LED is one by its value or footprint', () => {
    expect(lightEnd('D3', { value: 'PESD5V0S1BL', footprint: 'D_SOD-323' })).toBe(false)
    expect(lightEnd('D1', { value: 'LED_RGB', footprint: 'LED_0603_1608Metric' })).toBe(true)
    expect(lightEnd('LED1', { value: 'red' })).toBe(true)
    expect(lightEnd('U4', { value: 'XR22417' })).toBe(false)
  })

  it('draws no ghost on the ride: from frame 0 to the chip\'s arrival no ink line stands under 0.4 strength and none is dashed but the hidden wiring\'s dots (the paper\'s printed grid, under the pen\'s width, is the paper), on twelve films', () => {
    const bad: string[] = []
    for (const board of RIDES) {
      for (const aspect of ASPECTS4) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const ink = sheetInk(tl.palette)
        for (let f = 0; f <= arrival(tl); f += 4) {
          let style = ''
          let alpha = 1
          let dash: number[] = []
          let lw = 1
          let m = [1, 0, 0, 1, 0, 0]
          const u = Math.min(tl.width, tl.height) / 1080
          const saved: Array<[string, number, number[], number, number[]]> = []
          for (const c of record(tl, f)) {
            if (c.method === 'save') saved.push([style, alpha, dash, lw, m])
            else if (c.method === 'restore') [style, alpha, dash, lw, m] = saved.pop() ?? [style, alpha, dash, lw, m]
            else if (c.method === 'set:strokeStyle') style = String(c.args[0])
            else if (c.method === 'set:globalAlpha') alpha = Number(c.args[0])
            else if (c.method === 'set:lineWidth') lw = Number(c.args[0])
            else if (c.method === 'setTransform') m = c.args.map(Number)
            else if (c.method === 'setLineDash') dash = c.args[0] as number[]
            else if (c.method === 'stroke' && style === ink && lw * Math.sqrt(Math.abs((m[0] as number) * (m[3] as number) - (m[1] as number) * (m[2] as number))) >= u && (alpha < 0.4 - 1e-9 || (dash.length > 0 && dash[0] !== 0))) bad.push(`${board} ${aspect} f${f}: ${alpha.toFixed(2)}${dash.length > 0 ? ' dashed' : ''}`)
          }
        }
      }
    }
    expect([...new Set(bad)].slice(0, 12)).toEqual([])
  }, 600000)

  it('draws the ride\'s wide copper at its true width as an outline in the copper pen, as the bus\'s neighbours are, when the ride is close', () => {
    const tl = plotTimeline('icebreaker.kicad_pcb', { aspect: '9:16', output: { ...ASPECT_SIZE['9:16'], fps: 30 } })
    const ink = sheetInk(tl.palette)
    let style = ''
    let lw = 1
    let m = [1, 0, 0, 1, 0, 0]
    let widest = 0
    for (const c of record(tl, 60)) {
      if (c.method === 'set:strokeStyle') style = String(c.args[0])
      else if (c.method === 'set:lineWidth') lw = Number(c.args[0])
      else if (c.method === 'setTransform') m = c.args.map(Number)
      else if (c.method === 'stroke' && style === ink) widest = Math.max(widest, lw * Math.sqrt(Math.abs((m[0] as number) * (m[3] as number) - (m[1] as number) * (m[2] as number))))
    }
    expect(widest).toBeGreaterThan(3 * 2.4 * (Math.min(tl.width, tl.height) / 1080))
  }, 600000)

  it('draws every track as one stroke in the pen\'s weight from the chip\'s arrival on: in the push and the tilt no track is stroked wide in ink and then hollowed in the paper\'s colour, on twelve films', () => {
    const bad: string[] = []
    for (const board of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as const) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const paper = tl.palette.bg
        const ink = sheetInk(tl.palette)
        const pen = 2.4 * (Math.min(tl.width, tl.height) / 1080)
        for (const f of [240, 250, 260]) {
          let style = ''
          let lw = 1
          let m = [1, 0, 0, 1, 0, 0]
          let hollow = 0
          const inked = new Set<unknown>()
          for (const c of record(tl, f)) {
            if (c.method === 'set:strokeStyle') style = String(c.args[0])
            else if (c.method === 'set:lineWidth') lw = Number(c.args[0])
            else if (c.method === 'setTransform') m = c.args.map(Number)
            else if (c.method === 'stroke' && c.args[0] !== undefined) {
              const wide = lw * Math.sqrt(Math.abs((m[0] as number) * (m[3] as number) - (m[1] as number) * (m[2] as number))) > 3 * pen
              if (style === ink && wide) inked.add(c.args[0])
              else if (style === paper && inked.has(c.args[0])) hollow += 1
            }
          }
          if (hollow > 0) bad.push(`${board} ${aspect} f${f}: ${hollow} hollow strokes`)
        }
      }
    }
    expect(bad).toEqual([])
  }, 900000)

  it('keeps the signal in the heavy pen through the tilt and in the end view: its widest yellow stroke is at least 0.5% of the frame\'s width, on twelve films', () => {
    const bad: string[] = []
    for (const board of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as const) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot
        if (plot === undefined) throw new Error('no plot')
        const yellow = signalInk(tl.palette)
        for (const f of [atBeat(tl, plot.beats.tilt[0]), atBeat(tl, (plot.beats.tilt[0] + plot.beats.tilt[1]) / 2), atBeat(tl, plot.beats.tilt[1]), atBeat(tl, plot.beats.pull[1]), tl.totalFrames - 1]) {
          let style = ''
          let lw = 1
          let m = [1, 0, 0, 1, 0, 0]
          const saved: Array<[string, number, number[]]> = []
          let widest = 0
          for (const c of record(tl, f)) {
            if (c.method === 'save') saved.push([style, lw, m])
            else if (c.method === 'restore') [style, lw, m] = saved.pop() ?? [style, lw, m]
            else if (c.method === 'set:strokeStyle') style = String(c.args[0])
            else if (c.method === 'set:lineWidth') lw = Number(c.args[0])
            else if (c.method === 'setTransform') m = c.args.map(Number)
            else if (c.method === 'stroke' && style === yellow) widest = Math.max(widest, lw * Math.sqrt(Math.abs((m[0] as number) * (m[3] as number) - (m[1] as number) * (m[2] as number))))
          }
          if (widest < SIGNAL_HEAVY * tl.width) bad.push(`${board} ${aspect} f${f}: ${((100 * widest) / tl.width).toFixed(2)}%`)
        }
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('shows the main chip\'s whole top face in the end view, from the frame the pull lands to the last, on twelve films', () => {
    const bad: string[] = []
    for (const board of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as const) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const plot = tl.scene.plot
        if (plot === undefined) throw new Error('no plot')
        for (let f = atBeat(tl, plot.beats.pull[1]); f < tl.totalFrames; f += 4) {
          const cover = chipCover(heroFrame(tl, f).view, tl.scene.parts)
          if (cover > 0) bad.push(`${board} ${aspect} f${f}: ${(100 * cover).toFixed(1)}% covered`)
        }
      }
    }
    expect(bad.slice(0, 12)).toEqual([])
  }, 600000)

  it('draws no solid yellow over a body in the end view: the signal is copper on the board, under every part, and only its hidden run is drawn over a body, dashed and inside that body\'s outline, on twelve films', () => {
    const bad: string[] = []
    for (const board of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as const) {
        const tl = plotTimeline(board, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const yellow = signalInk(tl.palette)
        const calls = record(tl, tl.totalFrames - 1)
        const last = calls.reduce((k, c, i) => ((c.method === 'set:fillStyle' && c.args[0] === tl.palette.bg) ? i : k), -1)
        let style = ''
        let dashed = false
        let depth = 0
        const clips: number[] = []
        let after = 0
        for (const c of calls.slice(last + 1)) {
          if (c.method === 'save') { depth += 1; clips.push(clips.at(-1) ?? 0) }
          else if (c.method === 'restore') { depth -= 1; clips.pop() }
          else if (c.method === 'clip' && clips.length > 0) clips[clips.length - 1] = 1
          else if (c.method === 'set:strokeStyle' || c.method === 'set:fillStyle') style = String(c.args[0])
          else if (c.method === 'setLineDash') dashed = Array.isArray(c.args[0]) && (c.args[0] as unknown[]).length > 0
          else if ((c.method === 'stroke' || c.method === 'fill') && style === yellow && !(c.method === 'stroke' && dashed && (clips.at(-1) ?? 0) === 1 && depth > 0)) after += 1
        }
        if (last < 0 || after > 0) bad.push(`${board} ${aspect}: ${after} solid yellow marks after the last body`)
      }
    }
    expect(bad).toEqual([])
  }, 600000)
})

/** the main chip's name as one frame letters it, measured in its lid's own frame, the top face the renderer draws (the stamp's jolt carried): the body's height as a share of its full height, from how far that face stands above its outline on the board; the name's capital height and centre as shares of the lid's shorter side, its pin 1 dot's radius likewise; whether the lid letters it; and the px of line drawn before the lid's paper that the paper leaves showing inside the face */
const handName = (tl: TraceTimeline, hp: TracePart, f: number): { rise: number; lid: boolean; h?: number; c?: Xy; dot?: number; through: number } => {
  const view = heroFrame(tl, f).view
  const plot = tl.scene.plot as PlotScore
  const stamp = plot.events.find((e) => e.kind === 'stamp')
  const jolt = stamp === undefined ? undefined : ([[6, -4], [-3, 2]] as Xy[])[f - Math.round(plotFrame(stamp.t0, tl.totalFrames))]
  const J: Xy = jolt === undefined ? [0, 0] : [(jolt[0] * Math.min(tl.width, tl.height)) / 1080, (jolt[1] * Math.min(tl.width, tl.height)) / 1080]
  const co = Math.cos(hp.rot)
  const si = Math.sin(hp.rot)
  const G = (lx: number, ly: number, z: number): Xy => { const q = axoPoint(view, [hp.x + lx * co - ly * si, hp.y + lx * si + ly * co], z); return [q[0] + J[0], q[1] + J[1]] }
  const ground = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Xy[]).map(([a, b]) => G((a * hp.w) / 2, (b * hp.h) / 2, 0))
  const full = G(0, 0, 0)[1] - G(0, 0, hp.z)[1]
  const span = Math.max(...ground.map((q) => q[0])) - Math.min(...ground.map((q) => q[0]))
  const stock = tl.palette.bg.toLowerCase()
  let m = [1, 0, 0, 1, 0, 0]
  const saved: Array<[number[], number, string]> = []
  let alpha = 1
  let filter = 'none'
  let fill = ''
  let ink = ''
  let width = 1
  let font = 10
  let ops: Array<[string, Xy, number?]> = []
  const T = (x: number, y: number): Xy => [(m[0] as number) * x + (m[2] as number) * y + (m[4] as number), (m[1] as number) * x + (m[3] as number) * y + (m[5] as number)]
  const opacity = (): number => Number(/opacity\(([\d.]+)\)/.exec(filter)?.[1] ?? 1)
  let top: Xy[] | undefined
  const strokes: Array<{ pts: Array<[string, Xy]>; w: number; a: number; i: number }> = []
  const papers: Array<{ i: number; area: number; a: number; poly: Xy[] }> = []
  let lastFill: Xy | undefined
  let name: { i: number; up: Xy; c: Xy; dot?: Xy } | undefined
  record(tl, f).forEach((c, i) => {
    const a = c.args
    if (c.method === 'setTransform') m = a.map(Number)
    else if (c.method === 'save') saved.push([m, alpha, filter])
    else if (c.method === 'restore') [m, alpha, filter] = saved.pop() ?? [m, alpha, filter]
    else if (c.method === 'set:globalAlpha') alpha = Number(a[0])
    else if (c.method === 'set:filter') filter = String(a[0])
    else if (c.method === 'set:fillStyle') fill = String(a[0]).toLowerCase()
    else if (c.method === 'set:strokeStyle') ink = String(a[0]).toLowerCase()
    else if (c.method === 'set:lineWidth') width = Number(a[0])
    else if (c.method === 'set:font') font = Number.parseFloat(String(a[0]))
    else if (c.method === 'beginPath') ops = []
    else if (c.method === 'moveTo' || c.method === 'lineTo') ops.push([c.method, T(Number(a[0]), Number(a[1]))])
    else if (c.method === 'arc') ops.push(['arc', T(Number(a[0]), Number(a[1])), Number(a[2])])
    else if (c.method === 'stroke' && ink !== stock) {
      const p2 = typeof a[0] === 'object' && a[0] !== null ? (a[0] as { ops: Array<{ op: string; args: number[] }> }) : undefined
      const pts = p2 !== undefined ? p2.ops.map((q): [string, Xy] => [q.op, T(q.args[q.args.length - 2] as number, q.args[q.args.length - 1] as number)]) : ops.filter(([op]) => op !== 'arc').map(([op, q]): [string, Xy] => [op, q])
      strokes.push({ pts, w: width * Math.sqrt(Math.abs((m[0] as number) * (m[3] as number) - (m[1] as number) * (m[2] as number))), a: alpha * opacity(), i })
      const quad = pts.map(([, q]) => q)
      if (p2 === undefined && quad.length === 4) {
        const dys = quad.map((q, k) => (ground[k] as Xy)[1] - q[1])
        if (quad.every((q, k) => Math.abs(q[0] - (ground[k] as Xy)[0]) < 0.01 * span) && Math.max(...dys) - Math.min(...dys) < 0.01 * span && Math.min(...dys) > 0.5) top = quad
      }
    } else if (c.method === 'fill' && a.length === 0) {
      const arcs = ops.filter(([op]) => op === 'arc')
      if (fill === stock) papers.push({ i, area: polyArea(ops.map(([, q]) => q)), a: alpha * opacity(), poly: ops.map(([, q]) => q) })
      else lastFill = arcs.length === 1 ? [(m[0] as number) * (arcs[0]?.[2] as number), (m[1] as number) * (arcs[0]?.[2] as number)] : undefined
    } else if (c.method === 'fillText' && alpha * opacity() >= 0.5 && String(a[0]) === plot.hero.label) {
      name = { i, up: [(m[2] as number) * font * CAP, (m[3] as number) * font * CAP], c: T(Number(a[1]), Number(a[2])), ...(lastFill === undefined ? {} : { dot: lastFill }) }
    }
  })
  const face = top ?? ground
  const o: Xy = [face.reduce((t, q) => t + q[0], 0) / 4, face.reduce((t, q) => t + q[1], 0) / 4]
  const ex: Xy = [((face[1] as Xy)[0] - (face[0] as Xy)[0]) / hp.w, ((face[1] as Xy)[1] - (face[0] as Xy)[1]) / hp.w]
  const ey: Xy = [((face[3] as Xy)[0] - (face[0] as Xy)[0]) / hp.h, ((face[3] as Xy)[1] - (face[0] as Xy)[1]) / hp.h]
  const det = ex[0] * ey[1] - ey[0] * ex[1]
  const toLid = (v: Xy): Xy => [(ey[1] * v[0] - ey[0] * v[1]) / det, (-ex[1] * v[0] + ex[0] * v[1]) / det]
  const edge = Math.min(hp.w, hp.h)
  const grid = Array.from({ length: 64 }, (_, k): Xy => { const u = ((k % 8) + 0.5) / 8; const v = (Math.floor(k / 8) + 0.5) / 8; const a0 = face[0] as Xy; const a1 = face[1] as Xy; const a3 = face[3] as Xy; return [a0[0] + (a1[0] - a0[0]) * u + (a3[0] - a0[0]) * v, a0[1] + (a1[1] - a0[1]) * u + (a3[1] - a0[1]) * v] })
  const paper = top === undefined ? undefined : papers.filter((q) => q.poly.length >= 3 && grid.filter((g) => inPoly(g, q.poly)).length >= 58 && q.area <= 6 * polyArea(face)).reduce<(typeof papers)[number] | undefined>((b, q) => (b === undefined || q.area < b.area ? q : b), undefined)
  let through = 0
  if (top !== undefined && paper !== undefined) {
    const lid = top
    for (const st of strokes.filter((q) => q.i < paper.i)) {
      st.pts.forEach(([op, q], k) => {
        const p0 = st.pts[k - 1]?.[1]
        if (op !== 'lineTo' || p0 === undefined) return
        const len = Math.hypot(q[0] - p0[0], q[1] - p0[1])
        const n = Math.max(1, Math.ceil(len / 2))
        for (let j = 0; j < n; j++) if (inPoly([p0[0] + ((q[0] - p0[0]) * (j + 0.5)) / n, p0[1] + ((q[1] - p0[1]) * (j + 0.5)) / n], lid)) through += (len / n) * st.w * st.a * (1 - paper.a)
      })
    }
  }
  return {
    rise: top === undefined ? 0 : ((ground[0] as Xy)[1] - (top[0] as Xy)[1]) / full,
    lid: top !== undefined && name !== undefined && paper !== undefined && name.i > paper.i,
    ...(name === undefined ? {} : { h: Math.hypot(...toLid(name.up)) / edge, c: toLid([name.c[0] - o[0], name.c[1] - o[1]]).map((v) => v / edge) as Xy, ...(name.dot === undefined ? {} : { dot: Math.hypot(...toLid(name.dot)) / edge }) }),
    through
  }
}

const handOffs = new Map<string, Array<{ f: number } & ReturnType<typeof handName>>>()

/** each of the twelve films as rendered, from the last frame the plan letters the main chip's name to the film's last frame */
const handOff = (board: string, aspect: string): Array<{ f: number } & ReturnType<typeof handName>> => {
  const key = `${board} ${aspect}`
  const known = handOffs.get(key)
  if (known !== undefined) return known
  const tl = filmTimeline(board, aspect)
  const hp = tl.scene.parts.find((q) => q.hero === true)
  if (hp === undefined) throw new Error('no chip')
  const rows: Array<{ f: number } & ReturnType<typeof handName>> = []
  for (let f = atBeat(tl, (tl.scene.plot as PlotScore).beats.tilt[0]) + 8; f < tl.totalFrames; f++) rows.push({ f, ...handName(tl, hp, f) })
  const first = rows.findIndex((r) => r.lid)
  const out = first < 1 ? rows : rows.slice(first - 1)
  handOffs.set(key, out)
  return out
}

const TWELVE = ['glasgow', 'icebreaker', 'kit-dev-coldfire-xilinx_5213'].flatMap((b) => (['16:9', '4:5', '9:16', '1:1'] as const).map((a) => [b, a] as const))

describe('blueprint round 14: the name\'s hand-off from the plan to the lid', () => {
  it('hands the main chip\'s name to the lid in place: from the last plan frame to the last frame its height on the lid changes by at most 5% and its centre moves at most 2% of the lid\'s shorter side between neighbouring frames, in the lid\'s own frame, on the twelve films as they are rendered', () => {
    const bad: string[] = []
    for (const [board, aspect] of TWELVE) {
      const rows = handOff(board, aspect)
      if (!rows.some((r) => r.lid)) bad.push(`${board} ${aspect}: the lid never letters it`)
      rows.forEach((r, i) => {
        const q = rows[i - 1]
        if (q?.h === undefined || q.c === undefined) return
        if (r.h === undefined || r.c === undefined) { bad.push(`${board} ${aspect} f${r.f}: no name`); return }
        if (Math.abs(r.h / q.h - 1) > 0.05) bad.push(`${board} ${aspect} f${r.f}: height ${(100 * Math.abs(r.h / q.h - 1)).toFixed(1)}%`)
        if (Math.hypot(r.c[0] - q.c[0], r.c[1] - q.c[1]) > 0.02) bad.push(`${board} ${aspect} f${r.f}: centre ${(100 * Math.hypot(r.c[0] - q.c[0], r.c[1] - q.c[1])).toFixed(1)}%`)
      })
    }
    expect(bad.slice(0, 12)).toEqual([])
  }, 3600000)

  it('keeps the pin 1 dot through the hand-off: from the last plan frame to the last frame the dot stands beside the name on every frame, at one size on the lid, on the twelve films as they are rendered', () => {
    const bad: string[] = []
    for (const [board, aspect] of TWELVE) {
      const rows = handOff(board, aspect)
      const sizes = rows.map((r) => r.dot)
      const missing = rows.filter((r) => r.dot === undefined).map((r) => r.f)
      if (missing.length > 0) bad.push(`${board} ${aspect}: no dot on ${missing.length} frames from f${missing[0]}`)
      const got = sizes.filter((v): v is number => v !== undefined)
      if (got.length > 0 && Math.max(...got) - Math.min(...got) > 1e-3) bad.push(`${board} ${aspect}: dot ${Math.min(...got).toFixed(3)} to ${Math.max(...got).toFixed(3)}`)
    }
    expect(bad).toEqual([])
  }, 3600000)

  it('draws the main chip\'s lid opaque: on every frame its lid is drawn, no line drawn before its paper shows through inside the lid, on the twelve films as they are rendered', () => {
    const bad: string[] = []
    for (const [board, aspect] of TWELVE) {
      const worst = handOff(board, aspect).reduce((b, r) => (r.through > b.through ? r : b), { f: -1, through: 0 })
      if (worst.through > 0) bad.push(`${board} ${aspect} f${worst.f}: ${worst.through.toFixed(0)} px`)
    }
    expect(bad).toEqual([])
  }, 3600000)
})

describe('blueprint round 15: the main chip\'s name enters whole', () => {
  it('never letters part of the main chip\'s name, and draws its pin 1 dot only with the name: from the first frame to the tilt, every copy drawn has its whole box, its width by its capital height, inside the frame, and a dot only on a frame that letters the name, its own box inside the frame, on the twelve films as they are rendered', () => {
    const bad: string[] = []
    for (const [board, aspect] of TWELVE) {
      const tl = filmTimeline(board, aspect)
      const label = (tl.scene.plot as PlotScore).hero.label
      const hp = tl.scene.parts.find((q) => q.hero === true)
      const short = hp === undefined ? 0 : Math.min(hp.w, hp.h)
      const cut: number[] = []
      const lone: number[] = []
      for (let f = 0; f < atBeat(tl, (tl.scene.plot as PlotScore).beats.tilt[0]); f++) {
        let m = [1, 0, 0, 1, 0, 0]
        let font = 10
        const calls = record(tl, f)
        const named = calls.some((c) => c.method === 'fillText' && String(c.args[0]) === label)
        let dm = [1, 0, 0, 1, 0, 0]
        const dots = calls.filter((c, i) => {
          if (c.method === 'setTransform') dm = c.args.map(Number)
          if (c.method !== 'arc' || Math.abs(Number(c.args[2]) - 0.045 * short) > 1e-6 || !calls.slice(i, i + 4).some((z) => z.method === 'fill')) return false
          const [x, y, r] = [Number(c.args[0]), Number(c.args[1]), Number(c.args[2])]
          const whole = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Xy[]).every(([a, b]) => {
            const sx = (dm[0] as number) * (x + a * r) + (dm[2] as number) * (y + b * r) + (dm[4] as number)
            const sy = (dm[1] as number) * (x + a * r) + (dm[3] as number) * (y + b * r) + (dm[5] as number)
            return sx >= 0 && sy >= 0 && sx <= tl.width && sy <= tl.height
          })
          return !named || !whole
        })
        if (dots.length > 0) lone.push(f)
        const out = calls.some((c) => {
          if (c.method === 'setTransform') m = c.args.map(Number)
          if (c.method === 'set:font') font = Number.parseFloat(String(c.args[0]))
          if (c.method !== 'fillText' || String(c.args[0]) !== label) return false
          const [x, y] = [Number(c.args[1]), Number(c.args[2])]
          const [hw, hh] = [0.3 * font * label.length, 0.5 * CAP * font]
          return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Xy[]).some(([a, b]) => {
            const sx = (m[0] as number) * (x + a * hw) + (m[2] as number) * (y + b * hh) + (m[4] as number)
            const sy = (m[1] as number) * (x + a * hw) + (m[3] as number) * (y + b * hh) + (m[5] as number)
            return sx < 0 || sy < 0 || sx > tl.width || sy > tl.height
          })
        })
        if (out) cut.push(f)
      }
      if (cut.length > 0) bad.push(`${board} ${aspect}: ${cut.length} frames from f${cut[0]}`)
      if (lone.length > 0) bad.push(`${board} ${aspect}: the dot without the whole name or cut on ${lone.length} frames from f${lone[0]}`)
    }
    expect(bad).toEqual([])
  }, 3600000)
})

describe('blueprint round 15: the main chip\'s body rises', () => {
  it('raises the main chip\'s body out of the plan: from the board to its full height over at least six frames, its height changing by at most a quarter of the full height between neighbouring frames, on the twelve films as they are rendered', () => {
    const bad: string[] = []
    for (const [board, aspect] of TWELVE) {
      const rows = handOff(board, aspect)
      const from = rows.findIndex((r) => r.rise > 1e-3)
      const to = rows.findIndex((r) => r.rise >= 0.999)
      if (from < 0 || to < 0) { bad.push(`${board} ${aspect}: never stands`); continue }
      if (to - from + 1 < 6) bad.push(`${board} ${aspect}: f${(rows[from] as { f: number }).f} to f${(rows[to] as { f: number }).f}, ${to - from + 1} frames`)
      rows.forEach((r, k) => {
        const q = rows[k - 1]
        if (q !== undefined && Math.abs(r.rise - q.rise) > 0.25) bad.push(`${board} ${aspect} f${r.f}: ${(100 * Math.abs(r.rise - q.rise)).toFixed(0)}%`)
      })
    }
    expect(bad.slice(0, 12)).toEqual([])
  }, 3600000)
})

describe('blueprint round 16: no route notes', () => {
  it('letters no note or caption about the copper on any frame of the twelve films as they are rendered: every text drawn is the main chip\'s name, the section\'s own words, a part\'s own marking, or the title sheet\'s name and stamp', () => {
    const bad: string[] = []
    for (const [board, aspect] of TWELVE) {
      const tl = filmTimeline(board, aspect)
      const plot = tl.scene.plot as PlotScore
      const whole = new Set([plot.hero.label, ...(plot.section === undefined ? [] : ['A', SECTION_TITLE, ...plot.section.layers.map((l) => l.name)]), ...plot.bodies.flatMap((b) => lidWords(b.value))])
      const stamp = plot.facts.version !== undefined ? `REV ${plot.facts.version.replace(/^rev\.?\s*/i, '').toUpperCase()}` : plot.facts.date ?? ''
      const growing = [...plot.sheet.name.lines, stamp].filter((l) => l.length > 0)
      const seen = new Set<string>()
      for (let f = 0; f < tl.totalFrames; f++) {
        for (const t of texts(tl, f)) {
          if (whole.has(t) || growing.some((l) => t.length > 0 && l.startsWith(t)) || seen.has(t)) continue
          seen.add(t)
          bad.push(`${board} ${aspect} f${f}: "${t}"`)
        }
      }
    }
    expect(bad).toEqual([])
  }, 3600000)
})
