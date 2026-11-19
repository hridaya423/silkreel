import type { FlatPath, TraceGroup, TraceLayer, TracePart, TraceScene, TraceTimeline } from '@silk-reel/choreo'
import { SILK_LEAD } from '@silk-reel/choreo'
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
/** the main chip's nets dip this far over these frames before the last pulse leaves it, and each comes back over `release` frames as the pulse's front passes it */
export const PULSE_DIP = { frames: 6, depth: 0.85, release: 6 }
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
  l.ctx.lineWidth = Math.max(1.2, Math.min(w, 3))
  l.ctx.beginPath()
  l.ctx.moveTo(tx, ty)
  l.ctx.lineTo(hx, hy)
  l.ctx.stroke()
}

/**
 * How each role reads once the board is powered: the rails are warm and stay
 * lit; the hero's own lines carry one cool streak out of it and settle to an ember.
 */
const ROLE_LOOK: Record<TraceGroup['kind'], { cool: boolean; grow: number; tail: number; steady: boolean }> = {
  power: { cool: false, grow: 0.8, tail: 0.012, steady: true },
  ground: { cool: false, grow: 0, tail: 0.01, steady: false },
  clock: { cool: true, grow: 1.0, tail: 0.012, steady: true },
  bus: { cool: true, grow: 0.9, tail: 0.012, steady: true },
  diff: { cool: true, grow: 0.9, tail: 0.012, steady: true },
  signal: { cool: true, grow: 0.8, tail: 0.012, steady: true }
}

/** the hero wakes half a beat after power-on; every front leaves it then */
const WAKE = 1 / 24
/** how long the supply's light trails behind its front on the way in from the connector */
const IN_TAIL = 14 / 360
const PULSE = 1.2
/** the pulse power-on: copper behind the head goes dark again within this share of the film */
const PULSE_TAIL = 2 / 360

/** the routing tip: white-hot at the head, cooling to bare copper along a tail of about a beat */
const HEAD = { gain: 0.65, tail: 0.025 }
/** an unreached pad: a dark mark in the laminate */
const GHOST = 0.12
/** how long a pad takes to plate once reached */
const PLATE = 0.008

