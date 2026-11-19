import type { BoardModel, Footprint, Pad, Vec2 } from '@silk-reel/ingest'
import type { CellKind } from './cells'
import { cellGlyph, classify, CLASS_CELL } from './cells'
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
  /** a field mark on one of the main chip's signal nets, or a connector pad where such a net leaves the board */
  link?: 'net' | 'exit' | undefined
  /** a field mark of a part's pad: the part's reference */
  group?: string | undefined
  /** the beat after its act starts on which the mark has landed; when every cell of an act has one, it replaces growth */
  land?: number | undefined
  /** the field's build stage: 1 the smallest marks with the main chip, 2 the next size, 3 the largest, 4 the marks that close the picture */
  stage?: number | undefined
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
export function padCounts(board: BoardModel): Map<string, number> {
  const pads = new Map<string, number>()
  for (const layer of Object.values(board.copper)) {
    for (const p of layer.pads) if (p.footprintRef !== undefined) pads.set(p.footprintRef, (pads.get(p.footprintRef) ?? 0) + 1)
  }
  return pads
}

/** the body cell a real footprint stands for */
export function partKind(f: Footprint, pads: Map<string, number>): CellKind {
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

/** the main chip's size in pitches, the same in every act that shows it, so it never changes between them */
export const HERO_SIZE = 2.9
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
  return v.length >= 2 && v.length <= 10 && !/^(Net-|unconnected)/i.test(v) && !isGround(v) ? v : undefined
}

export const isGround = (name: string | undefined): boolean => GROUND.test((name?.split('/').pop() ?? '').replace(/[{}~]/g, ''))
/** every board has ground, so it is never one of the board's own words */
const GROUND = /^(?:[ADPSC]|SIG|CHASSIS|SYS)?[_-]?GND|GND[A-Z0-9]?$|^GROUND|^VSS|^EARTH|^0V$/i
/** a supply rail rather than a signal */
export const RAIL = /^[+-]|^\d+V\d*$|^V(?:CC|DD|IN|BAT|BUS|CORE|IO|REF|PP|USB|SYS)/i

/** steps of full ink behind each route's head: the comet tail */
const TAIL = 3
/** the chip's neighbours that stand beside it in the routes act, each with its C2 twin */
const NEIGHBOURS = 2

/**
 * Act I — the routes. The hero chip sits at the centre and its longest real
 * traces run out to the parts they feed, stepped onto the lattice with a C2
 * twin and drawn as strokes along the copper's direction. Every route is drawn
 * from the cell beside the chip, so the chip never floats in a gap. Each route travels
 * at one speed from the chip, a bright head with a settling tail; heavy
 * copper draws heavier. Bends and vias become joints, and each route lands on
 * the cell of the part it reaches with a ping and the net's own name. The
 * chip's nearest neighbours on its nets stand beside it as pads with their
 * net's name. A board without routed copper falls back to straight lines to
 * its farthest parts.
 */
