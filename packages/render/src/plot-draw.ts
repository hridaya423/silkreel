import { makeCam, project, sampleShot } from '@silk-reel/choreo'
import type { Cam, FlatPath, TracePart, TraceTimeline } from '@silk-reel/choreo'
import { FONT } from './font'
import { drawTitle } from './title'

type Pt = [number, number]

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const ease = (x: number): number => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

const dropAt = (t: number, p: number, hero: boolean): number => {
  const dur = (hero ? 0.75 : 0.5) / 24
  const u = (p - (t - dur)) / dur
  return u <= 0 ? 1 : u >= 1 ? 0 : (1 - u) ** 3
}
const snapBack = (s: number): number => (s <= 0 ? 1 : Math.exp(-s / 0.05) * Math.cos((2 * Math.PI * s) / 0.2))

const ROUND = new Set(['can', 'valve'])

interface View {
  cam: Cam
  W: number
  H: number
}

const toScreen = (v: View, x: number, y: number, z = 0): Pt | undefined => {
  const q = project(v.cam, x, y, z)
  if (q.w <= 0) return undefined
  return [(q.x * 0.5 + 0.5) * v.W, (0.5 - q.y * 0.5) * v.H]
}

const localAffine = (ctx: CanvasRenderingContext2D, v: View, x: number, y: number, z = 0): number => {
  const o = toScreen(v, x, y, z)
  const a = toScreen(v, x + 1, y, z)
  const b = toScreen(v, x, y + 1, z)
  if (o === undefined || a === undefined || b === undefined) return 0
  const ax = a[0] - o[0]
  const ay = a[1] - o[1]
  const bx = b[0] - o[0]
  const by = b[1] - o[1]
  ctx.setTransform(ax, ay, bx, by, o[0] - x * ax - y * bx, o[1] - x * ay - y * by)
  return Math.sqrt(Math.abs(ax * by - ay * bx))
}

const polyPath = (ctx: CanvasRenderingContext2D, v: View, path: FlatPath, z = 0, close = true): void => {
  ctx.beginPath()
  let started = false
  for (let i = 0; i + 1 < path.length; i += 2) {
    const s = toScreen(v, path[i] as number, path[i + 1] as number, z)
    if (s === undefined) continue
    if (started) ctx.lineTo(s[0], s[1])
    else ctx.moveTo(s[0], s[1])
    started = true
  }
  if (close) ctx.closePath()
}

const partialPath = (ctx: CanvasRenderingContext2D, v: View, path: FlatPath, frac: number): void => {
  let total = 0
  for (let i = 2; i + 1 < path.length; i += 2) total += Math.hypot((path[i] as number) - (path[i - 2] as number), (path[i + 1] as number) - (path[i - 1] as number))
  let rest = total * clamp01(frac)
  ctx.beginPath()
  const first = toScreen(v, path[0] as number, path[1] as number)
  if (first === undefined) return
  ctx.moveTo(first[0], first[1])
  for (let i = 2; i + 1 < path.length && rest > 0; i += 2) {
    const x0 = path[i - 2] as number
    const y0 = path[i - 1] as number
    const x1 = path[i] as number
    const y1 = path[i + 1] as number
    const d = Math.hypot(x1 - x0, y1 - y0)
    const k = d > 0 ? Math.min(1, rest / d) : 1
    const s = toScreen(v, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k)
    if (s !== undefined) ctx.lineTo(s[0], s[1])
    rest -= d
  }
}

const upright = (ctx: CanvasRenderingContext2D): void => {
  if (ctx.getTransform().a < 0) ctx.rotate(Math.PI)
}

const cross2 = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

