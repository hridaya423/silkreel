import { copperStack, project } from '@silk-reel/choreo'
import type { Cam, TraceScene } from '@silk-reel/choreo'

type Ctx = CanvasRenderingContext2D
type RGB = [number, number, number]

const BG = '#020304'
const GHOST = 'rgba(120, 140, 160, 0.035)'
const EDGE: RGB = [170, 195, 220]
const FRONT: RGB = [232, 246, 255]
const INNER: RGB = [70, 130, 200]
const BACK: RGB = [60, 115, 185]
const PAD: RGB = [240, 250, 255]
/** the alpha of the tone inside a main-chip pad the scene draws as a ring (an exposed pad), so it reads as metal under its edge, not as a hole */
export const RING_TONE = 0.22

/** a layer's line strength: tracks, pads, vias and every pour's outline draw at it */
export const LINE = { F: 0.36, inner: 0.3, B: 0.24 } as const
/** a pour's inside: one faint tone, the same on every layer, so the stack of all pours stays a third of a track or less */
export const POUR = 0.025
/** the thinnest line, as a share of the frame's width: 0.6 px on a 390 px phone */
export const LINE_LEAST = 0.6 / 390
/** the main chip's body: one clean tone inside its outline, with no texture */
const BODY = 0.05

/** copper thinner on screen draws denser, so the whole board reads as brightly as the close shot: the density rises below LIFT screen pixels a millimetre, to at most LIFT_MOST times */
const LIFT = 30
const LIFT_MOST = 1.8

const rgba = (c: RGB, a: number): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

/** a layer is brighter in the frames it arrives: its density, by its age in frames */
const ARRIVE = [1.7, 1.3]
/** once a newer layer has arrived, an older one falls back to this share of its strength, its pours with it, so the newest is always the brightest and a single track stays legible through the stack */
export const FALL = 0.45

/** the whole board's X-ray is exposed once a film, so that its front copper alone, the first layer to arrive, stands at one mean level over the board, the level of a dense four-layer board's front; the gain stays inside least..most */
export const EXPOSE = { level: 0.18, least: 0.6, most: 2.5 } as const
const exposed = new WeakMap<TraceScene, number>()

/** a pad's outline on the board, in board units */
export function padOutline(p: TraceScene['pads'][number]): Array<[number, number]> {
  const c = Math.cos(p.rot)
  const s = Math.sin(p.rot)
  const at = (u: number, v: number): [number, number] => [p.x + c * u - s * v, p.y + s * u + c * v]
  const hw = p.w / 2
  const hh = p.h / 2
  if (p.shape === 'circle') return Array.from({ length: 20 }, (_, i) => at(hw * Math.cos((i / 20) * 2 * Math.PI), hh * Math.sin((i / 20) * 2 * Math.PI)))
  if (p.shape === 'rect') return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)]
  const r = 0.64 * Math.min(hw, hh)
  const pts: Array<[number, number]> = []
  for (const [cx, cy, a0] of [[hw - r, hh - r, 0], [-hw + r, hh - r, 0.5], [-hw + r, -hh + r, 1], [hw - r, -hh + r, 1.5]] as const) {
    for (let i = 0; i <= 4; i++) {
      const a = (a0 + i / 8) * Math.PI
      pts.push(at(cx + r * Math.cos(a), cy + r * Math.sin(a)))
    }
  }
  return pts
}

