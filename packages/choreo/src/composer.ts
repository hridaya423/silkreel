import type { BoardModel, Vec2 } from '@silk-reel/ingest'
import { fieldAct, fieldFit, heroPart, planAct, routeAct } from './acts'
import { clusterAct, diagonalAct } from './board-acts'
import { boardTitle } from './board-title'
import { nameAct } from './name-act'
import type { ActPlan, Box, Cell, Role, Room } from './acts'
import { CELL_KINDS, cellGlyph, cellId, heroChip, takeCensus } from './cells'
import type { CellKind, Census } from './cells'
import { DECODE_IN, DECODE_OUT } from './decode'
import { mod } from './curves'
import { buildCast } from './glyphs'
import { safeArea } from './layout'
import { makeRng } from './rng'
import type { Rng } from './rng'
import { GLYPH_ADDED_BEATS, GLYPH_FILM_BEATS, GLYPH_LOOP_BEATS } from './config'
import type { ResolvedConfig } from './config'
import type { AtomState, FormationEvent, Glyph, GlyphEvent, Placement, TimelineWarning, Tone } from './types'

/**
 * The loop is a score on a 15fps decode grid. Nothing ever moves: cells
 * decode in, hold, and decode out, and all the motion is the ORDER they do it
 * in. Each act grows outward from its seeds along its own structure, breathes
 * through a hold, then strips back toward the next act's seeds — so the
 * residue of one act is the first mark of the next, and the last act's
 * residue is the first frame of the loop.
 */

const DECODE_IN_STEPS = DECODE_IN[0]?.length ?? 5
const DECODE_OUT_STEPS = DECODE_OUT[0]?.length ?? 6
/** the share of a fast-grown act, nearest its seeds, that writes on its first step, so it never opens on one part alone */
const FIRST_PULSE_SHARE = 0.25
/** the write-ins that show ink on their first step and blink at different steps, so a fast-grown act never blinks out whole */
const FULL_FIRST_PATTERNS = DECODE_IN.flatMap((p, i) => ((p[0] ?? 0) > 0 ? [i] : []))
const LOOP_BEATS = GLYPH_LOOP_BEATS
/** one lattice pitch in stage units (stage ±1 = half the safe short side) */
const PITCH = 0.085
/** no mark of a formation writes in within this distance, in stage units, of a mark of the formation before it that still stands */
export const GLYPH_CLEAR = 2 * PITCH
/** how much of each stage half-axis the structures may claim */
const FILL = 0.71

interface ActTiming {
  grow: [number, number]
  strip: [number, number]
  /** the hold starts breathing here; at the end of the growth when absent */
  breath?: number
}

/**
 * In beats; the field holds longest — it is the last scene. The routes write
 * in only after it has held: no act is ever drawn over another, so the field
 * strips inward to the main chip just ahead of the routes. The plan leaves a
 * beat earlier than the field starts, and the field is built in stages timed
 * by its own cells (`Cell.land`), so its grow window ends on its lock.
 */
