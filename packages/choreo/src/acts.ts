import type { BoardModel, Footprint, Vec2 } from '@silk-reel/ingest'
import type { CellKind } from './cells'
import { classify, CLASS_CELL } from './cells'
import type { CastHints, FormationId, Glyph } from './types'

/**
 * Three acts, each a structure with a direction of growth. Cells sit on an
 * integer lattice (1 = one pitch); only the fundamental copy is authored and
 * the symmetry expands it. Seeds are where each act's first marks land; the
 * previous act strips back toward them, so every act hands off like a match
 * cut instead of a fade.
 */
type Sym = 'single' | 'rot2' | 'mirrorX' | 'quad'
export type Role = 'anchor' | 'body' | 'edge' | 'joint' | 'accent' | 'hero' | 'text'

export interface Cell {
  x: number
  y: number
  role: Role
  sym: Sym
  /** forced shape; otherwise the composer picks from the board's census */
  kind?: CellKind | undefined
  /** forced glyph id (hero silhouette, text token) */
  glyphId?: string | undefined
  /** size in pitches; role default when omitted */
  size?: number | undefined
  rot?: number | undefined
  flipX?: boolean | undefined
  flipY?: boolean | undefined
  /** growth weight: >1 makes this cell arrive later than its distance says */
  lag?: number | undefined
  /** authored arrival order; when every cell of an act has one, it replaces growth by distance */
  at?: number | undefined
  /** tone override; otherwise the role's */
  tone?: number | undefined
  /** hairline multiplier */
  weight?: number | undefined
  /** steps at full ink after decoding in */
  flare?: number | undefined
  /** a brief mark: decodes out this many steps after it lands instead of holding */
  life?: number | undefined
}

export interface ActPlan {
  id: FormationId
  cells: Cell[]
  /** every symmetric seed position, lattice units */
  seeds: Vec2[]
  /** where this act strips toward; the next act's seeds when omitted */
  stripTo?: Vec2[] | undefined
  /** glyphs only this act uses (net names) */
  glyphs?: Glyph[] | undefined
}

/** lattice half-extents (cells) the frame can hold */
export interface Room {
  nx: number
  ny: number
}

const clampI = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)))

class Grid {
  readonly cells: Cell[] = []
  private readonly taken = new Set<string>()
  constructor(private readonly sym: Sym) {}
  private keys(x: number, y: number, sym = this.sym): string[] {
    const k = (a: number, b: number): string => `${Math.round(a * 2)},${Math.round(b * 2)}`
    switch (sym) {
      case 'single':
        return [k(x, y)]
      case 'rot2':
        return [k(x, y), k(-x, -y)]
      case 'mirrorX':
        return [k(x, y), k(-x, y)]
      case 'quad':
        return [k(x, y), k(-x, y), k(x, -y), k(-x, -y)]
    }
  }
  /** a mark that overlays a taken site (a ping, a label) */
  over(c: Cell): void {
    this.cells.push(c)
  }
  add(c: Omit<Cell, 'sym'> & { sym?: Sym }): boolean {
    const keys = this.keys(c.x, c.y, c.sym)
    if (keys.some((key) => this.taken.has(key))) return false
    for (const key of keys) this.taken.add(key)
    this.cells.push({ ...c, sym: c.sym ?? this.sym })
    return true
  }
  has(x: number, y: number): boolean {
    return this.keys(x, y).some((key) => this.taken.has(key))
  }
  /** a word on one row: lands only where its whole width is free, and claims it */
  word(c: Cell, halfWidth: number): boolean {
    const xs: number[] = []
    for (let x = c.x - halfWidth; x <= c.x + halfWidth + 1e-9; x += 0.5) xs.push(x)
    if (xs.some((x) => this.has(x, c.y))) return false
    for (const x of xs) for (const key of this.keys(x, c.y, c.sym)) this.taken.add(key)
    this.cells.push(c)
    return true
  }
}

