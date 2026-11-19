import './test-recorder'
import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, compileTimeline, joinOf, montageShot } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, MontageScore, TraceTimeline } from '@silk-reel/choreo'
import type { BoardModel } from '@silk-reel/ingest'
import { dotAt, drawMontageFrame } from './montage-draw'
import type { TypeBox } from './montage-draw'
import { asCtx, currentRecorder } from './test-recorder'
import { boardModel } from '../../choreo/test/helpers'

const compile = (b: BoardModel, aspect: Aspect = '4:5'): TraceTimeline => {
  const config: FilmConfig = { style: 'montage', aspect, knobs: {}, seed: 3, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 } }
  const tl = compileTimeline(b, config)
  if (tl.style !== 'montage') throw new Error('expected a montage timeline')
  return tl
}

const ctxOf = (): CanvasRenderingContext2D => {
  const ctx = asCtx(currentRecorder())
  ctx.measureText = (text: string): TextMetrics => ({ width: Array.from(text).length * 0.6 * Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 10) }) as TextMetrics
  return ctx
}

const score = (tl: TraceTimeline): MontageScore => tl.scene.montage as MontageScore

interface Drawn { calls: Array<{ method: string; args: unknown[] }>; types: TypeBox[] }

const record = (tl: TraceTimeline, frame: number): Drawn => {
  const rec = currentRecorder()
  rec.reset()
  const types: TypeBox[] = []
  drawMontageFrame(ctxOf(), tl, frame, types)
  return { calls: rec.calls.map((c) => ({ method: c.method, args: [...c.args] })), types }
}

const textSizes = (calls: Drawn['calls']): number[] => {
  let font = ''
  const out: number[] = []
  for (const c of calls) {
    if (c.method === 'set:font') font = String(c.args[0])
    if (c.method === 'fillText') out.push(Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]))
  }
  return out
}

const films = (): Array<[string, TraceTimeline]> => ([['icebreaker.kicad_pcb', '4:5'], ['glasgow.kicad_pcb', '9:16'], ['StickHub.kicad_pcb', '16:9']] as const).map(([b, a]) => [`${b} ${a}`, compile(boardModel(b), a)])

const hit = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): boolean => a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5

