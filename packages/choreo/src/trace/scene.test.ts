import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import type { Aspect, FilmConfig } from '../types'
import { buildTraceScene, partNumber } from './scene'
import { boardModel } from '../../test/helpers'

const BOARDS = [
  'StickHub.kicad_pcb',
  'ecc83-pp.kicad_pcb',
  'glasgow.kicad_pcb',
  'icebreaker.kicad_pcb',
  'kit-dev-coldfire-xilinx_5213.kicad_pcb',
  'video.kicad_pcb'
] as const

function resolved(aspect: Aspect) {
  const config: FilmConfig = {
    style: 'trace',
    aspect,
    knobs: {},
    seed: 1,
    duration: 'auto',
    output: { width: 1080, height: 1350, fps: 30 }
  }
  return resolveConfig(config)
}

for (const name of BOARDS) {
  for (const aspect of ['4:5', '16:9'] as const) {
    describe(`${name} @ ${aspect}`, () => {
      const board = boardModel(name)
      const r = resolved(aspect)
      const { scene } = buildTraceScene(board, r, 1)

      it('packs segs at stride 7, t0 ascending, all t within [0, 0.8]', () => {
        let total = 0
        let inBeat = 0
        // count violations, assert once — per-seg expect() is too slow on big boards
        let badStride = 0
        let badTime = 0
        for (const layer of scene.layers) {
          if (layer.segs.length % 7 !== 0) badStride += 1
          let prev = -1
          for (let i = 0; i < layer.segs.length; i += 7) {
            const t0 = layer.segs[i + 5] as number
            const t1 = layer.segs[i + 6] as number
            if (t0 < prev || t0 < 0 || t0 > t1 || t1 > 0.8) badTime += 1
            prev = t0
            total += 1
            if (t0 >= scene.beats.growth[0]) inBeat += 1
          }
        }
        expect(badStride).toBe(0)
        expect(badTime).toBe(0)
        expect(inBeat / total).toBeGreaterThanOrEqual(0.9)
      })

      it('keeps every seg endpoint and pad inside the frame', () => {
        const pad = 2
        let out = 0
        for (const layer of scene.layers) {
          for (let i = 0; i < layer.segs.length; i += 7) {
            for (const x of [layer.segs[i] as number, layer.segs[i + 2] as number]) {
              if (x < -pad || x > r.width + pad) out += 1
            }
            for (const y of [layer.segs[i + 1] as number, layer.segs[i + 3] as number]) {
              if (y < -pad || y > r.height + pad) out += 1
            }
          }
        }
        expect(out).toBe(0)
        expect(scene.pads.length).toBeGreaterThan(0)
        let padsOut = 0
        for (const p of scene.pads) {
          if (p.x < -pad || p.x > r.width + pad || p.y < -pad || p.y > r.height + pad) padsOut += 1
        }
        expect(padsOut).toBe(0)
      })
    })
  }
}

describe('camera track', () => {
  it('rides a low-fill board zoomed in, then pulls back to the whole board for the hold', () => {
    const { scene } = buildTraceScene(boardModel('video.kicad_pcb'), resolved('4:5'), 1)
    const ts = scene.camera.map((k) => k.t)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(Math.max(...scene.camera.map((k) => k.zoom))).toBeGreaterThan(1.3)
    // whole board back in frame early enough to hold ≥1.5s of a 12s loop before the fade
    const reveal = scene.camera.find((k) => k.zoom === 1 && k.t > 0.5)
    expect(reveal?.t).toBeLessThanOrEqual(0.96 - 1.5 / 12)
  })
  it('keeps a frame-filling board on a gentle push', () => {
    const { scene } = buildTraceScene(boardModel('glasgow.kicad_pcb'), resolved('4:5'), 1)
    expect(scene.camera.map((k) => k.zoom)).toEqual([1, 1.05])
  })
})

describe('buildTraceScene performance', () => {
  it('compiles video.kicad_pcb in under 4s', () => {
    const board = boardModel('video.kicad_pcb')
    const r = resolved('4:5')
    const t0 = performance.now()
    buildTraceScene(board, r, 1)
    const ms = performance.now() - t0
    console.log(`buildTraceScene(video) = ${ms.toFixed(0)}ms`)
    expect(ms).toBeLessThan(4000)
  })
})

describe('hero caption', () => {
  it('prints part numbers and drops library names', () => {
    expect(partNumber('ICE40HX8K-BG121')).toBe('ICE40HX8K-BG121')
    expect(partNumber('NE555')).toBe('NE555')
    expect(partNumber('Conn_01x02_Pin')).toBeUndefined()
    expect(partNumber('Bus_DDR4_SODIMM_CUSTOM_Jetson-Orin-H9.2mm-socket')).toBeUndefined()
    expect(partNumber('Power')).toBeUndefined()
    expect(partNumber('100nF')).toBe('100nF')
    expect(partNumber('STM32F407VGT6TR-EXTRA-LONG')).toBe('STM32F407VGT6TR-EXT…')
  })
})
