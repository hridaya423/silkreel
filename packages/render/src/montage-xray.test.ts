import './test-recorder'
import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, compileTimeline, copperStack, makeCam, sampleShot } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, HypeCut, MontageScore, TraceTimeline } from '@silk-reel/choreo'
import { drawXray, EXPOSE, LINE_LEAST, POUR, RING_TONE } from './montage-xray'
import { asCtx, RecordingCtx } from './test-recorder'
import { boardModel } from '../../choreo/test/helpers'

const film = (name: string, aspect: Aspect): TraceTimeline => {
  const config: FilmConfig = { style: 'montage', aspect, knobs: {}, seed: 3, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 } }
  return compileTimeline(boardModel(name), config) as TraceTimeline
}

const draw = (tl: TraceTimeline, frame: number, grey = 0, upTo?: number): { out: RecordingCtx; made: RecordingCtx[] } => {
  const h = (tl.scene.montage as MontageScore).hype as HypeCut
  const made: RecordingCtx[] = []
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown }
  const was = proto.getContext
  proto.getContext = function (this: HTMLCanvasElement): CanvasRenderingContext2D {
    const r = new RecordingCtx(this.width, this.height)
    made.push(r)
    const c = asCtx(r) as unknown as Record<string, unknown>
    c.getImageData = (): { data: Uint8ClampedArray } => ({ data: new Uint8ClampedArray(this.width * this.height * 4).map((_, i) => (i % 4 === 3 ? 255 : Math.round(grey * 255))) })
    return c as unknown as CanvasRenderingContext2D
  }
  const out = new RecordingCtx(tl.width, tl.height)
  try {
    const cam = makeCam(sampleShot(h.shots, (h.plan[frame]?.clone ?? 0) / h.total), tl.width, tl.height)
    drawXray(asCtx(out), tl.scene, cam, tl.width, tl.height, { layers: upTo ?? h.plan[frame]?.layers ?? 1, age: 4 })
  } finally {
    proto.getContext = was
  }
  return { out, made }
}

describe('the X-ray of the whole board', { timeout: 120_000 }, () => {
  for (const [name, aspect] of [['glasgow.kicad_pcb', '4:5'], ['icebreaker.kicad_pcb', '9:16'], ['kit-dev-coldfire-xilinx_5213.kicad_pcb', '16:9']] as const) {
    it(`${name} ${aspect}: every pour draws as its outline at line strength over a faint inside, tracks over the whole stack of pours stand three times over it, no line is thinner than the floor, and nothing adds grain`, () => {
      const tl = film(name, aspect)
      const frame = 284
      const { out, made } = draw(tl, frame)
      const stack = copperStack(tl.scene)
      const layers = ((tl.scene.montage as MontageScore).hype as HypeCut).plan[frame]?.layers ?? 0
      expect(layers, 'the last frame of the hold shows every layer').toBe(stack.length)
      const per = made.slice(-3 * stack.length)
      const least = LINE_LEAST * tl.width
      for (const [i, l] of stack.entries()) {
        const [lines, , merged] = per.slice(3 * i, 3 * i + 3) as [RecordingCtx, RecordingCtx, RecordingCtx]
        const pours = tl.scene.zones.filter((z) => z.side === l.side && (l.side !== 'inner' || (z.layer ?? 'In1.Cu') === l.id)).length
        expect(lines.calls.filter((c) => c.method === 'stroke').length, `${l.id ?? l.side}: each of its ${pours} pours is outlined on the line layer`).toBeGreaterThanOrEqual(pours)
        for (const c of lines.calls.filter((x) => x.method === 'set:lineWidth')) expect(c.args[0] as number, `${l.id ?? l.side}: a line under the floor`).toBeGreaterThanOrEqual(least - 1e-9)
        const alphas = merged.calls.filter((c) => c.method === 'set:globalAlpha').map((c) => c.args[0] as number)
        const [inside, line] = alphas as [number, number]
        expect(line, `${l.id ?? l.side}: a track over all ${stack.length} pours stands three times over them (inside ${inside}, line ${line})`).toBeGreaterThanOrEqual(2 * stack.length * inside)
      }
      expect(least * (390 / tl.width), 'the thinnest line is 0.6 px on a 390 px phone').toBeGreaterThanOrEqual(0.6 - 1e-9)
      expect(out.calls.some((c) => c.method === 'set:globalCompositeOperation' && c.args[0] === 'overlay'), 'no grain over the X-ray').toBe(false)
      expect(made.some((r) => r.calls.some((c) => c.method === 'putImageData')), 'no noise texture is made').toBe(false)
    })
  }
})

