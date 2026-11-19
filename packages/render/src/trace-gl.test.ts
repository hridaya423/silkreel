import './test-recorder.js'
import { describe, expect, it } from 'vitest'
import { compileTimeline } from '@silk-reel/choreo'
import type { CameraShot, FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import { makeCam, sampleShot } from '@silk-reel/choreo'
import { BLUR_MOST, BLUR_PASS, BLUR_STEP, blurAt, passEnds, blurPlan, shutterGap, CAN, COAT_HOLD, leadsOf, lookAt, linear, markingLines, maskExposure, NEAR_DIM, nearDimAt, rigFor, SEAT_SHEEN, seatSheen, SETTLE, shotSpan } from './trace-gl.js'
import { drawMaps, PULSE_DIP } from './trace-maps.js'
import type { MapSet } from './trace-maps.js'
import { asCtx, RecordingCtx } from './test-recorder.js'
import { boardModel } from '../../choreo/test/helpers.js'

const W = 1080
const H = 1350

/** clip-space position of a plane point (px, y down, height z) */
function project(vp: Float32Array, x: number, y: number, z = 0): [number, number] {
  const v = [x, -y, z, 1]
  const out = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].reduce((s, c) => s + (vp[c * 4 + r] as number) * (v[c] as number), 0))
  return [(out[0] as number) / (out[3] as number), (out[1] as number) / (out[3] as number)]
}

describe('camera', () => {
  it('zoom 1, tilt 0 reproduces the flat framing exactly', () => {
    const cam = makeCam({ x: W / 2, y: H / 2, zoom: 1, tilt: 0, yaw: 0, aperture: 0 }, W, H)
    const [cx, cy] = project(cam.vp, W / 2, H / 2)
    expect(cx).toBeCloseTo(0, 6)
    expect(cy).toBeCloseTo(0, 6)
    const [rx, ty] = project(cam.vp, W, 0)
    expect(rx).toBeCloseTo(1, 5)
    expect(ty).toBeCloseTo(1, 5)
  })

  it('tilting pitches toward the board bottom: the near edge grows', () => {
    const cam = makeCam({ x: W / 2, y: H / 2, zoom: 1, tilt: 0.8, yaw: 0, aperture: 0 }, W, H)
    const near = project(cam.vp, W, H)[0] - project(cam.vp, 0, H)[0]
    const far = project(cam.vp, W, 0)[0] - project(cam.vp, 0, 0)[0]
    expect(near).toBeGreaterThan(far)
  })

  it('sampleShot passes through every key and holds at turnarounds', () => {
    const shots: CameraShot[] = [
      { t: 0, x: 0, y: 0, zoom: 4, tilt: 1, yaw: 0, aperture: 1 },
      { t: 0.5, x: 100, y: 50, zoom: 2, tilt: 0.5, yaw: 0.3, aperture: 0.5 },
      { t: 1, x: 0, y: 0, zoom: 1, tilt: 0, yaw: 0, aperture: 0 }
    ]
    for (const k of shots) {
      const s = sampleShot(shots, k.t)
      expect(s.x).toBeCloseTo(k.x, 6)
      expect(s.zoom).toBeCloseTo(k.zoom, 6)
    }
    // x turns around at the middle key, so it must not overshoot it
    for (let p = 0; p <= 1; p += 0.01) expect(sampleShot(shots, p).x).toBeLessThanOrEqual(100 + 1e-6)
  })

  it('a cut holds the outgoing shot until the cut, then jumps', () => {
    const shots: CameraShot[] = [
      { t: 0, x: 0, y: 0, zoom: 1, tilt: 0, yaw: 0, aperture: 0 },
      { t: 0.5, x: 500, y: 0, zoom: 3, tilt: 0, yaw: 0, aperture: 0, cut: true },
      { t: 1, x: 600, y: 0, zoom: 3, tilt: 0, yaw: 0, aperture: 0 }
    ]
    expect(sampleShot(shots, 0.49).x).toBeCloseTo(0, 6)
    expect(sampleShot(shots, 0.5).x).toBeCloseTo(500, 6)
    expect(sampleShot(shots, 0.75).x).toBeGreaterThan(500)
  })

  it('motion blur stays inside the shot: the span ends at the next cut', () => {
    const shots: CameraShot[] = [
      { t: 0, x: 0, y: 0, zoom: 1, tilt: 0, yaw: 0, aperture: 0 },
      { t: 0.4, x: 9, y: 0, zoom: 1, tilt: 0, yaw: 0, aperture: 0, cut: true },
      { t: 0.7, x: 9, y: 0, zoom: 1, tilt: 0, yaw: 0, aperture: 0, cut: true },
      { t: 1, x: 9, y: 0, zoom: 1, tilt: 0, yaw: 0, aperture: 0 }
    ]
    expect(shotSpan(shots, 0.39)).toEqual([0, 0.4])
    expect(shotSpan(shots, 0.4)).toEqual([0.4, 0.7])
    expect(shotSpan(shots, 0.9)).toEqual([0.7, 1])
  })

  it('linear() undoes the sRGB curve', () => {
    expect(linear('#ffffff')).toEqual([1, 1, 1])
    expect(linear('#000000')).toEqual([0, 0, 0])
    expect(linear('#808080')[0]).toBeCloseTo(Math.pow(128 / 255, 2.2), 6)
  })
})

