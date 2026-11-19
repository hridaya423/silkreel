import type { Vec2 } from '@silk-reel/ingest'
import type { ResolvedConfig } from '../config'
import type { CameraShot, TraceActs, TraceLayer, TraceLockup } from '../types'
import { centreOn, corners, fitZoom, heroCrossed, heroOcclusion, inSight, lidCover, makeCam, nearCover, nearShare, project, sampleShot } from './camera'
import type { Body } from './camera'
import { boardPoints, buildFrom, CAP, clearOf, composite, lockupAt, onTick, READ_SECONDS, silhouette, titleBlock } from './lockup'
import type { Side } from './lockup'
import type { ShotInput } from './scene'

const B = 1 / 24
const D = Math.PI / 180
const FRAMES = 360
const FILM_SECONDS = 12

type Key = Omit<CameraShot, 't'>
type Lens = { tilt: number; fov: number; aperture: number }

/** copper draws itself seen along the surface: low, close, long lens */
export const SPARK: Lens = { tilt: 80 * D, fov: 14 * D, aperture: 0.3 }
/** the wet coat arrives toward the lens: lower still, a wider lens */
export const COAT: Lens = { tilt: 77 * D, fov: 24 * D, aperture: 0.2 }
/** the skyline: across the board at the main chip's lands */
export const PLACE: Lens = { tilt: 82 * D, fov: 14 * D, aperture: 0.25 }
/** the board dims to the main chip's rim this long before it seats, so it falls alone into its own light */
const HERO_ALONE = 12 / FRAMES
/** the parts take: the first position looks halfway from the main chip to the crowd of parts smaller than this share of it; the camera cranes to the second over the half beat before it, which rises to this lens and stands between these many times wider than the main chip's close; the third stands this much nearer than it */
const STAGE_SMALL = 0.6
const WIDE: Lens = { tilt: 76 * D, fov: 20 * D, aperture: 0.15 }
const WIDE_OUT = [1.3, 1.6] as const
const ALONE_IN = 1.12
/** where the main chip seats, the camera turns and drops until nothing nearer crosses the chip's outline, the chip spans at least this share of the frame's width, and black above the board's far edge takes at most this share of its height */
export const ALONE_WIDTH = 0.3
export const ALONE_SKY = 0.25
const ALONE_DROP = [0, 6, 12, 18, 24, 30, 36].map((d) => d * D)
const ALONE_SIZES = [ALONE_WIDTH + 0.03, 0.45, 0.6, 0.8]
/** no part nearer than what a parts-take position looks at covers more than this share of its frame; the position rises until none does */
const STAGE_FRONT = 0.1
/** the ride: low and wide over the board, sharp from the lens to the far edge, tightening onto the main chip as it arrives */
export const RIDE: Lens = { tilt: 78 * D, fov: 38 * D, aperture: 0 }
/** the course is planned for the RIDE lens; the camera flies it this much wider, so the board reads as a large place */
const RIDE_OPEN = 1.27
/** where the open lens lets a part cover the main chip, the ride flies its planning lens around those frames, else the widest of these that keeps it clear */
const OPEN_STEPS = [1.18]
/** the trace film's ride pays this much for an arrival, or a course start, that reads the board's silk upside down, and for an arrival that reads the main chip's marking upside down as the last frame turns it (sideways is free) */
const RIDE_READ = 20
/** a plain ride that misreads less than this, or loses sight of its light, keeps its course: the readable search would not pay for itself */
const READ_WORTH = 5
/** the lens opens to this aperture as the ride tightens, so the arrival holds the main chip against a soft board */
const ARRIVE_APERTURE = 0.2
/** the ride stops this many chip sizes off the main chip, which then spans this share of the frame's width */
const ARRIVE_OFF = 2.6
const ARRIVE_SPAN = 0.75
/** over this last share of the ride the lens tightens and the camera slows to this share of its speed */
const RIDE_TIGHTEN = 0.45
const RIDE_LAND = 0.12
/** the arrival's lens is at most this share of the travel lens */
const RIDE_TIGHT = 0.75
/** the least ground the ride covers, as a share of the board's longer side */
export const RIDE_REACH = 0.42
/** the ride starts within this angle of straight behind its arrival, so its heading turns little */
const RIDE_CONE = 35 * D
/** parts nearer the lens than what it looks at may cover at most this share of the ride's frame; the ride rises (up to RIDE_RISE times its flying height) until they do */
export const RIDE_WALL = 0.2
const RIDE_RISE = 3
/** the ride's lit copper within this many mm of where it looks, of which at least RIDE_SEEN frame widths should be in sight in every frame */
const RIDE_SIDE = 8
const RIDE_SEEN = 1
/** over the ride's first RIDE_CHECK frames, every second frame shows lit copper past the parts at least RIDE_LIT frame widths long, and no part nearer than the lens's target covers RIDE_COVER of the frame for more than RIDE_WALL_RUN frames; a ride that fails flies another arrival whose camera still travels RIDE_RUN of the board's longer side */
const RIDE_CHECK = 45
const RIDE_LIT = 0.2
const RIDE_COVER = 0.25
const RIDE_WALL_RUN = 4
const RIDE_RUN = 1 / 3
/** how a ride that fails may fly instead: skip this share of its course, look along it toward where it stands or toward the main chip, and start its light a look ahead */
const RIDE_VARIANTS: Array<[number, 'stand' | 'hero', boolean]> = [[0, 'stand', false], [0, 'hero', false], [0.15, 'stand', false], [0.15, 'hero', false], [0, 'stand', true], [0, 'hero', true], [0.15, 'stand', true], [0.15, 'hero', true]]
/** the poster's revision is never set smaller than this share of the frame's short side, in a wide frame and in the others: the sizes a one-line name gives it, where it reads at 390 px */
export const REV_LEAST = { wide: 0.0462, other: 0.026 }
/** on the coat take and the parts take the board covers at least this share of the frame's height (the least frames of the working films, Glasgow 4:5: 59% and 52.5%), the camera moving in where it covers less; the main chip stays within TAKE_CHIP of the frame's half width, on the coat take and on the parts take (the working parts takes reach 0.95) */
export const TAKE_TALL = { sheen: 0.54, stage: 0.52 }
const TAKE_CHIP = { sheen: 0.7, stage: 0.95 }

/** on the close-up's first frame the hero's marking runs within this of level on screen (the films that read: 0 to 6 degrees; iCEBreaker 16:9 and 1:1 of round 9: 45 to 58) */
export const MARK_LEVEL = 10 * D
/** over the close-up no other drawn body hides any of the marking's cell, and at most this share of the lid (the working dev kit 16:9: 4.0% on this grid) */
export const LID_COVER = 0.04
/** the close-up may look this much more steeply where no turn alone clears the marking: a pin in front then stands shorter than the lid's near edge */
const CLOSE_STEEPER = 24 * D

/** in the breath, bodies nearer the lens than the main chip cover at most this share of the frame's lower third (the working films: 52 to 60%; Glasgow 9:16 77%, the dev kit 4:5 82 to 86%) */
export const BREATH_MOST = 0.65

/** the share of the frame's lower third covered by bodies whose centre stands nearer the lens than the main chip's */
export function breathCover(cam: ReturnType<typeof makeCam>, hero: Body, bodies: Body[], W: number, H: number): number {
  const depth = (hero.x - cam.pos[0]) * cam.f[0] + (-hero.y - cam.pos[1]) * cam.f[1] + ((hero.base ?? 0) + hero.z / 2 - cam.pos[2]) * cam.f[2]
  return nearShare(cam, W, H, bodies, depth, 40, [-1, -1 / 3])
}

/** the screen angle, in radians, of a reading direction on a body's top: 0 runs level left to right, a quarter turn runs down the frame */
export function markLevel(cam: ReturnType<typeof makeCam>, b: Body, dir: Vec2, W: number, H: number): number {
  const z = (b.base ?? 0) + b.z
  const step = Math.min(b.w, b.h) / 4
  const a = project(cam, b.x, b.y, z)
  const e = project(cam, b.x + dir.x * step, b.y + dir.y * step, z)
  return Math.abs(Math.atan2(-(e.y - a.y) * H, (e.x - a.x) * W))
}

/** on the held poster, bodies whose centre stands nearer than this share of the main chip's depth are the out-of-focus foreground; they may cover at most FENCE_MOST of the frame (the working posters: 2.2%, 11.1% and 15.7%) */
export const FENCE_DEPTH = 0.75
export const FENCE_MOST = 0.17
/** the name's first mark comes at most this long before the poster stops; from there to the last frame no body nearer the lens than the main chip may cross it */
export const NAME_EARLY = 24 / 360
/** the most a low shot rises (tilt from the vertical) to keep its lens out of a part */
const LOW_LEAST = 68 * D
/** the poster's lens, straight down */
const POSTER_FOV = 16 * D
/** the top-down take opens this many times nearer than the poster */
const TOP_PUSH = 3.2
/** the top-down take starts turned this far from the poster and keeps a little of it */
const TOP_TURN = [9 * D, 3 * D] as const
/** the pull back runs at one speed for this share of its time and covers this share of its scale, then settles */
const PULL_RUN = 0.5
const PULL_REACH = 0.9
/** a board wider than tall lies landscape in a wide frame's poster and fills at least this share of its height */
export const WIDE_POSTER = 0.6
/** the widths a wide poster's title column may take, as a share of the frame's width */
const COLUMNS = [0.22, 0.26, 0.31]
/** the name builds only where the board's silhouette keeps this share of the frame's height clear of it */
const TITLE_CLEAR = 0.015
/** the pull back settles on the poster here and the film holds from then on */
const HOLD_FROM = 20.5 * B
/** the name may start building this long after the pull back starts to settle, once the board stays clear of it */
const NAME_LEAD = 0
/** the shortest the pull back to the poster may become so the name can be read */
const PULL_LEAST = 2 * B

/** the trace film's own takes (style 'trace'): the copper drawn under a low ring, sharp from front to back, the whole board seen once under its coat, and an ending low on the main chip */
const FRONT = { tilt: 65 * D, aperture: 0.01, shift: 0.28 }
/** the coat take's lens: low three-quarter, wide enough to hold the whole outline */
const WHOLE: Lens = { tilt: 62 * D, fov: 30 * D, aperture: 0.08 }
const WHOLE_TURN = 32 * D
/** the coat take looks down from the highest tilt, no steeper than the film's 60° (54° in a tall frame), where the board's long side lies along the frame's and its outline covers this share of the frame; it fits the board this close and pushes in this far */
export const COAT_SHARE = 0.45
const COAT_FIT = [0.97, 0.96] as const
const COAT_PUSH = 1.02
/** under its coat the whole board spans at least this share of the frame along the side that binds: the lens comes down through these heights (tilt from the vertical) until it does */
/** a tall frame looks this much further down on the whole board, so the board is not a sliver in it */
const WHOLE_TALL = 8 * D
/** the last frame: low on the main chip (14° above the board), the chip this much wider than the place take holds it */
const HERO: Lens = { tilt: 76 * D, fov: 22 * D, aperture: 0.2 }
const HERO_WIDER = 0.1
/** how far off the marking's square-on view the last frame stands */
const HERO_OFF = [-36, -24, -14, 14, 24, 36].map((d) => d * D)
/** where the chip's top edge sits in the last frame (NDC y), under the name */
const HERO_TOP = 0.02
/** and how far below the middle its nearest corner may reach (NDC y); a tall part is held smaller to fit between them */
const HERO_FLOOR = 0.9
/** the camera settles into the last frame by this beat */
const HERO_FROM = 20 * B
/** the held frame pushes in this far, then holds its last frames still */
const HERO_PUSH = 1.018
/** the last frames hold still */
const STILL = 10
/** the poster's name spans at least this share of the frame's width, and its top stays this share of the frame's height below the frame's top */
const NAME_HALF = 0.5
/** the poster's name stands in at most this many lines */
const NAME_LINES = 2
const NAME_CROSS = 0.35
const NAME_TOP = 0.05
/** the poster's heading pays this much for each pin, chip passive, crystal or LED that stands in the band the name takes */
const NAME_BAND = 3
const LID_CROSSED = 2 * B
const WHOLE_LOOK = 2 * B
const WHOLE_LOOK_FROM = 2.4
const HERO_IN = 1.14
const HERO_SWING = 7 * D
/** heavy caps: cap height, mean advance, the revision's advance in its own size, the line step and the revision's size, as shares of the type size */
const GROTESK = { cap: 0.7, advance: 0.86, small: 0.74, lead: 0.9, rev: 0.26 }

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const onBeat = (t: number): number => Math.round(t * 24) / 24

/** the trace film's parts take in three positions, when the main chip seats on a beat at least three beats and a half after the silk: the crane from the crowd to the wide position, and the cut to the main chip's close */
/** each line of a grotesk name, and its revision after the last line, as a screen box in px */
export function letterBoxes(L: TraceLockup): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  const revW = L.version === undefined ? 0 : 0.22 * L.size + L.version.text.length * GROTESK.small * L.version.size
  return L.lines.map((line, k) => {
    const w = line.text.length * GROTESK.advance * L.size + (k === L.lines.length - 1 ? revW : 0)
    return { x0: line.x - w / 2, x1: line.x + w / 2, y0: line.y - GROTESK.cap * L.size, y1: line.y }
  })
}

/** whether any part, seen through the last frame's lens, stands across a letter of the name or its revision: it overlaps the letter and stands at least NAME_CROSS of a letter's height on screen */
export function nameCrossed(L: TraceLockup, cam: ReturnType<typeof makeCam>, parts: Body[], W: number, H: number): boolean {
  const boxes = letterBoxes(L)
  const tall = NAME_CROSS * ((boxes[0]?.y1 ?? 0) - (boxes[0]?.y0 ?? 0))
  const c = (b: Body): number => Math.cos(b.rot)
  const sn = (b: Body): number => Math.sin(b.rot)
  return parts.some((b) => {
    const pts = [0, 0.25, 0.5, 0.75, 1].flatMap((u) => [0, 0.25, 0.5, 0.75, 1].flatMap((v) => [b.base ?? 0, (b.base ?? 0) + b.z].map((z): [number, number, number] => [
      b.x + c(b) * (u - 0.5) * b.w - sn(b) * (v - 0.5) * b.h,
      b.y + sn(b) * (u - 0.5) * b.w + c(b) * (v - 0.5) * b.h,
      z
    ])))
    const qs = pts.map(([x, y, z]) => project(cam, x, y, z))
    if (qs.some((q) => q.w <= 0)) return false
    const sx = qs.map((q) => (q.x * 0.5 + 0.5) * W)
    const sy = qs.map((q) => (0.5 - q.y * 0.5) * H)
    if (Math.max(...sy) - Math.min(...sy) < tall) return false
    return sx.some((x, i) => boxes.some((r) => x > r.x0 && x < r.x1 && (sy[i] as number) > r.y0 && (sy[i] as number) < r.y1))
  })
}