describe('the X-ray exposure', { timeout: 120_000 }, () => {
  it('sets one gain a film from the front copper, so a board whose front reads at twice the level draws its lines and pours at half the gain, and a faint one is lifted', () => {
    const tl = film('icebreaker.kicad_pcb', '4:5')
    const gainAt = (grey: number): number => {
      const { made } = draw({ ...tl, scene: { ...tl.scene } }, 272, grey)
      const merged = made.at(-1) as RecordingCtx
      const alphas = merged.calls.filter((c) => c.method === 'set:globalAlpha').map((c) => c.args[0] as number)
      return (alphas[0] as number) / POUR
    }
    expect(gainAt(2 * EXPOSE.level), 'a board at twice the level').toBeCloseTo(Math.max(EXPOSE.least, 0.5), 2)
    expect(gainAt(EXPOSE.level), 'a board at the level').toBeCloseTo(1, 2)
    expect(gainAt(EXPOSE.level / 2), 'a board at half the level').toBeCloseTo(2, 2)
  })
})

describe('a later X-ray layer', { timeout: 120_000 }, () => {
  it('adds lines, not haze: once a layer has arrived, the layers under it fall back, so the newest is the brightest', () => {
    const tl = film('kit-dev-coldfire-xilinx_5213.kicad_pcb', '16:9')
    const stack = copperStack(tl.scene)
    expect(stack.length, 'a board with more than one layer').toBeGreaterThan(1)
    const lineAlpha = (upTo: number, i: number): number => {
      const merged = draw(tl, 284, EXPOSE.level, upTo).made.slice(-3 * upTo)[3 * i + 2] as RecordingCtx
      return merged.calls.filter((c) => c.method === 'set:globalAlpha').map((c) => c.args[0] as number)[1] as number
    }
    for (let i = 0; i + 1 < stack.length; i++) {
      const alone = lineAlpha(i + 1, i)
      const under = lineAlpha(stack.length, i)
      expect(under, `layer ${i} falls back once ${stack.length - 1 - i} more have arrived`).toBeLessThan(alone)
      expect(under, `layer ${i} falls under the newest`).toBeLessThan(lineAlpha(stack.length, stack.length - 1))
    }
  })
})

describe('the main chip\'s exposed pad in the X-ray', { timeout: 120_000 }, () => {
  it('icebreaker 9:16: the pad the scene draws as a ring keeps a pale tone inside its edge, not a dark hole', () => {
    const tl = film('icebreaker.kicad_pcb', '9:16')
    const rings = tl.scene.pads.filter((p) => p.hero === true && p.ring === true)
    expect(rings.length, 'U6\'s exposed pad is a ring').toBeGreaterThanOrEqual(1)
    const { made } = draw(tl, 112)
    const toned = made.some((r) => r.calls.some((c, i) => c.method === 'set:fillStyle' && c.args[0] === `rgba(240, 250, 255, ${RING_TONE})` && r.calls[i + 1]?.method !== 'set:fillStyle' && r.calls.slice(i + 1, i + 8).some((d) => d.method === 'fill') && r.calls.slice(i + 1, i + 8).some((d) => d.method === 'stroke')))
    expect(toned, 'filled at the tone, then stroked').toBe(true)
  })
})
