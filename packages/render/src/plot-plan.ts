import type { FlatPath, TracePad, TracePart, TraceScene } from '@silk-reel/choreo'
import { DRAFT, FONT } from './font'

export type Aff = [number, number, number, number, number, number]
export type Pt = [number, number]

export interface Pen {
  ctx: CanvasRenderingContext2D
  k: number
  u: number
  su: number
  W: number
  H: number
  stock: string
  ink: string
  accent: string
  transparent: boolean
  /** screen outlines of the bodies drawn so far, for the signal they hide */
  hides?: Pt[][]
  /** the transform last set with setT */
  m?: Aff
  /** while a panel wipes in, the screen row its reveal has reached: text whose glyphs reach below it waits */
  gate?: number | undefined
  /** the plane a drawing lies on: every transform set with setT is carried through it, so ink drawn in one view lands on the board in another */
  base?: Aff | undefined
  /** frame-space outlines of the lettering drawn so far this frame, each with its clear band: every later stroke breaks at them */
  bands?: Pt[][]
  /** the main chip's name and its pin 1 pad, board px, lettered inside its outline wherever the plan draws it until its marking letters on the lid, as a note or once the lid is drawn */
  hero?: { label: string; pin1?: [number, number] | undefined; read?: Pt | undefined; part?: boolean } | undefined
  /** the same name and dot as the lid letters them once the plan hands them over, in the plan's place on the lid */
  lid?: { label: string; pin1?: [number, number] | undefined; read?: Pt | undefined; part?: boolean } | undefined
  /** the main chip's body as the whole scene has it, before the ink reaches it: the sheet keeps its paper clear */
  chip?: TracePart | undefined
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
export const easeOut = (x: number): number => 1 - (1 - clamp01(x)) ** 3
export const easeInOut = (x: number): number => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

export const mixHex = (a: string, b: string, t: number): string => {
  const c = (h: string, i: number): number => Number.parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
  return `#${[0, 1, 2].map((i) => Math.round(c(a, i) + (c(b, i) - c(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

export const rgba = (hex: string, a: number): string => {
  const c = (i: number): number => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  return `rgba(${c(0)},${c(1)},${c(2)},${a})`
}

/** the pen weights on one base: hair for hatch and hidden lines; the base for copper and construction; twice it for part silhouettes; three times it for the outline and section cuts */
/** the sheet's three pens, as shares of 1080 px of the frame's short side: hairline 0.10% (dimensions, leaders, centre and hidden lines), medium 0.22% (visible edges), heavy 0.44% (the subject's outline) */
export const weights = (u: number): { f: number; m: number; h: number } => ({ f: 1.1 * u, m: 2.4 * u, h: 4.8 * u })

export const mul = (a: Aff, b: Aff): Aff => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
]
export const apply = (m: Aff, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
export const scaleOf = (m: Aff): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
export const invert = (m: Aff): Aff => {
  const det = m[0] * m[3] - m[1] * m[2]
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}
export const setT = (pen: Pen, m: Aff): void => {
  pen.m = m
  const k = pen.k
  const t = pen.base === undefined ? m : mul(pen.base, m)
  pen.ctx.setTransform(k * t[0], k * t[1], k * t[2], k * t[3], k * t[4], k * t[5])
}
export const ID: Aff = [1, 0, 0, 1, 0, 0]

/** a glow under what is drawn next, only for light that carries energy: ink never glows */
export const bleed = (pen: Pen, on: boolean, color = pen.ink): void => {
  const glow = on && color !== pen.ink
  pen.ctx.shadowColor = glow ? rgba(color, 0.42) : 'rgba(0,0,0,0)'
  pen.ctx.shadowBlur = glow ? 1.8 * pen.u * pen.k : 0
}

export const knockout = (pen: Pen, draw: () => void): void => {
  const ctx = pen.ctx
  bleed(pen, false)
  if (pen.transparent) ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = pen.stock
  ctx.strokeStyle = pen.stock
  draw()
  ctx.globalCompositeOperation = 'source-over'
}

/** a capital's height in the sheet's lettering, as a share of the font size */
export const CAP = 0.72
/** the clear band round lettering, in capital heights */
export const BAND = 0.25

/** paper cleared round lettering's box x0..x1, y0..y1 in the current transform, out by pad, and the band kept so every later stroke breaks at it */
export const band = (pen: Pen, x0: number, y0: number, x1: number, y1: number, pad: number, alpha = 1): void => {
  const ctx = pen.ctx
  const a = ctx.globalAlpha
  knockout(pen, () => {
    ctx.globalAlpha = alpha
    ctx.fillRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad)
  })
  ctx.globalAlpha = a
  if (pen.bands === undefined) return
  const m = ctx.getTransform()
  pen.bands.push(([[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]] as Pt[]).map(([u, v]): Pt => [m.a * u + m.c * v + m.e, m.b * u + m.d * v + m.f]))
}

/** the context with every stroke and inked fill clipped out of the bands kept so far, one clip a band so overlapping bands stay clear; the paper's own fills pass */
export const banded = (ctx: CanvasRenderingContext2D, bands: Pt[][], stock: string): CanvasRenderingContext2D => new Proxy(ctx, {
  get: (t, prop): unknown => {
    const v: unknown = Reflect.get(t, prop, t)
    if (typeof v !== 'function') return v
    const f = (v as (...a: unknown[]) => unknown).bind(t)
    const inks = prop === 'stroke' || prop === 'strokeRect' || ((prop === 'fill' || prop === 'fillRect') && t.fillStyle !== stock && t.globalCompositeOperation !== 'destination-out')
    if (!inks) return f
    return (...args: unknown[]): void => {
      const m = bands.length === 0 ? undefined : t.getTransform()
      const det = m === undefined ? 0 : m.a * m.d - m.b * m.c
      if (m === undefined || Math.abs(det) < 1e-12) { f(...args); return }
      const loop = (path: Path2D, q: Pt[]): Path2D => {
        q.forEach(([x, y], i) => {
          const u = (m.d * (x - m.e) - m.c * (y - m.f)) / det
          const w = (m.a * (y - m.f) - m.b * (x - m.e)) / det
          if (i === 0) path.moveTo(u, w)
          else path.lineTo(u, w)
        })
        path.closePath()
        return path
      }
      t.save()
      for (const b of bands) t.clip(loop(loop(new Path2D(), [[-1e5, -1e5], [1e5, -1e5], [1e5, 1e5], [-1e5, 1e5]]), b), 'evenodd')
      f(...args)
      t.restore()
    }
  },
  set: (t, prop, v): boolean => Reflect.set(t, prop, v, t)
})

export type Front = Array<{ w: number; path: Path2D; lead: boolean }>

interface Geo {
  front: Front
  frontLines: Path2D
  back: Path2D
  vias: Path2D
  viaRings: Array<{ x: number; y: number; r: number }>
  zonesF: Path2D
  zonesB: Path2D
  outline: Path2D
  loops: FlatPath[]
  loopLen: number[]
  parts: Path2D
  hero: Path2D | undefined
  drillsBig: Array<{ x: number; y: number; r: number }>
  drillsSmall: Array<{ x: number; y: number; r: number }>
  bounds: { x0: number; y0: number; x1: number; y1: number }
  hatch: Map<number, Path2D>
  layerPaths: Map<string, { lines: Path2D; zones: Path2D }>
}

const GEO = new WeakMap<TraceScene, Geo>()

export const padPath = (path: Path2D, pad: TracePad, grow = 0): void => {
  const c = Math.cos(pad.rot)
  const s = Math.sin(pad.rot)
  const w = pad.w / 2 + grow
  const h = pad.h / 2 + grow
  if (pad.shape === 'circle') {
    path.moveTo(pad.x + Math.max(w, h), pad.y)
    path.arc(pad.x, pad.y, Math.max(w, h), 0, Math.PI * 2)
    return
  }
  const r = pad.shape === 'round' ? Math.min(w, h) * 0.9 : 0
  const pts: Pt[] = []
  const corner = (cx: number, cy: number, a0: number): void => {
    const n = r > 0 ? 5 : 1
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / Math.max(1, n - 1)) * (Math.PI / 2)
      pts.push([cx + (r > 0 ? Math.cos(a) * r : 0), cy + (r > 0 ? Math.sin(a) * r : 0)])
    }
  }
  corner(w - r, h - r, 0)
  corner(-w + r, h - r, Math.PI / 2)
  corner(-w + r, -h + r, Math.PI)
  corner(w - r, -h + r, Math.PI * 1.5)
  pts.forEach(([x, y], i) => {
    const X = pad.x + x * c - y * s
    const Y = pad.y + x * s + y * c
    if (i === 0) path.moveTo(X, Y)
    else path.lineTo(X, Y)
  })
  path.closePath()
}

const polyInto = (path: Path2D, f: FlatPath): void => {
  for (let i = 0; i + 1 < f.length; i += 2) {
    if (i === 0) path.moveTo(f[0] as number, f[1] as number)
    else path.lineTo(f[i] as number, f[i + 1] as number)
  }
  path.closePath()
}

const rectInto = (path: Path2D, x: number, y: number, w: number, h: number, rot: number): void => {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const pts: Pt[] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
  pts.forEach(([a, b], i) => {
    const X = x + a * c - b * s
    const Y = y + a * s + b * c
    if (i === 0) path.moveTo(X, Y)
    else path.lineTo(X, Y)
  })
  path.closePath()
}

export function geo(s: TraceScene): Geo {
  const hit = GEO.get(s)
  if (hit !== undefined) return hit
  const front = new Map<number, Path2D>()
  const frontLines = new Path2D()
  const back = new Path2D()
  for (const layer of s.layers) {
    if (layer.side === 'inner') continue
    for (let i = 0; i + 6 < layer.segs.length; i += 7) {
      const x0 = layer.segs[i] as number
      const y0 = layer.segs[i + 1] as number
      const x1 = layer.segs[i + 2] as number
      const y1 = layer.segs[i + 3] as number
      if (layer.side === 'B') {
        back.moveTo(x0, y0)
        back.lineTo(x1, y1)
        continue
      }
      const w = Math.round((layer.segs[i + 4] as number) * 4) / 4
      const lead = (s.groups[layer.groups[i / 7] as number]?.t ?? -1) >= 0
      const key = lead ? -w - 1 : w
      let p = front.get(key)
      if (p === undefined) {
        p = new Path2D()
        front.set(key, p)
      }
      p.moveTo(x0, y0)
      p.lineTo(x1, y1)
      frontLines.moveTo(x0, y0)
      frontLines.lineTo(x1, y1)
    }
  }
  const vias = new Path2D()
  for (const v of s.vias) {
    vias.moveTo(v.x + v.r, v.y)
    vias.arc(v.x, v.y, v.r, 0, Math.PI * 2)
  }
  const zonesF = new Path2D()
  const zonesB = new Path2D()
  for (const z of s.zones) {
    if (z.side === 'F') polyInto(zonesF, z.fill)
    else if (z.side === 'B') polyInto(zonesB, z.fill)
  }
  const outline = new Path2D()
  for (const l of s.board) polyInto(outline, l)
  const loopLen = s.board.map((l) => {
    let t = 0
    for (let i = 2; i + 1 < l.length; i += 2) t += Math.hypot((l[i] as number) - (l[i - 2] as number), (l[i + 1] as number) - (l[i - 1] as number))
    return t + Math.hypot((l[0] as number) - (l[l.length - 2] as number), (l[1] as number) - (l[l.length - 1] as number))
  })
  const parts = new Path2D()
  let hero: Path2D | undefined
  for (const pt of s.parts) {
    if (pt.kind === 'pin') continue
    if (pt.hero === true) {
      hero = new Path2D()
      if (pt.kind === 'valve') hero.arc(pt.x, pt.y, Math.max(pt.w, pt.h) / 2, 0, 2 * Math.PI)
      else rectInto(hero, pt.x, pt.y, pt.w, pt.h, pt.rot)
    } else rectInto(parts, pt.x, pt.y, pt.w, pt.h, pt.rot)
  }
  const sorted = [...s.drills].sort((a, b) => b.r - a.r)
  const cut = sorted.length === 0 ? 0 : (sorted[0] as { r: number }).r * 0.45
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const l of s.board) {
    for (let i = 0; i + 1 < l.length; i += 2) {
      x0 = Math.min(x0, l[i] as number)
      x1 = Math.max(x1, l[i] as number)
      y0 = Math.min(y0, l[i + 1] as number)
      y1 = Math.max(y1, l[i + 1] as number)
    }
  }
  const g: Geo = {
    front: [...front.entries()].map(([k, path]) => ({ w: k < 0 ? -k - 1 : k, path, lead: k < 0 })).sort((a, b) => Number(a.lead) - Number(b.lead)),
    frontLines,
    back,
    vias,
    viaRings: s.vias,
    zonesF,
    zonesB,
    outline,
    loops: s.board,
    loopLen,
    parts,
    hero,
    drillsBig: sorted.filter((d) => d.r >= cut && d.r > 0),
    drillsSmall: sorted.filter((d) => d.r < cut || d.r <= 0),
    bounds: { x0, y0, x1, y1 },
    hatch: new Map(),
    layerPaths: new Map()
  }
  GEO.set(s, g)
  return g
}

export function hatchPath(g: Geo, spacing: number, angle = 1): Path2D {
  const lv = Math.pow(2, Math.round(Math.log2(Math.max(0.25, spacing)))) * angle
  const hit = g.hatch.get(lv)
  if (hit !== undefined) return hit
  const sp = Math.abs(lv)
  const p = new Path2D()
  const { x0, y0, x1, y1 } = g.bounds
  const pad = 20
  if (angle > 0) {
    for (let c = x0 + y0 - (y1 - y0) - pad; c <= x1 + y1 + pad; c += sp) {
      p.moveTo(c - y0 + pad, y0 - pad)
      p.lineTo(c - y1 - pad, y1 + pad)
    }
  } else {
    for (let c = x0 - y1 - pad; c <= x1 - y0 + pad; c += sp) {
      p.moveTo(c + y0 - pad, y0 - pad)
      p.lineTo(c + y1 + pad, y1 + pad)
    }
  }
  g.hatch.set(lv, p)
  return p
}

export function layerPaths(s: TraceScene, name: string, layer: number, zones: number[]): { lines: Path2D; zones: Path2D } {
  const g = geo(s)
  const hit = g.layerPaths.get(name)
  if (hit !== undefined) return hit
  const lines = new Path2D()
  const segs = s.layers[layer]?.segs ?? []
  for (let i = 0; i + 6 < segs.length; i += 7) {
    lines.moveTo(segs[i] as number, segs[i + 1] as number)
    lines.lineTo(segs[i + 2] as number, segs[i + 3] as number)
  }
  const zp = new Path2D()
  for (const zi of zones) {
    const z = s.zones[zi]
    if (z !== undefined) polyInto(zp, z.fill)
  }
  const out = { lines, zones: zp }
  g.layerPaths.set(name, out)
  return out
}

/** where the outline's pen is when frac of it is drawn, board px; nothing once it is closed */
export function edgeHead(g: Geo, frac: number): Pt | undefined {
  let rest = g.loopLen.reduce((a, b) => a + b, 0) * clamp01(frac)
  let head: Pt | undefined
  for (const l of g.loops) {
    if (rest <= 0) break
    const n = l.length / 2
    head = [l[0] as number, l[1] as number]
    for (let i = 1; i <= n && rest > 0; i++) {
      const j = (i % n) * 2
      const px = l[(i - 1) * 2] as number
      const py = l[(i - 1) * 2 + 1] as number
      const d = Math.hypot((l[j] as number) - px, (l[j + 1] as number) - py)
      const t = d > 0 ? Math.min(1, rest / d) : 1
      head = [px + ((l[j] as number) - px) * t, py + ((l[j + 1] as number) - py) * t]
      rest -= d
    }
  }
  return frac >= 1 ? undefined : head
}

export function edgeTo(pen: Pen, g: Geo, frac: number): Pt | undefined {
  const total = g.loopLen.reduce((a, b) => a + b, 0)
  let rest = total * clamp01(frac)
  const ctx = pen.ctx
  ctx.beginPath()
  let head: Pt | undefined
  for (const l of g.loops) {
    if (rest <= 0) break
    ctx.moveTo(l[0] as number, l[1] as number)
    head = [l[0] as number, l[1] as number]
    const n = l.length / 2
    for (let i = 1; i <= n && rest > 0; i++) {
      const j = (i % n) * 2
      const px = l[(i - 1) * 2] as number
      const py = l[(i - 1) * 2 + 1] as number
      const qx = l[j] as number
      const qy = l[j + 1] as number
      const d = Math.hypot(qx - px, qy - py)
      const t = d > 0 ? Math.min(1, rest / d) : 1
      head = [px + (qx - px) * t, py + (qy - py) * t]
      ctx.lineTo(head[0], head[1])
      rest -= d
    }
  }
  ctx.stroke()
  return frac >= 1 ? undefined : head
}

export interface PlanOpts {
  /** the whole plan's opacity, for fading it out */
  alpha?: number
  hatch?: number
  back?: number
  parts?: number
  drills?: number
  edge?: number
  /** the fine copper's weight over the base pen */
  weight?: number
  construction?: boolean
  quiet?: number
  fine?: number
  /** the strength of the main chip's own copper, drawn at one pen width (weight) so a brighter, heavier line can sit over it; without it that copper is full ink at its true width */
  lead?: number
  /** copper to draw in place of the board's front copper */
  front?: Front
  /** draw that copper alone */
  bare?: boolean
  /** wide copper and large pads drawn at their true size as outlines in the copper pen, as the bus's neighbours are, so a close view of the board reads at the strength of a wide one */
  solid?: boolean
}

export function drawPlan(pen: Pen, s: TraceScene, m: Aff, o: PlanOpts): number {
  const A = o.alpha ?? 1
  const ctx = pen.ctx
  const g = geo(s)
  const sc = scaleOf(m)
  const { f, m: c, h } = weights(pen.u)
  const px = (v: number): number => v / sc
  setT(pen, m)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  let drawn = 0
  if (o.construction === true) {
    bleed(pen, false)
    ctx.strokeStyle = pen.ink
    ctx.globalAlpha = A * 0.3
    ctx.lineWidth = px(f)
    ctx.setLineDash([px(14 * pen.u), px(3 * pen.u)])
    ctx.stroke(g.frontLines)
    ctx.stroke(g.outline)
    ctx.globalAlpha = A * 0.24
    ctx.stroke(g.parts)
    const pads = new Path2D()
    for (const pad of s.pads) if (pad.side !== 'B') padPath(pads, pad)
    ctx.stroke(pads)
    if (g.hero !== undefined) {
      ctx.globalAlpha = A * 0.4
      ctx.stroke(g.hero)
    }
    ctx.setLineDash([])
    ctx.globalAlpha = A
    return 2
  }
  ctx.strokeStyle = pen.ink
  ctx.fillStyle = pen.ink
  const hp = pen.chip ?? s.parts.find((pt) => pt.hero === true)
  ctx.save()
  if (hp !== undefined && hp.kind !== 'valve') {
    const [c0, s0] = [Math.cos(hp.rot), Math.sin(hp.rot)]
    const under = new Path2D()
    under.rect(-1e7, -1e7, 2e7, 2e7)
    ;([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Pt[]).forEach(([u, v], k) => {
      const x = hp.x + (c0 * u * hp.w - s0 * v * hp.h) / 2
      const y = hp.y + (s0 * u * hp.w + c0 * v * hp.h) / 2
      if (k === 0) under.moveTo(x, y)
      else under.lineTo(x, y)
    })
    under.closePath()
    ctx.clip(under, 'evenodd')
  }
  if ((o.back ?? 0) > 0 && o.bare !== true) {
    ctx.globalAlpha = A * (0.3 * (o.back ?? 0))
    ctx.lineWidth = px(f)
    ctx.setLineDash([px(4 * pen.u), px(3.5 * pen.u)])
    ctx.stroke(g.back)
    ctx.globalAlpha = A * (0.16 * (o.back ?? 0))
    ctx.stroke(g.zonesB)
    ctx.setLineDash([])
    drawn += 2
  }
  if ((o.hatch ?? 0) > 0 && o.bare !== true) {
    ctx.globalAlpha = A * (0.4 * (o.hatch ?? 0))
    ctx.lineWidth = px(f)
    ctx.stroke(g.zonesF)
    drawn += 2
  }
  ctx.globalAlpha = A
  const quiet = o.fine ?? o.quiet ?? 0.5
  const knock: Array<{ w: number; path: Path2D }> = []
  for (const b of o.front ?? g.front) {
    if (o.fine !== undefined && (!b.lead || o.lead !== undefined)) {
      ctx.globalAlpha = A * (b.lead ? o.lead ?? 1 : o.fine)
      const wide = o.solid === true && b.w * sc >= 3 * c
      ctx.lineWidth = wide ? b.w + px(2 * c) : px(c * (o.weight ?? 1))
      ctx.stroke(b.path)
      if (wide) knock.push(b)
      drawn += 1
      continue
    }
    const edge = b.lead ? 1.3 * c : c
    const wide = b.w * sc >= 3 * edge
    ctx.globalAlpha = A * (b.lead ? 1 : quiet)
    ctx.lineWidth = wide ? b.w + px(2 * edge) : Math.max(b.w, px(edge))
    ctx.stroke(b.path)
    if (wide) knock.push(b)
    drawn += 1
  }
  if (o.bare === true) {
    knockout(pen, () => {
      for (const b of knock) {
        ctx.lineWidth = b.w
        ctx.stroke(b.path)
      }
    })
    ctx.globalAlpha = 1
    bleed(pen, false)
    ctx.restore()
    return drawn
  }
  const big = new Path2D()
  const bigOwn: TracePad[] = []
  const bigOut = new Path2D()
  const small = [new Path2D(), new Path2D()]
  const clear = hp === undefined || pen.hero === undefined ? undefined : nameBand(ctx, hp, pen.hero)
  const inBand = (x: number, y: number): boolean => clear !== undefined && clear.every((a, k) => {
    const b = clear[(k + 1) % clear.length] as Pt
    return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0
  })
  for (const pad of s.pads) {
    if (pad.side === 'B') continue
    const tier = pad.hero === true ? 1 : 0
    if (tier === 1 && clear !== undefined) {
      const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]] as Pt[]).map(([u, v]): Pt => [pad.x + (Math.cos(pad.rot) * u * pad.w - Math.sin(pad.rot) * v * pad.h) / 2, pad.y + (Math.sin(pad.rot) * u * pad.w + Math.cos(pad.rot) * v * pad.h) / 2])
      const across = Math.hypot((clear[3] as Pt)[0] - (clear[0] as Pt)[0], (clear[3] as Pt)[1] - (clear[0] as Pt)[1])
      if (Math.min(pad.w, pad.h) < across ? corners.some(([x, y]) => inBand(x, y)) : corners.every(([x, y]) => inBand(x, y))) continue
    }
    if (Math.min(pad.w, pad.h) * sc >= 2.6 * f) {
      if (tier === 1) bigOwn.push(pad)
      else {
        padPath(bigOut, pad, px(o.solid === true ? c : f))
        padPath(big, pad)
      }
    } else padPath(small[tier] as Path2D, pad, px(0.3 * f))
  }
  ctx.globalAlpha = A * quiet
  ctx.fill(bigOut)
  ctx.fill(small[0] as Path2D)
  const ownPads = (): void => {
    ctx.save()
    if (hp !== undefined && clear !== undefined) {
      const keep = new Path2D()
      const r = 2 * Math.max(hp.w, hp.h)
      keep.rect(hp.x - r, hp.y - r, 2 * r, 2 * r)
      clear.forEach((q, i) => { if (i === 0) keep.moveTo(q[0], q[1]); else keep.lineTo(q[0], q[1]) })
      keep.closePath()
      ctx.clip(keep, 'evenodd')
    }
    ctx.fillStyle = pen.ink
    ctx.globalAlpha = A
    for (const pad of [...bigOwn].sort((a, b) => b.w * b.h - a.w * a.h)) {
      const ring = new Path2D()
      padPath(ring, pad, px(o.solid === true ? c : f))
      ctx.fillStyle = pen.ink
      ctx.fill(ring)
      const hole = new Path2D()
      padPath(hole, pad)
      knockout(pen, () => { ctx.fill(hole) })
    }
    ctx.fillStyle = pen.ink
    ctx.fill(small[1] as Path2D)
    ctx.restore()
  }
  ctx.globalAlpha = A * (quiet)
  const viaKnock = s.vias.length > 0 && Math.min(...s.vias.slice(0, 8).map((v) => v.r)) * sc >= 1.8 * f
  if (viaKnock) {
    ctx.lineWidth = px(2 * f)
    ctx.stroke(g.vias)
  }
  ctx.fill(g.vias)
  ctx.globalAlpha = A
  knockout(pen, () => {
    for (const b of knock) {
      ctx.lineWidth = b.w
      ctx.stroke(b.path)
    }
    ctx.fill(big)
    if (viaKnock) ctx.fill(g.vias)
  })
  ctx.strokeStyle = pen.ink
  ctx.fillStyle = pen.ink
  drawn += 3
  if (viaKnock) {
    ctx.globalAlpha = A * (quiet)
    ctx.lineWidth = px(f)
    ctx.beginPath()
    for (const v of g.viaRings) {
      ctx.moveTo(v.x + v.r * 0.42, v.y)
      ctx.arc(v.x, v.y, v.r * 0.42, 0, Math.PI * 2)
    }
    ctx.stroke()
    ctx.globalAlpha = A
  }
  const dr = o.drills ?? 0
  if (dr > 0) {
    ctx.globalAlpha = A * (dr > 2 ? 1 : 0.85)
    ctx.lineWidth = px(dr > 2 ? h : f)
    const ring = (list: Array<{ x: number; y: number; r: number }>, marks: boolean): void => {
      ctx.beginPath()
      for (const d of list) {
        ctx.moveTo(d.x + d.r, d.y)
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
        if (marks && d.r * sc >= 3 * f) {
          const a = d.r + px(4 * pen.u)
          ctx.moveTo(d.x - a, d.y)
          ctx.lineTo(d.x + a, d.y)
          ctx.moveTo(d.x, d.y - a)
          ctx.lineTo(d.x, d.y + a)
        }
      }
      ctx.stroke()
    }
    ring(g.drillsBig, true)
    ctx.globalAlpha = A * (dr > 2 ? 1 : quiet)
    ctx.lineWidth = px(f)
    if (dr > 1) ring(g.drillsSmall, false)
    ctx.globalAlpha = A
    drawn += 1
  }
  if ((o.parts ?? 0) > 0) {
    ctx.globalAlpha = A * (0.45 * (o.parts ?? 0))
    ctx.lineWidth = px(f)
    ctx.stroke(g.parts)
    ctx.globalAlpha = A
    drawn += 1
  }
  ctx.restore()
  if (g.hero !== undefined && (o.parts ?? 0) >= 0) {
    const body = g.hero
    const valve = s.parts.some((pt) => pt.hero === true && pt.kind === 'valve')
    if ((o.parts ?? 0) > 0 && !valve) {
      knockout(pen, () => { ctx.fill(body) })
      ctx.strokeStyle = pen.ink
      ctx.fillStyle = pen.ink
    }
    ownPads()
    ctx.globalAlpha = A
    ctx.lineWidth = px(h)
    ctx.stroke(g.hero)
    if (hp !== undefined && hp.kind !== 'valve' && pen.hero !== undefined) heroName(pen, hp, pen.hero, m, sc)
    drawn += 1
  } else ownPads()
  const e = o.edge ?? 1
  if (e > 0) {
    ctx.lineWidth = px(h)
    if (e >= 1) ctx.stroke(g.outline)
    else edgeTo(pen, g, e)
    drawn += 1
  }
  bleed(pen, false)
  return drawn
}

/** the main chip's name lettered inside its outline along the body's longer side, a third of the body wide, read the way its lid reads (else upright), on a clear band over its pads, with a dot inside its pin 1 corner; the name only while its box, its measured width by its capital height, stands wholly in the frame, on a part marking too, and the pin 1 dot only with the name and only while its own box stands in the frame */
/** text is measured at no less than MEASURE_PX: Chromium on Windows returns other boxes for small font sizes */
const MEASURE_PX = 100

/** the paper the main chip's name keeps clear on its lid, board px corners: its lettering's box and band, whichever way it reads */
function nameBand(ctx: CanvasRenderingContext2D, hp: { x: number; y: number; w: number; h: number; rot: number }, hero: { label: string; read?: Pt | undefined }): Pt[] {
  const { size, along } = nameSize(ctx, hp, hero)
  ctx.font = `${size}px ${DRAFT}`
  const w = ctx.measureText(hero.label).width / 2 + BAND * CAP * size
  const t = 0.55 * size + BAND * CAP * size
  const [c, si] = [Math.cos(along), Math.sin(along)]
  return ([[-w, -t], [w, -t], [w, t], [-w, t]] as Pt[]).map(([u, v]): Pt => [hp.x + c * u - si * v, hp.y + si * u + c * v])
}

const nameSize = (ctx: CanvasRenderingContext2D, hp: { w: number; h: number; rot: number }, hero: { label: string; read?: Pt | undefined }): { size: number; along: number; onW: boolean; per: number } => {
  const read = hero.read
  const onW = read === undefined ? hp.w >= hp.h : read[0] !== 0
  const [long, short] = onW ? [hp.w, hp.h] : [hp.h, hp.w]
  const probe = Math.max(MEASURE_PX, short)
  ctx.font = `${probe}px ${DRAFT}`
  const per = ctx.measureText(hero.label).width / probe
  return { size: Math.min(short / (3 * CAP), (0.8 * long) / Math.max(1e-6, per)), along: hp.rot + (read === undefined ? (onW ? 0 : Math.PI / 2) : Math.atan2(read[1], read[0])), onW, per }
}

function heroName(pen: Pen, hp: { x: number; y: number; w: number; h: number; rot: number }, hero: { label: string; pin1?: [number, number] | undefined; read?: Pt | undefined; part?: boolean }, m: Aff, sc: number): void {
  const ctx = pen.ctx
  const { label, pin1, read, part } = hero
  const { size, along, onW, per } = nameSize(ctx, hp, hero)
  const short = onW ? hp.h : hp.w
  const sx = m[0] * Math.cos(along) + m[2] * Math.sin(along)
  const sy = m[1] * Math.cos(along) + m[3] * Math.sin(along)
  const turn = read === undefined && (sx < -1e-6 || (Math.abs(sx) <= 1e-6 && sy > 0)) ? Math.PI : 0
  if (size * CAP * sc < 6 * pen.u) return
  const lift = ctx.globalAlpha
  const inFrame = (t: Aff, pts: number[][]): boolean => pts.every(([x, y]) => {
    const px = t[0] * (x as number) + t[2] * (y as number) + t[4]
    const py = t[1] * (x as number) + t[3] * (y as number) + t[5]
    return px >= 0 && py >= 0 && px <= pen.W * pen.k && py <= pen.H * pen.k
  })
  const plane = ctx.getTransform()
  const r = along + turn
  const back = pen.m ?? m
  const at = mul(back, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), hp.x, hp.y])
  const dev = (pen.base === undefined ? at : mul(pen.base, at)).map((v) => pen.k * v) as Aff
  const [hw, hh] = [(per * size) / 2, (CAP * size) / 2]
  const inset = 0.5 * CAP * size * sc
  const whole = inFrame(dev, [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) && (part === true || framed(pen, label, 0, 0, size, 'center', 'middle', 0, inset, { a: dev[0], b: dev[1], c: dev[2], d: dev[3], e: dev[4], f: dev[5] }))
  if (whole && pin1 !== undefined) {
    const c = Math.cos(hp.rot)
    const si = Math.sin(hp.rot)
    const lx = (pin1[0] - hp.x) * c + (pin1[1] - hp.y) * si
    const ly = -(pin1[0] - hp.x) * si + (pin1[1] - hp.y) * c
    const dx = Math.sign(lx) * (hp.w / 2 - 0.16 * short)
    const dy = Math.sign(ly) * (hp.h / 2 - 0.16 * short)
    const [ox, oy, rr] = [hp.x + dx * c - dy * si, hp.y + dx * si + dy * c, 0.045 * Math.min(hp.w, hp.h)]
    if (inFrame([plane.a, plane.b, plane.c, plane.d, plane.e, plane.f], [[ox - rr, oy - rr], [ox + rr, oy - rr], [ox + rr, oy + rr], [ox - rr, oy + rr]])) {
      ctx.beginPath()
      ctx.arc(ox, oy, rr, 0, 2 * Math.PI)
      ctx.fillStyle = pen.ink
      ctx.fill()
    }
  }
  setT(pen, at)
  if (whole) lettered(pen, label, 0, 0, size, { align: 'center', base: 'middle', free: true, alpha: lift, inset, part: part === true })
  setT(pen, back)
}

/** the main chip's name and pin 1 dot on the plane m maps from board px, lettered as the plan letters them, so a hand-off from the plan to the lid changes only the plane */
export function planeName(pen: Pen, hp: { x: number; y: number; w: number; h: number; rot: number }, hero: NonNullable<Pen['lid']>, m: Aff): void {
  const back = pen.m ?? ID
  setT(pen, m)
  pen.ctx.globalAlpha = 1
  heroName(pen, hp, hero, m, scaleOf(m))
  setT(pen, back)
}

/** the main chip's pad rows and columns as pencil centre lines across its body */
export function heroPencil(pen: Pen, s: TraceScene, m: Aff): void {
  const hp = s.parts.find((pt) => pt.hero === true)
  if (hp === undefined) return
  const co = Math.cos(hp.rot)
  const si = Math.sin(hp.rot)
  const own = s.pads.filter((pad) => pad.hero === true).map((pad): Pt => [co * (pad.x - hp.x) + si * (pad.y - hp.y), -si * (pad.x - hp.x) + co * (pad.y - hp.y)])
  if (own.length === 0 || own.length > 400) return
  const rows = (k: 0 | 1): number[] => [...new Set(own.map((q) => Math.round(q[k] * 2) / 2))]
  const grid = new Path2D()
  const line = (a: Pt, b: Pt): void => {
    grid.moveTo(hp.x + co * a[0] - si * a[1], hp.y + si * a[0] + co * a[1])
    grid.lineTo(hp.x + co * b[0] - si * b[1], hp.y + si * b[0] + co * b[1])
  }
  for (const x of rows(0)) line([x, -hp.h / 2], [x, hp.h / 2])
  for (const y of rows(1)) line([-hp.w / 2, y], [hp.w / 2, y])
  const sc = scaleOf(m)
  setT(pen, m)
  pen.ctx.strokeStyle = pen.ink
  pen.ctx.globalAlpha = 0.3
  pen.ctx.lineWidth = weights(pen.u).f / sc
  pen.ctx.setLineDash([(14 * pen.u) / sc, (3 * pen.u) / sc])
  pen.ctx.stroke(grid)
  pen.ctx.setLineDash([])
  pen.ctx.globalAlpha = 1
}

export function drawGrid(pen: Pen, m: Aff, pxPerMm: number, alpha = 1): void {
  const ctx = pen.ctx
  const sc = scaleOf(m)
  const inv = invert(m)
  const corners = [[0, 0], [pen.W, 0], [0, pen.H], [pen.W, pen.H]].map(([x, y]) => apply(inv, x as number, y as number))
  const bx0 = Math.min(...corners.map((c) => c[0]))
  const bx1 = Math.max(...corners.map((c) => c[0]))
  const by0 = Math.min(...corners.map((c) => c[1]))
  const by1 = Math.max(...corners.map((c) => c[1]))
  setT(pen, m)
  bleed(pen, false)
  ctx.setLineDash([])
  ctx.strokeStyle = pen.ink
  for (const step of [0.5, 1, 2, 5, 10, 20, 50, 100]) {
    const gap = step * pxPerMm * sc
    if (gap < 7 * pen.u) continue
    const major = step * 5 * pxPerMm
    const a = Math.min(1, (gap - 7 * pen.u) / (7 * pen.u))
    const minor = step * pxPerMm
    for (const [stepPx, al, w] of [[minor, 0.07 * a, 0.6], [major, 0.13, 0.8]] as const) {
      ctx.globalAlpha = al * alpha
      ctx.lineWidth = (w * pen.u) / sc
      ctx.beginPath()
      for (let x = Math.floor(bx0 / stepPx) * stepPx; x <= bx1; x += stepPx) {
        ctx.moveTo(x, by0)
        ctx.lineTo(x, by1)
      }
      for (let y = Math.floor(by0 / stepPx) * stepPx; y <= by1; y += stepPx) {
        ctx.moveTo(bx0, y)
        ctx.lineTo(bx1, y)
      }
      ctx.stroke()
    }
    break
  }
  ctx.globalAlpha = 1
}

/** whether a box drawn through m reaches below a panel's reveal, so its glyphs must wait */
export const gated = (pen: Pen, m: Aff, x0: number, y0: number, x1: number, y1: number): boolean =>
  pen.gate !== undefined && Math.max(...[[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => apply(m, x as number, y as number)[1])) > pen.gate

/** whether a line of lettering lies wholly in the frame under the canvas's own transform: a note is whole in the frame or not drawn, so none ever slides out across an edge */
export const framed = (pen: Pen, text: string, x: number, y: number, size: number, align: CanvasTextAlign = 'left', base: CanvasTextBaseline = 'alphabetic', spacing = 0, inset = 0, t: { a: number; b: number; c: number; d: number; e: number; f: number } = pen.ctx.getTransform()): boolean => {
  const w = text.length * size * (0.66 + spacing)
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x
  const [y0, y1] = base === 'middle' ? [y - 0.37 * size, y + 0.37 * size] : base === 'top' ? [y, y + 0.73 * size] : [y - 0.73 * size, y]
  const k = pen.k
  return [[x0, y0], [x0 + w, y0], [x0, y1], [x0 + w, y1]].every(([a, b]) => {
    const sx = t.a * (a as number) + t.c * (b as number) + t.e
    const sy = t.b * (a as number) + t.d * (b as number) + t.f
    return sx >= (inset - 1) * k && sx <= (pen.W + 1 - inset) * k && sy >= (inset - 1) * k && sy <= (pen.H + 1 - inset) * k
  })
}

/** a line of lettering, set whole: with chars, nothing until the first glyph is due, then every glyph at once */
export const lettered = (pen: Pen, text: string, x: number, y: number, size: number, opts: { align?: CanvasTextAlign; spacing?: number; color?: string; alpha?: number; base?: CanvasTextBaseline; weight?: string; chars?: number; free?: boolean; clear?: number; part?: boolean; inset?: number } = {}): void => {
  const ctx = pen.ctx
  const display = opts.weight !== undefined && opts.weight !== ''
  if (opts.part !== true && !framed(pen, text, x, y, size, opts.align, opts.base, display ? opts.spacing ?? 0.06 : 0, opts.inset)) return
  if (opts.free !== true && pen.gate !== undefined) {
    const w = text.length * size * (0.66 + (display ? opts.spacing ?? 0.06 : 0))
    const x0 = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x
    const [t0, t1] = opts.base === 'middle' ? [y - 0.55 * size, y + 0.55 * size] : opts.base === 'top' ? [y, y + size] : [y - 0.8 * size, y + 0.25 * size]
    if (gated(pen, pen.m ?? ID, x0, t0, x0 + w, t1)) return
  }
  if (opts.chars !== undefined && opts.chars < 1) return
  ctx.font = display ? `${opts.weight ?? ''} ${size}px ${FONT}` : `${size}px ${DRAFT}`
  ctx.textAlign = opts.align ?? 'left'
  ctx.textBaseline = opts.base ?? 'alphabetic'
  ctx.letterSpacing = display ? `${(opts.spacing ?? 0.06) * size}px` : '0px'
  if (opts.clear !== undefined) {
    knockout(pen, () => {
      ctx.lineJoin = 'round'
      ctx.lineWidth = opts.clear ?? 0
      ctx.strokeText(text, x, y)
    })
  }
  const w = ctx.measureText(text).width
  const x0 = opts.align === 'center' ? x - w / 2 : opts.align === 'right' || opts.align === 'end' ? x - w : x
  const [t0, t1] = opts.base === 'middle' ? [y - 0.55 * size, y + 0.55 * size] : opts.base === 'top' || opts.base === 'hanging' ? [y, y + size] : opts.base === 'bottom' ? [y - size, y] : [y - 0.8 * size, y + 0.25 * size]
  band(pen, x0, t0, x0 + w, t1, BAND * CAP * size, opts.alpha ?? 1)
  ctx.fillStyle = opts.color ?? pen.ink
  ctx.globalAlpha = opts.alpha ?? 1
  bleed(pen, true, opts.color ?? pen.ink)
  ctx.fillText(text, x, y)
  ctx.letterSpacing = '0px'
  ctx.globalAlpha = 1
}

/** a dimension's arrowhead length, in sheet units */
const ARROW = 11

export function dimension(pen: Pen, a: Pt, b: Pt, off: number, text: string, opts: { color?: string; size?: number; alpha?: number; m?: Aff; toward?: Pt; grow?: number; inside?: { x: number; y: number; w: number; h: number }; touch?: boolean; level?: boolean; tight?: boolean | undefined } = {}): Pt | undefined {
  const ctx = pen.ctx
  const { f } = weights(pen.u)
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (L < 1) return undefined
  const d: Pt = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  const n: Pt = [-d[1], d[0]]
  const A: Pt = [a[0] + n[0] * off, a[1] + n[1] * off]
  const Bp: Pt = [b[0] + n[0] * off, b[1] + n[1] * off]
  const sg = Math.sign(off) || 1
  const ext = 6 * pen.u
  setT(pen, opts.m ?? ID)
  const grow = clamp01(opts.grow ?? 1)
  if (grow <= 0) return
  ctx.save()
  if (grow < 1) {
    const big = Math.abs(off) + 60 * pen.u
    const reach = grow * (L + ext)
    ctx.beginPath()
    ctx.moveTo(a[0] - d[0] * ext - n[0] * big, a[1] - d[1] * ext - n[1] * big)
    ctx.lineTo(a[0] - d[0] * ext + n[0] * big, a[1] - d[1] * ext + n[1] * big)
    ctx.lineTo(a[0] + d[0] * reach + n[0] * big, a[1] + d[1] * reach + n[1] * big)
    ctx.lineTo(a[0] + d[0] * reach - n[0] * big, a[1] + d[1] * reach - n[1] * big)
    ctx.closePath()
    ctx.clip()
  }
  ctx.setLineDash([])
  ctx.strokeStyle = opts.color ?? pen.ink
  ctx.globalAlpha = opts.alpha ?? 1
  ctx.lineWidth = f
  bleed(pen, true, opts.color ?? pen.ink)
  ctx.beginPath()
  for (const [p, q] of [[a, A], [b, Bp]] as const) {
    const lead = opts.touch === true ? 0 : 4 * pen.u
    ctx.moveTo(p[0] + n[0] * sg * lead, p[1] + n[1] * sg * lead)
    ctx.lineTo(q[0] + n[0] * sg * ext, q[1] + n[1] * sg * ext)
  }
  const ah = ARROW * pen.u
  const tight = opts.tight ?? L < 2.6 * ah
  const run = tight ? 1.6 * ah : 0
  ctx.moveTo(A[0] - d[0] * run, A[1] - d[1] * run)
  ctx.lineTo(Bp[0] + d[0] * run, Bp[1] + d[1] * run)
  for (const [p, s] of [[A, tight ? -1 : 1], [Bp, tight ? 1 : -1]] as const) {
    ctx.moveTo(p[0] + (d[0] * s + n[0] * 0.3) * ah, p[1] + (d[1] * s + n[1] * 0.3) * ah)
    ctx.lineTo(p[0], p[1])
    ctx.lineTo(p[0] + (d[0] * s - n[0] * 0.3) * ah, p[1] + (d[1] * s - n[1] * 0.3) * ah)
  }
  ctx.stroke()
  const size = opts.size ?? 22 * pen.u
  let ang = Math.atan2(d[1], d[0])
  if (ang > Math.PI / 2) ang -= Math.PI
  if (ang < -Math.PI / 2) ang += Math.PI
  const upright = opts.inside !== undefined && Math.abs(Math.sin(ang)) > 0.5
  if (upright && opts.inside !== undefined && text.length * size * 0.66 + 10 * pen.u > opts.inside.h && / MM$/.test(text)) text = text.replace(/ MM$/, '')
  const tw = text.length * size * 0.66 + 10 * pen.u
  const cx = (A[0] + Bp[0]) / 2
  const cy = (A[1] + Bp[1]) / 2
  const t = opts.toward
  const way = t !== undefined && (t[0] - cx) * d[0] + (t[1] - cy) * d[1] < 0 ? -1 : 1
  const tooLong = opts.inside !== undefined && Math.abs(Math.sin(ang)) > 0.5 && tw > opts.inside.h
  if ((tight && t !== undefined) || opts.level === true || tooLong) ang = 0
  const along = ang === 0 && tight ? Math.abs(d[0]) * tw + Math.abs(d[1]) * size * 1.24 : tw
  const past = tight ? way * (L / 2 + run + 0.6 * ah + along / 2) : 0
  let mx = cx + d[0] * past
  let my = cy + d[1] * past
  const box = opts.inside
  if (box !== undefined) {
    const hx = Math.abs(Math.cos(ang)) * tw / 2 + Math.abs(Math.sin(ang)) * size * 0.62
    const hy = Math.abs(Math.sin(ang)) * tw / 2 + Math.abs(Math.cos(ang)) * size * 0.62
    mx = Math.min(box.x + box.w - hx, Math.max(box.x + hx, mx))
    my = Math.min(box.y + box.h - hy, Math.max(box.y + hy, my))
  }
  ctx.restore()
  const hx = Math.abs(Math.cos(ang)) * tw / 2 + Math.abs(Math.sin(ang)) * size * 0.62
  const hy = Math.abs(Math.sin(ang)) * tw / 2 + Math.abs(Math.cos(ang)) * size * 0.62
  if (text.length > 0 && grow >= 1 && !gated(pen, opts.m ?? ID, mx - hx, my - hy, mx + hx, my + hy)) {
    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(ang)
    knockout(pen, () => { ctx.fillRect(-tw / 2, -size * 0.62, tw, size * 1.24); })
    lettered(pen, text, 0, 0, size, { align: 'center', base: 'middle', color: opts.color ?? pen.ink, alpha: opts.alpha ?? 1, free: true })
    ctx.restore()
  }
  ctx.globalAlpha = 1
  bleed(pen, false)
  return [mx, my]
}

/** how many glyphs of a line to show when n are due: whole space-separated tokens only */
export const tokens = (text: string, n: number): number => {
  if (n >= text.length) return text.length
  const cut = text.lastIndexOf(' ', Math.floor(n))
  return cut < 0 ? 0 : cut
}
