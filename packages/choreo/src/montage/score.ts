import type { BoardModel, Vec2 } from '@silk-reel/ingest'
import type { ResolvedConfig } from '../config'
import { planDuration } from '../config'
import { boardFacts } from '../trace/facts'
import { boardCharacter } from '../trace/archetype'
import { pickHero } from '../trace/hero'
import { buildTraceScene } from '../trace/scene'
import type { PartBodies, Timeline, TimelineWarning, TraceScene } from '../types'
import { easeInOut, easeOut, smooth, span01 } from './ease'
import { FAN_START, LIT, NAME_BEAT, fanSpan, layHits } from './hits'
import type { Tell } from './hits'
import { extractParts } from '../trace/parts'
import { hypeCut } from './hype'
import { apply, boardTells, boardToScene, chooseDot, chooseRoute, fanRoutes, filmInk, filmWords, heroLabel, heroPins, layerLabels, nearestNode, netGraphs, placeDot, walkNet } from './facts'
import type { MontageBox, MontageEvent, MontageFact, MontageHit, MontagePulse, MontageScore, MontageShot, MontageShotKind, MontageRect, MontageView, MontageWeight, MontageWord } from './types'

export const DOT_SHARE = 0.05
export const FIELD_DENSITY = 8

export function viewPoint(v: MontageView, x: number, y: number, W: number, H: number): { x: number; y: number } {
  const dx = (x - v.cx) * v.k
  const dy = (y - v.cy) * v.k
  const c = Math.cos(v.rot)
  const s = Math.sin(v.rot)
  return { x: c * dx - s * dy + W / 2, y: s * dx + c * dy + H / 2 }
}

export function anchored(x: number, y: number, k: number, rot: number, at: { x: number; y: number }, W: number, H: number): MontageView {
  const dx = at.x - W / 2
  const dy = at.y - H / 2
  const c = Math.cos(-rot)
  const s = Math.sin(-rot)
  return { cx: x - (c * dx - s * dy) / k, cy: y - (s * dx + c * dy) / k, k, rot }
}

export function boardShare(v: MontageView, b: MontageBox, W: number, H: number): number {
  const a = viewPoint(v, b.x0, b.y0, W, H)
  const z = viewPoint(v, b.x1, b.y1, W, H)
  const w = Math.max(0, Math.min(W, Math.max(a.x, z.x)) - Math.max(0, Math.min(a.x, z.x)))
  const h = Math.max(0, Math.min(H, Math.max(a.y, z.y)) - Math.max(0, Math.min(a.y, z.y)))
  return (w * h) / (W * H)
}

export function zoomPath(a: MontageView, b: MontageView, x: number, y: number, u: number, W: number, H: number): MontageView {
  const k = Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * u)
  const pa = viewPoint(a, x, y, W, H)
  const pb = viewPoint(b, x, y, W, H)
  return anchored(x, y, k, b.rot, { x: pa.x + (pb.x - pa.x) * u, y: pa.y + (pb.y - pa.y) * u }, W, H)
}

export function along(path: number[], d: number): { x: number; y: number; a: number } {
  let left = Math.max(0, d)
  for (let i = 2; i < path.length; i += 2) {
    const ax = path[i - 2] as number
    const ay = path[i - 1] as number
    const bx = path[i] as number
    const by = path[i + 1] as number
    const l = Math.hypot(bx - ax, by - ay)
    if (left <= l || i + 2 >= path.length) {
      const u = Math.min(1, left / Math.max(1e-9, l))
      return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, a: Math.atan2(by - ay, bx - ax) }
    }
    left -= l
  }
  return { x: path[0] as number, y: path[1] as number, a: 0 }
}

export const pathLength = (f: number[]): number => {
  let l = 0
  for (let i = 2; i < f.length; i += 2) l += Math.hypot((f[i] as number) - (f[i - 2] as number), (f[i + 1] as number) - (f[i - 1] as number))
  return l
}

export function shotOf(m: MontageScore, kind: MontageShotKind, index = 0): MontageShot | undefined {
  return m.shots.find((s) => s.kind === kind && (s.index ?? 0) === index)
}

export function montageShot(m: MontageScore, frame: number): MontageShot {
  return m.shots.find((s) => frame >= s.f0 && frame < s.f1) ?? (m.shots.at(-1) as MontageShot)
}

const wrap = (a: number): number => a - 2 * Math.PI * Math.round(a / (2 * Math.PI))

export function swing(a: MontageView, b: MontageView, x: number, y: number, u: number, W: number, H: number): MontageView {
  const k = Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * u)
  const pa = viewPoint(a, x, y, W, H)
  const pb = viewPoint(b, x, y, W, H)
  return anchored(x, y, k, a.rot + wrap(b.rot - a.rot) * u, { x: pa.x + (pb.x - pa.x) * u, y: pa.y + (pb.y - pa.y) * u }, W, H)
}

export function corners(r: MontageRect): Array<{ x: number; y: number }> {
  const c = Math.cos(r.rot)
  const s = Math.sin(r.rot)
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const dx = ((u as number) * r.w) / 2
    const dy = ((v as number) * r.h) / 2
    return { x: r.x + c * dx - s * dy, y: r.y + s * dx + c * dy }
  })
}

export function hitU(shot: MontageShot, frame: number): number {
  return span01(frame, shot.f0, Math.max(shot.f0 + 1, shot.f1 - 1 - (shot.hit?.out ?? 0)))
}

