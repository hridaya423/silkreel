import type { BoardModel, Vec2 } from '@silk-reel/ingest'
import { boardCore, frameAct, heroPart, planAct, routeAct } from './acts'
import type { ActPlan, Cell, Role, Room } from './acts'
import { CELL_KINDS, cellGlyph, cellId, heroChip, takeCensus } from './cells'
import type { CellKind, Census } from './cells'
import { DECODE_IN } from './decode'
import { mod } from './curves'
import { buildCast, REFDES, VALUE } from './glyphs'
import { safeArea } from './layout'
import { makeRng } from './rng'
import type { Rng } from './rng'
import type { ResolvedConfig } from './config'
import type { AtomState, FormationEvent, Glyph, Placement, TimelineWarning, Tone } from './types'

/**
 * The loop is a score on a 15fps decode grid. Nothing ever moves: cells
 * decode in, hold, and decode out, and all the motion is the ORDER they do it
 * in. Each act grows outward from its seeds along its own structure, breathes
 * through a hold, then strips back toward the next act's seeds — so the
 * residue of one act is the first mark of the next, and the last act's
 * residue is the first frame of the loop.
 */

const DECODE_IN_STEPS = DECODE_IN[0]?.length ?? 5
/** a full loop is 24 beats (168 steps, 11.2s) */
const LOOP_BEATS = 24
/** one lattice pitch in stage units (stage ±1 = half the safe short side) */
const PITCH = 0.085
/** how much of each stage half-axis the structures may claim */
const FILL = 0.71

interface ActTiming {
  /** seed marks appear (may be negative — wraps) */
  seeds: number
  grow: [number, number]
  strip: [number, number]
}

/** in beats; the frame act holds longest — it is the climax */
const SCORE: ActTiming[] = [
  { seeds: -1.4, grow: [0, 3.6], strip: [6.2, 8.7] },
  { seeds: 6.9, grow: [8, 11.4], strip: [14.2, 16.7] },
  { seeds: 14.9, grow: [16, 19.6], strip: [22.2, 24.8] }
]
/** where frame 0 sits in the score: just after the routes complete */
const OPEN_BEAT = 4

const ROLE_SIZE: Record<Role, number> = {
  anchor: 0.95, body: 0.8, edge: 0.8, joint: 0.8, accent: 0.72, hero: 2.1, text: 0.5
}
const ROLE_TONE: Record<Role, number> = {
  anchor: 0.92, body: 0.78, edge: 0.6, joint: 0.7, accent: 0.62, hero: 1, text: 0.72
}
const ROLE_KIND: Record<Role, Tone> = {
  anchor: 'support', body: 'support', edge: 'punct', joint: 'punct', accent: 'punct', hero: 'hero', text: 'text'
}


export interface ComposeResult {
  cast: Glyph[]
  placements: Placement[]
  formations: FormationEvent[]
  steps: number
  cadence: 'twos' | 'smooth'
  warnings: TimelineWarning[]
}

function weighted(rng: Rng, items: Array<{ kind: CellKind; w: number }>): CellKind {
  let r = rng.next()
  for (const it of items) {
    r -= it.w
    if (r <= 0) return it.kind
  }
  return (items[items.length - 1] as { kind: CellKind }).kind
}

function pickKind(role: Role, census: Census, rng: Rng): CellKind {
  switch (role) {
    case 'anchor': {
      const chip = census.body.find((b) => b.kind === 'chip')?.w ?? 0
      const leaf = census.body.find((b) => b.kind === 'leaf')?.w ?? 0
      return rng.next() < chip / Math.max(1e-9, chip + leaf) ? 'chip' : 'leaf'
    }
    case 'body':
      return weighted(rng, census.body)
    case 'edge':
      return rng.pick(['tick', 'dash', 'bracket'] as CellKind[])
    case 'joint':
      return rng.pick<CellKind>(census.holes ? ['ring', 'dot', 'pad'] : ['dot', 'pad', 'dot'])
    default:
      return rng.pick(['dot', 'corner', 'dot'] as CellKind[])
  }
}

