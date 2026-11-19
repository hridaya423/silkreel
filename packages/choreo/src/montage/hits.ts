import { along, anchored, corners, pathLength, viewPoint } from './score'
import type { MontageTally, MontageAct, MontageGround, MontageHit, MontageInto, MontageJoin, MontageRect, MontageShot, MontageShotKind, MontageView, MontageWeight } from './types'

interface Pt { x: number; y: number }

export interface Stage {
  weight: MontageWeight
  W: number
  H: number
  fps: number
  total: number
  ground: MontageGround
  rot: number
  fitK: number
  coverK: number
  centre: Pt
  board: { x0: number; y0: number; x1: number; y1: number }
  hero: MontageRect
  start: Pt
  startR: number
  path: number[]
  length: number
  breaks: number[]
  layers: string[]
  end: Pt & { label: string; kind: string; light: Pt; led: boolean }
  close: MontageView
  arrival: MontageView
  poster: MontageView
  field: { centre: Pt; k: number } | undefined
  holeR: (p: Pt) => number
  viaNear: (p: Pt) => (Pt & { r: number }) | undefined
  tells: Tell[]
  count0: MontageView
  ruler: MontageView | undefined
  mm: number
  count: number
  unit: 'via' | 'pad'
  part: string
  feed: number[]
  feedPads: MontageRect[]
  ports: MontageRect[][]
  layerName: (id: string) => string
}

export interface Tell {
  kind: MontageAct
  score: number
  beats: number
  from: MontageView
  to: MontageView
  dot: Pt
  word?: string | undefined
  unit?: string | undefined
  tally?: MontageTally | undefined
  layers?: string[] | undefined
}

export const PRINT_BEAT = 18
export const NAME_BEAT = 19
export const FALL_BEAT = 2
export const FAN_START = 10
export const LIT = 92
const TELL = 0.45
const GLOW = 2.5
const PULL = 3.5
const WAKE = 1.5
const NAMED = 2
const CITY_BEATS = 4
const FIRST = 0.05
const HOLD = 3.5

export function fanSpan(n: number): number {
  return 70 / Math.max(1, n)
}

const AUTO: Record<MontageWeight, MontageJoin> = { route: 'dots', density: 'ascii', object: 'dither' }
const JOIN_FRAMES: Record<MontageInto, number> = { cut: 0, iris: 7, word: 7, whip: 5, zoom: 6 }

