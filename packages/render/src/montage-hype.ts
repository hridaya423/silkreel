import { bodyOutline, DIM_LABEL, drawnBody, measuredBox, makeCam, PRINT_BAND, printBand, project, sampleShot, printKept, silkBox, silkInBand, silkWhole } from '@silk-reel/choreo'
import type { Cam, HypeCut, KeptKind, HypeDims, HypeFrame, HypeLook, HypeWord, MontageScore, TraceTimeline } from '@silk-reel/choreo'
import { createTraceGL, markingLines } from './trace-gl'
import type { TraceGL, TraceQuality } from './trace-gl'
import { createTreat } from './montage-treat'
import type { Treat, TreatOptions } from './montage-treat'
import { advance, CAP, heavy } from './montage-type'
import { drawXray, padOutline } from './montage-xray'

type Ctx = CanvasRenderingContext2D

export interface Hype {
  render(tl: TraceTimeline, frame: number): HTMLCanvasElement
  dispose(): void
}

const INK = '#f3f0ea'
const LINE = '#dfe8f8'
const POOL = { dark: 0.7, hit: { core: 0.3, reach: 0.9 }, end: { core: 0.14, reach: 0.62 } }
/** how much of the lit shot's floor stays under the X-ray of the whole board */
const FLOOR = 0.5
/** the end's highlight: its width as a share of the lid's diagonal */
const GLINT_WIDE = 0.16

const camOf = (h: HypeCut, frame: number, W: number, H: number): Cam => makeCam(sampleShot(h.shots, (h.plan[frame]?.clone ?? 0) / h.total), W, H)

const toScreen = (cam: Cam, W: number, H: number, x: number, y: number, z = 0): { x: number; y: number } => {
  const q = project(cam, x, y, z)
  return { x: ((q.x + 1) / 2) * W, y: ((1 - q.y) / 2) * H }
}

const shadeWalls = (ctx: Ctx, cam: Cam, board: number[][], thick: number, W: number, H: number): void => {
  const outer = board.reduce<number[]>((a, l) => (l.length > a.length ? l : a), [])
  ctx.save()
  ctx.fillStyle = '#050505'
  for (const loop of board) {
  const n = loop.length / 2
  let area = 0
  for (let i = 0; i < n; i++) area += (loop[2 * i] as number) * (loop[(2 * i + 3) % loop.length] as number) - (loop[(2 * i + 2) % loop.length] as number) * (loop[2 * i + 1] as number)
  const sign = Math.sign(area) * (loop === outer ? 1 : -1)
  for (let i = 0; i < n; i++) {
    const x0 = loop[2 * i] as number
    const y0 = loop[2 * i + 1] as number
    const x1 = loop[(2 * i + 2) % loop.length] as number
    const y1 = loop[(2 * i + 3) % loop.length] as number
    const nx = sign * (y1 - y0)
    const ny = -sign * (x1 - x0)
    if ((cam.pos[0] - (x0 + x1) / 2) * nx + (-cam.pos[1] - (y0 + y1) / 2) * ny <= 0) continue
    const q = [project(cam, x0, y0, 0.5), project(cam, x1, y1, 0.5), project(cam, x1, y1, -thick - 1), project(cam, x0, y0, -thick - 1)]
    if (q.some((p) => p.w <= 0)) continue
    ctx.beginPath()
    for (const p of q) ctx.lineTo(((p.x + 1) / 2) * W, ((1 - p.y) / 2) * H)
    ctx.closePath()
    ctx.fill()
  }
  }
  ctx.restore()
}

const grain = (() => {
  let noise: HTMLCanvasElement | undefined
  return (): HTMLCanvasElement => {
    if (noise !== undefined) return noise
    const n = document.createElement('canvas')
    n.width = 384
    n.height = 384
    const c = n.getContext('2d') as Ctx
    const img = c.createImageData(384, 384)
    let s = 7
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const v = 70 + ((s >> 8) % 116)
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    c.putImageData(img, 0, 0)
    noise = n
    return n
  }
})()

/** the draw shot grades the lit image hot: a channel clips from about 75 of 255, and a pixel whose smallest channel clips turns paper white. So the raw image first rolls off its smallest channel above DRAW_KNEE towards DRAW_TOP on a log curve, and scales the pixel's other channels with it, leaning the hotter it is (up to COPPER_TINT) to copper's own ratio, as a lit metal's highlight takes its colour: copper keeps its colour, a large pad keeps the light's fall across it, and a pixel whose smallest channel is low (gold, red copper) is untouched */
export const DRAW_KNEE = 30
export const COPPER = [1, 0.62, 0.4] as const
export const COPPER_TINT = 0.7
export const DRAW_TOP = 50
const ROLL = 20

export const shoulder = (rgba: Uint8ClampedArray): void => {
  const span = Math.log(1 + (255 - DRAW_KNEE) / ROLL)
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] as number
    const g = rgba[i + 1] as number
    const b = rgba[i + 2] as number
    const m = Math.min(r, g, b)
    if (m <= DRAW_KNEE) continue
    const k = (DRAW_KNEE + ((DRAW_TOP - DRAW_KNEE) * Math.log(1 + (m - DRAW_KNEE) / ROLL)) / span) / m
    const top = Math.max(r, g, b) * k
    const a = COPPER_TINT * (1 - DRAW_KNEE / m)
    rgba[i] = r * k * (1 - a) + COPPER[0] * top * a
    rgba[i + 1] = g * k * (1 - a) + COPPER[1] * top * a
    rgba[i + 2] = b * k * (1 - a) + COPPER[2] * top * a
  }
}

