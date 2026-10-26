import type { CameraKey, FlatPath, TraceTimeline } from '@silk-reel/choreo'
import { FONT } from './font'
import { drawTitle } from './title'

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}
const within = (p: number, span: readonly [number, number]): number => ease((p - span[0]) / (span[1] - span[0]))

const pathLength = (path: FlatPath): number => {
  let len = 0
  for (let i = 2; i + 1 < path.length; i += 2) {
    len += Math.hypot((path[i] as number) - (path[i - 2] as number), (path[i + 1] as number) - (path[i - 1] as number))
  }
  return len
}

const tracePath = (ctx: CanvasRenderingContext2D, path: FlatPath): void => {
  ctx.beginPath()
  ctx.moveTo(path[0] as number, path[1] as number)
  for (let i = 2; i + 1 < path.length; i += 2) ctx.lineTo(path[i] as number, path[i + 1] as number)
}

const OUTLINE_HEADS = 8

/** the point `frac` of the way along a polyline */
const pointAt = (path: FlatPath, frac: number): [number, number] => {
  let rest = Math.max(0, frac) * pathLength(path)
  for (let i = 2; i + 1 < path.length; i += 2) {
    const x0 = path[i - 2] as number
    const y0 = path[i - 1] as number
    const d = Math.hypot((path[i] as number) - x0, (path[i + 1] as number) - y0)
    if (rest <= d && d > 0) return [x0 + ((path[i] as number) - x0) * (rest / d), y0 + ((path[i + 1] as number) - y0) * (rest / d)]
    rest -= d
  }
  return [path[path.length - 2] as number, path[path.length - 1] as number]
}

/** progressive draw: shows the first `frac` of the polyline's length */
const strokeReveal = (ctx: CanvasRenderingContext2D, path: FlatPath, frac: number): void => {
  const len = Math.max(1, pathLength(path))
  tracePath(ctx, path)
  ctx.setLineDash([len])
  ctx.lineDashOffset = len * (1 - Math.min(1, frac))
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

const roundedRect = (ctx: CanvasRenderingContext2D, w: number, h: number, r: number): void => {
  const x = -w / 2
  const y = -h / 2
  const c = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + c, y)
  ctx.lineTo(x + w - c, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + c)
  ctx.lineTo(x + w, y + h - c)
  ctx.quadraticCurveTo(x + w, y + h, x + w - c, y + h)
  ctx.lineTo(x + c, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - c)
  ctx.lineTo(x, y + c)
  ctx.quadraticCurveTo(x, y, x + c, y)
  ctx.closePath()
}

const padPath = (ctx: CanvasRenderingContext2D, w: number, h: number, shape: 'rect' | 'round' | 'circle'): void => {
  if (shape === 'circle') {
    ctx.beginPath()
    ctx.arc(0, 0, Math.max(w, h) / 2, 0, Math.PI * 2)
    return
  }
  if (shape === 'round') {
    roundedRect(ctx, w, h, Math.min(w, h) * 0.32)
    return
  }
  ctx.beginPath()
  ctx.rect(-w / 2, -h / 2, w, h)
}

/** #rrggbb → rgba() string, for gradient stops */
const withAlpha = (hex: string, a: number): string => {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

function sampleCamera(keys: CameraKey[], p: number, W: number, H: number): Omit<CameraKey, 't'> {
  const first = keys[0]
  if (first === undefined) return { cx: W / 2, cy: H / 2, zoom: 1 }
  let k = 0
  while (k + 1 < keys.length && (keys[k + 1] as CameraKey).t <= p) k++
  const a = keys[k] as CameraKey
  const b = keys[k + 1] ?? a
  // zoom moves ease in and out; tracking keys at one zoom glide at constant
  // speed so the camera doesn't stop at every key
  const v = b.t > a.t ? (p - a.t) / (b.t - a.t) : 0
  const u = a.zoom === b.zoom ? v : ease(v)
  return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u, zoom: a.zoom + (b.zoom - a.zoom) * u }
}

