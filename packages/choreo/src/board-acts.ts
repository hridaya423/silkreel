import type { BoardModel, Footprint, Vec2 } from '@silk-reel/ingest'
import { HERO_SIZE, MARK_SIZE, PLAN_TONE, RAIL_PARTS, hullGap, outline, padCounts, partKind, partsOnNets } from './acts'
import type { ActPlan, Cell } from './acts'
import { classify } from './cells'
import type { CellKind } from './cells'
import type { FormationId, Glyph } from './types'

type Sym = Cell['sym']

export interface BoardInput {
  board: BoardModel
  hero: Footprint | undefined
  heroGlyph: Glyph | undefined
  chipTurn: number
  view: { nx: number; ny: number }
  id: FormationId
  skip?: Set<string>
}

interface Spot {
  x: number
  y: number
  kind: CellKind
  size: number
  ref: string
  rot?: number
  at: number
}

const GAP = 0.3

const copies = (pts: Vec2[], sym: Sym): Vec2[][] => {
  const fx = pts.map((p) => ({ x: -p.x, y: p.y }))
  const fy = pts.map((p) => ({ x: p.x, y: -p.y }))
  const r = pts.map((p) => ({ x: -p.x, y: -p.y }))
  switch (sym) {
    case 'single': return [pts]
    case 'mirrorX': return [pts, fx]
    case 'rot2': return [pts, r]
    case 'quad': return [pts, fx, fy, r]
  }
}

const real = (board: BoardModel): Footprint[] => board.footprints.filter((f) => !/\*/.test(f.ref) && !['hole', 'tp'].includes(classify(f.ref, f.value)))

function extents(board: BoardModel): Map<string, { w: number; h: number }> {
  const spans = new Map<string, { x0: number; y0: number; x1: number; y1: number }>()
  for (const layer of Object.values(board.copper)) {
    for (const p of layer.pads) {
      if (p.footprintRef === undefined) continue
      const b = spans.get(p.footprintRef) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      const r = Math.max(p.size.x, p.size.y) / 2
      spans.set(p.footprintRef, { x0: Math.min(b.x0, p.pos.x - r), y0: Math.min(b.y0, p.pos.y - r), x1: Math.max(b.x1, p.pos.x + r), y1: Math.max(b.y1, p.pos.y + r) })
    }
  }
  return new Map([...spans].map(([ref, b]) => [ref, { w: b.x1 - b.x0, h: b.y1 - b.y0 }]))
}

function glyphHull(g: Glyph | undefined, size: number, rot: number, x: number, y: number): Vec2[] {
  const pts = (g?.strokes.flat() ?? []).map((q) => ({ x: x + (q.x * Math.cos(rot) - q.y * Math.sin(rot)) * size, y: y + (q.x * Math.sin(rot) + q.y * Math.cos(rot)) * size }))
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return [{ x: Math.min(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.max(...ys) }, { x: Math.min(...xs), y: Math.max(...ys) }]
}

function placeAll(spots: Spot[], sym: Sym, fixed: Vec2[][], nudge: Array<[number, number]>, room: { nx: number; ny: number }): Spot[] {
  const shapes = fixed.flatMap((s) => copies(s, 'single'))
  const out: Spot[] = []
  for (const s of spots) {
    for (const [dx, dy] of nudge) {
      const x = s.x + dx
      const y = s.y + dy
      const o = outline(s.kind, s.size, s.rot ?? 0, x, y)
      if (o.some((p) => Math.abs(p.x) > room.nx - 0.6 || Math.abs(p.y) > room.ny - 0.6)) continue
      const mine = copies(o, sym)
      const self = mine.slice(1).every((c) => hullGap(o, c) >= GAP || (sym !== 'single' && c.every((p, i) => Math.hypot(p.x - (o[i] as Vec2).x, p.y - (o[i] as Vec2).y) < 1e-9)))
      if (!self) continue
      if (!mine.every((m) => shapes.every((q) => hullGap(m, q) >= GAP))) continue
      shapes.push(...mine)
      out.push({ ...s, x, y })
      break
    }
  }
  return out
}

const RING: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [2, 0], [0, 2], [2, 1], [1, 2], [2, 2]]

