import { describe, expect, it } from 'vitest'
import { parseKicadPcb } from '@silk-reel/ingest'
import { extractParts } from './parts'
import { boardModel } from '../../test/helpers'

describe('part kinds', () => {
  it('a connector whose pins sit on a shallow arc is not a tube', () => {
    const pad = (n: string, type: string, x: number, y: number): string =>
      `(pad "${n}" ${type} oval (at ${x} ${y}) (size 1.2 2.9) (layers ${type === 'smd' ? '"F.Cu"' : '"*.Cu"'}))`
    const board = parseKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "Connector_USB:USB_A_Receptacle_GCT_USB1046" (layer "F.Cu") (at 100 100)
        (property "Reference" "J1")
        ${pad('', 'smd', -6.4, -3.55)} ${pad('', 'smd', 6.4, -3.55)}
        ${pad('1', 'smd', -3.5, -7.25)} ${pad('2', 'smd', -1, -7.25)} ${pad('3', 'smd', 1, -7.25)} ${pad('4', 'smd', 3.5, -7.25)}
        ${pad('SH', 'thru_hole', -6.4, -3.55)} ${pad('SH', 'thru_hole', 6.4, -3.55)}))`, 'usb.kicad_pcb')
    expect(extractParts(board).map((p) => p.kind)).toEqual(['conn'])
  })

  it('a noval socket is still a tube', () => {
    expect(extractParts(boardModel('ecc83-pp.kicad_pcb')).filter((p) => p.kind === 'valve').map((p) => p.ref)).toEqual(['U1'])
  })
})

describe('part bodies', () => {
  const body = (rot: number): { w: number; h: number } => {
    const board = parseKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "Resistor_SMD:R_1206" (layer "F.Cu") (at 30 15 ${rot})
        (property "Reference" "R1")
        (pad "1" smd rect (at -2 0 ${rot}) (size 1 0.4) (layers "F.Cu"))
        (pad "2" smd rect (at 2 0 ${rot}) (size 1 0.4) (layers "F.Cu"))))`, 'r.kicad_pcb')
    const part = extractParts(board)[0]
    if (part === undefined) throw new Error('no part')
    return { w: part.w, h: part.h }
  }

  it('a part keeps its size when its footprint turns', () => {
    const flat = body(0)
    for (const rot of [30, 45, 90, 135, 200]) {
      expect(body(rot).w, `width at ${rot}°`).toBeCloseTo(flat.w, 3)
      expect(body(rot).h, `height at ${rot}°`).toBeCloseTo(flat.h, 3)
    }
  })
})

describe('which footprints are parts', () => {
  const refs = ['HDMI1', 'NTC1', 'GPS1', 'SH1', 'KEYPAD1', 'HS1', 'R1', 'H1', 'MH2', 'TP3', 'FID1', 'NT1', 'G1', 'MK1', 'JP1', 'LOGO']
  const board = parseKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
    ${refs.map((ref, i) => `(footprint "Lib:Part" (layer "F.Cu") (at ${10 * i} 10)
      (property "Reference" "${ref}")
      (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu"))
      (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu")))`).join('\n')})`, 'refs.kicad_pcb')

  it('keeps real parts whose reference only starts like a hole, tie or mark', () => {
    expect(extractParts(board).map((p) => p.ref)).toEqual(['HDMI1', 'NTC1', 'GPS1', 'SH1', 'KEYPAD1', 'HS1', 'R1'])
  })
})