export function drawXray(out: Ctx, scene: TraceScene, cam: Cam, W: number, H: number, shown?: { layers: number; age: number }): void {
  const sx = (x: number, y: number, z = 0): [number, number, number] => {
    const q = project(cam, x, y, z)
    return [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H, q.w]
  }
  const a0 = sx(scene.origin.x, scene.origin.y)
  const ax = sx(scene.origin.x + 10, scene.origin.y)
  const ay = sx(scene.origin.x, scene.origin.y + 10)
  const k = (Math.hypot(ax[0] - a0[0], ax[1] - a0[1]) + Math.hypot(ay[0] - a0[0], ay[1] - a0[1])) / 20
  const lift = Math.min(LIFT_MOST, Math.max(1, LIFT / (k * scene.material.pxPerMm)))
  const layer = (): Ctx => {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    return c.getContext('2d') as Ctx
  }
  const poly = (ctx: Ctx, pts: Array<[number, number, number]>): void => {
    ctx.beginPath()
    for (const p of pts) ctx.lineTo(p[0], p[1])
    ctx.closePath()
  }
  const padPath = (ctx: Ctx, p: TraceScene['pads'][number]): void => {
    poly(ctx, padOutline(p).map(([x, y]) => sx(x, y)))
  }
  const least = LINE_LEAST * W
  const metal = (side: 'F' | 'B' | 'inner', id: string | undefined, gain: number, e: number): HTMLCanvasElement => {
    const ctx = layer()
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#fff'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const pour = layer()
    pour.fillStyle = '#fff'
    for (const zn of scene.zones) {
      if (zn.side !== side || (side === 'inner' && (zn.layer ?? 'In1.Cu') !== id)) continue
      const pts: Array<[number, number, number]> = []
      for (let i = 0; i + 1 < zn.fill.length; i += 2) pts.push(sx(zn.fill[i] as number, zn.fill[i + 1] as number))
      poly(pour, pts)
      pour.fill('evenodd')
      poly(ctx, pts)
      ctx.lineWidth = least
      ctx.stroke()
    }
    for (const l of scene.layers) {
      if (l.side !== side || (side === 'inner' && l.id !== id)) continue
      for (let i = 0; i + 6 < l.segs.length; i += 7) {
        const a = sx(l.segs[i] as number, l.segs[i + 1] as number)
        const b = sx(l.segs[i + 2] as number, l.segs[i + 3] as number)
        ctx.lineWidth = Math.max(least, (l.segs[i + 4] as number) * k)
        ctx.beginPath()
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(b[0], b[1])
        ctx.stroke()
      }
    }
    for (const p of scene.pads) {
      if (p.ring === true) continue
      if (!(p.side === side || p.side === 'both')) continue
      if (side === 'inner' && p.side !== 'both') continue
      padPath(ctx, p)
      ctx.fill()
    }
    for (const v of scene.vias) {
      const c = sx(v.x, v.y)
      ctx.beginPath()
      ctx.arc(c[0], c[1], Math.max(least / 2, v.r * k), 0, 2 * Math.PI)
      ctx.fill()
    }
    for (const c of [ctx, pour]) {
      c.globalCompositeOperation = 'destination-out'
      for (const d of scene.drills) {
        const q = sx(d.x, d.y)
        c.beginPath()
        c.arc(q[0], q[1], Math.max(0.5, d.r * k), 0, 2 * Math.PI)
        c.fill()
      }
      c.globalCompositeOperation = 'source-over'
    }
    const tint = (c: Ctx, col: RGB): void => {
      c.globalCompositeOperation = 'source-in'
      c.fillStyle = rgba(col, 1)
      c.fillRect(0, 0, W, H)
      c.globalCompositeOperation = 'source-over'
    }
    const col = side === 'F' ? FRONT : side === 'B' ? BACK : INNER
    tint(ctx, col)
    tint(pour, col)
    const merged = layer()
    merged.globalAlpha = POUR * e * Math.min(1, gain)
    merged.drawImage(pour.canvas, 0, 0)
    merged.globalAlpha = Math.min(1, gain * lift * e * LINE[side])
    merged.globalCompositeOperation = 'lighter'
    merged.drawImage(ctx.canvas, 0, 0)
    return merged.canvas
  }

  const boardPath = (c: Ctx): void => {
    c.beginPath()
    for (const loop of scene.board) {
      for (let i = 0; i + 1 < loop.length; i += 2) {
        const q = sx(loop[i] as number, loop[i + 1] as number)
        if (i === 0) c.moveTo(q[0], q[1])
        else c.lineTo(q[0], q[1])
      }
      c.closePath()
    }
  }
  const full = copperStack(scene)
  const paint = (c: Ctx, upTo: number, e: number, age: number | undefined): void => {
    c.fillStyle = BG
    c.fillRect(0, 0, W, H)
    c.fillStyle = GHOST
    boardPath(c)
    c.fill('evenodd')
    c.globalCompositeOperation = 'lighter'
    const stack = full.slice(0, upTo)
    for (const [i, l] of stack.entries()) c.drawImage(metal(l.side, l.id, age === undefined ? 1 : i === stack.length - 1 ? (ARRIVE[age] ?? 1) : FALL, e), 0, 0)
  }
  const exposure = (): number => {
    const seen = exposed.get(scene)
    if (seen !== undefined) return seen
    const probe = layer()
    paint(probe, 1, 1, undefined)
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.round(W / 8))
    small.height = Math.max(1, Math.round(H / 8))
    const sc = small.getContext('2d') as Ctx
    sc.scale(small.width / W, small.height / H)
    boardPath(sc)
    sc.clip('evenodd')
    sc.drawImage(probe.canvas, 0, 0)
    const d = sc.getImageData(0, 0, small.width, small.height).data
    let sum = 0
    let area = 0
    for (let i = 0; i + 3 < d.length; i += 4) {
      const a = (d[i + 3] as number) / 255
      sum += (a * (0.2126 * (d[i] as number) + 0.7152 * (d[i + 1] as number) + 0.0722 * (d[i + 2] as number))) / 255
      area += a
    }
    const e = Math.min(EXPOSE.most, Math.max(EXPOSE.least, area > 0 && sum > 0 ? (EXPOSE.level * area) / sum : EXPOSE.most))
    exposed.set(scene, e)
    return e
  }
  const acc = layer()
  paint(acc, shown?.layers ?? full.length, shown === undefined ? 1 : exposure(), shown?.age)
  acc.fillStyle = rgba(PAD, 0.8)
  acc.strokeStyle = rgba(PAD, 0.5)
  acc.lineWidth = Math.max(1, 0.0012 * W)
  for (const p of scene.pads) {
    if (p.hero !== true) continue
    padPath(acc, p)
    if (p.ring === true) {
      acc.fillStyle = rgba(PAD, RING_TONE)
      acc.fill()
      acc.stroke()
      acc.fillStyle = rgba(PAD, 0.8)
    } else acc.fill()
  }
  const hero = scene.parts.find((p) => p.hero === true)
  if (hero !== undefined) {
    const c = Math.cos(hero.rot)
    const s = Math.sin(hero.rot)
    const at = (u: number, v: number): [number, number, number] => sx(hero.x + (c * u * hero.w) / 2 - (s * v * hero.h) / 2, hero.y + (s * u * hero.w) / 2 + (c * v * hero.h) / 2, hero.z)
    acc.strokeStyle = rgba(EDGE, 0.55)
    acc.fillStyle = rgba(EDGE, BODY)
    acc.lineWidth = Math.max(1, 0.0012 * W)
    poly(acc, [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)])
    acc.fill()
    acc.stroke()
  }

  out.save()
  out.setTransform(1, 0, 0, 1, 0, 0)
  out.globalAlpha = 1
  out.globalCompositeOperation = 'source-over'
  out.filter = 'none'
  out.drawImage(acc.canvas, 0, 0)
  out.globalCompositeOperation = 'lighter'
  out.globalAlpha = 0.2
  out.filter = `blur(${Math.round(0.004 * W)}px)`
  out.drawImage(acc.canvas, 0, 0)
  out.filter = 'none'
  out.globalCompositeOperation = 'source-over'
  out.globalAlpha = 1
  const v = out.createRadialGradient(W / 2, H * 0.5, 0.25 * H, W / 2, H * 0.5, 0.72 * H)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(0,0,0,0.7)')
  out.fillStyle = v
  out.fillRect(0, 0, W, H)
  out.restore()
}