export function routeAct(board: BoardModel, room: Room, hero: Footprint | undefined, heroGlyph: Glyph | undefined, chipTurn = 0): ActPlan {
  const g = new Grid('rot2')
  const body = heroGlyph?.strokes[0] ?? []
  const bw = Math.max(...body.map((p) => Math.abs(p.x)), 1e-6)
  const bh = Math.max(...body.map((p) => Math.abs(p.y)), 1e-6)
  const cos = Math.abs(Math.cos(chipTurn))
  const sin = Math.abs(Math.sin(chipTurn))
  const fit = Math.min(1, Math.max(bw, bh) / Math.max(bw * cos + bh * sin, bw * sin + bh * cos))
  g.add(heroGlyph === undefined
    ? { x: 0, y: 0, role: 'anchor', sym: 'single', at: 0 }
    : { x: 0, y: 0, role: 'hero', glyphId: heroGlyph.id, size: HERO_SIZE * fit, rot: chipTurn, sym: 'single', at: 0 })
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
  // a net's name beside a mark: past it along the copper, else above or below it; never over other marks
  // the chip's pads in their own order; a ground net hands its label to the next pad's net that has a name, a signal before a rail
  const chipPads = allPads.filter((p) => p.footprintRef === hero.ref).sort((a, b) => (a.num ?? '').localeCompare(b.num ?? '', undefined, { numeric: true }))
  const wordFor = (net: number | undefined): string | undefined => {
    const own = netLabel(names.get(net ?? -1))
    if (own !== undefined || !isGround(names.get(net ?? -1))) return own
    const from = Math.max(0, chipPads.findIndex((p) => p.netId === net))
    const next = [...chipPads.slice(from + 1), ...chipPads.slice(0, from + 1)].map((p) => netLabel(names.get(p.netId ?? -1))).filter((l): l is string => l !== undefined && !glyphs.some((gl) => gl.text === l))
    return next.find((l) => !RAIL.test(l)) ?? next[0]
  }
  const nameBeside = (end: { x: number; y: number; dx: number; dy: number }, net: number | undefined, at: number): void => {
    const label = wordFor(net)
    if (label === undefined || glyphs.some((gl) => gl.text === label)) return
    const id = `net:${label}`
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
      return Math.abs(p.y) <= room.ny - 0.4 && g.word({ x, y: p.y, role: 'text', glyphId: id, size: 0.42, sym: 'rot2', at }, w)
    })
    if (landed) glyphs.push({ id, kind: 'text', strokes: [], text: label })
  }
  for (const [ri, route] of routes.entries()) {
    const weight = route.width > 0 && Number.isFinite(thin) ? 1 + Math.min(1, (route.width / thin - 1) / 2) : 1
    // the lattice cannot hold sub-cell jogs: keep only the bends it can show
    const kept = simplify((rel[ri] as Vec2[]).map(toLattice), 0.6)
    const pts = [{ x: 0, y: 0 }, ...kept.map((i) => toLattice(rel[ri]?.[i] as Vec2))]
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
        if (`${x},${y}` === last || Math.max(Math.abs(x), Math.abs(y)) < HERO_SIZE / 2 + 0.5) continue
        last = `${x},${y}`
        n++
        const tipCell = i === pts.length - 1 && s === steps
        const corner = s === steps && !tipCell
        if (tipCell) {
          g.add({ x, y, role: 'anchor', kind: part === undefined ? 'pad' : partKind(part, pads), at: n, flare: TAIL + 2 })
          end = { x, y, dx: b.x - a.x, dy: b.y - a.y }
        } else if (Math.max(Math.abs(x), Math.abs(y)) < HERO_SIZE / 2 + 1.5) {
          // beside the chip a route's stroke points at it: square to its edge, a slash off a corner
          const toChip = Math.abs(x) === Math.abs(y) ? stroke(x, y) : Math.abs(x) > Math.abs(y) ? stroke(1, 0) : stroke(0, 1)
          g.add({ x, y, role: 'body', ...toChip, at: n, weight, flare: TAIL, tone: 0.6 })
        } else if (corner) {
          g.add({ x, y, role: 'joint', kind: vias.has(key(route.pts[kept[i - 1] as number] as Vec2)) ? 'ring' : undefined, at: n, flare: TAIL })
        } else {
          g.add({ x, y, role: 'body', ...stroke(b.x - a.x, b.y - a.y), at: n, weight, flare: TAIL, tone: 0.6 })
        }
      }
    }
    // a landing beside the chip would only crowd it
    if (end === undefined || Math.hypot(end.x, end.y) < 3) continue
    // the landing: a ring pings around the part the signal reached
    g.over({ x: end.x, y: end.y, role: 'accent', kind: 'ring', size: 2.2, sym: 'rot2', at: n, life: 2 })
    nameBeside(end, route.net, n + 1.5)
  }
  // the chip's nearest neighbours on its nets stand beside it as pads, named by the net they share;
  // one too close to show is moved straight out to the first free ring round the chip
  const onNets = partsOnNets(board)
  const heroNets = [...new Set(allPads.filter((p) => p.footprintRef === hero.ref && p.netId !== undefined).map((p) => p.netId as number))]
  const ring = HERO_SIZE / 2 + 2
  let beside = 0
  for (const f of [...real].sort((a, b) => Math.hypot(a.pos.x - hero.pos.x, a.pos.y - hero.pos.y) - Math.hypot(b.pos.x - hero.pos.x, b.pos.y - hero.pos.y))) {
    if (beside === NEIGHBOURS) break
    const shared = heroNets.filter((n) => onNets.get(n)?.has(f.ref) === true)
    const first = shared.find((n) => netLabel(names.get(n)) !== undefined || isGround(names.get(n)))
    const named = shared.filter((n) => netLabel(names.get(n)) !== undefined)
    // a neighbour on ground is named by its next shared net instead, a signal before a rail
    const net = isGround(names.get(first ?? -1)) ? named.find((n) => !RAIL.test(netLabel(names.get(n)) as string)) ?? named[0] : first
    const q = toLattice({ x: f.pos.x - hero.pos.x, y: f.pos.y - hero.pos.y })
    const r = Math.max(Math.abs(q.x), Math.abs(q.y))
    if (net === undefined || r < 1e-6) continue
    const out = Math.max(1, ring / r)
    const x = Math.round(q.x * out)
    const y = Math.round(q.y * out)
    if (Math.abs(x) > room.nx - 1 || Math.abs(y) > room.ny - 1) continue
    const at = Math.max(Math.abs(x), Math.abs(y)) - HERO_SIZE / 2
    if (!g.add({ x, y, role: 'anchor', kind: 'pad', at, flare: TAIL + 2 })) continue
    beside++
    nameBeside({ x, y, dx: x, dy: y }, net, at + 1.5)
  }
  return { id: 'route', cells: g.cells, seeds: [{ x: 0, y: 0 }], glyphs }
}

