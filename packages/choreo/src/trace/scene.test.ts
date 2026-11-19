import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import type { Aspect, FilmConfig } from '../types'
import { buildTraceScene, partNumber } from './scene'
import { boardModel } from '../../test/helpers'
import { parseKicadPcb } from '@silk-reel/ingest'

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

      it('packs segs at stride 7, t0 ascending; the copper around the opening part (the hero, unless the film opens on another part) is already drawn on the first frame, so it fills the frame, and all routing is done by the end of this board\'s drawing act', () => {
        let badStride = 0
        let badTime = 0
        const drawn = { own: 0, ownLen: 0, rest: 0, restLen: 0 }
        for (const layer of scene.layers) {
          if (layer.segs.length % 7 !== 0) badStride += 1
          let prev = -Infinity
          for (let i = 0; i < layer.segs.length; i += 7) {
            const t0 = layer.segs[i + 5] as number
            const t1 = layer.segs[i + 6] as number
            if (t0 < prev || t0 > t1 || t0 > scene.acts.draw[1] - 0.5 / 24 + 1e-9 || t1 > scene.acts.draw[1] + 1e-9) badTime += 1
            prev = t0
            const len = Math.hypot((layer.segs[i + 2] as number) - (layer.segs[i] as number), (layer.segs[i + 3] as number) - (layer.segs[i + 1] as number))
            const out = len * Math.min(1, Math.max(0, -t0 / Math.max(1e-9, t1 - t0)))
            if (scene.opening === undefined ? scene.groups[layer.groups[i / 7] as number]?.hero === true : scene.opening.groups.includes(layer.groups[i / 7] as number)) {
              drawn.own += out
              drawn.ownLen += len
            } else {
              drawn.rest += out
              drawn.restLen += len
            }
          }
        }
        expect(badStride).toBe(0)
        expect(badTime).toBe(0)
        expect(drawn.own / drawn.ownLen).toBeGreaterThanOrEqual(0.05)
        expect(drawn.own / drawn.ownLen).toBeLessThanOrEqual(0.85)
        if (drawn.restLen > 0) expect(drawn.rest / drawn.restLen).toBeLessThan(0.35)
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
    const { scene } = buildTraceScene(boardModel('glasgow.kicad_pcb'), resolved('16:9'), 1)
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
    expect(partNumber('S5933_PQ160')).toBe('S5933_PQ160')
    expect(partNumber('Bus_DDR4_SODIMM_CUSTOM_Jetson-Orin-H9.2mm-socket')).toBeUndefined()
    expect(partNumber('Power')).toBeUndefined()
    expect(partNumber('100nF')).toBe('100nF')
    expect(partNumber('STM32F407VGT6TR-EXTRA-LONG')).toBe('STM32F407VGT6TR-EXT…')
  })
})

describe('rotated footprints', () => {
  const turned = (rot: number, aspect: Aspect, outline: string) => {
    const board = parseKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (gr_rect (start 0 0) (end ${outline}) (stroke (width 0.1)) (layer "Edge.Cuts"))
      (footprint "Resistor_SMD:R_1206" (layer "F.Cu") (at 15 15 ${rot})
        (property "Reference" "R1")
        (pad "1" smd rect (at -2 0 ${rot}) (size 1 0.4) (layers "F.Cu"))
        (pad "2" smd rect (at 2 0 ${rot}) (size 1 0.4) (layers "F.Cu"))))`, 'turned.kicad_pcb')
    return buildTraceScene(board, resolved(aspect), 1).scene
  }
  const sameAxis = (a: number, b: number): number => Math.abs(Math.sin(a - b))

  for (const [aspect, outline] of [['16:9', '60 30'], ['16:9', '30 60'], ['4:5', '30 60']] as const) {
    for (const rot of [30, 45, 120]) {
      it(`a ${outline} board at ${aspect}: pads and body at ${rot}° lie along the row of pads`, () => {
        const scene = turned(rot, aspect, outline)
        const [a, b] = scene.pads
        if (a === undefined || b === undefined) throw new Error('expected two pads')
        const row = Math.atan2(b.y - a.y, b.x - a.x)
        expect(a.w).toBeGreaterThan(a.h)
        expect(sameAxis(a.rot, row), 'pad angle against the row').toBeLessThan(1e-6)
        const part = scene.parts[0]
        if (part === undefined) throw new Error('expected a part')
        expect(part.w).toBeGreaterThan(part.h)
        expect(sameAxis(part.rot, row), 'body angle against the row').toBeLessThan(1e-6)
      })
    }
  }
})

describe('pad corners', () => {
  it('draws a roundrect whose file gives it nearly square corners as a rectangle, and every other roundrect rounded', () => {
    const board = parseKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (gr_rect (start 0 0) (end 40 30) (stroke (width 0.1)) (layer "Edge.Cuts"))
      (footprint "Package_DFN_QFN:QFN-48" (layer "F.Cu") (at 20 15)
        (property "Reference" "U1")
        (pad "1" smd roundrect (at -2 0) (size 0.8 0.3) (layers "F.Cu" "F.Mask") (roundrect_rratio 0.25))
        (pad "49" smd roundrect (at 0 0) (size 5.6 5.6) (layers "F.Cu" "F.Mask") (roundrect_rratio 0.045))
        (pad "2" smd roundrect (at 2 0) (size 0.8 0.3) (layers "F.Cu" "F.Mask"))))`, 'corners.kicad_pcb')
    const pads = [...buildTraceScene(board, resolved('16:9'), 1).scene.pads].sort((p, q) => q.w - p.w)
    expect(pads.map((q) => q.shape)).toEqual(['rect', 'round', 'round'])
  })
})

describe('the main chip\'s own pads', () => {
  it('never draw as rings, so an exposed pad shows its surface, while another oversized pad keeps the ring', () => {
    const pins = Array.from({ length: 12 }, (_, i) => `(pad "${i + 1}" smd roundrect (at ${-3 + (i % 6) * 1.2} ${i < 6 ? -3.4 : 3.4}) (size 0.3 0.8) (layers "F.Cu" "F.Mask") (net ${i + 1} "N${i + 1}"))`).join(' ')
    const board = parseKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (gr_rect (start 0 0) (end 40 30) (stroke (width 0.1)) (layer "Edge.Cuts"))
      (footprint "Package_DFN_QFN:QFN-12" (layer "F.Cu") (at 20 15)
        (property "Reference" "U1")
        ${pins}
        (pad "13" smd roundrect (at 0 0) (size 5.6 5.6) (layers "F.Cu" "F.Mask") (roundrect_rratio 0.045)))
      (footprint "MountingHole" (layer "F.Cu") (at 5 5)
        (property "Reference" "H1")
        (pad "1" thru_hole circle (at 0 0) (size 6 6) (drill 3.2) (layers "*.Cu" "*.Mask"))))`, 'exposed.kicad_pcb')
    const s = buildTraceScene(board, resolved('4:5'), 1).scene
    const own = s.pads.filter((pad) => pad.hero === true)
    expect(own.length).toBe(13)
    expect(own.filter((pad) => pad.ring === true)).toEqual([])
    expect(s.pads.filter((pad) => pad.hero !== true).map((pad) => pad.ring)).toEqual([true])
  })
})
