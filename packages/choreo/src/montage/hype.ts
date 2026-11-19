import { fitZoom, makeCam, project, sampleShot } from '../trace/camera'
import { liveLed, markingAxis } from '../trace/scene'
import type { CameraShot, TraceLight, TracePart, TraceScene } from '../types'
import type { MontageScore } from './types'

export type HypeLook = 'lit' | 'dither' | 'dots' | 'ascii' | 'blueprint' | 'xray'
export type HypeState = 'lit' | 'bare' | 'copper' | 'draw' | 'black'
export type HypeGrade = 'build' | 'stop' | 'release' | 'black'
export type HypeEventKind = 'hold' | 'burst' | 'stop' | 'hit' | 'cut' | 'move' | 'type' | 'poster'

export interface HypeWord {
  text: string
  f0: number
  f1: number
  x: number
  y: number
  size: number
  small?: boolean | undefined
  drift?: number | undefined
  /** a board point the word rides with: its place is the point's place on screen, plus x and y; z is the point's height */
  follow?: { x: number; y: number; z?: number | undefined } | undefined
  /** a print's size line that found no clear place outside the chip: it stands centred in the chip's empty body */
  inside?: boolean | undefined
  /** a print's chip name: the text is the chip's marking, the print draws its first line where the lit marking's first line stands on the lid, and the size line under it */
  name?: boolean | undefined
  turn?: boolean | undefined
  behind?: boolean | undefined
  minCap?: number | undefined
  /** the tallest its capitals may stand, as a share of the frame's height */
  maxCap?: number | undefined
  /** the most of any one letter the parts behind the main chip cover, as the seat measured it */
  cover?: number | undefined
  /** a small line that sits on the seated name's cap line, at its right end */
  crown?: boolean | undefined
  grow?: number | undefined
}

/** the stage the lit board stands on after the hit: how far its nets glow, where its one key hangs from the lens's heading, how much fill is left, how much more light the main chip takes than the rest, how many stops the light falls from it to the far corners, and the floor */
export interface HypeStage {
  energy: number
  key: { az: number; el: number; size: number; gain: number }
  fill: number
  hero: number
  fall: number
  ground: string
}

export interface HypeDims {
  f0: number
  f1: number
  at: number
  corners: Array<{ x: number; y: number }>
  labels: [string, string]
  /** where each label stands: along its edge as a share of the edge, and out from its default place in its own heights; null where no clear place is found, and then it is not drawn */
  shift: [PrintShift | null, PrintShift | null]
}

export interface PrintShift { along: number; out: number }

export interface HypeFrame {
  state: HypeState
  clone: number
  spot?: { x: number; y: number; r: number } | undefined
  look: HypeLook
  blur: number
  /** the share of the shutter left open, where the pull into the poster would otherwise smear the frame */
  shut?: number | undefined
  /** an X-ray of the whole board: how many copper layers it shows, counted from the front (`copperStack`) */
  layers?: number | undefined
  /** the main chip's marking is left out: a print draws the chip bare, as the edges of its letters would be mush */
  bare?: true | undefined
  grade: HypeGrade
}

/** the copper layers of a board from the front: the front, the inner layers in name order, the back */
export function copperStack(scene: TraceScene): Array<{ side: 'F' | 'B' | 'inner'; id?: string | undefined }> {
  const inners = [...new Set(scene.layers.filter((l) => l.side === 'inner').map((l) => l.id).concat(scene.zones.filter((z) => z.side === 'inner').map((z) => z.layer ?? 'In1.Cu')))].sort()
  return [{ side: 'F' }, ...inners.map((id) => ({ side: 'inner' as const, id })), { side: 'B' }]
}

export interface HypeCut {
  frames: number
  total: number
  shots: CameraShot[]
  plan: HypeFrame[]
  words: HypeWord[]
  dims: HypeDims[]
  stage: HypeStage
  cuts: number[]
  events: Array<{ f: number; kind: HypeEventKind }>
  still: [number, number]
  turns: boolean[]
  late: { from: number; turns: boolean[] }
  blink?: { at: number; from: number } | undefined
  /** the one change of the held end: the key's highlight crosses the main chip's lid, centred at x, y, z, the lid `along` its marking's axis (rot) and `across` it */
  glint: { f0: number; f1: number; x: number; y: number; z: number; rot: number; along: number; across: number; peak: number }
  /** the hit's frames: the pool of dark around the main chip as the light comes on */
  hit: [number, number]
}

interface Pose {
  x: number
  y: number
  zoom: number
  tilt: number
  yaw: number
  aperture: number
  fov?: number
  roll?: number
  shift?: number
  focus?: { x: number; y: number }
}

type Shape = 'catch' | 'out' | 'drift' | 'in' | 'spring'

interface Move {
  f0: number
  f1: number
  a: Pose
  b: Pose
  shape: Shape
  state?: HypeState
  light?: TraceLight
  draw?: [number, number]
  looks?: Array<[number, number, HypeLook]>
  hold?: number
  spot?: [number, { x: number; y: number; r: number }]
  grade?: HypeGrade
  via?: Pose
  via2?: Pose
  join?: true
  slope0?: number
  slope?: number
}

export const STOP = 135
export const RELEASE = 165
export const POSTER = 300
export const SETTLE = 8
const SWEEP = 96
/** the longest streak a ride or a detail may leave, as a share of the frame's width; the whip and the pull keep PULL_SMEAR */
const RIDE_SMEAR = 0.02
/** the trace renderer eases a change of light over this share of its film: the stop's dark and the hit's light stand this far apart in the clone, so the light comes on in one frame */
const LIGHT_EASE = 0.05
/** the end frame: a lens of FOV radians low over the main chip, the chip this wide against the frame's short side and this far down it, the board's far edge no higher than SKY, and the parts in front of the chip over no more than FRONT of the frame */
const END = { fov: 0.62, wide: 0.52, down: 0.73, sky: 0.17, tilt: [1, 1.32], turns: [0, 0.14, -0.14, 0.32, -0.32, 0.5, -0.5, 0.75, -0.75], front: 0.1 } as const
/** the name behind the skyline: its width as a share of the frame's, the tallest its capitals may stand as a share of the frame's height, the most of it and of any one letter the parts may cover, the share of the skyline that may stand above its foot, how far of a capital's height the foot tucks under the rest, and the room kept above it for the revision as a share of the frame's height */
const NAME = { wide: 0.92, cap: 0.19, landscape: 0.14, hidden: 0.25, letter: 0.3, over: 0.25, tuck: 0.1, head: 0.065 } as const
/** the narrower widths the name takes, widest first, where the skyline would cover its letters at full width */
const NAME_FITS = [0.92, 0.84, 0.76, 0.68, 0.62] as const
/** a seat behind the parts is taken only where the name keeps this share of the width it has in front; else it stands in front */
export const BEHIND_KEEP = 0.9
/** the revision over the name: its width, its least and most cap (of the frame, of the name), how far it rises in its own caps, and the frame's height left clear above it */
export const CROWN = { wide: 0.2, least: 0.022, most: 0.5, rise: 1.45, gap: 0.045 } as const
/** the name's face: its capitals' height and each letter's advance, in ems (a capital, a lower-case letter, a narrow letter, a space) */
const FACE = { cap: 0.74, upper: 1, lower: 0.72, narrow: 0.4, space: 0.3 } as const
/** the turn of the end is scored with every letter as wide as `FACE.cap / TURN_EM` ems, the estimate the approved end shots were chosen with */
const TURN_EM = 0.72
const emOf = (c: string): number => (c === ' ' ? FACE.space : /[iljtfrI1.,:;'!|]/.test(c) ? FACE.narrow : c !== c.toUpperCase() ? FACE.lower : FACE.upper)
const PUSH = 1.02
/** the one look at the whole board: the cut to the pull back, the frame it stands whole and still, and the frame the camera drops to the chip */
export const WHOLE = [255, 267, 285] as const
/** the whole board seen through, inside its still hold: the frame it cuts to the X-ray, the frame it cuts back to the lit board as the camera drops, and the frames by which every copper layer has arrived, front first */
export const SEEN = [270, 285] as const
const SEEN_STACKED = 10
const SEEN_STEP = 5
/** the fewest frames the build's X-ray shot holds, so the chip's pads read on a phone */
const SEEN_LEAST = 8
/** a lit shot in the build lights the whole frame between dark ones: closer than this to the stop only the last one stays lit, so the build never pulses twice in one second */
const STROBE = 30
/** the held end's one change: the highlight starts this many whole seconds after the hit, so it lands on the track's beat, and crosses the lid in GLINT_RUN frames */
const GLINT_AT = 6
const GLINT_RUN = 9
/** the light the glint adds at its height: a viewer names it at 390 px wide (0.26 did not read), and it stays under the level where the marking whitens and it reads as a flash (0.6 did) */
export const GLINT_PEAK = 0.45
const WHIP_SMEAR = 0.02
export const WHIP = 195
const WHIP_BACK = 0.4
const SIDE = 225
/** silk whose words are an empty value the board file left in place of a real one (a maker's name of NULL): no release place shows it */
export const EMPTY_VALUE = /(^|\s)(NULL|N\/A|TBD)(\s|$)|^\s*\?\s*$/i
const HELD = 3
/** the longest streak the pull into the poster may leave, as a share of the frame's width */
const PULL_SMEAR = 0.06
/** the board has resolved once a frame's streak is this short, as a share of the frame's width: the name lands then */
const RESOLVED = 0.02
/** a model's lid is its flat top: the vertices within LID_FLAT mm of its highest, when they span at least LID_LEAST of the model each way (a body with leads has a lid smaller than its footprint; a lone bump on top is not a lid) */
const LID_FLAT = 0.02
const LID_LEAST = 0.5

/** a print's label: its size as a share of the frame's width, how far its letters reach above and below the line it is set on as a share of the size, and the margin it keeps inside the frame; where it cannot stand whole with the margin, it is not drawn */
export const LABEL = { size: 0.05, over: 0.56, under: 0.46, margin: 0.04 } as const

const LIGHT: Record<HypeState, TraceLight> = { copper: 'route', bare: 'place', lit: 'poster', draw: 'route', black: 'poster' }
const STAGE: HypeStage = { energy: 0, key: { az: 2.75, el: 0.85, size: 0.07, gain: 2.6 }, fill: 0.74, hero: 3.5, fall: 1.2, ground: '#1f1c19' }
/** the main chip's gain on a black board, where the exposure already lifts it; `STAGE.hero` is its gain on a white one */
const DARK_HERO = 1.2
const FOV = (30 * Math.PI) / 180

const shapeOf = (shape: Shape, u: number): number => {
  if (shape === 'drift') return u
  if (shape === 'out') return 1 - (1 - u) ** 3
  if (shape === 'in') return u * u
  if (shape === 'spring') return 1 - (1 - u) ** 2 * (1 - 2 * u)
  const c = 0.5 + 0.5 * Math.sign(2 * u - 1) * Math.abs(2 * u - 1) ** 2.2
  return 0.85 * c + 0.15 * u
}

const mix = (a: Pose, b: Pose, k: number): Pose => {
  const l = (p: number, q: number): number => p + (q - p) * k
  const fa = a.focus ?? { x: a.x, y: a.y }
  const fb = b.focus ?? { x: b.x, y: b.y }
  return {
    x: l(a.x, b.x), y: l(a.y, b.y), zoom: Math.exp(l(Math.log(a.zoom), Math.log(b.zoom))), tilt: l(a.tilt, b.tilt), yaw: l(a.yaw, b.yaw), aperture: l(a.aperture, b.aperture),
    fov: l(a.fov ?? FOV, b.fov ?? FOV), roll: l(a.roll ?? 0, b.roll ?? 0), shift: l(a.shift ?? 0, b.shift ?? 0), focus: { x: l(fa.x, fb.x), y: l(fa.y, fb.y) }
  }
}

const curve = (mv: { a: Pose; b: Pose; via?: Pose | undefined; via2?: Pose | undefined }, k: number): Pose => {
  if (mv.via === undefined) return mix(mv.a, mv.b, k)
  if (mv.via2 === undefined) return mix(mix(mv.a, mv.via, k), mix(mv.via, mv.b, k), k)
  const p = mix(mv.a, mv.via, k)
  const q = mix(mv.via, mv.via2, k)
  const r = mix(mv.via2, mv.b, k)
  return mix(mix(p, q, k), mix(q, r, k), k)
}

const ahead = (a: Pose, b: Pose, c: number): Pose => {
  const p = mix(a, b, 1 + c)
  return { ...p, zoom: b.zoom * (b.zoom / a.zoom) ** c }
}

const wind = (p: Pose, to: number): Pose => ({ ...p, yaw: p.yaw + 2 * Math.PI * Math.round((to - p.yaw) / (2 * Math.PI)) })

const truck = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.atan2(-(b.y - a.y), b.x - a.x)

/** the body the film draws for a part, as triangles in plane px (x, y, z): its model where it wears one, placed as the mesh shader places it at rest, else its box */
export function drawnBody(scene: TraceScene, pt: TraceScene['parts'][number]): Array<[number, number, number]> {
  const model = pt.mesh === undefined ? undefined : scene.meshes[pt.mesh.id]
  if (pt.mesh === undefined || model === undefined) {
    const c = Math.cos(pt.rot)
    const s = Math.sin(pt.rot)
    const at = (u: number, v: number, z: number): [number, number, number] => [pt.x + (c * u * pt.w - s * v * pt.h) / 2, pt.y + (s * u * pt.w + c * v * pt.h) / 2, z]
    const k = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
    const lo = k.map(([u, v]) => at(u, v, 0))
    const hi = k.map(([u, v]) => at(u, v, pt.z))
    type P = [number, number, number]
    const of = (list: P[], i: number): P => list[i % 4] as P
    const quad = (p: P, q: P, r: P, t: P): P[] => [p, q, r, p, r, t]
    return [...quad(of(hi, 0), of(hi, 1), of(hi, 2), of(hi, 3)), ...k.flatMap((_, i) => quad(of(lo, i), of(lo, i + 1), of(hi, i + 1), of(hi, i)))]
  }
  const [a, b, c, d] = pt.mesh.m
  const scale = Math.hypot(a, b)
  const pos = new Float32Array(Uint8Array.from(atob(model.pos), (ch) => ch.charCodeAt(0)).buffer)
  const idx = new Uint32Array(Uint8Array.from(atob(model.idx), (ch) => ch.charCodeAt(0)).buffer)
  const cx = (model.min[0] + model.max[0]) / 2
  const cy = (model.min[1] + model.max[1]) / 2
  return Array.from(idx, (i) => {
    const u = (pos[3 * i] as number) - cx
    const v = (pos[3 * i + 1] as number) - cy
    return [pt.x + a * u + c * v, pt.y + b * u + d * v, (pos[3 * i + 2] as number) * scale] as [number, number, number]
  })
}

/** a print's dimension or size line keeps margin of its own height clear of every other mark (the placement asks slack more, so the camera's drift within a shot keeps the margin), steps step of its height when it moves, and is set this wide per letter */
export const CLEAR_TEXT = { margin: 0.5, slack: 0.1, step: 0.5, letter: 0.5 } as const
/** a print clears the paper this far round the main chip's outline, as a share of the frame's width: nothing of the board is drawn there */
export const PRINT_BAND = 0.045
/** a dimension's label: its height as a share of the frame's short side, and how far out from its edge it stands, as a share of the frame's width */
export const DIM_LABEL = { size: 0.04, gap: 0.05 } as const

/** a print's chip name, as a share of the frame's width: larger than the size line under it (LABEL.size), shrunk to fit the body */
export const NAME_SIZE = 0.08

export type Seg = [number, number, number, number]
export interface TextBox { x: number; y: number; ux: number; uy: number; along: number; across: number }

/** whether a segment touches a text box (centre, unit axis along the text, half extents), all in pixels */
export const touches = (s: Seg, b: TextBox): boolean => {
  const local = (x: number, y: number): [number, number] => [(x - b.x) * b.ux + (y - b.y) * b.uy, -(x - b.x) * b.uy + (y - b.y) * b.ux]
  const [x0, y0] = local(s[0], s[1])
  const [x1, y1] = local(s[2], s[3])
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [[-(x1 - x0), x0 + b.along], [x1 - x0, b.along - x0], [-(y1 - y0), y0 + b.across], [y1 - y0, b.across - y0]] as const) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const r = q / p
    if (p < 0) t0 = Math.max(t0, r)
    else t1 = Math.min(t1, r)
    if (t0 > t1) return false
  }
  return true
}

