import { FILM_SUB, PLOT_LAND, SIGNAL_HEAVY } from '@silk-reel/choreo'
import type { PlotAxo, PlotBody, PlotFlowSeg, PlotScore, TracePart, TraceScene } from '@silk-reel/choreo'
import { drawBody, post, vent } from './plot-body'
import { ID, apply, bleed, clamp01, drawPlan, easeInOut, geo, knockout, layerPaths, lettered, mixHex, planeName, scaleOf, setT, weights } from './plot-plan'
import type { Aff, Pen, Pt } from './plot-plan'

/** board px at height z → px, through an axonometric view */
export const axoAff = (v: PlotAxo, z: number): Aff => {
  const c = Math.cos(v.psi)
  const s = Math.sin(v.psi)
  const se = Math.sin(v.e)
  const ce = Math.cos(v.e)
  return [v.k * c, v.k * se * s, -v.k * s, v.k * se * c, v.x - v.k * (c * v.mx - s * v.my), v.y - v.k * se * (s * v.mx + c * v.my) - v.k * ce * z]
}

/** the same view seen through a 2D camera: zoom Z about (cx, cy) onto the frame's centre */
export const throughCamera = (v: PlotAxo, cam: { x: number; y: number; zoom: number }, W: number, H: number): PlotAxo =>
  ({ ...v, k: v.k * cam.zoom, x: cam.zoom * (v.x - cam.x) + W / 2, y: cam.zoom * (v.y - cam.y) + H / 2 })

export interface ObjectState {
  /** each layer's lift above its closed height, board px, top layer first */
  lift: number[]
  /** the parts' lift above the top copper */
  parts: number
  /** 0..1: how far the via projection lines have drawn */
  proj: number
  /** 0..1: how far the hidden edges have dashed in */
  hidden: number
  /** the top copper's strength */
  copper: number
  /** 0..1: how far the part bodies have faded in over the plan */
  bodies: number
  /** draws the top copper's plane through m in place of the object's own top copper: a film that travels keeps the drawing it travelled over; named false leaves out the main chip's name */
  plane?: ((m: Aff, named: boolean) => number) | undefined
  /** the hero lid's reading direction in its own axes, picked once for the film */
  read?: Pt | undefined
  /** 0..1: how far one part has been drawn on, when the parts are drawn one after another */
  reveal?: ((p: TracePart) => number) | undefined
  /** the strength of every body's ink but the main chip's, when a brighter line must stay the sheet's brightest */
  rest?: number | undefined
}

const path = (ctx: CanvasRenderingContext2D, pts: Pt[], close = true): void => {
  ctx.beginPath()
  pts.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  if (close) ctx.closePath()
}

const loopPts = (s: TraceScene, m: Aff): Pt[][] => s.board.map((l) => {
  const out: Pt[] = []
  for (let i = 0; i + 1 < l.length; i += 2) out.push(apply(m, l[i] as number, l[i + 1] as number))
  return out
})

/**
 * The assembled board drawn oblique: the copper layers as plates that lift
 * and close, the board's cut edge hatched under the heaviest line, part
 * bodies as prisms with their hidden edges dashed, the top copper inked as
 * in the plan.
 */