/** one cell's symmetry copies, in stage units; coincident copies collapse */
function expand(cell: Cell, scale: number, text: boolean): AtomState[] {
  const x = cell.x * PITCH
  const y = cell.y * PITCH
  const rot = cell.rot ?? 0
  const fx = cell.flipX === true
  const fy = cell.flipY === true
  const base: AtomState = { x, y, rot, scale, flipX: fx, flipY: fy }
  // words never mirror: copies move, the text stays readable
  const flip = (ax: boolean, ay: boolean): AtomState =>
    text ? { ...base, x: ax ? -x : x, y: ay ? -y : y } : { ...base, x: ax ? -x : x, y: ay ? -y : y, flipX: ax ? !fx : fx, flipY: ay ? !fy : fy }
  const atoms: AtomState[] = [base]
  switch (cell.sym) {
    case 'single':
      break
    case 'rot2':
      if (x !== 0 || y !== 0) atoms.push(text ? { ...base, x: -x, y: -y } : { ...base, x: -x, y: -y, rot: rot + Math.PI })
      break
    case 'mirrorX':
      if (x !== 0) atoms.push(flip(true, false))
      break
    case 'quad':
      if (x !== 0) atoms.push(flip(true, false))
      if (y !== 0) atoms.push(flip(false, true))
      if (x !== 0 && y !== 0) atoms.push(flip(true, true))
      break
  }
  return atoms
}

interface Unit {
  placement: Placement
  act: number
  /** lattice positions of every copy, for growth distances */
  sites: Vec2[]
  lag: number
  at?: number | undefined
  life?: number | undefined
}

/** shortest growth distance from the seeds to every unit across the lattice */
function growthDistances(units: Unit[], seeds: Vec2[]): number[] {
  const near = (a: Vec2[], b: Vec2[]): number => {
    let best = Infinity
    for (const p of a) for (const q of b) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y))
    return best
  }
  const n = units.length
  const dist = units.map((u) => near(u.sites, seeds) < 0.8 ? 0 : Infinity)
  if (dist.every((d) => d === Infinity)) {
    // no unit sits on a seed: start from whichever is nearest
    const d0 = units.map((u) => near(u.sites, seeds))
    const m = Math.min(...d0)
    d0.forEach((d, i) => { if (d <= m + 1e-9) dist[i] = 0 })
  }
  const pair: number[][] = units.map((a) => units.map((b) => near(a.sites, b.sites)))
  const done = new Array<boolean>(n).fill(false)
  for (let it = 0; it < n; it++) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || (dist[i] as number) < (dist[u] as number))) u = i
    if (u < 0 || dist[u] === Infinity) break
    done[u] = true
    const row = pair[u] as number[]
    for (let v = 0; v < n; v++) {
      if (done[v]) continue
      const d = row[v] as number
      // growth crawls cell to cell; long jumps cost extra so gaps read as gaps
      const w = (d <= 1.6 ? d : d * 1.6) * (units[v] as Unit).lag
      if ((dist[u] as number) + w < (dist[v] as number)) dist[v] = (dist[u] as number) + w
    }
  }
  return dist.map((d) => (d === Infinity ? 0 : d))
}


/**
 * Two short words off the board's own silk — net names, block labels — for
 * the frame act's captions. Hinted words lead; then short upper-case tokens,
 * front side and taller first, since those are the ones a designer labelled.
 */
