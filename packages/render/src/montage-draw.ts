import { along, anchored, arrive, corners, FAN_START, easeInOut, hitAnchor, hitClock, hitCount, hitDistance, hitTally, hitU, joinOf, montageShot, montageView, shotView, smooth, span01, swing, tallyText, viewPoint, zoomEase } from '@silk-reel/choreo'
import type { MontageBox, MontageGround, MontageHit, MontageJoinState, MontageScore, MontageShot, MontageView, MontageWord, TraceTimeline } from '@silk-reel/choreo'
import type { TraceQuality } from './trace-gl'
import { createTreat } from './montage-treat'
import { createHype } from './montage-hype'
import type { Hype } from './montage-hype'
import { CAP, DESC, drawName, fitLine, footerTop, heavy, nameLayout } from './montage-type'
import type { NameLayout } from './montage-type'

export interface Montage {
  render(tl: TraceTimeline, frame: number): HTMLCanvasElement
  dispose(): void
}

export interface TypeBox extends MontageBox {
  text: string
  crop: boolean
  stop: boolean
}

export interface DotState {
  x: number
  y: number
  r: number
  ink: string
}

type Ctx = CanvasRenderingContext2D
interface Pt { x: number; y: number }

interface Frame {
  ctx: Ctx
  tl: TraceTimeline
  m: MontageScore
  W: number
  H: number
  f: number
  types: TypeBox[]
  reserved: MontageBox[]
  dry: boolean
  ground: string
  dot: DotState
  view: MontageView | undefined
  words: boolean
}

export interface Surfaces {
  next: Ctx
  mask: Ctx
}

const groundInk = (m: MontageScore, g: MontageGround): string => (g === 'paper' ? m.ink.paper : g === 'spot' ? m.ink.spot : m.ink.black)
const baseInk = (m: MontageScore): string => (m.base === 'paper' ? m.ink.paper : m.ink.black)
const fgInk = (m: MontageScore): string => (m.base === 'paper' ? m.ink.black : m.ink.paper)
const floodInk = (m: MontageScore): string => (m.ink.black === m.ink.spot ? m.ink.paper : m.ink.black)
const floodWord = (m: MontageScore): string => (floodInk(m) === m.ink.black ? m.ink.paper : m.ink.black)
const g = (tl: TraceTimeline, f30: number): number => Math.max(2, Math.round((f30 * tl.fps) / 30))

export function titleBox(m: MontageScore, W: number, H: number): MontageBox {
  return { x0: m.type.margin, y0: m.type.margin, x1: W - m.type.margin, y1: footerTop(m, H) - 0.5 * m.type.margin }
}

function useView(ctx: Ctx, v: MontageView, W: number, H: number): void {
  const c = Math.cos(v.rot) * v.k
  const s = Math.sin(v.rot) * v.k
  ctx.setTransform(c, s, -s, c, W / 2 - (c * v.cx - s * v.cy), H / 2 - (s * v.cx + c * v.cy))
}

function disc(ctx: Ctx, x: number, y: number, r: number, ink: string): void {
  if (r <= 0) return
  ctx.fillStyle = ink
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

function loops(ctx: Ctx, tl: TraceTimeline): void {
  ctx.beginPath()
  for (const loop of tl.scene.board) {
    ctx.moveTo(loop[0] as number, loop[1] as number)
    for (let i = 2; i < loop.length; i += 2) ctx.lineTo(loop[i] as number, loop[i + 1] as number)
    ctx.closePath()
  }
}

function polyline(ctx: Ctx, f: number[], upTo = Infinity): void {
  let left = upTo
  ctx.moveTo(f[0] as number, f[1] as number)
  for (let i = 2; i < f.length && left > 0; i += 2) {
    const ax = f[i - 2] as number
    const ay = f[i - 1] as number
    const bx = f[i] as number
    const by = f[i + 1] as number
    const l = Math.hypot(bx - ax, by - ay)
    const u = Math.min(1, left / Math.max(1e-9, l))
    ctx.lineTo(ax + (bx - ax) * u, ay + (by - ay) * u)
    left -= l
  }
}

function padPath(ctx: Ctx, p: TraceTimeline['scene']['pads'][number], grow: number): void {
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.rotate(p.rot)
  const w = p.w + 2 * grow
  const h = p.h + 2 * grow
  if (p.shape === 'circle') {
    ctx.moveTo(Math.max(w, h) / 2, 0)
    ctx.arc(0, 0, Math.max(w, h) / 2, 0, Math.PI * 2)
  }
  else if (p.shape === 'round') ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2)
  else ctx.rect(-w / 2, -h / 2, w, h)
  ctx.restore()
}