const boxSegs = (b: TextBox): Seg[] => {
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [b.x + (u as number) * b.along * b.ux - (v as number) * b.across * b.uy, b.y + (u as number) * b.along * b.uy + (v as number) * b.across * b.ux] as const)
  return c.map((p, i) => { const q = c[(i + 1) % 4] as readonly [number, number]; return [p[0], p[1], q[0], q[1]] })
}

/** whether a pixel lies within PRINT_BAND of the frame's width outside the box (its corners in pixels, in order), or inside it */
export const printBand = (box: Array<{ x: number; y: number }>, W: number): ((x: number, y: number) => boolean) => {
  const mid = { x: box.reduce((a, p) => a + p.x, 0) / box.length, y: box.reduce((a, p) => a + p.y, 0) / box.length }
  return (x, y) => box.every((p, k) => {
    const q = box[(k + 1) % box.length] as { x: number; y: number }
    const l = Math.max(1e-9, Math.hypot(q.x - p.x, q.y - p.y))
    const out = ((x - p.x) * (q.y - p.y) - (y - p.y) * (q.x - p.x)) / l
    const toward = ((mid.x - p.x) * (q.y - p.y) - (mid.y - p.y) * (q.x - p.x)) / l
    return Math.sign(toward) * out >= -PRINT_BAND * W
  })
}

/** a silk text's box on the board, larger than its letters by half a letter all round, corners in order */
export const silkBox = (t: TraceScene['texts'][number]): Array<[number, number]> => {
  const w = t.size * (t.text.length + 1)
  const h = 1.8 * t.size
  const shift = t.align === 'left' ? w / 2 : t.align === 'right' ? -w / 2 : 0
  const c = Math.cos(t.rot)
  const s = Math.sin(t.rot)
  const x = t.x + shift * c
  const y = t.y + shift * s
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [x + ((u as number) * w * c - (v as number) * h * s) / 2, y + ((u as number) * w * s + (v as number) * h * c) / 2])
}

/** a silk text whose box lies whole inside the frame: a print keeps it, and labels dodge it */
export const silkWhole = (t: TraceScene['texts'][number], cam: ReturnType<typeof makeCam>): boolean =>
  silkBox(t).every(([x, y]) => ((q) => q.x >= -1 && q.x <= 1 && q.y >= -1 && q.y <= 1)(project(cam, x, y)))

const convex = (pts: Array<[number, number]>): Array<[number, number]> => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: Array<[number, number]>): Array<[number, number]> => list.reduce<Array<[number, number]>>((h, q) => {
    while (h.length >= 2 && cross(h[h.length - 2] as [number, number], h[h.length - 1] as [number, number], q) <= 0) h.pop()
    return [...h, q]
  }, [])
  const lo = half(p)
  const hi = half([...p].reverse())
  return [...lo.slice(0, -1), ...hi.slice(0, -1)]
}

const inside = (px: number, py: number, poly: Array<{ x: number; y: number }>): boolean => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as { x: number; y: number }
    const b = poly[j] as { x: number; y: number }
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}

/** the share of the frame the board fills through cam, read on a 7×7 grid: with clipped, an outline that runs behind the camera is cut at the camera's plane, so a low close view whose far edge lies behind the lens still counts as board; without it, any such outline counts as none */
export const boardCover = (rim: number[], cam: ReturnType<typeof makeCam>, clipped: boolean): number => {
  const clip = Array.from({ length: rim.length / 2 }, (_, i) => project(cam, rim[2 * i] as number, rim[2 * i + 1] as number)).map((v) => ({ x: v.x * v.w, y: v.y * v.w, w: v.w }))
  const NEAR = 1e-3
  const poly = clip.flatMap((a, i) => {
    const b = clip[(i + 1) % clip.length] as typeof a
    const out = a.w > NEAR ? [{ x: a.x / a.w, y: a.y / a.w }] : []
    if ((a.w > NEAR) !== (b.w > NEAR)) {
      const t = (NEAR - a.w) / (b.w - a.w)
      out.push({ x: (a.x + t * (b.x - a.x)) / NEAR, y: (a.y + t * (b.y - a.y)) / NEAR })
    }
    return out
  })
  if (poly.length < 3 || (!clipped && clip.some((v) => v.w <= 0))) return 0
  let n = 0
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (inside(-0.92 + (i * 1.84) / 6, -0.92 + (j * 1.84) / 6, poly)) n++
  return n / 49
}

/** how many places further on a release slot may take when the readable views break the motion across a cut, and the agreement of screen motion across a cut below which it may */
const SPARES = 3
const SMOOTH = 0.5

/** when no reading view keeps the motion at SMOOTH, the one that keeps it highest is taken if it keeps it at least this well; below, the shot stays as cut before the turns */
export const SMOOTH_LEAST = 0.45

/** the turns of a view's heading about its target that a view with a word upside down may take: half a turn first, then eighths of a half turn, the least first */
export const TURNS = [Math.PI, ...[1, 2, 3, 4, 5, 6, 7].flatMap((i) => [(i * Math.PI) / 8, (-i * Math.PI) / 8])]

/** the headings a view may take, given how each turn reads (ok: no counted word upside down; level: the screen area of words within LEVEL_LEAN of level): a view that reads keeps its own; otherwise the turns that read, the most level word area first */
export function turnsFor(judge: (turn: number) => { ok: boolean; level: number }): number[] {
  if (judge(0).ok) return [0]
  return TURNS.map((turn, i) => ({ turn, i, ...judge(turn) })).filter((t) => t.ok).sort((p, q) => q.level - p.level || p.i - q.i).map((t) => t.turn)
}

/** the most of a release place's frame that one body the board file gives no model and no marking (an estimated block) may fill in front: the largest share one such block fills on the demo films whose blocks read as the board */
export const PLAIN_MOST = 0.262

/** the nearest body's view depth and index in each cell of cell px, through cam: bodies rasterised by their triangles */
export function bodyRaster(bodies: Array<Array<[number, number, number]>>, cam: ReturnType<typeof makeCam>, W: number, H: number, cell = 6): { depth: Float32Array; which: Int32Array; w: number; h: number } {
  const w = Math.ceil(W / cell)
  const h = Math.ceil(H / cell)
  const depth = new Float32Array(w * h).fill(Infinity)
  const which = new Int32Array(w * h).fill(-1)
  for (const [k, body] of bodies.entries()) {
    for (let t = 0; t + 2 < body.length; t += 3) {
      const v = [body[t], body[t + 1], body[t + 2]].map((q) => project(cam, (q as [number, number, number])[0], (q as [number, number, number])[1], (q as [number, number, number])[2]))
      if (v.some((q) => q.w <= 0)) continue
      const [a, b, c] = v.map((q) => ({ x: ((q.x + 1) / 2) * w, y: ((1 - q.y) / 2) * h, z: q.w })) as [{ x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }]
      const d = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
      if (Math.abs(d) < 1e-9) continue
      for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))); y <= Math.min(h - 1, Math.ceil(Math.max(a.y, b.y, c.y))); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))); x <= Math.min(w - 1, Math.ceil(Math.max(a.x, b.x, c.x))); x++) {
          const l1 = ((b.x - x - 0.5) * (c.y - y - 0.5) - (c.x - x - 0.5) * (b.y - y - 0.5)) / d
          const l2 = ((c.x - x - 0.5) * (a.y - y - 0.5) - (a.x - x - 0.5) * (c.y - y - 0.5)) / d
          if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue
          const z = l1 * a.z + l2 * b.z + (1 - l1 - l2) * c.z
          const i = y * w + x
          if (z < (depth[i] as number)) {
            depth[i] = z
            which[i] = k
          }
        }
      }
    }
  }
  return { depth, which, w, h }
}

/** the share of the frame the largest plain body (no model, no marking) fills in front of every other body, through cam, on a raster of cell px */
export function plainMost(bodies: Array<{ body: Array<[number, number, number]>; plain: boolean }>, cam: ReturnType<typeof makeCam>, W: number, H: number, cell = 6): number {
  const { which } = bodyRaster(bodies.map((b) => b.body), cam, W, H, cell)
  const counts = which.reduce((n, v) => (v >= 0 && bodies[v]?.plain === true ? n.set(v, (n.get(v) ?? 0) + 1) : n), new Map<number, number>())
  return Math.max(0, ...counts.values()) / which.length
}

/** a word reads upside down past this lean of its baseline from level, left to right, on screen; from 60° to here it reads sideways */
export const FLIPPED = (120 * Math.PI) / 180

/** the most the main chip's marking may lean from level where its lid is in frame */
export const MARK_LEAN = (80 * Math.PI) / 180

/** a word counts when its letters stand at least this tall, in px at 1080 */
export const WORD_LEAST = 14

/** a word within this lean of level reads level, for choosing among turns */
export const LEVEL_LEAN = (30 * Math.PI) / 180

/** the silk face (JetBrains Mono) inside its em box: ink stops this share of the em short of each side of a 0.6 em advance, and capitals stand this share of the em tall, centred on the em's middle */
export const INK = { side: 0.05, cap: 0.73 } as const

/** a silk text or a part's printed marking, in board space: the outline of its letters at height z (not the em box round them), its baseline direction and its letter height */
export type BoardWord = { text: string; part?: number; x: number; y: number; z: number; dx: number; dy: number; tall: number; corners: Array<[number, number]> }

/** every word the board carries: its silk texts, and each labelled part's marking laid on its lid as the mesh shader lays it (the atlas cell's height over 0.78 of the long side, at most the short side) */
export function boardWords(scene: TraceScene): BoardWord[] {
  const box = (x: number, y: number, z: number, dx: number, dy: number, u0: number, u1: number, v0: number, v1: number): Array<[number, number]> => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]): [number, number] => [x + dx * (u as number) - dy * (v as number), y + dy * (u as number) + dx * (v as number)])
  const silk = scene.texts.map((t): BoardWord => {
    const lines = t.text.split('\n')
    const wide = 0.6 * t.size * Math.max(...lines.map((l) => l.length))
    const tall = t.size * (1 + (lines.length - 1) * 1.2)
    const x0 = t.align === 'left' ? 0 : t.align === 'right' ? -wide : -wide / 2
    const y0 = t.valign === 'top' ? -t.size / 2 : t.valign === 'bottom' ? -tall + t.size / 2 : -tall / 2
    const dx = Math.cos(t.rot)
    const dy = Math.sin(t.rot)
    const rim = ((1 - INK.cap) / 2) * t.size
    return { text: t.text, x: t.x, y: t.y, z: 0, dx, dy, tall: t.size, corners: box(t.x, t.y, 0, dx, dy, x0 + INK.side * t.size, x0 + wide - INK.side * t.size, y0 + rim, y0 + tall - rim) }
  })
  const marks = scene.parts.flatMap((p, i): BoardWord[] => {
    if (p.label === undefined) return []
    const m = /^(.+[A-Z0-9])-([A-Z]{1,4}[0-9]{1,4}[A-Z]?)$/i.exec(p.label)
    const lines = m === null ? [p.label] : [m[1] as string, m[2] as string]
    const fit = (text: string): number => Math.min(34, 384 / Math.max(1, text.length))
    const size = lines.length === 1 ? fit(p.label) : Math.min(1.5 * fit(p.label), ...lines.map(fit), 51.2)
    const long = Math.max(p.w, p.h)
    const short = Math.min(p.w, p.h)
    const hFrac = Math.min(1, (0.78 * long) / 2 / short)
    const unit = (hFrac * short) / 128
    const half = ((0.6 * Math.max(...lines.map((l) => l.length)) - 2 * INK.side) * size * unit) / 2
    const halfTall = (((lines.length - 1) * 1.15 + INK.cap) * size * unit) / 2
    const d = markingAxis(p)
    return [{ text: lines.join(' '), part: i, x: p.x, y: p.y, z: p.z, dx: d.x, dy: d.y, tall: 0.7 * size * unit, corners: box(p.x, p.y, p.z, d.x, d.y, -half, half, -halfTall, halfTall) }]
  })
  return [...silk, ...marks]
}

