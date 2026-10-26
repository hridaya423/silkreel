import type { FlatPath, TraceGroup, TraceLayer, TraceScene, TraceTimeline } from '@silk-reel/choreo'
import { FONT } from './font'

/**
 * Board-space data maps for the lit renderer. Nothing here is colour: each
 * canvas packs three scalar fields into R/G/B (drawn with 'lighter' so the
 * channels never bleed), and the shader turns them into copper, mask, ink
 * and light. The maps cover only `region` (plane px) — the part of the board
 * the camera can see — so a macro shot gets texels where it needs them.
 *
 *   top:    R copper (front)    G exposed pad      B warm energy (power)
 *   surf:   R silk ink          G drilled hole     B board area
 *   fx:     R cool energy       G part shadow      B routing head
 */
export interface Region { x: number; y: number; w: number; h: number }

export interface MapSet {
  top: HTMLCanvasElement
  surf: HTMLCanvasElement
  fx: HTMLCanvasElement
}

type Ch = 0 | 1 | 2

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}
const within = (p: number, a: number, b: number): number => ease((p - a) / (b - a))

export function createMaps(w: number, h: number): MapSet {
  const make = (): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  return { top: make(), surf: make(), fx: make() }
}

const CH = ['rgba(255,0,0,', 'rgba(0,255,0,', 'rgba(0,0,255,'] as const
const ink = (ch: Ch, a = 1): string => `${CH[ch]}${Math.max(0, Math.min(1, a)).toFixed(4)})`

function begin(c: HTMLCanvasElement, r: Region): CanvasRenderingContext2D {
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, c.width, c.height)
  const s = c.width / r.w
  ctx.setTransform(s, 0, 0, s, -r.x * s, -r.y * s)
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  return ctx
}

const poly = (ctx: CanvasRenderingContext2D | Path2D, path: FlatPath): void => {
  ctx.moveTo(path[0] as number, path[1] as number)
  for (let i = 2; i + 1 < path.length; i += 2) ctx.lineTo(path[i] as number, path[i + 1] as number)
}

/** an energy target: which canvas and channel a role's light lands in */
interface Light { ctx: CanvasRenderingContext2D; ch: Ch }

/**
 * Energy along a seg for a front that crosses it during [w0, w1]: a streak
 * from the tail to the head, brightest at the head. Fronts spill across seg
 * boundaries because every seg draws its own slice of the streak.
 */
function streak(
  l: Light,
  x0: number, y0: number, x1: number, y1: number,
  w: number, w0: number, w1: number, p: number, gain: number, tail: number
): void {
  if (p < w0 || p > w1 + tail) return
  const span = Math.max(1e-6, w1 - w0)
  const hf = Math.min(1, (p - w0) / span)
  const tf = Math.max(0, (p - tail - w0) / span)
  if (hf <= tf) return
  const hx = x0 + (x1 - x0) * hf
  const hy = y0 + (y1 - y0) * hf
  const tx = x0 + (x1 - x0) * tf
  const ty = y0 + (y1 - y0) * tf
  // once the front has left this seg, its slice of the streak dims with the tail
  const headA = hf >= 1 ? gain * (1 - (p - w1) / tail) : gain
  const grad = l.ctx.createLinearGradient(tx, ty, hx, hy)
  grad.addColorStop(0, ink(l.ch, 0))
  grad.addColorStop(1, ink(l.ch, headA))
  l.ctx.strokeStyle = grad
  // light reads at film scale even on a hairline trace
  l.ctx.lineWidth = Math.max(2, w * 1.5)
  l.ctx.beginPath()
  l.ctx.moveTo(tx, ty)
  l.ctx.lineTo(hx, hy)
  l.ctx.stroke()
}

/**
 * How each role reads once the board is powered: the rails are warm and stay
 * lit, clocks are short sharp cool ticks, buses and pairs are long cool
 * streaks, a lone signal is a dim one.
 */