/** the share of the frame the board's outline spans along the side that binds */
/** the share of the frame's width the main chip's top spans */
export function heroWidth(cam: ReturnType<typeof makeCam>, hero: Body): number {
  const xs = corners(hero).filter(([, , z]) => z > (hero.base ?? 0)).map(([x, y, z]) => project(cam, x, y, z).x)
  return (Math.max(...xs) - Math.min(...xs)) / 2
}

/** the mean share of the frame's height, across its width, that lies above the board's far edge */
export function skyAbove(cam: ReturnType<typeof makeCam>, loops: number[][]): number {
  const cols = Array.from({ length: 10 }, (_, i) => -0.9 + 0.2 * i)
  const segs = loops.flatMap((loop) => Array.from({ length: loop.length / 2 }, (_, i) => {
    const j = (i + 1) % (loop.length / 2)
    return [project(cam, loop[2 * i] as number, loop[2 * i + 1] as number, 0), project(cam, loop[2 * j] as number, loop[2 * j + 1] as number, 0)] as const
  })).filter(([a, b]) => a.w > 0 && b.w > 0)
  return cols.reduce((sum, x) => {
    const ys = segs.filter(([a, b]) => (a.x - x) * (b.x - x) <= 0 && a.x !== b.x).map(([a, b]) => a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y))
    return sum + (ys.length === 0 ? 1 : (1 - Math.min(1, Math.max(-1, Math.max(...ys)))) / 2)
  }, 0) / cols.length
}

/** the share of the frame the board's outline covers (even-odd over its loops), and its extent across and up the frame */
export function boardShare(cam: ReturnType<typeof makeCam>, loops: number[][]): { share: number; across: number; up: number } {
  const polys = loops.map((loop) => Array.from({ length: loop.length / 2 }, (_, i) => project(cam, loop[2 * i] as number, loop[2 * i + 1] as number, 0)))
  const N = 40
  let n = 0
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = (2 * i + 1) / N - 1
      const y = (2 * j + 1) / N - 1
      let inside = false
      for (const P of polys) {
        for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
          const pa = P[a] as { x: number; y: number }
          const pb = P[b] as { x: number; y: number }
          if (pa.y > y !== pb.y > y && x < ((pb.x - pa.x) * (y - pa.y)) / (pb.y - pa.y) + pa.x) inside = !inside
        }
      }
      if (inside) n++
    }
  }
  const all = polys.flat()
  return { share: n / (N * N), across: Math.max(...all.map((q) => q.x)) - Math.min(...all.map((q) => q.x)), up: Math.max(...all.map((q) => q.y)) - Math.min(...all.map((q) => q.y)) }
}

/** how many bright parts stand inside the band the poster's name takes */
export function paleInBand(cam: ReturnType<typeof makeCam>, pale: Array<{ x: number; y: number; z: number }>, H: number): number {
  const low = 1 - (2 * ((1 - (HERO_TOP + 0.16)) * (H / 2) - 0.07 * H)) / H
  return pale.filter((pt) => {
    const q = project(cam, pt.x, pt.y, pt.z)
    return q.w > 0 && Math.abs(q.x) < 0.74 && q.y > low && q.y < 1 - 2 * NAME_TOP
  }).length
}

/** whether a coat key lays the board's long side along the frame's long side: wider than tall on screen in a wide frame, the line of sight along the board's length in a tall one */
export function longAlong(yaw: number, b: { across: number; up: number }, loops: number[][], W: number, H: number): boolean {
  if (W === H) return true
  if (W > H) return b.across * W >= b.up * H
  const xs = loops.flatMap((l) => l.filter((_, i) => i % 2 === 0))
  const ys = loops.flatMap((l) => l.filter((_, i) => i % 2 === 1))
  const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)
  return Math.abs(wide ? Math.cos(yaw) : Math.sin(yaw)) <= Math.SQRT1_2
}

export function stageCuts(acts: TraceActs): { crane: [number, number]; close: number } | undefined {
  const lands = acts.place[1]
  const close = lands - B
  const wide = close - B
  return Math.abs(lands * 24 - Math.round(lands * 24)) < 1e-6 && wide - B / 2 >= onBeat(acts.silk[0]) + B - 1e-9 ? { crane: [wide - B / 2, wide], close } : undefined
}

/** where copper is arriving at phase t: the head of every front-side line being drawn (energy: being lit) */
export function heads(layers: TraceLayer[], t: number, energy: boolean): Vec2[] {
  const out: Vec2[] = []
  for (const l of layers) {
    if (l.side !== 'F') continue
    for (let o = 0, i = 0; o < l.segs.length; o += 7, i++) {
      const a = energy ? (l.energy[2 * i] as number) : (l.segs[o + 5] as number)
      const b = energy ? (l.energy[2 * i + 1] as number) : (l.segs[o + 6] as number)
      if (a < 0 && b < 0) continue
      if (t < Math.min(a, b) || t >= Math.max(a, b)) continue
      const f = (t - a) / (b - a)
      const x0 = l.segs[o] as number
      const y0 = l.segs[o + 1] as number
      out.push({ x: x0 + ((l.segs[o + 2] as number) - x0) * f, y: y0 + ((l.segs[o + 3] as number) - y0) * f })
    }
  }
  return out
}

/** the heading (yaw) whose screen-right runs along v, turned by `toward` so the move also runs away from the lens */
const headingAlong = (v: Vec2, toward = 0): number => Math.atan2(-v.y, v.x) - toward
const viewDir = (yaw: number): Vec2 => ({ x: -Math.sin(yaw), y: -Math.cos(yaw) })

/** the lens's plane position and height for a key */
function lensAt(k: Key, W: number, H: number): { x: number; y: number; z: number } {
  const cam = makeCam(k, W, H)
  return { x: cam.pos[0], y: -cam.pos[1], z: cam.pos[2] }
}

/** how far into a part's box the lens sits (0: clear); a part's box grows by a margin around and above it */
function inPart(lens: { x: number; y: number; z: number }, bodies: Body[], margin: number): number {
  let worst = 0
  for (const b of bodies) {
    if (lens.z > b.z + margin) continue
    const c = Math.cos(b.rot)
    const s = Math.sin(b.rot)
    const dx = lens.x - b.x
    const dy = lens.y - b.y
    const u = Math.abs(dx * c + dy * s) - b.w / 2
    const v = Math.abs(-dx * s + dy * c) - b.h / 2
    if (u < margin && v < margin) worst = Math.max(worst, b.z + margin - lens.z)
  }
  return worst
}

/** the key raised (less tilt) until its lens clears every part, never above LOW_LEAST */
function clearLens(k: Key, bodies: Body[], W: number, H: number, margin: number, front = Infinity): Key {
  let tilt = k.tilt
  const blocked = (q: Key): boolean => {
    if (inPart(lensAt(q, W, H), bodies, margin) > 0) return true
    if (front === Infinity) return false
    const cam = makeCam(q, W, H)
    return nearCover(cam, W, H, bodies, 0.85 * cam.dist) > front
  }
  while (tilt > LOW_LEAST && blocked({ ...k, tilt })) tilt -= 1 * D
  return { ...k, tilt }
}

/** the ride's course in plane px from where it starts to the main chip, the run along it at each point, where the light's front is along that run over time, and how wide its lit lane is */
export interface RideLight {
  course: Vec2[]
  runs: number[]
  front: Array<{ s: number; t: number }>
  /** how many times its flying height the ride is at each course point: the lit lane widens with it */
  spread: number[]
}

/**
 * The camera's way to `goal` low over the board: a least-cost path on a grid that keeps out of walls (tall parts),
 * costs more off the board and away from the lit copper it should follow, from a start whose run is at least
 * `reach` (the light's source when its run is long enough), smoothed, and straightened into `arrive` over its last stretch.
 */
/** the grid a ride's course is planned on: cells, which are walls, which lie on the board, how far each is from followed copper, how crowded it is */
function flyGrid(box: { x0: number; y0: number; x1: number; y1: number }, cell: number, wall: (q: Vec2) => boolean, onBoard: (q: Vec2) => boolean, follow: Vec2[], near: number) {
  const nx = Math.max(2, Math.ceil((box.x1 - box.x0) / cell) + 1)
  const ny = Math.max(2, Math.ceil((box.y1 - box.y0) / cell) + 1)
  const at = (i: number): Vec2 => ({ x: box.x0 + (i % nx) * cell, y: box.y0 + Math.floor(i / nx) * cell })
  const index = (q: Vec2): number => clamp(Math.round((q.y - box.y0) / cell), 0, ny - 1) * nx + clamp(Math.round((q.x - box.x0) / cell), 0, nx - 1)
  const n = nx * ny
  const apart = new Float64Array(n).fill(Infinity)
  for (const q of follow) apart[index(q)] = 0
  for (const [from, to, dir] of [[0, n, 1], [n - 1, -1, -1]] as const) {
    for (let i = from; i !== to; i += dir) {
      const x = i % nx
      for (const [dx, dy, c] of [[-1, 0, 1], [0, -1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2]] as const) {
        const ox = x + dx * dir
        const oy = Math.floor(i / nx) + dy * dir
        if (ox < 0 || oy < 0 || ox >= nx || oy >= ny) continue
        apart[i] = Math.min(apart[i] as number, (apart[oy * nx + ox] as number) + c * cell)
      }
    }
  }
  const toFollow = (q: Vec2): number => (follow.length === 0 ? 0 : (apart[index(q)] as number))
  const walled = new Uint8Array(n)
  for (let i = 0; i < n; i++) walled[i] = wall(at(i)) ? 1 : 0
  const crowd = (q: Vec2): number => {
    const cx = clamp(Math.round((q.x - box.x0) / cell), 0, nx - 1)
    const cy = clamp(Math.round((q.y - box.y0) / cell), 0, ny - 1)
    const r = Math.ceil((1.5 * near) / cell)
    let hit = 0
    let all = 0
    for (let dy = -r; dy <= r; dy += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue
        all++
        hit += walled[y * nx + x] as number
      }
    }
    return all === 0 ? 0 : hit / all
  }
  const board = new Float64Array(n)
  const followCost = new Float64Array(n)
  const crowdCost = new Float64Array(n)
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const follows = new Float64Array(n)
  const crowds = new Float64Array(n)
  const weights = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const q = at(i)
    xs[i] = q.x
    ys[i] = q.y
    follows[i] = toFollow(q)
    crowds[i] = crowd(q)
    board[i] = onBoard(q) ? 0 : 2
    followCost[i] = 2.5 * Math.min(1, (follows[i] as number) / near)
    crowdCost[i] = 3 * (crowds[i] as number)
    weights[i] = (walled[i] === 1 ? Infinity : 1) + (board[i] as number) + (followCost[i] as number) + (crowdCost[i] as number)
  }
  return { cell, nx, ny, n, at, index, walled, board, followCost, crowdCost, near, xs, ys, follows, crowds, weights }
}

