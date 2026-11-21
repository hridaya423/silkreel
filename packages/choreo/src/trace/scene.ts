import type { BBox, BoardModel, DrillHit, Pad, Vec2 } from '@silk-reel/ingest'
import { fitBoard, safeArea } from '../layout'
import { boardTitle, revisionLabel } from '../board-title'
import type { ResolvedConfig } from '../config'
import type {
  CameraKey, CameraShot, FlatPath, TraceActs, TraceBeats, TraceGroup, TraceLayer, TraceMaterial, TraceSign,
  PartBodies, PartMesh, TitleBuild, TracePad, TracePart, TraceScene, TraceText, TraceVia, TraceZone, TimelineWarning
} from '../types'
import { makeCam, pinReach, project, sampleShot } from './camera'
import type { Body, Cam } from './camera'
import { FACT_SEP } from './lockup'
import { growthSchedule } from './graph'
import { boardCharacter, groundFor } from './archetype'
import type { GraphLink, GraphSeg, GraphSeed } from './graph'
import { DEMO_MASKS } from '../hints'
import { classify } from '../cells'
import { pickHero } from './hero'
import { clearPlot, entryOf, powerPath } from './plot-shots'
import { groupNets } from './nets'
import { chaseLight, cineShots, stageCuts } from './shots'
import { extractParts } from './parts'
import { boardFacts } from './facts'
import type { BoardFacts } from './facts'
import type { PartMm } from './parts'
import type { NetKind } from './nets'

const B = 1 / 24

/** silk lines of one text sit this many text heights apart */
export const SILK_LEAD = 1.6

/**
 * The score, on a grid of 24 beats, in four shots. Drawing: copper routes
 * out of the hero as hot lines, and the pours flood near beat 4. Object: the
 * mask floods the board on beats 5–7, the silk prints on beat 7, parts land on
 * the half-beats and the hero seats on beat 12. A held breath. Alive: first
 * power-on from the real power entry; the rails fill, the hero wakes, its
 * lines run. Hold: the whole running board, once.
 */
export const TRACE_ACTS: TraceActs = {
  draw: [0, 5 * B],
  pour: [3.5 * B, 3.5 * B + (14 / 15) * B],
  mask: [5 * B, 8 * B],
  silk: [8 * B, 8.5 * B],
  place: [8.5 * B, 11 * B],
  reflow: [11 * B, 12 * B],
  power: [12 * B, 21 * B],
  hold: [21 * B, 24 * B]
}

/** the flat fallback renderer still reads beats; they follow the acts */
const TRACE_BEATS: TraceBeats = {
  outline: [0, B],
  pads: [0, B],
  growth: TRACE_ACTS.draw,
  zones: TRACE_ACTS.pour,
  silk: TRACE_ACTS.silk,
  // the title lands half a beat after the crane settles on the whole board; the film ends on that held frame
  hold: [21 * B, 1]
}

/**
 * The power-on's dim, in film phase: from the cut at 7.0 s (power[0]) the key falls to a quarter over 18 frames;
 * rim and fill hold. The supply pin lights at beat 15 (7.5 s) and the wave reaches the board's edge by beat 19.
 */
export const POWER_DIM: [number, number] = [12 * B, 12 * B + 18 / 360]
const WAVE_LEAVE = B
/** a board this many times longer than it is wide gets the long poster: broadside, large across the frame, the name below */
const LONG_BOARD = 2.2
/** a lit line stays dark when more than this share of it runs within one line-width of lit lines already kept (longest first), so the light reads as lines on a phone */
const LIT_CROWD = 0.3
/** in the routes ending an LED is a small true point: its glow, against the hero's */
const ROUTE_LED = 0.4
/** the supply's light enters this long after the cut into the power-on take */
const IN_LEAD = 2 / 360
/** the main chip wakes as the ride arrives on it, on beat 15; the light reaches the board's far copper as the pull back shows it whole */
const WAKE = 15 * B
const REACH_EDGE = 19 * B
/** copper this far from the ride's course, on a supply net or a power net, lights as the ride's front passes it */
const RIDE_SIDE = 8
/** the trace film's coat runs at least this many beats, so its colour arrives across the frame rather than being cut to */
const COAT_BEATS = 2
/** any other copper this close to the course lights with it, so the ride always runs on light */
const RIDE_LANE = 5
const OPEN_HOLD = 0.75 * B
/** the most the opening hold grows on a board that is mostly routing (track length per part 24 mm or more) */
const DRAW_HOLD = 2.25 * B
/** how much of the short side an opening chip's pads fill on the first frame */
const OPEN_FILL = 1.1
/** a plug opens wider: its few pads with the copper that leaves them */
const PLUG_FILL = 0.7
/** a pad this many mm across on its short side is flat copper to the opening frame (a thermal pad, a plane), not detail */
const OPEN_BIG_PAD = 2
/** a part coming in from the frame's edge starts no larger than this share of the frame; a part that would fill more starts lower, and one that fills more at rest drops a quarter of its height */
const ENTRY_COVER = 0.3
/** a falling part's first visible frame shows at most this share of it: it crosses an edge, it does not appear */
export const ENTRY_SLIVER = 0.5
/** NDC beyond the frame edge a falling part starts, so a handheld sway never shows it early */
const ENTRY_MARGIN = 0.02
/** board-plane directions tried for a falling part's way in */
const ENTRY_DIRS = 16
/** how much a way in that travels up the screen costs over one that falls down it */
const ENTRY_UP = 2

/**
 * How long a part takes to come down onto its pads, as a share of the film: small parts in five and a half
 * frames, large ones in nine and a half, the hero in eleven and a half. Every landing is on a whole frame,
 * so a descent starts half a frame after one, between two shutters, and no part is caught half-present.
 */
/** when the first LED wakes in the LED power-on */
const WAKE_FIRST = 14 * B
/** the first lamp of the lamps power-on: half a beat after the cut into it */
const LAMP_FIRST = 12.5 * B
const LAMP_OUT = 12 / 360
export const DESCENT = { small: 6 / 360, large: 10 / 360, heavy: 15 / 360, hero: 11.5 / 360 }
/** a chip whose long side is this share of the hero's or more gets its own landing, a beat before the hero's */
const SECOND_CHIP = 0.6
/** a connector this many times the hero's long side and 2.5 mm tall or more lands with weight, after the crowd */
const HEAVY_CONN = 1.5
/** a family of the same part (kind, value, footprint) lands as one sweep when three or more sit within this many of their own lengths of each other */
const ROW_LINK = 3
/** the longest sweep of a row, frames */
const ROW_SWEEP = 10
/** the passives land after the big parts, in rows of this many that ripple out from the hero */
export const RIPPLE_ROW = 12
/** frames between landings within one ripple row */
export const RIPPLE_STEP = 0.25
/** frames over which the parts bigger than a passive land, biggest first and furthest apart */
const BIG_RUN = 16
export const WIDE_BOARD = 0.64
/** the least share of a wide frame's width the board takes in the end frame */
export const WIDE_BOARD_W = 0.55

const SIGN_AT = 16 * B

/**
 * The middle of the film answers the board. Part count sets the cut into the place shot: 40 parts or fewer cut
 * on beat 9 (a short place act), 160 or more on beat 7 (a long one). Track length per part sets where the drawing
 * ends: 6 mm or less on beat 5, 24 mm or more on beat 7, never closer than a beat to that cut. The coat takes what
 * is left between them.
 */
export function actsFor(routing: number, parts: number, coat = B): TraceActs {
  const dense = Math.min(1, Math.max(0, Math.log(routing / 6) / Math.log(4)))
  const crowd = Math.min(1, Math.max(0, Math.log(parts / 40) / Math.log(4)))
  const cut = (9 - Math.round(2 * crowd)) * B
  const drawn = Math.min(cut - coat, Math.max(5 * B, (Math.round(2 * (5 + 2 * dense)) / 2) * B))
  return { ...TRACE_ACTS, draw: [0, drawn], pour: [drawn - 1.5 * B, drawn - 1.5 * B + (14 / 15) * B], mask: [drawn, cut], silk: [cut, cut + 0.5 * B], place: [cut + 0.5 * B, 11 * B] }
}

export const MASK_ALBEDO: Record<string, string> = {
  green: '#0d3b22', black: '#0c0d0e', white: '#d8dbd4', blue: '#0f2a5c', red: '#5c1015',
  yellow: '#b79a16', purple: '#3a1a55', matte: '#121314'
}
const FINISH: Record<string, { albedo: string; rough: number }> = {
  enig: { albedo: '#dcc38a', rough: 0.18 },
  'enepig': { albedo: '#e3bb6c', rough: 0.18 },
  hal: { albedo: '#d4d8dc', rough: 0.34 },
  'immersion silver': { albedo: '#dfe3e6', rough: 0.2 },
  'immersion tin': { albedo: '#c9cdd1', rough: 0.3 }
}

const DEG = Math.PI / 180
const SIDE_ORDER = { inner: 0, B: 1, F: 2 } as const

type Side = 'F' | 'B' | 'inner'

const sideOf = (layerId: string): Side =>
  layerId.startsWith('F.') ? 'F' : layerId.startsWith('B.') ? 'B' : 'inner'

const flat = (pts: Vec2[], map: (p: Vec2) => Vec2): FlatPath => {
  const out: number[] = []
  for (const p of pts) {
    const m = map(p)
    out.push(m.x, m.y)
  }
  return out
}

/** a roundrect with a corner radius under this share of its shorter side is drawn square: an exposed pad, not a rounded land */
const SQUARE_CORNER = 0.1

const padShape = (pad: Pad, squareCorners: boolean): TracePad['shape'] => {
  const w = pad.size.x
  const h = pad.size.y
  if (pad.shape === 'circle' || (pad.shape === 'oval' && Math.abs(w - h) < 0.01 * Math.max(w, h))) return 'circle'
  if (squareCorners && pad.shape === 'roundrect' && pad.rratio !== undefined && pad.rratio < SQUARE_CORNER) return 'rect'
  if (pad.shape === 'roundrect' || pad.shape === 'oval') return 'round'
  return 'rect'
}

/**
 * what reads as the board: its outline plus copper and part bodies hanging
 * past it (edge connectors). board.bbox also counts silk text and footprint
 * origins floating off the edge, which shrank long thin boards by ~30%
 */
function contentBox(board: BoardModel): BBox {
  const pts = board.outline.flatMap((path) => path.points)
  if (pts.length < 2) return board.bbox
  const min = { x: Infinity, y: Infinity }
  const max = { x: -Infinity, y: -Infinity }
  const add = (x: number, y: number, r = 0): void => {
    min.x = Math.min(min.x, x - r)
    min.y = Math.min(min.y, y - r)
    max.x = Math.max(max.x, x + r)
    max.y = Math.max(max.y, y + r)
  }
  for (const p of pts) add(p.x, p.y)
  for (const copper of Object.values(board.copper)) {
    for (const pad of copper.pads) add(pad.pos.x, pad.pos.y, Math.max(pad.size.x, pad.size.y) / 2)
    for (const trace of copper.traces) for (const p of trace.points) add(p.x, p.y)
    for (const via of copper.vias) add(via.pos.x, via.pos.y, via.dia / 2)
  }
  // footprint silk is the part's body (a connector overhanging the edge);
  // free silk and text off the edge is annotation
  const owned = new Set(board.footprints.flatMap((fp) => [...fp.silkRefs]))
  for (const silk of Object.values(board.silkscreen)) {
    for (const line of silk.lines) if (owned.has(line.id)) for (const p of line.points) add(p.x, p.y)
  }
  return { min, max }
}