const ROLE_LOOK: Record<TraceGroup['kind'], { cool: boolean; grow: number; pulse: number; tail: number; steady: number }> = {
  power: { cool: false, grow: 0.7, pulse: 0, tail: 0.03, steady: 0.18 },
  ground: { cool: false, grow: 0, pulse: 0, tail: 0.01, steady: 0 },
  clock: { cool: true, grow: 0.9, pulse: 0.75, tail: 0.006, steady: 0 },
  bus: { cool: true, grow: 0.7, pulse: 0.42, tail: 0.02, steady: 0 },
  diff: { cool: true, grow: 0.7, pulse: 0.5, tail: 0.014, steady: 0 },
  signal: { cool: true, grow: 0.4, pulse: 0.3, tail: 0.012, steady: 0 }
}

/** how long the power-on wave takes to cross the board, in film phase */
const INRUSH = 1.6 / 24

/** the routing tip: a short bright streak behind each growing seg's head */
const HEAD = { gain: 0.32, tail: 0.01 }

function drawCopperLayer(
  ctx: CanvasRenderingContext2D,
  head: Light,
  warm: Light,
  cool: Light,
  layer: TraceLayer,
  scene: TraceScene,
  p: number
): void {
  const { segs, groups, energy } = layer
  const batches = new Map<number, Path2D>()
  const n = segs.length / 7
  for (let i = 0; i < n; i++) {
    const o = i * 7
    const t0 = segs[o + 5] as number
    if (t0 > p) break
    const x0 = segs[o] as number
    const y0 = segs[o + 1] as number
    const x1 = segs[o + 2] as number
    const y1 = segs[o + 3] as number
    const w = segs[o + 4] as number
    const t1 = segs[o + 6] as number
    if (t1 <= p) {
      const key = Math.round(w * 4) / 4
      let path = batches.get(key)
      if (path === undefined) {
        path = new Path2D()
        batches.set(key, path)
      }
      path.moveTo(x0, y0)
      path.lineTo(x1, y1)
    } else {
      const f = (p - t0) / Math.max(1e-6, t1 - t0)
      ctx.strokeStyle = ink(0)
      ctx.lineWidth = w
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
      ctx.stroke()
    }
    streak(head, x0, y0, x1, y1, w, t0, t1, p, HEAD.gain, HEAD.tail)
  }
  ctx.strokeStyle = ink(0)
  for (const [w, path] of batches) {
    ctx.lineWidth = w
    ctx.stroke(path)
  }

  const [p0] = scene.acts.power
  if (p < p0) return
  // power-on: one warm wave crosses every trace in the order it was routed
  const [d0, d1] = scene.acts.draw
  const wave = INRUSH / (d1 - d0)
  if (p < p0 + INRUSH + 0.06) {
    // a dense cluster takes the brightest streak, not their sum, so it never merges into one blob
    warm.ctx.globalCompositeOperation = 'lighten'
    for (let i = 0; i < n; i++) {
      const o = i * 7
      const w0 = p0 + ((segs[o + 5] as number) - d0) * wave
      if (w0 > p) break
      streak(warm, segs[o] as number, segs[o + 1] as number, segs[o + 2] as number, segs[o + 3] as number, segs[o + 4] as number,
        w0, p0 + ((segs[o + 6] as number) - d0) * wave, p, 0.5, 0.03)
    }
    warm.ctx.globalCompositeOperation = 'lighter'
  }
  for (let i = 0; i < n; i++) {
    const e0 = energy[i * 2] as number
    if (e0 < 0 || e0 > p) continue
    const e1 = energy[i * 2 + 1] as number
    const o = i * 7
    const x0 = segs[o] as number
    const y0 = segs[o + 1] as number
    const x1 = segs[o + 2] as number
    const y1 = segs[o + 3] as number
    const w = segs[o + 4] as number
    const grp = scene.groups[groups[i] as number] as TraceGroup
    const look = ROLE_LOOK[grp.kind]
    const light = look.cool ? cool : warm
    streak(light, x0, y0, x1, y1, w, e0, e1, p, look.grow, look.tail)
    if (look.steady > 0 && p > e1) {
      light.ctx.strokeStyle = ink(light.ch, look.steady * within(p, e1, e1 + 0.02))
      light.ctx.lineWidth = w * 1.5
      light.ctx.beginPath()
      light.ctx.moveTo(x0, y0)
      light.ctx.lineTo(x1, y1)
      light.ctx.stroke()
    }
    // pulses replay the power-on front faster, on the beat
    const k = 1 / grp.pulseSpeed
    for (const s of grp.pulses) {
      const w0 = s + (e0 - grp.t) * k
      const w1 = s + (e1 - grp.t) * k
      if (p < w0 || p > w1 + look.tail) continue
      streak(light, x0, y0, x1, y1, w, w0, w1, p, look.pulse, look.tail)
    }
  }
}