/** in the stop the chip's lit rim leads: every pixel off the ring RIM_RING of the frame's width wide along the chip's drawn outline is held under STOP_LEVEL of the rim's peak and at no more colour (largest less smallest channel) than the rim's own, the median of its pixels at RIM_LIT of its peak or more (the lit line, not the leads beside it), so an LED stays a dim point and nothing out-shines or out-colours the rim */
export const RIM_RING = 0.02
export const STOP_LEVEL = 0.75
export const RIM_LIT = 0.8

export const holdStop = (rgba: Uint8ClampedArray, ring: Uint8ClampedArray): void => {
  const luma = (i: number): number => 0.2126 * (rgba[i] as number) + 0.7152 * (rgba[i + 1] as number) + 0.0722 * (rgba[i + 2] as number)
  const on: number[] = []
  for (let j = 0; j < ring.length; j++) if ((ring[j] as number) >= 128) on.push(luma(4 * j))
  if (on.length === 0) return
  const peak = on.sort((a, b) => a - b)[Math.floor(0.995 * (on.length - 1))] as number
  const lit: number[] = []
  for (let j = 0; j < ring.length; j++) {
    if ((ring[j] as number) < 128 || luma(4 * j) < RIM_LIT * peak) continue
    const i = 4 * j
    lit.push(Math.max(rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number) - Math.min(rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number))
  }
  const colour = lit.length === 0 ? 0 : (lit.sort((a, b) => a - b)[Math.floor(0.5 * (lit.length - 1))] as number)
  const cap = STOP_LEVEL * peak
  for (let j = 0; j < ring.length; j++) {
    const i = 4 * j
    if ((ring[j] as number) >= 128 && luma(i) >= RIM_LIT * peak) continue
    let r = rgba[i] as number
    let g = rgba[i + 1] as number
    let b = rgba[i + 2] as number
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (l > cap) {
      r *= cap / l
      g *= cap / l
      b *= cap / l
    }
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const c = Math.max(r, g, b) - Math.min(r, g, b)
    if (c > colour) {
      const t = colour / c
      r = y + (r - y) * t
      g = y + (g - y) * t
      b = y + (b - y) * t
    }
    rgba[i] = r
    rgba[i + 1] = g
    rgba[i + 2] = b
  }
}

export const gradeBuild = (ctx: Ctx, frame: number, W: number, H: number, grained: boolean): void => {
  ctx.save()
  const v = ctx.createRadialGradient(W / 2, H * 0.48, 0.18 * H, W / 2, H * 0.48, 0.62 * H)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(0,0,0,0.88)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, W, H)
  if (!grained) {
    ctx.restore()
    return
  }
  const n = grain()
  const pat = ctx.createPattern(n, 'repeat') as CanvasPattern
  const ox = ((frame * 137) % 384)
  const oy = ((frame * 251) % 384)
  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = 0.28
  ctx.translate(-ox, -oy)
  ctx.fillStyle = pat
  ctx.fillRect(0, 0, W + 384, H + 384)
  ctx.restore()
}

const hull = (pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (list: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => list.reduce<Array<{ x: number; y: number }>>((h, q) => {
    while (h.length >= 2 && cross(h[h.length - 2] as { x: number; y: number }, h[h.length - 1] as { x: number; y: number }, q) <= 0) h.pop()
    h.push(q)
    return h
  }, [])
  const lo = half(p)
  const hi = half([...p].reverse())
  return [...lo.slice(0, -1), ...hi.slice(0, -1)]
}

/** a print draws the main chip from the body the film draws, not from the lit frame. Its outline is the measured box: the four lines along the box's edges that hold the hull of its model above its leads (which sit below BODY_LOW of its height), drawn as the print's heaviest line, OUTLINE of the frame's width, in OUTLINE_INK. Around it, PRINT_BAND of the frame's width, the paper is clear: nothing of the board is drawn there, and a mark the band's edge would cut is dropped whole when it is no larger than MARK_MOST of the frame's width */
export const OUTLINE = 2.2 / 390
export const OUTLINE_INK = '#f4f7fc'
export const MARK_MOST = 0.12


/** the band round the chip: zone pixels take the paper's own pixel (its tone and grid), and every mark the zone touches that is no larger than most pixels across is taken whole. rgba and paper are row-major rgba bytes, zone one byte a pixel; ink is how far from the paper a pixel must stand to be a mark, and reach how far apart two strokes may stand and still be one mark; keep pixels (the silk words) are never cleared */
export function clearBand(rgba: Uint8ClampedArray, paper: Uint8ClampedArray, zone: Uint8ClampedArray, w: number, h: number, most: number, ink = 24, reach = 2, keep?: Uint8ClampedArray): void {
  const n = w * h
  const on = new Uint8Array(n)
  for (let i = 0; i < n; i++) on[i] = Math.max(...[0, 1, 2].map((c) => Math.abs((rgba[4 * i + c] as number) - (paper[4 * i + c] as number)))) > ink ? 1 : 0
  const near = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (on[y * w + x] === 0) continue
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1
      }
    }
  }
  const group = new Int32Array(n).fill(-1)
  const take: boolean[] = []
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (near[i] === 0 || group[i] !== -1) continue
    const g = take.length
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    let touched = false
    group[i] = g
    stack.push(i)
    while (stack.length > 0) {
      const j = stack.pop() as number
      const x = j % w
      const y = (j - x) / w
      if (on[j] === 1) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
        if ((zone[j] as number) >= 128) touched = true
      }
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= n || (Math.abs((k % w) - x) > 1) || near[k] === 0 || group[k] !== -1) continue
        group[k] = g
        stack.push(k)
      }
    }
    take.push(touched && Math.max(x1 - x0, y1 - y0) + 1 <= most)
  }
  for (let i = 0; i < n; i++) {
    if ((keep?.[i] ?? 0) >= 128 || ((zone[i] as number) < 128 && !(on[i] === 1 && take[group[i] as number] === true))) continue
    for (let c = 0; c < 4; c++) rgba[4 * i + c] = paper[4 * i + c] as number
  }
}