export function layHits(s: Stage): { shots: MontageShot[]; home: Pt; lit: number; landing: Pt } {
  const { W, H, rot, fitK } = s
  const min = Math.min(W, H)
  const beat = s.fps / 2
  const at = (b: number): number => Math.round(b * beat)
  const view = (p: Pt, k: number, r = rot): MontageView => anchored(p.x, p.y, k, r, { x: W / 2, y: H / 2 }, W, H)
  const keep = (v: MontageView, p: Pt, inner = 0.3): MontageView => {
    const q = viewPoint(v, p.x, p.y, W, H)
    const x = Math.min(W * (0.5 + inner), Math.max(W * (0.5 - inner), q.x))
    const y = Math.min(H * (0.5 + inner), Math.max(H * (0.5 - inner), q.y))
    return x === q.x && y === q.y ? v : anchored(p.x, p.y, v.k, v.rot, { x, y }, W, H)
  }
  const push = (v: MontageView, p: Pt, f: number): MontageView => {
    const q = viewPoint(v, p.x, p.y, W, H)
    return anchored(p.x, p.y, v.k * f, v.rot, q, W, H)
  }
  const box = (rects: MontageRect[], fill: number, r = rot): MontageView => {
    const pts = rects.flatMap(corners)
    const c = Math.cos(r)
    const sn = Math.sin(r)
    const tx = pts.map((p) => c * p.x - sn * p.y)
    const ty = pts.map((p) => sn * p.x + c * p.y)
    const w = Math.max(1e-6, Math.max(...tx) - Math.min(...tx))
    const h = Math.max(1e-6, Math.max(...ty) - Math.min(...ty))
    const mid = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length }
    return view(mid, Math.min((fill * W) / w, (fill * H) / h, 60 * fitK), r)
  }
  const head = (d: number): Pt => along(s.path, d)
  const L = s.length
  const base: Omit<MontageHit, 'from' | 'to'> = { whip: false, word: undefined, into: 'cut', at: s.start, r: 0, frames: 0, out: 0, follow: false, pin: false, ease: false, invert: 0, spot: undefined, unit: undefined, clear: false, join: undefined, flood: false, layer: s.layers[0] as string, route: [0, 0], path: 'route', clock: [0, 0], count: undefined, tally: undefined, act: undefined, plug: false, ruler: false, dot: s.start, light: false, climax: undefined }
  type Draft = { kind: MontageShotKind; beats: number; hit: Partial<MontageHit> & { from: MontageView } }
  const acts: Draft[] = []
  const add = (kind: MontageShotKind, beats: number, hit: Partial<MontageHit> & { from: MontageView }): void => {
    acts.push({ kind, beats, hit })
  }
  const sentence = (label: string): string[] => {
    const parts = label.split(/\s+/).filter((w) => w.length > 0)
    if (parts.length <= 1) return [`${label}.`]
    return [parts[0] as string, `${parts.slice(1).join(' ')}.`]
  }
  const part = s.part.length <= 18 ? s.part : undefined
  const turn = rot + Math.PI / 2
  const kRun = Math.max(3.4 * fitK, 1.8 * s.close.k)
  let home: Pt = s.start
  let tail = 0
  let landed: MontageView | undefined

  const beatsSoFar = (): number => FALL_BEAT + acts.reduce((t, d) => t + d.beats, 0)
  const pull = (anchor: Pt, k0: number, end: MontageView, k1: number, beats: number[], extra: (i: number, n: number, from: MontageView, to: MontageView) => Partial<MontageHit>): void => {
    const n = beats.length
    const target = viewPoint(end, anchor.x, anchor.y, W, H)
    const vs = Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n
      const k = Math.exp(Math.log(k0) + (Math.log(k1) - Math.log(k0)) * t)
      const e = t ** 1.5
      return anchored(anchor.x, anchor.y, k, rot, { x: 0.5 * W * (1 - e) + target.x * e, y: 0.5 * H * (1 - e) + target.y * e }, W, H)
    })
    beats.forEach((bt, i) => {
      acts.push({ kind: 'step', beats: bt, hit: { from: vs[i] as MontageView, to: vs[i + 1] as MontageView, into: i === 0 ? 'zoom' : 'cut', at: anchor, ease: true, ...extra(i, n, vs[i] as MontageView, vs[i + 1] as MontageView) } })
    })
  }
  const split = (room: number): number[] => {
    const n = Math.max(1, Math.floor(room))
    return Array.from({ length: n }, (_, i) => (i === 0 ? room - (n - 1) : 1))
  }
  const hold = (hit: Partial<MontageHit> & { from: MontageView }): void => {
    acts.push({ kind: 'hold', beats: PRINT_BEAT - beatsSoFar(), hit: { to: hit.from, clock: [LIT, LIT], ...hit } })
  }

  const told = (kind: MontageAct): Tell | undefined => s.tells.find((t) => t.kind === kind && t.score > -9)

  if (s.weight === 'route') {
    const light = s.end.led ? s.end.light : { x: s.end.x, y: s.end.y }
    home = light
    const kPad = Math.min((0.2 * min) / (2 * s.startR), 2.8 * s.close.k)
    const stub = Math.min(0.05 * L, s.breaks[1] ?? L)
    const layered = s.layers.length > 1
    add('pad', 0.5, { from: view(s.start, kPad), to: push(view(s.start, kPad), s.start, 1.25), route: [0, stub], dot: 'head', into: 'zoom', at: s.start })
    add('chip', NAMED, { from: s.close, to: push(s.close, s.start, 1.08), route: [stub, stub], dot: s.start, word: part, join: AUTO.route, into: 'zoom', at: s.start })
    const runs = s.layers.slice(0, 3)
    for (const [i, layer] of runs.entries()) {
      const a = i === 0 ? stub : (s.breaks[i] as number)
      const z = i === runs.length - 1 ? L : (s.breaks[i + 1] as number)
      if (z - a < 1e-6 && i > 0) continue
      const flood = i === 1
      const via = head(a)
      add(flood ? 'layer' : 'run', flood ? 2 : layered ? 0.5 : 1, { from: view(head(a), kRun, flood ? turn : rot), to: view(head(z), kRun, flood ? turn : rot), route: [a, z], dot: 'head', follow: true, flood, layer, word: flood ? s.layerName(layer) : undefined, into: i === 0 ? 'zoom' : 'iris', at: i === 0 ? s.start : via, r: i === 0 ? 0 : s.holeR(via) })
    }
    const words = sentence(s.end.label)
    const ride = words.length > 1
    add('arrival', 1.5, { from: s.arrival, to: push(s.arrival, light, 1.1), route: [L, L], dot: light, word: words[0], into: 'iris', at: { x: s.end.x, y: s.end.y } })
    const copper = told('copper')
    const pullBeats = copper === undefined ? 0 : PULL
    const rideBeats = PRINT_BEAT - beatsSoFar() - GLOW - pullBeats
    const lamp = { x: light.x, y: light.y, w: 0, h: 0, rot: 0 }
    const pair = box([s.hero, lamp], 0.55)
    const mid = anchored(pair.cx, pair.cy, pair.k, rot, W > H ? { x: 0.6 * W, y: 0.5 * H } : { x: 0.5 * W, y: 0.38 * H }, W, H)
    const steps = [Math.min(1.5, rideBeats), ...split(Math.max(0, rideBeats - 1.5))].filter((b) => b > 1e-9)
    pull(light, s.arrival.k / 1.15, mid, mid.k, steps, (i) => ({ dot: light, route: [L, L], word: ride ? words[1] : undefined, pin: true, into: i === 0 ? 'zoom' : 'cut' }))
    const lit = push(mid, light, 1.05)
    add('lamp', copper === undefined ? PRINT_BEAT - beatsSoFar() : GLOW, { from: mid, to: lit, climax: 'lamp', light: true, route: [L, L], dot: light, word: words.join(' '), pin: true, into: 'cut', at: light })
    const hub = { x: s.hero.x, y: s.hero.y }
    const spread = push(lit, hub, 0.86)
    landed = push(spread, hub, 0.96)
    if (copper !== undefined) add('copper', pullBeats, { from: lit, to: spread, climax: 'lamp', act: 'copper', light: true, route: [L, L], dot: light, unit: copper.unit, tally: copper.tally, count: [0, 1], pin: true, clock: [0, 0], into: 'cut', ease: true, at: light })
  } else if (s.weight === 'density') {
    home = s.end.kind !== 'other' ? { x: s.end.x, y: s.end.y } : head(L)
    add('chip', NAMED, { from: s.close, to: push(s.close, s.start, 1.08), word: part, join: AUTO.density, into: 'zoom', at: s.start })
    add('run', 0.5, { from: view(s.start, kRun), to: view(head(L), kRun), route: [0, L], dot: 'head', follow: true, into: 'zoom', at: s.start })
    const said = s.end.kind !== 'other' ? sentence(s.end.label).join(' ').replace(/\.(?=.)/, '') : undefined
    add('arrival', 1.5, { from: s.arrival, to: push(s.arrival, home, 1.1), route: [L, L], dot: home, word: said, into: 'iris', at: home })
    const stack = told('stack')
    const layers = stack !== undefined && stack.score >= TELL ? (stack.layers ?? []).slice(0, 4) : []
    const tally = { total: s.count, digits: 0, suffix: '' }
    const city = (u: number): MontageView => push(s.count0, s.centre, 1 + 0.03 * u)
    const per = layers.length > 0 && PRINT_BEAT - beatsSoFar() - 2 - 1.5 * layers.length >= CITY_BEATS ? 1.5 : layers.length > 0 ? 1 : 0
    const count = PRINT_BEAT - beatsSoFar() - per * layers.length - 2
    add('count', count, { from: city(0), to: city(0.5), climax: 'city', count: [FIRST, 1], tally, clear: true, dot: home, route: [L, L], into: 'cut', at: home })
    layers.forEach((layer, i) => {
      add('stack', per, { from: city(0.5 + (0.5 * i) / layers.length), to: city(0.5 + (0.5 * (i + 1)) / layers.length), climax: 'city', act: 'stack', layer, word: stack?.word, clear: true, dot: home, route: [L, L], into: 'cut', at: home })
    })
    hold({ from: s.count0, to: push(s.count0, s.centre, 1.02), dot: home, route: [L, L], word: `${s.count} ${s.unit === 'via' ? 'VIAS' : 'PADS'}.`, clear: true, flood: true, count: [1, 1], tally, into: 'cut', at: home })
  } else {
    const ruler = s.ruler ?? s.poster
    const feedLen = pathLength(s.feed)
    const mm = `${s.mm.toFixed(1)} MM.`
    const hub = { x: s.hero.x, y: s.hero.y }
    let mid = hub
    if (s.feedPads.length > 0 && s.feed.length >= 4) {
      const plug = box(s.feedPads, 0.8)
      mid = { x: plug.cx, y: plug.cy }
      add('ruler', 2, { from: ruler, to: ruler, ruler: true, word: mm, dot: mid, into: 'cut', at: mid })
      add('plug', 0.5, { from: plug, to: push(plug, mid, 1.08), dot: mid, into: 'zoom', at: mid })
      add('plug', 1.5, { from: push(plug, mid, 1.45), to: push(plug, mid, 1.6), dot: mid, plug: true, word: '1 PLUG.', into: 'zoom', at: mid })
    } else add('ruler', 2, { from: ruler, to: ruler, ruler: true, word: mm, dot: hub, into: 'cut', at: hub })
    const n = Math.min(s.ports.length, 9)
    home = hub
    if (n > 0) {
      tail = FAN_START + n * fanSpan(n)
      const wide = (u: number): MontageView => push(ruler, hub, 1 + 0.04 * u)
      const split: Partial<MontageHit> = { climax: 'split', plug: true, dot: hub, at: hub }
      if (s.feedPads.length > 0 && s.feed.length >= 4) add('fan', 1, { ...split, from: wide(0), to: wide(0.1), path: 'feed', route: [0, feedLen], clock: [0, FAN_START], dot: 'head', into: 'zoom', at: mid })
      add('pins', WAKE, { ...split, from: wide(0.1), to: wide(0.25), act: 'pins', clock: [FAN_START, FAN_START], into: beatsSoFar() > 6.5 ? 'cut' : 'zoom' })
      add('fan', PRINT_BEAT - beatsSoFar() - HOLD, { ...split, from: wide(0.25), to: wide(0.75), clock: [FAN_START, tail], into: 'cut' })
      hold({ ...split, from: wide(0.75), to: wide(1), clock: [tail, tail], word: `${s.ports.length} ${s.ports.length === 1 ? 'PORT' : 'PORTS'}.`, into: 'cut' })
    } else hold({ from: ruler, plug: true, dot: hub, word: mm, ruler: true, into: 'zoom', at: hub })
  }

  const landing = acts[0]?.hit.at ?? s.start
  const inside = (v: MontageView): MontageView => {
    if (v.k < s.coverK) return v
    const c = Math.cos(v.rot)
    const sn = Math.sin(v.rot)
    const turned = [[s.board.x0, s.board.y0], [s.board.x1, s.board.y0], [s.board.x1, s.board.y1], [s.board.x0, s.board.y1]].map(([x, y]) => ({ x: c * (x as number) - sn * (y as number), y: sn * (x as number) + c * (y as number) }))
    const lo = { x: Math.min(...turned.map((p) => p.x)), y: Math.min(...turned.map((p) => p.y)) }
    const hi = { x: Math.max(...turned.map((p) => p.x)), y: Math.max(...turned.map((p) => p.y)) }
    const t = { x: c * v.cx - sn * v.cy, y: sn * v.cx + c * v.cy }
    const hw = W / 2 / v.k
    const hh = H / 2 / v.k
    const clamp = (q: number, a: number, b: number, half: number): number => (b - a <= 2 * half ? (a + b) / 2 : Math.min(b - half, Math.max(a + half, q)))
    const x = clamp(t.x, lo.x, hi.x, hw)
    const y = clamp(t.y, lo.y, hi.y, hh)
    return { ...v, cx: c * x + sn * y, cy: -sn * x + c * y }
  }
  const scale = s.fps / 30
  const shots: MontageShot[] = []
  let b = FALL_BEAT
  let prev: MontageView = view(s.centre, fitK)
  let textured = -Infinity
  const room2 = (last: MontageShot | undefined): number => (last === undefined ? Math.round(8 * scale) : Math.floor(0.6 * (last.f1 - last.f0)))
  for (const d of acts) {
    const hit: MontageHit = { ...base, to: d.hit.from, ...d.hit }
    const fix = (v: MontageView): MontageView => (hit.dot === 'head' || hit.act !== undefined ? v : keep(inside(v), hit.dot, 0.4))
    hit.from = fix(hit.from)
    hit.to = fix(hit.to)
    const ratio = hit.from.k / prev.k
    if (hit.into === 'zoom' && ratio <= 1 / 3 && shots.at(-1)?.hit?.act !== undefined) hit.into = 'cut'
    if (hit.join === undefined && hit.invert === 0 && hit.count === undefined && hit.into === 'zoom' && d.beats >= 1 && Math.max(ratio, 1 / ratio) >= 3.5 && b - textured >= 2) hit.join = AUTO[s.weight]
    if (hit.join !== undefined) textured = b
    const last = shots.at(-1)
    hit.frames = Math.min(room2(last), Math.round(JOIN_FRAMES[hit.into] * scale))
    if (last?.hit !== undefined) last.hit.out = hit.frames
    shots.push({ kind: d.kind, f0: at(b), f1: at(b + d.beats), ground: hit.flood ? 'spot' : hit.climax === 'lamp' || hit.climax === 'city' ? 'black' : s.ground, carry: 'move', hit })
    prev = hit.to
    b += d.beats
  }
  const lastStep = shots.at(-1)
  const object = s.weight === 'object'
  const settled = lastStep?.hit?.act === 'copper' && landed !== undefined
  const straight = settled || (s.weight === 'density' && lastStep?.hit?.flood === true)
  const print: MontageHit = {
    ...base,
    from: settled ? (lastStep.hit as MontageHit).to : s.poster,
    to: settled ? (landed as MontageView) : push(s.poster, home, 1.04),
    ease: settled,
    clock: [LIT, 100],
    dot: home,
    light: s.end.led && s.weight === 'route',
    plug: object,
    route: object ? [0, 0] : [L, L],
    into: straight ? 'cut' : 'zoom',
    at: home,
    frames: straight ? 0 : Math.min(room2(lastStep), Math.round(10 * scale))
  }
  if (lastStep?.hit !== undefined) lastStep.hit.out = print.frames
  shots.push({ kind: 'print', f0: at(b), f1: at(NAME_BEAT), ground: s.ground, carry: 'move', hit: print })
  return { shots, home, lit: tail, landing }
}