function distanceIn(shot: MontageShot, frame: number): number {
  const h = shot.hit
  if (h === undefined) return 0
  const u = hitU(shot, frame)
  const e = h.whip ? easeInOut(u) : h.dot === 'head' && h.route[0] === 0 ? easeOut(u) : u
  return h.route[0] + (h.route[1] - h.route[0]) * e
}

export function hitDistance(m: MontageScore, frame: number): number {
  return distanceIn(montageShot(m, frame), frame)
}

export function hitPath(m: MontageScore, frame: number): number[] {
  return montageShot(m, frame).hit?.path === 'feed' ? m.feed : m.route.path
}

export function hitAnchor(m: MontageScore, shot: MontageShot, frame: number): { x: number; y: number } {
  const h = shot.hit
  if (h === undefined) return shot.kind === 'fall' ? m.landing : m.home
  if (h.dot !== 'head') return h.dot
  const p = along(h.path === 'feed' ? m.feed : m.route.path, distanceIn(shot, frame))
  return { x: p.x, y: p.y }
}

export function hitClock(m: MontageScore, frame: number): number {
  const shot = montageShot(m, frame)
  const h = shot.hit
  if (h === undefined) return shot.kind === 'name' ? 100 : 0
  return h.clock[0] + (h.clock[1] - h.clock[0]) * hitU(shot, frame)
}

const CITY = 0.8
const SPREAD = 0.5

export function hitTally(m: MontageScore, frame: number): number {
  const shot = montageShot(m, frame)
  const c = shot.hit?.count
  if (c === undefined) return 0
  const u = hitU(shot, frame)
  const t = shot.hit?.tally ?? { total: m.count, digits: 0, suffix: '' }
  const w = shot.hit?.climax === 'lamp' ? Math.min(1, u / SPREAD) : u
  const e = shot.hit?.climax === 'city' ? smooth(Math.min(1, u / CITY)) : w * (1.5 - 0.5 * w)
  const value = t.total * (c[0] + (c[1] - c[0]) * e)
  return c[1] > 0 ? Math.max(10 ** -t.digits, value) : value
}

export function hitCount(m: MontageScore, frame: number): number {
  return Math.round(hitTally(m, frame))
}

export function tallyText(m: MontageScore, h: MontageHit, value: number): string {
  const t = h.tally ?? { total: m.count, digits: 0, suffix: '' }
  return `${value.toFixed(t.digits)}${t.suffix}`
}

export function shotView(m: MontageScore, shot: MontageShot, frame: number, W: number, H: number): MontageView {
  const h = shot.hit
  if (h === undefined) return shot.kind === 'name' ? m.views.poster : m.views.fit
  const u = hitU(shot, frame)
  if (h.follow) {
    const p = hitAnchor(m, shot, frame)
    return anchored(p.x, p.y, h.from.k, h.from.rot, { x: W / 2, y: H / 2 }, W, H)
  }
  const e = h.whip ? easeInOut(u) : h.ease ? 0.4 * u + 0.6 * smooth(u) : u
  return settled(m, shot, frame, blend(h.from, h.to, e), W, H)
}

export interface MontageJoinState {
  a: MontageShot
  b: MontageShot
  u: number
  j0: number
}

export function joinOf(m: MontageScore, frame: number): MontageJoinState | undefined {
  const i = m.shots.findIndex((s) => frame >= s.f0 && frame < s.f1)
  const a = m.shots[i]
  const b = m.shots[i + 1]
  const h = b?.hit
  if (a === undefined || b === undefined || h === undefined || h.frames <= 0) return undefined
  const j0 = b.f0 - h.frames
  if (frame < j0) return undefined
  return { a, b, u: (frame - j0 + 1) / (h.frames + 1), j0 }
}

export const IRIS_PUSH = 10
const ANTICIPATE = 0.2
const OVERSHOOT = 0.06

export function zoomEase(u: number): number {
  if (u < ANTICIPATE) return -0.05 * Math.sin((Math.PI * u) / ANTICIPATE)
  return (1 + OVERSHOOT) * easeInOut((u - ANTICIPATE) / (1 - ANTICIPATE))
}

function settled(m: MontageScore, shot: MontageShot, frame: number, v: MontageView, W: number, H: number): MontageView {
  const h = shot.hit
  if (h === undefined || h.into !== 'zoom' || h.frames <= 0) return v
  const t = (frame - shot.f0 + 1) / (SETTLE + 1)
  if (t >= 1) return v
  const i = m.shots.indexOf(shot)
  const a = m.shots[i - 1]
  if (a === undefined) return v
  const over = zoomEase(h.frames / (h.frames + 1)) - 1
  return swing(shotView(m, a, shot.f0 - h.frames - 1, W, H), v, h.at.x, h.at.y, 1 + over * (1 - t) ** 2, W, H)
}

const SETTLE = 4

export function joinView(m: MontageScore, j: MontageJoinState, W: number, H: number): MontageView {
  const h = j.b.hit as MontageHit
  const va = shotView(m, j.a, j.j0 - 1, W, H)
  if (h.into === 'whip') return blend(va, h.from, easeInOut(j.u))
  if (h.into === 'zoom') return swing(va, h.from, h.at.x, h.at.y, zoomEase(j.u), W, H)
  const push = h.into === 'iris' ? IRIS_PUSH : 1.25
  const q = viewPoint(va, h.at.x, h.at.y, W, H)
  return anchored(h.at.x, h.at.y, va.k * push ** (j.u ** 1.5), va.rot, q, W, H)
}

