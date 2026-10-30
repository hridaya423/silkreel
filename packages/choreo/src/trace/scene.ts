import type { BBox, BoardModel, Pad, Vec2 } from '@silk-reel/ingest'
import { fitBoard, safeArea } from '../layout'
import type { ResolvedConfig } from '../config'
import type {
  CameraKey, CameraShot, FlatPath, TraceActs, TraceBeats, TraceCallout, TraceGroup, TraceLayer, TraceMaterial,
  PartBodies, PartMesh, TracePad, TracePart, TraceScene, TraceText, TraceVia, TraceZone, TimelineWarning
} from '../types'
import { makeRng } from '../rng'
import { fitZoom } from './camera'
import { growthSchedule } from './graph'
import type { GraphLink, GraphSeg, GraphSeed } from './graph'
import { DEMO_MASKS } from '../hints'
import { pickHero } from './hero'
import { groupNets } from './nets'
import { extractParts } from './parts'
import type { PartMm } from './parts'
import type { NetKind } from './nets'

const B = 1 / 24

/**
 * The score, on a grid of 24 beats. Drawing: seen from above, copper routes
 * out from the hero and the pours fill. Object: the camera tilts down while
 * the mask coats and the silk prints; parts sit on wet paste until the
 * reflow front snaps them square. Alive: first power-on. The rails fill,
 * the clock starts, data runs. Hold: the running board.
 */
export const TRACE_ACTS: TraceActs = {
  draw: [0, 5.5 * B],
  pour: [5 * B, 6.5 * B],
  mask: [6.5 * B, 9.5 * B],
  silk: [9 * B, 10.5 * B],
  place: [10 * B, 13.5 * B],
  reflow: [13.5 * B, 15 * B],
  power: [16 * B, 22 * B],
  hold: [22 * B, 24 * B]
}

/** the flat fallback renderer still reads beats; they follow the acts */
const TRACE_BEATS: TraceBeats = {
  outline: [0, B],
  pads: [0, B],
  growth: TRACE_ACTS.draw,
  zones: TRACE_ACTS.pour,
  silk: TRACE_ACTS.silk,
  // the title card arrives with the poster cut; the film ends on the held poster
  hold: [20 * B, 1]
}

/** when each role's energy first crosses it after power-on; ground stays dark */
const ROLE_TIME: Record<NetKind, { start: [number, number]; d: [number, number] } | undefined> = {
  power: { start: [16 * B, 16.5 * B], d: [1 * B, 1.5 * B] },
  clock: { start: [17 * B, 17 * B], d: [0.5 * B, 0.5 * B] },
  bus: { start: [18 * B, 19 * B], d: [1 * B, 1.5 * B] },
  diff: { start: [18 * B, 19.5 * B], d: [0.75 * B, 1 * B] },
  signal: { start: [18.5 * B, 21 * B], d: [0.75 * B, 1.5 * B] },
  ground: undefined
}

const MASK_ALBEDO: Record<string, string> = {
  green: '#0d3b22', black: '#0c0d0e', white: '#d8dbd4', blue: '#0f2a5c', red: '#5c1015',
  yellow: '#b79a16', purple: '#3a1a55', matte: '#121314'
}
const FINISH: Record<string, { albedo: string; rough: number }> = {
  enig: { albedo: '#e3bb6c', rough: 0.18 },
  'enepig': { albedo: '#e3bb6c', rough: 0.18 },
  hal: { albedo: '#d4d8dc', rough: 0.34 },
  'immersion silver': { albedo: '#dfe3e6', rough: 0.2 },
  'immersion tin': { albedo: '#c9cdd1', rough: 0.3 }
}

const DEG = Math.PI / 180
/** wrap a text rotation into (−π/2, π/2] — text reads the same upside-down */
const upright = (r: number): number => {
  const m = ((r % Math.PI) + Math.PI) % Math.PI
  return m > Math.PI / 2 ? m - Math.PI : m
}
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