export function drawObject(pen: Pen, s: TraceScene, plot: PlotScore, view: PlotAxo, st: ObjectState, under?: () => number): number {
  const ctx = pen.ctx
  const g = geo(s)
  const { f, m, h } = weights(pen.u)
  const n = plot.stack.length
  const thick = s.material.thicknessPx
  const at = (z: number): Aff => axoAff(view, z)
  const zOf = (i: number): number => st.lift[i] ?? 0
  const sc = scaleOf(at(0))
  const px = (v: number): number => v / sc
  let drawn = 0
  const chip = s.parts.find((p) => p.hero === true)
  const lidded = chip !== undefined && st.bodies > 0 && st.read !== undefined && (st.reveal?.(chip) ?? 1) > 0 && !roundBody(plot, chip) && bodyOf(plot, chip)?.lone === true
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])

  const zb = zOf(n - 1)
  const top = loopPts(s, at(zb))
  const bot = loopPts(s, at(zb - thick))
  setT(pen, [1, 0, 0, 1, 0, 0])
  knockout(pen, () => {
    for (const l of bot) {
      path(ctx, l)
      ctx.fill()
    }
  })
  const cut = Math.max(0, ...st.lift) > 1e-3
  ctx.save()
  ctx.beginPath()
  for (const l of bot) {
    l.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
  }
  ctx.clip()
  bleed(pen, false)
  ctx.strokeStyle = pen.ink
  ctx.globalAlpha = 0.6
  ctx.lineWidth = f
  const all = [...top.flat(), ...bot.flat()]
  const x0 = Math.min(...all.map((q) => q[0]))
  const x1 = Math.max(...all.map((q) => q[0]))
  const y0 = Math.min(...all.map((q) => q[1]))
  const y1 = Math.max(...all.map((q) => q[1]))
  ctx.beginPath()
  if (cut) for (let x = x0 - (y1 - y0); x < x1; x += 4 * pen.u) {
    ctx.moveTo(x, y1)
    ctx.lineTo(x + (y1 - y0), y0)
  }
  ctx.stroke()
  ctx.restore()
  ctx.globalAlpha = 1
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = h
  for (const l of bot) {
    path(ctx, l)
    ctx.stroke()
  }
  const flat = top.flat()
  const ext = [flat.reduce((b, q) => (q[0] < b[0] ? q : b), flat[0] ?? [0, 0]), flat.reduce((b, q) => (q[0] > b[0] ? q : b), flat[0] ?? [0, 0]), flat.reduce((b, q) => (q[1] > b[1] ? q : b), flat[0] ?? [0, 0])]
  const down = apply(at(zb - thick), 0, 0)[1] - apply(at(zb), 0, 0)[1]
  ctx.beginPath()
  for (const q of ext) {
    ctx.moveTo(q[0], q[1])
    ctx.lineTo(q[0], q[1] + down)
  }
  ctx.stroke()
  drawn += 2

  for (let i = n - 1; i >= 0; i--) {
    const layer = plot.stack[i]
    if (layer === undefined) continue
    const mi = at(zOf(i))
    setT(pen, mi)
    knockout(pen, () => {
      ctx.globalAlpha = pen.transparent ? 1 : 0.9
      ctx.fill(g.outline, 'evenodd')
      ctx.globalAlpha = 1
    })
    if (i === 0) {
      drawn += st.plane !== undefined ? st.plane(mi, !lidded) : drawPlan(lidded ? { ...pen, hero: undefined } : pen, s, mi, { hatch: 1, back: 0, parts: -1, drills: 2, edge: 0, quiet: st.copper, fine: st.copper })
    } else {
      const lp = layerPaths(s, layer.name, layer.layer, layer.zones)
      ctx.strokeStyle = pen.ink
      setT(pen, mi)
      ctx.strokeStyle = pen.ink
      ctx.globalAlpha = 0.35
      ctx.lineWidth = px(f)
      ctx.stroke(lp.zones)
      ctx.globalAlpha = 0.45
      ctx.stroke(lp.lines)
      ctx.globalAlpha = 1
    }
    setT(pen, mi)
    ctx.strokeStyle = pen.ink
    ctx.lineWidth = px(i === 0 || i === n - 1 ? h : m)
    ctx.stroke(g.outline)
    drawn += 2
  }
  drawn += edgeFingers(pen, s, at(zOf(0)))

  if (st.proj > 0 && n > 1) {
    setT(pen, [1, 0, 0, 1, 0, 0])
    ctx.strokeStyle = pen.ink
    ctx.lineWidth = f
    ctx.setLineDash([6 * pen.u, 4 * pen.u])
    const a0 = at(zOf(0))
    const a1 = at(zb)
    ctx.beginPath()
    for (let j = 0; j + 1 < plot.vias.length; j += 2) {
      const vx = plot.vias[j] as number
      const vy = plot.vias[j + 1] as number
      const p = apply(a0, vx, vy)
      const q = apply(a1, vx, vy)
      ctx.moveTo(p[0], p[1])
      ctx.lineTo(p[0] + (q[0] - p[0]) * st.proj, p[1] + (q[1] - p[1]) * st.proj)
    }
    ctx.stroke()
    ctx.setLineDash([])
    drawn += 1
  }

  const rise = apply(at(0), 0, 0)[1] - apply(at(1), 0, 0)[1]
  const headroom = s.parts.filter((p) => p.kind !== 'pin').reduce((room, p) => {
    const r = Math.hypot(p.w, p.h) / 2
    const q = apply(at(zOf(0) + p.z), p.x, p.y)
    const top = q[1] - r * sc
    return Math.min(room, rise > 1e-9 ? (top - 0.1 * pen.H) / rise : Infinity)
  }, Infinity)
  const zp = zOf(0) + Math.min(st.parts, Math.max(0, headroom))
  const ground = at(0)
  const parts = s.parts.filter((p) => p.kind !== 'pin').map((p) => ({ p, d: apply(ground, p.x, p.y)[1] })).sort((a, b) => a.d - b.d)
  if (st.parts > 1) {
    setT(pen, at(zp))
    ctx.strokeStyle = pen.ink
    ctx.globalAlpha = 0.45
    ctx.lineWidth = px(f)
    ctx.setLineDash([px(5 * pen.u), px(4 * pen.u)])
    ctx.stroke(g.outline)
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
  if (zp - zOf(0) > 1e-6) {
    const top = at(zp)
    const down = at(zOf(0))
    setT(pen, [1, 0, 0, 1, 0, 0])
    ctx.strokeStyle = pen.ink
    ctx.globalAlpha = 0.7
    ctx.lineWidth = f
    ctx.setLineDash([4 * pen.u, 4 * pen.u])
    ctx.beginPath()
    for (const { p } of parts) {
      const co = Math.cos(p.rot)
      const si = Math.sin(p.rot)
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [p.x + (co * (i as number) * p.w - si * (j as number) * p.h) / 2, p.y + (si * (i as number) * p.w + co * (j as number) * p.h) / 2] as const)
      if (corners.every(([x, y]) => overBoard(s, x, y))) continue
      const a = apply(top, p.x, p.y)
      const b = apply(down, p.x, p.y)
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
  construction(pen, s, at(zOf(0)), st.hidden)
  setT(pen, [1, 0, 0, 1, 0, 0])
  if (under !== undefined) {
    drawn += under()
    setT(pen, [1, 0, 0, 1, 0, 0])
  }
  const outer = ctx.filter !== 'none' ? `${ctx.filter} ` : ''
  if (st.bodies > 0) {
    ctx.filter = st.bodies < 1 ? `${outer}opacity(${st.bodies})` : outer === '' ? 'none' : outer.trim()
    let heroK = 1
    const dim: Pen = st.rest === undefined ? pen : { ...pen, ink: mixHex(pen.ink, pen.stock, 1 - st.rest) }
    for (const { p } of parts) {
      const k = st.reveal?.(p) ?? 1
      if (p.hero === true) heroK = k
      if (k <= 0) continue
      const reach = 2.4 * (p.w + p.h + 2 * p.z) * sc
      const bp = p.hero === true ? pen : dim
      const risen = p.hero === true && k < 1 ? { ...p, z: p.z * easeInOut(k) } : p
      drawn += k < 1 ? growing(bp, k, reach, (gp) => body(gp, plot, at, zp, risen, st.hidden, s, st.read), p.hero === true) : body(bp, plot, at, zp, risen, st.hidden, s, st.read)
      if (p.hero === true && pen.lid !== undefined && !roundBody(plot, p) && bodyOf(plot, p)?.lone === true) {
        const q = onBoard(s, risen)
        planeName(pen, q, pen.lid, at(zp + q.z))
      }
    }
    if (heroK > 0) drawn += heroK < 1 ? growing(pen, heroK, 0.5 * pen.W, (gp) => leads(gp, s, at, zp, easeInOut(heroK))) : leads(pen, s, at, zp)
    ctx.filter = outer === '' ? 'none' : outer.trim()
  }
  bleed(pen, false)
  return drawn
}

/**
 * Draws with every line grown k of the way along its length from its start:
 * a dash as long as k of reach, then a gap longer than any line, so each
 * subpath restarts the pattern and a long edge takes longer than a short one.
 * Fills come in with k, and lettering too unless whole: then it stands at full
 * strength from the first frame, and so does its paper, which hides what lies
 * under the body from the first frame.
 */
export function growing(pen: Pen, k: number, reach: number, draw: (pen: Pen) => number, whole = false): number {
  const ctx = pen.ctx
  const grow = [Math.max(0.01, k * reach), 1e5]
  const paper = pen.stock.toLowerCase()
  const faint = (name: 'fill' | 'fillRect' | 'fillText') => (...a: unknown[]): void => {
    if (whole && typeof ctx.fillStyle === 'string' && ctx.fillStyle.toLowerCase() === paper) {
      ;(ctx[name] as (...b: unknown[]) => void).apply(ctx, a)
      return
    }
    const g = ctx.globalAlpha
    ctx.globalAlpha = g * k
    ;(ctx[name] as (...b: unknown[]) => void).apply(ctx, a)
    ctx.globalAlpha = g
  }
  const wrapped: Record<string, unknown> = { setLineDash: (): void => { ctx.setLineDash(grow) }, fill: faint('fill'), fillRect: faint('fillRect'), ...(whole ? {} : { fillText: faint('fillText') }) }
  const proxy = new Proxy(ctx, {
    get: (t, prop): unknown => {
      if (typeof prop === 'string' && prop in wrapped) return wrapped[prop]
      const v: unknown = Reflect.get(t, prop, t)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
    set: (t, prop, v): boolean => Reflect.set(t, prop, v, t)
  })
  ctx.setLineDash(grow)
  try {
    return draw({ ...pen, ctx: proxy })
  } finally {
    ctx.setLineDash([])
  }
}

/** whether a board point lies on the board, inside its outline and outside its cut-outs */
export const overBoard = (s: TraceScene, x: number, y: number): boolean => {
  let inside = false
  for (const l of s.board) {
    for (let i = 0, j = l.length - 2; i + 1 < l.length; j = i, i += 2) {
      const ax = l[i] as number
      const ay = l[i + 1] as number
      const bx = l[j] as number
      const by = l[j + 1] as number
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
    }
  }
  return inside
}

/** a square-set part cut back side by side until its corners sit over the board, so a connector that overhangs the edge rests on the board instead of hanging in the air */
const onBoard = (s: TraceScene, p: TracePart): TracePart => {
  const c = Math.abs(Math.cos(p.rot))
  const sn = Math.abs(Math.sin(p.rot))
  if (Math.min(c, sn) > 0.02) return p
  const hw = (c > sn ? p.w : p.h) / 2
  const hh = (c > sn ? p.h : p.w) / 2
  let [x0, x1, y0, y1] = [p.x - hw, p.x + hw, p.y - hh, p.y + hh]
  const on = (x: number, y: number): boolean => overBoard(s, x, y)
  const step = 0.04
  for (let k = 0; k < 15; k++) {
    if (!on(x0, y0) && !on(x0, y1) && x1 - x0 > step * 2 * hw) x0 += step * 2 * hw
    if (!on(x1, y0) && !on(x1, y1) && x1 - x0 > step * 2 * hw) x1 -= step * 2 * hw
    if (!on(x0, y0) && !on(x1, y0) && y1 - y0 > step * 2 * hh) y0 += step * 2 * hh
    if (!on(x0, y1) && !on(x1, y1) && y1 - y0 > step * 2 * hh) y1 -= step * 2 * hh
  }
  if (x0 === p.x - hw && x1 === p.x + hw && y0 === p.y - hh && y1 === p.y + hh) return p
  const w = x1 - x0
  const h = y1 - y0
  return { ...p, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: c > sn ? w : h, h: c > sn ? h : w }
}

/** a part body drawn in the oblique: a cylinder when its footprint is round, else a box */
export function body(pen: Pen, plot: PlotScore, at: (z: number) => Aff, zp: number, part: TracePart, hidden: number, s?: TraceScene, read?: Pt): number {
  const p = s === undefined ? part : onBoard(s, part)
  const b = bodyOf(plot, part)
  if (!roundBody(plot, p)) {
    const n = drawBody(pen, at, zp, p, b, p.hero === true, hidden, read)
    if (b?.style === 'header' && n > 0) {
      const c = Math.cos(p.rot)
      const sn = Math.sin(p.rot)
      const inside = (x: number, y: number): boolean => Math.abs(c * (x - p.x) + sn * (y - p.y)) <= p.w / 2 && Math.abs(-sn * (x - p.x) + c * (y - p.y)) <= p.h / 2
      const pins = (s?.parts ?? []).filter((q) => q.kind === 'pin' && inside(q.x, q.y))
      if (pins.length > 0) for (const q of pins) post(pen, at, zp, q.x, q.y, Math.max(q.w, q.h), q.seat ?? p.z, Math.max(q.z, (q.seat ?? p.z) + 0.3 * q.z))
      else for (const pd of b.pads) post(pen, at, zp, pd[0], pd[1], 0.4 * Math.min(pd[2], pd[3]), p.z, 2.6 * p.z)
    }
    return n
  }
  const n = cylinder(pen, at, zp, p, hidden)
  if (b?.style === 'elec') vent(pen, at, zp + p.z, p.x, p.y, Math.min(p.w, p.h) / 2)
  return n
}

/** the blueprint's record of a scene part: the body whose centre it shares */
/** whether a part is drawn as a cylinder, which carries no lid lettering */
const roundBody = (plot: PlotScore, p: TracePart): boolean => p.kind === 'valve' || p.kind === 'can' || plot.round.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < 0.3 * Math.min(p.w, p.h))

export const bodyOf = (plot: PlotScore, p: TracePart): PlotBody | undefined => plot.bodies.find((q) => Math.abs(q.x - p.x) < 1e-3 && Math.abs(q.y - p.y) < 1e-3)

/** a hidden edge's dots: round caps on zero-length dashes, a little over three line widths apart */
const DOTS = (pen: Pen): number[] => [0, 3.4 * pen.u]

/** light falls from the upper left of the frame: a face turned away from it is in shadow and takes the hatch */





function cylinder(pen: Pen, at: (z: number) => Aff, zp: number, p: TracePart, hidden: number): number {
  if (p.kind !== 'valve') return drum(pen, at, zp, p, hidden)
  const r0 = Math.min(p.w, p.h) / 2
  const seat = 0.24 * r0
  drum(pen, at, zp, { ...p, w: 2.3 * r0, h: 2.3 * r0, z: seat, kind: 'other', hero: false }, hidden)
  return drum(pen, at, zp + seat, { ...p, z: p.z - seat }, hidden)
}

function drum(pen: Pen, at: (z: number) => Aff, zp: number, p: TracePart, hidden: number): number {
  const ctx = pen.ctx
  const { f, m } = weights(pen.u)
  const r = Math.min(p.w, p.h) / 2
  const ring = (z: number, rr = r): Pt[] => Array.from({ length: 48 }, (_, i) => apply(at(z), p.x + rr * Math.cos((i / 48) * Math.PI * 2), p.y + rr * Math.sin((i / 48) * Math.PI * 2)))
  const zt = zp + p.z
  const base = ring(zp)
  const top = ring(zt)
  const domed = p.kind === 'valve' || p.z > 2.2 * r
  const rise = p.kind === 'valve' ? 0.9 * r : 0.6 * r
  const dome = domed ? Array.from({ length: 6 }, (_, k) => ring(zt + rise * Math.sin(((k + 1) / 6) * (Math.PI / 2)), r * Math.cos(((k + 1) / 6) * (Math.PI / 2)))).flat() : []
  const sil = hull([...base, ...top, ...dome])
  if (Math.max(...sil.map((q) => q[0])) - Math.min(...sil.map((q) => q[0])) < 3 * pen.u) return 0
  pen.hides?.push(sil.map((q) => apply(pen.m ?? [1, 0, 0, 1, 0, 0], q[0], q[1])))
  knockout(pen, () => {
    path(ctx, sil)
    ctx.fill()
  })
  ctx.strokeStyle = pen.ink
  const below = (q: Pt, ell: Pt[]): boolean => {
    const l = ell.reduce((b, v) => (v[0] < b[0] ? v : b), ell[0] as Pt)
    const rr = ell.reduce((b, v) => (v[0] > b[0] ? v : b), ell[0] as Pt)
    return q[1] >= l[1] + ((q[0] - l[0]) / Math.max(1e-6, rr[0] - l[0])) * (rr[1] - l[1]) - 1e-6
  }
  const front = (ell: Pt[]): Pt[] => {
    const k0 = ell.findIndex((q, i) => below(q, ell) && !below(ell[(i + ell.length - 1) % ell.length] as Pt, ell))
    const out: Pt[] = []
    for (let i = 0; i < ell.length; i++) {
      const q = ell[(Math.max(0, k0) + i) % ell.length] as Pt
      if (below(q, ell)) out.push(q)
    }
    return out
  }
  if (hidden > 0) {
    ctx.lineWidth = f
    ctx.globalAlpha = hidden
    ctx.setLineDash([4 * pen.u, 3 * pen.u])
    path(ctx, base.filter((q) => !below(q, base)), false)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
  if (p.kind === 'valve') {
    valveInside(pen, at, zp, p, r, front, below)
    const inner = [ring(zp, 0.92 * r), ring(zt, 0.92 * r)]
    ctx.lineWidth = m
    ctx.beginPath()
    for (const pick of [(a: Pt, b: Pt): boolean => a[0] < b[0], (a: Pt, b: Pt): boolean => a[0] > b[0]]) {
      const [lo, hi] = inner.map((ell) => ell.reduce((b, q) => (pick(q, b) ? q : b), ell[0] as Pt)) as [Pt, Pt]
      ctx.moveTo(lo[0], lo[1])
      ctx.lineTo(hi[0], hi[1])
    }
    ctx.stroke()
  }
  ctx.lineWidth = m
  if (!domed) {
    path(ctx, top)
    ctx.stroke()
  }
  ctx.lineWidth = p.hero === true ? weights(pen.u).h : m
  path(ctx, sil)
  ctx.stroke()
  return 1
}

/** a valve seen through its glass: mica spacers, two anode plates between them, the pins up through the base, the getter, one highlight */
function valveInside(pen: Pen, at: (z: number) => Aff, zp: number, p: TracePart, r: number, front: (ell: Pt[]) => Pt[], below: (q: Pt, ell: Pt[]) => boolean): void {
  const ctx = pen.ctx
  const { f } = weights(pen.u)
  const pt = (x: number, y: number, z: number): Pt => apply(at(z), p.x + x, p.y + y)
  const ring = (z: number, rr: number): Pt[] => Array.from({ length: 48 }, (_, i) => pt(rr * Math.cos((i / 48) * Math.PI * 2), rr * Math.sin((i / 48) * Math.PI * 2), z))
  const dashed = (on: boolean): void => { ctx.setLineDash(on ? DOTS(pen) : []) }
  ctx.save()
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = f
  for (const k of [0.16, 0.74]) {
    const disc = ring(zp + k * p.z, 0.84 * r)
    dashed(true)
    ctx.globalAlpha = 0.6
    path(ctx, disc.filter((q) => !below(q, disc)), false)
    ctx.stroke()
    dashed(false)
    ctx.globalAlpha = 1
    path(ctx, front(disc), false)
    ctx.stroke()
  }
  for (const ux of [-0.45, 0.45]) {
    for (const side of [-1, 1]) {
      const corners: Pt[] = []
      for (const z of [0.2, 0.7]) for (const [x, y] of [[-0.24, 0.17], [0.24, 0.17], [0.24, 0.27], [-0.24, 0.27]] as const) corners.push(pt((ux + x) * r, side * y * r, zp + z * p.z))
      ctx.globalAlpha = side > 0 ? 1 : 0.6
      dashed(side < 0)
      path(ctx, hull(corners))
      ctx.stroke()
    }
    dashed(false)
    ctx.globalAlpha = 0.8
    for (const gx of [-0.12, 0.12]) {
      const g0 = pt((ux + gx) * r, 0, zp + 0.22 * p.z)
      const g1 = pt((ux + gx) * r, 0, zp + 0.68 * p.z)
      ctx.setLineDash([2 * pen.u, 3 * pen.u])
      ctx.beginPath()
      ctx.moveTo(g0[0], g0[1])
      ctx.lineTo(g1[0], g1[1])
      ctx.stroke()
    }
    dashed(false)
  }
  dashed(false)
  ctx.globalAlpha = 0.8
  ctx.beginPath()
  for (let i = 0; i < 9; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 10
    const lo = pt(0.6 * r * Math.cos(a), 0.6 * r * Math.sin(a), zp - 0.04 * p.z)
    const hi = pt(0.6 * r * Math.cos(a), 0.6 * r * Math.sin(a), zp + 0.16 * p.z)
    ctx.moveTo(lo[0], lo[1])
    ctx.lineTo(hi[0], hi[1])
  }
  ctx.stroke()
  ctx.globalAlpha = 1
  const getter = ring(zp + 0.9 * p.z, 0.32 * r)
  path(ctx, getter)
  ctx.stroke()
  const post0 = pt(0, 0, zp + 0.74 * p.z)
  const post1 = pt(0, 0, zp + 0.9 * p.z)
  ctx.beginPath()
  ctx.moveTo(post0[0], post0[1])
  ctx.lineTo(post1[0], post1[1])
  ctx.stroke()
  const h0 = pt(-0.94 * r * Math.cos(0.5), 0.94 * r * Math.sin(0.5), zp + 0.1 * p.z)
  const h1 = pt(-0.94 * r * Math.cos(0.5), 0.94 * r * Math.sin(0.5), zp + 0.88 * p.z)
  ctx.lineWidth = f
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.moveTo(h0[0], h0[1])
  ctx.lineTo(h1[0], h1[1])
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.lineCap = 'round'
  for (const ux of [-0.45, 0.45]) {
    const c0 = pt(ux * r, 0, zp + 0.18 * p.z)
    const c1 = pt(ux * r, 0, zp + 0.72 * p.z)
    ctx.strokeStyle = pen.ink
    ctx.lineWidth = 3.2 * weights(pen.u).m
    ctx.beginPath()
    ctx.moveTo(c0[0], c0[1])
    ctx.lineTo(c1[0], c1[1])
    ctx.stroke()
    ctx.strokeStyle = pen.accent
    ctx.lineWidth = 1.6 * weights(pen.u).m
    const f0 = pt(ux * r, 0, zp + 0.12 * p.z)
    ctx.beginPath()
    ctx.moveTo(f0[0], f0[1])
    ctx.lineTo(c1[0], c1[1])
    ctx.stroke()
  }
  ctx.restore()
}


/** a plug's contacts on the far side of the board, drawn hidden: dashed outlines of the long pads that run to the board's edge */
function edgeFingers(pen: Pen, s: TraceScene, m: Aff): number {
  const ctx = pen.ctx
  const { x0, y0, x1, y1 } = geo(s).bounds
  const fingers = s.pads.filter((pd) => {
    if (pd.side !== 'B') return false
    const long = Math.max(pd.w, pd.h)
    if (long < 3 * Math.min(pd.w, pd.h)) return false
    return Math.min(pd.x - x0, x1 - pd.x, pd.y - y0, y1 - pd.y) < long
  })
  if (fingers.length < 3) return 0
  setT(pen, [1, 0, 0, 1, 0, 0])
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = weights(pen.u).f
  ctx.globalAlpha = 0.8
  ctx.setLineDash([5 * pen.u, 3 * pen.u])
  for (const pd of fingers) {
    const c = Math.cos(pd.rot)
    const sn = Math.sin(pd.rot)
    path(ctx, [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => apply(m, pd.x + c * (a as number) * pd.w / 2 - sn * (b as number) * pd.h / 2, pd.y + sn * (a as number) * pd.w / 2 + c * (b as number) * pd.h / 2)))
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  return fingers.length
}

/** the hero's gull-wing leads: a short line from each pad outside the body up to the body's edge */
function leads(pen: Pen, s: TraceScene, at: (z: number) => Aff, zp: number, rise = 1): number {
  const ctx = pen.ctx
  const hero = s.parts.find((p) => p.hero === true && p.kind !== 'pin')
  if (hero === undefined) return 0
  const c = Math.cos(hero.rot)
  const sn = Math.sin(hero.rot)
  let n = 0
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = weights(pen.u).f
  ctx.beginPath()
  for (const pd of s.pads) {
    if (pd.hero !== true) continue
    const dx = pd.x - hero.x
    const dy = pd.y - hero.y
    const lx = c * dx + sn * dy
    const ly = -sn * dx + c * dy
    if (Math.abs(lx) <= hero.w / 2 && Math.abs(ly) <= hero.h / 2) continue
    const ex = Math.max(-hero.w / 2, Math.min(hero.w / 2, lx))
    const ey = Math.max(-hero.h / 2, Math.min(hero.h / 2, ly))
    const a = apply(at(zp), pd.x, pd.y)
    const b = apply(at(zp + 0.3 * hero.z * rise), hero.x + c * ex - sn * ey, hero.y + sn * ex + c * ey)
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    n += 1
  }
  ctx.stroke()
  return n
}

/** the draughtsman's set-up, left faintly in: the board's bounding box and dash-dot centre lines through the hero and the mounting holes */
function construction(pen: Pen, s: TraceScene, m: Aff, alpha: number): void {
  if (alpha <= 0) return
  const ctx = pen.ctx
  const { x0, y0, x1, y1 } = geo(s).bounds
  const k = 0.04 * Math.max(x1 - x0, y1 - y0)
  setT(pen, [1, 0, 0, 1, 0, 0])
  bleed(pen, false)
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = weights(pen.u).f
  ctx.globalAlpha = 0.4 * alpha
  ctx.setLineDash([12 * pen.u, 4 * pen.u, 2 * pen.u, 4 * pen.u])
  ctx.beginPath()
  const run = 4 * k
  for (const [a, b] of [[[x0 - run, y0], [x1 + run, y0]], [[x0 - run, y1], [x1 + run, y1]], [[x0, y0 - run], [x0, y1 + run]], [[x1, y0 - run], [x1, y1 + run]]] as const) {
    const p0 = apply(m, a[0], a[1])
    const p1 = apply(m, b[0], b[1])
    ctx.moveTo(p0[0], p0[1])
    ctx.lineTo(p1[0], p1[1])
  }
  const cross = (x: number, y: number, r: number): void => {
    for (const [a, b] of [[apply(m, x - r, y), apply(m, x + r, y)], [apply(m, x, y - r), apply(m, x, y + r)]] as const) {
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
    }
  }
  const hero = s.parts.find((p) => p.hero === true && p.kind !== 'pin')
  if (hero !== undefined) cross(hero.x, hero.y, 0.85 * Math.max(hero.w, hero.h))
  for (const pd of s.pads) if (pd.ring === true) cross(pd.x, pd.y, 1.5 * Math.max(pd.w, pd.h))
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 1
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
const hull = (pts: Pt[]): Pt[] => {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const lo: Pt[] = []
  for (const p of s) {
    while (lo.length >= 2 && cross(lo[lo.length - 2] as Pt, lo[lo.length - 1] as Pt, p) <= 0) lo.pop()
    lo.push(p)
  }
  const hi: Pt[] = []
  for (const p of s.reverse()) {
    while (hi.length >= 2 && cross(hi[hi.length - 2] as Pt, hi[hi.length - 1] as Pt, p) <= 0) hi.pop()
    hi.push(p)
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)]
}

/** the height a board point sits at on the assembled board: the top of the body over it, else the copper */
export function topAt(s: TraceScene, x: number, y: number): number {
  let z = 0
  for (const p of s.parts) {
    if (p.kind === 'pin') continue
    const c = Math.cos(-p.rot)
    const sn = Math.sin(-p.rot)
    const dx = x - p.x
    const dy = y - p.y
    if (Math.abs(c * dx - sn * dy) <= p.w / 2 && Math.abs(sn * dx + c * dy) <= p.h / 2) z = Math.max(z, p.z)
  }
  return z
}

/**
 * The supply path in chalk on the board: one stroke from the entry that
 * grows to p, at 2.5× the copper line weight under a soft halo, dashed straight
 * where it crosses a plane or a part, a dot at each layer change, a tick on
 * each power pin it reaches.
 */
/** the supply route's stroke width: two and a half times a part's outline */
export const flowCore = (u: number): number => 2.5 * weights(u).m


/** the signal where the bodies hide it: its run dashed in the same heavy pen inside each body's outline, so it can be followed to its pin */
export function hiddenFlow(pen: Pen, segs: PlotFlowSeg[], m: Aff, p: number, hides: Pt[][]): void {
  const ctx = pen.ctx
  const core = flowCore(pen.u)
  const live = segs.filter((sg) => p >= sg.p0 && sg.plane !== true)
  if (live.length === 0 || hides.length === 0) return
  setT(pen, [1, 0, 0, 1, 0, 0])
  for (const sil of hides) {
    ctx.save()
    ctx.beginPath()
    for (const q of sil) ctx.lineTo(q[0], q[1])
    ctx.closePath()
    ctx.clip()
    ctx.strokeStyle = pen.accent
    ctx.lineCap = 'butt'
    for (const sg of live) {
      const k = clamp01((p - sg.p0) / Math.max(1e-9, sg.p1 - sg.p0))
      const a = apply(m, sg.a[0], sg.a[1])
      const b0 = apply(m, sg.b[0], sg.b[1])
      const half = Math.max(0.75 * core, 0.5 * sg.w * scaleOf(m), 0.51 * SIGNAL_HEAVY * pen.W)
      ctx.lineWidth = 2 * half
      ctx.setLineDash([3 * half, 2.5 * half])
      ctx.beginPath()
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(a[0] + (b0[0] - a[0]) * k, a[1] + (b0[1] - a[1]) * k)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.restore()
  }
}

export function drawFlow(pen: Pen, segs: PlotFlowSeg[], vias: Array<[number, number]>, pins: Array<[number, number]>, end: number, m: Aff, p: number): number {
  const ctx = pen.ctx
  const { f } = weights(pen.u)
  const core = flowCore(pen.u)
  setT(pen, [1, 0, 0, 1, 0, 0])
  bleed(pen, false)
  ctx.strokeStyle = pen.accent
  ctx.fillStyle = pen.accent
  ctx.lineWidth = f
  ctx.lineCap = 'butt'
  const last = segs[segs.length - 1]
  if (last !== undefined) {
    const q = apply(m, last.b[0], last.b[1])
    const shut = clamp01((p - (end - 0.25 / 24)) / (0.25 / 24))
    const gap = (1 - shut) * 1.1
    ctx.beginPath()
    ctx.arc(q[0], q[1], 1.6 * core, -Math.PI / 2 + gap / 2, 1.5 * Math.PI - gap / 2)
    ctx.stroke()
  }
  const live = segs.filter((sg) => p >= sg.p0)
  for (const sg of live) {
    const k = clamp01((p - sg.p0) / Math.max(1e-9, sg.p1 - sg.p0))
    const a = apply(m, sg.a[0], sg.a[1])
    const b0 = apply(m, sg.b[0], sg.b[1])
    const b: Pt = [a[0] + (b0[0] - a[0]) * k, a[1] + (b0[1] - a[1]) * k]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 0.5) continue
    const half = Math.max(0.75 * core, 0.5 * sg.w * scaleOf(m), 0.51 * SIGNAL_HEAVY * pen.W)
    ctx.beginPath()
    if (sg.plane === true) {
      ctx.setLineDash([1.6 * core, 1.4 * core])
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
      ctx.stroke()
      ctx.setLineDash([])
      continue
    }
    ctx.lineWidth = 2 * half
    ctx.lineCap = 'round'
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.stroke()
    ctx.lineCap = 'butt'
    ctx.lineWidth = f
  }
  for (const v of vias) {
    const reached = segs.some((sg) => p >= sg.p1 && (Math.hypot(sg.b[0] - v[0], sg.b[1] - v[1]) < 1e-3 || Math.hypot(sg.a[0] - v[0], sg.a[1] - v[1]) < 1e-3))
    if (!reached) continue
    const q = apply(m, v[0], v[1])
    ctx.beginPath()
    ctx.arc(q[0], q[1], 0.8 * core, 0, Math.PI * 2)
    ctx.stroke()
  }
  if (p >= end) {
    for (const pin of pins) {
      const q = apply(m, pin[0], pin[1])
      ctx.beginPath()
      ctx.arc(q[0], q[1], 0.9 * core, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  ctx.lineCap = 'round'
  return live.length
}

/** where a supply label sits, as an offset from its segment's start in label sizes; the film picks it on clear paper */
export type FlowSpot = (i: number) => Pt | undefined

/** the supply's own labels: the supply's name where it starts, each regulator by the net it puts out, each plane it hops and a run on the far side; each sits at its spot, or beside its segment's start */
export function flowLabelRects(pen: Pen, segs: PlotFlowSeg[], m: Aff, p: number, frames: number, spot?: FlowSpot): Array<{ text: string; rect: { x: number; y: number; w: number; h: number }; chars: number; at: Pt }> {
  const size = FILM_SUB * pen.su
  return segs.flatMap((sg, i) => {
    if (p < sg.p0 || sg.label === undefined) return []
    const chars = Math.min(sg.label.length, Math.floor(2 * (p - sg.p0) * frames))
    if (chars <= 0) return []
    const a = apply(m, sg.a[0], sg.a[1])
    const b = apply(m, sg.b[0], sg.b[1])
    const w = flowLabelWidth(sg.label, size)
    const h = 1.5 * size
    const off = spot?.(i)
    if (off !== undefined) return [{ text: sg.label, rect: { x: a[0] + off[0] * size, y: a[1] + off[1] * size, w, h }, chars, at: a }]
    if (spot !== undefined) return []
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const n: Pt = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]
    const side = n[1] > 0 ? -1 : 1
    const left = n[0] * side >= 0
    const x0 = a[0] + side * n[0] * 1.2 * size - (left ? 0.3 * size : w - 0.3 * size)
    const y0 = a[1] + side * n[1] * 1.2 * size - 0.75 * size
    const x = Math.min(0.95 * pen.W - w, Math.max(0.05 * pen.W, x0))
    const y = Math.min(0.95 * pen.H - h, Math.max(0.05 * pen.H, y0))
    return [{ text: sg.label, rect: { x, y, w, h }, chars, at: a }]
  })
}

export const flowLabelWidth = (text: string, size: number): number => text.length * size * 0.74 + 0.6 * size

/** the supply's labels lettered on at their spots, each with a thin accent leader back to its segment when it sits away from it */
export function flowLabels(pen: Pen, segs: PlotFlowSeg[], m: Aff, p: number, frames: number, alpha: number, spot?: FlowSpot): void {
  if (alpha <= 0) return
  const ctx = pen.ctx
  const size = FILM_SUB * pen.su
  setT(pen, [1, 0, 0, 1, 0, 0])
  flowLabelRects(pen, segs, m, p, frames, spot).forEach(({ text, rect, chars, at }) => {
    const w = chars * size * 0.74 + 0.6 * size
    const end: Pt = [Math.min(rect.x + rect.w, Math.max(rect.x, at[0])), Math.min(rect.y + rect.h, Math.max(rect.y, at[1]))]
    if (Math.hypot(end[0] - at[0], end[1] - at[1]) > 0.8 * size) {
      ctx.globalAlpha = alpha
      ctx.strokeStyle = pen.accent
      ctx.lineWidth = weights(pen.u).f
      ctx.beginPath()
      ctx.moveTo(at[0], at[1])
      ctx.lineTo(end[0], end[1])
      ctx.stroke()
    }
    ctx.globalAlpha = alpha
    knockout(pen, () => { ctx.fillRect(rect.x, rect.y, w, rect.h) })
    ctx.globalAlpha = 1
    lettered(pen, text, rect.x + 0.3 * size, rect.y + rect.h / 2, size, { color: pen.accent, spacing: 0.08, base: 'middle', chars, alpha })
  })
  bleed(pen, false)
}

/** a callout: grow counts frames since it starts writing on */
export interface Callout { at: Pt; rect: { x: number; y: number; w: number; h: number }; text: string; sub: string; grow: number; alpha: number; color?: string; size?: number; subSize?: number; pill?: boolean }

/** a callout printed in its planned box: a dot on its part, a leader to the box's nearest edge, then the name over its note */
export function drawCallouts(pen: Pen, items: Callout[], size: number, subSize: number): void {
  const ctx = pen.ctx
  const { f } = weights(pen.u)
  setT(pen, [1, 0, 0, 1, 0, 0])
  ctx.setLineDash([])
  for (const it of items) {
    if (it.alpha <= 0 || it.grow < 0) continue
    const color = it.color ?? (it.pill === true ? pen.accent : pen.ink)
    const r = it.rect
    const end: Pt = [Math.min(r.x + r.w, Math.max(r.x, it.at[0])), Math.min(r.y + r.h, Math.max(r.y, it.at[1]))]
    const lead = clamp01((it.grow + 1) / 2)
    const glyphs = it.grow
    ctx.globalAlpha = it.alpha
    bleed(pen, true, color)
    ctx.fillStyle = color
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.arc(it.at[0], it.at[1], 4.5 * pen.u, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = f
    ctx.beginPath()
    ctx.moveTo(it.at[0], it.at[1])
    ctx.lineTo(it.at[0] + (end[0] - it.at[0]) * lead, it.at[1] + (end[1] - it.at[1]) * lead)
    ctx.stroke()
    ctx.globalAlpha = 1
    if (glyphs < 1) continue
    knockout(pen, () => {
      ctx.globalAlpha = pen.transparent ? it.alpha : 0.9 * it.alpha
      ctx.fillRect(r.x, r.y, r.w, r.h)
      ctx.globalAlpha = 1
    })
    const pad = 6 * pen.u
    const sz = it.size ?? size
    const sub = it.subSize ?? subSize
    if (it.pill === true) {
      ctx.globalAlpha = it.alpha
      ctx.strokeStyle = color
      ctx.lineWidth = f
      ctx.beginPath()
      ctx.roundRect(r.x, r.y, r.w, r.h, 0.3 * r.h)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    lettered(pen, it.text, r.x + pad, r.y + sz * 1.05 - (it.sub.length > 0 ? 6 * pen.u : 0), sz, { color, alpha: it.alpha, chars: glyphs })
    if (it.sub.length > 0) lettered(pen, it.sub, r.x + pad, r.y + sz * 1.05 + sub * 1.2, sub, { color, alpha: 0.85 * it.alpha, spacing: 0.1, chars: glyphs - 2 })
  }
  bleed(pen, false)
}

export const hash = (x: number, y: number): number => {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return h - Math.floor(h)
}
export const noise = (x: number, y: number): number => {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = hash(xi, yi)
  const b = hash(xi + 1, yi)
  const c = hash(xi, yi + 1)
  const d = hash(xi + 1, yi + 1)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

const DENSITY = new Map<string, HTMLCanvasElement>()

/** the ink's uneven take along long strokes: a slow, static board-space mottle of paper colour laid over the ink, which leaves bare paper as it was */
export function inkDensity(pen: Pen, s: TraceScene, m: Aff): void {
  if (pen.transparent || typeof document === 'undefined') return
  const n = 24
  let cv = DENSITY.get(pen.stock)
  if (cv === undefined) {
    cv = document.createElement('canvas')
    cv.width = n
    cv.height = n
    const c = cv.getContext('2d')
    if (c === null) return
    const img = c.createImageData(n, n)
    const rgb = [1, 3, 5].map((i) => parseInt(pen.stock.slice(i, i + 2), 16))
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = 0.65 * noise(x / 3.1 + 5, y / 3.1 + 9) + 0.35 * noise(x / 1.4 + 2, y / 1.4 + 1)
      const i = (y * n + x) * 4
      img.data[i] = rgb[0] ?? 0
      img.data[i + 1] = rgb[1] ?? 0
      img.data[i + 2] = rgb[2] ?? 0
      img.data[i + 3] = 255 * 0.26 * Math.max(0, Math.min(1, (v - 0.3) / 0.5))
    }
    c.putImageData(img, 0, 0)
    DENSITY.set(pen.stock, cv)
  }
  const b = s.board.flat()
  const xs = b.filter((_, i) => i % 2 === 0)
  const ys = b.filter((_, i) => i % 2 === 1)
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const side = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) * 1.4
  setT(pen, m)
  bleed(pen, false)
  pen.ctx.imageSmoothingEnabled = true
  pen.ctx.drawImage(cv, x0 - 0.2 * side, y0 - 0.2 * side, side, side)
  setT(pen, ID)
}

const SHEET_WEAR = new Map<string, HTMLCanvasElement>()

/** the sheet's own wear, static in sheet space: two fold lines, a crease shadow beside each, and the edges rubbed pale */
export function sheetWear(pen: Pen, base: Aff, alpha: number): void {
  if (pen.transparent || alpha <= 0 || typeof document === 'undefined') return
  const w = Math.round(pen.W / 2)
  const h = Math.round(pen.H / 2)
  const key = `${w}x${h}`
  let cv = SHEET_WEAR.get(key)
  if (cv === undefined) {
    cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const c = cv.getContext('2d')
    if (c === null) return
    const img = c.createImageData(w, h)
    const u = Math.min(w, h) / 540
    const folds = h > 1.5 * w ? [h / 3, (2 * h) / 3] : [h / 2]
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      let lit = 0
      let dark = 0
      for (const fy of folds) {
        const d = y - fy
        lit += Math.exp(-(d * d) / (2 * (0.8 * u) ** 2)) * 0.55
        dark += d > 0 ? Math.exp(-d / (5 * u)) * 0.22 : 0
      }
      const dx = x - w / 2
      lit += Math.exp(-(dx * dx) / (2 * (0.8 * u) ** 2)) * 0.55
      dark += dx > 0 ? Math.exp(-dx / (5 * u)) * 0.22 : 0
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y) / u
      const rub = Math.max(0, 1 - edge / 9) * (0.4 + 0.6 * noise(x / (2.5 * u), y / (2.5 * u))) * 0.5
      const a = Math.min(1, lit + rub + dark)
      const pale = lit + rub >= dark
      img.data[i] = pale ? 235 : 0
      img.data[i + 1] = pale ? 240 : 6
      img.data[i + 2] = pale ? 250 : 28
      img.data[i + 3] = 255 * a * (pale ? 0.32 : 1)
    }
    c.putImageData(img, 0, 0)
    SHEET_WEAR.set(key, cv)
  }
  setT(pen, base)
  bleed(pen, false)
  pen.ctx.globalAlpha = alpha
  pen.ctx.drawImage(cv, 0, 0, pen.W, pen.H)
  pen.ctx.globalAlpha = 1
  setT(pen, ID)
}

/** the beat the film callouts hand over to the sheet, when the camera has settled on it */
export const LAND = PLOT_LAND