describe('end exposure', () => {
  it('keeps the mask colour: white above colours above black, each in its band', () => {
    const white = maskExposure('#d8dbd4')
    const black = maskExposure('#0c0d0e')
    const colours = ['#0d3b22', '#12305e', '#6b1414', '#3b1f5c'].map(maskExposure)
    expect(white).toBeGreaterThanOrEqual(0.62)
    expect(white).toBeLessThanOrEqual(0.72)
    expect(black).toBeGreaterThanOrEqual(0.2)
    expect(black).toBeLessThanOrEqual(0.26)
    for (const c of colours) {
      expect(c).toBeGreaterThanOrEqual(0.33)
      expect(c).toBeLessThanOrEqual(0.42)
      expect(c).toBeLessThan(white)
      expect(c).toBeGreaterThan(black)
    }
  })
})

describe('the parts take', () => {
  it('lifts the plate on the dark stage while the parts keep their own lower room light', () => {
    for (const light of ['stage', 'alone'] as const) {
      const r = rigFor(light, 0.5, 0, '#000000', 0)
      expect(r.room / (r.partRoom ?? r.room), light).toBeGreaterThanOrEqual(1.5)
    }
  })

  it('crosses the sheen over the main chip once, inside a beat around its seat', () => {
    const at = Array.from({ length: 40 }, (_, i) => seatSheen(i - 20))
    const on = at.flatMap((u, i) => (u === undefined ? [] : [i]))
    expect(on.length).toBeGreaterThan(0)
    expect(on.length).toBeLessThanOrEqual(15)
    expect((on.at(-1) as number) - (on[0] as number)).toBe(on.length - 1)
    expect(seatSheen(0)).toBeDefined()
    const us = on.map((i) => at[i] as number)
    for (let i = 1; i < us.length; i++) expect(us[i]).toBeGreaterThan(us[i - 1] as number)
    expect(SEAT_SHEEN.gain).toBeLessThan(1)
  })

  it('lets a landing part glint inside a quarter beat', () => {
    expect(SETTLE.gain).toBeGreaterThan(0)
    expect(SETTLE.frames).toBeLessThanOrEqual(15 / 2)
  })

  it('sets a value with a package suffix on two lines, and anything else on one', () => {
    expect(markingLines('ICE40UP5K-SG48')).toEqual(['ICE40UP5K', 'SG48'])
    expect(markingLines('MCF5213-LQFP100')).toEqual(['MCF5213', 'LQFP100'])
    expect(markingLines('ATMEGA328P')).toEqual(['ATMEGA328P'])
    expect(markingLines('LM1117-3.3')).toEqual(['LM1117-3.3'])
  })
})

describe('estimated chips', () => {
  const body = { x: 0, y: 0, w: 40, h: 60, rot: 0.3, z: 12 }
  const at = (lx: number, ly: number, w: number, h: number) => ({ x: Math.cos(0.3) * lx - Math.sin(0.3) * ly, y: Math.sin(0.3) * lx + Math.cos(0.3) * ly, w, h, rot: 0.3 })
  const rows = (x: number) => [-20, 0, 20].map((y) => at(x, y, 14, 6))

  it('gives each pad that reaches past the body on two sides a tin lead: a shoulder at mid height, a drop and a foot on the pad', () => {
    const leads = leadsOf(body, [...rows(-26), ...rows(26)], 10)
    expect(leads.length).toBe(6 * 3)
    const shoulder = leads[0] as (typeof leads)[number]
    expect(shoulder.base + shoulder.z / 2).toBeCloseTo(body.z / 2, 6)
    const foot = leads[2] as (typeof leads)[number]
    expect(foot.base).toBe(0)
    expect(Math.hypot(foot.x, foot.y)).toBeGreaterThan(body.w / 2)
  })

  it('gives none where the pads lie under the body, reach out on one side only, or show only a leadless toe', () => {
    expect(leadsOf(body, [...rows(-14), ...rows(14)], 10)).toEqual([])
    expect(leadsOf(body, rows(26), 10)).toEqual([])
    expect(leadsOf(body, [...rows(-20), ...rows(20)], 10)).toEqual([])
  })

  it('leaves a neighbour\'s pads alone', () => {
    expect(leadsOf(body, [...rows(-26), ...rows(26), ...rows(60)], 10).length).toBe(6 * 3)
  })
})