const padShape = (pad: Pad): TracePad['shape'] => {
  const w = pad.size.x
  const h = pad.size.y
  if (pad.shape === 'circle' || (pad.shape === 'oval' && Math.abs(w - h) < 0.01 * Math.max(w, h))) return 'circle'
  if (pad.shape === 'roundrect' || pad.shape === 'oval') return 'round'
  return 'rect'
}

/**
 * what reads as the board: its outline plus copper and part bodies hanging
 * past it (edge connectors). board.bbox also counts silk text and footprint
 * origins floating off the edge, which shrank boards like StickHub by ~30%
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

export function buildTraceScene(board: BoardModel, resolved: ResolvedConfig, seed: number, bodies?: PartBodies): { scene: TraceScene; warnings: TimelineWarning[] } {
  const beats = TRACE_BEATS
  const acts = TRACE_ACTS
  const box = contentBox(board)
  const fit = fitBoard(box, resolved.width, resolved.height, resolved.title !== undefined)
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
  const md = Math.max(1e-9, g.maxDist)

  const { groups: netGroups, groupOf } = groupNets(board.nets)
  const segGroup = segNet.map((n) => (n === undefined ? -1 : (groupOf.get(n) ?? -1)))
  const sched = scheduleEnergy(netGroups.map((ng) => ng.kind), segLen, segNet, segGroup, g.start, md, seed)

  // the routing: a wavefront out of the hero's pins, in even work per beat
  const [d0, d1] = acts.draw
  const byStart = segs.map((_, i) => i).sort((a, b) => (g.start[a] as number) - (g.start[b] as number))
  const rank = new Map(byStart.map((segIdx, r) => [segIdx, r / Math.max(1, byStart.length - 1)]))

  const rowsByLayer = new Map<string, { side: Side; rows: number[][] }>()
  const segT0 = new Array<number>(segs.length)
  segs.forEach((s, i) => {
    const side = sideAt(s.layer)
    const u = 0.5 * (rank.get(i) ?? 0) + 0.5 * Math.min(1, (g.start[i] as number) / md)
    const t0 = d0 + u * (d1 - d0) * 0.88
    const t1 = Math.min(d1, t0 + Math.max(0.003, Math.pow((segLen[i] as number) / md, 0.85) * (d1 - d0) * 0.45))
    segT0[i] = t0
    const ends = g.flipped[i] === true ? [s.b, s.a] : [s.a, s.b]
    const a = map(ends[0] as Vec2)
    const b = map(ends[1] as Vec2)
    let rec = rowsByLayer.get(s.layer)
    if (rec === undefined) {
      rec = { side, rows: [] }
      rowsByLayer.set(s.layer, rec)
    }
    const e = sched.segTime[i] ?? [-1, -1]
    rec.rows.push([a.x, a.y, b.x, b.y, Math.max(0.9, s.width * fit.scale), t0, t1, segGroup[i] as number, e[0], e[1]])
  })
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
        energy: rows.flatMap((r) => [r[8] as number, r[9] as number])
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

  // the parts are placed before the routing starts: every pad is there from the first frame
  // mounting holes sit in copper layers but are really drills — plated:false
  // marks them; oversized pads draw as rings either way so they never blob
  const npth = board.drill.filter((d) => !d.plated)
  const drillOnly = (pad: Pad): boolean =>
    npth.some((d) => Math.hypot(d.pos.x - pad.pos.x, d.pos.y - pad.pos.y) < 0.05)
  const pxMin = Math.min(resolved.width, resolved.height)
  const pads: TracePad[] = []
  for (const { pad, sides } of padLayerSets.values()) {
    const m = map(pad.pos)
    pads.push({
      x: m.x,
      y: m.y,
      w: Math.max(1.5, pad.size.x * fit.scale),
      h: Math.max(1.5, pad.size.y * fit.scale),
      rot: (back ? -pad.rot : pad.rot) * DEG + (fit.rotated ? Math.PI / 2 : 0),
      shape: padShape(pad),
      t: 0,
      side: sides.size > 1 ? 'both' : ([...sides][0] === 'F' ? 'F' : 'B'),
      ring:
        Math.min(pad.size.x, pad.size.y) * fit.scale > 0.03 * pxMin ||
        drillOnly(pad)
    })
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
        const lt = g.linkTime[linkVia.get(via.id) ?? -1] ?? Infinity
        t = Number.isFinite(lt) ? d0 + Math.min(1, lt / md) * (d1 - d0) * 0.9 : d0
      }
      const m = map(via.pos)
      vias.push({ x: m.x, y: m.y, r: Math.max(0.9, (via.dia / 2) * fit.scale), t })
    }
  }
  vias.sort((a, b) => a.t - b.t)

  // pours fill once the routing is done, outward from the hero; a power pour glows at power-on
  const [z0, z1] = acts.pour
  const zoneSpans: Array<{ layer: Side; pts: Vec2[]; d: number; group: number }> = []
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
        zoneSpans.push({ layer: sideAt(layerId), pts: fill, d, group: gi })
      }
    }
  }
  const zones: TraceZone[] = zoneSpans.map((z) => {
    const path = flat(z.pts, map)
    path.push(path[0] as number, path[1] as number)
    const t0 = z0 + (z.d / zoneDMax) * (z1 - z0) * 0.5
    const grp = sched.groups[z.group]
    const lit = grp !== undefined && grp.kind === 'power' && grp.t >= 0
    return { fill: path, side: z.layer, t0, t1: t0 + (z1 - z0) * 0.5, e0: lit ? grp.t + grp.d * 0.5 : -1 }
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
          // keep text upright: rot is mod π so a flipped board never draws it upside-down
          rot: upright((back ? -text.rot : text.rot) * DEG + (fit.rotated ? Math.PI / 2 : 0)),
          t: 0
        }
      })
    }
  }
  textRaw.sort((a, b) => a.y - b.y)
  const texts = textRaw.map((t, i) => ({
    ...t.text,
    t: s0 + 0.01 + (textRaw.length > 1 ? (i / (textRaw.length - 1)) * (s1 - s0 - 0.03) : 0)
  }))

  const drills = board.drill.map((d) => {
    const m = map(d.pos)
    return { x: m.x, y: m.y, r: Math.max(0.8, (d.dia / 2) * fit.scale) }
  })

  const origin = hero !== undefined ? map(hero.center) : { x: resolved.width / 2, y: resolved.height / 2 }
  const warnings: TimelineWarning[] = []
  if (segs.length === 0) warnings.push({ code: 'trace-no-copper', message: 'board has no copper segments to grow' })
  if (hero === undefined) warnings.push({ code: 'trace-no-hero', message: 'no hero footprint; growth ordered from board center' })

  // --- parts: set down on wet paste outward from the hero, then snapped square as the reflow front passes
  const loopsPx = boardLoops(board).map((loop) => flat(loop, map))
  const xs = loopsPx.flatMap((l) => l.filter((_, i) => i % 2 === 0))
  const bx0 = Math.min(...xs)
  const bx1 = Math.max(...xs)
  const rotOf = (deg: number): number => (back ? -deg : deg) * DEG + (fit.rotated ? Math.PI / 2 : 0)
  const partsMm = extractParts(board).filter((pt) => pt.back === back)
  const heroPart = partsMm.find((pt) => pt.ref === hero?.ref)
  const dists = partsMm.map((pt) => Math.hypot(pt.pos.x - originMm.x, pt.pos.y - originMm.y))
  const order = partsMm.map((_, i) => i).filter((i) => partsMm[i] !== heroPart).sort((a, b) => (dists[a] as number) - (dists[b] as number))
  const rankOf = new Map(order.map((idx, r) => [idx, r / Math.max(1, order.length - 1)]))
  const [pl0, pl1] = acts.place
  const [rf0, rf1] = acts.reflow
  const prng = makeRng(seed, 'trace-paste')
  const leds = partsMm.filter((pt) => pt.kind === 'led')
  const footprintOf = new Map(board.footprints.map((fp) => [fp.ref, fp]))
  const meshes: PartMesh[] = []
  const meshIds = new Map<number, number>()
  const parts: TracePart[] = partsMm.flatMap((pt, i) => {
    const isHero = pt === heroPart
    const label = pt.kind === 'ic' && pt.value !== undefined ? pt.value.replace(/_/g, '-').toUpperCase().slice(0, 22) : undefined
    const fp = footprintOf.get(pt.ref)
    const source = bodies?.byRef[pt.ref]
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
    const off = (isHero ? 0.05 : 0.14) * Math.min(w, h)
    const t = isHero ? pl0 + 0.75 * B : pl0 + 1.5 * B + (rankOf.get(i) ?? 0) * (pl1 - pl0 - 1.5 * B)
    const settle = rf0 + Math.min(1, Math.max(0, (m.x - bx0) / Math.max(1, bx1 - bx0))) * (rf1 - rf0 - 0.5 * B)
    const skew: [number, number, number] = [prng.range(-off, off), prng.range(-off, off), prng.range(-1, 1) * (isHero ? 1.5 : 5) * DEG]
    const body: TracePart = {
      x: m.x, y: m.y, w, h, rot: rotOf(pt.rot), z,
      kind: pt.kind,
      t,
      settle,
      // through-hole pins hold a header square: it never floats on the paste
      skew: pt.pins === undefined ? skew : [0, 0, 0],
      label,
      pitch: pt.kind === 'conn' && pt.pitch > 0 ? pt.pitch * fit.scale : undefined,
      led: pt.kind === 'led' ? ledLight(pt, leds) : undefined,
      hero: isHero,
      mesh: solid
    }
    const pinW = 0.64 * (pt.pinZ ?? 0) / 8.5 * fit.scale
    return [body, ...(solid === undefined ? pt.pins ?? [] : []).map((pin): TracePart => ({
      ...map(pin), w: pinW, h: pinW, rot: body.rot, z: (pt.pinZ ?? 0) * fit.scale, kind: 'pin', t, settle, skew: [0, 0, 0], seat: body.z
    }))]
  })

  const callouts: TraceCallout[] = []
  const heroBody = parts.find((pt) => pt.hero === true)
  if (hero !== undefined && heroBody !== undefined) {
    const value = board.footprints.find((f) => f.ref === hero.ref)?.value
    callouts.push({ t0: heroBody.t + 0.5 * B, t1: rf1 - 0.002, x: origin.x, y: origin.y, text: hero.ref, sub: partNumber(value) })
  }

  const minWH = Math.min(resolved.width, resolved.height)
  return {
    scene: {
      outline,
      layers,
      pads,
      vias,
      drills,
      zones,
      silkStrokes,
      texts,
      origin,
      camera: cameraTrack(box, resolved, map, layers, origin),
      beats,
      groups: sched.groups,
      board: loopsPx,
      material: material(board, resolved, fit.scale),
      shots: shotList(resolved, {
        hero: origin,
        heroSize: heroPart === undefined ? 0.08 * minWH : Math.max(heroPart.w, heroPart.h) * fit.scale,
        loops: loopsPx,
        tallest: Math.max(0, ...parts.map((pt) => pt.z))
      }),
      acts,
      parts,
      meshes,
      callouts
    },
    warnings
  }
}

interface Schedule {
  groups: TraceGroup[]
  /** per seg its energy window [e0, e1], undefined while it stays dark */
  segTime: Array<[number, number] | undefined>
}