function sizeOf(ext: Map<string, { w: number; h: number }>, ref: string, k: number): number {
  const e = ext.get(ref)
  return Math.max(0.45, Math.min(1.5, e === undefined ? 0.7 : Math.max(e.w, e.h) * k))
}

function cellsOf(spots: Spot[], sym: Sym): Cell[] {
  const reach = Math.max(1e-6, ...spots.map((s) => s.at))
  return spots.map((s) => ({ x: s.x, y: s.y, role: s.kind === 'chip' ? 'anchor' : 'body', sym, kind: s.kind, size: s.size, tone: PLAN_TONE[s.kind] ?? 0.72, at: 0.1 + (0.8 * s.at) / reach, group: s.ref, ...(s.rot === undefined ? {} : { rot: s.rot }) }))
}

export const CLUSTER_PARTS = 44
const CLUSTER_POOL = 120
const DIAGONAL_PARTS = 20

function mixed<T extends { f: Footprint }>(near: T[], pads: Map<string, number>, count: number): T[] {
  const byKind = new Map<CellKind, T[]>()
  for (const n of near) {
    const k = partKind(n.f, pads)
    byKind.set(k, [...(byKind.get(k) ?? []), n])
  }
  const queues = [...byKind.values()]
  const out: T[] = []
  while (out.length < count && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift()
      if (next !== undefined && out.length < count) out.push(next)
    }
  }
  return out
}

export function clusterAct(input: BoardInput): ActPlan {
  const { board, hero, view } = input
  if (hero === undefined) return { id: input.id, cells: [], seeds: [{ x: 0, y: 0 }] }
  const pads = padCounts(board)
  const ext = extents(board)
  const near = mixed(real(board).filter((f) => f.ref !== hero.ref && input.skip?.has(f.ref) !== true).map((f) => ({ f, d: Math.hypot(f.pos.x - hero.pos.x, f.pos.y - hero.pos.y) })).sort((a, b) => a.d - b.d).slice(0, CLUSTER_POOL), pads, CLUSTER_PARTS)
  const room = { nx: view.nx * 0.78, ny: view.ny * 0.78 }
  const chipHull = glyphHull(input.heroGlyph, HERO_SIZE, input.chipTurn, 0, 0)
  const cx = Math.max(...chipHull.map((p) => p.x))
  const cy = Math.max(...chipHull.map((p) => p.y))
  const wide = room.nx > room.ny
  const reachX = Math.max(1e-6, ...near.map(({ f }) => Math.abs(wide ? f.pos.x - hero.pos.x : f.pos.y - hero.pos.y)))
  const reachY = Math.max(1e-6, ...near.map(({ f }) => Math.abs(wide ? f.pos.y - hero.pos.y : f.pos.x - hero.pos.x)))
  const kx = (room.nx - cx - 1.6) / reachX
  const ky = (room.ny - cy - 1.6) / reachY
  const k = Math.min(kx, ky) * 1.15
  const spots: Spot[] = near.map(({ f, d }) => {
    const dx = Math.abs(wide ? f.pos.x - hero.pos.x : f.pos.y - hero.pos.y)
    const dy = Math.abs(wide ? f.pos.y - hero.pos.y : f.pos.x - hero.pos.x)
    const ux = dx / Math.max(1e-6, Math.hypot(dx, dy))
    const uy = dy / Math.max(1e-6, Math.hypot(dx, dy))
    const out = ux * cy > uy * cx ? (cx + 1) / Math.max(ux, 1e-6) : (cy + 1) / Math.max(uy, 1e-6)
    const r = out + Math.hypot(dx * kx, dy * ky) * 0.8
    return { x: Math.round(ux * r), y: Math.round(uy * r), kind: partKind(f, pads), size: sizeOf(ext, f.ref, k), ref: f.ref, at: d }
  }).sort((a, b) => (a.kind === 'chip' ? 0 : 1) - (b.kind === 'chip' ? 0 : 1) || a.at - b.at)
  const placed = placeAll(spots, 'quad', [chipHull], RING, room)
  const X = Math.max(cx, ...placed.map((s) => Math.abs(s.x) + s.size * 0.45)) + 1.3
  const Y = Math.max(cy, ...placed.map((s) => Math.abs(s.y) + s.size * 0.45)) + 1.3
  const a = 0.55
  const edge = Math.atan2(Y - a * Y, a * X - X) - Math.atan2(-1, 1)
  const ticks: Cell[] = [
    { x: ((1 + a) * X) / 2, y: ((1 + a) * Y) / 2, role: 'edge', sym: 'quad', kind: 'slash', size: MARK_SIZE, rot: edge, tone: 0.85, at: 0 },
    { x: 0.35 * X, y: Y, role: 'edge', sym: 'quad', kind: 'dash', size: MARK_SIZE, tone: 0.85, at: 0.02 },
    { x: X, y: 0.3 * Y, role: 'edge', sym: 'quad', kind: 'tick', size: MARK_SIZE, tone: 0.85, at: 0.02 }
  ]
  const marks = ticks.flatMap((t) => copies(outline(t.kind as CellKind, MARK_SIZE, t.rot ?? 0, t.x, t.y), 'quad'))
  const clear = placed.filter((p) => copies(outline(p.kind, p.size, p.rot ?? 0, p.x, p.y), 'quad').every((o) => marks.every((m) => hullGap(o, m) >= GAP)))
  const chip: Cell = { x: 0, y: 0, role: 'hero', sym: 'single', glyphId: 'cell:cluster-chip', size: HERO_SIZE, rot: input.chipTurn, at: 0.05 }
  const glyphs: Glyph[] = input.heroGlyph === undefined ? [] : [{ ...input.heroGlyph, id: 'cell:cluster-chip' }]
  return { id: input.id, cells: [chip, ...ticks, ...cellsOf(clear, 'quad')], seeds: [{ x: 0, y: 0 }], glyphs }
}