describe('montage draw', { timeout: 600_000 }, () => {
  const all = films()

  it.each(all)('keeps type off the dot and off other type, and sets the name on a clear box that nothing else enters, in every frame of %s', (_, tl) => {
    const m = score(tl)
    const ctx = ctxOf()
    for (let f = 0; f < tl.totalFrames; f++) {
      const { calls, types } = record(tl, f)
      for (const [i, a] of types.entries()) {
        for (const b of types.slice(i + 1)) expect(hit(a, b), `frame ${f}: "${a.text}" and "${b.text}"`).toBe(false)
        if (!a.crop) expect(a.x0 >= 0 && a.y0 >= 0 && a.x1 <= tl.width && a.y1 <= tl.height, `frame ${f}: "${a.text}" leaves the frame`).toBe(true)
      }
      const d = dotAt(ctx, tl, f)
      const p = f > 0 && montageShot(m, f - 1) === montageShot(m, f) ? dotAt(ctx, tl, f - 1) : d
      const reach = { x0: Math.min(d.x, p.x) - d.r - 1, y0: Math.min(d.y, p.y) - d.r - 1, x1: Math.max(d.x, p.x) + d.r + 1, y1: Math.max(d.y, p.y) + d.r + 1 }
      for (const t of types) if (!t.stop) expect(hit(t, reach), `frame ${f}: the dot enters "${t.text}"`).toBe(false)
      if (montageShot(m, f).hit !== undefined) continue
      const clears = new Set(types.map((t) => `${t.x0},${t.y0}`))
      const first = calls.findIndex((c) => c.method === 'fillRect' && clears.has(`${c.args[0] as number},${c.args[1] as number}`))
      if (first < 0) continue
      let path: number[][] = []
      for (const c of calls.slice(first)) {
        if (c.method === 'beginPath') path = []
        if (c.method === 'moveTo' || c.method === 'lineTo' || c.method === 'arc') path.push(c.args.slice(0, 2) as number[])
        if (c.method === 'fillRect') expect(clears.has(`${c.args[0] as number},${c.args[1] as number}`), `frame ${f}: a fill after the type that is no clear box`).toBe(true)
        if (c.method === 'fill' || c.method === 'stroke' || c.method === 'drawImage' || c.method === 'strokeRect') {
          expect(c.method === 'fill' || c.method === 'stroke', `frame ${f}: ${c.method} after the type`).toBe(true)
          for (const [x, y] of path) expect((x as number) >= reach.x0 && (x as number) <= reach.x1 && (y as number) >= reach.y0 && (y as number) <= reach.y1, `frame ${f}: a ${c.method} after the type that is not the dot`).toBe(true)
        }
      }
    }
  })

  it.each(all)('keeps the dot in the frame and jumps it only on a cut or rides it with a whip or the fall: %s', (_, tl) => {
    const m = score(tl)
    const ctx = ctxOf()
    const track = Array.from({ length: tl.totalFrames }, (_, f) => dotAt(ctx, tl, f))
    for (const [f, d] of track.entries()) {
      expect(d.x - d.r >= -0.5 && d.x + d.r <= tl.width + 0.5 && d.y - d.r >= -0.5 && d.y + d.r <= tl.height + 0.5, `frame ${f}`).toBe(true)
      const prev = track[f - 1]
      if (prev === undefined || montageShot(m, f - 1) !== montageShot(m, f)) continue
      if (joinOf(m, f)?.b.hit?.into === 'whip' || montageShot(m, f).hit?.whip === true || montageShot(m, f).kind === 'fall') continue
      expect(Math.hypot(d.x - prev.x, d.y - prev.y), `frame ${f}`).toBeLessThan(0.2 * Math.max(tl.width, tl.height))
    }
    const end = track.at(-1) as (typeof track)[number]
    expect(Math.hypot(end.x - (track[0]?.x ?? 0), end.y - (track[0]?.y ?? 0))).toBeLessThan(0.5)
  })

  it.each(all)('clears a ring of 1.5 dot diameters around the dot while it rides and inks it apart from the vias: %s', (_, tl) => {
    const m = score(tl)
    const ctx = ctxOf()
    for (const s of m.shots.filter((x) => x.kind === 'run' || x.kind === 'pad')) {
      for (let f = s.f0; f < s.f1; f++) {
        const { calls } = record(tl, f)
        const d = dotAt(ctx, tl, f)
        let ink = ''
        let screen = true
        for (const [i, c] of calls.entries()) {
          if (c.method === 'set:fillStyle') ink = String(c.args[0])
          if (c.method === 'setTransform') screen = (c.args as number[]).join(',') === '1,0,0,1,0,0'
          if (c.method !== 'arc' || !screen || calls.slice(i).every((x) => x.method !== 'fill')) continue
          const [x, y, r] = c.args as number[]
          if (Math.hypot((x as number) - d.x, (y as number) - d.y) < 0.5) continue
          expect(Math.hypot((x as number) - d.x, (y as number) - d.y) - (r as number), `frame ${f}`).toBeGreaterThanOrEqual(3 * d.r - 0.5)
          expect(ink).not.toBe(d.ink)
        }
      }
    }
  })

  it('sets every readable text with capitals at 2.4% of the frame width or more, in every aspect', () => {
    for (const aspect of Object.keys(ASPECT_SIZE) as Aspect[]) {
      for (const b of ['glasgow.kicad_pcb', 'StickHub.kicad_pcb']) {
        const tl = compile(boardModel(b), aspect)
        for (const s of score(tl).shots) {
          for (const f of [s.f0 + 1, Math.floor((s.f0 + s.f1) / 2), s.f1 - 1]) {
            const sizes = textSizes(record(tl, f).calls)
            if (sizes.length === 0) continue
            expect(Math.min(...sizes) * 0.68, `${b} ${aspect} ${s.kind} ${f}`).toBeGreaterThanOrEqual(0.024 * tl.width - 0.5)
          }
        }
      }
    }
  })

  it.each(all)('ends on frame 0: the last frame draws exactly what the first frame draws: %s', (_, tl) => {
    const drawn = (calls: Drawn['calls']): string => {
      let font = ''
      return JSON.stringify(calls.flatMap((c) => {
        if (c.method === 'set:font') font = String(c.args[0])
        return c.method === 'set:font' ? [] : c.method === 'fillText' ? [{ ...c, font }] : [c]
      }))
    }
    expect(drawn(record(tl, tl.totalFrames - 1).calls)).toBe(drawn(record(tl, 0).calls))
  })

  it('draws every shot of a board with no vias and a one-net board', () => {
    const glasgow = boardModel('glasgow.kicad_pcb')
    const bare: BoardModel = { ...glasgow, copper: Object.fromEntries(Object.entries(glasgow.copper).map(([k, c]) => [k, { ...c, vias: [] }])) }
    const ice = boardModel('icebreaker.kicad_pcb')
    const first = ice.nets.find((n) => n.name.length > 0) as BoardModel['nets'][number]
    const one: BoardModel = { ...ice, nets: [first], copper: Object.fromEntries(Object.entries(ice.copper).map(([k, c]) => [k, { ...c, traces: c.traces.filter((t) => t.netId === first.id) }])) }
    for (const [b, aspect] of [[bare, '4:5'], [one, '1:1']] as const) {
      const tl = compile(b, aspect)
      for (const s of score(tl).shots) expect(record(tl, Math.floor((s.f0 + s.f1) / 2)).calls.some((c) => c.method === 'fill' || c.method === 'fillText'), s.kind).toBe(true)
    }
  })
})
