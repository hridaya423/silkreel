import type { BoardModel, Footprint, Pad, Vec2 } from '@silk-reel/ingest'
import type { PartKind } from '../types'

/**
 * Component bodies, estimated from what a footprint carries: its pads and
 * its silk outline. Not CAD-accurate — a QFP is a black slab inside its pin
 * ring, an 0402 is a sliver between its pads, a header is a plastic bar —
 * but at film scale that is what the eye reads as "a populated board".
 */
export interface PartMm {
  ref: string
  value: string | undefined
  /** body centre and size in mm, in the footprint's own frame */
  pos: Vec2
  w: number
  h: number
  /** footprint rotation, degrees (KiCad convention) */
  rot: number
  /** body height, mm */
  z: number
  kind: PartKind
  back: boolean
  /** pad count — the hero is the part with most */
  pads: number
  /** centre-to-centre pad spacing, mm (nearest neighbour, median) */
  pitch: number
  /** a vertical pin header's pins, board mm, standing pinZ mm above the board */
  pins?: Vec2[] | undefined
  pinZ?: number | undefined
}

const SKIP = /^(H|MH|TP|FID|G|LOGO|REF|#|NT|JP\d|MK|KEY|SH)/i

function kindOf(ref: string, value: string | undefined, nPads: number, tht: boolean, spanMm: number): PartKind {
  const r = ref.toUpperCase()
  const v = (value ?? '').toUpperCase()
  if (/^(U|IC)\d/.test(r) || (/^Q\d/.test(r) && nPads >= 3)) return 'ic'
  if (/^(Y|X|XTAL|OSC)\d/.test(r) || /MHZ|XTAL|CRYSTAL/.test(v)) return 'xtal'
  if (/^(LED|D)\d/.test(r) && /LED|WS28|SK68|APA10/.test(v + r)) return 'led'
  if (/^D\d/.test(r)) return 'diode'
  if (/^(J|P|CN|CON|USB|X)\d/.test(r)) return 'conn'
  if (/^(SW|S|BTN|K)\d/.test(r)) return 'switch'
  if (/^C\d/.test(r)) return tht && spanMm > 2.4 ? 'can' : 'cap'
  if (/^(R|RN)\d/.test(r)) return 'res'
  if (/^(L|FB)\d/.test(r)) return 'ind'
  return 'other'
}

const HEIGHT: Record<PartKind, (w: number, h: number) => number> = {
  ic: (w, h) => Math.min(1.6, 0.8 + 0.04 * Math.max(w, h)),
  res: (w, h) => Math.min(0.6, 0.25 + 0.12 * Math.min(w, h)),
  cap: (w, h) => Math.min(1.4, 0.35 + 0.25 * Math.min(w, h)),
  ind: (w, h) => Math.min(2.5, 0.5 + 0.3 * Math.min(w, h)),
  diode: (w, h) => Math.min(1.2, 0.4 + 0.2 * Math.min(w, h)),
  led: () => 0.6,
  xtal: (w, h) => Math.min(3.5, 0.8 + 0.25 * Math.min(w, h)),
  conn: (w, h) => Math.min(6, 2.2 + 0.25 * Math.min(w, h)),
  switch: (w, h) => Math.min(4, 1.2 + 0.3 * Math.min(w, h)),
  can: (w, h) => Math.min(9, 1.2 * Math.min(w, h)),
  // a noval tube stands about 2.2 bulb diameters tall
  valve: (w, h) => 2.2 * Math.min(w, h),
  pin: () => 8.5,
  other: (w, h) => Math.min(1.5, 0.4 + 0.15 * Math.min(w, h))
}

export function extractParts(board: BoardModel): PartMm[] {
  const padsOf = new Map<string, Map<string, { pad: Pad; layers: number }>>()
  for (const copper of Object.values(board.copper)) {
    for (const pad of copper.pads) {
      if (pad.footprintRef === undefined) continue
      let m = padsOf.get(pad.footprintRef)
      if (m === undefined) {
        m = new Map()
        padsOf.set(pad.footprintRef, m)
      }
      const rec = m.get(pad.id)
      if (rec === undefined) m.set(pad.id, { pad, layers: 1 })
      else rec.layers += 1
    }
  }
  const silkById = new Map<string, Vec2[]>()
  for (const layer of Object.values(board.silkscreen)) for (const line of layer.lines) silkById.set(line.id, line.points)

  const out: PartMm[] = []
  for (const fp of board.footprints) {
    if (SKIP.test(fp.ref) || /\*/.test(fp.ref)) continue
    const pads = [...(padsOf.get(fp.ref)?.values() ?? [])]
    if (pads.length === 0) continue
    const body = bodyOf(fp, pads.map((p) => p.pad), fp.silkRefs.flatMap((id) => silkById.get(id) ?? []))
    if (body === undefined) continue
    const tht = pads.some((p) => p.layers > 1)
    // KiCad's own 3D model names a vertical header or socket: a plastic housing, pins standing out of a header
    const header = /^Pin(Header|Socket)_(\d+)x\d+_P([\d.]+)mm_(Vertical|Horizontal)/.exec(fp.model ?? '')
    const kind = header !== null ? 'conn' : tht && onCircle(pads.map((p) => p.pad.pos)) ? 'valve' : kindOf(fp.ref, fp.value, pads.length, tht, body.span)
    // two-pad passives sit between their pads, not over them
    let { w, h } = body
    if ((kind === 'res' || kind === 'cap' || kind === 'ind' || kind === 'diode' || kind === 'led') && pads.length === 2 && !tht) {
      w = Math.max(0.3, w * 0.86)
      h = Math.max(0.2, h * 0.92)
    }
    if (kind === 'can') {
      const d = Math.max(w, h)
      w = d
      h = d
    }
    let centre = body.centre
    if (kind === 'valve') {
      // the bulb stands on the pin circle and is about 1.85 times its diameter
      const pts = pads.map((p) => p.pad.pos)
      const d = 1.85 * 2 * meanRadius(pts)
      w = d
      h = d
      centre = circleOf(pts)
    }
    const pitchMm = Number(header?.[3] ?? 2.54)
    const lying = header?.[4] === 'Horizontal'
    const male = header?.[1] === 'Header' && !lying
    out.push({
      ref: fp.ref,
      value: fp.value,
      pos: centre,
      w,
      h,
      rot: fp.rot,
      // a right-angle part lies on its side: as tall as its rows
      z: header === null ? HEIGHT[kind](w, h) : lying ? Number(header[2]) * pitchMm + 0.4 : (male ? 2.5 : 8.5) * pitchMm / 2.54,
      ...(male ? { pins: pads.map((p) => p.pad.pos), pinZ: 8.5 * pitchMm / 2.54 } : {}),
      kind,
      back: fp.layer.startsWith('B.'),
      pads: pads.length,
      pitch: pitchOf(pads.map((p) => p.pad.pos))
    })
  }
  return out
}

const centroid = (pts: Vec2[]): Vec2 => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length
})

