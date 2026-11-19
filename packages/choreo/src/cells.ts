import type { BoardModel, Vec2 } from '@silk-reel/ingest'
import type { Glyph } from './types'

/**
 * The cell vocabulary: tiny primitives that sit on one lattice pitch. A board
 * reads as a population of these — chamfered ICs, diode leaves, passive pills,
 * via pads, holes — so the census of its footprints decides which ones recur.
 * Every shape lives inside the unit box [-0.5, 0.5].
 */
export type CellKind =
  | 'chip' | 'leaf' | 'pill' | 'half' | 'pad'
  | 'ring' | 'dot' | 'tick' | 'dash' | 'bracket'
  | 'slash' | 'wedge' | 'corner'

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 10): Vec2[] => {
  const out: Vec2[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
  }
  return out
}

const box = (hw: number, hh: number): Vec2[] => [
  { x: -hw, y: -hh },
  { x: hw, y: -hh },
  { x: hw, y: hh },
  { x: -hw, y: hh },
  { x: -hw, y: -hh }
]

const S = 0.42
const PI = Math.PI

const SHAPES: Record<CellKind, { strokes: Vec2[][]; filled?: boolean }> = {
  // IC body with a pin-1 chamfer, top-left
  chip: {
    strokes: [[
      { x: -S + 0.2, y: -S },
      { x: S, y: -S },
      { x: S, y: S },
      { x: -S, y: S },
      { x: -S, y: -S + 0.2 },
      { x: -S + 0.2, y: -S }
    ]]
  },
  // a square whose top-right corner is one big radius — the diode/LED leaf
  leaf: {
    strokes: [[
      { x: -S, y: -S },
      ...arc(S - 0.5, -S + 0.5, 0.5, -PI / 2, 0),
      { x: S, y: S },
      { x: -S, y: S },
      { x: -S, y: -S }
    ]]
  },
  // two-terminal passive: a short body, its end caps marked
  pill: {
    strokes: [box(0.38, 0.2), [{ x: -0.16, y: -0.2 }, { x: -0.16, y: 0.2 }], [{ x: 0.16, y: -0.2 }, { x: 0.16, y: 0.2 }]]
  },
  // D-shape: flat on the left, round on the right — transistors, crystals
  half: {
    strokes: [[
      { x: 0, y: -S },
      { x: -S, y: -S },
      { x: -S, y: S },
      { x: 0, y: S },
      ...arc(0, 0, S, PI / 2, -PI / 2)
    ]]
  },
  // via / test pad: a square with a drilled centre
  pad: {
    strokes: [box(0.26, 0.26), box(0.07, 0.07)]
  },
  ring: { strokes: [arc(0, 0, 0.24, 0, PI * 2, 20)] },
  dot: { strokes: [arc(0, 0, 0.075, 0, PI * 2, 10)], filled: true },
  tick: { strokes: [[{ x: 0, y: -0.36 }, { x: 0, y: 0.36 }]] },
  dash: { strokes: [[{ x: -0.28, y: 0 }, { x: 0.28, y: 0 }]] },
  bracket: {
    strokes: [[{ x: 0.12, y: -0.36 }, { x: -0.1, y: -0.36 }, { x: -0.1, y: 0.36 }, { x: 0.12, y: 0.36 }]]
  },
  slash: { strokes: [[{ x: -0.5, y: 0.5 }, { x: 0.5, y: -0.5 }]] },
  // filled corner wedge — the frame's registration marks
  wedge: {
    strokes: [[{ x: -0.2, y: -0.2 }, { x: 0.2, y: -0.2 }, { x: -0.2, y: 0.2 }, { x: -0.2, y: -0.2 }]],
    filled: true
  },
  corner: { strokes: [[{ x: -0.3, y: 0.1 }, { x: -0.3, y: -0.3 }, { x: 0.1, y: -0.3 }]] }
}

export const cellId = (kind: CellKind): string => `cell:${kind}`

export function cellGlyph(kind: CellKind): Glyph {
  const s = SHAPES[kind]
  return { id: cellId(kind), kind: 'mark', strokes: s.strokes, filled: s.filled === true }
}

export const CELL_KINDS = Object.keys(SHAPES) as CellKind[]

/** half the hero body's long side, in units of its size */
export const HERO_HALF = 0.36

/**
 * The hero, drawn from its own pads in its own frame (the footprint's turn,
 * in degrees as KiCad writes it, taken off): a chamfered body ringed by pin
 * ticks for leaded/QFN parts, or a ball grid for BGAs — the one shape on the
 * loop a designer would point at and say "that's the FPGA".
 */
export function isBallGrid(pads: Array<Vec2 & { num?: string | undefined }>): boolean {
  const xs = pads.map((p) => p.x)
  const ys = pads.map((p) => p.y)
  const w = Math.max(1e-6, Math.max(...xs) - Math.min(...xs))
  const h = Math.max(1e-6, Math.max(...ys) - Math.min(...ys))
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2
  const id = (p: { num?: string | undefined }, i: number): string => (p.num === undefined || p.num === '' ? `#${i}` : p.num)
  const inner = new Set(pads.flatMap((p, i) => (Math.abs(p.x - cx) < w * 0.3 && Math.abs(p.y - cy) < h * 0.3 ? [id(p, i)] : [])))
  return inner.size / new Set(pads.map(id)).size > 0.15
}

