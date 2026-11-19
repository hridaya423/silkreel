import { GLYPH_CHIP_SHARE, GLYPH_CUT_EARLY, GLYPH_Z, LAND_EARLY, driftSeconds, glide, safeArea } from '@silk-reel/choreo'
import type { GlyphTimeline } from '@silk-reel/choreo'

export { glide }

const smooth = (u: number): number => {
  const t = Math.min(1, Math.max(0, u))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u

/** a pull waits this share of its formation's write-in before it starts */
const PULL_WAIT = 0.35
/** the frames the camera rebounds over after a pull lands, and how far, as a share of its scale */
const SETTLE = 12
const REBOUND = 0.008
/** how the push through the plan's hold eases in: slow after the plan is whole, fastest in its last third */
const PUSH_EASE = 2.4
/** the share of the push that creeps from the plan's lock at one speed, so the held plan is alive from its first frame */
const PUSH_CREEP = 0.2
/** the cut to the chip comes this many frames before the scene's first beat, in the dark between the plan and the field */
/** the pull back eases out by this power: most of its travel early, slowing into the stop */
const PULL_OUT = 2

/**
 * The camera's scale at a frame. It opens close on the main chip and glides
 * back until the first formation writes in. Then each pull lands on the frame
 * its formation locks, rebounds a little, and holds until the next one. It is
 * never wider than the glide it replaces.
 */
export function camScale(frame: number, total: number, pulls: Array<[number, number]>): number {
  const first = pulls[0]
  const stop = (i: number): number => (i === 0 ? glide((first?.[0] ?? 0) / total) : glide(((pulls[i - 1] as [number, number])[1] - LAND_EARLY) / total))
  if (first === undefined || frame < first[0]) return glide(frame / total)
  const i = pulls.reduce((at, [a], k) => (frame >= a ? k : at), 0)
  const [a, b] = pulls[i] as [number, number]
  const u = Math.min(1, (frame - a) / (b - a))
  const v = Math.min(1, Math.max(0, (frame - b) / SETTLE))
  return lerp(stop(i), stop(i + 1), smooth((u - PULL_WAIT) / (1 - PULL_WAIT))) * (1 + REBOUND * Math.sin(Math.PI * v) * (1 - v))
}

/** the camera at a frame: its scale, and the point it centres, as an offset in pixels at scale 1 from the frame's centre */
export interface GlyphView {
  scale: number
  dx: number
  dy: number
  /** from the cut to the last scene's lock, only that scene's own marks are drawn */
  scene: boolean
}

interface Scene {
  push: number
  far: number
  aim: [number, number]
  cut: number
  start: number
  lock: number
  close: number
  chip: [number, number]
  fit: [number, number]
  leave: number
  arrive: number
  name: [number, number]
}

/** the frames of the 24-beat score the camera is timed on; the film ends before it does */
const loopFrames = (tl: GlyphTimeline): number => Math.round((tl.steps * tl.fps) / 15)

const scenes = new WeakMap<GlyphTimeline, Scene | null>()

function sceneOf(tl: GlyphTimeline): Scene | null {
  const turn = tl.events.find((e) => e.kind === 'turn')?.at
  const at = tl.pulls.findIndex(([a]) => a === turn)
  const pull = tl.pulls[at]
  const pads = tl.placements.filter((p) => p.stage !== undefined && p.role === 'hero').flatMap((p) => p.atoms)
  const marks = tl.placements.filter((p) => p.stage !== undefined)
  if (turn === undefined || pull === undefined || pads.length === 0) return null
  const safe = safeArea(tl.width, tl.height, false)
  const stage = 0.5 * Math.min(safe.w, safe.h)
  const px = (x: number, y: number): [number, number] => [safe.x + safe.w / 2 + x * stage - tl.width / 2, safe.y + safe.h / 2 + y * stage - tl.height / 2]
  const xs = pads.map((a) => a.x)
  const ys = pads.map((a) => a.y)
  const grid = Math.max(...xs) - Math.min(...xs) + Math.max(...pads.map((a) => a.scale)) * 0.15
  const all = marks.flatMap((p) => p.atoms.map((a): [number, number] => [a.x, a.y]))
  const fx = all.map(([x]) => x)
  const fy = all.map(([, y]) => y)
  const top = Math.min(...fy)
  const bottom = Math.max(...fy)
  const prior = [...tl.formations].sort((a, b) => a.startPhase - b.startPhase).findIndex((f) => f.id === 'field')
  const before = [...tl.formations].sort((a, b) => a.startPhase - b.startPhase)[prior - 1]?.beat
  const plan = tl.placements.find((p) => p.role === 'hero' && p.stage === undefined && p.formation === before)
  const part = plan?.atoms[0]
  const outline = tl.cast.find((g) => g.id === plan?.glyphId)?.strokes[0] ?? []
  const corners = outline.length === 0 ? [] : [Math.min(...outline.map((q) => q.x)), Math.max(...outline.map((q) => q.x))].flatMap((x) => [Math.min(...outline.map((q) => q.y)), Math.max(...outline.map((q) => q.y))].map((y) => ({ x, y })))
  const turned = corners.map((q) => q.x * Math.cos(part?.rot ?? 0) - q.y * Math.sin(part?.rot ?? 0))
  const wide = turned.length === 0 ? 0 : Math.max(...turned) - Math.min(...turned)
  const close = Math.max(camScale(pull[0], loopFrames(tl), tl.pulls), (GLYPH_CHIP_SHARE * tl.width) / (grid * stage))
  const push = tl.pulls[at - 1]?.[1] ?? pull[0] - GLYPH_CUT_EARLY
  const named = tl.formations.find((f) => f.id === 'name')?.beat
  const fieldBeat = marks[0]?.formation
  const shown = tl.placements.filter((p) => p.formation === named || (p.formation === fieldBeat && p.role === 'hero' && p.outStep > (tl.placements.find((q) => q.formation === named)?.inStep ?? Infinity)))
  const strokes = new Map(tl.cast.map((g) => [g.id, g.strokes.flat()]))
  const ink = shown.flatMap((p) => p.atoms.flatMap((a) => (strokes.get(p.glyphId) ?? [{ x: 0, y: 0 }]).map((q) => ({ x: a.x + (q.x * Math.cos(a.rot) - q.y * Math.sin(a.rot)) * a.scale, y: a.y + (q.x * Math.sin(a.rot) + q.y * Math.cos(a.rot)) * a.scale }))))
  const nx = ink.map((q) => q.x)
  const ny = ink.map((q) => q.y)
  const leaves = marks.filter((p) => p.role !== 'hero').map((p) => p.outStep)
  const leave = leaves.length === 0 ? Infinity : Math.round((Math.min(...leaves) * tl.fps) / 15)
  const arrive = tl.events.find((e) => e.kind === 'letter')?.at ?? Infinity
  const fit = px((Math.min(...fx) + Math.max(...fx)) / 2, (top + bottom) / 2)
  return {
    push,
    far: part === undefined || wide === 0 ? camScale(push, loopFrames(tl), tl.pulls) : (close * grid) / (wide * part.scale),
    aim: part === undefined ? [0, 0] : px(part.x, part.y),
    cut: pull[0] - GLYPH_CUT_EARLY,
    start: pull[0],
    lock: pull[1],
    close,
    chip: px((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2),
    fit,
    leave,
    arrive,
    name: nx.length === 0 ? fit : px((Math.min(...nx) + Math.max(...nx)) / 2, (Math.min(...ny) + Math.max(...ny)) / 2)
  }
}

/**
 * The camera at a frame. It is `camScale` centred on the frame, except in the
 * last scene: there a cut hidden in the dark before it puts the main chip's
 * pad grid at the frame's centre, a third of its width; from the scene's
 * first beat one eased pull
 * takes it back to the scale of the scene's lock while it slides to centre the
 * whole field and the name. Until the lock only the scene's own marks are
 * drawn, so the last of the formation before, already decoding out, ends on
 * the cut instead of showing enlarged. It holds there to the film's last
 * frame. It is never wider than the glide.
 */
export function glyphView(frame: number, tl: GlyphTimeline): GlyphView {
  const scale = camScale(frame, loopFrames(tl), tl.pulls)
  const s = scenes.has(tl) ? (scenes.get(tl) as Scene | null) : sceneOf(tl)
  scenes.set(tl, s)
  if (s === null || frame < s.push) return { scale, dx: 0, dy: 0, scene: false }
  if (frame < s.cut) {
    const t = (frame - s.push) / (s.cut - 1 - s.push)
    const e = PUSH_CREEP * t + (1 - PUSH_CREEP) * t ** PUSH_EASE
    return { scale: scale * (s.far / scale) ** e, dx: s.aim[0] * e, dy: s.aim[1] * e, scene: false }
  }
  if (frame < s.lock) {
    const p = 1 - (1 - Math.max(0, frame - s.start) / (s.lock - s.start)) ** PULL_OUT
    const landed = camScale(s.lock, loopFrames(tl), tl.pulls)
    return {
      scale: Math.max(landed * (s.close / landed) ** (1 - p), glide(frame / loopFrames(tl))),
      dx: lerp(s.chip[0], s.fit[0], p),
      dy: lerp(s.chip[1], s.fit[1], p),
      scene: true
    }
  }
  const u = smooth((frame - s.leave) / Math.max(1, s.arrive - s.leave))
  return { scale, dx: lerp(s.fit[0], s.name[0], u), dy: lerp(s.fit[1], s.name[1], u), scene: false }
}

/** each placement's depth layer: parallax and drift grow with it */

export const glyphDepth = (pl: GlyphTimeline['placements'][number]): number => (pl.role === 'hero' && pl.glyphId.startsWith('cell:') ? 0 : GLYPH_Z[pl.role])

/** the camera at a frame with the film's slow drift and roll */
export function glyphPose(tl: GlyphTimeline, frame: number): { view: GlyphView; driftX: number; driftY: number; roll: number } {
  const sec = driftSeconds(frame, tl.fps)
  return {
    view: glyphView(frame, tl),
    driftX: Math.sin((sec / 11.2) * 2 * Math.PI) * 0.018 * tl.width,
    driftY: Math.cos((sec / 11.2) * 2 * Math.PI) * 0.012 * tl.height,
    roll: Math.sin((sec / 11.2) * 2 * Math.PI + 1) * 0.012
  }
}

/** where a stage point of depth layer z lands on the frame, in pixels, and the layer's scale */
export function glyphScreen(tl: GlyphTimeline, frame: number, z: number): { at: (x: number, y: number) => [number, number]; scale: number; stagePx: number } {
  const { view, driftX, driftY, roll } = glyphPose(tl, frame)
  const W = tl.width
  const H = tl.height
  const safe = safeArea(W, H, false)
  const stagePx = 0.5 * Math.min(safe.w, safe.h)
  const s = view.scale * (1 + 0.09 * z)
  return {
    scale: s,
    stagePx,
    at: (x, y) => {
      const ux = (safe.x + safe.w / 2 + x * stagePx - W / 2 - view.dx) * s
      const uy = (safe.y + safe.h / 2 + y * stagePx - H / 2 - view.dy) * s
      return [W / 2 + driftX * (1 + 0.9 * z) + Math.cos(roll) * ux - Math.sin(roll) * uy, H / 2 + driftY * (1 + 0.9 * z) + Math.sin(roll) * ux + Math.cos(roll) * uy]
    }
  }
}
