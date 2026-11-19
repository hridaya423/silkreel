import type { BoardModel, Vec2 } from '@silk-reel/ingest'
import { padCounts, partKind } from './acts'
import type { ActPlan, Cell } from './acts'
import { cellGlyph, classify } from './cells'
import type { CellKind } from './cells'
import type { Glyph, GlyphEnding } from './types'

export const FONT: Record<string, string> = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.####|#....|#....|#..##|#...#|#...#|.###.',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
  J: '....#|....#|....#|....#|....#|#...#|.###.',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|.#.#.|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  '1': '..#..|.##..|#.#..|..#..|..#..|..#..|#####',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
  '3': '####.|....#|....#|.###.|....#|....#|####.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '.###.|#....|#....|####.|#...#|#...#|.###.',
  '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  '9': '.###.|#...#|#...#|.####|....#|....#|.###.',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.....|..#..'
}
const ROWS = 7
const COLS = 5
const ADVANCE = 6
const SPACE = 4
const LINE_GAP = 3

const bits = (ch: string): string[] => (FONT[ch] ?? FONT['-'] ?? '').split('|')
const on = (g: string[], c: number, r: number): boolean => g[r]?.[c] === '#'
const advance = (ch: string): number => (ch === ' ' ? SPACE : ADVANCE)
const cols = (line: string): number => Array.from(line).reduce((n, c) => n + advance(c), 0) - (ADVANCE - COLS)
export function nameLines(name: string, lines: number): string[] {
  const text = name.trim()
  if (lines <= 1) return [text.toUpperCase()]
  const cuts: number[] = []
  for (let i = 1; i < text.length; i++) {
    const a = text[i - 1] as string
    const b = text[i] as string
    const c = text[i + 1] ?? ''
    const camel = /[a-z0-9]/.test(a) && /[A-Z]/.test(b)
    const acronym = /[A-Z]/.test(a) && /[A-Z]/.test(b) && /[a-z]/.test(c)
    if ((b === ' ' || camel || acronym) && i >= 2 && text.length - i >= 2) cuts.push(i)
  }
  if (cuts.length === 0 && lines === 2 && !text.includes(' ')) cuts.push(Math.ceil(text.length / 2))
  let best: string[] = [text.toUpperCase()]
  let worst = Infinity
  const pick = (from: number, left: number, chosen: number[]): void => {
    if (left === 0) {
      const ends = [0, ...chosen, text.length]
      const option = ends.slice(1).map((e, i) => text.slice(ends[i] as number, e).trim().toUpperCase())
      const longest = Math.max(...option.map((l) => l.length))
      if (longest < worst) {
        worst = longest
        best = option
      }
      return
    }
    for (const c of cuts) if (c > from) pick(c, left - 1, [...chosen, c])
  }
  pick(0, lines - 1, [])
  return best
}
export function letterSegments(ch: string): Array<[Vec2, Vec2]> {
  const g = bits(ch)
  const segs: Array<[Vec2, Vec2]> = []
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!on(g, c, r)) continue
    if (on(g, c + 1, r)) segs.push([{ x: c, y: r }, { x: c + 1, y: r }])
    if (on(g, c, r + 1)) segs.push([{ x: c, y: r }, { x: c, y: r + 1 }])
    if (on(g, c + 1, r + 1) && !on(g, c + 1, r) && !on(g, c, r + 1)) segs.push([{ x: c, y: r }, { x: c + 1, y: r + 1 }])
    if (on(g, c - 1, r + 1) && !on(g, c - 1, r) && !on(g, c, r + 1)) segs.push([{ x: c, y: r }, { x: c - 1, y: r + 1 }])
  }
  return segs
}

export interface NameInput {
  board: BoardModel
  name: string
  ending: GlyphEnding
  pitchPx: number
  width: number
  height: number
  centre: Vec2
  chip: { x0: number; y0: number; x1: number; y1: number } | undefined
}
export const NAME_MARGIN_X = 0.06 + 0.018
export const NAME_MARGIN_Y = 0.06 + 0.012
const READ_PITCH = 7.5
const PHONE = 390
const NAME_TONE = 0.95

interface Letter { ch: string; x: number; y: number; line: number }