const SCORE: ActTiming[] = [
  { grow: [13 / 7, 16 / 7], strip: [7, 7], breath: 3.6 },
  { grow: [8, 8 + 6 / 7], strip: [12.7, 12.7] },
  { grow: [96 / 7, 14], strip: [124 / 7, 124 / 7] },
  { grow: [131 / 7, 134 / 7], strip: [161 / 7, 161 / 7] },
  { grow: [161 / 7, 196 / 7], strip: [219 / 7, 219 / 7] },
  { grow: [227 / 7, 238 / 7], strip: [LOOP_BEATS + 1, LOOP_BEATS + 1] }
]
const FIELD_ACT = 4
/** where frame 0 sits in the score: just after the routes complete */
const OPEN_BEAT = 4
/** the glyph hairline in pixels on a frame whose short side is 1080 */
export const GLYPH_INK = 2
/** a glyph's stroke on screen is this many times its ink at any camera scale */
export const GLYPH_INK_SCALE = 1.25
/** two plan outlines keep three line weights of dark between their strokes, so four between their centre lines */
const PLAN_GAP_WEIGHTS = 4
/** a label keeps this share of the frame's short side from every edge */
export const LABEL_MARGIN = 0.04
/** each tone's depth layer: it scales by 1 + 0.09 z and drifts by 1 + 0.9 z */
export const GLYPH_Z: Record<Tone, number> = { hero: 1, text: 0.4, support: 0, punct: -1 }
/** the plan's and the routes' hairline is at least this many pixels when the film plays 390 px wide, so their outlines read on a phone; the field is dense enough without */
const PHONE_INK = 0.7
const PHONE_INK_ACTS = new Set(['plan', 'route', 'diagonal', 'cluster', 'name'])
const PHONE_WIDTH = 390
/** the push before the last scene ends with the main chip this share of the frame's width */
export const GLYPH_CHIP_SHARE = 1 / 3
/** a part at least this share of the main chip's size is one of its size */
const CHIP_LIKE = 0.7
/** steps before the cut where the parts of the chip's size that the push's last frame would show write out */
const CHIP_CLEAR_STEPS = 9
/** frames before the last scene's first beat where the camera cuts to its close start; the formation before holds whole to that frame */
export const GLYPH_CUT_EARLY = 4
/** a formation's lock is an event of its own only this many seconds clear of a formation starting or the name landing */
const LOCK_CLEAR = 0.4
/** a pull lands this many frames before the dive at the latest, and lasts at least PULL_LEAST frames, starting before its formation writes in when that comes late */
const PULL_CLEAR = 12
const PULL_LEAST = 42
/** a pull that changes the scale by less than this share keeps to its formation's own frames, so a handover stays at one scale */
const PULL_SMALL = 0.03
/** the share of the frame's edge the field keeps clear of the drift and roll */
const FIELD_MARGIN = 0.06
/** a text glyph on several lines: each line's baseline sits this many sizes under the one before */
export const GLYPH_NAME_LEADING = 1.15
/** the camera's scale where it is widest, as the last formation holds */
export const GLYPH_WIDE = 1.32
/** a pull lands on the scale the glide had this many frames before the lock, so the landing is never wider than the glide */
export const LAND_EARLY = 6

const ease = (u: number): number => {
  const t = Math.min(1, Math.max(0, u))
  return t * t * (3 - 2 * t)
}
const mix = (a: number, b: number, u: number): number => a + (b - a) * u

const GLIDE_FIRST = 4.08
const GLIDE_MIDDLE = 12 + GLYPH_ADDED_BEATS
const GLIDE_LAST = 19.2 + GLYPH_ADDED_BEATS
/** the camera's scale as one unbroken glide over the score's share p: the approved film's camera, its middle stretched over the beats the film gained, so the routes open and the field ends as they did; the pulls never go wider than it */
export const glide = (p: number): number => {
  const b = p * LOOP_BEATS
  if (b < GLIDE_FIRST) return mix(3.1, 2.3, ease(b / GLIDE_FIRST))
  if (b < GLIDE_MIDDLE) return mix(2.3, 1.75, ease((b - GLIDE_FIRST) / (GLIDE_MIDDLE - GLIDE_FIRST)))
  return mix(1.75, GLYPH_WIDE, ease((b - GLIDE_MIDDLE) / (GLIDE_LAST - GLIDE_MIDDLE)))
}