function flyway(goal: Vec2, grid: ReturnType<typeof flyGrid>, onBoard: (q: Vec2) => boolean, reach: number, source: Vec2 | undefined, arrive: Vec2, straight: number): { pts: Vec2[]; tier: number } {
  const { cell, nx, ny, n, at, index, walled, board, followCost, crowdCost, near, xs, ys, follows, crowds } = grid
  const weight = grid.weights.slice()
  const g = index(goal)
  for (let y = Math.max(0, Math.floor(g / nx) - 3); y <= Math.min(ny - 1, Math.floor(g / nx) + 3); y++) {
    for (let x = Math.max(0, (g % nx) - 3); x <= Math.min(nx - 1, (g % nx) + 3); x++) {
      const i = y * nx + x
      if (walled[i] === 1 && Math.hypot((xs[i] as number) - goal.x, (ys[i] as number) - goal.y) <= 2 * cell) weight[i] = 1 + (board[i] as number) + (followCost[i] as number) + (crowdCost[i] as number)
    }
  }
  const cost = new Float64Array(n).fill(Infinity)
  const len = new Float64Array(n)
  const prev = new Int32Array(n).fill(-1)
  cost[g] = 0
  const heap: number[] = [g]
  const less = (a: number, b: number): boolean => (cost[a] as number) < (cost[b] as number)
  const push = (v: number): void => {
    heap.push(v)
    for (let i = heap.length - 1; i > 0;) {
      const up = (i - 1) >> 1
      if (!less(heap[i] as number, heap[up] as number)) break
      ;[heap[i], heap[up]] = [heap[up] as number, heap[i] as number]
      i = up
    }
  }
  const pop = (): number => {
    const top = heap[0] as number
    const last = heap.pop() as number
    if (heap.length > 0) {
      heap[0] = last
      for (let i = 0; ;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && less(heap[l] as number, heap[m] as number)) m = l
        if (r < heap.length && less(heap[r] as number, heap[m] as number)) m = r
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m] as number, heap[i] as number]
        i = m
      }
    }
    return top
  }
  const done = new Uint8Array(n)
  const steps = [Math.hypot(1, 1) * cell, Math.hypot(0, 1) * cell]
  while (heap.length > 0) {
    const v = pop()
    if (done[v] === 1) continue
    done[v] = 1
    const vx = v % nx
    const vy = Math.floor(v / nx)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = vx + dx
        const y = vy + dy
        if ((dx === 0 && dy === 0) || x < 0 || y < 0 || x >= nx || y >= ny) continue
        const o = y * nx + x
        const step = steps[dx !== 0 && dy !== 0 ? 0 : 1] as number
        const c = (cost[v] as number) + step * 0.5 * ((weight[v] as number) + (weight[o] as number))
        if (c < (cost[o] as number)) {
          cost[o] = c
          len[o] = (len[v] as number) + step
          prev[o] = v
          push(o)
        }
      }
    }
  }
  const facing = new Float64Array(n).fill(-Infinity)
  for (let i = 0; i < n; i++) {
    const qx = xs[i] as number
    const qy = ys[i] as number
    const d = Math.hypot(qx - goal.x, qy - goal.y)
    if (d > 0) facing[i] = -((qx - goal.x) * arrive.x + (qy - goal.y) * arrive.y) / d
  }
  const behind = (i: number, cone: number): boolean => (facing[i] as number) >= Math.cos(cone)
  const all = Array.from({ length: n }, (_, i) => i).filter((i) => Number.isFinite(cost[i] as number))
  const inside = all.filter((i) => board[i] === 0 && (follows[i] as number) <= near)
  let edge: number[] | undefined
  const edgeCells = (): number[] => {
    edge ??= all.filter((i) => {
      const qx = xs[i] as number
      const qy = ys[i] as number
      const d = Math.max(1e-6, Math.hypot(goal.x - qx, goal.y - qy))
      return onBoard({ x: qx + ((goal.x - qx) / d) * near, y: qy + ((goal.y - qy) / d) * near })
    })
    return edge
  }
  const cones = [[1, 1.5], [2, 2.5]].flatMap((widths) => [(): number[] => inside, edgeCells].flatMap((set) => widths.map((c) => (): number[] => set().filter((i) => behind(i, c * RIDE_CONE)))))
  let tier = -1
  let reached: number[] | undefined
  for (let k = 0; k < cones.length && reached === undefined; k++) {
    const cone = (cones[k] as () => number[])()
    if (cone.some((i) => (len[i] as number) >= reach)) {
      tier = k
      reached = cone
    }
  }
  reached ??= all.filter((i) => behind(i, RIDE_CONE))
  const from = source === undefined ? undefined : index(source)
  const score = (i: number): number => (cost[i] as number) / Math.max(1e-6, len[i] as number) + (2 * Math.min(1, (follows[i] as number) / near)) + 4 * (crowds[i] as number) + (source === undefined ? 0 : Math.hypot((xs[i] as number) - source.x, (ys[i] as number) - source.y) / (8 * reach))
  const start = from !== undefined && behind(from, RIDE_CONE) && (len[from] as number) >= reach && (len[from] as number) <= 2.5 * reach && Number.isFinite(cost[from])
    ? from
    : reached.filter((i) => (len[i] as number) >= reach && (len[i] as number) <= 2 * reach).sort((a, b) => score(a) - score(b))[0]
      ?? reached.filter((i) => (len[i] as number) >= 0.5 * reach).sort((a, b) => (len[b] as number) - (len[a] as number))[0] ?? g
  const raw: Vec2[] = []
  for (let v = start; v >= 0; v = prev[v] as number) raw.push(at(v))
  raw[raw.length - 1] = goal
  if (raw.length < 2) raw.unshift({ x: goal.x - arrive.x * reach, y: goal.y - arrive.y * reach })
  else if (start === g) raw.splice(0, raw.length - 1, { x: goal.x - arrive.x * reach, y: goal.y - arrive.y * reach })
  let pts = raw
  for (let pass = 0; pass < 4; pass++) pts = pts.map((q, i) => {
    if (i === 0 || i === pts.length - 1) return q
    const lo = Math.max(0, i - 4)
    const hi = Math.min(pts.length - 1, i + 4)
    let sx = 0
    let sy = 0
    for (let j = lo; j <= hi; j++) {
      sx += (pts[j] as Vec2).x
      sy += (pts[j] as Vec2).y
    }
    return { x: sx / (hi - lo + 1), y: sy / (hi - lo + 1) }
  })
  const runs = [0]
  for (let i = 1; i < pts.length; i++) runs.push((runs[i - 1] as number) + Math.hypot((pts[i] as Vec2).x - (pts[i - 1] as Vec2).x, (pts[i] as Vec2).y - (pts[i - 1] as Vec2).y))
  const total = runs.at(-1) as number
  const span = Math.min(0.35 * total, straight)
  return {
    pts: pts.map((q, i) => {
      const left = total - (runs[i] as number)
      const w = span <= 0 ? 0 : clamp(1 - left / span, 0, 1)
      const e = w * w * (3 - 2 * w)
      return { x: q.x + (goal.x - arrive.x * left - q.x) * e, y: q.y + (goal.y - arrive.y * left - q.y) * e }
    }),
    tier: tier < 0 ? cones.length : tier
  }
}

/**
 * Five takes, cut on beats; the whole board is seen once, at the end, straight down.
 *  1 spark  — black; copper draws itself out of the opening part, seen along the surface on a long lens, the lens
 *             trucking with the growth front
 *  2 coat   — lower, wider: the wet mask crosses toward the lens
 *  3 place  — a skyline across the main chip's lands: parts fall in and land, the chip last; then the breath
 *  4 ride   — power: low and fast along the real supply copper into the main chip as it wakes
 *  5 poster — a hard cut to straight down on the chip's quarter, already pulling back to the whole board, held
 */
type Solved = { shots: CameraShot[]; lockup: TraceLockup | undefined; turnYaw: number; hold: number | undefined; ride: RideLight }
/** the last few boards and aspects solved: the same inputs solve to the same shots, and the studio and the tests compile one board many times */
const solved = new Map<string, Solved>()
const SOLVED_KEEP = 8

export function cineShots(resolved: ResolvedConfig, si: ShotInput, layers: TraceLayer[]): Solved {
  const groups = [...new Set(layers.flatMap((l) => l.groups))].sort((a, b) => a - b)
  const key = JSON.stringify([resolved, { ...si, chase: [...si.chase].sort((a, b) => a - b), rideSide: groups.map((g) => [g, si.rideSide(g)]) }, layers])
  const hit = solved.get(key)
  if (hit !== undefined) {
    solved.delete(key)
    solved.set(key, hit)
    return structuredClone(hit)
  }
  const out = solveShots(resolved, si, layers)
  solved.set(key, structuredClone(out))
  if (solved.size > SOLVED_KEEP) solved.delete(solved.keys().next().value as string)
  return out
}

/** what the trace film's readable ride shares with the plain solve it is measured against: the grid, the arrivals, the courses, the flights, their sight counts and the ride it chose */
type Reuse = { grid?: ReturnType<typeof flyGrid>; ride?: { o: object; f: object }; arrivals: Map<number, Array<{ yaw: number; tilt: number; cost: number; lens: { fov: number; off: number } }>>; ways: Map<string, { pts: Vec2[]; tier: number }>; flights: Map<string, object>; sight: WeakMap<object, { dark: number; limit: number }> }