export function montageView(m: MontageScore, frame: number, W: number, H: number): MontageView {
  const shot = montageShot(m, frame)
  if (shot.hit === undefined) return shot.kind === 'name' ? m.views.poster : m.views.fit
  const j = joinOf(m, frame)
  return j === undefined ? shotView(m, shot, frame, W, H) : joinView(m, j, W, H)
}

function blend(a: MontageView, b: MontageView, u: number): MontageView {
  return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, k: Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * u), rot: a.rot + wrap(b.rot - a.rot) * u }
}

function fitBox(pts: Array<{ x: number; y: number }>, region: MontageBox, rot: number, W: number, H: number, kMax: number): MontageView {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const turned = pts.map((p) => ({ x: c * p.x - s * p.y, y: s * p.x + c * p.y }))
  const x0 = Math.min(...turned.map((p) => p.x))
  const x1 = Math.max(...turned.map((p) => p.x))
  const y0 = Math.min(...turned.map((p) => p.y))
  const y1 = Math.max(...turned.map((p) => p.y))
  const k = Math.min(kMax, (region.x1 - region.x0) / Math.max(1e-6, x1 - x0), (region.y1 - region.y0) / Math.max(1e-6, y1 - y0))
  const mx = (x0 + x1) / 2
  const my = (y0 + y1) / 2
  return anchored(c * mx + s * my, -s * mx + c * my, k, rot, { x: (region.x0 + region.x1) / 2, y: (region.y0 + region.y1) / 2 }, W, H)
}

export function montageWeight(archetype: string, density: number, unit: 'via' | 'pad'): MontageWeight {
  if (archetype === 'stick') return 'object'
  return density >= FIELD_DENSITY && unit === 'via' ? 'density' : 'route'
}

