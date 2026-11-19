import type { FlatPath, TitleBuild, TraceLockup } from '../types'
import { makeCam, project } from './camera'
import type { Cam } from './camera'
import type { CameraShot } from '../types'

const ADVANCE = 0.6
export const CAP = 0.73
/** lines of the facts sit this many sizes apart */
export const FACT_LEAD = 1.5
/** what sits between two facts on one line */
export const FACT_SEP = '  ·  '
/** text meant to be read stands at least this share of the frame's short side, cap height */
export const READ_CAP = 0.026

/** a body for the end frame's silhouette: plane px centre, size, rotation and height */
export interface Solid { x: number; y: number; w: number; h: number; rot: number; z: number }

/** the board's outline at its top face and its underside, and every body's top corners */
export function boardPoints(loops: FlatPath[], solids: Solid[], thick: number): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = []
  for (const loop of loops) {
    const n = loop.length / 2
    const step = Math.max(1, Math.floor(n / 160))
    for (let i = 0; i < n; i += step) {
      const x = loop[2 * i] as number
      const y = loop[2 * i + 1] as number
      pts.push([x, y, 0], [x, y, -thick])
    }
  }
  for (const s of solids) {
    const c = Math.cos(s.rot)
    const sn = Math.sin(s.rot)
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const dx = (u * s.w) / 2
      const dy = (v * s.h) / 2
      pts.push([s.x + dx * c - dy * sn, s.y + dx * sn + dy * c, s.z])
    }
  }
  return pts
}

/** the points' convex hull in screen px */
export function silhouette(cam: Cam, pts: Array<[number, number, number]>, W: number, H: number): Array<[number, number]> {
  const q = pts.map(([x, y, z]) => project(cam, x, y, z)).filter((p) => p.w > 0).map((p): [number, number] => [(p.x * 0.5 + 0.5) * W, (0.5 - p.y * 0.5) * H])
  q.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: Array<[number, number]>): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2] as [number, number], out[out.length - 1] as [number, number], p) <= 0) out.pop()
      out.push(p)
    }
    return out
  }
  const lower = half(q)
  const upper = half([...q].reverse())
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function edgeOver(hull: Array<[number, number]>, x0: number, x1: number, side: 1 | -1): number {
  let best = side > 0 ? -Infinity : Infinity
  const take = (y: number): void => {
    best = side > 0 ? Math.max(best, y) : Math.min(best, y)
  }
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i] as [number, number]
    const b = hull[(i + 1) % hull.length] as [number, number]
    if (a[0] >= x0 && a[0] <= x1) take(a[1])
    for (const x of [x0, x1]) {
      if ((a[0] - x) * (b[0] - x) < 0) take(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]))
    }
  }
  return best
}

/** the title block's type, sized from the frame alone */
export interface Block { lines: string[]; size: number; version: { text: string; size: number } | undefined; factSize: number; facts: string; /** how many first facts lines are set without tracking: the hero part, or every line in a narrow column */ lead: number; width: number; height: number; widths: number[] }

const factW = (text: string, s: number): number => text.length * (ADVANCE + 0.1) * s
const leadW = (text: string, s: number): number => text.length * ADVANCE * s

/** the facts line's least cap height in output px: 9.4 px when the frame is shown 390 px wide, 12 px on a tall 9:16 */
export function factCap(W: number, H: number): number {
  return ((H > 1.6 * W ? 12 : 9.8) * W) / 390
}

/** the title's cap height before it is fitted to the room: 9% of the height on a wide frame, 5% otherwise */
export function titleCap(W: number, H: number): number {
  return (W > 1.05 * H ? 0.09 : 0.05) * H
}