/** first seg index (stride 7) with t0 > p — segs are sorted by t0 */
const liveSegs = (segs: number[], p: number): number => {
  let lo = 0
  let hi = segs.length / 7
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((segs[mid * 7 + 5] as number) <= p) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function drawTraceFrame(ctx: CanvasRenderingContext2D, tl: TraceTimeline, frame: number): number {
  const { scene: s, palette: pal, width: W, height: H } = tl
  const p = frame / tl.totalFrames
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (tl.transparent) ctx.clearRect(0, 0, W, H)
  else {
    ctx.fillStyle = pal.bg
    ctx.fillRect(0, 0, W, H)
  }
  const cam = sampleCamera(s.camera, p, W, H)
  ctx.save()
  ctx.translate(W / 2, H / 2)
  ctx.scale(cam.zoom, cam.zoom)
  ctx.translate(-cam.cx, -cam.cy)
  ctx.globalAlpha = 1
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  let drawn = 0

  // 1 outline — dash reveal completing by p=0.07 so the hook lands fast
  const outlineFrac = within(p, [s.beats.outline[0], s.beats.outline[0] + 0.07])
  if (outlineFrac > 0) {
    ctx.strokeStyle = pal.silk
    ctx.lineWidth = 1.5
    ctx.globalAlpha = 0.7
    for (const path of s.outline) {
      strokeReveal(ctx, path, outlineFrac)
      drawn += 1
    }
    // a head rides the tips of the longest strokes so the first half-second has
    // a focal point; cutouts and short edges would turn it into confetti
    if (outlineFrac < 1) {
      ctx.fillStyle = pal.head
      ctx.globalAlpha = 1
      for (const path of [...s.outline].sort((a, b) => pathLength(b) - pathLength(a)).slice(0, OUTLINE_HEADS)) {
        const [x, y] = pointAt(path, outlineFrac)
        ctx.beginPath()
        ctx.arc(x, y, 4.5, 0, Math.PI * 2)
        ctx.fill()
        drawn += 1
      }
    }
  }

  // 1b drill hits — a faint hole constellation fading in with the outline,
  // persisting as texture under the copper
  const drillAlpha = 0.3 * outlineFrac
  if (drillAlpha > 0.001) {
    ctx.fillStyle = pal.copperDim
    ctx.globalAlpha = drillAlpha
    for (const d of s.drills) {
      ctx.beginPath()
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
      ctx.fill()
      drawn += 1
    }
  }

  // 2 zones — radial wipe clip from the growth origin, low alpha
  for (const zone of s.zones) {
    const frac = within(p, [zone.t0, zone.t1])
    if (frac <= 0) continue
    const r = frac * Math.hypot(W, H)
    ctx.save()
    ctx.beginPath()
    ctx.arc(s.origin.x, s.origin.y, r, 0, Math.PI * 2)
    ctx.clip()
    // pours are texture, not subject — stacked sides at higher alpha turned
    // whole boards into amber mush and killed copper contrast
    tracePath(ctx, zone.fill)
    ctx.fillStyle = pal.copperDim
    ctx.globalAlpha = (zone.side === 'F' ? 0.07 : 0.035)
    ctx.fill()
    ctx.strokeStyle = pal.copperDim
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.2
    ctx.stroke()
    ctx.restore()
    drawn += 1
  }

  // 3 copper layers back -> front; complete segs batched per rounded width,
  // growing segs stroked to their lerp point with a head queued behind them
  // layers run inner -> B -> F, so the last is the topmost — on boards with no
  // F copper the top present side is promoted to the hero color, not dimmed
  const topSide = s.layers.some((l) => l.side === 'F') ? 'F' : (s.layers[s.layers.length - 1]?.side ?? 'F')
  // dense boards smear when every growing seg carries a glowing head — cap to
  // the ones whose seg length clears the 60th percentile
  const segLens: number[] = []
  for (const layer of s.layers) {
    for (let i = 0; i + 3 < layer.segs.length; i += 7) {
      segLens.push(Math.hypot((layer.segs[i + 2] as number) - (layer.segs[i] as number), (layer.segs[i + 3] as number) - (layer.segs[i + 1] as number)))
    }
  }
  segLens.sort((a, b) => a - b)
  const headMinLen = segLens[Math.floor(segLens.length * 0.6)] ?? 0
  const heads: Array<{ x: number; y: number; w: number; tx: number; ty: number; len: number }> = []
  for (const layer of s.layers) {
    const front = layer.side === topSide
    ctx.strokeStyle = front ? pal.copper : pal.copperDim
    const segs = layer.segs
    const n = liveSegs(segs, p)
    const batches = new Map<number, Path2D>()
    for (let i = 0; i < n; i++) {
      const o = i * 7
      const x0 = segs[o] as number
      const y0 = segs[o + 1] as number
      const x1 = segs[o + 2] as number
      const y1 = segs[o + 3] as number
      const w = segs[o + 4] as number
      const t0 = segs[o + 5] as number
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
        drawn += 1
        continue
      }
      const frac = (p - t0) / Math.max(1e-6, t1 - t0)
      const hx = x0 + (x1 - x0) * frac
      const hy = y0 + (y1 - y0) * frac
      ctx.globalAlpha = (front ? 1 : 0.45)
      ctx.lineWidth = w
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(hx, hy)
      ctx.stroke()
      const segLenPx = Math.hypot(x1 - x0, y1 - y0)
      if (segLenPx >= headMinLen) {
        // a streak reads as motion: the last 30% of the seg trails the head
        const tf = Math.max(0, frac - 0.3)
        heads.push({ x: hx, y: hy, w, tx: x0 + (x1 - x0) * tf, ty: y0 + (y1 - y0) * tf, len: segLenPx })
      }
      drawn += 1
    }
    ctx.globalAlpha = (front ? 1 : 0.45)
    for (const [w, path] of batches) {
      ctx.lineWidth = w
      ctx.stroke(path)
    }
  }

  // 4 growth heads — bright dots the post pass will bloom, capped so dense
  // boards read as a wavefront, not confetti; each head drags a fading tail
  if (heads.length > 0) {
    heads.sort((a, b) => b.len - a.len)
    for (const head of heads.slice(0, 80)) {
      const grad = ctx.createLinearGradient(head.tx, head.ty, head.x, head.y)
      grad.addColorStop(0, withAlpha(pal.head, 0))
      grad.addColorStop(1, withAlpha(pal.head, 0.9))
      ctx.strokeStyle = grad
      ctx.lineWidth = head.w * 2
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.moveTo(head.tx, head.ty)
      ctx.lineTo(head.x, head.y)
      ctx.stroke()
      drawn += 1
    }
    ctx.fillStyle = pal.head
    ctx.globalAlpha = 1
    for (const head of heads.slice(0, 80)) {
      ctx.beginPath()
      ctx.arc(head.x, head.y, Math.max(2, head.w * 1.3), 0, Math.PI * 2)
      ctx.fill()
      drawn += 1
    }
  }

  // 5 vias — copper ring once reached, plus a head-colored flash just after
  for (const via of s.vias) {
    if (p < via.t) continue
    ctx.strokeStyle = pal.copper
    ctx.lineWidth = Math.max(0.8, via.r * 0.35)
    ctx.globalAlpha = 0.8
    ctx.beginPath()
    ctx.arc(via.x, via.y, via.r, 0, Math.PI * 2)
    ctx.stroke()
    drawn += 1
    const flash = 1 - (p - via.t) / 0.03
    if (flash > 0) {
      ctx.strokeStyle = pal.head
      ctx.globalAlpha = flash
      ctx.beginPath()
      ctx.arc(via.x, via.y, via.r * 1.4, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // 6 pads — pop in with a slight overshoot
  for (const pad of s.pads) {
    if (p < pad.t) continue
    const k = ease((p - pad.t) / 0.02)
    const scale = k < 0.7 ? 0.6 + 0.48 * (k / 0.7) : 1.08 - 0.08 * ((k - 0.7) / 0.3)
    ctx.save()
    ctx.translate(pad.x, pad.y)
    ctx.rotate(pad.rot)
    ctx.scale(scale, scale)
    padPath(ctx, pad.w, pad.h, pad.shape)
    if (pad.ring === true) {
      // mounting holes and big pads are rings — a filled blob would dominate
      // the frame and ride over the bloom threshold
      ctx.strokeStyle = pad.side === 'B' ? pal.copperDim : pal.copper
      ctx.lineWidth = 1.5
      ctx.globalAlpha = (pad.side === 'B' ? 0.55 : 0.85)
      ctx.stroke()
    } else {
      ctx.fillStyle = pad.side === 'B' ? pal.copperDim : pal.copper
      ctx.globalAlpha = (pad.side === 'B' ? 0.55 : 0.85)
      ctx.fill()
    }
    if (k < 1) {
      ctx.strokeStyle = pal.head
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.5 * (1 - k)
      ctx.stroke()
    }
    ctx.restore()
    drawn += 1
  }

  // 7 silkscreen strokes — quick dash reveal, top to bottom; kept dim and
  // thin so the hold reads as copper, not whiteout
  // finished strokes share one path: hatched fills (polarity marks) stack
  // dozens of overlapping lines that would otherwise add up to solid white
  ctx.strokeStyle = pal.silk
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.45
  const silkDone = new Path2D()
  let silkDoneCount = 0
  for (const stroke of s.silkStrokes) {
    const frac = ease((p - stroke.t) / 0.03)
    if (frac <= 0) continue
    if (frac >= 1) {
      silkDoneCount += 1
      silkDone.moveTo(stroke.path[0] as number, stroke.path[1] as number)
      for (let i = 2; i + 1 < stroke.path.length; i += 2) silkDone.lineTo(stroke.path[i] as number, stroke.path[i + 1] as number)
    } else strokeReveal(ctx, stroke.path, frac)
    drawn += 1
  }
  if (silkDoneCount > 0) ctx.stroke(silkDone)

  // 8 labels — type on inside the silk beat
  ctx.fillStyle = pal.silk
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const text of s.texts) {
    const k = ease((p - text.t) / 0.025)
    if (k <= 0) continue
    const shown = text.text.substring(0, Math.ceil(text.text.length * k))
    if (shown.length === 0) continue
    ctx.save()
    ctx.translate(text.x, text.y)
    ctx.rotate(text.rot)
    ctx.font = `${text.size}px ${FONT}`
    ctx.globalAlpha = 0.7
    ctx.fillText(shown, 0, 0)
    ctx.restore()
    drawn += 1
  }

  // 9 glint — a light band sweeps corner to corner once, early in the hold
  // (~1.2s), clipped to the copper by stroking the complete F segments
  const [h0, h1] = s.beats.hold
  const glintSpan = Math.min(h1 - h0, 1.2 / tl.durationSeconds)
  if (p >= h0 && p <= h0 + glintSpan + 0.02) {
    const g = Math.min(1, (p - h0) / glintSpan)
    const diag = Math.hypot(W, H)
    const ux = W / diag
    const uy = H / diag
    const band = 0.11 * W
    const c = (-0.15 + 1.3 * g) * diag
    const cx = ux * c
    const cy = uy * c
    const gradient = ctx.createLinearGradient(cx - ux * band, cy - uy * band, cx + ux * band, cy + uy * band)
    gradient.addColorStop(0, 'rgba(0,0,0,0)')
    gradient.addColorStop(0.5, pal.head)
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.25
    ctx.strokeStyle = gradient
    for (const layer of s.layers) {
      if (layer.side !== topSide) continue
      const segs = layer.segs
      const n = liveSegs(segs, p)
      const batches = new Map<number, Path2D>()
      for (let i = 0; i < n; i++) {
        const o = i * 7
        if ((segs[o + 6] as number) > p) continue
        const key = Math.round((segs[o + 4] as number) * 4) / 4
        let path = batches.get(key)
        if (path === undefined) {
          path = new Path2D()
          batches.set(key, path)
        }
        path.moveTo(segs[o] as number, segs[o + 1] as number)
        path.lineTo(segs[o + 2] as number, segs[o + 3] as number)
      }
      for (const [w, path] of batches) {
        ctx.lineWidth = w
        ctx.stroke(path)
      }
    }
    ctx.restore()
  }

  ctx.restore()

  // 10 title card — screen space, after the camera transform is popped
  drawTitle(ctx, tl, p, 1)
  return drawn
}