export function buildTraceScene(board: BoardModel, resolved: ResolvedConfig, seed: number, bodies?: PartBodies, readSilk = true): { scene: TraceScene; warnings: TimelineWarning[] } {
  const box = contentBox(board)
  const fit = fitBoard(box, resolved.width, resolved.height, resolved.title !== undefined && resolved.style !== 'plot', resolved.style === 'plot')
  const hero = pickHero(board, resolved.cast, resolved.hero)
  const originMm = hero?.center ?? {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2
  }
  // a hero on the back copper means the film is shot from the back: mirror
  // the board and swap its sides, so the back reads as the face
  const back = hero?.back === true
  const mirrorX = box.min.x + box.max.x
  const map = back ? (p: Vec2): Vec2 => fit.map({ x: mirrorX - p.x, y: p.y }) : fit.map
  const rotOf = (deg: number): number => (back ? deg : -deg) * DEG + (fit.rotated ? Math.PI / 2 : 0)
  const sideAt = (layerId: string): Side => {
    const s = sideOf(layerId)
    return back ? (s === 'F' ? 'B' : s === 'B' ? 'F' : s) : s
  }

  const segs: GraphSeg[] = []
  const segLen: number[] = []
  const segNet: Array<number | undefined> = []
  const links: GraphLink[] = []
  const linkVia = new Map<string, number>()
  const padLayerSets = new Map<string, { pad: Pad; sides: Set<Side> }>()
  const copperEntries = Object.entries(board.copper)
  for (const [layerId, copper] of copperEntries) {
    for (const trace of copper.traces) {
      for (let i = 0; i + 1 < trace.points.length; i++) {
        const a = trace.points[i] as Vec2
        const b = trace.points[i + 1] as Vec2
        segs.push({ layer: layerId, a, b, width: trace.width })
        segLen.push(Math.hypot(b.x - a.x, b.y - a.y))
        segNet.push(trace.netId)
      }
    }
    for (const via of copper.vias) {
      if (linkVia.has(via.id)) continue
      linkVia.set(via.id, links.length)
      links.push({ pos: via.pos, r: Math.max(0.05, via.dia / 2) })
    }
    for (const pad of copper.pads) {
      const rec = padLayerSets.get(pad.id)
      if (rec !== undefined) rec.sides.add(sideAt(layerId))
      else padLayerSets.set(pad.id, { pad, sides: new Set([sideAt(layerId)]) })
    }
  }
  // through-hole pads bridge every copper layer they touch
  for (const { pad, sides } of padLayerSets.values()) {
    if (sides.size >= 2) links.push({ pos: pad.pos, r: Math.max(pad.size.x, pad.size.y) / 2 })
  }

  const seeds: GraphSeed[] = (hero?.pads ?? []).map((p) => ({ layer: p.layer, pos: p.pos }))
  const g = growthSchedule(segs, links, seeds, originMm)
  const opener = openingPart(board, segs, segLen, hero?.ref, back ? 'B.Cu' : 'F.Cu')
  const gD = opener === undefined ? g : growthSchedule(segs, links, opener.seeds, opener.at)
  const mdD = Math.max(1e-9, gD.maxDist)

  const { groups: netGroups, groupOf } = groupNets(board.nets)
  const segGroup = segNet.map((n) => (n === undefined ? -1 : (groupOf.get(n) ?? -1)))
  const isPower = (net: number | undefined): boolean => net !== undefined && netGroups[groupOf.get(net) ?? -1]?.kind === 'power'
  const entry = powerEntry(board, isPower)
  const heroGroups = new Set<number>()
  for (const copper of Object.values(board.copper)) {
    for (const pad of copper.pads) if (pad.footprintRef === hero?.ref && pad.netId !== undefined) heroGroups.add(groupOf.get(pad.netId) ?? -1)
  }
  const heroReach = Math.max(0.5, ...(hero?.pads ?? []).map((hp) => Math.hypot(hp.pos.x - originMm.x, hp.pos.y - originMm.y)))
  const plug = resolved.power === 'routes' && hero !== undefined ? entryOf(board, undefined) : undefined
  const inPath = plug === undefined || plug.ref === hero?.ref ? undefined : powerPath(board, plug, hero?.ref, back ? 'B.Cu' : 'F.Cu')
  const inLen = (inPath?.steps ?? []).reduce((sum, st) => sum + Math.hypot(st.b.x - st.a.x, st.b.y - st.a.y), 0)
  const inFrom = TRACE_ACTS.power[0] + IN_LEAD
  const wakeAt = resolved.power === 'routes' ? WAKE : undefined
  const inSpan = inLen > 0 ? WAKE - inFrom : 0
  const sched = scheduleEnergy(netGroups.map((ng) => ng.kind), segLen, segNet, segGroup, g.start, heroGroups, heroReach, resolved.power === 'pulse' ? 16 * B : resolved.power === 'routes' ? REACH_EDGE : 19 * B, wakeAt)
  if (inPath !== undefined && inLen > 0) {
    let run = 0
    const along = new Map<string, number>()
    for (const st of inPath.steps) {
      const len = Math.hypot(st.b.x - st.a.x, st.b.y - st.a.y)
      if (st.kind === 'trace') {
        along.set(`${st.layer}:${Math.round(st.a.x * 100)}:${Math.round(st.a.y * 100)}:${Math.round(st.b.x * 100)}:${Math.round(st.b.y * 100)}`, run)
        along.set(`${st.layer}:${Math.round(st.b.x * 100)}:${Math.round(st.b.y * 100)}:${Math.round(st.a.x * 100)}:${Math.round(st.a.y * 100)}`, -(run + len))
      }
      run += len
    }
    const at = (d: number): number => inFrom + (inSpan * d) / inLen
    segs.forEach((sg, i) => {
      const d = along.get(`${sg.layer}:${Math.round(sg.a.x * 100)}:${Math.round(sg.a.y * 100)}:${Math.round(sg.b.x * 100)}:${Math.round(sg.b.y * 100)}`)
      if (d === undefined) return
      const len = segLen[i] as number
      const ab: [number, number] = d >= 0 ? [at(d), at(d + len)] : [at(-d), at(-d - len)]
      sched.segTime[i] = g.flipped[i] === true ? [ab[1], ab[0]] : ab
      const grp = sched.groups[segGroup[i] as number]
      if (grp !== undefined) Object.assign(grp, { hero: true, t: grp.t < 0 ? Math.min(...ab) : Math.min(grp.t, ...ab) })
    })
  }
  const everyPart = extractParts(board)
  const allParts = everyPart.filter((pt) => pt.back === back)
  const kindOf = new Map(everyPart.map((pt) => [pt.ref, pt.kind]))
  const routing = segLen.reduce((a, v) => a + v, 0) / Math.max(1, board.footprints.length)
  const acts = resolved.style === 'plot' ? TRACE_ACTS : actsFor(routing, allParts.length, resolved.style === 'trace' ? COAT_BEATS * B : B)
  const beats: TraceBeats = resolved.style === 'plot' ? { ...TRACE_BEATS, hold: [20.5 * B, 1] } : { ...TRACE_BEATS, growth: acts.draw, zones: acts.pour, silk: acts.silk }
  const dense = Math.min(1, Math.max(0, Math.log(routing / 6) / Math.log(4)))
  const heroMm = allParts.find((pt) => pt.ref === hero?.ref)
  const ledSign = heroMm !== undefined && heroMm.kind !== 'valve' && allParts.some((pt) => pt.kind === 'led')
  const signRoute = ledSign || hero === undefined || kindOf.get(hero.ref) === 'valve' ? undefined : routeSign(board, hero.ref, originMm, kindOf, (n) => netGroups[groupOf.get(n) ?? -1]?.kind)
  if (signRoute !== undefined) {
    const chosen = new Set(signRoute.nets)
    const own = segs.map((_, i) => i).filter((i) => chosen.has(segNet[i] as number))
    const lo = Math.min(...own.map((i) => g.start[i] as number))
    const hi = Math.max(...own.map((i) => (g.start[i] as number) + (segLen[i] as number)))
    const at = (d: number): number => SIGN_AT - 0.1 * B + ((d - lo) / Math.max(1e-9, hi - lo)) * 0.5 * B
    for (const i of own) sched.segTime[i] = [at(g.start[i] as number), at((g.start[i] as number) + (segLen[i] as number))]
  }

  // the routing: a wavefront out of the hero's pins, sparse while the lens is close on the hero, most of the work once it pulls up to watch
  const [d0, d1] = acts.draw
  const openAtMm = opener?.at ?? originMm
  const reachOf = segs.map((sg, i) => Math.min(gD.start[i] as number, 1.25 * Math.hypot((sg.a.x + sg.b.x) / 2 - openAtMm.x, (sg.a.y + sg.b.y) / 2 - openAtMm.y)))
  const byStart = segs.map((_, i) => i).sort((a, b) => (reachOf[a] as number) - (reachOf[b] as number))
  const totalLen = Math.max(1e-9, segLen.reduce((x, v) => x + v, 0))
  let before = 0
  const rank = new Map(byStart.map((segIdx) => {
    const r = before / totalLen
    before += segLen[segIdx] as number
    return [segIdx, r]
  }))
  const lastAt = d1 - (1 - dense) * B
  const openGroups = opener === undefined ? heroGroups : new Set(segs.flatMap((sg, i) => (opener.nets.has(segNet[i] as number) ? [segGroup[i] as number] : [])))
  const ownSeg = segs.map((_, i) => openGroups.has(segGroup[i] as number))
  const widths = segs.map((sg) => sg.width).sort((a, b) => a - b)
  const trackMm = widths[Math.floor(widths.length / 2)] ?? 0.2
  const openSpanMm = Math.max(OPEN_TRACKS * trackMm, opener === undefined ? Math.max(4, ...(hero?.pads ?? []).map((hp) => 2 * Math.hypot(hp.pos.x - originMm.x, hp.pos.y - originMm.y))) : 2 * Math.max(...opener.seeds.map((sd) => Math.hypot(sd.pos.x - opener.at.x, sd.pos.y - opener.at.y))))
  const openFill = opener !== undefined && classify(opener.ref, board.footprints.find((f) => f.ref === opener.ref)?.value) === 'ic' ? OPEN_FILL : PLUG_FILL
  const firstReach = (0.6 * openSpanMm * Math.max(resolved.width, resolved.height)) / (openFill * Math.min(resolved.width, resolved.height))
  const holdEnd = OPEN_HOLD + DRAW_HOLD * dense
  const rN = Math.min(0.8, Math.max(0.02, segs.reduce((a, _, i) => a + ((reachOf[i] as number) <= firstReach ? (segLen[i] as number) : 0), 0) / totalLen))
  const r0 = OPEN_DRAWN * rN
  const arrive = (r: number): number => r <= rN
    ? (holdEnd * (r - r0)) / (rN - r0)
    : holdEnd + Math.pow((r - rN) / (1 - rN), 1 - 0.5 * dense) * (0.94 * lastAt - holdEnd)
  const grow = (i: number): [number, number] => {
    const t0 = Math.min(d1 - 0.5 * B, arrive(rank.get(i) ?? 0) - (ownSeg[i] === true ? OWN_LEAD * holdEnd : 0))
    return [t0, Math.min(d1, t0 + Math.max(1.2 / 360, Math.pow((segLen[i] as number) / mdD, 0.85) * d1 * 0.45))]
  }
  const firstOf = (own: boolean): number => Math.min(0, ...segs.flatMap((_, i) => (ownSeg[i] === own ? [grow(i)[0]] : [])))
  const g0 = firstOf(true)
  const gRest = firstOf(false)

  const rowsByLayer = new Map<string, { side: Side; rows: number[][] }>()
  const segT0 = new Array<number>(segs.length)
  const lit0: Vec2[] = []
  const pad0: Vec2[] = []
  const padBig: Vec2[] = []
  const litHold: Vec2[] = []
  segs.forEach((s, i) => {
    const side = sideAt(s.layer)
    const [t0, t1] = grow(i)
    segT0[i] = t0
    const ends = gD.flipped[i] === true ? [s.b, s.a] : [s.a, s.b]
    const a = map(ends[0] as Vec2)
    const b = map(ends[1] as Vec2)
    if (t0 < 0 && side === 'F') {
      const f = Math.min(1, -t0 / Math.max(1e-9, t1 - t0))
      const n = Math.max(1, Math.ceil((f * Math.hypot(b.x - a.x, b.y - a.y)) / (0.5 * fit.scale)))
      for (let k = 0; k <= n; k++) lit0.push({ x: a.x + ((b.x - a.x) * f * k) / n, y: a.y + ((b.y - a.y) * f * k) / n })
    }
    if (t1 > 0 && t0 < holdEnd && side === 'F') {
      const f0 = Math.max(0, -t0 / Math.max(1e-9, t1 - t0))
      const f1 = Math.min(1, (holdEnd - t0) / Math.max(1e-9, t1 - t0))
      const n = Math.max(1, Math.ceil(((f1 - f0) * Math.hypot(b.x - a.x, b.y - a.y)) / (0.5 * fit.scale)))
      for (let k = 0; k <= n; k++) {
        const f = f0 + ((f1 - f0) * k) / n
        litHold.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f })
      }
    }
    let rec = rowsByLayer.get(s.layer)
    if (rec === undefined) {
      rec = { side, rows: [] }
      rowsByLayer.set(s.layer, rec)
    }
    const e0 = sched.segTime[i] ?? [-1, -1]
    const e: [number, number] = gD.flipped[i] === g.flipped[i] ? e0 : [e0[1], e0[0]]
    rec.rows.push([a.x, a.y, b.x, b.y, Math.max(0.9, s.width * fit.scale), t0, t1, segGroup[i] as number, e[0], e[1]])
  })
  const lit = [...rowsByLayer.values()].filter((rec) => rec.side === 'F').flatMap((rec) => rec.rows).filter((r) => (r[8] as number) >= 0)
    .sort((x, y) => Math.hypot((y[2] as number) - (y[0] as number), (y[3] as number) - (y[1] as number)) - Math.hypot((x[2] as number) - (x[0] as number), (x[3] as number) - (x[1] as number)))
  const keptAt = new Map<number, Map<number, Array<[number, number, number]>>>()
  const cellOfLit = Math.max(2, 4 * Math.max(...lit.map((r) => r[4] as number), 1))
  for (const r of lit) {
    const [x0, y0, x1, y1, w] = r as [number, number, number, number, number]
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / w))
    const pts = Array.from({ length: n + 1 }, (_, k) => [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n] as [number, number])
    const near = pts.filter(([x, y]) => {
      const cx = Math.floor(x / cellOfLit)
      const cy = Math.floor(y / cellOfLit)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if ((keptAt.get(cx + dx)?.get(cy + dy) ?? []).some(([kx, ky, kw]) => {
          const room = (kw + w) / 2 + Math.max(kw, w)
          return Math.abs(kx - x) < room && Math.abs(ky - y) < room && Math.hypot(kx - x, ky - y) < room
        })) return true
      }
      return false
    }).length
    if (near > LIT_CROWD * pts.length && Math.min(r[8] as number, r[9] as number) > (wakeAt ?? Infinity) + 1e-9) {
      r[8] = -1
      r[9] = -1
      continue
    }
    for (const [x, y] of pts) {
      const column = keptAt.get(Math.floor(x / cellOfLit)) ?? new Map<number, Array<[number, number, number]>>()
      keptAt.set(Math.floor(x / cellOfLit), column)
      const kept = column.get(Math.floor(y / cellOfLit)) ?? []
      column.set(Math.floor(y / cellOfLit), kept)
      kept.push([x, y, w])
    }
  }
  const layers: TraceLayer[] = [...rowsByLayer.entries()]
    .map(([id, rec]) => ({ id, side: rec.side, rows: rec.rows }))
    .sort((x, y) => SIDE_ORDER[x.side] - SIDE_ORDER[y.side])
    .map(({ id, side, rows }) => {
      rows.sort((x, y) => (x[5] as number) - (y[5] as number))
      return {
        id,
        side,
        segs: rows.flatMap((r) => r.slice(0, 7)),
        groups: rows.map((r) => r[7] as number),
        energy: resolved.power === 'lamps' ? rows.flatMap(() => [-1, -1]) : rows.flatMap((r) => [r[8] as number, r[9] as number])
      }
    })

  // seg endpoints in a 1 mm grid: vias look up which seg reaches them first
  const CELL = 1
  const ends = new Map<string, number[]>()
  const cellKey = (x: number, y: number): string => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
  segs.forEach((s, i) => {
    for (const q of [s.a, s.b]) {
      const k = cellKey(q.x, q.y)
      const list = ends.get(k)
      if (list === undefined) ends.set(k, [i])
      else list.push(i)
    }
  })
  /** earliest t0 of a seg with an end within r of pos */
  const earliestAt = (pos: Vec2, r: number): number => {
    let best = Infinity
    const n = Math.ceil(r / CELL)
    const cx = Math.floor(pos.x / CELL)
    const cy = Math.floor(pos.y / CELL)
    for (let dx = -n; dx <= n; dx++) {
      for (let dy = -n; dy <= n; dy++) {
        for (const i of ends.get(`${cx + dx},${cy + dy}`) ?? []) {
          const s = segs[i] as GraphSeg
          if ((Math.hypot(s.a.x - pos.x, s.a.y - pos.y) <= r || Math.hypot(s.b.x - pos.x, s.b.y - pos.y) <= r) && (segT0[i] as number) < best) {
            best = segT0[i] as number
          }
        }
      }
    }
    return best
  }

  // every pad is placed before the routing starts, as a dark mark; it plates when the routing reaches it
  const heroPads = new Set((hero?.pads ?? []).map((hp) => `${hp.pos.x.toFixed(3)},${hp.pos.y.toFixed(3)}`))
  const [pour0] = acts.pour
  // mounting holes sit in copper layers but are really drills — plated:false
  // marks them; oversized pads draw as rings either way so they never blob
  const npth = board.drill.filter((d) => !d.plated)
  const drillOnly = (pad: Pad): boolean =>
    npth.some((d) => Math.hypot(d.pos.x - pad.pos.x, d.pos.y - pad.pos.y) < 0.05)
  const slotOf = (d: DrillHit): Pad | undefined => d.plated ? undefined
    : [...padLayerSets.values()].find(({ pad }) => Math.hypot(d.pos.x - pad.pos.x, d.pos.y - pad.pos.y) < 0.05 && Math.max(pad.size.x, pad.size.y) <= d.dia + 0.05)?.pad
  const bare = new Set(npth.map(slotOf).filter((pad) => pad !== undefined))
  const pxMin = Math.min(resolved.width, resolved.height)
  const pads: TracePad[] = []
  const openRef = opener?.ref ?? hero?.ref
  const openLands: TracePad[] = []
  for (const { pad, sides } of padLayerSets.values()) {
    if (bare.has(pad)) continue
    const m = map(pad.pos)
    const own = heroPads.has(`${pad.pos.x.toFixed(3)},${pad.pos.y.toFixed(3)}`)
    const reached = own
      ? g0
      : earliestAt(pad.pos, Math.max(pad.size.x, pad.size.y) / 2 + 0.1)
    pads.push({
      x: m.x,
      y: m.y,
      w: Math.max(1.5, pad.size.x * fit.scale),
      h: Math.max(1.5, pad.size.y * fit.scale),
      rot: rotOf(pad.rot),
      shape: padShape(pad, readSilk),
      t: Number.isFinite(reached) ? Math.max(Math.min(g0, gRest), reached) : pour0,
      side: sides.size > 1 ? 'both' : ([...sides][0] === 'F' ? 'F' : 'B'),
      ring: !(own && resolved.style === 'trace' && readSilk) && (Math.min(pad.size.x, pad.size.y) * fit.scale > 0.03 * pxMin || drillOnly(pad)),
      hero: own || undefined
    })
    if (openRef !== undefined && pad.footprintRef === openRef) openLands.push(pads[pads.length - 1] as TracePad)
  }
  for (const pd of pads) {
    if (pd.side !== 'B' && Math.min(pd.w, pd.h) > OPEN_BIG_PAD * fit.scale) {
      const nb = Math.max(1, Math.round(Math.max(pd.w, pd.h) / (1.0 * fit.scale)))
      for (let u = -nb; u <= nb; u++) for (let v = -nb; v <= nb; v++) padBig.push({ x: pd.x + (u / nb) * (pd.w / 2), y: pd.y + (v / nb) * (pd.h / 2) })
    }
    if (pd.t > 0 || pd.side === 'B' || pd.ring) continue
    const r = Math.max(pd.w, pd.h) / 2
    const n = Math.max(1, Math.round(r / (0.5 * fit.scale)))
    for (let u = -n; u <= n; u++) for (let v = -n; v <= n; v++) pad0.push({ x: pd.x + (u / n) * Math.min(r, pd.w / 2), y: pd.y + (v / n) * Math.min(r, pd.h / 2) })
  }

  const edgePts = board.outline.flatMap((path) => path.points)
  const ex0 = Math.min(...edgePts.map((q) => q.x))
  const ex1 = Math.max(...edgePts.map((q) => q.x))
  const ey0 = Math.min(...edgePts.map((q) => q.y))
  const ey1 = Math.max(...edgePts.map((q) => q.y))
  const byFootprint = new Map<string, Pad[]>()
  for (const { pad, sides } of padLayerSets.values()) {
    if (pad.footprintRef === undefined || sides.size > 1) continue
    byFootprint.set(pad.footprintRef, [...(byFootprint.get(pad.footprintRef) ?? []), pad])
  }
  const gold: Array<[number, number, number, number]> = []
  const modelled = new Set(board.footprints.filter((f) => f.models.length > 0).map((f) => f.ref))
  for (const [ref, group] of byFootprint) {
    if (group.length < 10 || edgePts.length < 2 || modelled.has(ref) || group.some((q) => Math.max(q.size.x, q.size.y) < 3 * Math.min(q.size.x, q.size.y))) continue
    const fx0 = Math.min(...group.map((q) => q.pos.x - q.size.x / 2))
    const fx1 = Math.max(...group.map((q) => q.pos.x + q.size.x / 2))
    const fy0 = Math.min(...group.map((q) => q.pos.y - q.size.y / 2))
    const fy1 = Math.max(...group.map((q) => q.pos.y + q.size.y / 2))
    if (Math.min(fx0 - ex0, ex1 - fx1, fy0 - ey0, ey1 - fy1) > 3) continue
    const a = map({ x: fx0 - 0.3, y: fy0 - 0.3 })
    const b = map({ x: fx1 + 0.3, y: fy1 + 0.3 })
    gold.push([Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)])
  }

  const vias: TraceVia[] = []
  const seenVia = new Set<string>()
  for (const [, copper] of copperEntries) {
    for (const via of copper.vias) {
      if (seenVia.has(via.id)) continue
      seenVia.add(via.id)
      // a via appears when the routing reaches it
      let t = earliestAt(via.pos, Math.max(0.05, via.dia / 2) + 0.05)
      if (!Number.isFinite(t)) {
        const lt = gD.linkTime[linkVia.get(via.id) ?? -1] ?? Infinity
        t = Number.isFinite(lt) ? d0 + Math.min(1, lt / mdD) * (d1 - d0) * 0.9 : d0
      }
      const m = map(via.pos)
      vias.push({ x: m.x, y: m.y, r: Math.max(0.9, (via.dia / 2) * fit.scale), t })
    }
  }
  vias.sort((a, b) => a.t - b.t)

  // pours fill once the routing is done, outward from the hero; a power pour glows at power-on
  const [z0, z1] = acts.pour
  const zoneSpans: Array<{ layer: Side; pts: Vec2[]; d: number; group: number; id: string }> = []
  let zoneDMax = 1e-9
  for (const [layerId, copper] of copperEntries) {
    for (const zone of copper.zones) {
      const gi = zone.netId === undefined ? -1 : (groupOf.get(zone.netId) ?? -1)
      for (const fill of zone.fills) {
        if (fill.length < 3) continue
        let cx = 0
        let cy = 0
        for (const p of fill) {
          cx += p.x
          cy += p.y
        }
        cx /= fill.length
        cy /= fill.length
        const d = Math.hypot(cx - originMm.x, cy - originMm.y)
        zoneDMax = Math.max(zoneDMax, d)
        zoneSpans.push({ layer: sideAt(layerId), pts: fill, d, group: gi, id: layerId })
      }
    }
  }
  const zones: TraceZone[] = zoneSpans.map((z) => {
    const path = flat(z.pts, map)
    path.push(path[0] as number, path[1] as number)
    const t0 = z0 + (z.d / zoneDMax) * (z1 - z0)
    const grp = sched.groups[z.group]
    const lit = grp !== undefined && grp.kind === 'power' && grp.t >= 0
    return { fill: path, side: z.layer, t0, t1: z1, e0: lit ? grp.t + grp.d * 0.5 : -1, layer: z.id }
  })

  const outline: FlatPath[] = []
  if (board.outline.length > 0) {
    for (const path of board.outline) {
      if (path.points.length < 2) continue
      const f = flat(path.points, map)
      if (path.closed) f.push(f[0] as number, f[1] as number)
      outline.push(f)
    }
  }
  if (outline.length === 0) {
    const { min, max } = board.bbox
    outline.push(flat([min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }, min], map))
  }

  const [s0, s1] = acts.silk
  const silkRaw: Array<{ path: FlatPath; y: number }> = []
  for (const [layerId, silk] of Object.entries(board.silkscreen)) {
    if (sideAt(layerId) !== 'F') continue
    for (const line of silk.lines) {
      if (line.points.length < 2) continue
      const f = flat(line.points, map)
      silkRaw.push({ path: f, y: meanY(f) })
    }
  }
  silkRaw.sort((a, b) => a.y - b.y)
  const silkSpan = s1 - s0 - 0.02
  const silkStrokes = silkRaw.map((s, i) => ({
    path: s.path,
    t: s0 + (silkRaw.length > 1 ? (i / (silkRaw.length - 1)) * silkSpan : 0)
  }))

  const textRaw: Array<{ text: TraceText; y: number }> = []
  for (const [layerId, silk] of Object.entries(board.silkscreen)) {
    if (sideAt(layerId) !== 'F') continue
    for (const text of silk.texts) {
      if (text.mirrored !== back) continue
      const value = text.value.trim()
      if (value.length < 1 || value.length > 24) continue
      const m = map(text.pos)
      textRaw.push({
        y: m.y,
        text: {
          text: value,
          x: m.x,
          y: m.y,
          size: Math.max(9, text.height * fit.scale),
          rot: rotOf(text.rot),
          t: 0,
          align: text.justify,
          valign: text.vjustify
        }
      })
    }
  }
  textRaw.sort((a, b) => a.y - b.y)
  const texts = textRaw.map((t, i) => ({
    ...t.text,
    t: s0 + (textRaw.length > 1 ? (i / (textRaw.length - 1)) * silkSpan : 0)
  }))

  const drills = board.drill.flatMap((d) => {
    const slot = slotOf(d)
    const long = slot === undefined ? 0 : Math.max(slot.size.x, slot.size.y)
    const short = slot === undefined ? d.dia : Math.min(slot.size.x, slot.size.y)
    if (slot === undefined || long < short * 1.2) {
      const m = map(d.pos)
      return [{ x: m.x, y: m.y, r: Math.max(0.8, (d.dia / 2) * fit.scale) }]
    }
    const a = (slot.rot + (slot.size.y > slot.size.x ? 90 : 0)) * DEG
    const n = Math.ceil((long - short) / short * 4) + 1
    return Array.from({ length: n }, (_, i) => {
      const k = ((i / (n - 1)) - 0.5) * (long - short)
      const m = map({ x: d.pos.x + Math.cos(a) * k, y: d.pos.y - Math.sin(a) * k })
      return { x: m.x, y: m.y, r: Math.max(0.8, (short / 2) * fit.scale) }
    })
  })

  const origin = hero !== undefined ? map(hero.center) : { x: resolved.width / 2, y: resolved.height / 2 }
  const warnings: TimelineWarning[] = []
  if (segs.length === 0) warnings.push({ code: 'trace-no-copper', message: 'board has no copper segments to grow' })
  if (hero === undefined) warnings.push({ code: 'trace-no-hero', message: 'no hero footprint; growth ordered from board center' })

  // --- parts: set down outward from the hero, each landing once, square, where it stays
  const loopsPx = boardLoops(board).map((loop) => flat(loop, map))
  const xs = loopsPx.flatMap((l) => l.filter((_, i) => i % 2 === 0))
  const ys = loopsPx.flatMap((l) => l.filter((_, i) => i % 2 === 1))
  const bx0 = Math.min(...xs)
  const bx1 = Math.max(...xs)
  const by0 = Math.min(...ys)
  const by1 = Math.max(...ys)
  const partsMm = extractParts(board).filter((pt) => pt.back === back)
  const heroPart = partsMm.find((pt) => pt.ref === hero?.ref)
  const dists = partsMm.map((pt) => Math.hypot(pt.pos.x - originMm.x, pt.pos.y - originMm.y))
  const order = partsMm.map((_, i) => i).filter((i) => partsMm[i] !== heroPart).sort((a, b) => (dists[a] as number) - (dists[b] as number))
  const heroSpan = heroPart === undefined ? Infinity : Math.max(heroPart.w, heroPart.h)
  const large = (i: number): boolean => {
    const pt = partsMm[i] as (typeof partsMm)[number]
    return Math.max(pt.w, pt.h) >= 0.3 * heroSpan || pt.z >= 2.5
  }
  const landing = new Map<number, { t: number; fall: number }>()
  const passive = (i: number): boolean => ['res', 'cap', 'ind', 'diode', 'led'].includes((partsMm[i] as (typeof partsMm)[number]).kind) && !large(i)
  const area = (i: number): number => (partsMm[i] as (typeof partsMm)[number]).w * (partsMm[i] as (typeof partsMm)[number]).h
  if (resolved.style === 'plot') {
    const big = order.filter((i) => !passive(i)).sort((a, b) => area(b) - area(a))
    const bigFrom = 8 * 15 + 1 + DESCENT.large * 360
    big.forEach((idx, j) => landing.set(idx, { t: Math.round(bigFrom + BIG_RUN * Math.sqrt(j / Math.max(1, big.length))) / 360, fall: DESCENT.large }))
    const small = order.filter(passive)
    const smallFrom = bigFrom + BIG_RUN + 1
    const rows = Math.max(1, Math.ceil(small.length / RIPPLE_ROW))
    const gap = Math.min(1.5, (Math.round(acts.place[1] * 360) - 8 - smallFrom) / rows)
    small.forEach((idx, j) => landing.set(idx, { t: Math.round(smallFrom + gap * Math.floor(j / RIPPLE_ROW)) / 360, fall: DESCENT.small }))
  }
  const plan = resolved.style === 'plot' ? undefined : landings(partsMm, order, heroSpan, acts, large, passive, resolved.style === 'trace' && readSilk ? stageCuts(acts) : undefined)
  for (const [idx, at] of plan?.at ?? []) landing.set(idx, at)
  const pl1 = acts.place[1]
  const [rf0, rf1] = acts.reflow
  const leds = partsMm.filter((pt) => pt.kind === 'led')
  const firstLed = !ledSign ? undefined : [...leds].sort((a, b) => Math.hypot(a.pos.x - originMm.x, a.pos.y - originMm.y) - Math.hypot(b.pos.x - originMm.x, b.pos.y - originMm.y))[0]
  // an LED fires when a pulse reaches it: the first lit copper that ends at its pads, else when the wave's radius passes it
  const litEnds = [...rowsByLayer.values()].flatMap((rec) => rec.rows.filter((r) => (r[8] as number) >= 0).flatMap((r) => [[r[0], r[1], r[8]], [r[2], r[3], r[9]]] as Array<[number, number, number]>))
  const arrival = new Map(leds.map((pt) => {
    const at = map(pt.pos)
    const reach = Math.max(pt.w, pt.h) * fit.scale
    const hit = litEnds.filter(([x, y]) => Math.hypot(x - at.x, y - at.y) <= reach).map((e) => e[2])
    const wave = sched.leave + Math.log(Math.max(heroReach, 1.3 * Math.hypot(pt.pos.x - originMm.x, pt.pos.y - originMm.y)) / heroReach) / sched.rate
    return [pt.ref, Math.min(acts.power[1], hit.length > 0 ? Math.min(...hit) : wave)]
  }))
  const lampPlan = resolved.power === 'lamps' ? lampOrder(leds, texts, board, map, fit.scale) : undefined
  const faults = resolved.power === 'routes' ? lampOrder(leds, texts, board, map, fit.scale)?.faults ?? [] : []
  let lampsLast = 0
  if (lampPlan !== undefined) {
    const n = lampPlan.cluster.length
    const step = (n > 1 ? Math.min(1, Math.max(0.5, Math.round(8 / (n - 1)) / 2)) : 1) * B
    lampPlan.cluster.forEach((ref, i) => arrival.set(ref, LAMP_FIRST + i * step))
    const last = LAMP_FIRST + (n - 1) * step
    lampsLast = lampPlan.faults.length > 0 ? last + LAMP_OUT : last
    leds.filter((pt) => !lampPlan.cluster.includes(pt.ref)).forEach((pt) => arrival.set(pt.ref, last + 0.5 * B))
  }
  const footprintOf = new Map(board.footprints.map((fp) => [fp.ref, fp]))
  const meshes: PartMesh[] = []
  const meshIds = new Map<number, number>()
  const parts: TracePart[] = partsMm.flatMap((pt, i) => {
    const isHero = pt === heroPart
    const label = pt.kind === 'ic' && pt.value !== undefined ? marking(pt.value) : undefined
    const fp = footprintOf.get(pt.ref)
    const source = pt.kind === 'led' && Math.max(pt.w, pt.h) <= 2.2 ? undefined : bodies?.byRef[pt.ref]
    const mesh = fp === undefined || source === undefined ? undefined : bodies?.meshes[source]
    let m = map(pt.pos)
    let w = pt.w * fit.scale
    let h = pt.h * fit.scale
    let z = pt.z * fit.scale
    let solid: TracePart['mesh']
    if (fp !== undefined && mesh !== undefined) {
      const a = (-fp.rot * Math.PI) / 180
      const at = (u: number, v: number): Vec2 => map({ x: fp.pos.x + u * Math.cos(a) - v * Math.sin(a), y: fp.pos.y + u * Math.sin(a) + v * Math.cos(a) })
      const o = at(0, 0)
      const du = at(1, 0)
      const dv = at(0, 1)
      const affine: [number, number, number, number, number, number] = [du.x - o.x, du.y - o.y, dv.x - o.x, dv.y - o.y, o.x, o.y]
      const [x0, y0] = mesh.min
      const [x1, y1, z1] = mesh.max
      m = at((x0 + x1) / 2, (y0 + y1) / 2)
      w = (x1 - x0) * fit.scale
      h = (y1 - y0) * fit.scale
      z = Math.max(0.05, z1) * fit.scale
      const id = meshIds.get(source as number) ?? meshes.push(mesh) - 1
      meshIds.set(source as number, id)
      solid = { id, m: affine }
    }
    const t = landing.get(i)?.t ?? pl1
    const fall = landing.get(i)?.fall ?? DESCENT.hero
    const settle = isHero ? rf1 : Math.min(rf1, Math.max(t + 0.25 * B, rf0 + Math.min(1, Math.max(0, (m.x - bx0) / Math.max(1, bx1 - bx0))) * (rf1 - rf0 - 0.5 * B)))
    const shell = pt.kind === 'conn' && solid === undefined && /USB|HDMI|RJ45|DisplayPort/i.test(`${fp?.footprint ?? ''} ${fp?.model ?? ''}`)
    const body: TracePart = {
      x: m.x, y: m.y, w, h, rot: rotOf(pt.rot), z,
      kind: shell ? 'xtal' : pt.kind,
      ...(shell ? { socket: true } : {}),
      t,
      fall,
      settle,
      label,
      pitch: pt.kind === 'conn' && pt.pitch > 0 && !shell ? pt.pitch * fit.scale : undefined,
      led: pt.kind === 'led' ? { ...ledLight(pt, leds), ...(lampPlan !== undefined && !lampPlan.cluster.includes(pt.ref) ? { gain: 0.2 * ledLight(pt, leds).gain } : resolved.power === 'routes' ? { gain: ROUTE_LED * ledLight(pt, leds).gain } : {}), at: arrival.get(pt.ref) ?? -1, ...(lampPlan?.faults.includes(pt.ref) === true ? { off: lampsLast } : faults.includes(pt.ref) ? { off: (arrival.get(pt.ref) ?? 0) + LAMP_OUT } : {}) } : undefined,
      hero: isHero,
      mesh: solid
    }
    const pinW = 0.64 * (pt.pinZ ?? 0) / 8.5 * fit.scale
    // a model that stands clear of the board (a part mounted off it, or placed wrong) would steal the frame
    if (!isHero && (m.x < bx0 || m.x > bx1 || m.y < by0 || m.y > by1)) return []
    return [body, ...(solid === undefined ? pt.pins ?? [] : []).map((pin): TracePart => ({
      ...map(pin), w: pinW, h: pinW, rot: body.rot, z: (pt.pinZ ?? 0) * fit.scale, kind: 'pin', t, fall, settle, seat: body.z
    }))]
  })

  const heroBody = parts.find((pt) => pt.hero === true)
  const ledBody = firstLed === undefined ? undefined : parts.find((pt) => pt.kind === 'led' && Math.hypot(pt.x - map(firstLed.pos).x, pt.y - map(firstLed.pos).y) < 1e-6)
  const sign: TraceSign | undefined = heroBody?.kind === 'valve'
    ? { kind: 'heater', x: heroBody.x, y: heroBody.y, t: acts.power[0], pads: [] }
    : ledBody !== undefined
      ? { kind: 'led', x: ledBody.x, y: ledBody.y, t: ledBody.led?.at ?? SIGN_AT, pads: [] }
      : signRoute !== undefined
        ? { kind: 'pins', ...mean(signRoute.pads.map((pd) => map(pd.pos))), t: SIGN_AT, pads: signRoute.pads.map((pd) => ({ ...map(pd.pos), w: Math.min(1.2, pd.size.x, pd.size.y) * fit.scale, h: Math.min(1.2, pd.size.x, pd.size.y) * fit.scale, rot: 0 })) }
      : entry.length > 0
        ? { kind: 'pins', ...mean(entry.map((e) => map(e.pos))), t: SIGN_AT, pads: entry.map((e) => ({ ...map(e.pos), w: 1.2 * fit.scale, h: 1.2 * fit.scale, rot: 0 })) }
        : undefined
  const heroFp = hero === undefined || heroBody === undefined ? undefined : board.footprints.find((f) => f.ref === hero.ref)
  const heroNumber = heroFp?.value === undefined ? undefined : partNumber(heroFp.value) ?? partNumber(marking(heroFp.value))
  const named = resolved.title === undefined ? undefined : boardTitle(board, resolved)
  const heroName = heroNumber !== undefined && !(named?.name ?? '').toUpperCase().includes(heroNumber.toUpperCase()) ? heroNumber : undefined
  const heroPackage = heroFp === undefined ? undefined : /^([A-Za-z]+)-(\d+)/.exec(heroFp.model ?? '')
  const alnum = (t: string): string => t.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const heroLine = heroName === undefined ? undefined : heroPackage === null || heroPackage === undefined || (resolved.style === 'trace' && alnum(heroName).includes(alnum(`${heroPackage[1]}${heroPackage[2]}`))) ? heroName : `${heroName}${FACT_SEP}${heroPackage[1]?.toUpperCase()}-${heroPackage[2]}`

  const minWH = Math.min(resolved.width, resolved.height)
  const plot = resolved.style === 'plot'
    ? clearPlot({
      board, resolved, layers, zones, groups: sched.groups, loops: loopsPx, hero: origin, heroRef: hero?.ref,
      heroLabel: heroName,
      heroSize: heroPart === undefined ? 0.08 * minWH : Math.max(heroPart.w, heroPart.h) * fit.scale,
      entry: entry.map((e) => e.pos), tallest: Math.max(0, ...parts.map((pt) => pt.z)), pxPerMm: fit.scale, map, back,
      parts: parts.filter((pt) => pt.kind !== 'pin').map((pt) => ({ x: pt.x, y: pt.y, w: pt.w, h: pt.h, rot: pt.rot, z: pt.z, hero: pt.hero })),
      pins: parts.filter((pt) => pt.kind === 'pin').map((pt) => ({ x: pt.x, y: pt.y, w: pt.w, h: pt.h, rot: pt.rot, z: pt.z, seat: pt.seat })),
      measured: parts.filter((pt) => pt.kind !== 'pin').reduce<TracePart | undefined>((b, pt) => (b === undefined || pt.z > b.z ? pt : b), undefined)?.mesh !== undefined,
      pads, vias
    })
    : undefined
  const facts = boardFacts(board)
  const factList = factLine(facts)
  const mat = material(board, resolved, fit.scale)
  const character = boardCharacter(parts, loopsPx, gold, origin)
  const early = [...rowsByLayer.values()].flatMap((rec) => rec.rows).filter((r) => (r[8] as number) >= 0 && (r[8] as number) <= sched.leave + 18 / 360)
  if (resolved.power === 'leds') {
    const lit = parts.filter((pt) => pt.led !== undefined && pt.led.at >= 0).sort((a, b) => (a.led?.at ?? 0) - (b.led?.at ?? 0))
    lit.forEach((pt, i) => {
      if (pt.led !== undefined) pt.led.at = i === 0 ? WAKE_FIRST : WAKE_FIRST + B + (lit.length > 1 ? ((i - 1) / Math.max(1, lit.length - 2)) * 4 * B : 0)
    })
  }
  const supplyNets = new Set((inPath?.steps ?? []).flatMap((st) => (st.net === undefined ? [] : [st.net])))
  const netName = new Map(board.nets.map((n) => [n.id, n.name]))
  const chase = new Set(netGroups.flatMap((ng, gi) => (ng.kind !== 'ground' && (ng.kind === 'power' || heroGroups.has(gi) || ng.netIds.some((n) => supplyNets.has(netName.get(n) ?? ''))) ? [gi] : [])))
  const rideSide = (gi: number): number => (chase.has(gi) ? RIDE_SIDE : (netGroups[gi]?.kind ?? 'ground') !== 'ground' ? RIDE_LANE : 0) * fit.scale
  const trace = plot === undefined ? cineShots(resolved, {
      chase,
      rideSide,
      ride: { first: early.map((r) => ({ x: ((r[0] as number) + (r[2] as number)) / 2, y: ((r[1] as number) + (r[3] as number)) / 2 })) },
      hero: origin,
      heroSize: heroPart === undefined ? 0.08 * minWH : Math.max(heroPart.w, heroPart.h) * fit.scale,
      loops: loopsPx,
      tallest: Math.max(0, ...parts.map((pt) => pt.z)),
      bodies: parts.filter((pt) => pt.hero !== true && pt.kind !== 'pin').map((pt) => {
        const pinTop = pt.kind === 'conn' ? Math.max(0, ...parts.filter((q) => q.kind === 'pin' && q.t === pt.t && Math.hypot(q.x - pt.x, q.y - pt.y) <= Math.max(pt.w, pt.h) / 2 + 1).map((q) => q.z)) : 0
        return [pt.x, pt.y, Math.max(pt.z, pinTop), Math.max(pt.w, pt.h), Math.min(pt.w, pt.h)]
      }),
      solids: parts.filter((pt) => pt.kind !== 'pin'),
      pale: parts.filter((pt) => pt.hero !== true && PALE.has(pt.kind)),
      powerAt: wakeAt,
      openFrom: opener === undefined ? undefined : map(opener.at),
      acts,
      named: named === undefined ? undefined : { name: named.name, revision: revisionLabel(named.revision) },
      openSpan: opener === undefined ? 0 : openSpanMm * fit.scale,
      supply: ((): Array<[number, number, number]> => {
        let run = 0
        return (inPath?.steps ?? []).flatMap((st): Array<[number, number, number]> => {
          const a = map(st.a)
          const b = map(st.b)
          const from = run / Math.max(1e-9, inLen)
          run += Math.hypot(st.b.x - st.a.x, st.b.y - st.a.y)
          return [[a.x, a.y, from], [b.x, b.y, run / Math.max(1e-9, inLen)]]
        })
      })(),
      powerFrom: inFrom,
      heroBox: heroBody === undefined ? { x: origin.x, y: origin.y, w: 0.08 * minWH, h: 0.08 * minWH, rot: 0, z: 0 } : { x: heroBody.x, y: heroBody.y, w: heroBody.w, h: heroBody.h, rot: heroBody.rot, z: heroBody.z },
      heroReach: heroBody === undefined ? 1.4 : pinReach(heroBody, pads.filter((pd) => pd.hero === true)),
      heroMark: heroBody?.label === undefined || heroBody.kind === 'valve' ? undefined : Math.atan2(markingAxis(heroBody).y, markingAxis(heroBody).x),
      blockers: parts.filter((pt) => pt.hero !== true && (heroBody === undefined || pt.kind !== 'pin' || Math.hypot(pt.x - heroBody.x, pt.y - heroBody.y) > Math.max(heroBody.w, heroBody.h) / 2)).map((pt) => ({ x: pt.x, y: pt.y, w: pt.w, h: pt.h, rot: pt.rot, z: pt.z, drawn: drawnOf(pt, meshes) })),
      readSilk,
      own: readSilk,
      marks: [
        ...(heroBody?.label === undefined || heroBody.kind === 'valve' ? [] : [Math.atan2(markingAxis(heroBody).y, markingAxis(heroBody).x)]),
        ...[...texts].sort((a, b) => b.size * b.text.length - a.size * a.text.length).slice(0, 1).map((t) => t.rot)
      ],
      thick: Math.max(1.5, mat.thicknessPx),
      mm: mat.pxPerMm,
      heroLine
    }, layers) : undefined
  if (trace !== undefined && wakeAt !== undefined) chaseLight(layers, trace.ride, rideSide, inFrom, wakeAt)
  const endYaw = trace?.turnYaw
  if (endYaw !== undefined) {
    for (const pt of parts) {
      if (pt.label === undefined) continue
      const d = markingAxis(pt)
      pt.turn = d.x * Math.cos(endYaw) - d.y * Math.sin(endYaw) < 0
    }
  }
  if (trace !== undefined) {
    for (const pt of parts) {
      if (pt.kind === 'pin' || pt.kind === 'valve') continue
      const way = entryPath(trace.shots, resolved.width, resolved.height, pt, landLift(pt, mat.pxPerMm))
      pt.lift = way?.lift ?? landLift(pt, mat.pxPerMm)
      if (way !== undefined && (way.enter.x !== 0 || way.enter.y !== 0)) pt.enter = way.enter
      if (way !== undefined) pt.fall = way.fall
    }
    for (const pin of parts) {
      if (pin.kind !== 'pin') continue
      const body = parts.find((pt) => pt.kind !== 'pin' && pt.t === pin.t && Math.hypot(pt.x - pin.x, pt.y - pin.y) <= Math.max(pt.w, pt.h) / 2 + 1)
      pin.lift = body?.lift
      if (body?.enter !== undefined) pin.enter = body.enter
      if (body !== undefined) pin.fall = body.fall
    }
  }
  return {
    scene: {
      outline,
      layers,
      pads,
      gold: gold.slice(0, 4),
      vias,
      drills,
      zones,
      silkStrokes,
      texts,
      origin,
      camera: cameraTrack(box, resolved, map, layers, origin),
      beats: trace?.hold === undefined ? beats : { ...beats, hold: [trace.hold, 1] },
      groups: sched.groups,
      board: loopsPx,
      material: mat,
      shots: plot?.shots ?? trace?.shots ?? [],
      lockup: trace?.lockup,
      bareLid: resolved.style === 'trace' && wakeAt !== undefined ? [0, wakeAt + 0.5 * B, wakeAt] : undefined,
      film: resolved.style === 'trace' ? true : undefined,
      seat: resolved.style === 'trace' && readSilk ? parts.find((pt) => pt.hero === true)?.t : undefined,
      pulse: resolved.style === 'trace' && readSilk ? lastPulse(trace?.lockup?.build, layers, sched.groups) : undefined,
      sign,
      wake: wakeAt,
      opening: opener === undefined ? undefined : { ...map(opener.at), groups: [...openGroups], edge: undefined },
      character,
      acts: { ...acts, ...(trace?.hold === undefined ? {} : { hold: [trace.hold, 1] as [number, number] }) },
      parts,
      meshes,
      facts: factList,
      power: resolved.power,
      plot: plot?.plot
    },
    warnings
  }
}