export function heroChip(board: BoardModel, ref: string, rotDeg = 0): Glyph | undefined {
  const pads: Array<Vec2 & { num?: string | undefined; r: number }> = []
  const cos = Math.cos((rotDeg * PI) / 180)
  const sin = Math.sin((rotDeg * PI) / 180)
  for (const layer of Object.values(board.copper)) {
    for (const p of layer.pads) if (p.footprintRef === ref) pads.push({ x: p.pos.x * cos - p.pos.y * sin, y: p.pos.x * sin + p.pos.y * cos, num: p.num, r: Math.max(p.size.x, p.size.y) / 2 })
  }
  if (pads.length < 4) return undefined
  const xs = pads.map((p) => p.x)
  const ys = pads.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const w = Math.max(1e-6, maxX - minX)
  const h = Math.max(1e-6, maxY - minY)
  // balls fill the interior; leads hug the perimeter
  const inner = pads.filter((p) => Math.abs(p.x - (minX + maxX) / 2) < w * 0.3 && Math.abs(p.y - (minY + maxY) / 2) < h * 0.3)
  const bga = isBallGrid(pads)
  const ar = Math.min(1.6, Math.max(1 / 1.6, w / h))
  const bw = HERO_HALF * (ar >= 1 ? 1 : ar)
  const bh = HERO_HALF * (ar >= 1 ? 1 / ar : 1)
  const c = 0.09
  const strokes: Vec2[][] = [[
    { x: -bw + c, y: -bh },
    { x: bw, y: -bh },
    { x: bw, y: bh },
    { x: -bw, y: bh },
    { x: -bw, y: -bh + c },
    { x: -bw + c, y: -bh }
  ]]
  if (bga) {
    const k = Math.max(3, Math.min(6, Math.round(Math.sqrt(pads.length) / 2)))
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        const x = -bw + ((i + 0.5) / k) * 2 * bw
        const y = -bh + ((j + 0.5) / k) * 2 * bh
        strokes.push(arc(x, y, Math.min(bw, bh) / (k * 2.6), 0, PI * 2, 8))
      }
    }
  } else {
    const n = Math.max(3, Math.min(8, Math.round(pads.length / 8)))
    const len = 0.09
    for (let i = 0; i < n; i++) {
      const tx = -bw + ((i + 0.5) / n) * 2 * bw
      const ty = -bh + ((i + 0.5) / n) * 2 * bh
      strokes.push([{ x: tx, y: -bh - 0.03 }, { x: tx, y: -bh - 0.03 - len }])
      strokes.push([{ x: tx, y: bh + 0.03 }, { x: tx, y: bh + 0.03 + len }])
      strokes.push([{ x: -bw - 0.03, y: ty }, { x: -bw - 0.03 - len, y: ty }])
      strokes.push([{ x: bw + 0.03, y: ty }, { x: bw + 0.03 + len, y: ty }])
    }
    strokes.push(arc(-bw + 0.12, -bh + 0.12, 0.025, 0, PI * 2, 8))
    if (inner.length > 0) {
      const u = (2 * bw) / w
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const ew = Math.min(bw - 0.18, u * Math.max(...inner.map((p) => Math.abs(p.x - cx) + p.r)))
      const eh = Math.min(bh - 0.18, u * Math.max(...inner.map((p) => Math.abs(p.y - cy) + p.r)))
      if (ew > 0.03 && eh > 0.03) strokes.push(box(ew, eh))
    }
  }
  return { id: `hero:${ref}`, kind: 'package', strokes }
}

/** footprint class → the body cell that stands for it */
type FpClass = 'ic' | 'diode' | 'passive' | 'conn' | 'hole' | 'tp' | 'xtal' | 'transistor' | 'other'

export function classify(ref: string, value: string | undefined): FpClass {
  const v = value ?? ''
  if (/^(FID|H|MH|MK)\d*$/i.test(ref) || /mount|fiducial/i.test(v)) return 'hole'
  if (/^TP\d/i.test(ref)) return 'tp'
  if (/^(U|IC)\d/i.test(ref)) return 'ic'
  if (/^(D|LED)\d/i.test(ref)) return 'diode'
  if (/^(C|R|L|RN|FB|RR)\d/i.test(ref)) return 'passive'
  if (/^(J|P|CN|CON|X|USB)\d/i.test(ref) || /conn|header|usb/i.test(v)) return 'conn'
  if (/^Y\d/i.test(ref)) return 'xtal'
  if (/^Q\d/i.test(ref)) return 'transistor'
  return 'other'
}

export const CLASS_CELL: Record<FpClass, CellKind> = {
  ic: 'chip',
  diode: 'leaf',
  passive: 'pill',
  conn: 'bracket',
  hole: 'ring',
  tp: 'pad',
  xtal: 'half',
  transistor: 'half',
  other: 'pad'
}

/** relative weight of each body cell in this board's population (sums to 1) */
export interface Census {
  body: Array<{ kind: CellKind; w: number }>
  /** board has holes/fiducials — rings join the joint vocabulary */
  holes: boolean
}

const BODY: CellKind[] = ['chip', 'leaf', 'pill', 'half', 'pad']

export function takeCensus(board: BoardModel): Census {
  const counts = new Map<CellKind, number>(BODY.map((k) => [k, 0]))
  let holes = false
  for (const fp of board.footprints) {
    const cls = classify(fp.ref, fp.value)
    if (cls === 'hole') holes = true
    const kind = CLASS_CELL[cls]
    if (counts.has(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  let vias = 0
  for (const layer of Object.values(board.copper)) vias += layer.vias.length
  counts.set('pad', (counts.get('pad') ?? 0) + Math.min(20, vias / 10))
  if (board.drill.some((d) => !d.plated && d.dia >= 2)) holes = true
  // sqrt compresses the passive flood; a floor keeps every shape in the mix
  const raw = BODY.map((kind) => ({ kind, w: Math.sqrt(counts.get(kind) ?? 0) + 0.6 }))
  const total = raw.reduce((n, r) => n + r.w, 0)
  return { body: raw.map((r) => ({ kind: r.kind, w: r.w / total })), holes }
}