function boardWords(board: BoardModel, prefer: string[], rng: Rng): Glyph[] {
  const seen = new Map<string, number>()
  for (const [layerId, layer] of Object.entries(board.silkscreen)) {
    for (const t of layer.texts) {
      const v = t.value.trim()
      if (v.length < 2 || v.length > 8 || /\s/.test(v) || REFDES.test(v) || VALUE.test(v) || !/[A-Za-z]/.test(v)) continue
      const score = (layerId.startsWith('F.') ? 2 : 0) + (v === v.toUpperCase() ? 1.5 : 0) + Math.min(2, t.height) + rng.next() * 0.5
      seen.set(v, Math.max(seen.get(v) ?? -Infinity, score + (prefer.includes(v) ? 100 : 0)))
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([v], i) => ({ id: `word:${i}:${v}`, kind: 'text', strokes: [], text: v }))
}

/**
 * order → 0..1 arrival fraction. Pure distance stalls on sparse stretches
 * (a frame's long empty edges); pure rank loses the shape of the wave. Half
 * of each keeps the direction and a steady cadence. Ties land together.
 */
function paced(d: number[]): number[] {
  const lo = Math.min(...d)
  const span = Math.max(1e-9, Math.max(...d) - lo)
  const sorted = [...d].sort((a, b) => a - b)
  const n = Math.max(1, d.length - 1)
  return d.map((v) => 0.5 * ((v - lo) / span) + 0.5 * (sorted.indexOf(v) / n))
}

export function composeFilm(
  board: BoardModel,
  resolved: ResolvedConfig,
  seed: number,
  durationSeconds: number
): ComposeResult {
  const warnings: TimelineWarning[] = []
  const { cast: bench, warnings: castWarnings } = buildCast(
    board,
    resolved.knobs.texts >= 0.5,
    makeRng(seed, 'cast'),
    resolved.cast
  )
  warnings.push(...castWarnings)
  const census = takeCensus(board)

  const safe = safeArea(resolved.width, resolved.height, resolved.title !== undefined)
  const stageAspect = safe.w / safe.h
  const room: Room = {
    nx: Math.floor((FILL * Math.max(1, stageAspect)) / PITCH),
    ny: Math.floor((FILL * Math.max(1, 1 / stageAspect)) / PITCH)
  }
  const steps = Math.round(durationSeconds * 15)
  const at = (b: number): number => Math.round((b * steps) / LOOP_BEATS)

  // every act is the board: its hero's routes, its plan, the hero's neighbourhood
  const hero = heroPart(board, resolved.hero, resolved.cast)
  const coreRoom = { x: Math.min(room.nx - 3, 5), y: Math.min(room.ny - 3, 6) }
  const core = boardCore(board, hero, coreRoom.x, coreRoom.y)
  const heroPkg = (hero === undefined ? undefined : heroChip(board, hero.ref)) ??
    bench.find((g) => g.kind === 'package')
  const words = resolved.knobs.texts >= 0.5 ? boardWords(board, resolved.cast?.preferTexts ?? [], makeRng(seed, 'words')) : []
  const acts: ActPlan[] = [
    routeAct(board, room, hero, heroPkg?.id),
    planAct(board, room, hero),
    frameAct({ nx: room.nx, ny: room.ny }, core, heroPkg?.id, words.map((w) => w.id))
  ]

  const glyphs = new Map<string, Glyph>()
  for (const g of [...bench, ...words, ...acts.flatMap((a) => a.glyphs ?? [])]) glyphs.set(g.id, g)
  if (heroPkg !== undefined) glyphs.set(heroPkg.id, heroPkg)
  for (const k of CELL_KINDS) glyphs.set(cellId(k), cellGlyph(k))
  if (resolved.title !== undefined) {
    glyphs.set('txt:title', { id: 'txt:title', kind: 'text', strokes: [], text: resolved.title.name })
  }

  const units: Unit[] = []
  for (const [ai, act] of acts.entries()) {
    const rng = makeRng(seed, `cells:${ai}`)
    const cells = [...act.cells]
    if (ai === 2 && resolved.title !== undefined) {
      const fy = Math.max(...cells.map((c) => c.y))
      cells.push({ x: 0, y: fy + 1.6, role: 'text', sym: 'single', glyphId: 'txt:title', lag: 1.3 })
    }
    for (const cell of cells) {
      const gid = cell.glyphId ?? cellId(cell.kind ?? pickKind(cell.role, census, rng))
      const glyph = glyphs.get(gid)
      if (glyph === undefined) continue
      const text = glyph.kind === 'text'
      const scale = (cell.size ?? ROLE_SIZE[cell.role]) * PITCH
      const atoms = expand(cell, scale, text)
      const tone = cell.tone ?? ROLE_TONE[cell.role]
      units.push({
        act: ai,
        lag: cell.lag ?? 1,
        at: cell.at,
        life: cell.life,
        sites: atoms.map((a) => ({ x: a.x / PITCH, y: a.y / PITCH })),
        placement: {
          glyphId: gid,
          atoms,
          tones: atoms.map(() => tone),
          role: ROLE_KIND[cell.role],
          inStep: 0,
          outStep: 0,
          pattern: rng.int(0, 6),
          formation: ai,
          ...(cell.weight === undefined ? {} : { weight: cell.weight }),
          ...(cell.flare === undefined ? {} : { flare: cell.flare })
        }
      })
    }
  }

  // growth: each act's cells arrive by lattice distance from its seeds,
  // in pulses of two steps so the wavefront has a pulse
  for (const [ai, act] of acts.entries()) {
    const t = SCORE[ai] as ActTiming
    const mine = units.filter((u) => u.act === ai)
    const g0 = at(t.grow[0])
    const g1 = at(t.grow[1])
    const rng = makeRng(seed, `grow:${ai}`)
    // an authored order travels at one speed, cell by cell; otherwise the
    // structure grows out from its seeds in pulses of two steps
    const timed = mine.every((u) => u.at !== undefined)
    const last = Math.max(1e-9, ...mine.map((u) => u.at ?? 0))
    const grow = timed ? mine.map((u) => (u.at ?? 0) / last) : paced(growthDistances(mine, act.seeds))
    for (const [i, u] of mine.entries()) {
      const frac = grow[i] as number
      if (timed) {
        u.placement.inStep = mod(g0 + Math.round((g1 - g0) * frac), steps)
        continue
      }
      const jitter = frac > 0 && frac < 1 ? rng.int(0, 2) : 0
      u.placement.inStep = mod(g0 + 2 * Math.round(((g1 - g0) * frac) / 2) + jitter, steps)
    }
    // strip toward the next act's seeds: the far side goes first, the cells
    // nearest the next seeds hold on as residue
    const toward = act.stripTo ?? (acts[(ai + 1) % acts.length] as ActPlan).seeds
    const s0 = at(t.strip[0])
    const s1 = at(t.strip[1])
    const strip = paced(mine.map((u) => -Math.min(...u.sites.flatMap((p) => toward.map((q) => Math.hypot(p.x - q.x, p.y - q.y))))))
    for (const [i, u] of mine.entries()) {
      u.placement.outStep = mod(s0 + Math.round((s1 - s0) * (strip[i] as number)) + rng.int(0, 2), steps)
      // a brief mark leaves right after it lands
      if (u.life !== undefined) u.placement.outStep = mod(u.placement.inStep + DECODE_IN_STEPS + u.life, steps)
    }
  }

  // seed marks: the next act's first dots appear while the last act strips
  for (const [ai, act] of acts.entries()) {
    const t = SCORE[ai] as ActTiming
    const atoms = act.seeds.map((p) => ({ x: p.x * PITCH, y: p.y * PITCH, rot: 0, scale: 0.8 * PITCH }))
    units.push({
      act: ai,
      lag: 1,
      sites: act.seeds,
      placement: {
        glyphId: cellId('dot'),
        atoms,
        tones: atoms.map(() => 0.9),
        role: 'punct',
        inStep: mod(at(t.seeds), steps),
        outStep: mod(at(t.grow[0]) + 3, steps),
        pattern: 1,
        formation: ai
      }
    })
  }

  // the hold breathes: single cells blink out and back, never two at once
  for (const [ai] of acts.entries()) {
    const t = SCORE[ai] as ActTiming
    const rng = makeRng(seed, `breath:${ai}`)
    const pool = units.filter((u) => u.act === ai && u.life === undefined && u.placement.role !== 'hero' && u.placement.role !== 'text' && u.sites.length > 1)
    if (pool.length === 0) continue
    const h0 = at(t.grow[1]) + 6
    const h1 = at(t.strip[0]) - 2
    for (let s = h0; s < h1; s += 2 + rng.int(0, 3)) {
      const u = rng.pick(pool)
      const blinks = u.placement.blinks ?? []
      blinks.push(mod(s, steps))
      u.placement.blinks = blinks
    }
  }

  // the loop opens on the routes already standing: frame 0 is a poster, and
  // the first motion a scroller sees is the strip that hands off to act II
  const shift = at(OPEN_BEAT)
  const placements = units.map((u) => {
    const p = u.placement
    p.inStep = mod(p.inStep - shift, steps)
    p.outStep = mod(p.outStep - shift, steps)
    if (p.blinks !== undefined) p.blinks = p.blinks.map((b) => mod(b - shift, steps))
    return p
  })
  const formations: FormationEvent[] = acts
    .map((act, i) => {
      const t = SCORE[i] as ActTiming
      const start = mod(at(t.grow[0]) - shift, steps)
      return { id: act.id, startPhase: start / steps, endPhase: (start + at(t.strip[1]) - at(t.grow[0])) / steps, beat: i }
    })
    .sort((a, b) => a.startPhase - b.startPhase)

  const used = new Set(placements.map((p) => p.glyphId))
  return {
    cast: [...glyphs.values()].filter((g) => used.has(g.id)),
    placements,
    formations,
    steps,
    cadence: resolved.cadence,
    warnings
  }
}
