import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import type { Aspect, FilmConfig } from '../types'
import { corners, heroCrossed, heroOcclusion, lidCover, makeCam, nearCover, nearShare, project, sampleShot } from './camera'
import { buildTraceScene } from './scene'
import { ALONE_SKY, ALONE_WIDTH, FENCE_DEPTH, FENCE_MOST, boardShare, COAT_SHARE, heroWidth, BREATH_MOST, breathCover, TAKE_TALL, LID_COVER, MARK_LEVEL, markLevel, letterBoxes, longAlong, nameCrossed, REV_LEAST, skyAbove, stageCuts } from './shots'
import { POSTER_HOLD, PULSE_RETURN } from './scene'
import { boardModel } from '../../test/helpers'

vi.setConfig({ testTimeout: 30_000 })

const BOARDS = ['glasgow', 'icebreaker', 'kit-dev-coldfire-xilinx_5213', 'StickHub']
const ASPECTS: Aspect[] = ['4:5', '1:1', '9:16', '16:9']
const CROSS_MOST = 0.03
const FENCED = new Set(['glasgow 9:16', 'kit-dev-coldfire-xilinx_5213 4:5', 'kit-dev-coldfire-xilinx_5213 9:16', 'kit-dev-coldfire-xilinx_5213 1:1'])
const CLEAR_POSTER = new Set(['glasgow 4:5', 'glasgow 1:1', 'glasgow 9:16', 'glasgow 16:9', 'icebreaker 4:5', 'icebreaker 9:16', 'kit-dev-coldfire-xilinx_5213 9:16'])