interface Schedule {
  groups: TraceGroup[]
  /** per seg its energy window [e0, e1], undefined while it stays dark */
  segTime: Array<[number, number] | undefined>
}

/** the first frame holds at least this many widths of the board's typical track across its opening part, so a board of wide tracks opens wider */
const OPEN_TRACKS = 50
/** the share of the copper within the first frame's reach already drawn on frame 0: the rest arrives across it through the close hold */
const OPEN_DRAWN = 0.75
/** the opening part's own routes run this share of the close hold ahead of the rest */
const OWN_LEAD = 0.4

/**
 * First power-on, by role and in net order. Six frames after ignition the supply pulse leaves the hero, then
 * the clocks, then the buses rank by rank (a differential pair is one group, so its two lines race side by
 * side), then the other signals; nets that do not touch the hero follow a little later. Each front runs out
 * along the real copper at a speed that grows with its distance (a constant speed on screen while the camera
 * pulls back), so the farthest copper is reached as the crane starts. Ground stays dark.
 */
function scheduleEnergy(
  kinds: NetKind[],
  segLen: number[],
  segNet: Array<number | undefined>,
  segGroup: number[],
  start: number[],
  heroGroups: Set<number>,
  r0: number,
  arrive = 19 * B,
  from = TRACE_ACTS.power[0] + WAVE_LEAVE
): Schedule & { leave: number; rate: number } {
  const p0 = from
  const busRank = new Map<number, number>()
  kinds.forEach((k, gi) => {
    if (k === 'bus' || k === 'diff') busRank.set(gi, busRank.size)
  })
  const leave = (gi: number): number | undefined => {
    const kind = gi < 0 ? undefined : kinds[gi]
    if (kind === undefined || kind === 'ground') return undefined
    const own = heroGroups.has(gi) ? 0 : 6 / 360
    if (kind === 'power') return p0 + own
    if (kind === 'clock') return p0 + 4 / 360 + own
    if (kind === 'bus' || kind === 'diff') return p0 + 8 / 360 + Math.min(4, busRank.get(gi) ?? 0) * (3 / 360) + own
    return p0 + 14 / 360 + own
  }
  let reach = 1e-9
  segGroup.forEach((gi, i) => {
    if (leave(gi) !== undefined && segNet[i] !== undefined) reach = Math.max(reach, (start[i] as number) + (segLen[i] as number))
  })
  const near = Math.max(1e-3, r0)
  const rate = Math.log(Math.max(reach, 2 * near) / near) / (arrive - p0)
  const at = (t: number, d: number): number => t + Math.log(Math.max(d, near) / near) / rate
  const segTime = segGroup.map((gi, i): [number, number] | undefined => {
    const t = leave(gi)
    if (t === undefined || segNet[i] === undefined) return undefined
    return [at(t, start[i] as number), at(t, (start[i] as number) + (segLen[i] as number))]
  })
  const groups: TraceGroup[] = kinds.map((kind, gi) => {
    const own = segTime.filter((_, i) => segGroup[i] === gi).filter((w): w is [number, number] => w !== undefined)
    const t = own.length > 0 ? Math.min(...own.map((w) => w[0])) : -1
    return { kind, t, d: own.length > 0 ? Math.max(...own.map((w) => w[1])) - t : 0, ...(heroGroups.has(gi) ? { hero: true } : {}) }
  })
  return { groups, segTime, leave: p0, rate }
}


