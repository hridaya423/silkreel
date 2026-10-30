import type {
  BoardModel,
  CopperLayers,
  DrillHit,
  Footprint,
  IngestWarning,
  Layer,
  LayerSide,
  ModelRef,
  Net,
  NetNodeRef,
  Pad,
  PadShape,
  Path,
  SilkLayer,
  Stackup,
  Trace,
  Vec2,
  Vec3,
  Via,
  Zone
} from './types.js'
import type { SExprNode } from './sexp.js'
import {
  isAtom,
  isList,
  head,
  children,
  listsNamed,
  firstListNamed,
  atomsAfterHead,
  toNumber,
  parseXY
} from './sexp-query.js'
import { ParseError } from './errors.js'

interface IdSeq {
  n: number
}

function nextId(ids: IdSeq): number {
  ids.n += 1
  return ids.n
}

class BBoxAccumulator {
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity

  point(p: Vec2): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
    if (p.x < this.minX) this.minX = p.x
    if (p.y < this.minY) this.minY = p.y
    if (p.x > this.maxX) this.maxX = p.x
    if (p.y > this.maxY) this.maxY = p.y
  }

  radius(p: Vec2, r: number): void {
    this.point({ x: p.x - r, y: p.y - r })
    this.point({ x: p.x + r, y: p.y + r })
  }

  get started(): boolean {
    return Number.isFinite(this.minX)
  }
}

function sideOf(layerId: string): LayerSide {
  if (/^In\d+\.Cu$/.test(layerId)) return 'inner'
  const m = /^([FB])\./.exec(layerId)
  return m ? (m[1] as LayerSide) : null
}

function layerKindOf(layerId: string): Layer['kind'] | undefined {
  if (/\.Cu$/.test(layerId)) return 'copper'
  if (/\.SilkS$/.test(layerId)) return 'silk'
  if (layerId === 'Edge.Cuts') return 'outline'
  if (
    /\.Mask$/.test(layerId) ||
    /\.(Adhes|Paste|Fab|CrtYd)$/.test(layerId) ||
    /^(Dwgs|Cmts|Eco\d?)\.User$/.test(layerId) ||
    layerId === 'Margin'
  ) {
    return 'mask'
  }
  return undefined
}

