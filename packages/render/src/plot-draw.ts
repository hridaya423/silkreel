import { axoPoint, END_STROKE, standSeed, standTime, SECTION_COL_GAP, SECTION_GROW, SECTION_ROW, SECTION_TITLE, fanInk, NOTE_HALO, settle, SHEET_PUSH, FILM_SUB, FILM_TEXT, calloutFrame, calloutSize, hullBox, inkClock, nameStrip, plotClock, plotFrame, sampleShot, sheetUnit, stackLabelRows } from '@silk-reel/choreo'
import type { PlotAxo, PlotInk, PlotScore, PlotSection, PlotStroke, TracePart, TraceScene, TraceTimeline } from '@silk-reel/choreo'
import { ID, apply, banded, bleed, mul, clamp01, drawGrid, drawPlan, easeInOut, heroPencil, easeOut, geo, invert, knockout, lettered, mixHex, scaleOf, setT, weights } from './plot-plan'
import type { Aff, Front, Pen, PlanOpts, Pt } from './plot-plan'
import type { Frame } from './plot-body'
import { axoAff, bodyOf, drawCallouts, drawFlow, drawObject, hiddenFlow, growing, hash, inkDensity, noise, throughCamera } from './plot-object'
import type { Callout, ObjectState } from './plot-object'
import { drawSheet } from './plot-sheet'
import { frameOf, lidReading } from './plot-body'
import { drawSignature, sectionFrame, stationPills } from './plot-signature'

const B = 1 / 24

const lumaOf = (hex: string): number => [0.299, 0.587, 0.114].reduce((t, k, i) => t + (k * Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)) / 255, 0)

/** the signal's ink: on a dark stock the palette's accent lifted half way to white, so it is the brightest line on the sheet in luminance and not by hue alone; on a light stock the accent itself */
export const signalInk = (palette: { head: string; bg: string }): string => (lumaOf(palette.bg) < 0.5 ? mixHex(palette.head, '#ffffff', 0.5) : palette.head)

/** every other line's ink, held a step under the signal's in luminance: the sheet's ink mixed 8% toward the paper */
export const sheetInk = (palette: { silk: string; bg: string }): string => mixHex(palette.silk, palette.bg, 0.08)

/** the three weights of line: the signal 1.7 of the heavy pen in its own ink; the main chip's own signals at FAN_FINE of the sheet's ink and 2.2 of the medium pen, their fresh heads white at FAN_HEAD; all other copper at REST_FINE, two thirds of the sheet's ink, and one medium pen */
const PAIR_GAIN = 1.7
const FAN_FINE = 0.94
const FAN_HEAD = 0.84
const FAN_WEIGHT = 2.2
const REST_FINE = 0.66
/** the strength of the lines drawn beside the signal in its opening shot, and the most they weigh: 0.6 of the signal's pen */
const SWEEP_FINE = 0.8
const sweepCap = (pen: Pen): number => 0.6 * PAIR_GAIN * weights(pen.u).h
/** the strength of every part's body but the main chip's, in a film that travels its signal */
const REST_BODIES = 0.8
/** the most a close camera thickens the signal's line: ink on paper looks heavier from nearer */
const NEAR_GAIN = 2.2


const TEXTURE = new Map<string, HTMLCanvasElement>()

function paperTexture(w: number, h: number): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined
  const key = `${w}x${h}`
  const hit = TEXTURE.get(key)
  if (hit !== undefined) return hit
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const c = cv.getContext('2d')
  if (c === null) return undefined
  const img = c.createImageData(w, h)
  const unit = Math.min(w, h) / 1080
  const fold = (d: number): number => Math.exp(-(d * d) / (2 * (14 * unit) ** 2))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cloud = 0.6 * noise(x / (190 * unit), y / (190 * unit)) + 0.4 * noise(x / (55 * unit), y / (55 * unit)) - 0.5
      const fibre = noise(x / (3.5 * unit) + 17, y / (3.5 * unit)) * noise(x / (9 * unit), y / (9 * unit) + 31) - 0.25
      const grain = hash(x, y) - 0.5
      const crease = 0.5 * fold(x - w * 0.5) - 0.35 * fold(x - w * 0.5 - 18 * unit) + 0.5 * fold(y - h * 0.5) - 0.35 * fold(y - h * 0.5 - 18 * unit)
      const strand = Math.max(0, noise((0.94 * x + 0.34 * y) / (0.8 * unit), (-0.34 * x + 0.94 * y) / (11 * unit) + 7) - 0.62) + Math.max(0, noise((0.5 * x - 0.87 * y) / (0.7 * unit) + 3, (0.87 * x + 0.5 * y) / (9 * unit)) - 0.66)
      const v = 128 + cloud * 84 + fibre * 30 + grain * 12 + crease * 70 + strand * 90
      const i = (y * w + x) * 4
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  c.putImageData(img, 0, 0)
  TEXTURE.set(key, cv)
  return cv
}

function stock(pen: Pen, tl: TraceTimeline): void {
  const ctx = pen.ctx
  setT(pen, ID)
  bleed(pen, false)
  if (pen.transparent) {
    ctx.clearRect(0, 0, pen.W, pen.H)
    return
  }
  ctx.fillStyle = tl.palette.bg
  ctx.fillRect(0, 0, pen.W, pen.H)
}

const TOOTH = new Map<string, HTMLCanvasElement>()

