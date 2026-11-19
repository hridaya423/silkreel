import type { CameraShot, TraceLight } from '../types'

/**
 * The trace camera. The board lies in its zoom-1 frame px (y down) at z = 0;
 * world is x right, y up (= −plane y), z toward the viewer. Shared by the
 * score (to frame shots exactly) and the renderer (to draw them).
 */
export type V3 = [number, number, number]

const FOV = (30 * Math.PI) / 180

export interface Cam {
  pos: V3
  f: V3
  r: V3
  u: V3
  dist: number
  tanX: number
  tanY: number
  /** column-major view-projection */
  vp: Float32Array
  aperture: number
  /** vertical lens shift, NDC */
  shift: number
  /** depth along the lens axis that is held sharp */
  focus: number
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

const SHOT_KEYS = ['x', 'y', 'zoom', 'tilt', 'yaw', 'aperture', 'shift', 'fov', 'roll', 'fx', 'fy'] as const
type ShotKey = (typeof SHOT_KEYS)[number]

const val = (s: CameraShot, key: ShotKey): number => {
  switch (key) {
    case 'zoom': return Math.log(Math.max(1e-6, s.zoom))
    case 'shift': return s.shift ?? 0
    case 'fov': return s.fov ?? FOV
    case 'roll': return s.roll ?? 0
    case 'fx': return s.focus?.x ?? s.x
    case 'fy': return s.focus?.y ?? s.y
    default: return s[key]
  }
}

const RAMP = 1 / 6
const RISE = 0.7
const RISE_V = 1 / (1 - RISE / 2)
const shape = (ease: CameraShot['ease'], u: number): number => {
  if (ease === 'out') return 1 - (1 - u) ** 3
  if (ease === 'inout') return u * u * u * (u * (6 * u - 15) + 10)
  if (ease === 'rise') return u < RISE ? (RISE_V * u * u) / (2 * RISE) : RISE_V * (u - RISE / 2)
  if (ease === 'land') {
    const v = 1 / (1 - RAMP)
    if (u < RAMP) return (v * u * u) / (2 * RAMP)
    if (u > 1 - RAMP) return 1 - (v * (1 - u) ** 2) / (2 * RAMP)
    return v * (u - RAMP / 2)
  }
  return u
}

/**
 * Monotone cubic through the shot keys: the camera glides through a key when
 * the move continues and settles on it when the move turns around. A key
 * marked `cut` is a hard cut: the previous shot holds its last key until the
 * cut, and no curve is drawn across it. A key with an `ease` runs the move
 * that leaves it on that curve instead (constant speed, decelerating, or starting and settling);
 * its focus still pulls with a smooth start and stop.
 */
export function sampleShot(shots: CameraShot[], p: number): Omit<CameraShot, 't' | 'cut' | 'ease' | 'light'> & { fov: number; roll: number; focus: { x: number; y: number } } {
  const out: Record<ShotKey, number> = { x: 0, y: 0, zoom: 1, tilt: 0, yaw: 0, aperture: 0, shift: 0, fov: FOV, roll: 0, fx: 0, fy: 0 }
  const done = (): ReturnType<typeof sampleShot> => {
    const { fx, fy, ...rest } = out
    return { ...rest, focus: { x: fx, y: fy } }
  }
  if (shots.length === 0) return done()
  let k = 0
  while (k + 1 < shots.length && (shots[k + 1] as CameraShot).t <= p) k++
  const a = shots[k] as CameraShot
  const nb = shots[k + 1]
  const b = nb === undefined || nb.cut === true ? a : nb
  const h = b.t - a.t
  const u = h > 0 ? Math.min(1, Math.max(0, (p - a.t) / h)) : 0
  if (a.ease !== undefined) {
    const e = shape(a.ease, u)
    const pull = a.ease === 'rise' ? e : u * u * (3 - 2 * u)
    const turn = a.ease === 'inout' ? shape('inout', Math.min(1, u / 0.6)) : e
    for (const key of SHOT_KEYS) {
      const v = val(a, key) + (val(b, key) - val(a, key)) * (key === 'fx' || key === 'fy' ? pull : key === 'yaw' ? turn : e)
      out[key] = key === 'zoom' ? Math.exp(v) : v
    }
    return done()
  }
  for (const key of SHOT_KEYS) {
    const slope = (i: number): number => {
      const cur = shots[i]
      const prev = shots[i - 1]
      const next = shots[i + 1]
      // a cut or an eased move on either side makes this key an end of its curve: it settles
      if (cur !== undefined && prev?.ease === 'rise' && cur.ease === undefined && cur.cut !== true) return (RISE_V * (val(cur, key) - val(prev, key))) / Math.max(1e-6, cur.t - prev.t)
      if (cur !== undefined && prev?.ease === 'linear' && cur.ease === undefined && cur.cut !== true && next?.cut !== true) return (val(cur, key) - val(prev, key)) / Math.max(1e-6, cur.t - prev.t)
      if (cur === undefined || prev === undefined || next === undefined || cur.cut === true || next.cut === true || prev.ease !== undefined || cur.ease !== undefined) return 0
      const d0 = (val(cur, key) - val(prev, key)) / Math.max(1e-6, cur.t - prev.t)
      const d1 = (val(next, key) - val(cur, key)) / Math.max(1e-6, next.t - cur.t)
      return d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1)
    }
    const m0 = b === a ? 0 : slope(k) * h
    const m1 = b === a ? 0 : slope(k + 1) * h
    const u2 = u * u
    const u3 = u2 * u
    const v = (2 * u3 - 3 * u2 + 1) * val(a, key) + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * val(b, key) + (u3 - u2) * m1
    out[key] = key === 'zoom' ? Math.exp(v) : v
  }
  return done()
}