/** a box on the lattice, in pitches */
export interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** the field's build, in beats after it starts: each stage is a wave out from the main chip, each faster than the last, then a stop, and the closing marks land on the lock */
const FIELD_WAVES: ReadonlyArray<readonly [number, number]> = [[0, 1.4], [2, 0.85], [3, 0.55]]
const FIELD_CLOSE = 5
/** marks this near the main chip, as a share of the field's reach, and at least FIELD_NEAREST of them, land with it */
const FIELD_NEAR = 0.1
const FIELD_NEAREST = 80
/** the first stage needs this share of the marks, or the marks split by drawn size */
const FIELD_FIRST_SHARE = 0.15
const CLOSING_FALLBACK = 4
/** a field mark's drawn radius is at most this share of the distance to its nearest neighbour, so two pads always keep a dark gap */
const PAD_GAP = 0.3
/** a field pad at least this many times as long as it is wide, whose point PAD_GAP would shrink, draws instead as a bar along its long side at its true length, capped across the pitch only, with the ink its point had */
const BAR_ASPECT = 1.4
/** a bar's tone is its point's ink over its own area, to this power: brighter per area than an equal-ink bar, which reads darker than its point on a phone, and below full tone, which outshines the main chip */
const BAR_INK = 0.5
/** bar glyphs are shared by width-to-length ratio, rounded down to steps of this */
const BAR_STEP = 0.01
/** the plan's edge and hole marks, drawn at their role's own size */
export const MARK_SIZE = 0.8
const DOT_R = 0.075
const RING_R = 0.24

/** build order (arrival fraction): ICs land while the outline is still sweeping, then connectors, the rest, passives last */
const TIER: Partial<Record<CellKind, number>> = { chip: 0.06, bracket: 0.35, pill: 0.75, pad: 0.75 }
/** passives recede so the parts that matter read */
export const PLAN_TONE: Partial<Record<CellKind, number>> = { chip: 1, bracket: 0.85, pill: 0.42, pad: 0.5 }

/**
 * Act II — the plan. The whole board from above, folded about its centre.
 * The outline sweeps round as the ICs land out from the hero's site, then the
 * rest arrive at their true size: connectors, the rest, passives last. A board whose long
 * side disagrees with the frame turns a quarter turn. It collapses inward to
 * the hero's site as the frame closes round it, a push in.
 */