function rects(ctx: Ctx, list: Array<{ x: number; y: number; w: number; h: number; rot: number }>): void {
  for (const r of list) {
    const q = corners(r)
    ctx.moveTo((q[0] as Pt).x, (q[0] as Pt).y)
    for (const p of q.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
  }
}

function viewBounds(v: MontageView, W: number, H: number): MontageBox {
  const r = Math.hypot(W, H) / 2 / v.k
  return { x0: v.cx - r, y0: v.cy - r, x1: v.cx + r, y1: v.cy + r }
}

const ring = (F: Frame): number => 3 * F.m.dotPx

function blocked(F: Frame, q: Pt, r: number): boolean {
  if (Math.hypot(q.x - F.dot.x, q.y - F.dot.y) < ring(F) + r) return true
  const margin = r + 0.012 * Math.min(F.W, F.H)
  return F.reserved.some((b) => q.x > b.x0 - margin && q.x < b.x1 + margin && q.y > b.y0 - margin && q.y < b.y1 + margin)
}

interface Print {
  board?: string | undefined
  copper: string
  layer: string
  hero?: string | undefined
  holes?: string | undefined
  pours?: boolean | undefined
}

const viaR = (F: Frame, v: MontageView, r: number): number => Math.min(F.m.dotPx / 1.6, Math.max(r * v.k, 2.4 * F.m.type.unit))

function solid(F: Frame, v: MontageView, o: Print): void {
  const { ctx, tl, m, W, H } = F
  const s = tl.scene
  const b = viewBounds(v, W, H)
  const min = 4 * m.type.unit
  if (F.dry) return
  useView(ctx, v, W, H)
  if (o.board !== undefined) {
    loops(ctx, tl)
    ctx.fillStyle = o.board
    ctx.fill('evenodd')
  }
  const layer = s.layers.find((l) => l.id === o.layer)
  ctx.strokeStyle = o.copper
  ctx.fillStyle = o.copper
  if (o.pours === true) {
    ctx.beginPath()
    for (const f of m.pours[o.layer] ?? []) {
      ctx.moveTo(f[0] as number, f[1] as number)
      for (let i = 2; i < f.length; i += 2) ctx.lineTo(f[i] as number, f[i + 1] as number)
      ctx.closePath()
    }
    ctx.fill('evenodd')
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let i = 0; i < (layer?.segs.length ?? 0); i += 7) {
    const sg = layer?.segs as number[]
    const x0 = sg[i] as number
    const y0 = sg[i + 1] as number
    const x1 = sg[i + 2] as number
    const y1 = sg[i + 3] as number
    const w = Math.max(sg[i + 4] as number, min / v.k)
    if (Math.max(x0, x1) < b.x0 - w || Math.min(x0, x1) > b.x1 + w || Math.max(y0, y1) < b.y0 - w || Math.min(y0, y1) > b.y1 + w) continue
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }
  const side = layer?.side ?? (o.layer.startsWith('In') ? 'inner' : o.layer.startsWith('B.') ? 'B' : 'F')
  ctx.beginPath()
  for (const p of s.pads) {
    if ((side === 'inner' ? p.side !== 'both' : p.side !== side && p.side !== 'both') || p.x < b.x0 - p.w || p.x > b.x1 + p.w || p.y < b.y0 - p.h || p.y > b.y1 + p.h) continue
    if (p.shape !== 'rect' && blocked(F, viewPoint(v, p.x, p.y, W, H), (Math.max(p.w, p.h) / 2) * v.k)) continue
    padPath(ctx, p, 0)
  }
  ctx.fill()
  if (o.hero !== undefined) {
    ctx.beginPath()
    rects(ctx, m.contacts)
    ctx.fill()
    const hero = s.parts.find((p) => p.hero)
    if (hero !== undefined) {
      ctx.save()
      ctx.translate(hero.x, hero.y)
      ctx.rotate(hero.rot)
      ctx.fillStyle = o.hero
      ctx.fillRect(-hero.w / 2, -hero.h / 2, hero.w, hero.h)
      ctx.restore()
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = o.holes ?? o.copper
  ctx.beginPath()
  for (const via of s.vias) {
    if (via.x < b.x0 || via.x > b.x1 || via.y < b.y0 || via.y > b.y1) continue
    const q = viewPoint(v, via.x, via.y, W, H)
    const r = viaR(F, v, via.r)
    if (q.x < -r || q.x > W + r || q.y < -r || q.y > H + r || blocked(F, q, r)) continue
    ctx.moveTo(q.x + r, q.y)
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
  }
  ctx.fill()
}

function stroke(F: Frame, v: MontageView, path: number[], upTo: number, ink: string, px: number): void {
  const { ctx, W, H } = F
  useView(ctx, v, W, H)
  ctx.strokeStyle = ink
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = px / v.k
  ctx.beginPath()
  polyline(ctx, path, upTo)
  ctx.stroke()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

const widths = new WeakMap<object, number>()
function copperWidth(tl: TraceTimeline, layer: string): number {
  const segs = tl.scene.layers.find((l) => l.id === layer)?.segs ?? []
  const known = widths.get(segs)
  if (known !== undefined) return known
  const all = segs.filter((_, i) => i % 7 === 4).sort((a, b) => a - b)
  const w = all[Math.floor(all.length / 2)] ?? 0
  widths.set(segs, w)
  return w
}
const home = (m: MontageScore): string => m.route.layers[0] as string
const routePx = (F: Frame, v: MontageView): number => Math.max(0.45 * F.m.dotPx, 1.4 * copperWidth(F.tl, home(F.m)) * v.k)
const pulsePx = (F: Frame, v: MontageView): number => Math.min(routePx(F, v), Math.max(0.12 * F.m.dotPx, 1.1 * copperWidth(F.tl, home(F.m)) * v.k))

function claim(F: Frame, box: MontageBox, t: TypeBox): boolean {
  if (F.dry) {
    F.reserved.push(box)
    return false
  }
  F.types.push(t)
  F.ctx.fillStyle = F.ground
  F.ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0)
  return true
}

function setName(F: Frame, L: NameLayout, ink: string, reveal?: (i: number) => number): void {
  if (!claim(F, L.clear, { ...L.clear, text: F.m.name, crop: false, stop: true })) return
  drawName(F.ctx, L, ink, reveal)
}

function nameOf(ctx: Ctx, m: MontageScore, W: number, H: number): NameLayout {
  return nameLayout(ctx, m, titleBox(m, W, H))
}

const thingView = (m: MontageScore): MontageView | undefined => (m.weight === 'object' && m.fact?.kind === 'ruler' ? m.fact.view : undefined)
const nameInk = (m: MontageScore): string => (m.weight === 'density' ? baseInk(m) : fgInk(m))
const stopInk = (m: MontageScore): string => (m.weight === 'density' ? baseInk(m) : m.ink.spot)

function nameAt(ctx: Ctx, m: MontageScore, W: number, H: number): NameLayout {
  const f = m.fact
  if (thingView(m) !== undefined && f?.kind === 'ruler') return nameLayout(ctx, m, { x0: m.type.margin, y0: f.line, x1: W - m.type.margin, y1: H - m.type.margin })
  return nameOf(ctx, m, W, H)
}

function backView(m: MontageScore, shot: MontageShot, frame: number, fps: number, W: number, H: number): MontageView {
  const thing = thingView(m) as MontageView
  const e = smooth(span01(frame, shot.f0, shot.f0 + Math.round((12 * fps) / 30)))
  return e >= 1 ? thing : swing(m.views.poster, thing, (m.board.x0 + m.board.x1) / 2, (m.board.y0 + m.board.y1) / 2, e, W, H)
}

const irisOf = (m: MontageScore, shot: MontageShot, frame: number, fps: number): number => span01(frame, shot.f0, shot.f0 + Math.round((9 * fps) / 30))

const fallSplit = (s: MontageShot): number => s.f0 + Math.round(0.2 * (s.f1 - s.f0))
const land = (t: number): number => (t < 0.75 ? zoomEase(t / 0.75) : 1 + (zoomEase(1) - 1) * (1 - (t - 0.75) / 0.25) ** 2)

function viewAt(ctx: Ctx, tl: TraceTimeline, frame: number): MontageView {
  const m = tl.scene.montage as MontageScore
  const shot = montageShot(m, frame)
  if (shot.kind !== 'fall') return montageView(m, frame, tl.width, tl.height)
  const thing = thingView(m)
  if (thing !== undefined) return thing
  const L = nameAt(ctx, m, tl.width, tl.height)
  const r = m.landing
  return swing(anchored(r.x, r.y, m.fallK, m.rot, L.dot, tl.width, tl.height), m.views.fit, r.x, r.y, land(span01(frame, fallSplit(shot), fallSplit(shot) + g(tl, 11))), tl.width, tl.height)
}

function hitDotR(m: MontageScore, shot: MontageShot, frame: number, v: MontageView): number {
  const small = 0.6 * m.dotPx
  const h = shot.hit as MontageHit
  if (!h.light) return small
  const full = Math.max(small, Math.min(2.4 * m.dotPx, Math.max(1.6 * m.dotPx, m.lightR * v.k)))
  const prev = m.shots[m.shots.indexOf(shot) - 1]
  if (prev?.hit?.light !== true) return small + (full - small) * arrive(span01(frame, shot.f0, shot.f0 + Math.max(2, Math.round(m.beat / 3))))
  return full
}

const windowed = (h: MontageHit): boolean => h.into === 'iris' || h.into === 'word'

function nextView(m: MontageScore, j: MontageJoinState, W: number, H: number): MontageView {
  const h = j.b.hit as MontageHit
  const pb = hitAnchor(m, j.b, j.b.f0)
  const qb = viewPoint(h.from, pb.x, pb.y, W, H)
  if (h.into === 'word') return h.from
  const va = shotView(m, j.a, j.j0 - 1, W, H)
  const wc = viewPoint(va, h.at.x, h.at.y, W, H)
  const e = smooth(j.u)
  return anchored(pb.x, pb.y, h.from.k, h.from.rot, { x: wc.x + (qb.x - wc.x) * e, y: wc.y + (qb.y - wc.y) * e }, W, H)
}

const dotInk = (m: MontageScore, h: MontageHit): string => (h.flood ? floodWord(m) : m.ink.spot)

export function dotAt(ctx: Ctx, tl: TraceTimeline, frame: number): DotState {
  const m = tl.scene.montage as MontageScore
  const W = tl.width
  const H = tl.height
  const shot = montageShot(m, frame)
  const at = (x: number, y: number, r: number, ink = m.ink.spot): DotState => ({ x: Math.min(W - r, Math.max(r, x)), y: Math.min(H - r, Math.max(r, y)), r, ink })
  const small = 0.6 * m.dotPx
  const h = shot.hit
  if (h !== undefined) {
    const v = montageView(m, frame, W, H)
    const j = joinOf(m, frame)
    if (j !== undefined) {
      const hb = j.b.hit as MontageHit
      const pa = hitAnchor(m, j.a, j.j0 - 1)
      const pb = hitAnchor(m, j.b, j.b.f0)
      const ra = j.a.hit === undefined ? small : hitDotR(m, j.a, j.j0 - 1, shotView(m, j.a, j.j0 - 1, W, H))
      const rb = hitDotR(m, j.b, j.b.f0, hb.from)
      if (!windowed(hb)) {
        const e = hb.into === 'zoom' ? zoomEase(j.u) : easeInOut(j.u)
        const va = shotView(m, j.a, j.j0 - 1, W, H)
        if (hb.into === 'zoom' && Math.max(va.k / hb.from.k, hb.from.k / va.k) >= 3) {
          const qa = viewPoint(va, pa.x, pa.y, W, H)
          const qb = viewPoint(hb.from, pb.x, pb.y, W, H)
          const t = smooth(j.u)
          return at(qa.x + (qb.x - qa.x) * t, qa.y + (qb.y - qa.y) * t, ra + (rb - ra) * t, dotInk(m, t < 0.5 ? h : hb))
        }
        const q = viewPoint(v, pa.x + (pb.x - pa.x) * e, pa.y + (pb.y - pa.y) * e, W, H)
        return at(q.x, q.y, ra + (rb - ra) * Math.min(1, Math.max(0, e)), dotInk(m, e < 0.5 ? h : hb))
      }
      const e = smooth(j.u)
      const qa = viewPoint(v, pa.x, pa.y, W, H)
      const qb = viewPoint(nextView(m, j, W, H), pb.x, pb.y, W, H)
      return at(qa.x + (qb.x - qa.x) * e, qa.y + (qb.y - qa.y) * e, ra + (rb - ra) * e, dotInk(m, e < 0.5 ? h : hb))
    }
    const a = hitAnchor(m, shot, frame)
    const p = viewPoint(v, a.x, a.y, W, H)
    return at(p.x, p.y, hitDotR(m, shot, frame, v), dotInk(m, h))
  }
  if (shot.kind === 'title') {
    const L = nameAt(ctx, m, W, H)
    return at(L.dot.x, L.dot.y, L.dot.r * (1 + 0.45 * arrive(span01(frame, 0, shot.f1))), stopInk(m))
  }
  if (shot.kind === 'fall') {
    const j = joinOf(m, frame)
    const hb = j?.b.hit
    if (j !== undefined && hb !== undefined) {
      const e = zoomEase(j.u)
      const pb = hitAnchor(m, j.b, j.b.f0)
      const pa = m.landing
      const q = viewPoint(montageView(m, frame, W, H), pa.x + (pb.x - pa.x) * e, pa.y + (pb.y - pa.y) * e, W, H)
      return at(q.x, q.y, small + (hitDotR(m, j.b, j.b.f0, hb.from) - small) * Math.min(1, Math.max(0, e)))
    }
    const L = nameAt(ctx, m, W, H)
    const thing = thingView(m)
    if (thing !== undefined) {
      const e = smooth(span01(frame, shot.f0, shot.f1 - 1))
      const p = viewPoint(thing, m.landing.x, m.landing.y, W, H)
      return at(L.dot.x + (p.x - L.dot.x) * e, L.dot.y + (p.y - L.dot.y) * e, 1.45 * L.dot.r + (small - 1.45 * L.dot.r) * e)
    }
    const split = fallSplit(shot)
    if (frame < split) return at(L.dot.x, L.dot.y, 1.45 * L.dot.r, stopInk(m))
    const p = viewPoint(viewAt(ctx, tl, frame), m.landing.x, m.landing.y, W, H)
    return at(p.x, p.y, 1.45 * L.dot.r + (small - 1.45 * L.dot.r) * smooth(span01(frame, split, split + g(tl, 9))))
  }
  const L = nameAt(ctx, m, W, H)
  const word = m.words.find((w) => w.role === 'name') as MontageWord
  const print = m.shots.find((x) => x.kind === 'print') as MontageShot
  const r0 = hitDotR(m, print, print.f1 - 1, m.views.poster)
  if (m.weight === 'density') {
    const q0 = viewPoint(m.views.poster, m.home.x, m.home.y, W, H)
    if (irisOf(m, shot, frame, tl.fps) < 1) return at(q0.x, q0.y, r0)
    let since = 0
    while (since < g(tl, 6) && frame - since - 1 >= shot.f0 && irisOf(m, shot, frame - since - 1, tl.fps) >= 1) since++
    const t = smooth(Math.min(1, since / g(tl, 6)))
    return at(q0.x + (L.dot.x - q0.x) * t, q0.y + (L.dot.y - q0.y) * t, r0 + (L.dot.r - r0) * t, stopInk(m))
  }
  const back = thingView(m) !== undefined
  const s = back ? 1 - smooth(span01(frame, shot.f0, word.f0)) : 1 - span01(frame, shot.f0, word.f0) ** 2
  const q = viewPoint(back ? backView(m, shot, frame, tl.fps, W, H) : m.views.poster, m.home.x, m.home.y, W, H)
  const e = arrive(span01(frame, shot.f0, word.f0 + 4))
  return at(L.dot.x + (q.x - L.dot.x) * s, L.dot.y + (q.y - L.dot.y) * s, e >= 1 ? L.dot.r : r0 + (L.dot.r - r0) * e)
}

function paintDot(F: Frame): void {
  disc(F.ctx, F.dot.x, F.dot.y, F.dot.r, F.dot.ink)
}

function silhouette(F: Frame, v: MontageView, layer = home(F.m)): void {
  solid(F, v, { board: fgInk(F.m), copper: baseInk(F.m), layer, hero: baseInk(F.m) })
}

function paintFall(F: Frame, shot: MontageShot): void {
  const { ctx, m } = F
  const thing = thingView(m)
  if (thing !== undefined) {
    silhouette(F, thing)
    return
  }
  const split = fallSplit(shot)
  if (F.f >= split) {
    if (!F.dry && shot.ground === 'spot') {
      ctx.fillStyle = baseInk(m)
      ctx.fillRect(0, 0, F.W, F.H)
    }
    silhouette(F, viewAt(ctx, F.tl, F.f))
    return
  }
  const L = nameAt(ctx, m, F.W, F.H)
  const k = Math.exp(Math.log(5) * span01(F.f, shot.f0, split) ** 1.6)
  const map = (p: Pt): Pt => ({ x: L.dot.x + (p.x - L.dot.x) * k, y: L.dot.y + (p.y - L.dot.y) * k })
  const a = map({ x: L.clear.x0, y: L.clear.y0 })
  const z = map({ x: L.clear.x1, y: L.clear.y1 })
  const box = { x0: a.x, y0: a.y, x1: z.x, y1: z.y }
  if (!claim(F, box, { ...box, text: m.name, crop: true, stop: true })) return
  ctx.save()
  ctx.setTransform(k, 0, 0, k, L.dot.x - L.dot.x * k, L.dot.y - L.dot.y * k)
  drawName(ctx, L, nameInk(m))
  ctx.restore()
}

function thing(F: Frame, v: MontageView, h: MontageHit, clock: number, reached: boolean): void {
  const { ctx, m, W, H } = F
  if (F.dry) return
  useView(ctx, v, W, H)
  ctx.fillStyle = m.weight !== 'object' && reached ? m.ink.spot : baseInk(m)
  ctx.beginPath()
  rects(ctx, m.route.end.pads)
  ctx.fill()
  const lit = [...(h.plug ? m.feeds : []), ...m.ports.filter((_, j) => clock >= (m.portAt[j] as number)).flat()]
  if (lit.length > 0) {
    ctx.fillStyle = m.ink.spot
    ctx.beginPath()
    rects(ctx, lit)
    ctx.fill()
  }
  const b = m.route.end.body
  if (b !== undefined && m.weight === 'route') {
    ctx.strokeStyle = baseInk(m)
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(0.01 * Math.min(W, H), 0.12 * Math.min(b.w, b.h) * v.k) / v.k
    ctx.beginPath()
    rects(ctx, [b])
    ctx.stroke()
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

const boldPx = (F: Frame, v: MontageView): number => (F.m.weight === 'object' ? Math.max(routePx(F, v), 0.012 * Math.min(F.W, F.H)) : routePx(F, v))

function pulsesAt(F: Frame, v: MontageView, clock: number, ink: string): void {
  for (const p of F.m.pulses) {
    if (clock <= p.f0) continue
    stroke(F, v, p.path, ((clock - p.f0) * p.length) / p.dur, ink, p.bold ? boldPx(F, v) : pulsePx(F, v))
  }
}

function paintSplit(F: Frame, shot: MontageShot, v: MontageView, clock: number): void {
  const { ctx, m, W, H } = F
  const h = shot.hit as MontageHit
  if (h.act !== 'pins' && clock >= FAN_START) {
    useView(ctx, v, W, H)
    ctx.fillStyle = m.ink.spot
    ctx.beginPath()
    rects(ctx, m.pins)
    ctx.fill()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
  const fan = m.pulses.filter((p) => p.bold && p.f0 >= FAN_START)
  if (h.word !== undefined) {
    const period = Math.round(0.9 * F.tl.fps)
    const t = (F.f - shot.f0) / period
    fan.forEach((p, j) => {
      const u = (((t + j / fan.length) % 1) + 1) % 1
      const a = u * p.length
      const pts: number[] = []
      for (let k = 0; k <= 8; k++) {
        const q = along(p.path, Math.min(p.length, a + (0.14 * p.length * k) / 8))
        pts.push(q.x, q.y)
      }
      stroke(F, v, pts, Infinity, m.ink.paper, 0.6 * boldPx(F, v))
    })
  }
  const centres = m.ports.map((port) => {
    const q = port.map((r) => viewPoint(v, r.x, r.y, W, H))
    return { x: q.reduce((a, b) => a + b.x, 0) / q.length, y: q.reduce((a, b) => a + b.y, 0) / q.length }
  })
  const hub = viewPoint(v, m.hero.x, m.hero.y, W, H)
  const gap = Math.min(...centres.flatMap((c, i) => centres.slice(i + 1).map((d) => Math.hypot(c.x - d.x, c.y - d.y))), Infinity)
  const size = Math.min((0.14 * Math.min(W, H)) / CAP, (0.55 * gap) / CAP)
  const stretch = nameOf(ctx, m, W, H).stretch
  centres.forEach((c, j) => {
    const at = m.portAt[j] as number
    if (clock < at || j >= 9) return
    const pop = arrive(Math.min(1, (clock - at) / 4))
    heavy(ctx, size * (0.6 + 0.4 * pop), stretch)
    const text = String(j + 1)
    const w = ctx.measureText(text).width
    const capH = CAP * size * (0.6 + 0.4 * pop)
    const up = c.y < hub.y ? -1 : 1
    const y = c.y + up * (0.5 * capH + 0.12 * size)
    const pad = 0.16 * capH
    const box = { x0: c.x - w / 2 - pad, y0: y - capH / 2 - pad, x1: c.x + w / 2 + pad, y1: y + capH / 2 + pad }
    F.types.push({ ...box, text, crop: false, stop: false })
    ctx.fillStyle = F.ground
    ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0)
    ctx.fillStyle = m.ink.spot
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, c.x - w / 2, y + capH / 2)
  })
}

function countVias(F: Frame, v: MontageView, n: number, ink: string, swell: number): void {
  const { ctx, m, W, H } = F
  ctx.fillStyle = ink
  ctx.beginPath()
  for (const d of m.dots.slice(0, n)) {
    const q = viewPoint(v, d.x, d.y, W, H)
    const r = viaR(F, v, d.r) * 1.15 * swell
    if (q.x < -r || q.x > W + r || q.y < -r || q.y > H + r || Math.hypot(q.x - F.dot.x, q.y - F.dot.y) < ring(F) + r) continue
    ctx.moveTo(q.x + r, q.y)
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
  }
  ctx.fill()
}

function paintRuler(F: Frame, shot: MontageShot): void {
  const { ctx, m, W, H } = F
  const fact = m.fact
  if (fact?.kind !== 'ruler') return
  const left = viewPoint(fact.view, fact.from.x, fact.from.y, W, H).x
  const reach = fact.mm * arrive(span01(F.f, shot.f0, shot.f0 + g(F.tl, 8)))
  const at = (mm: number): number => left + (fact.right - left) * (mm / fact.mm)
  const min = Math.min(W, H)
  ctx.fillStyle = m.ink.spot
  const t = 0.012 * min
  ctx.fillRect(left, fact.line - t / 2, Math.max(0, at(reach) - left), t)
  ctx.beginPath()
  for (let mm = 0; mm <= reach + 1e-6; mm += 1) {
    const x = at(mm)
    const h = (mm % 10 === 0 ? 1 : mm % 5 === 0 ? 0.62 : 0.36) * fact.tick
    const w = mm % 10 === 0 ? 0.01 * min : 0.006 * min
    ctx.rect(x - w / 2, fact.line, w, h)
  }
  if (reach >= fact.mm - 1e-6) ctx.rect(fact.right - 0.005 * min, fact.line, 0.01 * min, fact.tick)
  ctx.fill()
}

interface Placed { x: number; baseline: number; size: number; unit: number; stretch: Parameters<typeof heavy>[2]; box: MontageBox }

const UNDER = 0.34
const GLOW_CELL = 0.03
const UNDER_GAP = 0.2
const MIN_UNDER = 0.2

function place(F: Frame, text: string, dots: DotState[], safe: MontageBox, under: string | undefined, keep: DotState[] = [], gap?: number): Placed | undefined {
  const { ctx, m, H } = F
  const stretch = nameOf(ctx, m, F.W, H).stretch
  const clear = gap ?? ring(F) + 0.02 * Math.min(F.W, H)
  const desc = DESC.test(text) ? 0.24 : 0
  const extra = under !== undefined ? UNDER + UNDER_GAP : 0
  const d = { x0: Math.min(...dots.map((q) => q.x)) - clear, y0: Math.min(...dots.map((q) => q.y)) - clear, x1: Math.max(...dots.map((q) => q.x)) + clear, y1: Math.max(...dots.map((q) => q.y)) + clear }
  const bands: MontageBox[] = dots.length === 0 ? [{ ...safe, y1: -Infinity }, safe] : [
    { x0: safe.x0, y0: safe.y0, x1: safe.x1, y1: Math.min(safe.y1, d.y0) },
    { x0: safe.x0, y0: Math.max(safe.y0, d.y1), x1: safe.x1, y1: safe.y1 },
    { x0: safe.x0, y0: safe.y0, x1: Math.min(safe.x1, d.x0), y1: safe.y1 },
    { x0: Math.max(safe.x0, d.x1), y0: safe.y0, x1: safe.x1, y1: safe.y1 }
  ]
  let best: Placed | undefined
  const off = keep.map((q) => ({ x0: q.x - clear, y0: q.y - clear, x1: q.x + clear, y1: q.y + clear }))
  for (const [i, b0] of bands.entries()) {
    const b = off.reduce((r, o) => (o.x1 < r.x0 || o.x0 > r.x1 || o.y1 < r.y0 || o.y0 > r.y1 ? r : i === 0 ? { ...r, y1: Math.min(r.y1, o.y0) } : i === 1 ? { ...r, y0: Math.max(r.y0, o.y1) } : i === 2 ? { ...r, x1: Math.min(r.x1, o.x0) } : { ...r, x0: Math.max(r.x0, o.x1) }), b0)
    const w = b.x1 - b.x0
    const h = b.y1 - b.y0
    if (w <= 0 || h <= 0) continue
    const fit = fitLine(ctx, text, w, Math.min(0.62 * H, h / (1 + Math.max(desc, extra) / CAP)), [stretch])
    heavy(ctx, 100, fit.stretch)
    const wide = under === undefined ? 0 : ctx.measureText(under).width / 100
    const size = under === undefined ? fit.size : Math.min(fit.size, w / (MIN_UNDER * wide))
    const unit = under === undefined ? UNDER : Math.min(UNDER, w / (size * wide))
    if (best !== undefined && size <= best.size) continue
    heavy(ctx, size, fit.stretch)
    const width = Math.max(ctx.measureText(text).width, wide * unit * size)
    const capH = CAP * size
    const low = Math.max(desc * size, extra * capH)
    const baseline = i === 0 ? b.y1 - low : i === 1 ? b.y0 + capH : Math.min(b.y1 - low, Math.max(b.y0 + capH, (b.y0 + b.y1 + capH - low) / 2))
    const x = i === 2 ? b.x1 - width : b.x0
    best = { x, baseline, size, unit, stretch: fit.stretch, box: { x0: x, y0: baseline - capH, x1: x + width, y1: baseline + low } }
  }
  return best
}

function underRuler(F: Frame, text: string): Placed | undefined {
  const fact = F.m.fact
  if (fact?.kind !== 'ruler') return undefined
  const left = viewPoint(fact.view, fact.from.x, fact.from.y, F.W, F.H).x
  const fit = fitLine(F.ctx, text, fact.right - left, fact.cap, [nameOf(F.ctx, F.m, F.W, F.H).stretch])
  heavy(F.ctx, fit.size, fit.stretch)
  const width = F.ctx.measureText(text).width
  const x = fact.right - width
  return { x, baseline: fact.baseline, size: fit.size, unit: UNDER, stretch: fit.stretch, box: { x0: x, y0: fact.baseline - CAP * fit.size, x1: fact.right, y1: fact.baseline } }
}

function toBoard(v: MontageView, x: number, y: number, W: number, H: number): Pt {
  const dx = x - W / 2
  const dy = y - H / 2
  const c = Math.cos(-v.rot)
  const s = Math.sin(-v.rot)
  return { x: v.cx + (c * dx - s * dy) / v.k, y: v.cy + (s * dx + c * dy) / v.k }
}

type Affine = [number, number, number, number, number, number]

function similarity(a: MontageView, b: MontageView, W: number, H: number): Affine {
  const p0 = toBoard(a, 0, 0, W, H)
  const p1 = toBoard(a, 1, 0, W, H)
  const o = viewPoint(b, p0.x, p0.y, W, H)
  const x = viewPoint(b, p1.x, p1.y, W, H)
  return [x.x - o.x, x.y - o.y, -(x.y - o.y), x.x - o.x, o.x, o.y]
}

const apply = (T: Affine, x: number, y: number): Pt => ({ x: T[0] * x + T[2] * y + T[4], y: T[1] * x + T[3] * y + T[5] })
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

interface WordGeom { T: Affine; p: Placed; text: string; layout: string; unit: string | undefined; counting: boolean }

function wordGeom(F: Frame, shot: MontageShot, v: MontageView): WordGeom | undefined {
  const { ctx, m, W, H } = F
  const h = shot.hit as MontageHit
  const counting = h.count !== undefined && h.word === undefined && h.count[1] > 0
  const text = h.word ?? (counting ? tallyText(m, h, hitTally(m, F.f)) : undefined)
  if (text === undefined) return undefined
  const layout = h.word ?? tallyText(m, h, h.tally?.total ?? m.count)
  const unit = h.unit ?? (h.count !== undefined && !h.flood ? m.countWord.split(' ')[1] : undefined)
  const fixed = h.follow || h.pin || h.clear
  const chain = [shot]
  if (h.pin) {
    const i0 = m.shots.indexOf(shot)
    const same = (q: MontageShot | undefined): boolean => q?.hit?.pin === true && q.hit.word === h.word && q.hit.act === h.act && q.hit.unit === h.unit
    for (let i = i0 - 1; same(m.shots[i]); i--) chain.unshift(m.shots[i] as MontageShot)
    for (let i = i0 + 1; same(m.shots[i]); i++) chain.push(m.shots[i] as MontageShot)
  }
  const track = h.pin ? chain.flatMap((q) => [q.f0, Math.floor((q.f0 + q.f1) / 2), q.f1 - 1]).map((f) => dotAt(ctx, F.tl, f)) : [dotAt(ctx, F.tl, shot.f0)]
  const v0 = fixed ? v : shotView(m, shot, shot.f0, W, H)
  const vEnd = fixed ? v : shotView(m, shot, shot.f1 - 1 - h.out, W, H)
  const mg = m.type.margin
  const frame = { x0: mg, y0: mg, x1: W - mg, y1: H - mg }
  const back = [toBoard(vEnd, frame.x0, frame.y0, W, H), toBoard(vEnd, frame.x1, frame.y1, W, H)].map((q) => viewPoint(v0, q.x, q.y, W, H))
  const safe = fixed ? frame : { x0: Math.max(frame.x0, Math.min(...back.map((q) => q.x))), y0: Math.max(frame.y0, Math.min(...back.map((q) => q.y))), x1: Math.min(frame.x1, Math.max(...back.map((q) => q.x))), y1: Math.min(frame.y1, Math.max(...back.map((q) => q.y))) }
  const below = h.ruler || (h.climax === 'split' && m.fact?.kind === 'ruler')
  const sp = h.spot === undefined ? undefined : viewPoint(v0, h.spot.x, h.spot.y, W, H)
  const board = [[m.board.x0, m.board.y0], [m.board.x1, m.board.y0], [m.board.x1, m.board.y1], [m.board.x0, m.board.y1]].map(([x, y]) => ({ ...viewPoint(h.climax === 'city' ? h.to : m.views.count0, x as number, y as number, W, H), r: 0, ink: '' }))
  const lit = h.climax === 'lamp' ? [m.route.end.light, m.hero].map((q) => ({ ...viewPoint(h.from, q.x, q.y, W, H), r: 0, ink: '' })) : undefined
  const around = h.clear ? board : sp !== undefined ? [{ ...sp, r: 0, ink: '' }] : lit ?? track
  const p = below ? underRuler(F, layout) : place(F, layout, around, safe, unit, sp !== undefined ? track : [], h.clear ? 0.055 * Math.min(W, H) : undefined)
  if (p === undefined || (!below && CAP * p.size < 0.045 * Math.min(W, H))) return undefined
  return { T: fixed ? IDENTITY : similarity(v0, v, W, H), p, text, layout, unit, counting }
}

function hitWord(F: Frame, shot: MontageShot, v: MontageView, ink: string): void {
  const { ctx } = F
  const w = wordGeom(F, shot, v)
  if (w === undefined) return
  const { T, p } = w
  const pad = 0.16 * CAP * p.size
  const c = [apply(T, p.box.x0, p.box.y0), apply(T, p.box.x1, p.box.y0), apply(T, p.box.x1, p.box.y1), apply(T, p.box.x0, p.box.y1)]
  const box = { x0: Math.min(...c.map((q) => q.x)), y0: Math.min(...c.map((q) => q.y)), x1: Math.max(...c.map((q) => q.x)), y1: Math.max(...c.map((q) => q.y)) }
  if (F.dry) {
    F.reserved.push(box)
    return
  }
  F.types.push({ ...box, text: w.text, crop: true, stop: false })
  ctx.setTransform(...T)
  ctx.fillStyle = F.ground
  ctx.fillRect(p.box.x0 - pad, p.box.y0 - pad, p.box.x1 - p.box.x0 + 2 * pad, p.box.y1 - p.box.y0 + 2 * pad)
  heavy(ctx, p.size, p.stretch)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  const x = w.counting ? p.x + ctx.measureText(w.layout).width - ctx.measureText(w.text).width : p.x
  ctx.fillStyle = ink
  ctx.fillText(w.text, x, p.baseline)
  if (w.unit !== undefined) {
    heavy(ctx, p.unit * p.size, p.stretch)
    ctx.fillText(w.unit, p.x, p.baseline + (UNDER_GAP + p.unit) * CAP * p.size)
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

function paintHit(F: Frame, shot: MontageShot): void {
  const { m, W, H } = F
  const h = shot.hit as MontageHit
  const v = F.view ?? montageView(m, F.f, W, H)
  const clock = hitClock(m, F.f)
  const d = hitDistance(m, F.f)
  const drawn = m.weight !== 'object' && h.path === 'route' && h.route[1] > 0
  if (h.climax === 'lamp' || h.climax === 'city') {
    if (!F.dry) {
      if (h.climax === 'lamp') paintLamp(F, shot, v)
      else {
        if (h.act === 'stack') solid(F, v, { copper: m.ink.spot, layer: h.layer, pours: true })
        paintCity(F, v, h.act === 'stack' ? m.dots.length : hitCount(m, F.f))
      }
    }
    if (F.words) hitWord(F, shot, v, m.ink.spot)
    return
  }
  if (h.act === 'stack' && !h.flood) {
    solid(F, v, { board: fgInk(m), copper: m.ink.spot, layer: h.layer, pours: true })
    if (F.dry) return
    if (F.words) hitWord(F, shot, v, m.ink.spot)
    return
  }
  if (h.flood) {
    solid(F, v, { copper: floodInk(m), layer: h.layer, holes: h.count !== undefined ? floodWord(m) : undefined, pours: h.act === 'stack' })
    if (F.dry) return
    if (drawn) stroke(F, v, m.route.path, d, floodWord(m), routePx(F, v))
    pulsesAt(F, v, clock, floodWord(m))
    if (F.words) hitWord(F, shot, v, floodWord(m))
    return
  }
  const layer = h.dot === 'head' && h.path === 'route' && m.route.layers.length > 1 ? (m.route.layers[m.route.breaks.findIndex((b, i) => i > 0 && d < b) - 1] ?? h.layer) : h.layer
  silhouette(F, v, layer)
  thing(F, v, h, clock, d >= m.route.length - 1e-6)
  if (F.dry) return
  if (h.act !== undefined) paintAct(F, v, h)
  if (h.count !== undefined && h.act === undefined) {
    const swell = h.word !== undefined ? 1 + 3.5 * (1 - smooth(span01(F.f, shot.f0, shot.f0 + g(F.tl, 10)))) : 1
    countVias(F, v, h.word !== undefined ? m.dots.length : hitCount(m, F.f), m.ink.spot, swell)
  }
  if (drawn) stroke(F, v, m.route.path, d, m.ink.spot, routePx(F, v))
  pulsesAt(F, v, clock, m.ink.spot)
  if (h.climax === 'split') paintSplit(F, shot, v, clock)
  if (h.ruler) paintRuler(F, shot)
  if (F.words) hitWord(F, shot, v, m.ink.spot)
}

interface Glow { cell: number; cells: number[]; back: number[] }
const glows = new WeakMap<object, Glow>()
function glowOf(F: Frame, v: MontageView): Glow {
  const { tl, m, W, H } = F
  const known = glows.get(m)
  if (known !== undefined) return known
  const cell = (GLOW_CELL * Math.min(W, H)) / v.k
  const b = m.board
  const cols = Math.ceil((b.x1 - b.x0) / cell)
  const rows = Math.ceil((b.y1 - b.y0) / cell)
  const area = new Float32Array(cols * rows)
  const put = (x: number, y: number, a: number): void => {
    const i = Math.floor((x - b.x0) / cell)
    const j = Math.floor((y - b.y0) / cell)
    if (i >= 0 && i < cols && j >= 0 && j < rows) area[j * cols + i] = (area[j * cols + i] as number) + a
  }
  const layer = home(m)
  const segs = tl.scene.layers.find((l) => l.id === layer)?.segs ?? []
  for (let i = 0; i < segs.length; i += 7) {
    const x0 = segs[i] as number
    const y0 = segs[i + 1] as number
    const x1 = segs[i + 2] as number
    const y1 = segs[i + 3] as number
    const w = segs[i + 4] as number
    const n = Math.max(1, Math.ceil((3 * Math.hypot(x1 - x0, y1 - y0)) / cell))
    for (let k = 0; k < n; k++) put(x0 + ((x1 - x0) * (k + 0.5)) / n, y0 + ((y1 - y0) * (k + 0.5)) / n, (Math.max(w, 0.25 * cell) * Math.hypot(x1 - x0, y1 - y0)) / n)
  }
  const side = layer.startsWith('B.') ? 'B' : 'F'
  for (const p of tl.scene.pads) {
    if (p.side !== side && p.side !== 'both') continue
    const n = Math.max(1, Math.ceil((2 * Math.max(p.w, p.h)) / cell))
    for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) put(p.x - p.w / 2 + (p.w * (a + 0.5)) / n, p.y - p.h / 2 + (p.h * (c + 0.5)) / n, (p.w * p.h) / (n * n))
  }
  const cells: number[] = []
  area.forEach((a, i) => {
    if (a > 0.02 * cell * cell) cells.push(b.x0 + ((i % cols) + 0.5) * cell, b.y0 + (Math.floor(i / cols) + 0.5) * cell, Math.min(1, a / (cell * cell)))
  })
  const path = m.route.path
  const back: number[] = []
  for (let i = path.length - 2; i >= 0; i -= 2) back.push(path[i] as number, path[i + 1] as number)
  const out = { cell, cells, back }
  glows.set(m, out)
  return out
}

function paintLamp(F: Frame, shot: MontageShot, v: MontageView): void {
  const { ctx, m, W, H } = F
  const h = shot.hit as MontageHit
  const lamp = m.route.end.light
  const first = m.shots.find((s) => s.hit?.climax === 'lamp') as MontageShot
  const glow = glowOf(F, first.hit?.from ?? v)
  const reach = Math.max(1e-6, Math.hypot(m.hero.x - lamp.x, m.hero.y - lamp.y))
  const far = Math.max(...[[m.board.x0, m.board.y0], [m.board.x1, m.board.y0], [m.board.x1, m.board.y1], [m.board.x0, m.board.y1]].map(([x, y]) => Math.hypot((x as number) - lamp.x, (y as number) - lamp.y)))
  const u = hitU(shot, F.f)
  const on = h.act === 'copper' ? 1 : arrive(span01(u, 0, 0.7))
  const R = h.act === 'copper' ? 1.35 * reach + (far - 1.35 * reach) * (hitTally(m, F.f) / Math.max(1e-9, h.tally?.total ?? 1)) : (0.2 + 1.15 * on) * reach
  const core = 4 * glow.cell
  const settle = h.act === 'copper' ? 1 - 0.75 * smooth(hitTally(m, F.f) / Math.max(1e-9, h.tally?.total ?? 1)) : 1
  if (h.act === 'copper') {
    const share = hitTally(m, F.f) / Math.max(1e-9, h.tally?.total ?? 1)
    const wide = Math.max(...[[m.board.x0, m.board.y0], [m.board.x1, m.board.y0], [m.board.x1, m.board.y1], [m.board.x0, m.board.y1]].map(([x, y]) => Math.hypot((x as number) - m.hero.x, (y as number) - m.hero.y)))
    const q = viewPoint(v, m.hero.x, m.hero.y, W, H)
    ctx.save()
    ctx.beginPath()
    ctx.arc(q.x, q.y, Math.max(1.2 * reach, wide * smooth(share)) * v.k, 0, Math.PI * 2)
    ctx.clip()
    silhouette(F, v)
    ctx.restore()
    paintAct(F, v, h)
  }
  ctx.fillStyle = m.ink.spot
  ctx.beginPath()
  const c = glow.cells
  for (let i = 0; i < c.length; i += 3) {
    const x = c[i] as number
    const y = c[i + 1] as number
    const d = Math.hypot(x - lamp.x, y - lamp.y)
    const fall = Math.max(0, 1 - d / R)
    const value = settle * Math.max(Math.min(1, 1.4 * (c[i + 2] as number)) * fall ** 1.6, (1 - d / core) * on)
    if (value <= 0.01) continue
    const q = viewPoint(v, x, y, W, H)
    const r = 0.6 * glow.cell * v.k * value ** 0.75
    if (r < 0.6 || q.x < -r || q.x > W + r || q.y < -r || q.y > H + r) continue
    ctx.moveTo(q.x + r, q.y)
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
  }
  ctx.fill()
  const lit = h.act === 'copper' ? m.route.length : m.route.length * arrive(span01(u, 0.08, 0.75))
  const ink = h.act === 'copper' ? m.ink.spot : m.ink.paper
  stroke(F, v, glow.back, lit, ink, routePx(F, v))
  if (lit >= m.route.length - 1e-6) {
    useView(ctx, v, W, H)
    ctx.fillStyle = ink
    ctx.translate(m.hero.x, m.hero.y)
    ctx.rotate(m.hero.rot)
    ctx.fillRect(-m.hero.w / 2, -m.hero.h / 2, m.hero.w, m.hero.h)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
}

const cityR = new WeakMap<object, number[]>()
function paintCity(F: Frame, v: MontageView, n: number): void {
  const { ctx, tl, m, W, H } = F
  const min = Math.min(W, H)
  let radii = cityR.get(m)
  if (radii === undefined) {
    const pts = m.dots.map((d) => viewPoint(m.views.count0, d.x, d.y, W, H))
    radii = pts.map((p, i) => {
      let nn = Infinity
      pts.forEach((q, j) => {
        if (j !== i) nn = Math.min(nn, Math.hypot(q.x - p.x, q.y - p.y))
      })
      return Math.max(0.0055 * min, Math.min(0.011 * min, 0.42 * nn))
    })
    cityR.set(m, radii)
  }
  useView(ctx, v, W, H)
  loops(ctx, tl)
  ctx.strokeStyle = m.ink.paper
  ctx.lineWidth = (0.004 * min) / v.k
  ctx.stroke()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const fresh = Math.max(2, 0.06 * n)
  ctx.fillStyle = m.ink.paper
  ctx.beginPath()
  m.dots.slice(0, n).forEach((d, i) => {
    const q = viewPoint(v, d.x, d.y, W, H)
    const r = (radii[i] as number) * (1 + 0.7 * Math.max(0, 1 - (n - i) / fresh)) * (v.k / m.views.count0.k)
    ctx.moveTo(q.x + r, q.y)
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
  })
  ctx.fill()
}

const orders = new WeakMap<object, number[]>()
function copperOrder(F: Frame): number[] {
  const { tl, m } = F
  const known = orders.get(tl.scene)
  if (known !== undefined) return known
  const all: number[] = []
  for (const l of tl.scene.layers) {
    for (let i = 0; i < l.segs.length; i += 7) all.push((l.segs[i] as number), (l.segs[i + 1] as number), (l.segs[i + 2] as number), (l.segs[i + 3] as number), (l.segs[i + 4] as number))
  }
  const n = all.length / 5
  const far = (i: number): number => Math.hypot((all[5 * i] as number) - m.hero.x, (all[5 * i + 1] as number) - m.hero.y)
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => far(a) - far(b))
  const out = idx.flatMap((i) => all.slice(5 * i, 5 * i + 5))
  orders.set(tl.scene, out)
  return out
}

function paintAct(F: Frame, v: MontageView, h: MontageHit): void {
  const { ctx, m, W, H } = F
  const share = h.count === undefined ? arrive(span01(hitU(montageShot(m, F.f), F.f), 0, 0.7)) : hitTally(m, F.f) / Math.max(1e-9, h.tally?.total ?? m.count)
  useView(ctx, v, W, H)
  ctx.fillStyle = m.ink.spot
  ctx.strokeStyle = m.ink.spot
  ctx.lineCap = 'round'
  if (h.act === 'copper') {
    const segs = copperOrder(F)
    const n = Math.round((share * segs.length) / 5)
    const thin = (1.2 * m.type.unit) / v.k
    for (let i = 0; i < n; i++) {
      ctx.lineWidth = Math.max(segs[5 * i + 4] as number, thin)
      ctx.beginPath()
      ctx.moveTo(segs[5 * i] as number, segs[5 * i + 1] as number)
      ctx.lineTo(segs[5 * i + 2] as number, segs[5 * i + 3] as number)
      ctx.stroke()
    }
  }
  if (h.act === 'parts' || h.act === 'pins') {
    const list = h.act === 'parts' ? m.blocks : m.pins
    const n = Math.max(1, Math.round(share * list.length))
    ctx.beginPath()
    rects(ctx, list.slice(0, n).flat())
    ctx.fill()
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

function paintName(F: Frame, shot: MontageShot): void {
  const { ctx, m, W, H } = F
  const word = m.words.find((w) => w.role === 'name') as MontageWord
  const k30 = F.tl.fps / 30
  const rise = (i: number): number => arrive(span01(F.f, word.f0 + 2 * k30 * i, word.f0 + 2 * k30 * i + 6 * k30))
  if (thingView(m) !== undefined) {
    silhouette(F, backView(m, shot, F.f, F.tl.fps, W, H))
    if (F.f >= word.f0) setName(F, nameAt(ctx, m, W, H), nameInk(m), rise)
    return
  }
  if (m.weight === 'density') {
    const e = irisOf(m, shot, F.f, F.tl.fps)
    if (e < 1 && !F.dry) {
      const v = m.views.poster
      ctx.fillStyle = baseInk(m)
      ctx.fillRect(0, 0, W, H)
      silhouette(F, v)
      pulsesAt(F, v, 100, m.ink.spot)
      const q = viewPoint(v, m.home.x, m.home.y, W, H)
      disc(ctx, q.x, q.y, Math.max(F.dot.r, Math.hypot(W, H) * e ** 1.5), m.ink.spot)
    }
    if (F.f >= word.f0) setName(F, nameAt(ctx, m, W, H), nameInk(m), rise)
    return
  }
  const s = 1 - span01(F.f, shot.f0, word.f0) ** 2
  if (s > 0.004 && !F.dry) {
    const v = m.views.poster
    const c = Math.cos(v.rot) * v.k
    const sn = Math.sin(v.rot) * v.k
    const ex = W / 2 - (c * v.cx - sn * v.cy)
    const ey = H / 2 - (sn * v.cx + c * v.cy)
    const q = viewPoint(v, m.home.x, m.home.y, W, H)
    const d = F.dot
    ctx.setTransform(s * c, s * sn, -s * sn, s * c, d.x + s * (ex - q.x), d.y + s * (ey - q.y))
    loops(ctx, F.tl)
    ctx.fillStyle = fgInk(m)
    ctx.fill('evenodd')
    ctx.strokeStyle = m.ink.spot
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = (0.12 * m.dotPx) / v.k
    ctx.beginPath()
    for (const p of m.pulses) polyline(ctx, p.path)
    if (m.weight !== 'object') polyline(ctx, m.route.path)
    ctx.stroke()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
  if (F.f >= word.f0) setName(F, nameAt(F.ctx, m, W, H), fgInk(m), rise)
}

function paintShot(F: Frame, shot: MontageShot, dot = true): void {
  const { ctx, W, H } = F
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = F.ground
  ctx.fillRect(0, 0, W, H)
  if (shot.kind === 'title') {
    const thing = thingView(F.m)
    if (thing !== undefined) silhouette(F, thing)
    setName(F, nameAt(ctx, F.m, W, H), nameInk(F.m))
  }
  else if (shot.kind === 'fall') paintFall(F, shot)
  else if (shot.kind === 'name') paintName(F, shot)
  else if (shot.hit !== undefined) {
    F.dry = true
    paintHit(F, shot)
    F.dry = false
    paintHit(F, shot)
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (dot) paintDot(F)
}

const groundOf = (m: MontageScore, shot: MontageShot): string => (shot.hit === undefined ? groundInk(m, shot.ground) : shot.ground === 'spot' ? m.ink.spot : shot.ground === 'black' ? m.ink.black : baseInk(m))

function frameOf(ctx: Ctx, tl: TraceTimeline, types: TypeBox[], shot: MontageShot, state: number, dot: DotState): Frame {
  const plain = tl.scene.montage as MontageScore
  const m = state - shot.f0 < (shot.hit?.invert ?? 0) ? { ...plain, base: plain.base === 'paper' ? ('black' as const) : ('paper' as const) } : plain
  const ground = groundOf(m, shot)
  return { ctx, tl, m, W: tl.width, H: tl.height, f: state, types, reserved: [], dry: false, ground, dot, view: undefined, words: true }
}

function windowShape(F: Frame, mask: Ctx, j: MontageJoinState, v: MontageView): void {
  const { m, W, H } = F
  const h = j.b.hit as MontageHit
  const diag = Math.hypot(W, H)
  const e = smooth(j.u)
  mask.fillStyle = '#fff'
  mask.strokeStyle = '#fff'
  if (h.into === 'iris') {
    const q = viewPoint(v, h.at.x, h.at.y, W, H)
    const r0 = Math.max(2, h.r > 0 ? h.r * v.k : 0.6 * m.dotPx)
    const R = r0 * (diag / r0) ** e
    mask.beginPath()
    mask.arc(q.x, q.y, R, 0, Math.PI * 2)
    mask.fill()
    return
  }
  const geom = wordGeom({ ...F, ctx: mask, f: j.j0 - 1 }, j.a, v)
  if (geom === undefined) {
    mask.fillRect(0, 0, W, H)
    return
  }
  const { T, p } = geom
  const cx = (p.box.x0 + p.box.x1) / 2
  const cy = (p.box.y0 + p.box.y1) / 2
  const grow = ((3 * diag) / Math.max(1, CAP * p.size)) ** (e ** 1.6)
  mask.setTransform(T[0] * grow, T[1] * grow, T[2] * grow, T[3] * grow, apply(T, cx, cy).x - grow * (T[0] * cx + T[2] * cy), apply(T, cx, cy).y - grow * (T[1] * cx + T[3] * cy))
  heavy(mask, p.size, p.stretch)
  mask.textAlign = 'left'
  mask.textBaseline = 'alphabetic'
  mask.fillText(geom.layout, p.x, p.baseline)
  mask.setTransform(1, 0, 0, 1, 0, 0)
}

export function drawMontageFrame(ctx: Ctx, tl: TraceTimeline, frame: number, types: TypeBox[] = [], surfaces?: Surfaces): number {
  const m = tl.scene.montage as MontageScore
  const W = tl.width
  const H = tl.height
  const shot = montageShot(m, frame)
  const dot = dotAt(ctx, tl, frame)
  const j = joinOf(m, frame)
  const hb = j?.b.hit
  if (j === undefined || hb === undefined) {
    paintShot(frameOf(ctx, tl, types, shot, frame, dot), shot)
    return 1
  }
  const v = montageView(m, frame, W, H)
  if (!windowed(hb)) {
    const F = frameOf(ctx, tl, types, j.b, j.b.f0, dot)
    if (hb.join === 'ascii') F.ground = groundOf(m, j.a)
    F.view = v
    const va = shotView(m, j.a, j.j0 - 1, W, H)
    F.words = hb.into === 'zoom' && hb.act === undefined && Math.max(va.k / hb.from.k, hb.from.k / va.k) < 3
    paintShot(F, j.b)
    return 1
  }
  if (surfaces === undefined) {
    const late = j.u >= 0.6
    const F = frameOf(ctx, tl, types, late ? j.b : shot, late ? j.b.f0 : frame, dot)
    if (late) {
      F.view = nextView(m, j, W, H)
      F.words = false
    }
    paintShot(F, late ? j.b : shot)
    return 1
  }
  const A = frameOf(ctx, tl, types, shot, frame, dot)
  paintShot(A, shot, false)
  const B = frameOf(surfaces.next, tl, [], j.b, j.b.f0, dot)
  B.view = nextView(m, j, W, H)
  B.words = false
  paintShot(B, j.b, false)
  const mask = surfaces.mask
  mask.setTransform(1, 0, 0, 1, 0, 0)
  mask.globalCompositeOperation = 'source-over'
  mask.clearRect(0, 0, W, H)
  windowShape(A, mask, j, v)
  mask.globalCompositeOperation = 'source-in'
  mask.drawImage(surfaces.next.canvas, 0, 0)
  mask.globalCompositeOperation = 'source-over'
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(mask.canvas, 0, 0)
  paintDot(A)
  return 1
}

const JOIN_CELLS = [0.075, 0.05, 0.032, 0.02]
const GLYPH_CELLS = [0.034, 0.03, 0.026, 0.022]

export function joinAt(m: MontageScore, frame: number): { kind: NonNullable<MontageHit['join']>; cell: number; seed: number } | undefined {
  const j = joinOf(m, frame)
  const kind = j?.b.hit?.join
  if (j === undefined || kind === undefined) return undefined
  const cells = kind === 'ascii' ? GLYPH_CELLS : JOIN_CELLS
  return { kind, cell: cells[Math.min(cells.length - 1, Math.floor(j.u * cells.length))] as number, seed: j.b.f0 }
}

export function createMontage(width: number, height: number, quality: TraceQuality): Montage {
  const canvas = (): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    return c
  }
  const out = canvas()
  const surfaces: Surfaces = { next: canvas().getContext('2d') as Ctx, mask: canvas().getContext('2d') as Ctx }
  const treat = createTreat(width, height)
  let hype: Hype | undefined
  return {
    render(tl, frame) {
      if (tl.scene.montage?.hype !== undefined) {
        hype ??= createHype(width, height, quality)
        return hype.render(tl, frame)
      }
      const ctx = out.getContext('2d') as Ctx
      drawMontageFrame(ctx, tl, frame, [], surfaces)
      const m = tl.scene.montage as MontageScore
      const j = joinAt(m, frame)
      if (j !== undefined && treat !== undefined) {
        const invert = j.kind === 'ascii' ? fgInk(m) === m.ink.paper : false
        const under = j.kind === 'ascii' ? groundOf(m, (joinOf(m, frame) as MontageJoinState).a) : m.ink.black
        const img = treat.render(out, { kind: j.kind, progress: 1, cell: Math.max(4, Math.round(j.cell * Math.min(width, height))), dark: under, light: m.ink.paper, invert, stream: m.glyphs, seed: j.seed })
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.drawImage(img, 0, 0)
      }
      return out
    },
    dispose() {
      treat?.dispose()
      hype?.dispose()
    }
  }
}
