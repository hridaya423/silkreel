import { describe, expect, it } from 'vitest'
import { pickHero } from './hero'
import { boardModel } from '../../test/helpers'
import type { BoardModel } from '@silk-reel/ingest'

const emptyBoard = (): BoardModel => ({
  source: { format: 'kicad', files: [], boardName: 'empty' },
  stackup: { thickness: 1.6 },
  bbox: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  outline: [],
  layers: [],
  copper: {},
  silkscreen: {},
  footprints: [],
  drill: [],
  nets: [],
  stats: { traces: 0, pads: 0, vias: 0, zones: 0, texts: 0, drills: 0 },
  warnings: []
})

describe('pickHero', () => {
  it('picks a U-prefixed footprint with plenty of seed pads on glasgow', () => {
    const board = boardModel('glasgow.kicad_pcb')
    const hero = pickHero(board)
    expect(hero).toBeDefined()
    expect(hero?.ref).toMatch(/^U/)
    expect(hero?.pads.length).toBeGreaterThanOrEqual(20)
  })
  it('honours preferRefs order when several hints match U footprints', () => {
    const board = boardModel('icebreaker.kicad_pcb')
    const hero = pickHero(board, { preferRefs: ['U4', 'U5'] })
    expect(hero?.ref).toBe('U4')
  })
  it.each([
    ['kit-dev-coldfire-xilinx_5213.kicad_pcb', 'U102'],
    ['icebreaker.kicad_pcb', 'U6'],
    ['glasgow.kicad_pcb', 'U30'],
    ['StickHub.kicad_pcb', 'U1']
  ])('with no hint, %s is about the chip that carries the most signals: %s', (file, ref) => {
    expect(pickHero(boardModel(file))?.ref).toBe(ref)
  })
  it('returns undefined when the board has no footprints', () => {
    expect(pickHero(emptyBoard())).toBeUndefined()
  })
})
