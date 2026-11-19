import { CAP, nameStrip, SHEET_TEXT } from '@silk-reel/choreo'
import type { PlotBody, TracePart } from '@silk-reel/choreo'
import { apply, knockout, lettered, setT, weights } from './plot-plan'
import type { Aff, Pen, Pt } from './plot-plan'

type At = (z: number) => Aff
type V3 = [number, number, number]

const CORNERS: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
const NORMALS: Pt[] = [[0, -1], [1, 0], [0, 1], [-1, 0]]
const textW = (n: number, size: number): number => n * size * 0.66

const polyPath = (ctx: CanvasRenderingContext2D, pts: Pt[], close = true): void => {
  ctx.beginPath()
  pts.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  if (close) ctx.closePath()
}

const hullOf = (pts: Pt[]): Pt[] => {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cr = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo: Pt[] = []
  for (const q of s) {
    while (lo.length >= 2 && cr(lo[lo.length - 2] as Pt, lo[lo.length - 1] as Pt, q) <= 0) lo.pop()
    lo.push(q)
  }
  const hi: Pt[] = []
  for (const q of [...s].reverse()) {
    while (hi.length >= 2 && cr(hi[hi.length - 2] as Pt, hi[hi.length - 1] as Pt, q) <= 0) hi.pop()
    hi.push(q)
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)]
}

/** a body's own frame: local board px about its centre, height above the board, to the frame */
export interface Frame {
  P: (lx: number, ly: number, z: number) => Pt
  toLocal: (x: number, y: number) => Pt
  w: number
  h: number
  z: number
}

export const frameOf = (at: At, zp: number, p: TracePart): Frame => {
  const c = Math.cos(p.rot)
  const s = Math.sin(p.rot)
  return {
    P: (lx, ly, z) => apply(at(zp + z), p.x + lx * c - ly * s, p.y + lx * s + ly * c),
    toLocal: (x, y) => [c * (x - p.x) + s * (y - p.y), -s * (x - p.x) + c * (y - p.y)],
    w: p.w,
    h: p.h,
    z: p.z
  }
}

const facing = (F: Frame, n: Pt): boolean => {
  const c = F.P(0, 0, 0)
  const q = F.P(n[0] * 0.5 * F.w, n[1] * 0.5 * F.h, 0)
  return q[1] - c[1] > 1e-6
}

const onFace = (F: Frame, k: number, s: number, t: number): Pt => {
  const a = CORNERS[k] as Pt
  const b = CORNERS[(k + 1) % 4] as Pt
  return F.P(((a[0] + (b[0] - a[0]) * s) * F.w) / 2, ((a[1] + (b[1] - a[1]) * s) * F.h) / 2, t * F.z)
}

/**
 * A box body with no hatch: its silhouette knocked out of what lies behind,
 * its lid and its visible edges in the medium pen, its far edges dashed in
 * the hairline, and its outline heavy when it is the shot's subject.
 */
export function prism(pen: Pen, F: Frame, subject: boolean, hidden: number): { sil: Pt[]; faces: number[] } {
  const ctx = pen.ctx
  const { f, m, h } = weights(pen.u)
  const lo = CORNERS.map(([a, b]) => F.P((a * F.w) / 2, (b * F.h) / 2, 0))
  const hi = CORNERS.map(([a, b]) => F.P((a * F.w) / 2, (b * F.h) / 2, F.z))
  const sil = hullOf([...lo, ...hi])
  pen.hides?.push(sil.map((q) => apply(pen.m ?? [1, 0, 0, 1, 0, 0], q[0], q[1])))
  knockout(pen, () => {
    polyPath(ctx, sil)
    ctx.fill()
  })
  const faces = NORMALS.map((n, k) => (facing(F, n) ? k : -1)).filter((k) => k >= 0)
  ctx.strokeStyle = pen.ink
  if (hidden > 0) {
    const far = lo.reduce((b, q, i) => (q[1] < (lo[b] as Pt)[1] ? i : b), 0)
    const fa = lo[far] as Pt
    ctx.lineWidth = f
    ctx.globalAlpha = hidden
    ctx.setLineDash([4 * pen.u, 3 * pen.u])
    ctx.beginPath()
    for (const q of [lo[(far + 1) % 4] as Pt, lo[(far + 3) % 4] as Pt, hi[far] as Pt]) {
      ctx.moveTo(fa[0], fa[1])
      ctx.lineTo(q[0], q[1])
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
  ctx.lineWidth = m
  polyPath(ctx, hi)
  ctx.stroke()
  ctx.beginPath()
  for (const k of faces) for (const i of [k, (k + 1) % 4]) {
    ctx.moveTo((lo[i] as Pt)[0], (lo[i] as Pt)[1])
    ctx.lineTo((hi[i] as Pt)[0], (hi[i] as Pt)[1])
  }
  ctx.stroke()
  ctx.lineWidth = subject ? h : m
  polyPath(ctx, sil)
  ctx.stroke()
  return { sil, faces }
}

const span = (pts: Pt[]): number => Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0]))