/** the light state at phase p: the last one named at or before it */
export function lightAt(shots: CameraShot[], p: number): TraceLight | undefined {
  let light: TraceLight | undefined
  for (const k of shots) {
    if (k.t > p) break
    if (k.light !== undefined) light = k.light
  }
  return light
}

export function makeCam(shot: Omit<CameraShot, 't' | 'cut'>, W: number, H: number): Cam {
  const tanY = Math.tan((shot.fov ?? FOV) / 2)
  const tanX = tanY * (W / H)
  const dist = H / 2 / tanY / Math.max(0.05, shot.zoom)
  const T: V3 = [shot.x, -shot.y, 0]
  const st = Math.sin(shot.tilt)
  const pos: V3 = [T[0] + dist * st * Math.sin(shot.yaw), T[1] - dist * st * Math.cos(shot.yaw), dist * Math.cos(shot.tilt)]
  const f = norm(sub(T, pos))
  const r0: V3 = [Math.cos(shot.yaw), Math.sin(shot.yaw), 0]
  const u0 = norm(cross(r0, f))
  const cr = Math.cos(shot.roll ?? 0)
  const sr = Math.sin(shot.roll ?? 0)
  const r: V3 = [r0[0] * cr + u0[0] * sr, r0[1] * cr + u0[1] * sr, r0[2] * cr + u0[2] * sr]
  const u: V3 = [u0[0] * cr - r0[0] * sr, u0[1] * cr - r0[1] * sr, u0[2] * cr - r0[2] * sr]
  const near = dist * 0.02
  const far = dist * 20
  const view = [
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -dot(r, pos), -dot(u, pos), dot(f, pos), 1
  ]
  const py = 1 / tanY
  const px = 1 / tanX
  const shift = shot.shift ?? 0
  const proj = [px, 0, 0, 0, 0, py, 0, 0, 0, -shift, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]
  const vp = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let rr = 0; rr < 4; rr++) {
      let s = 0
      for (let i = 0; i < 4; i++) s += (proj[i * 4 + rr] as number) * (view[c * 4 + i] as number)
      vp[c * 4 + rr] = s
    }
  }
  const focus = shot.focus === undefined ? dist : Math.max(near, dot(sub([shot.focus.x, -shot.focus.y, 0], pos), f))
  return { pos, f, r, u, dist, tanX, tanY, vp, aperture: shot.aperture, shift, focus }
}

/** NDC of a plane point (px, y down) at height z; w ≤ 0 means behind the camera */
export function project(cam: Cam, x: number, y: number, z = 0): { x: number; y: number; w: number } {
  const m = cam.vp
  const px = 0 + (m[0] as number) * x + (m[4] as number) * -y + (m[8] as number) * z + (m[12] as number) * 1
  const py = 0 + (m[1] as number) * x + (m[5] as number) * -y + (m[9] as number) * z + (m[13] as number) * 1
  const w = 0 + (m[3] as number) * x + (m[7] as number) * -y + (m[11] as number) * z + (m[15] as number) * 1
  return { x: px / w, y: py / w, w }
}