function solveShots(resolved: ResolvedConfig, si: ShotInput, layers: TraceLayer[], reuse: Reuse = { arrivals: new Map(), ways: new Map(), flights: new Map(), sight: new WeakMap() }): Solved {
  const W = resolved.width
  const H = resolved.height
  const short = Math.min(W, H)
  const tall = H / W
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const loop of si.loops) {
    for (let i = 0; i + 1 < loop.length; i += 2) {
      x0 = Math.min(x0, loop[i] as number)
      x1 = Math.max(x1, loop[i] as number)
      y0 = Math.min(y0, loop[i + 1] as number)
      y1 = Math.max(y1, loop[i + 1] as number)
    }
  }
  const mid = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
  const hero = si.hero
  const heroSize = Math.max(si.heroSize, 0.02 * Math.max(x1 - x0, y1 - y0))
  const margin = 1.5 * si.mm
  const toward = clamp((tall - 0.8) * 30, 0, 20) * D
  const acts = si.acts
  const film = resolved.style === 'trace'

  const tCoat = Math.max(2 * B, Math.floor(acts.mask[0] * 24 + 1e-6) / 24)
  const tPlace = onBeat(acts.silk[0])
  const tRide = onBeat(acts.power[0])
  const wake = si.powerAt ?? tRide + 3 * B
  const tTop = Math.max(tRide + 3 * B, Math.ceil((wake + 0.5 * B) * 24 - 1e-6) / 24)
  const silk = si.marks.length > (si.heroMark === undefined ? 0 : 1) ? si.marks.at(-1) : undefined
  const upright = (yaw: number): number => (silk === undefined ? 1 : Math.cos(silk + yaw))
  const plain = film && si.readSilk ? solveShots(resolved, { ...si, readSilk: false }, layers, reuse) : undefined
  if (plain !== undefined && plain.shots.every((k) => k.t < tRide || k.t >= tTop || (upright(k.yaw) >= 0 && Math.cos(k.yaw - plain.turnYaw) >= 0))) return plain
  const ending = plain?.turnYaw
  const standAt = (yaw: number, off: number): Vec2 => ({ x: hero.x - viewDir(yaw).x * off, y: hero.y - viewDir(yaw).y * off })
  const unread = (yaw: number): number => (ending === undefined ? 0 : RIDE_READ * (Math.max(0, -upright(yaw)) + Math.max(0, -Math.cos(yaw - ending))))
  const misread = (o: Option): number => {
    const from = o.way.pts[0]
    const to = standAt(o.a.yaw, o.a.lens.off)
    return from === undefined || ending === undefined ? 0 : RIDE_READ * Math.max(0, -upright(Math.atan2(-(to.x - from.x), -(to.y - from.y)))) + unread(o.a.yaw)
  }
  const plainRide = reuse.ride as { o: Option; f: Flight } | undefined
  if (plain !== undefined && plainRide !== undefined && ((reuse.sight.get(plainRide.f)?.dark ?? 0) > 0 || misread(plainRide.o) < READ_WORTH)) return plain

  const open = si.openFrom ?? hero
  const zSpark = short / (0.8 * Math.max(si.openSpan, 1.4 * heroSize))
  const half = short / (2 * zSpark)
  const times = Array.from({ length: 13 }, (_, i) => (tCoat * i) / 12)
  const fronts = times.map((t) => heads(layers, t, false))
  const pull = { x: 0, y: 0 }
  for (const l of layers) {
    if (l.side !== 'F') continue
    for (let o = 0; o < l.segs.length; o += 7) {
      if ((l.segs[o + 5] as number) >= tCoat) continue
      const mx = ((l.segs[o] as number) + (l.segs[o + 2] as number)) / 2 - open.x
      const my = ((l.segs[o + 1] as number) + (l.segs[o + 3] as number)) / 2 - open.y
      const d = Math.hypot(mx, my)
      if (d < 1e-6 || d > 6 * half) continue
      const w = Math.hypot((l.segs[o + 2] as number) - (l.segs[o] as number), (l.segs[o + 3] as number) - (l.segs[o + 1] as number)) * (d / half)
      pull.x += (mx / d) * w
      pull.y += (my / d) * w
    }
  }
  const pl = Math.hypot(pull.x, pull.y)
  const v = pl < 1e-6 ? { x: 1, y: 0 } : { x: pull.x / pl, y: pull.y / pl }
  const reach = fronts.map((hs) => {
    const along = hs.filter((h) => Math.abs(-(h.x - open.x) * v.y + (h.y - open.y) * v.x) <= 0.7 * half).map((h) => (h.x - open.x) * v.x + (h.y - open.y) * v.y).filter((a) => a >= 0).sort((p, q) => p - q)
    return along.length === 0 ? 0 : (along[Math.floor(0.85 * (along.length - 1))] as number)
  })
  const yawSpark = headingAlong(v, toward)
  const travel = reach.map((r, i) => {
    const tau = (times[i] as number) / tCoat
    return clamp(r - 0.2 * half, 0.15 * half + 1.6 * half * tau, 0.15 * half + 4 * half * tau)
  })
  for (let i = 1; i < travel.length; i++) travel[i] = Math.max(travel[i] as number, (travel[i - 1] as number) + (0.7 * half) / 12)
  const spark: CameraShot[] = [0, 4, 8, 12].map((i) => {
    const s = travel[i] as number
    const at = { x: open.x + v.x * s, y: open.y + v.y * s }
    const front = { x: open.x + v.x * Math.max(s, reach[i] as number), y: open.y + v.y * Math.max(s, reach[i] as number) }
    return { t: times[i] as number, ...at, zoom: zSpark * (1 + 0.6 * clamp((tall - 0.9) / 0.9, 0, 1)) * (1 + 0.15 * (i / 12)), yaw: yawSpark + 5 * D * (i / 12), ...SPARK, focus: at, shift: -0.1, ...(film ? { ...FRONT, focus: { x: (at.x + front.x) / 2, y: (at.y + front.y) / 2 } } : {}), ...(i === 0 ? { light: 'spark' as const } : {}) }
  })
  spark[spark.length - 1] = { ...(spark.at(-1) as CameraShot), t: tCoat - 1e-4 }

  const towardMid = { x: mid.x - hero.x, y: mid.y - hero.y }
  const tl = Math.hypot(towardMid.x, towardMid.y)
  const md = tl > 0.05 * (y1 - y0) ? { x: towardMid.x / tl, y: towardMid.y / tl } : { x: 1, y: 0 }
  const along = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => ((x as number) - hero.x) * md.x + ((y as number) - hero.y) * md.y)
  const lo = Math.min(...along)
  const hi = Math.max(...along)
  const u = clamp((tCoat + 0.7 * (tPlace - tCoat) - acts.mask[0]) / Math.max(1e-6, acts.mask[1] - acts.mask[0]), 0, 1)
  const front = lo + (u * u * (3 - 2 * u)) * (hi - lo)
  const coatAt = { x: hero.x + md.x * front, y: hero.y + md.y * front }
  const yawCoat = Math.atan2(md.x, md.y)
  const zCoat = 0.8 * zSpark
  const rimPts = si.loops.flatMap((loop) => Array.from({ length: loop.length / 2 }, (_, i): [number, number, number] => [loop[2 * i] as number, loop[2 * i + 1] as number, 0]))
  const wholeKey = (yaw: number, tilt = WHOLE.tilt - WHOLE_TALL * clamp((H / W - 1) / 0.78, 0, 1), fit: readonly [number, number] = [0.92, 0.84]): Key => {
    let k: Key = { ...mid, zoom: 1, yaw, ...WHOLE, tilt, focus: mid, shift: 0 }
    for (let i = 0; i < 3; i++) {
      k = { ...k, ...centreOn(k, rimPts, W, H) }
      k = { ...k, zoom: fitZoom(k, rimPts, W, H, fit[0], fit[1], 0.05, 40) }
    }
    return k
  }
  const fill = (k: Key): number => k.zoom * (1 - 0.03 * Math.abs(wrap(k.yaw - yawCoat)))
  const coatKey = (): Key => {
    const yaws = Array.from({ length: 24 }, (_, i) => yawCoat + i * 15 * D)
    const top = WHOLE.tilt - WHOLE_TALL * clamp((H / W - 1) / 0.78, 0, 1)
    const floor = (H > W ? 54 : 60) * D
    const tilts = [...Array.from({ length: Math.max(0, Math.ceil((top - floor) / D - 1e-9)) }, (_, i) => top - i * D), floor]
    const at = (tilt: number) => yaws.map((yaw) => wholeKey(yaw, tilt, COAT_FIT)).map((k) => ({ k, b: boardShare(makeCam(k, W, H), si.loops) })).filter(({ k, b }) => longAlong(k.yaw, b, si.loops, W, H))
    for (const tilt of tilts) {
      const pick = at(tilt).filter(({ b }) => b.share >= COAT_SHARE).sort((p, q) => q.b.share - p.b.share || Math.abs(wrap(p.k.yaw - yawCoat)) - Math.abs(wrap(q.k.yaw - yawCoat)))[0]
      if (pick !== undefined) return pick.k
    }
    return at(floor).sort((p, q) => q.b.share - p.b.share)[0]?.k ?? wholeKey(yawCoat, floor, COAT_FIT)
  }
  const board = film && si.own ? coatKey() : ([0, 1, 2, 3].flatMap((q) => [-WHOLE_TURN, WHOLE_TURN].map((off) => wholeKey((Math.round(yawCoat / (Math.PI / 2)) + q) * (Math.PI / 2) + off))).sort((p, q) => fill(q) - fill(p))[0] as Key)
  const coat: CameraShot[] = film
    ? [
        { t: tCoat, ...board, light: 'sheen', cut: true, ease: 'linear' },
        { t: tPlace - 1e-4, ...board, zoom: board.zoom * (si.own ? COAT_PUSH : 1.07), yaw: board.yaw + 3 * D * Math.sign(wrap(board.yaw - yawCoat) || 1) }
      ]
    : [
        { t: tCoat, ...coatAt, zoom: zCoat, yaw: yawCoat, ...COAT, focus: coatAt, shift: -0.15, light: 'coat', cut: true, ease: 'linear' },
        { t: tPlace - 1e-4, ...coatAt, zoom: zCoat * 1.08, yaw: yawCoat + 4 * D, ...COAT, focus: coatAt, shift: -0.15 }
      ]

  const heroFrac = W >= H ? 0.28 + 0.14 * clamp((16 / 9 - W / H) / (7 / 9), 0, 1) : 0.5
  const zPlace = (heroFrac * W) / heroSize
  const placeShift = W >= H ? -0.18 : 0.1
  const tallest = Math.max(1e-6, si.tallest)
  const placeTilt = PLACE.tilt - 8 * D * clamp((tall - 1) / 0.78, 0, 1)
  const placeKey = (yaw: number, zoom: number): Key => ({ x: hero.x, y: hero.y, zoom, yaw, ...PLACE, tilt: placeTilt, focus: hero, shift: placeShift })
  const skyline = (k: Key): number => {
    const cam = makeCam(k, W, H)
    const heroDepth = (hero.x - cam.pos[0]) * cam.f[0] + (-hero.y - cam.pos[1]) * cam.f[1] - cam.pos[2] * cam.f[2]
    let sum = 0
    for (const [bx, by, bz] of si.bodies) {
      if (bz < 0.3 * tallest) continue
      const depth = (bx - cam.pos[0]) * cam.f[0] + (-by - cam.pos[1]) * cam.f[1] + (bz / 2 - cam.pos[2]) * cam.f[2]
      const q = project(cam, bx, by, bz)
      if (q.w <= 0 || Math.abs(q.x) > 1 || Math.abs(q.y) > 1) continue
      sum += (depth > heroDepth ? 1 : -0.5) * (bz / tallest)
    }
    return sum
  }
  const placeScore = (yaw: number): number => {
    const k = placeKey(yaw, zPlace)
    const cam = makeCam(k, W, H)
    const occ = heroOcclusion(cam, W, H, si.heroBox, si.blockers, si.heroReach)
    const lens = inPart(lensAt(k, W, H), si.blockers, margin) > 0 ? 1 : 0
    const reads = si.heroMark === undefined ? 0 : Math.abs(Math.cos(si.heroMark + yaw))
    return skyline(k) - 40 * occ.covered - 2 * Math.max(0, occ.larger - 1.5) - 50 * lens + 0.5 * reads
  }
  const yawPlace = Array.from({ length: 36 }, (_, i) => i * 10 * D).map((y) => ({ y, s: placeScore(y) })).sort((p, q) => q.s - p.s)[0]?.y ?? 0
  const heroLands = acts.place[1]
  const cuts = film && si.own ? stageCuts(acts) : undefined
  const wideAt = cuts?.crane[1] ?? heroLands
  const aloneAt = cuts?.close ?? heroLands
  const near = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
  const small = si.solids.filter((pt) => pt.hero !== true && Math.max(pt.w, pt.h) < STAGE_SMALL * heroSize && pt.t >= tPlace && pt.t < wideAt)
  const crowdAt = small.map((a) => ({ a, n: small.filter((b) => near(a, b) < heroSize).length / (1 + near(a, hero) / (2 * heroSize)) })).sort((p, q) => q.n - p.n)[0]?.a
  const run = crowdAt === undefined ? [] : small.filter((b) => near(crowdAt, b) < heroSize)
  const runAt = run.length === 0 ? hero : { x: (hero.x + run.reduce((a, b) => a + b.x, 0) / run.length) / 2, y: (hero.y + run.reduce((a, b) => a + b.y, 0) / run.length) / 2 }
  const crowdKey = (yaw: number, zoom: number): Key => ({ ...placeKey(yaw, zoom), x: runAt.x, y: runAt.y, focus: runAt })
  const landsWide = si.solids.filter((pt) => pt.hero !== true && pt.t >= wideAt && pt.t < heroLands)
  const widePts = [...landsWide, si.heroBox].map((pt): [number, number, number] => [pt.x, pt.y, pt.z])
  const wideKey = (yaw: number): Key => {
    let k: Key = { ...placeKey(yaw, zPlace), ...WIDE, focus: hero }
    k = { ...k, ...centreOn(k, widePts, W, H) }
    return { ...k, zoom: clamp(fitZoom(k, widePts, W, H, 0.8, 0.7, 0.05, 40), zPlace / WIDE_OUT[1], zPlace / WIDE_OUT[0]) }
  }
  const wide = wideKey(yawPlace)
  const outline = si.loops.flatMap((loop) => loop.flatMap((v, i) => (i % 2 === 0 ? [[v, loop[i + 1] as number] as [number, number]] : [])))
  const whole = (k: Key): boolean => {
    const cam = makeCam(k, W, H)
    return outline.every(([x, y]) => {
      const q = project(cam, x, y, 0)
      return q.w > 0 && Math.abs(q.x) <= 1.15 && Math.abs(q.y) <= 1.15
    })
  }
  const withhold = <T extends Key>(k: T): T => {
    let zoom = k.zoom
    for (let i = 0; i < 60 && whole({ ...k, zoom }); i++) zoom *= 1.12
    return { ...k, zoom }
  }
  const hb = si.heroBox
  const heroCorners = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [0, Math.min(hb.z, Math.max(hb.w, hb.h))].map((z): [number, number, number] => [
    hb.x + (Math.cos(hb.rot) * sx * hb.w) / 2 - (Math.sin(hb.rot) * sy * hb.h) / 2,
    hb.y + (Math.sin(hb.rot) * sx * hb.w) / 2 + (Math.cos(hb.rot) * sy * hb.h) / 2,
    z
  ])))
  const heroWithin = <T extends Key>(k: T, inside: number): T => {
    let zoom = k.zoom
    const out = (z: number): boolean => {
      const cam = makeCam({ ...k, zoom: z }, W, H)
      return heroCorners.some(([x, y, z0]) => {
        const q = project(cam, x, y, z0)
        return q.w <= 0 || Math.max(Math.abs(q.x), Math.abs(q.y)) > inside
      })
    }
    for (let i = 0; i < 40 && out(zoom); i++) zoom /= 1.05
    return { ...k, zoom }
  }
  const keepHero = <T extends Key>(k: T): T => heroWithin(k, 0.95)
  const aloneKey = (zoom: number, drift: number): Key => {
    const base = placeKey(yawPlace - 2 * D, zoom)
    const turns = Array.from({ length: 36 }, (_, i) => (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 10 * D)
    const holds = (k: Key): boolean => {
      const cam = makeCam(k, W, H)
      const inFrame = corners(si.heroBox).every(([x, y, z]) => { const q = project(cam, x, y, z); return q.w > 0 && Math.abs(q.x) < 0.95 && Math.abs(q.y) < 0.95 })
      return inFrame && heroWidth(cam, si.heroBox) >= ALONE_WIDTH && !heroCrossed(cam, si.heroBox, si.blockers) && skyAbove(cam, si.loops) <= ALONE_SKY && inPart(lensAt(k, W, H), si.blockers, margin) === 0
    }
    let least: { k: Key; c: number } | undefined
    let first = true
    for (const drop of ALONE_DROP.filter((d) => base.tilt - d >= (H > W ? 54 : 60) * D - 1e-9)) {
      for (const wide of ALONE_SIZES) {
        for (const turn of turns) {
          const k0 = { ...base, yaw: base.yaw + turn, tilt: base.tilt - drop }
          const k = { ...k0, zoom: zoom * Math.max(1, wide / heroWidth(makeCam(k0, W, H), si.heroBox)) }
          if (!holds(k) || !holds(aloneEnd(k, drift))) continue
          const shown = [k, aloneEnd(k, drift)].map((q) => makeCam(keepHero(withhold(keepHero(clearLens(q, si.blockers, W, H, margin, cuts !== undefined ? STAGE_FRONT : Infinity)))), W, H))
          const c = Math.max(...shown.map((cam) => breathCover(cam, si.heroBox, si.blockers, W, H)))
          if (first && c <= BREATH_MOST) return k
          first = false
          if (cuts !== undefined && nearCover(shown[0] as ReturnType<typeof makeCam>, W, H, si.solids.filter((pt) => pt.hero !== true), 0.85 * (shown[0] as ReturnType<typeof makeCam>).dist) > STAGE_FRONT) continue
          if (c <= BREATH_MOST) return k
          if (least === undefined || c < least.c) least = { k, c }
        }
      }
    }
    return least?.k ?? base
  }
  const aloneEnd = (k: Key, drift: number): Key => ({ ...k, yaw: k.yaw - D, zoom: k.zoom * drift })
  const alone = film && si.own ? (cuts !== undefined ? aloneKey(zPlace * ALONE_IN, 1.04) : aloneKey(zPlace, 1.03)) : undefined
  const place: CameraShot[] = cuts !== undefined
    ? [
        { t: tPlace, ...clearLens(crowdKey(yawPlace + 4 * D, zPlace), si.blockers, W, H, margin, STAGE_FRONT), light: 'stage', cut: true, ease: 'linear' },
        { t: cuts.crane[0], ...clearLens(crowdKey(yawPlace + 1 * D, zPlace * 0.96), si.blockers, W, H, margin, STAGE_FRONT) },
        { t: wideAt, ...clearLens(wide, si.blockers, W, H, margin, STAGE_FRONT), ease: 'linear' },
        { t: aloneAt - 1e-4, ...clearLens({ ...wide, yaw: wide.yaw - 3 * D, zoom: wide.zoom * 1.05 }, si.blockers, W, H, margin, STAGE_FRONT) },
        { t: aloneAt, ...clearLens(alone ?? placeKey(yawPlace - 2 * D, zPlace * ALONE_IN), si.blockers, W, H, margin, STAGE_FRONT), light: 'alone', cut: true, ease: 'linear' },
        { t: heroLands, ...clearLens(alone === undefined ? placeKey(yawPlace - 3 * D, zPlace * ALONE_IN * 1.04) : aloneEnd(alone, 1.04), si.blockers, W, H, margin, STAGE_FRONT) },
        { t: tRide - 1e-4, ...clearLens(alone === undefined ? placeKey(yawPlace - 3 * D, zPlace * ALONE_IN * 1.04) : aloneEnd(alone, 1.04), si.blockers, W, H, margin, STAGE_FRONT) }
      ]
    : [
        { t: tPlace, ...clearLens(placeKey(yawPlace + 4 * D, zPlace / 1.22), si.blockers, W, H, margin), light: film && si.own ? 'stage' : 'skyline', cut: true, ease: 'linear' },
        { t: heroLands - HERO_ALONE, ...clearLens(alone ?? placeKey(yawPlace - 2 * D, zPlace), si.blockers, W, H, margin), light: film && si.own ? 'alone' : 'rim', ease: 'linear' },
        { t: tRide - 1e-4, ...clearLens(alone === undefined ? placeKey(yawPlace - 3 * D, zPlace * 1.03) : aloneEnd(alone, 1.03), si.blockers, W, H, margin) }
      ]

  const path = si.supply
  const longSide = Math.max(x1 - x0, y1 - y0)
  const onBoard = (q: Vec2): boolean => {
    let inside = false
    for (const loop of si.loops) {
      for (let i = 0, j = loop.length - 2; i + 1 < loop.length; j = i, i += 2) {
        const ax = loop[i] as number
        const ay = loop[i + 1] as number
        const bx = loop[j] as number
        const by = loop[j + 1] as number
        if (ay > q.y !== by > q.y && q.x < ((bx - ax) * (q.y - ay)) / (by - ay) + ax) inside = !inside
      }
    }
    return inside
  }
  const lowParts = si.blockers.map((b) => b.z).sort((a, b) => a - b)
  const hFly = clamp(2.5 * (lowParts[Math.floor(0.75 * (lowParts.length - 1))] ?? si.mm), 1.8 * si.mm, 3.5 * si.mm)
  const walls = si.blockers.flatMap((b) => {
    const pad = b.z >= 0.7 * hFly ? 0.6 * hFly + 0.5 * si.mm : b.z >= 0.2 * hFly && Math.max(b.w, b.h) >= 2.5 * hFly ? 0.3 * hFly : -1
    return pad < 0 ? [] : [{ ...b, w: b.w + 2 * pad, h: b.h + 2 * pad }]
  })
  const wallTurns = walls.map((b) => [Math.cos(b.rot), Math.sin(b.rot), Math.hypot(b.w, b.h) / 2] as const)
  const inWall = (q: Vec2): boolean => walls.some((b, i) => {
    const [c, s, r] = wallTurns[i] as readonly [number, number, number]
    if (Math.abs(q.x - b.x) > r || Math.abs(q.y - b.y) > r) return false
    const dx = q.x - b.x
    const dy = q.y - b.y
    return Math.abs(dx * c + dy * s) <= b.w / 2 && Math.abs(-dx * s + dy * c) <= b.h / 2
  })
  const lens = (fov: number): number => Math.min(40 * D, 2 * Math.atan(Math.tan(fov / 2) * Math.max(1, tall) ** 0.4))
  const fovTravel = lens(RIDE.fov)
  const span = ARRIVE_SPAN + 0.1 * clamp((tall - 1) / 0.78, 0, 1)
  const offFor = (fov: number): number => heroSize / (2 * span * Math.tan(fov / 2) * (W / H))
  const backRoom = (yaw: number): number => {
    let d = 0
    while (d < longSide && onBoard({ x: hero.x - viewDir(yaw).x * (d + si.mm), y: hero.y - viewDir(yaw).y * (d + si.mm) })) d += si.mm
    return d
  }
  const lensFor = (yaw: number, tight: number): { fov: number; off: number } => {
    const want = clamp(2 * Math.atan((heroSize / (2 * span * ARRIVE_OFF * heroSize)) * (H / W)), 12 * D, tight * fovTravel)
    const off = Math.max(1.2 * heroSize, Math.min(offFor(want), backRoom(yaw) - 0.75 * RIDE_REACH * longSide))
    const fov = clamp(2 * Math.atan((heroSize / (2 * span * off)) * (H / W)), want, tight * fovTravel)
    return { fov, off: offFor(fov) }
  }
  const firstLit = si.ride.first.length > 0 ? { x: si.ride.first.reduce((a, p) => a + p.x, 0) / si.ride.first.length, y: si.ride.first.reduce((a, p) => a + p.y, 0) / si.ride.first.length } : undefined
  const source = path.length > 1 ? { x: (path[0] as [number, number, number])[0], y: (path[0] as [number, number, number])[1] } : firstLit
  const comeFrom = source === undefined || Math.hypot(source.x - hero.x, source.y - hero.y) < heroSize ? viewDir(yawPlace) : { x: hero.x - source.x, y: hero.y - source.y }
  const yawFrom = Math.atan2(-comeFrom.x, -comeFrom.y)
  const arriveKey = (yaw: number, tilt: number, lens: { fov: number; off: number }): Key => {
    const dist = lens.off / Math.sin(tilt)
    return { ...hero, zoom: H / 2 / Math.tan(lens.fov / 2) / dist, yaw, tilt, fov: lens.fov, aperture: ARRIVE_APERTURE, focus: hero, shift: 0 }
  }
  const hb0 = si.heroBox
  const boxCorners = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [0, Math.min(hb0.z, Math.max(hb0.w, hb0.h))].map((z): [number, number, number] => [
    hb0.x + (Math.cos(hb0.rot) * sx * hb0.w) / 2 - (Math.sin(hb0.rot) * sy * hb0.h) / 2,
    hb0.y + (Math.sin(hb0.rot) * sx * hb0.w) / 2 + (Math.cos(hb0.rot) * sy * hb0.h) / 2,
    z
  ])))
  const framed = (k: Key): boolean => {
    const cam = makeCam(k, W, H)
    return boxCorners.every(([x, y, z]) => {
      const q = project(cam, x, y, z)
      return q.w > 0 && Math.max(Math.abs(q.x), Math.abs(q.y)) <= 0.94
    })
  }
  const follow = layers.filter((l) => l.side === 'F').flatMap((l) => l.groups.flatMap((gi, i) => {
    if (!si.chase.has(gi)) return []
    const o = 7 * i
    const a = { x: l.segs[o] as number, y: l.segs[o + 1] as number }
    const b = { x: l.segs[o + 2] as number, y: l.segs[o + 3] as number }
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (0.5 * si.mm)))
    return Array.from({ length: k + 1 }, (_, j) => ({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k }))
  }))
  const box = { x0: x0 - 10 * si.mm, y0: y0 - 10 * si.mm, x1: x1 + 10 * si.mm, y1: y1 + 10 * si.mm }
  const followed = [...follow, ...path.map(([x, y]) => ({ x, y }))]
  const grid = (reuse.grid ??= flyGrid(box, 0.75 * si.mm, inWall, onBoard, followed, 3 * si.mm))
  type Flight = { ride: CameraShot[]; wide: CameraShot[]; open: (open: number) => CameraShot[]; rideLight: RideLight; flaws: () => number; run: number }
  type Option = { a: { yaw: number; tilt: number; cost: number; lens: { fov: number; off: number } }; way: { pts: Vec2[]; tier: number } }
  const solve = (tight: number): Option[] => {
  const base = reuse.arrivals.get(tight) ?? [RIDE.tilt, 74 * D, 70 * D].flatMap((tilt) => Array.from({ length: 24 }, (_, i) => {
    const yaw = yawFrom + i * 15 * D
    let lens = lensFor(yaw, tight)
    for (let j = 0; j < 30 && !framed(arriveKey(yaw, tilt, lens)); j++) lens = { ...lens, off: lens.off * 1.05 }
    const offEnd = lens.off
    const k = arriveKey(yaw, tilt, lens)
    const cam = makeCam(k, W, H)
    const occ = heroOcclusion(cam, W, H, si.heroBox, si.blockers, si.heroReach)
    const at = standAt(yaw, offEnd)
    const front = si.blockers.reduce((sum, b) => {
      const ahead = (b.x - at.x) * viewDir(yaw).x + (b.y - at.y) * viewDir(yaw).y
      if (ahead <= 0 || ahead > 0.6 * offEnd) return sum
      const c = Math.cos(b.rot)
      const sn = Math.sin(b.rot)
      const qs = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [0, b.z].map((z) => project(cam, b.x + (c * sx * b.w - sn * sy * b.h) / 2, b.y + (sn * sx * b.w + c * sy * b.h) / 2, z))))
      if (qs.some((q) => q.w <= 0)) return sum + 0.3
      const xs = qs.map((q) => clamp(q.x, -1, 1))
      const ys = qs.map((q) => clamp(q.y, -1, 1))
      return sum + ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 4
    }, 0)
    const run = Array.from({ length: 8 }, (_, j) => ({ x: at.x - viewDir(yaw).x * offEnd * (j / 7), y: at.y - viewDir(yaw).y * offEnd * (j / 7) })).filter(inWall).length / 8
    const back = Array.from({ length: 12 }, (_, j) => ({ x: at.x - viewDir(yaw).x * RIDE_REACH * longSide * (j / 11), y: at.y - viewDir(yaw).y * RIDE_REACH * longSide * (j / 11) }))
    const room = back.filter((q) => onBoard(q) && !inWall(q)).length / back.length
    const heroAt = project(cam, hero.x, hero.y, 0)
    const posts = si.blockers.filter((b) => {
      const ahead = (b.x - at.x) * viewDir(yaw).x + (b.y - at.y) * viewDir(yaw).y
      if (ahead <= 0 || ahead >= offEnd - 0.4 * heroSize) return false
      const top = project(cam, b.x, b.y, b.z)
      return top.w > 0 && Math.abs(top.x - heroAt.x) < 0.3 && top.y > heroAt.y - 0.05
    }).length
    const cost = 5 * occ.covered + 6 * front + 1.5 * posts + 0.3 * Math.max(0, occ.larger - 2) + (inWall(at) ? 10 : 0) + 2 * run + 8 * (1 - room) + 0.6 * (1 - Math.cos(yaw - yawFrom)) + 0.01 * (RIDE.tilt - tilt) / D + 0.12 * (lens.fov - fovTravel * RIDE_TIGHT) / D + (onBoard(at) ? 0 : 0.3)
    return { yaw, tilt, cost: cost + (onBoard(at) ? 0 : 1), lens }
  }))
  reuse.arrivals.set(tight, base)
  const arrivals = base.map((a) => ({ ...a, cost: a.cost + unread(a.yaw) })).sort((p, q) => p.cost - q.cost)
  const tried = arrivals.filter((a, i) => i === 0 || arrivals.findIndex((b) => Math.abs(wrap(b.yaw - a.yaw)) < 1e-6) === i).slice(0, 5)
    .map((a) => {
      const key = `${a.yaw} ${a.lens.off}`
      const way = reuse.ways.get(key) ?? flyway(standAt(a.yaw, a.lens.off), grid, onBoard, RIDE_REACH * longSide, source, viewDir(a.yaw), a.lens.off)
      reuse.ways.set(key, way)
      return { a, way }
    })
  return tried.sort((p, q) => Number(p.way.tier >= 8) - Number(q.way.tier >= 8) || p.a.cost + 0.5 * p.way.tier + misread(p) - (q.a.cost + 0.5 * q.way.tier + misread(q)))
  }
  const options = solve(RIDE_TIGHT)
  let chosen = options[0] as Option
  for (const tight of [0.85, 0.92]) {
    if (chosen.way.tier < 4) break
    const looser = solve(tight)
    options.push(...looser)
    if ((looser[0] as Option).way.tier < chosen.way.tier) chosen = looser[0] as Option
  }
  const sideLit = layers.filter((l) => l.side === 'F').flatMap((l) => l.groups.flatMap((gi, i) => (si.chase.has(gi) ? [[l.segs[7 * i] as number, l.segs[7 * i + 1] as number, l.segs[7 * i + 2] as number, l.segs[7 * i + 3] as number]] : [])))
  const fly = (chosen: Option, skip = 0, aim: 'stand' | 'hero' = 'stand', early = false): Flight => {
    const key = `${chosen.a.yaw} ${chosen.a.tilt} ${chosen.a.lens.fov} ${chosen.a.lens.off} ${skip} ${aim}`
    const hit = reuse.flights.get(`${key} ${early}`)
    if (hit !== undefined) return hit as Flight
    const f = (reuse.flights.get(`${key} false`) as (Flight & { early: RideLight }) | undefined) ?? flyInner(chosen, skip, aim)
    reuse.flights.set(`${key} false`, f)
    const out = early ? { ...f, rideLight: f.early } : f
    reuse.flights.set(`${key} ${early}`, out)
    return out
  }
  const flyInner = (chosen: Option, skip: number, aim: 'stand' | 'hero'): Flight & { early: RideLight } => {
  const arrival = chosen.a
  const offEnd = arrival.lens.off
  const fovEnd = arrival.lens.fov
  const goal = standAt(arrival.yaw, offEnd)
  const course = ((): Vec2[] => {
    const all = chosen.way.pts
    let run = 0
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1] as Vec2
      const b = all[i] as Vec2
      const l = Math.hypot(b.x - a.x, b.y - a.y)
      if (run + l > skip) {
        const w = clamp((skip - run) / Math.max(1e-9, l), 0, 1)
        return [{ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w }, ...all.slice(i)]
      }
      run += l
    }
    return all
  })()
  const runs = [0]
  for (let i = 1; i < course.length; i++) runs.push((runs[i - 1] as number) + Math.hypot((course[i] as Vec2).x - (course[i - 1] as Vec2).x, (course[i] as Vec2).y - (course[i - 1] as Vec2).y))
  const L = Math.max(1e-6, runs.at(-1) as number)
  const alongCourse = (s: number): Vec2 => {
    let i = 1
    while (i < course.length - 1 && (runs[i] as number) < s) i++
    const a = course[i - 1] as Vec2
    const b = course[i] as Vec2
    const w = clamp((s - (runs[i - 1] as number)) / Math.max(1e-9, (runs[i] as number) - (runs[i - 1] as number)), 0, 1)
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w }
  }
  const hEnd = offEnd / Math.tan(arrival.tilt)
  const toward = aim === 'stand' ? goal : hero
  const chordYaw = Math.atan2(-(toward.x - (course[0] as Vec2).x), -(toward.y - (course[0] as Vec2).y))
  const tighten = (u: number): number => {
    const w = clamp((u - (1 - RIDE_TIGHTEN)) / RIDE_TIGHTEN, 0, 1)
    return w * w * (3 - 2 * w)
  }
  const speedAt = (u: number): number => 1 - (1 - RIDE_LAND) * tighten(u)
  const N = 200
  const cum = [0]
  for (let i = 1; i <= N; i++) cum.push((cum[i - 1] as number) + speedAt((i - 0.5) / N))
  const travelled = (u: number): number => ((cum[Math.round(clamp(u, 0, 1) * N)] as number) / (cum[N] as number)) * L
  const rideTimes = Array.from({ length: 17 }, (_, i) => tRide + ((wake - tRide) * i) / 16)
  const keyAt = (u: number, rise: number, open = 1): { key: Key; at: Vec2 } => {
    const w = tighten(u)
    const s = travelled(u)
    const at = alongCourse(s)
    const tilt = RIDE.tilt + (arrival.tilt - RIDE.tilt) * w
    const h = hFly * rise + (hEnd - hFly * rise) * w
    const fov = Math.exp(Math.log(fovTravel * open) + (Math.log(fovEnd) - Math.log(fovTravel * open)) * w)
    const m = u * u * (3 - 2 * u)
    const yaw = chordYaw + wrap(arrival.yaw - chordYaw) * m
    const ahead = h * Math.tan(tilt)
    const look = { x: at.x + viewDir(yaw).x * ahead, y: at.y + viewDir(yaw).y * ahead }
    const zoom = H / 2 / Math.tan(fov / 2) / (h / Math.cos(tilt))
    return { key: { ...look, zoom, yaw, tilt, fov, aperture: RIDE.aperture + (ARRIVE_APERTURE - RIDE.aperture) * w, focus: u >= 0.8 ? hero : look, shift: 0 }, at }
  }
  const walled = (k: Key): number => {
    const cam = makeCam(k, W, H)
    return nearCover(cam, W, H, si.blockers, 0.85 * cam.dist, 16)
  }
  const laneOf = (track: Vec2[], spread: number[]): number[][] => {
    const near = (x: number, y: number): boolean => track.some((q, i) => Math.hypot(q.x - x, q.y - y) <= RIDE_SIDE * si.mm * (spread[i] as number))
    return sideLit.filter(([ax, ay, bx, by]) => near(ax as number, ay as number) || near(bx as number, by as number))
  }
  const seenOf = (k: Key, lane: number[][]): number => {
    const cam = makeCam(k, W, H)
    const ahead = si.blockers.filter((b) => {
      const q = project(cam, b.x, b.y, b.z / 2)
      return q.w > 0 && Math.abs(q.x) < 1.6 && Math.abs(q.y) < 1.6
    })
    let seen = 0
    for (const [ax, ay, bx, by] of lane) {
      const qa = project(cam, ax as number, ay as number, 0)
      const qb = project(cam, bx as number, by as number, 0)
      if (qa.w <= 0 || qb.w <= 0 || Math.max(Math.abs(qa.x), Math.abs(qa.y), Math.abs(qb.x), Math.abs(qb.y)) > 1) continue
      if (inSight(cam, ((ax as number) + (bx as number)) / 2, ((ay as number) + (by as number)) / 2, 0, ahead)) seen += Math.hypot(((qa.x - qb.x) * W) / 2, ((qa.y - qb.y) * H) / 2) / W
    }
    return seen
  }
  const RISES = 48
  const cover = new Map<string, number>()
  const walledAt = (i: number, rise: number): number => {
    const key = `${i} ${rise}`
    const hit = cover.get(key)
    if (hit !== undefined) return hit
    const v = walled(keyAt(i / RISES, rise).key)
    cover.set(key, v)
    return v
  }
  const need = Array.from({ length: RISES + 1 }, (_, i) => {
    let rise = 1
    while (rise < RIDE_RISE && walledAt(i, rise) > RIDE_WALL) rise = Math.min(RIDE_RISE, rise * 1.15)
    return rise
  })
  const blocked = need.map((rise, i) => walledAt(i, rise) > RIDE_WALL + 0.05)
  const walls = blocked.findIndex((b, i) => !b && blocked.slice(i, i + 12).filter(Boolean).length <= 3)
  if (skip === 0 && walls > 0 && L - travelled(walls / RISES) >= 0.85 * RIDE_REACH * longSide) return fly(chosen, travelled(walls / RISES), aim) as Flight & { early: RideLight }
  let rises = need.map((_, i) => Math.max(...need.slice(Math.max(0, i - 3), i + 4)))
  for (let pass = 0; pass < 3; pass++) rises = rises.map((_, i) => rises.slice(Math.max(0, i - 2), i + 3).reduce((a, b) => a + b, 0) / (Math.min(rises.length, i + 3) - Math.max(0, i - 2)))
  const riseAt = (u: number): number => {
    const x = clamp(u, 0, 1) * RISES
    const i = Math.min(RISES - 1, Math.floor(x))
    return (rises[i] as number) + ((rises[i + 1] as number) - (rises[i] as number)) * (x - i)
  }
  const rideKey = (u: number): { key: Key; at: Vec2 } => keyAt(u, riseAt(u))
  const shotsOf = (open: number): CameraShot[] => {
    const keys: CameraShot[] = rideTimes.map((t, i) => ({ t, ...keyAt(i / 16, riseAt(i / 16), open).key, ...(i === 0 ? { light: 'ride' as const, cut: true } : {}) }))
    for (let i = 1; i < keys.length; i++) (keys[i] as CameraShot).yaw = (keys[i - 1] as CameraShot).yaw + wrap((keys[i] as CameraShot).yaw - (keys[i - 1] as CameraShot).yaw)
    const arrive = { ...(keys.at(-1) as CameraShot), ...hero, focus: hero }
    keys[keys.length - 1] = arrive
    keys.push({ ...arrive, t: tTop - 1e-4, zoom: arrive.zoom * 1.06, yaw: arrive.yaw + 2 * D * Math.sign(wrap(arrive.yaw - (keys[0] as CameraShot).yaw) || 1) })
    return keys
  }
  const ride = shotsOf(1)
  const looks = Array.from({ length: 49 }, (_, i) => rideKey(i / 48))
  const track = [looks[0]?.at ?? hero, ...looks.map((k) => ({ x: k.key.x, y: k.key.y }))]
  track[track.length - 1] = hero
  const trackRuns = [0]
  for (let i = 1; i < track.length; i++) trackRuns.push((trackRuns[i - 1] as number) + Math.hypot((track[i] as Vec2).x - (track[i - 1] as Vec2).x, (track[i] as Vec2).y - (track[i - 1] as Vec2).y))
  const trackEnd = trackRuns.at(-1) as number
  const lead = (k: { key: Key; at: Vec2 }): number => Math.hypot(k.key.x - k.at.x, k.key.y - k.at.y)
  const lag = 0.8 * (lead(looks[0] as { key: Key; at: Vec2 }) - lead(keyAt(0, 1)))
  const frontFrom = (early: boolean): Array<{ s: number; t: number }> => {
    let ahead = early ? (trackRuns[1] as number) + lead(looks[0] as { key: Key; at: Vec2 }) : 0
    return looks.map((k, i) => {
      const u = i / 48
      ahead = Math.max(ahead, Math.min(trackEnd, (trackRuns[i + 1] as number) + 0.8 * (1 - u) * lead(k) - lag * (1 - Math.min(1, 3 * u)) ** 2))
      return { s: i === 48 ? trackEnd : ahead, t: tRide + (wake - tRide) * u }
    })
  }
  const rideLight = { course: track, runs: trackRuns, front: frontFrom(false), spread: [riseAt(0), ...looks.map((_, i) => riseAt(i / 48))] }
  let counted: number | undefined
  const flaws = (): number => {
    if (counted !== undefined) return counted
    const lane = laneOf(track, rideLight.spread)
    counted = Array.from({ length: 25 }, (_, i) => {
      const k = rideKey(i / 24).key
      return (walled(k) > RIDE_WALL + 0.05 ? 1 : 0) + (seenOf(k, lane) < RIDE_SEEN ? 1 : 0)
    }).reduce((x, y) => x + y, 0)
    return counted
  }
  const run = looks.reduce((sum, k, i) => {
    if (i === 0) return sum
    const a = makeCam(k.key, W, H).pos
    const b = makeCam((looks[i - 1] as { key: Key }).key, W, H).pos
    return sum + Math.hypot(a[0] - b[0], a[1] - b[1])
  }, 0)
  return { ride, wide: shotsOf(RIDE_OPEN), open: shotsOf, rideLight, flaws, run, early: { ...rideLight, front: frontFrom(true) } }
  }
  const pick = (): { o: Option; f: Flight } => {
    const first = { o: chosen, f: fly(chosen) }
    return (first.f.flaws() <= 2 ? [] : options.filter((o) => o !== chosen && o.way.tier < 8)).map((o) => ({ o, f: fly(o) })).reduce((best, c) => (c.f.flaws() < best.f.flaws() - 2 ? c : best), first)
  }
  const picked = plain === undefined ? pick() : (reuse.ride as { o: Option; f: Flight })
  const topCopper = layers.filter((l) => l.side === 'F')
  const sightFlaws = (f: { ride: CameraShot[]; rideLight: RideLight }, limit = Infinity): number => {
    const seen = reuse.sight.get(f)
    if (seen !== undefined && (seen.dark < seen.limit || limit <= seen.limit)) return Math.min(seen.dark, limit)
    const dark = countFlaws(f, limit)
    reuse.sight.set(f, { dark, limit })
    return dark
  }
  const countFlaws = (f: { ride: CameraShot[]; rideLight: RideLight }, limit: number): number => {
    const lit = topCopper.map((l) => ({ ...l, energy: [...l.energy] }))
    if (si.powerAt !== undefined) chaseLight(lit, f.rideLight, si.rideSide, si.powerFrom, si.powerAt)
    const from = Math.round(tRide * FRAMES)
    const parts = [...si.blockers, si.heroBox]
    const last = (from + RIDE_CHECK - 1) / FRAMES
    const glowing: number[] = []
    for (const l of lit) {
      for (let i = 0; i < l.groups.length; i++) {
        const e = Math.min(l.energy[2 * i] as number, l.energy[2 * i + 1] as number)
        if (e >= 0 && e <= last) glowing.push(e, l.segs[7 * i] as number, l.segs[7 * i + 1] as number, l.segs[7 * i + 2] as number, l.segs[7 * i + 3] as number)
      }
    }
    let run = 0
    let dark = 0
    for (let fr = from; fr < from + RIDE_CHECK; fr++) {
      const p = fr / FRAMES
      const cam = makeCam(sampleShot(f.ride, p), W, H)
      run = nearCover(cam, W, H, si.blockers, 0.85 * cam.dist) > RIDE_COVER ? run + 1 : 0
      if (run > RIDE_WALL_RUN) dark++
      if (dark >= limit) return dark
      if ((fr - from) % 2 === 1) continue
      const near = parts.flatMap((b) => {
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (const [x, y, z] of corners(b)) {
          const q = project(cam, x, y, z)
          if (q.w <= 0) return [{ b, x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }]
          x0 = Math.min(x0, q.x)
          y0 = Math.min(y0, q.y)
          x1 = Math.max(x1, q.x)
          y1 = Math.max(y1, q.y)
        }
        return x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1 ? [] : [{ b, x0, y0, x1, y1 }]
      })
      let seen = 0
      for (let o = 0; o < glowing.length && seen < RIDE_LIT; o += 5) {
        if ((glowing[o] as number) > p) continue
        const [sx0, sy0, sx1, sy1] = [glowing[o + 1] as number, glowing[o + 2] as number, glowing[o + 3] as number, glowing[o + 4] as number]
        const a = project(cam, sx0, sy0, 0)
        const b = project(cam, sx1, sy1, 0)
        if (a.w <= 0 || b.w <= 0 || Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)) > 1) continue
        const mx = (sx0 + sx1) / 2
        const my = (sy0 + sy1) / 2
        const m = project(cam, mx, my, 0)
        if (inSight(cam, mx, my, 0, near.filter((n) => m.x >= n.x0 && m.x <= n.x1 && m.y >= n.y0 && m.y <= n.y1).map((n) => n.b))) seen += Math.hypot(((a.x - b.x) * W) / 2, ((a.y - b.y) * H) / 2) / W
      }
      if (seen < RIDE_LIT) dark++
    }
    return dark
  }
  const flies = (f: Flight): boolean => {
    const t0 = (f.wide[0] as CameraShot).t
    const span = Array.from({ length: Math.round(((f.wide.at(-1) as CameraShot).t - t0) * FRAMES) }, (_, i) => makeCam(sampleShot(f.wide, t0 + i / FRAMES), W, H).pos)
    const run = span.reduce((sum, q, i) => (i === 0 ? 0 : sum + Math.hypot(q[0] - (span[i - 1] as [number, number, number])[0], q[1] - (span[i - 1] as [number, number, number])[1])), 0)
    return run >= RIDE_RUN * longSide && sightFlaws({ ride: f.wide, rideLight: f.rideLight }, 1) === 0
  }
  const pickedFlaws = sightFlaws(picked.f)
  let best = { o: picked.o, f: picked.f, dark: pickedFlaws, misread: misread(picked.o) }
  const settled = (): boolean => best.dark === 0 && best.misread === 0
  const others = options.filter((o, i) => o !== picked.o && options.findIndex((q) => Math.abs(wrap(q.a.yaw - o.a.yaw)) < 1e-6 && q.a.tilt === o.a.tilt && q.a.lens.off === o.a.lens.off) === i)
  const readable = others.filter((o) => misread(o) === 0)
  for (const o of settled() ? [] : plain === undefined ? [picked.o, ...others] : readable) {
    if (best.dark === 0 && misread(o) >= best.misread) continue
    const len = o.way.pts.reduce((sum, q, i) => (i === 0 ? 0 : sum + Math.hypot(q.x - (o.way.pts[i - 1] as Vec2).x, q.y - (o.way.pts[i - 1] as Vec2).y)), 0)
    for (const [cut, aim, early] of plain === undefined ? RIDE_VARIANTS : RIDE_VARIANTS.slice(0, 1)) {
      if (o === picked.o && cut === 0 && aim === 'stand' && !early) continue
      const f = fly(o, cut * len, aim, early)
      if (f.run < RIDE_RUN * longSide) continue
      const dark = sightFlaws(f, best.dark + 1)
      if (dark < best.dark || (dark === best.dark && misread(o) < best.misread && flies(f))) best = { o, f, dark, misread: misread(o) }
      if (best.f === f && best.dark === 0) break
    }
    if (settled()) break
  }
  if (plain !== undefined && (best.f === picked.f || !flies(best.f))) return plain
  reuse.ride = { o: best.o, f: best.f }
  const hidden = (keys: CameraShot[]): number[] => Array.from({ length: RIDE_CHECK }, (_, i) => tRide + i / FRAMES).filter((p) => heroOcclusion(makeCam(sampleShot(keys, p), W, H), W, H, si.heroBox, si.blockers, si.heroReach).covered > 0)
  const behind = si.own ? hidden(best.f.wide) : []
  const tight = best.f.open(1)
  const ride = behind.length === 0 ? best.f.wide : [best.f.wide.map((k, i, ks) => (behind.some((p) => p >= (ks[i - 1] ?? k).t && p <= (ks[i + 1] ?? k).t) ? (tight[i] as CameraShot) : k)), ...OPEN_STEPS.map((k) => best.f.open(k))].find((keys) => hidden(keys).length === 0) ?? best.f.wide
  const { rideLight } = best.f

  const pts = boardPoints(si.loops, si.solids, si.thick)
  const titled = titleBlock(si.named?.name, si.named?.revision, [], W, H, 0.78 * W, 3, si.heroLine)
  const columns = titled === undefined || W <= 1.05 * H ? [] : COLUMNS.flatMap((room) => [si.heroLine, undefined].flatMap((first) => {
    const b = titleBlock(si.named?.name, si.named?.revision, [], W, H, room * W, 3, first)
    return b !== undefined && b.width <= 0.41 * W && CAP * b.size >= 0.06 * H ? [{ b, first }] : []
  }))
  const frameEnd = (yaw: number, side: Side, block: typeof titled): { key: Key; top: number; cx: number; fill: number; wide: number; tall: number } => {
    const gap = side === 'beside' ? 0.03 * W : 0.05 * H
    let shot: Omit<Key, 'zoom'> = { ...mid, tilt: 0, yaw, fov: POSTER_FOV, aperture: 0, focus: hero, light: 'poster' }
    const settle = (z: number): ReturnType<typeof composite> => {
      shot = { ...shot, ...centreOn({ ...shot, zoom: z, shift: 0 }, pts, W, H) }
      const c = composite({ ...shot, zoom: z }, pts, block, W, H, side, gap)
      if (side !== 'beside') return c
      shot = { ...shot, ...centreOn({ ...shot, zoom: z, shift: 0 }, pts, W, H, (2 * c.dx) / W) }
      return composite({ ...shot, zoom: z }, pts, block, W, H, side, gap)
    }
    const m = side === 'beside' ? 0.058 : 0.07
    const fits = (c: ReturnType<typeof composite>): boolean => c.x0 >= m * W && c.x1 <= (1 - m) * W && c.y1 - c.y0 <= (1 - 2 * m) * H
    let zlo = 0.05
    let zhi = 40
    for (let i = 0; i < 18; i++) {
      const z = Math.sqrt(zlo * zhi)
      if (fits(settle(z))) zlo = z
      else zhi = z
    }
    const c = settle(zlo)
    const hull = silhouette(makeCam({ ...shot, zoom: zlo, shift: 0 }, W, H), pts, W, H)
    const area = Math.abs(hull.reduce((sum, q, i) => {
      const n = hull[(i + 1) % hull.length] as [number, number]
      return sum + q[0] * n[1] - n[0] * q[1]
    }, 0)) / (2 * W * H)
    const xs = hull.map((q) => q[0])
    const ys = hull.map((q) => q[1])
    return { key: { ...shot, zoom: zlo, shift: c.shift }, top: c.top, cx: c.cx, fill: area, wide: (Math.max(...xs) - Math.min(...xs)) / W, tall: (Math.max(...ys) - Math.min(...ys)) / H }
  }
  const quarters = [0, 1, 2, 3].map((q) => ({ yaw: (q * Math.PI) / 2 + TOP_TURN[1], read: upright((q * Math.PI) / 2) }))
  const layouts: Array<{ side: Side; block: typeof titled; lead: number }> = [{ side: 'below', block: titled, lead: 0 }, ...columns.map((c) => ({ side: 'beside' as const, block: c.b, lead: c.first === undefined ? 0 : 0.02 }))]
  const ends = quarters.filter((e) => e.read > -0.2).flatMap((e) => layouts.map((l) => ({ ...e, ...l, ...frameEnd(e.yaw, l.side, l.block) })))
  const cramped = (e: (typeof ends)[number]): number => (W > 1.05 * H && ((e.side === 'below' ? e.wide < 0.6 : e.tall < 0.6) || (e.wide < 0.56 && e.tall < 0.88)) ? 1 : 0)
  const aspectBoard = Math.max(x1 - x0, y1 - y0) / Math.max(1e-6, Math.min(x1 - x0, y1 - y0))
  const lying = W > 1.05 * H && aspectBoard >= 1.15 ? ends.filter((e) => e.wide * W >= e.tall * H && e.tall >= (aspectBoard >= 1.9 ? 0.49 : WIDE_POSTER)) : []
  const end = (lying.length > 0 ? lying : ends).sort((p, q) => q.fill + q.lead + 0.04 * q.read - cramped(q) - (p.fill + p.lead + 0.04 * p.read - cramped(p)))[0] as (typeof ends)[number]
  const block = end.block
  const lockup = block === undefined ? undefined : lockupAt(block, end.side, end.top, W, end.cx)
  const quarter = { x: hero.x + (mid.x - hero.x) * 0.2, y: hero.y + (mid.y - hero.y) * 0.2 }
  const topKey: Key = { ...quarter, zoom: end.key.zoom * TOP_PUSH, tilt: 0, yaw: end.yaw + TOP_TURN[0] - TOP_TURN[1], fov: POSTER_FOV, aperture: 0, focus: hero, shift: 0 }
  const before = [...spark, ...coat, ...place.map(keepHero), ...ride].map((k) => ((k.t >= tRide && k.t < wake) || (film && k.t >= tCoat && k.t < tPlace) ? k : withhold(k))).map((k) => (k.t >= tPlace && (k.t < tRide || k.t >= wake) ? keepHero(k) : k))
  if (film) {
    const arrive = before.at(-1) as CameraShot
    const zHero = ((heroFrac + HERO_WIDER) * W) / heroSize
    const heroKey = (yaw: number, zoom = zHero): Key => clearLens({ x: hero.x, y: hero.y, zoom, yaw, ...HERO, focus: hero, shift: 0 }, si.blockers, W, H, margin)
    const facing = si.heroMark === undefined ? [arrive.yaw] : HERO_OFF.map((off) => Math.PI * Math.round((arrive.yaw + (si.heroMark as number)) / Math.PI) - (si.heroMark as number) + off)
    const rise = (k: Key): number[] => heroCorners.map(([x, y, z]) => project(makeCam(k, W, H), x, y, z).y)
    const lastFor = (yaw: number): Key => {
      const loose = rise(heroKey(yaw))
      const flat = heroKey(yaw, zHero * Math.min(1, (HERO_TOP + HERO_FLOOR) / (Math.max(...loose) - Math.min(...loose))))
      return { ...flat, shift: HERO_TOP - Math.max(...rise(flat)) }
    }
    const nameBand = (yaw: number): number => paleInBand(makeCam(lastFor(yaw), W, H), si.pale, H)
    const heroScore = (yaw: number): number => {
      const k = heroKey(yaw)
      const occ = heroOcclusion(makeCam(k, W, H), W, H, si.heroBox, si.blockers, si.heroReach)
      return skyline(k) - 40 * occ.covered - 2 * Math.max(0, occ.larger - 1.5) - 50 * (inPart(lensAt(k, W, H), si.blockers, margin) > 0 ? 1 : 0) - 40 * nearCover(makeCam(k, W, H), W, H, si.blockers, 0.85 * makeCam(k, W, H).dist, 16) - 1.2 * Math.abs(wrap(yaw - arrive.yaw)) - (si.own ? NAME_BAND * nameBand(yaw) : 0)
    }
    const tWhole = Math.max(tTop, onBeat(wake + LID_CROSSED))
    const tDrop = onBeat(tWhole + WHOLE_LOOK)
    const stop = Math.round(Math.max(HERO_FROM, tDrop + B) / B) * B
    const tail = (last: Key): CameraShot[] => [
      { t: tDrop, ...heroWithin({ ...last, zoom: last.zoom * HERO_IN, yaw: last.yaw + HERO_SWING }, 0.9), light: 'hero', cut: true, ease: 'out' },
      { t: stop, ...last },
      ...(si.own ? [{ ...last, t: 1 - STILL / FRAMES, zoom: last.zoom * HERO_PUSH, yaw: last.yaw - 1 * D }] : []),
      { ...last, t: 1, zoom: last.zoom * (si.own ? HERO_PUSH : 1.04), yaw: last.yaw - (si.own ? 1 : 2) * D }
    ]
    const marks = Array.from({ length: Math.round((1 - stop + NAME_EARLY) * FRAMES) + 1 }, (_, i) => Math.min(1, stop - NAME_EARLY + i / FRAMES))
    const crossing = (yaw: number): { x: boolean; c: number } => {
      const keys = tail(lastFor(yaw))
      const cams = marks.map((t) => makeCam(sampleShot(keys, t), W, H))
      return { x: cams.some((cam) => heroCrossed(cam, si.heroBox, si.blockers)), c: Math.max(...cams.map((cam) => heroOcclusion(cam, W, H, si.heroBox, si.blockers, si.heroReach).covered)) }
    }
    const fence = (yaw: number): boolean => {
      const cam = makeCam(lastFor(yaw), W, H)
      return nearShare(cam, W, H, si.blockers, FENCE_DEPTH * ((si.heroBox.x - cam.pos[0]) * cam.f[0] + (-si.heroBox.y - cam.pos[1]) * cam.f[1] + (si.heroBox.z / 2 - cam.pos[2]) * cam.f[2])) > FENCE_MOST
    }
    const ranked = facing.map((y) => ({ y, s: heroScore(y), ...(si.own ? { ...crossing(y), f: fence(y) } : { x: false, c: 0, f: false }) })).sort((p, q) => Number(p.x) - Number(q.x) || (p.x ? p.c - q.c : 0) || Number(p.f) - Number(q.f) || q.s - p.s)
    const yawHero = ending ?? arrive.yaw + wrap((ranked[0]?.y ?? arrive.yaw) - arrive.yaw)
    const last: Key = lastFor(yawHero)
    const found = before.findIndex((k) => k.t >= wake - 1e-9)
    const lid = before.at(-2) as CameraShot
    const linger = (tWhole - lid.t) / (arrive.t - lid.t)
    const aboveAt = (yaw: number): Key => {
      let k: Key = { ...topKey, ...mid, focus: mid, yaw }
      for (let i = 0; i < 3; i++) {
        k = { ...k, ...centreOn(k, rimPts, W, H) }
        k = { ...k, zoom: fitZoom(k, rimPts, W, H, 0.95, 0.9, 0.05, 40) }
      }
      return k
    }
    const above = [0, 1, 2, 3].map((q) => aboveAt(topKey.yaw + wrap((q * Math.PI) / 2 - topKey.yaw))).sort((a, b) => b.zoom * (1 + 0.02 * upright(b.yaw)) - a.zoom * (1 + 0.02 * upright(a.yaw)))[0] as Key
    type Move = { dy: number; dt: number }
    const still: Move = { dy: 0, dt: 0 }
    const moved = (k: CameraShot, m: Move, u: number): CameraShot => ({ ...k, yaw: k.yaw + m.dy * u, tilt: k.tilt + m.dt * u })
    const turnedBy = (m: Move) => (k: CameraShot): CameraShot => { const u = clamp((k.t - wake + 30 / FRAMES) / (30 / FRAMES), 0, 1); return moved(k, m, u * u * (3 - 2 * u)) }
    const closing = (m: Move): CameraShot => keepHero(moved({ ...arrive, t: tWhole - 1e-4, zoom: lid.zoom * (arrive.zoom / lid.zoom) ** linger, yaw: lid.yaw + (arrive.yaw - lid.yaw) * linger }, m, 1))
    const keysOf = (m: Move): CameraShot[] => [...before.slice(0, -1).map(turnedBy(m)), closing(m)]
    const wakeCam = (m: Move) => makeCam(moved(before[found] as CameraShot, m, 1), W, H)
    const reads = si.heroMark === undefined ? undefined : { x: Math.cos(si.heroMark), y: Math.sin(si.heroMark) }
    const readSign = reads === undefined || reads.x * Math.cos(yawHero) - reads.y * Math.sin(yawHero) >= 0 ? 1 : -1
    const levelOf = (m: Move): number => reads === undefined ? 0 : markLevel(wakeCam(m), si.heroBox, { x: readSign * reads.x, y: readSign * reads.y }, W, H)
    const hidAt = (m: Move): number => { const keys = keysOf(m); return Math.max(...Array.from({ length: Math.round((tWhole - wake) * FRAMES / 2) + 16 }, (_, i) => heroOcclusion(makeCam(sampleShot(keys, wake - 30 / FRAMES + (2 * i) / FRAMES), W, H), W, H, si.heroBox, si.blockers, si.heroReach).covered)) }
    const runOf = (m: Move): number => {
      const keys = before.map(turnedBy(m))
      const pos = Array.from({ length: Math.ceil((wake - tRide) * FRAMES) }, (_, i) => makeCam(sampleShot(keys, tRide + i / FRAMES), W, H).pos)
      return pos.reduce((sum, q, i) => (i === 0 ? 0 : sum + Math.hypot(q[0] - (pos[i - 1] as [number, number, number])[0], q[1] - (pos[i - 1] as [number, number, number])[1])), 0)
    }
    const wallOf = (m: Move): number => {
      const keys = before.map(turnedBy(m))
      let run = 0
      let most = 0
      for (let t = wake - 30 / FRAMES; t < wake; t += 1 / FRAMES) {
        const cam = makeCam(sampleShot(keys, t), W, H)
        run = nearCover(cam, W, H, si.blockers, 0.85 * cam.dist) > RIDE_COVER ? run + 1 : 0
        most = Math.max(most, run)
      }
      return most
    }
    const closeFrames = Array.from({ length: Math.max(0, Math.ceil((tWhole - wake) * FRAMES)) }, (_, i) => wake + i / FRAMES)
    const clearOf = (m: Move, every: number): boolean => {
      const keys = keysOf(m)
      return closeFrames.filter((_, i) => i % every === 0 || i === closeFrames.length - 1).every((t) => { const c = lidCover(makeCam(sampleShot(keys, t), W, H), si.heroBox, si.blockers); return c.mark === 0 && c.lid <= LID_COVER })
    }
    const fine = (m: Move): boolean => levelOf(m) <= MARK_LEVEL
    const need = si.own && found >= 0 && (!fine(still) || !clearOf(still, 1))
    const hid0 = need ? hidAt(still) : 0
    const run0 = need ? Math.min(runOf(still), RIDE_RUN * longSide) : 0
    const wall0 = need ? Math.max(RIDE_WALL_RUN, wallOf(still)) : 0
    const yaws = [0, ...Array.from({ length: 180 }, (_, i) => (i % 2 === 0 ? 1 : -1) * (Math.floor(i / 2) + 1) * D)]
    const move = !need ? still : (Array.from({ length: Math.round(CLOSE_STEEPER / (3 * D)) + 1 }, (_, i) => -3 * D * i).flatMap((dt) => yaws.map((dy) => ({ dy, dt }))).find((m) => (m.dy !== 0 || m.dt !== 0) && fine(m) && runOf(m) >= run0 && wallOf(m) <= wall0 && hidAt(m) <= hid0 && clearOf(m, 4) && clearOf(m, 1)) ?? still)
    const turned = move === still ? (k: CameraShot): CameraShot => k : turnedBy(move)
    const tMid = Math.round(((wake + tWhole) / 2) * FRAMES) / FRAMES
    const arcOf = (m: Move) => (ks: CameraShot[]): CameraShot[] => {
      const pin = wake + 1 / FRAMES
      const at = (t: number): CameraShot => ({ ...sampleShot(ks, t), t })
      return [...ks.filter((k) => k.t <= wake), at(pin), ...ks.filter((k) => k.t > pin && k.t < tMid).map((k) => { const u = (k.t - pin) / (tMid - pin); return moved(k, m, u * u * (3 - 2 * u)) }), moved(at(tMid), m, 1), ...ks.filter((k) => k.t > tMid).map((k) => moved(k, m, 1))]
    }
    const closeAs = keysOf(move)
    const levelAt = (keys: CameraShot[], t: number): number => reads === undefined ? 0 : markLevel(makeCam(sampleShot(keys, t), W, H), si.heroBox, { x: readSign * reads.x, y: readSign * reads.y }, W, H)
    const arcs = (m: Move): boolean => {
      const keys = arcOf(m)(closeAs)
      return closeFrames.every((t) => { const c = lidCover(makeCam(sampleShot(keys, t), W, H), si.heroBox, si.blockers); return c.mark === 0 && c.lid <= LID_COVER && levelAt(keys, t) <= (t >= tMid ? MARK_LEVEL : Math.PI / 2) })
    }
    const arc = si.own && found >= 0 && closeFrames.some((t) => t >= tMid && levelAt(closeAs, t) > MARK_LEVEL) ? (Array.from({ length: Math.round(CLOSE_STEEPER / (3 * D)) + 1 }, (_, i) => -3 * D * i).flatMap((dt) => yaws.map((dy) => ({ dy, dt }))).find((m) => (m.dy !== 0 || m.dt !== 0) && arcs(m)) ?? still) : still
    const tallAt = (keys: CameraShot[], t: number, chipMost: number): { up: number; chip: boolean } => {
      const cam = makeCam(sampleShot(keys, t), W, H)
      const ys = rimPts.map(([x, y, z]) => project(cam, x, y, z)).filter((q) => q.w > 0).map((q) => q.y)
      return { up: (Math.min(1, Math.max(...ys)) - Math.max(-1, Math.min(...ys))) / 2, chip: heroCorners.every(([x, y, z]) => { const q = project(cam, x, y, z); return q.w > 0 && Math.abs(q.x) <= chipMost && Math.abs(q.y) <= 0.95 }) }
    }
    const heightened = (keys: CameraShot[]): CameraShot[] => {
      if (!si.own) return keys
      let out = keys
      keys.forEach((k, i) => {
        if (k.cut !== true || (k.light !== 'sheen' && k.light !== 'stage')) return
        const j = keys.findIndex((q, n) => n > i && q.cut === true)
        const end = Math.round(((keys[j] as CameraShot).t - k.t) * FRAMES)
        const least = (ks: CameraShot[]): { up: number; chip: boolean } => Array.from({ length: end }, (_, f) => tallAt(ks, k.t + f / FRAMES, TAKE_CHIP[k.light === 'sheen' ? 'sheen' : 'stage'])).reduce((a, b) => ({ up: Math.min(a.up, b.up), chip: a.chip && b.chip }), { up: 1, chip: true })
        const tallest = TAKE_TALL[k.light === 'sheen' ? 'sheen' : 'stage']
        if (least(out).up >= tallest) return
        let best = out
        for (let z = 1.02; z < 4; z *= 1.02) {
          const ks = out.map((q, n) => (n >= i && n < j ? { ...q, zoom: q.zoom * z } : q))
          const l = least(ks)
          if (!l.chip) break
          best = ks
          if (l.up >= tallest) break
        }
        out = best
      })
      return out
    }
    const shots: CameraShot[] = heightened([
      ...(arc === still ? (ks: CameraShot[]): CameraShot[] => ks : arcOf(arc))([
        ...before.slice(0, -1).map((k, i): CameraShot => turned(i === found ? { ...k, light: 'hero' } : k)),
        closing(move)
      ]),
      { t: tWhole, ...heroWithin({ ...topKey, yaw: above.yaw, zoom: above.zoom * WHOLE_LOOK_FROM }, 0.85), light: 'power', cut: true, ease: 'out' },
      { t: tDrop - 1e-4, ...above },
      ...tail(last)
    ])
    const named = si.named
    if (named === undefined) return { shots, lockup: undefined, turnYaw: yawHero, hold: stop, ride: rideLight }
    const rev = named.revision !== undefined && named.revision.length > 0 ? named.revision : undefined
    const revW = rev === undefined ? 0 : 0.22 + rev.length * GROTESK.small * GROTESK.rev
    const revLeast = rev === undefined || !si.own ? 0 : (W > H ? REV_LEAST.wide : REV_LEAST.other) * Math.min(W, H)
    const words = named.name.split(' ')
    const baseline = (1 - (HERO_TOP + 0.16)) * (H / 2) - 0.07 * H
    const layouts = [1, 2, 3].filter((n) => n <= words.length && (!si.own || n <= NAME_LINES)).map((n) => {
      const lines: string[] = []
      let line = ''
      for (const w of words) {
        const next = line === '' ? w : `${line} ${w}`
        if (line !== '' && lines.length < n - 1 && next.length > named.name.length / n + w.length / 2) {
          lines.push(line)
          line = w
        } else line = next
      }
      lines.push(line)
      const widest = Math.max(...lines.map((l, k) => l.length * GROTESK.advance + (k === lines.length - 1 ? revW : 0)))
      const tall = (lines.length - 1) * GROTESK.lead + GROTESK.cap
      const set = ((lines.length === 1 ? 0.15 : 0.28) * H) / tall
      return { lines, widest, size: si.own ? Math.min(Math.max(set, (NAME_HALF * W) / Math.max(...lines.map((l) => l.length * GROTESK.advance))), (0.74 * W) / widest, rev === undefined ? Infinity : (0.74 * W - rev.length * GROTESK.small * revLeast) / ((lines.at(-1) ?? '').length * GROTESK.advance + 0.22), (baseline - NAME_TOP * H) / tall) : Math.min(set, (0.74 * W) / widest) }
    }).sort((p, q) => q.size - p.size)
    const set = (wrapped: { lines: string[]; widest: number; size: number }): TraceLockup => {
      const size = wrapped.size
      const revSize = Math.max(GROTESK.rev * size, revLeast)
      const width = Math.max(...wrapped.lines.map((l, k) => (l.length * GROTESK.advance + (k === wrapped.lines.length - 1 && rev !== undefined ? 0.22 : 0)) * size + (k === wrapped.lines.length - 1 && rev !== undefined ? rev.length * GROTESK.small * revSize : 0)))
      return {
        side: 'above',
        face: 'grotesk',
        size,
        lines: wrapped.lines.map((text, k) => ({ text, x: W / 2, y: baseline - (wrapped.lines.length - 1 - k) * GROTESK.lead * size })),
        version: rev === undefined ? undefined : { text: rev, size: revSize, y: baseline },
        facts: undefined,
        box: { x0: (W - width) / 2, y0: baseline - ((wrapped.lines.length - 1) * GROTESK.lead + GROTESK.cap) * size, x1: (W + width) / 2, y1: baseline }
      }
    }
    const endCam = makeCam(shots.at(-1) as CameraShot, W, H)
    const sets = layouts.map(set)
    const clear = sets.find((L) => !si.own || !nameCrossed(L, endCam, si.blockers, W, H))
    const lockup: TraceLockup = clear ?? { ...(sets[0] as TraceLockup), front: true }
    const from = onTick(stop * FRAMES - 12)
    const late = Math.max(0, buildFrom(lockup, from, FRAMES, si.own).up * FRAMES - (FRAMES - (READ_SECONDS * FRAMES) / FILM_SECONDS))
    return { shots, lockup: { ...lockup, build: buildFrom(lockup, from - Math.ceil(late / (B * FRAMES / 4) - 1e-6) * (B * FRAMES / 4), FRAMES, si.own) }, turnYaw: yawHero, hold: stop, ride: rideLight }
  }
  const top0 = keepHero(withhold(topKey))
  const toward0 = (f: number): Key => ({
    ...end.key,
    light: undefined,
    x: top0.x + (end.key.x - top0.x) * f,
    y: top0.y + (end.key.y - top0.y) * f,
    zoom: top0.zoom * (end.key.zoom / top0.zoom) ** f,
    yaw: top0.yaw + (end.key.yaw - top0.yaw) * f,
    shift: (end.key.shift ?? 0) * f
  })
  const timeline = (stop: number): CameraShot[] => [
    ...before,
    { t: tTop, ...top0, light: 'power', cut: true, ease: 'linear' },
    { t: tTop + PULL_RUN * (stop - tTop), ...toward0(PULL_REACH) },
    { t: stop, ...end.key, light: 'poster', ease: 'linear' },
    ...(si.own ? [{ ...end.key, t: 1 - STILL / FRAMES, zoom: end.key.zoom * 1.015, yaw: end.key.yaw - 0.5 * D }] : []),
    { ...end.key, t: 1, zoom: end.key.zoom * 1.015, yaw: end.key.yaw - 0.5 * D }
  ]
  const deadline = FRAMES - Math.ceil(READ_SECONDS * 30)
  const plan = (stop: number): { shots: CameraShot[]; lockup: TraceLockup | undefined } => {
    const shots = timeline(stop)
    if (lockup === undefined) return { shots, lockup }
    let clear = FRAMES
    const settling = Math.min(stop, tTop + PULL_RUN * (stop - tTop) + NAME_LEAD)
    for (let f = FRAMES - 1; f >= settling * FRAMES; f--) {
      if (!clearOf(silhouette(makeCam(sampleShot(shots, f / FRAMES), W, H), pts, W, H), lockup.box, TITLE_CLEAR * H)) break
      clear = f
    }
    return { shots, lockup: { ...lockup, build: buildFrom(lockup, onTick(Math.max(clear, Math.ceil(settling * FRAMES))), FRAMES) } }
  }
  let stop = HOLD_FROM
  let best2 = plan(stop)
  while (best2.lockup?.build !== undefined && best2.lockup.build.up * FRAMES > deadline + 1e-6 && stop - B / 2 >= tTop + PULL_LEAST - 1e-9) {
    stop -= B / 2
    best2 = plan(stop)
  }
  return { shots: best2.shots, lockup: best2.lockup, turnYaw: end.key.yaw, hold: stop, ride: rideLight }
}

