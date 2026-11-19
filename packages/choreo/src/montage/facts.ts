import { boardTitle } from '../board-title'
import type { BoardModel, Pad, Vec2 } from '@silk-reel/ingest'
import { boardFacts } from '../trace/facts'
import { bareName, netKind } from '../trace/nets'
import type { NetKind } from '../trace/nets'
import { extractParts } from '../trace/parts'
import { pickHero } from '../trace/hero'
import { partNumber } from '../trace/scene'
import type { CastHints, PartKind, TitleCard, TraceScene } from '../types'
import type { MontageDot, MontageInk } from './types'

export type Affine = [number, number, number, number, number, number]

export const apply = (m: Affine, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] })

const AUTO = /^(Net-\(|unconnected-|net\d+$)/i

function solve3(a: number[][], b: number[]): number[] {
  const m = a.map((row, i) => [...row, b[i] as number])
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs((m[r] as number[])[c] as number) > Math.abs((m[piv] as number[])[c] as number)) piv = r
    ;[m[c], m[piv]] = [m[piv] as number[], m[c] as number[]]
    const row = m[c] as number[]
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const other = m[r] as number[]
      const k = (other[c] as number) / (row[c] as number)
      for (let j = c; j < 4; j++) other[j] = (other[j] as number) - k * (row[j] as number)
    }
  }
  return m.map((row, i) => (row[3] as number) / (row[i] as number))
}

export function boardToScene(board: BoardModel, scene: TraceScene): Affine {
  const unique = new Map<string, Pad>()
  for (const copper of Object.values(board.copper)) for (const pad of copper.pads) if (!unique.has(pad.id)) unique.set(pad.id, pad)
  const all = [...unique.values()]
  const bare = new Set(board.drill.filter((d) => !d.plated).map((d) => all.find((pad) => Math.hypot(d.pos.x - pad.pos.x, d.pos.y - pad.pos.y) < 0.05 && Math.max(pad.size.x, pad.size.y) <= d.dia + 0.05)))
  const pads = all.filter((pad) => !bare.has(pad))
  const n = Math.min(pads.length, scene.pads.length)
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const bx = [0, 0, 0]
  const by = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const p = (pads[i] as Pad).pos
    const q = scene.pads[i] as { x: number; y: number }
    const v = [p.x, p.y, 1]
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) (ata[r] as number[])[c] = ((ata[r] as number[])[c] as number) + (v[r] as number) * (v[c] as number)
      bx[r] = (bx[r] as number) + (v[r] as number) * q.x
      by[r] = (by[r] as number) + (v[r] as number) * q.y
    }
  }
  const [a, b, c] = solve3(ata, bx) as [number, number, number]
  const [d, e, f] = solve3(ata, by) as [number, number, number]
  return [a, b, c, d, e, f]
}

function hsl(hex: string): [number, number, number] {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const hi = Math.max(...v)
  const lo = Math.min(...v)
  const l = (hi + lo) / 2
  const d = hi - lo
  if (d < 1e-6) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  const [r, g, b] = v
  const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

function hex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
}

const chromatic = (c: string): boolean => {
  const [, s, l] = hsl(c)
  return s > 0.22 && l > 0.08 && l < 0.92
}

export const lightMask = (scene: TraceScene): boolean => hsl(scene.material.mask)[2] > 0.55

export const COPPER_HUE = 18

export function filmInk(scene: TraceScene): { ink: MontageInk; base: 'paper' | 'black' } {
  const m = scene.material
  const neutral = !chromatic(m.mask)
  const [h, s] = neutral ? [COPPER_HUE, 0.8] : hsl(m.mask)
  const l = h > 40 && h < 75 ? 0.5 : h >= 75 && h < 170 ? 0.4 : 0.52
  return {
    ink: { paper: '#efede6', black: '#121212', spot: hex(h, Math.min(0.9, Math.max(0.68, s)), l) },
    base: neutral && hsl(m.mask)[2] < 0.5 ? 'black' : 'paper'
  }
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-12, dx * dx + dy * dy)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

export interface Holes {
  unit: 'via' | 'pad'
  points: Array<{ pos: Vec2; r: number }>
  dot: { pos: Vec2; r: number; drill: number | undefined; net: string | undefined }
}