/** KiCad angles are counter-clockwise on screen (y down) */
function rotatePoint(p: Vec2, origin: Vec2, rotDeg: number): Vec2 {
  if (rotDeg === 0) return p
  const rad = (rotDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - origin.x
  const dy = p.y - origin.y
  return { x: origin.x + dx * cos + dy * sin, y: origin.y - dx * sin + dy * cos }
}

function padShapeOf(token: string): PadShape {
  switch (token) {
    case 'rect':
    case 'circle':
    case 'oval':
    case 'roundrect':
      return token
    case 'trapezoid':
    case 'custom':
      return token
    default:
      return 'roundrect'
  }
}

interface KicadTextInfo {
  value: string
  at: Vec2
  rot: number
  height: number
  mirrored: boolean
  hidden: boolean
  layerId: string
}

function extractTextLike(node: SExprNode[], file: string): KicadTextInfo {
  const atoms = atomsAfterHead(node)
  const valueAtomIndex = atoms[0] === 'user' || atoms[0] === 'reference' || atoms[0] === 'value' ? 1 : 0
  const info: KicadTextInfo = {
    value: atoms[valueAtomIndex] ?? '',
    at: { x: 0, y: 0 },
    rot: 0,
    height: 1,
    mirrored: false,
    hidden: false,
    layerId: 'F.SilkS'
  }
  for (const child of children(node)) {
    if (!isList(child)) continue
    const h = head(child)
    if (h === 'at') {
      const atAtoms = atomsAfterHead(child)
      info.at = {
        x: toNumber(atAtoms[0] ?? '0', file, 'text x'),
        y: toNumber(atAtoms[1] ?? '0', file, 'text y')
      }
      const rot = Number.parseFloat(atAtoms[2] ?? '')
      if (Number.isFinite(rot)) info.rot = rot
    } else if (h === 'layer') {
      const layerAtoms = atomsAfterHead(child)
      info.layerId = layerAtoms[0] ?? info.layerId
      if (layerAtoms.includes('mirror')) info.mirrored = true
    } else if (h === 'hide' || h === 'hidden') {
      info.hidden = atomsAfterHead(child)[0] !== 'no'
    } else if (h === 'effects') {
      const font = firstListNamed(child, 'font')
      if (font) {
        const size = firstListNamed(font, 'size')
        if (size) {
          const hVal = Number.parseFloat(atomsAfterHead(size)[0] ?? '')
          if (Number.isFinite(hVal)) info.height = hVal
        }
        if (hasAtom(font, 'mirror')) info.mirrored = true
      }
      if (!info.mirrored && hasAtom(child, 'mirror')) info.mirrored = true
      if (hasAtom(child, 'hide')) info.hidden = true
    }
  }
  if (atoms.slice(valueAtomIndex + 1).includes('hide')) info.hidden = true
  return info
}

function propertyValue(fpNode: SExprNode[], propName: string): string | undefined {
  for (const prop of listsNamed(fpNode, 'property')) {
    const atoms = atomsAfterHead(prop)
    if ((atoms[0] ?? '') === propName) return atoms[1]
  }
  return undefined
}

/** pre-v6 boards carry `(fp_text reference J1 …)` instead of a property node */
function fpTextField(fpNode: SExprNode[], field: string): string | undefined {
  for (const text of listsNamed(fpNode, 'fp_text')) {
    const atoms = atomsAfterHead(text)
    if ((atoms[0] ?? '') === field) return atoms[1]
  }
  return undefined
}

function hasAtom(node: SExprNode[], atom: string): boolean {
  for (const child of node) {
    if (isAtom(child) && child === atom) return true
    if (isList(child) && hasAtom(child, atom)) return true
  }
  return false
}

export function classifyKicad(root: SExprNode[], fileName: string): BoardModel {
  const warnings: IngestWarning[] = []
  const layers: Layer[] = []
  const copper: Record<string, CopperLayers> = {}
  const silkscreen: Record<string, SilkLayer> = {}
  const footprints: Footprint[] = []
  const drill: DrillHit[] = []
  const outline: Path[] = []
  const bbox = new BBoxAccumulator()
  const ids: IdSeq = { n: 0 }

  const netNamesById = new Map<number, string>()
  const netNodesById = new Map<number, NetNodeRef[]>()
  const layersDecl = firstListNamed(root, 'layers')
  const declaredCopperLayerIds: string[] = []
  // KiCad 5 and older let a copper layer carry a free name ("Top", "GND"); its number says which layer it is
  const layerAlias = new Map<string, string>()
  if (layersDecl) {
    for (const entry of children(layersDecl)) {
      if (!isList(entry)) continue
      const num = Number.parseInt(head(entry), 10)
      let layerId = atomsAfterHead(entry)[0]
      const type = atomsAfterHead(entry)[1]
      if (layerId !== undefined && layerKindOf(layerId) === undefined && Number.isInteger(num) && ['signal', 'power', 'mixed', 'jumper'].includes(type ?? '')) {
        const canonical = num === 0 ? 'F.Cu' : num === 31 ? 'B.Cu' : `In${num}.Cu`
        layerAlias.set(layerId, canonical)
        layerId = canonical
      }
      if (layerId !== undefined && layerKindOf(layerId) === 'copper') declaredCopperLayerIds.push(layerId)
    }
  }
  const layerOf = (node: SExprNode[], fallback: string): string => {
    const id = atomsAfterHead(node)[0] ?? fallback
    return layerAlias.get(id) ?? id
  }
  const onEdge = (node: SExprNode[]): boolean => {
    const layerNode = firstListNamed(node, 'layer')
    return layerNode !== undefined && layerOf(layerNode, '') === 'Edge.Cuts'
  }

  function copperFor(layerId: string): CopperLayers {
    let c = copper[layerId]
    if (!c) {
      c = { traces: [], pads: [], vias: [], zones: [] }
      copper[layerId] = c
    }
    return c
  }

  function silkFor(layerId: string): SilkLayer {
    let s = silkscreen[layerId]
    if (!s) {
      s = { lines: [], texts: [] }
      silkscreen[layerId] = s
    }
    return s
  }

  function ensureLayer(layerId: string): void {
    if (layers.some((l) => l.id === layerId)) return
    const kind = layerKindOf(layerId)
    if (kind === undefined) return
    layers.push({ id: layerId, name: layerId, kind, side: sideOf(layerId) })
  }

  function bindNet(
    netAtom: string | undefined,
    elementKind: NetNodeRef['elementKind'],
    elementId: string,
    footprintRef?: string
  ): number | undefined {
    if (netAtom === undefined) return undefined
    const id = Number.parseInt(netAtom, 10)
    if (!Number.isFinite(id)) return undefined
    let nodes = netNodesById.get(id)
    if (nodes === undefined) {
      nodes = []
      netNodesById.set(id, nodes)
    }
    nodes.push(footprintRef === undefined ? { elementKind, elementId } : { elementKind, elementId, footprintRef })
    return id
  }

  function netAtomOf(node: SExprNode[]): string | undefined {
    const netNode = firstListNamed(node, 'net')
    return netNode ? atomsAfterHead(netNode)[0] : undefined
  }

  function pushTrace(layerId: string, points: Vec2[], width: number, netAtom: string | undefined): void {
    ensureLayer(layerId)
    const eid = nextId(ids)
    const trace: Trace = { id: `t:${eid}`, points, width, netId: bindNet(netAtom, 'trace', `t:${eid}`) }
    copperFor(layerId).traces.push(trace)
    for (const p of points) bbox.point(p)
  }

  for (const seg of listsNamed(root, 'segment')) {
    const startNode = firstListNamed(seg, 'start')
    const endNode = firstListNamed(seg, 'end')
    if (!startNode || !endNode) {
      warnings.push({ code: 'segment-incomplete', message: 'segment without start/end skipped' })
      continue
    }
    const widthNode = firstListNamed(seg, 'width')
    const width = widthNode ? toNumber(atomsAfterHead(widthNode)[0] ?? '0.25', fileName, 'segment width') : 0.25
    const layerNode = firstListNamed(seg, 'layer')
    const layerId = layerNode ? layerOf(layerNode, 'F.Cu') : 'F.Cu'
    pushTrace(layerId, [parseXY(startNode, fileName), parseXY(endNode, fileName)], width, netAtomOf(seg))
  }

  for (const arcSeg of listsNamed(root, 'arc')) {
    const startNode = firstListNamed(arcSeg, 'start')
    const midNode = firstListNamed(arcSeg, 'mid')
    const endNode = firstListNamed(arcSeg, 'end')
    if (!startNode || !endNode) {
      warnings.push({ code: 'arc-incomplete', message: 'copper arc without endpoints skipped' })
      continue
    }
    const mid = midNode ? parseXY(midNode, fileName) : undefined
    const widthNode = firstListNamed(arcSeg, 'width')
    const width = widthNode ? toNumber(atomsAfterHead(widthNode)[0] ?? '0.25', fileName, 'arc width') : 0.25
    const layerNode = firstListNamed(arcSeg, 'layer')
    const layerId = layerNode ? layerOf(layerNode, 'F.Cu') : 'F.Cu'
    const points = mid ? approximateArc(parseXY(startNode, fileName), mid, parseXY(endNode, fileName)) : [parseXY(startNode, fileName), parseXY(endNode, fileName)]
    pushTrace(layerId, points, width, netAtomOf(arcSeg))
  }

  for (const viaNode of listsNamed(root, 'via')) {
    const atNode = firstListNamed(viaNode, 'at')
    if (!atNode) {
      warnings.push({ code: 'via-incomplete', message: 'via without position skipped' })
      continue
    }
    const pos = parseXY(atNode, fileName)
    const sizeNode = firstListNamed(viaNode, 'size')
    const dia = sizeNode ? toNumber(atomsAfterHead(sizeNode)[0] ?? '0.8', fileName, 'via diameter') : 0.8
    const drillNode = firstListNamed(viaNode, 'drill')
    const drillDia = drillNode ? toNumber(atomsAfterHead(drillNode)[0] ?? String(dia / 2), fileName, 'via drill') : dia / 2
    const eid = nextId(ids)
    const via: Via = { id: `v:${eid}`, pos, dia, drill: drillDia, netId: bindNet(netAtomOf(viaNode), 'via', `v:${eid}`) }
    const viaLayers = listsNamed(viaNode, 'layers')
    const targetLayer = viaLayers.length > 0 ? layerOf(viaLayers[0] as SExprNode[], 'F.Cu') : 'F.Cu'
    ensureLayer(targetLayer)
    copperFor(targetLayer).vias.push(via)
    bbox.radius(pos, dia / 2)
  }

  for (const zoneNode of listsNamed(root, 'zone')) {
    const polyNode = firstListNamed(zoneNode, 'polygon')
    const ptsNode = polyNode ? firstListNamed(polyNode, 'pts') : undefined
    if (!ptsNode) continue
    const points = listsNamed(ptsNode, 'xy').map((xy) => parseXY(xy, fileName))
    if (points.length < 3) continue
    if (firstListNamed(zoneNode, 'keepout') !== undefined) continue
    const one = firstListNamed(zoneNode, 'layer')
    const many = firstListNamed(zoneNode, 'layers')
    const spec = one ? [layerOf(one, 'F.Cu')] : many ? atomsAfterHead(many).map((t) => layerAlias.get(t) ?? t) : ['F.Cu']
    const zoneLayerIds = resolvePadLayers(spec, declaredCopperLayerIds, [])
    const netAtom = netAtomOf(zoneNode)
    for (const layerId of zoneLayerIds) {
      const fills: Vec2[][] = []
      for (const filled of listsNamed(zoneNode, 'filled_polygon')) {
        const fillLayer = firstListNamed(filled, 'layer')
        if (fillLayer && layerOf(fillLayer, layerId) !== layerId) continue
        const fpts = firstListNamed(filled, 'pts')
        if (fpts) fills.push(listsNamed(fpts, 'xy').map((xy) => parseXY(xy, fileName)))
      }
      const eid = nextId(ids)
      const zone: Zone = { id: `z:${eid}`, outline: points, fills, netId: bindNet(netAtom, 'zone', `z:${eid}`) }
      ensureLayer(layerId)
      copperFor(layerId).zones.push(zone)
    }
    if (zoneLayerIds.length > 0) for (const p of points) bbox.point(p)
  }

  interface PadRecord {
    key: string
    pad: Pad
    netId: number | undefined
  }
  const padRecords: PadRecord[] = []

  function collectPad(fp: Footprint, fpOrigin: Vec2, fpRot: number, node: SExprNode[]): void {
    const atoms = atomsAfterHead(node)
    const padType = atoms[1] ?? 'smd'
    const shapeToken = atoms[2] ?? 'circle'
    const atNode = firstListNamed(node, 'at')
    const sizeNode = firstListNamed(node, 'size')
    const localAt = atNode ? parseXY(atNode, fileName) : { x: 0, y: 0 }
    let padRot = 0
    if (atNode) {
      const atAtoms = atomsAfterHead(atNode)
      if (atAtoms[2] !== undefined) padRot = toNumber(atAtoms[2], fileName, 'pad rotation')
    }
    const sizeAtoms = sizeNode ? atomsAfterHead(sizeNode) : []
    const sx = toNumber(sizeAtoms[0] ?? '1', fileName, 'pad size')
    const syRaw = sizeAtoms[1] ?? sizeAtoms[0] ?? '1'
    const sy = toNumber(syRaw, fileName, 'pad size')
    const globalPos = rotatePoint({ x: fpOrigin.x + localAt.x, y: fpOrigin.y + localAt.y }, fpOrigin, fpRot)
    const eid = nextId(ids)
    const key = `p:${eid}`
    const netId = bindNet(netAtomOf(node), 'pad', key, fp.ref)
    const pad: Pad = {
      id: key,
      pos: globalPos,
      size: { x: sx, y: sy },
      shape: padShapeOf(shapeToken),
      // pad and text angles in the file are already board-absolute
      rot: padRot,
      footprintRef: fp.ref,
      netId
    }
    padRecords.push({ key, pad, netId })
    fp.padRefs.push(key)

    if (padType === 'np_thru_hole') {
      const drillNode = firstListNamed(node, 'drill')
      const d = drillNode ? Number.parseFloat(atomsAfterHead(drillNode)[0] ?? String(Math.max(sx, sy))) : Math.max(sx, sy)
      drill.push({ id: `d:${nextId(ids)}`, pos: globalPos, dia: Number.isFinite(d) && d > 0 ? d : Math.max(sx, sy), plated: false })
    } else if (padType !== 'smd') {
      const drillNode = firstListNamed(node, 'drill')
      const d = drillNode ? Number.parseFloat(atomsAfterHead(drillNode)[0] ?? '0') : 0
      if (Number.isFinite(d) && d > 0) drill.push({ id: `d:${nextId(ids)}`, pos: globalPos, dia: d, plated: true })
    }

    const layerNodes = listsNamed(node, 'layers')
    const layerSpec = layerNodes.length > 0 ? atomsAfterHead(layerNodes[0] as SExprNode[]).map((t) => layerAlias.get(t) ?? t) : []
    const throughHole = padType === 'thru_hole' || padType === 'connect' || padType === 'np_thru_hole'
    const targetLayers = resolvePadLayers(
      layerSpec,
      declaredCopperLayerIds,
      throughHole ? ['F.Cu', 'B.Cu'] : ['F.Cu']
    )
    for (const layerId of targetLayers) {
      ensureLayer(layerId)
      copperFor(layerId).pads.push(pad)
    }
    bbox.radius(globalPos, Math.max(sx, sy) / 2)
  }

  function collectFpSilkLine(fp: Footprint, fpOrigin: Vec2, fpRot: number, node: SExprNode[]): void {
    const startNode = firstListNamed(node, 'start')
    const endNode = firstListNamed(node, 'end')
    if (!startNode || !endNode) return
    const layerNode = firstListNamed(node, 'layer')
    const layerId = layerNode ? (atomsAfterHead(layerNode)[0] ?? 'F.SilkS') : 'F.SilkS'
    const strokeNode = firstListNamed(node, 'stroke')
    const wNode = (strokeNode ? firstListNamed(strokeNode, 'width') : undefined) ?? firstListNamed(node, 'width')
    const width = wNode ? toNumber(atomsAfterHead(wNode)[0] ?? '0.12', fileName, 'fp_line width') : 0.12
    const a = parseXY(startNode, fileName)
    const b = parseXY(endNode, fileName)
    const pts = [
      rotatePoint({ x: fpOrigin.x + a.x, y: fpOrigin.y + a.y }, fpOrigin, fpRot),
      rotatePoint({ x: fpOrigin.x + b.x, y: fpOrigin.y + b.y }, fpOrigin, fpRot)
    ]
    if (/\.SilkS$/.test(layerId)) {
      ensureLayer(layerId)
      const lineId = `sl:${nextId(ids)}`
      silkFor(layerId).lines.push({ id: lineId, points: pts, width })
      fp.silkRefs.push(lineId)
    } else if (layerId === 'Edge.Cuts') {
      outline.push({ id: `o:${nextId(ids)}`, points: pts, closed: false, layerId })
    }
    for (const p of pts) bbox.point(p)
  }

  function collectFpSilkArc(fp: Footprint, fpOrigin: Vec2, fpRot: number, node: SExprNode[]): void {
    const startNode = firstListNamed(node, 'start')
    const midNode = firstListNamed(node, 'mid')
    const endNode = firstListNamed(node, 'end')
    if (!startNode || !midNode || !endNode) return
    const layerNode = firstListNamed(node, 'layer')
    const layerId = layerNode ? (atomsAfterHead(layerNode)[0] ?? 'F.SilkS') : 'F.SilkS'
    const approx = approximateArc(parseXY(startNode, fileName), parseXY(midNode, fileName), parseXY(endNode, fileName))
    const shifted = approx.map((p) => rotatePoint({ x: fpOrigin.x + p.x, y: fpOrigin.y + p.y }, fpOrigin, fpRot))
    if (layerId === 'Edge.Cuts') outline.push({ id: `o:${nextId(ids)}`, points: shifted, closed: false, layerId })
    if (!/\.SilkS$/.test(layerId)) return
    const strokeNode = firstListNamed(node, 'stroke')
    const wNode = (strokeNode ? firstListNamed(strokeNode, 'width') : undefined) ?? firstListNamed(node, 'width')
    const width = wNode ? toNumber(atomsAfterHead(wNode)[0] ?? '0.12', fileName, 'fp_arc width') : 0.12
    const arcId = `sa:${nextId(ids)}`
    ensureLayer(layerId)
    silkFor(layerId).lines.push({ id: arcId, points: shifted, width })
    fp.silkRefs.push(arcId)
    for (const p of shifted) bbox.point(p)
  }

  function collectFpText(
    fp: Footprint,
    fpOrigin: Vec2,
    fpRot: number,
    node: SExprNode[],
    kind: 'fp_text' | 'property'
  ): void {
    const info = extractTextLike(node, fileName)
    if (info.hidden) return
    if (kind === 'property') {
      const propName = atomsAfterHead(node)[0] ?? ''
      const propValue = atomsAfterHead(node)[1]
      if (propValue === undefined) return
      info.value = propValue
      if (propName !== 'Reference' && propName !== 'Value') return
    } else {
      if (info.value.includes('${REFERENCE}')) {
        const ref = propertyValue(fpNodeOf(fp), 'Reference')
        if (ref !== undefined) info.value = ref
      }
    }
    const globalAt = rotatePoint({ x: fpOrigin.x + info.at.x, y: fpOrigin.y + info.at.y }, fpOrigin, fpRot)
    if (/\.SilkS$/.test(info.layerId)) {
      ensureLayer(info.layerId)
      const textId = `tx:${nextId(ids)}`
      silkFor(info.layerId).texts.push({
        id: textId,
        value: info.value,
        refdes: fp.ref,
        pos: globalAt,
        rot: info.rot,
        height: info.height,
        mirrored: info.mirrored,
        footprintRef: fp.ref
      })
      fp.silkRefs.push(textId)
    }
    bbox.point(globalAt)
  }

  const footprintNodeById = new Map<string, SExprNode[]>()

  function fpNodeOf(fp: Footprint): SExprNode[] {
    return footprintNodeById.get(fp.ref) ?? []
  }

  for (const fpNode of [...listsNamed(root, 'footprint'), ...listsNamed(root, 'module')]) {
    const second: SExprNode | undefined = fpNode[1]
    const libId = second !== undefined && isAtom(second) ? second : undefined
    const atNode = firstListNamed(fpNode, 'at')
    const fpOrigin = atNode ? parseXY(atNode, fileName) : { x: 0, y: 0 }
    let fpRot = 0
    if (atNode) {
      const atAtoms = atomsAfterHead(atNode)
      if (atAtoms[2] !== undefined) fpRot = toNumber(atAtoms[2], fileName, 'footprint rotation')
    }
    const layerNode = firstListNamed(fpNode, 'layer')
    const fpLayer = layerNode ? layerOf(layerNode, 'F.Cu') : 'F.Cu'
    const ref =
      propertyValue(fpNode, 'Reference') ??
      fpTextField(fpNode, 'reference') ??
      (libId !== undefined ? libId.replace(/^[^:]*:/, '').replace(/[^A-Za-z0-9_.-]/g, '_') : `fp${footprints.length + 1}`)
    const fp: Footprint = {
      ref,
      value: propertyValue(fpNode, 'Value') ?? fpTextField(fpNode, 'value'),
      pos: fpOrigin,
      rot: fpRot,
      layer: fpLayer,
      padRefs: [],
      silkRefs: [],
      model: modelName(fpNode),
      models: modelRefs(fpNode, fileName)
    }
    footprintNodeById.set(ref, fpNode)
    for (const child of children(fpNode)) {
      if (!isList(child)) continue
      const h = head(child)
      if (h === 'pad') collectPad(fp, fpOrigin, fpRot, child)
      else if (h === 'fp_line') collectFpSilkLine(fp, fpOrigin, fpRot, child)
      else if (h === 'fp_arc') collectFpSilkArc(fp, fpOrigin, fpRot, child)
      else if (h === 'fp_circle') collectFpCircle(fp, fpOrigin, fpRot, child)
      else if (h === 'fp_text') collectFpText(fp, fpOrigin, fpRot, child, 'fp_text')
      else if (h === 'property') collectFpText(fp, fpOrigin, fpRot, child, 'property')
      else if (h === 'fp_poly' || h === 'fp_rect') collectFpPolyOrRect(fp, fpOrigin, fpRot, child, h)
      else if (h === 'fp_curve' && onEdge(child)) {
        const pts = bezierOf(child, fileName).map((p) => rotatePoint({ x: fpOrigin.x + p.x, y: fpOrigin.y + p.y }, fpOrigin, fpRot))
        outline.push({ id: `o:${nextId(ids)}`, points: pts, closed: false, layerId: 'Edge.Cuts' })
        for (const p of pts) bbox.point(p)
      }
    }
    footprints.push(fp)
    bbox.point(fpOrigin)
  }

  function collectFpCircle(fp: Footprint, fpOrigin: Vec2, fpRot: number, node: SExprNode[]): void {
    const centerNode = firstListNamed(node, 'center')
    const endNode = firstListNamed(node, 'end')
    const layerNode = firstListNamed(node, 'layer')
    const layerId = layerNode ? (atomsAfterHead(layerNode)[0] ?? 'F.SilkS') : 'F.SilkS'
    if (!centerNode || !endNode) return
    const cLocal = parseXY(centerNode, fileName)
    const eLocal = parseXY(endNode, fileName)
    const radius = Math.hypot(eLocal.x - cLocal.x, eLocal.y - cLocal.y)
    const strokeNode = firstListNamed(node, 'stroke')
    const wNode = (strokeNode ? firstListNamed(strokeNode, 'width') : undefined) ?? firstListNamed(node, 'width')
    const width = wNode ? toNumber(atomsAfterHead(wNode)[0] ?? '0.12', fileName, 'fp_circle width') : 0.12
    const center = rotatePoint({ x: fpOrigin.x + cLocal.x, y: fpOrigin.y + cLocal.y }, fpOrigin, fpRot)
    if (/\.SilkS$/.test(layerId)) {
      ensureLayer(layerId)
      const circleId = `sc:${nextId(ids)}`
      silkFor(layerId).lines.push({ id: circleId, points: approximateFullCircle(center, radius), width })
      fp.silkRefs.push(circleId)
    } else if (layerId === 'Edge.Cuts') {
      outline.push({ id: `o:${nextId(ids)}`, points: approximateFullCircle(center, radius), closed: true, layerId })
    }
    bbox.radius(center, radius)
  }

  function collectFpPolyOrRect(
    fp: Footprint,
    fpOrigin: Vec2,
    fpRot: number,
    node: SExprNode[],
    h: string
  ): void {
    const layerNode = firstListNamed(node, 'layer')
    const layerId = layerNode ? (atomsAfterHead(layerNode)[0] ?? 'F.SilkS') : 'F.SilkS'
    if (!/\.SilkS$/.test(layerId) && layerId !== 'Edge.Cuts') return
    const strokeNode = firstListNamed(node, 'stroke')
    const wNode = (strokeNode ? firstListNamed(strokeNode, 'width') : undefined) ?? firstListNamed(node, 'width')
    const width = wNode ? toNumber(atomsAfterHead(wNode)[0] ?? '0.12', fileName, 'fp_poly width') : 0.12
    let localPts: Vec2[] = []
    const ptsNode = firstListNamed(node, 'pts')
    if (ptsNode) {
      localPts = listsNamed(ptsNode, 'xy').map((xy) => parseXY(xy, fileName))
    } else {
      const startNode = firstListNamed(node, 'start')
      const endNode = firstListNamed(node, 'end')
      if (startNode && endNode) {
        const a = parseXY(startNode, fileName)
        const b = parseXY(endNode, fileName)
        localPts = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
      }
    }
    if (localPts.length < 2) return
    const globalPts = localPts.map((p) => rotatePoint({ x: fpOrigin.x + p.x, y: fpOrigin.y + p.y }, fpOrigin, fpRot))
    if (layerId === 'Edge.Cuts') {
      outline.push({ id: `o:${nextId(ids)}`, points: globalPts, closed: globalPts.length > 2, layerId })
      for (const p of globalPts) bbox.point(p)
      return
    }
    const polyId = `${h === 'fp_rect' ? 'sr' : 'sp'}:${nextId(ids)}`
    ensureLayer(layerId)
    silkFor(layerId).lines.push({ id: polyId, points: [...globalPts, globalPts[0] as Vec2], width })
    fp.silkRefs.push(polyId)
    for (const p of globalPts) bbox.point(p)
  }

  for (const gt of listsNamed(root, 'gr_text')) {
    const info = extractTextLike(gt, fileName)
    if (info.hidden) continue
    if (/\.SilkS$/.test(info.layerId)) {
      ensureLayer(info.layerId)
      silkFor(info.layerId).texts.push({
        id: `tx:${nextId(ids)}`,
        value: info.value,
        pos: info.at,
        rot: info.rot,
        height: info.height,
        mirrored: info.mirrored
      })
    }
    bbox.point(info.at)
  }

  for (const gl of listsNamed(root, 'gr_line')) {
    const startNode = firstListNamed(gl, 'start')
    const endNode = firstListNamed(gl, 'end')
    if (!startNode || !endNode) continue
    const a = parseXY(startNode, fileName)
    const b = parseXY(endNode, fileName)
    const layerNode = firstListNamed(gl, 'layer')
    const layerId = layerNode ? (atomsAfterHead(layerNode)[0] ?? 'Edge.Cuts') : 'Edge.Cuts'
    const strokeNode = firstListNamed(gl, 'stroke')
    const wNode = (strokeNode ? firstListNamed(strokeNode, 'width') : undefined) ?? firstListNamed(gl, 'width')
    const width = wNode ? toNumber(atomsAfterHead(wNode)[0] ?? '0.1', fileName, 'gr_line width') : 0.1
    if (layerId === 'Edge.Cuts') {
      outline.push({ id: `o:${nextId(ids)}`, points: [a, b], closed: false, layerId })
    } else if (/\.SilkS$/.test(layerId)) {
      ensureLayer(layerId)
      silkFor(layerId).lines.push({ id: `sl:${nextId(ids)}`, points: [a, b], width })
    }
    bbox.point(a)
    bbox.point(b)
  }

  for (const gr of [...listsNamed(root, 'gr_rect'), ...listsNamed(root, 'gr_poly')]) {
    const isRect = head(gr) === 'gr_rect'
    const ptsNode = firstListNamed(gr, 'pts')
    const startNode = firstListNamed(gr, 'start')
    const endNode = firstListNamed(gr, 'end')
    let points: Vec2[] = []
    if (ptsNode) points = listsNamed(ptsNode, 'xy').map((xy) => parseXY(xy, fileName))
    else if (startNode && endNode) {
      const a = parseXY(startNode, fileName)
      const b = parseXY(endNode, fileName)
      points = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
    }
    if (points.length < 2) continue
    const layerNode = firstListNamed(gr, 'layer')
    const layerId = layerNode ? (atomsAfterHead(layerNode)[0] ?? 'Edge.Cuts') : 'Edge.Cuts'
    const strokeNode = firstListNamed(gr, 'stroke')
    const wNode = (strokeNode ? firstListNamed(strokeNode, 'width') : undefined) ?? firstListNamed(gr, 'width')
    const width = wNode ? toNumber(atomsAfterHead(wNode)[0] ?? '0.1', fileName, 'outline width') : 0.1
    if (layerId === 'Edge.Cuts') {
      outline.push({ id: `o:${nextId(ids)}`, points, closed: isRect || points.length > 2, layerId })
    } else if (/\.SilkS$/.test(layerId)) {
      ensureLayer(layerId)
      silkFor(layerId).lines.push({ id: `sl:${nextId(ids)}`, points: [...points, points[0] as Vec2], width })
    }
    for (const p of points) bbox.point(p)
  }

  for (const ga of listsNamed(root, 'gr_arc')) {
    const startNode = firstListNamed(ga, 'start')
    const midNode = firstListNamed(ga, 'mid')
    const endNode = firstListNamed(ga, 'end')
    if (!startNode || !midNode || !endNode) continue
    const layerNode = firstListNamed(ga, 'layer')
    const layerId = layerNode ? (atomsAfterHead(layerNode)[0] ?? 'Edge.Cuts') : 'Edge.Cuts'
    const approx = approximateArc(parseXY(startNode, fileName), parseXY(midNode, fileName), parseXY(endNode, fileName))
    const strokeNode = firstListNamed(ga, 'stroke')
    const wNode = (strokeNode ? firstListNamed(strokeNode, 'width') : undefined) ?? firstListNamed(ga, 'width')
    const width = wNode ? toNumber(atomsAfterHead(wNode)[0] ?? '0.12', fileName, 'gr_arc width') : 0.12
    if (layerId === 'Edge.Cuts') {
      outline.push({ id: `o:${nextId(ids)}`, points: approx, closed: false, layerId })
    } else if (/\.SilkS$/.test(layerId)) {
      ensureLayer(layerId)
      silkFor(layerId).lines.push({ id: `sl:${nextId(ids)}`, points: approx, width })
    }
    for (const p of approx) bbox.point(p)
  }

  for (const gc of listsNamed(root, 'gr_curve')) {
    if (!onEdge(gc)) continue
    const pts = bezierOf(gc, fileName)
    if (pts.length < 2) continue
    outline.push({ id: `o:${nextId(ids)}`, points: pts, closed: false, layerId: 'Edge.Cuts' })
    for (const p of pts) bbox.point(p)
  }

  for (const gc of listsNamed(root, 'gr_circle')) {
    const centerNode = firstListNamed(gc, 'center')
    const endNode = firstListNamed(gc, 'end')
    if (!centerNode || !endNode || !onEdge(gc)) continue
    const center = parseXY(centerNode, fileName)
    const end = parseXY(endNode, fileName)
    const radius = Math.hypot(end.x - center.x, end.y - center.y)
    outline.push({ id: `o:${nextId(ids)}`, points: approximateFullCircle(center, radius), closed: true, layerId: 'Edge.Cuts' })
    bbox.radius(center, radius)
  }

  if (layersDecl) {
    for (const entry of children(layersDecl)) {
      if (!isList(entry)) continue
      const layerId = atomsAfterHead(entry)[0]
      if (layerId !== undefined) ensureLayer(layerId)
    }
  }

  const netDecls: SExprNode[][] = listsNamed(root, 'net')
  for (const nd of netDecls) {
    const atoms = atomsAfterHead(nd)
    const idTok = atoms[0]
    if (idTok === undefined) continue
    const id = Number.parseInt(idTok, 10)
    if (!Number.isFinite(id)) continue
    const name = atoms[1] ?? ''
    netNamesById.set(id, name)
  }
  for (const id of netNodesById.keys()) {
    if (!netNamesById.has(id)) netNamesById.set(id, `net${id}`)
  }
  const netsOut: Net[] = []
  for (const entry of netNamesById) {
    const id: number = entry[0]
    const name: string = entry[1]
    const refs = netNodesById.get(id)
    const nodeRefs: NetNodeRef[] = refs === undefined ? [] : [...refs]
    netsOut.push({ id, name: name === '' ? `net${id}` : name, nodeRefs })
  }
  netsOut.sort((a, b) => a.id - b.id)

  if (!bbox.started) throw new ParseError(fileName, 'the board is empty, with no outline, copper or parts yet')

  const stats = {
    traces: Object.values(copper).reduce((n, c) => n + c.traces.length, 0),
    pads: countUniquePads(padRecords),
    vias: Object.values(copper).reduce((n, c) => n + c.vias.length, 0),
    zones: Object.values(copper).reduce((n, c) => n + c.zones.length, 0),
    texts: Object.values(silkscreen).reduce((n, s) => n + s.texts.length, 0),
    drills: drill.length
  }

  return {
    source: { format: 'kicad', files: [fileName], boardName: boardNameOf(fileName) },
    stackup: parseStackup(root),
    bbox: { min: { x: bbox.minX, y: bbox.minY }, max: { x: bbox.maxX, y: bbox.maxY } },
    outline,
    layers,
    copper,
    silkscreen,
    footprints,
    drill,
    nets: netsOut,
    stats,
    warnings
  }
}

function parseStackup(root: SExprNode[]): Stackup {
  const general = firstListNamed(root, 'general')
  const th = general ? firstListNamed(general, 'thickness') : undefined
  const thickness = Number.parseFloat(th ? (atomsAfterHead(th)[0] ?? '') : '')
  const setup = firstListNamed(root, 'setup')
  const stack = setup ? firstListNamed(setup, 'stackup') : undefined
  let maskColor: string | undefined
  let finish: string | undefined
  if (stack !== undefined) {
    for (const layer of listsNamed(stack, 'layer')) {
      if (atomsAfterHead(layer)[0] !== 'F.Mask') continue
      const color = firstListNamed(layer, 'color')
      if (color !== undefined) maskColor = atomsAfterHead(color)[0]
    }
    const fin = firstListNamed(stack, 'copper_finish')
    if (fin !== undefined) finish = atomsAfterHead(fin)[0]
  }
  return { thickness: Number.isFinite(thickness) && thickness > 0 ? thickness : 1.6, maskColor, finish }
}

function countUniquePads(records: { key: string }[]): number {
  const seen = new Set<string>()
  for (const r of records) seen.add(r.key)
  return seen.size
}

function boardNameOf(fileName: string): string {
  const base = fileName.split('/').at(-1) ?? fileName
  return base.replace(/\.kicad_pcb$/i, '')
}

function resolvePadLayers(layerSpec: string[], declaredCopperLayerIds: string[], fallback: string[]): string[] {
  const out: string[] = []
  const add = (layerId: string): void => {
    if (!out.includes(layerId)) out.push(layerId)
  }
  for (const tok of layerSpec) {
    if (tok === '*.Cu') {
      for (const layerId of declaredCopperLayerIds) add(layerId)
    } else if (tok === 'F&B.Cu') {
      add('F.Cu')
      add('B.Cu')
    } else if (/\.Cu$/.test(tok)) {
      add(tok)
    }
  }
  return out.length > 0 ? out : fallback
}

interface ArcGeo {
  cx: number
  cy: number
  r: number
  startAngle: number
  midAngle: number
  endAngle: number
}

function circleFrom3(a: Vec2, m: Vec2, b: Vec2): ArcGeo | undefined {
  const ax = a.x
  const ay = a.y
  const bx = m.x
  const by = m.y
  const cx = b.x
  const cy = b.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-9) return undefined
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  if (!Number.isFinite(r) || r <= 0) return undefined
  return {
    cx: ux,
    cy: uy,
    r,
    startAngle: Math.atan2(ay - uy, ax - ux),
    midAngle: Math.atan2(by - uy, bx - ux),
    endAngle: Math.atan2(cy - uy, cx - ux)
  }
}