describe('the coat and the poster', () => {
  it('keeps bare copper lit through the coat take and carries a bright front line', () => {
    const r = rigFor('sheen', 0.5, 0, '#000000', 0)
    expect(r.keepCu).toBe(COAT_HOLD.keepCu)
    expect(COAT_HOLD.keepCu).toBeGreaterThan(0)
    expect(COAT_HOLD.frontGain).toBeGreaterThan(1)
    expect(rigFor('stage', 0.5, 0, '#000000', 0).keepCu ?? 0).toBe(0)
  })

  it('draws a crystal can as dark satin steel', () => {
    expect(Math.max(...CAN.alb)).toBeLessThanOrEqual(0.25)
    expect(CAN.rough).toBeLessThan(0.45)
  })
})

describe('the held poster\'s foreground', () => {
  const film = (name: string, aspect: '16:9' | '4:5', w: number, h: number): TraceTimeline => compileTimeline(boardModel(`${name}.kicad_pcb`), { style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { width: w, height: h, fps: 30 }, title: { name } }) as TraceTimeline
  it('dims what stands nearer than the focus plane only on a poster whose foreground still fences the chip, and only from the cut to it', () => {
    const fenced = film('kit-dev-coldfire-xilinx_5213', '4:5', 1080, 1350)
    const cut = fenced.scene.shots.filter((k) => k.cut === true).at(-1)?.t ?? 1
    expect(nearDimAt(fenced, 1, 1080, 1350)).toBe(NEAR_DIM.amount)
    expect(nearDimAt(fenced, cut - 1 / 360, 1080, 1350)).toBe(0)
    expect(nearDimAt(film('glasgow', '16:9', 1920, 1080), 1, 1920, 1080)).toBe(0)
  })
})

describe('board maps', () => {
  const cfg: FilmConfig = { style: 'trace', knobs: {}, seed: 42, duration: 'auto', output: { width: W, height: H, fps: 30 } }
  const tl = compileTimeline(boardModel('glasgow.kicad_pcb'), cfg) as TraceTimeline
  const fake = (): { canvas: HTMLCanvasElement; rec: RecordingCtx } => {
    const rec = new RecordingCtx(1024, 1280)
    const ctx = asCtx(rec)
    const canvas = { width: 1024, height: 1280, getContext: () => ctx } as unknown as HTMLCanvasElement
    return { canvas, rec }
  }
  const pulsed = compileTimeline(boardModel('glasgow.kicad_pcb'), { ...cfg, power: 'pulse' }) as TraceTimeline
  const lamps = compileTimeline(boardModel('glasgow.kicad_pcb'), { ...cfg, power: 'lamps' }) as TraceTimeline
  const draw = (p: number, film = tl) => {
    const top = fake()
    const surf = fake()
    const fx = fake()
    const maps: MapSet = { top: top.canvas, surf: surf.canvas, fx: fx.canvas }
    drawMaps(maps, film, p, { x: 0, y: 0, w: W, h: W * 1280 / 1024 }, { all: 0, hero: 0 })
    return { top: top.rec, surf: surf.rec, fx: fx.rec }
  }
  const warm = (p: number): number => draw(p).top.calls.filter((c) => c.method === 'set:strokeStyle' && typeof c.args[0] === 'string' && c.args[0].startsWith('rgba(0,0,255,')).reduce((sum, c) => sum + Number(/,([\d.]+)\)$/.exec(c.args[0] as string)?.[1] ?? 0), 0)

  it('packs channels additively and maps the region into the texture', () => {
    const { top } = draw(0.4)
    expect(top.calls.find((c) => c.method === 'set:globalCompositeOperation' && c.args[0] === 'lighter')).toBeDefined()
    const xf = top.calls.filter((c) => c.method === 'setTransform').at(-1)?.args as number[]
    expect(xf[0]).toBeCloseTo(1024 / W, 6)
  })

  it('routes copper out through the drawing act', () => {
    const strokes = (p: number) => draw(p).top.calls.filter((c) => c.method === 'stroke').length
    expect(strokes(0.2)).toBeGreaterThan(strokes(0.02))
  })

  it('fills the board area and every drill into the surface map', () => {
    const { surf } = draw(0.5)
    const fills = surf.calls.filter((c) => c.method === 'fill').length
    expect(fills).toBeGreaterThanOrEqual(tl.scene.drills.length + 1)
  })

  it('lights cool energy only after power-on, while the pulse runs', () => {
    const cool = (p: number) => draw(p, pulsed).fx.calls.filter((c) => c.method === 'stroke').length
    expect(cool(pulsed.scene.acts.power[0] - 0.01)).toBe(0)
    expect(cool(pulsed.scene.acts.power[0] + 2.5 / 24)).toBeGreaterThan(0)
  })

  it('dips the main chip\'s nets over the frames before the last pulse leaves it', () => {
    const out = tl.scene.pulse
    expect(out).toBeDefined()
    if (out === undefined) return
    expect(warm(out.at - 1 / 360)).toBeLessThan(0.9 * warm(out.at - (PULSE_DIP.frames + 4) / 360))
  })

  it('dips over at most six frames and returns outward from the chip, whole again before the poster holds', () => {
    const out = tl.scene.pulse
    if (out === undefined) return
    expect(PULSE_DIP.frames).toBeLessThanOrEqual(6)
    const full = warm(out.at - (PULSE_DIP.frames + 2) / 360)
    const half = warm(out.at + out.span / 2)
    expect(warm(out.at)).toBeLessThan(half)
    expect(half).toBeLessThan(full)
    expect(warm(out.at + (3 * out.span) / 4)).toBeGreaterThan(1.15 * warm(out.at + out.span / 4))
    expect(warm(out.at + out.span + (PULSE_DIP.release + 1) / 360) / full).toBeGreaterThan(0.97)
  })

  it('lights no copper in the lamps ending: the lamps are the only light', () => {
    expect(draw(lamps.scene.acts.power[0] + 2.5 / 24, lamps).fx.calls.filter((c) => c.method === 'stroke').length).toBe(0)
  })
})