/**
 * Where the drawing starts, by rule: on a board 2.2 times longer than wide, its plug (the connector nearest an end);
 * else the chip of 16 pads or more with the most track length within one and a half times its pad spread, when that is not the hero.
 */
function openingPart(board: BoardModel, segs: GraphSeg[], segLen: number[], heroRef: string | undefined, face: string): { ref: string; seeds: GraphSeed[]; at: Vec2; nets: Set<number> } | undefined {
  const pads = Object.entries(board.copper).flatMap(([layer, c]) => c.pads.map((pd) => ({ layer, pd })))
  const onFace = new Set(pads.filter((q) => q.layer === face && q.pd.footprintRef !== undefined).map((q) => q.pd.footprintRef as string))
  const make = (ref: string): ReturnType<typeof openingPart> => {
    const own = pads.filter((q) => q.pd.footprintRef === ref)
    if (own.length === 0) return undefined
    const at = { x: own.reduce((a, q) => a + q.pd.pos.x, 0) / own.length, y: own.reduce((a, q) => a + q.pd.pos.y, 0) / own.length }
    return { ref, seeds: own.map((q) => ({ layer: q.layer, pos: q.pd.pos })), at, nets: new Set(own.flatMap((q) => (q.pd.netId === undefined ? [] : [q.pd.netId]))) }
  }
  const { min, max } = board.bbox
  const w = max.x - min.x
  const h = max.y - min.y
  if (Math.max(w, h) / Math.max(1e-6, Math.min(w, h)) >= LONG_BOARD) {
    const endOf = (p: Vec2): number => {
      const u = w >= h ? (p.x - min.x) / w : (p.y - min.y) / h
      return Math.min(u, 1 - u)
    }
    const plug = board.footprints.filter((f) => classify(f.ref, f.value) === 'conn' && onFace.has(f.ref) && endOf(f.pos) < 0.15).sort((a, b) => endOf(a.pos) - endOf(b.pos))[0]
    return plug === undefined || plug.ref === heroRef ? undefined : make(plug.ref)
  }
  const byRef = new Map<string, Vec2[]>()
  for (const q of pads) if (q.pd.footprintRef !== undefined && !/\*/.test(q.pd.footprintRef)) byRef.set(q.pd.footprintRef, [...(byRef.get(q.pd.footprintRef) ?? []), q.pd.pos])
  const mids = segs.map((sg) => ({ x: (sg.a.x + sg.b.x) / 2, y: (sg.a.y + sg.b.y) / 2 }))
  const around = (ps: Vec2[]): number => {
    const c = { x: ps.reduce((a, q) => a + q.x, 0) / ps.length, y: ps.reduce((a, q) => a + q.y, 0) / ps.length }
    const reach = 1.5 * Math.max(1, ...ps.map((q) => Math.hypot(q.x - c.x, q.y - c.y)))
    return mids.reduce((sum, m, i) => sum + (Math.hypot(m.x - c.x, m.y - c.y) <= reach ? (segLen[i] as number) : 0), 0)
  }
  const ranked = [...byRef.entries()].filter(([ref, ps]) => ps.length >= 16 && onFace.has(ref) && classify(ref, board.footprints.find((f) => f.ref === ref)?.value) === 'ic').map(([ref, ps]) => ({ ref, copper: around(ps) })).sort((a, b) => b.copper - a.copper)
  const best = ranked[0]
  return best === undefined || best.ref === heroRef ? undefined : make(best.ref)
}