/**
 * The zoom that fits these points inside an NDC box (±mx, ±my), centred on
 * the shot's look-at point: the largest zoom where every point projects in.
 */
export function fitZoom(
  shot: Omit<CameraShot, 't' | 'cut' | 'zoom'>,
  pts: Array<[number, number, number]>,
  W: number,
  H: number,
  mx: number,
  my: number,
  lo = 0.2,
  hi = 6
): number {
  const fits = (z: number): boolean => {
    const cam = makeCam({ ...shot, zoom: z }, W, H)
    return pts.every(([x, y, zz]) => {
      const q = project(cam, x, y, zz)
      return q.w > 0 && Math.abs(q.x) <= mx && Math.abs(q.y - (shot.shift ?? 0)) <= my
    })
  }
  if (!fits(lo)) return lo
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * The look-at point that centres these points in frame at this zoom.
 * Perspective pushes a tilted board low and off to one side, so centring the
 * board's middle does not centre its picture; a few Newton steps on the
 * projected bounds' centre do. `aim` puts that centre off the middle (NDC x).
 */
export function centreOn(
  shot: Omit<CameraShot, 't' | 'cut'>,
  pts: Array<[number, number, number]>,
  W: number,
  H: number,
  aim = 0,
  aimY = 0
): { x: number; y: number } {
  const mid = (x: number, y: number): [number, number] => {
    const cam = makeCam({ ...shot, x, y }, W, H)
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const [px, py, pz] of pts) {
      const q = project(cam, px, py, pz)
      x0 = Math.min(x0, q.x)
      x1 = Math.max(x1, q.x)
      y0 = Math.min(y0, q.y)
      y1 = Math.max(y1, q.y)
    }
    return [(x0 + x1) / 2 - aim, (y0 + y1) / 2 - (shot.shift ?? 0) - aimY]
  }
  let { x, y } = shot
  const h = 0.01 * Math.min(W, H)
  for (let i = 0; i < 4; i++) {
    const [cx, cy] = mid(x, y)
    const [ax, ay] = mid(x + h, y)
    const [bx, by] = mid(x, y + h)
    const j00 = (ax - cx) / h
    const j10 = (ay - cy) / h
    const j01 = (bx - cx) / h
    const j11 = (by - cy) / h
    const det = j00 * j11 - j01 * j10
    if (Math.abs(det) < 1e-12) break
    x -= (j11 * cx - j01 * cy) / det
    y -= (-j10 * cx + j00 * cy) / det
  }
  return { x, y }
}

/** a body as a box on the plane: centre, footprint (px, y down), rotation and height */
export interface Body {
  x: number
  y: number
  w: number
  h: number
  rot: number
  z: number
  /** how high its underside is above the board (a part mid-fall); 0 when absent */
  base?: number
  /** the triangles the renderer draws for it, in plane px (x, y down, height; nine numbers a triangle), when it wears a mesh */
  drawn?: Float32Array | undefined
}

const cornerCache = new WeakMap<Body, { of: number[]; at: Array<[number, number, number]> }>()
export const corners = (b: Body): Array<[number, number, number]> => {
  const of = [b.x, b.y, b.w, b.h, b.rot, b.z, b.base ?? 0]
  const hit = cornerCache.get(b)
  if (hit !== undefined && hit.of.every((v, i) => v === of[i])) return hit.at
  const at = boxCorners(b)
  cornerCache.set(b, { of, at })
  return at
}
const boxCorners = (b: Body): Array<[number, number, number]> => {
  const c = Math.cos(b.rot)
  const s = Math.sin(b.rot)
  return [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [b.base ?? 0, (b.base ?? 0) + b.z].map((z): [number, number, number] => {
    const lx = (sx * b.w) / 2
    const ly = (sy * b.h) / 2
    return [b.x + c * lx - s * ly, b.y + s * lx + c * ly, z]
  })))
}