function lead(pen: Pen, F: Frame, pad: [number, number, number, number], near: boolean | undefined, gull: boolean): void {
  const ctx = pen.ctx
  const [lx, ly] = F.toLocal(pad[0], pad[1])
  const ox = Math.abs(lx) - F.w / 2
  const oy = Math.abs(ly) - F.h / 2
  const alongX = ox / F.w > oy / F.h
  const n: Pt = alongX ? [Math.sign(lx) || 1, 0] : [0, Math.sign(ly) || 1]
  if (near !== undefined && facing(F, n) !== near) return
  const edge = alongX ? F.w / 2 : F.h / 2
  const at = alongX ? Math.abs(lx) : Math.abs(ly)
  const t = alongX ? ly : lx
  const wd = 0.55 * Math.min(pad[2], pad[3])
  const pt = (nn: number, tt: number, z: number): Pt => (alongX ? F.P(n[0] * nn, tt, z) : F.P(tt, n[1] * nn, z))
  const foot = Math.max(at, edge + 0.5 * wd)
  const ring: V3[] = gull
    ? [[foot + 0.35 * (foot - edge), -1, 0], [edge + 0.45 * (foot - edge), -1, 0], [edge, -1, 0.42], [edge, 1, 0.42], [edge + 0.45 * (foot - edge), 1, 0], [foot + 0.35 * (foot - edge), 1, 0]]
    : [[edge + 0.02 * edge, -1, 0], [edge + 0.02 * edge, -1, 0.14], [edge + 0.02 * edge, 1, 0.14], [edge + 0.02 * edge, 1, 0]]
  ctx.fillStyle = pen.ink
  polyPath(ctx, ring.map(([a, b, z]) => pt(a, t + (b * wd) / 2, z * F.z)))
  ctx.fill()
}

function pinOne(pen: Pen, F: Frame, b: PlotBody): void {
  if (b.pin1 === undefined) return
  const [lx, ly] = F.toLocal(b.pin1[0], b.pin1[1])
  const r = 0.05 * Math.min(F.w, F.h)
  const cx = Math.sign(lx) * Math.max(0, F.w / 2 - 3 * r)
  const cy = Math.sign(ly) * Math.max(0, F.h / 2 - 3 * r)
  const ring = Array.from({ length: 16 }, (_, i) => F.P(cx + r * Math.cos((i / 16) * Math.PI * 2), cy + r * Math.sin((i / 16) * Math.PI * 2), F.z))
  if (span(ring) < 2.5 * pen.u) return
  pen.ctx.strokeStyle = pen.ink
  pen.ctx.lineWidth = weights(pen.u).f
  polyPath(pen.ctx, ring)
  pen.ctx.stroke()
}