/**
 * The least-squares circle through the points (Kasa fit). A noval socket
 * leaves one of its ten pin places empty, so the centroid is off centre.
 */
function circleOf(pts: Vec2[]): Vec2 {
  const m = centroid(pts)
  let suu = 0
  let suv = 0
  let svv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let svuu = 0
  for (const p of pts) {
    const u = p.x - m.x
    const v = p.y - m.y
    suu += u * u
    suv += u * v
    svv += v * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return m
  const bu = (suuu + suvv) / 2
  const bv = (svvv + svuu) / 2
  return { x: m.x + (bu * svv - bv * suv) / det, y: m.y + (bv * suu - bu * suv) / det }
}

function meanRadius(pts: Vec2[]): number {
  const c = circleOf(pts)
  return pts.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / pts.length
}

/** seven or more pins ringing one circle of at least 3 mm radius: a tube socket */
function onCircle(pts: Vec2[]): boolean {
  if (pts.length < 7) return false
  const c = circleOf(pts)
  const r = pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y))
  const mean = r.reduce((s, x) => s + x, 0) / r.length
  const angles = pts.map((p) => Math.atan2(p.y - c.y, p.x - c.x)).sort((a, b) => a - b)
  const gap = Math.max(2 * Math.PI + (angles[0] as number) - (angles[angles.length - 1] as number), ...angles.slice(1).map((a, i) => a - (angles[i] as number)))
  return mean > 3 && gap < Math.PI / 2 && Math.max(...r.map((x) => Math.abs(x - mean))) < 0.08 * mean
}