describe('the parts take and the end hold', () => {
  for (const name of BOARDS) {
    const board = boardModel(`${name}.kicad_pcb`)
    for (const aspect of ASPECTS) {
      const config: FilmConfig = { style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, title: { name } }
      const r = resolveConfig(config)
      const s = buildTraceScene(board, r, 42).scene
      const hero = s.parts.find((pt) => pt.hero === true)
      const cuts = stageCuts(s.acts)

      it(`${name} ${aspect}: the seat is the frame the main chip lands`, () => {
        expect(s.seat).toBeDefined()
        expect(s.seat).toBe(hero?.t)
      })

      it(`${name} ${aspect}: where there is room, the take holds the crowd, cranes on a beat to the wide position, and cuts close onto the main chip a beat before it seats`, () => {
        if (cuts === undefined) {
          expect(s.shots.some((k) => k.light === 'stage')).toBe(true)
          return
        }
        const take = s.shots.filter((k) => k.t >= s.acts.silk[0] - 1e-9 && k.t < s.acts.power[0] - 1e-9)
        expect(take[0]?.light).toBe('stage')
        expect(take.filter((k) => k.cut === true).map((k) => k.t * 24)).toEqual([take[0]?.t ?? 0, cuts.close].map((t) => t * 24))
        expect(take.find((k) => k.cut === true && k.t > (take[0]?.t ?? 0))?.light).toBe('alone')
        expect(take.some((k) => Math.abs(k.t - cuts.crane[1]) < 1e-9 && k.cut !== true)).toBe(true)
        expect(cuts.crane[1] * 24).toBeCloseTo(Math.round(cuts.crane[1] * 24), 9)
      })

      it(`${name} ${aspect}: no part falls across the close cut`, () => {
        if (cuts === undefined) return
        for (const pt of s.parts) {
          if (pt.kind === 'pin' || pt.hero === true) continue
          const from = pt.t - (pt.fall ?? 0)
          expect(from < cuts.close - 1e-9 && pt.t >= cuts.close - 1e-9, `a part landing at ${Math.round(pt.t * 360)}`).toBe(false)
        }
      })

      it(`${name} ${aspect}: no part in front of a parts-take position covers a tenth of its frame`, () => {
        if (cuts === undefined) return
        const bodies = s.parts.filter((pt) => pt.kind !== 'pin' && pt.hero !== true)
        for (const t of [s.acts.silk[0], cuts.crane[0], cuts.crane[1], cuts.close]) {
          const cam = makeCam(sampleShot(s.shots, t), r.width, r.height)
          expect(nearCover(cam, r.width, r.height, bodies, 0.85 * cam.dist), `at beat ${(t * 24).toFixed(1)}`).toBeLessThanOrEqual(0.1 + 0.02)
        }
      })

      it(`${name} ${aspect}: the name spans half the frame unless it would leave the top, the revision lands on its own beat after the name is whole, and one pulse runs before the last ten frames`, () => {
        const L = s.lockup
        const b = L?.build
        if (L === undefined || b === undefined) return
        expect(L.box.x1 - L.box.x0 >= 0.5 * r.width || L.box.y0 <= 0.05 * r.height + 1).toBe(true)
        if (b.version !== undefined) {
          const name = L.lines.map((l) => l.text).join(' ')
          expect(b.version * 24).toBeCloseTo(Math.round(b.version * 24), 9)
          expect(b.version).toBeGreaterThan(b.t0 + (name.length - 1) * b.step + b.land)
        }
        if (s.pulse === undefined) return
        expect(s.pulse.at * 24).toBeCloseTo(Math.round(s.pulse.at * 24), 9)
        expect(s.pulse.at).toBeGreaterThanOrEqual((b.version ?? b.readable) + 2 / 24 - 1e-9)
        expect(s.pulse.at + s.pulse.span).toBeLessThanOrEqual(1 - 10 / 360 + 1e-9)
      })

      it(`${name} ${aspect}: the name takes at most two lines, and either no part crosses a letter at the held frame or the name stands in front of the scene`, () => {
        const L = s.lockup
        if (L === undefined) return
        expect(L.lines.length).toBeLessThanOrEqual(2)
        const cam = makeCam(sampleShot(s.shots, 1 - 1e-6), r.width, r.height)
        expect(L.front === true || !nameCrossed(L, cam, s.parts.filter((pt) => pt.hero !== true), r.width, r.height)).toBe(true)
      })

      it(`${name} ${aspect}: the coat take holds the whole board, spanning at least 70% of the frame along the side that binds, unless it moved in to TAKE_TALL.sheen of the height`, () => {
        const take = s.shots.filter((k) => k.light === 'sheen')
        expect(take.length).toBeGreaterThan(0)
        const rim = s.board.flatMap((loop) => Array.from({ length: loop.length / 2 }, (_, i) => [loop[2 * i] as number, loop[2 * i + 1] as number] as const))
        for (const k of take) {
          const qs = rim.map(([x, y]) => project(makeCam(k, r.width, r.height), x, y, 0))
          const xs = qs.map((q) => q.x)
          const ys = qs.map((q) => q.y)
          if (Math.max(...xs.map(Math.abs), ...ys.map(Math.abs)) > 1) {
            expect((Math.min(1, Math.max(...ys)) - Math.max(-1, Math.min(...ys))) / 2).toBeGreaterThanOrEqual(TAKE_TALL.sheen)
            continue
          }
          expect(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2).toBeGreaterThanOrEqual(0.7)
        }
      })

      it(`${name} ${aspect}: the coat take covers at least 45% of the frame with the board, or the most it can at the film's steepest tilt, its long side along the frame's`, () => {
        const loops = s.board.map((l) => Array.from(l))
        for (const k of s.shots.filter((q) => q.light === 'sheen')) {
          const b = boardShare(makeCam(k, r.width, r.height), loops)
          expect(b.share >= COAT_SHARE || Math.abs(k.tilt - (r.height > r.width ? 54 : 60) * (Math.PI / 180)) < 1e-6, `share ${b.share.toFixed(2)} at ${(k.tilt * 180 / Math.PI).toFixed(1)}°`).toBe(true)
          expect(longAlong(k.yaw, b, loops, r.width, r.height)).toBe(true)
        }
      })

      it(`${name} ${aspect}: where the main chip seats it is the nearest large part: nothing nearer crosses it, it spans 30% of the width, and black above the board takes at most a quarter of the height`, () => {
        if (hero === undefined) return
        const box = { x: hero.x, y: hero.y, w: hero.w, h: hero.h, rot: hero.rot, z: hero.z }
        const blockers = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
        const alone = s.shots.find((k) => k.light === 'alone')
        expect(alone).toBeDefined()
        for (const t of [alone?.t ?? 0, hero.t]) {
          const cam = makeCam(sampleShot(s.shots, t), r.width, r.height)
          expect(heroCrossed(cam, box, blockers), `at ${Math.round(t * 360)}`).toBe(false)
          expect(heroWidth(cam, box)).toBeGreaterThanOrEqual(ALONE_WIDTH)
          expect(skyAbove(cam, s.board.map((l) => Array.from(l)))).toBeLessThanOrEqual(ALONE_SKY)
        }
      })

      it(`${name} ${aspect}: from the name's first mark to the last frame nothing nearer the lens crosses the main chip`, () => {
        if (hero === undefined) return
        const box = { x: hero.x, y: hero.y, w: hero.w, h: hero.h, rot: hero.rot, z: hero.z }
        const blockers = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
        const from = s.lockup?.build?.t0
        expect(from).toBeDefined()
        const cams: ReturnType<typeof makeCam>[] = []
        for (let f = Math.floor((from ?? 1) * 360); f <= 360; f++) cams.push(makeCam(sampleShot(s.shots, f / 360), r.width, r.height))
        if (CLEAR_POSTER.has(`${name} ${aspect}`)) expect(cams.filter((cam) => heroCrossed(cam, box, blockers)).length).toBe(0)
        else expect(Math.max(...cams.map((cam) => heroOcclusion(cam, r.width, r.height, box, blockers, 1).covered))).toBeLessThanOrEqual(CROSS_MOST)
      })

      it(`${name} ${aspect}: on the held poster the out-of-focus bodies nearer than the main chip cover at most FENCE_MOST of the frame`, () => {
        if (hero === undefined) return
        const cam = makeCam(sampleShot(s.shots, 1), r.width, r.height)
        const depth = (hero.x - cam.pos[0]) * cam.f[0] + (-hero.y - cam.pos[1]) * cam.f[1] + (hero.z / 2 - cam.pos[2]) * cam.f[2]
        const blockers = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
        const fence = nearShare(cam, r.width, r.height, blockers, FENCE_DEPTH * depth)
        if (!FENCED.has(`${name} ${aspect}`)) expect(fence).toBeLessThanOrEqual(FENCE_MOST)
      })

      it(`${name} ${aspect}: on the parts take the board covers at least TAKE_TALL.stage of the frame's height, unless the main chip already stands at the frame's edge`, () => {
        const i = s.shots.findIndex((k) => k.cut === true && k.light === 'stage')
        const j = s.shots.findIndex((k, n) => n > i && k.cut === true)
        if (hero === undefined || i < 0) return
        const f0 = Math.round((s.shots[i] as { t: number }).t * 360)
        const f1 = Math.round((s.shots[j] as { t: number }).t * 360)
        let least = 1
        let edge = 0
        for (let f = f0; f < f1; f++) {
          const cam = makeCam(sampleShot(s.shots, f / 360), r.width, r.height)
          const ys = s.board.flatMap((l) => Array.from({ length: l.length / 2 }, (_, k) => project(cam, l[2 * k] as number, l[2 * k + 1] as number, 0))).filter((q) => q.w > 0).map((q) => q.y)
          least = Math.min(least, (Math.min(1, Math.max(...ys)) - Math.max(-1, Math.min(...ys))) / 2)
          edge = Math.max(edge, ...corners(hero).map(([x, y, z]) => Math.abs(project(cam, x, y, z).x)))
        }
        if (edge < 0.9) expect(least).toBeGreaterThanOrEqual(TAKE_TALL.stage)
        expect(edge).toBeLessThanOrEqual(0.95 + 1e-9)
      })

      it(`${name} ${aspect}: on the coat take the board covers at least TAKE_TALL.sheen of the frame's height`, () => {
        const i = s.shots.findIndex((k) => k.cut === true && k.light === 'sheen')
        const j = s.shots.findIndex((k, n) => n > i && k.cut === true)
        const f0 = Math.round((s.shots[i] as { t: number }).t * 360)
        const f1 = Math.round((s.shots[j] as { t: number }).t * 360)
        for (let f = f0; f < f1; f++) {
          const cam = makeCam(sampleShot(s.shots, f / 360), r.width, r.height)
          const ys = s.board.flatMap((l) => Array.from({ length: l.length / 2 }, (_, k) => project(cam, l[2 * k] as number, l[2 * k + 1] as number, 0))).filter((q) => q.w > 0).map((q) => q.y)
          expect((Math.min(1, Math.max(...ys)) - Math.max(-1, Math.min(...ys))) / 2).toBeGreaterThanOrEqual(TAKE_TALL.sheen)
        }
      })

      it(`${name} ${aspect}: in the breath, bodies nearer than the main chip cover at most BREATH_MOST of the frame's lower third`, () => {
        const i = s.shots.findIndex((k) => k.cut === true && k.light === 'alone')
        const next = s.shots.find((k, n) => n > i && k.cut === true)
        if (hero === undefined || i < 0 || next === undefined) return
        const blockers = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
        for (const t of [(s.shots[i] as { t: number }).t, next.t - 1e-4]) expect(breathCover(makeCam(sampleShot(s.shots, t), r.width, r.height), hero, blockers, r.width, r.height)).toBeLessThanOrEqual(BREATH_MOST + 0.01)
      })

      it(`${name} ${aspect}: over the close-up no other body hides the marking's cell, and at most LID_COVER of the lid`, () => {
        const wake = s.shots.find((k) => k.light === 'hero')
        const cut = s.shots.find((k) => k.light === 'power')
        if (hero === undefined || wake === undefined || cut === undefined) return
        const blockers = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
        for (let f = Math.round(wake.t * 360); f < Math.round(cut.t * 360); f++) {
          const c = lidCover(makeCam(sampleShot(s.shots, f / 360), r.width, r.height), hero, blockers)
          expect(c.mark, `f${f}`).toBe(0)
          expect(c.lid, `f${f}`).toBeLessThanOrEqual(LID_COVER)
        }
      })

      it(`${name} ${aspect}: from the close-up's middle frame to its cut the main chip's marking holds within MARK_LEVEL of level`, () => {
        const wake = s.shots.find((k) => k.light === 'hero')
        const cut = s.shots.find((k) => wake !== undefined && k.t > wake.t && k.cut === true)
        if (hero?.label === undefined || wake === undefined || cut === undefined) return
        const axis = hero.w >= hero.h ? { x: Math.cos(hero.rot), y: Math.sin(hero.rot) } : { x: -Math.sin(hero.rot), y: Math.cos(hero.rot) }
        const sign = hero.turn === true ? -1 : 1
        for (let f = Math.round(((wake.t + cut.t) / 2) * 360); f < Math.round(cut.t * 360); f++) {
          expect(markLevel(makeCam(sampleShot(s.shots, f / 360), r.width, r.height), hero, { x: sign * axis.x, y: sign * axis.y }, r.width, r.height), `f${f}`).toBeLessThanOrEqual(MARK_LEVEL + 1e-9)
        }
      })

      it(`${name} ${aspect}: on the close-up's first frame the main chip's marking runs within MARK_LEVEL of level, never upside down`, () => {
        const wake = s.shots.find((k) => k.light === 'hero')
        if (hero?.label === undefined || wake === undefined) return
        const axis = hero.w >= hero.h ? { x: Math.cos(hero.rot), y: Math.sin(hero.rot) } : { x: -Math.sin(hero.rot), y: Math.cos(hero.rot) }
        const sign = hero.turn === true ? -1 : 1
        expect(markLevel(makeCam(sampleShot(s.shots, wake.t), r.width, r.height), hero, { x: sign * axis.x, y: sign * axis.y }, r.width, r.height)).toBeLessThanOrEqual(MARK_LEVEL)
      })


      it(`${name} ${aspect}: the revision is never set smaller than REV_LEAST of the short side and stays inside the name's measure`, () => {
        const L = s.lockup
        if (L?.version === undefined) return
        expect(L.version.size).toBeGreaterThanOrEqual((r.width > r.height ? REV_LEAST.wide : REV_LEAST.other) * Math.min(r.width, r.height) - 1e-9)
        for (const b of letterBoxes(L)) expect(b.x1 - b.x0).toBeLessThanOrEqual(0.74 * r.width + 1e-6)
      })

      it(`${name} ${aspect}: the last pulse returns over 10 to 14 frames and the poster holds at least 15 after it`, () => {
        expect(s.pulse).toBeDefined()
        if (s.pulse === undefined) return
        expect(s.pulse.span * 360).toBeGreaterThanOrEqual(10 - 1e-6)
        expect(s.pulse.span * 360).toBeLessThanOrEqual(14 + 1e-6)
        expect(1 - s.pulse.at - s.pulse.span).toBeGreaterThanOrEqual(POSTER_HOLD - 1e-9)
        expect(PULSE_RETURN).toBe(s.pulse.span)
      })

      it(`${name} ${aspect}: montage's clone keeps none of it`, () => {
        const m = buildTraceScene(board, r, 42, undefined, false).scene
        expect(m.seat).toBeUndefined()
        expect(m.pulse).toBeUndefined()
        expect(m.shots.some((k) => k.light === 'stage' || k.light === 'alone')).toBe(false)
      })
    }
  }

  it('a long name of many words still takes at most two lines', () => {
    for (const aspect of ASPECTS) {
      const config: FilmConfig = { style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, title: { name: 'Interface Explorer Instrumentation' } }
      const L = buildTraceScene(boardModel('glasgow.kicad_pcb'), resolveConfig(config), 42).scene.lockup
      expect(L?.lines.length, aspect).toBeLessThanOrEqual(2)
    }
  })
})