const key = (p: Vec2): string => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`

/** a footprint's pad count, by ref */
function padCounts(board: BoardModel): Map<string, number> {
  const pads = new Map<string, number>()
  for (const layer of Object.values(board.copper)) {
    for (const p of layer.pads) if (p.footprintRef !== undefined) pads.set(p.footprintRef, (pads.get(p.footprintRef) ?? 0) + 1)
  }
  return pads
}

/** the body cell a real footprint stands for */
function partKind(f: Footprint, pads: Map<string, number>): CellKind {
  const cls = classify(f.ref, f.value)
  // only real headers read as brackets; small connectors are pads
  return cls === 'conn' && (pads.get(f.ref) ?? 0) < 6 ? 'pad' : CLASS_CELL[cls]
}

/** Douglas–Peucker: indices of the vertices that stray more than `eps` from the chord */
function simplify(pts: Vec2[], eps: number): number[] {
  const keep = new Set([0, pts.length - 1])
  const split = (i: number, j: number): void => {
    const a = pts[i] as Vec2
    const b = pts[j] as Vec2
    const len = Math.max(1e-9, Math.hypot(b.x - a.x, b.y - a.y))
    let far = -1
    let worst = eps
    for (let m = i + 1; m < j; m++) {
      const p = pts[m] as Vec2
      const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len
      if (d > worst) [far, worst] = [m, d]
    }
    if (far < 0) return
    keep.add(far)
    split(i, far)
    split(far, j)
  }
  split(0, pts.length - 1)
  return [...keep].sort((a, b) => a - b)
}

/**
 * The hero's own copper, walked: per net, segments chain through shared
 * endpoints (vias and through-holes join layers at one point), and the route
 * runs from the hero's pad to the point farthest from the chip. The longest
 * routes in distinct directions win; the C2 twin would cover a route's
 * opposite, so direction is compared modulo a half turn.
 */
interface Route {
  pts: Vec2[]
  /** widest copper on the path, mm */
  width: number
  net: number | undefined
}

function heroRoutes(board: BoardModel, hero: Footprint, max: number): Route[] {
  const layers = Object.values(board.copper)
  const heroPads = layers.flatMap((l) => l.pads).filter((p) => p.footprintRef === hero.ref && p.netId !== undefined)
  const found: Array<Route & { reach: number; angle: number }> = []
  for (const net of new Set(heroPads.map((p) => p.netId))) {
    const pos = new Map<string, Vec2>()
    const adj = new Map<string, Array<[string, number, number]>>()
    for (const l of layers) {
      for (const t of l.traces) {
        if (t.netId !== net) continue
        for (let i = 1; i < t.points.length; i++) {
          const a = t.points[i - 1] as Vec2
          const b = t.points[i] as Vec2
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          for (const [p, q] of [[a, b], [b, a]] as const) {
            pos.set(key(p), p)
            const out = adj.get(key(p)) ?? []
            out.push([key(q), d, t.width])
            adj.set(key(p), out)
          }
        }
      }
    }
    const mine = heroPads.filter((h) => h.netId === net)
    const dist = new Map<string, number>()
    const prev = new Map<string, [string, number]>()
    for (const [k, p] of pos) {
      if (mine.some((h) => Math.hypot(p.x - h.pos.x, p.y - h.pos.y) <= Math.max(h.size.x, h.size.y) / 2 + 0.1)) dist.set(k, 0)
    }
    const done = new Set<string>()
    for (;;) {
      let u: string | undefined
      for (const [k, d] of dist) if (!done.has(k) && (u === undefined || d < (dist.get(u) as number))) u = k
      if (u === undefined) break
      done.add(u)
      for (const [v, w, width] of adj.get(u) ?? []) {
        const d = (dist.get(u) as number) + w
        if (d < (dist.get(v) ?? Infinity)) {
          dist.set(v, d)
          prev.set(v, [u, width])
        }
      }
    }
    let far: string | undefined
    let reach = 0
    for (const k of done) {
      const p = pos.get(k) as Vec2
      const r = Math.hypot(p.x - hero.pos.x, p.y - hero.pos.y)
      if (r > reach) [far, reach] = [k, r]
    }
    if (far === undefined) continue
    const pts: Vec2[] = []
    let width = 0
    for (let k: string | undefined = far; k !== undefined; k = prev.get(k)?.[0]) {
      pts.unshift(pos.get(k) as Vec2)
      width = Math.max(width, prev.get(k)?.[1] ?? 0)
    }
    const end = pts[pts.length - 1] as Vec2
    found.push({ pts, width, net, reach, angle: Math.atan2(end.y - hero.pos.y, end.x - hero.pos.x) })
  }
  found.sort((a, b) => b.reach - a.reach)
  const picked: typeof found = []
  for (const r of found) {
    const apart = (a: number): number => {
      const d = Math.abs(a - r.angle) % Math.PI
      return Math.min(d, Math.PI - d)
    }
    if (picked.every((p) => apart(p.angle) > 0.4)) picked.push(r)
    if (picked.length === max) break
  }
  return picked
}

/** the copper's own direction as a mark: dash, tick, or a short slash for 45° runs */
function stroke(dx: number, dy: number): Pick<Cell, 'kind' | 'size' | 'flipX'> {
  const a = Math.abs(Math.atan2(dy, dx)) % Math.PI
  const t = Math.min(a, Math.PI - a)
  if (t < Math.PI / 8) return { kind: 'dash', size: 1.3 }
  if (t > (Math.PI * 3) / 8) return { kind: 'tick', size: 1 }
  return { kind: 'slash', size: 0.62, flipX: dx * dy > 0 }
}

/** a net's own name, as its designer wrote it: last path segment, overbars dropped; none for auto names */
function netLabel(name: string | undefined): string | undefined {
  const v = (name?.split('/').pop() ?? '').replace(/~\{([^}]*)\}/g, '$1').replace(/[{}~]/g, '')
  return v.length >= 2 && v.length <= 10 && !/^(Net-|unconnected)/i.test(v) ? v : undefined
}

/** steps of full ink behind each route's head: the comet tail */
const TAIL = 3

/**
 * Act I — the routes. The hero chip sits at the centre and its longest real
 * traces run out to the parts they feed, stepped onto the lattice with a C2
 * twin and drawn as strokes along the copper's direction. Each route travels
 * at one speed from the chip, a bright head with a settling tail; heavy
 * copper draws heavier. Bends and vias become joints, and each route lands on
 * the cell of the part it reaches with a ping and the net's own name. A board
 * without routed copper falls back to straight lines to its farthest parts.
 */
export function routeAct(board: BoardModel, room: Room, hero: Footprint | undefined, heroGlyph: string | undefined): ActPlan {
  const g = new Grid('rot2')
  g.add(heroGlyph === undefined
    ? { x: 0, y: 0, role: 'anchor', sym: 'single', at: 0 }
    : { x: 0, y: 0, role: 'hero', glyphId: heroGlyph, size: 1.5, sym: 'single', at: 0 })
  if (hero === undefined) return { id: 'route', cells: g.cells, seeds: [{ x: 0, y: 0 }] }
  const real = board.footprints.filter((f) => !/\*/.test(f.ref) && f !== hero)
  let routes = heroRoutes(board, hero, 5)
  if (routes.length === 0) {
    routes = [...real]
      .sort((a, b) => Math.hypot(b.pos.x - hero.pos.x, b.pos.y - hero.pos.y) - Math.hypot(a.pos.x - hero.pos.x, a.pos.y - hero.pos.y))
      .slice(0, 3)
      .map((f) => ({ pts: [hero.pos, f.pos], width: 0, net: undefined }))
  }
  const pads = padCounts(board)
  const vias = new Set(Object.values(board.copper).flatMap((l) => l.vias.map((v) => key(v.pos))))
  const allPads = Object.values(board.copper).flatMap((l) => l.pads)
  const names = new Map(board.nets.map((n) => [n.id, n.name]))
  const thin = Math.min(...routes.map((r) => r.width).filter((w) => w > 0))
  const rel = routes.map((r) => r.pts.map((p) => ({ x: p.x - hero.pos.x, y: p.y - hero.pos.y })))
  const ex = Math.max(1e-6, ...rel.flat().map((p) => Math.abs(p.x)))
  const ey = Math.max(1e-6, ...rel.flat().map((p) => Math.abs(p.y)))
  const turn = ex > ey !== room.nx > room.ny
  // fit the median route, not the longest: one long run would shrink the rest
  // into the chip; longer routes run off the frame edge instead
  const fits = rel
    .map((r) => {
      const rx = Math.max(1e-6, ...r.map((p) => Math.abs(turn ? p.y : p.x)))
      const ry = Math.max(1e-6, ...r.map((p) => Math.abs(turn ? p.x : p.y)))
      return Math.min((room.nx - 2) / rx, (room.ny - 2) / ry)
    })
    .sort((a, b) => a - b)
  const k = fits[Math.floor((fits.length - 1) / 2)] as number
  const toLattice = (p: Vec2): Vec2 => (turn ? { x: -p.y * k, y: p.x * k } : { x: p.x * k, y: p.y * k })
  const glyphs: Glyph[] = []
  for (const [ri, route] of routes.entries()) {
    const weight = route.width > 0 && Number.isFinite(thin) ? 1 + Math.min(1, (route.width / thin - 1) / 2) : 1
    // the lattice cannot hold sub-cell jogs: keep only the bends it can show
    const kept = simplify((rel[ri] as Vec2[]).map(toLattice), 0.6)
    const pts = kept.map((i) => toLattice(rel[ri]?.[i] as Vec2))
    const tip = route.pts[route.pts.length - 1] as Vec2
    // the part this route reaches names its last cell
    const near = allPads.find((p) => p.footprintRef !== hero.ref && Math.hypot(p.pos.x - tip.x, p.pos.y - tip.y) < Math.max(p.size.x, p.size.y))
    const part = near === undefined ? undefined : real.find((f) => f.ref === near.footprintRef)
    let last = '0,0'
    let n = 0
    let end: { x: number; y: number; dx: number; dy: number } | undefined
    walk: for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as Vec2
      const b = pts[i] as Vec2
      // Chebyshev steps: a 45° run lands on clean diagonal cells
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))))
      for (let s = 1; s <= steps; s++) {
        const x = Math.round(a.x + ((b.x - a.x) * s) / steps)
        const y = Math.round(a.y + ((b.y - a.y) * s) / steps)
        if (Math.abs(x) > room.nx - 1 || Math.abs(y) > room.ny - 1) break walk
        if (`${x},${y}` === last || Math.hypot(x, y) < 1.5) continue
        last = `${x},${y}`
        n++
        const tipCell = i === pts.length - 1 && s === steps
        const corner = s === steps && !tipCell
        if (tipCell) {
          g.add({ x, y, role: 'anchor', kind: part === undefined ? 'pad' : partKind(part, pads), at: n, flare: TAIL + 2 })
          end = { x, y, dx: b.x - a.x, dy: b.y - a.y }
        } else if (corner) {
          g.add({ x, y, role: 'joint', kind: vias.has(key(route.pts[kept[i] as number] as Vec2)) ? 'ring' : undefined, at: n, flare: TAIL })
        } else {
          g.add({ x, y, role: 'body', ...stroke(b.x - a.x, b.y - a.y), at: n, weight, flare: TAIL, tone: 0.6 })
        }
      }
    }
    // a landing beside the chip would only crowd it
    if (end === undefined || Math.hypot(end.x, end.y) < 3) continue
    // the landing: a ring pings around the part the signal reached
    g.over({ x: end.x, y: end.y, role: 'accent', kind: 'ring', size: 2.2, sym: 'rot2', at: n, life: 2 })
    const label = netLabel(names.get(route.net ?? -1))
    if (label === undefined || glyphs.some((gl) => gl.text === label)) continue
    const id = `net:${label}`
    // beside the tip: past it along the copper, else above or below it; never over other marks
    const w = 0.13 * label.length
    const sx = Math.sign(end.dx) || 1
    const sy = Math.sign(end.dy) || 1
    const spots = [
      Math.abs(end.dx) >= Math.abs(end.dy) ? { x: end.x + sx * (0.7 + w), y: end.y } : { x: end.x, y: end.y + sy },
      { x: end.x, y: end.y - 1 },
      { x: end.x, y: end.y + 1 }
    ]
    const landed = spots.some((p) => {
      const x = Math.sign(p.x) * Math.min(Math.abs(p.x), room.nx - 0.3 - w)
      return Math.abs(p.y) <= room.ny - 0.4 && g.word({ x, y: p.y, role: 'text', glyphId: id, size: 0.42, sym: 'rot2', at: n + 1.5 }, w)
    })
    if (landed) glyphs.push({ id, kind: 'text', strokes: [], text: label })
  }
  return { id: 'route', cells: g.cells, seeds: [{ x: 0, y: 0 }], glyphs }
}

/** build order (arrival fraction): ICs land while the outline is still sweeping, then connectors, the rest, passives last */
const TIER: Partial<Record<CellKind, number>> = { chip: 0.06, bracket: 0.35, pill: 0.75, pad: 0.75 }
/** passives recede so the parts that matter read */
const PLAN_TONE: Partial<Record<CellKind, number>> = { chip: 1, bracket: 0.85, pill: 0.42, pad: 0.5 }

/**
 * Act II — the plan. The whole board from above, folded about its centre.
 * The outline sweeps round as the ICs land out from the hero's site, then the
 * rest arrive at their true size: connectors, the rest, passives last. A board whose long
 * side disagrees with the frame turns a quarter turn. It collapses inward to
 * the hero's site as the frame closes round it, a push in.
 */
export function planAct(board: BoardModel, room: Room, hero: Footprint | undefined): ActPlan {
  const g = new Grid('quad')
  const c = { x: (board.bbox.min.x + board.bbox.max.x) / 2, y: (board.bbox.min.y + board.bbox.max.y) / 2 }
  const bw = board.bbox.max.x - board.bbox.min.x
  const bh = board.bbox.max.y - board.bbox.min.y
  const turn = bw > bh !== room.nx > room.ny
  const hw = Math.max(1e-6, (turn ? bh : bw) / 2)
  const hh = Math.max(1e-6, (turn ? bw : bh) / 2)
  const k = Math.min((room.nx - 1) / hw, (room.ny - 1) / hh)
  const fold = (p: Vec2): Vec2 => {
    const dx = Math.abs(p.x - c.x) * k
    const dy = Math.abs(p.y - c.y) * k
    return turn ? { x: dy, y: dx } : { x: dx, y: dy }
  }
  const h = fold(hero?.pos ?? c)
  const hx = Math.round(h.x)
  const hy = Math.round(h.y)
  // the outline sweeps from one axis to the other, all four copies at once
  const sweep = (x: number, y: number): number => (0.4 * Math.atan2(y, x)) / (Math.PI / 2)
  for (const d of board.drill) {
    // mounting holes, not tooling or connector pegs
    if (d.plated || d.dia < 2) continue
    const p = fold(d.pos)
    const x = Math.round(p.x * 2) / 2
    const y = Math.round(p.y * 2) / 2
    g.add({ x, y, role: 'joint', kind: 'ring', at: sweep(x, y) + 0.02 })
  }
  for (const path of board.outline) {
    // fold each sample, not the ends: an edge across the axis folds onto itself
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1] as Vec2
      const b = path.points[i] as Vec2
      const flat = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) !== turn
      const steps = Math.max(1, Math.ceil((Math.hypot(b.x - a.x, b.y - a.y) * k) / 2))
      for (let s = 0; s < steps; s++) {
        const p = fold({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps })
        const x = Math.round(p.x)
        const y = Math.round(p.y)
        g.add({ x, y, role: 'edge', kind: flat ? 'dash' : 'tick', tone: 0.85, at: sweep(x, y) })
      }
    }
  }
  // each part at its true size: its pads' extent on the lattice
  const extent = new Map<string, number>()
  const spans = new Map<string, BBoxAcc>()
  for (const layer of Object.values(board.copper)) {
    for (const p of layer.pads) {
      if (p.footprintRef === undefined) continue
      const b = spans.get(p.footprintRef) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      const r = Math.max(p.size.x, p.size.y) / 2
      spans.set(p.footprintRef, { x0: Math.min(b.x0, p.pos.x - r), y0: Math.min(b.y0, p.pos.y - r), x1: Math.max(b.x1, p.pos.x + r), y1: Math.max(b.y1, p.pos.y + r) })
    }
  }
  for (const [ref, b] of spans) extent.set(ref, Math.max(b.x1 - b.x0, b.y1 - b.y0) * k)
  const reach = Math.hypot(room.nx, room.ny)
  for (const cell of foldParts(board, board.footprints.filter((f) => !/\*/.test(f.ref)), fold, room.nx - 2, room.ny - 2, 0.22)) {
    const size = cell.big ? 1.5 : Math.max(0.38, Math.min(1.3, extent.get(cell.ref) ?? 0.7))
    g.add({
      x: cell.x,
      y: cell.y,
      role: cell.big ? 'anchor' : 'body',
      kind: cell.kind,
      size,
      tone: PLAN_TONE[cell.kind] ?? 0.72,
      at: (TIER[cell.kind] ?? 0.55) + (0.2 * Math.hypot(cell.x - hx, cell.y - hy)) / reach
    })
  }
  const site = [{ x: hx, y: hy }, { x: -hx, y: hy }, { x: hx, y: -hy }, { x: -hx, y: -hy }]
  return { id: 'plan', cells: g.cells, seeds: site, stripTo: site }
}

interface BBoxAcc {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface CoreCell {
  x: number
  y: number
  kind: CellKind
  big: boolean
  ref: string
}

/**
 * Act III — the frame. Corner cuts mark an octagon, the frame closes, then the
 * board itself fills the inside: the real neighbourhood of the hero chip,
 * folded into one quadrant and mirrored. The hero lands last, alone, at the
 * centre — the beat the whole loop has been walking toward.
 */
export function frameAct(
  room: Room,
  core: CoreCell[],
  heroGlyph: string | undefined,
  labels: string[]
): ActPlan {
  const g = new Grid('quad')
  const Fx = clampI(room.nx - 1, 4, 7)
  const Fy = clampI(Math.min(room.ny - 2, Fx + 2), 4, 9)
  const cut = { x: Fx - 0.5, y: Fy - 0.5 }
  g.add({ x: cut.x, y: cut.y, role: 'accent', kind: 'slash', size: 1, flipX: true })
  g.add({ x: Fx + 0.55, y: Fy + 0.55, role: 'accent', kind: 'wedge', flipX: true, flipY: true })
  g.add({ x: Fx - 1.6, y: Fy - 1.6, role: 'anchor', kind: 'leaf', flipY: true })
  for (let x = Fx - 3; x >= 0.5; x -= 2) g.add({ x, y: Fy, role: 'edge', kind: 'dash' })
  for (let y = Fy - 3; y >= 0.5; y -= 2) g.add({ x: Fx, y, role: 'edge', kind: 'tick' })
  // the board's own words ride outside the frame, top and bottom
  const [top, bottom] = labels
  if (top !== undefined) g.add({ x: Fx - 2.4, y: -(Fy + 1.1), role: 'text', glyphId: top, sym: 'mirrorX', lag: 1.2 })
  const low = bottom ?? top
  if (low !== undefined) g.add({ x: Fx - 2.4, y: Fy + 1.1, role: 'text', glyphId: low, sym: 'mirrorX', lag: 1.2 })
  // the hero owns the middle 3×3
  const hero = heroGlyph !== undefined
  for (const c of core) {
    if (c.x > Fx - 2 || c.y > Fy - 2) continue
    if (hero && c.x < 2 && c.y < 2) continue
    g.add({ x: c.x, y: c.y, role: c.big ? 'anchor' : 'body', kind: c.kind, size: c.big ? 1.7 : 0.78 })
  }
  if (hero) g.add({ x: 0, y: 0, role: 'hero', glyphId: heroGlyph, size: 2.9, sym: 'single', lag: 1.15 })
  return {
    id: 'frame',
    cells: g.cells,
    seeds: [
      { x: cut.x, y: cut.y },
      { x: -cut.x, y: cut.y },
      { x: cut.x, y: -cut.y },
      { x: -cut.x, y: -cut.y }
    ]
  }
}

const PRIORITY: Record<CellKind, number> = {
  chip: 6, leaf: 5, half: 4, pad: 3, ring: 3, bracket: 2, pill: 1,
  dot: 0, tick: 0, dash: 0, slash: 0, wedge: 0, corner: 0
}

/**
 * The named part if the board has it, then the first IC the curated hints
 * prefer. Otherwise the biggest IC by pad count,
 * then the biggest part that is not a connector or a hole, then a connector;
 * a tie goes to the part nearer the board's centre.
 */
/** the parts worth offering as a hero, best first: ICs, then big parts, then big connectors */
export function heroChoices(board: BoardModel, limit = 16): Footprint[] {
  const rank = (f: Footprint): number => {
    const k = classify(f.ref, f.value)
    return k === 'ic' ? 0 : k === 'conn' ? 2 : 1
  }
  return board.footprints
    .filter((f) => !/\*/.test(f.ref) && !['hole', 'tp'].includes(classify(f.ref, f.value)) && (rank(f) === 0 || f.padRefs.length >= 8))
    .sort((a, b) => rank(a) - rank(b) || b.padRefs.length - a.padRefs.length || a.ref.localeCompare(b.ref, undefined, { numeric: true }))
    .slice(0, limit)
}

export function heroPart(board: BoardModel, ref?: string, hints?: CastHints): Footprint | undefined {
  const named = ref === undefined ? undefined : board.footprints.find((f) => f.ref === ref)
  if (named !== undefined) return named
  const hinted = hints?.preferRefs
    ?.map((r) => board.footprints.find((f) => f.ref === r && r.startsWith('U')))
    .find((f) => f !== undefined)
  if (hinted !== undefined) return hinted
  const real = board.footprints.filter((f) => !/\*/.test(f.ref))
  const kind = (f: Footprint): string => classify(f.ref, f.value)
  const ics = real.filter((f) => kind(f) === 'ic')
  const parts = real.filter((f) => !['conn', 'hole', 'tp'].includes(kind(f)) && f.padRefs.length >= 8)
  const conns = real.filter((f) => kind(f) === 'conn')
  const pool = [ics, parts, conns, real].find((list) => list.length > 0) ?? []
  const cx = (board.bbox.min.x + board.bbox.max.x) / 2
  const cy = (board.bbox.min.y + board.bbox.max.y) / 2
  const off = (f: Footprint): number => Math.hypot(f.pos.x - cx, f.pos.y - cy)
  return pool.reduce<Footprint | undefined>((best, f) => {
    if (best === undefined) return f
    const n = f.padRefs.length
    const m = best.padRefs.length
    return n > m || (n === m && off(f) < off(best)) ? f : best
  }, undefined)
}

/**
 * Parts snapped onto one quadrant of the lattice by `fold` (mm → lattice
 * units). One cell per site; the higher-ranked part wins a collision so ICs
 * and diodes read through the passive flood. Dense at the origin, thinning
 * outward; `fill` caps the share of sites taken so the lattice breathes.
 */
function foldParts(board: BoardModel, parts: Footprint[], fold: (p: Vec2) => Vec2, cx: number, cy: number, fill: number): CoreCell[] {
  const pads = padCounts(board)
  const candidates: Array<CoreCell & { rank: number }> = []
  for (const f of parts) {
    const p = fold(f.pos)
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (x > cx || y > cy) continue
    const kind = partKind(f, pads)
    const n = pads.get(f.ref) ?? 0
    const near = 1 - Math.hypot(x / (cx + 1), y / (cy + 1)) / Math.SQRT2
    candidates.push({ x, y, kind, ref: f.ref, big: classify(f.ref, f.value) === 'ic' && n >= 14, rank: PRIORITY[kind] * 50 + Math.min(n, 60) + near * 400 })
  }
  // strongest parts claim their sites first; big ICs take a 2×2 block
  candidates.sort((a, b) => b.rank - a.rank)
  const cap = Math.max(6, Math.round((cx + 1) * (cy + 1) * fill))
  const taken = new Set<string>()
  const cells: CoreCell[] = []
  for (const c of candidates) {
    if (cells.length >= cap) break
    // a block straddling an axis would overlap its own mirror copy
    const block = c.big && c.x >= 1 && c.y >= 1 && c.x + 1 <= cx && c.y + 1 <= cy
      ? [[0, 0], [1, 0], [0, 1], [1, 1]]
      : [[0, 0]]
    const keys = block.map(([dx, dy]) => `${c.x + (dx as number)},${c.y + (dy as number)}`)
    if (keys.some((k) => taken.has(k))) continue
    for (const k of keys) taken.add(k)
    cells.push({ x: block.length > 1 ? c.x + 0.5 : c.x, y: block.length > 1 ? c.y + 0.5 : c.y, kind: c.kind, big: block.length > 1, ref: c.ref })
  }
  return cells
}

/**
 * The hero's real neighbourhood, folded: every footprint's offset from the
 * hero chip, mirrored into one quadrant and snapped to the lattice, scaled so
 * the nearer ~70% of parts land inside the core.
 */
export function boardCore(board: BoardModel, hero: Footprint | undefined, cx: number, cy: number): CoreCell[] {
  if (hero === undefined) return []
  const others = board.footprints.filter((f) => !/\*/.test(f.ref) && f !== hero)
  if (others.length === 0) return []
  const reach = others.map((f) => Math.max(Math.abs(f.pos.x - hero.pos.x) / cx, Math.abs(f.pos.y - hero.pos.y) / cy)).sort((a, b) => a - b)
  const mmPerCell = Math.max(0.5, reach[Math.floor(reach.length * 0.7)] ?? 1)
  return foldParts(board, others, (p) => ({ x: Math.abs(p.x - hero.pos.x) / mmPerCell, y: Math.abs(p.y - hero.pos.y) / mmPerCell }), cx, cy, 0.5)
}