export function buildMontage(board: BoardModel, resolved: ResolvedConfig, seed: number, bodies?: PartBodies): { scene: TraceScene; warnings: TimelineWarning[] } {
  const base = buildTraceScene(board, { ...resolved, style: 'trace', title: undefined }, seed, bodies, false)
  const scene = base.scene
  const W = resolved.width
  const H = resolved.height
  const fps = resolved.fps
  const total = planDuration(resolved).totalFrames
  const g = (frames30: number): number => Math.max(2, Math.round((frames30 * fps) / 30))
  const heroRef = pickHero(board, resolved.cast, resolved.hero)?.ref
  const map = boardToScene(board, scene)
  const scale = Math.sqrt(Math.abs(map[0] * map[4] - map[1] * map[3]))
  const toScene = (p: Vec2): Vec2 => apply(map, p)
  const flat = (pts: Vec2[]): number[] => pts.flatMap((p) => {
    const q = toScene(p)
    return [q.x, q.y]
  })
  const holes = chooseDot(board, resolved.cast, resolved.hero)
  const facts = boardFacts(board)
  const words = filmWords(board, resolved.title)
  const unit = Math.min(W, H) / 1080
  const min = Math.min(W, H)
  const dotPx = Math.round(DOT_SHARE * min)
  const { ink, base: ground } = filmInk(scene)
  const type = { unit, min: Math.ceil((0.024 * W) / 0.68), margin: Math.round(44 * unit) }
  const character = boardCharacter(scene.parts, scene.board, scene.gold ?? [], scene.origin)
  const viaCount = new Set(Object.values(board.copper).flatMap((c) => c.vias.map((v) => v.id))).size
  const density = viaCount / Math.max(1e-6, (facts.widthMm * facts.heightMm) / 100)
  const weight = montageWeight(character.archetype, density, holes.unit)

  const xs = scene.board.flatMap((l) => l.filter((_, i) => i % 2 === 0))
  const ys = scene.board.flatMap((l) => l.filter((_, i) => i % 2 === 1))
  const bb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
  const bw = bb.x1 - bb.x0
  const bh = bb.y1 - bb.y0
  const long = Math.max(bw, bh)
  const rot = (bw >= bh) !== (W >= H) ? Math.PI / 2 : 0
  const sw = rot === 0 ? bw : bh
  const sh = rot === 0 ? bh : bw
  const footerTop = H - type.margin - 1.6 * type.min
  const baseline = Math.round(footerTop - 0.1 * min)
  const stop = { x: W - type.margin - Math.round(0.07 * min) - dotPx, y: baseline - dotPx, r: dotPx, baseline }
  const centre = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 }
  const fitK = Math.min((0.94 * W) / sw, (0.94 * H) / sh)
  const fit = anchored(centre.x, centre.y, fitK, rot, { x: W / 2, y: H / 2 }, W, H)
  const heroPart = scene.parts.find((p) => p.hero)
  const heroBody: MontageRect = heroPart === undefined ? { x: centre.x, y: centre.y, w: bw / 6, h: bh / 6, rot: 0 } : { x: heroPart.x, y: heroPart.y, w: heroPart.w, h: heroPart.h, rot: heroPart.rot }

  const graphs = netGraphs(board)
  const choice = chooseRoute(board, heroRef, graphs)
  const fallback = (() => {
    const gr = [...graphs].sort((a, b) => b.edges.length - a.edges.length)[0]
    const pts = gr === undefined ? [] : walkNet(gr, undefined).points
    return { net: gr?.name ?? words.name, points: pts.length >= 2 ? pts : [board.bbox.min, board.bbox.max], layers: [] as string[] }
  })()
  const picked = choice ?? fallback
  const path = flat(picked.points)
  const segs = path.length / 2 - 1
  const home = picked.layers[0] ?? Object.keys(board.copper).find((id) => id.startsWith('F.')) ?? 'F.Cu'
  const layerOf = Array.from({ length: segs }, (_, i) => picked.layers[i] ?? home)
  const breaks: number[] = [0]
  const runs: string[] = [layerOf[0] as string]
  let run = 0
  for (let i = 0; i < segs; i++) {
    if (i > 0 && layerOf[i] !== layerOf[i - 1]) {
      breaks.push(run)
      runs.push(layerOf[i] as string)
    }
    run += Math.hypot((path[2 * i + 2] as number) - (path[2 * i] as number), (path[2 * i + 3] as number) - (path[2 * i + 1] as number))
  }
  const length = run
  breaks.push(length)
  const startPos = { x: path[0] as number, y: path[1] as number }
  const endPos = { x: path.at(-2) as number, y: path.at(-1) as number }
  const nearPad = (p: { x: number; y: number }): TraceScene['pads'][number] | undefined => scene.pads.reduce<TraceScene['pads'][number] | undefined>((a, q) => (a === undefined || Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? q : a), undefined)
  const startPad = nearPad(startPos) ?? { w: 1, h: 1 }
  const startR = Math.max(1e-3, Math.min(startPad.w, startPad.h) / 2)

  const endRef = choice?.end.ref
  const ownPads = [...new Map(Object.values(board.copper).flatMap((c) => c.pads).filter((p) => p.footprintRef !== undefined && p.footprintRef === endRef).map((p) => [p.id, p])).values()]
  const endPads: MontageRect[] = ownPads.map((p) => {
    const q = toScene(p.pos)
    const s = nearPad(q)
    return s !== undefined && Math.hypot(s.x - q.x, s.y - q.y) < 0.5 * scale ? { x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot } : { x: q.x, y: q.y, w: p.size.x * scale, h: p.size.y * scale, rot: 0 }
  })
  const padPts = endPads.length > 0 ? endPads.flatMap(corners) : [endPos]
  const padBox = { x0: Math.min(...padPts.map((p) => p.x)), y0: Math.min(...padPts.map((p) => p.y)), x1: Math.max(...padPts.map((p) => p.x)), y1: Math.max(...padPts.map((p) => p.y)) }
  const padMid = { x: (padBox.x0 + padBox.x1) / 2, y: (padBox.y0 + padBox.y1) / 2 }
  const bodyPart = scene.parts.filter((p) => !p.hero && p.x > padBox.x0 - 1e-6 && p.x < padBox.x1 + 1e-6 && p.y > padBox.y0 - 1e-6 && p.y < padBox.y1 + 1e-6).sort((a, b) => Math.hypot(a.x - padMid.x, a.y - padMid.y) - Math.hypot(b.x - padMid.x, b.y - padMid.y))[0]
  const endBody: MontageRect | undefined = bodyPart === undefined ? undefined : { x: bodyPart.x, y: bodyPart.y, w: bodyPart.w, h: bodyPart.h, rot: bodyPart.rot }
  const endKind = choice?.end.kind ?? 'other'
  const light = endKind === 'led' ? { x: endBody?.x ?? padMid.x, y: endBody?.y ?? padMid.y } : endPos

  const inset = type.margin + 1.5 * dotPx
  const region = { x0: inset, y0: inset, x1: W - inset, y1: H - inset }
  const grow = (pts: Array<{ x: number; y: number }>, e: number): Array<{ x: number; y: number }> => {
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length
    return pts.map((p) => ({ x: cx + (p.x - cx) * e, y: cy + (p.y - cy) * e }))
  }
  const close = fitBox(grow(corners(heroBody), 1.3), region, rot, W, H, 60 * fitK)
  const thingPts = [...padPts, ...(endBody === undefined ? [] : corners(endBody))]
  const arrival = fitBox(grow(thingPts, endKind === 'led' ? 1.5 : 1.3), { x0: inset, y0: 0.25 * H, x1: W - inset, y1: 0.75 * H }, rot, W, H, 60 * fitK)

  const fact: MontageFact | undefined = (() => {
    if (weight === 'object') {
      const rotH = bw >= bh ? 0 : Math.PI / 2
      const S = Math.min(bw, bh)
      const capR = 0.2 * min
      const gap = 0.025 * min
      const tick = 0.045 * min
      const below = 2 * gap + tick + capR
      const kR = Math.min((W - 2 * type.margin - 2 * dotPx) / long, (H - 2 * type.margin - below) / S)
      const top = Math.max(type.margin, (H - (S * kR + below)) / 2)
      const view = anchored(centre.x, centre.y, kR, rotH, { x: W / 2, y: top + (S * kR) / 2 }, W, H)
      const ends = bw >= bh ? [{ x: bb.x0, y: centre.y }, { x: bb.x1, y: centre.y }] : [{ x: centre.x, y: bb.y0 }, { x: centre.x, y: bb.y1 }]
      const [from, to] = [...ends].sort((p, q) => viewPoint(view, p.x, p.y, W, H).x - viewPoint(view, q.x, q.y, W, H).x) as [Vec2, Vec2]
      const right = viewPoint(view, to.x, to.y, W, H).x
      const line = top + S * kR + gap
      const rb = line + tick + gap + capR
      return { kind: 'ruler', from, to, mm: Math.max(facts.widthMm, facts.heightMm), view, line, tick, baseline: rb, cap: capR, dot: { x: right - dotPx, y: rb - dotPx }, right }
    }
    if (weight !== 'density') return undefined
    const reach = 0.14 * Math.min(bw, bh)
    const vias = [...new Map(Object.values(board.copper).flatMap((c) => c.vias).map((v) => [v.id, toScene(v.pos)])).values()]
    const clear = 0.5 * Math.hypot(heroBody.w, heroBody.h) + 0.4 * reach
    const near = vias.filter((v) => Math.hypot(v.x - startPos.x, v.y - startPos.y) < 1.2 * reach && Math.hypot(v.x - heroBody.x, v.y - heroBody.y) > clear)
    const count = (c: Vec2): number => vias.filter((v) => Math.hypot(v.x - c.x, v.y - c.y) < reach).length
    const best = near.reduce<{ c: Vec2; n: number }>((a, v) => { const n = count(v); return n > a.n ? { c: v, n } : a }, { c: startPos, n: -1 })
    const mid = { x: (best.c.x + startPos.x) / 2, y: (best.c.y + startPos.y) / 2 }
    return { kind: 'field', centre: mid, k: min / (1.2 * reach) }
  })()

  const fanned = weight === 'object' ? fanRoutes(board, heroRef, graphs) : { routes: [], inputs: [] as Array<{ net: number; ref: string; points: Vec2[] }> }
  const fan = fanned.routes
  const feedRoute = fanned.inputs.length === 1 ? fanned.inputs[0] : undefined
  const feed = feedRoute === undefined ? [] : flat([...feedRoute.points].reverse())
  const fanNets = new Set([...fan, ...(feedRoute === undefined ? [] : [feedRoute])].map((r) => r.net))
  const pinWalks = heroPins(board, heroRef).flatMap((p) => {
    const gr = graphs.find((x) => x.id === p.netId)
    if (gr === undefined || gr.name === choice?.net || fanNets.has(gr.id)) return []
    const s0 = nearestNode(gr, p.pos, 0.6)
    if (s0 === undefined) return []
    const pts = flat(walkNet(gr, s0).points)
    return pts.length >= 4 ? [{ id: gr.id, path: pts, length: pathLength(pts) }] : []
  }).sort((a, b) => a.id - b.id).filter((w, i, list) => list.findIndex((o) => o.id === w.id) === i).slice(0, 64)
  const used = new Set([...pinWalks.map((w) => w.id), ...fanNets])
  const others = graphs.filter((gr) => !used.has(gr.id) && gr.kind !== 'ground' && gr.kind !== 'power' && gr.name !== choice?.net).map((gr) => {
    const pts = flat(walkNet(gr, undefined).points)
    return { id: gr.id, path: pts, length: pathLength(pts) }
  }).filter((w) => w.path.length >= 4 && w.length > 0.04 * long).sort((a, b) => a.id - b.id).slice(0, 200)

  const padsOf = (refs: string[]): MontageRect[] => [...new Map(Object.values(board.copper).flatMap((c) => c.pads).filter((q) => q.footprintRef !== undefined && refs.includes(q.footprintRef)).map((q) => [q.id, q])).values()].map((q) => {
    const c = toScene(q.pos)
    const sp = nearPad(c)
    return sp !== undefined && Math.hypot(sp.x - c.x, sp.y - c.y) < 0.5 * scale ? { x: sp.x, y: sp.y, w: sp.w, h: sp.h, rot: sp.rot } : { x: c.x, y: c.y, w: q.size.x * scale, h: q.size.y * scale, rot: 0 }
  })
  const contacts = padsOf(extractParts(board).filter((p) => p.kind === 'conn').map((p) => p.ref))
  const face = board.footprints.find((f) => f.ref === heroRef)?.layer
  const ports = fan.map((r) => padsOf([r.ref]))
  const facePorts = fan.filter((r) => board.footprints.find((f) => f.ref === r.ref)?.layer === face).map((r) => padsOf([r.ref]))
  const feeds = feedRoute === undefined ? [] : padsOf([feedRoute.ref])
  const shown = Math.min(fan.length, 9)
  const span = fanSpan(shown)
  const portAt = fan.map((_, j) => FAN_START + Math.min(j, shown - 1) * span + 0.6 * span)

  const label = heroLabel(board, heroRef)
  const layerName = (id: string): string => (id.startsWith('F.') ? 'FRONT COPPER.' : id.startsWith('B.') ? 'BACK COPPER.' : /^In(\d+)/.test(id) ? `INNER ${/^In(\d+)/.exec(id)?.[1] ?? ''}.` : `${id.toUpperCase()}.`)
  const posterView = anchored(centre.x, centre.y, weight === 'object' ? Math.min(W / sw, (0.98 * H) / sh) : Math.min((weight === 'route' ? 1.7 : 1.35) * fitK, Math.max(W / sw, H / sh)), rot, { x: W / 2, y: H / 2 }, W, H)

  const label0 = heroLabel(board, heroRef)
  const glyphs = weight === 'density' ? `${label0} `.repeat(Math.ceil(400 / (label0.length + 1))).slice(0, 400) : [...new Set(extractParts(board).map((p) => (p.value ?? p.ref).toUpperCase()).filter((v) => v.length > 1))].join(' ').slice(0, 400)
  const lightPx = endKind === 'led' ? Math.max(dotPx, Math.min(2.4 * dotPx, 0.45 * Math.max(endBody?.w ?? 0, endBody?.h ?? 0) * arrival.k)) : 0
  const nearVia = (p: { x: number; y: number }): TraceScene['vias'][number] | undefined => scene.vias.reduce<TraceScene['vias'][number] | undefined>((a, q) => (a === undefined || Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? q : a), undefined)
  const holeR = (p: { x: number; y: number }): number => {
    const v = nearVia(p)
    return v !== undefined && Math.hypot(v.x - p.x, v.y - p.y) < 2 * v.r ? v.r : startR
  }
  const viaNear = (p: { x: number; y: number }): { x: number; y: number; r: number } | undefined => {
    const v = nearVia(p)
    return v === undefined ? undefined : { x: v.x, y: v.y, r: v.r }
  }
  const outline = corners({ x: centre.x, y: centre.y, w: bw, h: bh, rot: 0 })
  const mg = type.margin
  const turned = outline.map((p) => ({ x: Math.cos(rot) * p.x - Math.sin(rot) * p.y, y: Math.sin(rot) * p.x + Math.cos(rot) * p.y }))
  const tall = (Math.max(...turned.map((p) => p.y)) - Math.min(...turned.map((p) => p.y))) / Math.max(1e-6, Math.max(...turned.map((p) => p.x)) - Math.min(...turned.map((p) => p.x)))
  const side = W > H || tall > (1.6 * H) / W
  const loose = fitBox(outline, side ? { x0: mg + 0.3 * W, y0: mg, x1: W - mg, y1: H - mg } : { x0: mg, y0: mg, x1: W - mg, y1: H - mg - 0.3 * H }, rot, W, H, 60 * fitK)
  const seen = outline.map((p) => viewPoint(loose, p.x, p.y, W, H))
  const extent = side ? Math.max(...seen.map((p) => p.x)) - Math.min(...seen.map((p) => p.x)) : Math.max(...seen.map((p) => p.y)) - Math.min(...seen.map((p) => p.y))
  const count0 = fitBox(outline, side ? { x0: W - mg - extent, y0: mg, x1: W - mg, y1: H - mg } : { x0: mg, y0: mg, x1: W - mg, y1: mg + extent }, rot, W, H, 60 * fitK)
  const told = boardTells(board)
  const heroPads = padsOf(heroRef === undefined ? [] : [heroRef])
  const heroNums = [...new Map(Object.values(board.copper).flatMap((c) => c.pads).filter((q) => heroRef !== undefined && q.footprintRef === heroRef).map((q) => [q.id, q])).values()].map((q) => q.num)
  const inner = (q: MontageRect): boolean => {
    const c = Math.cos(-heroBody.rot)
    const sn = Math.sin(-heroBody.rot)
    const dx = q.x - heroBody.x
    const dy = q.y - heroBody.y
    return Math.abs(c * dx - sn * dy) < 0.3 * heroBody.w && Math.abs(sn * dx + c * dy) < 0.3 * heroBody.h
  }
  const named = heroPads.filter((_, i) => heroNums[i] !== undefined && heroNums[i] !== '')
  const edge = named.filter((q) => !inner(q)).length >= 0.7 * named.length
  const seenNums = new Set<string>(edge ? heroPads.flatMap((q, i) => (inner(q) && heroNums[i] !== undefined ? [heroNums[i]] : [])) : [])
  const pinRects = heroPads.filter((_, i) => {
    const num = heroNums[i]
    if (num === undefined || num === '' || seenNums.has(num)) return false
    seenNums.add(num)
    return true
  }).sort((a, b) => Math.atan2(a.y - heroBody.y, a.x - heroBody.x) - Math.atan2(b.y - heroBody.y, b.x - heroBody.x))
  const blocks: MontageRect[][] = board.footprints.flatMap((f): MontageRect[][] => {
    const own = padsOf([f.ref])
    const pts = own.flatMap(corners)
    if (pts.length === 0) return []
    const x0 = Math.min(...pts.map((q) => q.x))
    const x1 = Math.max(...pts.map((q) => q.x))
    const y0 = Math.min(...pts.map((q) => q.y))
    const y1 = Math.max(...pts.map((q) => q.y))
    return [Math.max(x1 - x0, y1 - y0) <= 0.12 * long ? [{ x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, rot: 0 }] : own]
  }).sort((a, b) => Math.hypot((a[0] as MontageRect).x - heroBody.x, (a[0] as MontageRect).y - heroBody.y) - Math.hypot((b[0] as MontageRect).x - heroBody.x, (b[0] as MontageRect).y - heroBody.y))
  const pours: Record<string, number[][]> = Object.fromEntries(told.layers.map((id) => [id, (board.copper[id]?.zones ?? []).flatMap((z) => z.fills.map((f) => flat(f)))]))
  const hub = { x: heroBody.x, y: heroBody.y }
  const at = (p: { x: number; y: number }, k: number): MontageView => anchored(p.x, p.y, k, rot, { x: W / 2, y: H / 2 }, W, H)
  const focus = W > H ? { x: 0.66 * W, y: 0.5 * H } : { x: 0.5 * W, y: 0.34 * H }
  const aside = (p: { x: number; y: number }, k: number): MontageView => anchored(p.x, p.y, k, rot, focus, W, H)
  const metres = told.copperMm / 1000
  const pinView = fitBox(grow(corners(heroBody), 1.5), W > H ? { x0: 0.38 * W, y0: type.margin, x1: W - type.margin, y1: H - type.margin } : { x0: type.margin, y0: type.margin, x1: W - type.margin, y1: 0.6 * H }, rot, W, H, 60 * fitK)
  const tells: Tell[] = [
    { kind: 'stack', score: told.layers.length >= 4 ? 0.9 + 0.1 * (told.layers.length - 4) : told.layers.length === 1 ? 0.5 : 0.2, beats: 0.5 * Math.min(6, told.layers.length), from: at(centre, 1.3 * fitK), to: at(centre, 1.38 * fitK), dot: hub, word: `${told.layers.length} ${told.layers.length === 1 ? 'LAYER' : 'LAYERS'}.`, layers: told.layers.slice(0, 6) },
    { kind: 'copper', score: Math.log10(Math.max(1e-6, told.copperMm / Math.max(facts.widthMm, facts.heightMm))) / 2 - 0.1, beats: 1.5, from: aside(hub, 1.7 * fitK), to: aside(hub, 1.15 * fitK), dot: hub, unit: metres >= 1 ? `METRE${metres.toFixed(1) === '1.0' ? '' : 'S'} OF COPPER.` : 'CENTIMETRES OF COPPER.', tally: metres >= 1 ? { total: Number(metres.toFixed(1)), digits: 1, suffix: '' } : { total: Math.round(told.copperMm / 10), digits: 0, suffix: '' } },
    { kind: 'pins', score: pinRects.length >= 8 ? Math.log2(pinRects.length / 16) / 3 : -10, beats: 1.5, from: pinView, to: anchored(hub.x, hub.y, 1.06 * pinView.k, rot, viewPoint(pinView, hub.x, hub.y, W, H), W, H), dot: hub, unit: 'PINS.', tally: { total: pinRects.length, digits: 0, suffix: '' } },
    { kind: 'parts', score: blocks.length >= 8 ? Math.log10(blocks.length / Math.max(1e-6, (facts.widthMm * facts.heightMm) / 100)) / 1.2 : -10, beats: 1.5, from: at(centre, fitK), to: at(centre, 1.06 * fitK), dot: hub, unit: 'PARTS.', tally: { total: blocks.length, digits: 0, suffix: '' } },
  ]
  const laid = layHits({
    weight, W, H, fps, total, ground, rot, fitK, coverK: Math.max(W / sw, H / sh), centre, board: bb, hero: heroBody, start: startPos, startR, path, length, breaks, layers: runs,
    end: { x: endPos.x, y: endPos.y, label: choice?.end.label ?? '', kind: choice === undefined ? 'other' : endKind, light, led: endKind === 'led' },
    close, arrival, poster: posterView, field: fact?.kind === 'field' ? { centre: fact.centre, k: fact.k } : undefined, viaNear, count0, holeR, ruler: fact?.kind === 'ruler' ? fact.view : undefined,
    mm: Math.max(facts.widthMm, facts.heightMm), count: holes.points.length, unit: holes.unit, part: label, feed, feedPads: feeds, ports, layerName, tells
  })
  const homeAt = weight === 'route' ? { x: heroBody.x, y: heroBody.y } : laid.home
  const fromHome = (pts: number[]): number => Math.min(Math.hypot((pts[0] as number) - homeAt.x, (pts[1] as number) - homeAt.y), Math.hypot((pts.at(-2) as number) - homeAt.x, (pts.at(-1) as number) - homeAt.y))
  const ripple = [...pinWalks, ...others].map((w) => ({ ...w, far: fromHome(w.path) })).sort((a, b) => a.far - b.far)
  const nearest = Math.min(...ripple.map((w) => w.far))
  const farthest = Math.max(nearest + 1e-6, ...ripple.map((w) => w.far))
  const reach01 = (far: number): number => (far - nearest) / (farthest - nearest)
  const dur = Math.max(4, 0.12 * (100 - laid.lit))
  const pulses: MontagePulse[] = [
    ...(feed.length >= 4 ? [{ path: feed, length: pathLength(feed), f0: 0, dur: FAN_START, bold: true }] : []),
    ...fan.map((r, j): MontagePulse => {
      const p = flat(r.points)
      return { path: p, length: pathLength(p), f0: FAN_START + Math.min(j, shown - 1) * span, dur: 0.6 * span, bold: true }
    }),
    ...ripple.map((w): MontagePulse => ({ path: w.path, length: w.length, bold: false, dur, f0: laid.lit + (LIT - 0.6 * dur - laid.lit) * Math.sqrt(reach01(w.far)) }))
  ]
  const fall = laid.shots[0] as MontageShot
  const opening = weight === 'density' ? 'spot' as const : ground
  const shots: MontageShot[] = [
    { kind: 'title', f0: 0, f1: g(6), ground: opening, carry: 'seam' },
    { kind: 'fall', f0: g(6), f1: fall.f0, ground: opening, carry: 'move' },
    ...laid.shots,
    { kind: 'name', f0: (laid.shots.at(-1) as MontageShot).f1, f1: total, ground: opening, carry: 'seam' }
  ]
  const letters = Array.from(words.name).length
  const hitWords: MontageWord[] = laid.shots.flatMap((s): MontageWord[] => {
    const text = s.hit?.word
    if (text === undefined) return []
    const role: MontageWord['role'] = s.kind === 'chip' ? 'part' : s.kind === 'layer' ? 'layer' : s.kind === 'arrival' || s.kind === 'step' ? 'reached' : 'fact'
    return [{ role, text, f0: s.f0, move: 'crop', crop: true }]
  })
  const dots = holes.points.map((p) => ({ ...toScene(p.pos), r: p.r * scale }))
  const from = laid.home
  dots.sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))

  const montage: MontageScore = {
    ink,
    base: ground,
    archetype: character.archetype,
    weight,
    fan: fan.length,
    beat: fps / 2,
    contacts,
    ports,
    facePorts,
    portAt,
    feeds,
    feed,
    glyphs,
    home: laid.home,
    lightR: arrival.k > 0 ? lightPx / arrival.k : 0,
    name: words.name,
    version: words.version,
    lines: (resolved.title?.lines ?? []).slice(0, 3),
    footer: words.footer,
    unit: holes.unit,
    count: holes.points.length,
    countWord: `${holes.points.length} ${holes.unit === 'via' ? 'VIAS' : 'PADS'}`,
    dot: placeDot(holes, map, scale),
    dotPx,
    dots,
    layers: layerLabels(board),
    route: {
      net: picked.net,
      path,
      length,
      layers: runs,
      breaks,
      ride: { f0: 0, f1: 0 },
      zoom: 0,
      start: { ...startPos, r: startR },
      end: { ...endPos, ref: choice?.end.ref ?? '', label: choice?.end.label ?? words.name, kind: endKind, pads: endPads, body: endBody, light }
    },
    pulses,
    energised: pinWalks.map((w) => w.path),
    parts: [],
    blocks,
    pins: pinRects,
    pours,
    netCount: facts.nets,
    hero: { label, ref: heroRef ?? '', ...heroBody },
    fact,
    density,
    shots,
    words: [...hitWords, { role: 'name', text: words.name, f0: Math.min(total - g(4) - g(6) - 2 * (letters - 1), Math.round((NAME_BEAT + (weight === 'density' ? 0.4 : 1)) * fps / 2)), move: 'rise', crop: false }],
    stop,
    rot,
    board: bb,
    fallK: 3 * fitK,
    region,
    aside: undefined,
    wordsTop: false,
    views: { fit, close, arrival, poster: (laid.shots.at(-1) as MontageShot).hit?.to ?? posterView, count0 },
    landing: laid.landing,
    type
  }
  const trailer = fps === 30 && total === 360 ? hypeCut(scene, montage, W, H, total) : undefined
  return { scene: { ...scene, film: undefined, montage: trailer === undefined ? montage : { ...montage, hype: trailer } }, warnings: base.warnings }
}