function lay(lines: string[], pitch: number, cx: number, top: number[]): Letter[] {
  const out: Letter[] = []
  for (const [li, line] of lines.entries()) {
    let x = cx - (cols(line) * pitch) / 2
    for (const ch of line) {
      if (ch !== ' ') out.push({ ch, x, y: top[li] as number, line: li })
      x += advance(ch) * pitch
    }
  }
  return out
}
function choose(name: string, fit: (lines: string[]) => number, scale: number): { lines: string[]; pitch: number } {
  const options = [1, 2, 3].map((n) => nameLines(name, n)).filter((l, i, all) => all.findIndex((m) => m.join('|') === l.join('|')) === i)
  const read = options.find((l) => fit(l) * scale >= READ_PITCH)
  const lines = read ?? options.reduce((best, l) => (fit(l) > fit(best) ? l : best))
  return { lines, pitch: fit(lines) }
}

function boardKinds(board: BoardModel): Array<[CellKind, number]> {
  const pads = padCounts(board)
  const counts = new Map<CellKind, number>()
  for (const f of board.footprints) {
    if (/\*/.test(f.ref) || ['hole', 'tp'].includes(classify(f.ref, f.value))) continue
    const k = partKind(f, pads)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const extent = (kind: CellKind): number => {
  const pts = cellGlyph(kind).strokes.flat()
  return Math.max(Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y)))
}

const LINK = 0.62
const NODE = 0.5
const NODE_KINDS: CellKind[] = ['chip', 'leaf', 'pad', 'half']
function partsName(input: NameInput): ActPlan {
  const { width, height, pitchPx } = input
  const W = (width * (1 - 2 * NAME_MARGIN_X)) / pitchPx
  const H = (height * (1 - 2 * NAME_MARGIN_Y)) / pitchPx
  const fit = (lines: string[]): number => Math.min(W / Math.max(...lines.map(cols)), H / (lines.length * ROWS - 1 + (lines.length - 1) * LINE_GAP))
  const { lines, pitch } = choose(input.name, fit, (pitchPx * PHONE) / width)
  const tall = (lines.length * ROWS - 1 + (lines.length - 1) * LINE_GAP) * pitch
  const top = lines.map((_, i) => input.centre.y - tall / 2 + i * (ROWS + LINE_GAP) * pitch)
  const letters = lay(lines, pitch, input.centre.x, top)
  const mix = boardKinds(input.board)
  const link: CellKind = mix.find(([k]) => k === 'pill') === undefined ? (mix[0]?.[0] ?? 'pill') : 'pill'
  const nodes = mix.filter(([k]) => k !== link && NODE_KINDS.includes(k))
  const pool = nodes.length === 0 ? ([['chip', 1]] as Array<[CellKind, number]>) : nodes
  const total = pool.reduce((n, [, c]) => n + c, 0)
  const given = new Map<CellKind, number>()
  const cells: Cell[] = []
  const count = letters.length
  for (const [i, l] of letters.entries()) {
    const node = (pool.map(([k, c]) => ({ k, owed: ((i + 1) * c) / total - (given.get(k) ?? 0) })).sort((a, b) => b.owed - a.owed)[0] as { k: CellKind }).k
    given.set(node, (given.get(node) ?? 0) + 1)
    const g = bits(l.ch)
    const segs = letterSegments(l.ch)
    const degree = new Map<string, Vec2[]>()
    for (const [a, b] of segs) {
      degree.set(`${a.x},${a.y}`, [...(degree.get(`${a.x},${a.y}`) ?? []), { x: b.x - a.x, y: b.y - a.y }])
      degree.set(`${b.x},${b.y}`, [...(degree.get(`${b.x},${b.y}`) ?? []), { x: a.x - b.x, y: a.y - b.y }])
    }
    const isNode = (c: number, r: number): boolean => {
      const ds = degree.get(`${c},${r}`) ?? []
      if (ds.length !== 2) return true
      const [d0, d1] = ds as [Vec2, Vec2]
      return d0.x !== -d1.x || d0.y !== -d1.y
    }
    const at = (c: number, r: number): number => (i + (r * COLS + c) / (ROWS * COLS)) / count
    const put = (x: number, y: number): Vec2 => ({ x: l.x + x * pitch, y: l.y + y * pitch })
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (!on(g, c, r) || !isNode(c, r)) continue
      const p = put(c, r)
      cells.push({ x: p.x, y: p.y, role: 'body', sym: 'single', kind: node, size: (NODE * pitch) / extent(node), tone: NAME_TONE, at: at(c, r), group: `name:${i}` })
    }
    for (const [a, b] of segs) {
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const ends = [isNode(a.x, a.y), isNode(b.x, b.y)]
      const share = ends[0] === true && ends[1] === true ? LINK * 0.8 : LINK
      const shift = ends[0] === ends[1] ? 0 : (ends[0] === true ? 1 : -1) * ((1 - share) / 2 - NODE / 2 / len) * 0.5
      const mid = put(a.x + (b.x - a.x) * (0.5 + shift), a.y + (b.y - a.y) * (0.5 + shift))
      cells.push({ x: mid.x, y: mid.y, role: 'body', sym: 'single', kind: link, size: (share * len * pitch) / extent(link), rot: Math.atan2(b.y - a.y, b.x - a.x), tone: NAME_TONE, at: at((a.x + b.x) / 2, (a.y + b.y) / 2), group: `name:${i}` })
    }
  }
  return { id: 'name', cells, seeds: [input.centre] }
}