/** the lettering a lid carries, in the lid's own plane at the type floor: the part's value, on a one-of-a-kind body wider than 8% of the frame, when it fits and stays inside the frame; a kept marking (the hero's) shrinks to fit instead, down to 40% of the type floor */
export function lidText(pen: Pen, F: Frame, b: PlotBody, wide: boolean, keep = false, read?: Pt): boolean {
  const L0 = SHEET_TEXT * pen.su
  const c = F.P(0, 0, F.z)
  const ex = F.P(1, 0, F.z)
  const ey = F.P(0, 1, F.z)
  const ux: Pt = [ex[0] - c[0], ex[1] - c[1]]
  const uy: Pt = [ey[0] - c[0], ey[1] - c[1]]
  const flatX = Math.abs(ux[0]) / Math.hypot(ux[0], ux[1])
  const flatY = Math.abs(uy[0]) / Math.hypot(uy[0], uy[1])
  const prefer = F.w >= F.h ? flatX > 0.5 || flatX >= flatY : !(flatY > 0.5 || flatY >= flatX)
  const core = b.value.split(/[-\s/]/)[0] ?? ''
  if ((!wide && !keep) || core.length < 3) return false
  const texts = [...new Set([core, core.split('_').at(-1) ?? core])].filter((t) => t.length >= 3)
  const floor = nameStrip(pen.W, pen.H).y
  if (read !== undefined) return printed(pen, F, texts[0] as string, read, L0, floor)
  for (const text of texts) {
    for (const alongX of [prefer, !prefer]) {
      let e = alongX ? ux : uy
      let g = alongX ? uy : ux
      if (e[0] < 0) e = [-e[0], -e[1]]
      if (g[1] < 0) g = [-g[0], -g[1]]
      const el = Math.hypot(e[0], e[1])
      const tilt = Math.hypot(g[0], g[1]) / el
      const len = (alongX ? F.w : F.h) * el
      const across = (alongX ? F.h : F.w) * Math.hypot(g[0], g[1])
      const L = keep ? Math.max(0.2 * L0, Math.min(L0, (0.82 * len) / textW(text.length, 1), (0.9 * across) / (CAP * 1.15 * tilt))) : L0
      if (textW(text.length, L) > 0.82 * len || CAP * L * 1.15 * tilt > 0.9 * across) continue
      const half = [0.5 * textW(text.length, L) + 0.2 * L, 0.6 * CAP * L * tilt + 0.2 * L] as const
      const edge = Math.max(0.015 * pen.W, CAP * L) + 0.6 * CAP * L
      const room = [Math.max(0, 0.41 * len - half[0]), Math.max(0, 0.45 * across - half[1])] as const
      const at = (s: number, t: number): Pt => [c[0] + (e[0] / el) * s + (g[0] / el) * t, c[1] + (e[1] / el) * s + (g[1] / el) * t]
      const fits = (o: Pt): boolean => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([i, j]) => {
        const x = o[0] + (i as number) * (e[0] / el) * half[0] + (j as number) * (g[0] / el) * half[1]
        const y = o[1] + (i as number) * (e[1] / el) * half[0] + (j as number) * (g[1] / el) * half[1]
        return x >= edge && y >= edge && x <= pen.W - edge && y <= floor - edge
      })
      const steps = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1]
      const spot = steps.flatMap((a) => steps.map((q) => at(a * room[0], q * room[1]))).find(fits)
      if (spot === undefined) continue
      setT(pen, [e[0] / el, e[1] / el, g[0] / el, g[1] / el, spot[0], spot[1]])
      lettered(pen, text, 0, 0, L, { align: 'center', base: 'middle', free: true, part: true })
      setT(pen, [1, 0, 0, 1, 0, 0])
      return true
    }
  }
  return false
}

