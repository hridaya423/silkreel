import { describe, expect, it } from 'vitest'
import { parseKicadPcb } from './kicad-ingest.js'

const board = (body: string) => parseKicadPcb(`(kicad_pcb (version 20241229) (generator pcbnew)\n${body}\n)`, 'edge.kicad_pcb')

describe('arcs keep the direction the file gives them', () => {
  it('a clockwise copper arc under 180° ends on its end point', () => {
    const model = board('(arc (start 1 0) (mid 0.7071 -0.7071) (end 0 -1) (width 0.2) (layer "F.Cu"))')
    const points = model.copper['F.Cu']?.traces[0]?.points ?? []
    const last = points[points.length - 1]
    const middle = points[Math.floor(points.length / 2)]
    expect(last?.x).toBeCloseTo(0, 3)
    expect(last?.y).toBeCloseTo(-1, 3)
    expect(middle?.x).toBeCloseTo(0.7071, 2)
    expect(middle?.y).toBeCloseTo(-0.7071, 2)
  })

  it('a clockwise silk arc over 180° ends on its end point', () => {
    const model = board('(gr_arc (start 1 0) (mid -0.7071 -0.7071) (end 0 1) (stroke (width 0.12)) (layer "F.SilkS"))')
    const points = model.silkscreen['F.SilkS']?.lines[0]?.points ?? []
    const last = points[points.length - 1]
    const middle = points[Math.floor(points.length / 2)]
    expect(last?.x).toBeCloseTo(0, 3)
    expect(last?.y).toBeCloseTo(1, 3)
    expect(middle?.x).toBeCloseTo(-0.7071, 2)
    expect(middle?.y).toBeCloseTo(-0.7071, 2)
  })

  it('a counter-clockwise arc still ends on its end point', () => {
    const model = board('(arc (start 1 0) (mid 0.7071 0.7071) (end 0 1) (width 0.2) (layer "F.Cu"))')
    const points = model.copper['F.Cu']?.traces[0]?.points ?? []
    const last = points[points.length - 1]
    expect(last?.x).toBeCloseTo(0, 3)
    expect(last?.y).toBeCloseTo(1, 3)
  })
})

describe('slotted drills', () => {
  const model = board(`(footprint "Slots" (layer "F.Cu") (at 0 0)
    (pad "1" thru_hole oval (at 0 0) (size 1.6 2.6) (drill oval 1 2) (layers "*.Cu"))
    (pad "" np_thru_hole oval (at 5 0) (size 0.8 1.4) (drill oval 0.6 1.2) (layers "*.Cu"))
  )`)

  it('a plated slot is a drill hit as long as the slot', () => {
    expect(model.drill.filter((d) => d.plated).map((d) => d.dia)).toEqual([2])
  })

  it('an unplated slot takes its length from the drill, not the pad', () => {
    expect(model.drill.filter((d) => !d.plated).map((d) => d.dia)).toEqual([1.2])
  })
})

describe('text and encoding', () => {
  it('board text that reads "user", "value" or "reference" keeps its words', () => {
    const model = board(`(gr_text "user" (at 1 1) (layer "F.SilkS"))
      (gr_text "value" (at 2 1) (layer "F.SilkS"))
      (gr_text "reference" (at 3 1) (layer "F.SilkS"))`)
    expect(model.silkscreen['F.SilkS']?.texts.map((t) => t.value)).toEqual(['user', 'value', 'reference'])
  })

  it('reads a board saved with a UTF-8 byte order mark', () => {
    const model = parseKicadPcb(String.fromCharCode(0xfeff) + '(kicad_pcb (version 20241229) (generator pcbnew) (gr_text "BOM" (at 1 1) (layer "F.SilkS")))', 'bom.kicad_pcb')
    expect(model.silkscreen['F.SilkS']?.texts[0]?.value).toBe('BOM')
  })
})
