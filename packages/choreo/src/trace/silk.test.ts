import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import { DEMO_CAST_HINTS } from '../hints'
import type { FilmConfig } from '../types'
import { buildTraceScene } from './scene'
import { boardModel } from '../../test/helpers'

const BOARDS = ['glasgow', 'icebreaker', 'StickHub', 'ecc83-pp', 'video', 'kit-dev-coldfire-xilinx_5213']
const TURN = 2 * Math.PI
const wrap = (a: number): number => ((a % TURN) + TURN) % TURN
const same = (a: number, b: number): boolean => Math.min(wrap(a - b), TURN - wrap(a - b)) < 1e-6

describe('silk is board truth', () => {
  for (const name of BOARDS) {
    it(`${name}: every silk text keeps the file's rotation, mirror and justification, gr_text and footprint text alike`, () => {
      const board = boardModel(`${name}.kicad_pcb`)
      const config: FilmConfig = { style: 'trace', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, ...(DEMO_CAST_HINTS[name] === undefined ? {} : { cast: DEMO_CAST_HINTS[name] }) }
      const s = buildTraceScene(board, resolveConfig(config), 42).scene
      const sources = Object.entries(board.silkscreen).flatMap(([layer, silk]) => silk.texts.map((t) => ({ ...t, layer })))
      expect(s.texts.length).toBeGreaterThan(0)
      const fits = [false, true].flatMap((back) => [0, Math.PI / 2].map((turn) => ({ back, turn })))
        .filter(({ back, turn }) => s.texts.every((t) => sources.some((src) =>
          src.value.trim() === t.text && src.mirrored === back && same(t.rot, (back ? src.rot : -src.rot) * (Math.PI / 180) + turn) && src.justify === t.align && src.vjustify === t.valign)))
      expect(fits.length, `${name}: some drawn text turned, mirrored or re-justified away from the file`).toBeGreaterThan(0)
    })
  }

  it('keeps footprint text upright as KiCad draws it: on ColdFire, R103 (file angle 270) and R211 (file angle 90) draw the same way round, as kicad-cli plots them', () => {
    const board = boardModel('kit-dev-coldfire-xilinx_5213.kicad_pcb')
    const config: FilmConfig = { style: 'trace', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } }
    const s = buildTraceScene(board, resolveConfig(config), 42).scene
    const rot = (text: string): number => s.texts.find((t) => t.text === text)?.rot ?? NaN
    expect(same(rot('R103'), rot('R211'))).toBe(true)
    expect(same(rot('R211'), rot('R212'))).toBe(true)
    const footprintTexts = Object.values(board.silkscreen).flatMap((silk) => silk.texts).filter((t) => t.footprintRef !== undefined && ['R103', 'R211', 'R212', 'R213', 'VX_EN201'].includes(t.value))
    expect(footprintTexts.length).toBe(5)
    for (const t of footprintTexts) expect(t.rot > -90 && t.rot <= 90, `${t.value} at ${t.rot}`).toBe(true)
  })
})