function normalizeAngle(a: number): number {
  let x = a
  while (x > Math.PI) x -= 2 * Math.PI
  while (x < -Math.PI) x += 2 * Math.PI
  return x
}

// arcs and circles become polylines with segments no longer than this, in mm
const MAX_SEGMENT = 0.4

function approximateArc(a: Vec2, m: Vec2, b: Vec2): Vec2[] {
  const geo = circleFrom3(a, m, b)
  if (geo === undefined) return [a, b]
  const dir = normalizeAngle(geo.midAngle - geo.startAngle) >= 0 ? 1 : -1
  let sweep = dir * normalizeAngle(geo.endAngle - geo.startAngle)
  if (sweep < 0) sweep += 2 * Math.PI
  if (sweep === 0) sweep = 2 * Math.PI
  const steps = Math.min(96, Math.max(2, Math.ceil((geo.r * sweep) / MAX_SEGMENT)))
  const out: Vec2[] = []
  for (let i = 0; i <= steps; i++) {
    const t = geo.startAngle + (sweep * i) / steps
    out.push({ x: geo.cx + geo.r * Math.cos(t), y: geo.cy + geo.r * Math.sin(t) })
  }
  return out
}

function bezierOf(node: SExprNode[], fileName: string): Vec2[] {
  const ptsNode = firstListNamed(node, 'pts')
  const ctrl = ptsNode ? listsNamed(ptsNode, 'xy').map((xy) => parseXY(xy, fileName)) : []
  if (ctrl.length !== 4) return ctrl
  const [a, b, c, d] = ctrl as [Vec2, Vec2, Vec2, Vec2]
  const hull = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y)
  const steps = Math.min(96, Math.max(2, Math.ceil(hull / MAX_SEGMENT)))
  const out: Vec2[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const
    out.push({ x: k[0] * a.x + k[1] * b.x + k[2] * c.x + k[3] * d.x, y: k[0] * a.y + k[1] * b.y + k[2] * c.y + k[3] * d.y })
  }
  return out
}