const hull = (pts: Array<[number, number]>): Array<[number, number]> => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross2 = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: Array<[number, number]>): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    for (const q of list) {
      while (out.length >= 2 && cross2(out[out.length - 2] as [number, number], out[out.length - 1] as [number, number], q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half([...p].reverse())]
}

const hullArea = (pts: Array<[number, number]>): number => {
  let poly = hull(pts)
  for (const [axis, lim, keep] of [[0, -1, 1], [0, 1, -1], [1, -1, 1], [1, 1, -1]] as const) {
    const out: Array<[number, number]> = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as [number, number]
      const b = poly[(i + 1) % poly.length] as [number, number]
      const ina = (a[axis] - lim) * keep >= 0
      const inb = (b[axis] - lim) * keep >= 0
      if (ina) out.push(a)
      if (ina !== inb) {
        const t = (lim - a[axis]) / (b[axis] - a[axis])
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
    poly = out
  }
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as [number, number]
    const b = poly[(i + 1) % poly.length] as [number, number]
    area += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(area) / 2
}

/** the share of the frame a body's box covers, clipped to the frame; 1 when it reaches behind the lens */
export function screenShare(cam: Cam, b: Body): number {
  const qs = corners(b).map(([x, y, z]) => project(cam, x, y, z))
  return qs.some((q) => q.w <= 0) ? 1 : hullArea(qs.map((q): [number, number] => [q.x, q.y])) / 4
}

/** whether any body nearer the lens than the hero and about as tall has a screen outline that overlaps the hero's */
export function heroCrossed(cam: Cam, hero: Body, bodies: Body[]): boolean {
  const outline = (b: Body): Array<[number, number]> | undefined => {
    const qs = corners(b).map(([x, y, z]) => project(cam, x, y, z))
    return qs.some((q) => q.w <= 0) ? undefined : hull(qs.map((q): [number, number] => [q.x, q.y]))
  }
  const own = outline(hero)
  if (own === undefined) return true
  const depth = (b: Body): number => dot(sub([b.x, -b.y, (b.base ?? 0) + b.z / 2], cam.pos), cam.f)
  const heroDepth = depth(hero)
  const apart = (a: Array<[number, number]>, b: Array<[number, number]>): boolean => [a, b].some((poly) => poly.some((p, i) => {
    const q = poly[(i + 1) % poly.length] as [number, number]
    const n: [number, number] = [q[1] - p[1], p[0] - q[0]]
    const along = (r: [number, number]): number => n[0] * r[0] + n[1] * r[1]
    return Math.max(...a.map(along)) < Math.min(...b.map(along)) || Math.max(...b.map(along)) < Math.min(...a.map(along))
  }))
  return bodies.some((b) => {
    if (depth(b) >= heroDepth || (b.base ?? 0) + b.z < 0.9 * hero.z) return false
    const o = outline(b)
    return o === undefined || !apart(own, o)
  })
}

/** how far the hero's own pads reach, as a multiple of its box (at least 1.05) */
export function pinReach(hero: Body, pads: Array<Omit<Body, 'z'>>): number {
  const c = Math.cos(hero.rot)
  const s = Math.sin(hero.rot)
  let r = 1.05
  for (const p of pads) {
    const half = Math.max(p.w, p.h) / 2
    const lx = Math.abs(c * (p.x - hero.x) + s * (p.y - hero.y)) + half
    const ly = Math.abs(-s * (p.x - hero.x) + c * (p.y - hero.y)) + half
    r = Math.max(r, (2 * lx) / hero.w, (2 * ly) / hero.h)
  }
  return r
}

/** how far along d (world) the ray from pos first enters a body's box, as a multiple of d; Infinity when it misses */
function meet(pos: V3, d: V3, b: Body): number {
  const cos = Math.cos(b.rot)
  const sin = Math.sin(b.rot)
  const ox = pos[0] - b.x
  const oy = -pos[1] - b.y
  const base = b.base ?? 0
  let t0 = 0
  let t1 = Infinity
  for (let a = 0; a < 3; a++) {
    const oo = a === 0 ? cos * ox + sin * oy : a === 1 ? -sin * ox + cos * oy : pos[2]
    const vv = a === 0 ? cos * d[0] - sin * d[1] : a === 1 ? -sin * d[0] - cos * d[1] : d[2]
    const lo = a === 0 ? -b.w / 2 : a === 1 ? -b.h / 2 : base
    const hi = a === 0 ? b.w / 2 : a === 1 ? b.h / 2 : base + b.z
    if (Math.abs(vv) < 1e-12) {
      if (oo < lo || oo > hi) return Infinity
      continue
    }
    const ta = (lo - oo) / vv
    const tb = (hi - oo) / vv
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
    if (t0 > t1) return Infinity
  }
  return t0
}

/** the largest share of the frame that one body nearer the lens than `depth` (along its axis) is the first sight of, on a grid of rays `n` across */
/** the share of the frame (or of the band of it between these two heights, -1 at the bottom to 1 at the top) covered by the screen outlines of the bodies whose centre stands nearer the lens than this depth */
export function nearShare(cam: Cam, W: number, H: number, bodies: Body[], depth: number, n = 40, band: [number, number] = [-1, 1]): number {
  const outlines = bodies.filter((b) => dot(sub([b.x, -b.y, (b.base ?? 0) + b.z / 2], cam.pos), cam.f) < depth).flatMap((b) => {
    const qs = corners(b).map(([x, y, z]) => project(cam, x, y, z))
    return qs.some((q) => q.w <= 0) ? [] : [hull(qs.map((q): [number, number] => [q.x, q.y]))]
  })
  const inside = (P: Array<[number, number]>, x: number, y: number): boolean => {
    let c = false
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, yi] = P[i] as [number, number]
      const [xj, yj] = P[j] as [number, number]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
    }
    return c
  }
  const m = Math.max(1, Math.round((n * H * (band[1] - band[0])) / 2 / W))
  let hit = 0
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) if (outlines.some((P) => inside(P, (2 * (i + 0.5)) / n - 1, band[0] + ((band[1] - band[0]) * (j + 0.5)) / m))) hit++
  return hit / (n * m)
}