const BEAT_SECONDS = 11.2 / 24
const DRIFT_KEEP = 6
const DRIFT_FIELD = 11
/** the clock the camera's slow drift and roll run on: round 17's to the plan's lock, round 17's shifted by the added beats from the field on, and slower between, so the routes, the plan and the field drift as they did */
export const driftSeconds = (frame: number, fps: number): number => {
  const b = frame / fps / BEAT_SECONDS
  const late = DRIFT_FIELD + GLYPH_ADDED_BEATS
  const t = b <= DRIFT_KEEP ? b : b >= late ? b - GLYPH_ADDED_BEATS : DRIFT_KEEP + ((b - DRIFT_KEEP) * (DRIFT_FIELD - DRIFT_KEEP)) / (late - DRIFT_KEEP)
  return t * BEAT_SECONDS
}

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
  events: GlyphEvent[]
  pulls: Array<[number, number]>
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
  /** the steps its decode-in and decode-out begin, in its own act's time before the loop wraps them */
  in: number
  out: number
  /** lattice positions of every copy, for growth distances */
  sites: Vec2[]
  lag: number
  at?: number | undefined
  life?: number | undefined
  land?: number | undefined
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
  const steps = Math.round((durationSeconds * 15 * LOOP_BEATS) / GLYPH_FILM_BEATS)
  const film = Math.round(durationSeconds * resolved.fps)
  const at = (b: number): number => Math.round((b * steps) / LOOP_BEATS)

  // every act is the board: its hero's routes, its plan, then the field, fitted to the frame at the camera's widest with the name below it
  const hero = heroPart(board, resolved.hero ?? resolved.cast?.hero, resolved.cast)
  const chip = hero === undefined ? undefined : heroChip(board, hero.ref, hero.rot)
  const heroPkg = chip ?? bench.find((g) => g.kind === 'package')
  // the field is fitted to the frame at the camera's scale on its lock, where the camera centres it with the name
  const drawn = safeArea(resolved.width, resolved.height, false)
  const drawnStage = 0.5 * Math.min(drawn.w, drawn.h)
  const lockStep = at((SCORE[FIELD_ACT] as ActTiming).grow[1]) - at(OPEN_BEAT)
  const atLock = glide((Math.round((lockStep * resolved.fps) / 15) - LAND_EARLY) / Math.round((steps * resolved.fps) / 15))
  const pitchPx = PITCH * drawnStage * atLock
  const lattice = (px: number, extent: number, centre: number, zoom = 1): number => ((px - extent / 2) / (atLock * zoom) + extent / 2 - centre) / (PITCH * drawnStage)
  const fieldBox: Box = {
    x0: lattice(FIELD_MARGIN * resolved.width, resolved.width, drawn.x + drawn.w / 2),
    x1: lattice((1 - FIELD_MARGIN) * resolved.width, resolved.width, drawn.x + drawn.w / 2),
    y0: lattice(FIELD_MARGIN * resolved.height, resolved.height, drawn.y + drawn.h / 2),
    y1: lattice((1 - FIELD_MARGIN) * resolved.height, resolved.height, drawn.y + drawn.h / 2)
  }
  const whole = fieldFit(board, fieldBox)
  const chipTurn = hero === undefined ? 0 : (-hero.rot * Math.PI) / 180 + (whole.turn ? Math.PI / 2 : 0)
  const phoneInk = Math.max(1, (PHONE_INK * resolved.width) / PHONE_WIDTH / ((GLYPH_INK * Math.min(resolved.width, resolved.height)) / 1080))
  const loop = Math.round((steps * resolved.fps) / 15)
  const plan = SCORE[1] as ActTiming
  const planFrame = (step: number): number => Math.round(((step - at(OPEN_BEAT)) * resolved.fps) / 15)
  const planWidest = Math.min(glide(planFrame(at(plan.grow[0])) / loop), glide((planFrame(at(plan.grow[1]) + DECODE_IN_STEPS) - LAND_EARLY) / loop))
  const planGap = (PLAN_GAP_WEIGHTS * GLYPH_INK_SCALE * GLYPH_INK * Math.min(resolved.width, resolved.height) * phoneInk) / 1080 / (PITCH * drawnStage * planWidest)
  const view = (i: number): { nx: number; ny: number } => {
    const s = glide((planFrame(at((SCORE[i] as ActTiming).grow[1]) + DECODE_IN_STEPS) - LAND_EARLY) / loop)
    return { nx: resolved.width / 2 / (drawnStage * s * PITCH), ny: resolved.height / 2 / (drawnStage * s * PITCH) }
  }
  const diagonal = diagonalAct({ board, hero, heroGlyph: heroPkg, chipTurn, view: view(2), id: 'diagonal' })
  const acts: ActPlan[] = [
    routeAct(board, room, hero, heroPkg, chip === undefined ? 0 : chipTurn),
    planAct(board, room, hero, chipTurn, planGap),
    diagonal,
    clusterAct({ board, hero, heroGlyph: heroPkg, chipTurn, view: view(3), id: 'cluster', skip: new Set(diagonal.cells.flatMap((c) => (c.group === undefined ? [] : [c.group]))) }),
    fieldAct(board, fieldBox, hero, (DECODE_IN_STEPS * LOOP_BEATS) / steps, whole.turn)
  ]
  const field = acts[FIELD_ACT] as ActPlan
  const span = (cells: Cell[]): Box => ({ x0: Math.min(...cells.map((c) => c.x)), x1: Math.max(...cells.map((c) => c.x)), y0: Math.min(...cells.map((c) => c.y)), y1: Math.max(...cells.map((c) => c.y)) })
  const extent = span(field.cells)
  const pads = field.cells.filter((c) => c.role === 'hero')
  const reach = Math.max(0, ...pads.map((c) => ((c.size ?? 0) * (cellGlyph('dot').strokes.flat().reduce((m, q) => Math.max(m, Math.abs(q.x), Math.abs(q.y)), 0)))))
  const chipBox = pads.length === 0 ? undefined : ((b: Box): Box => ({ x0: b.x0 - reach, x1: b.x1 + reach, y0: b.y0 - reach, y1: b.y1 + reach }))(span(pads))
  acts.push(nameAct({ board, name: boardTitle(board, resolved).name, ending: resolved.ending, pitchPx, width: resolved.width, height: resolved.height, centre: field.cells.length === 0 ? { x: 0, y: 0 } : { x: (extent.x0 + extent.x1) / 2, y: (extent.y0 + extent.y1) / 2 }, chip: chipBox }))

  const glyphs = new Map<string, Glyph>()
  for (const g of [...bench, ...acts.flatMap((a) => a.glyphs ?? [])]) glyphs.set(g.id, g)
  if (heroPkg !== undefined) glyphs.set(heroPkg.id, heroPkg)
  for (const k of CELL_KINDS) glyphs.set(cellId(k), cellGlyph(k))

  const units: Unit[] = []
  for (const [ai, act] of acts.entries()) {
    const rng = makeRng(seed, `cells:${ai}`)
    const cells = [...act.cells]
    const far = act.id === 'field' ? Math.max(1e-9, ...cells.map((c) => c.at ?? 0)) : 0
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
        in: 0,
        out: 0,
        lag: cell.lag ?? 1,
        at: cell.at,
        life: cell.life,
        land: cell.land,
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
          ...(PHONE_INK_ACTS.has(act.id) || cell.weight !== undefined ? { weight: (cell.weight ?? 1) * (PHONE_INK_ACTS.has(act.id) ? phoneInk : 1) } : {}),
          ...(cell.flare === undefined ? {} : { flare: cell.flare }),
          ...(far > 0 && cell.at !== undefined ? { reach: cell.at / far } : {}),
          ...(cell.link === undefined ? {} : { link: cell.link }),
          ...(cell.group === undefined ? {} : { group: cell.group }),
          ...(cell.stage === undefined ? {} : { stage: cell.stage }),
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
    const staged = mine.every((u) => u.land !== undefined)
    for (const u of staged ? mine : []) u.in = g0 + Math.max(0, Math.round(((u.land ?? 0) * steps) / LOOP_BEATS) - DECODE_IN_STEPS)
    const timed = mine.every((u) => u.at !== undefined)
    const last = Math.max(1e-9, ...mine.map((u) => u.at ?? 0))
    const grow = staged ? [] : timed ? mine.map((u) => (u.at ?? 0) / last) : paced(growthDistances(mine, act.seeds))
    const opening = [...grow].sort((a, b) => a - b)[Math.floor(FIRST_PULSE_SHARE * (grow.length - 1))] ?? 0
    const fast = g1 - g0 < 2 * DECODE_IN_STEPS
    for (const [i, u] of mine.entries()) {
      if (staged) break
      const frac = grow[i] as number
      if (fast) {
        u.placement.pattern = FULL_FIRST_PATTERNS[i % FULL_FIRST_PATTERNS.length] as number
        u.placement.steady = true
      }
      if (fast && frac <= opening) {
        u.in = g0
        continue
      }
      if (timed) {
        u.in = g0 + Math.round((g1 - g0) * frac)
        continue
      }
      const jitter = Math.round(((g1 - g0) * frac) / 2) > 0 && frac < 1 ? rng.int(0, 2) : 0
      u.in = g0 + 2 * Math.round(((g1 - g0) * frac) / 2) + jitter
    }
    // strip toward the next act's seeds: the far side goes first, the cells
    // nearest the next seeds hold on as residue
    // before an act built out from its seeds, the marks nearest those seeds go first, just ahead of its front
    const next = acts[(ai + 1) % acts.length] as ActPlan
    const outward = next.cells.every((c) => c.land !== undefined)
    const toward = outward ? next.seeds : act.stripTo ?? next.seeds
    const s0 = at(t.strip[0])
    const s1 = at(t.strip[1])
    const strip = paced(mine.map((u) => (outward ? 1 : -1) * Math.min(...u.sites.flatMap((p) => toward.map((q) => Math.hypot(p.x - q.x, p.y - q.y))))))
    for (const [i, u] of mine.entries()) {
      u.out = s0 + Math.round((s1 - s0) * (strip[i] as number)) + (s1 > s0 ? rng.int(0, 2) : 0)
      // a brief mark leaves right after it lands
      if (u.life !== undefined) u.out = u.in + DECODE_IN_STEPS + u.life
    }
  }

  // no formation is drawn over another: a mark has decoded out before the next act writes one in beside it, and the main chip before the next act writes its chip, wherever that stands.
  // A mark the next act writes again, the same glyph in the same place at the same size (the main chip), hands over to it and never goes dark
  const clear = GLYPH_CLEAR / PITCH
  const cellKey = (x: number, y: number, a: number): string => `${a}:${Math.floor(x / clear)},${Math.floor(y / clear)}`
  const index = new Map<string, number[]>()
  units.forEach((v, i) => {
    for (const q of v.sites) {
      const key = cellKey(q.x, q.y, v.act)
      const list = index.get(key) ?? []
      if (list[list.length - 1] !== i) list.push(i)
      index.set(key, list)
    }
  })
  const beside = (u: Unit, act: number): Unit[] => {
    const found = new Set<number>()
    for (const p of u.sites) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of index.get(cellKey(p.x + dx * clear, p.y + dy * clear, act)) ?? []) found.add(i)
    return [...found].sort((a, b) => a - b).map((i) => units[i] as Unit).filter((v) => v.sites.some((q) => u.sites.some((p) => Math.hypot(p.x - q.x, p.y - q.y) <= clear)))
  }
  for (const u of units) {
    const next = (u.act + 1) % acts.length
    const lap = next > u.act ? 0 : steps
    const near = u.placement.role === 'hero'
      ? [...new Set([...beside(u, next), ...units.filter((v) => v.act === next && v.placement.role === 'hero')])]
      : beside(u, next)
    const again = u.placement.role === 'hero' ? near.find((v) => v.placement.glyphId === u.placement.glyphId && JSON.stringify(v.placement.atoms) === JSON.stringify(u.placement.atoms)) : undefined
    u.out = again === undefined
      ? Math.max(u.in + DECODE_IN_STEPS, Math.min(u.out, Math.min(...near.map((v) => v.in + lap)) - DECODE_OUT_STEPS))
      : again.in + lap + DECODE_IN_STEPS
    if (acts[next]?.cells.every((c) => c.land !== undefined) === true && next !== u.act) u.out = Math.max(u.in + DECODE_IN_STEPS, Math.min(...units.filter((v) => v.act === next).map((v) => v.in + lap)) - Math.round((GLYPH_CUT_EARLY * 15) / resolved.fps))
    u.placement.inStep = mod(u.in, steps)
    u.placement.outStep = mod(u.out, steps)
  }

  const NAME_ACT = acts.length - 1
  if (resolved.ending === 'routes') {
    for (const u of units.filter((v) => v.act === FIELD_ACT && v.placement.role === 'hero')) {
      u.out = at((SCORE[NAME_ACT] as ActTiming).strip[0])
      u.placement.outStep = mod(u.out, steps)
    }
  }

  // the push into the act before the staged one ends on its main chip alone: the parts of the chip's size its last frame would show write out first
  for (const [ai] of acts.entries()) {
    const next = (ai + 1) % acts.length
    if (!(acts[next]?.cells.every((c) => c.land !== undefined) ?? false)) continue
    const span = (u: Unit): [number, number] => {
      const pts = glyphs.get(u.placement.glyphId)?.strokes.flat() ?? []
      const k = u.placement.atoms[0]?.scale ?? 0
      const r = u.placement.atoms[0]?.rot ?? 0
      const w = pts.length === 0 ? 0 : (Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x))) * k
      const h = pts.length === 0 ? 0 : (Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y))) * k
      return [Math.abs(Math.cos(r)) * w + Math.abs(Math.sin(r)) * h, Math.abs(Math.sin(r)) * w + Math.abs(Math.cos(r)) * h]
    }
    const chip = units.find((u) => u.act === ai && u.placement.role === 'hero')
    const centre = chip?.placement.atoms[0]
    if (chip === undefined || centre === undefined) continue
    const [cw, ch] = span(chip)
    const hw = cw / (2 * GLYPH_CHIP_SHARE)
    const hh = (hw * resolved.height) / resolved.width
    const cut = Math.min(...units.filter((v) => v.act === next).map((v) => v.in + (next > ai ? 0 : steps))) - Math.round((GLYPH_CUT_EARLY * 15) / resolved.fps)
    for (const u of units.filter((v) => v.act === ai && v !== chip)) {
      const [w, h] = span(u)
      if (Math.max(w, h) < CHIP_LIKE * Math.max(cw, ch)) continue
      if (!u.placement.atoms.some((a) => Math.abs(a.x - centre.x) < hw + w / 2 && Math.abs(a.y - centre.y) < hh + h / 2)) continue
      u.out = Math.max(u.in + DECODE_IN_STEPS, Math.min(u.out, cut - CHIP_CLEAR_STEPS))
      u.placement.outStep = mod(u.out, steps)
    }
  }

  // the staged act's first point appears on the cut into it, where the camera has just closed on the chip
  for (const [ai, act] of acts.entries()) {
    if (!act.cells.every((c) => c.land !== undefined)) continue
    const t = SCORE[ai] as ActTiming
    const atoms = act.seeds.map((p) => ({ x: p.x * PITCH, y: p.y * PITCH, rot: 0, scale: 0.8 * PITCH }))
    const point = at(t.grow[0]) - Math.round((GLYPH_CUT_EARLY * 15) / resolved.fps)
    units.push({
      act: ai,
      in: point,
      out: at(t.grow[0]) + 3,
      lag: 1,
      sites: act.seeds,
      placement: {
        glyphId: cellId('dot'),
        atoms,
        tones: atoms.map(() => 0.9),
        role: 'punct',
        inStep: mod(point, steps),
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
    const h0 = at(t.breath ?? t.grow[1]) + 6
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

  const frameOf = (step: number): number => Math.round((step * resolved.fps) / 15)
  const writes = acts.map((act, i) => ({ id: act.id, at: frameOf(mod(at((SCORE[i] as ActTiming).grow[0]) - shift, steps)) }))
  const lettered = [...new Set(units.filter((u) => u.act === NAME_ACT).map((u) => u.placement.group as string))]
  const letters = lettered.map((g) => ({ at: frameOf(Math.min(...units.filter((u) => u.act === NAME_ACT && u.placement.group === g).map((u) => mod(u.in - shift, steps)))), kind: 'letter' as const })).filter((e, i, all) => all.findIndex((o) => o.at === e.at) === i)
  const named = [{ at: frameOf(mod(Math.max(...units.filter((u) => u.act === NAME_ACT).map((u) => u.in)) + DECODE_IN_STEPS - shift, steps)), kind: 'name' as const }]
  const sounded = [...writes.map((w) => w.at), ...named.map((e) => e.at)]
  // a staged act locks when its last marks land; the others when their growth ends
  const landing = (i: number): number | undefined => {
    const mine = units.filter((u) => u.act === i && u.land !== undefined && u.placement.role !== 'text')
    return mine.length === 0 ? undefined : Math.max(...mine.map((u) => u.in)) + DECODE_IN_STEPS
  }
  const locks = acts.map((_, i) => {
    const landed = landing(i)
    return landed === undefined
      ? frameOf(mod(at((SCORE[i] as ActTiming).grow[1]) - shift, steps) + DECODE_IN_STEPS)
      : frameOf(mod(landed - shift, steps))
  })
  const total = frameOf(steps)
  const snaps = (a: number, b: number): boolean => glide(a / total) / glide((b - LAND_EARLY) / total) - 1 > PULL_SMALL
  const pulls = writes.filter((w) => w.id !== 'name').map((w, i): [number, number] => [w.at, Math.min(locks[i] as number, film - PULL_CLEAR)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]).map(([a, b], i, all): [number, number] => [Math.max(snaps(a, b) ? Math.min(a, b - PULL_LEAST) : a, all[i - 1]?.[1] ?? 0), b])
  const events = ([
    { at: 0, kind: 'open' },
    ...writes.map((w) => ({ at: w.at, kind: 'form' as const })),
    ...locks.map((f) => ({ at: f, kind: 'lock' as const }))
      
      .filter((e) => e.at < film && sounded.every((f) => Math.abs(f - e.at) > LOCK_CLEAR * resolved.fps)),
    ...named,
    ...letters,
    { at: writes.find((w) => w.id === 'field')?.at ?? 0, kind: 'turn' },
    ...[...new Set(placements.flatMap((p) => (p.stage === undefined ? [] : [p.stage])))].sort((a, b) => a - b)
      .map((stage) => ({ at: frameOf(Math.min(...placements.filter((p) => p.stage === stage).map((p) => p.inStep))), kind: 'stage' as const, stage })),
    ...(placements.some((p) => p.stage !== undefined) ? [{ at: (locks[FIELD_ACT] as number) + Math.round(frameOf(steps) / LOOP_BEATS), kind: 'button' as const }] : [])
  ] satisfies GlyphEvent[]).filter((e) => e.at < film).sort((a, b) => a.at - b.at)

  const used = new Set(placements.map((p) => p.glyphId))
  return {
    cast: [...glyphs.values()].filter((g) => used.has(g.id)),
    placements,
    formations,
    events,
    pulls,
    steps,
    cadence: resolved.cadence,
    warnings
  }
}