function pitchOf(pts: Vec2[]): number {
  if (pts.length < 2) return 0
  const near = pts.map((a) => Math.min(...pts.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))))
  near.sort((a, b) => a - b)
  return near[Math.floor(near.length / 2)] as number
}

interface Body { centre: Vec2; w: number; h: number; span: number }

/**
 * The body box in the footprint's frame. A silk outline that encloses most
 * of the pads is the body; otherwise the pads' extent, pulled in for
 * perimeter-pin packages (the pins sit outside a QFP's body).
 */
function bodyOf(fp: Footprint, pads: Pad[], silk: Vec2[]): Body | undefined {
  const a = (-fp.rot * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const local = (p: Vec2): Vec2 => {
    const dx = p.x - fp.pos.x
    const dy = p.y - fp.pos.y
    return { x: dx * c - dy * s, y: dx * s + dy * c }
  }
  const box = (pts: Array<{ p: Vec2; rx: number; ry: number }>): { x0: number; y0: number; x1: number; y1: number } => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const { p, rx, ry } of pts) {
      x0 = Math.min(x0, p.x - rx)
      y0 = Math.min(y0, p.y - ry)
      x1 = Math.max(x1, p.x + rx)
      y1 = Math.max(y1, p.y + ry)
    }
    return { x0, y0, x1, y1 }
  }
  const padPts = pads.map((pad) => {
    const rr = Math.abs(((pad.rot - fp.rot) % 180 + 180) % 180 - 90) < 45
    return { p: local(pad.pos), rx: (rr ? pad.size.y : pad.size.x) / 2, ry: (rr ? pad.size.x : pad.size.y) / 2 }
  })
  const pb = box(padPts)
  const centres = box(padPts.map((q) => ({ p: q.p, rx: 0, ry: 0 })))
  const span = Math.max(centres.x1 - centres.x0, centres.y1 - centres.y0)
  if (!Number.isFinite(pb.x0)) return undefined
  const pw = pb.x1 - pb.x0
  const ph = pb.y1 - pb.y0
  let b = pb
  if (silk.length >= 2) {
    const sb = box(silk.map((p) => ({ p: local(p), rx: 0, ry: 0 })))
    const sw = sb.x1 - sb.x0
    const sh = sb.y1 - sb.y0
    // a believable outline: roughly the pads' size, not a courtyard or a lone tick
    if (sw > 0.3 && sh > 0.3 && sw * sh > 0.35 * pw * ph && sw * sh < 4 * pw * ph + 4) b = sb
  } else if (pads.length >= 8) {
    // perimeter pins: the body is inside the ring
    const minPad = Math.min(...pads.map((p) => Math.min(p.size.x, p.size.y)))
    const maxPad = Math.max(...pads.map((p) => Math.max(p.size.x, p.size.y)))
    const inset = Math.max(0, maxPad - minPad) * 0.6
    b = { x0: pb.x0 + inset, y0: pb.y0 + inset, x1: pb.x1 - inset, y1: pb.y1 - inset }
  }
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  if (!(w > 0.15 && h > 0.15)) return undefined
  // back to board coords
  const cxl = (b.x0 + b.x1) / 2
  const cyl = (b.y0 + b.y1) / 2
  const ca = Math.cos(-a)
  const sa = Math.sin(-a)
  return { centre: { x: fp.pos.x + cxl * ca - cyl * sa, y: fp.pos.y + cxl * sa + cyl * ca }, w, h, span }
}