function block(name: string, version: string | undefined, facts: string[], W: number, H: number, room: number, most: number, first: string | undefined): Block {
  const cap = titleCap(W, H)
  const vSize = (s: number): number => Math.max(0.034 * Math.min(W, H), (READ_CAP * Math.min(W, H)) / CAP, 0.45 * s)
  const lineW = (text: string, s: number, last: boolean): number => text.length * ADVANCE * s + (last && version !== undefined ? 0.25 * s + version.length * ADVANCE * vSize(s) : 0)
  const fitSize = (lines: string[]): number => {
    let s = cap / CAP
    while (s > 4 && Math.max(...lines.map((l, i) => lineW(l, s, i === lines.length - 1))) > room) s *= 0.98
    return s
  }
  let lines = [name]
  let size = fitSize(lines)
  const words = name.split(' ')
  const cuts = (rest: string[], k: number): string[][] => k === 1 ? [[rest.join(' ')]] : rest.slice(1, rest.length - k + 2).flatMap((_, i) => cuts(rest.slice(i + 1), k - 1).map((tail) => [rest.slice(0, i + 1).join(' '), ...tail]))
  for (let k = 2; k <= Math.min(most, words.length) && (size * CAP < 0.035 * H || (room < 0.5 * W && size * CAP < 0.999 * cap)); k++) {
    lines = cuts(words, k).sort((a, b) => Math.max(...a.map((l) => l.length)) - Math.max(...b.map((l) => l.length)))[0] ?? [name]
    size = fitSize(lines)
  }
  const factSize = Math.max(0.024 * Math.min(W, H), (0.013 * H) / CAP, factCap(W, H) / CAP, (READ_CAP * Math.min(W, H)) / CAP)
  const half = Math.ceil(facts.length / 2)
  const paired = facts.length < 3 ? [facts.join(FACT_SEP)] : [facts.slice(0, half).join(FACT_SEP), facts.slice(half).join(FACT_SEP)]
  const leadLines = first === undefined ? [] : leadW(first, factSize) <= room ? [first] : first.split(FACT_SEP)
  const column = room < 0.5 * W
  const restW = column ? leadW : factW
  const factLines = [...leadLines, ...(paired.every((l) => restW(l, factSize) <= room) ? paired : facts)]
  const plain = column ? factLines.length : leadLines.length
  const factsText = factLines.join('\n')
  const widths = lines.map((l, i) => lineW(l, size, i === lines.length - 1))
  const lead = 1.12 * size
  const height = CAP * size + (lines.length - 1) * lead + (factLines.length > 0 ? 0.25 * size + 1.4 * factSize + (factLines.length - 1) * FACT_LEAD * factSize + 0.25 * factSize : 0.25 * size)
  return { lines, size, version: version === undefined ? undefined : { text: version, size: vSize(size) }, factSize, facts: factsText, lead: plain, width: Math.max(...widths, ...factLines.map((l, i) => (i < plain ? leadW : factW)(l, factSize)), 0), height, widths }
}

function place(hull: Array<[number, number]>, b: Block, W: number, H: number, side: Side, gap: number): { top: number; x0: number; x1: number; y0: number; y1: number; dx: number; cx: number } {
  const hx = hull.map((p) => p[0])
  const hy = hull.map((p) => p[1])
  if (side === 'beside') {
    const left = (W - (Math.max(...hx) - Math.min(...hx) + gap + b.width)) / 2
    const dx = left - Math.min(...hx)
    const top = (Math.min(...hy) + Math.max(...hy)) / 2 - b.height / 2
    const bx0 = Math.max(...hx) + dx + gap
    return { top, x0: left, x1: bx0 + b.width, y0: Math.min(top, ...hy), y1: Math.max(top + b.height, ...hy), dx, cx: bx0 + b.width / 2 }
  }
  const x0 = (W - b.width) / 2
  const x1 = (W + b.width) / 2
  const edge = edgeOver(hull, x0 - gap, x1 + gap, side === 'below' ? 1 : -1)
  const top = side === 'below' ? edge + gap : edge - gap - b.height
  return { top, x0: Math.min(x0, ...hx), x1: Math.max(x1, ...hx), y0: Math.min(top, ...hy), y1: Math.max(top + b.height, ...hy), dx: 0, cx: W / 2 }
}

/** where the title block sits against the board: under it, over it, or in a column to its right */
export type Side = 'below' | 'above' | 'beside'

/**
 * The board with the block in screen px once the lens shift (NDC) centres them
 * vertically, where the block's top and centre land, and how far right (px)
 * the board must move for a block beside it to centre the pair.
 */
export function composite(shot: Omit<CameraShot, 't' | 'cut'>, pts: Array<[number, number, number]>, b: Block | undefined, W: number, H: number, side: Side, gap: number): { x0: number; x1: number; y0: number; y1: number; shift: number; top: number; dx: number; cx: number } {
  const hull = silhouette(makeCam({ ...shot, shift: 0 }, W, H), pts, W, H)
  const hx = hull.map((p) => p[0])
  const hy = hull.map((p) => p[1])
  const c = b === undefined ? { top: 0, x0: Math.min(...hx), x1: Math.max(...hx), y0: Math.min(...hy), y1: Math.max(...hy), dx: 0, cx: W / 2 } : place(hull, b, W, H, side, gap)
  const dy = (c.y0 + c.y1) / 2 - H / 2
  return { x0: c.x0, x1: c.x1, y0: c.y0 - dy, y1: c.y1 - dy, shift: dy * (2 / H), top: c.top - dy, dx: c.dx, cx: c.cx }
}