function drawCopperLayer(
  ctx: CanvasRenderingContext2D,
  head: Light,
  warm: Light,
  cool: Light,
  layer: TraceLayer,
  scene: TraceScene,
  p: number,
  secs: number,
  lit: { all: number; hero: number }
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
    streak(head, x0, y0, x1, y1, w, t0, t1, p, HEAD.gain * (scene.groups[groups[i] as number]?.hero === true ? 1.3 : 1), HEAD.tail)
  }
  ctx.strokeStyle = ink(0)
  for (const [w, path] of batches) {
    ctx.lineWidth = w
    ctx.stroke(path)
  }

  if (p < scene.acts.power[0]) return
  const first = [Infinity, Infinity]
  const order: number[] = []
  for (let i = 0; i < n; i++) {
    const e0 = Math.min(energy[i * 2] as number, energy[i * 2 + 1] as number)
    const h = scene.groups[groups[i] as number]?.hero === true ? 0 : 1
    if (e0 >= 0 && e0 < (first[h] as number)) first[h] = e0
    if (h === 0 && e0 >= 0) order.push(Math.max(energy[i * 2] as number, energy[i * 2 + 1] as number))
  }
  order.sort((x, y) => x - y)
  const rank = (e: number): number => {
    let lo = 0
    let hi = order.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((order[mid] as number) < e) lo = mid + 1
      else hi = mid
    }
    return lo / Math.max(1, order.length - 1)
  }
  const rise = [within(p, first[0] as number, (first[0] as number) + 0.02), within(p, first[1] as number, (first[1] as number) + 0.04)]
  for (let i = 0; i < n; i++) {
    const rev = (energy[i * 2 + 1] as number) < (energy[i * 2] as number)
    const e0 = energy[i * 2 + (rev ? 1 : 0)] as number
    if (e0 < 0 || e0 > p) continue
    const e1 = energy[i * 2 + (rev ? 0 : 1)] as number
    const o = i * 7
    const x0 = segs[o + (rev ? 2 : 0)] as number
    const y0 = segs[o + (rev ? 3 : 1)] as number
    const x1 = segs[o + (rev ? 0 : 2)] as number
    const y1 = segs[o + (rev ? 1 : 3)] as number
    const w = segs[o + 4] as number
    const grp = scene.groups[groups[i] as number] as TraceGroup
    const look = ROLE_LOOK[grp.kind]
    const light = look.cool ? cool : warm
    const hero = grp.hero === true
    const k = (rise[hero ? 0 : 1] as number) * (hero ? 1 : 0.45)
    // a wide trace carries its light as a core line, not a flooded slab
    const lw = Math.min(w, 2.5)
    if (scene.power === 'pulse') {
      streak(light, x0, y0, x1, y1, 0.5 * lw, e0, e1, p, 0.45, PULSE_TAIL)
      streak(head, x0, y0, x1, y1, 0.5 * lw, e0, e1, p, 0.85, 0.002)
      continue
    }
    const inbound = scene.wake !== undefined && e1 <= scene.wake + 1e-6
    streak(light, x0, y0, x1, y1, inbound ? Math.max(lw, Math.min(1.8 * lw, w)) : lw, e0, e1, p, inbound ? 1 : look.grow * k, inbound ? IN_TAIL : look.tail)
    if (look.grow > 0 || inbound) streak(head, x0, y0, x1, y1, inbound ? Math.max(lw, Math.min(1.8 * lw, w)) : lw, e0, e1, p, inbound ? 1 : 0.9 * k, inbound ? 0.012 : 0.006)
    if (look.steady && p > e1) {
      const ph = ((p - e0) * secs) / PULSE
      const f = ph - Math.floor(ph)
      const pulse = hero && p > scene.acts.hold[0] ? 0.05 * Math.exp(-(((Math.min(f, 1 - f) * PULSE) / 0.12) ** 2)) : 0
      const out = scene.pulse
      const back = out === undefined ? 0 : out.at + Math.min(1, rank(e1)) * (out.span - PULSE_DIP.release / 360)
      const dip = out === undefined || !hero ? 1 : 1 - PULSE_DIP.depth * within(p, out.at - PULSE_DIP.frames / 360, out.at) * (1 - within(p, back, back + PULSE_DIP.release / 360))
      light.ctx.strokeStyle = ink(light.ch, ((hero ? 0.45 + 0.3 * within(p, scene.acts.hold[0], scene.acts.hold[0] + 0.04) : 0.2) + pulse) * k * within(p, e1, e1 + 0.02) * dip)
      light.ctx.lineWidth = lw
      light.ctx.beginPath()
      light.ctx.moveTo(x0, y0)
      light.ctx.lineTo(x1, y1)
      light.ctx.stroke()
    }
    const out = scene.pulse
    const wake = scene.wake
    if (out !== undefined && wake !== undefined && hero && Math.min(e0, e1) > wake && p >= out.at) {
      const at = (e: number): number => out.at + ((e - wake) / Math.max(1e-6, out.reach - wake)) * out.span
      streak(light, x0, y0, x1, y1, lw, at(e0), at(e1), p, 1, PULSE_TAIL)
    }
  }
  if (lit.all <= 0) return
  for (let i = 0; i < n; i++) {
    const o = i * 7
    if ((segs[o + 6] as number) > p) continue
    const hero = scene.groups[groups[i] as number]?.hero === true
    ctx.strokeStyle = ink(2, hero ? lit.hero : lit.all)
    ctx.lineWidth = Math.min(segs[o + 4] as number, 2.5)
    ctx.beginPath()
    ctx.moveTo(segs[o] as number, segs[o + 1] as number)
    ctx.lineTo(segs[o + 2] as number, segs[o + 3] as number)
    ctx.stroke()
  }
}