const offscreen = (cache: Map<string, HTMLCanvasElement>, w: number, h: number): HTMLCanvasElement => {
  const key = `${w}x${h}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  cache.set(key, cv)
  return cv
}

function toothTexture(w: number, h: number): HTMLCanvasElement | undefined {
  const cv = offscreen(TOOTH, w, h)
  if (cv.dataset.ready === '1') return cv
  const c = cv.getContext('2d')
  if (c === null) return undefined
  const img = c.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = Math.max(0, hash(x * 1.7 + 3, y * 1.3 + 11) - 0.84) * 2 * (0.6 + 0.8 * noise(x / 2.2, y / 2.2))
      const i = (y * w + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 * Math.min(1, k)
      img.data[i + 3] = 255
    }
  }
  c.putImageData(img, 0, 0)
  cv.dataset.ready = '1'
  return cv
}

const SCRATCH = new Map<string, HTMLCanvasElement>()

/** breaks the ink's edge where the paper's tooth did not take it */
function tooth(pen: Pen, w: number, h: number): void {
  const grain = toothTexture(w, h)
  const cv = offscreen(SCRATCH, w, h)
  const c = cv.getContext('2d')
  if (grain === undefined || c === null) return
  c.globalCompositeOperation = 'copy'
  c.drawImage(pen.ctx.canvas, 0, 0)
  c.globalCompositeOperation = 'difference'
  c.fillStyle = pen.stock
  c.fillRect(0, 0, w, h)
  c.globalCompositeOperation = 'multiply'
  c.drawImage(grain, 0, 0)
  c.globalCompositeOperation = 'source-over'
  const ctx = pen.ctx
  ctx.globalCompositeOperation = 'difference'
  ctx.drawImage(cv, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
}

function wear(pen: Pen): void {
  if (pen.transparent) return
  const tex = paperTexture(Math.round(pen.W * pen.k), Math.round(pen.H * pen.k))
  if (tex === undefined) return
  const ctx = pen.ctx
  setT(pen, ID)
  bleed(pen, false)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  tooth(pen, tex.width, tex.height)
  setT(pen, ID)
  gleam(pen)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'soft-light'
  ctx.globalAlpha = 0.6
  ctx.drawImage(tex, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

function gleam(pen: Pen): void {
  const ctx = pen.ctx
  const lit = ctx.createLinearGradient(0, 0, pen.W, pen.H)
  lit.addColorStop(0, 'rgba(255,250,235,0.05)')
  lit.addColorStop(0.45, 'rgba(255,250,235,0)')
  lit.addColorStop(0.6, 'rgba(0,4,20,0)')
  lit.addColorStop(1, 'rgba(0,4,20,0.07)')
  ctx.fillStyle = lit
  ctx.fillRect(0, 0, pen.W, pen.H)
  const r = Math.hypot(pen.W, pen.H) / 2
  const gr = ctx.createRadialGradient(pen.W / 2, pen.H / 2, 0, pen.W / 2, pen.H / 2, r)
  gr.addColorStop(0, 'rgba(255,250,240,0.045)')
  gr.addColorStop(0.45, 'rgba(0,4,20,0)')
  gr.addColorStop(1, 'rgba(0,4,20,0.26)')
  ctx.fillStyle = gr
  ctx.fillRect(0, 0, pen.W, pen.H)
  const worn = 0.11 * Math.min(pen.W, pen.H)
  for (const [cx, cy] of [[0, 0], [pen.W, 0], [0, pen.H], [pen.W, pen.H]] as const) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, worn)
    g.addColorStop(0, 'rgba(225,236,255,0.16)')
    g.addColorStop(0.5, 'rgba(225,236,255,0.06)')
    g.addColorStop(1, 'rgba(225,236,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(cx - worn, cy - worn, 2 * worn, 2 * worn)
  }
}


const stageK = (s: TraceScene, p: number, W: number, H: number): number => {
  const k = (nameStrip(W, H).y - 0.012 * Math.min(W, H)) / H
  const [a, b] = s.plot?.beats.pull ?? [16.5, 18]
  const u = clamp01((p * 24 - a) / Math.max(1e-6, b - a))
  return k + (1 - k) * u * u * u * (u * (6 * u - 15) + 10)
}

/** the camera at film time p, squeezed into the frame above the name strip until the pull opens it to the whole sheet */
export const camAt = (s: TraceScene, p: number, W: number, H: number): ReturnType<typeof sampleShot> => {
  const c = sampleShot(s.shots, p)
  const k = stageK(s, p, W, H)
  return { ...c, y: c.y + (H * (1 - k)) / (2 * k * c.zoom), zoom: k * c.zoom }
}

export const flatView = (s: TraceScene, p: number, W: number, H: number): Aff => {
  const c = sampleShot(s.shots, p)
  const k = stageK(s, p, W, H)
  const z = k * c.zoom
  const co = Math.cos(c.yaw)
  const si = Math.sin(c.yaw)
  return [z * co, z * si, -z * si, z * co, W / 2 - z * (co * c.x - si * c.y), (k * H) / 2 - z * (si * c.x + co * c.y)]
}

const along = (path: number[], frac: number): { pts: Pt[]; head: Pt } => {
  const n = path.length / 2
  let total = 0
  for (let i = 1; i < n; i++) total += Math.hypot((path[2 * i] as number) - (path[2 * i - 2] as number), (path[2 * i + 1] as number) - (path[2 * i - 1] as number))
  let rest = total * clamp01(frac)
  const pts: Pt[] = [[path[0] as number, path[1] as number]]
  for (let i = 1; i < n && rest > 0; i++) {
    const a: Pt = [path[2 * i - 2] as number, path[2 * i - 1] as number]
    const b: Pt = [path[2 * i] as number, path[2 * i + 1] as number]
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    const k = d > 0 ? Math.min(1, rest / d) : 1
    pts.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k])
    rest -= d
  }
  return { pts, head: pts[pts.length - 1] as Pt }
}

/** a stroke wider than this many px on screen is drawn as its outline, hatched, not as a solid bar */
const INK_OUTLINE = 14

function hatchWide(pen: Pen, m: Aff, strokes: PlotStroke[], p: number, judge: number, alpha: number): void {
  const ctx = pen.ctx
  const sc = scaleOf(m)
  const { f, m: med } = weights(pen.u)
  const gap = 9 * pen.u
  const h: Pt = [Math.SQRT1_2, -Math.SQRT1_2]
  setT(pen, ID)
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = f
  ctx.globalAlpha = alpha
  ctx.beginPath()
  for (const st of strokes) {
    const w = st.w * sc
    if (p < st.t0 || st.w * judge <= INK_OUTLINE * pen.u) continue
    const { pts } = along(st.path, p >= st.t1 ? 1 : (p - st.t0) / Math.max(1e-9, st.t1 - st.t0))
    const half = w / 2 - med
    let phase = 0
    for (let j = 1; j < pts.length; j++) {
      const a = apply(m, (pts[j - 1] as Pt)[0], (pts[j - 1] as Pt)[1])
      const b = apply(m, (pts[j] as Pt)[0], (pts[j] as Pt)[1])
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (L === 0) continue
      const t: Pt = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
      const across = Math.abs(h[0] * -t[1] + h[1] * t[0])
      const d: Pt = across > 0.35 ? h : [-t[1], t[0]]
      const k = across > 0.35 ? half / across : half
      for (let s = gap - phase; s < L; s += gap) {
        const c: Pt = [a[0] + t[0] * s, a[1] + t[1] * s]
        ctx.moveTo(c[0] - d[0] * k, c[1] - d[1] * k)
        ctx.lineTo(c[0] + d[0] * k, c[1] + d[1] * k)
      }
      phase = (phase + L) % gap
    }
  }
  ctx.stroke()
  ctx.globalAlpha = 1
  bleed(pen, false)
}

const textW = (n: number, size: number): number => n * size * 0.66

/** how much larger than the film's text the hero's marking may letter on a lid that has room for it */
const LID_TEXT = 2

/** the hero's marking lettered on its lid, its part number alone when the whole marking would letter under the film's text size: along the film's reading of that lid, each letter on paper cleared of the copper under it */
function penMark(pen: Pen, F: Frame, at: Frame, core: string, read: Pt, chars: number): void {
  const reach = (G: Frame): number => {
    const c0 = G.P(0, 0, 0)
    const q0 = G.P(read[0], read[1], 0)
    return Math.hypot(q0[0] - c0[0], q0[1] - c0[1])
  }
  const c = F.P(0, 0, 0)
  const q = F.P(read[0], read[1], 0)
  const el = reach(F)
  if (el < 1e-9) return
  const e: Pt = [(q[0] - c[0]) / el, (q[1] - c[1]) / el]
  const fits = (t: string): boolean => (0.7 * (read[0] !== 0 ? at.w : at.h) * reach(at)) / textW(t.length, 1) >= FILM_TEXT * pen.su
  const text = fits(core) ? core : core.split('_').at(-1) ?? core
  if (text.length < 3) return
  const L = Math.min(LID_TEXT * FILM_TEXT * pen.su, (0.7 * (read[0] !== 0 ? F.w : F.h) * el) / textW(text.length, 1))
  const n = Math.min(text.length, chars)
  const pad = 0.4 * L
  setT(pen, [e[0], e[1], -e[1], e[0], c[0], c[1]])
  knockout(pen, () => { pen.ctx.fillRect(-0.5 * textW(text.length, L) - pad, -0.5 * L - pad, textW(n, L) + 2 * pad, L + 2 * pad) })
  lettered(pen, text.slice(0, n), -0.5 * textW(text.length, L), 0, L, { base: 'middle' })
  setT(pen, ID)
}

/** strokes inked as far as they have grown at p: narrow ones solid and no wider than cap frame px, ones wider than the outline pen at the scale judge as hatched outlines (a judge of 0 keeps every stroke solid, as the signal is), the growing one's last stretch bright white */
function inkStrokes(pen: Pen, m: Aff, strokes: PlotStroke[], p: number, judge = scaleOf(m), heavy = false, gain = 1, cap = Infinity): void {
  const ctx = pen.ctx
  const sc = scaleOf(m)
  const med = (heavy ? weights(pen.u).h : weights(pen.u).m) * gain
  const wide = new Map<number, Path2D>()
  const thin = new Map<number, Path2D>()
  let live: { pts: Pt[]; w: number } | undefined
  for (const st of strokes) {
    if (p < st.t0) continue
    const frac = p >= st.t1 ? 1 : (p - st.t0) / Math.max(1e-9, st.t1 - st.t0)
    const { pts } = along(st.path, frac)
    const bucket = st.w * judge > INK_OUTLINE * pen.u ? wide : thin
    const key = Math.round(st.w * 8) / 8
    const path = bucket.get(key) ?? new Path2D()
    bucket.set(key, path)
    pts.forEach(([x, y], j) => {
      if (j === 0) path.moveTo(x, y)
      else path.lineTo(x, y)
    })
    if (frac < 1) live = { pts, w: st.w }
  }
  setT(pen, m)
  ctx.strokeStyle = pen.ink
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [w, path] of wide) {
    ctx.lineWidth = w + (2 * med) / sc
    ctx.stroke(path)
  }
  for (const [w, path] of thin) {
    ctx.lineWidth = Math.min(Math.max(w, med / sc), cap / sc)
    ctx.stroke(path)
  }
  knockout(pen, () => {
    for (const [w, path] of wide) {
      ctx.lineWidth = w
      ctx.stroke(path)
    }
  })
  if (wide.size > 0) hatchWide(pen, m, strokes, p, judge, 0.85)
  if (live !== undefined) {
    const fresh = live
    const tail: Pt[] = []
    let room = Math.max(30 * pen.u, 0.1 * sc * fresh.pts.slice(1).reduce((t, q, j) => t + Math.hypot(q[0] - (fresh.pts[j] as Pt)[0], q[1] - (fresh.pts[j] as Pt)[1]), 0)) / sc
    for (let j = fresh.pts.length - 1; j > 0 && room > 0; j--) {
      const a = fresh.pts[j] as Pt
      const b = fresh.pts[j - 1] as Pt
      const d = Math.hypot(b[0] - a[0], b[1] - a[1])
      tail.push(a)
      if (d >= room) {
        tail.push([a[0] + ((b[0] - a[0]) * room) / d, a[1] + ((b[1] - a[1]) * room) / d])
        break
      }
      room -= d
    }
    if (tail.length >= 2) {
      const line = (): void => {
        ctx.beginPath()
        tail.forEach(([x, y], j) => {
          if (j === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.stroke()
      }
      ctx.strokeStyle = gain > 1 ? '#ffffff' : pen.ink
      if (fresh.w * judge > INK_OUTLINE * pen.u) {
        ctx.lineWidth = fresh.w + (2 * med) / sc
        line()
        knockout(pen, () => {
          ctx.lineWidth = fresh.w
          line()
        })
      } else {
        ctx.lineWidth = Math.max(fresh.w, med / sc)
        line()
      }
    }
  }
  bleed(pen, false)
}

interface Tip { psi: number; e: number; k: number; x: number; y: number }

const WAVE = new WeakMap<PlotScore, Map<string, { t0: number; t1: number }>>()

const waveKey = (x: number, y: number): string => `${Math.round(x * 10)},${Math.round(y * 10)}`

const objectState = (plot: PlotScore, beat: number, s?: TraceScene): ObjectState => {
  const n = plot.stack.length
  const Bt = plot.beats
  const pl = Bt.parts
  const gap = plot.object.gap
  const open = Bt.lift[1] > Bt.lift[0] ? easeInOut((beat - Bt.lift[0]) / (Bt.lift[1] - Bt.lift[0])) : 0
  const land = (T: number): number => {
    if (beat >= T) return beat < T + 0.25 ? 1 - 0.05 * Math.sin((Math.PI * (beat - T)) / 0.25) ** 2 : 1
    const k = clamp01((beat - (T - 0.5)) / 0.5)
    return k * k
  }
  const gaps = Bt.lands.map((T) => gap * open * (1 - land(T)))
  const lift = Array.from({ length: n }, (_, i) => gaps.slice(i).reduce((a, b) => a + b, 0))
  return {
    lift,
    parts: 0.8 * gap * open * (1 - land(pl)),
    proj: beat < pl ? clamp01((beat - Bt.lift[1]) / 0.5) : 1 - clamp01((beat - pl) / 0.5),
    hidden: clamp01((beat - pl) / 1),
    copper: beat < Bt.push[1] ? 1 : 1 - 0.4 * clamp01((beat - Bt.push[1]) / 0.5),
    bodies: plot.film.signature.kind === 'section' ? 1 : clamp01((beat - Bt.tilt[0]) / (7 / 15)),
    ...(s === undefined ? {} : { reveal: revealOf(plot, beat) })
  }
}

/** how far each part is drawn at a beat, 0..1, from its window in the object's drawing wave */
const revealOf = (plot: PlotScore, beat: number): ((p: TracePart) => number) => {
  let windows = WAVE.get(plot)
  if (windows === undefined) {
    windows = new Map(plot.object.wave.map((w) => [waveKey(w.x, w.y), { t0: w.t0, t1: w.t1 }]))
    WAVE.set(plot, windows)
  }
  const known = windows
  return (p) => {
    const w = known.get(waveKey(p.x, p.y))
    return w === undefined ? 1 : clamp01((beat - w.t0) / Math.max(1e-6, w.t1 - w.t0))
  }
}

/** whether the plan was turned on its sheet: then the tilt starts on a cut to the oblique's heading instead of spinning the drawing round */
const tiltCut = (plot: PlotScore): boolean => Math.abs(Math.sin(plot.object.planYaw - plot.object.psi[0])) > 0.5 && plot.object.planYaw !== 0

const readings = new WeakMap<PlotScore, Pt | undefined>()

/** the hero lid's reading for the whole film: the score's, else the side that reads in every view the film shows the object in */
export function heroReading(s: TraceScene, plot: PlotScore, W: number, H: number): Pt | undefined {
  if (plot.hero.read !== undefined) return plot.hero.read
  if (readings.has(plot)) return readings.get(plot)
  const hero = s.parts.find((q) => q.hero === true)
  const p0 = plot.shots.object[0]
  const views = Array.from({ length: 49 }, (_, i) => p0 + ((1 - p0) * i) / 48)
    .filter((p) => plot.film.shots.find((q) => p < q.t1)?.kind !== 'signature')
    .map((p) => axoAff(objectView(s, plot, p, W, H), 0))
  const read = hero === undefined || views.length === 0 ? undefined : lidReading(views, hero)
  readings.set(plot, read)
  return read
}

const planReadings = new WeakMap<PlotScore, Pt | undefined>()

/** the main chip's name as its lid letters it: the plan's name, size, reading and dot, carried up on the top face as the body rises out of the plan */
const lidName = (s: TraceScene, plot: PlotScore, W: number, H: number): NonNullable<Pen['lid']> => ({ label: plot.hero.label, pin1: plot.hero.pin1, read: planReading(s, plot, W, H), part: plot.signal !== undefined })

/** the name reads along the lid's side in whichever of its two directions lies within 90° of the frame's own reading direction at the arrival, chosen once for the whole film, a vertical name from bottom to top; the orbit turns the way that carries it into the object views reading */
export function planReading(s: TraceScene, plot: PlotScore, W: number, H: number): Pt | undefined {
  if (planReadings.has(plot)) return planReadings.get(plot)
  const hp = s.parts.find((q) => q.hero === true)
  const lid = heroReading(s, plot, W, H)
  let read = lid
  if (hp !== undefined && lid !== undefined && plot.ink !== undefined) {
    const a = hp.rot + Math.atan2(lid[1], lid[0])
    const m = flatView(s, plot.ink.hold[0], W, H)
    const sx = m[0] * Math.cos(a) + m[2] * Math.sin(a)
    const sy = m[1] * Math.cos(a) + m[3] * Math.sin(a)
    const level = Math.abs(sx) > 1e-6 * Math.hypot(sx, sy)
    if (level ? sx < 0 : sy > 0) read = [-lid[0], -lid[1]]
  }
  planReadings.set(plot, read)
  return read
}

/** the share of the tilt its zoom runs at a steady rate before it slows to rest on the tilt's last frame */
const ZOOM_STEADY = 0.6

/** progress at a steady rate, then slowing evenly to rest at the end */
const landing = (t: number): number => {
  const v = 2 / (1 + ZOOM_STEADY)
  if (t <= ZOOM_STEADY) return v * t
  const r = (t - ZOOM_STEADY) / (1 - ZOOM_STEADY)
  return v * ZOOM_STEADY + v * (1 - ZOOM_STEADY) * (r - (r * r) / 2)
}

function objectView(s: TraceScene, plot: PlotScore, p: number, W: number, H: number): PlotAxo {
  const beat = p / B
  const iso = plot.sheet.iso
  const [psi0, psi1] = plot.object.psi
  const Bt = plot.beats
  const turn = plot.object.turn
  const back = turn === undefined ? easeInOut(clamp01(beat - Bt.pull[0] - 0.5)) : easeInOut(clamp01((beat - turn[0]) / Math.max(1e-6, turn[1] - turn[0])))
  const ta = Bt.parts + 0.5
  const turned = psi0 + (psi1 - psi0) * clamp01((beat - ta) / Math.max(1, Bt.pull[0] - Bt.parts))
  const psi = turned + Math.atan2(Math.sin(iso.psi - turned), Math.cos(iso.psi - turned)) * back
  const e = plot.object.e + (iso.e - plot.object.e) * back
  const ride = { ...iso, k: iso.k * (plot.object.scale ?? 1) ** (1 - back) }
  const v = throughCamera({ ...ride, psi, e }, camAt(s, p, W, H), W, H)
  const hero = s.parts.find((q) => q.hero === true)
  if (beat >= Bt.tilt[1]) {
    if (hero === undefined || beat <= Bt.sheet) return v
    const grown = 1 + ((SHEET_PUSH - 1) * (beat - Bt.sheet)) / (24 - Bt.sheet)
    const at = axoPoint(v, [hero.x, hero.y], 0)
    return { ...v, k: v.k * grown, x: at[0] + grown * (v.x - at[0]), y: at[1] + grown * (v.y - at[1]) }
  }
  const sig = plot.film.signature
  if (sig.kind === 'section' && hero !== undefined) {
    const sf = sectionFrame({ W, H, su: sheetUnit(W, H), u: Math.min(W, H) / 1080 } as Pen, sig)
    const side: PlotAxo = { ...iso, psi: psi0, e: 0.06, k: sf.s / s.material.pxPerMm, x: 0, y: 0 }
    const at = axoPoint(side, [hero.x, hero.y], 0)
    const a: PlotAxo = { ...side, x: sf.cx - at[0], y: sf.boardY - at[1] }
    const bv = throughCamera({ ...ride, psi: psi0, e: plot.object.e }, camAt(s, Bt.tilt[1] * B, W, H), W, H)
    const t = settle(clamp01((beat - Bt.tilt[0]) / Math.max(1e-6, Bt.tilt[1] - Bt.tilt[0])))
    const lerp = (x: number, y: number): number => x + (y - x) * t
    return { ...bv, psi: lerp(a.psi, bv.psi), e: lerp(a.e, bv.e), k: Math.exp(lerp(Math.log(a.k), Math.log(bv.k))), x: lerp(a.x, bv.x), y: lerp(a.y, bv.y) }
  }
  const m3 = flatView(s, plot.shots.object[0] - 0.0011, W, H)
  const at0 = apply(m3, iso.mx, iso.my)
  const bv = throughCamera({ ...ride, psi: psi0, e: plot.object.e }, camAt(s, Bt.tilt[1] * B, W, H), W, H)
  const cut = tiltCut(plot)
  const flat = hullBox({ ...iso, psi: bv.psi, e: Math.PI / 2, k: 1, x: 0, y: 0 }, plot.object.hull)
  const fill = Math.min((0.9 * W) / flat.w, (0.86 * H) / flat.h)
  const a: Tip = cut
    ? { psi: bv.psi, e: Math.PI / 2, k: fill, x: W / 2 - fill * (flat.x + flat.w / 2), y: H / 2 - fill * (flat.y + flat.h / 2) }
    : { psi: plot.object.planYaw, e: Math.PI / 2, k: scaleOf(m3), x: at0[0], y: at0[1] }
  const travels = !cut && plot.film.shots.some((q) => q.kind === 'outline')
  const t = travels ? easeInOut(clamp01((beat - Bt.tilt[0]) / Math.max(1, Bt.tilt[1] - Bt.tilt[0]))) : settle(cut ? clamp01(beat - Bt.tilt[0]) : easeInOut(clamp01(beat - Bt.tilt[0])))
  const lerp = (x: number, y: number): number => x + (y - x) * t
  if (travels) {
    const hp: Pt = hero === undefined ? [iso.mx, iso.my] : [hero.x, hero.y]
    const from = apply(m3, hp[0], hp[1])
    const to = axoPoint(bv, hp, 0)
    const v: PlotAxo = { ...iso, psi: lerp(a.psi, bv.psi), e: lerp(a.e, bv.e), k: Math.exp(lerp(Math.log(a.k), Math.log(bv.k))), x: 0, y: 0 }
    const h0 = axoPoint(v, hp, 0)
    return { ...v, x: lerp(from[0], to[0]) - h0[0], y: lerp(from[1], to[1]) - h0[1] }
  }
  const mid: PlotAxo = { ...iso, psi: lerp(a.psi, bv.psi), e: lerp(a.e, bv.e), k: 1, x: 0, y: 0 }
  const board = plot.object.hull.slice(0, 3 * plot.object.hullBoard)
  const across = (v: PlotAxo): number => {
    const pts = Array.from({ length: board.length / 3 }, (_, i) => axoPoint(v, [board[3 * i] as number, board[3 * i + 1] as number], board[3 * i + 2] as number))
    return Math.max(...pts.flatMap((q) => pts.map((r) => Math.hypot(q[0] - r[0], q[1] - r[1]))))
  }
  const wb = across(bv)
  const bb = hullBox(bv, plot.object.hull)
  const over = Math.max(1, bb.w / (0.94 * W), bb.h / (0.9 * H))
  const lin = landing(clamp01(beat - Bt.tilt[0]))
  const sizeFrom = (wa: number) => (u: number, v: number): number => {
    const at = (x: number, y: number): number => x + (y - x) * u
    const m: PlotAxo = { ...iso, psi: at(a.psi, bv.psi), e: at(a.e, bv.e), k: 1, x: 0, y: 0 }
    const unit = hullBox(m, plot.object.hull)
    const d = across(m)
    const kw = Math.exp(Math.log(wa) + (Math.log(wb) - Math.log(wa)) * v) / d
    const kf = Math.min((1.3 * W) / unit.w, (1.15 * H) / unit.h) * over ** u
    const soft = 0.25 * kw
    return d * (Math.min(kw, kf) - Math.max(0, soft - Math.abs(kw - kf)) ** 2 / (4 * soft))
  }
  const sizeAt = sizeFrom(sizeFrom(across({ ...iso, psi: a.psi, e: a.e, k: a.k, x: 0, y: 0 }))(0, 0))
  const reach = Math.min(0.12, t, 1 - t)
  const k = [-1, -0.5, 0, 0.5, 1].reduce((sum, d) => sum + sizeAt(t + d * reach, clamp01(lin + d * reach)), 0) / (5 * across(mid))
  const v0: PlotAxo = { ...mid, k, x: lerp(a.x, bv.x), y: lerp(a.y, bv.y) }
  const box = hullBox(v0, plot.object.hull)
  const shift = (lo: number, size: number, span: number): number => Math.max(0.05 * span - lo, Math.min(0, 0.95 * span - lo - size))
  const end = t * t
  return { ...v0, x: v0.x + shift(box.x, box.w, W) + (bv.x - v0.x - shift(box.x, box.w, W)) * end, y: v0.y + shift(box.y, box.h, H) + (bv.y - v0.y - shift(box.y, box.h, H)) * end }
}






function stackLabels(pen: Pen, s: TraceScene, plot: PlotScore, view: PlotAxo, st: ObjectState, beat: number, frames: number): Array<{ x: number; y: number; w: number; h: number }> {
  const n = plot.stack.length
  const lands = [...plot.beats.lands, plot.beats.lift[1]]
  const out = Math.max(0, 1 - clamp01((beat - plot.beats.parts - 0.5) / 0.5))
  if (out <= 0 || beat < plot.beats.lift[1] || plot.beats.lift[1] <= plot.beats.lift[0]) return []
  const m0 = axoAff(view, 0)
  const pts: Pt[] = []
  const anchorAt = (z: number): Pt => {
    const m = axoAff(view, z)
    let best: Pt = [-Infinity, 0]
    for (const l of s.board)
      for (let i = 0; i + 1 < l.length; i += 2) {
        const q = apply(m, l[i] as number, l[i + 1] as number)
        pts.push(q)
        if (q[0] > best[0]) best = q
      }
    return best
  }
  const rows = stackLabelRows(plot.facts.parts, plot.stack).slice(0, n).map((r, i) => ({ ...r, at: anchorAt(st.lift[i] ?? 0), ...calloutSize(r.text, r.sub, pen.su, FILM_TEXT, FILM_SUB) }))
  for (const l of s.board) for (let i = 0; i + 1 < l.length; i += 2) pts.push(apply(m0, l[i] as number, l[i + 1] as number))
  const x0 = Math.min(...pts.map((q) => q[0]))
  const y0 = Math.min(...pts.map((q) => q[1]))
  const box = { x: x0, y: y0, w: Math.max(...pts.map((q) => q[0])) - x0, h: Math.max(...pts.map((q) => q[1])) - y0 }
  const fr = calloutFrame(pen.W, pen.H)
  const L = FILM_TEXT * pen.su
  const rowH = 1.7 * L
  const wMax = Math.max(...rows.map((r) => r.w))
  const right = box.x + box.w + 1.2 * L + wMax <= fr.x1
  const left = box.x - 1.2 * L - wMax >= fr.x0
  const above = box.y - 0.6 * L - rows.length * rowH >= fr.y0
  if (!right && !left && !above) return []
  const x = right ? box.x + box.w + 1.2 * L : left ? box.x - 1.2 * L - wMax : Math.min(fr.x1 - wMax, box.x + box.w - wMax)
  const top = right || left || !above ? Math.min(fr.y1 - rows.length * rowH, Math.max(fr.y0, box.y + box.h / 2 - (rows.length * rowH) / 2)) : box.y - 0.6 * L - rows.length * rowH
  drawCallouts(pen, rows.flatMap((r, i): Callout[] => {
    const grow = Math.round(plotFrame(beat * B, frames) - plotFrame((lands[i] ?? plot.beats.lift[1]) * B, frames))
    return grow < 0 ? [] : [{ at: r.at, rect: { x, y: top + i * rowH, w: r.w, h: r.h }, text: r.text, sub: r.sub, grow: 99, alpha: out }]
  }), FILM_TEXT * pen.su, FILM_SUB * pen.su)
  return [{ x, y: top, w: wMax, h: rows.length * rowH }]
}

/** the view the film ends on, which is the sheet's */
export function posterView(tl: TraceTimeline): PlotAxo {
  const plot = tl.scene.plot
  if (plot === undefined) throw new Error('not a blueprint film')
  return objectView(tl.scene, plot, plotClock(tl.totalFrames - 1, tl.totalFrames), tl.width, tl.height)
}

/** the screen box the exploded stack, its lifted parts included, fills at a film frame */
export function stackBox(tl: TraceTimeline, frame: number): { x: number; y: number; w: number; h: number } {
  const plot = tl.scene.plot
  if (plot === undefined) throw new Error('not a blueprint film')
  const p = plotClock(frame, tl.totalFrames)
  const view = objectView(tl.scene, plot, p, tl.width, tl.height)
  const st = objectState(plot, p / B)
  const up = (st.lift[0] ?? 0) + st.parts
  const hull = plot.object.hull
  return hullBox(view, Array.from({ length: hull.length / 3 }, (_, i) => [hull[3 * i] as number, hull[3 * i + 1] as number, (hull[3 * i + 2] as number) + ((hull[3 * i + 2] as number) >= 0 ? up : 0)]).flat())
}

/** the hero's axonometric view and its callouts at a film frame */
export function heroFrame(tl: TraceTimeline, frame: number): { view: PlotAxo; callouts: Callout[] } {
  const plot = tl.scene.plot
  if (plot === undefined) throw new Error('not a blueprint film')
  const p = plotClock(frame, tl.totalFrames)
  return { view: objectView(tl.scene, plot, p, tl.width, tl.height), callouts: [] }
}

const convexHull = (pts: Pt[]): Pt[] => {
  const ps = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: Pt[]): Pt[] => {
    const out: Pt[] = []
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2] as Pt, out[out.length - 1] as Pt, q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(ps), ...half([...ps].reverse())]
}

/** the frames a dimension takes to grow to its full length */
export const SLIDE = 8

/** the frames the object's bodies take to come in over the tilt */
const ENTER_FRAMES = 8

/**
 * The blueprint film: one cyanotype sheet whose drawing grows in fine ink,
 * then the assembled board drawn oblique, then the sheet built around it.
 * Every line is white ink in a 4:2:1 weight ladder; the one yellow accent is
 * the signal path.
 */
/** how far the sheet jumps on the two frames after the stamp lands, in 1080ths of the frame's short side */
const SHAKE: Pt[] = [[6, -4], [-3, 2]]

export function drawPlotFrame(paper: CanvasRenderingContext2D, tl: TraceTimeline, frame: number, scale = 1): number {
  const plot = tl.scene.plot
  if (plot === undefined) return 0
  const stamp = plot.events.find((e) => e.kind === 'stamp')
  const jolt = stamp === undefined ? undefined : SHAKE[frame - Math.round(plotFrame(stamp.t0, tl.totalFrames))]
  const ctx = jolt === undefined ? paper : shaken(paper, (jolt[0] * scale * Math.min(tl.width, tl.height)) / 1080, (jolt[1] * scale * Math.min(tl.width, tl.height)) / 1080)
  if (jolt !== undefined) stock({ ctx: paper, k: scale, u: Math.min(tl.width, tl.height) / 1080, su: sheetUnit(tl.width, tl.height), W: tl.width, H: tl.height, stock: tl.palette.bg, ink: sheetInk(tl.palette), accent: signalInk(tl.palette), transparent: tl.transparent }, tl)
  const pen: Pen = { ctx, k: scale, u: Math.min(tl.width, tl.height) / 1080, su: sheetUnit(tl.width, tl.height), W: tl.width, H: tl.height, stock: tl.palette.bg, ink: sheetInk(tl.palette), accent: signalInk(tl.palette), transparent: tl.transparent }
  ctx.save()
  stock(pen, tl)
  const drawn = drawBody(ctx, tl, plot, frame, scale)
  ctx.restore()
  setT(pen, ID)
  return drawn
}

/** the context with every transform set on it moved by dx, dy */
const shaken = (ctx: CanvasRenderingContext2D, dx: number, dy: number): CanvasRenderingContext2D => new Proxy(ctx, {
  get: (t, prop): unknown => {
    if (prop === 'setTransform') return (a: number, b: number, c: number, d: number, e: number, f: number): void => { t.setTransform(a, b, c, d, e + dx, f + dy) }
    const v: unknown = Reflect.get(t, prop, t)
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
  },
  set: (t, prop, v): boolean => Reflect.set(t, prop, v, t)
})

function drawBody(paper: CanvasRenderingContext2D, tl: TraceTimeline, plot: PlotScore, frame: number, scale: number): number {
  const s = tl.scene
  const W = tl.width
  const H = tl.height
  const u = Math.min(W, H) / 1080
  const bands: Pt[][] = []
  const ctx = banded(paper, bands, tl.palette.bg)
  const pen: Pen = { ctx, k: scale, u, su: sheetUnit(W, H), W, H, stock: tl.palette.bg, ink: sheetInk(tl.palette), accent: signalInk(tl.palette), transparent: tl.transparent, bands, chip: s.parts.find((q) => q.hero === true), ...(plotClock(frame, tl.totalFrames) < plot.beats.pull[0] * B ? { hero: { label: plot.hero.label, pin1: plot.hero.pin1, read: planReading(s, plot, W, H), part: plot.signal !== undefined } } : {}), lid: lidName(s, plot, W, H) }
  const p = plotClock(frame, tl.totalFrames)
  const beat = p / B
  const S = plot.shots
  const pxPerMm = s.material.pxPerMm
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  stock(pen, tl)
  let drawn = 0
  const shot = plot.film.shots.find((q) => p < q.t1) ?? plot.film.shots[0]
  const travels = travelled(plot)
  const mB = flatView(s, S.bus[1] - 0.0011, W, H)
  if (p >= S.object[0] && shot?.kind !== 'signature') {
    const view = objectView(s, plot, p, W, H)
    const plane = (mi: Aff, named: boolean): number => {
      const r = scaleOf(mi) / scaleOf(axoAff(view, 0))
      const rise = plot.object.wave.find((q) => s.parts.some((pt) => pt.hero === true && pt.x === q.x && pt.y === q.y))
      const n = travelPlan(named && (rise === undefined || beat < rise.t1) ? pen : { ...pen, hero: undefined }, s, plot, mi, mB, travelOpts(plot, p), p, tl.totalFrames, (z) => [mi[0], mi[1], mi[2], mi[3], mi[4], mi[5] + r * view.k * Math.cos(view.e) * z])
      return n
    }
    const st: ObjectState = { ...(p >= S.sheet[0] ? { lift: plot.stack.map(() => 0), parts: 0, proj: 0, hidden: 1, copper: 0.6, bodies: 1 } : { ...objectState(plot, beat, s), ...(travels ? { bodies: 1 } : {}) }), read: heroReading(s, plot, W, H), ...(travels ? { plane, rest: REST_BODIES } : {}) }
    const cam = camAt(s, p, W, H)
    let column: Array<{ x: number; y: number; w: number; h: number }> = []
    const trailEnd = Math.max(0, ...plot.object.trail.map((sg) => sg.p1))
    const flow = (): number => drawFlow(pen, plot.flow.path, plot.flow.vias, plot.flow.pins, plot.flow.end, axoAff(view, 0), p) + (plot.object.trail.length > 0 ? drawFlow(pen, plot.object.trail, [], [], trailEnd, axoAff(view, 0), p) : 0)
    const hides: Pt[][] = []
    if (p >= S.sheet[0]) {
      drawn += drawSheet({ ...pen, hides }, tl, plot, beat - S.sheet[0] / B, view, st, flow)
      hiddenFlow(pen, plot.flow.path, axoAff(view, 0), p, hides)
    } else {
      const t8 = plot.beats.tilt[0]
      const fade = clamp01(beat - t8)
      if (fade < 1) drawGrid(pen, flatView(s, S.object[0] - 0.0011, W, H), pxPerMm, 1 - fade)
      drawGrid(pen, [cam.zoom, 0, 0, cam.zoom, W / 2 - cam.zoom * cam.x, H / 2 - cam.zoom * cam.y], (13.5 * u) / 10, fade)
      const standing = plot.film.signature.kind === 'section'
      const enter = standing || travels ? 1 : clamp01(((beat - t8) * 15) / ENTER_FRAMES)
      if (enter < 1) ctx.filter = `opacity(${enter})`
      drawn += drawObject({ ...pen, hides }, s, plot, view, st, flow)
      hiddenFlow(pen, plot.flow.path, axoAff(view, 0), p, hides)
      ctx.filter = 'none'
      const leave = standing || travels ? 0 : 1 - easeInOut((beat - t8) / 0.8)
      if (leave > 0) {
        drawPlan(pen, s, axoAff(view, 0), { alpha: leave, edge: 1, back: 1, drills: 3, hatch: 1, parts: 1, fine: 1, weight: 2 })
        ctx.globalAlpha = leave
        drawn += flow()
      }
      ctx.globalAlpha = 1
      inkDensity(pen, s, axoAff(view, 0))
      column = stackLabels(pen, s, plot, view, st, beat, tl.totalFrames)
    }
    if (p < plot.beats.sheet / 24) {
      const hb = plot.object.hull.slice(0, 3 * plot.object.hullBoard)
      const sil = convexHull(Array.from({ length: hb.length / 3 }, (_, i) => apply(axoAff(view, hb[3 * i + 2] as number), hb[3 * i] as number, hb[3 * i + 1] as number)))
      stationPills(pen, plot, p, tl.totalFrames, (x, y) => apply(axoAff(view, 0), x, y), sil, column)
    }
    wear(pen)
    return drawn
  }

  const m = flatView(s, p, W, H)
  drawGrid(pen, m, pxPerMm)
  const outlinePts = (): Pt[] => s.board.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i) => apply(m, l[2 * i] as number, l[2 * i + 1] as number)))
  const path = (): void => {
    drawFlow(pen, plot.flow.path, plot.flow.vias, plot.flow.pins, plot.flow.end, m, p)
    stationPills(pen, plot, p, tl.totalFrames, (x, y) => apply(m, x, y), convexHull(outlinePts()), [])
  }
  const pairSig = shot?.kind === 'signature' && plot.film.signature.kind === 'pair'
  if (shot?.kind === 'signature' && !pairSig) {
    drawn += drawSignature(pen, s, plot, m, p, tl.totalFrames)
    const g = plot.film.signature.kind
    if (g === 'section' || g === 'header') stationPills(pen, plot, p, tl.totalFrames, undefined, [], [])
    else path()
    wear(pen)
    return drawn
  }

  if (shot?.kind === 'open' || shot?.kind === 'macro' || pairSig) {
    const first = shot.kind === 'open'
    const front = pairSig && travels ? plot.ink : undefined
    ctx.save()
    if (front === undefined && first) drawn += drawPlan(pen, s, m, { construction: true })
    ctx.restore()
    const strokes = first ? plot.nib.strokes : plot.bus.strokes
    const judge = first ? 0 : scaleOf(flatView(s, S.bus[1] - 0.0011, W, H))
    if (pairSig) {
      const near = Math.min(NEAR_GAIN, Math.max(1, scaleOf(m) / Math.max(1e-9, judge)))
      inkStrokes({ ...pen, ink: mixHex(pen.ink, pen.stock, 1 - SWEEP_FINE) }, m, plot.bus.sweep, p, judge, false, near, near * sweepCap(pen))
      inkStrokes({ ...pen, ink: pen.accent }, m, strokes, p, 0, true, PAIR_GAIN * near)
    } else {
      inkStrokes(pen, m, first ? strokes : [...plot.bus.sweep, ...strokes.filter((st) => st.accent !== true)].sort((x, y) => x.t0 - y.t0), p, judge, !first || plot.film.plan === 'stick')
      if (!first) inkStrokes({ ...pen, ink: pen.accent }, m, [...strokes.filter((st) => st.accent === true), ...plot.bus.line], p, 0, true, PAIR_GAIN)
    }
    drawn += 1
    const hero = s.parts.find((q) => q.hero === true)
    const lid = hero === undefined ? undefined : bodyOf(plot, hero)
    const mark = plot.nib.mark
    const read = heroReading(s, plot, W, H)
    if (first && mark !== undefined && hero !== undefined && lid !== undefined && read !== undefined && p >= mark) {
      penMark(pen, frameOf(() => m, 0, hero), frameOf(() => flatView(s, mark, W, H), 0, hero), lid.value.split(/[-\s/]/)[0] ?? '', read, Math.round(plotFrame(p, tl.totalFrames) - plotFrame(mark, tl.totalFrames)) + 1)
    }
    path()
    wear(pen)
    return drawn
  }

  const span = (S.outline[1] - S.outline[0]) / B
  const head = Math.min(S.outline[0] <= 0 ? OUTLINE_HEAD : CUT_HEAD, 0.5 * span)
  const rel = head + ((p - S.outline[0]) / B) * ((span - head) / span)
  const bxs = s.board.flatMap((l) => l.filter((_, i) => i % 2 === 0))
  const bys = s.board.flatMap((l) => l.filter((_, i) => i % 2 === 1))
  const kEdge = (S.outline[0] > 0 ? easeOut : easeInOut)(clamp01(rel / Math.min(0.8, 0.35 * span)))
  const sig = plot.film.signature
  const kCopper = sig.kind === 'pair' ? 0.15 + 0.85 * easeInOut(clamp01(rel / (0.9 * span))) : easeInOut(clamp01((rel - 0.1 * span) / (0.85 * span)))
  const diag = Math.hypot(Math.max(...bxs) - Math.min(...bxs), Math.max(...bys) - Math.min(...bys)) * scaleOf(flatView(s, S.outline[1] - 0.0011, W, H))
  if (plot.ink !== undefined && travels) {
    drawn += travelPlan(pen, s, plot, m, mB, travelOpts(plot, p), p, tl.totalFrames)
    path()
    const cut = plot.section
    if (cut !== undefined && cut.over && p >= cut.t.line[0]) {
      const R = flatView(s, cut.t.line[0], W, H)
      drawSection({ ...pen, base: mul(m, invert(R)) }, cut, R, p, tl.totalFrames)
    }
    wear(pen)
    return drawn
  }
  drawPlan(pen, s, m, { construction: true })
  if (sig.kind === 'pair') inkStrokes({ ...pen, ink: mixHex(pen.ink, pen.stock, 1 - SWEEP_FINE) }, m, plot.bus.sweep, 1, scaleOf(mB), false, 1, sweepCap(pen))
  const plan = (gp: Pen): number => drawPlan(gp, s, m, travelOpts(plot, p))
  if (kCopper > 0) drawn += kCopper < 1 ? growing(pen, kCopper, 0.5 * diag, plan) : plan(pen)
  if (kEdge > 0)
    drawn += growing(pen, kEdge, 2.2 * diag, (gp) => {
      setT(gp, m)
      gp.ctx.strokeStyle = gp.ink
      gp.ctx.lineWidth = weights(gp.u).h / scaleOf(m)
      gp.ctx.stroke(geo(s).outline)
      setT(gp, ID)
      return 1
    })
  inkStrokes({ ...pen, ink: pen.accent }, m, sig.kind === 'pair' ? plot.bus.strokes : [...plot.bus.strokes.filter((st) => st.accent === true), ...plot.bus.line], 1, 0, true, PAIR_GAIN)
  path()
  wear(pen)
  return drawn
}

const TRAVEL_PLAN: PlanOpts = { edge: 0, back: 1, drills: 3, hatch: 1, parts: 1, fine: REST_FINE, lead: FAN_FINE, weight: 1 }
/** copper is outlined at its true width only on the ride, before the chip's arrival; from the arrival on every track is one stroke in the pen's weight */
const travelOpts = (plot: PlotScore, p: number): PlanOpts => (p < (plot.ink?.hold[0] ?? 0) ? { ...TRAVEL_PLAN, solid: true } : TRAVEL_PLAN)

/** film time a line's fresh head stays bright */
const FRESH = 0.25 * B

interface FanSeg { a: Pt; b: Pt; w: number; lead: boolean; t0: number; t1: number }

const FANS = new WeakMap<PlotInk, { segs: FanSeg[]; rest: Front; done: number }>()

/** the chip's own signals near it, held back and drawn outward from the chip along their copper, the rest of the front copper, and the film time the last ink lands */
function fanOf(s: TraceScene, ink: PlotInk): { segs: FanSeg[]; rest: Front; done: number } {
  const hit = FANS.get(ink)
  if (hit !== undefined) return hit
  const c: Pt = [ink.far.x, ink.far.y]
  const { fan: segs, rest: loose } = fanInk(s.layers, s.groups, s.parts.find((q) => q.hero === true), ink)
  const rest = new Map<number, Path2D>()
  for (const q of loose) {
    const k = q.lead ? -q.w - 1 : q.w
    const path = rest.get(k) ?? new Path2D()
    rest.set(k, path)
    path.moveTo(q.a[0], q.a[1])
    path.lineTo(q.b[0], q.b[1])
  }
  const { x0, y0, x1, y1 } = geo(s).bounds
  const far = Math.max(...[[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => Math.hypot((x as number) - c[0], (y as number) - c[1])))
  const out = {
    segs,
    rest: [...rest.entries()].map(([k, path]) => ({ w: k < 0 ? -k - 1 : k, path, lead: k < 0 })).sort((x, y) => Number(x.lead) - Number(y.lead)),
    done: Math.max(ink.far.t + far / ink.far.v + ink.hold[1] - ink.hold[0], ...segs.map((q) => q.t1))
  }
  FANS.set(ink, out)
  return out
}

interface Ring { x: number; y: number; t: number; v: number }
interface Seed { u: number; t: number; v: number }
interface InkRun { loose: Array<{ a: Pt; b: Pt; w: number; lead: boolean; seed: Seed }>; layers: Seed[][]; pads: number[]; vias: number[]; drills: number[]; parts: number[]; zones: Seed[][]; board: Seed[][] }
const REVEALS = new WeakMap<PlotInk, InkRun>()

const ringsOf = (ink: PlotInk): Ring[] => {
  const out: Ring[] = [{ x: ink.far.x, y: ink.far.y, t: ink.far.t, v: ink.far.v }]
  for (let i = 0; i + 3 < ink.src.length; i += 4) out.push({ x: ink.src[i] as number, y: ink.src[i + 1] as number, t: ink.src[i + 2] as number, v: ink.src[i + 3] as number })
  return out.filter((r) => r.v > 0)
}

const seedOf = (rings: Ring[], ax: number, ay: number, bx: number, by: number): Seed => {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let best: Seed = { u: 0, t: Infinity, v: 1 }
  for (const r of rings) {
    const u = l2 > 0 ? clamp01(((r.x - ax) * dx + (r.y - ay) * dy) / l2) : 0
    const t = r.t + Math.hypot(ax + dx * u - r.x, ay + dy * u - r.y) / r.v
    if (t < best.t) best = { u, t, v: r.v }
  }
  return best
}

const markTime = (rings: Ring[], x: number, y: number): number => {
  let t = Infinity
  for (const r of rings) t = Math.min(t, r.t + Math.hypot(x - r.x, y - r.y) / r.v)
  return t
}

function inkRuns(s: TraceScene, ink: PlotInk): InkRun {
  const hit = REVEALS.get(ink)
  if (hit !== undefined) return hit
  const rings = ringsOf(ink)
  const { rest } = fanInk(s.layers, s.groups, s.parts.find((q) => q.hero === true), ink)
  const seed = (ax: number, ay: number, bx: number, by: number): Seed => {
    const stood = standSeed(ink, [ax, ay], [bx, by])
    const run = seedOf(rings, ax, ay, bx, by)
    return stood !== undefined && stood.t < run.t ? stood : run
  }
  const mark = (x: number, y: number): number => Math.min(markTime(rings, x, y), standTime(ink, x, y))
  const loopSeeds = (l: number[]): Seed[] => Array.from({ length: l.length / 2 }, (_, i) => seed(l[2 * i] as number, l[2 * i + 1] as number, l[(2 * i + 2) % l.length] as number, l[(2 * i + 3) % l.length] as number))
  const out: InkRun = {
    loose: rest.map((q) => ({ ...q, seed: seed(q.a[0], q.a[1], q.b[0], q.b[1]) })),
    layers: s.layers.map((l) => Array.from({ length: Math.floor(l.segs.length / 7) }, (_, i) => seed(l.segs[7 * i] as number, l.segs[7 * i + 1] as number, l.segs[7 * i + 2] as number, l.segs[7 * i + 3] as number))),
    pads: s.pads.map((q) => mark(q.x, q.y)),
    vias: s.vias.map((q) => mark(q.x, q.y)),
    drills: s.drills.map((q) => mark(q.x, q.y)),
    parts: s.parts.map((q) => mark(q.x, q.y)),
    zones: s.zones.map((z) => loopSeeds(z.fill)),
    board: s.board.map(loopSeeds)
  }
  REVEALS.set(ink, out)
  return out
}

const runOf = (seed: Seed, len: number, now: number): [number, number] | undefined => {
  const r = (now - seed.t) * seed.v
  if (!(r > 0)) return undefined
  const k = r / Math.max(1e-9, len)
  return [Math.max(0, seed.u - k), Math.min(1, seed.u + k)]
}

/** the scene and front copper as far as the ink has drawn them at raw ink time now: each line one run along itself, each pad, via, part and pour whole once reached */
export function revealed(s: TraceScene, ink: PlotInk, now: number): { s: TraceScene; front: Front } {
  const rv = inkRuns(s, ink)
  const lerp = (a: number, b: number, k: number): number => a + (b - a) * k
  const front = new Map<number, Path2D>()
  for (const q of rv.loose) {
    const run = runOf(q.seed, Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]), now)
    if (run === undefined) continue
    const key = q.lead ? -q.w - 1 : q.w
    const path = front.get(key) ?? new Path2D()
    front.set(key, path)
    path.moveTo(lerp(q.a[0], q.b[0], run[0]), lerp(q.a[1], q.b[1], run[0]))
    path.lineTo(lerp(q.a[0], q.b[0], run[1]), lerp(q.a[1], q.b[1], run[1]))
  }
  const layers = s.layers.map((l, li) => {
    const segs: number[] = []
    const groups: number[] = []
    const energy: number[] = []
    for (let i = 0; 7 * i + 6 < l.segs.length; i++) {
      const [x0, y0, x1, y1] = [l.segs[7 * i] as number, l.segs[7 * i + 1] as number, l.segs[7 * i + 2] as number, l.segs[7 * i + 3] as number]
      const run = runOf((rv.layers[li] as Seed[])[i] as Seed, Math.hypot(x1 - x0, y1 - y0), now)
      if (run === undefined) continue
      segs.push(lerp(x0, x1, run[0]), lerp(y0, y1, run[0]), lerp(x0, x1, run[1]), lerp(y0, y1, run[1]), ...l.segs.slice(7 * i + 4, 7 * i + 7))
      groups.push(l.groups[i] as number)
      energy.push(l.energy[2 * i] as number, l.energy[2 * i + 1] as number)
    }
    return { ...l, segs, groups, energy }
  })
  const board = s.board.flatMap((l, li) => (rv.board[li] as Seed[]).flatMap((seed, i) => {
    const [x0, y0, x1, y1] = [l[2 * i] as number, l[2 * i + 1] as number, l[(2 * i + 2) % l.length] as number, l[(2 * i + 3) % l.length] as number]
    const run = runOf(seed, Math.hypot(x1 - x0, y1 - y0), now)
    return run === undefined ? [] : [[lerp(x0, x1, run[0]), lerp(y0, y1, run[0]), lerp(x0, x1, run[1]), lerp(y0, y1, run[1])]]
  }))
  const zones = s.zones.flatMap((z, zi) => {
    const l = z.fill
    const runs = (rv.zones[zi] as Seed[]).map((seed, i) => {
      const [x0, y0, x1, y1] = [l[2 * i] as number, l[2 * i + 1] as number, l[(2 * i + 2) % l.length] as number, l[(2 * i + 3) % l.length] as number]
      const run = runOf(seed, Math.hypot(x1 - x0, y1 - y0), now)
      return run === undefined ? undefined : { fill: [lerp(x0, x1, run[0]), lerp(y0, y1, run[0]), lerp(x0, x1, run[1]), lerp(y0, y1, run[1])], whole: run[0] === 0 && run[1] === 1 }
    })
    return runs.every((q) => q?.whole === true) ? [z] : runs.flatMap((q) => (q === undefined ? [] : [{ ...z, fill: q.fill }]))
  })
  const by = <T,>(list: T[], times: number[]): T[] => list.filter((_, i) => (times[i] as number) <= now)
  return {
    s: { ...s, layers, board, pads: s.pads.filter((q, i) => q.hero === true || (rv.pads[i] as number) <= now), vias: by(s.vias, rv.vias), drills: by(s.drills, rv.drills), parts: by(s.parts, rv.parts), zones },
    front: [...front.entries()].map(([k, path]) => ({ w: k < 0 ? -k - 1 : k, path, lead: k < 0 })).sort((x, y) => Number(x.lead) - Number(y.lead))
  }
}

function inked(pen: Pen, s: TraceScene, ink: PlotInk, m: Aff, p: number, draw: (q: Pen, at: TraceScene, front?: Front) => number): number {
  if (p >= fanOf(s, ink).done + FRESH) return draw(pen, s)
  const ctx = pen.ctx
  const now = inkClock(ink, p)
  ctx.save()
  setT(pen, m)
  ctx.clip(geo(s).outline, 'evenodd')
  const fresh = revealed(s, ink, now)
  draw({ ...pen, ink: '#ffffff', hero: undefined }, { ...fresh.s, pads: fresh.s.pads.filter((q) => q.hero !== true) }, fresh.front)
  ctx.restore()
  ctx.save()
  const old = revealed(s, ink, now - FRESH)
  const n = draw(pen, old.s, old.front)
  ctx.restore()
  return n
}

/** the chip's signals drawn out from it, each as far as it has grown at p, its head white */
function drawFan(pen: Pen, s: TraceScene, ink: PlotInk, m: Aff, p: number, o: PlanOpts): void {
  const grown = new Map<number, Path2D>()
  const heads = new Map<number, Path2D>()
  const into = (bucket: Map<number, Path2D>, q: FanSeg, k0: number, k1: number): void => {
    const key = q.lead ? -q.w - 1 : q.w
    const path = bucket.get(key) ?? new Path2D()
    bucket.set(key, path)
    path.moveTo(q.a[0] + (q.b[0] - q.a[0]) * k0, q.a[1] + (q.b[1] - q.a[1]) * k0)
    path.lineTo(q.a[0] + (q.b[0] - q.a[0]) * k1, q.a[1] + (q.b[1] - q.a[1]) * k1)
  }
  for (const q of fanOf(s, ink).segs) {
    if (p < q.t0) continue
    const k = clamp01((p - q.t0) / Math.max(1e-9, q.t1 - q.t0))
    into(grown, q, 0, k)
    if (p < q.t1 + FRESH) into(heads, q, clamp01((p - FRESH - q.t0) / Math.max(1e-9, q.t1 - q.t0)), k)
  }
  const list = (b: Map<number, Path2D>): Front => [...b.entries()].map(([key, path]) => ({ w: key < 0 ? -key - 1 : key, path, lead: key < 0 }))
  if (grown.size > 0) drawPlan(pen, s, m, { ...o, front: list(grown), bare: true })
  if (heads.size > 0) drawPlan({ ...pen, ink: '#ffffff', hero: undefined }, s, m, { ...o, lead: FAN_HEAD, fine: FAN_HEAD, front: list(heads), bare: true })
}

/** whether the film travels its signal: then the plan it travelled over is the drawing's top copper to the last frame, and nothing is cross-faded at the turn */
const travelled = (plot: PlotScore): boolean => plot.film.shots.some((q) => q.kind === 'outline') && plot.film.signature.kind !== 'section' && !tiltCut(plot)

/** the travel's plan through m as far as it is drawn at p: pencil ahead, then the ink spreading from the signal, the chip's signals fanning out, and the pair in the accent */
function travelPlan(pen: Pen, s: TraceScene, plot: PlotScore, m: Aff, mB: Aff, o0: PlanOpts, p: number, frames: number, below?: (z: number) => Aff): number {
  const ink = plot.ink
  const o = plot.hidden === undefined ? o0 : { ...o0, back: 0 }
  const pair = plot.film.signature.kind === 'pair'
  const fan = ink === undefined ? undefined : fanOf(s, ink)
  const body = (q: Pen, at = s, front = fan?.rest): number => {
    if (pair && ink === undefined) inkStrokes({ ...q, ink: mixHex(q.ink, q.stock, 1 - SWEEP_FINE) }, m, plot.bus.sweep, 1, scaleOf(mB), false, 1, sweepCap(q))
    const n = drawPlan(q, at, m, front === undefined ? o : { ...o, front })
    setT(q, m)
    q.ctx.strokeStyle = q.ink
    q.ctx.lineWidth = weights(q.u).h / scaleOf(m)
    q.ctx.stroke(geo(at).outline)
    return n
  }
  let n: number
  if (ink === undefined) {
    drawPlan(pen, s, m, { construction: true })
    n = body(pen)
  } else {
    drawHidden(pen, s, plot, m, p, below)
    n = inked(pen, s, ink, m, p, body)
    if (pair) inkStrokes({ ...pen, ink: mixHex(pen.ink, pen.stock, 1 - SWEEP_FINE) }, m, plot.bus.sweep, p, scaleOf(mB), false, 1, sweepCap(pen))
    drawFan(pen, s, ink, m, p, { ...o, fine: FAN_FINE, lead: FAN_FINE, weight: FAN_WEIGHT })
    if (p >= fanOf(s, ink).done) heroPencil(pen, s, m)
  }
  const cut = plot.section
  if (cut !== undefined && p >= cut.t.line[0]) {
    const R = flatView(s, cut.t.line[0], pen.W, pen.H)
    if (!cut.over) drawSection({ ...pen, base: mul(m, invert(R)) }, cut, R, p, frames)
  }
  inkStrokes({ ...pen, ink: pen.accent }, m, pair ? plot.bus.strokes : [...plot.bus.strokes.filter((st) => st.accent === true), ...plot.bus.line], ink === undefined ? 1 : p, 0, true, PAIR_GAIN)
  setT(pen, ID)
  return n
}

const OUTLINE_HEAD = 0.5
const CUT_HEAD = 0.3

/** Section A–A drawn on in the view the camera holds over it: the cutting line, its arrows and letters, the panel's paper with its frame, each layer from the top with its name, the via posts, the pads, the chip, the title. It is lettered at the film's text size; the pen's base carries it onto the board, so it tilts with the sheet */
function drawSection(pen: Pen, sc: PlotSection, R: Aff, p: number, frames: number): void {
  const ctx = pen.ctx
  const { f, m: med, h } = weights(pen.u)
  const u = pen.u
  const since = (t: number): number => plotFrame(p, frames) - plotFrame(t, frames)
  const grown = (t: number, n = SECTION_GROW): number => clamp01((since(t) + 1) / n)
  const T = sc.t
  const z = scaleOf(R)
  const c = apply(R, sc.at[0], sc.at[1])
  const xs = (t: number): number => c[0] + t * z
  const size = sc.size
  const n = sc.layers.length
  const gap = SECTION_ROW * size
  const lid = 1.1 * size
  const pad = 7 * u
  const lab = (Math.max(...sc.layers.map((l) => l.name.length)) * 0.66 + 1.5) * size
  const zk = z * sc.scale
  const rows = Math.ceil(n / sc.cols)
  const bx = c[0] + sc.panel[0] * z
  const bw = (sc.panel[2] - sc.panel[0]) * z
  const colOf = (i: number): number => Math.floor(i / rows)
  const xpIn = (col: number) => (t: number): number => bx + col * (2 * sc.half * zk + 60 * u + lab + SECTION_COL_GAP * size) + lab + 30 * u + (sc.half + t) * zk
  const xp = xpIn(0)
  const ph = (sc.panel[3] - sc.panel[1]) * z
  const py0 = c[1] + sc.panel[1] * z
  const top = py0 + (sc.apart ? 2 + SECTION_ROW : 2) * size + pad
  const yOf = (i: number): number => top + (i % rows) * gap
  setT(pen, ID)
  bleed(pen, false)
  ctx.lineCap = 'butt'
  ctx.strokeStyle = pen.ink
  ctx.fillStyle = pen.ink
  const k0 = clamp01((p - T.line[0]) / Math.max(1e-9, T.line[1] - T.line[0]))
  ctx.lineWidth = med
  ctx.setLineDash([22 * u, 5 * u, 3 * u, 5 * u])
  ctx.beginPath()
  ctx.moveTo(xs(sc.line[0]), c[1])
  ctx.lineTo(xs(sc.line[0] + (sc.line[1] - sc.line[0]) * k0), c[1])
  ctx.stroke()
  ctx.setLineDash([])
  if (p >= T.arrows) {
    const k = grown(T.arrows, 2)
    for (const [x, sgn, shown] of [[xs(sc.line[0]), 1, sc.marks[0]], [xs(sc.line[1]), -1, sc.marks[1]]] as Array<[number, number, boolean]>) {
      if (!shown) {
        ctx.lineWidth = 2 * h
        ctx.beginPath()
        ctx.moveTo(x, c[1])
        ctx.lineTo(x, c[1] + END_STROKE * u * k)
        ctx.stroke()
        continue
      }
      ctx.lineWidth = h
      ctx.beginPath()
      ctx.moveTo(x, c[1])
      ctx.lineTo(x, c[1] + 34 * u * k)
      ctx.stroke()
      if (k >= 1) {
        ctx.beginPath()
        ctx.moveTo(x - 10 * u, c[1] + 30 * u)
        ctx.lineTo(x + 10 * u, c[1] + 30 * u)
        ctx.lineTo(x, c[1] + 52 * u)
        ctx.closePath()
        ctx.fill()
      }
      lettered(pen, 'A', x + sgn * 0.75 * size, c[1] - 0.45 * size, size, { align: 'center', base: 'middle', free: true, part: true, clear: NOTE_HALO * size })
    }
  }
  if (p < T.panel || p >= T.gone) return
  const kp = grown(T.panel, 3)
  knockout(pen, () => { ctx.fillRect(bx, py0, bw, ph * kp) })
  ctx.strokeStyle = pen.ink
  ctx.fillStyle = pen.ink
  ctx.lineWidth = med
  ctx.beginPath()
  ctx.moveTo(bx, py0 + ph * kp)
  ctx.lineTo(bx, py0)
  ctx.lineTo(bx + bw, py0)
  ctx.lineTo(bx + bw, py0 + ph * kp)
  if (kp >= 1) ctx.closePath()
  ctx.stroke()
  sc.layers.forEach((l, i) => {
    if (p < l.t) return
    const y = yOf(i)
    const xc = xpIn(colOf(i))
    const head = xc(-sc.half) + (xc(sc.half) - xc(-sc.half)) * grown(l.t)
    ctx.globalAlpha = l.plane ? 0.85 : 0.6
    ctx.lineWidth = l.plane ? med : f
    ctx.beginPath()
    ctx.moveTo(xc(-sc.half), y)
    ctx.lineTo(head, y)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 7 * u
    ctx.beginPath()
    for (const [t, w] of l.cuts) {
      if (xc(t) > head) continue
      ctx.moveTo(xc(t) - (w * zk) / 2, y)
      ctx.lineTo(xc(t) + (w * zk) / 2, y)
    }
    ctx.stroke()
    lettered(pen, l.name, xc(-sc.half) - 30 * u - lab + 0.6 * size, y, size, { base: 'middle', free: true, part: true, chars: 3 * (since(l.t) + 1) })
    ctx.strokeStyle = pen.ink
    ctx.fillStyle = pen.ink
  })
  if (p >= T.posts) {
    const k = grown(T.posts)
    for (let col = 0; col < sc.cols; col++) {
      const span = gap * (Math.min(n, (col + 1) * rows) - col * rows - 1)
      for (const t of sc.posts) {
        const x = xpIn(col)(t)
        knockout(pen, () => { ctx.fillRect(x - POST_W * u, yOf(0), 2 * POST_W * u, span * k) })
        ctx.strokeStyle = pen.ink
        ctx.lineWidth = med
        ctx.strokeRect(x - 0.5 * POST_W * u, yOf(0) - 3.5 * u, POST_W * u, (span + 7 * u) * k)
      }
    }
  }
  if (p >= T.pads) {
    ctx.lineWidth = pad
    ctx.beginPath()
    for (const [t, w] of sc.pads) {
      ctx.moveTo(xp(t) - Math.max(4 * u, w * zk) / 2, yOf(0) - pad / 2)
      ctx.lineTo(xp(t) + Math.max(4 * u, w * zk) / 2, yOf(0) - pad / 2)
    }
    ctx.stroke()
  }
  if (p >= T.chip) {
    const [a, b] = [xp(sc.chip[0]), xp(sc.chip[1])]
    const run = 2 * (b - a + lid)
    ctx.lineWidth = med
    ctx.setLineDash([run * grown(T.chip), run])
    ctx.beginPath()
    ctx.moveTo(a, yOf(0) - pad)
    ctx.lineTo(a, yOf(0) - pad - lid)
    ctx.lineTo(b, yOf(0) - pad - lid)
    ctx.lineTo(b, yOf(0) - pad)
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (p >= T.title) lettered(pen, SECTION_TITLE, bx + 0.6 * size, py0 + 0.85 * size, size, { base: 'middle', free: true, part: true, chars: 3 * (since(T.title) + 1) })
  ctx.lineCap = 'round'
  setT(pen, ID)
}

/** the hidden wiring's dots: their width and their step at 1080, and their strength; a chain of round dots, so it differs in kind from the pencil's long dashes */
const HIDDEN_DOT = 3.4
const HIDDEN_STEP = 9
const HIDDEN_INK = 0.9
/** a via post's width at 1080 */
const POST_W = 9

/** the main chip's wiring on the layers below the top as far as it is drawn at p, each segment growing out from the chip; through below, each layer sinks by its depth */
function drawHidden(pen: Pen, s: TraceScene, plot: PlotScore, m: Aff, p: number, below?: (z: number) => Aff): void {
  const ctx = pen.ctx
  for (const run of plot.hidden ?? []) {
    const path = new Path2D()
    let any = false
    for (let i = 0; i + 5 < run.segs.length; i += 6) {
      const [x0, y0, x1, y1, t0, t1] = run.segs.slice(i, i + 6) as [number, number, number, number, number, number]
      if (p < t0) continue
      const k = clamp01((p - t0) / (t1 - t0))
      path.moveTo(x0, y0)
      path.lineTo(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k)
      any = true
    }
    if (!any) continue
    const mh = below === undefined ? m : below(run.depth)
    const sc = scaleOf(mh)
    ctx.save()
    setT(pen, m)
    ctx.clip(geo(s).outline)
    setT(pen, mh)
    ctx.strokeStyle = pen.ink
    ctx.globalAlpha = HIDDEN_INK
    ctx.lineWidth = (HIDDEN_DOT * pen.u) / sc
    ctx.lineCap = 'round'
    ctx.setLineDash([0, (HIDDEN_STEP * pen.u) / sc])
    ctx.stroke(path)
    ctx.restore()
  }
  setT(pen, ID)
}
