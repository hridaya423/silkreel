import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { DEMO_CAST_HINTS } from '../hints'
import type { Aspect, FilmConfig } from '../types'
import { makeCam, project, sampleShot } from './camera'
import { READ_SECONDS } from './lockup'
import { REV_LEAST } from './shots'
import { buildTraceScene } from './scene'
import { boardModel } from '../../test/helpers'

vi.setConfig({ testTimeout: 30_000 })

const TITLES: Record<string, string> = { glasgow: 'Glasgow', icebreaker: 'iCEBreaker', StickHub: 'StickHub', 'ecc83-pp': 'ECC83 PP', video: 'Video', 'kit-dev-coldfire-xilinx_5213': 'ColdFire Xilinx Dev Kit' }
const BOARDS = Object.keys(TITLES)
const ASPECTS: Aspect[] = ['4:5', '1:1', '9:16', '16:9']
const DEG = 180 / Math.PI

describe('end frame lockup', () => {
  for (const name of BOARDS) {
    const board = boardModel(`${name}.kicad_pcb`)
    for (const aspect of ASPECTS) {
      it(`${name} ${aspect}: a low end frame on the main chip with the name in heavy caps above it, the revision small after it, and no other words`, () => {
        const config: FilmConfig = { style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, title: { name: TITLES[name] ?? name }, ...(DEMO_CAST_HINTS[name] === undefined ? {} : { cast: DEMO_CAST_HINTS[name] }) }
        const r = resolveConfig(config)
        const W = r.width
        const H = r.height
        const s = buildTraceScene(board, r, 42).scene
        const L = s.lockup
        expect(L).toBeDefined()
        if (L === undefined) return
        expect(L.face).toBe('grotesk')
        expect(L.side).toBe('above')
        expect(L.facts).toBeUndefined()
        expect(L.lines.map((l) => l.text).join(' ')).toBe(TITLES[name])
        expect(L.lines.length, 'a long name wraps at its words to at most three lines').toBeLessThanOrEqual(3)
        expect(L.box.x0).toBeGreaterThanOrEqual(0.12 * W)
        expect(L.box.x1).toBeLessThanOrEqual(0.88 * W)
        expect(L.box.y0).toBeGreaterThanOrEqual(0.04 * H)
        expect(Math.abs((L.box.x0 + L.box.x1) / 2 - W / 2)).toBeLessThanOrEqual(0.01 * W)
        expect((0.7 * L.size * 390) / W, 'the caps stand at least 12 px on a phone').toBeGreaterThanOrEqual(12)
        if (L.version !== undefined) expect(L.version.size).toBeLessThanOrEqual(Math.max(0.3 * L.size, (W > H ? REV_LEAST.wide : REV_LEAST.other) * Math.min(W, H) + 1e-9))
        const hero = s.parts.find((pt) => pt.hero === true)
        for (const p of [s.beats.hold[0], 1]) {
          const k = sampleShot(s.shots, p)
          expect(k.tilt * DEG, 'no more than 15° above the board').toBeGreaterThanOrEqual(75)
          if (hero === undefined) continue
          const cam = makeCam(k, W, H)
          const c = Math.cos(hero.rot)
          const sn = Math.sin(hero.rot)
          const rise = Math.min(hero.z, Math.max(hero.w, hero.h))
          for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]>) {
            const q = project(cam, hero.x + (u * hero.w * c - v * hero.h * sn) / 2, hero.y + (u * hero.w * sn + v * hero.h * c) / 2, rise)
            expect(((1 - q.y) * H) / 2, 'the chip stands under the name').toBeGreaterThanOrEqual(L.box.y1)
            expect(Math.abs(q.x)).toBeLessThanOrEqual(1)
          }
        }
        expect(L.build, 'the name is built').toBeDefined()
        expect((1 - (L.build?.up ?? 1)) * 12, `every word is up ${READ_SECONDS} s before the last frame, however long the name`).toBeGreaterThanOrEqual(READ_SECONDS - 1e-6)
        expect(s.shots.some((k) => Math.abs(k.t - s.acts.hold[0]) < 1e-6), 'the held frame starts where the camera settles').toBe(true)
        const end = s.shots.at(-1)
        const still = sampleShot(s.shots, 1 - 10 / 360)
        for (const k of ['x', 'y', 'zoom', 'yaw', 'tilt'] as const) expect(still[k], `the last ten frames are still: ${k}`).toBeCloseTo(end?.[k] ?? NaN, 6)
      })
    }
  }
})