export function nearCover(cam: Cam, W: number, H: number, bodies: Body[], depth: number, n = 24): number {
  let widest = 0
  for (const b of bodies) widest = Math.max(widest, b.w, b.h)
  const reach = depth + widest
  const [px, py, pz] = cam.pos
  const [fx, fy, fz] = cam.f
  const [rx, ry, rz] = cam.r
  const [ux, uy, uz] = cam.u
  const sides = [[1, 0, -cam.tanX], [-1, 0, -cam.tanX], [0, 1, -(1 - cam.shift) * cam.tanY], [0, -1, -(1 + cam.shift) * cam.tanY]].map(([a, b, c]) => [a, b, c, Math.hypot(a as number, b as number, c as number)] as [number, number, number, number])
  const near = bodies.filter((b) => {
    const cx = b.x - px
    const cy = -b.y - py
    const cz = (b.base ?? 0) + b.z / 2 - pz
    const k = cx * fx + cy * fy + cz * fz
    if (!(k > -Math.max(b.w, b.h, b.z) && k < reach)) return false
    const R = Math.hypot(b.w, b.h, b.z) / 2 + 1e-4 * Math.abs(k) + 1e-6
    if (k - R <= 0) return true
    const X = cx * rx + cy * ry + cz * rz
    const Y = cx * ux + cy * uy + cz * uz
    return sides.every(([a, bb, c, l]) => (a * X + bb * Y + c * k) / l <= R)
  })
  const m = Math.max(1, Math.round((n * H) / W))
  const hits = new Array<number>(near.length).fill(0)
  const spans = near.map((b) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y, z] of corners(b)) {
      const q = project(cam, x, y, z)
      if (q.w <= 0) return [-Infinity, -Infinity, Infinity, Infinity]
      x0 = Math.min(x0, q.x)
      y0 = Math.min(y0, q.y)
      x1 = Math.max(x1, q.x)
      y1 = Math.max(y1, q.y)
    }
    return [x0, y0, x1, y1]
  })
  const nearest = near.map((b) => (b.x - px) * fx + (-b.y - py) * fy + ((b.base ?? 0) + b.z / 2 - pz) * fz - Math.hypot(b.w, b.h, b.z) / 2 - 1e-6 * (1 + Math.abs(depth)))
  const seen = near.flatMap((_, k) => {
    const [x0, y0, x1, y1] = spans[k] as [number, number, number, number]
    return x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1 ? [] : [k]
  }).sort((a, b) => (nearest[a] as number) - (nearest[b] as number) || a - b)
  for (let i = 0; i < n; i++) {
    const x = (2 * (i + 0.5)) / n - 1
    const column = seen.filter((k) => x >= ((spans[k] as number[])[0] as number) && x <= ((spans[k] as number[])[2] as number))
    if (column.length === 0) continue
    for (let j = 0; j < m; j++) {
      const y = (2 * (j + 0.5)) / m - 1
      const d: V3 = [fx + cam.r[0] * x * cam.tanX + cam.u[0] * (y - cam.shift) * cam.tanY, fy + cam.r[1] * x * cam.tanX + cam.u[1] * (y - cam.shift) * cam.tanY, fz + cam.r[2] * x * cam.tanX + cam.u[2] * (y - cam.shift) * cam.tanY]
      let first = depth
      let who = -1
      for (const k of column) {
        if ((nearest[k] as number) > first) break
        const span = spans[k] as number[]
        if (y < (span[1] as number) || y > (span[3] as number)) continue
        const t = meet(cam.pos, d, near[k] as Body)
        if (t < first || (who >= 0 && t === first && k < who)) {
          first = t
          who = k
        }
      }
      if (who >= 0) hits[who] = (hits[who] as number) + 1
    }
  }
  return Math.max(0, ...hits) / (n * m)
}

