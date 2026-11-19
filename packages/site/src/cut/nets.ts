import type { BoardModel, Vec2 } from '@silk-reel/ingest'
import type { TraceTimeline } from '@silk-reel/choreo'

export interface Net {
  name: string
  mm: number
  /** front copper, stride 5: x0, y0, x1, y1, width (plane px) */
  f: number[]
  b: number[]
  /** pads on the visible side, stride 5: x, y, w, h, rot */
  pads: number[]
  /** stride 3: x, y, r */
  vias: number[]
}

export interface NetPart {
  ref: string
  value: string
  /** x, y, w, h, rot, height (plane px) */
  box: [number, number, number, number, number, number]
  nets: number[]
}

export interface NetData {
  w: number
  h: number
  nets: Net[]
  parts: NetPart[]
  facts: { parts: number; nets: number; vias: number; copperMm: number }
  /** column-major view-projection of the camera the hero faces were rendered through */
  vp?: number[]
}

const r1 = (v: number) => Math.round(v * 10) / 10

function planeMap(board: BoardModel, tl: TraceTimeline): (p: Vec2) => Vec2 {
  const s = tl.scene.material.pxPerMm
  const mm = board.outline.flatMap((p) => p.points)
  const px = tl.scene.board.flatMap((loop) => Array.from({ length: loop.length / 2 }, (_, i) => ({ x: loop[i * 2] ?? 0, y: loop[i * 2 + 1] ?? 0 })))
  const lo = (a: number[]) => Math.min(...a)
  const x0 = lo(px.map((p) => p.x))
  const y0 = lo(px.map((p) => p.y))
  const marks = new Set(tl.scene.vias.map((v) => `${Math.round(v.x / 2)},${Math.round(v.y / 2)}`))
  const vias = Object.values(board.copper).flatMap((c) => c.vias).slice(0, 400)
  const turns: Array<(p: Vec2) => Vec2> = [
    (p) => ({ x: s * p.x, y: s * p.y }),
    (p) => ({ x: -s * p.x, y: s * p.y }),
    (p) => ({ x: -s * p.y, y: s * p.x }),
    (p) => ({ x: -s * p.y, y: -s * p.x })
  ]
  let best = turns[0] as (p: Vec2) => Vec2
  let most = -1
  for (const turn of turns) {
    const q = mm.map(turn)
    const tx = x0 - lo(q.map((p) => p.x))
    const ty = y0 - lo(q.map((p) => p.y))
    const f = (p: Vec2) => { const r = turn(p); return { x: r.x + tx, y: r.y + ty } }
    const hits = vias.filter((v) => { const r = f(v.pos); return marks.has(`${Math.round(r.x / 2)},${Math.round(r.y / 2)}`) }).length
    if (hits > most) { most = hits; best = f }
  }
  return best
}

/** every routed net of a board in the film's plane, with the parts that stand on it */
export function netsOf(board: BoardModel, tl: TraceTimeline): NetData {
  const map = planeMap(board, tl)
  const s = tl.scene.material.pxPerMm
  const side = new Map(board.layers.map((l) => [l.id, l.side]))
  const back = tl.scene.layers.some((l) => l.side === 'F') ? 'B' : 'F'
  const byId = new Map<number, Net>()
  const names = new Map(board.nets.map((n) => [n.id, n.name]))
  const net = (id: number | undefined) => {
    if (id === undefined || id <= 0) return
    let n = byId.get(id)
    if (!n) { n = { name: names.get(id) ?? '', mm: 0, f: [], b: [], pads: [], vias: [] }; byId.set(id, n) }
    return n
  }
  const seen = new Set<string>()
  let vias = 0
  let copperMm = 0
  const padNet = new Map<string, number[]>()
  for (const [layer, copper] of Object.entries(board.copper)) {
    const front = side.get(layer) !== back && side.get(layer) !== 'inner'
    for (const t of copper.traces) {
      const n = net(t.netId)
      for (let i = 0; i + 1 < t.points.length; i++) {
        const p = t.points[i]
        const q = t.points[i + 1]
        if (!p || !q) continue
        const len = Math.hypot(q.x - p.x, q.y - p.y)
        copperMm += len
        if (!n) continue
        n.mm += len
        const a = map(p)
        const c = map(q)
        ;(front ? n.f : n.b).push(r1(a.x), r1(a.y), r1(c.x), r1(c.y), r1(Math.max(1, t.width * s)))
      }
    }
    for (const v of copper.vias) {
      if (seen.has(v.id)) continue
      seen.add(v.id)
      vias++
      const q = map(v.pos)
      net(v.netId)?.vias.push(r1(q.x), r1(q.y), r1(Math.max(1, (v.dia / 2) * s)))
    }
    for (const pad of copper.pads) {
      if (pad.footprintRef !== undefined && pad.netId !== undefined && pad.netId > 0) padNet.set(pad.footprintRef, [...(padNet.get(pad.footprintRef) ?? []), pad.netId])
      if (!front || seen.has(pad.id)) continue
      seen.add(pad.id)
      const q = map(pad.pos)
      net(pad.netId)?.pads.push(r1(q.x), r1(q.y), r1(pad.size.x * s), r1(pad.size.y * s), Math.round(pad.rot * 100) / 100)
    }
  }
  const ids = [...byId.keys()].filter((id) => { const n = byId.get(id); return !!n && n.f.length + n.b.length > 0 })
  const index = new Map(ids.map((id, i) => [id, i]))
  const bodies = tl.scene.parts.filter((p) => p.kind !== 'pin')
  const taken = new Set<number>()
  const parts: NetPart[] = []
  for (const fp of board.footprints) {
    const q = map(fp.pos)
    let best = -1
    let d = Infinity
    bodies.forEach((p, i) => {
      if (taken.has(i)) return
      const k = Math.hypot(p.x - q.x, p.y - q.y)
      if (k < d && k <= Math.max(p.w, p.h) * 0.75 + s) { d = k; best = i }
    })
    const body = bodies[best]
    if (!body) continue
    taken.add(best)
    const own = [...new Set(padNet.get(fp.ref) ?? [])].map((id) => index.get(id)).filter((i): i is number => i !== undefined)
    if (!own.length) continue
    parts.push({ ref: fp.ref, value: fp.value ?? '', box: [r1(body.x), r1(body.y), r1(body.w), r1(body.h), Math.round(body.rot * 100) / 100, r1(body.z)], nets: own })
  }
  return {
    w: tl.width,
    h: tl.height,
    nets: ids.map((id) => { const n = byId.get(id) as Net; return { ...n, mm: r1(n.mm) } }),
    parts,
    facts: { parts: board.footprints.length, nets: board.nets.filter((n) => n.id > 0).length, vias, copperMm: Math.round(copperMm) }
  }
}