/**
 * The power pads of the connector that feeds the board: one on a VBUS or VIN
 * net when there is one, else the J/P part with the most pads on power nets.
 */
function powerEntry(board: BoardModel, isPower: (net: number | undefined) => boolean): GraphSeed[] {
  const supply = new Set(board.nets.filter((n) => /VBUS|VUSB|^\/?VIN$/i.test(n.name)).map((n) => n.id))
  const feeds = new Set<string>()
  const byRef = new Map<string, GraphSeed[]>()
  for (const [layer, copper] of Object.entries(board.copper)) {
    for (const pad of copper.pads) {
      if (pad.footprintRef === undefined || !/^(J|P|CN|USB|X)\d/i.test(pad.footprintRef) || !isPower(pad.netId)) continue
      if (pad.netId !== undefined && supply.has(pad.netId)) feeds.add(pad.footprintRef)
      const list = byRef.get(pad.footprintRef) ?? []
      list.push({ layer, pos: pad.pos })
      byRef.set(pad.footprintRef, list)
    }
  }
  return [...byRef.entries()].sort((a, b) => Number(feeds.has(b[0])) - Number(feeds.has(a[0])) || b[1].length - a[1].length)[0]?.[1] ?? []
}

/**
 * Edge.Cuts arrives as loose lines and arcs; chain them end to end into
 * closed loops so the board's area can be filled (evenodd keeps cutouts).
 */