/**
 * First power-on, by role. Each casting unit gets one start and duration
 * from its role's window, ordered outward from the hero. Inside a unit every
 * net is normalised to that window, so a bus's members leave together and
 * arrive together however long each runs: length-matched lines land on the
 * same frame, which is what the designer built them for. Ground stays dark,
 * and only some lone signals carry light, so the board never glitters.
 */
function scheduleEnergy(
  kinds: NetKind[],
  segLen: number[],
  segNet: Array<number | undefined>,
  segGroup: number[],
  start: number[],
  md: number,
  seed: number
): Schedule {
  const netMin = new Map<number, number>()
  const netMax = new Map<number, number>()
  const gMin = new Array<number>(kinds.length).fill(Infinity)
  const gMax = new Array<number>(kinds.length).fill(-Infinity)
  const gSegs = new Array<number>(kinds.length).fill(0)
  segGroup.forEach((gi, i) => {
    const net = segNet[i]
    if (net === undefined || gi < 0) return
    const a = start[i] as number
    const b = a + (segLen[i] as number)
    netMin.set(net, Math.min(netMin.get(net) ?? Infinity, a))
    netMax.set(net, Math.max(netMax.get(net) ?? -Infinity, b))
    gMin[gi] = Math.min(gMin[gi] as number, a)
    gMax[gi] = Math.max(gMax[gi] as number, b)
    gSegs[gi] = (gSegs[gi] as number) + 1
  })

  const rng = makeRng(seed, 'trace-pulses')
  const groups: TraceGroup[] = kinds.map((kind) => ({ kind, t: -1, d: 0, pulses: [], pulseSpeed: 1 }))
  const snap = (t: number, q: number): number => Math.round(t / q) * q
  for (const kind of Object.keys(ROLE_TIME) as NetKind[]) {
    const role = ROLE_TIME[kind]
    if (role === undefined) continue
    const mine = [...kinds.keys()].filter((i) => kinds[i] === kind && (gSegs[i] as number) > 0)
      .sort((a, b) => (gMin[a] as number) - (gMin[b] as number))
    const { start: [s0, s1], d: [d0, d1] } = role
    // a busy board lights a third of its lone signals; a small one lights them all
    const share = kind === 'signal' ? Math.min(1, Math.max(0.3, 40 / Math.max(1, mine.length))) : 1
    mine.forEach((gi, r) => {
      if (rng.next() > share) return
      const u = 0.6 * (mine.length > 1 ? r / (mine.length - 1) : 0) + 0.4 * Math.min(1, (gMin[gi] as number) / md)
      const span = (gMax[gi] as number) - (gMin[gi] as number)
      const d = d0 + (d1 - d0) * Math.min(1, span / (0.6 * md))
      const t = Math.min(snap(s0 + u * (s1 - s0), B / 2), TRACE_ACTS.power[1] - d)
      const grp = groups[gi] as TraceGroup
      grp.t = t
      grp.d = d
      const done = t + d
      if (kind === 'clock') {
        grp.pulseSpeed = 2
        for (let p = snap(done + B / 2, B); p < 1 - B; p += B) grp.pulses.push(p)
      } else if (kind === 'bus') {
        // every bus fires on the same beats: the board breathes in time
        grp.pulseSpeed = 1.4
        for (const p of [19, 20, 21, 22, 23].map((b) => b * B)) if (p > done + B / 2) grp.pulses.push(p)
      } else if (kind === 'diff') {
        grp.pulseSpeed = 1.5
        for (let p = snap(done + B, B); p < 1 - B; p += 2 * B) grp.pulses.push(p)
      } else if (kind === 'signal' && share > 0.6) {
        grp.pulseSpeed = 1.2
        const p = snap(rng.range(Math.max(done + B, 19 * B), 23 * B), B / 2)
        if (p > done + B / 2 && p < 1 - B) grp.pulses.push(p)
      }
    })
  }

  const segTime = segGroup.map((gi, i): [number, number] | undefined => {
    const net = segNet[i]
    const grp = groups[gi]
    if (net === undefined || grp === undefined || grp.t < 0) return undefined
    const lo = netMin.get(net) as number
    const span = Math.max(1e-6, (netMax.get(net) as number) - lo)
    const a = ((start[i] as number) - lo) / span
    const b = ((start[i] as number) + (segLen[i] as number) - lo) / span
    return [grp.t + a * grp.d, grp.t + Math.min(1, b) * grp.d]
  })
  return { groups, segTime }
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

/** the board's own mask and finish under the copper palette; the stylised palettes tint them */
function material(board: BoardModel, resolved: ResolvedConfig, pxPerMm: number): TraceMaterial {
  const palette = resolved.palette
  const trueColour = palette.copper === '#d08a4c'
  // a board that declares no colour is most likely the fab's default green
  const mask = resolved.mask ?? board.stackup.maskColor?.toLowerCase() ?? DEMO_MASKS[board.source.boardName] ?? 'green'
  const finishKey = board.stackup.finish?.toLowerCase() ?? ''
  const finish = Object.entries(FINISH).find(([k]) => finishKey.startsWith(k))?.[1]
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
    energyWarm: trueColour ? '#ffc98a' : palette.head,
    energyCool: trueColour ? '#9fd6ff' : mixHex(palette.head, palette.silk, 0.5),
    pxPerMm,
    thicknessPx: board.stackup.thickness * pxPerMm
  }
}