/** the words that count through cam: every letter inside the frame, nothing in front of them on the depth raster, letters at least WORD_LEAST px tall at 1080; each with its baseline's lean from level (turned markings read the other way), letter height and screen area */
export function countedWords(words: BoardWord[], turned: (part: number) => boolean, raster: ReturnType<typeof bodyRaster>, cam: ReturnType<typeof makeCam>, W: number, H: number): Array<{ word: BoardWord; lean: number; tall: number; area: number }> {
  const px = (x: number, y: number, z: number): { x: number; y: number; w: number } => {
    const v = project(cam, x, y, z)
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H, w: v.w }
  }
  const scale = 1080 / Math.min(W, H)
  return words.flatMap((word) => {
    const c = word.corners.map(([x, y]) => px(x, y, word.z))
    if (c.some((q) => q.w <= 0 || q.x < 0 || q.x > W || q.y < 0 || q.y > H)) return []
    const k = word.part !== undefined && turned(word.part) ? -1 : 1
    const p = px(word.x, word.y, word.z)
    const q = px(word.x + k * word.dx, word.y + k * word.dy, word.z)
    const up = px(word.x - word.dy * word.tall, word.y + word.dx * word.tall, word.z)
    const tall = Math.hypot(up.x - p.x, up.y - p.y) * scale
    if (tall < WORD_LEAST) return []
    const mid = { x: c.reduce((n, v) => n + v.x, 0) / 4, y: c.reduce((n, v) => n + v.y, 0) / 4, w: c.reduce((n, v) => n + v.w, 0) / 4 }
    const seen = [mid, ...c.map((v) => ({ x: mid.x + 0.7 * (v.x - mid.x), y: mid.y + 0.7 * (v.y - mid.y), w: mid.w + 0.7 * (v.w - mid.w) }))].every((v) => {
      const i = Math.min(raster.h - 1, Math.floor((v.y / H) * raster.h)) * raster.w + Math.min(raster.w - 1, Math.floor((v.x / W) * raster.w))
      return (raster.depth[i] as number) >= v.w * 0.99
    })
    if (!seen) return []
    const area = Math.abs(c.reduce((n, v, i) => n + v.x * (c[(i + 1) % 4] as { y: number }).y - (c[(i + 1) % 4] as { x: number }).x * v.y, 0)) / 2
    return [{ word, lean: Math.atan2(-(q.y - p.y), q.x - p.x), tall, area }]
  })
}

/** the share of the main chip's drawn body (lid, pins, marking) that another part's drawn body stands in front of through cam, on a raster of cell px: each body is rasterised by its triangles with depth, so a pin's real outline counts and its box does not */
export function heroCovered(hero: Array<[number, number, number]>, others: Array<Array<[number, number, number]>>, cam: ReturnType<typeof makeCam>, W: number, H: number, cell = 8): number {
  const w = Math.ceil(W / cell)
  const h = Math.ceil(H / cell)
  const depth = new Float32Array(w * h).fill(Infinity)
  const tris = (body: Array<[number, number, number]>, each: (i: number, z: number) => void): void => {
    for (let t = 0; t + 2 < body.length; t += 3) {
      const v = [body[t], body[t + 1], body[t + 2]].map((q) => project(cam, (q as [number, number, number])[0], (q as [number, number, number])[1], (q as [number, number, number])[2]))
      if (v.some((q) => q.w <= 0)) continue
      const [a, b, c] = v.map((q) => ({ x: ((q.x + 1) / 2) * w, y: ((1 - q.y) / 2) * h, z: q.w })) as [{ x: number; y: number; z: number }, { x: number; y: number; z: number }, { x: number; y: number; z: number }]
      const d = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
      if (Math.abs(d) < 1e-9) continue
      for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))); y <= Math.min(h - 1, Math.ceil(Math.max(a.y, b.y, c.y))); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))); x <= Math.min(w - 1, Math.ceil(Math.max(a.x, b.x, c.x))); x++) {
          const l1 = ((b.x - x - 0.5) * (c.y - y - 0.5) - (c.x - x - 0.5) * (b.y - y - 0.5)) / d
          const l2 = ((c.x - x - 0.5) * (a.y - y - 0.5) - (a.x - x - 0.5) * (c.y - y - 0.5)) / d
          if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue
          each(y * w + x, l1 * a.z + l2 * b.z + (1 - l1 - l2) * c.z)
        }
      }
    }
  }
  tris(hero, (i, z) => { if (z < (depth[i] as number)) depth[i] = z })
  const covered = new Uint8Array(w * h)
  for (const body of others) tris(body, (i, z) => { if (z < (depth[i] as number) - 1e-4) covered[i] = 1 })
  let area = 0
  let hit = 0
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] === Infinity) continue
    area++
    hit += covered[i] as number
  }
  return area === 0 ? 0 : hit / area
}

/** the main chip's drawn body in a print: the hull of its lid and of its model above its leads (which sit below BODY_LOW of its height), in pixels through cam */
export const BODY_LOW = 0.15

export const bodyOutline = (lid: Pick<HypeCut['glint'], 'x' | 'y' | 'z' | 'rot' | 'along' | 'across'>, body: Array<[number, number, number]>, cam: ReturnType<typeof makeCam>, W: number, H: number): Array<{ x: number; y: number }> => {
  const at = (x: number, y: number, z: number): [number, number] => ((q) => [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H] as [number, number])(project(cam, x, y, z))
  const c = Math.cos(lid.rot)
  const s = Math.sin(lid.rot)
  const top = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => at(lid.x + ((a as number) * lid.along * c - (b as number) * lid.across * s) / 2, lid.y + ((a as number) * lid.along * s + (b as number) * lid.across * c) / 2, lid.z))
  const high = Math.max(...body.map((v) => v[2]))
  return convex([...top, ...body.filter((v) => v[2] >= BODY_LOW * high).map((v) => at(v[0], v[1], v[2]))]).map(([x, y]) => ({ x, y }))
}

/** the box whose edges run along the given box's edges and just hold the outline: each edge moved out to the outline's farthest point, the corners where neighbouring edges meet */
export const measuredBox = (outline: Array<{ x: number; y: number }>, box: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
  const mid = { x: box.reduce((a, p) => a + p.x, 0) / box.length, y: box.reduce((a, p) => a + p.y, 0) / box.length }
  const lines = box.map((p, k) => {
    const q = box[(k + 1) % box.length] as { x: number; y: number }
    const l = Math.max(1e-9, Math.hypot(q.x - p.x, q.y - p.y))
    const t = { x: (q.x - p.x) / l, y: (q.y - p.y) / l }
    const n0 = { x: t.y, y: -t.x }
    const n = (p.x - mid.x) * n0.x + (p.y - mid.y) * n0.y >= 0 ? n0 : { x: -n0.x, y: -n0.y }
    return { t, n, d: Math.max(...outline.map((o) => o.x * n.x + o.y * n.y)) }
  })
  return lines.map((b, k) => {
    const a = lines[(k + lines.length - 1) % lines.length] as typeof b
    const det = a.n.x * b.n.y - a.n.y * b.n.x
    return { x: (a.d * b.n.y - b.d * a.n.y) / det, y: (b.d * a.n.x - a.d * b.n.x) / det }
  })
}

/** a part claims the pads whose centres lie within its body grown by REACH of its longer side and the pad's own size */
export const PART_REACH = 0.25

/** what the board owns and a print keeps whole wherever the band lies, when it is whole in the frame: each silk word, each other part with the pads it stands on, each other pad, and each silk stroke (a part's drawn outline, a logo). shape is the outline in pixels to keep (a stroke's own line), core a word's letters alone, segs the marks labels dodge: its edges and, for a box, its diagonals, so a label that would sit wholly inside it still meets one */
export type KeptKind = 'word' | 'part' | 'pad' | 'stroke'

export function printKept(scene: TraceScene, cam: ReturnType<typeof makeCam>, W: number, H: number): Array<{ shape: Array<[number, number]>; segs: Seg[]; kind: KeptKind; core?: Array<[number, number]> }> {
  const at = (x: number, y: number, z = 0): [number, number] => {
    const q = project(cam, x, y, z)
    return [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H]
  }
  const whole = (shape: Array<[number, number]>): boolean => shape.every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H)
  const ring = (c: Array<[number, number]>): Seg[] => [...c.map((p, i): Seg => { const q = c[(i + 1) % c.length] as [number, number]; return [p[0], p[1], q[0], q[1]] }), ...(c.length === 4 ? [[...c[0] as [number, number], ...c[2] as [number, number]] as Seg, [...c[1] as [number, number], ...c[3] as [number, number]] as Seg] : [])]
  const corners = (x: number, y: number, w: number, h: number, rot: number, z = 0): Array<[number, number]> => {
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => at(x + ((u as number) * w * c - (v as number) * h * s) / 2, y + ((u as number) * w * s + (v as number) * h * c) / 2, z))
  }
  const others = scene.pads.filter((d) => d.hero !== true)
  const words = scene.texts.filter((t) => silkWhole(t, cam)).map((t) => {
    const c = silkBox(t).map(([x, y]) => at(x, y))
    const [mx, my] = c.reduce(([a, b], [x, y]) => [a + x / 4, b + y / 4], [0, 0])
    const along = t.text.length / (t.text.length + 1)
    const across = 1 / 1.8
    const core = c.map(([x, y], k): [number, number] => {
      const q = c[k % 2 === 0 ? k + 1 : k - 1] as [number, number]
      const ax = (x - q[0]) / 2
      const ay = (y - q[1]) / 2
      return [mx + (x - mx - ax) * across + ax * along, my + (y - my - ay) * across + ay * along]
    })
    return { shape: c, segs: ring(c), kind: 'word' as const, core }
  })
  const parts = scene.parts.filter((p) => p.z > 0 && p.hero !== true).map((p) => {
    const c = Math.cos(p.rot)
    const s = Math.sin(p.rot)
    const grow = PART_REACH * Math.max(p.w, p.h)
    const local = others.map((d) => ({ d, u: (d.x - p.x) * c + (d.y - p.y) * s, v: -(d.x - p.x) * s + (d.y - p.y) * c })).filter(({ d, u, v }) => Math.abs(u) <= p.w / 2 + grow + Math.max(d.w, d.h) / 2 && Math.abs(v) <= p.h / 2 + grow + Math.max(d.w, d.h) / 2)
    const pads = local.flatMap(({ d }) => corners(d.x, d.y, d.w, d.h, d.rot))
    const top = corners(p.x, p.y, p.w, p.h, p.rot, p.z)
    const foot = corners(p.x, p.y, p.w, p.h, p.rot)
    return { shape: convex([...top, ...foot, ...pads]), segs: [...ring(top), ...ring(foot)], kind: 'part' as const }
  })
  const pads = others.map((d) => ((c) => ({ shape: c, segs: ring(c), kind: 'pad' as const }))(corners(d.x, d.y, d.w, d.h, d.rot)))
  const strokes = scene.silkStrokes.map(({ path }) => {
    const pts = Array.from({ length: path.length / 2 }, (_, i) => at(path[2 * i] as number, path[2 * i + 1] as number))
    return { shape: pts, segs: pts.slice(1).map((q, i): Seg => [...(pts[i] as [number, number]), ...q]), kind: 'stroke' as const }
  })
  return [...words, ...parts, ...pads, ...strokes].filter((k) => whole(k.shape))
}

/** a silk text the band touches: the print clears it whole when the frame's edge cuts it */
export const silkInBand = (t: TraceScene['texts'][number], cam: ReturnType<typeof makeCam>, W: number, H: number, inBand: (x: number, y: number) => boolean): boolean => {
  const c = silkBox(t).map(([x, y]) => ((q) => [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H] as const)(project(cam, x, y)))
  const probes = c.flatMap((p, k) => { const q = c[(k + 1) % 4] as readonly [number, number]; return Array.from({ length: 8 }, (_, j) => [p[0] + ((q[0] - p[0]) * j) / 8, p[1] + ((q[1] - p[1]) * j) / 8] as const) })
  return probes.some(([x, y]) => inBand(x, y))
}