/** whether the lens sees the plane point (x, y, z) past every body */
export function inSight(cam: Cam, x: number, y: number, z: number, bodies: Body[]): boolean {
  const d = sub([x, -y, z], cam.pos)
  return bodies.every((b) => meet(cam.pos, d, b) > 0.999)
}

/**
 * How much of the hero the other bodies hide from this camera. `covered` is
 * the fraction of the hero's footprint, grown to `reach` times its box (its pin rows), that a ray from the
 * lens cannot reach (the footprint at the hero's top, the margin on the
 * board); `larger` is the largest on-screen area of any body nearer the lens
 * than the hero, over the hero's own.
 */
export function heroOcclusion(cam: Cam, W: number, H: number, hero: Body, bodies: Body[], reach = 1.4): { covered: number; larger: number } {
  const N = 16
  const c = Math.cos(hero.rot)
  const s = Math.sin(hero.rot)
  const heroDepth = dot(sub([hero.x, -hero.y, hero.z / 2], cam.pos), cam.f)
  const screen = (b: Body): Array<[number, number]> | undefined => {
    const qs = corners(b).map(([x, y, z]) => project(cam, x, y, z))
    return qs.some((q) => q.w <= 0) ? undefined : qs.map((q): [number, number] => [(q.x * W) / 2, (q.y * H) / 2])
  }
  const heroQs = screen(hero)
  const heroArea = heroQs === undefined ? 0 : hullArea(heroQs.map(([x, y]) => [(2 * x) / W, (2 * y) / H])) * (W / 2) * (H / 2)
  const near = bodies.filter((b) => dot(sub([b.x, -b.y, (b.base ?? 0) + b.z / 2], cam.pos), cam.f) < heroDepth)
  const around = corners({ ...hero, w: hero.w * reach, h: hero.h * reach }).map(([x, y, z]) => project(cam, x, y, z))
  const mx0 = Math.min(...around.map((q) => q.x))
  const mx1 = Math.max(...around.map((q) => q.x))
  const my0 = Math.min(...around.map((q) => q.y))
  const my1 = Math.max(...around.map((q) => q.y))
  let larger = 0
  const boxes: Body[] = []
  for (const b of near) {
    const qs = screen(b)
    if (qs === undefined) {
      boxes.push(b)
      continue
    }
    const ndc = qs.map(([x, y]): [number, number] => [(2 * x) / W, (2 * y) / H])
    larger = Math.max(larger, (hullArea(ndc) * (W / 2) * (H / 2)) / Math.max(1e-9, heroArea))
    if (Math.max(...ndc.map((q) => q[0])) < mx0 || Math.min(...ndc.map((q) => q[0])) > mx1 || Math.max(...ndc.map((q) => q[1])) < my0 || Math.min(...ndc.map((q) => q[1])) > my1) continue
    boxes.push(b)
  }
  let hit = 0
  let seen = 0
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const lx = ((i + 0.5) / N - 0.5) * reach
      const ly = ((j + 0.5) / N - 0.5) * reach
      const inside = Math.abs(lx) <= 0.5 && Math.abs(ly) <= 0.5
      const px = hero.x + c * lx * hero.w - s * ly * hero.h
      const py = hero.y + s * lx * hero.w + c * ly * hero.h
      const target: V3 = [px, -py, inside ? hero.z : 0]
      const q = project(cam, px, py, target[2])
      if (q.w <= 0 || Math.abs(q.x) > 1 || Math.abs(q.y) > 1) continue
      seen++
      if (!inSight(cam, px, py, target[2], boxes)) hit++
    }
  }
  return { covered: seen === 0 ? 0 : hit / seen, larger }
}