const padPath = (ctx: CanvasRenderingContext2D, w: number, h: number, shape: 'rect' | 'round' | 'circle'): void => {
  ctx.beginPath()
  if (shape === 'circle') ctx.arc(0, 0, Math.max(w, h) / 2, 0, Math.PI * 2)
  else if (shape === 'round' && typeof ctx.roundRect === 'function') ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.32)
  else ctx.rect(-w / 2, -h / 2, w, h)
}

/** pours flood as one front outward from the hero, a shade below the traces; a power pour glows softly once powered */
function drawZones(ctx: CanvasRenderingContext2D, warm: Light, scene: TraceScene, side: 'F' | 'B' | 'inner', p: number, region: Region): void {
  const [z0, z1] = scene.acts.pour
  if (p < z0) return
  const o = scene.origin
  let reach = 1
  let start = Infinity
  for (const zone of scene.zones) {
    if (zone.side !== side) continue
    const f = zone.fill
    for (let i = 0; i + 1 < f.length; i += 2) {
      const ax = f[i] as number
      const ay = f[i + 1] as number
      const bx = f[(i + 2) % f.length] as number
      const by = f[(i + 3) % f.length] as number
      reach = Math.max(reach, Math.hypot(ax - o.x, ay - o.y))
      const t = Math.min(1, Math.max(0, ((o.x - ax) * (bx - ax) + (o.y - ay) * (by - ay)) / Math.max(1e-9, (bx - ax) ** 2 + (by - ay) ** 2)))
      start = Math.min(start, Math.hypot(ax + (bx - ax) * t - o.x, ay + (by - ay) * t - o.y))
    }
  }
  const k = Math.min(1, (p - z0) / Math.max(1e-6, z1 - z0))
  const near = Math.min(start, reach)
  const seen = Math.max(near, Math.min(reach, Math.max(...[[region.x, region.y], [region.x + region.w, region.y], [region.x, region.y + region.h], [region.x + region.w, region.y + region.h]].map(([x, y]) => Math.hypot((x as number) - o.x, (y as number) - o.y)))))
  const front = 1.05 * (k < 0.9 ? near + (seen - near) * ease(k / 0.9) : seen + (reach - seen) * ((k - 0.9) / 0.1))
  for (const zone of scene.zones) {
    if (zone.side !== side) continue
    const clip = new Path2D()
    poly(clip, zone.fill)
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
    ctx.globalCompositeOperation = 'lighten'
    ctx.clip(clip)
    const edge = Math.max(1, 0.12 * reach)
    const r = Math.max(1e-3, front)
    const fill = ctx.createRadialGradient(scene.origin.x, scene.origin.y, Math.max(0, r - edge), scene.origin.x, scene.origin.y, r)
    fill.addColorStop(0, ink(0, 0.13))
    fill.addColorStop(1, ink(0, 0))
    ctx.fillStyle = k >= 1 ? ink(0, 0.13) : fill
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    ctx.restore()
    // a power pour keeps a low glow once its rail is live
    if (zone.e0 >= 0 && p > zone.e0 && scene.power === 'leds') {
      warm.ctx.save()
      warm.ctx.clip(clip)
      warm.ctx.fillStyle = ink(warm.ch, 0.05 * within(p, zone.e0, zone.e0 + 0.04))
      warm.ctx.fill(clip)
      warm.ctx.restore()
    }
  }
}

/** a part's descent when the scene gives none: the hero's */
const HERO_FALL = 11.5 / 360

