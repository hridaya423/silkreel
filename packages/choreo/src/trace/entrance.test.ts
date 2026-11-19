import { describe, expect, it } from 'vitest'
import { compileTimeline } from '../compile'
import { ASPECT_SIZE } from '../layout'
import type { Aspect, FilmConfig, TraceTimeline } from '../types'
import { makeCam, project, sampleShot } from './camera'
import { ENTRY_SLIVER } from './scene'
import { boardModel } from '../../test/helpers'

const FILMS: Array<[string, Aspect]> = [
  ['glasgow', '4:5'], ['glasgow', '9:16'], ['glasgow', '16:9'],
  ['icebreaker', '4:5'], ['icebreaker', '9:16'],
  ['StickHub', '16:9'], ['kit-dev-coldfire-xilinx_5213', '16:9']
]

describe('no part appears from nothing', () => {
  for (const [name, aspect] of FILMS) {
    it(`${name} ${aspect}: a falling part's first visible frame shows at most ${ENTRY_SLIVER} of it, crossing a frame edge, and the frame before shows none of it`, () => {
      const size = ASPECT_SIZE[aspect]
      const config: FilmConfig = { style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { ...size, fps: 30 } }
      const tl = compileTimeline(boardModel(`${name}.kicad_pcb`), config) as TraceTimeline
      const s = tl.scene
      const frames = tl.totalFrames
      for (const pt of s.parts) {
        if (pt.kind === 'pin' || pt.kind === 'valve') continue
        const fall = pt.fall ?? 0
        const c = Math.cos(pt.rot)
        const sn = Math.sin(pt.rot)
        const seen = (f: number): number => {
          const u = (pt.t - f / frames) / fall
          if (u > 1 + 1e-9) return 0
          const v = Math.max(0, u)
          const k = pt.hero === true ? v * v : v * v * (3 - 2 * v)
          const cam = makeCam(sampleShot(s.shots, f / frames), size.width, size.height)
          const qs = [-1, 1].flatMap((a) => [-1, 1].flatMap((b) => [0, pt.z].map((z) => project(cam,
            pt.x + k * (pt.enter?.x ?? 0) + (c * a * pt.w - sn * b * pt.h) / 2,
            pt.y + k * (pt.enter?.y ?? 0) + (sn * a * pt.w + c * b * pt.h) / 2,
            k * (pt.lift ?? 0) + z))))
          expect(qs.every((q) => q.w > 0)).toBe(true)
          const xs = qs.map((q) => q.x)
          const ys = qs.map((q) => q.y)
          const full = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
          const cx = Math.max(0, Math.min(1, Math.max(...xs)) - Math.max(-1, Math.min(...xs)))
          const cy = Math.max(0, Math.min(1, Math.max(...ys)) - Math.max(-1, Math.min(...ys)))
          return (cx * cy) / full
        }
        const start = Math.ceil((pt.t - fall) * frames - 1e-9)
        const landed = Math.round(pt.t * frames)
        for (let f = start; f <= landed; f++) {
          const share = seen(f)
          if (share === 0) continue
          expect(share).toBeLessThanOrEqual(ENTRY_SLIVER)
          break
        }
      }
    }, 120_000)
  }
})