export function diagonalAct(input: BoardInput): ActPlan {
  const { board, hero, view } = input
  const pads = padCounts(board)
  const ext = extents(board)
  const parts = real(board).filter((f) => f.ref !== hero?.ref)
  const conns = parts.filter((f) => classify(f.ref, f.value) === 'conn')
  const onConn = new Set<string>()
  for (const refs of partsOnNets(board).values()) {
    if (refs.size < 2 || refs.size >= RAIL_PARTS) continue
    if ([...refs].some((r) => conns.some((c) => c.ref === r))) for (const r of refs) onConn.add(r)
  }
  const group = parts.filter((f) => onConn.has(f.ref) || conns.includes(f)).slice(0, 60)
  if (group.length === 0) return { id: input.id, cells: [], seeds: [{ x: 0, y: 0 }] }
  const bw = board.bbox.max.x - board.bbox.min.x
  const bh = board.bbox.max.y - board.bbox.min.y
  const along = (f: Footprint): number => (bw >= bh ? f.pos.x - (board.bbox.min.x + bw / 2) : f.pos.y - (board.bbox.min.y + bh / 2))
  const side = (f: Footprint): number => (bw >= bh ? f.pos.y - (board.bbox.min.y + bh / 2) : f.pos.x - (board.bbox.min.x + bw / 2))
  const room = { nx: view.nx * 0.86, ny: view.ny * 0.86 }
  const run = Math.min(room.nx, room.ny) * 1.25
  const lo = Math.min(...group.map(along))
  const hi = Math.max(...group.map(along))
  const wideSide = Math.max(1e-6, ...group.map((f) => Math.abs(side(f))))
  const far = group.filter((f) => along(f) >= (lo + hi) / 2 - 1e-9).sort((a, b) => along(a) - along(b))
  const half = mixed(far.map((f) => ({ f })), pads, DIAGONAL_PARTS).map(({ f }) => f).sort((a, b) => along(a) - along(b))
  const step = run / Math.max(1, half.length)
  const spots: Spot[] = half.map((f, i) => {
    const t = (i + 0.7) * step
    const q = Math.round((1.4 * side(f)) / wideSide)
    return { x: Math.round((t + q) / Math.SQRT2), y: Math.round((-t + q) / Math.SQRT2), kind: partKind(f, pads), size: sizeOf(ext, f.ref, 0.35), ref: f.ref, at: t }
  })
  const placed = placeAll(spots, 'rot2', [], [[0, 0], [1, -1], [-1, 1], [1, 0], [0, -1], [-1, 0], [0, 1], [2, -2], [-2, 2], [1, 1], [-1, -1]], room)
  return { id: input.id, cells: cellsOf(placed, 'rot2'), seeds: [{ x: 0, y: 0 }] }
}
