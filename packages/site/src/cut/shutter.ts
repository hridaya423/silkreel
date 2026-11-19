const HALF = Math.PI / 2

export interface Wave {
  front: number
  fan: number
  reach: number
  settle: number
  back: number
}

const smooth = (v: number) => {
  const x = Math.min(1, Math.max(0, v))
  return x * x * (3 - 2 * x)
}

export function slatAngles(n: number, w: Wave, sw: number, out = new Float32Array(n * 3)): Float32Array {
  const edge = w.fan * HALF
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n
    const s = x - w.front
    let a = edge * smooth((s + w.reach) / w.reach) + HALF * smooth(s / w.settle)
    const b = Math.min(1, Math.max(0, (w.back * 1.25 - x) / 0.25))
    a += Math.PI * b * b * (3 - 2 * b)
    out[i * 3] = i
    out[i * 3 + 1] = a
    out[i * 3 + 2] = Math.abs(Math.sin(a)) * sw * 1.5
  }
  return out
}

export const activeSlat = (n: number, w: Wave) => (w.back > 0 ? (w.back * 1.25 - 0.125) * n - 0.5 : w.front * n - 0.5)

export function orbit(yawDeg: number, pitchDeg: number): Float32Array {
  const y = (yawDeg * Math.PI) / 180
  const p = (pitchDeg * Math.PI) / 180
  const cy = Math.cos(y)
  const sy = Math.sin(y)
  const cp = Math.cos(p)
  const sp = Math.sin(p)
  return new Float32Array([cy, 0, -sy, sy * sp, cp, cy * sp, sy * cp, -sp, cy * cp])
}

export interface Film { x: number; y: number; w: number; h: number }

export function project(u: number, v: number, film: Film, rot: Float32Array, W: number, H: number): [number, number] {
  const cx = film.x + film.w / 2
  const cy = film.y + film.h / 2
  const px = film.x + u * film.w - cx
  const py = film.y + v * film.h - cy
  const r = (k: number) => rot[k] ?? 0
  const x = r(0) * px + r(3) * py + cx
  const y = r(1) * px + r(4) * py + cy
  const z = r(2) * px + r(5) * py
  const D = H * 1.5
  const s = D / (D - z)
  return [W / 2 + (x - W / 2) * s, H / 2 + (y - H / 2) * s]
}