/** how high a part still is above its seat, as a share of its fall height: 1 as its descent starts, 0 from contact on, above 1 before it is in the picture */
export function partDrop(t: number, p: number, fall: number, valve = false, hero = false): number {
  if (valve) {
    const a = 1 - (t - p) / (3 / 24)
    if (a <= 0) return 1
    if (a >= 1) return 0
    return 1 - a * a * (3 - 2 * a)
  }
  const u = (t - p) / fall
  if (u > 1) return 1.01
  if (u <= 0) return 0
  return hero ? u * u : u * u * (3 - 2 * u)
}

/**
 * A body's drawn pose at phase p, as the part and mesh vertex shaders place it:
 * plane position, rotation, height above its seat and footprint scale. It mirrors
 * drop() in trace-gl's LANDING: one eased descent along a straight line from its way in, nothing after.
 */
export function partPose(part: Pick<TracePart, 'x' | 'y' | 'w' | 'h' | 'rot' | 't' | 'kind' | 'hero' | 'fall' | 'enter'>, p: number, _secs: number, fall: number): { x: number; y: number; rot: number; lift: number; grow: number } {
  const dr = Math.min(partDrop(part.t, p, part.fall ?? HERO_FALL, part.hero === true && part.kind === 'valve', part.hero === true), 1)
  return { x: part.x + dr * (part.enter?.x ?? 0), y: part.y + dr * (part.enter?.y ?? 0), rot: part.rot, lift: dr * fall, grow: 1 }
}