/** what a print keeps of the board (printKept) is kept this far, as a share of the frame's width, past its outline, so an edge's own glow stays with it */
export const KEEP_GROW = 3 / 390

/** beside the outline the paper is clear this far, as a share of the frame's width, so the chip's own edges never show through a kept word's box; a part, pad or silk stroke that reaches into this strip or under the body is cleared whole instead, so it is drawn whole or not at all. A silk word whole in the frame is drawn unless its letters (core) lie under the body or across the outline's own stroke, and its letters are drawn again after the strip is cleared, so the strip never cuts a word; a silk stroke wholly inside the band is the chip's own drawing (its silk outline, its pin mark) and goes too, so the one heavy outline stands alone */
export const OUTLINE_CLEAR = 6 / 390

export const fillKept = (ctx: Ctx, zone: Ctx, kept: Array<{ shape: Array<[number, number]>; kind: KeptKind; core?: Array<[number, number]> | undefined }>, box: Array<{ x: number; y: number }>, W: number): void => {
  const mid = { x: box.reduce((a, p) => a + p.x, 0) / box.length, y: box.reduce((a, p) => a + p.y, 0) / box.length }
  const within = (reach: number) => ([x, y]: [number, number]): boolean => box.every((p, k) => {
    const q = box[(k + 1) % box.length] as { x: number; y: number }
    const l = Math.max(1e-9, Math.hypot(q.x - p.x, q.y - p.y))
    const out = ((x - p.x) * (q.y - p.y) - (y - p.y) * (q.x - p.x)) / l
    const toward = ((mid.x - p.x) * (q.y - p.y) - (mid.y - p.y) * (q.x - p.x)) / l
    return Math.sign(toward) * out >= -reach * W
  })
  const along = (c: Array<[number, number]>, closed: boolean): Array<[number, number]> => c.flatMap((p, i): Array<[number, number]> => {
    const q = c[(i + 1) % c.length] as [number, number]
    return !closed && i === c.length - 1 ? [p] : Array.from({ length: 16 }, (_, k): [number, number] => [p[0] + ((q[0] - p[0]) * k) / 16, p[1] + ((q[1] - p[1]) * k) / 16])
  })
  ctx.save()
  zone.save()
  for (const c of [ctx, zone]) {
    c.fillStyle = '#fff'
    c.strokeStyle = '#fff'
    c.lineJoin = 'round'
    c.lineWidth = 2 * KEEP_GROW * W
  }
  const words: Array<Array<[number, number]>> = []
  for (const { shape, kind, core } of kept) {
    const into = (kind === 'word' ? along(core ?? shape, true).some(within(OUTLINE / 2)) : along(shape, kind !== 'stroke').some(within(OUTLINE_CLEAR + KEEP_GROW)) || (kind === 'stroke' && along(shape, false).every(within(PRINT_BAND)))) ? zone : ctx
    if (kind === 'word' && into === ctx) words.push(core ?? shape)
    into.beginPath()
    for (const [x, y] of shape) into.lineTo(x, y)
    if (kind !== 'stroke') {
      into.closePath()
      into.fill()
    }
    into.stroke()
  }
  zone.restore()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineWidth = 2 * OUTLINE_CLEAR * W
  ctx.beginPath()
  for (const p of box) ctx.lineTo(p.x, p.y)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.globalCompositeOperation = 'source-over'
  ctx.lineWidth = 2 * KEEP_GROW * W
  for (const core of words) {
    ctx.beginPath()
    for (const [x, y] of core) ctx.lineTo(x, y)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

/** in a print, the main chip's pads are drawn from the board after the band is cleared, in the print's own mark ink (the level of the neighbouring parts' marks), PAD_LINE of the frame's width: 1.1 px on a 390 px phone, under the outline's 2.2 */
export const PAD_LINE = 1.1 / 390

export const drawPads = (ctx: Ctx, pads: TraceTimeline['scene']['pads'], cam: Cam, W: number, H: number, ink: { light: string }): void => {
  ctx.save()
  ctx.strokeStyle = ink.light
  ctx.lineJoin = 'miter'
  ctx.lineWidth = PAD_LINE * W
  ctx.beginPath()
  for (const p of pads) {
    const pts = padOutline(p).map(([x, y]) => toScreen(cam, W, H, x, y))
    for (const [i, q] of pts.entries()) {
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    }
    ctx.closePath()
  }
  ctx.stroke()
  ctx.restore()
}

export const drawBody = (ctx: Ctx, box: Array<{ x: number; y: number }>, W: number, ink: { dark: string }): void => {
  ctx.save()
  ctx.fillStyle = ink.dark
  ctx.strokeStyle = OUTLINE_INK
  ctx.lineJoin = 'miter'
  ctx.lineWidth = OUTLINE * W
  ctx.beginPath()
  for (const p of box) ctx.lineTo(p.x, p.y)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

const LOOK: Record<Exclude<HypeLook, 'lit' | 'xray'>, Omit<TreatOptions, 'stream' | 'seed' | 'progress' | 'invert'>> = {
  dither: { kind: 'dither', cell: 4, dark: '#07080a', light: '#6d7682', gain: 0.8 },
  dots: { kind: 'dots', cell: 10, dark: '#07080a', light: '#7a8490', gain: 0.75 },
  ascii: { kind: 'ascii', cell: 13, dark: '#07080a', light: '#9aa3ae', gain: 1.3 },
  blueprint: { kind: 'blueprint', cell: 2, dark: '#071633', light: '#c9dbf7', gain: 1.6 }
}

/** the measured box closes on the chip from outside; within SNAP of the frame's width it stands on the outline */
export const SNAP = 0.006

export const drawDims = (ctx: Ctx, d: HypeDims, c: Array<{ x: number; y: number }>, frame: number, W: number, H: number): void => {
  const u = Math.min(1, Math.max(0, (frame - d.at) / 34))
  const close = 1 - (1 - u) ** 3
  const cx = c.reduce((a, p) => a + p.x, 0) / c.length
  const cy = c.reduce((a, p) => a + p.y, 0) / c.length
  const font = DIM_LABEL.size * Math.min(W, H)
  ctx.save()
  ctx.strokeStyle = LINE
  ctx.fillStyle = LINE
  ctx.lineWidth = Math.max(1.5, 0.0016 * W)
  ctx.globalAlpha = 0.25 + 0.75 * close
  const reach = Math.hypot(W, H)
  const slide = (1 - close) * 0.35 * W
  const off = slide < SNAP * W ? 0 : slide
  for (let i = 0; i < 4; i++) {
    const a = c[i] as { x: number; y: number }
    const b = c[(i + 1) % 4] as { x: number; y: number }
    const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
    const tx = (b.x - a.x) / len
    const ty = (b.y - a.y) / len
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const nl = Math.max(1, Math.hypot(mx - cx, my - cy))
    const ox = ((mx - cx) / nl) * off
    const oy = ((my - cy) / nl) * off
    ctx.beginPath()
    ctx.moveTo(a.x + ox - tx * reach, a.y + oy - ty * reach)
    ctx.lineTo(a.x + ox + tx * reach, a.y + oy + ty * reach)
    ctx.stroke()
    const at = i < 2 ? d.shift[i] ?? null : null
    if (at !== null) {
      const gap = DIM_LABEL.gap * W
      const lx = mx + tx * at.along * len + ((mx - cx) / nl) * (gap + at.out * font) + ox
      const ly = my + ty * at.along * len + ((my - cy) / nl) * (gap + at.out * font) + oy
      ctx.beginPath()
      ctx.moveTo(a.x + ((mx - cx) / nl) * gap * 0.6 + ox, a.y + ((my - cy) / nl) * gap * 0.6 + oy)
      ctx.lineTo(b.x + ((mx - cx) / nl) * gap * 0.6 + ox, b.y + ((my - cy) / nl) * gap * 0.6 + oy)
      ctx.stroke()
      ctx.save()
      ctx.translate(lx, ly)
      ctx.rotate(Math.atan2(ty, tx) + (tx < 0 ? Math.PI : 0))
      ctx.font = `300 ${Math.round(font)}px "SilkGrotesk", "Helvetica Neue", Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(d.labels[i] ?? '', 0, 0)
      ctx.restore()
    }
  }
  for (const p of c) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, 0.006 * W, 0, 2 * Math.PI)
    ctx.stroke()
  }
  ctx.restore()
}

interface Seated { right: number; top: number }

/** how much brighter or darker than the ground just above it a covering part must stand at its top edge for a viewer to see it */
export const SEEN_EDGE = 0.06

/** the columns of a name's box where the part covering it has no edge a viewer can see against the ground: there the name stands in front. cover and luma are row-major, w by h, 0..1 */
export function unseenColumns(cover: Float32Array, luma: Float32Array, w: number, h: number): boolean[] {
  return Array.from({ length: w }, (_, x) => {
    let top = -1
    for (let y = 0; y < h; y++) {
      if ((cover[y * w + x] as number) > 0.5) {
        top = y
        break
      }
    }
    if (top < 0) return false
    const mean = (from: number, to: number): number => {
      let sum = 0
      let n = 0
      for (let y = Math.max(0, from); y < Math.min(h, to); y++) {
        sum += luma[y * w + x] as number
        n++
      }
      return n === 0 ? NaN : sum / n
    }
    const part = mean(top + 1, top + 4)
    const ground = mean(top - 4, top - 1)
    return Number.isNaN(ground) || Number.isNaN(part) ? false : Math.abs(part - ground) < SEEN_EDGE
  })
}

/** a size line inside the chip stands at the measured box's centre at its own size, made smaller only where it would not fit: its width within INSIDE_FIT of the body's narrowest span */
export const INSIDE_FIT = 0.8

export const insideAt = (box: Array<{ x: number; y: number }>, width: number, height: number): { x: number; y: number; scale: number } => {
  const c = { x: box.reduce((a, p) => a + p.x, 0) / box.length, y: box.reduce((a, p) => a + p.y, 0) / box.length }
  const span = Math.min(...box.map((p, k) => {
    const q = box[(k + 1) % box.length] as { x: number; y: number }
    return (2 * Math.abs((q.x - p.x) * (c.y - p.y) - (q.y - p.y) * (c.x - p.x))) / Math.max(1e-9, Math.hypot(q.x - p.x, q.y - p.y))
  }))
  return { ...c, scale: Math.min(1, (INSIDE_FIT * span) / Math.max(1e-9, width), (0.5 * span) / Math.max(1e-9, height)) }
}

/** where the lit marking's first line stands on the main chip's lid, as a board point: the marking is centred on the lid along its long side, its lines laid out as the marking atlas lays them (CELL_W by CELL_H cells, 600-weight monospace at most 34 px, lines 1.15 sizes apart), the cell spanning MARK_SPAN of the long side, turned half a turn on a turned part */
const CELL = { w: 256, h: 128, px: 34, span: 0.78 } as const

export const markSpot = (part: Pick<TraceTimeline['scene']['parts'][number], 'x' | 'y' | 'w' | 'h' | 'rot' | 'turn'>, label: string, width100 = (t: string): number => 60 * t.length): [number, number] => {
  const fit = (t: string): number => Math.min(CELL.px, (CELL.px * CELL.w * 0.9) / Math.max(1, (width100(t) * CELL.px) / 100))
  const lines = markingLines(label)
  const size = lines.length === 1 ? fit(label) : Math.min(1.5 * fit(label), ...lines.map(fit), 0.4 * CELL.h)
  const long = Math.max(part.w, part.h)
  const short = Math.min(part.w, part.h)
  const across = Math.min(1, (CELL.span * long) / 2 / short)
  const d = ((-(lines.length - 1) / 2) * 1.15 * size / CELL.h) * across * (part.turn === true ? -1 : 1)
  const c = Math.cos(part.rot)
  const s = Math.sin(part.rot)
  return part.w >= part.h ? [part.x - s * d * part.h, part.y + c * d * part.h] : [part.x - c * d * part.w, part.y - s * d * part.w]
}

/** a print names its chip: the name's centre on the marking's first line, the size line under it; each within INSIDE_FIT of the body's narrowest span, both whole inside the body or the size line goes, and the name too if it alone is not whole. width(px, text) is the text's width at px, measured at 100 px */
export const LABEL_PX = 0.05

export const nameBlock = (box: Array<{ x: number; y: number }>, spot: { x: number; y: number }, width: (px: number, text: string) => number, name: string, namePx: number, size: string, sizePx: number): { name?: { x: number; y: number; px: number }; size?: { x: number; y: number; px: number } } => {
  const c = { x: box.reduce((a, p) => a + p.x, 0) / box.length, y: box.reduce((a, p) => a + p.y, 0) / box.length }
  const span = Math.min(...box.map((p, k) => {
    const q = box[(k + 1) % box.length] as { x: number; y: number }
    return (2 * Math.abs((q.x - p.x) * (c.y - p.y) - (q.y - p.y) * (c.x - p.x))) / Math.max(1e-9, Math.hypot(q.x - p.x, q.y - p.y))
  }))
  const fitPx = (px: number, text: string): number => Math.min(px, (INSIDE_FIT * span * px) / Math.max(1e-9, width(px, text)))
  const inside = (x: number, y: number, w: number, hgt: number): boolean => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([u, v]) => box.every((p, k) => {
    const q = box[(k + 1) % box.length] as { x: number; y: number }
    const px = x + ((u as number) * w) / 2
    const py = y + ((v as number) * hgt) / 2
    return Math.sign((q.x - p.x) * (c.y - p.y) - (q.y - p.y) * (c.x - p.x)) * ((q.x - p.x) * (py - p.y) - (q.y - p.y) * (px - p.x)) >= 0
  }))
  const np = fitPx(namePx, name)
  const sp = Math.min(fitPx(sizePx, size), 0.6 * np)
  const named = { x: spot.x, y: spot.y, px: np }
  const sized = { x: spot.x, y: spot.y + 0.7 * np + 0.55 * sp, px: sp }
  const nameWhole = inside(named.x, named.y, width(np, name), 0.75 * np)
  const sizeWhole = inside(sized.x, sized.y, width(sp, size), 0.75 * sp)
  return { ...(nameWhole ? { name: named } : {}), ...(nameWhole && sizeWhole ? { size: sized } : {}) }
}

const drawWord = (ctx: Ctx, h: HypeCut, board: number[][], w: HypeWord, frame: number, W: number, H: number, layer: Ctx, matte: () => HTMLCanvasElement | undefined, seated?: Seated, box?: Array<{ x: number; y: number }>, hero?: TraceTimeline['scene']['parts'][number]): Seated | undefined => {
  const masked = w.behind === true
  const target = masked ? layer : ctx
  const k = frame - w.f0
  const u = (frame - w.f0) / Math.max(1, w.f1 - w.f0)
  const slam = w.follow !== undefined ? 1 : k === 0 ? 1.18 : k === 1 ? 1.05 : 1
  if (w.small === true) {
    ctx.save()
    const face = (px: number): string => `500 ${Math.round(px)}px "SilkGrotesk", "Helvetica Neue", Arial, sans-serif`
    ctx.font = face(w.size * W)
    const px = w.size * W * (1 + (w.grow ?? 0) * u) * Math.min(1, (0.86 * W) / ctx.measureText(w.text).width)
    ctx.font = face(px)
    let at = { x: w.x * W, y: w.y * H }
    if (w.follow !== undefined) {
      const b = toScreen(camOf(h, frame, W, H), W, H, w.follow.x, w.follow.y, w.follow.z ?? 0)
      at = { x: b.x + w.x * W, y: b.y + w.y * H }
    }
    const named = h.words.find((x) => x.name === true && frame >= x.f0 && frame < x.f1)
    if (w.inside === true && box !== undefined && named !== undefined && hero !== undefined) {
      const spot = markSpot(hero, named.text, (t) => { ctx.font = '600 100px ui-monospace, Menlo, monospace'; return ctx.measureText(t).width })
      const block = nameBlock(box, toScreen(camOf(h, frame, W, H), W, H, spot[0], spot[1], hero.z), (px100: number, text: string) => { ctx.font = face(100); return (ctx.measureText(text).width * px100) / 100 }, markingLines(named.text)[0] as string, named.size * W, (h.words.find((x) => x.small === true && x.name !== true && x.inside === true && frame >= x.f0 && frame < x.f1) ?? w).text, LABEL_PX * W)
      const mine = w.name === true ? block.name : block.size
      if (mine === undefined) {
        ctx.restore()
        return undefined
      }
      ctx.font = face(mine.px)
      at = mine
    } else if (w.inside === true && box !== undefined) {
      const fit = insideAt(box, ctx.measureText(w.text).width, px)
      ctx.font = face(px * fit.scale)
      at = fit
    }
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)'
    ctx.shadowBlur = 0.03 * W
    ctx.fillStyle = 'rgba(240, 241, 244, 0.96)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(w.name === true ? (markingLines(w.text)[0] as string) : w.text, at.x, at.y)
    ctx.restore()
    return undefined
  }
  heavy(ctx, 100, 'semi-expanded')
  const full = (100 * w.size * (w.turn === true ? H : W)) / Math.max(1, advance(ctx, w.text))
  const least = w.minCap === undefined ? full : Math.max(full, (w.minCap * Math.min(W, H)) / CAP)
  const size = w.maxCap === undefined ? least : Math.min(least, (w.maxCap * H) / CAP)
  heavy(target, size * slam, 'semi-expanded')
  const width = advance(target, w.text)
  let x = w.x * W + (w.drift ?? 0) * W * u
  let y = w.y * H
  if (w.follow !== undefined) {
    const b = toScreen(camOf(h, frame, W, H), W, H, w.follow.x, w.follow.y)
    x = b.x + w.x * W
    y = b.y + w.y * H
  }
  if (w.crown === true && seated !== undefined) {
    x = seated.right - width / 2
    y = seated.top - 0.95 * size * CAP
  }
  if (w.size <= 1 && w.turn !== true) x = Math.min(W - width / 2 - 0.01 * W, Math.max(width / 2 + 0.01 * W, x))
  if (masked) layer.clearRect(0, 0, W, H)
  target.save()
  target.fillStyle = INK
  target.textBaseline = 'middle'
  target.textAlign = 'left'
  if (w.turn === true) {
    target.translate(x, y)
    target.rotate(-Math.PI / 2)
    x = 0
    y = 0
  }
  let cx = x - width / 2
  for (const ch of Array.from(w.text)) {
    target.fillText(ch, cx, y)
    cx += target.measureText(ch).width
  }
  target.restore()
  if (masked) {
    const mt = matte()
    if (mt !== undefined) {
      const x0 = Math.max(0, Math.floor(x - width / 2))
      const x1 = Math.min(W, Math.ceil(x + width / 2))
      const y0 = Math.max(0, Math.floor(y - size * CAP))
      const y1 = Math.min(H, Math.ceil(y + size * CAP))
      const cut = document.createElement('canvas')
      cut.width = W
      cut.height = H
      const cc = cut.getContext('2d') as Ctx
      cc.drawImage(mt, 0, 0)
      if (x1 > x0 && y1 > y0) {
        const bw = x1 - x0
        const bh = y1 - y0
        const alpha = cc.getImageData(x0, y0, bw, bh).data
        const seen = ctx.getImageData(x0, y0, bw, bh).data
        const luma = new Float32Array(bw * bh).map((_, i) => (0.2126 * (seen[4 * i] as number) + 0.7152 * (seen[4 * i + 1] as number) + 0.0722 * (seen[4 * i + 2] as number)) / 255)
        const cover = new Float32Array(bw * bh).map((_, i) => (alpha[4 * i + 3] as number) / 255)
        for (const [i, front] of unseenColumns(cover, luma, bw, bh).entries()) if (front) cc.clearRect(x0 + i, y0, 1, bh)
      }
      layer.save()
      layer.globalCompositeOperation = 'destination-out'
      layer.drawImage(cut, 0, 0)
      layer.restore()
    }
    ctx.drawImage(layer.canvas, 0, 0)
  }
  return w.follow !== undefined ? { right: x + width / 2, top: y - (size * CAP) / 2 } : undefined
}

export function createHype(width: number, height: number, quality: TraceQuality): Hype {
  const canvas = (): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    return c
  }
  const out = canvas()
  const layer = canvas().getContext('2d') as Ctx
  let treat: Treat | undefined
  let gl: TraceGL | undefined
  let clone: TraceTimeline | undefined
  let clones: TraceTimeline[] = []
  let cloneOf: TraceTimeline | undefined
  let bodyOf: { tl: TraceTimeline; body: Array<[number, number, number]> } | undefined
  let paperOf: { w: number; h: number; data: Uint8ClampedArray } | undefined
  return {
    render(tl, frame) {
      let box: Array<{ x: number; y: number }> | undefined
      const m = tl.scene.montage as MontageScore
      const h = m.hype as HypeCut
      const pf = (h.plan[frame] ?? h.plan.at(-1)) as HypeFrame
      const ctx = out.getContext('2d') as Ctx
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.filter = 'none'
      const words = h.words.filter((w) => frame >= w.f0 && frame < w.f1)
      if (pf.look === 'xray' && pf.grade === 'build') {
        drawXray(ctx, tl.scene, camOf(h, frame, width, height), width, height)
        gradeBuild(ctx, frame, width, height, false)
        return out
      }
      if (pf.grade === 'black') {
        ctx.fillStyle = '#050505'
        ctx.fillRect(0, 0, width, height)
        for (const w of words) drawWord(ctx, h, tl.scene.board, w, frame, width, height, layer, () => undefined)
        return out
      }
      gl ??= createTraceGL(width, height, quality)
      treat ??= createTreat(width, height)
      if (cloneOf !== tl) {
        cloneOf = tl
        clones = [h.turns, h.late.turns].map((turns): TraceTimeline => ({ ...tl, style: 'trace', totalFrames: h.total, scene: { ...tl.scene, shots: h.shots, blink: h.blink, stage: h.stage, parts: tl.scene.parts.map((p, i) => (p.label === undefined ? p : { ...p, turn: turns[i] === true })) } }))
      }
      clone = clones[frame >= h.late.from ? 1 : 0]
      if (gl !== undefined && clone !== undefined) {
        ctx.filter = pf.grade === 'build' ? (pf.state === 'draw' ? 'saturate(0.65) brightness(1.85) contrast(1.12)' : (pf.state === 'copper' ? 'saturate(0.8) brightness(1.15) contrast(1.1)' : 'saturate(0.6) brightness(1.1) contrast(1.08)')) : 'none'
        const lit = pf.blur === 1 ? gl.render(clone, pf.clone) : gl.render(clone, pf.clone + 0.25 * (pf.shut ?? 1), pf.blur, pf.shut)
        if (pf.grade !== 'build' || pf.state !== 'draw') ctx.drawImage(lit, 0, 0)
        else {
          layer.setTransform(1, 0, 0, 1, 0, 0)
          layer.globalAlpha = 1
          layer.globalCompositeOperation = 'copy'
          layer.drawImage(lit, 0, 0)
          const img = layer.getImageData(0, 0, width, height)
          shoulder(img.data)
          layer.putImageData(img, 0, 0)
          layer.globalCompositeOperation = 'source-over'
          ctx.drawImage(layer.canvas, 0, 0)
        }
        ctx.filter = 'none'
        if (pf.grade === 'build' && (pf.state === 'draw' || pf.state === 'copper')) {
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.globalAlpha = pf.state === 'copper' ? 0.35 : 0.75
          ctx.filter = 'saturate(0.8) brightness(0.95) contrast(2.4)'
          ctx.drawImage(out, 0, 0)
          ctx.restore()
        }
        if (pf.grade === 'build') {
          ctx.save()
          ctx.globalCompositeOperation = 'destination-in'
          ctx.drawImage(gl.matte(clone, pf.clone), 0, 0)
          ctx.globalCompositeOperation = 'destination-over'
          ctx.fillStyle = '#050505'
          ctx.fillRect(0, 0, width, height)
          ctx.restore()
          shadeWalls(ctx, camOf(h, frame, width, height), tl.scene.board, Math.max(1.5, tl.scene.material.thicknessPx), width, height)
        }
      }
      if (pf.grade === 'stop' && gl !== undefined && clone !== undefined) {
        if (bodyOf?.tl !== tl) bodyOf = { tl, body: ((hero) => (hero === undefined ? [] : drawnBody(tl.scene, hero)))(tl.scene.parts.find((p) => p.hero === true)) }
        const rim = canvas().getContext('2d') as Ctx
        rim.strokeStyle = '#fff'
        rim.lineJoin = 'round'
        rim.lineWidth = RIM_RING * width
        rim.beginPath()
        for (const p of bodyOutline(h.glint, bodyOf.body, camOf(h, frame, width, height), width, height)) rim.lineTo(p.x, p.y)
        rim.closePath()
        rim.stroke()
        const img = ctx.getImageData(0, 0, width, height)
        holdStop(img.data, rim.getImageData(0, 0, width, height).data.filter((_, i) => i % 4 === 3))
        ctx.putImageData(img, 0, 0)
      }
      if (pf.look === 'xray' && gl !== undefined && clone !== undefined) {
        layer.setTransform(1, 0, 0, 1, 0, 0)
        layer.globalAlpha = 1
        layer.globalCompositeOperation = 'copy'
        layer.drawImage(out, 0, 0)
        layer.globalCompositeOperation = 'destination-out'
        layer.drawImage(gl.matte(clone, pf.clone), 0, 0)
        layer.globalCompositeOperation = 'source-over'
        const layers = pf.layers ?? 1
        let age = 0
        while (age < frame && (h.plan[frame - age - 1]?.layers ?? 0) === layers) age++
        drawXray(ctx, tl.scene, camOf(h, frame, width, height), width, height, { layers, age })
        ctx.save()
        ctx.globalAlpha = FLOOR
        ctx.drawImage(layer.canvas, 0, 0)
        ctx.restore()
        return out
      }
      if (pf.grade === 'build') gradeBuild(ctx, frame, width, height, pf.look === 'lit')
      if (pf.look !== 'lit' && pf.look !== 'xray' && treat !== undefined) {
        const from = Math.max(0, ...h.cuts.filter((c) => c <= frame))
        const to = h.cuts.find((c) => c > frame) ?? h.frames
        ctx.drawImage(treat.render(out, { ...LOOK[pf.look], progress: 1, invert: false, stream: m.glyphs, seed: to - from < 10 ? from : frame }), 0, 0)
        if (pf.bare === true) {
          if (bodyOf?.tl !== tl) bodyOf = { tl, body: ((hero) => (hero === undefined ? [] : drawnBody(tl.scene, hero)))(tl.scene.parts.find((p) => p.hero === true)) }
          const cam = camOf(h, frame, width, height)
          const d = h.dims.find((x) => frame >= x.f0 && frame < x.f1)
          const lid = bodyOutline(h.glint, bodyOf.body, cam, width, height)
          box = measuredBox(lid, d === undefined ? lid.slice(0, 4) : d.corners.map((p) => toScreen(cam, width, height, p.x, p.y)))
          const pads = tl.scene.pads.filter((p) => p.hero === true)
          if (paperOf?.w !== width || paperOf.h !== height) {
            const blank = canvas().getContext('2d') as Ctx
            blank.fillStyle = '#000'
            blank.fillRect(0, 0, width, height)
            const pc = canvas().getContext('2d') as Ctx
            pc.drawImage(treat.render(blank.canvas, { ...LOOK[pf.look], progress: 1, invert: false, stream: m.glyphs, seed: 0 }), 0, 0)
            paperOf = { w: width, h: height, data: pc.getImageData(0, 0, width, height).data }
          }
          const zone = canvas().getContext('2d') as Ctx
          zone.fillStyle = '#fff'
          zone.strokeStyle = '#fff'
          zone.lineJoin = 'round'
          zone.lineWidth = 2 * PRINT_BAND * width
          for (const shape of [box, hull(pads.flatMap((p) => padOutline(p).map(([x, y]) => toScreen(cam, width, height, x, y))))]) {
            if (shape.length < 3) continue
            zone.beginPath()
            for (const p of shape) zone.lineTo(p.x, p.y)
            zone.closePath()
            zone.fill()
            zone.stroke()
          }
          const inBand = printBand(box, width)
          for (const t of tl.scene.texts) {
            if (silkWhole(t, cam) || !silkInBand(t, cam, width, height, inBand)) continue
            zone.beginPath()
            for (const [x, y] of silkBox(t)) {
              const q = toScreen(cam, width, height, x, y)
              zone.lineTo(q.x, q.y)
            }
            zone.closePath()
            zone.fill()
          }
          const keep = canvas().getContext('2d') as Ctx
          fillKept(keep, zone, printKept(tl.scene, cam, width, height), box, width)
          const img = ctx.getImageData(0, 0, width, height)
          const alpha = (c: Ctx): Uint8ClampedArray => c.getImageData(0, 0, width, height).data.filter((_, i) => i % 4 === 3)
          clearBand(img.data, paperOf.data, alpha(zone), width, height, MARK_MOST * width, 24, 2, alpha(keep))
          ctx.putImageData(img, 0, 0)
          drawPads(ctx, pads, cam, width, height, LOOK[pf.look])
          drawBody(ctx, box, width, LOOK[pf.look])
        }
      }
      const cam = camOf(h, frame, width, height)
      if (pf.spot !== undefined) {
        const c = toScreen(cam, width, height, pf.spot.x, pf.spot.y)
        const e = toScreen(cam, width, height, pf.spot.x + pf.spot.r, pf.spot.y)
        const r = Math.max(1, Math.hypot(e.x - c.x, e.y - c.y))
        ctx.save()
        const g = ctx.createRadialGradient(c.x, c.y, 0.62 * r, c.x, c.y, 1.15 * r)
        g.addColorStop(0, 'rgba(2, 5, 12, 0)')
        g.addColorStop(1, 'rgba(2, 5, 12, 0.97)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, width, height)
        ctx.restore()
      }
      for (const d of h.dims) if (frame >= d.f0 && frame < d.f1) drawDims(ctx, d, box ?? d.corners.map((p) => toScreen(cam, width, height, p.x, p.y)), frame, width, height)
      const low = frame < h.late.from ? 0 : Math.min(1, Math.max(0, (sampleShot(h.shots, pf.clone / h.total).tilt - 0.7) / 0.3))
      if (low > 0) {
        ctx.save()
        const sky = ctx.createLinearGradient(0, 0, 0, 0.3 * height)
        sky.addColorStop(0, `rgba(5, 5, 5, ${low})`)
        sky.addColorStop(0.5, `rgba(5, 5, 5, ${0.8 * low})`)
        sky.addColorStop(1, 'rgba(5, 5, 5, 0)')
        ctx.fillStyle = sky
        ctx.fillRect(0, 0, width, 0.3 * height)
        ctx.restore()
      }
      const hit = frame < h.hit[0] || frame >= h.hit[1] ? 0 : Math.min(1, (h.hit[1] - frame) / 6)
      const fall = hit > 0 ? { ...POOL.hit, dark: POOL.dark * hit } : { ...POOL.end, dark: POOL.dark * low }
      if (fall.dark > 0) {
        const aim = sampleShot(h.shots, pf.clone / h.total)
        const at = toScreen(camOf(h, frame, width, height), width, height, aim.x, aim.y)
        const pool = ctx.createRadialGradient(at.x, at.y, fall.core * width, at.x, at.y, fall.reach * width)
        pool.addColorStop(0, 'rgba(5, 5, 5, 0)')
        pool.addColorStop(1, `rgba(5, 5, 5, ${fall.dark})`)
        ctx.fillStyle = pool
        ctx.fillRect(0, 0, width, height)
      }
      if (frame >= h.glint.f0 && frame < h.glint.f1) {
        const g = h.glint
        const u = (frame + 0.5 - g.f0) / (g.f1 - g.f0)
        const e = u * u * (3 - 2 * u)
        const c = Math.cos(g.rot)
        const s = Math.sin(g.rot)
        const lid = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => toScreen(cam, width, height, g.x + ((a as number) * g.along * c - (b as number) * g.across * s) / 2, g.y + ((a as number) * g.along * s + (b as number) * g.across * c) / 2, g.z))
        const [p0, , p2] = lid as [{ x: number; y: number }, unknown, { x: number; y: number }]
        const at = -GLINT_WIDE + (1 + 2 * GLINT_WIDE) * e
        const band = ctx.createLinearGradient(p0.x, p0.y, p2.x, p2.y)
        for (const [k, a] of [[-GLINT_WIDE, 0], [0, g.peak * Math.sin(Math.PI * u)], [GLINT_WIDE, 0]] as const) band.addColorStop(Math.min(1, Math.max(0, at + k)), `rgba(255, 246, 232, ${a})`)
        ctx.save()
        ctx.beginPath()
        for (const p of lid) ctx.lineTo(p.x, p.y)
        ctx.closePath()
        ctx.clip()
        ctx.globalCompositeOperation = 'lighter'
        ctx.fillStyle = band
        ctx.fillRect(0, 0, width, height)
        ctx.restore()
      }
      const matte = (): HTMLCanvasElement | undefined => (gl !== undefined && clone !== undefined ? gl.matte(clone, pf.clone) : undefined)
      let seated: Seated | undefined
      for (const w of words) seated = drawWord(ctx, h, tl.scene.board, w, frame, width, height, layer, matte, seated, box, clone?.scene.parts.find((p) => p.hero === true)) ?? seated
      return out
    },
    dispose() {
      gl?.dispose()
      treat?.dispose()
    }
  }
}