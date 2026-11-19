import type { BoardModel, Footprint } from '@silk-reel/ingest'

/** what the file says about the board, as both films print it */
export interface BoardFacts {
  /** the Edge.Cuts outline's extent, as laid out in the file (x, then y) */
  widthMm: number
  heightMm: number
  thicknessMm: number
  copperLayers: number
  /** real components: annotated, with pads, not a fiducial, mounting hole, logo or bare test point */
  parts: number
  nets: number
}

const MARKS = /^(FID|MK|MH|H|LOGO|G)\d/i
const MARK_VALUE = /fiducial|mounting|logo/i

export function isComponent(fp: Footprint): boolean {
  if (fp.padRefs.length === 0 || fp.ref.startsWith('#') || fp.ref.startsWith('REF')) return false
  if (MARKS.test(fp.ref) || MARK_VALUE.test(fp.value ?? '')) return false
  return !/^TP\d/i.test(fp.ref) || fp.models.length > 0
}

const tenth = (v: number): number => Math.round(v * 10) / 10

export function boardFacts(board: BoardModel): BoardFacts {
  const pts = board.outline.flatMap((path) => path.points)
  const xs = pts.length > 1 ? pts.map((p) => p.x) : [board.bbox.min.x, board.bbox.max.x]
  const ys = pts.length > 1 ? pts.map((p) => p.y) : [board.bbox.min.y, board.bbox.max.y]
  const copper = new Set([...Object.keys(board.copper), ...board.layers.filter((l) => l.kind === 'copper').map((l) => l.name)].filter((n) => /\.Cu$/.test(n)))
  return {
    widthMm: tenth(Math.max(...xs) - Math.min(...xs)),
    heightMm: tenth(Math.max(...ys) - Math.min(...ys)),
    thicknessMm: Math.round(board.stackup.thickness * 100) / 100,
    copperLayers: copper.size,
    parts: board.footprints.filter(isComponent).length,
    nets: board.nets.filter((n) => n.name.length > 0).length
  }
}