describe('motion blur', () => {
  const FINAL = 32
  const film = (aspect: '16:9' | '9:16', w: number, h: number): TraceTimeline => compileTimeline(boardModel('glasgow.kicad_pcb'), { style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { width: w, height: h, fps: 30 }, title: { name: 'glasgow' } }) as TraceTimeline
  const extentOf = (tl: TraceTimeline): { x: number; y: number; w: number; h: number } => {
    const xs = tl.scene.board.flatMap((loop) => loop.filter((_, i) => i % 2 === 0))
    const ys = tl.scene.board.flatMap((loop) => loop.filter((_, i) => i % 2 === 1))
    const m = 0.06 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    return { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + 2 * m, h: Math.max(...ys) - Math.min(...ys) + 2 * m }
  }

  const stepOf = (smear: number, plan: { n: number; even: boolean }): number => smear * (plan.even ? 1 / plan.n : shutterGap(plan.n))

  it.each([['16:9', 1920, 1080], ['9:16', 1080, 1920]] as const)('%s: neighbouring shutter samples of a final render stand at most BLUR_STEP apart where the board moves fastest in frame, so the copper smears instead of stepping', (aspect, w, h) => {
    const tl = film(aspect, w, h)
    const extent = extentOf(tl)
    let stepped = 0
    for (let f = 0; f < tl.totalFrames; f++) {
      const p = f / tl.totalFrames
      const { smear } = blurAt(tl, p, w, h, extent, lookAt(tl, p).shutter)
      if (stepOf(smear, { n: FINAL, even: false }) > BLUR_STEP) stepped++
      expect(stepOf(smear, blurPlan(smear, FINAL, true)), `f${f}`).toBeLessThanOrEqual(BLUR_STEP + 1e-9)
    }
    expect(stepped).toBeGreaterThan(0)
  })

  it('a frame under the bound keeps its quality\'s count and shutter times, the draft keeps one sample, and a stepped frame takes even times', () => {
    expect(blurPlan(BLUR_STEP / shutterGap(FINAL), FINAL, true)).toEqual({ n: FINAL, even: false })
    expect(blurPlan(5 * BLUR_STEP, 5, false)).toEqual({ n: 5, even: false })
    expect(blurPlan(400, 1, true)).toEqual({ n: 1, even: false })
    expect(blurPlan(100, FINAL, true)).toEqual({ n: 134, even: true })
    expect(blurPlan(1e4, FINAL, true).n).toBe(BLUR_MOST)
  })

  it('a frame of up to BLUR_MOST samples hands the browser back its main thread at least every BLUR_PASS samples, and a round 10 frame never does', () => {
    for (let n = 1; n <= BLUR_MOST; n++) {
      let run = 0
      for (let i = 0; i < n; i++) {
        run++
        if (passEnds(i, n)) run = 0
        expect(run, `n ${n}, sample ${i}`).toBeLessThanOrEqual(BLUR_PASS)
      }
    }
    expect(Array.from({ length: FINAL }, (_, i) => passEnds(i, FINAL)).some(Boolean)).toBe(false)
  })
})