/**
 * The ride's light: copper on the chased groups within `side` of the ride's course (wider where the ride flies higher) lights as the front passes it,
 * running out from the course at the front's speed, all of it before the wake. Copper behind the front when the ride
 * begins is already lit, whole, on its first frame.
 */
export function chaseLight(layers: TraceLayer[], ride: { course: Vec2[]; runs: number[]; front: Array<{ s: number; t: number }>; spread: number[] }, side: (group: number) => number, from: number, wake: number): void {
  const { course, runs, front, spread } = ride
  const s0 = (front[0] as { s: number }).s
  const sEnd = (front.at(-1) as { s: number }).s
  const speed = (sEnd - s0) / Math.max(1e-6, wake - (front[0] as { t: number }).t)
  const timeAt = (s: number): number => {
    if (s <= s0) return Math.min(from, (front[0] as { t: number }).t)
    let i = 1
    while (i < front.length - 1 && (front[i] as { s: number }).s < s) i++
    const a = front[i - 1] as { s: number; t: number }
    const b = front[i] as { s: number; t: number }
    return a.t + (b.t - a.t) * Math.min(1, Math.max(0, (s - a.s) / Math.max(1e-9, b.s - a.s)))
  }
  const place = (x: number, y: number): { s: number; d: number } => {
    let best = { s: 0, d: Infinity }
    for (let i = 0; i + 1 < course.length; i++) {
      const a = course[i] as Vec2
      const b = course[i + 1] as Vec2
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l2 = Math.max(1e-9, dx * dx + dy * dy)
      const w = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / l2))
      const d = Math.hypot(a.x + dx * w - x, a.y + dy * w - y)
      const wide = (spread[i] as number) + ((spread[i + 1] as number) - (spread[i] as number)) * w
      if (d / wide < best.d) best = { s: (runs[i] as number) + w * Math.sqrt(l2), d: d / wide }
    }
    return best
  }
  const xs = course.map((q) => q.x)
  const ys = course.map((q) => q.y)
  const [bx0, bx1, by0, by1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const widest = Math.max(...spread)
  const far = (x: number, y: number, reach: number): boolean => Math.hypot(Math.max(0, bx0 - x, x - bx1), Math.max(0, by0 - y, y - by1)) > reach * widest * (1 + 1e-9)
  for (const layer of layers) {
    if (layer.side !== 'F') continue
    for (let i = 0; i < layer.groups.length; i++) {
      const reach = side(layer.groups[i] as number)
      if (reach <= 0 || (layer.energy[2 * i] as number) < 0) continue
      const o = 7 * i
      if (far(layer.segs[o] as number, layer.segs[o + 1] as number, reach) && far(layer.segs[o + 2] as number, layer.segs[o + 3] as number, reach)) continue
      const ends = [place(layer.segs[o] as number, layer.segs[o + 1] as number), place(layer.segs[o + 2] as number, layer.segs[o + 3] as number)]
      if (Math.min(...ends.map((e) => e.d)) > reach) continue
      if (ends.every((e) => e.s <= s0)) {
        layer.energy[2 * i] = (front[0] as { t: number }).t - 1 / 360
        layer.energy[2 * i + 1] = (front[0] as { t: number }).t - 0.5 / 360
        continue
      }
      const [ta, tb] = ends.map((e) => Math.min(wake - 1 / 360, timeAt(e.s) + (e.s <= s0 ? 0 : e.d / speed))) as [number, number]
      layer.energy[2 * i] = ta
      layer.energy[2 * i + 1] = tb === ta ? tb + 0.5 / 360 : tb
    }
  }
}
