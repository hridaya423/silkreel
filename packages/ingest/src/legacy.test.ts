import { describe, expect, it } from 'vitest'
import { parseKicadPcb } from './kicad-ingest.js'

const OUTLINE = '(gr_line (start 0 0) (end 20 0) (layer Edge.Cuts) (width 0.1))'

describe('KiCad 5 and older files', () => {
  const v5 = `(kicad_pcb (version 20171130) (host pcbnew 5.1.6)
  (layers (0 Top signal) (1 GND power) (31 Bottom signal) (37 F.SilkS user) (44 Edge.Cuts user))
  (net 0 "") (net 1 GND)
  (module Package_SO:SOIC-8 (layer Top) (at 10 5 90)
    (fp_text reference U1 (at 0 -3) (layer F.SilkS) (effects (font (size 1 1))))
    (fp_text value NE555 (at 0 3) (layer F.Fab) hide (effects (font (size 1 1))))
    (fp_line (start -2 -2) (end 2 -2) (layer F.SilkS) (width 0.15))
    (pad 1 smd rect (at -2.7 -1.9 90) (size 1.5 0.6) (layers Top F.Paste F.Mask) (net 1 GND))
    (pad 2 thru_hole circle (at 2.7 -1.9 90) (size 1.5 1.5) (drill 0.8) (layers *.Cu *.Mask)))
  (segment (start 1 1) (end 5 1) (width 0.25) (layer Bottom) (net 1))
  (zone (net 1) (net_name GND) (layer GND) (polygon (pts (xy 0 0) (xy 20 0) (xy 20 10))))
  ${OUTLINE})`
  const board = parseKicadPcb(v5, 'v5.kicad_pcb')

  it('reads module nodes as footprints', () => {
    expect(board.footprints.map((f) => f.ref)).toEqual(['U1'])
    expect(board.footprints[0]?.value).toBe('NE555')
    expect(board.footprints[0]?.padRefs).toHaveLength(2)
  })

  it('maps named copper layers to canonical ids by layer number', () => {
    expect(Object.keys(board.copper).sort()).toEqual(['B.Cu', 'F.Cu', 'In1.Cu'])
    expect(board.copper['B.Cu']?.traces).toHaveLength(1)
    expect(board.copper['In1.Cu']?.zones).toHaveLength(1)
    expect(board.footprints[0]?.layer).toBe('F.Cu')
  })

  it('reads a bare width on footprint lines', () => {
    const line = board.silkscreen['F.SilkS']?.lines[0]
    expect(line?.width).toBe(0.15)
  })
})

describe('KiCad 6 and 7 tokens', () => {
  const v7 = `(kicad_pcb (version 20221018) (generator pcbnew)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user) (44 "Edge.Cuts" user))
  (footprint "Lib:Part" (layer "F.Cu") (at 5 5)
    (fp_text reference "U1" (at 0 -2 90 unlocked) (layer "F.SilkS") (effects (font (size 1 1))))
    (fp_text user "TEXT" (at 1 1 unlocked) (layer "F.SilkS") (effects (font (size 1 1))))
    (pad "1" thru_hole circle (at 0 0) (size 1.5 1.5) (drill 0.8) (layers "F&B.Cu")))
  (zone (net 0) (net_name "") (layers "F&B.Cu") (keepout (tracks not_allowed)) (polygon (pts (xy 0 0) (xy 9 0) (xy 9 9))))
  (zone (net 0) (net_name "") (layers "F&B.Cu") (polygon (pts (xy 0 0) (xy 9 0) (xy 9 9)))
    (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 1 0) (xy 1 1)))
    (filled_polygon (layer "B.Cu") (pts (xy 0 0) (xy 2 0) (xy 2 2))))
  ${OUTLINE})`
  const board = parseKicadPcb(v7, 'v7.kicad_pcb')

  it('reads (at x y unlocked) and (at x y rot unlocked)', () => {
    const texts = board.silkscreen['F.SilkS']?.texts ?? []
    expect(texts.map((t) => t.value).sort()).toEqual(['TEXT', 'U1'])
    expect(texts.find((t) => t.value === 'TEXT')?.rot).toBe(0)
    expect(texts.find((t) => t.value === 'U1')?.rot).toBe(90)
  })

  it('puts F&B.Cu pads on both outer layers, never on a layer of that name', () => {
    expect(Object.keys(board.copper).sort()).toEqual(['B.Cu', 'F.Cu'])
    expect(board.copper['F.Cu']?.pads).toHaveLength(1)
    expect(board.copper['B.Cu']?.pads).toHaveLength(1)
  })

  it('skips keepout areas and splits a two-layer zone by its fills', () => {
    expect(board.copper['F.Cu']?.zones).toHaveLength(1)
    expect(board.copper['B.Cu']?.zones).toHaveLength(1)
    expect(board.copper['B.Cu']?.zones[0]?.fills[0]?.[1]?.x).toBe(2)
  })
})