const LEAD = 0.6
const LANE = 0.6
const BEND = 0.6
const AIR = 1.2
const VIA = 0.75
const PIN_SPAN = 0.8
const RISER_AIR = 1
function routesName(input: NameInput): ActPlan {
  const { width, height, pitchPx } = input
  const chip = input.chip ?? { x0: input.centre.x - 1, y0: input.centre.y - 1, x1: input.centre.x + 1, y1: input.centre.y + 1 }
  const c = { x: (chip.x0 + chip.x1) / 2, y: (chip.y0 + chip.y1) / 2 }
  const hw = (chip.x1 - chip.x0) / 2
  const hh = (chip.y1 - chip.y0) / 2
  const W = (width * (1 - 2 * NAME_MARGIN_X)) / pitchPx
  const H = (height * (1 - 2 * NAME_MARGIN_Y)) / pitchPx
  const split = (lines: string[]): number => (lines.length === 1 ? 1 : lines.length - 1)
  const lanes = (line: string | undefined): number => Math.ceil(Array.from(line ?? '').filter((ch) => ch !== ' ').length / 2)
  const gap = (line: string | undefined): number => LEAD + lanes(line) * LANE + 2 * BEND + AIR
  const shape = (lines: string[]): { rows: number; across: number } => {
    const above = split(lines)
    const below = lines.length - above
    const rows = above * ROWS - 1 + lines.slice(0, above - 1).reduce((n, l) => n + gap(l), 0) + gap(lines[above - 1]) + (below > 0 ? gap(lines[above]) + below * ROWS - 1 : 0)
    return { rows, across: Math.max(...lines.map(cols), ...lines.slice(1, above).map((l, k) => cols(l) + (2 * (RISER_AIR + lanes(lines[k]) * LANE)))) }
  }
  const fit = (lines: string[]): number => {
    const { rows, across } = shape(lines)
    return Math.max(1e-6, Math.min(W / across, (H - 2 * hh) / rows))
  }
  const { lines, pitch } = choose(input.name, fit, (pitchPx * PHONE) / width)
  const above = split(lines)
  const top: number[] = []
  const upEdge = c.y - hh
  const downEdge = c.y + hh
  for (let i = above - 1; i >= 0; i--) top[i] = i === above - 1 ? upEdge - gap(lines[above - 1]) * pitch - (ROWS - 1) * pitch : (top[i + 1] as number) - (ROWS - 1 + gap(lines[i])) * pitch
  if (lines.length > above) top[above] = downEdge + gap(lines[above]) * pitch
  const letters = lay(lines, pitch, c.x, top)
  const glyphs: Glyph[] = []
  const cells: Cell[] = []
  const order = letters.map((l, i) => ({ l, i }))
  const count = letters.length
  const trace = (pts: Vec2[], id: string, at: number, group: string): void => {
    const o = pts[0] as Vec2
    glyphs.push({ id, kind: 'mark', strokes: [pts.map((q) => ({ x: q.x - o.x, y: q.y - o.y }))] })
    cells.push({ x: o.x, y: o.y, role: 'body', sym: 'single', glyphId: id, size: 1, tone: 0.9, at, group })
  }
  const via = (p: Vec2, at: number, group: string): void => {
    cells.push({ x: p.x, y: p.y, role: 'body', sym: 'single', kind: 'ring', size: (VIA * pitch) / extent('ring'), tone: NAME_TONE, at, group })
  }
  const fan = (line: number, up: boolean): void => {
    const row = order.filter(({ l }) => l.line === line)
    const edge = up ? upEdge : downEdge
    const sign = up ? -1 : 1
    const m = row.length
    const pins = row.map((_, k) => c.x - PIN_SPAN * hw + (2 * PIN_SPAN * hw * (k + 0.5)) / m)
    const anchors = row.map(({ l }) => {
      const g = bits(l.ch)
      const r = up ? ROWS - 1 : 0
      const lit = Array.from(g[r] ?? '').flatMap((b, k) => (b === '#' ? [k] : []))
      const k = lit.reduce((a, b) => (Math.abs(b - 2) < Math.abs(a - 2) ? b : a), lit[0] ?? 2)
      return { x: l.x + k * pitch, y: l.y + r * pitch }
    })
    const lefts = row.map((_, k) => k).filter((k) => (anchors[k] as Vec2).x < (pins[k] as number) - 1e-6)
    const rights = row.map((_, k) => k).filter((k) => (anchors[k] as Vec2).x > (pins[k] as number) + 1e-6).reverse()
    const lane = new Map<number, number>()
    lefts.forEach((k, rank) => lane.set(k, rank))
    rights.forEach((k, rank) => lane.set(k, rank))
    const ys = (u: number): number => edge + sign * u * pitch
    for (const [k, { i }] of row.entries()) {
      const a = anchors[k] as Vec2
      const xp = pins[k] as number
      const dx = a.x - xp
      const dir = Math.sign(dx)
      const d = BEND * pitch
      const u = LEAD + (lane.get(k) ?? 0) * LANE
      const pts: Vec2[] = [{ x: xp, y: edge }]
      if (Math.abs(dx) < 1e-6) pts.push(a)
      else if (Math.abs(dx) < 2 * d) pts.push({ x: xp, y: ys(u) }, { x: a.x, y: ys(u) + sign * Math.abs(dx) }, a)
      else pts.push({ x: xp, y: ys(u) }, { x: xp + dir * d, y: ys(u) + sign * d }, { x: a.x - dir * d, y: ys(u) + sign * d }, { x: a.x, y: ys(u) + 2 * sign * d }, a)
      const t = i / count
      trace(pts, `name:trace:${i}`, t, `name:${i}`)
      via(a, t + 0.4 / count, `name:${i}`)
    }
  }
  const over = (line: number): void => {
    const mid = order.filter(({ l }) => l.line === line + 1)
    const x0 = Math.min(...mid.map(({ l }) => l.x))
    const x1 = Math.max(...mid.map(({ l }) => l.x)) + (COLS - 1) * pitch
    const d = BEND * pitch
    const anchors = order.filter(({ l }) => l.line === line).map(({ l, i }) => {
      const lit = Array.from(bits(l.ch)[ROWS - 1] ?? '').flatMap((b, k) => (b === '#' ? [k] : []))
      const k = lit.reduce((m, b) => (Math.abs(b - 2) < Math.abs(m - 2) ? b : m), lit[0] ?? 2)
      return { a: { x: l.x + k * pitch, y: l.y + (ROWS - 1) * pitch }, i }
    })
    const side = (group: typeof anchors, dir: number): void => {
      const n = group.length
      const edge = dir < 0 ? x0 : x1
      group.forEach(({ a, i }, k) => {
        const reach = edge + dir * (RISER_AIR + (n - 1 - k) * LANE) * pitch
        const rx = dir < 0 ? Math.min(reach, a.x) : Math.max(reach, a.x)
        const py = c.y - PIN_SPAN * hh + (2 * PIN_SPAN * hh * (n - 1 - k + 0.5)) / n
        const px = c.x + dir * hw
        const pts: Vec2[] = [{ x: px, y: py }, { x: rx - dir * d, y: py }, { x: rx, y: py - d }]
        if (Math.abs(a.x - rx) < 1e-6) pts.push(a)
        else {
          const ly = a.y + (LEAD + BEND + k * LANE) * pitch
          pts.push({ x: rx, y: ly + d }, { x: rx - dir * d, y: ly }, { x: a.x + dir * d, y: ly }, { x: a.x, y: ly - d }, a)
        }
        const t = (i + 0.5) / count
        trace(pts, `name:trace:${i}`, t, `name:${i}`)
        via(a, t + 0.4 / count, `name:${i}`)
      })
    }
    side(anchors.filter(({ a }) => a.x <= c.x), -1)
    side(anchors.filter(({ a }) => a.x > c.x).reverse(), 1)
  }
  fan(above - 1, true)
  if (lines.length > above) fan(above, false)
  for (let line = above - 2; line >= 0; line--) over(line)
  for (const { l, i } of order) {
    const id = `name:letter:${i}`
    glyphs.push({ id, kind: 'mark', strokes: letterSegments(l.ch).map(([p, q]) => [{ x: p.x * pitch, y: p.y * pitch }, { x: q.x * pitch, y: q.y * pitch }]) })
    cells.push({ x: l.x, y: l.y, role: 'body', sym: 'single', glyphId: id, size: 1, tone: NAME_TONE, at: (i + 0.5) / count, group: `name:${i}` })
  }
  return { id: 'name', cells, seeds: [c], glyphs }
}

export function nameAct(input: NameInput): ActPlan {
  return input.ending === 'routes' ? routesName(input) : partsName(input)
}
