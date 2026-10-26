import type { BoardModel, Vec2 } from '@silk-reel/ingest'
import { heroPart } from '../acts'
import type { CastHints } from '../types'

export interface HeroPick {
  ref: string
  /** the hero sits on the back copper — the film is shot from that side */
  back: boolean
  center: Vec2
  /** every hero pad on every copper layer — growth seeds */
  pads: Array<{ layer: string; pos: Vec2 }>
}

export function pickHero(board: BoardModel, hints?: CastHints, ref?: string): HeroPick | undefined {
  if (board.footprints.length === 0) return undefined
  const fp = heroPart(board, ref, hints)
  if (fp === undefined) return undefined
  const hero = fp
  const pads: HeroPick['pads'] = []
  for (const [layer, copper] of Object.entries(board.copper)) {
    for (const pad of copper.pads) {
      if (pad.footprintRef === hero.ref) pads.push({ layer, pos: pad.pos })
    }
  }
  const center = pads.length > 0
    ? { x: pads.reduce((s, p) => s + p.pos.x, 0) / pads.length, y: pads.reduce((s, p) => s + p.pos.y, 0) / pads.length }
    : hero.pos
  return { ref: hero.ref, back: hero.layer.startsWith('B.'), center, pads }
}