export function chooseDot(board: BoardModel, hints: CastHints | undefined, heroRef: string | undefined): Holes {
  const hero = pickHero(board, hints, heroRef)
  const centre = hero?.center ?? { x: (board.bbox.min.x + board.bbox.max.x) / 2, y: (board.bbox.min.y + board.bbox.max.y) / 2 }
  const netName = (id: number | undefined): string | undefined => {
    const n = board.nets.find((x) => x.id === id)?.name
    return n === undefined || n.length === 0 ? undefined : bareName(n)
  }
  const vias = [...new Map(Object.values(board.copper).flatMap((c) => c.vias).map((v) => [v.id, v])).values()]
  if (vias.length === 0) {
    const pads = [...new Map(Object.values(board.copper).flatMap((c) => c.pads).map((p) => [p.id, p])).values()]
    const own = pads.filter((p) => p.footprintRef === hero?.ref)
    const pin: Pad = own.find((p) => p.num === '1') ?? own[0] ?? (pads[0] as Pad)
    return {
      unit: 'pad',
      points: pads.map((p) => ({ pos: p.pos, r: Math.min(p.size.x, p.size.y) / 2 })),
      dot: { pos: pin.pos, r: Math.min(pin.size.x, pin.size.y) / 2, drill: board.drill.find((d) => Math.hypot(d.pos.x - pin.pos.x, d.pos.y - pin.pos.y) < 0.05)?.dia, net: netName(pin.netId) }
    }
  }
  const segs = Object.values(board.copper).flatMap((c) => c.traces.flatMap((t) => t.points.slice(1).map((b, i) => ({ a: t.points[i] as Vec2, b, w: t.width }))))
  const pads = Object.values(board.copper).flatMap((c) => c.pads)
  const clearance = vias.map((v) => {
    const r = v.dia / 2
    let c = Infinity
    for (const o of vias) if (o !== v) c = Math.min(c, Math.hypot(o.pos.x - v.pos.x, o.pos.y - v.pos.y) - o.dia / 2 - r)
    for (const p of pads) c = Math.min(c, Math.hypot(p.pos.x - v.pos.x, p.pos.y - v.pos.y) - Math.max(p.size.x, p.size.y) / 2 - r)
    for (const s of segs) {
      if (Math.hypot(s.a.x - v.pos.x, s.a.y - v.pos.y) < r || Math.hypot(s.b.x - v.pos.x, s.b.y - v.pos.y) < r) continue
      c = Math.min(c, segDist(v.pos, s.a, s.b) - s.w / 2 - r)
    }
    return c
  })
  const near = (i: number): number => Math.hypot((vias[i] as { pos: Vec2 }).pos.x - centre.x, (vias[i] as { pos: Vec2 }).pos.y - centre.y)
  const idx = vias.map((_, i) => i)
  const free = idx.filter((i) => (clearance[i] as number) >= 0.8 * (vias[i] as { dia: number }).dia)
  const pick = free.length > 0 ? free.sort((a, b) => near(a) - near(b))[0] as number : idx.sort((a, b) => (clearance[b] as number) - (clearance[a] as number))[0] as number
  const v = vias[pick] as (typeof vias)[number]
  return { unit: 'via', points: vias.map((x) => ({ pos: x.pos, r: x.dia / 2 })), dot: { pos: v.pos, r: v.dia / 2, drill: v.drill, net: netName(v.netId) } }
}

export function placeDot(holes: Holes, map: Affine, scale: number): MontageDot {
  const p = apply(map, holes.dot.pos)
  return { x: p.x, y: p.y, r: holes.dot.r * scale, mm: holes.dot.pos, drill: holes.dot.drill, net: holes.dot.net }
}

export function filmWords(board: BoardModel, title: TitleCard | undefined): { name: string; version: string | undefined; footer: [string, string]; parts: number } {
  const facts = boardFacts(board)
  const { name, revision: version } = boardTitle(board, { title })
  return {
    name,
    version,
    footer: [version === undefined ? name : `${name} ${version}`, `${facts.copperLayers} layers  ${facts.widthMm.toFixed(1)}×${facts.heightMm.toFixed(1)} mm`],
    parts: facts.parts
  }
}

export function heroLabel(board: BoardModel, heroRef: string | undefined): string {
  const fp = board.footprints.find((f) => f.ref === heroRef)
  const value = fp?.value?.replace(/^[A-Za-z]+_(?=\S)/, '')
  return partNumber(value) ?? value ?? heroRef ?? board.source.boardName
}

export interface NetGraph {
  id: number
  name: string
  kind: NetKind
  at: Map<string, Vec2>
  adj: Map<string, number[]>
  edges: Array<[string, string]>
  layers: string[]
  vias: Set<string>
}

export const keyOf = (p: Vec2): string => `${Math.round(p.x * 50)},${Math.round(p.y * 50)}`