function luma(hex: string): number {
  const c = (i: number): number => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255
  return 0.2126 * c(0) + 0.7152 * c(1) + 0.0722 * c(2)
}

/** a value worth printing under the ref: a part number like ICE40HX8K-BG121, not a library name like Conn_01x02_Pin */
export function partNumber(value: string | undefined): string | undefined {
  const v = value?.trim() ?? ''
  if (!/^[A-Z0-9][A-Z0-9.+/-]{2,}$/i.test(v) || !/\d/.test(v) || !/[A-Z]/i.test(v)) return undefined
  return v.length > 20 ? `${v.slice(0, 19)}…` : v
}

const LED_COLOURS: Array<[RegExp, string]> = [
  [/RED/, '#ff2a14'],
  [/GREEN|GRN/, '#2cff5a'],
  [/BLUE|BLU/, '#2f6bff'],
  [/YELLOW|YEL/, '#ffd22a'],
  [/AMBER|ORANGE/, '#ff8c1a'],
  [/WHITE|WHT|WS28|SK68|APA10|RGB/, '#fff1e2']
]

/** an LED lights in the colour its value names; a crowd of LEDs shares its light, so a matrix stays a grid of points */
function ledLight(led: PartMm, leds: PartMm[]): { color: string; gain: number } {
  const value = (led.value ?? '').toUpperCase()
  const reach = 3 * Math.max(led.w, led.h)
  const near = leds.filter((o) => o !== led && Math.hypot(o.pos.x - led.pos.x, o.pos.y - led.pos.y) < reach).length
  return { color: LED_COLOURS.find(([re]) => re.test(value))?.[1] ?? '#ffb070', gain: 1 / Math.sqrt(1 + 0.5 * near) }
}