/** every mark a print draws from the board, as segments in pixels through cam: silk strokes, silk text boxes, the bodies of parts and every pad; what the band clears is left out, and what printKept keeps is never cleared */
export function printMarks(scene: TraceScene, cam: ReturnType<typeof makeCam>, W: number, H: number, inBand: (x: number, y: number) => boolean = () => false): Seg[] {
  const at = (x: number, y: number, z = 0): [number, number] => {
    const q = project(cam, x, y, z)
    return [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H]
  }
  const rect = (x: number, y: number, w: number, h: number, rot: number, z = 0): Seg[] => {
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => at(x + ((u as number) * w * c - (v as number) * h * s) / 2, y + ((u as number) * w * s + (v as number) * h * c) / 2, z)).map((p, i, all) => { const q = all[(i + 1) % 4] as [number, number]; return [p[0], p[1], q[0], q[1]] as Seg })
  }
  const kept = printKept(scene, cam, W, H).flatMap((k) => k.segs)
  const held = new Set(kept.map((sg) => sg.join(',')))
  const silk = scene.silkStrokes.flatMap(({ path }) => Array.from({ length: Math.max(0, path.length / 2 - 1) }, (_, i) => [...at(path[2 * i] as number, path[2 * i + 1] as number), ...at(path[2 * i + 2] as number, path[2 * i + 3] as number)] as Seg))
  const texts = scene.texts.filter((t) => !silkWhole(t, cam) && !silkInBand(t, cam, W, H, inBand)).flatMap((t) => silkBox(t).map(([x, y]) => at(x, y)).map((p, i, all): Seg => { const q = all[(i + 1) % 4] as [number, number]; return [p[0], p[1], q[0], q[1]] }))
  const parts = scene.parts.filter((p) => p.z > 0 && p.hero !== true).flatMap((p) => [...rect(p.x, p.y, p.w, p.h, p.rot, p.z), ...rect(p.x, p.y, p.w, p.h, p.rot)])
  const pads = scene.pads.flatMap((p) => rect(p.x, p.y, p.w, p.h, p.rot))
  return [...kept, ...[...silk, ...texts, ...parts, ...pads].filter((sg) => !held.has(sg.join(',')) && !(inBand(sg[0], sg[1]) && inBand(sg[2], sg[3])))]
}

/** the nearest of the places that keeps the box inside the frame's margin and clear of every mark, or undefined */
const clearPlace = <T>(places: Array<{ box: TextBox; at: T }>, marks: Seg[], W: number, H: number): { box: TextBox; at: T } | undefined =>
  places.find(({ box }) => boxSegs(box).every((s) => s[0] >= LABEL.margin * W && s[0] <= (1 - LABEL.margin) * W && s[1] >= LABEL.margin * H && s[1] <= (1 - LABEL.margin) * H) && !marks.some((s) => touches(s, box)))