export function netGraphs(board: BoardModel): NetGraph[] {
  const graphs = new Map<number, NetGraph>()
  const graph = (id: number): NetGraph => {
    let g = graphs.get(id)
    if (g === undefined) {
      const name = bareName(board.nets.find((n) => n.id === id)?.name ?? '')
      g = { id, name, kind: netKind(name), at: new Map(), adj: new Map(), edges: [], layers: [], vias: new Set() }
      graphs.set(id, g)
    }
    return g
  }
  for (const [layer, copper] of Object.entries(board.copper)) {
    for (const t of copper.traces) {
      if (t.netId === undefined) continue
      const g = graph(t.netId)
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1] as Vec2
        const b = t.points[i] as Vec2
        const ka = keyOf(a)
        const kb = keyOf(b)
        if (ka === kb) continue
        g.at.set(ka, a)
        g.at.set(kb, b)
        g.adj.set(ka, [...(g.adj.get(ka) ?? []), g.edges.length])
        g.adj.set(kb, [...(g.adj.get(kb) ?? []), g.edges.length])
        g.edges.push([ka, kb])
        g.layers.push(layer)
      }
    }
    for (const v of copper.vias) if (v.netId !== undefined && graphs.has(v.netId)) graph(v.netId).vias.add(keyOf(v.pos))
  }
  return [...graphs.values()].filter((g) => g.edges.length > 0)
}

export function nearestNode(g: NetGraph, p: Vec2, within: number): string | undefined {
  let best: string | undefined
  let d = within
  for (const [k, q] of g.at) {
    const e = Math.hypot(q.x - p.x, q.y - p.y)
    if (e <= d) {
      d = e
      best = k
    }
  }
  return best
}

export function walkNet(g: NetGraph, start: string | undefined): { points: Vec2[]; events: number } {
  const tries = start !== undefined ? [start] : [...g.adj].filter(([, e]) => e.length === 1).map(([k]) => k).slice(0, 8)
  if (tries.length === 0) tries.push((g.edges[0] as [string, string])[0])
  let best = { points: [] as Vec2[], events: 0, length: -1 }
  for (const s of tries) {
    const used = new Set<number>()
    let node = s
    const keys = [s]
    let heading: number | undefined
    let turns = 0
    let length = 0
    for (;;) {
      const here = g.at.get(node) as Vec2
      let pick: { i: number; next: string; a: number; turn: number } | undefined
      for (const i of g.adj.get(node) ?? []) {
        if (used.has(i)) continue
        const [ka, kb] = g.edges[i] as [string, string]
        const next = ka === node ? kb : ka
        const q = g.at.get(next) as Vec2
        const a = Math.atan2(q.y - here.y, q.x - here.x)
        const turn = heading === undefined ? 0 : Math.abs(Math.atan2(Math.sin(a - heading), Math.cos(a - heading)))
        if (pick === undefined || turn < pick.turn) pick = { i, next, a, turn }
      }
      if (pick === undefined) break
      used.add(pick.i)
      if (pick.turn > 0.25) turns++
      const q = g.at.get(pick.next) as Vec2
      length += Math.hypot(q.x - here.x, q.y - here.y)
      heading = pick.a
      node = pick.next
      keys.push(node)
    }
    if (length > best.length) best = { points: keys.map((k) => g.at.get(k) as Vec2), events: turns + keys.filter((k) => g.vias.has(k)).length, length }
  }
  return { points: best.points, events: best.events }
}

export function heroPins(board: BoardModel, heroRef: string | undefined): Array<{ pos: Vec2; netId: number | undefined; name: string; num: string }> {
  const pads = [...new Map(Object.values(board.copper).flatMap((c) => c.pads).filter((p) => p.footprintRef === heroRef).map((p) => [p.id, p])).values()]
  return pads.map((p) => ({ pos: p.pos, netId: p.netId, name: bareName(board.nets.find((n) => n.id === p.netId)?.name ?? '') || (p.num ?? ''), num: p.num ?? '' }))
}

export function layerLabels(board: BoardModel): Array<{ id: string; label: string }> {
  const ids = Object.keys(board.copper).filter((id) => /\.Cu$/.test(id))
  const rank = (id: string): number => (id.startsWith('F.') ? -1 : id.startsWith('B.') ? 99 : Number(/\d+/.exec(id)?.[0] ?? 50))
  return ids.sort((a, b) => rank(a) - rank(b)).map((id) => {
    const own = board.layerNames?.[id]
    const zones = (board.copper[id]?.zones ?? []).map((z) => bareName(board.nets.find((n) => n.id === z.netId)?.name ?? '')).filter((n) => n.length > 0)
    const pour = zones.sort((a, b) => zones.filter((z) => z === b).length - zones.filter((z) => z === a).length)[0]
    const extra = own ?? (id.startsWith('In') ? pour : undefined)
    return { id, label: extra === undefined ? id.toUpperCase() : `${id.toUpperCase()} ${extra.toUpperCase()}` }
  })
}