export function planAct(board: BoardModel, room: Room, hero: Footprint | undefined, chipTurn = 0, gap = 0): ActPlan {
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
  const holes: Vec2[] = []
  for (const d of board.drill) {
    // mounting holes, not tooling or connector pegs
    if (d.plated || d.dia < 2) continue
    const p = fold(d.pos)
    const x = Math.round(p.x * 2) / 2
    const y = Math.round(p.y * 2) / 2
    holes.push({ x, y })
  }
  const edges: Array<Vec2 & { kind: CellKind }> = []
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
        if (!edges.some((e) => e.x === x && e.y === y)) edges.push({ x, y, kind: flat ? 'dash' : 'tick' })
      }
    }
  }
  // each part at its true size: its pads' extent on the lattice
  const extent = new Map<string, number>()
  const spans = new Map<string, BBoxAcc>()
  const cos = Math.cos(((hero?.rot ?? 0) * Math.PI) / 180)
  const sin = Math.sin(((hero?.rot ?? 0) * Math.PI) / 180)
  for (const layer of Object.values(board.copper)) {
    for (const p of layer.pads) {
      if (p.footprintRef === undefined) continue
      const b = spans.get(p.footprintRef) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      const r = Math.max(p.size.x, p.size.y) / 2
      const q = p.footprintRef === hero?.ref ? { x: p.pos.x * cos - p.pos.y * sin, y: p.pos.x * sin + p.pos.y * cos } : p.pos
      spans.set(p.footprintRef, { x0: Math.min(b.x0, q.x - r), y0: Math.min(b.y0, q.y - r), x1: Math.max(b.x1, q.x + r), y1: Math.max(b.y1, q.y + r) })
    }
  }
  for (const [ref, b] of spans) extent.set(ref, Math.max(b.x1 - b.x0, b.y1 - b.y0) * k)
  const reach = Math.hypot(room.nx, room.ny)
  const side = hero === undefined ? { x: 1, y: 1 } : { x: Math.sign((turn ? hero.pos.y - c.y : hero.pos.x - c.x)) || 1, y: Math.sign((turn ? hero.pos.x - c.x : hero.pos.y - c.y)) || 1 }
  const sizeOf = (cell: Pick<CoreCell, 'big' | 'ref'>): number => (cell.big ? 1.5 : Math.max(0.38, Math.min(1.3, extent.get(cell.ref) ?? 0.7)))
  // the main chip is drawn once, on its own side and at its own turn
  const shapeOf = (cell: Pick<CoreCell, 'big' | 'ref' | 'kind' | 'x' | 'y'>): Vec2[] => cell.ref === hero?.ref
    ? outline(cell.kind, sizeOf(cell), chipTurn, side.x * cell.x, side.y * cell.y)
    : outline(cell.kind, sizeOf(cell), 0, cell.x, cell.y)
  // parts take their places first, clear of the board's edge; a hole that would cross a part yields to it, and the edge breaks round a hole close to it
  const edgeShapes = edges.map((e) => outline(e.kind, MARK_SIZE, 0, e.x, e.y))
  const placed = foldParts(board, board.footprints.filter((f) => !/\*/.test(f.ref)), fold, room.nx - 2, room.ny - 2, 0.22, shapeOf, gap, edgeShapes, hero?.ref)
  const partShapes = placed.map(shapeOf)
  const ringShapes: Vec2[][] = []
  for (const o of holes) {
    const ring = outline('ring', MARK_SIZE, 0, o.x, o.y)
    if (!partShapes.every((q) => apart(ring, q, gap))) continue
    if (g.add({ x: o.x, y: o.y, role: 'joint', kind: 'ring', size: MARK_SIZE, at: sweep(o.x, o.y) + 0.02 })) ringShapes.push(ring)
  }
  for (const [i, e] of edges.entries()) {
    if (!ringShapes.every((q) => apart(edgeShapes[i] as Vec2[], q, gap))) continue
    g.add({ x: e.x, y: e.y, role: 'edge', kind: e.kind, size: MARK_SIZE, tone: 0.85, at: sweep(e.x, e.y) })
  }
  for (const cell of placed) {
    const size = sizeOf(cell)
    const chip = cell.ref === hero?.ref
    g.add({
      x: chip ? side.x * cell.x : cell.x,
      y: chip ? side.y * cell.y : cell.y,
      role: chip ? 'hero' : cell.big ? 'anchor' : 'body',
      ...(chip ? { sym: 'single' as const, rot: chipTurn } : {}),
      kind: cell.kind,
      size,
      tone: PLAN_TONE[cell.kind] ?? 0.72,
      at: (TIER[cell.kind] ?? 0.55) + (0.2 * Math.hypot(cell.x - hx, cell.y - hy)) / reach
    })
  }
  const site = [{ x: hx, y: hy }, { x: -hx, y: hy }, { x: hx, y: -hy }, { x: -hx, y: -hy }]
  return { id: 'plan', cells: g.cells, seeds: site, stripTo: site }
}

/** the convex hull, in pitches, of a cell's outline drawn at `size`, turned by `rot` and centred on x, y */
export function outline(kind: CellKind, size: number, rot: number, x: number, y: number): Vec2[] {
  const pts = cellGlyph(kind).strokes.flat().map((q) => ({ x: x + (q.x * Math.cos(rot) - q.y * Math.sin(rot)) * size, y: y + (q.x * Math.sin(rot) + q.y * Math.cos(rot)) * size }))
  return hull(pts)
}

/** the convex hull of points, counter-clockwise (Andrew's monotone chain) */
function hull(points: Vec2[]): Vec2[] {
  const ps = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const chain = (list: Vec2[]): Vec2[] => {
    const out: Vec2[] = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2] as Vec2, out[out.length - 1] as Vec2, p) <= 0) out.pop()
      out.push(p)
    }
    return out.slice(0, -1)
  }
  return ps.length < 3 ? ps : [...chain(ps), ...chain([...ps].reverse())]
}