function boardLoops(board: BoardModel): Vec2[][] {
  const loops: Vec2[][] = []
  const open: Vec2[][] = []
  for (const path of board.outline) {
    if (path.points.length < 2) continue
    if (path.closed) loops.push([...path.points])
    else open.push([...path.points])
  }
  const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 0.02
  while (open.length > 0) {
    const chain = open.pop() as Vec2[]
    for (let grew = true; grew;) {
      grew = false
      for (let i = 0; i < open.length; i++) {
        const piece = open[i] as Vec2[]
        const head = chain[0] as Vec2
        const tail = chain[chain.length - 1] as Vec2
        const p0 = piece[0] as Vec2
        const p1 = piece[piece.length - 1] as Vec2
        if (near(tail, p0)) chain.push(...piece.slice(1))
        else if (near(tail, p1)) chain.push(...[...piece].reverse().slice(1))
        else if (near(head, p1)) chain.unshift(...piece.slice(0, -1))
        else if (near(head, p0)) chain.unshift(...[...piece].reverse().slice(0, -1))
        else continue
        open.splice(i, 1)
        grew = true
        break
      }
    }
    if (chain.length >= 3 && near(chain[0] as Vec2, chain[chain.length - 1] as Vec2)) loops.push(chain)
  }
  const { min, max } = board.bbox
  const rect = [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }]
  const span = (pts: Vec2[]): number => {
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
  }
  const outer = loops.length > 0 && Math.max(...loops.map(span)) > 0.5 * span(rect)
  return outer ? loops : [rect, ...loops]
}

/** whether any footprint is a BGA or has pads at 0.5 mm pitch or finer */
export function finePitch(board: BoardModel): boolean {
  const byRef = new Map<string, Pad[]>()
  for (const pad of Object.values(board.copper).flatMap((layer) => layer.pads)) {
    if (pad.footprintRef === undefined) continue
    byRef.set(pad.footprintRef, [...(byRef.get(pad.footprintRef) ?? []), pad])
  }
  return [...byRef.values()].some((pads) => {
    if (pads.length < 8) return false
    if (pads.filter((pad) => /^[A-Z]{1,2}\d{1,2}$/.test(pad.num ?? '')).length >= 16) return true
    return pads.some((a, i) => pads.slice(i + 1).some((b) => b.num !== a.num && Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) <= 0.55))
  })
}

/** the board's own mask and finish under the copper palette; the stylised palettes tint them */
function material(board: BoardModel, resolved: ResolvedConfig, pxPerMm: number): TraceMaterial {
  const palette = resolved.palette
  const trueColour = palette.copper === '#d08a4c'
  const accent = palette.id === 'custom' ? palette.head : undefined
  // a board that declares no colour is most likely the fab's default green
  const mask = resolved.mask ?? board.stackup.maskColor?.toLowerCase() ?? DEMO_MASKS[board.source.boardName] ?? 'green'
  const declared = board.stackup.finish?.toLowerCase() ?? ''
  const finishKey = declared === '' || declared === 'none' ? (finePitch(board) ? 'enig' : 'hal') : declared
  const finish = Object.entries(FINISH).find(([k]) => finishKey.startsWith(k))?.[1] ?? FINISH.hal
  const maskHex: string = trueColour
    ? (mask.startsWith('#') ? mask : (MASK_ALBEDO[mask] ?? '#0d3b22'))
    : mixHex(palette.bg, palette.copperDim, 0.45)
  // white boards print black legends; everything else prints white
  const silk = luma(maskHex) > 0.5 ? '#1b1c1e' : '#eeeee8'
  return {
    // true copper is a pale salmon metal; the stylised palettes keep their own hue
    copper: trueColour ? '#ec9a78' : palette.copper,
    mask: maskHex,
    finish: trueColour ? (finish?.albedo ?? '#e8a878') : palette.copper,
    finishRough: finish?.rough ?? 0.24,
    substrate: trueColour ? '#2b2617' : mixHex(palette.bg, palette.copperDim, 0.3),
    silk,
    // light reads against the mask: a deep amber on a white board, white-gold on a dark one
    energyWarm: trueColour && accent === undefined ? (luma(maskHex) > 0.5 ? '#ff6a14' : '#ffa860') : palette.head,
    energyCool: trueColour && accent === undefined ? (luma(maskHex) > 0.5 ? '#ff9a4a' : '#ffcf9c') : mixHex(palette.head, palette.silk, 0.5),
    ...(accent === undefined ? {} : { accent }),
    pxPerMm,
    thicknessPx: board.stackup.thickness * pxPerMm,
    ground: groundFor(maskHex),
    ink: '#f3ece2'
  }
}

function factLine(f: BoardFacts): string[] {
  return [
    `${f.widthMm} × ${f.heightMm} mm`,
    ...(f.copperLayers > 0 ? [`${f.copperLayers} layers`] : []),
    ...(f.parts > 0 ? [`${f.parts} parts`] : []),
    ...(f.nets > 0 ? [`${f.nets} nets`] : [])
  ]
}

function luma(hex: string): number {
  const c = (i: number): number => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255
  return 0.2126 * c(0) + 0.7152 * c(1) + 0.0722 * c(2)
}

function routeSign(board: BoardModel, heroRef: string, at: Vec2, kindOf: Map<string, string>, kindOfNet: (net: number) => NetKind | undefined): { nets: number[]; pads: Pad[] } | undefined {
  const pads = Object.values(board.copper).flatMap((c) => c.pads)
  const heroNets = new Set(pads.filter((pd) => pd.footprintRef === heroRef && pd.netId !== undefined).map((pd) => pd.netId as number))
  const name = new Map(board.nets.map((n) => [n.id, n.name]))
  const reach = (kind: string): Pad[] => pads.filter((pd) => pd.netId !== undefined && heroNets.has(pd.netId) && pd.footprintRef !== heroRef && kindOf.get(pd.footprintRef ?? '') === kind && kindOfNet(pd.netId) !== 'power' && kindOfNet(pd.netId) !== 'ground')
  const count = new Map<string | undefined, number>()
  for (const pd of pads) count.set(pd.footprintRef, (count.get(pd.footprintRef) ?? 0) + 1)
  const others = reach('other')
  const most = Math.max(20, ...others.map((pd) => count.get(pd.footprintRef) ?? 0))
  const ends = reach('conn').length > 0 ? reach('conn') : others.filter((pd) => (count.get(pd.footprintRef) ?? 0) >= most)
  if (ends.length === 0) return undefined
  const far = (pd: Pad): number => Math.hypot(pd.pos.x - at.x, pd.pos.y - at.y)
  const usb = ends.filter((pd) => /(^|[^A-Z])(D[+-]|DP|DM|USB_?D[PMN+-]?)($|[^A-Z])/i.test(name.get(pd.netId as number) ?? ''))
  const plain = (pd: Pad): number => (name.get(pd.netId as number) ?? '').length
  const plug = usb.length > 0
    ? [...usb].sort((a, b) => plain(a) - plain(b) || far(a) - far(b))[0]?.footprintRef
    : [...ends].sort((a, b) => far(a) - far(b))[0]?.footprintRef
  const pick = (usb.length > 0 ? usb : ends).filter((pd) => pd.footprintRef === plug)
  const nets = [...new Set([...pick].sort((a, b) => far(a) - far(b)).map((pd) => pd.netId as number))].slice(0, usb.length > 0 ? 2 : 3)
  return { nets, pads: pick.filter((pd) => nets.includes(pd.netId as number)) }
}

function marking(value: string): string {
  const parts = value.split(/[_\s]+/)
  const rest = parts.length > 1 && /^[A-Z]+$/i.test(parts[0] as string) && /\d/.test(parts.slice(1).join('')) ? parts.slice(1) : parts
  return rest.join('-').toUpperCase().slice(0, 22)
}

/** the direction a part's marking reads along on the plane (y down): its long side */
/**
 * The lamps power-on: the board's LEDs grouped where they sit within 12 mm of each other, the largest group
 * for the macro, ordered from its power lamp (a power word in the silk beside it, or a series resistor whose
 * other end is a supply) along the row by distance; with no power lamp, from an end of the row.
 */
