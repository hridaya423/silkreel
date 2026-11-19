import type { Net, NetData } from './nets'

export interface ProbeHit {
  key: string
  title: string
  meta: string
  u: number
  v: number
}

interface Graph {
  x: Float32Array
  y: Float32Array
  ends: Int32Array
  len: Float32Array
  pads: Int32Array
  vias: Int32Array
  adj: Array<Array<[number, number]>>
  draw: Float32Array
  front: number
  padDraw: Float32Array
  viaDraw: Float32Array
}

interface Fire {
  net: number
  t0: number
  released: number
  dist: Float32Array
  far: number
  hit: number
  at: number
}

const SPEED = 1500
const ACCEL = 1100
const HEAD = 130
const FADE = 0.5

const key = (x: number, y: number) => Math.round(x) * 8192 + Math.round(y)

function hull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (src: Array<[number, number]>) => {
    const out: Array<[number, number]> = []
    for (const q of src) {
      while (out.length >= 2 && cross(out[out.length - 2] as [number, number], out[out.length - 1] as [number, number], q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half(p.reverse())]
}

/** the board's nets as light: a net fires from where it is touched and its front runs the copper to every end */
export class Probe {
  readonly canvas = document.createElement('canvas')
  level = 0
  private readonly ctx = this.canvas.getContext('2d')
  private data: NetData | null = null
  private vp = new Float32Array(16)
  private inv = new Float32Array(9)
  private graphs = new Map<number, Graph>()
  private grid = new Map<number, number[]>()
  private padGrid = new Map<number, number[]>()
  private hulls: Array<{ pts: Array<[number, number]>; depth: number; part: number; u: number; v: number }> = []
  private cover = new Path2D()
  private fires: Fire[] = []
  private held = ''
  private quiet = false
  private drawn = false
  private scale = 1

  get ready() { return this.data !== null }
  get busy() { return this.fires.length > 0 }

  load(data: NetData, vp: ArrayLike<number>, wide: number): void {
    this.data = data
    this.vp = Float32Array.from(vp)
    this.graphs = new Map()
    this.fires = []
    this.held = ''
    const m = this.vp
    const a = [m[0] ?? 0, -(m[4] ?? 0), m[12] ?? 0, m[1] ?? 0, -(m[5] ?? 0), m[13] ?? 0, m[3] ?? 0, -(m[7] ?? 0), m[15] ?? 0] as const
    const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
    this.inv = Float32Array.from([
      a[4] * a[8] - a[5] * a[7], a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4],
      a[5] * a[6] - a[3] * a[8], a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5],
      a[3] * a[7] - a[4] * a[6], a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3]
    ].map((v) => v / det))
    this.scale = data.w / 1920
    this.canvas.width = data.w >= data.h ? wide : Math.round((wide * data.w) / data.h)
    this.canvas.height = Math.round((this.canvas.width * data.h) / data.w)
    this.grid = new Map()
    this.padGrid = new Map()
    const put = (g: Map<number, number[]>, x: number, y: number, v: number) => {
      const k = key(Math.floor(x / 32), Math.floor(y / 32))
      const cell = g.get(k)
      if (cell) cell.push(v)
      else g.set(k, [v])
    }
    data.nets.forEach((net, n) => {
      const segs = [...net.f, ...net.b]
      for (let i = 0; i < segs.length; i += 5) {
        const x0 = segs[i] ?? 0
        const y0 = segs[i + 1] ?? 0
        const x1 = segs[i + 2] ?? 0
        const y1 = segs[i + 3] ?? 0
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 24))
        for (let s = 0; s <= steps; s++) put(this.grid, x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, n * 65536 + i / 5)
      }
      for (let i = 0; i < net.pads.length; i += 5) put(this.padGrid, net.pads[i] ?? 0, net.pads[i + 1] ?? 0, n * 65536 + i / 5)
    })
    this.hulls = data.parts.map((p, part) => {
      const [x, y, w, h, rot, z] = p.box
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      const pts: Array<[number, number]> = []
      for (const zz of [0, z]) for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) pts.push(this.over(x + (lx * w * c - ly * h * s) / 2, y + (lx * w * s + ly * h * c) / 2, zz))
      const top = this.clip(x, y, z)
      return { pts: hull(pts), depth: top[2], part, u: top[0], v: top[1] }
    })
    this.cover = new Path2D()
    for (const hl of this.hulls) {
      hl.pts.forEach(([px, py], i) => { if (i === 0) this.cover.moveTo(px, py); else this.cover.lineTo(px, py) })
      this.cover.closePath()
    }
    this.paint(0, true)
  }

  private clip(x: number, y: number, z: number): [number, number, number] {
    const m = this.vp
    const r = (k: number) => (m[k] ?? 0) * x - (m[4 + k] ?? 0) * y + (m[8 + k] ?? 0) * z + (m[12 + k] ?? 0)
    const w = r(3)
    return [(r(0) / w) * 0.5 + 0.5, 0.5 - (r(1) / w) * 0.5, w]
  }

  private over(x: number, y: number, z = 0): [number, number] {
    const [u, v] = this.clip(x, y, z)
    return [u * this.canvas.width, v * this.canvas.height]
  }

  /** the plane point under a film uv */
  plane(u: number, v: number): [number, number] {
    const i = this.inv
    const nx = u * 2 - 1
    const ny = 1 - v * 2
    const w = (i[6] ?? 0) * nx + (i[7] ?? 0) * ny + (i[8] ?? 1)
    return [((i[0] ?? 0) * nx + (i[1] ?? 0) * ny + (i[2] ?? 0)) / w, ((i[3] ?? 0) * nx + (i[4] ?? 0) * ny + (i[5] ?? 0)) / w]
  }

  private graph(n: number): Graph {
    const have = this.graphs.get(n)
    if (have) return have
    const net = this.data?.nets[n] as Net
    const ids = new Map<number, number>()
    const xs: number[] = []
    const ys: number[] = []
    const node = (x: number, y: number) => {
      const k = key(x, y)
      let id = ids.get(k)
      if (id === undefined) { id = xs.length; ids.set(k, id); xs.push(x); ys.push(y) }
      return id
    }
    const segs = [...net.f, ...net.b]
    const count = segs.length / 5
    const ends = new Int32Array(count * 2)
    const len = new Float32Array(count)
    const draw = new Float32Array(count * 5)
    const unit = this.canvas.width / (this.data?.w ?? 1)
    for (let i = 0; i < count; i++) {
      const x0 = segs[i * 5] ?? 0
      const y0 = segs[i * 5 + 1] ?? 0
      const x1 = segs[i * 5 + 2] ?? 0
      const y1 = segs[i * 5 + 3] ?? 0
      ends[i * 2] = node(x0, y0)
      ends[i * 2 + 1] = node(x1, y1)
      len[i] = Math.hypot(x1 - x0, y1 - y0)
      const a = this.over(x0, y0)
      const b = this.over(x1, y1)
      const mx = (x0 + x1) / 2
      const my = (y0 + y1) / 2
      const p = this.over(mx, my)
      const q = this.over(mx + 1, my)
      const r = this.over(mx, my + 1)
      const local = Math.min(Math.hypot(q[0] - p[0], q[1] - p[1]), Math.hypot(r[0] - p[0], r[1] - p[1]))
      draw.set([a[0], a[1], b[0], b[1], Math.max(1.4 * unit * 1.5, (segs[i * 5 + 4] ?? 1) * local * 1.15)], i * 5)
    }
    const routed = xs.length
    const pads = new Int32Array(net.pads.length / 5)
    const padDraw = new Float32Array(pads.length * 8)
    const links: Array<[number, number, number]> = []
    for (let i = 0; i < pads.length; i++) {
      const [x, y, w, h, rot] = [net.pads[i * 5] ?? 0, net.pads[i * 5 + 1] ?? 0, net.pads[i * 5 + 2] ?? 0, net.pads[i * 5 + 3] ?? 0, net.pads[i * 5 + 4] ?? 0]
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      const id = node(x, y)
      pads[i] = id
      for (let j = 0; j < routed; j++) {
        const dx = (xs[j] ?? 0) - x
        const dy = (ys[j] ?? 0) - y
        if (j !== id && Math.abs(dx * c + dy * s) <= w / 2 + 1.5 && Math.abs(dy * c - dx * s) <= h / 2 + 1.5) links.push([id, j, Math.hypot(dx, dy)])
      }
      ;([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).forEach(([lx, ly], k) => { padDraw.set(this.over(x + (lx * w * c - ly * h * s) / 2, y + (lx * w * s + ly * h * c) / 2), i * 8 + k * 2) })
    }
    const vias = new Int32Array(net.vias.length / 3)
    const viaDraw = new Float32Array(vias.length * 3)
    for (let i = 0; i < vias.length; i++) {
      const [x, y, r] = [net.vias[i * 3] ?? 0, net.vias[i * 3 + 1] ?? 0, net.vias[i * 3 + 2] ?? 1]
      const id = node(x, y)
      vias[i] = id
      for (let j = 0; j < routed; j++) {
        const d = Math.hypot((xs[j] ?? 0) - x, (ys[j] ?? 0) - y)
        if (j !== id && d <= r + 1.5) links.push([id, j, d])
      }
      const p = this.over(x, y)
      const q = this.over(x + r, y)
      viaDraw.set([p[0], p[1], Math.max(1.5, Math.hypot(q[0] - p[0], q[1] - p[1]))], i * 3)
    }
    const adj: Array<Array<[number, number]>> = xs.map(() => [])
    for (let i = 0; i < count; i++) {
      const a = ends[i * 2] ?? 0
      const b = ends[i * 2 + 1] ?? 0
      adj[a]?.push([b, len[i] ?? 0])
      adj[b]?.push([a, len[i] ?? 0])
    }
    for (const [a, b, d] of links) { adj[a]?.push([b, d]); adj[b]?.push([a, d]) }
    const g: Graph = { x: Float32Array.from(xs), y: Float32Array.from(ys), ends, len, pads, vias, adj, draw, front: net.f.length / 5, padDraw, viaDraw }
    this.graphs.set(n, g)
    return g
  }

  private start(n: number, now: number, seeds: Array<[number, number]>, from: [number, number], hit = -1, at = 0): void {
    const g = this.graph(n)
    const dist = new Float32Array(g.x.length).fill(Infinity)
    const queue: number[] = []
    for (const [id, d] of seeds) { if (d < (dist[id] ?? 0)) { dist[id] = d; queue.push(id) } }
    for (let q = 0; q < queue.length; q++) {
      const a = queue[q] ?? 0
      const da = dist[a] ?? 0
      for (const [b, d] of g.adj[a] ?? []) if (da + d < (dist[b] ?? 0) - 0.01) { dist[b] = da + d; queue.push(b) }
    }
    let far = 0
    for (let i = 0; i < dist.length; i++) {
      if (!Number.isFinite(dist[i] ?? 0)) dist[i] = Math.hypot((g.x[i] ?? 0) - from[0], (g.y[i] ?? 0) - from[1]) * 1.2
      far = Math.max(far, dist[i] ?? 0)
    }
    this.fires = this.fires.filter((f) => f.net !== n)
    this.fires.push({ net: n, t0: now, released: -1, dist, far, hit, at })
  }

  private nearest(g: Graph, x: number, y: number): number {
    let best = 0
    let d = Infinity
    for (let i = 0; i < g.x.length; i++) {
      const k = Math.hypot((g.x[i] ?? 0) - x, (g.y[i] ?? 0) - y)
      if (k < d) { d = k; best = i }
    }
    return best
  }

  private fireNet(n: number, now: number, x: number, y: number, seg: number): void {
    const g = this.graph(n)
    if (seg < 0) { this.start(n, now, [[this.nearest(g, x, y), 0]], [x, y]); return }
    const a = g.ends[seg * 2] ?? 0
    const b = g.ends[seg * 2 + 1] ?? 0
    const ax = g.x[a] ?? 0
    const ay = g.y[a] ?? 0
    const l = g.len[seg] ?? 1
    const h = Math.min(1, Math.max(0, ((x - ax) * ((g.x[b] ?? 0) - ax) + (y - ay) * ((g.y[b] ?? 0) - ay)) / Math.max(1e-6, l * l)))
    this.start(n, now, [[a, h * l], [b, (1 - h) * l]], [x, y], seg, h)
  }

  private firePart(part: number, now: number): void {
    const p = this.data?.parts[part]
    if (!p) return
    const [x, y] = p.box
    const rails = (n: number) => (this.data?.nets[n]?.pads.length ?? 0) / 5 > 24
    const signal = p.nets.some((n) => !rails(n))
    for (const n of p.nets) {
      if (signal && rails(n)) continue
      const g = this.graph(n)
      let seed = -1
      let d = Infinity
      for (let i = 0; i < g.pads.length; i++) {
        const id = g.pads[i] ?? 0
        const k = Math.hypot((g.x[id] ?? 0) - x, (g.y[id] ?? 0) - y)
        if (k < d) { d = k; seed = id }
      }
      this.start(n, now, [[seed < 0 ? this.nearest(g, x, y) : seed, 0]], [x, y])
    }
  }

  private release(now: number): void {
    for (const f of this.fires) if (f.released < 0) f.released = now
    this.held = ''
  }

  private label(n: number): { title: string; meta: string } {
    const net = this.data?.nets[n] as Net
    const vias = net.vias.length / 3
    return { title: net.name.replace(/^\//, '') || 'unnamed net', meta: `${net.mm.toFixed(1)} mm${vias ? `  ·  ${String(vias)} ${vias === 1 ? 'via' : 'vias'}` : ''}` }
  }

  /** the pointer rests on a film uv: the copper or the part under it fires and holds */
  point(u: number, v: number, reach: number, lit: boolean, now: number): ProbeHit | null {
    const data = this.data
    if (!data) return null
    if (lit) {
      const px = u * this.canvas.width
      const py = v * this.canvas.height
      let top: (typeof this.hulls)[number] | undefined
      for (const hl of this.hulls) {
        if (top && hl.depth >= top.depth) continue
        let inside = hl.pts.length > 2
        for (let i = 0; i < hl.pts.length && inside; i++) {
          const a = hl.pts[i] as [number, number]
          const b = hl.pts[(i + 1) % hl.pts.length] as [number, number]
          if ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]) < 0) inside = false
        }
        if (inside) top = hl
      }
      if (top) {
        const part = data.parts[top.part]
        const id = `p${String(top.part)}`
        if (!part) return null
        if (this.held !== id) { this.release(now); this.firePart(top.part, now); this.held = id; this.quiet = false }
        return { key: id, title: `${part.ref} ${part.value}`.trim(), meta: `${String(part.nets.length)} ${part.nets.length === 1 ? 'net' : 'nets'}`, u: top.u, v: top.v }
      }
    }
    const [x, y] = this.plane(u, v)
    const [x2, y2] = this.plane(u + reach, v)
    const r = Math.max(3, Math.hypot(x2 - x, y2 - y))
    let best = -1
    let seg = -1
    let d = r
    const cx = Math.floor(x / 32)
    const cy = Math.floor(y / 32)
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (const e of this.padGrid.get(key(gx, gy)) ?? []) {
        const n = Math.floor(e / 65536)
        const i = (e % 65536) * 5
        const pads = data.nets[n]?.pads ?? []
        const dx = x - (pads[i] ?? 0)
        const dy = y - (pads[i + 1] ?? 0)
        const c = Math.cos(pads[i + 4] ?? 0)
        const s = Math.sin(pads[i + 4] ?? 0)
        const k = Math.max(Math.abs(dx * c + dy * s) - (pads[i + 2] ?? 0) / 2, Math.abs(dy * c - dx * s) - (pads[i + 3] ?? 0) / 2, 0) * 0.6
        if (k < d) { d = k; best = n; seg = -1 }
      }
      for (const e of this.grid.get(key(gx, gy)) ?? []) {
        const n = Math.floor(e / 65536)
        const net = data.nets[n]
        if (!net) continue
        const j = e % 65536
        const front = j < net.f.length / 5
        if (lit && !front) continue
        const segs = front ? net.f : net.b
        const i = (front ? j : j - net.f.length / 5) * 5
        const ax = segs[i] ?? 0
        const ay = segs[i + 1] ?? 0
        const bx = (segs[i + 2] ?? 0) - ax
        const by = (segs[i + 3] ?? 0) - ay
        const t = Math.min(1, Math.max(0, ((x - ax) * bx + (y - ay) * by) / Math.max(1e-6, bx * bx + by * by)))
        const k = Math.max(0, Math.hypot(x - ax - bx * t, y - ay - by * t) - (segs[i + 4] ?? 1) / 2) * (front ? 1 : 1.6)
        if (k < d) { d = k; best = n; seg = j }
      }
    }
    if (best < 0) { if (this.held) this.release(now); return null }
    const id = `n${String(best)}`
    if (this.held !== id) { this.release(now); this.fireNet(best, now, x, y, seg); this.held = id; this.quiet = false }
    return { key: id, ...this.label(best), u, v }
  }

  leave(now: number): void { this.release(now) }

  /** one part wakes by itself: its nets run out from its pins and fade; a negative pick wakes the part with the most nets */
  pulse(now: number, pick: number, seen: (u: number, v: number) => boolean): ProbeHit | null {
    const data = this.data
    if (!data) return null
    const count = (hl: { part: number }) => data.parts[hl.part]?.nets.length ?? 0
    const rail = (n: number) => (data.nets[n]?.pads.length ?? 0) / 5 > 24
    const copper = (hl: { part: number }) => (data.parts[hl.part]?.nets ?? []).reduce((mm, n) => mm + (rail(n) ? 0 : data.nets[n]?.mm ?? 0), 0)
    const able = this.hulls.filter((hl) => count(hl) >= 3 && copper(hl) >= 40 && seen(hl.u, hl.v))
    const hl = pick < 0 ? [...able].sort((a, b) => count(b) - count(a))[0] : able[Math.floor(pick * able.length) % Math.max(1, able.length)]
    const part = hl && data.parts[hl.part]
    if (!hl || !part) return null
    this.release(now)
    this.firePart(hl.part, now)
    this.quiet = true
    const [u, v] = this.clip(part.box[0], part.box[1], 0)
    return { key: `p${String(hl.part)}`, title: `${part.ref} ${part.value}`.trim(), meta: `${String(part.nets.length)} nets`, u, v }
  }

  private paint(now: number, instant: boolean): void {
    const ctx = this.ctx
    if (!ctx) return
    const { width: W, height: H } = this.canvas
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    const k = this.scale
    for (const f of this.fires) {
      const g = this.graph(f.net)
      const tau = Math.max(0, now - f.t0)
      const reach = instant ? Infinity : (SPEED * tau + ACCEL * tau * tau) * k
      const gain = f.released < 0 ? 1 : Math.exp(-(now - f.released) / FADE)
      const glow = (behind: number) => (0.62 + 0.38 * Math.exp(-Math.max(0, behind) / (HEAD * k))) * gain
      const count = g.len.length
      for (let i = 0; i < count; i++) {
        const l = Math.max(1e-3, g.len[i] ?? 0)
        const d0 = f.dist[g.ends[i * 2] ?? 0] ?? 0
        const d1 = f.dist[g.ends[i * 2 + 1] ?? 0] ?? 0
        let a = 0
        let b = 0
        let c = 1
        let d = 1
        if (i === f.hit) {
          a = Math.max(0, f.at - reach / l)
          b = Math.min(1, f.at + reach / l)
          c = d = 1
        } else {
          b = Math.min(1, Math.max(0, (reach - d0) / l))
          c = 1 - Math.min(1, Math.max(0, (reach - d1) / l))
          if (b >= c) { b = 1; c = d = 1 }
        }
        if (b <= a && d <= c) continue
        const x0 = g.draw[i * 5] ?? 0
        const y0 = g.draw[i * 5 + 1] ?? 0
        const dx = (g.draw[i * 5 + 2] ?? 0) - x0
        const dy = (g.draw[i * 5 + 3] ?? 0) - y0
        ctx.globalAlpha = Math.min(1, glow(reach - Math.min(d0, d1) - l * 0.5))
        ctx.strokeStyle = i < g.front ? '#ffff00' : '#5a0000'
        ctx.lineWidth = g.draw[i * 5 + 4] ?? 1.5
        ctx.beginPath()
        if (b > a) { ctx.moveTo(x0 + dx * a, y0 + dy * a); ctx.lineTo(x0 + dx * b, y0 + dy * b) }
        if (d > c) { ctx.moveTo(x0 + dx * c, y0 + dy * c); ctx.lineTo(x0 + dx * d, y0 + dy * d) }
        ctx.stroke()
      }
      ctx.fillStyle = '#ffff00'
      const crowd = 1 / (1 + g.pads.length / 60)
      for (let i = 0; i < g.pads.length; i++) {
        const behind = reach - (f.dist[g.pads[i] ?? 0] ?? 0)
        if (behind < 0) continue
        ctx.globalAlpha = Math.min(1, glow(behind) * (0.35 + 0.65 * crowd))
        ctx.beginPath()
        for (let c = 0; c < 4; c++) { const px = g.padDraw[i * 8 + c * 2] ?? 0; const py = g.padDraw[i * 8 + c * 2 + 1] ?? 0; if (c === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py) }
        ctx.fill()
      }
      for (let i = 0; i < g.vias.length; i++) {
        const behind = reach - (f.dist[g.vias[i] ?? 0] ?? 0)
        if (behind < 0) continue
        ctx.globalAlpha = Math.min(1, glow(behind))
        ctx.beginPath()
        ctx.arc(g.viaDraw[i * 3] ?? 0, g.viaDraw[i * 3 + 1] ?? 0, g.viaDraw[i * 3 + 2] ?? 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = '#ff00ff'
    ctx.fill(this.cover)
  }

  /** advances the light; true when the overlay changed and wants uploading */
  frame(now: number, dt: number, instant: boolean): boolean {
    const want = this.fires.some((f) => f.released < 0) ? (this.quiet ? 0.5 : 1) : 0
    this.level += (want - this.level) * Math.min(1, dt * (want ? 9 : 2.6))
    if (!this.data) return false
    const k = this.scale
    this.fires = this.fires.filter((f) => f.released < 0 || now - f.released < FADE * 5)
    const moving = this.fires.some((f) => {
      const tau = now - f.t0
      return f.released >= 0 || (!instant && (SPEED * tau + ACCEL * tau * tau) * k < f.far + HEAD * k * 5)
    })
    if (!this.fires.length) {
      if (!this.drawn) return false
      this.drawn = false
      this.paint(now, instant)
      return true
    }
    if (!moving && this.drawn && this.settled === this.fires.length) return false
    this.settled = moving ? -1 : this.fires.length
    this.drawn = true
    this.paint(now, instant)
    return true
  }

  private settled = -1
}