export interface RouteChoice {
  net: string
  points: Vec2[]
  layers: string[]
  start: Vec2
  end: { ref: string; label: string; kind: PartKind; pos: Vec2 }
  score: number
}

const ENDING: Record<PartKind, number> = { conn: 4, led: 5, switch: 3, ic: 2, xtal: 2, can: 2, valve: 2, other: 1, diode: 1, res: 0, cap: 0, ind: 0, pin: 0 }

interface Reach { start: string; dist: Map<string, number>; via: Map<string, number> }

function reach(g: NetGraph, start: string): Reach {
  const dist = new Map<string, number>([[start, 0]])
  const via = new Map<string, number>()
  const open = new Set([start])
  while (open.size > 0) {
    const node = [...open].reduce((a, b) => ((dist.get(a) as number) <= (dist.get(b) as number) ? a : b))
    open.delete(node)
    const here = g.at.get(node) as Vec2
    for (const i of g.adj.get(node) ?? []) {
      const [ka, kb] = g.edges[i] as [string, string]
      const next = ka === node ? kb : ka
      const q = g.at.get(next) as Vec2
      const d = (dist.get(node) as number) + Math.hypot(q.x - here.x, q.y - here.y)
      if (d < (dist.get(next) ?? Infinity)) {
        dist.set(next, d)
        via.set(next, i)
        open.add(next)
      }
    }
  }
  return { start, dist, via }
}

function pathTo(g: NetGraph, r: Reach, node: string): { points: Vec2[]; layers: string[]; length: number } {
  const keys: string[] = [node]
  const layers: string[] = []
  while (keys[0] !== r.start) {
    const i = r.via.get(keys[0] as string) as number
    const [ka, kb] = g.edges[i] as [string, string]
    layers.unshift(g.layers[i] as string)
    keys.unshift(ka === keys[0] ? kb : ka)
  }
  return { points: keys.map((k) => g.at.get(k) as Vec2), layers, length: r.dist.get(node) as number }
}

interface Reached { g: NetGraph; pin: Vec2; pad: Pad; part: ReturnType<typeof extractParts>[number]; path: { points: Vec2[]; layers: string[]; length: number } }

function reachedPads(board: BoardModel, heroRef: string | undefined, graphs: NetGraph[]): Reached[] {
  const parts = new Map(extractParts(board).map((p) => [p.ref, p]))
  const pads = [...new Map(Object.values(board.copper).flatMap((c) => c.pads).map((p) => [p.id, p])).values()]
  const out: Reached[] = []
  for (const pin of heroPins(board, heroRef)) {
    const g = graphs.find((x) => x.id === pin.netId)
    if (g === undefined || g.kind === 'ground') continue
    const start = nearestNode(g, pin.pos, 0.6)
    if (start === undefined) continue
    const r = reach(g, start)
    for (const pad of pads) {
      if (pad.netId !== g.id || pad.footprintRef === undefined || pad.footprintRef === heroRef) continue
      const part = parts.get(pad.footprintRef)
      const node = nearestNode(g, pad.pos, Math.max(pad.size.x, pad.size.y) / 2 + 0.2)
      if (part === undefined || node === undefined || !r.dist.has(node) || node === start) continue
      out.push({ g, pin: pin.pos, pad, part, path: pathTo(g, r, node) })
    }
  }
  return out
}

export function chooseRoute(board: BoardModel, heroRef: string | undefined, graphs: NetGraph[]): RouteChoice | undefined {
  const facts = boardFacts(board)
  const long = Math.max(facts.widthMm, facts.heightMm)
  let best: RouteChoice | undefined
  for (const { g, pin, pad, part, path } of reachedPads(board, heroRef, graphs)) {
    const flips = path.layers.filter((l, i) => i > 0 && l !== path.layers[i - 1]).length
    const reachShare = path.length / long
    const plain = /^(JP|TP)\d/i.test(part.ref) || /jumper|test ?point/i.test(part.value ?? '')
    const score = 10 * (plain ? 1 : ENDING[part.kind]) + (g.kind === 'power' ? 0 : 6) - (AUTO.test(g.name) ? 8 : 0) + 3 * Math.min(2, flips) + (reachShare >= 0.25 && reachShare <= 1.4 ? 4 : 2 * Math.min(1, reachShare / 0.25))
    if (best !== undefined && score <= best.score) continue
    best = { net: g.name.replace(/^Net-\((.*)\)$/, '$1'), points: path.points, layers: path.layers, start: pin, end: { ref: part.ref, label: placeName(part.kind, part.ref, part.value, board.footprints.find((f) => f.ref === part.ref)?.footprint), kind: part.kind, pos: pad.pos }, score }
  }
  return best
}