export function lampOrder(leds: PartMm[], texts: Array<{ text: string; x: number; y: number }>, board: BoardModel, map: (p: Vec2) => Vec2, scale: number): { cluster: string[]; faults: string[] } | undefined {
  if (leds.length === 0) return undefined
  const groups: PartMm[][] = []
  for (const pt of leds) {
    const hits = groups.filter((g) => g.some((q) => Math.hypot(q.pos.x - pt.pos.x, q.pos.y - pt.pos.y) <= 12))
    for (const h of hits) groups.splice(groups.indexOf(h), 1)
    groups.push([pt, ...hits.flat()])
  }
  const word = /^(PWR|POWER|PWR ?ON|ON|POWER ?ON)$/i
  const namedIn = (pool: PartMm[]): PartMm | undefined => texts.filter((t) => word.test(t.text.trim())).flatMap((t) => {
    const near = [...pool].sort((a, b) => Math.hypot(map(a.pos).x - t.x, map(a.pos).y - t.y) - Math.hypot(map(b.pos).x - t.x, map(b.pos).y - t.y))[0]
    return near !== undefined && Math.hypot(map(near.pos).x - t.x, map(near.pos).y - t.y) <= 6 * scale ? [near] : []
  })[0]
  const cluster = [...groups].sort((a, b) => b.length - a.length || (namedIn(b) === undefined ? 0 : 1) - (namedIn(a) === undefined ? 0 : 1))[0] ?? []
  const named = namedIn(cluster)
  const nets = new Map(board.nets.map((n) => [n.id, n.name.replace(/^\//, '')]))
  const pads = Object.values(board.copper).flatMap((c) => c.pads)
  const supply = (id: number | undefined): boolean => {
    const name = id === undefined ? '' : nets.get(id) ?? ''
    return !/GND/i.test(name) && /(^|[_/])(\+?\d+V\d*|VCC\w*|VDD\w*|VBUS|VIN)$/i.test(name)
  }
  const fed = cluster.find((pt) => pads.filter((pd) => pd.footprintRef === pt.ref).some((pd) => supply(pd.netId) || (pd.netId !== undefined && pads.some((q) => q.netId === pd.netId && q.footprintRef !== undefined && q.footprintRef !== pt.ref && /^R\d/i.test(q.footprintRef) && pads.some((o) => o.footprintRef === q.footprintRef && o.netId !== pd.netId && supply(o.netId))))))
  const mid = { x: cluster.reduce((a, pt) => a + pt.pos.x, 0) / cluster.length, y: cluster.reduce((a, pt) => a + pt.pos.y, 0) / cluster.length }
  const end = [...cluster].sort((a, b) => Math.hypot(b.pos.x - mid.x, b.pos.y - mid.y) - Math.hypot(a.pos.x - mid.x, a.pos.y - mid.y))[0] as PartMm
  const first = named ?? fed ?? end
  const alarm = /^(ERR|ERROR|FAULT|FAIL|ALARM)$/i
  const faults = new Set([
    ...texts.filter((t) => alarm.test(t.text.trim())).flatMap((t) => {
      const near = [...cluster].sort((a, b) => Math.hypot(map(a.pos).x - t.x, map(a.pos).y - t.y) - Math.hypot(map(b.pos).x - t.x, map(b.pos).y - t.y))[0]
      return near !== undefined && Math.hypot(map(near.pos).x - t.x, map(near.pos).y - t.y) <= 6 * scale ? [near.ref] : []
    }),
    ...cluster.filter((pt) => pads.some((pd) => pd.footprintRef === pt.ref && /(^|[_/])(ERR|ERROR|FAULT|FAIL|ALARM)/i.test(nets.get(pd.netId ?? -1) ?? ''))).map((pt) => pt.ref)
  ])
  const order = [...cluster].sort((a, b) => Math.hypot(a.pos.x - first.pos.x, a.pos.y - first.pos.y) - Math.hypot(b.pos.x - first.pos.x, b.pos.y - first.pos.y)).map((pt) => pt.ref)
  return { cluster: [...order.filter((r) => !faults.has(r)), ...order.filter((r) => faults.has(r))], faults: [...faults] }
}

/** how high a part starts its descent (mm is pixels per millimetre): far enough to be seen travelling, twice its own height, between 2.5 and 5 mm */
export function landLift(pt: Pick<TracePart, 'w' | 'h' | 'z' | 'fall'>, mm: number): number {
  return (pt.fall ?? 0) >= DESCENT.large - 1e-9 ? Math.min(8 * mm, Math.max(6 * mm, 2 * pt.z)) : Math.min(5 * mm, Math.max(2.5 * mm, 2 * pt.z))
}

/**
 * Where a part starts its descent: a height and a plane offset, eased to its pads, chosen so that on its first drawn frame
 * it is wholly outside the frame and on its first visible frame only part of it has crossed an edge. It may come in through
 * any edge, prefers to travel down the screen, never covers more than ENTRY_COVER of the frame or more than it covers at rest, and may lengthen its fall
 * to one beat (starting no earlier than its shot's cut). Undefined when no such path exists.
 */
const SIGNS = [-1, 1]

export function entryPath(shots: CameraShot[], W: number, H: number, pt: TracePart, height: number): { lift: number; enter: Vec2; fall: number } | undefined {
  const cutAt = Math.max(0, ...shots.filter((k) => k.cut === true && k.t <= pt.t - 1e-6).map((k) => k.t))
  const aspect = W / H
  const solve = (fall: number): { lift: number; enter: Vec2; fall: number; cost: number } | undefined => {
    const first = Math.ceil((pt.t - fall) * 360 - 1e-9)
    if (first / 360 < cutAt + 1 / 360) return undefined
    const last = Math.round(pt.t * 360)
    const cams = Array.from({ length: last - first + 1 }, (_, i) => makeCam(sampleShot(shots, (first + i) / 360), W, H))
    const drop = (f: number): number => {
      const u = Math.min(1, Math.max(0, (pt.t - f / 360) / fall))
      return pt.hero === true ? u * u : u * u * (3 - 2 * u)
    }
    const c = Math.cos(pt.rot)
    const sn = Math.sin(pt.rot)
    const box = (f: number, lift: number, e: Vec2): Array<{ x: number; y: number; w: number }> => {
      const k = drop(f)
      const cam = cams[f - first] as Cam
      const qs: Array<{ x: number; y: number; w: number }> = []
      for (const u of SIGNS) for (const v of SIGNS) for (const z of [0, pt.z]) qs.push(project(cam, pt.x + e.x * k + (c * u * pt.w - sn * v * pt.h) / 2, pt.y + e.y * k + (sn * u * pt.w + c * v * pt.h) / 2, lift * k + z))
      return qs
    }
    const seen = (qs: Array<{ x: number; y: number; w: number }>): { share: number; cover: number } => {
      if (qs.some((q) => q.w <= 0)) return { share: 1, cover: 1 }
      const xs = qs.map((q) => q.x)
      const ys = qs.map((q) => q.y)
      const full = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
      const cx = Math.max(0, Math.min(1, Math.max(...xs)) - Math.max(-1, Math.min(...xs)))
      const cy = Math.max(0, Math.min(1, Math.max(...ys)) - Math.max(-1, Math.min(...ys)))
      return { share: full > 0 ? (cx * cy) / full : 0, cover: (cx * cy) / 4 }
    }
    const out = (qs: Array<{ x: number; y: number; w: number }>): boolean =>
      qs.every((q) => q.w > 0) && (qs.every((q) => q.x > 1 + ENTRY_MARGIN) || qs.every((q) => q.x < -1 - ENTRY_MARGIN) || qs.every((q) => q.y > 1 + ENTRY_MARGIN) || qs.every((q) => q.y < -1 - ENTRY_MARGIN))
    const rest = box(last, 0, { x: 0, y: 0 })
    const restCover = seen(rest).cover
    const centre = (qs: Array<{ x: number; y: number; w: number }>): Vec2 => ({ x: qs.reduce((a, q) => a + q.x, 0) / qs.length, y: qs.reduce((a, q) => a + q.y, 0) / qs.length })
    const home = centre(rest)
    const reach = 4 * (cams[0] as Cam).dist
    let best: { lift: number; enter: Vec2; fall: number; cost: number } | undefined
    for (const lift of [height, 2 * height, 4 * height]) {
      for (let a = 0; a < ENTRY_DIRS; a++) {
        const dir = { x: Math.cos((2 * Math.PI * a) / ENTRY_DIRS), y: Math.sin((2 * Math.PI * a) / ENTRY_DIRS) }
        const at = (d: number): Vec2 => ({ x: dir.x * d, y: dir.y * d })
        let lo = 0
        let hi = Math.max(pt.w, pt.h, 1)
        if (!out(box(first, lift, at(lo)))) {
          while (!out(box(first, lift, at(hi))) && hi < reach) hi *= 1.6
          if (hi >= reach) continue
          for (let i = 0; i < 20; i++) {
            const mid = (lo + hi) / 2
            if (out(box(first, lift, at(mid)))) hi = mid
            else lo = mid
          }
        } else hi = 0
        const enter = at(hi)
        let ok = true
        let share = -1
        let from: Vec2 | undefined
        for (let f = first; f <= last && ok; f++) {
          const qs = box(f, lift, enter)
          const v = seen(qs)
          if (v.cover > Math.max(ENTRY_COVER, restCover) && f < last) ok = false
          if (share < 0 && v.share > 1e-6) {
            share = v.share
            from = centre(qs)
            if (f > first && share > ENTRY_SLIVER) ok = false
          }
        }
        if (!ok) continue
        const travel = from === undefined ? 0 : Math.hypot((home.x - from.x) * aspect, home.y - from.y)
        const up = from === undefined ? 0 : Math.max(0, home.y - from.y) / Math.max(1e-6, Math.hypot((home.x - from.x) * aspect, home.y - from.y))
        const cost = travel * (1 + ENTRY_UP * up) + Math.max(0, share) + lift / (8 * height)
        if (best === undefined || cost < best.cost) best = { lift, enter, fall, cost }
      }
    }
    return best
  }
  const own = solve(pt.fall ?? DESCENT.hero)
  if (own !== undefined || (pt.fall ?? DESCENT.hero) >= B - 1e-9) return own
  return solve(B) ?? solve(2 * B)
}

/** the last pulse leaves the main chip on the second beat after the poster's revision (or its name) lands and reaches the end of the main chip's nets before the film's last ten frames */
/** part kinds that read bright on the poster */
const PALE = new Set<TracePart['kind']>(['pin', 'res', 'cap', 'xtal', 'led'])

/** the last pulse returns the main chip's nets outward over this long, and the poster holds at least this long after it */
export const PULSE_RETURN = 12 / 360
export const POSTER_HOLD = 15 / 360

function lastPulse(build: TitleBuild | undefined, layers: TraceLayer[], groups: TraceGroup[]): TraceScene['pulse'] {
  const landed = build?.version ?? build?.readable
  if (landed === undefined) return undefined
  const at = Math.ceil((landed + 2 * B) * 24 - 1e-6) / 24
  const span = PULSE_RETURN
  let reach = -1
  for (const layer of layers) for (let i = 0; i < layer.groups.length; i++) if (groups[layer.groups[i] as number]?.hero === true) reach = Math.max(reach, layer.energy[2 * i] as number, layer.energy[2 * i + 1] as number)
  return 1 - at >= span + POSTER_HOLD && reach >= 0 ? { at, span, reach } : undefined
}

/** the LED that blinks on a held ending: the last one to come on that stays on; the phase it came on names it */
export function liveLed(parts: TracePart[]): number | undefined {
  return parts.filter((p) => p.led !== undefined && p.led.at >= 0 && p.led.off === undefined).map((p) => p.led?.at ?? 0).sort((x, y) => y - x)[0]
}

/** a part's mesh as the renderer places it at rest, in plane px: nine numbers a triangle (x, y down, height) */
function drawnOf(pt: TracePart, meshes: PartMesh[]): Float32Array | undefined {
  const mesh = pt.mesh === undefined ? undefined : meshes[pt.mesh.id]
  if (pt.mesh === undefined || mesh === undefined) return undefined
  const raw = (b64: string): ArrayBuffer => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer
  const pos = new Float32Array(raw(mesh.pos))
  const idx = new Uint32Array(raw(mesh.idx))
  const [a0, a1, a2, a3] = pt.mesh.m
  const cx = (mesh.min[0] + mesh.max[0]) / 2
  const cy = (mesh.min[1] + mesh.max[1]) / 2
  const scale = Math.hypot(a0, a1)
  const out = new Float32Array(idx.length * 3)
  idx.forEach((v, i) => {
    const dx = (pos[3 * v] as number) - cx
    const dy = (pos[3 * v + 1] as number) - cy
    out.set([pt.x + a0 * dx + a2 * dy, pt.y + a1 * dx + a3 * dy, (pos[3 * v + 2] as number) * scale], 3 * i)
  })
  return out
}

export function markingAxis(pt: Pick<TracePart, 'w' | 'h' | 'rot'>): Vec2 {
  return pt.w >= pt.h ? { x: Math.cos(pt.rot), y: Math.sin(pt.rot) } : { x: -Math.sin(pt.rot), y: Math.cos(pt.rot) }
}

/** a value worth printing under the ref: a part number like ICE40HX8K-BG121, not a library name like Conn_01x02_Pin */
/** what the marking does not say: package and pin count, and the pitch, from the footprint's model name */
export function partNumber(value: string | undefined): string | undefined {
  const v = value?.trim() ?? ''
  if (!/^[A-Z0-9][A-Z0-9._+/-]{2,}$/i.test(v) || !/\d/.test(v) || !/[A-Z]/i.test(v)) return undefined
  if (v.includes('_') && /[a-z]/.test(v)) return undefined
  return v.length > 20 ? `${v.slice(0, 19)}…` : v
}

const LED_COLOURS: Array<[RegExp, string]> = [
  [/RED/, '#ff2a14'],
  [/GREEN|GRN/, '#2cff5a'],
  [/BLUE|BLU/, '#2f6bff'],
  [/YELLOW|YEL/, '#ffd22a'],
  [/AMBER|ORANGE|ORA/, '#ff8c1a'],
  [/PINK|PNK/, '#ff4f9a'],
  [/WHITE|WHT|WS28|SK68|APA10|RGB/, '#fff1e2']
]

/** an LED lights in the colour its value names; a crowd of LEDs shares its light, so a matrix stays a grid of points */
function ledLight(led: PartMm, leds: PartMm[]): { color: string; gain: number } {
  const value = (led.value ?? '').toUpperCase()
  const reach = 3 * Math.max(led.w, led.h)
  const near = leds.filter((o) => o !== led && Math.hypot(o.pos.x - led.pos.x, o.pos.y - led.pos.y) < reach).length
  return { color: LED_COLOURS.find(([re]) => re.test(value))?.[1] ?? '#ffb070', gain: 1 / Math.sqrt(1 + 0.5 * near) }
}

export interface ShotInput {
  /** the groups whose copper the ride follows and lights as it passes: power, supply and the hero's own nets */
  chase: Set<number>
  /** how far from the ride's course a group's copper lights as the ride passes, px; 0 when it does not */
  rideSide: (group: number) => number
  /** where the power-on's first pulses run: copper lit in its first 18 frames */
  ride: { first: Vec2[] }
  hero: Vec2
  /** hero body's long side, px */
  heroSize: number
  loops: FlatPath[]
  /** the tallest part, px */
  tallest: number
  /** every other body: x, y, height, long side, short side */
  bodies: Array<[number, number, number, number, number]>
  heroBox: Body
  /** how far the hero's pin rows reach, as a multiple of its box */
  heroReach: number
  blockers: Body[]
  /** the plane direction the hero's marking runs along, if it has one */
  heroMark: number | undefined
  solids: TracePart[]
  /** the parts that read bright on the poster: pins, chip passives, crystals and LEDs */
  pale: TracePart[]
  /** the supply's path from where power enters to the hero: plane px and the share of its length run so far */
  supply: Array<[number, number, number]>
  /** when the supply's light reaches the hero, when it came in along copper */
  powerAt: number | undefined
  /** when the supply's light leaves where power enters */
  powerFrom: number
  /** where the drawing starts when it is not the hero, in plane px: the opening looks there */
  openFrom: Vec2 | undefined
  /** the opening part's pad spread, in plane px */
  openSpan: number
  /** this board's acts: where the drawing ends, the coat runs and the place shot cuts in */
  acts: TraceActs
  /** the poster's words when the film is titled: the shared board name and revision (the user's flag, else the board's silk, else its title block) */
  named: { name: string; revision: string | undefined } | undefined
  thick: number
  mm: number
  /** the poster's first facts line: the hero part and its package, unless the title already names it */
  heroLine: string | undefined
  /** the plane directions the hero's marking and the largest silk text read along, either way round */
  marks: number[]
  /** the ride prefers a heading that reads that silk the right way up (montage's trailer keeps the course it had) */
  readSilk: boolean
  /** the trace film's own takes: montage's clone keeps the course and landings it had */
  own: boolean
}

/**
 * When each part lands, in film phase, and how long its fall takes. The hero lands last, alone, on the place act's
 * last frame. A second large chip lands a beat before it. Heavy connectors land after the crowd, slower. The crowd
 * lands first: big parts biggest first, then each row of one part as one sweep along the row, then the loose
 * passives in ripples out from the hero.
 */
function landings(parts: PartMm[], order: number[], heroSpan: number, acts: TraceActs, large: (i: number) => boolean, passive: (i: number) => boolean, cuts: ReturnType<typeof stageCuts>): { at: Map<number, { t: number; fall: number }>; row: number[] } {
  const out = new Map<number, { t: number; fall: number }>()
  const heroF = Math.round(acts.place[1] * 360)
  const placeF = Math.ceil(acts.place[0] * 360)
  const span = (i: number): number => Math.max((parts[i] as PartMm).w, (parts[i] as PartMm).h)
  const second = order.filter((i) => (parts[i] as PartMm).kind === 'ic' && span(i) >= SECOND_CHIP * heroSpan).sort((a, b) => span(b) - span(a))[0]
  const crowdFirst = cuts !== undefined
  const secondF = second === undefined ? heroF : heroF - (crowdFirst ? 16 : 12)
  if (second !== undefined) out.set(second, { t: secondF / 360, fall: DESCENT.hero })
  const heavy = order.filter((i) => i !== second && (parts[i] as PartMm).kind === 'conn' && span(i) >= HEAVY_CONN * heroSpan && (parts[i] as PartMm).z >= 2.5)
  const axisOf = (idx: number[]): Vec2 => {
    const c = mean(idx.map((i) => (parts[i] as PartMm).pos))
    let xx = 0
    let xy = 0
    let yy = 0
    for (const i of idx) {
      const d = { x: (parts[i] as PartMm).pos.x - c.x, y: (parts[i] as PartMm).pos.y - c.y }
      xx += d.x * d.x
      xy += d.x * d.y
      yy += d.y * d.y
    }
    const a = 0.5 * Math.atan2(2 * xy, xx - yy)
    return { x: Math.cos(a), y: Math.sin(a) }
  }
  const along = (idx: number[]): number[] => {
    const ax = axisOf(idx)
    return [...idx].sort((a, b) => ((parts[a] as PartMm).pos.x - (parts[b] as PartMm).pos.x) * ax.x + ((parts[a] as PartMm).pos.y - (parts[b] as PartMm).pos.y) * ax.y)
  }
  const heavyLast = secondF - 4
  const heavyFirst = Math.min(heavyLast, Math.max(placeF + 1 + DESCENT.heavy * 360, heavyLast - 2 * (heavy.length - 1)))
  along(heavy).forEach((i, k) => out.set(i, { t: Math.round(heavyFirst + ((heavyLast - heavyFirst) * k) / Math.max(1, heavy.length - 1)) / 360, fall: DESCENT.heavy }))
  const crowdEnd = secondF - (second === undefined ? 10 : 6)
  const rest = order.filter((i) => !out.has(i))
  const family = new Map<string, number[]>()
  for (const i of rest) {
    const pt = parts[i] as PartMm
    const key = `${pt.kind}|${pt.value ?? ''}|${pt.w.toFixed(1)}x${pt.h.toFixed(1)}`
    family.set(key, [...(family.get(key) ?? []), i])
  }
  const rows: number[][] = []
  for (const members of family.values()) {
    const left = new Set(members)
    while (left.size > 0) {
      const seed = left.values().next().value as number
      left.delete(seed)
      const group = [seed]
      for (let g = 0; g < group.length; g++) {
        const a = parts[group[g] as number] as PartMm
        for (const j of [...left]) {
          const b = parts[j] as PartMm
          if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) <= ROW_LINK * Math.max(a.w, a.h) + 1) {
            left.delete(j)
            group.push(j)
          }
        }
      }
      if (group.length >= 3) rows.push(along(group))
    }
  }
  const inRow = new Set(rows.flat())
  const bigs = rest.filter((i) => !inRow.has(i) && !passive(i)).sort((a, b) => (parts[b] as PartMm).w * (parts[b] as PartMm).h - (parts[a] as PartMm).w * (parts[a] as PartMm).h)
  const loose = rest.filter((i) => !inRow.has(i) && passive(i))
  const ripples = Array.from({ length: Math.ceil(loose.length / RIPPLE_ROW) }, (_, r) => loose.slice(r * RIPPLE_ROW, (r + 1) * RIPPLE_ROW))
  rows.sort((a, b) => span(b[0] as number) * b.length - span(a[0] as number) * a.length)
  const big = bigs.map((i) => ({ idx: [i], step: 0 }))
  const crowd = [...rows.map((idx) => ({ idx, step: Math.min(1.5, ROW_SWEEP / Math.max(1, idx.length - 1)) })), ...ripples.map((idx) => ({ idx, step: RIPPLE_STEP }))]
  const groups: Array<{ idx: number[]; step: number }> = crowdFirst ? crowd : [...big, ...crowd]
  const fallOf = (i: number): number => (large(i) ? DESCENT.large : DESCENT.small)
  const first = placeF + 1 + Math.round(DESCENT.small * 360)
  const sweep = Math.min(ROW_SWEEP, 0.4 * Math.max(0, crowdEnd - first))
  for (const g of groups) if (g.idx.length > 1 && g.step > 0) g.step = Math.min(g.step, sweep / (g.idx.length - 1))
  const lastSweep = Math.max(0, ...groups.map((g) => g.step * (g.idx.length - 1)))
  const wideF = Math.min(crowdEnd, Math.max(first, Math.round((cuts?.crane[1] ?? 0) * 360)))
  const room = Math.max(0, (crowdFirst ? Math.min(crowdEnd, Math.max(wideF, first + 15)) : crowdEnd) - first - lastSweep)
  groups.forEach((g, j) => {
    const start = first + room * Math.pow(j / Math.max(1, groups.length - 1), 0.8)
    g.idx.forEach((i, k) => out.set(i, { t: Math.round(Math.max(placeF + 1 + fallOf(i) * 360, start + g.step * k)) / 360, fall: fallOf(i) }))
  })
  if (cuts !== undefined) {
    big.forEach((g, j) => {
      for (const i of g.idx) out.set(i, { t: Math.round(wideF + ((crowdEnd - wideF) * j) / Math.max(1, big.length)) / 360, fall: fallOf(i) })
    })
    for (const [i, l] of out) {
      const at = Math.round(l.t * 360)
      const moved = [cuts.crane.map((t) => t * 360), [cuts.close * 360, cuts.close * 360]].find(([a, b]) => at - l.fall * 360 < (b as number) && at >= (a as number))
      if (moved === undefined) continue
      const from = moved[1] as number
      const t = Math.min(heroF - 1, Math.max(at, Math.ceil(from + DESCENT.small * 360)))
      out.set(i, { t: t / 360, fall: Math.min(l.fall, (t - from) / 360) })
    }
  }
  return { at: out, row: rows[0] ?? [] }
}

const mean = (pts: Vec2[]): Vec2 => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length })