const padPath = (ctx: CanvasRenderingContext2D, w: number, h: number, shape: 'rect' | 'round' | 'circle'): void => {
  ctx.beginPath()
  if (shape === 'circle') ctx.arc(0, 0, Math.max(w, h) / 2, 0, Math.PI * 2)
  else if (shape === 'round' && typeof ctx.roundRect === 'function') ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.32)
  else ctx.rect(-w / 2, -h / 2, w, h)
}

/** pours fill outward from the hero; a power pour glows softly once powered */
function drawZones(ctx: CanvasRenderingContext2D, warm: Light, scene: TraceScene, side: 'F' | 'B' | 'inner', p: number, reachMax: number): void {
  for (const zone of scene.zones) {
    if (zone.side !== side) continue
    const f = within(p, zone.t0, zone.t1)
    if (f <= 0) continue
    const clip = new Path2D()
    poly(clip, zone.fill)
    ctx.save()
    ctx.clip(clip)
    ctx.beginPath()
    ctx.arc(scene.origin.x, scene.origin.y, f * reachMax, 0, Math.PI * 2)
    ctx.fillStyle = ink(0, 0.82)
    ctx.fill()
    ctx.restore()
    // the power-on wave crosses each pour as a soft ring; a power pour keeps a low glow
    const [p0] = scene.acts.power
    const u = (p - p0) / INRUSH
    if (u > 0 && u < 1.2) frontRing(warm, clip, scene.origin, u * reachMax * 0.8, 0.04 * Math.min(1, (1.2 - u) * 4))
    if (zone.e0 >= 0 && p > zone.e0) {
      warm.ctx.save()
      warm.ctx.clip(clip)
      warm.ctx.fillStyle = ink(warm.ch, 0.05 * within(p, zone.e0, zone.e0 + 0.04))
      warm.ctx.fill(clip)
      warm.ctx.restore()
    }
  }
}

/** a soft band of light just inside a front of radius r */
function frontRing(l: Light, clip: Path2D, o: { x: number; y: number }, r: number, a: number): void {
  const band = Math.max(60, r * 0.25)
  l.ctx.save()
  l.ctx.clip(clip)
  const grad = l.ctx.createRadialGradient(o.x, o.y, Math.max(0, r - band), o.x, o.y, r)
  grad.addColorStop(0, ink(l.ch, 0))
  grad.addColorStop(0.8, ink(l.ch, a))
  grad.addColorStop(1, ink(l.ch, 0))
  l.ctx.fillStyle = grad
  l.ctx.beginPath()
  l.ctx.arc(o.x, o.y, r, 0, Math.PI * 2)
  l.ctx.fill()
  l.ctx.restore()
}

/** how high a part still hangs above its seat: 1 before it drops, 0 once set down */
function partDrop(t: number, p: number, hero: boolean): number {
  const dur = (hero ? 0.75 : 0.5) / 24
  const u = (p - (t - dur)) / dur
  if (u <= 0) return 1
  if (u >= 1) return 0
  return (1 - u) * (1 - u) * (1 - u)
}