/** the title block set to fit `room` px across (78% of the width by default) in at most `most` lines, with an optional first facts line (the hero part) */
export function titleBlock(name: string | undefined, version: string | undefined, facts: string[], W: number, H: number, room = 0.78 * W, most = 3, first?: string): Block | undefined {
  return name === undefined ? undefined : block(name, version !== undefined && version.length > 0 ? version : undefined, facts, W, H, room, most, first)
}

/** the lockup in screen px for a block whose top sits at `top`, centred on `cx` */
export function lockupAt(b: Block, side: Side, top: number, W: number, cx = W / 2): TraceLockup {
  const lead = 1.12 * b.size
  const first = top + CAP * b.size
  const last = first + (b.lines.length - 1) * lead
  return {
    side,
    size: b.size,
    lines: b.lines.map((text, i) => ({ text, x: cx, y: first + i * lead })),
    version: b.version === undefined ? undefined : { text: b.version.text, size: b.version.size, y: last },
    facts: b.facts.length === 0 ? undefined : { text: b.facts, size: b.factSize, x: cx, y: last + 0.25 * b.size + 1.4 * b.factSize, ...(b.lead > 0 ? { lead: b.lead } : {}) },
    box: { x0: cx - b.width / 2, y0: top, x1: cx + b.width / 2, y1: top + b.height }
  }
}

/** frames a letter of the name takes to land */
export const LETTER_LAND = 4
/** the most frames the name's letters take to start, one after another: a long name sets more letters to a beat, never more time */
const NAME_SPAN = 10
/** frames the facts take to rise, as one move */
const FACT_MOVE = 8
/** the build lands on quarter beats of the film's 24-beat grid */
const TICK = 15 / 4

/** seconds every word of the poster is up before the last frame, however many words it holds */
export const READ_SECONDS = 1.7

/** the name built from `start` (frames, on a quarter beat): letter after letter, the version as one mark on the next quarter beat (on the first beat after the name is whole when it takes its own beat), the facts on the quarter beat after */
export function buildFrom(L: TraceLockup, start: number, frames: number, ownBeat = false): TitleBuild {
  const name = L.lines.map((l) => l.text).join(' ')
  const step = Math.min(1, NAME_SPAN / Math.max(1, name.length))
  const lastStart = start + (name.length - 1) * step
  const words: number[] = []
  for (let i = 0; i < name.length; i++) if (name[i] !== ' ' && (i + 1 === name.length || name[i + 1] === ' ')) words.push(start + i * step + LETTER_LAND)
  const version = L.version === undefined ? undefined : ownBeat ? Math.ceil((lastStart + LETTER_LAND) / (4 * TICK) + 1e-6) * 4 * TICK : onTick(lastStart + LETTER_LAND)
  if (version !== undefined) words.push(version + LETTER_LAND)
  const readable = Math.max(...words)
  const facts = L.facts === undefined ? undefined : onTick(readable)
  const up = facts === undefined ? readable : facts + FACT_MOVE
  return { t0: start / frames, step: step / frames, land: LETTER_LAND / frames, version: version === undefined ? undefined : version / frames, words: words.map((w) => w / frames), readable: readable / frames, facts: facts === undefined ? undefined : facts / frames, up: up / frames }
}

/** the first quarter beat at or after frame f */
export function onTick(f: number): number {
  return Math.ceil(f / TICK - 1e-6) * TICK
}

/** whether the board's silhouette keeps `m` px clear of the box */
export function clearOf(hull: Array<[number, number]>, box: { x0: number; y0: number; x1: number; y1: number }, m: number): boolean {
  const x0 = box.x0 - m
  const x1 = box.x1 + m
  const y0 = box.y0 - m
  const y1 = box.y1 + m
  if (hull.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) return false
  const inside = (x: number, y: number): boolean => {
    let c = false
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      const [xi, yi] = hull[i] as [number, number]
      const [xj, yj] = hull[j] as [number, number]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
    }
    return c
  }
  for (let i = 0; i <= 12; i++) for (let j = 0; j <= 6; j++) if (inside(x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * j) / 6)) return false
  return true
}