const BOX_FACES = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]]
const boxDrawn = (b: Body): Float32Array => {
  const c = corners(b)
  return Float32Array.from(BOX_FACES.flatMap(([p, q, r, t]) => [p, q, r, p, r, t].flatMap((i) => c[i as number] as [number, number, number])))
}

/** the screen's share of the marking cell on an IC's lid, along its long side and across its short one, as the renderer sets it: the cell keeps a 2:1 aspect and fills 0.78 of the long side where the short side allows */
export function markCell(b: Pick<Body, 'w' | 'h'>): { along: number; across: number } {
  const long = Math.max(b.w, b.h)
  const short = Math.min(b.w, b.h)
  const across = Math.min(1, (0.78 * long) / 2 / short)
  return { along: (across * short * 2) / long, across }
}

/** the share of a lid's top face, and of its marking cell, hidden from the lens by other bodies as drawn (their meshes, else their boxes), over an n × n grid of points on each */
export function lidCover(cam: Cam, lid: Body, blockers: Body[], n = 10): { lid: number; mark: number } {
  const c = Math.cos(lid.rot)
  const sn = Math.sin(lid.rot)
  const top = (lid.base ?? 0) + lid.z
  const cell = markCell(lid)
  const wide = Math.fround(lid.w) >= Math.fround(lid.h)
  const [mw, mh] = wide ? [cell.along, cell.across] : [cell.across, cell.along]
  const at = (u: number, v: number): [number, number, number] => [lid.x + u * lid.w * c - v * lid.h * sn, lid.y + u * lid.w * sn + v * lid.h * c, top]
  const qs = [-0.5, 0.5].flatMap((u) => [-0.5, 0.5].map((v) => project(cam, ...at(u, v))))
  const x0 = Math.min(...qs.map((q) => q.x)) - 0.02
  const x1 = Math.max(...qs.map((q) => q.x)) + 0.02
  const y0 = Math.min(...qs.map((q) => q.y)) - 0.02
  const y1 = Math.max(...qs.map((q) => q.y)) + 0.02
  const tris = blockers.filter((b) => {
    const cs = corners(b).map(([x, y, z]) => project(cam, x, y, z))
    return cs.some((q) => q.w <= 0) || !(Math.max(...cs.map((q) => q.x)) < x0 || Math.min(...cs.map((q) => q.x)) > x1 || Math.max(...cs.map((q) => q.y)) < y0 || Math.min(...cs.map((q) => q.y)) > y1)
  }).map((b) => b.drawn ?? boxDrawn(b))
  const o = cam.pos
  const hidden = ([px, py, pz]: [number, number, number]): boolean => {
    const [o0, o1, o2] = o
    const dx = px - o0
    const dy = -py - o1
    const dz = pz - o2
    for (const t of tris) {
      for (let k = 0; k < t.length; k += 9) {
        const ax = t[k] as number
        const ay = -(t[k + 1] as number)
        const az = t[k + 2] as number
        const e1x = (t[k + 3] as number) - ax
        const e1y = -(t[k + 4] as number) - ay
        const e1z = (t[k + 5] as number) - az
        const e2x = (t[k + 6] as number) - ax
        const e2y = -(t[k + 7] as number) - ay
        const e2z = (t[k + 8] as number) - az
        const px2 = dy * e2z - dz * e2y
        const py2 = dz * e2x - dx * e2z
        const pz2 = dx * e2y - dy * e2x
        const det = e1x * px2 + e1y * py2 + e1z * pz2
        if (Math.abs(det) < 1e-12) continue
        const sx = o0 - ax
        const sy = o1 - ay
        const sz = o2 - az
        const u = (sx * px2 + sy * py2 + sz * pz2) / det
        if (u < 0 || u > 1) continue
        const qx = sy * e1z - sz * e1y
        const qy = sz * e1x - sx * e1z
        const qz = sx * e1y - sy * e1x
        const v = (dx * qx + dy * qy + dz * qz) / det
        if (v < 0 || u + v > 1) continue
        const along = (e2x * qx + e2y * qy + e2z * qz) / det
        if (along > 1e-4 && along < 1 - 1e-4) return true
      }
    }
    return false
  }
  const share = (sw: number, sh: number): number => {
    let hit = 0
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (hidden(at(((i + 0.5) / n - 0.5) * sw, ((j + 0.5) / n - 0.5) * sh))) hit++
    return hit / (n * n)
  }
  return { lid: share(1, 1), mark: share(mw, mh) }
}
