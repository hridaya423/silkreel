function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sx = (u: number): number => ((ax * u + bx) * u + cx) * u
  const dx = (u: number): number => (3 * ax * u + 2 * bx) * u + cx
  return (t: number): number => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let u = t
    for (let i = 0; i < 8; i++) {
      const d = dx(u)
      if (Math.abs(d) < 1e-6) break
      u -= (sx(u) - t) / d
    }
    let lo = 0
    let hi = 1
    for (let i = 0; i < 30 && Math.abs(sx(u) - t) > 1e-7; i++) {
      if (sx(u) < t) lo = u
      else hi = u
      u = (lo + hi) / 2
    }
    return ((ay * u + by) * u + cy) * u
  }
}

export const easeOut = bezier(0.23, 1, 0.32, 1)
export const easeInOut = bezier(0.77, 0, 0.175, 1)

export const span01 = (f: number, f0: number, f1: number): number => Math.min(1, Math.max(0, (f - f0) / Math.max(1e-9, f1 - f0)))

export const arrive = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 2

export const smooth = (t: number): number => {
  const u = Math.min(1, Math.max(0, t))
  return u * u * (3 - 2 * u)
}