function mixHex(a: string, b: string, t: number): string {
  const c = (h: string, i: number): number => Number.parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
  return `#${[0, 1, 2].map((i) => Math.round(c(a, i) + (c(b, i) - c(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Boards that fill the frame get a gentle whole-film push. Boards that leave
 * it mostly empty (a 1:3 board in 4:5, a square board in 9:16) punch in on the
 * hero, ride the growth front at a zoom that fills the frame, then pull back
 * to the whole board for the hold — the reveal.
 */
function cameraTrack(
  bbox: BBox,
  resolved: ResolvedConfig,
  map: (p: Vec2) => Vec2,
  layers: TraceLayer[],
  origin: { x: number; y: number }
): CameraKey[] {
  const W = resolved.width
  const H = resolved.height
  const corners = [bbox.min, { x: bbox.max.x, y: bbox.min.y }, bbox.max, { x: bbox.min.x, y: bbox.max.y }].map(map)
  const bx0 = Math.min(...corners.map((c) => c.x))
  const bx1 = Math.max(...corners.map((c) => c.x))
  const by0 = Math.min(...corners.map((c) => c.y))
  const by1 = Math.max(...corners.map((c) => c.y))
  const safe = safeArea(W, H, resolved.title !== undefined)
  const fill = ((bx1 - bx0) * (by1 - by0)) / (safe.w * safe.h)
  const home = { cx: W / 2, cy: H / 2 }
  if (fill >= 0.55) return [{ t: 0, ...home, zoom: 1 }, { t: 1, ...home, zoom: 1.05 }]
  const zoom = Math.min(2.2, Math.max(1, 1 / Math.sqrt(fill)))
  const m = 0.04 * Math.min(W, H)
  // keep the zoomed window over the board (plus margin) on each axis
  const clampAxis = (c: number, lo: number, hi: number, half: number): number =>
    hi - lo + 2 * m <= 2 * half ? (lo + hi) / 2 : Math.min(hi + m - half, Math.max(lo - m + half, c))
  const clampKey = (cx: number, cy: number): { cx: number; cy: number } => ({
    cx: clampAxis(cx, bx0, bx1, W / 2 / zoom),
    cy: clampAxis(cy, by0, by1, H / 2 / zoom)
  })
  const [g0, g1] = TRACE_BEATS.growth
  const STEP = 0.04
  const fronts: Array<{ t: number; x: number; y: number }> = []
  let last = { x: origin.x, y: origin.y }
  for (let t = g0; t < g1 - 1e-9; t += STEP) {
    let sx = 0
    let sy = 0
    let n = 0
    for (const layer of layers) {
      const segs = layer.segs
      for (let o = 0; o < segs.length; o += 7) {
        const t0 = segs[o + 5] as number
        if (t0 < t || t0 >= t + STEP) continue
        sx += ((segs[o] as number) + (segs[o + 2] as number)) / 2
        sy += ((segs[o + 1] as number) + (segs[o + 3] as number)) / 2
        n += 1
      }
    }
    if (n > 0) last = { x: sx / n, y: sy / n }
    fronts.push({ t: t + STEP / 2, ...last })
  }
  const smooth = fronts.map((f, i) => {
    const w = fronts.slice(Math.max(0, i - 2), i + 3)
    return { t: f.t, x: w.reduce((a, b) => a + b.x, 0) / w.length, y: w.reduce((a, b) => a + b.y, 0) / w.length }
  })
  return [
    { t: 0, ...home, zoom: 1 },
    { t: TRACE_BEATS.outline[0] + 0.07, ...home, zoom: 1 },
    { t: TRACE_BEATS.pads[0] + 0.07, ...clampKey(origin.x, origin.y), zoom },
    ...smooth.filter((f) => f.t > TRACE_BEATS.pads[0] + 0.07 && f.t < g1 - 0.02).map((f) => ({ t: f.t, ...clampKey(f.x, f.y), zoom })),
    { t: g1, ...clampKey(last.x, last.y), zoom },
    // the reveal lands before zones/silk finish so the whole board holds ≥1.5s
    { t: 0.8, ...home, zoom: 1 },
    { t: 1, ...home, zoom: 1.03 }
  ]
}

function meanY(path: FlatPath): number {
  let sum = 0
  for (let i = 1; i < path.length; i += 2) sum += path[i] as number
  return sum / Math.max(1, path.length / 2)
}