interface ShotInput {
  hero: Vec2
  /** hero body's long side, px */
  heroSize: number
  loops: FlatPath[]
  /** the tallest part, px */
  tallest: number
}

/**
 * Four shots, cut on the beat grid.
 *  1 plan   — straight down on the hero's footprint while the routing leaves
 *             it, pulling back to the whole board, then tilting down into a
 *             three-quarter as the mask coats: the drawing becomes an object
 *  2 bench  — low and close on the hero: parts set down, the reflow snap
 *  3 alive  — the held breath, then power-on, close on the hero's half of the
 *             board under a slow arc, so the first light reads on a phone
 *  4 poster — cut wide to the other side on the bar: the whole running board,
 *             a slow push, held to the last frame
 * Every framing is solved against the board's real extent, so long boards
 * and tall frames fill the shot instead of floating in it.
 */
function shotList(resolved: ResolvedConfig, si: ShotInput): CameraShot[] {
  const D = Math.PI / 180
  const W = resolved.width
  const H = resolved.height
  const a = TRACE_ACTS
  const safe = safeArea(W, H, true)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const loop of si.loops) {
    for (let i = 0; i + 1 < loop.length; i += 2) {
      x0 = Math.min(x0, loop[i] as number)
      x1 = Math.max(x1, loop[i] as number)
      y0 = Math.min(y0, loop[i + 1] as number)
      y1 = Math.max(y1, loop[i + 1] as number)
    }
  }
  const mid = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
  const corners = (z: number): Array<[number, number, number]> => [[x0, y0, z], [x1, y0, z], [x0, y1, z], [x1, y1, z]]
  const boardPts = [...corners(0), ...corners(si.tallest)]
  // a board much longer than the frame lies on the diagonal for its hero shot
  const bAspect = (x1 - x0) / Math.max(1, y1 - y0)
  const fAspect = W / H
  const skew = Math.abs(Math.log(bAspect / fAspect))
  const heroYaw = (skew > 0.9 ? 30 : 18) * D * (bAspect > fAspect ? 1 : -1)
  const fit = (shot: Omit<CameraShot, 't' | 'zoom' | 'cut'>, m = 1): number =>
    fitZoom(shot, boardPts, W, H, 0.84 * m, (shot.shift === undefined ? 0.8 : 0.8 - shot.shift) * m)
  // with a title card, the held shots frame the board above its band: a lens shift, not a tilt
  const band = resolved.title === undefined ? 0 : (H - (safe.y + safe.h)) / H
  const shift = band > 0 ? band - 0.01 : undefined

  const macro = Math.min(6, Math.max(1.6, (0.34 * Math.min(W, H)) / Math.max(1, si.heroSize)))
  const plan = { ...mid, tilt: 0.5 * D, yaw: 6 * D, aperture: 0.02 }
  const tilted = { ...mid, tilt: 40 * D, yaw: heroYaw * 0.8, aperture: 0.05 }
  const bench0 = { ...si.hero, tilt: 60 * D, yaw: -26 * D, aperture: 0.7 }
  const bench1 = { ...si.hero, tilt: 57 * D, yaw: -16 * D, aperture: 0.7 }
  const wide = { ...mid, tilt: 38 * D, yaw: heroYaw, aperture: 0.05, shift }
  const poster = { ...mid, tilt: 34 * D, yaw: -heroYaw * 0.7, aperture: 0.04, shift }
  const benchZoom = Math.min(4, Math.max(1.4, macro * 0.55))
  // power-on frames the hero's half of the board; a long board is a thin strip, so closer still
  const long = Math.max(bAspect, 1 / bAspect) > 2.2
  const alive = { ...wide, x: (mid.x + si.hero.x) / 2, y: (mid.y + si.hero.y) / 2 }
  const aliveZoom = fit(wide, 1.02) * (long ? 1.6 : 1.4)
  return [
    { t: 0, ...si.hero, zoom: macro, tilt: 0.5 * D, yaw: -4 * D, aperture: 0.02 },
    { t: a.draw[1], ...plan, zoom: fit(plan, 1.04) },
    { t: a.place[0] - 0.001, ...tilted, zoom: fit(tilted, 1.04) },
    { t: a.place[0], ...bench0, zoom: benchZoom, cut: true },
    { t: a.reflow[1] - 0.001, ...bench1, zoom: benchZoom * 1.12 },
    { t: a.reflow[1], ...alive, zoom: aliveZoom, cut: true },
    { t: 20 / 24 - 0.001, ...alive, yaw: heroYaw * 0.75, zoom: aliveZoom * 1.04 },
    { t: 20 / 24, ...poster, zoom: fit(poster, 1.0) * 1.02, cut: true },
    { t: 1, ...poster, yaw: poster.yaw * 0.85, zoom: fit(poster, 1.0) * 1.08 }
  ]
}

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