/** draws every map for film phase p */
/** sun: how far a body's shadow reaches across the board per px of its height, plane px; none keeps every shadow under its body */
export function drawMaps(maps: MapSet, tl: TraceTimeline, p: number, region: Region, lit: { all: number; hero: number }, sun?: { x: number; y: number }): void {
  const s = tl.scene
  const top = begin(maps.top, region)
  const fx = begin(maps.fx, region)
  const warm: Light = { ctx: top, ch: 2 }
  const cool: Light = { ctx: fx, ch: 0 }
  const head: Light = { ctx: fx, ch: 2 }
  const topSide = s.layers.some((l) => l.side === 'F') ? 'F' : (s.layers[s.layers.length - 1]?.side ?? 'F')

  // --- front copper + energy
  drawZones(top, warm, s, topSide, p, region)
  for (const layer of s.layers) {
    if (layer.side === topSide) drawCopperLayer(top, head, warm, cool, layer, s, p, tl.durationSeconds, lit)
  }
  // pads: a dark mark from the first frame; each plates when the routing reaches it
  for (const pad of s.pads) {
    if (pad.side === 'B' && topSide === 'F') continue
    const k = within(p, pad.t, pad.t + PLATE)
    top.save()
    top.translate(pad.x, pad.y)
    top.rotate(pad.rot)
    padPath(top, pad.w, pad.h, pad.shape)
    const style = k > 0 ? `rgba(255,255,0,${k.toFixed(4)})` : ink(0, GHOST)
    if (pad.ring === true) {
      top.lineWidth = 1.6
      top.strokeStyle = style
      top.stroke()
    } else {
      top.fillStyle = style
      top.fill()
    }
    top.restore()
  }
  // a drill through one of the main chip's own pads (thermal vias in its exposed pad) stays an open hole in that copper
  const exposed = s.pads.filter((pad) => pad.hero === true && pad.ring !== true)
  top.save()
  top.globalCompositeOperation = 'destination-out'
  for (const d of s.drills) {
    if (!exposed.some((pad) => d.r < 0.5 * Math.min(pad.w, pad.h) && Math.abs((d.x - pad.x) * Math.cos(pad.rot) + (d.y - pad.y) * Math.sin(pad.rot)) < pad.w / 2 && Math.abs(-(d.x - pad.x) * Math.sin(pad.rot) + (d.y - pad.y) * Math.cos(pad.rot)) < pad.h / 2)) continue
    top.beginPath()
    top.arc(d.x, d.y, d.r, 0, Math.PI * 2)
    top.fill()
  }
  top.restore()
  // the hero wakes as the rails reach it: its own pins light, flaring once, then hold a warm glow
  const wake = s.wake ?? s.acts.power[0] + WAKE
  const hero = s.parts.find((pt) => pt.hero === true && pt.kind !== 'valve')
  if (p >= wake && hero !== undefined) {
    // the first sign of power: light escaping from under the package onto the mask round it, then settling
    const k = s.power !== 'leds' ? 0 : within(p, wake, wake + 5 / 360) * (0.22 + 0.33 * Math.exp(-Math.max(0, p - wake - 5 / 360) / (12 / 360)))
    top.save()
    top.translate(hero.x, hero.y)
    top.rotate(hero.rot)
    top.fillStyle = ink(2, k)
    top.fillRect(-hero.w * 0.56, -hero.h * 0.56, hero.w * 1.12, hero.h * 1.12)
    top.restore()
    // and one white-hot point at the supply pin: where the hero's earliest-lit supply copper starts
    let pin: [number, number] | undefined
    let first = Infinity
    for (const layer of s.layers) {
      for (let i = 0; i < layer.segs.length / 7; i++) {
        const e0 = layer.energy[i * 2] as number
        const grp = s.groups[layer.groups[i] as number]
        if (e0 < 0 || grp?.kind !== 'power' || grp.hero !== true || e0 >= first) continue
        first = e0
        pin = [layer.segs[i * 7] as number, layer.segs[i * 7 + 1] as number]
      }
    }
    if (pin !== undefined) {
      const r = 0.06 * Math.max(hero.w, hero.h)
      const a = s.power === 'lamps' ? 0 : within(p, wake, wake + 2 / 360) * ((s.power === 'pulse' ? 0 : 0.35) + 0.65 * Math.exp(-Math.max(0, p - wake - 6 / 360) / (10 / 360)))
      const glow = fx.createRadialGradient(pin[0], pin[1], 0, pin[0], pin[1], r)
      glow.addColorStop(0, ink(2, a))
      glow.addColorStop(1, ink(2, 0))
      fx.fillStyle = glow
      fx.beginPath()
      fx.arc(pin[0], pin[1], r, 0, Math.PI * 2)
      fx.fill()
    }
  }
  if (p >= wake) {
    const k = s.power === 'pulse' || s.power === 'lamps' ? 0 : s.power === 'routes' ? 0.2 * within(p, wake, wake + 0.03) : (0.35 + 0.3 * Math.max(0, 1 - (p - wake) / 0.04)) * within(p, wake, wake + 0.02)
    top.fillStyle = ink(2, k)
    for (const pad of s.pads) {
      if (pad.hero !== true) continue
      top.save()
      top.translate(pad.x, pad.y)
      top.rotate(pad.rot)
      padPath(top, pad.w * 1.15, pad.h * 1.15, pad.shape)
      top.fill()
      top.restore()
    }
  }
  if (s.sign?.kind === 'pins' && p >= s.sign.t) {
    top.fillStyle = ink(2, 0.6 * within(p, s.sign.t, s.sign.t + 0.02))
    for (const pad of s.sign.pads) {
      const own = s.pads.find((q) => Math.abs(q.x - pad.x) < 1 && Math.abs(q.y - pad.y) < 1)
      if (own?.side === 'B' && topSide === 'F') continue
      top.beginPath()
      top.arc(pad.x, pad.y, pad.w * 0.6, 0, Math.PI * 2)
      top.fill()
    }
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
    const drop = partDrop(part.t, p, part.fall ?? HERO_FALL, part.hero === true && part.kind === 'valve', part.hero === true)
    if (drop > 1) continue
    const k = (1 - drop) * Math.min(1, 0.35 + part.z / 30) * (part.kind === 'valve' ? 0.2 : 1)
    const lift = 0.5 * drop * Math.max(part.w, part.h)
    const spread = sun === undefined ? 0 : Math.min(1, Math.hypot(sun.x, sun.y))
    const reach = sun === undefined ? 0 : Math.min(40, Math.max(4, Math.ceil((Math.hypot(sun.x, sun.y) * part.z) / 1.5)))
    for (let j = reach; j >= 0; j--) {
      const cast = reach === 0 ? 0 : (j / reach) * part.z
      fx.save()
      fx.translate(part.x + drop * (part.enter?.x ?? 0) + 0.45 * lift + (sun?.x ?? 0) * cast, part.y + drop * (part.enter?.y ?? 0) + 0.6 * lift + (sun?.y ?? 0) * cast)
      fx.rotate(part.rot)
      const step = j === reach ? 0 : part.z / reach
      const ex = step * (Math.cos(part.rot) * (sun?.x ?? 0) + Math.sin(part.rot) * (sun?.y ?? 0))
      const ey = step * (Math.cos(part.rot) * (sun?.y ?? 0) - Math.sin(part.rot) * (sun?.x ?? 0))
      const sx = ex >= 0 ? 1 : -1
      const sy = ey >= 0 ? 1 : -1
      for (const [grow, a] of [[1.35, 0.14], [1.12, 0.3], [1.0, 0.85]] as const) {
        const pad = Math.min(part.w, part.h) * (grow - 1) + part.z * (grow - 1) * 0.6 * (1 + 0.5 * spread * (j / Math.max(1, reach)))
        const hw = part.w / 2 + pad
        const hh = part.h / 2 + pad
        fx.fillStyle = `rgb(0,${Math.round(255 * a * k * (1 - 0.35 * (j / Math.max(1, reach))))},0)`
        fx.beginPath()
        fx.moveTo(-sx * hw, -sy * hh)
        fx.lineTo(sx * hw, -sy * hh)
        fx.lineTo(sx * hw + ex, -sy * hh + ey)
        fx.lineTo(sx * hw + ex, sy * hh + ey)
        fx.lineTo(-sx * hw + ex, sy * hh + ey)
        fx.lineTo(-sx * hw, sy * hh)
        fx.closePath()
        fx.fill()
      }
      fx.restore()
    }
  }
  fx.globalCompositeOperation = 'lighter'
  // power-on peaks on the hero: its pins burn for two beats, then settle to an ember; each pin keeps its own shape, so they stay legible
  const since = (p - wake) * 24
  const flare = since < 0 ? 0 : Math.min(1, since / 0.5) * (s.power === 'pulse' || s.power === 'lamps' ? 0 : 0.1 + 0.45 * Math.exp(-Math.max(0, since - 2) / 1.0))
  if (flare > 0.01) {
    fx.fillStyle = ink(2, flare)
    for (const pad of s.pads) {
      if (pad.hero !== true) continue
      fx.save()
      fx.translate(pad.x, pad.y)
      fx.rotate(pad.rot)
      padPath(fx, pad.w * 1.05, pad.h * 1.05, pad.shape)
      fx.fill()
      fx.restore()
    }
  }

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
    const f = ease((p - stroke.t) / 0.012)
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
  surf.textBaseline = 'middle'
  for (const text of s.texts) {
    const k = ease((p - text.t) / 0.012)
    if (k <= 0) continue
    const shown = text.text.substring(0, Math.ceil(text.text.length * k))
    if (shown.length === 0) continue
    surf.save()
    surf.translate(text.x, text.y)
    surf.rotate(text.rot)
    surf.font = `${text.size}px ${FONT}`
    surf.textAlign = text.align ?? 'center'
    const lines = text.text.split('\n')
    const lead = SILK_LEAD * text.size
    const top = text.valign === 'top' ? 0 : text.valign === 'bottom' ? -(lines.length - 1) * lead : -0.5 * (lines.length - 1) * lead
    let left = shown.length
    lines.forEach((line, i) => {
      if (left > 0) surf.fillText(line.substring(0, left), 0, top + i * lead)
      left -= line.length + 1
    })
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