const hull = (pts: Pt[]): Pt[] => {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const lo: Pt[] = []
  for (const p of s) {
    while (lo.length >= 2 && cross2(lo[lo.length - 2] as Pt, lo[lo.length - 1] as Pt, p) <= 0) lo.pop()
    lo.push(p)
  }
  const hi: Pt[] = []
  for (const p of s.reverse()) {
    while (hi.length >= 2 && cross2(hi[hi.length - 2] as Pt, hi[hi.length - 1] as Pt, p) <= 0) hi.pop()
    hi.push(p)
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)]
}

const fillStroke = (ctx: CanvasRenderingContext2D, pts: Pt[], fill: string): void => {
  ctx.beginPath()
  for (const [i, [x, y]] of pts.entries()) {
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  ctx.stroke()
}

const pose = (part: TracePart, p: number, dur: number, fallPx: number): { x: number; y: number; rot: number; lift: number } | undefined => {
  if (p < part.t - (part.hero === true ? 0.75 : 0.5) / 24) return undefined
  const k = snapBack((p - part.settle) * dur)
  const dr = dropAt(part.t, p, part.hero === true)
  const seat = part.kind === 'pin' ? (part.seat ?? part.z) : part.z
  const lift = dr * Math.max(seat * (part.hero === true ? 5 : 6), fallPx) + Math.max(0, k) * Math.min(1.5, 0.08 * seat)
  return { x: part.x + part.skew[0] * k, y: part.y + part.skew[1] * k, rot: part.rot + part.skew[2] * k, lift }
}

/**
 * The plot look: the trace film's score and camera, drawn as a pen plot on
 * paper. Copper is drawn as outlined tracks, pours are hatched, parts are
 * hidden-line boxes, and power-on is the one red pen running the live nets.
 */
export function drawPlotFrame(ctx: CanvasRenderingContext2D, tl: TraceTimeline, frame: number, scale = 1): number {
  const { scene: s, palette: pal } = tl
  const W = tl.width * scale
  const H = tl.height * scale
  const p = frame / tl.totalFrames
  const m = s.material
  const u = Math.min(W, H) / 1080
  const v: View = { cam: makeCam(sampleShot(s.shots, p), tl.width, tl.height), W, H }
  const paper = pal.bg
  const ink = pal.silk
  const pen2 = pal.copperDim
  const red = pal.head
  const A = s.acts
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (tl.transparent) ctx.clearRect(0, 0, W, H)
  else {
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, W, H)
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  let drawn = 0

  const outlineFrac = ease((p - A.draw[0]) / Math.max(1e-6, (A.draw[1] - A.draw[0]) * 0.35))
  ctx.strokeStyle = ink
  if (outlineFrac >= 1) {
    ctx.lineWidth = 1.1 * u
    for (const loop of s.board) {
      polyPath(ctx, v, loop, -m.thicknessPx)
      ctx.stroke()
    }
    for (const loop of s.board) {
      polyPath(ctx, v, loop)
      ctx.fillStyle = paper
      ctx.fill()
    }
  }
  ctx.lineWidth = 2.2 * u
  for (const path of s.outline) {
    if (outlineFrac >= 1) polyPath(ctx, v, path)
    else partialPath(ctx, v, path, outlineFrac)
    ctx.stroke()
    drawn += 1
  }
  if (outlineFrac >= 1) {
    ctx.lineWidth = 1.1 * u
    for (const loop of s.board) {
      const top: Pt[] = []
      const bot: Pt[] = []
      for (let i = 0; i + 1 < loop.length; i += 2) {
        const a = toScreen(v, loop[i] as number, loop[i + 1] as number)
        const b = toScreen(v, loop[i] as number, loop[i + 1] as number, -m.thicknessPx)
        if (a && b) {
          top.push(a)
          bot.push(b)
        }
      }
      const h = hull([...top, ...bot])
      const onHull = new Set(h.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`))
      ctx.beginPath()
      top.forEach((a, i) => {
        const b = bot[i] as Pt
        if (!onHull.has(`${b[0].toFixed(2)},${b[1].toFixed(2)}`)) return
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5) return
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
      })
      ctx.stroke()
    }
  }

  if (outlineFrac > 0) {
    ctx.strokeStyle = pen2
    ctx.lineWidth = 0.8 * u
    ctx.globalAlpha = outlineFrac
    for (const d of s.drills) {
      const k = localAffine(ctx, v, d.x, d.y)
      if (k === 0) continue
      ctx.lineWidth = (0.8 * u) / k
      ctx.beginPath()
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
  }

  const planScale = localAffine(ctx, v, s.origin.x, s.origin.y)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const step = (9 * u) / Math.max(1e-3, planScale)
  for (const zone of s.zones) {
    const frac = ease((p - zone.t0) / Math.max(1e-6, zone.t1 - zone.t0))
    if (frac <= 0) continue
    const live = zone.e0 >= 0 && p >= zone.e0
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i + 1 < zone.fill.length; i += 2) {
      x0 = Math.min(x0, zone.fill[i] as number)
      x1 = Math.max(x1, zone.fill[i] as number)
      y0 = Math.min(y0, zone.fill[i + 1] as number)
      y1 = Math.max(y1, zone.fill[i + 1] as number)
    }
    ctx.save()
    polyPath(ctx, v, zone.fill)
    ctx.clip()
    ctx.strokeStyle = live ? red : pen2
    ctx.globalAlpha = live ? 0.3 * ease((p - zone.e0) / 0.04) + (1 - ease((p - zone.e0) / 0.04)) * (zone.side === 'F' ? 0.5 : 0.25) : zone.side === 'F' ? 0.5 : 0.25
    ctx.lineWidth = 0.7 * u
    ctx.beginPath()
    const span = x1 - x0 + (y1 - y0)
    for (let c = x0 + y0; c <= x0 + y0 + span * frac; c += step * Math.SQRT2) {
      const a = toScreen(v, c - y0, y0)
      const b = toScreen(v, c - y1, y1)
      if (a && b) {
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
      }
    }
    ctx.stroke()
    ctx.restore()
    drawn += 1
  }

  const topSide = s.layers.some((l) => l.side === 'F') ? 'F' : (s.layers[s.layers.length - 1]?.side ?? 'F')
  const hair = 0.9 * u
  for (const layer of s.layers) {
    const front = layer.side === topSide
    const segs = layer.segs
    const wide = new Map<number, Path2D>()
    const thin = new Path2D()
    for (let i = 0; i + 6 < segs.length; i += 7) {
      const t0 = segs[i + 5] as number
      if (t0 > p) break
      const t1 = segs[i + 6] as number
      const k = t1 <= p ? 1 : (p - t0) / Math.max(1e-6, t1 - t0)
      const ax = segs[i] as number
      const ay = segs[i + 1] as number
      const a = toScreen(v, ax, ay)
      const b = toScreen(v, ax + ((segs[i + 2] as number) - ax) * k, ay + ((segs[i + 3] as number) - ay) * k)
      if (!a || !b) continue
      const w = (segs[i + 4] as number) * planScale
      if (front && w > 3.2 * u) {
        const key = Math.round(w * 2) / 2
        let path = wide.get(key)
        if (path === undefined) {
          path = new Path2D()
          wide.set(key, path)
        }
        path.moveTo(a[0], a[1])
        path.lineTo(b[0], b[1])
      } else {
        thin.moveTo(a[0], a[1])
        thin.lineTo(b[0], b[1])
      }
      drawn += 1
    }
    ctx.globalAlpha = front ? 1 : 0.45
    ctx.strokeStyle = front ? ink : pen2
    ctx.lineWidth = front ? hair : 0.7 * u
    ctx.stroke(thin)
    for (const [w, path] of wide) {
      ctx.strokeStyle = ink
      ctx.lineWidth = w
      ctx.stroke(path)
    }
    for (const [w, path] of wide) {
      ctx.strokeStyle = paper
      ctx.lineWidth = Math.max(0, w - 2 * hair)
      ctx.stroke(path)
    }
  }
  ctx.globalAlpha = 1

  ctx.lineWidth = hair
  for (const pad of s.pads) {
    if (p < pad.t) continue
    const k = localAffine(ctx, v, pad.x, pad.y)
    if (k === 0) continue
    const back = pad.side === 'B'
    ctx.translate(pad.x, pad.y)
    ctx.rotate(pad.rot)
    ctx.beginPath()
    if (pad.shape === 'circle') ctx.arc(0, 0, Math.max(pad.w, pad.h) / 2, 0, Math.PI * 2)
    else if (pad.shape === 'round') ctx.roundRect(-pad.w / 2, -pad.h / 2, pad.w, pad.h, Math.min(pad.w, pad.h) * 0.32)
    else ctx.rect(-pad.w / 2, -pad.h / 2, pad.w, pad.h)
    ctx.lineWidth = hair / k
    ctx.strokeStyle = back ? pen2 : ink
    ctx.globalAlpha = back ? 0.5 : 1
    if (!back) {
      ctx.fillStyle = paper
      ctx.fill()
    }
    ctx.stroke()
    drawn += 1
  }
  ctx.globalAlpha = 1
  for (const via of s.vias) {
    if (p < via.t) continue
    const k = localAffine(ctx, v, via.x, via.y)
    if (k === 0) continue
    ctx.lineWidth = hair / k
    ctx.strokeStyle = ink
    ctx.fillStyle = paper
    ctx.beginPath()
    ctx.arc(via.x, via.y, via.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(via.x, via.y, via.r * 0.45, 0, Math.PI * 2)
    ctx.stroke()
    drawn += 1
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (p >= A.power[0]) {
    ctx.strokeStyle = red
    ctx.lineWidth = 1.6 * u
    for (const layer of s.layers) {
      if (layer.side !== topSide) continue
      const path = new Path2D()
      for (let j = 0; j * 7 + 6 < layer.segs.length; j++) {
        const e0 = layer.energy[j * 2] as number
        const e1 = layer.energy[j * 2 + 1] as number
        if (e0 < 0 || p < e0) continue
        const k = clamp01((p - e0) / Math.max(1e-6, e1 - e0))
        const o = j * 7
        const ax = layer.segs[o] as number
        const ay = layer.segs[o + 1] as number
        const a = toScreen(v, ax, ay)
        const b = toScreen(v, ax + ((layer.segs[o + 2] as number) - ax) * k, ay + ((layer.segs[o + 3] as number) - ay) * k)
        if (!a || !b) continue
        path.moveTo(a[0], a[1])
        path.lineTo(b[0], b[1])
        drawn += 1
      }
      ctx.stroke(path)
    }
  }

  ctx.strokeStyle = ink
  ctx.globalAlpha = 0.8
  ctx.lineWidth = 0.8 * u
  for (const stroke of s.silkStrokes) {
    const frac = ease((p - stroke.t) / 0.03)
    if (frac <= 0) continue
    if (frac >= 1) polyPath(ctx, v, stroke.path, 0, false)
    else partialPath(ctx, v, stroke.path, frac)
    ctx.stroke()
    drawn += 1
  }
  ctx.fillStyle = ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const text of s.texts) {
    const k = ease((p - text.t) / 0.025)
    if (k <= 0) continue
    const shown = text.text.substring(0, Math.ceil(text.text.length * k))
    if (shown.length === 0 || localAffine(ctx, v, text.x, text.y) === 0) continue
    ctx.translate(text.x, text.y)
    ctx.rotate(text.rot)
    upright(ctx)
    ctx.font = `${text.size}px ${FONT}`
    ctx.fillText(shown, 0, 0)
    drawn += 1
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1

  const dimFrac = ease((p - A.mask[0]) / Math.max(1e-6, A.mask[1] - A.mask[0]))
  const dimFade = 1 - ease((p - A.silk[0]) / Math.max(1e-6, A.silk[1] - A.silk[0]))
  if (dimFrac > 0 && dimFade > 0) {
    let bx0 = Infinity
    let by0 = Infinity
    let bx1 = -Infinity
    let by1 = -Infinity
    for (const loop of s.board) {
      for (let i = 0; i + 1 < loop.length; i += 2) {
        bx0 = Math.min(bx0, loop[i] as number)
        bx1 = Math.max(bx1, loop[i] as number)
        by0 = Math.min(by0, loop[i + 1] as number)
        by1 = Math.max(by1, loop[i + 1] as number)
      }
    }
    const gap = 5 * m.pxPerMm
    const tick = 2 * m.pxPerMm
    const dims: Array<{ a: Pt; b: Pt; off: Pt; mm: number }> = [
      { a: [bx0, by0], b: [bx1, by0], off: [0, -gap], mm: (bx1 - bx0) / m.pxPerMm },
      { a: [bx0, by0], b: [bx0, by1], off: [-gap, 0], mm: (by1 - by0) / m.pxPerMm }
    ]
    ctx.strokeStyle = ink
    ctx.fillStyle = ink
    ctx.lineWidth = 0.9 * u
    for (const [i, d] of dims.entries()) {
      const k = ease(dimFrac * 1.6 - i * 0.6)
      if (k <= 0) continue
      const [ax, ay] = [d.a[0] + d.off[0], d.a[1] + d.off[1]]
      const [bx, by] = [d.b[0] + d.off[0], d.b[1] + d.off[1]]
      const mx = (ax + bx) / 2
      const my = (ay + by) / 2
      const ex = d.off[0] === 0 ? 0 : tick
      const ey = d.off[1] === 0 ? 0 : tick
      const seg = (x0: number, y0: number, x1: number, y1: number): void => {
        const q0 = toScreen(v, x0, y0)
        const q1 = toScreen(v, x1, y1)
        if (!q0 || !q1) return
        ctx.moveTo(q0[0], q0[1])
        ctx.lineTo(q1[0], q1[1])
      }
      ctx.globalAlpha = k * dimFade
      ctx.beginPath()
      seg(d.a[0] + d.off[0] * 0.2, d.a[1] + d.off[1] * 0.2, ax + ex, ay + ey)
      seg(d.b[0] + d.off[0] * 0.2, d.b[1] + d.off[1] * 0.2, bx + ex, by + ey)
      seg(mx - ((mx - ax) * k), my - ((my - ay) * k), mx + ((bx - mx) * k), my + ((by - my) * k))
      ctx.stroke()
      if (k >= 1) {
        for (const [tx, ty, sx, sy] of [[ax, ay, 1, 1], [bx, by, -1, -1]] as const) {
          const dx = d.off[0] === 0 ? sx * tick : 0
          const dy = d.off[1] === 0 ? sy * tick : 0
          const nx = d.off[0] === 0 ? 0 : tick * 0.3
          const ny = d.off[1] === 0 ? 0 : tick * 0.3
          const tip = toScreen(v, tx, ty)
          const l = toScreen(v, tx + dx + nx, ty + dy + ny)
          const r = toScreen(v, tx + dx - nx, ty + dy - ny)
          if (!tip || !l || !r) continue
          ctx.beginPath()
          ctx.moveTo(tip[0], tip[1])
          ctx.lineTo(l[0], l[1])
          ctx.lineTo(r[0], r[1])
          ctx.closePath()
          ctx.fill()
        }
      }
      const sc = localAffine(ctx, v, mx + d.off[0] * 0.35, my + d.off[1] * 0.35)
      if (sc > 0) {
        ctx.translate(mx + d.off[0] * 0.35, my + d.off[1] * 0.35)
        if (d.off[0] !== 0) ctx.rotate(-Math.PI / 2)
        upright(ctx)
        ctx.font = `${2.6 * m.pxPerMm}px ${FONT}`
        ctx.fillText(`${d.mm.toFixed(1)} mm`, 0, 0)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
      }
    }
    ctx.globalAlpha = 1
  }

  const fallPx = 6 * m.pxPerMm
  const eye = v.cam.pos
  const bodies: Array<{ part: TracePart; at: NonNullable<ReturnType<typeof pose>>; d: number }> = []
  for (const part of s.parts) {
    const at = pose(part, p, tl.durationSeconds, fallPx)
    if (at === undefined) continue
    const d = Math.hypot(at.x - eye[0], -at.y - eye[1], at.lift + part.z / 2 - eye[2])
    bodies.push({ part, at, d })
  }
  bodies.sort((a, b) => b.d - a.d)
  for (const { part, at } of bodies) {
    const cr = Math.cos(at.rot)
    const sr = Math.sin(at.rot)
    const ring = (z: number, n: number, round: boolean): Pt[] => {
      const out: Pt[] = []
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const lx = round ? (Math.cos(a) * part.w) / 2 : (i === 0 || i === 3 ? -0.5 : 0.5) * part.w
        const ly = round ? (Math.sin(a) * part.h) / 2 : (i < 2 ? -0.5 : 0.5) * part.h
        const q = toScreen(v, at.x + lx * cr - ly * sr, at.y + lx * sr + ly * cr, at.lift + z)
        if (q) out.push(q)
      }
      return out
    }
    const round = ROUND.has(part.kind)
    const n = round ? 24 : 4
    const top = ring(part.z, n, round)
    const bot = ring(0, n, round)
    if (top.length < n || bot.length < n) continue
    const lit = part.led !== undefined && p >= A.power[0] + 0.02
    ctx.strokeStyle = part.hero === true || lit ? red : ink
    ctx.lineWidth = (part.hero === true ? 1.6 : 1) * u
    if (round) fillStroke(ctx, hull([...top, ...bot]), paper)
    else {
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4
        const face: Pt[] = [bot[i] as Pt, bot[j] as Pt, top[j] as Pt, top[i] as Pt]
        if (cross2(bot[i] as Pt, bot[j] as Pt, top[j] as Pt) < 0) fillStroke(ctx, face, paper)
      }
    }
    fillStroke(ctx, top, paper)
    if (part.kind === 'conn' && part.pitch !== undefined && part.pitch > 0) {
      const nx = Math.max(1, Math.floor(part.w / part.pitch))
      const ny = Math.max(1, Math.floor(part.h / part.pitch))
      ctx.beginPath()
      for (let ix = 0; ix < nx; ix++) {
        for (let iy = 0; iy < ny; iy++) {
          const lx = (ix + 0.5 - nx / 2) * part.pitch
          const ly = (iy + 0.5 - ny / 2) * part.pitch
          const q = toScreen(v, at.x + lx * cr - ly * sr, at.y + lx * sr + ly * cr, at.lift + part.z)
          if (!q) continue
          const r = 0.9 * u
          ctx.rect(q[0] - r, q[1] - r, 2 * r, 2 * r)
        }
      }
      ctx.fillStyle = ink
      ctx.fill()
    }
    if (part.label !== undefined) {
      const k = localAffine(ctx, v, at.x, at.y, at.lift + part.z)
      if (k > 0) {
        ctx.translate(at.x, at.y)
        ctx.rotate(at.rot + (part.h > part.w ? Math.PI / 2 : 0))
        upright(ctx)
        const len = Math.max(part.w, part.h)
        const size = Math.min(Math.min(part.w, part.h) * 0.2, (len * 0.8) / Math.max(4, part.label.length * 0.62))
        ctx.font = `${size}px ${FONT}`
        ctx.fillStyle = part.hero === true ? red : ink
        ctx.fillText(part.label, 0, 0)
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }
    drawn += 1
  }

  if (scale === 1) drawTitle(ctx, tl, p, 1)
  return drawn
}