function approximateFullCircle(c: Vec2, r: number): Vec2[] {
  const safeR = r > 0 ? r : 0.01
  const steps = Math.min(96, Math.max(8, Math.ceil((2 * Math.PI * safeR) / MAX_SEGMENT)))
  const out: Vec2[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (2 * Math.PI * i) / steps
    out.push({ x: c.x + safeR * Math.cos(t), y: c.y + safeR * Math.sin(t) })
  }
  return out
}

function modelRefs(fpNode: SExprNode[], fileName: string): ModelRef[] {
  return listsNamed(fpNode, 'model').flatMap((model) => {
    const path = atomsAfterHead(model)[0]
    const hidden = atomsAfterHead(model).includes('hide') || atomsAfterHead(firstListNamed(model, 'hide') ?? [])[0] === 'yes'
    if (path === undefined || hidden) return []
    const xyz = (name: string, fallback: number, unit = 1): Vec3 => {
      const node = firstListNamed(firstListNamed(model, name) ?? [], 'xyz')
      const [x, y, z] = node ? atomsAfterHead(node).map((a) => toNumber(a, fileName, `model ${name}`) * unit) : []
      return { x: x ?? fallback, y: y ?? fallback, z: z ?? fallback }
    }
    // KiCad 5 and older wrote the offset as (at) in inches
    const offset = firstListNamed(model, 'offset') ? xyz('offset', 0) : xyz('at', 0, 25.4)
    return [{ path, offset, scale: xyz('scale', 1), rotate: xyz('rotate', 0) }]
  })
}

function modelName(fpNode: SExprNode[]): string | undefined {
  const model = firstListNamed(fpNode, 'model')
  const path = model ? atomsAfterHead(model)[0] : undefined
  return path?.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, '')
}
