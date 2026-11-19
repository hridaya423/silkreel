import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import type { FilmConfig, TraceScene } from '../types'
import { makeCam, project, sampleShot } from './camera'
import { buildTraceScene, TRACE_ACTS } from './scene'
import { stageCuts } from './shots'
import { boardModel } from '../../test/helpers'

const BOARDS = ['glasgow', 'icebreaker', 'StickHub', 'ecc83-pp', 'video', 'kit-dev-coldfire-xilinx_5213']

function scene(name: string, aspect: FilmConfig['aspect'] = '4:5', power?: FilmConfig['power']): TraceScene {
  const config: FilmConfig = {
    style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, ...(power === undefined ? {} : { power })
  }
  return buildTraceScene(boardModel(`${name}.kicad_pcb`), resolveConfig(config), 42).scene
}

describe('the trace score', () => {
  const cache = new Map(BOARDS.map((b) => [b, scene(b)]))

  for (const name of BOARDS) {
    const s = cache.get(name) as TraceScene

    it(`${name}: every seg is routed inside this board's drawing act and names a real group`, () => {
      for (const layer of s.layers) {
        expect(layer.groups.length).toBe(layer.segs.length / 7)
        expect(layer.energy.length).toBe(layer.groups.length * 2)
        for (let i = 0; i < layer.groups.length; i++) {
          const g = layer.groups[i] as number
          expect(g === -1 || (g >= 0 && g < s.groups.length)).toBe(true)
          const t0 = layer.segs[i * 7 + 5] as number
          const t1 = layer.segs[i * 7 + 6] as number
          expect(t0).toBeLessThanOrEqual(s.acts.draw[1] - 0.5 / 24 + 1e-9)
          expect(t1).toBeLessThanOrEqual(s.acts.draw[1] + 1e-9)
          expect(t1).toBeGreaterThanOrEqual(t0)
        }
      }
    })

    it(`${name}: no light before the ignition point, which leads the power-on cut by 4 frames so its flash carries the join; ground stays dark`, () => {
      for (const layer of s.layers) {
        for (let i = 0; i < layer.energy.length; i += 2) {
          const e0 = layer.energy[i] as number
          if (e0 < 0) continue
          expect(e0).toBeGreaterThanOrEqual(TRACE_ACTS.power[0] - 4 / 360 - 1e-9)
          expect(layer.energy[i + 1] as number).toBeLessThanOrEqual(TRACE_ACTS.power[1] + 1e-9)
        }
      }
      for (const g of s.groups) {
        if (g.kind === 'ground') expect(g.t).toBe(-1)
      }
    })

    it(`${name}: shots ascend and cut on this board's events: the coat on the beat the mask starts in, the parts take on the silk (beat 7 to 9), close on the main chip a beat before it seats where there is room, the ride on the power-on (beat 12, in its own light), the whole lit board from above for two beats, then the last frame; the hold is low on the main chip`, () => {
      expect(s.shots[0]?.t).toBe(0)
      expect(s.shots.at(-1)?.t).toBe(1)
      for (let i = 1; i < s.shots.length; i++) expect((s.shots[i] as { t: number }).t).toBeGreaterThan((s.shots[i - 1] as { t: number }).t)
      const cuts = s.shots.filter((k) => k.cut === true).map((k) => k.t)
      const close = stageCuts(s.acts)?.close
      const want = [Math.floor(s.acts.mask[0] * 24 + 1e-6) / 24, s.acts.silk[0], ...(close === undefined ? [] : [close]), 12 / 24]
      want.forEach((t, i) => {
        expect(cuts[i]).toBeCloseTo(t, 9)
      })
      expect(cuts).toHaveLength(want.length + 2)
      expect((cuts.at(-1) as number) - (cuts.at(-2) as number)).toBeCloseTo(2 / 24, 9)
      expect(s.acts.silk[0] * 24).toBeGreaterThanOrEqual(7 - 1e-9)
      expect(s.acts.silk[0] * 24).toBeLessThanOrEqual(9 + 1e-9)
      expect(s.shots.find((k) => k.light === 'ride')?.t).toBe(12 / 24)
      expect(s.shots.at(-1)?.tilt).toBeGreaterThanOrEqual((75 * Math.PI) / 180)
      expect(s.shots.filter((k) => k.light !== undefined).at(-1)?.light).toBe('hero')
    })

    it(`${name}: the last frame holds the main chip, not the whole board`, () => {
      const W = 1080
      const H = 1350
      const cam = makeCam(sampleShot(s.shots, 0.99), W, H)
      const hero = s.parts.find((pt) => pt.hero === true)
      if (hero !== undefined) {
        const q = project(cam, hero.x, hero.y, 0)
        expect(Math.max(Math.abs(q.x), Math.abs(q.y))).toBeLessThanOrEqual(1)
      }
      const out = s.board.some((loop) => loop.some((_, i) => {
        if (i % 2 === 1) return false
        const q = project(cam, loop[i] as number, loop[i + 1] as number, 0)
        return q.w <= 0 || Math.abs(q.x) > 1 || Math.abs(q.y) > 1
      }))
      expect(out).toBe(true)
    })

    it(`${name}: parts land on whole frames inside the place act, the hero last on its beat`, () => {
      expect(s.parts.length).toBeGreaterThan(0)
      const hero = s.parts.filter((pt) => pt.hero === true)
      expect(hero.length).toBeLessThanOrEqual(1)
      for (const pt of s.parts) {
        expect(pt.t).toBeGreaterThanOrEqual(s.acts.place[0])
        expect(pt.t).toBeLessThanOrEqual(s.acts.place[1])
        expect(pt.t * 360).toBeCloseTo(Math.round(pt.t * 360), 6)
        expect(pt.settle).toBeGreaterThanOrEqual(TRACE_ACTS.reflow[0])
        expect(pt.settle).toBeLessThanOrEqual(TRACE_ACTS.reflow[1])
        if (pt.hero === true) expect(pt.t).toBe(s.acts.place[1])
        if (pt.hero !== true) expect(pt.t, 'the hero lands last and alone').toBeLessThanOrEqual(s.acts.place[1] - 10 / 360 + 1e-9)
        expect(pt.w).toBeGreaterThan(0)
        expect(pt.z).toBeGreaterThan(0)
      }
    })

    it(`${name}: the board area is closed loops`, () => {
      expect(s.board.length).toBeGreaterThan(0)
      for (const loop of s.board) expect(loop.length).toBeGreaterThanOrEqual(6)
    })
  }

  it('every act starts on the half-beat grid, on every board', () => {
    for (const acts of [TRACE_ACTS, ...[...cache.values()].map((s) => s.acts)]) for (const [a] of Object.values(acts)) expect(a * 48).toBeCloseTo(Math.round(a * 48), 6)
  })

  it('the lamps ending lights no copper: the lamps are the only light', () => {
    const s = scene('glasgow', '4:5', 'lamps')
    expect(s.power).toBe('lamps')
    expect(s.layers.every((layer) => layer.energy.every((e) => e === -1))).toBe(true)
  }, 30_000)

  it('a bus lights together and lands together — length-matched lines arrive on one frame', () => {
    const s = scene('glasgow', '4:5', 'pulse')
    const bus = s.groups.findIndex((g) => g.kind === 'bus' && g.t >= 0)
    expect(bus).toBeGreaterThanOrEqual(0)
    const g = s.groups[bus] as TraceScene['groups'][number]
    let first = Infinity
    let last = -Infinity
    for (const layer of s.layers) {
      layer.groups.forEach((gi, i) => {
        if (gi !== bus) return
        first = Math.min(first, layer.energy[i * 2] as number)
        last = Math.max(last, layer.energy[i * 2 + 1] as number)
      })
    }
    expect(first).toBeCloseTo(g.t, 6)
    expect(last).toBeCloseTo(g.t + g.d, 6)
  })

  it('reads the board build into its material', () => {
    expect((cache.get('glasgow') as TraceScene).material.mask).toBe('#d8dbd4')
    expect((cache.get('kit-dev-coldfire-xilinx_5213') as TraceScene).material.finish).toBe('#dcc38a')
    expect((cache.get('icebreaker') as TraceScene).material.mask).toBe('#0c0d0e')
  })

  it('shoots a back-side hero from the back: StickHub reads as itself, not mirrored', () => {
    const s = cache.get('StickHub') as TraceScene
    expect(s.texts.some((t) => t.text === 'StickHub')).toBe(true)
  })
})
