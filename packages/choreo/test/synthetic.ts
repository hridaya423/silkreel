import type { BoardModel, Vec2 } from '@silk-reel/ingest'

interface SyntheticElement {
  id: string
  kind: ElementKindForTests
  pos: Vec2
  size: number
}

type ElementKindForTests = 'trace' | 'trace-b' | 'text'

export function makeSyntheticBoard(elementCount: number): BoardModel {
  const side = Math.ceil(Math.sqrt(elementCount))
  const elements: SyntheticElement[] = []
  for (let i = 0; i < elementCount; i++) {
    const col = i % side
    const row = Math.floor(i / side)
    const bucket = i % 10
    if (bucket < 7) {
      elements.push({ id: `t:${i + 1}`, kind: 'trace', pos: { x: col * 2.54, y: row * 2.54 }, size: 0.3 })
    } else if (bucket < 9) {
      elements.push({ id: `t:${i + 1}`, kind: 'trace-b', pos: { x: col * 2.54, y: row * 2.54 }, size: 0.3 })
    } else {
      elements.push({ id: `tx:${i + 1}`, kind: 'text', pos: { x: col * 2.54, y: row * 2.54 }, size: 1 })
    }
  }
  return syntheticBoardFrom(elements)
}

function syntheticBoardFrom(elements: SyntheticElement[]): BoardModel {
  const frontTraces = elements
    .filter((e) => e.kind === 'trace')
    .map((e, i) => ({
      id: e.id,
      points: [
        { x: e.pos.x - e.size / 2, y: e.pos.y },
        { x: e.pos.x + e.size / 2, y: e.pos.y }
      ],
      width: 0.25,
      netId: 1 + (i % 4)
    }))
  const backTraces = elements
    .filter((e) => e.kind === 'trace-b')
    .map((e, i) => ({
      id: e.id,
      points: [
        { x: e.pos.x - e.size / 2, y: e.pos.y },
        { x: e.pos.x + e.size / 2, y: e.pos.y }
      ],
      width: 0.25,
      netId: 1 + (i % 4)
    }))
  const texts = elements
    .filter((e) => e.kind === 'text')
    .map((e) => ({
      id: e.id,
      value: `TXT${e.id}`,
      pos: e.pos,
      rot: 0,
      height: 1,
      mirrored: false
    }))
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const e of elements) {
    minX = Math.min(minX, e.pos.x)
    minY = Math.min(minY, e.pos.y)
    maxX = Math.max(maxX, e.pos.x)
    maxY = Math.max(maxY, e.pos.y)
  }
  return {
    source: { format: 'kicad', files: ['synthetic.kicad_pcb'], boardName: 'synthetic' },
    stackup: { thickness: 1.6 },
    bbox: {
      min: { x: Number.isFinite(minX) ? minX - 1 : 0, y: Number.isFinite(minY) ? minY - 1 : 0 },
      max: { x: Number.isFinite(maxX) ? maxX + 1 : 10, y: Number.isFinite(maxY) ? maxY + 1 : 10 }
    },
    outline: [{ id: 'o:1', points: [
      { x: Number.isFinite(minX) ? minX - 1 : 0, y: Number.isFinite(minY) ? minY - 1 : 0 },
      { x: Number.isFinite(maxX) ? maxX + 1 : 10, y: Number.isFinite(minY) ? minY - 1 : 0 },
      { x: Number.isFinite(maxX) ? maxX + 1 : 10, y: Number.isFinite(maxY) ? maxY + 1 : 10 },
      { x: Number.isFinite(minX) ? minX - 1 : 0, y: Number.isFinite(maxY) ? maxY + 1 : 10 },
      { x: Number.isFinite(minX) ? minX - 1 : 0, y: Number.isFinite(minY) ? minY - 1 : 0 }
    ], closed: true, layerId: 'Edge.Cuts' }],
    layers: [
      { id: 'F.Cu', name: 'F.Cu', kind: 'copper', side: 'F' },
      { id: 'B.Cu', name: 'B.Cu', kind: 'copper', side: 'B' },
      { id: 'F.SilkS', name: 'F.SilkS', kind: 'silk', side: 'F' },
      { id: 'Edge.Cuts', name: 'Edge.Cuts', kind: 'outline', side: null }
    ],
    copper: {
      'F.Cu': { traces: frontTraces, pads: [], vias: [], zones: [] },
      'B.Cu': { traces: backTraces, pads: [], vias: [], zones: [] }
    },
    silkscreen: { 'F.SilkS': { lines: [], texts } },
    footprints: [],
    drill: [],
    nets: [],
    stats: {
      traces: frontTraces.length + backTraces.length,
      pads: 0,
      vias: 0,
      zones: 0,
      texts: texts.length,
      drills: 0
    },
    warnings: []
  }
}

/** board with N footprints, each owning a closed chamfered-rect silk outline */
export function syntheticBoardWithFootprints(count: number): BoardModel {
  const board = syntheticBoardFrom([])
  const lines: import('@silk-reel/ingest').Trace[] = []
  const footprints: import('@silk-reel/ingest').Footprint[] = []
  for (let i = 0; i < count; i++) {
    const ox = i * 8
    const w = 5 + (i % 3)
    const h = 3 + (i % 2)
    const chamfer = 0.8
    const silkRefs: string[] = []
    const segs: [Vec2, Vec2][] = [
      [{ x: ox + chamfer, y: 0 }, { x: ox + w, y: 0 }],
      [{ x: ox + w, y: 0 }, { x: ox + w, y: h }],
      [{ x: ox + w, y: h }, { x: ox, y: h }],
      [{ x: ox, y: h }, { x: ox, y: chamfer }],
      [{ x: ox, y: chamfer }, { x: ox + chamfer, y: 0 }]
    ]
    for (const [j, [a, b]] of segs.entries()) {
      const id = `sl:fp${i}:${j}`
      lines.push({ id, points: [a, b], width: 0.12 })
      silkRefs.push(id)
    }
    footprints.push({
      ref: `U${i + 1}`,
      value: `VAL${i + 1}`,
      pos: { x: ox + w / 2, y: h / 2 },
      rot: 0,
      layer: 'F.Cu',
      padRefs: [],
      silkRefs,
      models: []
    })
  }
  const silk = board.silkscreen['F.SilkS']
  if (silk) silk.lines.push(...lines)
  board.footprints.push(...footprints)
  return board
}
