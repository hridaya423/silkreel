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