/** the lid text along a reading fixed in the lid's own axes, so it turns with the part and only with it; shrunk to fit, and when no spot clear of the frame's edge fits, left at the lid's middle and cut where lettering may not reach */
function printed(pen: Pen, F: Frame, text: string, read: Pt, L0: number, floor: number): boolean {
  const c = F.P(0, 0, F.z)
  const along = F.P(read[0], read[1], F.z)
  const ex = F.P(-read[1], read[0], F.z)
  let e: Pt = [along[0] - c[0], along[1] - c[1]]
  let g: Pt = [ex[0] - c[0], ex[1] - c[1]]
  if (e[0] * g[1] - e[1] * g[0] < 0) g = [-g[0], -g[1]]
  const el = Math.hypot(e[0], e[1])
  if (el < 1e-9) return false
  e = [e[0] / el, e[1] / el]
  const gl = Math.hypot(g[0], g[1])
  const tilt = gl / el
  const len = (read[0] !== 0 ? F.w : F.h) * el
  const across = (read[0] !== 0 ? F.h : F.w) * gl
  const L = Math.max(0.2 * L0, Math.min(L0, (0.82 * len) / textW(text.length, 1), (0.9 * across) / (CAP * 1.15 * tilt)))
  const gu: Pt = [g[0] / el, g[1] / el]
  const half = [0.5 * textW(text.length, L) + 0.2 * L, 0.6 * CAP * L * tilt + 0.2 * L] as const
  const edge = Math.max(0.015 * pen.W, CAP * L) + 0.6 * CAP * L
  const room = [Math.max(0, 0.41 * len - half[0]), Math.max(0, 0.45 * across - half[1])] as const
  const at = (s: number, t: number): Pt => [c[0] + e[0] * s + gu[0] * t, c[1] + e[1] * s + gu[1] * t]
  const fits = (o: Pt): boolean => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([i, j]) => {
    const x = o[0] + (i as number) * e[0] * half[0] + (j as number) * gu[0] * half[1]
    const y = o[1] + (i as number) * e[1] * half[0] + (j as number) * gu[1] * half[1]
    return x >= edge && y >= edge && x <= pen.W - edge && y <= floor - edge
  })
  const steps = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1]
  const spot = steps.flatMap((a) => steps.map((q) => at(a * room[0], q * room[1]))).find(fits)
  pen.ctx.save()
  if (spot === undefined) {
    setT(pen, [1, 0, 0, 1, 0, 0])
    pen.ctx.beginPath()
    pen.ctx.rect(edge, edge, pen.W - 2 * edge, floor - 2 * edge)
    pen.ctx.clip()
  }
  const o = spot ?? c
  const box = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [o[0] + (i as number) * e[0] * half[0] + (j as number) * gu[0] * half[1], o[1] + (i as number) * e[1] * half[0] + (j as number) * gu[1] * half[1]] as Pt)
  if (box.every((q) => q[0] < edge) || box.every((q) => q[0] > pen.W - edge) || box.every((q) => q[1] < edge) || box.every((q) => q[1] > floor - edge)) {
    pen.ctx.restore()
    return false
  }
  setT(pen, [e[0], e[1], gu[0], gu[1], o[0], o[1]])
  lettered(pen, text, 0, 0, L, { align: 'center', base: 'middle', free: true, part: true })
  pen.ctx.restore()
  setT(pen, [1, 0, 0, 1, 0, 0])
  return true
}

/** the direction, in a lid's own axes, its text reads along for the whole film: along its long side, never past vertical in any view given, and nearest level in the last (the held poster); if every way passes vertical somewhere, the way whose worst view is nearest level */
export function lidReading(views: Aff[], p: Pick<TracePart, 'rot' | 'w' | 'h'>): Pt {
  const c = Math.cos(p.rot)
  const s = Math.sin(p.rot)
  const all: Pt[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const dirs = all.filter(([x]) => (p.w >= 1.2 * p.h ? x !== 0 : p.h >= 1.2 * p.w ? x === 0 : true))
  const angle = (m: Aff, d: Pt): number => {
    const bx = d[0] * c - d[1] * s
    const by = d[0] * s + d[1] * c
    return Math.abs(Math.atan2(m[1] * bx + m[3] * by, m[0] * bx + m[2] * by))
  }
  const worst = (d: Pt): number => Math.max(...views.map((m) => angle(m, d)))
  const last = views[views.length - 1] as Aff
  const upright = dirs.filter((d) => worst(d) <= Math.PI / 2)
  return upright.length > 0 ? upright.reduce((best, d) => (angle(last, d) < angle(last, best) - 1e-9 ? d : best)) : dirs.reduce((best, d) => (worst(d) < worst(best) - 1e-9 ? d : best))
}

const ellipse = (F: Frame, cx: number, cy: number, r: number, z: number, n = 20): Pt[] => Array.from({ length: n }, (_, i) => F.P(cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2), z))