const LANDS = new Set<MontageShotKind>(['arrival', 'plug', 'port', 'lamp', 'print'])

export function montageEvents(timeline: Timeline): MontageEvent[] {
  if (timeline.style === 'glyph' || timeline.scene.montage === undefined) return []
  const m = timeline.scene.montage
  const events: MontageEvent[] = []
  let powered = false
  for (const s of m.shots.slice(1)) {
    const h = s.hit
    events.push({ kind: 'cut', frame: s.f0, text: `${s.kind}@${(s.f0 / m.beat).toFixed(1)}` })
    if (h === undefined) continue
    if (h.frames > 0) events.push({ kind: 'join', frame: s.f0 - h.frames, text: h.into })
    if (h.join !== undefined) events.push({ kind: 'screen', frame: s.f0 - h.frames, text: h.join })
    if (h.flood) events.push({ kind: 'flood', frame: s.f0, text: h.layer })
    if (h.whip || h.follow) events.push({ kind: 'ride', frame: s.f0, text: s.kind })
    if (h.count !== undefined && h.count[1] > h.count[0]) events.push({ kind: 'roll', frame: s.f1 - 2 - h.out, text: String(Math.max(1, Math.round(10 * (h.count[1] - h.count[0])))) })
    if (s.kind === 'field' && h.count?.[0] === 0) events.push({ kind: 'signature', frame: s.f0, text: m.weight })
    if (s.kind === 'ruler' || s.kind === 'hold') events.push({ kind: 'signature', frame: s.f0, text: s.kind === 'hold' ? 'hold' : m.weight })
    if (LANDS.has(s.kind) || (h.count !== undefined && h.count[0] === 1 && h.word !== undefined && !h.flood)) events.push({ kind: 'land', frame: s.f0, text: s.kind === 'port' ? `port ${h.word ?? ''}` : s.kind })
    if (h.clock[1] > h.clock[0]) {
      events.push({ kind: 'power', frame: s.f0 + (powered ? 0 : 1) })
      powered = true
    }
    if (h.word !== undefined) events.push({ kind: 'word', frame: s.f0, text: h.word })
    if (h.climax !== undefined && m.shots[m.shots.indexOf(s) - 1]?.hit?.climax !== h.climax) events.push({ kind: 'climax', frame: s.f0, text: h.climax })
    if (h.climax === 'split') m.portAt.forEach((t, j) => {
      if (t >= h.clock[0] && t < h.clock[1]) events.push({ kind: 'land', frame: Math.round(s.f0 + ((t - h.clock[0]) / (h.clock[1] - h.clock[0])) * (s.f1 - s.f0)), text: `port ${j + 1}` })
    })
  }
  events.push({ kind: 'land', frame: (shotOf(m, 'fall') as MontageShot).f1 - 2 })
  events.push({ kind: 'converge', frame: (shotOf(m, 'name') as MontageShot).f0 })
  events.push({ kind: 'set', frame: (m.words.find((w) => w.role === 'name') as MontageWord).f0, text: m.name })
  return events.sort((a, b) => a.frame - b.frame)
}