const COLOURS: Array<[RegExp, string]> = [[/\b(R|RED)\b/, 'RED'], [/\b(G|GRN|GREEN)\b/, 'GREEN'], [/\b(B|BLU|BLUE)\b/, 'BLUE'], [/\b(W|WHT|WHITE)\b/, 'WHITE'], [/\b(Y|YEL|YELLOW)\b/, 'YELLOW'], [/\b(AMB|AMBER)\b/, 'AMBER'], [/\b(ORG|ORANGE)\b/, 'ORANGE'], [/\bIR\b/, 'INFRARED'], [/\bRGB\b/, 'RGB']]
const PORTS: Array<[RegExp, string]> = [[/USB/, 'USB PORT'], [/HDMI/, 'HDMI PORT'], [/RJ45|ETHERNET|8P8C/, 'ETHERNET PORT'], [/MICRO.?SD|\bSD\b|SDCARD/, 'SD CARD SLOT'], [/AUDIO|TRRS|\bTRS\b|PHONE.?JACK/, 'AUDIO JACK'], [/BARREL|\bDC\b|POWER.?JACK/, 'POWER JACK'], [/PMOD/, 'PMOD PORT'], [/PIN.?HEADER|PINHEADER|IDC|CONN_\d+X\d+|\d+X\d+/, 'HEADER']]

export function placeName(kind: PartKind, ref: string, value: string | undefined, footprint: string | undefined): string {
  const v = (value ?? '').toUpperCase().replace(/[_-]/g, ' ')
  if (kind === 'led') return `${COLOURS.find(([re]) => re.test(v))?.[1] ?? ''} LED`.trim()
  if (kind === 'conn') {
    const text = `${v} ${(footprint ?? '').toUpperCase().replace(/[_-]/g, ' ')}`
    const port = PORTS.find(([re]) => re.test(text))?.[1] ?? 'CONNECTOR'
    const n = port === 'USB PORT' ? /USB\s*(\d+)$/.exec(v)?.[1] : undefined
    return n === undefined ? port : `${port} ${n}`
  }
  if (kind === 'ic') return partNumber(value) ?? ref
  return ref
}

export function fanRoutes(board: BoardModel, heroRef: string | undefined, graphs: NetGraph[]): { routes: Array<{ net: number; ref: string; points: Vec2[] }>; inputs: Array<{ net: number; ref: string; points: Vec2[] }> } {
  const prints = new Map(board.footprints.map((f) => [f.ref, f.footprint ?? f.value ?? '']))
  const best = new Map<string, Reached>()
  for (const r of reachedPads(board, heroRef, graphs)) {
    if (r.part.kind !== 'conn' || r.g.kind === 'power') continue
    const was = best.get(r.part.ref)
    if (was === undefined || r.path.length < was.path.length) best.set(r.part.ref, r)
  }
  const groups = new Map<string, Reached[]>()
  for (const r of best.values()) {
    const key = prints.get(r.part.ref) ?? ''
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const fan = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? []
  if (fan.length < 3) return { routes: [], inputs: [] }
  const refs = new Set(fan.map((r) => r.part.ref))
  return { routes: fan.sort((a, b) => a.part.ref.localeCompare(b.part.ref, undefined, { numeric: true })).map((r) => ({ net: r.g.id, ref: r.part.ref, points: r.path.points })), inputs: [...best.values()].filter((r) => !refs.has(r.part.ref)).map((r) => ({ net: r.g.id, ref: r.part.ref, points: r.path.points })) }
}

export interface BoardTells {
  copperMm: number
  layers: string[]
}

export function boardTells(board: BoardModel): BoardTells {
  let copperMm = 0
  for (const c of Object.values(board.copper)) {
    for (const t of c.traces) {
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1] as Vec2
        const b = t.points[i] as Vec2
        copperMm += Math.hypot(b.x - a.x, b.y - a.y)
      }
    }
  }
  const layers = layerLabels(board).map((l) => l.id).filter((id) => (board.copper[id]?.traces.length ?? 0) + (board.copper[id]?.zones.length ?? 0) > 0)
  return { copperMm, layers }
}