const faceToward = (F: Frame, dir: Pt | undefined): number => {
  if (dir === undefined) return -1
  const o = F.toLocal(0, 0)
  const q = F.toLocal(dir[0], dir[1])
  const d: Pt = [q[0] - o[0], q[1] - o[1]]
  return NORMALS.reduce((best, n, k) => (n[0] * d[0] + n[1] * d[1] > (NORMALS[best] as Pt)[0] * d[0] + (NORMALS[best] as Pt)[1] * d[1] ? k : best), 0)
}

const faceRect = (F: Frame, k: number, s0: number, s1: number, t0: number, t1: number): Pt[] => [onFace(F, k, s0, t0), onFace(F, k, s1, t0), onFace(F, k, s1, t1), onFace(F, k, s0, t1)]

/**
 * One part body, drawn from its footprint: a QFP's gull-wing leads, a QFN's
 * lands, a header's posts, a socket's holes, a USB socket's mouth and tongue,
 * a terminal block's screws, a passive's end caps; its pin 1 mark and its
 * lettered lid. Returns 1 when anything was drawn.
 */
export function drawBody(pen: Pen, at: At, zp: number, p: TracePart, b: PlotBody | undefined, subject: boolean, hidden: number, read?: Pt): number {
  const ctx = pen.ctx
  const { f, m } = weights(pen.u)
  const F = frameOf(at, zp, p)
  const outline = CORNERS.map(([a, c]) => F.P((a * F.w) / 2, (c * F.h) / 2, F.z))
  if (span([...outline, F.P(0, 0, 0)]) < 3 * pen.u) return 0
  const style = b?.style ?? 'block'
  const pads = b?.pads ?? []
  const gull = style === 'gull'
  if (gull) for (const pd of pads) lead(pen, F, pd, false, true)
  const { faces } = prism(pen, F, subject, hidden)
  ctx.strokeStyle = pen.ink
  if (gull || style === 'lands') for (const pd of pads) {
    const [lx, ly] = F.toLocal(pd[0], pd[1])
    const inset = Math.min(F.w / 2 - Math.abs(lx), F.h / 2 - Math.abs(ly))
    if (gull || inset < 0.9 * Math.min(pd[2], pd[3])) lead(pen, F, pd, true, gull)
  }
  const big = span(outline) > 0.08 * pen.W
  if (b !== undefined && (gull || style === 'lands') && !(p.hero === true && pen.lid !== undefined)) pinOne(pen, F, b)
  const mouth = style === 'socket' && b?.open !== undefined ? faceToward(F, [p.x + b.open[0], p.y + b.open[1]]) : -1
  if (mouth >= 0) {
    ctx.lineWidth = f
    const cols = Math.max(1, Math.round(pads.length / 2))
    const rows = pads.length >= 2 ? 2 : 1
    if (faces.includes(mouth)) for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const s0 = (i + 0.3) / cols
      const t0 = (j + 0.3) / rows
      polyPath(ctx, faceRect(F, mouth, s0, s0 + 0.4 / cols, t0, t0 + 0.4 / rows))
      ctx.stroke()
    }
  } else if (style === 'socket') {
    ctx.lineWidth = f
    for (const pd of pads) {
      const [lx, ly] = F.toLocal(pd[0], pd[1])
      const r = 0.3 * Math.min(pd[2], pd[3])
      polyPath(ctx, [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => F.P(lx + (a as number) * r, ly + (c as number) * r, F.z)))
      ctx.stroke()
    }
  }
  if (style === 'passive' && span(outline) > 14 * pen.u) {
    const long = F.w >= F.h
    ctx.lineWidth = m
    ctx.beginPath()
    for (const sgn of [-1, 1]) {
      const k = sgn * 0.3 * (long ? F.w : F.h)
      const a = long ? F.P(k, -F.h / 2, F.z) : F.P(-F.w / 2, k, F.z)
      const c = long ? F.P(k, F.h / 2, F.z) : F.P(F.w / 2, k, F.z)
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(c[0], c[1])
      for (const k2 of faces) {
        const n = NORMALS[k2] as Pt
        if ((long && n[0] !== 0) || (!long && n[1] !== 0)) continue
        const top = long ? F.P(k, (n[1] * F.h) / 2, F.z) : F.P((n[0] * F.w) / 2, k, F.z)
        const bot = long ? F.P(k, (n[1] * F.h) / 2, 0) : F.P((n[0] * F.w) / 2, k, 0)
        ctx.moveTo(top[0], top[1])
        ctx.lineTo(bot[0], bot[1])
      }
    }
    ctx.stroke()
  }
  if (style === 'usb' || style === 'block') {
    const k = faceToward(F, b?.open === undefined ? undefined : [p.x + b.open[0], p.y + b.open[1]])
    if (k >= 0 && faces.includes(k) && style === 'usb') {
      ctx.lineWidth = m
      polyPath(ctx, faceRect(F, k, 0.1, 0.9, 0.18, 0.84))
      ctx.stroke()
      ctx.fillStyle = pen.ink
      polyPath(ctx, faceRect(F, k, 0.24, 0.76, 0.44, 0.58))
      ctx.fill()
    }
  }
  if (style === 'block' && b !== undefined && /^(P|J|X|CN)\d/.test(b.ref) && pads.length >= 2) {
    ctx.lineWidth = m
    for (const pd of pads) {
      const [lx, ly] = F.toLocal(pd[0], pd[1])
      const r = Math.min(0.3 * Math.min(F.w, F.h), 0.45 * Math.max(pd[2], pd[3]))
      const head = ellipse(F, lx, ly, r, F.z)
      if (span(head) < 4 * pen.u) continue
      polyPath(ctx, head)
      ctx.stroke()
      const a = F.P(lx - 0.7 * r, ly + 0.7 * r, F.z)
      const c = F.P(lx + 0.7 * r, ly - 0.7 * r, F.z)
      ctx.beginPath()
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(c[0], c[1])
      ctx.stroke()
    }
  }
  if (b?.lone === true && p.hero === true && pen.lid === undefined) lidText(pen, F, b, big, true, read)
  return 1
}