/** draws every map for film phase p */
export function drawMaps(maps: MapSet, tl: TraceTimeline, p: number, region: Region): void {
  const s = tl.scene
  const top = begin(maps.top, region)
  const fx = begin(maps.fx, region)
  const warm: Light = { ctx: top, ch: 2 }
  const cool: Light = { ctx: fx, ch: 0 }
  const head: Light = { ctx: fx, ch: 2 }
  const topSide = s.layers.some((l) => l.side === 'F') ? 'F' : (s.layers[s.layers.length - 1]?.side ?? 'F')

  // --- front copper + energy
  drawZones(top, warm, s, topSide, p, Math.hypot(tl.width, tl.height))
  for (const layer of s.layers) {
    if (layer.side === topSide) drawCopperLayer(top, head, warm, cool, layer, s, p)
  }
  // pads: copper + exposed finish, there from the first frame
  for (const pad of s.pads) {
    if (p < pad.t) continue
    if (pad.side === 'B' && topSide === 'F') continue
    top.save()
    top.translate(pad.x, pad.y)
    top.rotate(pad.rot)
    padPath(top, pad.w, pad.h, pad.shape)
    if (pad.ring === true) {
      top.lineWidth = 1.6
      top.strokeStyle = 'rgba(255,255,0,1)'
      top.stroke()
    } else {
      top.fillStyle = 'rgba(255,255,0,1)'
      top.fill()
    }
    top.restore()
  }
  // vias: a copper ring once the routing reaches them
  top.strokeStyle = ink(0)
  for (const via of s.vias) {
    if (p < via.t) continue
    top.lineWidth = Math.max(0.8, via.r * 0.55)
    top.beginPath()
    top.arc(via.x, via.y, via.r * 0.8, 0, Math.PI * 2)
    top.stroke()
  }
  // part shadows: a soft dark footprint under every seated or falling body.
  // max-blended, so a crowd of parts never stacks into a black slab
  fx.globalCompositeOperation = 'lighten'
  for (const part of s.parts) {
    if (part.kind === 'pin') continue
    const drop = partDrop(part.t, p, part.hero === true)
    if (drop >= 1) continue
    const k = (1 - drop) * Math.min(1, 0.35 + part.z / 30)
    fx.save()
    fx.translate(part.x, part.y)
    fx.rotate(part.rot)
    for (const [grow, a] of [[1.35, 0.16], [1.15, 0.3], [1.0, 0.5]] as const) {
      const pad = Math.min(part.w, part.h) * (grow - 1) + part.z * (grow - 1) * 0.6
      fx.fillStyle = `rgb(0,${Math.round(255 * a * k)},0)`
      fx.fillRect(-part.w / 2 - pad, -part.h / 2 - pad, part.w + 2 * pad, part.h + 2 * pad)
    }
    fx.restore()
  }
  fx.globalCompositeOperation = 'lighter'

  // --- surface: silk, holes, board area
  const surf = begin(maps.surf, region)
  const area = new Path2D()
  for (const loop of s.board) {
    poly(area, loop)
    area.closePath()
  }
  surf.fillStyle = ink(2)
  surf.fill(area, 'evenodd')
  surf.fillStyle = ink(1)
  for (const d of s.drills) {
    surf.beginPath()
    surf.arc(d.x, d.y, d.r, 0, Math.PI * 2)
    surf.fill()
  }
  surf.strokeStyle = ink(0)
  surf.lineWidth = 1.1
  const silkDone = new Path2D()
  for (const stroke of s.silkStrokes) {
    const f = ease((p - stroke.t) / 0.03)
    if (f <= 0) continue
    if (f >= 1) {
      poly(silkDone, stroke.path)
      continue
    }
    const len = Math.max(1, pathLen(stroke.path))
    surf.setLineDash([len * f, len])
    surf.beginPath()
    poly(surf, stroke.path)
    surf.stroke()
    surf.setLineDash([])
  }
  surf.stroke(silkDone)
  surf.fillStyle = ink(0)
  surf.textAlign = 'center'
  surf.textBaseline = 'middle'
  for (const text of s.texts) {
    const k = ease((p - text.t) / 0.025)
    if (k <= 0) continue
    const shown = text.text.substring(0, Math.ceil(text.text.length * k))
    if (shown.length === 0) continue
    surf.save()
    surf.translate(text.x, text.y)
    surf.rotate(text.rot)
    surf.font = `${text.size}px ${FONT}`
    surf.fillText(shown, 0, 0)
    surf.restore()
  }
}

function pathLen(path: FlatPath): number {
  let len = 0
  for (let i = 2; i + 1 < path.length; i += 2) {
    len += Math.hypot((path[i] as number) - (path[i - 2] as number), (path[i + 1] as number) - (path[i - 1] as number))
  }
  return len
}