/** a lower bound on the distance between two convex outlines: their widest separation along any edge's normal or direction */
export function hullGap(a: Vec2[], b: Vec2[]): number {
  const axes = [a, b].flatMap((h) => h.flatMap((p, i) => {
    const q = h[(i + 1) % h.length] as Vec2
    const l = Math.hypot(q.x - p.x, q.y - p.y)
    return l === 0 ? [] : [{ x: (q.x - p.x) / l, y: (q.y - p.y) / l }, { x: -(q.y - p.y) / l, y: (q.x - p.x) / l }]
  }))
  return Math.max(...[{ x: 1, y: 0 }, { x: 0, y: 1 }, ...axes].map((n) => {
    const pa = a.map((p) => p.x * n.x + p.y * n.y)
    const pb = b.map((p) => p.x * n.x + p.y * n.y)
    return Math.max(Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb))
  }))
}

/** whether an outline keeps `gap` from another and from each of its mirror copies about both axes */
function apart(a: Vec2[], b: Vec2[], gap: number): boolean {
  return [[1, 1], [-1, 1], [1, -1], [-1, -1]].every(([sx, sy]) => hullGap(a, b.map((p) => ({ x: p.x * (sx as number), y: p.y * (sy as number) }))) >= gap)
}

interface BBoxAcc {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The last scene: the field. Every pad and via of the board at its true place, sized to fit `box`
 * and turned so its long side runs along the box's, with the main chip at the origin, where the
 * routes' chip stands; the camera centres the field when it is whole. Through-holes are rings, the rest dots sized
 * from the pad; the main chip's own pads are the brightest dots, and other parts' pads under it
 * are left out. It is built in stages of rising size, each a wave out from the main chip: the
 * smallest marks with the chip, then the next size, then the largest. After a stop the marks that
 * close the picture land together: the mounting holes, or the largest marks farthest from the chip.
 * Each stage's marks start to decode on the stage's beat; `decodeBeats` is how long a decode takes.
 */
/** how the field lays the board into a box: its copper's centre, whether it stands a quarter turn round so its long side lies along the box's, its half extents and its scale into lattice pitches */
export function fieldFit(board: BoardModel, box: Box, keep?: boolean): { c: Vec2; turn: boolean; hw: number; hh: number; k: number } {
  const copper = Object.values(board.copper).flatMap((l) => [...l.pads.map((p) => p.pos), ...l.vias.map((v) => v.pos)])
  const sites = copper.length > 0 ? copper : [board.bbox.min, board.bbox.max]
  const xs = sites.map((p) => p.x)
  const ys = sites.map((p) => p.y)
  const lo = { x: Math.min(...xs), y: Math.min(...ys) }
  const hi = { x: Math.max(...xs), y: Math.max(...ys) }
  const bw = box.x1 - box.x0
  const bh = box.y1 - box.y0
  const turn = keep ?? hi.x - lo.x > hi.y - lo.y !== bw > bh
  const hw = Math.max(1e-6, (turn ? hi.y - lo.y : hi.x - lo.x) / 2)
  const hh = Math.max(1e-6, (turn ? hi.x - lo.x : hi.y - lo.y) / 2)
  const k = Math.min((bw / 2 - 0.6) / hw, (bh / 2 - 0.6) / hh)
  return { c: { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 }, turn, hw, hh, k }
}

export function fieldAct(board: BoardModel, box: Box, hero: Footprint | undefined, decodeBeats: number, keep?: boolean): ActPlan {
  const all = Object.values(board.copper)
  const { c, turn, k } = fieldFit(board, box, keep)
  const local = (p: Vec2): Vec2 => {
    const dx = (p.x - c.x) * k
    const dy = (p.y - c.y) * k
    return turn ? { x: -dy, y: dx } : { x: dx, y: dy }
  }
  const h0 = local(hero?.pos ?? c)
  const off = { x: -h0.x, y: -h0.y }
  const at = (p: Vec2): Vec2 => {
    const q = local(p)
    return { x: q.x + off.x, y: q.y + off.y }
  }
  const pid = (p: Vec2): string => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`
  const heroPads = [...new Map(all.flatMap((l) => l.pads).filter((p) => p.footprintRef === hero?.ref).map((p) => [pid(p.pos), p])).values()]
  const h = at(hero?.pos ?? c)
  const near = (p: Vec2): number => Math.hypot(at(p).x - h.x, at(p).y - h.y)
  const under = heroPads.length === 0 ? (): boolean => false : (() => {
    const x0 = Math.min(...heroPads.map((p) => p.pos.x)) - 0.6
    const x1 = Math.max(...heroPads.map((p) => p.pos.x)) + 0.6
    const y0 = Math.min(...heroPads.map((p) => p.pos.y)) - 0.6
    const y1 = Math.max(...heroPads.map((p) => p.pos.y)) + 0.6
    return (p: Vec2): boolean => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1
  })()
  const gaps = heroPads.map((p) => Math.min(...heroPads.filter((q) => q !== p).map((q) => Math.hypot(p.pos.x - q.pos.x, p.pos.y - q.pos.y)))).filter(Number.isFinite).sort((a, b) => a - b)
  const heroPitch = gaps[Math.floor(gaps.length / 2)] ?? 1
  const tht = new Set(Object.entries(board.copper).filter(([n]) => n.startsWith('In')).flatMap(([, l]) => l.pads.map((p) => pid(p.pos))))
  const signal = new Set([...partsOnNets(board)].filter(([n, refs]) => refs.size >= 2 && refs.size < RAIL_PARTS && heroPads.some((p) => p.netId === n)).map(([n]) => n))
  const parts = new Map(board.footprints.map((f) => [f.ref, f]))
  const kindOf = (ref: string | undefined): string | undefined => {
    const f = ref === undefined ? undefined : parts.get(ref)
    return f === undefined ? undefined : classify(f.ref, f.value)
  }
  const link = (net: number | undefined, ref?: string): Cell['link'] => {
    if (net === undefined || !signal.has(net)) return undefined
    return kindOf(ref) === 'conn' ? 'exit' : 'net'
  }
  const pads = all.flatMap((l) => l.pads)
  const byPart = new Map<string | undefined, Pad[]>()
  for (const p of pads) {
    const mine = byPart.get(p.footprintRef) ?? []
    mine.push(p)
    byPart.set(p.footprintRef, mine)
  }
  const inside = (p: Pad): boolean => (byPart.get(p.footprintRef) ?? []).some((o) => o.size.x * o.size.y > 4 * p.size.x * p.size.y &&
    Math.abs(p.pos.x - o.pos.x) < Math.max(o.size.x, o.size.y) / 2 && Math.abs(p.pos.y - o.pos.y) < Math.max(o.size.x, o.size.y) / 2)

  interface Mark { cell: Cell; r: number; via: boolean; hole: boolean; bar?: { long: number; short: number; rot: number } }
  const marks: Mark[] = []
  const seen = new Set(heroPads.map((p) => pid(p.pos)))
  for (const p of pads) {
    const id = pid(p.pos)
    if (seen.has(id) || under(p.pos)) continue
    seen.add(id)
    if (tht.has(id) && inside(p)) continue
    const q = at(p.pos)
    const hole = kindOf(p.footprintRef) === 'hole'
    const ring = tht.has(id) || hole
    const size = hole
      ? Math.min(1.6, Math.max(0.42, (Math.max(p.size.x, p.size.y) * k) / (2 * RING_R)))
      : ring ? Math.min(0.42, Math.max(0.13, Math.max(p.size.x, p.size.y) * k * 0.8)) / 0.48 : Math.min(1.05, Math.max(0.55, (Math.min(p.size.x, p.size.y) * k) / 0.15))
    const long = Math.max(p.size.x, p.size.y) * k
    const short = Math.min(p.size.x, p.size.y) * k
    const bar = !ring && p.shape !== 'circle' && long >= BAR_ASPECT * short
    const rot = (-p.rot * Math.PI) / 180 + (p.size.y > p.size.x ? Math.PI / 2 : 0) + (turn ? Math.PI / 2 : 0)
    marks.push({
      cell: { x: q.x, y: q.y, role: 'body', sym: 'single', kind: ring ? 'ring' : 'dot', size, tone: 0.92, at: near(p.pos), link: link(p.netId, p.footprintRef), group: p.footprintRef },
      r: size * (ring ? RING_R : DOT_R),
      via: false,
      hole,
      ...(bar ? { bar: { long, short, rot } } : {})
    })
  }
  for (const d of board.drill) {
    if (d.plated || d.dia < 2 || seen.has(pid(d.pos))) continue
    seen.add(pid(d.pos))
    const q = at(d.pos)
    const size = Math.min(1.6, Math.max(0.42, (d.dia * k) / (2 * RING_R)))
    marks.push({ cell: { x: q.x, y: q.y, role: 'body', sym: 'single', kind: 'ring', size, tone: 0.92, at: near(d.pos) }, r: size * RING_R, via: false, hole: true })
  }
  for (const v of all.flatMap((l) => l.vias)) {
    const id = pid(v.pos)
    if (seen.has(id) || under(v.pos)) continue
    seen.add(id)
    const q = at(v.pos)
    marks.push({ cell: { x: q.x, y: q.y, role: 'body', sym: 'single', kind: 'dot', size: 0.42, tone: 0.7, at: near(v.pos), link: link(v.netId) }, r: 0.42 * DOT_R, via: true, hole: false })
  }

  const centres = [...marks.map((m) => m.cell), ...heroPads.map((p) => at(p.pos))]
  const bars = new Map<string, Glyph>()
  for (const m of marks) {
    const gap = PAD_GAP * Math.min(...centres.filter((c) => c !== m.cell).map((c) => Math.hypot(c.x - m.cell.x, c.y - m.cell.y)))
    if (m.r <= gap) continue
    if (m.bar !== undefined) {
      const ink = Math.PI * m.r * m.r
      m.r = Math.min(m.bar.short / 2, gap)
      const ux = Math.cos(m.bar.rot)
      const uy = Math.sin(m.bar.rot)
      const lane = centres.filter((c) => c !== m.cell).flatMap((c) => {
        const dx = c.x - m.cell.x
        const dy = c.y - m.cell.y
        return Math.abs(-dx * uy + dy * ux) < m.r + PAD_GAP * Math.hypot(dx, dy) ? [Math.abs(dx * ux + dy * uy)] : []
      })
      const long = Math.max(2 * m.r, Math.min(m.bar.long, 2 * PAD_GAP * Math.min(Infinity, ...lane)))
      m.cell.size = long
      m.cell.rot = m.bar.rot
      m.cell.tone = (m.cell.tone ?? 1) * Math.min(1, (ink / (2 * m.r * long)) ** BAR_INK)
      const exact = (2 * m.r) / long
      const thin = Math.floor(exact / BAR_STEP) * BAR_STEP || exact
      const id = `cell:bar:${thin.toFixed(4)}`
      if (!bars.has(id)) bars.set(id, { id, kind: 'mark', filled: true, strokes: [[{ x: -0.5, y: -thin / 2 }, { x: 0.5, y: -thin / 2 }, { x: 0.5, y: thin / 2 }, { x: -0.5, y: thin / 2 }, { x: -0.5, y: -thin / 2 }]] })
      m.cell.glyphId = id
      continue
    }
    m.cell.size = ((m.cell.size ?? 1) * gap) / m.r
    m.r = gap
  }
  const reach = Math.max(1e-9, ...marks.map((m) => m.cell.at ?? 0))
  const share = (m: Mark): number => (m.cell.at ?? 0) / reach
  const holes = marks.filter((m) => m.hole)
  const closing = new Set(holes.length > 0 ? holes : [...marks].filter((m) => share(m) > 0.75).sort((a, b) => b.r - a.r).slice(0, CLOSING_FALLBACK))
  const rest = marks.filter((m) => !closing.has(m))
  const dots = rest.filter((m) => m.cell.kind === 'dot').sort((a, b) => a.r - b.r)
  const vias = dots.filter((m) => m.via)
  const first = new Set(vias.length >= FIELD_FIRST_SHARE * rest.length ? vias : dots.slice(0, Math.ceil(dots.length / 2)))
  const nearest = new Set([...rest].sort((a, b) => share(a) - share(b)).filter((m, i) => i < FIELD_NEAREST || share(m) <= FIELD_NEAR))
  const stageOf = (m: Mark): number => closing.has(m) ? 4 : nearest.has(m) || first.has(m) ? 1 : m.cell.kind === 'dot' ? 2 : 3
  const stages = new Map<number, Mark[]>()
  for (const m of marks) {
    const list = stages.get(stageOf(m)) ?? []
    list.push(m)
    stages.set(stageOf(m), list)
  }
  const from = new Map([...stages].map(([st, ms]) => [st, st === 1 ? 0 : Math.min(...ms.map(share))]))
  const wave = (stage: number, m: Mark): number => {
    const [start, span] = FIELD_WAVES[stage - 1] as readonly [number, number]
    const r0 = from.get(stage) ?? 0
    return start + decodeBeats + (span * (share(m) - r0)) / Math.max(1e-9, 1 - r0)
  }
  const cells: Cell[] = heroPads.map((p) => {
    const q = at(p.pos)
    return { x: q.x, y: q.y, role: 'hero', sym: 'single', kind: 'dot', size: Math.max(0.7, (0.62 * heroPitch * k) / 0.15), tone: 1, at: near(p.pos), land: decodeBeats, stage: 1, group: hero?.ref }
  })
  for (const m of marks) {
    const stage = stageOf(m)
    cells.push({ ...m.cell, stage, land: stage === 4 ? FIELD_CLOSE : nearest.has(m) ? decodeBeats : wave(stage, m) })
  }
  return { id: 'field', cells, seeds: [h], stripTo: [h], glyphs: [...bars.values()] }
}

export interface CoreCell {
  x: number
  y: number
  kind: CellKind
  big: boolean
  ref: string
}

const PRIORITY: Record<CellKind, number> = {
  chip: 6, leaf: 5, half: 4, pad: 3, ring: 3, bracket: 2, pill: 1,
  dot: 0, tick: 0, dash: 0, slash: 0, wedge: 0, corner: 0
}

/**
 * The named part if the board has it, then the first IC the curated hints
 * prefer. Otherwise the IC that carries the most signals (nets shared with
 * one to seven other parts; a net on more parts is a rail), then the part
 * that is not a connector or a hole, then a connector; a tie goes to more
 * pads, then to the part nearer the board's centre.
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
  const signals = signalsByPart(board)
  const rank = (f: Footprint): number[] => [signals.get(f.ref) ?? 0, f.padRefs.length, -off(f)]
  return pool.reduce<Footprint | undefined>((best, f) => {
    if (best === undefined) return f
    const a = rank(f)
    const b = rank(best)
    const i = a.findIndex((v, k) => v !== b[k])
    return i >= 0 && (a[i] as number) > (b[i] as number) ? f : best
  }, undefined)
}

export const RAIL_PARTS = 9

export function partsOnNets(board: BoardModel): Map<number, Set<string>> {
  const partsOnNet = new Map<number, Set<string>>()
  for (const copper of Object.values(board.copper)) {
    for (const pad of copper.pads) {
      if (pad.netId === undefined || pad.netId === 0 || pad.footprintRef === undefined) continue
      const refs = partsOnNet.get(pad.netId) ?? new Set<string>()
      refs.add(pad.footprintRef)
      partsOnNet.set(pad.netId, refs)
    }
  }
  return partsOnNet
}

function signalsByPart(board: BoardModel): Map<string, number> {
  const count = new Map<string, number>()
  for (const refs of partsOnNets(board).values()) {
    if (refs.size < 2 || refs.size >= RAIL_PARTS) continue
    for (const ref of refs) count.set(ref, (count.get(ref) ?? 0) + 1)
  }
  return count
}

/**
 * Parts snapped onto one quadrant of the lattice by `fold` (mm → lattice
 * units). One cell per site; the higher-ranked part wins a collision so ICs
 * and diodes read through the passive flood. Dense at the origin, thinning
 * outward; `fill` caps the share of sites taken so the lattice breathes.
 */
/**
 * The parts folded into one quadrant, strongest first. A part takes its own
 * site only where its outline at its true size keeps `gap` from the board's edge, from
 * every outline already placed and from its own mirror copies; otherwise it is left out.
 */
function foldParts(board: BoardModel, parts: Footprint[], fold: (p: Vec2) => Vec2, cx: number, cy: number, fill: number, shape: (c: Pick<CoreCell, 'big' | 'ref' | 'kind' | 'x' | 'y'>) => Vec2[], gap: number, marks: Vec2[][], single?: string): CoreCell[] {
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
  const shapes = [...marks]
  // its own mirror copies, where they are distinct, must clear it too; the main chip has none
  const clear = (cell: Vec2 & { ref: string }, o: Vec2[]): boolean =>
    (cell.ref === single || ((cell.x === 0 || hullGap(o, o.map((p) => ({ x: -p.x, y: p.y }))) >= gap) &&
      (cell.y === 0 || hullGap(o, o.map((p) => ({ x: p.x, y: -p.y }))) >= gap) &&
      (cell.x === 0 || cell.y === 0 || hullGap(o, o.map((p) => ({ x: -p.x, y: -p.y }))) >= gap))) &&
    shapes.every((q) => apart(o, q, gap))
  for (const c of candidates) {
    if (cells.length >= cap) break
    // a block straddling an axis would overlap its own mirror copy
    const block = c.big && c.x >= 1 && c.y >= 1 && c.x + 1 <= cx && c.y + 1 <= cy
      ? [[0, 0], [1, 0], [0, 1], [1, 1]]
      : [[0, 0]]
    const keys = block.map(([dx, dy]) => `${c.x + (dx as number)},${c.y + (dy as number)}`)
    if (keys.some((k) => taken.has(k))) continue
    const cell = { x: block.length > 1 ? c.x + 0.5 : c.x, y: block.length > 1 ? c.y + 0.5 : c.y, kind: c.kind, big: block.length > 1, ref: c.ref }
    const o = shape(cell)
    if (!clear(cell, o)) continue
    for (const k of keys) taken.add(k)
    shapes.push(o)
    cells.push(cell)
  }
  return cells
}