/** a header's post: a square pin standing out of its housing, outlined in the light pen so a row of them never outshines the accent */
export function post(pen: Pen, at: At, zp: number, x: number, y: number, side: number, z0: number, z1: number): void {
  const ctx = pen.ctx
  const sq = (z: number): Pt[] => CORNERS.map(([a, b]) => apply(at(zp + z), x + (a * side) / 2, y + (b * side) / 2))
  const outline = hullOf([...sq(z0), ...sq(z1)])
  pen.hides?.push(outline.map((q) => apply(pen.m ?? [1, 0, 0, 1, 0, 0], q[0], q[1])))
  knockout(pen, () => {
    polyPath(ctx, outline)
    ctx.fill()
  })
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = weights(pen.u).f
  polyPath(ctx, outline)
  ctx.stroke()
}

/** an electrolytic's vent: the cross scored in its top, in the medium pen */
export function vent(pen: Pen, at: At, zt: number, x: number, y: number, r: number): void {
  const a = (dx: number, dy: number): Pt => apply(at(zt), x + dx, y + dy)
  const ends = [a(-0.6 * r, 0), a(0.6 * r, 0), a(0, -0.6 * r), a(0, 0.6 * r)]
  if (span(ends) < 10 * pen.u) return
  const ctx = pen.ctx
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = weights(pen.u).m
  ctx.beginPath()
  for (let i = 0; i < 4; i += 2) {
    ctx.moveTo((ends[i] as Pt)[0], (ends[i] as Pt)[1])
    ctx.lineTo((ends[i + 1] as Pt)[0], (ends[i + 1] as Pt)[1])
  }
  ctx.stroke()
}