export function hypeCut(source: TraceScene, m: MontageScore, W: number, H: number, frames = 360): HypeCut {
  const xs = source.board.flatMap((l) => l.filter((_, i) => i % 2 === 0))
  const ys = source.board.flatMap((l) => l.filter((_, i) => i % 2 === 1))
  const bb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
  const quarter = (bb.x1 - bb.x0 > bb.y1 - bb.y0) === (H > W) ? Math.PI / 2 : 0
  const silk = [...source.texts].sort((a, b) => b.size * b.text.length - a.size * a.text.length)[0]?.rot ?? 0
  const turns = source.parts.map((p) => {
    const d = markingAxis(p)
    return p.label !== undefined && d.x * Math.cos(silk) + d.y * Math.sin(silk) < -0.01
  })
  const scene: TraceScene = { ...source, parts: source.parts.map((p, i) => (p.label === undefined ? p : { ...p, turn: turns[i] === true })) }
  const mid = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 }
  const span = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0)
  const hero = scene.parts.find((p) => p.hero === true) ?? scene.parts.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
  const long = bb.x1 - bb.x0 >= bb.y1 - bb.y0 ? { x: 1, y: 0 } : { x: 0, y: 1 }
  const conns = [...scene.parts].filter((p) => p.kind === 'conn').sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h))
  const sig = (p: TracePart): string => `${p.kind}:${Math.round(Math.min(p.w, p.h) / 4)}x${Math.round(Math.max(p.w, p.h) / 4)}`
  const sets = new Map<string, TracePart[]>()
  for (const p of scene.parts) if (p !== hero) sets.set(sig(p), [...(sets.get(sig(p)) ?? []), p])
  const worth = (list: TracePart[]): number => {
    const p = list[0] as TracePart
    return list.length * Math.sqrt(p.w * p.h) * (p.kind === 'res' || p.kind === 'cap' || p.kind === 'pin' || p.kind === 'other' ? 0.2 : 1)
  }
  interface Mark { x: number; y: number; w: number; h: number }
  const ports: Mark[] = m.facePorts.filter((g) => g.length > 0).map((g) => {
    const px = g.flatMap((r) => [r.x - r.w / 2, r.x + r.w / 2])
    const py = g.flatMap((r) => [r.y - r.h / 2, r.y + r.h / 2])
    return { x: (Math.min(...px) + Math.max(...px)) / 2, y: (Math.min(...py) + Math.max(...py)) / 2, w: Math.max(...px) - Math.min(...px), h: Math.max(...py) - Math.min(...py) }
  })
  const repeated: Mark[] | undefined = ports.length >= 3 ? ports : [...sets.values()].filter((l) => l.length >= 3).sort((a, b) => worth(b) - worth(a))[0]
  const near = (list: Mark[], c: Mark): Mark[] => list.filter((p) => Math.hypot(p.x - c.x, p.y - c.y) < 0.22 * span)
  const spread = (list: Mark[]): number => Math.max(...list.map((p) => p.x)) - Math.min(...list.map((p) => p.x)) + Math.max(...list.map((p) => p.y)) - Math.min(...list.map((p) => p.y))
  const seed = repeated === undefined ? undefined : [...repeated].sort((a, b) => near(repeated, b).length - near(repeated, a).length)[0]
  const raw: Mark[] | undefined = repeated === undefined || seed === undefined ? undefined : spread(repeated) > 0.6 * span && near(repeated, seed).length >= 3 ? near(repeated, seed) : repeated
  const rAxis = raw === undefined || Math.max(...raw.map((p) => p.x)) - Math.min(...raw.map((p) => p.x)) >= Math.max(...raw.map((p) => p.y)) - Math.min(...raw.map((p) => p.y)) ? 'x' : 'y'
  const clear = (raw ?? []).filter((p) => Math.abs(p[rAxis] - hero[rAxis]) > 0.6 * Math.max(hero.w, hero.h))
  const sides = [clear.filter((p) => p[rAxis] < hero[rAxis]), clear.filter((p) => p[rAxis] > hero[rAxis])].sort((a, b) => b.length - a.length)
  const heroMax = Math.max(hero.w, hero.h)
  const astride = raw !== undefined && Math.hypot(raw.reduce((a, p) => a + p.x, 0) / raw.length - hero.x, raw.reduce((a, p) => a + p.y, 0) / raw.length - hero.y) < heroMax
  const group: Mark[] | undefined = !astride ? raw : (sides[0]?.length ?? 0) >= 2 ? sides[0] : undefined
  const gx = group === undefined ? [] : group.map((p) => p.x)
  const gy = group === undefined ? [] : group.map((p) => p.y)
  const gAxis = Math.max(...gx) - Math.min(...gx) >= Math.max(...gy) - Math.min(...gy) ? 'x' : 'y'
  const gSorted = group === undefined ? [] : [...group].sort((a, b) => a[gAxis] - b[gAxis])
  const ga = gSorted[0]
  const gb = gSorted.at(-1)
  const gMid = group === undefined ? mid : { x: gx.reduce((a, v) => a + v, 0) / gx.length, y: gy.reduce((a, v) => a + v, 0) / gy.length }
  const gExtent = ga === undefined || gb === undefined ? span : Math.hypot(gb.x - ga.x, gb.y - ga.y) + Math.max(ga.w, ga.h)
  const second = scene.parts.filter((p) => p !== hero && p.kind === 'ic' && Math.hypot(p.x - hero.x, p.y - hero.y) > 1.2 * heroMax && !(group ?? []).some((g) => g.x === p.x && g.y === p.y)).sort((a, b) => b.w * b.h - a.w * a.h)[0]
  const copperDone = Math.max(scene.acts.pour[1], ...scene.layers.flatMap((l) => l.segs.filter((_, i) => i % 7 === 6)))
  const silkDone = Math.max(scene.acts.silk[1], ...scene.silkStrokes.map((k) => k.t))
  const firstPart = Math.min(...scene.parts.map((p) => p.t - (p.fall ?? 11.5 / 360)))
  const WINDOWS: Record<'lit' | 'bare' | 'copper', [number, number]> = { copper: [copperDone + 0.002, scene.acts.mask[0] - 0.001], bare: [silkDone + 0.002, firstPart - 0.002], lit: [scene.acts.hold[0] + 0.045, 0.995] }
  const outline: Array<[number, number, number]> = scene.board.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i): [number, number, number] => [l[2 * i] as number, l[2 * i + 1] as number, 0]))
  const small0 = Math.min(W, H)
  const macro = (0.7 * small0) / Math.max(hero.w, hero.h)
  const poster = { x: mid.x, y: mid.y, tilt: 0.42, yaw: quarter + 0.1, aperture: 0.06, shift: -0.07 }
  const posterZ = fitZoom(poster, outline, W, H, 0.96, 0.83)
  const drawEnd = Math.min(copperDone, scene.acts.draw[1])
  const heroTop = { x: hero.x, y: hero.y, tilt: 0.12, aperture: 0.04 }
  const mark = markingAxis(hero)
  const sense = hero.turn === true ? -1 : 1
  const upYaw = Math.atan2(-sense * mark.y, sense * mark.x)
  const along = (quarter > 0 ? quarter : truck({ x: bb.x0, y: mid.y }, { x: bb.x1, y: mid.y }))
  const gYaw = ga === undefined || gb === undefined ? along : truck(ga, gb)
  const gZoom = Math.min(macro * 0.7, (0.85 * W) / Math.max(1, gExtent))
  const gClose = Math.min(macro * 1.2, Math.max(gZoom * 1.6, (0.9 * small0 * Math.max(1, (group?.length ?? 2) - 1)) / (2.5 * Math.max(1, gExtent))))
  const rim = scene.board.reduce<number[]>((a, l) => (l.length > a.length ? l : a), [])

  const rimPts = Array.from({ length: rim.length / 2 }, (_, i) => ({ x: rim[2 * i] as number, y: rim[2 * i + 1] as number }))
  const inner = Array.from({ length: 900 }, (_, i): [number, number] => [bb.x0 + (((i % 30) + 0.5) / 30) * (bb.x1 - bb.x0), bb.y0 + ((Math.floor(i / 30) + 0.5) / 30) * (bb.y1 - bb.y0)]).filter(([x, y]) => inside(x, y, rimPts))
  const seenShare = (p: Pose): number => {
    const cam = makeCam(p, W, H)
    return inner.filter(([x, y]) => {
      const v = project(cam, x, y)
      return v.w > 0 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1
    }).length / Math.max(1, inner.length)
  }
  const withhold = (p: Pose): Pose => {
    let q = p
    for (let i = 0; i < 16 && seenShare(q) > 0.3; i++) q = { ...q, zoom: q.zoom * 1.12 }
    return q
  }
  const cover = (p: Pose, clipped = false): number => boardCover(rim, makeCam(p, W, H), clipped)
  const fill = (p: Pose): Pose => {
    const f = p.focus ?? { x: p.x, y: p.y }
    for (const zm of [1, 1.15, 1.3, 1.5, 1.75]) {
      for (let k = 0; k <= 10; k++) {
        const c = { ...p, x: p.x + 0.1 * k * (mid.x - p.x), y: p.y + 0.1 * k * (mid.y - p.y), zoom: p.zoom * zm }
        const v = project(makeCam(c, W, H), f.x, f.y)
        if (Math.abs(v.x) < 0.85 && Math.abs(v.y) < 0.85 && cover(c) >= 0.95) return c
      }
    }
    return p
  }
  const readDir = (p: Pose): number => {
    const cam = makeCam(p, W, H)
    const shown = (x: number, y: number): boolean => {
      const v = project(cam, x, y)
      return v.w > 0 && Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9
    }
    const dx = (x: number, y: number, d: { x: number; y: number }): number => project(cam, x + 10 * d.x, y + 10 * d.y).x - project(cam, x, y).x
    const hv = project(cam, hero.x, hero.y)
    if (hv.w > 0 && Math.abs(hv.x) < 0.5 && Math.abs(hv.y) < 0.5) return dx(hero.x, hero.y, { x: sense * mark.x, y: sense * mark.y })
    return scene.texts.filter((t) => shown(t.x, t.y)).reduce((a, t) => a + t.size * t.text.length * Math.sign(dx(t.x, t.y, { x: Math.cos(t.rot), y: Math.sin(t.rot) })), 0)
  }
  const balance = (p: Pose): Pose => {
    const cam = makeCam(p, W, H)
    const vis = scene.parts.filter((pt) => {
      const v = project(cam, pt.x, pt.y)
      return v.w > 0 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1
    })
    if (vis.length < 3) return p
    return { ...p, x: (p.x + vis.reduce((a, pt) => a + pt.x, 0) / vis.length) / 2, y: (p.y + vis.reduce((a, pt) => a + pt.y, 0) / vis.length) / 2 }
  }
  const upright = (a: Pose, b: Pose): [Pose, Pose] => (readDir(mix(a, b, 0.5)) >= 0 ? [a, b] : [{ ...a, yaw: a.yaw + Math.PI }, { ...b, yaw: b.yaw + Math.PI }])
  const heroR = Math.max(hero.w, hero.h)
  const q = (list: number[], k: number): number => [...list].sort((p, r) => p - r)[Math.floor(k * (list.length - 1))] ?? 0
  const heroCopper = scene.layers.flatMap((l) => Array.from({ length: Math.floor(l.segs.length / 7) }, (_, i) => i * 7).filter((i) => Math.hypot(((l.segs[i] as number) + (l.segs[i + 2] as number)) / 2 - hero.x, ((l.segs[i + 1] as number) + (l.segs[i + 3] as number)) / 2 - hero.y) < 1.6 * heroR).map((i) => l.segs[i + 6] as number))
  const drawWin: [number, number] = heroCopper.length < 8 ? [0.5 * drawEnd, drawEnd] : [Math.min(drawEnd, q(heroCopper, 0.3)), Math.min(drawEnd, q(heroCopper, 0.97))]
  const STEPS = [0, 45, 75, 95, 110, 120, 126, 129, 132, STOP]
  const matchAt = (f: number): Pose => {
    const k = (f / STOP) ** 1.3
    return { ...heroTop, tilt: 0.3, zoom: macro * 0.6 * (0.95 / 0.6) ** k * (W > H ? 1.3 : 1), yaw: upYaw + 0.22 - 0.16 * k, roll: 0 }
  }
  const seeThrough = STEPS.findIndex((f0, i) => i % 3 === 1 && i > 1 && (STEPS[i + 1] as number) - f0 >= SEEN_LEAST)
  const movesBuild: Move[] = STEPS.slice(0, -1).map((f0, i): Move => {
    const f1 = STEPS[i + 1] as number
    const base = { f0, f1, shape: 'drift' as const, a: matchAt(f0), b: matchAt(f1) }
    if (i % 3 === 0) return i === 0 ? { ...base, state: 'draw', draw: drawWin, hold: 0 } : { ...base, state: 'copper' }
    if (i === seeThrough) return { ...base, state: 'lit', looks: [[f0, f1, 'xray']] }
    if (i % 3 === 1 || (i % 3 === 2 && i < STEPS.length - 2 && STOP - f1 < STROBE)) return { ...base, state: 'lit', looks: [[f0, f1, 'blueprint']], hold: f0, spot: [f0, { x: hero.x, y: hero.y, r: 0.95 * heroR }] }
    return { ...base, state: 'lit', grade: 'release' }
  })
  const name = /[a-z][A-Z]|^[a-z]/.test(m.name) ? m.name : m.name.toUpperCase()
  const rev = m.version === undefined ? undefined : /^(rev|v)/i.test(m.version) ? m.version : `REV ${m.version.toUpperCase()}`
  const farEdge = (p: Pose): number => {
    const cam = makeCam(p, W, H)
    return Math.min(1, ...outline.map(([x, y]) => project(cam, x, y)).filter((v) => v.w > 0).map((v) => (1 - v.y) / 2))
  }
  const endAt = (tilt: number, turn: number): Pose => ({ x: hero.x, y: hero.y, tilt, yaw: upYaw + turn, fov: END.fov, zoom: (END.wide * small0) / heroMax, aperture: 0.26, shift: 1 - 2 * END.down, focus: { x: hero.x, y: hero.y } })
  const ems = Array.from(name).map(emOf)
  const emSum = Math.max(1, ems.reduce((a, v) => a + v, 0))
  const crownOf = (capOf: number): number => rev === undefined ? 0 : Math.min(CROWN.most * capOf, Math.max((FACE.cap * CROWN.wide * W) / (Array.from(rev).map(emOf).reduce((a, v) => a + v, 0) * H), (CROWN.least * Math.min(W, H)) / H))
  const capAt = (wide: number): number => Math.min(W > H ? NAME.landscape : NAME.cap, (FACE.cap * wide * W) / (emSum * H))
  const bodies = scene.parts.filter((pt) => pt.z > 0).map((pt) => drawnBody(scene, pt))
  const seatOf = (p: Pose, capOf: number, face: { ems: number[]; lift: boolean; head: number; drawn: boolean }): { foot: number; float: number; worst: number; mean: number; front: number } => {
    const cam = makeCam(p, W, H)
    const far = farEdge(p)
    const at = project(cam, hero.x, hero.y)
    const near = at.w / 2
    const boxes = !face.drawn ? scene.parts.filter((pt) => pt.z > 0).flatMap((pt) => {
      const v = Array.from({ length: 50 }, (_, i) => project(cam, pt.x + (Math.cos(pt.rot) * ((i % 5) / 2 - 1) * pt.w) / 2 - (Math.sin(pt.rot) * ((Math.floor(i / 5) % 5) / 2 - 1) * pt.h) / 2, pt.y + (Math.sin(pt.rot) * ((i % 5) / 2 - 1) * pt.w) / 2 + (Math.cos(pt.rot) * ((Math.floor(i / 5) % 5) / 2 - 1) * pt.h) / 2, i < 25 ? 0 : pt.z)).filter((v) => v.w > near)
      return v.length === 0 ? [] : [{ x0: Math.min(...v.map((c) => (c.x + 1) / 2)), x1: Math.max(...v.map((c) => (c.x + 1) / 2)), y0: Math.max(0, Math.min(...v.map((c) => (1 - c.y) / 2))) }]
    }) : bodies.flatMap((tri) => {
      const out: Array<{ x0: number; x1: number; y0: number }> = []
      for (let i = 0; i + 2 < tri.length; i += 3) {
        const v = [tri[i], tri[i + 1], tri[i + 2]].map((q) => project(cam, (q as [number, number, number])[0], (q as [number, number, number])[1], (q as [number, number, number])[2]))
        if (v.some((q) => q.w <= near)) continue
        out.push({ x0: Math.min(...v.map((q) => (q.x + 1) / 2)), x1: Math.max(...v.map((q) => (q.x + 1) / 2)), y0: Math.max(0, Math.min(...v.map((q) => (1 - q.y) / 2))) })
      }
      return out
    })
    const n = Math.max(1, name.length)
    const total = face.ems.reduce((a, v) => a + v, 0)
    const wide = (capOf * total * H) / (FACE.cap * W)
    const starts = face.ems.map((_, l) => face.ems.slice(0, l).reduce((a, v) => a + v, 0) / total)
    const sky = Array.from({ length: 4 * n }, (_, i) => (1 - wide) / 2 + ((starts[Math.floor(i / 4)] ?? 0) + (((i % 4) + 0.5) / 4) * ((face.ems[Math.floor(i / 4)] ?? 0) / total)) * wide).map((x) => Math.min(far, ...boxes.filter((bx) => x >= bx.x0 && x <= bx.x1).map((bx) => bx.y0)))
    const cover = (foot: number): number[] => Array.from({ length: n }, (_, l) => sky.slice(4 * l, 4 * l + 4).reduce((a, y) => a + Math.min(1, Math.max(0, (foot - y) / capOf)), 0) / 4)
    const tucked = Math.max(capOf + face.head, q(sky, NAME.over) + NAME.tuck * capOf)
    const lifted = Math.max(capOf + face.head, Math.min(tucked, Math.min(...sky) + NAME.tuck * capOf))
    const foot = !face.lift || Math.max(...cover(tucked)) <= NAME.letter ? tucked : lifted
    const letters = cover(foot)
    const front = scene.parts.filter((pt) => pt !== hero && pt.z > 0).reduce((sum, pt) => {
      const c = project(cam, pt.x, pt.y)
      if (c.w <= 0 || c.w >= at.w || c.y >= at.y) return sum
      const v = [0, pt.z].flatMap((z) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => project(cam, pt.x + (Math.cos(pt.rot) * (i as number) * pt.w) / 2 - (Math.sin(pt.rot) * (j as number) * pt.h) / 2, pt.y + (Math.sin(pt.rot) * (i as number) * pt.w) / 2 + (Math.cos(pt.rot) * (j as number) * pt.h) / 2, z))).filter((c2) => c2.w > 0)
      if (v.length < 8) return sum + (Math.abs(c.x) < 1.2 ? 0.25 : 0)
      const side = (lo: number, hi: number): number => Math.max(0, Math.min(1, hi) - Math.max(-1, lo))
      return sum + (side(Math.min(...v.map((c2) => c2.x)), Math.max(...v.map((c2) => c2.x))) * side(Math.min(...v.map((c2) => c2.y)), Math.max(...v.map((c2) => c2.y)))) / 4
    }, 0)
    return { foot, float: far - foot, worst: Math.max(...letters), mean: letters.reduce((a, v) => a + v, 0) / n, front }
  }
  const ends = END.turns.map((turn) => endAt(Array.from({ length: 9 }, (_, i) => END.tilt[0] + (i * (END.tilt[1] - END.tilt[0])) / 8).find((tilt) => farEdge(endAt(tilt, turn)) >= END.sky) ?? END.tilt[1], turn))
  const costOf = (t: ReturnType<typeof seatOf>): number => t.float + 2 * Math.max(0, t.front - END.front) + 4 * Math.max(0, t.worst - NAME.letter) + 4 * Math.max(0, t.mean - NAME.hidden)
  const rough = { ems: Array.from(name, () => FACE.cap / TURN_EM), lift: false, head: NAME.head, drawn: false }
  const heroBody = drawnBody(scene, hero)
  const otherBodies = scene.parts.filter((pt) => pt !== hero && pt.z > 0).map((pt) => drawnBody(scene, pt))
  const coveredAt = (p: Pose): number => Math.max(...[0.9, 1, 1 / PUSH].map((k) => heroCovered(heroBody, otherBodies, makeCam({ ...p, zoom: p.zoom * k }, W, H), W, H)))
  const costed = ends.map((p) => ({ p, cost: costOf(seatOf(p, Math.min(NAME.cap, (TURN_EM * NAME.wide * W) / (Math.max(1, name.length) * H)), rough)) }))
  const choose = (list: typeof costed): (typeof costed)[number] => list.reduce((a, c) => (c.cost < a.cost - 0.02 ? c : a))
  const clearEnd = (left: typeof costed): (typeof costed)[number] | undefined => {
    if (left.length === 0) return undefined
    const pick = choose(left)
    return coveredAt(pick.p) === 0 ? pick : clearEnd(left.filter((c) => c !== pick))
  }
  const turned = (clearEnd(costed) ?? choose(costed)).p
  const fitAt = (wide: number): { wide: number; cap: number; t: ReturnType<typeof seatOf> } => ({ wide, cap: capAt(wide), t: seatOf(turned, capAt(wide), { ems, lift: true, drawn: true, head: Math.max(NAME.head, CROWN.rise * crownOf(capAt(wide)) + CROWN.gap) }) })
  const fit = NAME_FITS.filter((w) => w >= BEHIND_KEEP * NAME.wide).map(fitAt).find((c) => c.t.worst <= NAME.letter && c.t.mean <= NAME.hidden)
  const seat = { p: turned, ...(fit ?? fitAt(NAME.wide)) }
  const still = seat.p
  const passes = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const k = Math.min(1, Math.max(0, ((hero.x - a.x) * dx + (hero.y - a.y) * dy) / Math.max(1e-6, dx * dx + dy * dy)))
    return Math.hypot(a.x + k * dx - hero.x, a.y + k * dy - hero.y)
  }
  const lane = (k: number): { x: number; y: number } => ({ x: mid.x + long.x * k * span, y: mid.y + long.y * k * span })
  const edgeGap = (p: { x: number; y: number }): number => Math.min(...Array.from({ length: rim.length / 2 }, (_, i) => {
    const ax = rim[2 * i] as number
    const ay = rim[2 * i + 1] as number
    const bx = rim[(2 * i + 2) % rim.length] as number
    const by = rim[(2 * i + 3) % rim.length] as number
    const dx = bx - ax
    const dy = by - ay
    const k = Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.y - ay) * dy) / Math.max(1e-6, dx * dx + dy * dy)))
    return Math.hypot(ax + k * dx - p.x, ay + k * dy - p.y)
  }))
  const slots: Array<{ w: number; a: Pose; b: Pose }> = [
    ...(ga === undefined || gb === undefined || passes(ga, gb) < heroMax || edgeGap(gMid) < 0.12 * span ? [] : [{ w: 1.2, a: { ...ga, zoom: gClose, tilt: 0.58, yaw: gYaw + 0.12, aperture: 0.16, focus: ga }, b: { ...gb, zoom: gClose * 0.94, tilt: 0.52, yaw: gYaw + 0.02, aperture: 0.16, focus: gb } }]),
    ...(second === undefined ? [] : [{ w: 1, a: { x: second.x - 1.2 * second.w, y: second.y, zoom: macro * 0.75, tilt: 0.75, yaw: 0.15, aperture: 0.18, focus: { x: second.x, y: second.y } }, b: { x: second.x + 1.2 * second.w, y: second.y, zoom: macro * 0.75, tilt: 0.7, yaw: -0.05, aperture: 0.18, focus: { x: second.x, y: second.y } } }])
  ]
  const centre = (sl: { a: Pose; b: Pose }): { x: number; y: number } => ({ x: (sl.a.x + sl.b.x) / 2, y: (sl.a.y + sl.b.y) / 2 })
  const reach0 = slots.length === 0 ? 0.36 : 0.25
  const plug = conns.find((c) => Math.hypot(c.x - hero.x, c.y - hero.y) > 1.2 * heroMax && (group === undefined || Math.hypot(c.x - gMid.x, c.y - gMid.y) > 0.6 * gExtent + Math.max(c.w, c.h)))
  if (plug === undefined) slots.push({ w: 1.2, a: { ...lane(-reach0), zoom: posterZ * 1.9, tilt: 0.55, yaw: along - 0.15, aperture: 0.1 }, b: { ...lane(reach0), zoom: posterZ * 1.75, tilt: 0.45, yaw: along + 0.12, aperture: 0.1 } })
  else {
    const ax = markingAxis(plug)
    const len = Math.max(plug.w, plug.h)
    const e0 = { x: plug.x - 0.3 * len * ax.x, y: plug.y - 0.3 * len * ax.y }
    const e1 = { x: plug.x + 0.3 * len * ax.x, y: plug.y + 0.3 * len * ax.y }
    const pz = Math.max(posterZ * 2.2, Math.min(macro, (0.8 * W) / len))
    slots.push({ w: 1.2, a: { ...e0, zoom: pz, tilt: 0.62, yaw: truck(e0, e1) + 0.1, aperture: 0.14, focus: e0 }, b: { ...e1, zoom: pz * 0.95, tilt: 0.56, yaw: truck(e0, e1), aperture: 0.14, focus: e1 } })
  }
  const apart = slots.filter((sl, i) => slots.slice(0, i).every((o) => Math.hypot(centre(sl).x - centre(o).x, centre(sl).y - centre(o).y) > 0.25 * span))
  slots.splice(0, slots.length, ...apart)
  if (slots.length < 2 && slots.every((o) => Math.hypot(centre(o).x - mid.x, centre(o).y - mid.y) > 0.25 * span)) slots.push({ w: 1.2, a: { ...lane(-0.25), zoom: posterZ * 1.9, tilt: 0.55, yaw: along - 0.15, aperture: 0.1 }, b: { ...lane(0.25), zoom: posterZ * 1.75, tilt: 0.45, yaw: along + 0.12, aperture: 0.1 } })
  if (slots.length < 2 && passes(lane(0.3), lane(-0.3)) >= heroMax) slots.unshift({ w: 1, a: { ...lane(0.3), zoom: posterZ * 2.6, tilt: 0.85, yaw: along + Math.PI / 2 + 0.2, aperture: 0.14 }, b: { ...lane(-0.3), zoom: posterZ * 2.4, tilt: 0.8, yaw: along + Math.PI / 2 - 0.05, aperture: 0.14 } })
  const RUN = [200, WHOLE[0]] as const
  const detail = (c: { x: number; y: number }, dir: number, zm: number, tilt: number, aperture: number): [Pose, Pose] => {
    const yaw = truck(c, { x: c.x + Math.cos(dir), y: c.y + Math.sin(dir) })
    const at = withhold(fill({ ...c, zoom: Math.min(macro * 1.6, Math.max(posterZ * 2.2, zm)), tilt, yaw, aperture, focus: c }))
    const half = (0.11 * W) / at.zoom
    return [{ ...at, x: at.x - half * Math.cos(dir), y: at.y - half * Math.sin(dir) }, { ...at, x: at.x + half * Math.cos(dir), y: at.y + half * Math.sin(dir) }]
  }
  const shrouded = ([a, b]: [Pose, Pose], least = 0.5 * hero.w * hero.h, clipped = false): boolean => {
    const cam = makeCam(mix(a, b, 0.5), W, H)
    if (cover(a, clipped) < 0.9 || cover(b, clipped) < 0.9) return true
    return conns.filter((c) => c.w * c.h > least).reduce((sum, c) => {
      const pts = [0, c.z].flatMap((z) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => project(cam, c.x + (Math.cos(c.rot) * (u as number) * c.w) / 2 - (Math.sin(c.rot) * (v as number) * c.h) / 2, c.y + (Math.sin(c.rot) * (u as number) * c.w) / 2 + (Math.cos(c.rot) * (v as number) * c.h) / 2, z)))
      if (pts.some((q) => q.w <= 0)) return sum
      const side = (lo: number, hi: number): number => Math.max(0, Math.min(1, hi) - Math.max(-1, lo))
      return sum + (side(Math.min(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.x))) * side(Math.min(...pts.map((q) => q.y)), Math.max(...pts.map((q) => q.y)))) / 4
    }, 0) > 0.2
  }
  const castBodies = scene.parts.filter((pt) => pt.z > 0).map((pt) => ({ body: drawnBody(scene, pt), plain: pt.mesh === undefined && pt.label === undefined }))
  const solids = castBodies.map((b) => b.body)
  const written = boardWords(scene)
  const markLean = (cam: ReturnType<typeof makeCam>, turned: boolean): number | undefined => {
    const at = project(cam, hero.x, hero.y, hero.z)
    if (at.w <= 0 || Math.abs(at.x) >= 1 || Math.abs(at.y) >= 1) return undefined
    const d = markingAxis(hero)
    const k = turned ? -1 : 1
    const q = project(cam, hero.x + k * d.x, hero.y + k * d.y, hero.z)
    return Math.abs(Math.atan2((q.y - at.y) * H, (q.x - at.x) * W))
  }
  const readsAt = (p: Pose): { ok: boolean; level: number } => {
    const cam = makeCam(p, W, H)
    const lean = markLean(cam, hero.turn === true)
    if (lean !== undefined && lean > MARK_LEAN) return { ok: false, level: 0 }
    const got = countedWords(written, (k) => scene.parts[k]?.turn === true, bodyRaster(solids, cam, W, H), cam, W, H)
    return { ok: got.every((g) => Math.abs(g.lean) <= FLIPPED), level: got.reduce((n, g) => n + (Math.abs(g.lean) <= LEVEL_LEAN ? g.area : 0), 0) }
  }
  const entryOf = (from: Pose, to: Pose): Pose => (({ x, y, focus }: Pose): Pose => ({ ...from, x, y, ...(focus === undefined ? {} : { focus }) }))(ahead(to, from, WHIP_BACK))
  const turnedBy = (pr: [Pose, Pose], k: number): [Pose, Pose] => (k === 0 ? pr : (pr.map((p) => ({ ...p, yaw: p.yaw + k })) as [Pose, Pose]))
  const rightWays = (pr: [Pose, Pose], ride = false): Array<[Pose, Pose]> => turnsFor((k) => {
    const [a, b] = turnedBy(pr, k)
    const seen = (ride ? [entryOf(mix(a, b, 0.3), b), entryOf(mix(a, b, 0.7), a), mix(a, b, 0.5), a, b] : [a, mix(a, b, 0.5), b]).map(readsAt)
    return { ok: seen.every((r) => r.ok), level: seen.reduce((n, r) => n + r.level, 0) }
  }).map((k) => turnedBy(pr, k))
  const ways0 = slots.map((sl) => upright(withhold(fill(balance(sl.a))), withhold(fill(balance(sl.b)))))
  const blanks = scene.texts.filter((t) => EMPTY_VALUE.test(t.text))
  const showsBlank = ([a, b]: [Pose, Pose]): boolean => [a, mix(a, b, 0.5), b].some((p) => blanks.some((t) => {
    const v = project(makeCam(p, W, H), t.x, t.y)
    return v.w > 0 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1
  }))
  const asRidden = ways0.find((r) => !shrouded(r)) ?? ways0[0]
  const rideOptions = [...ways0.filter((r) => !shrouded(r)), ...ways0.filter((r) => shrouded(r))].map((r) => {
    const ways = rightWays(r, true)
    return ways[0] === r ? [r] : ways.filter((q) => !showsBlank(q) && (shrouded(r) || !shrouded(q, undefined, true)))
  }).find((list) => list.length > 0) ?? (asRidden === undefined ? [] : [asRidden])
  const rides = rideOptions.slice(0, 1)
  const seenIn = (list: Array<[Pose, Pose]>) => (x: number, y: number): boolean => list.some(([a, b]) => {
    const v = project(makeCam(mix(a, b, 0.5), W, H), x, y)
    return v.w > 0 && Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9
  })
  const ridden = seenIn([asRidden].filter((r) => r !== undefined))
  const lettered = [...scene.texts].map((t) => {
    const width = t.size * Math.max(...t.text.split('\n').map((l) => l.length))
    const shift = t.align === 'left' ? 0.5 : t.align === 'right' ? -0.5 : 0
    return { x: t.x + shift * width * Math.cos(t.rot), y: t.y + shift * width * Math.sin(t.rot), rot: t.rot, width }
  }).filter((t) => t.width > 0.5 * heroMax && Math.hypot(t.x - hero.x, t.y - hero.y) > 1.2 * heroMax && !scene.parts.some((p) => p.led !== undefined && Math.hypot(p.x - t.x, p.y - t.y) < 0.75 * t.width)).sort((p, r) => r.width - p.width)
  const chips = scene.parts.filter((p) => p !== hero && p !== second && p.kind === 'ic' && p.label !== undefined).sort((p, r) => r.w * r.h - p.w * p.h)
  const apartFrom = (p: { x: number; y: number }, taken: Array<{ x: number; y: number }>): boolean => taken.every((o) => Math.hypot(p.x - o.x, p.y - o.y) > 0.15 * span)
  const onText = (t: { x: number; y: number; rot: number; width: number }): [Pose, Pose] => detail(t, t.rot, (0.62 * W) / t.width, 0.62, 0.2)
  const onChip = (p: TracePart): [Pose, Pose] => {
    const way = p.turn === true ? -1 : 1
    return detail(p, Math.atan2(way * markingAxis(p).y, way * markingAxis(p).x), (0.42 * W) / Math.max(p.w, p.h), 0.6, 0.14)
  }
  const blocky = ([a, b]: [Pose, Pose]): boolean => [a, mix(a, b, 0.5), b].some((p) => plainMost(castBodies, makeCam(p, W, H), W, H) > PLAIN_MOST)
  const placesFor = (clipped: boolean, unturned = false): Array<Array<Array<[Pose, Pose]>>> => {
    const fits = (pr: [Pose, Pose], least?: number): Array<[Pose, Pose]> => {
      const clear = (r: [Pose, Pose]): boolean => !shrouded(r, least, clipped) && !showsBlank(r)
      if (!clear(pr)) return []
      if (unturned) return [pr]
      return rightWays(pr).filter((r) => (r === pr || (!shrouded(r, least, true) && !showsBlank(r))) && ((r === pr && asCut.has(JSON.stringify(pr))) || !blocky(r)))
    }
    const placed = (pr: [Pose, Pose], least?: number): [Pose, Pose] | undefined => fits(pr, least)[0]
    const letters = lettered.filter((t) => !ridden(t.x, t.y))
    const ics = chips.filter((p) => !ridden(p.x, p.y))
    const text1 = letters.find((t) => placed(onText(t)) !== undefined)
    const chip1 = ics.find((p) => apartFrom(p, text1 === undefined ? [] : [text1]) && placed(onChip(p)) !== undefined)
    const taken = [text1, chip1].filter((o) => o !== undefined)
    const text2 = letters.find((t) => t !== text1 && apartFrom(t, taken) && placed(onText(t)) !== undefined)
    const chip2 = ics.find((p) => p !== chip1 && apartFrom(p, taken) && placed(onChip(p)) !== undefined)
    const slots = [text1, chip1, text2 ?? chip2].filter((o) => o !== undefined)
    const texts = letters.map((o) => ({ o, aim: () => onText(o) }))
    const parts = ics.map((o) => ({ o, aim: () => onChip(o) }))
    const spares = (own: (typeof slots)[number], pool: Array<{ o: (typeof slots)[number]; aim: () => [Pose, Pose] }>): Array<Array<[Pose, Pose]>> => {
      const others = slots.filter((o) => o !== own)
      return pool.filter(({ o }) => o === own).concat(pool.filter(({ o }) => !slots.includes(o) && apartFrom(o, others))).map(({ aim }) => fits(aim())).filter((d) => d.length > 0).slice(0, 1 + SPARES)
    }
    const named: Array<Array<Array<[Pose, Pose]>>> = [
      ...(text1 === undefined ? [] : [spares(text1, texts)]),
      ...(chip1 === undefined ? [] : [spares(chip1, parts)]),
      ...(text2 !== undefined ? [spares(text2, texts)] : chip2 !== undefined ? [spares(chip2, parts)] : [])
    ]
    const row = named.length > 0 ? undefined : conns.filter((p) => p.pitch !== undefined && !ridden(p.x, p.y) && Math.hypot(p.x - hero.x, p.y - hero.y) > 1.2 * heroMax).map((p) => fits(detail(p, p.rot + (p.w >= p.h ? 0 : Math.PI / 2), (0.42 * W) / Math.max(p.w, p.h), 0.6, 0.14), 0)).find((d) => d.length > 0)
    return row === undefined ? named : [[row]]
  }
  const asPlaces = [false, true].reduce<Array<Array<Array<[Pose, Pose]>>>>((found, clipped) => (found.length > 0 ? found : placesFor(clipped, true)), [])
  const asCut = new Set(asPlaces.map((slot) => JSON.stringify(slot[0]?.[0])))
  const details = [false, true].reduce<Array<Array<Array<[Pose, Pose]>>>>((found, clipped) => (found.length > 0 ? found : placesFor(clipped)), [])
  const side = details.length > 0 ? SIDE : RUN[1]
  const paired: Array<Array<Array<[Pose, Pose]>>> = [...(rideOptions.length > 0 ? [[rideOptions]] : []), ...details]
  const spans = paired.map((_, i): [number, number] => (i < rides.length ? [RUN[0], side] : [side + 5 * Math.round(((i - rides.length) * (RUN[1] - side)) / details.length / 5), side + 5 * Math.round(((i - rides.length + 1) * (RUN[1] - side)) / details.length / 5)]))
  const struck: Pose = { ...heroTop, zoom: macro * 1.4, yaw: upYaw + 0.4, roll: 0.15 }
  const hitEnd: Pose = { ...heroTop, zoom: macro * 0.8, yaw: upYaw + 0.08, roll: 0 }
  const screenMove = (p: Pose, q: Pose): { x: number; y: number } => {
    const a = makeCam(p, W, H)
    const b = makeCam(q, W, H)
    let x = 0
    let y = 0
    let n = 0
    for (const [px, py] of inner) {
      const u = project(a, px, py)
      const v = project(b, px, py)
      if (u.w <= 0 || v.w <= 0 || Math.abs(u.x) > 1 || Math.abs(u.y) > 1) continue
      x += ((v.x - u.x) * W) / 2
      y += ((u.y - v.y) * H) / 2
      n++
    }
    return n === 0 ? { x: 0, y: 0 } : { x: x / n, y: y / n }
  }
  const agree = (a: { x: number; y: number }, b: { x: number; y: number }): number => (a.x * b.x + a.y * b.y) / Math.max(1e-9, Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))
  type Way = { pr: [Pose, Pose]; leave: { x: number; y: number }; arrive: { x: number; y: number } }
  const ways = new Map<[Pose, Pose], Way>()
  const wayOf = (pr: [Pose, Pose]): Way => ways.get(pr) ?? ways.set(pr, { pr, leave: screenMove(mix(pr[0], pr[1], 0.97), pr[1]), arrive: screenMove(pr[0], mix(pr[0], pr[1], 0.03)) }).get(pr) as Way
  const optionsOf = (slots: Array<Array<Array<[Pose, Pose]>>>, places: number, held: Array<boolean | undefined> = []) => slots.map((slot, i) => slot.slice(0, places).flatMap((list, r) => list.slice(0, 1).flatMap((pr) => [{ way: wayOf(pr), cost: 1000 * r, back: false }, { way: wayOf([pr[1], pr[0]]), cost: 1000 * r + i + 1, back: true }].filter((o) => held[i] === undefined || o.back === held[i]))))
  const route = (layers: Array<Array<{ way: Way; cost: number }>>): { flow: number; pick: Array<[Pose, Pose]> } => {
    const joins = layers.slice(1).map((list, i) => (layers[i] ?? []).map((o) => list.map((q) => agree(o.way.leave, q.way.arrive))))
    const reach = layers.slice(1).reduce((v, list, i) => list.map((_, k) => Math.max(...v.map((x, p) => Math.min(x, (joins[i] as number[][])[p]?.[k] ?? -1)))), (layers[0] ?? []).map(() => 1))
    const flow = Math.max(...reach)
    const ok = (i: number, p: number, k: number): boolean => ((joins[i] as number[][])[p]?.[k] ?? -1) >= flow - 0.1
    const toGo = layers.reduceRight<number[][]>((after, list, i) => [list.map((o, k) => o.cost + (i === layers.length - 1 ? 0 : Math.min(...(after[0] as number[]).map((g, q) => (ok(i, k, q) ? g : Infinity))))), ...after], [])
    const pick: Array<[Pose, Pose]> = []
    let at = (toGo[0] ?? []).indexOf(Math.min(...(toGo[0] ?? [])))
    layers.forEach((list, i) => {
      pick.push((list[at] as { way: Way }).way.pr)
      const left = (toGo[i] as number[])[at] as number - (list[at] as { cost: number }).cost
      if (i + 1 < layers.length) at = (toGo[i + 1] as number[]).findIndex((g, q) => ok(i, at, q) && g === left)
    })
    return { flow, pick }
  }
  const asPaired: Array<Array<Array<[Pose, Pose]>>> = [...(asRidden === undefined ? [] : [[[asRidden]]]), ...asPlaces]
  const asRoute = asPaired.length === 0 ? [] : route(optionsOf(asPaired, 1)).pick
  const samePair = (p: [Pose, Pose] | undefined, q: [Pose, Pose] | undefined): boolean => p !== undefined && q !== undefined && JSON.stringify(p) === JSON.stringify(q)
  const held = paired.map((slot, i) => (samePair(slot[0]?.[0], asPaired[i]?.[0]?.[0]) ? asRoute[i]?.[0] === asPaired[i]?.[0]?.[0]?.[1] : undefined))
  const choices = paired.map((slot, i) => (held[i] !== undefined ? [slot[0]?.[0] as [Pose, Pose]] : slot.slice(0, i < rides.length ? 1 : 1 + SPARES).flat()))
  const asCutAt = (i: number): [Pose, Pose] | undefined => asPaired[i]?.[0]?.[0]
  const combos = function* (lists: Array<Array<[Pose, Pose]>>, at: number, taken: Array<[Pose, Pose]>): Generator<Array<[Pose, Pose]>> {
    if (at === lists.length) yield taken
    else for (const pr of lists[at] as Array<[Pose, Pose]>) yield* combos(lists, at + 1, [...taken, pr])
  }
  const flowing = (picked: Array<[Pose, Pose]>) => route(optionsOf(picked.map((pr) => [[pr]]), 1, held))
  const firstFlowing = (lists: Array<Array<[Pose, Pose]>>) => {
    for (const picked of combos(lists, 0, [])) {
      const r = flowing(picked)
      if (r.flow >= SMOOTH) return r
    }
    return undefined
  }
  const asBefore = choices.map((list, i) => (i >= rides.length && held[i] === undefined && asCutAt(i) !== undefined ? [...list, asCutAt(i) as [Pose, Pose]] : list))
  const bestFlowing = (lists: Array<Array<[Pose, Pose]>>) => {
    let best: ReturnType<typeof flowing> | undefined
    for (const picked of combos(lists, 0, [])) {
      const r = flowing(picked)
      if (best === undefined || r.flow > best.flow) best = r
    }
    return best !== undefined && best.flow >= SMOOTH_LEAST ? best : undefined
  }
  const chosen = paired.length === 0 ? [] : (firstFlowing(choices) ?? bestFlowing(choices) ?? firstFlowing(asBefore) ?? flowing(choices.map((list) => list[0] as [Pose, Pose]))).pick
  const middle: Move[] = chosen.map(([a, b], i) => ({ f0: (spans[i] as [number, number])[0], f1: (spans[i] as [number, number])[1], shape: 'catch', a: i === 0 ? mix(a, b, 0.3) : a, b, ...(i === 0 ? { join: true as const } : {}) }))
  const first = middle[0]
  const last = middle.at(-1)
  const whip: Move[] = first === undefined ? [] : (() => {
    const entry = entryOf(first.a, first.b)
    const settle = (2.02 * (RUN[0] - WHIP)) / (WHIP_BACK * (first.f1 - first.f0))
    const arrive = screenMove(entry, mix(entry, first.a, (3 - 2 * settle) / (RUN[0] - WHIP)))
    const off = (th: number, d: number): Pose => ({ ...hitEnd, x: hitEnd.x + d * Math.cos(th), y: hitEnd.y + d * Math.sin(th) })
    const th = Array.from({ length: 72 }, (_, i) => (i * Math.PI) / 36).reduce((best, c) => (agree(screenMove(hitEnd, off(c, 4)), arrive) > agree(screenMove(hitEnd, off(best, 4)), arrive) ? c : best))
    const perUnit = Math.hypot(screenMove(hitEnd, off(th, 4)).x, screenMove(hitEnd, off(th, 4)).y) / 4
    let reach = (Math.hypot(arrive.x, arrive.y) * (WHIP - 186)) / (2 * Math.max(1e-6, perUnit))
    while (reach > 0.5 * heroMax && !inside(off(th, reach).x, off(th, reach).y, rimPts)) reach *= 0.85
    return [
      { f0: 186, f1: WHIP, shape: 'in' as const, join: true as const, a: hitEnd, b: off(th, reach) },
      { f0: WHIP, f1: RUN[0], shape: 'out' as const, a: entry, b: first.a, slope0: 3 - 2 * settle, slope: settle }
    ]
  })()
  const land: Pose = { ...still, zoom: still.zoom * 0.82, tilt: still.tilt - 0.18, yaw: still.yaw + 0.2, roll: 0.05 }
  const lateTurn = ((d) => d.x * Math.cos(still.yaw) - d.y * Math.sin(still.yaw) < 0)(markingAxis(hero))
  const leaves = last === undefined ? { x: 0, y: 0 } : screenMove(mix(last.a, last.b, 0.97), last.b)
  const pull = (lean: number): { wide: Pose; from: Pose } => {
    const yaw = quarter + 0.1 + Math.PI * Math.round((still.yaw - quarter - 0.1) / Math.PI) + lean
    const wide: Pose = { ...poster, yaw, shift: 0, zoom: fitZoom({ ...poster, yaw, shift: 0 }, outline, W, H, 0.9, 0.88), aperture: 0, roll: 0 }
    const back = (th: number): Pose => ({ ...wide, x: wide.x + 0.18 * span * Math.cos(th), y: wide.y + 0.18 * span * Math.sin(th), zoom: wide.zoom * 2.4, tilt: 0.6, yaw: wide.yaw + 0.3 })
    const starts = (th: number): number => agree(screenMove(back(th), mix(back(th), wide, 0.05)), leaves)
    return { wide, from: back(Array.from({ length: 72 }, (_, i) => (i * Math.PI) / 36).reduce((best, c) => (starts(c) > starts(best) ? c : best))) }
  }
  const leveled = (p: Pose): boolean => (markLean(makeCam(p, W, H), lateTurn) ?? 0) <= MARK_LEAN
  const { wide, from } = [0, ...[1, 2, 3, 4].flatMap((i) => [(i * Math.PI) / 8, (-i * Math.PI) / 8])].map(pull).find((v) => leveled(v.from)) ?? pull(0)
  const drop = wind(land, wide.yaw)
  const landed = wind(still, drop.yaw)
  const movesRelease: Move[] = [
    { f0: STOP, f1: RELEASE, shape: 'drift', state: 'lit', light: 'rim', grade: 'stop', a: { ...landed, zoom: landed.zoom * 0.9 }, b: { ...landed, zoom: landed.zoom * 0.97 } },
    { f0: RELEASE, f1: RELEASE + HELD, shape: 'drift', a: struck, b: struck },
    { f0: RELEASE + HELD, f1: 186, shape: 'out', join: true, a: struck, b: hitEnd },
    ...whip,
    ...middle,
    { f0: WHOLE[0], f1: WHOLE[1], shape: 'out', a: from, b: { ...wide, zoom: wide.zoom / PUSH } },
    { f0: WHOLE[1], f1: WHOLE[2], shape: 'drift', join: true, looks: [[SEEN[0], SEEN[1], 'xray']], a: { ...wide, zoom: wide.zoom / PUSH }, b: wide },
    { f0: WHOLE[2], f1: POSTER, shape: 'in', join: true, a: wide, b: drop },
    { f0: POSTER, f1: POSTER + SETTLE, shape: 'spring', join: true, hold: POSTER, a: drop, b: { ...landed, zoom: landed.zoom / PUSH } },
    { f0: POSTER + SETTLE, f1: frames, shape: 'drift', join: true, a: { ...landed, zoom: landed.zoom / PUSH }, b: landed }
  ]
  const moves = [...movesBuild, ...movesRelease]
  const moveAt = (f: number): Move | undefined => moves.find((mv) => f >= mv.f0 && f < mv.f1)
  const lookAt = (f: number): HypeLook => moveAt(f)?.looks?.find(([a, b]) => f >= a && f < b)?.[2] ?? 'lit'
  const pose = (f: number): Pose => {
    const mv = moveAt(Math.min(f, frames - 1e-6))
    if (mv === undefined) return still
    const u = Math.min(1, Math.max(0, (f - mv.f0) / (mv.f1 - mv.f0)))
    return curve(mv, mv.slope === undefined ? shapeOf(mv.shape, u) : u * u * (3 - 2 * u) + (mv.slope0 ?? 0) * (u * u * u - 2 * u * u + u) + mv.slope * (u * u * u - u * u))
  }
  const stateAt = (f: number): HypeState => {
    const mv = moveAt(f)
    if (mv === undefined) return 'black'
    const st = mv.state ?? 'lit'
    return st === 'bare' && WINDOWS.bare[1] - WINDOWS.bare[0] < 0.004 ? 'copper' : st
  }
  const used = { copper: 0, bare: 0, lit: 0 }
  for (let f = 0; f < frames; f++) {
    const st = stateAt(f)
    if (st === 'copper' || st === 'bare' || st === 'lit') used[st] += 2
  }
  let total = Math.ceil(Math.max(...(['copper', 'bare', 'lit'] as const).map((s) => used[s] / (WINDOWS[s][1] - WINDOWS[s][0])), 4 * frames)) + 4
  for (let i = 0; i < 400 && used.lit / 2 + moves.length + Math.ceil(LIGHT_EASE * total) + 8 > (WINDOWS.lit[1] - WINDOWS.lit[0]) * total; i++) total += 16
  const cursor = { copper: Math.ceil(WINDOWS.copper[0] * total), bare: Math.ceil(WINDOWS.bare[0] * total), lit: Math.ceil(WINDOWS.lit[0] * total) + RELEASE - STOP + Math.ceil(LIGHT_EASE * total) + 2 }
  let dark = Math.ceil(WINDOWS.lit[0] * total)
  const cuts = moves.filter((mv) => mv.f0 > 0 && mv.join !== true).map((mv) => mv.f0)
  const probe = [...Array.from({ length: 24 }, (_, i) => outline[Math.floor((i * outline.length) / 24)] as [number, number, number]), ...inner.filter((_, i) => i % 6 === 0).map(([x, y]): [number, number, number] => [x, y, 0])]
  const dense = [...probe, ...inner.map(([x, y]): [number, number, number] => [x, y, 0])]
  const smear = (f: number, over = probe): number => {
    const a = makeCam(pose(f), W, H)
    const b = makeCam(pose(f + 0.5), W, H)
    return Math.max(0, ...over.map(([x, y]) => {
      const p = project(a, x, y)
      const q = project(b, x, y)
      return p.w > 0 && q.w > 0 && Math.abs(p.x) < 1.5 && Math.abs(p.y) < 1.5 ? Math.hypot(((p.x - q.x) * W) / 2, ((p.y - q.y) * H) / 2) : 0
    }))
  }
  const shots: CameraShot[] = []
  const plan: HypeFrame[] = []
  const stack = copperStack(scene)
  const step = Math.min(SEEN_STEP, Math.floor(SEEN_STACKED / Math.max(1, stack.length - 1)))
  const key = (f: number, t: number, light: TraceLight, cut: boolean): void => {
    shots.push({ ...pose(f), t, ease: 'linear', light, cut })
  }
  for (let f = 0; f < frames; f++) {
    const state = stateAt(f)
    const grade: HypeGrade = state === 'black' ? 'black' : moveAt(f)?.grade ?? (f < STOP ? 'build' : 'release')
    if (state === 'black') {
      plan.push({ state, clone: 0, look: 'lit', blur: 1, grade })
      continue
    }
    const mv = moveAt(f) as Move
    const run = f === 0 || cuts.includes(f) || stateAt(f - 1) !== state
    let clone: number
    if (state === 'draw') {
      const [pa, pb] = mv.draw ?? [0, drawEnd]
      clone = Math.round((pa + ((pb - pa) * (f - mv.f0)) / (mv.f1 - mv.f0)) * total)
      key(f, clone / total, LIGHT[state], run)
      const ends = cuts.includes(f + 1) || stateAt(f + 1) !== state
      if (ends) key(f + 0.999, (clone + 0.999) / total, LIGHT[state], false)
    } else {
      const light = mv.light ?? LIGHT[state]
      if (run && f > 0 && grade !== 'stop') cursor[state] += 1
      clone = grade === 'stop' ? dark++ : cursor[state]++
      key(f, clone / total, light, run)
      const ends = f === frames - 1 || cuts.includes(f + 1) || stateAt(f + 1) !== state
      if (ends) key(f + 0.999, (clone + 0.999) / total, light, false)
    }
    const pulls = (f >= WHOLE[0] && f < WHOLE[1]) || (f >= WHOLE[2] && f < POSTER + SETTLE)
    const streak = grade === 'build' ? 0 : smear(f, pulls ? dense : probe)
    const shut = Math.min(1, ((pulls ? PULL_SMEAR : f >= 186 && f < RUN[0] ? WHIP_SMEAR : RIDE_SMEAR) * W) / Math.max(1e-6, streak))
    const through = grade !== 'build' && lookAt(f) === 'xray' ? { layers: Math.min(stack.length, 1 + Math.floor((f - SEEN[0]) / step)) } : {}
    plan.push({ state, clone, ...(mv.spot !== undefined && f >= mv.spot[0] ? { spot: mv.spot[1] } : {}), look: lookAt(f), ...through, ...(lookAt(f) === 'blueprint' ? { bare: true as const } : {}), blur: grade === 'build' ? 1 : Math.min(SWEEP, Math.max(24, Math.ceil((streak * shut) / (shut < 1 ? 1.25 : 2.5)))), ...(shut < 1 ? { shut } : {}), grade })
  }
  key(frames - 1, 0.5, 'power', true)
  key(frames - 1, (total - 1) / total, 'poster', true)
  shots.sort((a, b) => a.t - b.t)
  const read = { x: sense * mark.x, y: sense * mark.y }
  const flat = Math.abs(mark.x * Math.cos(hero.rot) + mark.y * Math.sin(hero.rot)) > 0.5
  const model = hero.mesh === undefined ? undefined : scene.meshes[hero.mesh.id]
  const lidOfBody = ((): [number, number] => {
    if (model === undefined) return [1, 1]
    const pos = new Float32Array(Uint8Array.from(atob(model.pos), (c) => c.charCodeAt(0)).buffer)
    const lo = [Infinity, Infinity]
    const hi = [-Infinity, -Infinity]
    for (let i = 0; i + 2 < pos.length; i += 3) {
      if ((pos[i + 2] as number) < model.max[2] - LID_FLAT) continue
      for (const k of [0, 1]) {
        lo[k] = Math.min(lo[k] as number, pos[i + k] as number)
        hi[k] = Math.max(hi[k] as number, pos[i + k] as number)
      }
    }
    const share = [0, 1].map((k) => ((hi[k] as number) - (lo[k] as number)) / ((model.max[k] as number) - (model.min[k] as number))) as [number, number]
    return Math.min(...share) >= LID_LEAST ? share : [1, 1]
  })()
  const lidSpan = flat ? [lidOfBody[0] * hero.w, lidOfBody[1] * hero.h] as const : [lidOfBody[1] * hero.h, lidOfBody[0] * hero.w] as const
  const anchor = ((): { x: number; y: number } => {
    const cam = makeCam(still, W, H)
    const [x, y] = outline.filter(([px, py]) => project(cam, px, py).w > 0).reduce((a, c) => (project(cam, c[0], c[1]).y > project(cam, a[0], a[1]).y ? c : a))
    return { x, y }
  })()
  const anchorAt = ((v: { x: number; y: number }): { x: number; y: number } => ({ x: (v.x + 1) / 2, y: (1 - v.y) / 2 }))(project(makeCam(still, W, H), anchor.x, anchor.y))
  const mm = (px: number): string => (px / scene.material.pxPerMm).toFixed(1)
  const told = m.lines.length > 0 ? m.lines : [`${mm(hero.w)} × ${mm(hero.h)} MM`]
  const hc = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const c = Math.cos(hero.rot)
    const s = Math.sin(hero.rot)
    const dx = ((u as number) * hero.w) / 2
    const dy = ((v as number) * hero.h) / 2
    return { x: hero.x + c * dx - s * dy, y: hero.y + s * dx + c * dy }
  })
  const prints = movesBuild.filter((mv) => mv.looks?.some(([, , l]) => l === 'blueprint') === true)
  const tall = (LABEL.size * W) / H
  const below = (mv: Move): number | undefined => {
    const cam = makeCam(pose(Math.min(mv.f1 - 1, (mv.hold ?? mv.f0) + 10)), W, H)
    const ys = hc.map((c) => (1 - project(cam, c.x, c.y).y) / 2)
    const lo = Math.max(...ys) + 0.06
    const hi = Math.min(...ys) - 0.06
    return lo + LABEL.under * tall <= 1 - LABEL.margin ? lo : hi - LABEL.over * tall >= LABEL.margin ? hi : undefined
  }
  const keep = CLEAR_TEXT.margin + CLEAR_TEXT.slack
  const lid = { x: hero.x, y: hero.y, z: hero.z, rot: Math.atan2(read.y, read.x), along: lidSpan[0], across: lidSpan[1] }
  const body = drawnBody(scene, hero)
  const laid = prints.map((mv, i) => {
    const seen = Array.from({ length: mv.f1 - mv.f0 }, (_, k) => mv.f0 + k).filter((f) => plan[f]?.bare === true)
    const watched = seen.filter((_, k) => k % 3 === 0 || k === seen.length - 1)
    const views = watched.map((f) => {
      const cam = makeCam(sampleShot(shots, (plan[f]?.clone ?? 0) / total), W, H)
      const px = measuredBox(bodyOutline(lid, body, cam, W, H), hc.map((c) => ((q) => ({ x: ((q.x + 1) / 2) * W, y: ((1 - q.y) / 2) * H }))(project(cam, c.x, c.y))))
      const mid = { x: px.reduce((a, p) => a + p.x, 0) / 4, y: px.reduce((a, p) => a + p.y, 0) / 4 }
      const chip = px.map((p, k): Seg => { const q = px[(k + 1) % 4] as { x: number; y: number }; return [p.x, p.y, q.x, q.y] })
      return { px, mid, chip, marks: printMarks(scene, cam, W, H, printBand(px, W)) }
    })
    const labels: [string, string] = [mm(hero.w), mm(hero.h)]
    const font = DIM_LABEL.size * Math.min(W, H)
    const tries = [0, 1, 2].flatMap((o) => Array.from({ length: 19 }, (_, j) => (j % 2 === 0 ? 1 : -1) * Math.ceil(j / 2) * 0.05).map((t): PrintShift => ({ out: o * CLEAR_TEXT.step, along: t })))
    const labelBox = (v: (typeof views)[number], k: number, at: PrintShift, text: string): TextBox => {
      const a = v.px[k] as { x: number; y: number }
      const b = v.px[k + 1] as { x: number; y: number }
      const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      const nl = Math.max(1, Math.hypot(cx - v.mid.x, cy - v.mid.y))
      return { x: cx + ((b.x - a.x) / len) * at.along * len + ((cx - v.mid.x) / nl) * (DIM_LABEL.gap * W + at.out * font), y: cy + ((b.y - a.y) / len) * at.along * len + ((cy - v.mid.y) / nl) * (DIM_LABEL.gap * W + at.out * font), ux: (b.x - a.x) / len, uy: (b.y - a.y) / len, along: (CLEAR_TEXT.letter * font * text.length) / 2 + keep * font, across: font / 2 + keep * font }
    }
    const shift = labels.map((text, k): PrintShift | undefined => {
      const len = (v: (typeof views)[number]): number => Math.hypot(((v.px[k + 1] as { x: number }).x - (v.px[k] as { x: number }).x), ((v.px[k + 1] as { y: number }).y - (v.px[k] as { y: number }).y))
      const order = [...tries].sort((p, q) => Math.hypot(p.along * len(views[0] as (typeof views)[number]), p.out * font) - Math.hypot(q.along * len(views[0] as (typeof views)[number]), q.out * font))
      return order.find((at) => views.every((v) => clearPlace([{ box: labelBox(v, k, at, text), at }], v.marks, W, H) !== undefined))
    })
    const y0 = below(mv)
    const text = told[i % told.length] as string
    const size = Math.min(LABEL.size * W, (0.86 * W) / (CLEAR_TEXT.letter * text.length))
    const ref = views[Math.floor(views.length / 2)]
    const side = y0 === undefined || ref === undefined || y0 * H > ref.mid.y ? 1 : -1
    const spots = y0 === undefined ? [] : Array.from({ length: 24 }, (_, k) => k).flatMap((k) => Array.from({ length: 13 }, (_, j) => (j % 2 === 0 ? 1 : -1) * Math.ceil(j / 2) * 0.05).map((dx) => ({ x: 0.5 + dx, y: y0 + (side * k * CLEAR_TEXT.step * size) / H }))).sort((p, q) => Math.hypot((p.x - 0.5) * W, (p.y - y0) * H) - Math.hypot((q.x - 0.5) * W, (q.y - y0) * H))
    const lineBox = (at: { x: number; y: number }): TextBox => ({ x: at.x * W, y: at.y * H, ux: 1, uy: 0, along: (CLEAR_TEXT.letter * size * text.length) / 2 + keep * size, across: size / 2 + keep * size })
    const line = spots.find((at) => views.every((v) => clearPlace([{ box: lineBox(at), at }], [...v.marks, ...v.chip, ...shift.flatMap((sh, k) => (sh === undefined ? [] : boxSegs(labelBox(v, k, sh, labels[k] as string))))], W, H) !== undefined))
    return { dims: { f0: mv.f0, f1: mv.f1, at: i === 0 ? mv.f0 : mv.f0 - 34, corners: hc, labels, shift: [shift[0] ?? null, shift[1] ?? null] } satisfies HypeDims, line: line === undefined ? undefined : { text, ...line } }
  })
  const dims: HypeDims[] = laid.map((l) => l.dims)
  const resolved = Array.from({ length: SETTLE }, (_, i) => POSTER + i).find((f) => smear(f, dense) < RESOLVED * W) ?? POSTER + SETTLE
  const words: HypeWord[] = [
    ...prints.map((mv, i): HypeWord => ((l) => ({ text: told[i % told.length] as string, f0: i === 0 ? mv.f0 + 6 : mv.f0, f1: mv.f1, size: LABEL.size, small: true, ...(l === undefined || hero.label !== undefined ? { x: 0, y: 0, follow: { x: hero.x, y: hero.y, z: hero.z }, inside: true } : { x: l.x, y: l.y }) }))(laid[i]?.line)),
    ...(hero.label === undefined ? [] : prints.map((mv): HypeWord => ({ text: hero.label as string, f0: mv.f0, f1: mv.f1, size: NAME_SIZE, small: true, x: 0, y: 0, follow: { x: hero.x, y: hero.y, z: hero.z }, inside: true, name: true }))),
    { text: name, f0: resolved, f1: frames, x: 0.5 - anchorAt.x, y: seat.t.foot - seat.cap / 2 - anchorAt.y, follow: anchor, size: seat.wide, behind: fit !== undefined, maxCap: seat.cap, cover: fit === undefined ? 0 : seat.t.worst },
    ...(rev === undefined ? [] : [{ text: rev, f0: POSTER + 8, f1: frames, x: 0.5, y: 0.06, size: CROWN.wide, crown: true, minCap: CROWN.least, maxCap: crownOf(seat.cap) }])
  ]
  const events: HypeCut['events'] = [
    { f: 0, kind: 'hold' as const },
    ...movesBuild.filter((mv) => mv.f0 > 0).map((mv) => ({ f: mv.f0, kind: 'burst' as const })),
    { f: STOP, kind: 'stop' as const },
    { f: RELEASE, kind: 'hit' as const },
    ...movesRelease.filter((mv) => mv.f0 > RELEASE && mv.f0 < POSTER).map((mv) => ({ f: mv.f0, kind: mv.join === true ? 'move' as const : 'cut' as const })),
    ...SEEN.map((f) => ({ f, kind: 'cut' as const })),
    ...words.filter((w) => w.name !== true).map((w) => ({ f: w.f0, kind: 'type' as const })),
    { f: POSTER, kind: 'poster' as const }
  ].sort((a, b) => a.f - b.f)
  const lamp = liveLed(source.parts)
  const pale = [1, 3, 5].reduce((sum, i, k) => sum + ([0.2126, 0.7152, 0.0722][k] as number) * (parseInt(scene.material.mask.slice(i, i + 2), 16) / 255), 0)
  const glintAt = RELEASE + 30 * GLINT_AT
  const glint = { f0: glintAt, f1: glintAt + GLINT_RUN, ...lid, peak: GLINT_PEAK }
  return { frames, total, shots, plan, words, dims, glint, stage: { ...STAGE, hero: DARK_HERO + (STAGE.hero - DARK_HERO) * pale }, cuts, events, still: [POSTER, frames], turns, hit: [RELEASE, 186], ...(lamp === undefined ? {} : { blink: { at: lamp, from: ((plan[POSTER] as HypeFrame).clone - 4) / total } }), late: { from: RUN[1], turns: source.parts.map((p) => {
    const d = markingAxis(p)
    return p.label !== undefined && d.x * Math.cos(still.yaw) - d.y * Math.sin(still.yaw) < 0
  }) } }
}
