import type { BoardModel, Footprint, Pad, Trace, Vec2 } from '@silk-reel/ingest'
import { boardTitle } from '../board-title'
import { sampleShot } from './camera'
import type { ResolvedConfig } from '../config'
import { planDuration } from '../config'
import type { BoardArchetype, CameraShot, PlotBeats, PlotPlan, PlotBody, PlotBodyStyle, PlotSigData, PlotStation, TracePad, TracePart, TraceVia, FlatPath, PlotAxo, PlotFacts, PlotShotKind, PlotCallout, PlotEvent, PlotFlowSeg, PlotMark, PlotInk, PlotPlace, PlotRect, PlotScore, PlotSection, PlotHidden, PlotStroke, TraceGroup, TraceLayer, TraceZone } from '../types'
import { boardCharacter } from './archetype'
import { boardFacts, isComponent } from './facts'
import { extractParts } from './parts'
import { bareName, netKind } from './nets'

const B = 1 / 24
const D = Math.PI / 180

export const PLOT_BEATS = { nib: [0, 3], bus: [3, 6], outline: [6, 8], object: [8, 17], sheet: [17, 24] } as const

export interface PlotInput {
  board: BoardModel
  resolved: ResolvedConfig
  layers: TraceLayer[]
  zones: TraceZone[]
  groups: TraceGroup[]
  loops: FlatPath[]
  hero: Vec2
  heroRef: string | undefined
  heroLabel: string | undefined
  heroSize: number
  entry: Vec2[]
  tallest: number
  pxPerMm: number
  map: (p: Vec2) => Vec2
  back: boolean
  /** the scene's part bodies, board px (pins left out) */
  parts: Array<{ x: number; y: number; w: number; h: number; rot: number; z: number; hero?: boolean | undefined }>
  /** the scene's pins standing in headers, board px: posts that can hide the chip in the end view; seat is the height of the housing each stands in */
  pins?: Array<{ x: number; y: number; w: number; h: number; rot: number; z: number; seat?: number | undefined }> | undefined
  /** the tallest body is a real model, not an estimate */
  measured: boolean
  pads: TracePad[]
  vias: TraceVia[]
}

type P2 = [number, number]

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const NICE = [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20]
const VERT = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50]

/** an elevation's vertical exaggeration as the note prints it: the drawing's height over its true height, never under 1 */
export const vertScale = (v: number): string => `VERT. ×${Number(v.toFixed(2))}`

/** the elevation panel's title notes: the board's thickness and the exaggeration on one line, or the exaggeration alone when both will not fit */
export const elevationNotes = (thicknessMm: number, v: number, w: number, W: number, H: number): string[] => {
  const vert = v !== 1 ? [vertScale(v)] : []
  const both = [`BOARD ${thicknessMm} MM`, ...vert]
  return titleLines('ELEVATION', both, w, W, H).length === 1 ? both : vert
}
const dist = (a: P2, b: P2): number => Math.hypot(b[0] - a[0], b[1] - a[1])
const rot = (p: P2, r: number): P2 => [Math.cos(r) * p[0] - Math.sin(r) * p[1], Math.sin(r) * p[0] + Math.cos(r) * p[1]]
const wrap = (r: number): number => Math.atan2(Math.sin(r), Math.cos(r))

const bounds = (loops: FlatPath[]): { x0: number; y0: number; x1: number; y1: number } => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const l of loops) {
    for (let i = 0; i + 1 < l.length; i += 2) {
      x0 = Math.min(x0, l[i] as number)
      x1 = Math.max(x1, l[i] as number)
      y0 = Math.min(y0, l[i + 1] as number)
      y1 = Math.max(y1, l[i + 1] as number)
    }
  }
  return { x0, y0, x1, y1 }
}



/** the drafting face's cap height over its size */
export const CAP = 736 / 1024
/** the one label size, px per 1080 of the text unit: a cap height of 2.46% of it */
export const SHEET_TEXT = 37
/** labels have one size: second lines print at it too */
export const SHEET_SUB = SHEET_TEXT
/** the key size, the title's: half as large again as a label */
export const SHEET_KEY = 1.5 * SHEET_TEXT
/** the least cap height a label may have on a frame's short side, for a word to be read on a phone */
export const READ_CAP = 0.026
/** the text unit: the frame's width over 1080, raised where a label would fall under the readable cap height on the short side */
export const sheetUnit = (W: number, H: number): number => Math.max(W / 1080, (READ_CAP * Math.min(W, H)) / (SHEET_TEXT * CAP))
/** film callouts, px at 1080: the label size */
export const FILM_TEXT = SHEET_TEXT
export const FILM_SUB = SHEET_SUB
const textW = (n: number, size: number): number => n * size * 0.66

/** a panel title line's baseline below the panel's top edge: a cap height of paper above its first line */
export const panelTitleY = (i: number, W: number, H: number): number => (1.6 + 1.45 * i) * SHEET_TEXT * sheetUnit(W, H)

/** the inner drawing area of a panel, under its label and its note lines */
export function panelArea(r: PlotRect, W: number, H: number, lines = 1): PlotRect {
  const T = SHEET_TEXT * sheetUnit(W, H)
  const m = Math.max(0.018 * Math.min(W, H), 0.8 * T)
  const top = panelTitleY(lines - 1, W, H) + 0.5 * T
  return { x: r.x + m, y: r.y + top, w: r.w - 2 * m, h: r.h - top - m }
}

/** the sheet's border frame: the same margin all round */
export function sheetFrame(W: number, H: number): PlotRect {
  const m = 0.03 * Math.min(W, H)
  return { x: m, y: m, w: W - 2 * m, h: H - 2 * m }
}

/** how far a panel's title sits in from its left and right edges: never less than a cap height of the sheet's text */
export const panelInset = (W: number, H: number): number => Math.max(0.018 * Math.min(W, H), 0.8 * SHEET_TEXT * sheetUnit(W, H))

/** a panel's title lines: its name, then its notes on the same line while they fit the panel's width */
export function titleLines(label: string, notes: string[], w: number, W: number, H: number): string[] {
  const T = SHEET_TEXT * sheetUnit(W, H)
  const room = w - 2 * panelInset(W, H) - 1.6 * T
  const lines = [label]
  for (const note of notes) {
    const last = lines[lines.length - 1] as string
    if (textW(last.length + 3 + note.length, T) <= room) lines[lines.length - 1] = `${last} · ${note}`
    else if (textW(note.length, T) <= room) lines.push(note)
    else note.split(' ').forEach((word, i) => {
      const prev = lines[lines.length - 1] as string
      if (i > 0 && textW(prev.length + 1 + word.length, T) <= room) lines[lines.length - 1] = `${prev} ${word}`
      else lines.push(word)
    })
  }
  return lines
}

/** the detail panel's note on its subject, left out when the panel is too narrow to give it a line of its own */
export function detailNotes(subject: string | undefined, w: number, W: number, H: number): string[] {
  const note = subject === undefined ? [] : [subject]
  return titleLines('DETAIL A', ['20×', ...note], w, W, H).length <= 2 ? note : []
}

/** words of a value broken into lines that fit a width at a size */
export function wrapWords(text: string, w: number, size: number): string[] {
  const lines: string[] = []
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && textW(last.length + 1 + word.length, size) <= w) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
}

/** a title-block cell's width: its caption, then its value a size larger, a cap height clear of both rules */
export const cellNeed = (cap: string, val: string, u: number): number => {
  const size = SHEET_SUB * u
  return textW(cap.length, size) + 0.6 * size + textW(val.length, SHEET_TEXT * u) + (cap === 'REV' ? 1.3 * size : 0) + 1.2 * size
}

/** the name strip's one row of cells: the name gives up its last words first, then SIDE leaves, then REV, when the row will not fit the width at the label size */
export function stripCells(fields: Array<[string, string]>, w: number, u: number): Array<[string, string]> {
  const fit = (row: Array<[string, string]>): boolean => row.reduce((t, [c, v]) => t + cellNeed(c, v, u), 0) <= w
  const words = (fields.find(([c]) => c === 'DRAWING')?.[1] ?? '').split(' ')
  for (let n = words.length; n >= 1; n--) {
    const row = fields.map(([c, v]): [string, string] => [c, c === 'DRAWING' ? words.slice(0, n).join(' ') : v])
    if (fit(row)) return row
  }
  const drops = [['SIDE'], ['SIDE', 'REV']]
  for (const d of drops) {
    const row = fields.filter(([c]) => !d.includes(c))
    if (fit(row)) return row
  }
  return fields.filter(([c]) => c === 'DRAWING')
}

interface Layout {
  frame: PlotRect
  title: PlotRect
  rects: Record<'hero' | 'plan' | 'block', PlotRect> & { stack?: PlotRect; detail?: PlotRect; elevation?: PlotRect }
}

/** the name strip's height: one line of labels with half a label clear above and below */
export const stripHeight = (W: number, H: number): number => 2 * SHEET_TEXT * sheetUnit(W, H)

/** the name strip: the bottom of the sheet frame, the same place on every frame of the film */
export function nameStrip(W: number, H: number): PlotRect {
  const f = sheetFrame(W, H)
  const h = stripHeight(W, H)
  return { x: f.x, y: f.y + f.h - h, w: f.w, h }
}

function nameKey(name: string, w: number, W: number, H: number, h?: number): { size: number; lines: string[] } {
  const K = SHEET_KEY * sheetUnit(W, H)
  const T = SHEET_TEXT * sheetUnit(W, H)
  const sizes = Array.from({ length: 9 }, (_, i) => K - ((K - T) * i) / 8)
  const set = (size: number, most: number, room: number | undefined): { size: number; lines: string[] } | undefined => {
    const lines = wrapWords(name.toUpperCase(), w, size * 1.15)
    const fits = lines.length <= most && lines.every((l) => textW(l.length, size * 1.15) <= w)
    return fits && (room === undefined || 0.5 * T + 1.2 * lines.length * size + 5.8 * T <= room + 1e-6) ? { size, lines } : undefined
  }
  return sizes.map((q) => set(q, 2, h)).find((q) => q !== undefined) ?? set(T, 2, undefined) ?? set(T, Infinity, undefined) ?? { size: T, lines: wrapWords(name.toUpperCase(), w, T * 1.15) }
}

/** the name's letter size on the sheet: the key size on one or two lines broken between words, else smaller, never below the label size */
export const keySize = (name: string, w: number, W: number, H: number, h?: number): number => nameKey(name, w, W, H, h).size

/** the title's lines in a width at the name's size; none when the name will not fit at the label size */
export const keyLines = (name: string, w: number, W: number, H: number, h?: number): string[] => nameKey(name, w, W, H, h).lines

/** the title's second line: the board's copper and size, after the file's own title when that names something else and the line stays under 32 letters */
export function subtitleOf(F: Pick<PlotFacts, 'title' | 'copperLayers' | 'widthMm' | 'heightMm'>): string {
  const core = `${F.copperLayers}-LAYER PCB · ${F.widthMm} × ${F.heightMm} MM`
  const long = F.title === undefined ? core : `${F.title.toUpperCase()} · ${core}`
  return long.length < 32 ? long : core
}

/** the hero panel's drawing area: the panel inside its inset; the title's box at its head is kept clear like a callout */
export function heroArea(hero: PlotRect, W: number, H: number): PlotRect {
  const m = panelInset(W, H)
  return { x: hero.x + m, y: hero.y + 0.25 * m, w: hero.w - 2 * m, h: hero.h - 1.25 * m }
}

/** whether a sheet's plan panel has room for its outline dimensions at the sheet's smaller type size */
export const planDims = (pa: PlotRect, su: number): boolean => Math.min(pa.w, pa.h) >= 7.5 * SHEET_SUB * su

/** each part body the blueprint draws, read from its footprint: its pads, its pin 1, its value and how its body is drawn */
export function plotBodies(board: BoardModel, back: boolean, px: (v: Vec2) => P2): PlotBody[] {
  const padsOf = new Map<string, Pad[]>()
  for (const c of Object.values(board.copper)) for (const q of c.pads) if (q.footprintRef !== undefined && !(padsOf.get(q.footprintRef) ?? []).some((o) => o.id === q.id)) padsOf.set(q.footprintRef, [...(padsOf.get(q.footprintRef) ?? []), q])
  const fps = new Map(board.footprints.map((f) => [f.ref, f]))
  const pts = board.outline.flatMap((l) => l.points)
  const ex = { x0: Math.min(...pts.map((q) => q.x)), x1: Math.max(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), y1: Math.max(...pts.map((q) => q.y)) }
  const parts = extractParts(board).filter((pt) => pt.back === back)
  const seen = new Map<string, number>()
  for (const pt of parts) seen.set((pt.value ?? '').toUpperCase(), (seen.get((pt.value ?? '').toUpperCase()) ?? 0) + 1)
  return parts.map((pt): PlotBody => {
    const fp = fps.get(pt.ref)
    const pads = padsOf.get(pt.ref) ?? []
    const a = (pt.rot * Math.PI) / 180
    const local = (q: Vec2): P2 => [Math.cos(a) * (q.x - pt.pos.x) - Math.sin(a) * (q.y - pt.pos.y), Math.sin(a) * (q.x - pt.pos.x) + Math.cos(a) * (q.y - pt.pos.y)]
    const outside = pads.filter((q) => {
      const [lx, ly] = local(q.pos)
      return Math.abs(lx) > pt.w / 2 + 0.05 || Math.abs(ly) > pt.h / 2 + 0.05
    }).length
    const name = `${fp?.model ?? ''} ${fp?.footprint ?? ''} ${pt.value ?? ''}`
    const style: PlotBodyStyle = pt.kind === 'valve' ? 'valve'
      : pt.kind === 'can' ? 'elec'
        : pt.kind === 'conn' && /USB/i.test(name) ? 'usb'
          : pt.kind === 'conn' && /PinSocket|Socket_Strip/i.test(name) ? 'socket'
            : pt.kind === 'conn' && (pt.pins !== undefined || /PinHeader|Pin_Header|Header/i.test(name)) ? 'header'
              : pt.kind === 'ic' && pads.length >= 6 ? (outside >= 0.5 * pads.length ? 'gull' : 'lands')
                : pads.length === 2 && ['res', 'cap', 'ind', 'diode', 'led'].includes(pt.kind) ? 'passive'
                  : 'block'
    const one = pads.find((q) => q.num === '1' || q.num === 'A1')
    const toEdge = [[pt.pos.x - ex.x0, -1, 0], [ex.x1 - pt.pos.x, 1, 0], [pt.pos.y - ex.y0, 0, -1], [ex.y1 - pt.pos.y, 0, 1]].sort((u, v) => (u[0] as number) - (v[0] as number))[0] as number[]
    const c = px(pt.pos)
    const o = px({ x: pt.pos.x + (toEdge[1] as number), y: pt.pos.y + (toEdge[2] as number) })
    const ol = Math.hypot(o[0] - c[0], o[1] - c[1]) || 1
    const corner = (q: Pad): number[] => {
      const p0 = px(q.pos)
      const turned = Math.abs(Math.sin((q.rot * Math.PI) / 180)) > 0.7
      const p1 = px({ x: q.pos.x + (turned ? q.size.y : q.size.x), y: q.pos.y + (turned ? q.size.x : q.size.y) })
      return [p0[0], p0[1], Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1])]
    }
    return {
      x: c[0], y: c[1], ref: pt.ref, value: (pt.value ?? '').toUpperCase(), lone: seen.get((pt.value ?? '').toUpperCase()) === 1, style,
      pads: pads.map((q) => corner(q) as [number, number, number, number]),
      ...(one === undefined || pads.length < 3 ? {} : { pin1: px(one.pos) }),
      ...(style === 'usb' || (style === 'socket' && /Angled|Horizontal/i.test(fp?.footprint ?? '')) ? { open: [(o[0] - c[0]) / ol, (o[1] - c[1]) / ol] as [number, number] } : {})
    }
  })
}

/**
 * The sheet's panels: the name strip along the bottom and the hero panel
 * with the board. A wide frame, or a long board on any frame, sets the title
 * and the second view in a column beside the board; a narrow frame gives the
 * board the panel's whole width and sets the title and the second view in a
 * row under it.
 */
/** the rows the sheet keeps under the name for the film's sentence */
export const SAID_ROWS = 4

/** the second panel's title when it draws the ride's signal path once more over the plan */
export const PATH_PANEL = 'SIGNAL PATH'

/** the longest sentence the sheet's title box is sized for */
const SAID_CHARS = 40

function layoutSheet(W: number, H: number, name: string, said: number, beside = false, long = false, word = 0): Layout {
  const minWH = Math.min(W, H)
  const u = sheetUnit(W, H)
  const L = SHEET_TEXT * u
  const frame = sheetFrame(W, H)
  const block = nameStrip(W, H)
  const g = 0.012 * minWH
  const body = { x: frame.x, y: frame.y, w: frame.w, h: block.y - g - frame.y }
  const head = (r: PlotRect): PlotRect => {
    const room = r.w - 2 * panelInset(W, H)
    const lines = keyLines(name, room, W, H)
    const Kn = keySize(name, room, W, H)
    const w = Math.max(Math.min(room, 0.42 * r.w, textW(said, L)), ...lines.map((l) => textW(l.length, Kn * 1.15)))
    const rows = Math.max(SAID_ROWS, Math.ceil((1.25 * textW(said, L)) / Math.max(1, room)))
    return { x: r.x, y: r.y, w: Math.min(r.w, w + 2 * panelInset(W, H)), h: 0.5 * L + lines.length * 1.2 * Kn + (1.5 + 1.3 * (rows - 1)) * L + 0.4 * L }
  }
  if (W / H >= 1.15 || beside || long) {
    const tall = W / H < 1.15
    const sw = Math.max((tall ? 0.36 : 0.3) * body.w, textW(word, L) + 2 * panelInset(W, H))
    const hero = { x: body.x, y: body.y, w: body.w - sw - g, h: body.h }
    const plan0 = (tall ? 0.62 : 0.46) * body.h
    const key = nameKey(name, sw - 2 * panelInset(W, H), W, H, body.h - plan0 - g)
    const planH = key.lines.length <= 2 ? plan0 : plan0 - 1.2 * (key.lines.length - 2) * key.size - 1.3 * L
    const title = { x: hero.x + hero.w + g, y: body.y, w: sw, h: body.h - planH - g }
    const plan = { x: title.x, y: title.y + title.h + g, w: sw, h: planH }
    return { frame, title, rects: { hero, plan, block } }
  }
  const tw = Math.max(0.4 * body.w, Math.min(0.5 * body.w, head({ ...body, w: 0.5 * body.w }).w))
  const rowH = Math.max(0.24 * body.h, head({ ...body, w: tw }).h)
  const hero = { x: body.x, y: body.y, w: body.w, h: body.h - rowH - g }
  const title = { x: body.x, y: hero.y + hero.h + g, w: tw, h: rowH }
  const plan = { x: title.x + tw + g, y: title.y, w: body.w - tw - g, h: rowH }
  return { frame, title, rects: { hero, plan, block } }
}

/** the isometric elevation: a true isometric view's angle above the board */
/** boards longer than this ratio keep their long axis along a portrait frame's height through the tilt and lift */
export const LONG_BOARD = 2.4
/** the beats shot 1 keeps after its last stroke, for the pencil to slide out of the frame before the cut */
const NIB_EXIT = 0.6
/** the fastest the hand inks in shot 1, px a beat at 1080 */
const NIB_SPEED = 1200
const SHIFTS: Array<[number, number]> = [[0, 0], [0, 1], [-1, 0], [1, 0], [-1, 1], [1, 1], [0, -1], [-1, -1], [1, -1]]
/** the most the hero hold and the power push may enlarge the board over the poster's scale */
const FAR_RUN = 10
/** the share of the frame shot 1's ink spans once the camera has framed it */
const OPEN_FILL = 0.86
/** the parts a supply route names when it runs through their pads: capacitors, diodes, fuses and inductors */
const ON_ROUTE = /^(C|D|F|L|FB)\d/

/** how much closer than the whole object the camera follows the drawing, at its nearest */
const NEAR = 2.4

/** how far past the box of the lines already inked a line the pen draws in the opening may reach, so the opening keeps its framing */
const OPEN_ROOM = 1.3

/** the share of the opening's lines already inked on the first frame when it opens on the hero's own routes */
const PRE_INK = 0.12

/** how much taller than the board the drawing camera may frame a tall frame's close shots */
const LAND_TALL = 1.5

/** how low in the frame the drawing camera keeps the object's bottom edge, as a share of the frame's height */
const FILL_LOW = 0.85

/** the beats one body takes to be drawn, its edges growing along their length */
export const BODY_DRAW = 0.6

/** the share of the wave the camera spends riding the route; the rest opens out over the bodies off it */
export const RIDE = 0.7

/** how far in beats the inked signal path runs ahead of the camera riding it */
const TRAIL_LEAD = 0.6

const TRAIL_APART = 34
const TRAIL_CROWD = 0.3

function thinTrail(traces: Trace[], always: Set<number>, gap: number, pairOf: (net: number) => string | undefined): Set<number> {
  const along = new Map<number, P2[]>()
  for (const t of traces) {
    const net = t.netId ?? -1
    const pts = along.get(net) ?? []
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1] as Vec2
      const b = t.points[i] as Vec2
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (gap / 2)))
      for (let k = 0; k < n; k++) pts.push([a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n])
    }
    along.set(net, pts)
  }
  const cell = (q: P2): string => `${Math.floor(q[0] / gap)},${Math.floor(q[1] / gap)}`
  const grid = new Map<string, Array<{ q: P2; net: number }>>()
  const near = (q: P2, net: number): boolean => {
    const mate = pairOf(net)
    const [cx, cy] = [Math.floor(q[0] / gap), Math.floor(q[1] / gap)]
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if ((grid.get(`${cx + dx},${cy + dy}`) ?? []).some((r) => (mate === undefined || pairOf(r.net) !== mate) && Math.hypot(r.q[0] - q[0], r.q[1] - q[1]) < gap)) return true
    return false
  }
  const kept = new Set<number>()
  const order = [...along.keys()].sort((a, b) => Number(always.has(b)) - Number(always.has(a)) || (along.get(b)?.length ?? 0) - (along.get(a)?.length ?? 0) || a - b)
  for (const net of order) {
    const pts = along.get(net) ?? []
    if (!always.has(net) && pts.filter((q) => near(q, net)).length > TRAIL_CROWD * pts.length) continue
    kept.add(net)
    for (const q of pts) grid.set(cell(q), [...(grid.get(cell(q)) ?? []), { q, net }])
  }
  return kept
}

/** how much the camera's pace along the route follows the bodies it passes rather than the distance, so it crosses bare copper quickly */
const ROUTE_PACE = 0.5

/** the least share of the widest connector's signals another connector must carry for the route to visit it */
const BUS_SHARE = 0.5

/** the most places the route visits after the hero */
const ROUTE_ENDS = 8

/** the waypoints a route leg takes from the copper between its ends */
const ROUTE_BINS = 6

/** the most parts the route passes through between the hero and a connector */
const ROUTE_HOPS = 3

/** the most parts a net may touch for the route to follow it: a point-to-point signal, not a shared control bus */
const ROUTE_POINT = 3

/** how near the route a body must be to stand up as the camera passes, a share of the board's diagonal */
const ROUTE_REACH = 0.18

/** how many of the gaps between two off-route parts' draws the camera's follow of them spans, so it frames the part being drawn rather than the mean of several far apart */
const OFF_FOLLOW = 2

/**
 * The order the object's bodies are drawn in, as a wave: the hero first, then
 * the bodies within reach of the route (the board's own signal path, board
 * px) in the order the route reaches them, then the bodies off it while the
 * camera opens out; with no route, a sweep along the board's long axis from
 * the end nearer the seed. Each body is drawn over BODY_DRAW beats and
 * overlaps the next. The front is where the ink is going down at a beat, for
 * the camera to follow.
 */
export function drawWave(parts: Array<{ x: number; y: number; hero?: boolean | undefined }>, seed: P2, from: number, to: number, heroAt = from, route: P2[] = [], reach = Infinity, until = to): { draws: Array<{ x: number; y: number; t0: number; t1: number }>; front: ((b: number) => P2) | undefined; when?: (q: P2) => number } {
  if (parts.length === 0 || to - from < 2 * BODY_DRAW) return { draws: parts.map((q) => ({ x: q.x, y: q.y, t0: from, t1: from + BODY_DRAW })), front: undefined }
  const hero = parts.find((q) => q.hero === true)
  const start = hero === undefined || heroAt < from ? from : from + 0.5 * BODY_DRAW
  const span = Math.max(1e-6, to - BODY_DRAW - start)
  const handOff = heroAt >= from ? start + 0.5 * BODY_DRAW : from
  const lead = (b: number, w: P2): P2 => {
    if (hero === undefined) return w
    const f = clamp(b - handOff, 0, 1)
    const e = f * f * (3 - 2 * f)
    return [hero.x + (w[0] - hero.x) * e, hero.y + (w[1] - hero.y) * e]
  }
  const timed = (t0s: number[], heroT = heroAt): Array<{ x: number; y: number; t0: number; t1: number }> => parts.map((q, i) => {
    const t0 = q.hero === true ? heroT : (t0s[i] as number)
    return { x: q.x, y: q.y, t0, t1: t0 + (q.hero === true ? 1.5 * BODY_DRAW : BODY_DRAW) }
  })
  if (route.length >= 2) {
    const cum = route.reduce<number[]>((c, q, i) => [...c, i === 0 ? 0 : (c[i - 1] as number) + dist(route[i - 1] as P2, q)], [])
    const L = Math.max(1e-6, cum[cum.length - 1] as number)
    const near = (q: P2): { s: number; d: number } => route.slice(1).reduce((best, b, i) => {
      const a = route[i] as P2
      const ab: P2 = [b[0] - a[0], b[1] - a[1]]
      const l2 = Math.max(1e-9, ab[0] * ab[0] + ab[1] * ab[1])
      const t = clamp(((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / l2, 0, 1)
      const d = dist(q, [a[0] + ab[0] * t, a[1] + ab[1] * t])
      return d < best.d ? { s: (cum[i] as number) + t * Math.sqrt(l2), d } : best
    }, { s: 0, d: Infinity })
    const at = (s: number): P2 => {
      const i = Math.max(1, cum.findIndex((c) => c >= s))
      const a = route[i - 1] as P2
      const b = route[i] as P2
      const f = clamp((s - (cum[i - 1] as number)) / Math.max(1e-9, (cum[i] as number) - (cum[i - 1] as number)), 0, 1)
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
    }
    const proj = parts.map((q) => near([q.x, q.y]))
    const passed = hero !== undefined && dist(route[0] as P2, [hero.x, hero.y]) > 0.25 * Math.min(reach, L)
    const off: number[] = []
    for (let left = parts.map((_, i) => i).filter((i) => parts[i]?.hero !== true && (proj[i] as { d: number }).d > reach), cur = route[route.length - 1] as P2; left.length > 0;) {
      const k = left.reduce((b, i) => (dist([parts[i]?.x ?? 0, parts[i]?.y ?? 0], cur) < dist([parts[b]?.x ?? 0, parts[b]?.y ?? 0], cur) ? i : b))
      off.push(k)
      cur = [parts[k]?.x ?? 0, parts[k]?.y ?? 0]
      left = left.filter((i) => i !== k)
    }
    const ride = off.length > 0 ? Math.max(RIDE, 1 - 0.08 * off.length) * span : until - start
    const onS = parts.flatMap((_, i) => (off.includes(i) || parts[i]?.hero === true ? [] : [(proj[i] as { s: number }).s])).sort((a, b) => a - b)
    const pace = (sv: number): number => (1 - ROUTE_PACE) * (sv / L) + ROUTE_PACE * (onS.length === 0 ? sv / L : onS.filter((x) => x <= sv).length / onS.length)
    const grid = Array.from({ length: 201 }, (_, g) => pace((g / 200) * L))
    const unpace = (u: number): number => {
      const g = Math.max(1, grid.findIndex((v) => v >= u))
      const a = grid[g - 1] as number
      const b = grid[g] as number
      return ((g - 1 + (b > a ? clamp((u - a) / (b - a), 0, 1) : 0)) / 200) * L
    }
    const t0s = parts.map((_, i) => {
      const k = off.indexOf(i)
      if (k >= 0) return start + ride + ((k + 1) / off.length) * Math.max(0, until - to + span - ride)
      return start + pace((proj[i] as { s: number }).s) * Math.max(0, ride - BODY_DRAW)
    })
    const heroT = hero === undefined ? heroAt : (t0s[parts.indexOf(hero)] as number)
    const follow = clamp((OFF_FOLLOW * Math.max(0, until - to + span - ride)) / Math.max(1, off.length), 0.2, 0.5)
    const onRoute = (b: number): P2 => (passed ? at(unpace(clamp((b - from) / (start + ride - from), 0, 1))) : lead(b, at(unpace(clamp((b - start - 0.5 * BODY_DRAW) / Math.max(1e-6, ride - BODY_DRAW), 0, 1)))))
    const afterRide = (b: number): P2 => {
      const end = onRoute(b)
      if (off.length === 0) return end
      const ws = off.map((i) => Math.exp(-((((t0s[i] as number) + 0.5 * BODY_DRAW - b) / follow) ** 2)))
      const sum = ws.reduce((a, w) => a + w, 0)
      if (sum < 1e-9) return end
      const q: P2 = [off.reduce((a, i, k) => a + (ws[k] as number) * (parts[i]?.x ?? 0), 0) / sum, off.reduce((a, i, k) => a + (ws[k] as number) * (parts[i]?.y ?? 0), 0) / sum]
      const e = clamp(b - (start + ride - 0.5), 0, 1)
      const f = e * e * (3 - 2 * e)
      return [end[0] + (q[0] - end[0]) * f, end[1] + (q[1] - end[1]) * f]
    }
    return { draws: timed(t0s, passed ? heroT : heroAt), front: afterRide, when: (q: P2): number => start + pace(near(q).s) * ride }
  }
  const xs = parts.map((q) => q.x)
  const ys = parts.map((q) => q.y)
  const mid: P2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)
  const sign = (wide ? seed[0] - mid[0] : seed[1] - mid[1]) > 0 ? -1 : 1
  const keys = parts.map((q) => sign * (wide ? q.x - mid[0] : q.y - mid[1]))
  const k0 = Math.min(...keys)
  const k1 = Math.max(...keys)
  const draws = timed(keys.map((k) => start + ((k - k0) / Math.max(1e-6, k1 - k0)) * span))
  const front = (b: number): P2 => {
    const k = k0 + clamp((b - start) / span, 0, 1) * (k1 - k0)
    const nearest = parts.map((q, i) => ({ q, d: Math.abs((keys[i] as number) - k) })).sort((a, c) => a.d - c.d).slice(0, Math.max(3, Math.ceil(parts.length / 6)))
    const across = nearest.reduce((a, e) => a + (wide ? e.q.y : e.q.x), 0) / nearest.length
    const along = sign * k + (wide ? mid[0] : mid[1])
    return lead(b, wide ? [along, across] : [across, along])
  }
  return { draws, front }
}

/** the fallback span the supply route inks over when it has no stations, in beats */
export const FLOW = [15, 16.5] as const

/** the beat the camera starts pulling back off the supply route, and the beat it lands on the sheet */
export const PLOT_LAND = 18

/** the beats the plan tips up into the oblique over, and the beats the layers part over */
export const PLOT_TILT: [number, number] = [8, 9]
export const PLOT_LIFT: [number, number] = [9, 9.5]

/** the beats between two layers landing: half a beat, closer on a stack of six or more so the stack never outlasts the signature */
const landStep = (layers: number): number => (layers <= 5 ? 0.5 : 2 / (layers - 1))

/** the beat each gap between two layers closes on, top gap first, one a step from beat 10 */
export const layerLands = (layers: number): number[] => Array.from({ length: Math.max(0, layers - 1) }, (_, j) => 10 + landStep(layers) * j)

/** a move that starts gently and spends the last half of its time on its last fifth of distance */
export const settle = (t: number): number => {
  const u = 1 - (1 - t) ** 1.8
  return u * u * (3 - 2 * u)
}

/** the beat the parts set down on the board: a step after the last layer */
export const partsLand = (layers: number): number => 10 + landStep(layers) * Math.max(0, layers - 1)

/** the routed length of a board's differential pairs, mm: for each pair named by polarity (D+/D−, _P/_N), the shorter of its two nets' track lengths */
export function pairedRun(board: BoardModel): number {
  const len = new Map<number, number>()
  for (const c of Object.values(board.copper)) for (const t of c.traces) for (let i = 1; i < t.points.length; i++) {
    const a = t.points[i - 1] as Vec2
    const b = t.points[i] as Vec2
    len.set(t.netId ?? -1, (len.get(t.netId ?? -1) ?? 0) + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const nets = board.nets.map((n) => ({ id: n.id, p: polarity(bareName(n.name)) }))
  return nets.reduce((t, a) => {
    if (a.p === undefined || (a.p.pol !== '+' && a.p.pol !== '_P')) return t
    const b = nets.find((q) => q.p?.base === a.p?.base && q.p?.pol === (a.p?.pol === '+' ? '-' : '_N'))
    return b === undefined ? t : t + Math.min(len.get(a.id) ?? 0, len.get(b.id) ?? 0)
  }, 0)
}

/** the most distinct pins any one connector of a board carries */
export function headerPins(board: BoardModel): number {
  const pins = new Map<string, Set<string>>()
  for (const c of Object.values(board.copper)) for (const q of c.pads) if (q.footprintRef !== undefined && CONN.test(q.footprintRef)) pins.set(q.footprintRef, (pins.get(q.footprintRef) ?? new Set()).add(q.num ?? q.id))
  return Math.max(0, ...[...pins.values()].map((x) => x.size))
}

/** the film's plan from the board's archetype and two measures: a board of headers and LEDs whose differential pairs run longer than its largest header's row (2.54 mm a pin) films its pairs, otherwise its header */
export const plotPlanOf = (arch: BoardArchetype, pairedMm: number, pins: number): PlotPlan => (arch === 'leds' ? (pairedMm > 2.54 * pins ? 'pair' : 'header') : arch)

/** each plan's shots in order: the board's one thing (the stick's chip, the valve's section, the pair alone), the travel along its signal to the main chip, one turn into the axonometric drawing, the pull back onto the sheet; no shot holds the whole board before the pull, and a film that travels drops its opening on the chip, so the chip's signals are first drawn when the travel reaches it */
export const ORDER: Record<PlotPlan, PlotShotKind[]> = {
  stick: ['open', 'signature', 'tilt', 'assembly', 'pull', 'sheet', 'hold'],
  valve: ['signature', 'tilt', 'assembly', 'pull', 'sheet', 'hold'],
  header: ['outline', 'section', 'tilt', 'assembly', 'pull', 'sheet', 'hold'],
  pair: ['signature', 'outline', 'section', 'tilt', 'assembly', 'pull', 'sheet', 'hold'],
  card: ['open', 'signature', 'macro', 'outline', 'section', 'tilt', 'assembly', 'detail', 'pull', 'sheet', 'hold'],
  dense: ['open', 'macro', 'outline', 'section', 'tilt', 'assembly', 'detail', 'pull', 'sheet', 'hold']
}

/** the beats the travel holds on the main chip before the turn: one still beat with nothing drawn, then three the chip's signals fan out in, one after another round the chip, as the camera rises */
const TRAVEL_HOLD = 4
/** a film that opens on its macro holds it FIRST_MACRO beats, so its caption, which names the ride's signal, its length and its end, stands whole for a second before the ride */
const FIRST_MACRO = 3
/** the macro slides onto its bus in at most MACRO_SLIDE beats, then holds, so its caption stands still to be read */
const MACRO_SLIDE = 1.6
/** the least width of the signal's yellow on the ride, as a share of the frame's width: 4 px on a phone */
export const SIGNAL_WIDE = 0.01
/** in the tilt and the end view the signal keeps a heavy pen at least SIGNAL_HEAVY of the frame's width */
export const SIGNAL_HEAVY = 0.005
/** the beats of its first stroke a ride has drawn by frame 0, so its yellow is on the sheet from the first frame */
const RIDE_DRAWN = 0.15
/** how far along its ride the camera keeps the signal's width before it eases out to frame the chip it lands on */
export const RIDE_CLOSE = 0.75

/** a ride moves at most RIDE_PACE of the frame's width a second; RIDE_EASE of the way along it starts to ease into the chip's pad */
export const RIDE_PACE = 0.5
const RIDE_EASE = 0.75
/** the camera centres on the head's mean place over RIDE_SMOOTH beats either side, so it turns a corner in a curve */
const RIDE_SMOOTH = 0.3
/** the camera slides from the head to the chip's middle no faster than RIDE_HOME of the frame's width a second */
const RIDE_HOME = 0.12
/** a ride's note stands whole in the frame RIDE_NOTE beats from when it starts: its leader and letters, then a second */
const RIDE_NOTE = 2.5
const RIDE_SEEN_FOR = 2.25
/** the ride began before the film: at frame 0 its drawn run reaches back at least RIDE_SEEN of the frame's long side from the head */
const RIDE_SEEN = 0.45
/** from a ride's arrival to the tilt the main chip's body spans at least HOLD_CHIP of the frame's short side */
const HOLD_CHIP = 0.47
/** and its body's shorter side spans at least HOLD_SIDE of the frame's short side, so a chip turned on the frame is read at the size of one that is not */
const HOLD_SIDE = 0.44
const RIDE_BODY = 0.38
const RIDE_OVER = 0.2
const RIDE_SLIDE = 0.065
const RIDE_BACK = 2
const RIDE_CLEAR = 1
const RIDE_UNDER = 0.5
/** a ride that would outrun the camera starts further along, until its simulated pace is RIDE_HEADROOM of the limit: room for the measured pace and for its note to stand whole */
const RIDE_HEADROOM = 0.8
/** the camera trails the head by at most RIDE_LAG of the frame's short side; it falls back on the head over the first RIDE_NOTE beats while the head runs on, then gains on it until both land, so the ride's note stands in a slower frame */
const RIDE_LAG = 0.3
/** the frame's width spans at most RIDE_SPAN mm of board through a ride, inside the spans Glasgow's own ride holds in every aspect */
const RIDE_SPAN = 15
/** a ride that at the signal's scale would hold the main chip's drawn outline before its last RIDE_LATE beats starts closer, at most RIDE_CLOSER times, if a closer frame can keep it out: at the widest frame that keeps the outline undrawn or out of the frame until the ride's last RIDE_LATE beats, the ink reaching it as the ride's wake does; it opens back to the signal's scale over the ride's last RIDE_OPEN beats, and it trails the head by RIDE_LAG of the frame's long side at frame 0 and gains on it at an even pace until both land, so the frame moves from frame 0 even where little of the stretch is left to ride */
const RIDE_CLOSER = 2
/** a ride's note stands until the frame opens by RIDE_SHRINK from the scale it was lettered at, so it is never read smaller than it was written; the section's panel may then take its paper */
const RIDE_SHRINK = 0.02
const RIDE_LATE = 3
const RIDE_OPEN = 2
const ridePeak = (rest: number): number => 1 / (RIDE_EASE - rest / 2 + (1 - RIDE_EASE) / 2)
/** the head's progress along its ride at x of the ride's time: from rest over the first `rest` of it, even, then easing into the pad */
const rideEase = (x: number, rest: number): number => {
  const k = Math.min(1, Math.max(0, x))
  const peak = ridePeak(rest)
  if (k < rest) return (peak * k * k) / (2 * rest)
  if (k <= RIDE_EASE) return peak * (k - rest / 2)
  return peak * (k - rest / 2 - (k - RIDE_EASE) ** 2 / (2 * (1 - RIDE_EASE)))
}
/** how far, board px, a ride of these beats at this zoom may run at the pace */
const rideReach = (W: number, beats: number, zoom: number, rest: number): number => (RIDE_PACE * W * beats * 0.5) / (ridePeak(rest) * zoom)
/** a net runs in a bus where RIDE_BUS of its copper has a parallel neighbour within BESIDE_MM */
const RIDE_BUS = 0.5
const BESIDE_MM = 1
/** the parts a ride takes last: an LED, a button or switch, a test point */
const LIGHT = /^(LED|SW|BTN|TP)\d/i
const LED_PART = /LED/i
/** a ride's far end is a light, a button or a test point by its reference (LED, SW, BTN, TP), or an LED by what it is: its value, footprint or model says so, whatever its reference */
export const lightEnd = (ref: string, fp: { value?: string | undefined; footprint?: string | undefined; model?: string | undefined } | undefined): boolean => LIGHT.test(ref) || (fp !== undefined && [fp.value, fp.footprint, fp.model].some((v) => LED_PART.test(v ?? '')))
const LIGHT_NET = /LED|BUTTON|BTN/i

/** a ride's copper as a tree to the chip's pads: its far end, the places on it a viewer can name (pads and vias) with their copper distance to the chip, the main path from any of them, and every yellow segment's ends' distances */
interface RidePath { goal: { key: string; d: number }; far: { key: string; d: number }; named: Array<{ key: string; d: number; name: string }>; line: (from: string) => { pts: P2[]; toChip: number[] }; segD: Array<[number, number]>; end: string }

/** the share of a net's copper that runs beside another net's track on its layer, parallel within 10° and BESIDE_MM apart */
function besideShare(board: BoardModel, id: number): number {
  let all = 0
  let beside = 0
  for (const c of Object.values(board.copper)) {
    const others = c.traces.filter((t) => t.netId !== id && t.netId !== undefined).flatMap((t) => t.points.slice(1).map((q, i) => [t.points[i] as Vec2, q] as const)).filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) > 0.3)
    for (const t of c.traces) {
      if (t.netId !== id) continue
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1] as Vec2
        const b = t.points[i] as Vec2
        const l = Math.hypot(b.x - a.x, b.y - a.y)
        if (l < 1e-6) continue
        all += l
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const near = others.some(([oa, ob]) => {
          const ol = Math.hypot(ob.x - oa.x, ob.y - oa.y)
          const ox = (ob.x - oa.x) / ol
          const oy = (ob.y - oa.y) / ol
          if (Math.abs(((b.x - a.x) / l) * oy - ((b.y - a.y) / l) * ox) > 0.17) return false
          const along = (mx - oa.x) * ox + (my - oa.y) * oy
          const off = Math.abs((mx - oa.x) * oy - (my - oa.y) * ox)
          return along > -0.2 * l && along < ol + 0.2 * l && off < BESIDE_MM && off > 0.05
        })
        if (near) beside += l
      }
    }
  }
  return all > 0 ? beside / all : 0
}

/** how much of its first lines a film that opens on its signal has drawn by frame 0: they cross half the frame and are still moving */
const OPEN_DRAWN = 0.7
/** the beats of ink a film that opens on its travel has already spread from the frame's centre by frame 0 */
const OPEN_INK = 3.5
/** a half of the arrival's frame holding less drawn copper than this (px of line per px² of the half) opens bare, and the copper the frame holds stands from the arrival */
const OPEN_BARE = 0.0015
/** how far ahead of the frame's centre the signal's ink rests at the end of the macro, in frame widths: the travel's camera follows it from there */
const HEAD_AHEAD = 0.2
/** how many rings out from its subject a note looks for bare paper, each 1.2 of its letter height further, and the paper it keeps clear round its lettering, in letter heights */
/** the paper kept clear round each letter of a note, in letter heights across: copper that is drawn later stops short of the letters */
export const NOTE_HALO = 1.1
const NOTE_RINGS = 12
const NOTE_CLEAR = 0.2
/** the paper between two notes, in letter heights */
const NOTE_APART = 0.6

/** the beats the fan-out's starts take to go once round the chip, and the beats one line takes to reach the frame's corner */
const FAN_ROUND = 1.9
const FAN_GROW = 1.1
/** beats the ink starts ahead of the camera wherever the drafted signal would leave the middle of the frame bare */
const INK_AHEAD = 2

/** how far the camera rises over the fan-out, as a share of its zoom on the chip */
const FAN_RISE = 1.5

/** the travel keeps the board's long side at least this many frame widths: the whole board is never in frame before the turn */
const TRAVEL_HIDE = 2

/** the share of the frame's height the main chip fills when the travel arrives on it */
const TRAVEL_HERO = 0.36

/** the most the travel's scale may change from its first frame to the main chip: it stays close, and the pull back belongs to the turn */
const TRAVEL_SPAN = 1.15

/** a film that opens on its pair builds to the main chip: its run takes PAIR_FILL of the frame's width on the first frame, at the frame's middle; the opening pulls back PAIR_BACK of the way (in log scale) from there to the whole board; the travel is at its widest TRAVEL_WIDE_AT of the way along, 1/TRAVEL_CLOSER of the scale it lands on the chip with, where the chip takes PAIR_HERO of the stage's height; its progress runs as time to the power TRAVEL_BUILD, so it starts slow and is fastest near the chip; the other ink spreads from the pair PAIR_SPREAD of the frame's diagonal a second at the travel's scale, so the paper behind the ink head fills */
const PAIR_FILL = 0.9
const PAIR_BACK = 0.2
const PAIR_HERO = 0.76
/** the most of the frame's width the main chip's side takes when a pair film lands on it, so a narrow frame holds the chip and its name whole */
const PAIR_WIDE = 0.8
const TRAVEL_CLOSER = 1.08
const TRAVEL_WIDE_AT = 0.35
const TRAVEL_BUILD = 1.35
const PAIR_SPREAD = 0.26
/** a pair's ride is re-timed to an even pace over the frame, leaving its start from rest over its first PAIR_REST */
const PAIR_REST = 0.3
/** a pair's ride too long for the pace holds its opening view PAIR_READ beats, so the pair's caption stands a second, then cuts to where it starts part way */
const PAIR_READ = 1
/** a ride's ink spreads as a wake from each stretch of its signal the head has drawn, RIDE_SPREAD of the frame's diagonal a second at the ride's scale */
const RIDE_SPREAD = 0.5
/** each ring of a ride's wake grows at most RIDE_WAKE of the head's speed along the stretch it was laid on, so the ink trails the head in a cone and never reaches a mark before the head passes it */
const RIDE_WAKE = 0.9

/** the latest beat the travel along the signal ends on: the section follows it, then the turn into the axonometric drawing */
export const TURN_AT = 14.5

/** the beats of the section through the main chip after the fan-out: SECTION_DRAW to draw it, the rest to stand whole before the turn; it takes them from the travel, the parts' rise and the end's hold */
export const SECTION_BEATS = 4
/** the least beats a film's travel keeps besides its hold on the chip: a film that cannot spare the section's beats without going under it has no section */
const TRAVEL_LEAST = 4
const SECTION_DRAW = 1.55

/** the beats that turn takes: a little over a second, so the sheet tilts and is not flipped */
const TURN_BEATS = 2.25

/** the beats of the sheet shot: the name is lettered as the pull lands and the stamp waits one beat after it */
const SHEET_BUILD = 1.5

/** the longest each plan's signature may run: the time its drawing takes to land, so the shot ends when the hand stops */
const SIG_MAX: Record<PlotPlan, number> = { stick: 2.25, valve: 5.5, header: 3.5, pair: 2.5, card: 4, dense: 4 }

/** how long each plan's signature drawing runs, in beats */
const SIG_BEATS: Record<PlotPlan, number> = { stick: 4, valve: 3.5, header: 3.5, pair: 2.5, card: 3.5, dense: 3.5 }

/** the beat each gap of a stack closes on, and the beat its parts set down: the stack takes one beat per copper layer, half a beat of it lifting */
const stackBeats = (s0: number, layers: number): { lift: [number, number]; lands: number[]; parts: number; end: number } => {
  const L = clamp(layers, 2, 6)
  const step = (L - 1) / L
  return { lift: [s0, s0 + 0.5], lands: Array.from({ length: Math.max(0, layers - 1) }, (_, j) => s0 + 0.5 + step * (j + 1) * ((L - 1) / Math.max(1, layers - 1))), parts: s0 + L - 0.5, end: s0 + L }
}

/**
 * The film's shots in beats and the object's moves, from the board's plan,
 * its station count, its copper layers, its part count and its sheet
 * callouts. A shot
 * that carries a station runs a quarter beat longer; the parts land over
 * three quarters of a beat and a 48th of a beat a part; the sheet takes what is
 * left before a hold of at most 1.5 s; each signature runs no longer than its
 * drawing takes, and the object, its parts drawn one after another, takes
 * what is spare.
 */
export function filmPlan(plan: PlotPlan, stations: number, layers: number, parts = 24, sectioned = true): { shots: Array<{ kind: PlotShotKind; b0: number; b1: number }>; beats: PlotBeats } {
  const n = clamp(stations, 2, 6)
  const kinds = ORDER[plan].filter((k) => (k !== 'detail' || stations > 0) && (k !== 'open' || !ORDER[plan].includes('outline')) && (k !== 'section' || sectioned))
  const L = clamp(layers, 2, 6)
  const cut = kinds.includes('section')
  const base: Record<PlotShotKind, number> = { open: 1.5 + 0.125 * (6 - n), macro: kinds[0] === 'macro' ? FIRST_MACRO : 1.5, outline: 1.5, section: SECTION_BEATS, signature: SIG_BEATS[plan], tilt: kinds.includes('outline') ? TURN_BEATS : 1, stack: L, assembly: cut ? SECTION_RISE : clamp(0.75 + parts / 48, 1, 2), detail: 1.75 + 0.125 * n, pull: cut ? SECTION_PULL : PULL, sheet: 0, hold: 2 + 0.125 * L }
  const carriers = kinds.filter((k) => k !== 'open' && k !== 'tilt' && k !== 'pull' && k !== 'sheet' && k !== 'hold' && k !== 'detail')
  const carry = new Set(Array.from({ length: n - 1 }, (_, i) => carriers[Math.min(carriers.length - 1, Math.floor((i * carriers.length) / Math.max(1, n - 1)))]))
  for (const k of carry) if (k !== undefined) base[k] += 0.25
  const want = SHEET_BUILD
  const used = kinds.reduce((t, k) => t + base[k], 0)
  let spare = 24 - used - want
  const give = (k: PlotShotKind, lo: number, hi: number): void => {
    const d = clamp(base[k] + spare, lo, hi) - base[k]
    base[k] += d
    spare -= d
  }
  if (spare < 0) give('assembly', 1, base.assembly)
  const at = (k: PlotShotKind, hi: number): void => { if (kinds.includes(k)) give(k, base[k], hi) }
  if (kinds.includes('signature')) give('signature', Math.min(SIG_MAX[plan], Math.max(3, base.stack + 0.25)), SIG_MAX[plan])
  if (!kinds.includes('outline')) {
    at('macro', 2.5)
    at('open', plan === 'stick' ? 3 : 2.5)
    at('assembly', 14)
  } else give('outline', base.outline, Math.max(base.outline, TURN_AT - kinds.slice(0, kinds.indexOf('outline')).reduce((t, k) => t + base[k], 0)))
  base.sheet = 24 - kinds.filter((k) => k !== 'sheet').reduce((t, k) => t + base[k], 0)
  if ((cut && kinds.includes('signature')) || Math.abs(base.sheet - base.hold) < 0.05 || Math.abs(base.sheet - base.pull) < 0.05) {
    base.signature -= 0.25
    base.sheet += 0.25
  }
  if (cut && base.outline < TRAVEL_HOLD + TRAVEL_LEAST) return filmPlan(plan, stations, layers, parts, false)
  let t = 0
  const timed = kinds.map((kind) => {
    const b0 = t
    t += base[kind]
    return { kind, b0, b1: t }
  })
  const shots = kinds[0] === 'macro' && kinds[1] === 'outline' ? [{ kind: 'outline' as const, b0: 0, b1: (timed[1] as { b1: number }).b1 }, ...timed.slice(2)] : timed
  const of = (k: PlotShotKind): { b0: number; b1: number } | undefined => shots.find((q) => q.kind === k)
  const tilt = of('tilt') ?? { b0: 8, b1: 9 }
  const pull = of('pull') ?? { b0: 16, b1: 17.5 }
  const stack = of('stack')
  const st = stack !== undefined ? stackBeats(stack.b0, layers) : { lift: [tilt.b1, tilt.b1] as [number, number], lands: [], parts: tilt.b1 + 0.75 }
  const detail = of('detail')
  return {
    shots,
    beats: { tilt: [tilt.b0, tilt.b1], lift: st.lift, lands: st.lands, parts: st.parts, push: detail !== undefined ? [detail.b0, detail.b0 + 1.5] : [pull.b0, pull.b0], pull: [pull.b0, pull.b1], sheet: pull.b1, done: (of('hold') ?? pull).b0 }
  }
}

/** the beats over which the sheet title letters on and underlines; the sheet holds from the second */
export const SHEET_TITLE: [number, number] = [18.9, 19.6]

/** the beat the second tier starts lettering on, and the beats between one label and the next */
export const TIER_AT = 18.4
export const TIER_STEP = 0.08

/** the most second-tier labels a sheet letters: more on a tall frame */
export const tierMost = (W: number, H: number): number => (H / W >= 1.15 ? 12 : 8)

/** the beat the sheet's last callout has lettered: the hold after it is the film's last 1.25 s */
export const SHEET_DONE = 21.5

/** the beats the camera takes to pull back from the object to the whole sheet */
export const PULL = 1.5

/** with a section the parts rise over half a beat and the pull takes one, so the end keeps the hold a film without a section has */
const SECTION_RISE = 0.5
const SECTION_PULL = 1


/** the seconds the board's name stands complete before the film ends: the section took the rest of the old 1.5 s */
export const TITLE_READ = 1

/** the beats the board's name is lettered over: it starts a quarter beat after the pull lands */
export const sheetTitleSpan = (sh: PlotScore['sheet']): [number, number] => [sh.at + 0.25, sh.at + 1]

/** the beats the stamp waits after the name is lettered */
const STAMP_AFTER = 0.75

/** the ISO sheet a drawing of the board at full size goes on: the smallest whose long side holds two and a half board lengths, room for the plan and the views beside it */
export const sheetSize = (longMm: number): string => ([['A4', 297], ['A3', 420], ['A2', 594], ['A1', 841]] as Array<[string, number]>).find(([, l]) => l >= 2.5 * longMm)?.[0] ?? 'A0'

/** the stack panel's title: a two-layer board draws its two copper sides instead of a stack */
export const stackTitle = (plot: Pick<PlotScore, 'stack'>): string => (plot.stack.length === 2 ? 'COPPER SIDES' : 'LAYER STACK')

/** every event of a blueprint film a score can follow, from the plot it plays */
export function plotEvents(plot: PlotScore, frames: number, _W: number, _H: number): PlotEvent[] {
  const at = (beat: number): number => plotSnap(beat / 24, frames)
  const after = (t: number, n: number): number => plotClock(Math.min(frames - 1, plotFrame(t, frames) + n), frames)
  const span = (kind: PlotEvent['kind'], b0: number, b1: number, text?: string): PlotEvent => ({ kind, t0: at(b0), t1: at(b1), ...(text !== undefined ? { text } : {}) })
  const letters = (t0: number, text: string, perFrame: number, lead = 0): PlotEvent => ({ kind: 'letter', t0: after(t0, lead), t1: after(t0, lead + Math.ceil(text.length / perFrame)), text })
  const S = plot.shots
  const out: PlotEvent[] = [
    ...plot.film.shots.filter((q, i) => q.kind === 'macro' || q.kind === 'signature' || (q.kind === 'tilt' && (plot.film.shots[i - 1]?.kind !== 'section' || plot.object.planYaw !== 0))).map((q): PlotEvent => ({ kind: 'cut', t0: q.t0, t1: q.t0 })),
    ...plot.nib.strokes.filter((k) => k.t1 > 0 && k.t1 <= 1).map((k): PlotEvent => ({ kind: 'stroke', t0: Math.max(0, k.t0), t1: k.t1, text: 'nib' })),
    ...plot.bus.strokes.map((k): PlotEvent => ({ kind: 'ink', t0: k.t0, t1: k.t1, text: 'macro' })),
    { kind: 'ink', t0: S.outline[0], t1: S.outline[1], text: 'outline' },
    span('tilt', plot.beats.tilt[0], plot.beats.tilt[1]),
    ...(plot.beats.lift[1] > plot.beats.lift[0] ? [span('lift', plot.beats.lift[0], plot.beats.lift[1])] : []),
    ...plot.beats.lands.map((b, j) => span('land', b, b, plot.stack[j]?.name)),
    span('land', plot.beats.parts, plot.beats.parts, 'parts'),
    ...plot.marks.map((mk): PlotEvent => ({ kind: 'letter', t0: mk.t, t1: after(mk.t, Math.max(mk.text.length, mk.sub.length + 2)), text: `${mk.text} ${mk.sub}`.trim() })),
    ...plot.film.shots.filter((q) => q.kind === 'detail').map((q) => span('push', q.t0 * 24, q.t0 * 24 + 1.5)),
    ...plot.flow.path.map((sg): PlotEvent => ({ kind: 'stroke', t0: sg.p0, t1: sg.p1, text: 'route' })),
    ...plot.film.stations.map((st) => letters(st.t, st.text, 2)),
    ...(plot.section === undefined ? [] : sectionEvents(plot.section, after)),
    ...(plot.hidden === undefined || plot.hidden.length === 0 ? [] : [{ kind: 'ink' as const, t0: Math.min(...plot.hidden.flatMap((h) => h.segs.filter((_, i) => i % 6 === 4))), t1: Math.max(...plot.hidden.flatMap((h) => h.segs.filter((_, i) => i % 6 === 5))), text: 'hidden' }]),
    span('pull', plot.beats.pull[0], plot.beats.pull[1]),
    span('title', sheetTitleSpan(plot.sheet)[0], sheetTitleSpan(plot.sheet)[1])
  ]
  const last = Math.max(...out.map((e) => plotFrame(e.t1, frames)))
  const struck = Math.min(23, Math.max(Math.ceil((24 * last) / frames), Math.ceil(sheetTitleSpan(plot.sheet)[1] + STAMP_AFTER)))
  return [...out, span('stamp', struck, struck)].sort((a, b) => a.t0 - b.t0)
}

/** the section's sounds: the cutting line in pencil, its letters, the panel's frame ruled, each layer's line in ink with its name lettered, the posts, the chip, the title */
const sectionEvents = (sc: PlotSection, after: (t: number, n: number) => number): PlotEvent[] => {
  const T = sc.t
  return [
    { kind: 'stroke', t0: T.line[0], t1: T.line[1], text: 'section' },
    { kind: 'letter', t0: T.arrows, t1: after(T.arrows, 2), text: 'A A' },
    { kind: 'rule', t0: T.panel, t1: after(T.panel, SECTION_GROW), text: 'section' },
    ...sc.layers.flatMap((l): PlotEvent[] => [{ kind: 'ink', t0: l.t, t1: after(l.t, SECTION_GROW), text: 'section' }, { kind: 'letter', t0: l.t, t1: after(l.t, Math.ceil(l.name.length / 3)), text: l.name }]),
    ...(sc.posts.length > 0 ? [{ kind: 'ink' as const, t0: T.posts, t1: after(T.posts, SECTION_GROW), text: 'section' }] : []),
    { kind: 'ink', t0: T.chip, t1: after(T.chip, SECTION_GROW), text: 'section' },
    { kind: 'letter', t0: T.title, t1: after(T.title, Math.ceil(SECTION_TITLE.length / 3)), text: SECTION_TITLE }
  ]
}

/** how far the section reaches either side of the chip, in the chip's half widths; the least screen px from one via post's centre to the next at 1080, so a phone tells them apart; the main chip's hidden wiring starts this many chip sizes out from its centre, keeps this many of the longest nets a layer, and grows out over this many beats from half a beat before the turn */
const SECTION_REACH = 2.3
const POST_APART = 26
/** once the section stands whole, the camera pushes in on the chip over these shares of the time left before the turn, by the least push that puts the panel's top below the frame with the chip's centre at most SECTION_HERO of the frame's height down; the panel is not drawn once it has left */
const SECTION_MOVE: [number, number] = [0.5, 1]
const SECTION_HERO = 0.66
/** the least screen px, at 1080, between the section's panel and any drawn line of the yellow signal */
const PANEL_CLEAR = 8
/** the clearance, px at 1080, kept between a mark of the cutting line (its "A" and arrow, or its end stroke) and any part's footprint, note or yellow line: each end sits on the line outward from the section's span, inside the frame the section is drawn in, where no part will rise under it and where every visible bit of it on the last frame is half a letter clear of every risen part and of the signal; an end that holds no mark carries an end stroke */
const MARK_CLEAR = 4
/** a cutting line's end stroke, px at 1080: drawn where no mark fits, turned toward the view */
export const END_STROKE = 30
/** the section's row pitch, in letter sizes: each layer's line, and the title's own row when the title on the chip's row would run into the chip's outline */
export const SECTION_ROW = 1.25
/** the gap between a section panel's two columns, in letter sizes */
export const SECTION_COL_GAP = 1.5
/** when a note would sit on the frame's edge at the end of the section's push, the push's zoom is stepped by this ratio, nearest first, and the panel is dropped further below the frame in as many steps up to half the frame, the least change of the two first, until every note is wholly in frame or wholly out of it with a margin */
const SECTION_ZOOM_STEP = 1.01
const SECTION_ZOOM_TRIES = 25
const HIDDEN_CLEAR = 0.75
const HIDDEN_NETS = 12
const HIDDEN_GROW = 1.25

/** the section's least letter size: the film's least readable size, a cap of READ_CAP of the short side; it letters at the travel's notes' size where the panel still fits under the chip at that size */
export const sectionSize = (W: number, H: number): number => (READ_CAP * Math.min(W, H)) / CAP

/** the section's title, and the frames each of its lines takes to grow */
export const SECTION_TITLE = 'SECTION A–A'
export const SECTION_GROW = 4

/** the most the hold may enlarge the poster */
export const HOLD_ZOOM = 1.15

/** how far the board's drawing has grown about its main chip by the last frame, from the beat the sheet lands: the ending never stands still, and the sheet's rules and lettering never move */
export const SHEET_PUSH = 1.06
/** the slow push every hero hold makes over beats 12 to 17, so the hold never freezes */
const HOLD_DRIFT = 0.06
export const ISO_E = Math.asin(Math.tan(Math.PI / 6))

/** the elevation the turn tilts the sheet to and the film ends on: lower than an isometric drawing, so the parts stand up and the board runs out of the frame */
export const CLOSE_E = 26 * D
/** the poster looks down at the least of these that clears the chip's lid (else the least that leaves CHIP_HIDE), the pull raising the camera from CLOSE_E, when a pin too thin for the coarse heading search covers more of the chip's lid than CHIP_HIDE and POSTER_SLACK */
export const POSTER_E = [30, 34, 38, 42, 46].map((d) => d * D)
/** how far the 40-point cover of a heading may read over CHIP_HIDE before the poster moves: the dev kit's 16:9 and 1:1 posters read 1.6% here and 1.4% as rendered */
export const POSTER_SLACK = 0.003

/** the most of the main chip's lid that nearer bodies may cover anywhere on the camera's way from the tilt to the end view: the most the films that read clear reach (1.4%, round 13); a film over it takes a clear end heading or start, else the mirrored orbit if that one is clear */
export const CHIP_HIDE = 0.014

/** how much larger than a whole-board fit the ending may draw the board, largest first */
const CLOSE_OVER = [1.5, 1.4, 1.3, 1.2, 1.1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4]

/** the stamp's box for its text at a letter height */
export const stampBox = (mark: string, K: number): { w: number; h: number } => ({ w: mark.length * 0.81 * K + 0.9 * K, h: 1.9 * K })

/** the space between the letters of the board's name on the ending, in letter heights */
export const NAME_SPACING = 0.08

/** the board's name set large for the ending: one line if it fits the room it is given, at most 60% of the frame's width, at a letter size of at least 9% of the frame's short side and never over 20% of it, else two lines broken between words */
/** the least width the title sheet's name spans, as a share of the frame's width: 40% in a tall frame, 30% in a wide or square one */
export const nameFloor = (W: number, H: number): number => (H > 1.1 * W ? 0.4 : 0.3)

export function nameSet(name: string, W: number, H: number, room = W): { lines: string[]; size: number; w: number; h: number } {
  const text = name.toUpperCase()
  const short = Math.min(W, H)
  const wide = (n: number, size: number): number => n * size * (0.66 + NAME_SPACING)
  const sizeFor = (lines: string[]): number => Math.min(0.2 * short, Math.min(0.6 * W, room) / wide(Math.max(...lines.map((l) => l.length)), 1))
  const one = [text]
  const words = text.split(' ')
  const two = words.length < 2 ? one : words.map((_, i) => [words.slice(0, i + 1).join(' '), words.slice(i + 1).join(' ')]).slice(0, -1).reduce((b, c) => (Math.max(...c.map((l) => l.length)) < Math.max(...b.map((l) => l.length)) ? c : b))
  const lines = sizeFor(one) >= 0.09 * short ? one : two
  const size = sizeFor(lines)
  return { lines, size, w: wide(Math.max(...lines.map((l) => l.length)), size), h: (CAP + 1.2 * (lines.length - 1)) * size }
}

/** where an axonometric view puts a board point at a height */
export const axoPoint = (v: PlotAxo, p: P2, z: number): P2 => {
  const c = Math.cos(v.psi)
  const s = Math.sin(v.psi)
  const dx = p[0] - v.mx
  const dy = p[1] - v.my
  return [v.x + v.k * (c * dx - s * dy), v.y + v.k * (Math.sin(v.e) * (s * dx + c * dy) - Math.cos(v.e) * z)]
}

interface Body { x: number; y: number; w: number; h: number; rot: number; z: number; z0?: number | undefined; hero?: boolean | undefined; in?: { x: number; y: number } | undefined }

/** the share of the main chip's top face, sampled on an n by n grid (40 finds a header's pin), that a nearer part's body covers in view v: a part is nearer when its centre (or the centre of the housing it stands in) lies further down the view's ground than the chip's, and a body stands from z0 (the board, when unset) to z */
export function chipCover(v: PlotAxo, parts: ReadonlyArray<Body>, n = 12): number {
  const chip = parts.find((q) => q.hero === true)
  if (chip === undefined) return 0
  const depth = (q: { x: number; y: number }): number => Math.sin(v.psi) * (q.x - v.mx) + Math.cos(v.psi) * (q.y - v.my)
  const lid = convex(bodyCorners(chip).map((c) => axoPoint(v, c, chip.z)))
  const box = { x0: Math.min(...lid.map((q) => q[0])), x1: Math.max(...lid.map((q) => q[0])), y0: Math.min(...lid.map((q) => q[1])), y1: Math.max(...lid.map((q) => q[1])) }
  const hulls = parts.filter((q) => q !== chip && q.z > 0 && depth(q.in ?? q) > depth(chip)).map((q) => convex(bodyCorners(q).flatMap((c) => [axoPoint(v, c, q.z0 ?? 0), axoPoint(v, c, q.z)])))
    .filter((h) => h.length >= 3 && h.some((q) => q[0] >= box.x0) && h.some((q) => q[0] <= box.x1) && h.some((q) => q[1] >= box.y0) && h.some((q) => q[1] <= box.y1))
  const c = Math.cos(chip.rot)
  const sn = Math.sin(chip.rot)
  let hit = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lx = ((i + 0.5) / n - 0.5) * chip.w
      const ly = ((j + 0.5) / n - 0.5) * chip.h
      const q = axoPoint(v, [chip.x + lx * c - ly * sn, chip.y + lx * sn + ly * c], chip.z)
      if (hulls.some((h) => insideConvex(q, h))) hit++
    }
  }
  return hit / (n * n)
}

const bodyCorners = (b: Body): P2[] => {
  const c = Math.cos(b.rot)
  const s = Math.sin(b.rot)
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, d]) => {
    const lx = ((a as number) * b.w) / 2
    const ly = ((d as number) * b.h) / 2
    return [b.x + lx * c - ly * s, b.y + lx * s + ly * c] as P2
  })
}

/** the axonometric turn that fits the assembled board largest into a box, centred there */
function fitAxo(box: PlotRect, outline: P2[], thick: number, bodies: Body[], mid: P2, psi?: number, face = 1): PlotAxo {
  let best: PlotAxo | undefined
  for (const r of psi === undefined ? [-60, -52.5, -45, -37.5, -30, -22.5, 22.5, 30, 37.5, 45, 52.5, 60].map((d) => face * d * D) : [psi]) {
    const unit: PlotAxo = { psi: r, e: ISO_E, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }
    const pts = [...outline.flatMap((p) => [axoPoint(unit, p, 0), axoPoint(unit, p, -thick)]), ...bodies.flatMap((b) => bodyCorners(b).map((p) => axoPoint(unit, p, b.z)))]
    const x0 = Math.min(...pts.map((p) => p[0]))
    const x1 = Math.max(...pts.map((p) => p[0]))
    const y0 = Math.min(...pts.map((p) => p[1]))
    const y1 = Math.max(...pts.map((p) => p[1]))
    const k = Math.min(box.w / Math.max(1e-6, x1 - x0), box.h / Math.max(1e-6, y1 - y0))
    if (best === undefined || k > best.k * 1.02) best = { ...unit, k, x: box.x + box.w / 2 - k * (x0 + x1) / 2, y: box.y + box.h / 2 - k * (y0 + y1) / 2 }
  }
  return best as PlotAxo
}

/** the screen box an axonometric view puts a board silhouette (x, y, z triples, board px) in */
export function hullBox(v: PlotAxo, hull: number[]): PlotRect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i + 2 < hull.length; i += 3) {
    const q = axoPoint(v, [hull[i] as number, hull[i + 1] as number], hull[i + 2] as number)
    x0 = Math.min(x0, q[0])
    x1 = Math.max(x1, q[0])
    y0 = Math.min(y0, q[1])
    y1 = Math.max(y1, q[1])
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const convex = (pts: P2[]): P2[] => {
  const ps = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (ps.length < 3) return ps
  const cross = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: P2[]): P2[] => {
    const out: P2[] = []
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2] as P2, out[out.length - 1] as P2, p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return [...half(ps), ...half([...ps].reverse())]
}

/** the box a callout prints in: a name over its note, sized in px at 1080 (31 over 22 in the film) */
export const calloutSize = (text: string, sub: string, u: number, size = 31, note = 22): { w: number; h: number } => ({
  w: Math.max(textW(text.length, size * u), textW(sub.length, note * u)) + 12 * u,
  h: sub.length > 0 ? size * u * 1.05 + note * u * 1.55 : size * u * 1.4
})

/** the area film labels may print in: inside the margin and above the name strip */
export const calloutFrame = (W: number, H: number): { x0: number; y0: number; x1: number; y1: number } => {
  const m = 0.03 * Math.min(W, H)
  return { x0: m, y0: m, x1: W - m, y1: nameStrip(W, H).y - m }
}

interface CalloutItem { at: P2; w: number; h: number }
type Frame = { x0: number; y0: number; x1: number; y1: number }

const CALL_GAP = 30
const CALL_ALONG = 26
const CALL_ROW = 14

/** the film's stack labels, one line each: the parts count, then each copper layer top down with its role */
export const stackLabelRows = (_parts: number, stack: ReadonlyArray<{ name: string; role: string }>): Array<{ text: string; sub: string }> => [
  ...stack.map((l) => {
    const name = l.name.toUpperCase()
    const role = l.role.replace(/ COPPER$| PLANE$/, '')
    return { text: name.includes(role) ? name : `${name} ${role}`, sub: '' }
  })
]

/** which margin each callout prints in, nearest side first, in priority order; a callout with no room is left out */
export function planCallouts(items: CalloutItem[], board: PlotRect, f: Frame, u: number, allowed: ReadonlyArray<0 | 1 | 2 | 3> = [0, 1, 2, 3]): PlotCallout[] {
  const g = CALL_GAP * u
  const pitch = Math.max(0, ...items.map((it) => it.h)) + CALL_ROW * u
  const margin = [board.y - f.y0, f.x1 - board.x - board.w, f.y1 - board.y - board.h, board.x - f.x0]
  const used = new Map<string, number>()
  const out: PlotCallout[] = []
  items.forEach((it, i) => {
    const reach = [it.at[1] - board.y, board.x + board.w - it.at[0], board.y + board.h - it.at[1], it.at[0] - board.x]
    const sides = allowed.slice().sort((a, b) => (reach[a] as number) - (reach[b] as number))
    for (const side of sides) {
      const flat = side % 2 === 0
      const room = (margin[side] as number) - g
      const rows = (flat ? pitch - CALL_ROW * u : it.w) <= room ? 1 : 0
      const avail = flat ? f.x1 - f.x0 : f.y1 - f.y0
      for (let row = 0; row < rows; row++) {
        const key = `${side}:${row}`
        const len = (used.get(key) ?? -CALL_ALONG * u) + CALL_ALONG * u + (flat ? it.w : it.h)
        if (len > avail) continue
        used.set(key, len)
        out.push({ item: i, side, row, order: 0 })
        return
      }
    }
  })
  for (const c of out) {
    const along = (k: PlotCallout): number => (items[k.item] as CalloutItem).at[k.side % 2 === 0 ? 0 : 1]
    c.order = out.filter((o) => o.side === c.side && o.row === c.row && along(o) < along(c)).length
  }
  return out
}

/** where each planned callout prints this frame: hugging its side of the board, packed along it in order, inside the frame */
export function placeCallouts(items: CalloutItem[], plan: PlotCallout[], board: PlotRect, f: Frame, u: number, along = CALL_ALONG): Array<PlotRect | undefined> {
  const g = CALL_GAP * u
  const ga = along * u
  const pitch = Math.max(0, ...items.map((it) => it.h)) + CALL_ROW * u
  const out: Array<PlotRect | undefined> = items.map(() => undefined)
  for (const side of [0, 1, 2, 3] as const) {
    const flat = side % 2 === 0
    for (const row of [...new Set(plan.filter((c) => c.side === side).map((c) => c.row))]) {
      const group = plan.filter((c) => c.side === side && c.row === row).sort((a, b) => a.order - b.order)
      const lens = group.map((c) => (flat ? (items[c.item] as CalloutItem).w : (items[c.item] as CalloutItem).h))
      const lo = flat ? f.x0 : f.y0
      const hi = flat ? f.x1 : f.y1
      const pos = group.map((c, i) => (items[c.item] as CalloutItem).at[flat ? 0 : 1] - (lens[i] as number) / 2)
      for (let i = 0; i < pos.length; i++) pos[i] = Math.max(pos[i] as number, i === 0 ? lo : (pos[i - 1] as number) + (lens[i - 1] as number) + ga)
      for (let i = pos.length - 1; i >= 0; i--) pos[i] = Math.min(pos[i] as number, (i === pos.length - 1 ? hi : (pos[i + 1] as number) - ga) - (lens[i] as number))
      group.forEach((c, i) => {
        const it = items[c.item] as CalloutItem
        const a = pos[i] as number
        if (side === 0) out[c.item] = { x: a, y: board.y - g - row * pitch - it.h, w: it.w, h: it.h }
        else if (side === 2) out[c.item] = { x: a, y: board.y + board.h + g + row * pitch, w: it.w, h: it.h }
        else if (side === 1) out[c.item] = { x: board.x + board.w + g, y: a, w: it.w, h: it.h }
        else out[c.item] = { x: board.x - g - it.w, y: a, w: it.w, h: it.h }
      })
    }
  }
  for (const c of plan) if (c.rect !== undefined) out[c.item] = c.rect
  return out
}

interface Seg { a: P2; b: P2; w: number; t: number; net?: number | undefined }

const layerSegs = (layers: TraceLayer[]): Seg[] =>
  layers.filter((l) => l.side === (layers.some((k) => k.side === 'F' && k.segs.length > 0) ? 'F' : 'B')).flatMap((l) => {
    const out: Seg[] = []
    for (let i = 0; i + 6 < l.segs.length; i += 7) {
      out.push({ a: [l.segs[i] as number, l.segs[i + 1] as number], b: [l.segs[i + 2] as number, l.segs[i + 3] as number], w: l.segs[i + 4] as number, t: l.segs[i + 5] as number })
    }
    return out
  })

/** everything a blueprint's plan inks, as lines of a width and discs, board px */
export interface PlanInk { lines: Array<{ a: P2; b: P2; w: number }>; discs: Array<{ x: number; y: number; r: number }> }

/** the copper the plan draws: the drawn side's traces, the pads on it and every via */
export const planInk = (layers: TraceLayer[], pads: TracePad[], vias: TraceVia[]): PlanInk => ({
  lines: layerSegs(layers),
  discs: [...pads.filter((q) => q.side !== 'B').map((q) => ({ x: q.x, y: q.y, r: 0.5 * Math.max(q.w, q.h) })), ...vias.map((q) => ({ x: q.x, y: q.y, r: q.r }))]
})

/** how many lines and discs of the ink come within margin of a box; none means bare paper */
export function inkAcross(r: { x: number; y: number; w: number; h: number }, ink: PlanInk, margin: number): number {
  const discs = ink.discs.filter((d) => Math.hypot(d.x - clamp(d.x, r.x, r.x + r.w), d.y - clamp(d.y, r.y, r.y + r.h)) < d.r + margin).length
  return discs + ink.lines.filter((l) => {
    const m = margin + l.w / 2
    const dx = l.b[0] - l.a[0]
    const dy = l.b[1] - l.a[1]
    let t0 = 0
    let t1 = 1
    let out = false
    for (const [den, num] of [[-dx, l.a[0] - (r.x - m)], [dx, r.x + r.w + m - l.a[0]], [-dy, l.a[1] - (r.y - m)], [dy, r.y + r.h + m - l.a[1]]] as Array<[number, number]>) {
      if (den === 0) out = out || num < 0
      else if (den < 0) t0 = Math.max(t0, num / den)
      else t1 = Math.min(t1, num / den)
    }
    return !out && t0 <= t1
  }).length
}

const keyOf = (p: P2): string => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`

function chains(segs: Seg[]): Array<{ pts: P2[]; w: number; t: number }> {
  const order = segs.map((_, i) => i).sort((x, y) => (segs[x] as Seg).t - (segs[y] as Seg).t)
  const at = new Map<string, number[]>()
  segs.forEach((s, i) => {
    for (const q of [s.a, s.b]) {
      const k = keyOf(q)
      at.set(k, [...(at.get(k) ?? []), i])
    }
  })
  const used = new Set<number>()
  const out: Array<{ pts: P2[]; w: number; t: number }> = []
  for (const i of order) {
    if (used.has(i)) continue
    const s = segs[i] as Seg
    used.add(i)
    const pts: P2[] = [s.a, s.b]
    for (let guard = 0; guard < 400; guard++) {
      const end = pts[pts.length - 1] as P2
      const next = (at.get(keyOf(end)) ?? []).filter((j) => !used.has(j) && Math.abs((segs[j] as Seg).w - s.w) < 0.01)
        .sort((x, y) => (segs[x] as Seg).t - (segs[y] as Seg).t)[0]
      if (next === undefined) break
      used.add(next)
      const n = segs[next] as Seg
      pts.push(keyOf(n.a) === keyOf(end) ? n.b : n.a)
    }
    out.push({ pts, w: s.w, t: s.t })
  }
  return out
}

const polyLen = (pts: P2[]): number => pts.slice(1).reduce((t, q, i) => t + dist(pts[i] as P2, q), 0)

/** the share of the opening's ink already down on its first frame when the fan grows out of the hero: its heaviest tracks */
const OPEN_TRUNK = 0.3
/** the beats into the opening that the pen letters the hero's lid: late enough for frame 0 to open close on the pen and pull back to the chip first */
const LID_MARK = 0.5
/** how much of the drawing time the fan's start times spread over, nearest the hero first */
const GROW_SPREAD = 0.55

/** the opening on the hero's own routes: its heaviest tracks already inked, the pen drawing the lid, and every other line growing out from the pins in order of its distance from the hero */
function growFan(ring: { pts: P2[]; w: number }, lines: Array<{ pts: P2[]; w: number; r: number; len: number }>, from: number, to: number, z: number, u: number): PlotStroke[] {
  const total = lines.reduce((t, c) => t + c.len, 0)
  const trunks: typeof lines = []
  let inked = 0
  for (const c of [...lines].sort((a, b) => b.w - a.w || b.len - a.len)) {
    if (inked >= OPEN_TRUNK * total) break
    trunks.push(c)
    inked += c.len
  }
  const rest = lines.filter((c) => !trunks.includes(c)).sort((a, b) => a.r - b.r)
  const span = to - from
  const [r0, r1] = [rest[0]?.r ?? 0, rest[rest.length - 1]?.r ?? 1]
  const v = NIB_SPEED * u * 24
  return [
    ...trunks.map((c) => ({ path: c.pts.flat(), w: c.w, t0: -1, t1: -1 })),
    { path: ring.pts.flat(), w: ring.w, t0: from - 0.04 * span, t1: from + 0.1 * span },
    ...rest.map((c) => {
      const t0 = from + 0.1 * span + GROW_SPREAD * span * ((c.r - r0) / Math.max(1e-9, r1 - r0))
      return { path: c.pts.flat(), w: c.w, t0, t1: Math.min(to, t0 + clamp((c.len * z) / v, 0.12 * span, 0.35 * span)) }
    })
  ]
}

function schedule(list: Array<{ pts: P2[]; w: number }>, z: number, u: number, from: number, to: number, pre: number, nearest: boolean, speed = 700 * u * 24): PlotStroke[] {
  const v = speed
  const dur = (s: { pts: P2[] }): number => (polyLen(s.pts) * z) / v
  let k = pre
  if (pre < 0) {
    k = list.length
    let tot = 0
    while (k > 0 && tot + dur(list[k - 1] as { pts: P2[] }) + 0.12 * B <= to - from) {
      k -= 1
      tot += dur(list[k] as { pts: P2[] }) + 0.12 * B
    }
    k = Math.max(0, Math.min(k, list.length - 1))
  }
  const done = list.slice(0, k).map((s) => ({ path: s.pts.flat(), w: s.w, t0: -1, t1: -1 }))
  const rest = list.slice(k)
  const ordered: Array<{ pts: P2[]; w: number }> = []
  let pen: P2 | undefined = rest[0]?.pts[0]
  while (rest.length > 0) {
    let pick = 0
    if (nearest && pen !== undefined) {
      const here = pen
      const window = rest.slice(0, 6)
      pick = window.reduce((b, s, i) => {
        const cost = (q: { pts: P2[] }): number => Math.min(dist(here, q.pts[0] as P2), dist(here, q.pts[q.pts.length - 1] as P2))
        return cost(s) < cost(window[b] as { pts: P2[] }) ? i : b
      }, 0)
    }
    const s = rest.splice(pick, 1)[0] as { pts: P2[]; w: number }
    const pts = nearest && pen !== undefined && dist(pen, s.pts[s.pts.length - 1] as P2) < dist(pen, s.pts[0] as P2) ? [...s.pts].reverse() : s.pts
    ordered.push({ pts, w: s.w })
    pen = pts[pts.length - 1]
  }
  const need = ordered.reduce((tt, o, i) => tt + dur(o) + (i > 0 ? 0.1 * B : 0), 0)
  const slow = pre < 0 && need > 0 && need < 0.9 * (to - from) ? (0.9 * (to - from)) / need : 1
  const dur0 = dur
  const durS = (o: { pts: P2[] }): number => dur0(o) * slow
  const d0 = ordered[0] === undefined ? 0 : durS(ordered[0])
  let t = from - Math.max(0.4 * d0, d0 - 0.5 * (to - from - 0.1 * B))
  let prev: P2 | undefined
  const live = ordered.map((s) => {
    if (prev !== undefined) t += 0.1 * B * slow + (dist(prev, s.pts[0] as P2) * z) / (3 * v)
    const t0 = t
    t += durS(s)
    prev = s.pts[s.pts.length - 1]
    return { path: s.pts.flat(), w: s.w, t0: t <= to - 0.1 * B ? t0 : 2, t1: t <= to - 0.1 * B ? t : 2 }
  })
  return [...done, ...live]
}


interface Run { lines: Seg[]; d: P2; n: P2; lo: number; hi: number }

const segLen = (s: Seg): number => dist(s.a, s.b)
const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1]
const segMid = (s: Seg): P2 => [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]

/** the largest group of parallel neighbouring tracks at a steady pitch, and the run all of them share */
/** the longest steady bundle of parallel tracks, weighted towards one with copper around it to fill the macro's frame */
function findBundle(segs: Seg[], minRun: number, aspect: number): Run | undefined {
  const cands = segs.filter((s) => segLen(s) >= minRun).sort((x, y) => segLen(y) - segLen(x)).slice(0, 80)
  const found: Array<Run & { score: number }> = []
  for (const c of cands) {
    const L = segLen(c)
    const d: P2 = [(c.b[0] - c.a[0]) / L, (c.b[1] - c.a[1]) / L]
    const n: P2 = [-d[1], d[0]]
    const al = (q: P2): number => dot([q[0] - c.a[0], q[1] - c.a[1]], d)
    const ac = (q: P2): number => dot([q[0] - c.a[0], q[1] - c.a[1]], n)
    const par = segs.flatMap((s) => {
      const sl = segLen(s)
      if (sl <= 0 || Math.abs(dot([s.b[0] - s.a[0], s.b[1] - s.a[1]], d)) / sl < 0.9976) return []
      const sp: [number, number] = [Math.max(0, Math.min(al(s.a), al(s.b))), Math.min(L, Math.max(al(s.a), al(s.b)))]
      return sp[1] - sp[0] >= minRun ? [{ s, c: ac(segMid(s)), sp }] : []
    }).sort((x, y) => x.c - y.c)
    const i0 = par.findIndex((p) => p.s === c)
    if (i0 < 0) continue
    for (let i = Math.max(0, i0 - 23); i <= i0; i++) {
      for (let j = Math.max(i0, i + 2); j < Math.min(par.length, i + 24); j++) {
        const group = par.slice(i, j + 1)
        if (new Set(group.map((g) => g.s.net)).size < group.length) break
        const gaps = group.slice(1).map((g, k) => g.c - (group[k] as { c: number }).c)
        if (gaps.some((g, k) => g < 0.5 * ((group[k] as { s: Seg }).s.w + (group[k + 1] as { s: Seg }).s.w))) break
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
        const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length)
        if (sd / mean > 0.35) continue
        const lo = Math.max(...group.map((g) => g.sp[0]))
        const hi = Math.min(...group.map((g) => g.sp[1]))
        if (hi - lo < minRun) break
        const score = (hi - lo) * group.length ** 0.8 * (group.length >= 6 ? 1.3 : 1)
        const o = dot(c.a, d)
        found.push({ lines: group.map((g) => g.s), d, n, lo: lo + o, hi: hi + o, score })
      }
    }
  }
  const neighbours = (r: Run): number => {
    const L = r.hi - r.lo
    const cs = r.lines.map((l) => dot(segMid(l), r.n))
    const c0 = Math.min(...cs)
    const c1 = Math.max(...cs)
    const half = 0.5 * aspect * (L + 0.2 * L)
    let t = 0
    for (const s of segs) {
      if (r.lines.includes(s)) continue
      const m = segMid(s)
      const a = dot(m, r.d)
      const c = dot(m, r.n)
      if (a > r.lo - 0.1 * L && a < r.hi + 0.1 * L && c > (c0 + c1) / 2 - half && c < (c0 + c1) / 2 + half && (c < c0 || c > c1)) t += segLen(s)
    }
    return t / (L * r.lines.length)
  }
  return found.sort((x, y) => y.score - x.score).slice(0, 40).map((r) => ({ r, s: r.score * Math.min(8, 0.1 + neighbours(r)) })).reduce<{ r: Run; s: number } | undefined>((b, x) => (b === undefined || x.s > b.s ? x : b), undefined)?.r
}

const polarity = (name: string): { base: string; pol: string } | undefined => {
  const m = /^(.*?)([+-]|_[PN])$/i.exec(name)
  if (m === null || (m[1] ?? '').length === 0) return undefined
  return { base: (m[1] ?? '').toUpperCase(), pol: (m[2] ?? '').toUpperCase() }
}

/** a differential pair by name (D+/D−, _P/_N) where its two tracks run side by side longest */
function findPair(segs: Seg[], names: Map<number, string>, minRun: number, maxGap: number): (Run & { text: string; gap: number }) | undefined {
  const byNet = new Map<number, Seg[]>()
  for (const s of segs) if (s.net !== undefined) byNet.set(s.net, [...(byNet.get(s.net) ?? []), s])
  const pol = [...byNet.keys()].flatMap((id) => {
    const nm = bareName(names.get(id) ?? '')
    const p = polarity(nm)
    return p === undefined || netKind(names.get(id) ?? '') === 'power' || netKind(names.get(id) ?? '') === 'ground' ? [] : [{ id, nm, ...p }]
  })
  let best: (Run & { text: string; gap: number; run: number }) | undefined
  for (const A of pol) {
    if (A.pol !== '+' && A.pol !== '_P') continue
    const B = pol.find((q) => q.base === A.base && q.pol === (A.pol === '+' ? '-' : '_N'))
    if (B === undefined) continue
    for (const s1 of byNet.get(A.id) ?? []) {
      const L = segLen(s1)
      if (L < minRun) continue
      const d: P2 = [(s1.b[0] - s1.a[0]) / L, (s1.b[1] - s1.a[1]) / L]
      const n: P2 = [-d[1], d[0]]
      for (const s2 of byNet.get(B.id) ?? []) {
        const l2 = segLen(s2)
        if (l2 <= 0 || Math.abs(dot([s2.b[0] - s2.a[0], s2.b[1] - s2.a[1]], d)) / l2 < 0.9976) continue
        const off = Math.abs(dot([segMid(s2)[0] - s1.a[0], segMid(s2)[1] - s1.a[1]], n))
        const gap = off - (s1.w + s2.w) / 2
        if (gap <= 0 || gap > maxGap) continue
        const p0 = Math.max(0, Math.min(dot([s2.a[0] - s1.a[0], s2.a[1] - s1.a[1]], d), dot([s2.b[0] - s1.a[0], s2.b[1] - s1.a[1]], d)))
        const p1 = Math.min(L, Math.max(dot([s2.a[0] - s1.a[0], s2.a[1] - s1.a[1]], d), dot([s2.b[0] - s1.a[0], s2.b[1] - s1.a[1]], d)))
        if (p1 - p0 < minRun || (best !== undefined && p1 - p0 <= best.run)) continue
        let pre = 0
        while (pre < Math.min(A.nm.length, B.nm.length) && A.nm[pre] === B.nm[pre]) pre++
        const cut = A.nm.lastIndexOf('_', pre) + 1
        const head = A.nm.slice(0, cut).replace(/_+$/, '').replace(/_/g, ' ').toUpperCase()
        const tail = (s: string): string => s.slice(cut).toUpperCase().replace(/-$/, '−')
        const o = dot(s1.a, d)
        best = { lines: [s1, s2], d, n, lo: p0 + o, hi: p1 + o, gap, run: p1 - p0, text: `${head.length > 0 ? `${head} ` : ''}${tail(A.nm)} / ${tail(B.nm)}` }
      }
    }
  }
  return best
}

const SHORT: Array<[RegExp, string]> = [[/USB/, 'USB'], [/PMOD/, 'PMOD'], [/RJ45|ETH/, 'RJ45'], [/SMA/, 'SMA'], [/BNC/, 'BNC'], [/DB9|DB-9|DSUB/, 'DB9'], [/JACK|BARREL/, 'JACK'], [/HOST/, 'HOST'], [/POWER|PWR/, 'POWER'], [/HEADER|PIN|CONN|SOCKET|IDC/, 'HEADER']]
const shortName = (v: string | undefined): string => {
  const t = (v ?? '').toUpperCase()
  return SHORT.find(([re]) => re.test(t))?.[1] ?? (t.split(/[\s_]/)[0] ?? '').slice(0, 8)
}

/** a value fit to print: no underscore, at most 14 characters, upper case */
const plain = (v: string | undefined): string | undefined => (v === undefined || v.length === 0 || v.includes('_') || v.length > 14 ? undefined : v.toUpperCase())

/** the part number as the package prints it: the token with letters and digits, maker names dropped, upper case */
export const partNumber = (v: string | undefined): string => {
  const toks = (v ?? '').split(/[_\s]+/).filter((s) => /\d/.test(s) && /[A-Za-z]/.test(s))
  const pn = (toks.reduce<string | undefined>((b, s) => (b === undefined || s.length > b.length ? s : b), undefined) ?? v ?? '').toUpperCase().slice(0, 20)
  const core = pn.split('-')[0] ?? pn
  return pn.length > 10 && core.length >= 5 ? core : pn
}

const CONN = /^(J|P|CN|USB|X|BUS)\d/i
/** a part the route may end on: a connector by its reference, or any part whose footprint is a pin header or socket */
const isConn = (f: Pick<Footprint, 'ref' | 'footprint'>): boolean => CONN.test(f.ref) || /^Pin(Header|Socket)_\d+x\d+/i.test(f.footprint ?? '')
const CHIP = /^(U|IC)\d/i
const CRYSTAL = /MHZ|\d(\.\d+)?M$|XTAL|CRYSTAL|OSC/i

/** the connector power comes in through: a USB host or power jack first, by what it is called */
const inkShift = (ink: PlotInk, t: number): number => (t < ink.hold[0] ? t : t + ink.hold[1] - ink.hold[0])

/** the raw time the ink has reached at film time p: it stands still over the held beat */
export const inkClock = (ink: PlotInk, p: number): number => (p < ink.hold[0] ? p : Math.max(ink.hold[0], p - (ink.hold[1] - ink.hold[0])))

/** one line of the front copper, board px; lead marks a line of a net the film's signal runs on */
export interface InkLine { a: [number, number]; b: [number, number]; w: number; lead: boolean }

/**
 * The order a travelling film inks the front copper in. The chip's own signals near it wait for the fan-out
 * and grow outward from the chip along their copper, each from a to b over t0 to t1 (`fan`). Every other line
 * (`rest`) is inked as the front reaches it (`inkTime`).
 */
export function fanInk(layers: TraceLayer[], groups: TraceGroup[], chip: { x: number; y: number; w: number; h: number; rot: number } | undefined, ink: PlotInk): { fan: Array<InkLine & { t0: number; t1: number }>; rest: InkLine[] } {
  const c: [number, number] = [ink.far.x, ink.far.y]
  const onChip = (q: [number, number]): boolean => {
    if (chip === undefined) return Math.hypot(q[0] - c[0], q[1] - c[1]) <= ink.fan.r0
    const dx = q[0] - chip.x
    const dy = q[1] - chip.y
    const co = Math.cos(chip.rot)
    const si = Math.sin(chip.rot)
    return Math.abs(co * dx + si * dy) <= 0.55 * chip.w && Math.abs(-si * dx + co * dy) <= 0.55 * chip.h
  }
  const all: Array<InkLine & { held: boolean }> = []
  for (const layer of layers) {
    if (layer.side !== 'F') continue
    for (let i = 0; i + 6 < layer.segs.length; i += 7) {
      const a: [number, number] = [layer.segs[i] as number, layer.segs[i + 1] as number]
      const b: [number, number] = [layer.segs[i + 2] as number, layer.segs[i + 3] as number]
      const g = groups[layer.groups[i / 7] as number]
      const near = Math.min(Math.hypot(a[0] - c[0], a[1] - c[1]), Math.hypot(b[0] - c[0], b[1] - c[1]))
      all.push({ a, b, w: Math.round((layer.segs[i + 4] as number) * 4) / 4, lead: (g?.t ?? -1) >= 0, held: g?.hero === true && g.kind !== 'ground' && g.kind !== 'power' && near <= ink.fan.r })
    }
  }
  const key = (q: [number, number]): string => `${Math.round(q[0] * 2)},${Math.round(q[1] * 2)}`
  const ends = new Map<string, number[]>()
  all.forEach((q, i) => {
    if (!q.held) return
    for (const e of [q.a, q.b]) ends.set(key(e), [...(ends.get(key(e)) ?? []), i])
  })
  const reach = new Map<string, number>()
  const turn = (q: [number, number]): number => {
    const a = (Math.atan2(q[1] - c[1], q[0] - c[0]) - ink.fan.from) / (2 * Math.PI)
    return (a - Math.floor(a)) * ink.fan.round * ink.fan.v
  }
  all.forEach((q) => { if (q.held) for (const e of [q.a, q.b]) if (onChip(e)) reach.set(key(e), turn(e)) })
  const fan: Array<InkLine & { t0: number; t1: number }> = []
  const taken = new Set<number>()
  for (let open = [...reach.keys()]; open.length > 0;) {
    open.sort((x, y) => (reach.get(x) as number) - (reach.get(y) as number))
    const at = open.shift() as string
    const d = reach.get(at) as number
    for (const i of ends.get(at) ?? []) {
      if (taken.has(i)) continue
      taken.add(i)
      const q = all[i] as (typeof all)[number]
      const [a, b] = key(q.a) === at ? [q.a, q.b] : [q.b, q.a]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const t0 = ink.fan.t + d / ink.fan.v
      const stood = standSeed(ink, a, b)
      fan.push(stood !== undefined ? { a, b, w: q.w, lead: q.lead, t0: Math.min(standTime(ink, a[0], a[1]), standTime(ink, b[0], b[1])), t1: Math.max(standTime(ink, a[0], a[1]), standTime(ink, b[0], b[1])) } : { a, b, w: q.w, lead: q.lead, t0, t1: t0 + len / ink.fan.v })
      const far = key(b)
      if ((reach.get(far) ?? Infinity) > d + len) {
        if (!reach.has(far)) open.push(far)
        reach.set(far, d + len)
      }
    }
  }
  return { fan, rest: all.filter((_, i) => !taken.has(i)).map(({ a, b, w, lead }) => ({ a, b, w, lead })) }
}

/** the film time the ink (lead 0) or the pencil (lead ink.lead) reaches board point x, y */
export function inkTime(ink: PlotInk, x: number, y: number, lead = 0): number {
  let t = ink.far.t + Math.hypot(x - ink.far.x, y - ink.far.y) / ink.far.v
  t = Math.min(t, standTime(ink, x, y))
  for (let i = 0; i + 3 < ink.src.length; i += 4) t = Math.min(t, (ink.src[i + 2] as number) + Math.hypot(x - (ink.src[i] as number), y - (ink.src[i + 1] as number)) / (ink.src[i + 3] as number))
  return inkShift(ink, t - lead)
}


/** a standing line's time sits this far ahead of the arrival, so it is whole on the arrival's frame */
const STAND_EARLY = 1e-6

/** the beats before the ride's arrival that the stand box's copper drafts in over, as a ring from the main chip outward */
export const STAND_DRAFT = 2

/** the film time the stand box's ring reaches board point x, y; Infinity outside the box */
export function standTime(ink: PlotInk, x: number, y: number): number {
  const s = ink.stand
  return s === undefined || !inQuad(s.at, [x, y]) ? Infinity : s.t0 + Math.hypot(x - s.from[0], y - s.from[1]) / s.v
}

/** where on the line a to b the stand box's ring first meets it (u along it), when, and how fast it runs on along it; undefined for a line whose middle lies outside the box */
export function standSeed(ink: PlotInk, a: [number, number], b: [number, number]): { u: number; t: number; v: number } | undefined {
  const s = ink.stand
  if (s === undefined || !inQuad(s.at, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) return undefined
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const l2 = dx * dx + dy * dy
  const u = l2 > 0 ? clamp(((s.from[0] - a[0]) * dx + (s.from[1] - a[1]) * dy) / l2, 0, 1) : 0
  return { u, t: s.t0 + Math.hypot(a[0] + dx * u - s.from[0], a[1] + dy * u - s.from[1]) / s.v, v: s.v }
}

/** whether q lies inside the convex quad at */
export function inQuad(at: Array<[number, number]>, q: [number, number]): boolean {
  const s = at.map((a, i) => { const b = at[(i + 1) % at.length] as [number, number]; return (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) })
  return s.every((v) => v >= 0) || s.every((v) => v <= 0)
}

const HALVES = 48
const halfStart =(k: number, total: number): number => Math.floor((k * total) / HALVES + 0.5)

/** the film time (0..1) a frame shows: every half-beat starts on a whole frame, so nothing authored on the beat grid falls between frames */
export function plotClock(frame: number, total: number): number {
  let k = clamp(Math.floor((frame * HALVES) / total), 0, HALVES - 1)
  while (k < HALVES - 1 && halfStart(k + 1, total) <= frame) k++
  while (k > 0 && halfStart(k, total) > frame) k--
  const a = halfStart(k, total)
  return (k + (frame - a) / (halfStart(k + 1, total) - a)) / HALVES
}

/** the frame, fractional, that shows film time t under plotClock */
export function plotFrame(t: number, total: number): number {
  const k = clamp(Math.floor(t * HALVES), 0, HALVES - 1)
  const a = halfStart(k, total)
  return a + (t * HALVES - k) * (halfStart(k + 1, total) - a)
}

/** the film time of the frame nearest t under plotClock */
export function plotSnap(t: number, total: number): number {
  return plotClock(Math.round(plotFrame(t, total)), total)
}

const insideConvex = (q: P2, poly: P2[]): boolean => {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as P2
    const b = poly[(i + 1) % poly.length] as P2
    const c = Math.sign((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]))
    if (c === 0) continue
    if (sign === 0) sign = c
    else if (c !== sign) return false
  }
  return poly.length >= 3
}

/** two segments cross at a point inside both */
export const segmentsCross = (p: [P2, P2], q: [P2, P2]): boolean => {
  const side = (a: P2, b: P2, c: P2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  return side(p[0], p[1], q[0]) * side(p[0], p[1], q[1]) < 0 && side(q[0], q[1], p[0]) * side(q[0], q[1], p[1]) < 0
}

const leaderEnd = (at: P2, r: PlotRect): P2 => [Math.min(r.x + r.w, Math.max(r.x, at[0])), Math.min(r.y + r.h, Math.max(r.y, at[1]))]

const insideLength = (a: P2, b: P2, r: PlotRect): number => {
  let t0 = 0
  let t1 = 1
  const d: P2 = [b[0] - a[0], b[1] - a[1]]
  for (const [p, q] of [[-d[0], a[0] - r.x], [d[0], r.x + r.w - a[0]], [-d[1], a[1] - r.y], [d[1], r.y + r.h - a[1]]] as const) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return 0; continue }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
  }
  return t1 > t0 ? (t1 - t0) * Math.hypot(d[0], d[1]) : 0
}

/** which callouts keep their leader: one that runs deep across the object, or crosses a leader already kept, is dropped */
export function cleanLeaders(calls: Array<{ at: P2 | undefined; rect: PlotRect | undefined }>, board: PlotRect): boolean[] {
  const reach = 0.3 * Math.min(board.w, board.h)
  const kept: Array<[P2, P2]> = []
  return calls.map(({ at, rect }) => {
    if (at === undefined || rect === undefined) return false
    const end = leaderEnd(at, rect)
    if (insideLength(at, end, board) > reach) return false
    if (kept.some(([a, b]) => segmentsCross([a, b], [at, end]))) return false
    kept.push([at, end])
    return true
  })
}

/** a rectangle touches a convex polygon */
export function rectHits(r: PlotRect, poly: P2[]): boolean {
  const c: P2[] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]
  return c.some((q, i) => segmentHits(q, c[(i + 1) % 4] as P2, poly)) || poly.some((q) => q[0] > r.x && q[0] < r.x + r.w && q[1] > r.y && q[1] < r.y + r.h)
}

/** a segment touches a convex polygon: an end inside it or a crossing of one of its edges */
export function segmentHits(a: P2, b: P2, poly: P2[]): boolean {
  if (insideConvex(a, poly) || insideConvex(b, poly)) return true
  const side = (p: P2, q: P2, r: P2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  return poly.some((p, i) => {
    const q = poly[(i + 1) % poly.length] as P2
    return side(a, b, p) * side(a, b, q) < 0 && side(p, q, a) * side(p, q, b) < 0
  })
}

/** three or more pads on one straight line: a row of pins, as on a 4-sided IC or a 2-row connector */
function inRow(ps: Vec2[]): boolean {
  return ps.some((a, i) => {
    const angles = ps.filter((_, j) => j !== i).map((b) => { const t = Math.atan2(b.y - a.y, b.x - a.x); return t < 0 ? t + Math.PI : t >= Math.PI ? t - Math.PI : t }).sort((x, y) => x - y)
    return angles.some((t, k) => k > 0 && t - (angles[k - 1] as number) < 0.01) || (angles.length > 1 && (angles[0] as number) + Math.PI - (angles[angles.length - 1] as number) < 0.01)
  })
}

/** footprints drawn as cylinders: the footprint's own outline is a circle around its pads, or every pad lies on one circle and no three on a line */
export function roundParts(board: BoardModel, padsOf: Map<string, Pad[]>): Footprint[] {
  return board.footprints.filter((f) => {
    const ps = [...new Map((padsOf.get(f.ref) ?? []).map((pd) => [keyOf([pd.pos.x, pd.pos.y]), pd.pos])).values()]
    if (ps.length === 0) return false
    const cx = ps.reduce((t, q) => t + q.x, 0) / ps.length
    const cy = ps.reduce((t, q) => t + q.y, 0) / ps.length
    const reach = Math.max(...ps.map((q) => Math.hypot(q.x - cx, q.y - cy)))
    const c = f.circle
    if (c !== undefined && c.r >= 0.6 && c.r >= 0.8 * reach && Math.hypot(c.center.x - cx, c.center.y - cy) < 0.25 * c.r) return true
    if (ps.length < 5 || inRow(ps)) return false
    const rs = ps.map((q) => Math.hypot(q.x - cx, q.y - cy))
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length)
    return mean > 0 && sd / mean < 0.08
  })
}

export function entryOf(board: BoardModel, fallback: string | undefined): Footprint | undefined {
  const nets = new Map(board.nets.map((n) => [n.id, n.name]))
  const padNets = new Map<string, string[]>()
  for (const c of Object.values(board.copper)) for (const p of c.pads) if (p.footprintRef !== undefined) padNets.set(p.footprintRef, [...(padNets.get(p.footprintRef) ?? []), nets.get(p.netId ?? -1) ?? ''])
  const score = (f: Footprint): number => {
    const v = (f.value ?? '').toUpperCase()
    const ns = padNets.get(f.ref) ?? []
    return (/HOST|UPSTREAM|PLUG|OTG|USB_?C|TYPE.?C|USB_?B|MICRO/.test(v) ? 4 : 0) + (/JACK|BARREL|POWER|PWR|DC_?IN|VIN|PCI|EDGE/.test(v) ? 3 : 0) +
      (ns.some((n) => /VBUS|VIN|VUSB/i.test(n)) ? 2 : 0) + (/USB/.test(v) ? 1 : 0)
  }
  const ranked = board.footprints.filter((f) => CONN.test(f.ref) && !CRYSTAL.test(f.value ?? '')).map((f) => ({ f, s: score(f) })).filter((c) => c.s > 0).sort((a, b) => b.s - a.s)
  return ranked[0]?.f ?? board.footprints.find((f) => f.ref === fallback)
}


const PART_KIND: Array<[RegExp, string]> = [[/^(U|IC|VR|REG)[A-Z_]*\d/i, 'REGULATOR'], [/^FB[A-Z_]*\d/i, 'FERRITE'], [/^F[A-Z_]*\d/i, 'FUSE'], [/^L[A-Z_]*\d/i, 'INDUCTOR'], [/^D[A-Z_]*\d/i, 'DIODE'], [/^(SW|S)[A-Z_]*\d/i, 'SWITCH'], [/^R[A-Z_]*\d/i, 'RESISTOR'], [/^(Q|T)\d/i, 'TRANSISTOR'], [/^JP[A-Z_]*\d/i, 'JUMPER']]

interface PathStep { a: Vec2; b: Vec2; w: number; kind: 'trace' | 'link'; label?: string | undefined; layer?: string; net?: string; part?: string; plane?: boolean }

/** the board's drilled holes grouped by diameter to 0.01 mm, smallest first */
export const holeSchedule = (board: BoardModel): Array<{ dia: number; count: number }> => {
  const by = new Map<number, number>()
  for (const d of board.drill) {
    const k = Math.round(d.dia * 100) / 100
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([dia, count]) => ({ dia, count }))
}

/** what a valve's supply connector feeds: HT when its net reaches an anode (pin 1 or 6), the heater when it reaches pins 4, 5 or 9 */
function valveSupply(board: BoardModel, valve: Footprint, entry: Footprint): string {
  const pads = Object.values(board.copper).flatMap((c) => c.pads)
  const own = [...new Map(pads.filter((p) => p.footprintRef === valve.ref).map((p) => [p.id, p])).values()]
  const feeds = new Set(pads.filter((p) => p.footprintRef === entry.ref && p.netId !== undefined).map((p) => p.netId))
  const on = (pins: number[]): boolean => pins.some((i) => feeds.has(own[i - 1]?.netId))
  return on([1, 6]) ? 'HT SUPPLY' : on([4, 5, 9]) ? 'HEATER' : 'VIN'
}

/** the one supply path: entry pad to the hero's nearest power pin, the copper it runs on, the planes and parts it crosses, its vias, and the hero pins on its net; its labels name the supply where it starts (its net, or `supply` when the net has no name), each regulator by the net it puts out, each plane it hops, and a run on the far side by its layer */
export function powerPath(board: BoardModel, entry: Footprint, heroRef: string | undefined, top = 'F.Cu', supply = 'VIN'): { steps: PathStep[]; vias: Vec2[]; pins: Vec2[] } | undefined {
  const names = new Map(board.nets.map((n) => [n.id, n.name]))
  const kind = (id: number | undefined): string => (id === undefined ? 'none' : netKind(names.get(id) ?? ''))
  const allPads = Object.values(board.copper).flatMap((c) => c.pads)
  const own = allPads.filter((p) => p.footprintRef === entry.ref && p.netId !== undefined && kind(p.netId) !== 'ground')
  const strict = own.filter((p) => kind(p.netId) === 'power' || /VBUS|VIN|PWR|Pin_?1\b|Pad1\b/i.test(names.get(p.netId as number) ?? ''))
  const seedNets = new Set((strict.length > 0 ? strict : own.filter((p) => !/D[+-]|DP|DM|DATA|SDA|SCL|TX|RX/i.test(names.get(p.netId as number) ?? ''))).map((p) => p.netId as number))
  if (seedNets.size === 0) return undefined
  const ok = (id: number | undefined): boolean => id !== undefined && kind(id) !== 'ground' && (seedNets.has(id) || kind(id) === 'power' || /VIN|VCC|VDD|VBAT|PWR|-IN\)|^Net-\(/i.test(names.get(id) ?? ''))
  interface Node { p: Vec2; net: number }
  const nodes: Node[] = []
  const index = new Map<string, number>()
  const node = (p: Vec2, net: number): number => {
    const k = `${net}:${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`
    const hit = index.get(k)
    if (hit !== undefined) return hit
    nodes.push({ p, net })
    index.set(k, nodes.length - 1)
    return nodes.length - 1
  }
  interface Edge { to: number; cost: number; seg: number; via: 't' | 'p' | 'b' | 'z'; label?: string | undefined }
  const adj: Edge[][] = []
  const link = (a: number, b: number, cost: number, via: Edge['via'], seg = -1, label?: string): void => {
    while (adj.length < nodes.length) adj.push([])
    ;(adj[a] as Edge[]).push({ to: b, cost, seg, via, label })
    ;(adj[b] as Edge[]).push({ to: a, cost, seg, via, label })
  }
  const segs: Array<{ a: Vec2; b: Vec2; w: number; na: number; nb: number; layer: string }> = []
  for (const [layer, c] of Object.entries(board.copper)) {
    for (const t of c.traces) {
      if (!ok(t.netId)) continue
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1] as Vec2
        const b = t.points[i] as Vec2
        const na = node(a, t.netId as number)
        const nb = node(b, t.netId as number)
        segs.push({ a, b, w: t.width, na, nb, layer })
        link(na, nb, Math.hypot(b.x - a.x, b.y - a.y), 't', segs.length - 1)
      }
    }
  }
  const byNet = new Map<number, number[]>()
  nodes.forEach((nd, i) => byNet.set(nd.net, [...(byNet.get(nd.net) ?? []), i]))
  const attach = (p: Vec2, net: number, r: number): number => {
    const me = node(p, net)
    for (const j of byNet.get(net) ?? []) if (j !== me && Math.hypot((nodes[j] as Node).p.x - p.x, (nodes[j] as Node).p.y - p.y) <= r) link(me, j, 0, 'p')
    return me
  }
  const padNode = new Map<string, number>()
  for (const p of allPads) if (ok(p.netId)) padNode.set(p.id, attach(p.pos, p.netId as number, Math.max(p.size.x, p.size.y) / 2 + 0.05))
  const viaNodes = new Set<number>()
  for (const c of Object.values(board.copper)) for (const v of c.vias) if (ok(v.netId)) viaNodes.add(attach(v.pos, v.netId as number, v.dia / 2 + 0.05))
  const byFp = new Map<string, typeof allPads>()
  for (const p of allPads) if (p.footprintRef !== undefined && ok(p.netId)) byFp.set(p.footprintRef, [...(byFp.get(p.footprintRef) ?? []), p])
  const fpValue = new Map(board.footprints.map((f) => [f.ref, f.value ?? '']))
  for (const [ref, ps] of byFp) {
    if (ref === heroRef || /^C[A-Z_]*\d/i.test(ref)) continue
    const v = fpValue.get(ref) ?? ''
    const loadSwitch = LOAD_SWITCH.test(v)
    if (/^(U|IC)\d/i.test(ref) && !loadSwitch && !REG.test(v) && !/^\d+(\.\d+)?V\d*$/i.test(v)) continue
    const kindOf = loadSwitch ? 'SWITCH' : PART_KIND.find(([re]) => re.test(ref))?.[1] ?? (partNumber(v) || 'PART')
    for (const a of ps) for (const b of ps) {
      if (a.netId === b.netId || a.id >= b.id) continue
      link(padNode.get(a.id) as number, padNode.get(b.id) as number, Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y), 'b', -1, `${ref} ${kindOf}`)
    }
  }
  const inPoly = (p: Vec2, poly: Vec2[]): boolean => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i] as Vec2
      const b = poly[j] as Vec2
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
    return inside
  }
  const pours: Array<{ members: number[]; label: string }> = []
  const pourOf = new Map<number, number[]>()
  for (const [layerName, c] of Object.entries(board.copper)) {
    const inner = !/^[FB]\./.test(layerName)
    for (const z of c.zones) {
      if (!ok(z.netId)) continue
      for (const f of z.fills) {
        const members = (byNet.get(z.netId as number) ?? []).concat([...padNode.values()].filter((i) => (nodes[i] as Node).net === z.netId)).filter((i) => inPoly((nodes[i] as Node).p, f))
        if (members.length < 2) continue
        const net = bareName(names.get(z.netId as number) ?? '').toUpperCase()
        pours.push({ members: [...new Set(members)], label: inner ? `VIA ${net} PLANE` : `${net} POUR` })
        for (const i of members) pourOf.set(i, [...(pourOf.get(i) ?? []), pours.length - 1])
      }
    }
  }
  while (adj.length < nodes.length) adj.push([])
  const dd = new Array<number>(nodes.length).fill(Infinity)
  const prev = new Array<Edge & { from: number } | undefined>(nodes.length).fill(undefined)
  const heap: Array<[number, number]> = []
  const push = (d: number, i: number): void => {
    heap.push([d, i])
    let k = heap.length - 1
    while (k > 0) {
      const pk = (k - 1) >> 1
      if ((heap[pk] as [number, number])[0] <= d) break
      ;[heap[pk], heap[k]] = [heap[k] as [number, number], heap[pk] as [number, number]]
      k = pk
    }
  }
  const pop = (): [number, number] => {
    const top = heap[0] as [number, number]
    const last = heap.pop() as [number, number]
    if (heap.length > 0) {
      heap[0] = last
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        const r = l + 1
        let m = k
        if (l < heap.length && (heap[l] as [number, number])[0] < (heap[m] as [number, number])[0]) m = l
        if (r < heap.length && (heap[r] as [number, number])[0] < (heap[m] as [number, number])[0]) m = r
        if (m === k) break
        ;[heap[m], heap[k]] = [heap[k] as [number, number], heap[m] as [number, number]]
        k = m
      }
    }
    return top
  }
  for (const p of allPads) {
    if (p.footprintRef !== entry.ref || p.netId === undefined || !seedNets.has(p.netId)) continue
    const i = padNode.get(p.id)
    if (i === undefined) continue
    dd[i] = 0
    push(0, i)
  }
  const relax = (from: number, e: Edge): void => {
    const nd = (dd[from] as number) + e.cost
    if (nd < (dd[e.to] as number)) {
      dd[e.to] = nd
      prev[e.to] = { ...e, from }
      push(nd, e.to)
    }
  }
  while (heap.length > 0) {
    const [d, i] = pop()
    if (d > (dd[i] as number)) continue
    for (const e of adj[i] as Edge[]) relax(i, e)
    for (const pi of pourOf.get(i) ?? []) {
      const pour = pours[pi] as { members: number[]; label: string }
      for (const j of pour.members) {
        if (j === i) continue
        const a = (nodes[i] as Node).p
        const b = (nodes[j] as Node).p
        relax(i, { to: j, cost: 4 * Math.hypot(b.x - a.x, b.y - a.y), seg: -1, via: 'z', label: pour.label })
      }
    }
  }
  const heroNodes = allPads.filter((p) => p.footprintRef === heroRef).map((p) => padNode.get(p.id)).filter((i): i is number => i !== undefined && Number.isFinite(dd[i]))
  const hp = allPads.filter((p) => p.footprintRef === heroRef)
  const hc = hp.length === 0 ? undefined : { x: hp.reduce((t, p) => t + p.pos.x, 0) / hp.length, y: hp.reduce((t, p) => t + p.pos.y, 0) / hp.length }
  const goal = heroNodes.sort((a, b) => (dd[a] as number) - (dd[b] as number))[0] ?? (hc === undefined ? undefined
    : nodes.map((nd, i) => ({ i, d: Math.hypot(nd.p.x - hc.x, nd.p.y - hc.y) })).filter(({ i }) => Number.isFinite(dd[i])).sort((a, b) => a.d - b.d)[0]?.i)
  if (goal === undefined) return undefined
  const chain: Array<{ from: number; to: number; e: Edge }> = []
  for (let k: number = goal; ;) {
    const e = prev[k]
    if (e === undefined) break
    chain.push({ from: e.from, to: k, e })
    k = e.from
  }
  chain.reverse()
  const steps: PathStep[] = []
  let w = 0.3
  let layer: string | undefined
  const seen = new Set<string>()
  const nodePad = new Map([...allPads].filter((p) => padNode.has(p.id)).map((p) => [padNode.get(p.id) as number, p]))
  const values = new Map(board.footprints.map((f) => [f.ref, f.value]))
  let passives = 0
  for (const { from, to, e } of chain) {
    const a = (nodes[from] as Node).p
    const b = (nodes[to] as Node).p
    if (e.seg >= 0) ({ w, layer } = segs[e.seg] as { w: number; layer: string })
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue
    const isLink = e.via === 'b' || e.via === 'z'
    const netName = names.get((nodes[to] as Node).net) ?? ''
    const shown = /^(Net-\(|unconnected)/i.test(netName) || netName.length === 0 ? undefined : bareName(netName).toUpperCase()
    const far = !isLink && layer !== undefined && layer !== top && /^[FB]\./.test(layer) ? ` · ${layer.toUpperCase()}` : ''
    const said = !steps.some((x) => x.kind === 'trace' && x.label !== undefined) && !isLink && layer !== undefined ? `${shown ?? supply}${far}` : e.via === 'z' ? e.label : e.via === 'b' && / REGULATOR$/.test(e.label ?? '') ? `${(e.label ?? '').replace(/ REGULATOR$/, '')} → ${shown ?? 'OUT'}` : far.length > 0 && !seen.has(layer ?? '') && Math.hypot(b.x - a.x, b.y - a.y) >= FAR_RUN ? `${shown ?? supply}${far}` : undefined
    const at = nodePad.get(from)
    const passive = at?.footprintRef !== undefined && at.footprintRef !== entry.ref && at.footprintRef !== heroRef && ON_ROUTE.test(at.footprintRef) && !seen.has(at.footprintRef) && passives < 1 && !steps.some((x) => x.kind === 'link' && x.label !== undefined && x.part === undefined) && !steps.some((x) => / → /.test(x.label ?? '')) ? `${at.footprintRef} ${(values.get(at.footprintRef) ?? '').toUpperCase()}`.trim() : undefined
    const label = said !== undefined && !seen.has(said) ? said : passive
    if (label !== undefined) seen.add(label)
    if (label !== undefined && label === passive) {
      seen.add(at?.footprintRef ?? '')
      passives++
    }
    if (far.length > 0) seen.add(layer ?? '')
    steps.push({ a, b, w, kind: isLink ? 'link' : 'trace', ...(label !== undefined ? { label } : {}), ...(!isLink && layer !== undefined ? { layer } : {}), net: names.get((nodes[to] as Node).net) ?? '', ...(e.via === 'b' && e.label !== undefined ? { part: e.label } : {}), ...(e.via === 'z' ? { plane: true } : {}) })
  }
  const pinPad = allPads.find((p) => p.footprintRef === heroRef && padNode.get(p.id) === goal)
  const lastAt = steps[steps.length - 1]?.b ?? (nodes[goal] as Node).p
  if (pinPad !== undefined && Math.hypot(pinPad.pos.x - lastAt.x, pinPad.pos.y - lastAt.y) > 1e-9) steps.push({ a: lastAt, b: pinPad.pos, w, kind: 'trace' })
  if (steps.length === 0) return undefined
  const tail = [...steps].reverse().find((x) => x.kind === 'trace' && x.label === undefined)
  if (pinPad?.num !== undefined && heroRef !== undefined && tail !== undefined) tail.label = `${heroRef} PIN ${pinPad.num}`
  const onPath = new Set([chain[0]?.from ?? -1, ...chain.map((c) => c.to)])
  const vias = [...onPath].filter((i) => viaNodes.has(i)).map((i) => (nodes[i] as Node).p)
  const endNet = (nodes[goal] as Node).net
  const pins = allPads.filter((p) => p.footprintRef === heroRef && p.netId === endNet).map((p) => p.pos)
  return { steps, vias, pins }
}

const polyArea = (pts: Vec2[]): number => Math.abs(pts.reduce((t, p, i) => {
  const q = pts[(i + 1) % pts.length] as Vec2
  return t + p.x * q.y - q.x * p.y
}, 0)) / 2

function layerRole(board: BoardModel, name: string, areaMm2: number, n: number): string {
  if (name.startsWith('F.')) return 'TOP COPPER'
  if (name.startsWith('B.')) return 'BOTTOM COPPER'
  const byNet = new Map<number, number>()
  for (const z of board.copper[name]?.zones ?? []) {
    if (z.netId === undefined) continue
    byNet.set(z.netId, (byNet.get(z.netId) ?? 0) + z.fills.reduce((t, f) => t + polyArea(f), 0))
  }
  const top = [...byNet.entries()].sort((a, b) => b[1] - a[1])[0]
  if (top !== undefined && top[1] >= 0.45 * areaMm2) {
    const net = board.nets.find((x) => x.id === top[0])?.name ?? ''
    const k = netKind(net)
    if (k === 'ground') return 'GND PLANE'
    if (k === 'power') return `${bareName(net).toUpperCase()} PLANE`
  }
  return `INNER ${n}`
}


/** screw and spring terminal blocks, by footprint name */
const TERMINAL = /TerminalBlock|AK300|Altech|Phoenix|MKDS|Screw_?Terminal/i
/** load switches and power-distribution switches: a supply passes through them unchanged */
const LOAD_SWITCH = /TPD\dS|TPS20\d\d|TPS22\d|SLG5N|AP22\d|MIC20\d\d/i
const REG = /REG|LDO|1117|2112|TLV7|MCP17|XC62|NCP|TPS7|TPS6|RT9|SPX|78\d\d|LM317|BUCK|DCDC|AP7|MIC5/i

/** the pencil's fastest ruling stroke, px a frame at 1080 */
export const HAND = 60

/** the sheet's callouts, at most: the hero, the power entry and the four most significant other named parts, the same in every aspect */
export const SHEET_CALLOUTS = 6

const COAX = new Set(['BNC', 'SMA'])

/** a footprint's signal pins: distinct pad numbers that carry a net, mounting holes and shield tabs left out */
export const signalPins = (pads: Pad[]): number =>
  new Set(pads.filter((pd) => pd.netId !== undefined && pd.num !== undefined && pd.num.length > 0 && !/^(MH|SH|S\d*|0|MP|EP|SHIELD)$/i.test(pd.num)).map((pd) => pd.num)).size

/** a crystal's frequency as printed: "24 MHZ", "32.768 KHZ"; else its value's first word */
export const frequency = (v: string | undefined): string => {
  const m = /(\d+(?:\.\d+)?)\s*(M|K)(?:HZ)?(?![A-Z])/i.exec(v ?? '')
  if (m !== null) return `${m[1] ?? ''} ${(m[2] ?? '').toUpperCase()}HZ`
  return (v ?? '').split(/[\s_]/)[0]?.toUpperCase() ?? ''
}

/** the screen angle a direction on the board takes in view v */
const screenAngle = (v: PlotAxo, b: P2): number => {
  const o = axoPoint(v, [v.mx, v.my], 0)
  const q = axoPoint(v, [v.mx + b[0], v.my + b[1]], 0)
  return Math.atan2(q[1] - o[1], q[0] - o[0])
}

/** the main chip's name, along the chip's own axes: the side of the lid that reads in every object view, turned round where in the plan at the arrival it would read from the right or downward; turns says it was turned, so the object views would carry it upside down */
function nameRead(plot: PlotScore, shots: CameraShot[], chip: Body): { read: P2; turns: boolean } | undefined {
  if (plot.ink === undefined) return undefined
  const o = plot.object
  const iso = plot.sheet.iso
  const base: PlotAxo = { ...iso, k: 1, x: 0, y: 0 }
  const views: PlotAxo[] = [
    ...Array.from({ length: 9 }, (_, i) => ({ ...base, psi: o.planYaw + ((o.psi[0] - o.planYaw) * i) / 8, e: Math.PI / 2 + ((o.e - Math.PI / 2) * i) / 8 })),
    ...Array.from({ length: 9 }, (_, i) => {
      const t = i / 8
      const turned = o.psi[1]
      return { ...base, psi: turned + Math.atan2(Math.sin(iso.psi - turned), Math.cos(iso.psi - turned)) * t, e: o.e + (iso.e - o.e) * t }
    })
  ]
  const c = Math.cos(chip.rot)
  const sn = Math.sin(chip.rot)
  const onBoard = (d: P2): P2 => [d[0] * c - d[1] * sn, d[0] * sn + d[1] * c]
  const dirs: P2[] = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as P2[]).filter(([x]) => (chip.w >= 1.2 * chip.h ? x !== 0 : chip.h >= 1.2 * chip.w ? x === 0 : true))
  const worst = (d: P2): number => Math.max(...views.map((v) => Math.abs(screenAngle(v, onBoard(d)))))
  const last = views[views.length - 1] as PlotAxo
  const upright = dirs.filter((d) => worst(d) <= Math.PI / 2)
  const lid = upright.length > 0 ? upright.reduce((b, d) => (Math.abs(screenAngle(last, onBoard(d))) < Math.abs(screenAngle(last, onBoard(b))) - 1e-9 ? d : b)) : dirs.reduce((b, d) => (worst(d) < worst(b) - 1e-9 ? d : b))
  const cam = sampleShot(shots, plot.ink.hold[0])
  const a = screenAngle({ ...base, psi: cam.yaw, e: Math.PI / 2 }, onBoard(lid))
  const [sx, sy] = [Math.cos(a), Math.sin(a)]
  const turns = Math.abs(sx) > 1e-6 ? sx < 0 : sy > 0
  return { read: turns ? [-lid[0], -lid[1]] : lid, turns }
}

/** the film's plot with the main chip kept clear of nearer bodies through the tilt (CHIP_HIDE), unless keeping it clear would draw the chip smaller on the sheet than the plain plot does: the poster keeps its chip */
export function clearPlot(inp: PlotInput): { shots: CameraShot[]; plot: PlotScore } {
  const kept = plotScore(inp)
  if (!kept.moved) return kept
  const plain = plotScore(inp, false, 1, undefined, false)
  return plain.plot.sheet.iso.k > kept.plot.sheet.iso.k ? plain : kept
}

export function plotScore(inp: PlotInput, signal = false, face = 1, read?: P2, avoid = true): { shots: CameraShot[]; plot: PlotScore; hidden: number; moved: boolean } {
  const W = inp.resolved.width
  const H = inp.resolved.height
  const u = Math.min(W, H) / 1080
  const minWH = Math.min(W, H)
  const bb = bounds(inp.loops)
  const bw = bb.x1 - bb.x0
  const bh = bb.y1 - bb.y0
  const mid: P2 = [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2]
  const hero: P2 = [inp.hero.x, inp.hero.y]
  const segs = layerSegs(inp.layers).map((sg) => ({ ...sg, t: Math.min(dist(sg.a, hero), dist(sg.b, hero)) }))
  const heroSize = Math.max(inp.heroSize, 0.02 * Math.max(bw, bh))
  const board = inp.board
  const ppm = inp.pxPerMm
  const px = (v: Vec2): P2 => {
    const q = inp.map(v)
    return [q.x, q.y]
  }
  const inBoard = (q: P2): boolean => q[0] >= bb.x0 && q[0] <= bb.x1 && q[1] >= bb.y0 && q[1] <= bb.y1
  const allPads = Object.values(board.copper).flatMap((c) => c.pads)
  const padsOf = new Map<string, typeof allPads>()
  for (const p of allPads) if (p.footprintRef !== undefined) padsOf.set(p.footprintRef, [...(padsOf.get(p.footprintRef) ?? []), p])
  const heroFp = board.footprints.find((f) => f.ref === inp.heroRef)
  const heroLabel = partNumber(heroFp?.value ?? inp.heroLabel)
  const thick = board.stackup.thickness * ppm
  const outlinePts: P2[] = inp.loops.flatMap((l) => {
    const out: P2[] = []
    for (let i = 0; i + 1 < l.length; i += 2) out.push([l[i] as number, l[i + 1] as number])
    return out
  })
  const bodies = inp.parts
  const drawnBodies = plotBodies(board, inp.back, px)
  const screen = ((): Body[] => {
    const used = new Set<object>()
    const posts = bodies.flatMap((b): Body[] => {
      const pb = drawnBodies.find((q) => Math.abs(q.x - b.x) < 1e-3 && Math.abs(q.y - b.y) < 1e-3)
      if (pb?.style !== 'header') return []
      const c = Math.cos(b.rot)
      const sn = Math.sin(b.rot)
      const own = (inp.pins ?? []).filter((q) => Math.abs(c * (q.x - b.x) + sn * (q.y - b.y)) <= b.w / 2 && Math.abs(-sn * (q.x - b.x) + c * (q.y - b.y)) <= b.h / 2)
      for (const q of own) used.add(q)
      return own.length > 0
        ? own.map((q) => ({ x: q.x, y: q.y, w: Math.max(q.w, q.h), h: Math.max(q.w, q.h), rot: 0, z: Math.max(q.z, (q.seat ?? b.z) + 0.3 * q.z), z0: q.seat ?? b.z, in: b }))
        : pb.pads.map((pd) => ({ x: pd[0], y: pd[1], w: 0.4 * Math.min(pd[2], pd[3]), h: 0.4 * Math.min(pd[2], pd[3]), rot: 0, z: 2.6 * b.z, z0: b.z, in: b }))
    })
    return [...bodies, ...posts, ...(inp.pins ?? []).filter((q) => !used.has(q))]
  })()
  const coverAlong = (from: number, to: number): number => Math.max(...Array.from({ length: 13 }, (_, i) => chipCover({ psi: from + (wrap(to - from) * i) / 12, e: CLOSE_E, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }, screen, 40)))
  const sparse = segs.length < 80

  const fallbackRef = inp.entry.length === 0 ? undefined
    : allPads.find((pd) => Math.hypot(pd.pos.x - (inp.entry[0] as Vec2).x, pd.pos.y - (inp.entry[0] as Vec2).y) < 0.01)?.footprintRef
  const entry = entryOf(board, fallbackRef)
  const comps = board.footprints.filter(isComponent)

  const roundFps = roundParts(board, padsOf)
  const round: Array<[number, number]> = roundFps.map((f) => px(f.circle?.center ?? f.pos))
  const heroPads = padsOf.get(inp.heroRef ?? '') ?? []
  const areas = heroPads.map((p) => p.size.x * p.size.y).sort((a, b) => a - b)
  const typical = areas[Math.floor(areas.length / 2)] ?? 0
  const pins = heroPads.filter((p) => p.size.x * p.size.y <= 3 * typical)
  const pin1Pad = pins.find((p) => p.num === '1' || p.num === 'A1')
  const pin1 = pin1Pad === undefined ? undefined : px(pin1Pad.pos)
  const nb = pin1Pad === undefined ? undefined : pins.filter((p) => p !== pin1Pad && Math.hypot(p.pos.x - pin1Pad.pos.x, p.pos.y - pin1Pad.pos.y) > 0.05)
    .sort((a, b) => Math.hypot(a.pos.x - pin1Pad.pos.x, a.pos.y - pin1Pad.pos.y) - Math.hypot(b.pos.x - pin1Pad.pos.x, b.pos.y - pin1Pad.pos.y))[0]
  const pitch = pin1Pad === undefined || nb === undefined ? undefined
    : { a: px(pin1Pad.pos), b: px(nb.pos), mm: Math.round(Math.hypot(nb.pos.x - pin1Pad.pos.x, nb.pos.y - pin1Pad.pos.y) * 100) / 100 }

  const tb = board.titleBlock
  const { name, revision: version } = boardTitle(board, inp.resolved)
  const facts0 = boardFacts(board)
  const o0 = inp.map({ x: 0, y: 0 })
  const o1 = inp.map({ x: 1, y: 0 })
  const turned = Math.abs(o1.y - o0.y) > Math.abs(o1.x - o0.x)
  const areaMm2 = (bw / ppm) * (bh / ppm)
  const sideOf = (n: string): number => (n.startsWith('F.') ? 0 : n.startsWith('B.') ? 2 : 1)
  const innerN = (n: string): number => Number(/\d+/.exec(n)?.[0] ?? 0)
  const names = [...new Set([...Object.keys(board.copper), ...board.layers.filter((l) => l.kind === 'copper').map((l) => l.name)])]
    .filter((n) => /\.Cu$/.test(n))
    .sort((a, b) => sideOf(a) - sideOf(b) || innerN(a) - innerN(b))
  if (inp.back) names.reverse()
  const stack = names.map((nm) => ({
    name: nm.toUpperCase(),
    role: layerRole(board, nm, areaMm2, innerN(nm)),
    layer: inp.layers.findIndex((l) => l.id === nm),
    zones: inp.zones.flatMap((z, i) => (z.layer === nm ? [i] : []))
  }))

  const fields: Array<[string, string]> = [
    ['DRAWING', name.toUpperCase()],
    ['SIDE', inp.back ? 'BOTTOM' : 'TOP']
  ]
  const fileTitle = tb?.title !== undefined && tb.title.toLowerCase() !== name.toLowerCase() ? tb.title : undefined
  const traceParts: TracePart[] = extractParts(board).filter((pt) => pt.back === inp.back).map((pt) => {
    const q = px(board.footprints.find((f) => f.ref === pt.ref)?.pos ?? pt.pos)
    return { x: q[0], y: q[1], w: pt.w * ppm, h: pt.h * ppm, rot: pt.rot, z: pt.z * ppm, kind: pt.kind, t: 0, settle: 0, hero: pt.ref === inp.heroRef }
  })
  const edgeMm = board.outline.flatMap((q) => q.points)
  const edge = { x0: Math.min(...edgeMm.map((q) => q.x)), x1: Math.max(...edgeMm.map((q) => q.x)), y0: Math.min(...edgeMm.map((q) => q.y)), y1: Math.max(...edgeMm.map((q) => q.y)) }
  const sides = new Map<string, number>()
  for (const c of Object.values(board.copper)) for (const q of c.pads) sides.set(q.id, (sides.get(q.id) ?? 0) + 1)
  const gold: Array<[number, number, number, number]> = board.footprints.filter((f) => f.models.length === 0).flatMap((f) => {
    const ps = (padsOf.get(f.ref) ?? []).filter((q) => sides.get(q.id) === 1)
    if (ps.length < 10 || ps.some((q) => Math.max(q.size.x, q.size.y) < 3 * Math.min(q.size.x, q.size.y))) return []
    const x0 = Math.min(...ps.map((q) => q.pos.x - q.size.x / 2))
    const x1 = Math.max(...ps.map((q) => q.pos.x + q.size.x / 2))
    const y0 = Math.min(...ps.map((q) => q.pos.y - q.size.y / 2))
    const y1 = Math.max(...ps.map((q) => q.pos.y + q.size.y / 2))
    if (Math.min(x0 - edge.x0, edge.x1 - x1, y0 - edge.y0, edge.y1 - y1) > 3) return []
    const a = px({ x: x0 - 0.3, y: y0 - 0.3 })
    const c = px({ x: x1 + 0.3, y: y1 + 0.3 })
    return [[Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])] as [number, number, number, number]]
  })
  const character = boardCharacter(traceParts, inp.loops, gold, inp.hero)
  const arch = character.archetype
  const planKind = plotPlanOf(arch, pairedRun(board), headerPins(board))
  const power = (planKind === 'card' || planKind === 'dense') && !signal
  const outlineLong = ((): boolean => {
    const xs = outlinePts.map((q) => q[0])
    const ys = outlinePts.map((q) => q[1])
    const a = Math.max(...xs) - Math.min(...xs)
    const b = Math.max(...ys) - Math.min(...ys)
    return Math.max(a, b) >= LONG_BOARD * Math.min(a, b)
  })()

  const su = sheetUnit(W, H)
  const inside = (q: P2, f: Footprint): boolean => {
    const pads = padsOf.get(f.ref) ?? []
    if (pads.length < 2) return false
    const r = Math.max(...pads.map((p) => 0.5 * Math.max(p.size.x, p.size.y))) * ppm + 1
    const ps = pads.map((p) => px(p.pos))
    const xs = ps.map((p) => p[0])
    const ys = ps.map((p) => p[1])
    return q[0] > Math.min(...xs) - r && q[0] < Math.max(...xs) + r && q[1] > Math.min(...ys) - r && q[1] < Math.max(...ys) + r
  }
  const labelled: Footprint[] = []
  const anchor = (f: Footprint): P2 | undefined => {
    const ps = padsOf.get(f.ref) ?? []
    if (ps.length === 0) return inBoard(px(f.pos)) ? px(f.pos) : undefined
    const cx = ps.reduce((t, p) => t + p.pos.x, 0) / ps.length
    const cy = ps.reduce((t, p) => t + p.pos.y, 0) / ps.length
    const order = [...ps].sort((a, b) => Math.hypot(a.pos.x - cx, a.pos.y - cy) - Math.hypot(b.pos.x - cx, b.pos.y - cy))
    for (const p of order) {
      const q = px(p.pos)
      if (inBoard(q) && !labelled.some((o) => o !== f && inside(q, o))) return q
    }
    return undefined
  }
  const topOf = (q: P2): number => {
    let z = 0
    for (const b of bodies) {
      const c = Math.cos(-b.rot)
      const s = Math.sin(-b.rot)
      const dx = q[0] - b.x
      const dy = q[1] - b.y
      if (Math.abs(c * dx - s * dy) <= b.w / 2 && Math.abs(s * dx + c * dy) <= b.h / 2) z = Math.max(z, b.z)
    }
    return z
  }
  const inBody = (b: Body, x: number, y: number): boolean => {
    const c = Math.cos(-b.rot)
    const sn = Math.sin(-b.rot)
    const dx = x - b.x
    const dy = y - b.y
    return Math.abs(c * dx - sn * dy) <= b.w / 2 && Math.abs(sn * dx + c * dy) <= b.h / 2
  }
  const bodyOf = (f: Footprint): number => {
    const q = px(f.pos)
    let best = -1
    bodies.forEach((b, i) => {
      const o = bodies[best]
      if (inBody(b, q[0], q[1]) && (o === undefined || dist([b.x, b.y], q) < dist([o.x, o.y], q))) best = i
    })
    return best
  }
  const tallestZ = Math.max(1, ...bodies.map((b) => b.z))
  const hidden = (v: PlotAxo, q: P2, z: number, own: number): boolean => {
    const k = Math.cos(v.e) / Math.max(1e-6, Math.sin(v.e))
    const step = tallestZ / 32
    for (let dz = step / 2; z + dz <= tallestZ; dz += step) {
      const x = q[0] + Math.sin(v.psi) * k * dz
      const y = q[1] + Math.cos(v.psi) * k * dz
      if (bodies.some((b, i) => i !== own && z + dz <= b.z && inBody(b, x, y))) return true
    }
    return false
  }
  const spots = (f: Footprint): Array<{ x: number; y: number; z: number }> => {
    const o = bodyOf(f)
    const b = bodies[o]
    if (b === undefined) {
      const ps = padsOf.get(f.ref) ?? []
      const cx = ps.reduce((t, p) => t + p.pos.x, 0) / Math.max(1, ps.length)
      const cy = ps.reduce((t, p) => t + p.pos.y, 0) / Math.max(1, ps.length)
      const at = anchor(f)
      const rest = [...ps].sort((a, c) => Math.hypot(a.pos.x - cx, a.pos.y - cy) - Math.hypot(c.pos.x - cx, c.pos.y - cy)).map((p) => px(p.pos)).filter(inBoard)
      return [...(at === undefined ? [] : [at]), ...rest].map((q) => ({ x: q[0], y: q[1], z: 0 }))
    }
    const steps = [0, -0.2, 0.2, -0.35, 0.35]
    return steps.flatMap((a) => steps.map((d) => [a, d] as P2)).sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1])).map(([a, d]) => {
      const lx = (a * b.w)
      const ly = (d * b.h)
      return { x: b.x + lx * Math.cos(b.rot) - ly * Math.sin(b.rot), y: b.y + lx * Math.sin(b.rot) + ly * Math.cos(b.rot), z: b.z }
    })
  }
  const silhouette = (v: PlotAxo, i: number): P2[] => {
    const b = bodies[i] as Body
    return convex(bodyCorners(b).flatMap((q) => [axoPoint(v, q, 0), axoPoint(v, q, b.z)]))
  }
  const cand: PlotMark[] = []
  const owner = new Map<PlotMark, Footprint>()
  const add = (f: Footprint, text: string, sub: string, accent = false): void => {
    labelled.push(f)
    const at = anchor(f)
    if (at === undefined) {
      labelled.pop()
      return
    }
    const mk = { x: at[0], y: at[1], z: topOf(at), text, sub, t: 0, ...(accent ? { accent } : {}) }
    owner.set(mk, f)
    cand.push(mk)
  }
  const socketPins = signalPins(padsOf.get(heroFp?.ref ?? '') ?? [])
  const triode = heroFp !== undefined && roundFps.includes(heroFp) && socketPins >= 7
  const socketKind = (heroFp?.descr ?? '').trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  const socketSub = `${heroFp?.ref ?? ''} · ${/^[A-Z]+$/.test(socketKind) ? socketKind : 'SOCKET'}`
  if (heroFp !== undefined) add(heroFp, triode ? partNumber(heroFp.value) || heroLabel : heroLabel, triode ? socketSub : heroFp.ref)
  const pp = entry === undefined ? undefined : powerPath(board, entry, inp.heroRef, inp.back ? 'B.Cu' : 'F.Cu', triode ? valveSupply(board, heroFp, entry) : 'VIN')
  if (entry !== undefined && power) add(entry, `POWER IN · ${entry.ref}`, '', true)
  const series = [...new Set((power ? pp?.steps ?? [] : []).flatMap((st) => (st.kind === 'link' && st.plane !== true && st.label !== undefined ? [st.label] : [])))]
  for (const text of series.slice(0, 2)) {
    const f = board.footprints.find((fp) => fp.ref === text.split(/[ →]/)[0])
    if (f !== undefined && f !== heroFp && f !== entry) add(f, text, '', true)
  }
  const lead = cand.length
  const tokens = `${tb?.title ?? ''} ${inp.resolved.title?.name ?? ''}`.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 3 && /\d/.test(t))
  const pinCount = (f: Footprint): number => (padsOf.get(f.ref) ?? []).length
  const second = comps.filter((f) => f.ref !== inp.heroRef && f !== entry && /^(U|IC)\d/i.test(f.ref)).sort((a, b) => pinCount(b) - pinCount(a))[0]
  const named = comps.find((f) => f.ref !== inp.heroRef && f !== entry && tokens.some((t) => (f.value ?? '').toUpperCase().includes(t))) ?? (second !== undefined && heroFp !== undefined && pinCount(second) >= 0.5 * pinCount(heroFp) ? second : undefined)
  if (named !== undefined) add(named, partNumber(named.value), named.ref)
  const isReg = (f: Footprint): boolean => /^(U|IC|VR|REG)\d/i.test(f.ref) && f.ref !== inp.heroRef && (REG.test(f.value ?? '') || /^\d+(\.\d+)?V\d*$/i.test(f.value ?? ''))
  for (const f of comps.filter(isReg)) add(f, `${f.ref} REGULATOR`, plain(partNumber(f.value) || f.value) ?? f.ref)
  const xtal = comps.find((f) => /^(Y|X)\d/i.test(f.ref) && CRYSTAL.test(f.value ?? ''))
  if (xtal !== undefined) add(xtal, `${xtal.ref} CRYSTAL`, frequency(xtal.value))
  const conns = comps.filter((f) => CONN.test(f.ref) && f.ref !== entry?.ref && f.ref !== inp.heroRef && f.padRefs.length >= 2 && !CRYSTAL.test(f.value ?? ''))
  for (const f of conns) {
    const kind = shortName(f.value)
    const count = COAX.has(kind) ? 'CONNECTOR' : ''
    const header = /pin_?header|pinsocket|pin_?socket/i.test(f.model ?? '')
    const value = plain(f.value)
    const terminal = TERMINAL.test(f.model ?? '')
    const role = triode ? valveSupply(board, heroFp, f) : 'VIN'
    if (terminal) add(f, `${f.ref} ${role === 'HEATER' ? 'HEATER IN' : role === 'HT SUPPLY' ? 'HT IN' : value === undefined || /^CONN/.test(value) ? 'TERMINAL' : value}`, 'TERMINAL')
    else if (header && !SHORT.some(([, k]) => k === kind)) add(f, `${f.ref} HEADER`, value === undefined || /^CONN|PIN/.test(value) ? count : value)
    else add(f, `${f.ref} ${kind}`.trim(), count)
  }
  for (const f of comps.filter((c) => /^U\d/i.test(c.ref) && c.ref !== inp.heroRef && !isReg(c))) add(f, partNumber(f.value), f.ref)
  const sizeOf = (m: PlotMark): number => {
    const f = owner.get(m)
    const b = f === undefined ? undefined : bodies[bodyOf(f)]
    if (b !== undefined) return b.w * b.h
    const ps = (f === undefined ? [] : padsOf.get(f.ref) ?? []).map((pd) => px(pd.pos))
    return ps.length === 0 ? 0 : (Math.max(...ps.map((q) => q[0])) - Math.min(...ps.map((q) => q[0]))) * (Math.max(...ps.map((q) => q[1])) - Math.min(...ps.map((q) => q[1])))
  }
  const mm2 = (m: PlotMark): number => Math.round(sizeOf(m) / (ppm * ppm))
  const ox = outlinePts.map((q) => q[0])
  const oy = outlinePts.map((q) => q[1])
  const ow = Math.max(...ox) - Math.min(...ox)
  const oh = Math.max(...oy) - Math.min(...oy)
  const longUp = H / W >= 1.15 && Math.max(ow, oh) > LONG_BOARD * Math.min(ow, oh)
  const hull = [...convex(outlinePts).flatMap((q) => [q[0], q[1], 0, q[0], q[1], -thick]), ...bodies.flatMap((b) => bodyCorners(b).flatMap((q) => [q[0], q[1], b.z]))]
  const longUpright = (psi: number, e: number): boolean => {
    const r = hullBox({ psi, e, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }, hull)
    return r.h >= r.w
  }
  const flatPsi = fitAxo({ x: 0, y: 0, w: 1.6, h: 1 }, outlinePts, thick, bodies, mid, undefined, face).psi
  const fitIn = (box: PlotRect): PlotAxo => {
    if (!longUp && box.h < 1.15 * box.w) return fitAxo(box, outlinePts, thick, bodies, mid, flatPsi)
    const psis = Array.from({ length: 13 }, (_, i) => face * (-45 + 7.5 * i) * D)
    const tallness = (p: number): number => {
      const r = hullBox({ psi: p, e: ISO_E, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }, hull)
      return r.h / r.w
    }
    const up = longUp ? psis.filter((p) => longUpright(p, ISO_E)) : psis
    return (up.length > 0 ? up : [psis.reduce((b, p) => (tallness(p) > tallness(b) ? p : b))]).map((p) => fitAxo(box, outlinePts, thick, bodies, mid, p)).reduce((b, v) => (v.k > b.k ? v : b))
  }
  const word = Math.max(0, ...comps.filter(isConn).map((f) => f.ref.length + 1))
  const lay = (H / W >= 1.5 && planKind !== 'valve' ? [false, true].map((l) => layoutSheet(W, H, name, SAID_CHARS, false, l, word)) : [layoutSheet(W, H, name, SAID_CHARS, planKind === 'valve', outlineLong, word)])
    .map((l) => ({ l, k: fitIn(heroArea(l.rects.hero, W, H)).k }))
    .reduce((b, c) => (c.k > b.k ? c : b)).l
  const R = lay.rects
  const heroBox = heroArea(R.hero, W, H)
  const isoPsi = fitIn(heroBox).psi
  const unitIso: PlotAxo = { psi: isoPsi, e: ISO_E, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }
  const seenOnIso = (m: PlotMark): boolean => {
    const f = owner.get(m)
    return f === undefined || spots(f).some((q) => !hidden(unitIso, [q.x, q.y], q.z, bodyOf(f)))
  }
  const others = cand.slice(lead).filter((m, i, all) => all.findIndex((o) => o.text === m.text) === i && seenOnIso(m)).sort((x, y) => mm2(y) - mm2(x) || x.text.localeCompare(y.text, 'en', { numeric: true }))
  cand.splice(lead, cand.length - lead, ...(power ? others.slice(0, SHEET_CALLOUTS - lead) : []))
  const ha = heroBox
  const heads: PlotRect[] = [lay.title]
  const heroFrameBox = { x0: ha.x, y0: ha.y, x1: ha.x + ha.w, y1: ha.y + ha.h }
  const leadersThrough = (v: PlotAxo, rects: Array<PlotRect | undefined>): number => rects.filter((r, i) => {
    const m = cand[i]
    if (r === undefined || m === undefined) return false
    const a = axoPoint(v, [m.x, m.y], m.z ?? 0)
    const end: P2 = [clamp(a[0], r.x, r.x + r.w), clamp(a[1], r.y, r.y + r.h)]
    const own = owner.get(m)
    return cand.some((o, j) => {
      const f = owner.get(o)
      const b = f === undefined ? -1 : bodyOf(f)
      return j !== i && b >= 0 && b !== (own === undefined ? -1 : bodyOf(own)) && segmentHits(a, end, convex(bodyCorners(bodies[b] as Body).flatMap((q) => [axoPoint(v, q, 0), axoPoint(v, q, (bodies[b] as Body).z)])))
    })
  }).length
  for (const c of cand) {
    const f = owner.get(c)
    if (f === undefined) continue
    const own = bodyOf(f)
    const all = spots(f)
    const at = all.find((q) => !hidden(unitIso, [q.x, q.y], q.z, own)) ?? all[0]
    if (at === undefined) continue
    c.x = at.x
    c.y = at.y
    c.z = own < 0 ? topOf([at.x, at.y]) : at.z
  }
  const ringFit = (): { v: PlotAxo; plan: PlotCallout[] } => {
    const m = 0.02 * Math.min(ha.w, ha.h)
    const t = lay.title
    const below = { x: ha.x, y: t.y + t.h, w: ha.w, h: ha.y + ha.h - t.y - t.h }
    const beside = { x: t.x + t.w, y: ha.y, w: ha.x + ha.w - t.x - t.w, h: ha.h }
    const boxFit = (r: PlotRect): PlotAxo => fitAxo({ x: r.x + 0.02 * r.w, y: r.y + 0.02 * r.h, w: 0.96 * r.w, h: 0.96 * r.h }, outlinePts, thick, bodies, mid, isoPsi)
    const whole = boxFit(ha)
    const wb = hullBox(whole, hull)
    const corner = [1, 0.95, 0.9, 0.85, 0.8, 0.76, 0.73].map((kk): PlotAxo => ({ ...whole, k: whole.k * kk, x: ha.x + 0.98 * ha.w - (wb.x + wb.w - whole.x) * kk, y: ha.y + 0.98 * ha.h - (wb.y + wb.h - whole.y) * kk }))
      .find((v) => !rectHits(t, convex(convex(outlinePts).flatMap((q) => [axoPoint(v, q, 0), axoPoint(v, q, -thick)]))))
    const apart = t.x >= ha.x + ha.w || t.y >= ha.y + ha.h
    const v0 = apart ? whole : [boxFit(below), boxFit(beside), ...(corner !== undefined ? [corner] : [])].reduce((a, b) => (b.k > a.k ? b : a))
    const cx = v0.x
    const cy = v0.y
    const viewAt = (k: number, sx = 0, sy = 0): PlotAxo => ({ ...v0, k: v0.k * k, x: cx + (v0.x - cx) * k + 0.45 * sx * (1 - 0.96 * k) * ha.w, y: cy + (v0.y - cy) * k + 0.45 * sy * (1 - 0.96 * k) * ha.h })
    const slots = (z: { w: number; h: number }): PlotRect[] => {
      const x0 = ha.x + m
      const x1 = ha.x + ha.w - m - z.w
      const y0 = ha.y + m
      const y1 = ha.y + ha.h - m - z.h
      const steps = (a: number, b: number): number[] => Array.from({ length: 7 }, (_, i) => a + ((b - a) * i) / 6)
      return [...steps(x0, x1).flatMap((x) => [y0, y1].map((y) => ({ x, y, w: z.w, h: z.h }))), ...steps(y0, y1).slice(1, -1).flatMap((y) => [x0, x1].map((x) => ({ x, y, w: z.w, h: z.h })))]
    }
    const overlap = (a: PlotRect, c: PlotRect): boolean => a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h
    const tryFit = (list: number[], v: PlotAxo): PlotCallout[] | undefined => {
      const polys = [convex(convex(outlinePts).flatMap((q) => [axoPoint(v, q, 0), axoPoint(v, q, -thick)])), ...bodies.map((b) => convex(bodyCorners(b).flatMap((q) => [axoPoint(v, q, 0), axoPoint(v, q, b.z)])))]
      const hits = (r: PlotRect): boolean => polys.some((poly) => rectHits(r, poly))
      const pad = 10 * su
      const sz = list.map((i) => calloutSize((cand[i] as PlotMark).text, (cand[i] as PlotMark).sub, su, SHEET_TEXT, SHEET_SUB))
      const at = list.map((i) => axoPoint(v, [(cand[i] as PlotMark).x, (cand[i] as PlotMark).y], (cand[i] as PlotMark).z ?? 0))
      if (heads.some(hits)) return undefined
      const options = list.map((_, j) => slots(sz[j] as { w: number; h: number }).map((r, i) => ({ r, i })).filter(({ r }) => !hits({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }) && !heads.some((q) => overlap(q, r))))
      const end = (j: number, r: PlotRect): [P2, P2] => {
        const a = at[j] as P2
        return [a, [clamp(a[0], r.x, r.x + r.w), clamp(a[1], r.y, r.y + r.h)]]
      }
      let best: { cost: number; rects: PlotRect[] } | undefined
      const pick: PlotRect[] = []
      const walk = (j: number, cost: number): void => {
        if (best !== undefined && cost >= best.cost) return
        if (j === list.length) {
          const full: Array<PlotRect | undefined> = cand.map(() => undefined)
          list.forEach((i, n) => { full[i] = pick[n] })
          if (leadersThrough(v, full) === 0) best = { cost, rects: [...pick] }
          return
        }
        for (const { r } of options[j] ?? []) {
          if (pick.some((q) => overlap(q, r))) continue
          const l = end(j, r)
          if (pick.some((q, n) => segmentsCross(end(n, q), l))) continue
          pick.push(r)
          walk(j + 1, cost + Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]))
          pick.pop()
        }
      }
      walk(0, 0)
      return best?.rects.map((r, n) => ({ item: list[n] as number, side: r.y + r.h / 2 < cy ? 0 : 2, row: 0, order: r.x + r.w / 2 < cx ? 0 : 1, rect: r }))
    }
    const roomy = (v: PlotAxo): boolean => {
      const b = hullBox(v, hull)
      return Math.max(b.w / R.hero.w, b.h / R.hero.h) >= 0.7
    }
    for (let n = cand.length; n > 2; n--) {
      for (const k of [1, 0.96, 0.92, 0.88, 0.84, 0.8]) {
        for (const [sx, sy] of SHIFTS) {
          const v = viewAt(k, sx, sy)
          if (!roomy(v)) continue
          const plan = tryFit(Array.from({ length: n }, (_, i) => i), v)
          if (plan !== undefined) {
            cand.splice(n)
            return { v, plan }
          }
        }
      }
    }
    for (const k of [1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72]) {
      for (let n = Math.min(2, cand.length); n >= 1; n--) {
        for (const [sx, sy] of SHIFTS) {
          const v = viewAt(k, sx, sy)
          if (!roomy(v)) continue
          const plan = tryFit(Array.from({ length: n }, (_, i) => i), v)
          if (plan !== undefined) {
            cand.splice(n)
            return { v, plan }
          }
        }
      }
    }
    cand.splice(1)
    return { v: viewAt(0.8), plan: tryFit([0], viewAt(0.8)) ?? [] }
  }
  const fit = ringFit()
  const mark = version !== undefined ? `REV ${version.replace(/^rev\.?\s*/i, '').toUpperCase()}` : tb?.date
  const stampK = 1.5 * SHEET_TEXT * su
  const struck = mark === undefined ? { w: 0, h: 0 } : stampBox(mark, stampK)
  const besideSet = nameSet(name, W, H, W - 0.16 * Math.min(W, H) - (struck.w > 0 ? struck.w + 0.1 * Math.min(W, H) : 0))
  const under = struck.w > 0 && (besideSet.w < nameFloor(W, H) * W || besideSet.size < stampK)
  const lettersOf = under ? nameSet(name, W, H, W - 0.16 * Math.min(W, H)) : besideSet
  const stampRise = under ? struck.h + 0.4 * lettersOf.size : 0
  const nameEdge = Math.max(0.055 * Math.min(W, H), 0.52 * CAP * lettersOf.size)
  const closeUp = ((): { v: PlotAxo; x: number; moved: boolean } => {
    const turns = [0, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI / 4, -Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4].map((d) => face * d).map((d) => ({ psi: fit.v.psi + d, cover: chipCover({ psi: fit.v.psi + d, e: CLOSE_E, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }, [...inp.parts, ...(inp.pins ?? [])]) }))
    const chip = inp.parts.find((q) => q.hero === true)
    const reads = (psi: number): boolean => read === undefined || chip === undefined || Math.abs(screenAngle({ psi, e: CLOSE_E, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }, [read[0] * Math.cos(chip.rot) - read[1] * Math.sin(chip.rot), read[0] * Math.sin(chip.rot) + read[1] * Math.cos(chip.rot)])) <= Math.PI / 2
    const legible = turns.filter((q) => reads(q.psi))
    const pool = legible.length > 0 ? legible : turns
    const first = pool.find((q) => q.cover === 0) ?? pool.reduce((a, b) => (b.cover < a.cover ? b : a))
    const seen = (q: { psi: number; cover: number }): boolean => coverAlong(longUp ? q.psi : flatPsi, q.psi) <= CHIP_HIDE
    const open = !avoid || seen(first) ? first : pool.find((q) => q.cover === 0 && seen(q)) ?? first
    const fine = (e: number): number => chipCover({ psi: open.psi, e, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }, [...inp.parts, ...(inp.pins ?? [])], 40)
    const steep = fine(CLOSE_E) > CHIP_HIDE + POSTER_SLACK ? POSTER_E.find((e) => fine(e) === 0) ?? POSTER_E.find((e) => fine(e) <= CHIP_HIDE) : undefined
    const unit: PlotAxo = { psi: open.psi, e: steep ?? CLOSE_E, k: 1, x: 0, y: 0, mx: mid[0], my: mid[1] }
    const ub = hullBox(unit, hull)
    const whole = Math.min(W / ub.w, H / ub.h)
    const edge = nameEdge
    const gap = 0.5 * lettersOf.size
    const clear = under ? Math.max(lettersOf.w, struck.w) : lettersOf.w + (struck.w > 0 ? gap + struck.w : 0)
    const top = H - edge - (under ? lettersOf.h + stampRise : Math.max(lettersOf.h, struck.h)) - 0.3 * lettersOf.size
    const hp = axoPoint(unit, hero, 0)
    const tall = Math.max(0, ...bodies.filter((b) => b.hero === true).map((b) => b.z))
    let best: { v: PlotAxo; x: number; score: number } | undefined
    for (const over of CLOSE_OVER) {
      for (const right of [false, true]) {
        const x = right ? W - edge - clear : edge
        const keep: PlotRect = { x: x - 0.3 * lettersOf.size, y: top, w: clear + 0.6 * lettersOf.size, h: H - top }
        for (const hx of [0.42, 0.5, 0.58, 0.66, 0.74]) {
          for (const hy of [0.18, 0.24, 0.3, 0.36, 0.42, 0.48]) {
            const k = whole * over
            const tx = (right ? 1 - hx : hx) * W
            const v: PlotAxo = { ...unit, k, x: tx - k * hp[0], y: hy * H - k * hp[1] }
            const poly = convex(Array.from({ length: hull.length / 3 }, (_, i) => axoPoint(v, [hull[3 * i] as number, hull[3 * i + 1] as number], hull[3 * i + 2] as number)))
            if (rectHits(keep, poly) || axoPoint(v, hero, tall)[1] < edge) continue
            const b = hullBox(v, hull)
            const seen = (Math.max(0, Math.min(W, b.x + b.w) - Math.max(0, b.x)) * Math.max(0, Math.min(H, b.y + b.h) - Math.max(0, b.y))) / (W * H)
            const score = seen - 0.2 * Math.hypot(hx - 0.58, hy - 0.4)
            if (best === undefined || score > best.score) best = { v, x, score }
          }
        }
      }
      if (best !== undefined) break
    }
    return { ...(best ?? { v: { ...fit.v, e: CLOSE_E }, x: edge }), moved: open !== first }
  })()
  const iso = closeUp.v
  const stampAt: [number, number] = under ? [closeUp.x + struck.w / 2, H - nameEdge + 0.5 * CAP * lettersOf.size - struck.h / 2] : [closeUp.x + lettersOf.w + 0.5 * lettersOf.size + struck.w / 2, H - nameEdge - Math.max(CAP * lettersOf.size, struck.h) / 2]
  const nameAt = { lines: lettersOf.lines, x: closeUp.x, y: H - nameEdge - stampRise - 1.2 * (lettersOf.lines.length - 1) * lettersOf.size, size: lettersOf.size, stamp: stampAt, stampSize: stampK }
  const ridePsi = longUp ? iso.psi : flatPsi
  const rideScale = fitAxo(heroBox, outlinePts, thick, bodies, mid, ridePsi).k / fitAxo(heroBox, outlinePts, thick, bodies, mid, iso.psi).k
  const rideIso: PlotAxo = { ...iso, e: CLOSE_E, k: iso.k * rideScale }
  const features: PlotMark[] = [...cand]

  let Dm = 0
  const planFit = (rotated: boolean): { pa: PlotRect; ps: number; dx: number; fill: number } => {
    const pa = panelArea(R.plan, W, H, titleLines(planKind === 'header' ? 'PLAN' : PATH_PANEL, rotated !== turned ? ['TURNED 90°'] : [], R.plan.w, W, H).length)
    Dm = planDims(pa, su) ? 1.5 * SHEET_SUB * su : 0
    const pw = rotated ? bh : bw
    const ph = rotated ? bw : bh
    const ps = Math.min((pa.w - Dm) / pw, (pa.h - Dm) / ph)
    return { pa, ps, dx: Dm, fill: Math.max((ps * pw) / pa.w, (ps * ph) / pa.h) }
  }
  const [lying, upright] = [planFit(false), planFit(true)]
  const turnPlan = upright.ps > 1.05 * lying.ps
  const planR = turnPlan ? Math.PI / 2 : 0
  const { pa, ps, dx: planDx } = planFit(turnPlan)
  const pc: P2 = [pa.x + planDx + (pa.w - planDx) / 2, pa.y + Dm + (pa.h - Dm) / 2]
  const rm = rot(mid, planR)
  const planAt: PlotPlace = { s: ps, r: planR, x: pc[0] - ps * rm[0], y: pc[1] - ps * rm[1] }

  const pinMid = { x: pins.reduce((t, pd) => t + pd.pos.x, 0) / Math.max(1, pins.length), y: pins.reduce((t, pd) => t + pd.pos.y, 0) / Math.max(1, pins.length) }
  const circleMm = 2 * Math.max(0, ...pins.map((pd) => Math.hypot(pd.pos.x - pinMid.x, pd.pos.y - pinMid.y)))
  const detailSubject = triode ? `${socketPins} PINS ON Ø${circleMm.toFixed(1)} MM` : pitch === undefined ? undefined : `PITCH ${pitch.mm.toFixed(2)} MM`
  const dr = R.detail ?? R.plan
  const da = panelArea(dr, W, H, titleLines('DETAIL A', ['20×', ...detailNotes(detailSubject, dr.w, W, H)], dr.w, W, H).length)
  const detailR = 0.46 * Math.min(da.w, da.h)
  const pitchPx = pitch === undefined ? 0 : dist(pitch.a, pitch.b)
  let focus: P2 = pin1 === undefined ? hero : [hero[0] + 1.05 * (pin1[0] - hero[0]), hero[1] + 1.05 * (pin1[1] - hero[1])]
  let reach = pin1 === undefined ? 0.75 * heroSize : Math.max(6 * pitchPx, 0.22 * heroSize)
  const copperNear = segs.filter((s) => dist(segMid(s), focus) < reach).length
  if (copperNear < 6) {
    const rad = 0.08 * Math.max(bw, bh)
    const pts = allPads.map((p) => px(p.pos))
    const dense = pts.map((p) => ({ p, n: pts.filter((q) => dist(p, q) < rad).length })).sort((a, b) => b.n - a.n)[0]
    if (dense !== undefined) {
      const ring = pts.filter((q) => dist(dense.p, q) < rad)
      focus = [ring.reduce((t, q) => t + q[0], 0) / ring.length, ring.reduce((t, q) => t + q[1], 0) / ring.length]
      reach = rad
    }
  }
  const dk = NICE.filter((n) => n <= ((0.7 * Math.max(bw, bh)) / reach) * (1 + 1e-6)).pop() ?? 1.5
  const dHero = rot(focus, planR)
  const detailAt: PlotPlace = { s: dk * ps, r: planR, x: da.x + da.w / 2 - dk * ps * dHero[0], y: da.y + da.h / 2 - dk * ps * dHero[1] }

  const elevationAt = ((): PlotPlace & { v: number } => {
    const er = R.elevation
    if (er === undefined) return { s: 0, v: 1, x: 0, y: 0 }
    const ea = panelArea(er, W, H, titleLines('ELEVATION', elevationNotes(facts0.thicknessMm, 2.5, er.w, W, H), er.w, W, H).length)
    const along = Math.max(bw, bh)
    const prof = Math.max(1, Math.max(0, ...bodies.map((b) => b.z)) + thick)
    const vk = Math.min(25, VERT.find((k) => k * prof >= 0.45 * along * (1 - 1e-6)) ?? 25)
    const es = Math.min((0.92 * ea.w) / along, (0.85 * ea.h) / (prof * vk))
    return { s: es, v: vk, x: ea.x + ea.w / 2 - es * (bh > bw ? mid[1] : mid[0]), y: ea.y + 0.07 * ea.h + (prof - thick) * es * vk }
  })()

  const allVias = Object.values(board.copper).flatMap((c) => c.vias)
  const nameOf = new Map(board.nets.map((n) => [n.id, n.name]))
  const cell = Math.sqrt((bw * bh) / 10)
  const seen = new Set<string>()
  const powerVias = allVias.filter((v) => netKind(nameOf.get(v.netId ?? -1) ?? '') === 'power').map((v) => px(v.pos)).filter((q) => {
    const k = `${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, 9)
  const heroVias = allVias.map((v) => px(v.pos)).filter((q) => dist(q, hero) < 0.8 * heroSize).slice(0, 6)
  const vias = [...powerVias, ...heroVias].flat()

  const stepLen = (pp?.steps ?? []).map((st) => Math.hypot(st.b.x - st.a.x, st.b.y - st.a.y))
  const cum = stepLen.reduce<number[]>((acc, l) => [...acc, (acc.at(-1) ?? 0) + l], [])
  const pathMm = cum.at(-1) ?? 0
  const stops: Array<{ text: string; p: Vec2; at: number }> = []
  if (pp !== undefined && entry !== undefined) {
    stops.push({ text: `POWER IN · ${entry.ref}`, p: (pp.steps[0] as PathStep).a, at: 0 })
    pp.steps.forEach((st, i) => {
      if (st.kind !== 'link' || st.label === undefined || stops.some((o) => o.text === st.label)) return
      stops.push({ text: st.label, p: { x: (st.a.x + st.b.x) / 2, y: (st.a.y + st.b.y) / 2 }, at: (cum[i] as number) - 0.5 * (stepLen[i] as number) })
    })
    const last = pp.steps[pp.steps.length - 1] as PathStep
    const tail = [...pp.steps].reverse().find((st) => st.label !== undefined && / PIN /.test(st.label))
    stops.push({ text: tail?.label ?? `${inp.heroRef ?? 'HERO'} SUPPLY`, p: last.b, at: pathMm })
  }
  const kept = stops.length <= 6 ? stops : [stops[0], ...[1, 2, 3, 4].map((k) => stops[Math.round((k * (stops.length - 1)) / 5)]), stops[stops.length - 1]].filter((q): q is (typeof stops)[number] => q !== undefined)
  const { shots: plan, beats } = filmPlan(planKind, power ? kept.length : 0, stack.length, inp.parts.length)
  const shotOf = (k: PlotShotKind): { b0: number; b1: number } | undefined => plan.find((q) => q.kind === k)
  const spanOf = (k: PlotShotKind, or: number): [number, number] => {
    const q = shotOf(k)
    return q === undefined ? [or, or] : [q.b0, q.b1]
  }
  const [nb0, nb1] = spanOf('open', 0)
  const [ou0, ou1] = spanOf('outline', 0)
  const [bu0, bu1] = planKind === 'pair' ? spanOf('signature', 0) : spanOf('macro', ou0)
  const [sg0, sg1] = spanOf('signature', 0)
  const ob0 = beats.tilt[0]
  const sh0 = beats.pull[0] + 0.5
  const ob1 = sh0
  const TA = beats.parts + 0.5
  const TS = Math.max(1, sh0 - TA)
  const strip = stripHeight(W, H) + 0.03 * Math.min(W, H)
  const portrait = H > 1.15 * W
  const ride = (from: P2, to: P2, across: number): { from: P2; to: P2; zoom: number; yaw: number } => {
    const d: P2 = [to[0] - from[0], to[1] - from[1]]
    const dl = Math.hypot(d[0], d[1]) || 1
    const yaw = wrap((portrait ? Math.PI / 2 : 0) - Math.atan2(d[1], d[0]))
    const zoom = portrait ? (0.78 * W) / across : (0.7 * (H - strip)) / across
    const half = (0.5 * (portrait ? H - strip : W)) / zoom
    const k = Math.min(0.46, half / dl)
    return { from: [from[0] + d[0] * k, from[1] + d[1] * k], to: [to[0] - d[0] * k, to[1] - d[1] * k], zoom, yaw }
  }
  const alongX = bw >= bh
  const axisEnds = (o: P2): [P2, P2] => {
    const a: P2 = alongX ? [bb.x0, mid[1]] : [mid[0], bb.y0]
    const b: P2 = alongX ? [bb.x1, mid[1]] : [mid[0], bb.y1]
    return dist(o, a) <= dist(o, b) ? [a, b] : [b, a]
  }
  const supplyNet = new Set((pp?.pins ?? []).map((q) => `${Math.round(q.x * 100)},${Math.round(q.y * 100)}`))
  const onSupply = (pd: Pad): boolean => supplyNet.has(`${Math.round(pd.pos.x * 100)},${Math.round(pd.pos.y * 100)}`) || netKind(nameOf.get(pd.netId ?? -1) ?? '') === 'power'
  const byNum = (a: Pad, b: Pad): number => (a.num ?? '').localeCompare(b.num ?? '', 'en', { numeric: true })
  const sigData = ((): PlotSigData => {
    if (arch === 'valve') {
      const body = bodies.find((q) => q.hero === true)
      return { kind: 'section', heightMm: (body?.z ?? 20 * ppm) / ppm, diaMm: Math.min(body?.w ?? 20 * ppm, body?.h ?? 20 * ppm) / ppm, pins: socketPins, boardMm: board.stackup.thickness, supply: kept[0]?.text.replace(/^POWER IN · /, '') ?? '' }
    }
    if (arch === 'stick') {
      const [a, b] = axisEnds(entry !== undefined ? px(entry.pos) : [character.opening.x, character.opening.y])
      const len = dist(a, b)
      const dir: P2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
      const proj = (q: P2): number => (q[0] - a[0]) * dir[0] + (q[1] - a[1]) * dir[1]
      const feats = [...comps.filter((f) => CONN.test(f.ref) && f.layer.startsWith(inp.back ? 'B' : 'F')).map((f) => proj(px(f.pos))), proj(hero), len].filter((t) => t > 0.04 * len && t <= len + 1e-6).sort((x, y) => x - y)
      const marks = feats.filter((t, i) => i === 0 || t - (feats[i - 1] as number) > 0.08 * len).map((t) => ({ at: t, mm: Math.round((t / ppm) * 10) / 10 }))
      const r = ride(a, b, ((alongX ? bh : bw) * 0.78) / 0.62)
      const nrm: P2 = [-dir[1], dir[0]]
      const off = (0.13 * (portrait ? W : H - strip)) / r.zoom
      return { kind: 'travel', ...r, from: [r.from[0] + nrm[0] * off, r.from[1] + nrm[1] * off], to: [r.to[0] + nrm[0] * off, r.to[1] + nrm[1] * off], lengthMm: Math.round((len / ppm) * 10) / 10, datum: a, dir, half: (alongX ? bh : bw) / 2, marks }
    }
    if (arch === 'card') {
      const g = gold.reduce((x, y) => ((y[2] - y[0]) * (y[3] - y[1]) > (x[2] - x[0]) * (x[3] - x[1]) ? y : x), gold[0] ?? [bb.x0, bb.y0, bb.x1, bb.y1])
      const fp = board.footprints.find((f) => (padsOf.get(f.ref) ?? []).length >= 10 && (padsOf.get(f.ref) ?? []).every((q) => { const c = px(q.pos); return c[0] >= g[0] - 1 && c[0] <= g[2] + 1 && c[1] >= g[1] - 1 && c[1] <= g[3] + 1 }))
      const ps = [...(padsOf.get(fp?.ref ?? '') ?? [])].sort((x, y) => (Math.abs(g[2] - g[0]) > Math.abs(g[3] - g[1]) ? x.pos.x - y.pos.x : x.pos.y - y.pos.y))
      const pitchMm = ps.length > 1 ? Math.round(Math.hypot((ps[1] as Pad).pos.x - (ps[0] as Pad).pos.x, (ps[1] as Pad).pos.y - (ps[0] as Pad).pos.y) * 100) / 100 : 0
      const centre: P2 = [(g[0] + g[2]) / 2, (g[1] + g[3]) / 2]
      const [a, b] = axisEnds(centre)
      return { kind: 'fingers', pads: ps.map((q) => { const c = px(q.pos); return [c[0], c[1], q.size.x * ppm, q.size.y * ppm] as [number, number, number, number] }), pitchMm, supply: ps.findIndex(onSupply), ...ride(a, b, alongX ? bh : bw) }
    }
    if (planKind === 'header') {
      const header = comps.filter((f) => CONN.test(f.ref)).map((f) => ({ f, pads: [...(padsOf.get(f.ref) ?? [])].sort(byNum).filter((q, i, all) => all.findIndex((o) => o.num === q.num) === i) })).sort((x, y) => y.pads.length - x.pads.length || x.f.ref.localeCompare(y.f.ref, 'en', { numeric: true }))[0]
      const ps = header?.pads ?? []
      const near = ps.map((q) => Math.min(...ps.filter((o) => o !== q).map((o) => Math.hypot(o.pos.x - q.pos.x, o.pos.y - q.pos.y))))
      const pitchMm = Math.round((near.sort((a, b) => a - b)[Math.floor(near.length / 2)] ?? 2.54) * 100) / 100
      const a = ((header?.f.rot ?? 0) * Math.PI) / 180
      const across = ps.map((q) => Math.round((-Math.sin(a) * q.pos.x + Math.cos(a) * q.pos.y) / (0.5 * pitchMm)))
      const lines = Math.max(1, new Set(across).size)
      return {
        kind: 'header', ref: header?.f.ref ?? '', value: (header?.f.value ?? '').toUpperCase(), pitchMm, lines, male: /PinHeader|Pin_Header/i.test(header?.f.model ?? ''), rot: a,
        pads: ps.map((q) => { const c = px(q.pos); return [c[0], c[1], q.size.x * ppm, q.size.y * ppm] as [number, number, number, number] }),
        rows: ps.map((q) => { const net = nameOf.get(q.netId ?? -1) ?? ''; return { num: q.num ?? '', net: /^(Net-\(|unconnected)/i.test(net) || net.length === 0 ? '—' : bareName(net).toUpperCase().slice(0, 12), supply: onSupply(q) } })
      }
    }
    if (planKind === 'pair') return { kind: 'pair', lengthsMm: [0, 0] }
    const pinPaths = pins.map((pd) => {
      const at = px(pd.pos)
      const reachPx = 0.6 * Math.max(pd.size.x, pd.size.y) * ppm
      const first = segs.find((sg) => dist(sg.a, at) <= reachPx || dist(sg.b, at) <= reachPx)
      if (first === undefined) return { at, path: [] as number[], supply: onSupply(pd) }
      const far = dist(first.a, at) <= dist(first.b, at) ? first.b : first.a
      const next = segs.find((sg) => sg !== first && (dist(sg.a, far) < 0.05 * ppm || dist(sg.b, far) < 0.05 * ppm))
      const tail = next === undefined ? [] : [...(dist(next.a, far) < dist(next.b, far) ? next.b : next.a)]
      return { at, path: [...at, ...far, ...tail], supply: onSupply(pd) }
    }).filter((q) => q.path.length >= 4)
    const a0 = pin1 === undefined ? 0 : Math.atan2(pin1[1] - hero[1], pin1[0] - hero[0])
    const ang = (q: P2): number => (Math.atan2(q[1] - hero[1], q[0] - hero[0]) - a0 + 4 * Math.PI) % (2 * Math.PI)
    return { kind: 'escape', centre: hero, pins: pinPaths.sort((x, y) => ang(x.at) - ang(y.at)), pitchMm: pitch?.mm ?? 0, zoom: (0.62 * Math.min(W, H - strip)) / Math.max(1, 2.2 * heroSize) }
  })()
  const carriers = plan.filter((q) => q.kind !== 'open' && q.b1 <= (shotOf('detail')?.b0 ?? 14))
  const detail = shotOf('detail') ?? { b0: beats.push[0], b1: beats.pull[0] }
  const stations: PlotStation[] = (power ? kept : []).map((q, i) => {
    const last = i === kept.length - 1
    const c = carriers[Math.min(carriers.length - 1, Math.floor((i * carriers.length) / Math.max(1, kept.length - 1)))]
    const beat = last ? detail.b0 + 0.6 * (detail.b1 - detail.b0) : (c?.b0 ?? 2) + Math.min(0.5, 0.4 * ((c?.b1 ?? 3) - (c?.b0 ?? 2)))
    const at = px(q.p)
    return { text: q.text, x: at[0], y: at[1], at: q.at, t: beat * B }
  })

  const near = segs.filter((s) => {
    const d = dist(segMid(s), hero)
    return d > 0.5 * heroSize && d < 3 * heroSize
  })
  let dx = near.reduce((t, q) => t + segMid(q)[0] - hero[0], 0)
  let dy = near.reduce((t, q) => t + segMid(q)[1] - hero[1], 0)
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = mid[0] - hero[0] || 1
    dy = mid[1] - hero[1]
  }
  const dl = Math.hypot(dx, dy)
  const yaw1 = planKind === 'stick' ? 0 : -12 * D
  const inView = (q: P2, look: P2, z: number, yaw: number, k = 0.95): boolean => {
    const v = rot([q[0] - look[0], q[1] - look[1]], yaw)
    return Math.abs(v[0]) * z < 0.5 * W * k && Math.abs(v[1]) * z < 0.5 * H * k
  }
  const heroRing = bodies.find((b) => b.hero === true)
  const lookAt = (z: number): P2 => (sparse ? hero : [hero[0] + (dx / dl) * (0.1 * minWH) / z, hero[1] + (dy / dl) * (0.1 * minWH) / z])
  let z1 = sparse ? clamp((0.24 * minWH) / heroSize, 1, 8) : clamp((0.3 * minWH) / heroSize, 1.8, 8)
  while (z1 > 1 && heroRing !== undefined && !bodyCorners(heroRing).every((q) => inView(q, lookAt(z1), z1 * 1.05, yaw1, 0.86))) z1 *= 0.95
  let look1 = lookAt(z1)
  const opening = ((): { focus: P2; span: [number, number]; items: Array<{ pts: P2[]; w: number }>; pre: number; chip?: { at: P2; size: number } | undefined } | undefined => {
    if (planKind === 'stick') {
      const loop = inp.loops.reduce((a, l) => (l.length > a.length ? l : a), inp.loops[0] ?? [])
      const pts: P2[] = []
      for (let i = 0; i + 1 < loop.length; i += 2) pts.push([loop[i] as number, loop[i + 1] as number])
      const o: P2 = [character.opening.x, character.opening.y]
      const k0 = pts.reduce((b, q, i) => (dist(q, o) < dist(pts[b] as P2, o) ? i : b), 0)
      const ring = [...pts.slice(k0), ...pts.slice(0, k0 + 1)]
      const items: Array<{ pts: P2[]; w: number }> = []
      let run: P2[] = [ring[0] as P2]
      for (let i = 1; i < ring.length; i++) {
        run.push(ring[i] as P2)
        if (polyLen(run) > 0.12 * Math.max(bw, bh) || i === ring.length - 1) {
          items.push({ pts: run, w: 0 })
          run = [ring[i] as P2]
        }
      }
      const chip = bodies.find((b) => b.hero === true)
      const ringPts = chip === undefined ? [] : bodyCorners(chip)
      const outline = ringPts.length === 0 ? [] : [{ pts: [...ringPts, ringPts[0] as P2], w: 0 }]
      const cc: P2 = chip === undefined ? mid : [chip.x, chip.y]
      const leads = (padsOf.get(inp.heroRef ?? '') ?? []).map((q) => {
        const [x, y] = px(q.pos)
        const hx = 0.5 * q.size.x * ppm
        const hy = 0.5 * q.size.y * ppm
        const c = Math.cos(q.rot * D)
        const sn = Math.sin(q.rot * D)
        const pts = ([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]] as P2[]).map(([u, v]): P2 => [x + c * u - sn * v, y + sn * u + c * v])
        return { pts, w: 0, a: Math.atan2(y - cc[1], x - cc[0]) }
      }).sort((m, n) => m.a - n.a).map(({ pts, w }) => ({ pts, w }))
      return { focus: mid, span: [bw, bh], items: [...outline, ...leads, ...items], pre: outline.length + Math.min(leads.length, 6), chip: chip === undefined ? undefined : { at: cc, size: Math.hypot(chip.w, chip.h) } }
    }
    const ref = planKind === 'valve' ? inp.heroRef : planKind === 'header' && sigData.kind === 'header' ? sigData.ref : undefined
    if (ref === undefined) return undefined
    const ps = padsOf.get(ref) ?? []
    if (ps.length === 0) return undefined
    const at = ps.map((q) => px(q.pos))
    const c: P2 = [at.reduce((t, q) => t + q[0], 0) / at.length, at.reduce((t, q) => t + q[1], 0) / at.length]
    const lands = ps.map((q, i) => {
      const [x, y] = at[i] as P2
      const r = 0.5 * Math.min(q.size.x, q.size.y) * ppm
      if (planKind === 'valve') return { pts: Array.from({ length: 17 }, (_, j): P2 => [x + r * Math.cos((j / 16) * Math.PI * 2), y + r * Math.sin((j / 16) * Math.PI * 2)]), w: 0 }
      const hx = 0.5 * q.size.x * ppm
      const hy = 0.5 * q.size.y * ppm
      return { pts: [[x - hx, y - hy], [x + hx, y - hy], [x + hx, y + hy], [x - hx, y + hy], [x - hx, y - hy]] as P2[], w: 0 }
    }).sort((a, b) => Math.atan2((a.pts[0] as P2)[1] - c[1], (a.pts[0] as P2)[0] - c[0]) - Math.atan2((b.pts[0] as P2)[1] - c[1], (b.pts[0] as P2)[0] - c[0]))
    const xs = at.map((q) => q[0])
    const ys = at.map((q) => q[1])
    const sw = Math.max(...xs) - Math.min(...xs)
    const sh = Math.max(...ys) - Math.min(...ys)
    const reach = 1.8 * Math.max(sw, sh, 4 * ppm)
    const routes = chains(segs.filter((sg) => at.some((q) => dist(sg.a, q) < 0.6 * ppm || dist(sg.b, q) < 0.6 * ppm))).map((ch) => ({ pts: ch.pts.filter((q) => dist(q, c) < reach), w: ch.w })).filter((ch) => ch.pts.length >= 2)
    return { focus: c, span: [Math.max(sw, 0.6 * reach), Math.max(sh, 0.6 * reach)], items: [...lands, ...routes], pre: Math.max(1, Math.round(0.3 * lands.length)) }
  })()
  if (opening !== undefined) {
    const fill = planKind === 'stick' ? 0.8 : 0.62
    z1 = clamp(Math.min((fill * W) / Math.max(1, opening.span[0]), (fill * (H - stripHeight(W, H))) / Math.max(1, opening.span[1])), 0.4, 8)
    look1 = opening.focus
  }
  const fan = chains(segs.filter((s) => inView(s.a, look1, z1, yaw1, 1.05) || inView(s.b, look1, z1, yaw1, 1.05)))
  const safe = (q: P2): boolean => inView(q, look1, z1 * 1.05, yaw1, 0.9)
  const inFrame1 = (pts: P2[]): P2[] => {
    const out: P2[] = []
    for (const q of pts) {
      if (safe(q)) {
        out.push(q)
        continue
      }
      const prev = out[out.length - 1]
      if (prev !== undefined) {
        let lo = 0
        let hi = 1
        for (let k = 0; k < 20; k++) {
          const mid2 = (lo + hi) / 2
          if (safe([prev[0] + (q[0] - prev[0]) * mid2, prev[1] + (q[1] - prev[1]) * mid2])) lo = mid2
          else hi = mid2
        }
        out.push([prev[0] + (q[0] - prev[0]) * lo, prev[1] + (q[1] - prev[1]) * lo])
      }
      break
    }
    return out
  }
  const info = fan.map((c) => {
    const first = c.pts[0] as P2
    const last = c.pts[c.pts.length - 1] as P2
    const pts = inFrame1(dist(first, hero) <= dist(last, hero) ? c.pts : [...c.pts].reverse())
    return { pts, w: c.w, r: pts.length > 0 ? dist(pts[0] as P2, hero) : Infinity, len: polyLen(pts) }
  }).filter((c) => c.pts.length >= 2 && c.len * z1 >= 6 * u).sort((a, b) => a.r - b.r)
  const heroBody = opening === undefined ? bodies.find((b) => b.hero === true) : undefined
  if (heroBody !== undefined) {
    const ring = bodyCorners(heroBody)
    info.unshift({ pts: [...ring, ring[0] as P2], w: 0, r: 0, len: polyLen([...ring, ring[0] as P2]) })
  }
  if (opening !== undefined) info.splice(0, info.length, ...opening.items.map((c) => ({ ...c, r: dist(c.pts[0] as P2, opening.focus), len: polyLen(c.pts) })))
  const total = info.reduce((t, c) => t + c.len, 0)
  const budget = (nb1 > nb0 ? PRE_INK : 0.27) * total
  const pre: typeof info = []
  let inked = 0
  for (const c of info.slice(heroBody === undefined ? 0 : 1)) {
    if (opening !== undefined ? pre.length >= opening.pre : inked + c.len > budget) continue
    pre.push(c)
    inked += c.len
  }
  const openRoom = ((rest) => {
    if (opening !== undefined || nb1 <= nb0 || pre.length === 0) return { near: [], far: rest }
    const pts = pre.flatMap((c) => c.pts)
    const [x0, x1, y0, y1] = [Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[1]))]
    const [cx, cy, hx, hy] = [(x0 + x1) / 2, (y0 + y1) / 2, (OPEN_ROOM * (x1 - x0)) / 2, (OPEN_ROOM * (y1 - y0)) / 2]
    const inside = (c: { pts: P2[] }): boolean => c.pts.every((q) => Math.abs(q[0] - cx) <= hx && Math.abs(q[1] - cy) <= hy)
    return { near: rest.filter(inside).sort((x, y) => y.len - x.len), far: rest.filter((c) => !inside(c)) }
  })(info.filter((c) => !pre.includes(c)))
  const live = [...openRoom.near, ...openRoom.far]
  const liveLen = live.reduce((t, c) => t + c.len, 0)
  const nibExit = Math.min(NIB_EXIT, 0.55 * (nb1 - nb0))
  const nibSpeed = clamp((liveLen * z1) / (0.92 * (nb1 - nb0 - nibExit) * B), 700 * u * 24, (opening !== undefined ? 4 : nb1 > nb0 ? 2.5 : 1) * NIB_SPEED * u * 24)
  const grows = opening === undefined && nb1 > nb0 && pre.length > 0 && heroBody !== undefined
  const nibStrokes = grows ? growFan(info[0] as { pts: P2[]; w: number }, [...pre, ...openRoom.near].filter((c) => c !== info[0]), nb0 * B, (nb1 - nibExit) * B, z1, u) : schedule([...pre, ...live], z1, u, nb0 * B, (nb1 - nibExit) * B, pre.length, true, nibSpeed)
  const lidMark = grows || opening?.chip !== undefined ? (nb0 + LID_MARK) * B : undefined
  if (opening?.chip !== undefined) {
    const span = (nb1 - nb0) * B
    const live2 = nibStrokes.filter((st) => st.t1 > nb0 * B)
    const leadN = Math.max(0, (padsOf.get(inp.heroRef ?? '') ?? []).length - Math.max(0, opening.pre - 1))
    live2.forEach((st, i) => {
      const lead = i < leadN
      const k = lead ? i / Math.max(1, leadN) : (i - leadN) / Math.max(1, live2.length - leadN)
      st.t0 = nb0 * B + span * (lead ? 0.38 * k : 0.45 + 0.3 * k)
      st.t1 = st.t0 + span * (lead ? 0.1 : 0.2)
    })
  }


  const names2 = new Map(board.nets.map((n) => [n.id, n.name]))
  const topLayer = inp.back ? 'B.Cu' : 'F.Cu'
  const rawSegs: Seg[] = (board.copper[topLayer]?.traces ?? []).flatMap((t) => t.points.slice(1).map((p, i) => ({ a: px(t.points[i] as Vec2), b: px(p), w: t.width * ppm, t: 0, net: t.netId })))
  const merged: Seg[] = []
  const byNetSegs = new Map<number, Seg[]>()
  for (const sg of rawSegs) if (sg.net !== undefined) byNetSegs.set(sg.net, [...(byNetSegs.get(sg.net) ?? []), { ...sg }])
  for (const list of byNetSegs.values()) {
    for (let grew = true; grew;) {
      grew = false
      for (let i = 0; i < list.length && !grew; i++) {
        for (let j = i + 1; j < list.length && !grew; j++) {
          const x = list[i] as Seg
          const y = list[j] as Seg
          const ends: Array<[P2, P2, P2]> = [[x.b, y.a, x.a], [x.b, y.b, x.a], [x.a, y.a, x.b], [x.a, y.b, x.b]]
          for (const [e, f, far] of ends) {
            if (dist(e, f) > 0.02) continue
            const other = f === y.a ? y.b : y.a
            const d1: P2 = [e[0] - far[0], e[1] - far[1]]
            const d2: P2 = [other[0] - e[0], other[1] - e[1]]
            const cos = (d1[0] * d2[0] + d1[1] * d2[1]) / Math.max(1e-9, Math.hypot(...d1) * Math.hypot(...d2))
            if (cos < 0.9986 || Math.abs(x.w - y.w) > 0.01) continue
            list[i] = { ...x, a: far, b: other }
            list.splice(j, 1)
            grew = true
            break
          }
        }
      }
    }
    merged.push(...list)
  }
  let pairNets: number[] = []
  let lineNet: number | undefined
  const pair = sparse ? undefined : findPair(merged, names2, 3 * ppm, 0.8 * ppm)
  const bundle = sparse || pair !== undefined ? undefined : findBundle(merged, 4 * ppm, 1)
  const run: Run | undefined = pair ?? bundle
  let busKind: PlotScore['bus']['kind'] = 'none'
  let busText = ''
  let busStrokes: PlotStroke[] = []
  const busLine: PlotStroke[] = []
  let busLanded = 0
  let busA: P2 = mid
  let busB: P2 = mid
  let look2: P2 = mid
  let z2 = z1 * 1.4
  let yaw2 = 8 * D
  let drift: P2 = [0, 0]
  let parity = 0
  let subject: (q: P2) => boolean = () => false
  if (run !== undefined) {
    const across = run.lines.map((l) => dot(segMid(l), run.n)).sort((a, b) => a - b)
    const c0 = across[0] as number
    const c1 = across[across.length - 1] as number
    const at = (a: number, c: number): P2 => [run.d[0] * a + run.n[0] * c, run.d[1] * a + run.n[1] * c]
    const Lr = run.hi - run.lo
    const tilt = planKind === 'pair' ? 0 : 18 * D
    const theta = Math.atan2(run.d[1], run.d[0])
    const last1 = [...nibStrokes].filter((st) => st.t1 >= 0 && st.t1 <= 1).sort((a, b) => a.t1 - b.t1).pop()
    const n1 = last1?.path.length ?? 0
    const dir1 = last1 === undefined || n1 < 4 ? [1, 0] as P2 : rot([(last1.path[n1 - 2] as number) - (last1.path[n1 - 4] as number), (last1.path[n1 - 1] as number) - (last1.path[n1 - 3] as number)], yaw1)
    yaw2 = wrap(-theta - tilt)
    if (Math.abs(yaw2) > Math.PI / 2) yaw2 = wrap(yaw2 + Math.PI)
    if (planKind === 'pair') yaw2 = 0
    parity = dot(rot(run.d, yaw2), dir1) < 0 ? 1 : 0
    const spread = Math.max(1e-6, c1 - c0)
    const fill = planKind === 'pair' ? PAIR_FILL : 0.75
    z2 = Math.min(16, Math.max((fill * W) / (Lr * Math.cos(tilt) + spread * Math.sin(tilt)), pair !== undefined ? (34 * u) / spread : 0))
    const Lc = Math.min(Lr, ((fill * W) / z2 - spread * Math.sin(tilt)) / Math.cos(tilt))
    const reachL = run.lo - 0.02 * Lc
    const reachH = run.lo + 0.98 * Lc
    look2 = at((reachL + reachH) / 2, (c0 + c1) / 2)
    drift = [0, 0]
    subject = (q: P2): boolean => {
      const a = dot(q, run.d)
      const c = dot(q, run.n)
      return a >= reachL - 0.01 * Lc && a <= reachH + 0.01 * Lc && c >= c0 - 0.2 * spread - ppm * 0.1 && c <= c1 + 0.2 * spread + ppm * 0.1
    }
    const lines = [...run.lines]
    if (pair === undefined) {
      const offs = (): number[] => lines.map((l) => dot(segMid(l), run.n)).sort((x, y) => x - y)
      const g0 = offs().slice(1).map((c, i) => c - (offs()[i] as number)).sort((x, y) => x - y)
      const pitch0 = g0[Math.floor(g0.length / 2)] ?? spread
      const cands = merged.filter((sg) => {
        if (lines.includes(sg)) return false
        const sl = segLen(sg)
        if (sl <= 0 || Math.abs(dot([sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]], run.d)) / sl < 0.9976) return false
        const a0 = dot(sg.a, run.d)
        const b0 = dot(sg.b, run.d)
        const lo = Math.max(reachL, Math.min(a0, b0))
        const hi = Math.min(reachH, Math.max(a0, b0))
        return hi - lo >= Math.max(0.25 * Lc, 2.5 * ppm)
      })
      for (let grew = true; grew;) {
        grew = false
        const o = offs()
        const gs = o.slice(1).map((c, i) => c - (o[i] as number)).sort((x, y) => x - y)
        const pitchNow = Math.max(pitch0, gs[Math.floor(gs.length / 2)] ?? pitch0)
        for (const sg of cands) {
          if (lines.includes(sg)) continue
          const c = dot(segMid(sg), run.n)
          if (c < (o[0] as number) - 5 * pitchNow || c > (o[o.length - 1] as number) + 5 * pitchNow) continue
          if (lines.some((l) => Math.abs(dot(segMid(l), run.n) - c) < 0.5 * Math.max(l.w, sg.w))) continue
          lines.push(sg)
          grew = true
        }
      }
    }
    const sorted = lines.sort((x, y) => dot(segMid(x), run.n) - dot(segMid(y), run.n))
    const across2 = sorted.map((l) => dot(segMid(l), run.n))
    const spread2 = (across2[across2.length - 1] as number) - (across2[0] as number)
    z2 = Math.min(z2, ((fill + 0.03) * W) / (Lc * Math.cos(tilt) + spread2 * Math.sin(tilt)))
    const clip = (s: Seg, flip: boolean): P2[] => {
      const a0 = dot(s.a, run.d)
      const b0 = dot(s.b, run.d)
      const lerp = (t: number): P2 => {
        const k = Math.abs(b0 - a0) < 1e-9 ? 0 : (t - a0) / (b0 - a0)
        return [s.a[0] + (s.b[0] - s.a[0]) * k, s.a[1] + (s.b[1] - s.a[1]) * k]
      }
      const lo = clamp(reachL, Math.min(a0, b0), Math.max(a0, b0))
      const hi = clamp(reachH, Math.min(a0, b0), Math.max(a0, b0))
      return flip ? [lerp(hi), lerp(lo)] : [lerp(lo), lerp(hi)]
    }
    const n = sorted.length
    const frames = planDuration(inp.resolved).totalFrames
    const lineLen = Math.max(...sorted.map((sg) => polyLen(clip(sg, false)))) * z2
    const lag = Math.min(1, 6 / Math.max(1, n))
    const slowest = 22 - Math.floor((n - 1) * lag)
    const ruleFrames = bu0 === 0 ? slowest : clamp(lineLen / (HAND * u), 8, slowest)
    busStrokes = sorted.map((s, i) => {
      const t0 = plotClock(plotFrame(bu0 * B, frames) + Math.floor(i * lag) - (bu0 === 0 ? Math.round(OPEN_DRAWN * ruleFrames) : 0), frames)
      return { path: clip(s, parity === 1).flat(), w: s.w, t0, t1: plotClock(plotFrame(t0, frames) + ruleFrames, frames) }
    })
    busLanded = Math.max(0, ...busStrokes.map((st) => st.t1))
    const end = run.lo + 0.8 * Lc
    const centres = (s0: Seg | undefined, s1: Seg | undefined, ca: number, cb: number): [P2, P2] => {
      if (s0 === undefined || s1 === undefined) return [at(end, ca), at(end, cb)]
      const span = (sg: Seg): [number, number] => [Math.min(dot(sg.a, run.d), dot(sg.b, run.d)), Math.max(dot(sg.a, run.d), dot(sg.b, run.d))]
      const [l0, h0] = span(s0)
      const [l1, h1] = span(s1)
      const t = clamp(end, Math.max(l0, l1), Math.min(h0, h1))
      const on = (sg: Seg): P2 => {
        const a0 = dot(sg.a, run.d)
        const b0 = dot(sg.b, run.d)
        const k = Math.abs(b0 - a0) < 1e-9 ? 0 : clamp((t - a0) / (b0 - a0), 0, 1)
        return [sg.a[0] + (sg.b[0] - sg.a[0]) * k, sg.a[1] + (sg.b[1] - sg.a[1]) * k]
      }
      return [on(s0), on(s1)]
    }
    if (pair !== undefined) {
      busKind = 'pair'
      ;[busA, busB] = centres(sorted[0], sorted[n - 1], c0, c1)
      busText = `DIFFERENTIAL PAIR · ${(Math.round((pair.gap / ppm) * 100) / 100).toFixed(2)} MM GAP`
      if (sigData.kind === 'pair') {
        const ids = [sorted[0]?.net, sorted[n - 1]?.net]
        pairNets = ids.filter((q): q is number => q !== undefined)
        const len = (id: number | undefined): number => Object.values(board.copper).flatMap((c) => c.traces).filter((t) => t.netId === id).reduce((t, tr) => t + tr.points.slice(1).reduce((v, q, i) => v + Math.hypot(q.x - (tr.points[i] as Vec2).x, q.y - (tr.points[i] as Vec2).y), 0), 0)
        sigData.lengthsMm = [len(ids[0]), len(ids[1])]
        busText = 'DIFFERENTIAL PAIR'
      }
    } else {
      busKind = 'bundle'
      const gaps = across2.slice(1).map((c, i) => c - (across2[i] as number)).sort((a, b) => a - b)
      const pitchMm = (gaps[Math.floor(gaps.length / 2)] ?? 0) / ppm
      const k = Math.floor(n / 2)
      ;[busA, busB] = centres(sorted[k - 1], sorted[k], across2[k - 1] ?? c0, across2[k] ?? c1)
      busText = `${n} LINES · ${pitchMm.toFixed(2)} MM PITCH`
      const heroNets = new Set((padsOf.get(inp.heroRef ?? '') ?? []).flatMap((q) => (q.netId === undefined ? [] : [q.netId])))
      const line = sorted.map((sg, i) => ({ i, net: sg.net })).filter((q) => q.net !== undefined && heroNets.has(q.net) && netKind(nameOf.get(q.net) ?? '') !== 'power' && netKind(nameOf.get(q.net) ?? '') !== 'ground').sort((x, y) => Math.abs(x.i - (n - 1) / 2) - Math.abs(y.i - (n - 1) / 2))[0]
      if (line !== undefined) {
        lineNet = line.net
        const st = busStrokes[line.i]
        if (st !== undefined) st.accent = true
      } else {
        const ruler = busStrokes[k] ?? busStrokes[0]
        const seen = (q: P2): boolean => inView(q, look2, z2, yaw2, 0.9)
        const own = [...heroNets].filter((id) => netKind(nameOf.get(id) ?? '') === 'signal' || (netKind(nameOf.get(id) ?? '') !== 'power' && netKind(nameOf.get(id) ?? '') !== 'ground'))
          .map((id) => ({ id, legs: merged.filter((sg) => sg.net === id && (seen(sg.a) || seen(sg.b) || seen(segMid(sg)))) }))
          .map((c) => ({ ...c, len: c.legs.reduce((t, sg) => t + segLen(sg), 0) }))
          .sort((x, y) => y.len - x.len)[0]
        if (own !== undefined && own.len > 0 && ruler !== undefined) {
          lineNet = own.id
          const far = Math.max(...own.legs.flatMap((sg) => [dist(sg.a, hero), dist(sg.b, hero)]))
          const near = Math.min(...own.legs.flatMap((sg) => [dist(sg.a, hero), dist(sg.b, hero)]))
          const when = (q: P2): number => ruler.t0 + (ruler.t1 - ruler.t0) * clamp((far - dist(q, hero)) / Math.max(1e-6, far - near), 0, 1)
          for (const sg of own.legs) {
            const [a, b] = dist(sg.a, hero) >= dist(sg.b, hero) ? [sg.a, sg.b] : [sg.b, sg.a]
            busLine.push({ path: [...a, ...b], w: sg.w, t0: when(a), t1: Math.max(when(b), when(a) + 0.002), accent: true })
          }
        }
      }
    }
  } else if (pins.length >= 3) {
    const cp = pins.map((p) => px(p.pos))
    const cx = cp.reduce((t, q) => t + q[0], 0) / cp.length
    const cy = cp.reduce((t, q) => t + q[1], 0) / cp.length
    const rs = cp.map((q) => dist(q, [cx, cy]))
    const rm0 = rs.reduce((a, b) => a + b, 0) / rs.length
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - rm0) ** 2, 0) / rs.length)
    look2 = [cx, cy]
    yaw2 = 8 * D
    if (cp.length >= 5 && sd / rm0 < 0.08) {
      busKind = 'pins'
      z2 = clamp((0.27 * minWH) / rm0, 1, 16)
      const ring0: P2[] = Array.from({ length: 65 }, (_, i) => [cx + rm0 * Math.cos(Math.PI + (i / 64) * Math.PI * 2), cy + rm0 * Math.sin(Math.PI + (i / 64) * Math.PI * 2)])
      const last1 = [...nibStrokes].filter((st) => st.t1 >= 0 && st.t1 <= 1).sort((a, b) => a.t1 - b.t1).pop()
      const n1 = last1?.path.length ?? 0
      const dir1: P2 = last1 === undefined || n1 < 4 ? [1, 0] : rot([(last1.path[n1 - 2] as number) - (last1.path[n1 - 4] as number), (last1.path[n1 - 1] as number) - (last1.path[n1 - 3] as number)], yaw1)
      const ring = dot(rot([(ring0[1] as P2)[0] - (ring0[0] as P2)[0], (ring0[1] as P2)[1] - (ring0[0] as P2)[1]], yaw2), dir1) < 0 ? [...ring0].reverse() : ring0
      busStrokes = [{ path: ring.flat(), w: 0, t0: bu0 * B, t1: (bu0 + 0.7 * (bu1 - bu0)) * B }]
      const dir = rot([1, 0], -yaw2)
      busA = [cx - dir[0] * rm0, cy - dir[1] * rm0]
      busB = [cx + dir[0] * rm0, cy + dir[1] * rm0]
      busText = `PIN CIRCLE Ø${((2 * rm0) / ppm).toFixed(1)} MM`
    } else if (pitch !== undefined) {
      busKind = 'pins'
      z2 = clamp((0.12 * minWH) / Math.max(1, pitchPx), 1, 16)
      look2 = [(pitch.a[0] + pitch.b[0]) / 2, (pitch.a[1] + pitch.b[1]) / 2]
      busA = pitch.a
      busB = pitch.b
      busText = `PIN PITCH ${pitch.mm.toFixed(2)} MM`
    }
  }

  const lastNib = [...nibStrokes].filter((st) => st.t1 >= 0 && st.t1 <= 1).sort((a, b) => a.t1 - b.t1).pop()
  const firstBus = busStrokes[0]
  const matched: P2 = lastNib === undefined || firstBus === undefined ? look2 : (() => {
    const e1 = rot([(lastNib.path[lastNib.path.length - 2] as number) - look1[0], (lastNib.path[lastNib.path.length - 1] as number) - look1[1]], yaw1)
    const back = rot([(e1[0] * z1 * 1.05) / z2, (e1[1] * z1 * 1.05) / z2], -yaw2)
    return [(firstBus.path[0] as number) - back[0], (firstBus.path[1] as number) - back[1]]
  })()
  const copperAt = (lk: P2): number => segs.reduce((t, sg) => t + (inView(sg.a, lk, z2, yaw2, 1) && inView(sg.b, lk, z2, yaw2, 1) ? segLen(sg) : 0), 0)
  const look2Start: P2 = copperAt(matched) >= 0.5 * copperAt(look2) ? matched : look2
  const look2Mid: P2 = [(look2[0] + look2Start[0]) / 2, (look2[1] + look2Start[1]) / 2]
  const seenB2 = (q: P2): boolean => inView(q, look2, z2, yaw2, 1) || inView(q, look2Start, z2, yaw2, 1) || inView(q, look2Mid, z2, yaw2, 1)
  const near2 = chains(segs.filter((sg) => !subject(segMid(sg)) && (seenB2(sg.a) || seenB2(sg.b) || seenB2(segMid(sg)))))
    .map((c) => ({ ...c, r: Math.min(...c.pts.map((q) => Math.min(dist(q, look2), dist(q, look2Start)))), len: polyLen(c.pts) }))
    .sort((a, b) => a.r - b.r)
  const seen2 = near2.reduce((t, c) => t + c.len, 0) + busStrokes.reduce((t, st) => t + polyLen(Array.from({ length: st.path.length / 2 }, (_, j) => [st.path[2 * j] as number, st.path[2 * j + 1] as number] as P2)), 0)
  const busSweep: PlotStroke[] = []
  let inked2 = 0
  const keepLive = new Set(near2.map((c, i) => ({ i, len: c.len })).sort((a, b) => a.len - b.len).slice(0, 3).map((c) => c.i))
  const looks: P2[] = [0, 0.5, 1].map((k) => [look2Start[0] + (look2[0] - look2Start[0]) * k, look2Start[1] + (look2[1] - look2Start[1]) * k])
  const atLook = looks.map(() => 0)
  near2.forEach((c, i) => {
    const pre2 = (inked2 < 0.27 * seen2 || atLook.some((a) => a * z2 < 1.3 * inked * z1)) && !keepLive.has(i)
    if (pre2) {
      inked2 += c.len
      looks.forEach((lk, n) => { atLook[n] = (atLook[n] as number) + c.pts.slice(1).reduce((t, q, j) => t + (inView(q, lk, z2, yaw2, 1) && inView(c.pts[j] as P2, lk, z2, yaw2, 1) ? dist(q, c.pts[j] as P2) : 0), 0) })
    }
    const k = i / Math.max(1, near2.length - 1)
    const t0 = (bu0 + 0.4 * (bu1 - bu0)) * B + 0.4 * (bu1 - bu0) * B * k
    busSweep.push({ path: c.pts.flat(), w: c.w, t0: pre2 ? -1 : t0, t1: pre2 ? -1 : t0 + Math.min(0.15 * B, (c.len * z2) / (2400 * u * 24)) })
  })
  const live2 = busSweep.filter((st) => st.t0 >= 0)
  if (live2.length < busSweep.length) {
    live2.forEach((st, i) => {
      const t0 = (bu0 + 0.4 * (bu1 - bu0)) * B + (0.4 * (bu1 - bu0) * B * i) / Math.max(1, live2.length - 1)
      st.t1 = t0 + (st.t1 - st.t0)
      st.t0 = t0
    })
  }
  if (bu1 <= bu0) {
    busStrokes = []
    busLine.length = 0
    busSweep.length = 0
    busText = ''
  }
  const filmFrames = planDuration(inp.resolved).totalFrames
  for (const st of [...nibStrokes, ...busSweep].filter((q) => q.t1 > 0 && q.t0 <= 1)) {
    st.t0 = plotSnap(st.t0, filmFrames)
    st.t1 = Math.max(plotClock(Math.round(plotFrame(st.t0, filmFrames)) + 1, filmFrames), plotSnap(st.t1, filmFrames))
  }
  for (const st of nibStrokes) if (st.t1 > 0 && st.t0 <= 1) st.pen = true

  const planYaw = planKind !== 'pair' && ((H > 1.15 * W && bw > 1.3 * bh) || (W > 1.15 * H && bh > 1.3 * bw)) ? Math.PI / 2 : 0
  const [pw, ph] = planYaw === 0 ? [bw, bh] : [bh, bw]
  const dimRoom = 2.2 * FILM_SUB * su
  const top3 = 0.02 * H + dimRoom
  const bot3 = H - strip - 0.01 * H
  const z3 = Math.min((bot3 - top3) / ph, (0.9 * W - 2 * dimRoom) / pw)
  const lift3 = H / 2 - (top3 + bot3) / 2
  const optical = (z: number): P2 => [mid[0] + Math.sin(planYaw) * lift3 / z, mid[1] + Math.cos(planYaw) * lift3 / z]

  const flowSegs: PlotFlowSeg[] = []
  const flowVias: Array<[number, number]> = []
  const flowPins: Array<[number, number]> = []
  const inkAt = (mm: number): number => {
    const i = Math.max(1, stations.findIndex((st) => st.at >= mm - 1e-9))
    const hi = stations[i] ?? stations[stations.length - 1]
    const lo = stations[i - 1] ?? hi
    if (hi === undefined || lo === undefined) return FLOW[0] * B
    const w = Math.min(0.5 * B, Math.max(0, hi.t - lo.t))
    return hi.t - w + (hi.at > lo.at ? clamp((mm - lo.at) / (hi.at - lo.at), 0, 1) : 1) * w
  }
  const signalNets = (ref: string): Set<number> => new Set((padsOf.get(ref) ?? []).flatMap((q) => (q.netId !== undefined && netKind(nameOf.get(q.netId) ?? '') !== 'power' && netKind(nameOf.get(q.netId) ?? '') !== 'ground' ? [q.netId] : [])))
  const headers = sigData.kind !== 'header' ? [] : comps.filter((f) => CONN.test(f.ref) && f.value === board.footprints.find((q) => q.ref === sigData.ref)?.value)
  const flowEnds: Array<{ x: number; y: number; text: string; t: number }> = []
  const thingNets = ((): Set<number> => {
    if (power) return new Set()
    if (sigData.kind === 'pair') return new Set(pairNets)
    const own = new Set(headers.flatMap((f) => [...signalNets(f.ref)]))
    return own.size === 0 && lineNet !== undefined && sigData.kind === 'escape' ? new Set([lineNet]) : own
  })()
  const heroNetIds = new Set((padsOf.get(inp.heroRef ?? '') ?? []).flatMap((q) => (q.netId === undefined ? [] : [q.netId])))
  const copperOf = (id: number): number => Object.values(board.copper).flatMap((c) => c.traces).filter((t) => t.netId === id).reduce((t, tr) => t + tr.points.slice(1).reduce((v, q, i) => v + Math.hypot(q.x - (tr.points[i] as Vec2).x, q.y - (tr.points[i] as Vec2).y), 0), 0)
  const padsOn = (id: number): Pad[] => Object.values(board.copper).flatMap((c) => c.pads).filter((q) => q.netId === id)
  const rideChain = ((): number[] | undefined => {
    if (sigData.kind !== 'header') return undefined
    const signalNet = (id: number): boolean => netKind(nameOf.get(id) ?? '') !== 'power' && netKind(nameOf.get(id) ?? '') !== 'ground'
    const ends = (id: number): Pad[] => padsOn(id).filter((q) => q.footprintRef !== inp.heroRef)
    const reaches = (id: number): boolean => ends(id).some((q) => CONN.test(q.footprintRef ?? '') || CHIP.test(q.footprintRef ?? ''))
    const chains = [...heroNetIds].filter(signalNet).flatMap((id): number[][] => {
      if (reaches(id)) return [[id]]
      return ends(id).flatMap((q) => {
        const own = (padsOf.get(q.footprintRef ?? '') ?? []).filter((o) => o.netId !== undefined)
        const other = own.length === 2 ? own.find((o) => o.netId !== id)?.netId : undefined
        return other !== undefined && signalNet(other) && reaches(other) ? [[id, other]] : []
      })
    })
    const minW = (chain: number[]): number => Math.min(...Object.values(board.copper).flatMap((c) => c.traces).filter((t) => chain.includes(t.netId ?? -1)).map((t) => t.width))
    const rideBeats = ou1 - TRAVEL_HOLD - ou0 + RIDE_DRAWN
    const fits = (chain: number[]): boolean => chain.reduce((t, id) => t + copperOf(id), 0) * ppm <= rideReach(W, rideBeats, Math.max((1.03 * SIGNAL_WIDE * W) / (minW(chain) * ppm), W / (RIDE_SPAN * ppm)), 0)
    const ranked = chains.map((chain) => ({ chain, light: chain.some((id) => LIGHT_NET.test(nameOf.get(id) ?? '')) || chain.flatMap(ends).some((q) => lightEnd(q.footprintRef ?? '', board.footprints.find((f) => f.ref === q.footprintRef))), bus: chain.reduce((t, id) => t + besideShare(board, id) * copperOf(id), 0) / Math.max(1e-9, chain.reduce((t, id) => t + copperOf(id), 0)) >= RIDE_BUS, fits: fits(chain), mm: chain.reduce((t, id) => t + copperOf(id), 0) }))
    return ranked.sort((a, b) => Number(a.light) - Number(b.light) || Number(b.bus) - Number(a.bus) || Number(b.fits) - Number(a.fits) || b.mm - a.mm)[0]?.chain
  })()
  if (rideChain !== undefined) {
    thingNets.clear()
    for (const id of rideChain) thingNets.add(id)
  }
  const thingPads = thingNets.size === 0 ? [] : Object.values(board.copper).flatMap((c) => c.pads).filter((q) => q.netId !== undefined && thingNets.has(q.netId) && q.footprintRef !== inp.heroRef)
  const thingEnd = thingPads.find((q) => CONN.test(q.footprintRef ?? '')) ?? (rideChain !== undefined ? thingPads.filter((q) => CHIP.test(q.footprintRef ?? '')).reduce<Pad | undefined>((f, q) => (f === undefined || dist(px(q.pos), hero) > dist(px(f.pos), hero) ? q : f), undefined) : undefined) ?? (lineNet !== undefined && thingNets.has(lineNet) ? thingPads.reduce<Pad | undefined>((f, q) => (f === undefined || dist(px(q.pos), hero) > dist(px(f.pos), hero) ? q : f), undefined) : undefined)
  const pairWay: P2[] = []
  if (planKind === 'pair' && thingEnd !== undefined && pairNets.length > 0) {
    const goal = px(thingEnd.pos)
    const D = Math.max(1, dist(look2, goal))
    const route = Object.values(board.copper).flatMap((c) => c.traces).filter((t) => pairNets.includes(t.netId ?? -1))
    const legs = route.flatMap((t) => t.points.slice(1).map((q, i) => [px(t.points[i] as Vec2), px(q), t.width * ppm] as [P2, P2, number]))
    for (const [a, b, w] of legs) {
      const fa = clamp(dist(a, look2) / D, 0, 1)
      const fb = clamp(dist(b, look2) / D, 0, 1)
      const [s0, s1, f0, f1] = fa <= fb ? [a, b, fa, fb] : [b, a, fb, fa]
      const t0 = (bu0 + (0.5 + 0.42 * f0) * (bu1 - bu0)) * B
      busStrokes.push({ path: [...s0, ...s1], w, t0, t1: Math.max(t0 + 0.002, (bu0 + (0.52 + 0.42 * f1) * (bu1 - bu0)) * B) })
    }
    const mids = legs.map(([a, b]): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
    for (const f of [1 / 3, 2 / 3]) {
      const best = mids.reduce<P2 | undefined>((bst, q) => bst === undefined || Math.abs(dist(q, look2) / D - f) + Math.abs(dist(q, goal) / D - (1 - f)) < Math.abs(dist(bst, look2) / D - f) + Math.abs(dist(bst, goal) / D - (1 - f)) ? q : bst, undefined)
      if (best !== undefined) pairWay.push(best)
    }
  }
  const flEnd = power ? stations.at(-1)?.t ?? FLOW[1] * B : ou1 * B
  if (power && pp !== undefined) {
    pp.steps.forEach((st, i) => {
      flowSegs.push({ a: px(st.a), b: px(st.b), w: st.w * ppm, p0: inkAt((cum[i] as number) - (stepLen[i] as number)), p1: inkAt(cum[i] as number), kind: st.kind, ...(st.label !== undefined ? { label: st.label } : {}), ...(st.plane === true ? { plane: true } : {}) })
    })
    for (const v of pp.vias) flowVias.push(px(v))
    for (const p of pp.pins) flowPins.push(px(p))
  }
  if (thingEnd !== undefined) {
    const goal = px(thingEnd.pos)
    const reach = Math.max(1, ...Object.values(board.copper).flatMap((c) => c.traces).filter((t) => thingNets.has(t.netId ?? -1)).flatMap((t) => t.points.map((q) => dist(px(q), hero))))
    for (const f of headers) flowEnds.push({ ...((q) => ({ x: q[0], y: q[1] }))(px(f.pos)), text: `${signalNets(f.ref).size}`, t: (ou0 + 0.1 + 0.6 * (ou1 - ou0 - 0.5)) * B })
    for (const c of Object.values(board.copper)) {
      for (const t of c.traces) {
        if (!thingNets.has(t.netId ?? -1)) continue
        for (let i = 1; i < t.points.length; i++) {
          const a = px(t.points[i - 1] as Vec2)
          const b = px(t.points[i] as Vec2)
          const [p0, p1] = [dist(a, hero), dist(b, hero)].map((d) => (ou0 - RIDE_DRAWN + (1 - d / reach) * (ou1 - ou0 - TRAVEL_HOLD - 0.5 + RIDE_DRAWN)) * B) as [number, number]
          flowSegs.push(p0 <= p1 ? { a, b, w: t.width * ppm, p0, p1: Math.max(p1, p0 + 0.002), kind: 'trace' } : { a: b, b: a, w: t.width * ppm, p0: p1, p1: Math.max(p0, p1 + 0.002), kind: 'trace' })
        }
      }
      for (const v of c.vias) if (thingNets.has(v.netId ?? -1)) flowVias.push(px(v.pos))
    }
    const last = flowSegs.reduce((k, sg, i) => (dist(sg.b, goal) < dist((flowSegs[k] as PlotFlowSeg).b, goal) ? i : k), 0)
    flowSegs.push(...flowSegs.splice(last, 1))
    flowPins.push(goal)
  }
  const ridePath = planKind === 'pair' || thingEnd === undefined || flowSegs.length === 0 ? undefined : ((): RidePath | undefined => {
    const key = (q: P2): string => `${Math.round(q[0] * 4)},${Math.round(q[1] * 4)}`
    const at = new Map<string, P2>()
    const adj = new Map<string, Array<[string, number]>>()
    const link = (a: P2, b: P2): void => {
      const [ka, kb] = [key(a), key(b)]
      at.set(ka, a)
      at.set(kb, b)
      adj.set(ka, [...(adj.get(ka) ?? []), [kb, dist(a, b)]])
      adj.set(kb, [...(adj.get(kb) ?? []), [ka, dist(a, b)]])
    }
    for (const sg of flowSegs) link(sg.a, sg.b)
    const ends = flowSegs.flatMap((sg) => [sg.a, sg.b])
    const onPads = Object.values(board.copper).flatMap((c) => c.pads).filter((q) => q.netId !== undefined && thingNets.has(q.netId))
    for (const pad of onPads) {
      const c = px(pad.pos)
      const r = (0.5 * Math.max(pad.size.x, pad.size.y) + 0.1) * ppm
      for (const e of ends) if (dist(e, c) <= r) link(c, e)
    }
    for (const ref of new Set(onPads.map((q) => q.footprintRef ?? ''))) {
      const own = (padsOf.get(ref) ?? []).filter((q) => q.netId !== undefined && thingNets.has(q.netId))
      if (ref !== inp.heroRef && (padsOf.get(ref) ?? []).length === 2 && own.length === 2 && own[0]?.netId !== own[1]?.netId) link(px((own[0] as Pad).pos), px((own[1] as Pad).pos))
    }
    const d = new Map<string, number>()
    const back = new Map<string, string>()
    const open: string[] = []
    for (const pad of onPads) if (pad.footprintRef === inp.heroRef && adj.has(key(px(pad.pos)))) {
      d.set(key(px(pad.pos)), 0)
      open.push(key(px(pad.pos)))
    }
    while (open.length > 0) {
      open.sort((x, y) => (d.get(y) as number) - (d.get(x) as number))
      const k = open.pop() as string
      for (const [n, l] of adj.get(k) ?? []) {
        if ((d.get(n) ?? Infinity) <= (d.get(k) as number) + l) continue
        if (!d.has(n)) open.push(n)
        d.set(n, (d.get(k) as number) + l)
        back.set(n, k)
      }
    }
    const goalKey = key(px(thingEnd.pos))
    const goal = d.has(goalKey) ? goalKey : [...d.keys()].reduce<string | undefined>((f, k) => (f === undefined || (d.get(k) as number) > (d.get(f) as number) ? k : f), undefined)
    if (goal === undefined || (d.get(goal) as number) <= 0) return undefined
    const named: Array<{ key: string; d: number; name: string }> = [
      ...onPads.filter((o) => o.footprintRef !== inp.heroRef && d.has(key(px(o.pos)))).map((o) => ({ key: key(px(o.pos)), d: d.get(key(px(o.pos))) as number, name: o.footprintRef ?? '' })),
      ...flowVias.filter((v) => d.has(key(v))).map((v) => ({ key: key(v), d: d.get(key(v)) as number, name: 'VIA' }))
    ]
    const others = Object.values(board.copper).flatMap((c) => c.traces).filter((t) => t.netId !== undefined && !thingNets.has(t.netId)).flatMap((t) => t.points.slice(1).map((q, i) => [px(t.points[i] as Vec2), px(q)] as const)).filter(([a, b]) => dist(a, b) > 0.3 * ppm)
    const beside = flowSegs.map((sg) => {
      const l = dist(sg.a, sg.b)
      if (l < 1e-6) return false
      const m: P2 = [(sg.a[0] + sg.b[0]) / 2, (sg.a[1] + sg.b[1]) / 2]
      return others.some(([oa, ob]) => {
        const ol = dist(oa, ob)
        const o: P2 = [(ob[0] - oa[0]) / ol, (ob[1] - oa[1]) / ol]
        if (Math.abs(((sg.b[0] - sg.a[0]) / l) * o[1] - ((sg.b[1] - sg.a[1]) / l) * o[0]) > 0.17) return false
        const along = (m[0] - oa[0]) * o[0] + (m[1] - oa[1]) * o[1]
        const off = Math.abs((m[0] - oa[0]) * o[1] - (m[1] - oa[1]) * o[0])
        return along > -0.2 * l && along < ol + 0.2 * l && off < BESIDE_MM * ppm && off > 0.05 * ppm
      })
    })
    const farEnd = (i: number): string => {
      const sg = flowSegs[i] as PlotFlowSeg
      return (d.get(key(sg.a)) ?? -1) >= (d.get(key(sg.b)) ?? -1) ? key(sg.a) : key(sg.b)
    }
    const forms = flowSegs.flatMap((_, i) => {
      if (beside[i] !== true) return []
      const k = farEnd(i)
      const before = flowSegs.map((_, j) => j).filter((j) => j !== i && farEnd(j) !== k && [key((flowSegs[j] as PlotFlowSeg).a), key((flowSegs[j] as PlotFlowSeg).b)].includes(k))
      return d.has(k) && before.every((j) => beside[j] !== true) ? [{ key: k, d: d.get(k) as number, name: 'BUS' }] : []
    })
    named.push(...forms)
    const line = (from: string): { pts: P2[]; toChip: number[] } => {
      const pts: P2[] = []
      for (let k: string | undefined = from; k !== undefined; k = back.get(k)) pts.push(at.get(k) as P2)
      return { pts, toChip: pts.map((q) => d.get(key(q)) as number) }
    }
    const segD = flowSegs.map((sg) => [d.get(key(sg.a)) ?? Infinity, d.get(key(sg.b)) ?? Infinity] as [number, number])
    const far = [...d.keys()].reduce((f, k) => ((d.get(k) as number) > (d.get(f) as number) ? k : f), goal)
    return { goal: { key: goal, d: d.get(goal) as number }, far: { key: far, d: d.get(far) as number }, named, line, segD, end: thingEnd.footprintRef ?? '' }
  })()


  const sheetFrame = heroFrameBox
  const callBoard = hullBox(iso, hull)
  let sheetPlan = fit.plan
  const ownBody = (m: PlotMark): number => {
    const f = owner.get(m)
    return f === undefined ? -1 : bodyOf(f)
  }
  for (let pass = 0; pass < 2; pass++) {
    const items = features.map((m) => ({ at: axoPoint(iso, [m.x, m.y], m.z ?? 0), ...calloutSize(m.text, m.sub, su, SHEET_TEXT, SHEET_SUB) }))
    const rects = placeCallouts(items, sheetPlan, callBoard, sheetFrame, su)
    const named = sheetPlan.map((c) => ownBody(features[c.item] as PlotMark)).filter((i) => i >= 0)
    for (const c of sheetPlan) {
      const m = features[c.item] as PlotMark
      const r = rects[c.item]
      if (r === undefined) continue
      const own = ownBody(m)
      const others = named.filter((i) => i !== own).map((i) => silhouette(iso, i))
      const clear = (q: { x: number; y: number; z: number }): boolean => {
        const a = axoPoint(iso, [q.x, q.y], q.z)
        return !others.some((poly) => segmentHits(a, [clamp(a[0], r.x, r.x + r.w), clamp(a[1], r.y, r.y + r.h)], poly))
      }
      if (clear({ x: m.x, y: m.y, z: m.z ?? 0 })) continue
      const f = owner.get(m)
      const alt = (f === undefined ? [] : spots(f).filter((q) => !hidden(iso, [q.x, q.y], q.z, own))).find(clear)
      if (alt === undefined) continue
      m.x = alt.x
      m.y = alt.y
      m.z = alt.z
    }
  }
  for (let pass = 0; pass < 2 * features.length; pass++) {
    const items = features.map((m) => ({ at: axoPoint(iso, [m.x, m.y], m.z ?? 0), ...calloutSize(m.text, m.sub, su, SHEET_TEXT, SHEET_SUB) }))
    const rects = placeCallouts(items, sheetPlan, callBoard, sheetFrame, su)
    const leader = (c: PlotCallout): [P2, P2] | undefined => {
      const r = rects[c.item]
      const a = items[c.item]?.at
      return r === undefined || a === undefined ? undefined : [a, [clamp(a[0], r.x, r.x + r.w), clamp(a[1], r.y, r.y + r.h)]]
    }
    const pair = sheetPlan.flatMap((c, i) => sheetPlan.slice(i + 1).map((o) => [c, o] as const)).find(([c, o]) => {
      const p = leader(c)
      const q = leader(o)
      return c.side === o.side && c.row === o.row && p !== undefined && q !== undefined && segmentsCross(p, q)
    })
    if (pair === undefined) break
    const [c, o] = pair
    sheetPlan = sheetPlan.map((x) => (x === c ? { ...x, order: o.order } : x === o ? { ...x, order: c.order } : x))
  }
  {
    const items = features.map((m) => ({ at: axoPoint(iso, [m.x, m.y], m.z ?? topOf([m.x, m.y])), ...calloutSize(m.text, m.sub, su, SHEET_TEXT, SHEET_SUB) }))
    const rects = placeCallouts(items, sheetPlan, callBoard, sheetFrame, su)
    const clean = cleanLeaders(sheetPlan.map((c) => ({ at: items[c.item]?.at, rect: rects[c.item] })), callBoard)
    sheetPlan = sheetPlan.map((c, k) => ({ ...c, drawn: clean[k] === true }))
  }
  const placed = [...sheetPlan].sort((x, y) => x.item - y.item)
  const marks = placed.map((c, i) => ({ ...(features[c.item] as PlotMark), t: (TA + 0.5 * i) * B }))
  const rectsOf = placed.map((c) => c.rect as PlotRect)
  const heroBeats = Array.from({ length: 11 }, (_, i) => TA + 0.5 * i)
  const smooth = (k: number): number => k * k * (3 - 2 * k)
  const silOf = (v: PlotAxo): P2[] => convex(Array.from({ length: hull.length / 3 }, (_, i) => axoPoint(v, [hull[3 * i] as number, hull[3 * i + 1] as number], hull[3 * i + 2] as number)))
  const turnClear = (turn: number): boolean => heroBeats.every((b) => {
    const v = { ...rideIso, psi: ridePsi - turn * (1 - smooth(clamp((b - TA) / TS, 0, 1))) }
    if (longUp && !longUpright(v.psi, v.e)) return false
    const poly = silOf(v)
    const pad = 6 * su
    const ends = rectsOf.map((r, i) => {
      const m = marks[i] as PlotMark
      const a = axoPoint(v, [m.x, m.y], m.z ?? 0)
      return [a, [clamp(a[0], r.x, r.x + r.w), clamp(a[1], r.y, r.y + r.h)]] as [P2, P2]
    })
    return rectsOf.every((r) => !rectHits({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }, poly)) && ends.every((l, i) => ends.slice(i + 1).every((o) => !segmentsCross(l, o)))
  })
  const wiggles = [12, -12, 8, -8, 4, -4].map((d) => face * d * D)
  const turnHides = (t: number): boolean => coverAlong(ridePsi - t, ridePsi) > CHIP_HIDE
  const firstTurn = wiggles.find(turnClear) ?? 0
  const turn = !avoid || !turnHides(firstTurn) ? firstTurn : wiggles.find((t) => turnClear(t) && !turnHides(t)) ?? (turnHides(0) ? firstTurn : 0)
  const moved = closeUp.moved || turn !== firstTurn
  const lidHidden = Math.max(coverAlong(ridePsi - turn, ridePsi), coverAlong(ridePsi, iso.psi))
  const psiAt = (b: number): number => ridePsi - turn * (1 - smooth(clamp((b - TA) / TS, 0, 1)))
  let turnSpan: [number, number] | undefined
  const viewOf = (b: number): PlotAxo => {
    const k = turnSpan === undefined ? 0 : smooth(clamp((b - turnSpan[0]) / Math.max(1e-6, turnSpan[1] - turnSpan[0]), 0, 1))
    const p = psiAt(b)
    return { ...rideIso, psi: p + Math.atan2(Math.sin(iso.psi - p), Math.cos(iso.psi - p)) * k, e: CLOSE_E + (iso.e - CLOSE_E) * k, k: iso.k * rideScale ** (1 - k) }
  }
  let holdDrift = HOLD_DRIFT
  const holdCam = (b: number): { x: number; y: number; zoom: number } => {
    const all = [hullBox(viewOf(b), hull)]
    const x0 = Math.min(...all.map((r) => r.x))
    const y0 = Math.min(...all.map((r) => r.y))
    const x1 = Math.max(...all.map((r) => r.x + r.w))
    const y1 = Math.max(...all.map((r) => r.y + r.h))
    const zoom = Math.max(1, Math.min((0.9 * W) / (x1 - x0), (0.9 * (H - strip)) / (y1 - y0))) * (1 + holdDrift * smooth(clamp((b - TA) / TS, 0, 1)))
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom }
  }
  const framedAll = (c: { x: number; y: number; zoom: number }, b: number): boolean => rectsOf.every((r, i) => {
    if (TA + 0.5 * i > b + 1e-9) return true
    const x = c.zoom * (r.x - c.x) + W / 2
    const y = c.zoom * (r.y - c.y) + H / 2
    return x >= 0.05 * W && y >= 0.05 * H && x + c.zoom * r.w <= 0.95 * W && y + c.zoom * r.h <= 0.95 * H
  })
  holdDrift = [HOLD_DRIFT, 0.04, 0.02, 0].find((d) => {
    holdDrift = d
    return [TA + 0.5, TA + 1, TA + 2].every((b) => framedAll(holdCam(b), b))
  }) ?? 0
  const routeCam = (b: number): { x: number; y: number; zoom: number } => {
    const cam = holdCam(b)
    const pin = flowSegs.at(-1)?.b
    if (pin === undefined) return cam
    const q = axoPoint(viewOf(b), pin, topOf(pin))
    const rb = detailR / Math.max(1e-6, detailAt.s)
    const zoom = Math.min(4 * cam.zoom, Math.max(cam.zoom, (0.7 * Math.min(W, H - strip)) / (2 * rb * viewOf(b).k)))
    return { x: q[0], y: q[1], zoom: zoom * (1 + 0.03 * clamp((b - detail.b0 - 1.5) / 1, 0, 1)) }
  }
  const pushIn = (b: number): { x: number; y: number; zoom: number } => {
    if (b <= detail.b0) return holdCam(b)
    const r = routeCam(b)
    if (b >= detail.b0 + 1.5) return r
    const c = holdCam(b)
    const k = settle(clamp((b - detail.b0) / 1.5, 0, 1))
    const zoom = c.zoom * (r.zoom / c.zoom) ** k
    const f = (zoom - c.zoom) / Math.max(1e-9, r.zoom - c.zoom)
    return { x: c.x + (r.x - c.x) * f, y: c.y + (r.y - c.y) * f, zoom }
  }
  const nearEnd = Math.min(beats.pull[0] - 1, detail.b0)
  const waveFrom = beats.lift[1] > beats.lift[0] ? beats.parts : beats.tilt[1]
  if (shotOf('detail') === undefined) turnSpan = [waveFrom + 0.7 * (nearEnd - waveFrom), beats.pull[1]]
  const heroSig = signalNets(inp.heroRef ?? '')
  const ends = (headers.length > 0 ? headers : comps.filter((f) => f.ref !== inp.heroRef && isConn(f)))
    .map((f) => ({ ref: f.ref, at: px(f.pos), nets: new Set([...signalNets(f.ref)].filter((nt) => heroSig.has(nt) || thingNets.has(nt))) }))
    .filter((q) => (q.nets.size >= 2 && q.ref !== entry?.ref) || q.ref === thingEnd?.footprintRef)
    .sort((a, b) => (b.ref === thingEnd?.footprintRef ? 1 : 0) - (a.ref === thingEnd?.footprintRef ? 1 : 0) || b.nets.size - a.nets.size)
    .filter((q, _, all) => q.ref === thingEnd?.footprintRef || q.nets.size >= BUS_SHARE * Math.max(...all.map((o) => o.nets.size)))
    .slice(0, ROUTE_ENDS)
  const taken = new Set<string | undefined>([inp.heroRef, ...ends.map((q) => q.ref)])
  type Hop = { ref: string; at: P2; nets: Set<number> }
  const sigOf = new Map(comps.map((f) => [f.ref, signalNets(f.ref)]))
  const shared = (a: string, b: string): Set<number> => new Set([...(sigOf.get(a) ?? [])].filter((nt) => sigOf.get(b)?.has(nt) === true))
  const reachOfNet = new Map<number, number>()
  for (const set of sigOf.values()) for (const nt of set) reachOfNet.set(nt, (reachOfNet.get(nt) ?? 0) + 1)
  const pointTo = (a: string, b: string): Set<number> => new Set([...shared(a, b)].filter((nt) => (reachOfNet.get(nt) ?? 0) <= ROUTE_POINT))
  const hopChains = new Map<string, Hop[]>([[inp.heroRef ?? '', []]])
  for (let depth = 0, rim = [inp.heroRef ?? '']; depth < ROUTE_HOPS && headers.length === 0; depth++) {
    const out: string[] = []
    for (const r of rim) {
      for (const f of comps) {
        if (hopChains.has(f.ref) || isConn(f)) continue
        const nets = pointTo(r, f.ref)
        if (nets.size === 0) continue
        hopChains.set(f.ref, [...(hopChains.get(r) ?? []), { ref: f.ref, at: px(f.pos), nets }])
        out.push(f.ref)
      }
    }
    rim = out
  }
  const inNets = entry === undefined || thingNets.size > 0 ? new Set<number>() : new Set([...signalNets(entry.ref)].filter((nt) => heroSig.has(nt)))
  const fromEntry = entry !== undefined && inNets.size >= 2 && planKind !== 'valve'
  const depthOf = (r: string): number => (r === inp.heroRef ? 0 : (hopChains.get(r)?.length ?? Infinity))
  const bankOf = (c: string): Set<number> => {
    const nets = new Set<number>()
    let rim = [...hopChains.keys()].filter((r) => r !== inp.heroRef && shared(r, c).size >= 2)
    for (const r of rim) for (const nt of shared(r, c)) nets.add(nt)
    const seen = new Set(rim)
    while (rim.length > 0) {
      const next: string[] = []
      for (const q of rim) {
        for (const r of hopChains.keys()) {
          if (depthOf(r) >= depthOf(q)) continue
          const via = pointTo(r, q)
          for (const nt of via) nets.add(nt)
          if (via.size > 0 && r !== inp.heroRef && !seen.has(r)) { seen.add(r); next.push(r) }
        }
      }
      rim = next
    }
    return nets
  }
  const reached = headers.length > 0 ? [] : comps.filter((c) => isConn(c) && !taken.has(c.ref) && (fromEntry || c.ref !== entry?.ref)).flatMap((c) => {
    const best = [...hopChains].filter(([r]) => r !== inp.heroRef).map(([r, chain]) => ({ chain, nets: shared(r, c.ref) })).filter((e) => e.nets.size >= 2).sort((a, b) => a.chain.length - b.chain.length || b.nets.size - a.nets.size)[0]
    return best === undefined ? [] : [{ ref: c.ref, at: px(c.pos), vias: best.chain, nets: best.nets, bank: bankOf(c.ref), own: signalNets(c.ref).size }]
  })
  const within = (a: Set<number>, b: Set<number>): boolean => [...a].every((nt) => b.has(nt))
  const ownBus = ends.some((q) => q.ref !== thingEnd?.footprintRef)
  const relays = ownBus ? [] : reached.filter((c) => !reached.some((d) => d !== c && within(c.bank, d.bank) && (d.bank.size > c.bank.size || d.own > c.own || (d.own === c.own && d.ref < c.ref)))).slice(0, Math.max(0, ROUTE_ENDS - ends.length))
  const tangled = relays.some((c) => c.vias.filter((h) => CHIP.test(h.ref)).length >= 2)
  const bus = !tangled ? undefined : comps.filter((f) => isConn(f) && f.ref !== inp.heroRef)
    .map((f) => ({ ref: f.ref, at: px(f.pos), nets: shared(inp.heroRef ?? '', f.ref) }))
    .sort((x, y) => y.nets.size - x.nets.size || x.ref.localeCompare(y.ref))[0]
  const busRide = bus !== undefined && bus.nets.size >= 2 ? bus : undefined
  const banks = new Set(busRide !== undefined ? [] : relays.flatMap((c) => [...c.bank]))
  const routeNets = busRide !== undefined ? new Set([...thingNets, ...busRide.nets]) : new Set([...(thingNets.size > 0 ? thingNets : [...inNets, ...ends.flatMap((q) => [...q.nets])]), ...banks])
  const routeTraces = Object.values(board.copper).flatMap((c) => c.traces).filter((t) => routeNets.has(t.netId ?? -1))
  const route: P2[] = [fromEntry ? px(entry.pos) : hero]
  const leg = (goal: P2, nets: Set<number>): void => {
    const cur = route[route.length - 1] as P2
    const d: P2 = [goal[0] - cur[0], goal[1] - cur[1]]
    const l2 = Math.max(1e-9, d[0] * d[0] + d[1] * d[1])
    const pts = routeTraces.filter((t) => nets.has(t.netId ?? -1) || thingNets.has(t.netId ?? -1)).flatMap((t) => t.points.map(px)).map((q) => ({ q, t: ((q[0] - cur[0]) * d[0] + (q[1] - cur[1]) * d[1]) / l2 })).filter((e) => e.t > 0.05 && e.t < 0.95)
    for (let k = 0; k < ROUTE_BINS; k++) {
      const bin = pts.filter((e) => e.t >= k / ROUTE_BINS && e.t < (k + 1) / ROUTE_BINS)
      if (bin.length > 0) route.push([bin.reduce((a, e) => a + e.q[0], 0) / bin.length, bin.reduce((a, e) => a + e.q[1], 0) / bin.length])
    }
    route.push(goal)
  }
  if (fromEntry) leg(hero, busRide?.ref === entry.ref ? busRide.nets : inNets)
  const routeEnds: string[] = fromEntry ? [entry.ref] : []
  const routeStops: Array<{ ref: string; at: P2; nets: Set<number>; vias?: Hop[] }> = busRide !== undefined ? (fromEntry && busRide.ref === entry.ref ? [] : [busRide]) : [...ends, ...relays.filter((r) => !fromEntry || r.ref !== entry.ref)]
  for (let left = routeStops; left.length > 0;) {
    const cur = route[route.length - 1] as P2
    const first = (q: typeof routeStops[number]): P2 => q.vias?.[0]?.at ?? q.at
    const next = left[0]?.ref === thingEnd?.footprintRef && routeEnds.length === 0 ? left[0] as typeof routeStops[number] : left.reduce((b, q) => (dist(first(q), cur) < dist(first(b), cur) ? q : b))
    left = left.filter((q) => q !== next)
    for (const hop of (next.vias ?? []).filter((v) => !routeEnds.includes(v.ref))) {
      routeEnds.push(hop.ref)
      leg(hop.at, hop.nets)
    }
    routeEnds.push(next.ref)
    leg(next.at, next.nets)
  }
  const smoothRoute = route.map((q, i) => (i === 0 || i === route.length - 1 ? q : [((route[i - 1] as P2)[0] + 2 * q[0] + (route[i + 1] as P2)[0]) / 4, ((route[i - 1] as P2)[1] + 2 * q[1] + (route[i + 1] as P2)[1]) / 4] as P2))
  const camEnd = Math.max(nearEnd, Math.min(beats.pull[0] - 0.25, detail.b0))
  const keyEnd = shotOf('detail') === undefined ? nearEnd : beats.pull[0]
  const wave = drawWave(inp.parts, flowSegs[0]?.a ?? hero, waveFrom, nearEnd, planKind === 'valve' ? beats.tilt[0] - 2 * BODY_DRAW : beats.lift[1] > beats.lift[0] ? waveFrom : beats.tilt[0] + 0.4, smoothRoute, ROUTE_REACH * Math.hypot(bw, bh), camEnd)
  const trail: PlotFlowSeg[] = wave.when === undefined || planKind === 'header' ? [] : ((kept) => routeTraces.filter((t) => kept.has(t.netId ?? -1)))(thinTrail(routeTraces, thingNets, (TRAIL_APART * u) / (NEAR * Math.min((0.88 * W) / bw, (0.84 * H) / bh) * inp.pxPerMm), (net) => polarity(board.nets.find((n) => n.id === net)?.name ?? '')?.base)).flatMap((t) => t.points.slice(1).map((q, i): PlotFlowSeg => {
    const a = px(t.points[i] as Vec2)
    const b = px(q)
    const when = wave.when as (q: P2) => number
    const [ta, tb] = [when(a), when(b)].map((w) => Math.max(beats.tilt[0] + 0.5, w - TRAIL_LEAD)) as [number, number]
    return ta <= tb ? { a, b, w: t.width * ppm, p0: ta * B, p1: Math.max(tb, ta + 0.05) * B, kind: 'trace' } : { a: b, b: a, w: t.width * ppm, p0: tb * B, p1: Math.max(ta, tb + 0.05) * B, kind: 'trace' }
  }))
  const sentence = ((): string => {
    const value = partNumber(heroFp?.value) || heroLabel
    if (sigData.kind === 'pair') {
      const ends = [...new Set(Object.values(board.copper).flatMap((c) => c.pads).filter((q) => thingNets.has(q.netId ?? -1)).flatMap((q) => (q.footprintRef === undefined ? [] : [q.footprintRef])))].sort((x, y) => (x === inp.heroRef ? -1 : y === inp.heroRef ? 1 : 0))
      const run = (sigData.lengthsMm[0] + sigData.lengthsMm[1]) / 2
      const out = new Set(relays.flatMap((c) => [...hopChains.keys()].filter((r) => r !== inp.heroRef).flatMap((r) => (shared(r, c.ref).size >= 2 ? [...shared(r, c.ref)] : [])))).size
      if (relays.length > 0 && out >= 2 && ends.length === 2) return `A PAIR TO ${thingEnd?.footprintRef ?? ends[1]}. ${out} SIGNALS TO ${relays.length <= 2 ? relays.map((c) => c.ref).join(', ') : `${relays.length} PORTS`}.`
      return `A MATCHED PAIR, ${run.toFixed(1)} MM${ends.length === 2 ? `, ${ends[0]} TO ${ends[1]}` : ''}.`
    }
    if (sigData.kind === 'header') {
      const same = comps.filter((f) => CONN.test(f.ref) && f.value === board.footprints.find((q) => q.ref === sigData.ref)?.value).length
      return `${same} ${sigData.value.toUpperCase()} HEADER${same === 1 ? '' : 'S'}. ${Math.max(...headers.map((f) => signalNets(f.ref).size), 0)} SIGNALS ${same === 1 ? '' : 'EACH'}`.trim() + '.'
    }
    if (sigData.kind === 'travel') {
      const ports = comps.filter((f) => CONN.test(f.ref) && /^USB\d+$/i.test(f.value ?? '')).length
      return `${ports > 1 ? 'A USB HUB' : 'A STICK'}. ${(Math.min(bw, bh) / ppm).toFixed(1)} MM WIDE.`
    }
    if (sigData.kind === 'section') return `AN ${value} ON ${socketPins} PINS.`
    if (busRide !== undefined) return fromEntry && busRide.ref === entry.ref ? `${busRide.nets.size} SIGNALS FROM ${busRide.ref} TO ${value}.` : `${busRide.nets.size} SIGNALS FROM ${value} TO ${busRide.ref}.`
    const ports = [...ends.map((q) => q.ref), ...relays.map((c) => c.ref)]
    const reach = new Set([...ends.flatMap((q) => [...q.nets]), ...relays.flatMap((c) => [...hopChains.keys()].flatMap((r) => (shared(r, c.ref).size >= 2 ? [...shared(r, c.ref)] : [])))]).size
    if (ports.length > 0 && reach >= 2) return `${reach} SIGNALS FROM ${value} TO ${ports.length <= 3 ? [...ports].sort((x, y) => x.localeCompare(y, 'en', { numeric: true })).join(', ') : `${ports.length} PORTS`}.`
    return ''
  })()
  const heroB = bodies.find((q) => q.hero === true)
  const heroSpan = heroB === undefined ? undefined : hullBox(viewOf(TA), bodyCorners(heroB).flatMap((q) => [q[0], q[1], 0, q[0], q[1], heroB.z]))
  const objBox = hullBox(viewOf(TA), hull)
  const close = heroSpan === undefined ? NEAR : clamp(0.8 / Math.max(heroSpan.w / objBox.w, heroSpan.h / objBox.h), planKind === 'valve' ? 1.15 : 1.6, planKind === 'valve' ? 1.8 : NEAR)
  const tall = clamp((H - strip) / (objBox.h * pushIn(beats.tilt[1]).zoom * close), 1, LAND_TALL)
  const nearest = (b: number): number => close * tall ** (1 - smooth(clamp((b - beats.tilt[1]) / Math.max(1e-6, 0.5 * (nearEnd - beats.tilt[1])), 0, 1)))
  const drawCam = (b: number): { x: number; y: number; zoom: number } => {
    const c = pushIn(b)
    if (wave.front === undefined || b >= nearEnd) return c
    const q = wave.front(b)
    const h = axoPoint(viewOf(b), q, 0)
    const back = smooth(clamp((b - waveFrom - 0.7 * (nearEnd - waveFrom)) / (0.3 * (nearEnd - waveFrom)), 0, 1))
    const into = beats.lift[1] > beats.lift[0] ? smooth(clamp((b - waveFrom + 0.25) / 1.75, 0, 1)) : 1
    const f = into * (1 - back)
    const zoom = c.zoom * nearest(b) ** f * (fromEntry ? 1 + 0.35 * Math.sin(Math.PI * clamp((b - waveFrom) / 2.5, 0, 1)) ** 2 : 1)
    const ob = hullBox(viewOf(b), hull)
    const inside = (v: number, lo: number, size: number, half: number): number => (size <= 2 * half ? lo + size / 2 : clamp(v, lo + half, lo + size - half))
    const x = inside(c.x + (h[0] - c.x) * f, ob.x, ob.w, (0.45 * W) / zoom)
    const y = inside(c.y + (h[1] - c.y) * f, ob.y, ob.h, (0.4 * H) / zoom)
    const fill = ob.y + ob.h - ((FILL_LOW - 0.5) * H) / zoom
    const lifted = Math.max(fill, h[1] - (0.4 * H) / zoom)
    const blend = (a: number, t: number): number => a + (t - a) * f
    return { x: blend(c.x, x), y: blend(c.y, Math.min(y, lifted)), zoom }
  }
  const camFrom = beats.lift[1] > beats.lift[0] ? TA : beats.tilt[1]
  const push = pushIn(16).zoom / holdCam(16).zoom - 1
  const box = hullBox(viewOf(TA), hull)
  const stacked = beats.lift[1] > beats.lift[0]
  const column = !stacked ? 0 : Math.max(...stackLabelRows(facts0.parts, stack).map((r) => calloutSize(r.text, r.sub, su, FILM_TEXT, FILM_SUB).w)) + (CALL_GAP + 30) * u
  const n = stack.length
  const lifts = stacked ? n - 1 + 0.8 : 0
  const Hs = H - strip
  const gapS = (0.068 * minWH * H) / (Hs - 0.012 * minWH)
  const zoom = Math.min(((stacked ? 0.8 : 0.88) * W) / box.w, ((stacked ? 0.7 : 0.84) * Hs) / box.h, (W - column - 0.06 * W) / box.w, (0.84 * Hs - lifts * 0.068 * minWH) / box.h)
  const room = Math.max(lifts * gapS, 0.84 * Hs - zoom * box.h)
  const gap = Math.max(gapS / (zoom * iso.k * Math.cos(CLOSE_E)), Math.min(0.3 * Math.max(bw, bh), room / Math.max(1e-6, zoom * iso.k * Math.cos(CLOSE_E) * lifts)))
  const lift = (lifts * gap * iso.k * Math.cos(CLOSE_E)) / 2
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2

  const open1 = ((): { look: P2; zoom: number } => {
    const pts = nibStrokes.filter((st) => st.t1 <= nb1 * B).flatMap((st) => Array.from({ length: st.path.length / 2 }, (_, i) => rot([(st.path[2 * i] as number) - look1[0], (st.path[2 * i + 1] as number) - look1[1]], yaw1)))
    if (pts.length < 2) return { look: look1, zoom: z1 }
    const x0 = Math.min(...pts.map((q) => q[0]))
    const x1 = Math.max(...pts.map((q) => q[0]))
    const y0 = Math.min(...pts.map((q) => q[1]))
    const y1 = Math.max(...pts.map((q) => q[1]))
    const zoom = clamp(Math.min((OPEN_FILL * W) / Math.max(1e-6, x1 - x0), (OPEN_FILL * H) / Math.max(1e-6, y1 - y0)) / 1.05, z1, 2.5 * z1)
    const c = rot([(x0 + x1) / 2, (y0 + y1) / 2], -yaw1)
    return { look: [look1[0] + c[0], look1[1] + c[1]], zoom }
  })()
  const E = 0.001
  const flat = { tilt: 0, aperture: 0 }
  const pairBack = z2 * (z3 / z2) ** PAIR_BACK
  const squeeze = (nameStrip(W, H).y - 0.012 * Math.min(W, H)) / H
  const centred = (q: P2, z: number): P2 => [q[0], q[1] - (H * (1 - squeeze)) / (2 * squeeze * z)]
  const pt = (p: P2): { x: number; y: number } => ({ x: p[0], y: p[1] })
  const travel = shotOf('outline')
  const smoothT = (k: number): number => k * k * (3 - 2 * k)
  const zChip = Math.max(TRAVEL_HIDE * z3, (TRAVEL_HERO * (H - strip)) / heroSize)
  const travelFrom: { at: P2; zoom: number; yaw: number } = planKind === 'pair' ? { at: centred(look2, pairBack), zoom: pairBack, yaw: yaw2 }
    : plan.some((q) => q.kind === 'macro') ? { at: [look2[0] + drift[0], look2[1] + drift[1]], zoom: z2 * 1.03, yaw: yaw2 }
      : { at: flowSegs.reduce<P2>((f, sg) => (dist(sg.a, hero) > dist(f, hero) ? sg.a : f), hero), zoom: 1.4 * zChip, yaw: planYaw }
  const zLand = planKind === 'pair' ? Math.max(TRAVEL_HIDE * z3, Math.min(PAIR_HERO * (H - strip), (PAIR_WIDE * W) / squeeze) / heroSize) : Math.max(TRAVEL_HIDE * z3, clamp(zChip, travelFrom.zoom / TRAVEL_SPAN, travelFrom.zoom * TRAVEL_SPAN))
  const zHold = ((): number => {
    const q = inp.parts.find((x) => x.hero === true)
    if (ridePath === undefined || q === undefined) return 0
    const [co, si] = [Math.cos(planYaw), Math.sin(planYaw)]
    const cs = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as P2[]).map(([u, v]): P2 => [(Math.cos(q.rot) * u * q.w - Math.sin(q.rot) * v * q.h) / 2, (Math.sin(q.rot) * u * q.w + Math.cos(q.rot) * v * q.h) / 2])
    const xs = cs.map(([x, y]) => co * x - si * y)
    const ys = cs.map(([x, y]) => si * x + co * y)
    return (Math.min(W, H) / squeeze) * Math.max(HOLD_CHIP / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), HOLD_SIDE / Math.min(q.w, q.h))
  })()
  const zEnd = Math.max(zLand, zHold)
  const d0 = Math.max(1, dist(travelFrom.at, hero))
  const wayPts = flowSegs.flatMap((sg) => [sg.a, sg.b]).filter((q) => dist(q, hero) < d0)
  const wayWin = (0.12 * W) / zEnd
  const chain: P2[] = [travelFrom.at]
  for (let left = wayPts; left.length > 0;) {
    const cur = chain[chain.length - 1] as P2
    const next = left.reduce((x, y) => (dist(y, cur) < dist(x, cur) ? y : x))
    left = left.filter((q) => q !== next && dist(q, next) > 1e-6)
    if (dist(next, hero) < dist(cur, hero) + wayWin) chain.push(next)
  }
  chain.push(hero)
  const chainCum = chain.reduce<number[]>((c, q, i) => [...c, i === 0 ? 0 : (c[i - 1] as number) + dist(chain[i - 1] as P2, q)], [])
  const chainLen = Math.max(1e-6, chainCum.at(-1) as number)
  const onChain = (sv: number): P2 => {
    const i = Math.max(1, chainCum.findIndex((c) => c >= sv))
    const a = chain[i - 1] as P2
    const b = chain[Math.min(i, chain.length - 1)] as P2
    const k = clamp((sv - (chainCum[i - 1] as number)) / Math.max(1e-9, (chainCum[i] as number) - (chainCum[i - 1] as number)), 0, 1)
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
  }
  const wayAt = (f: number): P2 => {
    const sv = f * chainLen
    const n = 9
    const win = Math.min(wayWin, sv, chainLen - sv)
    const pts = Array.from({ length: n }, (_, i) => onChain(clamp(sv + win * (i / (n - 1) - 0.5) * 2, 0, chainLen)))
    return [pts.reduce((t, q) => t + q[0], 0) / n, pts.reduce((t, q) => t + q[1], 0) / n]
  }
  const chainAt = (q: P2): number => (chainCum[chain.reduce((k, c, i) => (dist(c, q) < dist(chain[k] as P2, q) ? i : k), 0)] as number) / chainLen
  const bends = flowSegs.flatMap((x) => flowSegs.filter((y) => y !== x && dist(x.b, y.a) < 0.05 * ppm).map((y) => ({ at: x.b, turn: wrap(Math.atan2(y.b[1] - y.a[1], y.b[0] - y.a[0]) - Math.atan2(x.b[1] - x.a[1], x.b[0] - x.a[0])), len: Math.min(dist(x.a, x.b), dist(y.a, y.b)) })))
    .filter((q) => Math.abs(q.turn) / D >= 30 && q.len >= 1.5 * ppm && dist(q.at, hero) < d0)
    .map((q) => ({ ...q, s: chainAt(q.at) }))
    .filter((q, i, all) => all.findIndex((o) => Math.abs(o.s - q.s) < 0.05) === i)
  const bump = (sv: number, c: number, w: number): number => Math.exp(-(((sv - c) / w) ** 2))
  const pace = (sv: number): number => Math.max(0.3, 1 - 0.7 * Math.max(0, ...bends.map((q) => bump(sv, q.s, 0.06))))
  const paced = Array.from({ length: 201 }, (_, j) => j / 200).reduce<number[]>((c, sv, j) => [...c, j === 0 ? 0 : (c[j - 1] as number) + 1 / pace(sv - 1 / 400)], [])
  const warp = (k: number): number => {
    const want = k * (paced.at(-1) as number)
    const j = Math.max(1, paced.findIndex((c) => c >= want))
    const lo = paced[j - 1] as number
    return (j - 1 + (want - lo) / Math.max(1e-9, (paced[j] as number) - lo)) / 200
  }
  const zRise = Math.max(zHold, Math.min(zEnd, Math.max(zEnd / FAN_RISE, 1.4 * z3)))
  const zWide = planKind === 'pair' ? Math.min(travelFrom.zoom, zEnd / TRAVEL_CLOSER) : Math.min(travelFrom.zoom, zEnd)
  const zAlong = (f: number): number => (planKind !== 'pair' ? travelFrom.zoom * (zEnd / travelFrom.zoom) ** f : f < TRAVEL_WIDE_AT ? travelFrom.zoom * (zWide / travelFrom.zoom) ** smoothT(f / TRAVEL_WIDE_AT) : zWide * (zEnd / zWide) ** smoothT((f - TRAVEL_WIDE_AT) / (1 - TRAVEL_WIDE_AT)))
  const sigWs = (planKind === 'pair' ? busStrokes.map((st) => st.w) : flowSegs.filter((sg) => sg.plane !== true).map((sg) => sg.w)).filter((w) => w > 0)
  const underChip = (whole: RideLine): { line: RideLine; cut: number } => {
    const hp = inp.parts.find((x) => x.hero === true)
    if (hp === undefined) return { line: whole, cut: 0 }
    const [co, si] = [Math.cos(hp.rot), Math.sin(hp.rot)]
    const inBody = (q: P2): boolean => Math.abs(co * (q[0] - hp.x) + si * (q[1] - hp.y)) < hp.w / 2 && Math.abs(-si * (q[0] - hp.x) + co * (q[1] - hp.y)) < hp.h / 2
    for (let i = 0; i + 1 < whole.pts.length; i++) {
      const [a, b] = [whole.pts[i] as P2, whole.pts[i + 1] as P2]
      const [da, db] = [whole.toChip[i] as number, whole.toChip[i + 1] as number]
      const j = Array.from({ length: 33 }, (_, n) => n / 32).find((k) => inBody([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]))
      if (j === undefined) continue
      const cut = da + (db - da) * j
      if (cut < RIDE_CLEAR * ppm) return { line: whole, cut: 0 }
      return { line: { pts: [...whole.pts.slice(0, i + 1), [a[0] + (b[0] - a[0]) * j, a[1] + (b[1] - a[1]) * j]], toChip: [...whole.toChip.slice(0, i + 1).map((c) => c - cut), 0] }, cut }
    }
    return { line: whole, cut: 0 }
  }
  const zSig = sigWs.length > 0 ? Math.max((1.03 * SIGNAL_WIDE * W) / Math.min(...sigWs), W / (RIDE_SPAN * ppm)) : 0
  let zRide = zSig
  let closer = false
  const rideZoom = (gone: number): number => {
    if (zSig <= 0) return zAlong(smoothT(Math.min(1, gone)))
    if (closer) {
      const g1 = Math.max(0, 1 - RIDE_OPEN / Math.max(1e-6, rideLand - rideB0))
      const m = smoothT(clamp((gone - g1) / Math.max(1e-6, 1 - g1), 0, 1))
      const k = smoothT(clamp((gone - 1) / RIDE_OVER, 0, 1))
      return (zRide ** (1 - m) * zSig ** m) ** (1 - k) * zEnd ** k
    }
    const k = smoothT(clamp((gone - RIDE_CLOSE) / (1 + RIDE_OVER - RIDE_CLOSE), 0, 1))
    return zSig ** (1 - k) * zEnd ** k
  }
  const rideFrom = ou0 - RIDE_DRAWN
  const rideLand = travel === undefined ? ou1 : travel.b1 - TRAVEL_HOLD
  type RideLine = { pts: P2[]; toChip: number[] }
  const lineAt = (line: RideLine, sv: number): P2 => {
    const { pts, toChip } = line
    const i = Math.max(1, toChip.findIndex((c) => c <= sv))
    const a = pts[i - 1] as P2
    const b = pts[Math.min(i, pts.length - 1)] as P2
    const k = clamp(((toChip[i - 1] as number) - sv) / Math.max(1e-9, (toChip[i - 1] as number) - (toChip[Math.min(i, pts.length - 1)] as number)), 0, 1)
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
  }
  const rideB0 = travel?.b0 ?? rideFrom
  const rideGone = (b: number): number => clamp((b - rideB0) / Math.max(1e-6, rideLand - rideB0), 0, 1)
  const rideDone = (s0: number, pre: number, b: number): number => (b < rideB0 ? pre - ((s0 - pre) * ridePeak(0) * (rideB0 - b)) / Math.max(1e-6, rideLand - rideB0) : pre + (s0 - pre) * rideEase(rideGone(b), 0))
  const heroCorners = ((): P2[] => {
    const q = inp.parts.find((x) => x.hero === true)
    if (q === undefined) return []
    return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as P2[]).map(([u, v]): P2 => [q.x + (Math.cos(q.rot) * u * q.w - Math.sin(q.rot) * v * q.h) / 2, q.y + (Math.sin(q.rot) * u * q.w + Math.cos(q.rot) * v * q.h) / 2])
  })()
  const bodyShare = (at: P2, zoom: number): number => {
    const k = squeeze * zoom
    const [co, si] = [Math.cos(planYaw), Math.sin(planYaw)]
    let poly = heroCorners.map(([x, y]): P2 => [co * (x - at[0]) * k - si * (y - at[1]) * k, si * (x - at[0]) * k + co * (y - at[1]) * k])
    for (const [ax, sg, lim] of [[0, 1, W / 2], [0, -1, W / 2], [1, 1, H - (squeeze * H) / 2], [1, -1, (squeeze * H) / 2]] as Array<[0 | 1, number, number]>) {
      const inside = (v: P2): boolean => sg * v[ax] <= lim
      const out: P2[] = []
      poly.forEach((a, i) => {
        const c = poly[(i + 1) % poly.length] as P2
        if (inside(a)) out.push(a)
        if (inside(a) !== inside(c)) {
          const t = (sg * lim - a[ax]) / (c[ax] - a[ax])
          out.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t])
        }
      })
      poly = out
    }
    const area = Math.abs(poly.reduce((t, a, i) => { const c = poly[(i + 1) % poly.length] as P2; return t + a[0] * c[1] - c[0] * a[1] }, 0)) / 2
    return area / (W * H)
  }
  const rideCams = new Map<string, (b: number) => { at: P2; zoom: number }>()
  const rideCam = (line: RideLine, s0: number, pre: number, capped = true): ((b: number) => { at: P2; zoom: number }) => {
    const key = `${line.pts.length}:${s0}:${pre}:${capped}:${zRide}:${closer}`
    const hit = rideCams.get(key)
    if (hit !== undefined) return hit
    const most = Math.min(pre, (RIDE_LAG * (closer ? Math.max(W, H) : Math.min(W, H))) / (squeeze * rideZoom(0)))
    const note = Math.min(0.5, RIDE_NOTE / Math.max(1e-6, rideLand - rideB0))
    const lag = (x: number): number => (closer ? most * (1 - x) : x < note ? most * (0.5 + 0.5 * smoothT(x / note)) : most * (1 - smoothT((x - note) / (1 - note))))
    const pad = line.pts.at(-1) ?? hero
    const view = (b: number): { head: P2; shift: number; zoom: number } => {
      const gone = rideGone(b)
      const zoom = rideZoom(Math.max(0, (b - rideB0) / Math.max(1e-6, rideLand - rideB0)))
      const near = Array.from({ length: 9 }, (_, i) => {
        const x = Math.min(rideLand, b + RIDE_SMOOTH * (i / 4 - 1))
        return lineAt(line, s0 - Math.max(0, rideDone(s0, pre, x) - lag(rideGone(x))))
      })
      const head: P2 = [near.reduce((t, q) => t + q[0], 0) / 9, near.reduce((t, q) => t + q[1], 0) / 9]
      const shift = Math.max(0, 1 - (RIDE_HOME * W * (1 - gone) * (rideLand - rideB0) * 0.5) / Math.max(1e-9, dist(pad, hero) * squeeze * zoom))
      return { head, shift, zoom }
    }
    const step = 1 / 30
    const grid = Array.from({ length: Math.max(1, Math.ceil(((1 + RIDE_OVER) * (rideLand - rideB0)) / step)) + 1 }, (_, i) => Math.min(rideLand + RIDE_OVER * (rideLand - rideB0), rideB0 + i * step))
    const along = (v: { head: P2; shift: number }, g: number): P2 => {
      const f = g >= 0 ? v.shift * g : g
      return [v.head[0] + (hero[0] - pad[0]) * f, v.head[1] + (hero[1] - pad[1]) * f]
    }
    const raw = grid.map((x) => {
      const v = view(x)
      const fits = (g: number): boolean => bodyShare(along(v, g), v.zoom) <= RIDE_BODY
      if (!capped || heroCorners.length === 0 || fits(1)) return 1
      let [lo, hi] = [-RIDE_BACK, 1]
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        if (fits(mid)) lo = mid
        else hi = mid
      }
      return lo
    })
    const cam = (b: number): { at: P2; zoom: number } => {
      const v = view(b)
      const rate = (RIDE_SLIDE * W) / Math.max(1e-9, dist(pad, hero) * squeeze * v.zoom)
      const g0 = grid.reduce((m, x, i) => Math.min(m, (raw[i] as number) + rate * Math.abs(b - x)), 1)
      const g = g0 + (1 - g0) * smoothT(clamp((b - rideLand) / (TRAVEL_HOLD - 1), 0, 1))
      return { at: along(v, g), zoom: v.zoom }
    }
    rideCams.set(key, cam)
    return cam
  }
  const ridePace = (line: RideLine, s0: number, pre: number): number => {
    const cam = rideCam(line, s0, pre, false)
    const step = 1 / 15
    let most = 0
    for (let b = rideB0; b + step <= rideLand + 1e-9; b += step) {
      const [c0, c1] = [cam(b), cam(b + step)]
      most = Math.max(most, (dist(c0.at, c1.at) * squeeze * c1.zoom) / (step * 0.5 * W))
    }
    return most
  }
  type RideStart = { line: RideLine; s0: number; pre: number; name: string; cut: number }
  const startAt = (): RideStart | undefined => {
    if (ridePath === undefined) return undefined
    const best = [{ key: ridePath.goal.key, d: ridePath.goal.d, name: ridePath.end }, ...ridePath.named].reduce((x, y) => (y.d > x.d ? y : x))
    const q0 = ridePath.far.d > best.d + 0.5 * ppm ? { ...ridePath.far, name: 'END' } : best
    const { line, cut } = underChip(ridePath.line(q0.key))
    const q = { ...q0, d: q0.d - cut }
    const shown = (pre: number): number => {
      const cam = rideCam(line, q.d, pre, false)(rideB0)
      const k = squeeze * cam.zoom
      const on = Array.from({ length: 41 }, (_, i) => lineAt(line, q.d - (pre * i) / 40)).map((v): P2 => [clamp((v[0] - cam.at[0]) * k, -W / 2, W / 2), clamp((v[1] - cam.at[1]) * k, -H / 2, H / 2)])
      return Math.max(Math.max(...on.map((v) => v[0])) - Math.min(...on.map((v) => v[0])), Math.max(...on.map((v) => v[1])) - Math.min(...on.map((v) => v[1]))) / Math.max(W, H)
    }
    let lo = 0
    let hi = q.d
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (shown(mid) >= RIDE_SEEN) hi = mid
      else lo = mid
    }
    lo = hi
    hi = q.d
    if (ridePace(line, q.d, lo) > RIDE_HEADROOM * RIDE_PACE) {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        if (ridePace(line, q.d, mid) <= RIDE_HEADROOM * RIDE_PACE) hi = mid
        else lo = mid
      }
      lo = hi
    }
    return { line, s0: q.d, pre: lo, name: q.name, cut }
  }
  const rideStart = ((): RideStart | undefined => {
    const wide = startAt()
    if (wide === undefined || heroCorners.length === 0) return wide
    const span = Math.max(1e-6, rideLand - rideB0)
    const rim = heroCorners.flatMap((q, i) => Array.from({ length: 16 }, (_, k): P2 => {
      const n = heroCorners[(i + 1) % heroCorners.length] as P2
      return [q[0] + ((n[0] - q[0]) * k) / 16, q[1] + ((n[1] - q[1]) * k) / 16]
    }))
    const middle: P2 = [heroCorners.reduce((t, q) => t + q[0], 0) / 4, heroCorners.reduce((t, q) => t + q[1], 0) / 4]
    const inked = (r: RideStart): number => {
      const when = (sv: number): number => {
        const done = r.s0 - sv
        if (done <= r.pre) return rideB0 - ((r.pre - done) * span) / Math.max(1e-9, (r.s0 - r.pre) * ridePeak(0))
        let [lo, hi] = [0, 1]
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2
          if (r.pre + (r.s0 - r.pre) * rideEase(mid, 0) < done) lo = mid
          else hi = mid
        }
        return rideB0 + hi * span
      }
      const n = 80
      const marks = Array.from({ length: n + 1 }, (_, i) => (r.s0 * (n - i)) / n).map((sv) => ({ at: lineAt(r.line, sv), b: when(sv), sv }))
      const waves = marks.slice(1).map((q, i) => {
        const p = marks[i] as (typeof marks)[number]
        const z = rideZoom(clamp((q.b - rideB0) / span, 0, 1))
        return { at: q.at, b: q.b, v: Math.min((RIDE_SPREAD * Math.hypot(W, H)) / (2 * z), (RIDE_WAKE * (p.sv - q.sv)) / Math.max(1e-9, q.b - p.b)) }
      })
      return Math.min(...waves.map((w) => w.b + dist(middle, w.at) / w.v))
    }
    const seen = (r: RideStart, reach: number, b: number): boolean => {
      if (reach > b) return false
      const v = rideCam(r.line, r.s0, r.pre, false)(b)
      const k = squeeze * v.zoom
      const [co, si] = [Math.cos(planYaw), Math.sin(planYaw)]
      return rim.some((q) => {
        const [x, y] = [co * (q[0] - v.at[0]) * k - si * (q[1] - v.at[1]) * k, si * (q[0] - v.at[0]) * k + co * (q[1] - v.at[1]) * k]
        return Math.abs(x) <= W / 2 && y >= (-squeeze * H) / 2 && y <= H - (squeeze * H) / 2
      })
    }
    const reach = inked(wide)
    let early = false
    for (let b = rideB0; b <= rideLand - RIDE_LATE && !early; b += 1 / 15) early = seen(wide, reach, b)
    if (!early) return wide
    closer = true
    const late = (c: number): RideStart | undefined => {
      zRide = c * zSig
      const r = startAt()
      if (r === undefined) return undefined
      const reach = inked(r)
      for (let b = rideB0; b <= rideLand - RIDE_LATE; b += 1 / 15) if (seen(r, reach, b)) return undefined
      return r
    }
    const c = Array.from({ length: 20 }, (_, i) => 1 + ((RIDE_CLOSER - 1) * (i + 1)) / 20).find((x) => late(x) !== undefined)
    if (c === undefined) {
      closer = false
      zRide = zSig
      return wide
    }
    zRide = c * zSig
    return startAt()
  })()
  const rideS0 = rideStart?.s0 ?? 0
  const ridePre = rideStart?.pre ?? 0
  const rideLine = rideStart?.line
  const rideCut = rideStart?.cut ?? 0
  const rideWhen = (sv: number): number => {
    if (sv < rideCut) return rideLand + (RIDE_UNDER * (rideCut - sv)) / Math.max(1e-9, rideCut)
    const done = rideS0 - (sv - rideCut)
    if (done <= ridePre) return rideB0 - ((ridePre - done) * Math.max(1e-6, rideLand - rideB0)) / Math.max(1e-9, (rideS0 - ridePre) * ridePeak(0))
    let lo = 0
    let hi = 1
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (ridePre + (rideS0 - ridePre) * rideEase(mid, 0) < done) lo = mid
      else hi = mid
    }
    return rideB0 + hi * (rideLand - rideB0)
  }
  if (ridePath !== undefined) {
    flowSegs.forEach((sg, i) => {
      const [da, db] = ridePath.segD[i] as [number, number]
      if (!Number.isFinite(da) || !Number.isFinite(db)) return
      const [a, b, far, near] = da >= db ? [sg.a, sg.b, da, db] : [sg.b, sg.a, db, da]
      const p0 = rideWhen(far) * B
      Object.assign(sg, { a, b, p0, p1: Math.max(rideWhen(near) * B, p0 + 0.002) })
    })
  }
  const pairPace = ((): { map: (g: number) => number; cut?: number } => {
    if (planKind !== 'pair' || travel === undefined) return { map: (g) => g }
    const n = 400
    const state = (g: number): { at: P2; zoom: number } => {
      const f = warp(smoothT(g ** TRAVEL_BUILD))
      return { at: wayAt(f), zoom: zAlong(f) * Math.max(1, zSig / zAlong(f)) ** (1 - smoothT(clamp((g - RIDE_CLOSE) / (1 - RIDE_CLOSE), 0, 1))) }
    }
    const run = Array.from({ length: n + 1 }, (_, i) => state(i / n)).reduce<number[]>((c, q, i, all) => [...c, i === 0 ? 0 : (c[i - 1] as number) + (dist((all[i - 1] as typeof q).at, q.at) * squeeze * q.zoom) / W], [])
    const total = run.at(-1) as number
    const span = travel.b1 - TRAVEL_HOLD - travel.b0
    const whole = (total * ridePeak(PAIR_REST)) / (span * 0.5) <= 0.85 * RIDE_PACE
    const held = whole ? 0 : Math.min(0.5, PAIR_READ / span)
    const most = (0.85 * RIDE_PACE * (1 - held) * span * 0.5) / ridePeak(PAIR_REST)
    const cut = whole ? 0 : ((): number => {
      const k = Math.max(1, run.findIndex((c) => c >= total - most))
      const via = flowVias.map((v) => run.findIndex((_, i) => dist(state(i / n).at, v) < (0.02 * W) / state(i / n).zoom)).filter((i) => i >= k).sort((x, y) => x - y)[0]
      return run[via ?? k] as number
    })()
    const map = (g: number): number => {
      const want = g < held ? 0 : cut + (total - cut) * rideEase((g - held) / (1 - held), PAIR_REST)
      const j = Math.max(1, run.findIndex((c) => c >= want))
      const lo = run[j - 1] as number
      return clamp((j - 1 + (want - lo) / Math.max(1e-12, (run[j] as number) - lo)) / n, 0, 1)
    }
    return whole ? { map } : { map, cut: travel.b0 + held * span }
  })()
  const travelCam = (b: number): { at: P2; zoom: number; yaw: number } => {
    if (travel === undefined) return { at: hero, zoom: zEnd, yaw: planYaw }
    if (rideLine !== undefined) {
      const rise = smoothT(clamp((b - (travel.b1 - TRAVEL_HOLD + 1)) / (TRAVEL_HOLD - 1), 0, 1))
      const c = rideCam(rideLine, rideS0, ridePre)(b)
      return { at: c.at, zoom: c.zoom * (zRise / zEnd) ** rise, yaw: travelFrom.yaw + wrap(planYaw - travelFrom.yaw) * smoothT(clamp((b - travel.b0) / 1.5, 0, 1)) }
    }
    const gone = pairPace.map(clamp((b - travel.b0) / Math.max(1e-6, travel.b1 - TRAVEL_HOLD - travel.b0), 0, 1))
    const f = warp(smoothT(planKind === 'pair' ? gone ** TRAVEL_BUILD : gone))
    const rise = smoothT(clamp((b - (travel.b1 - TRAVEL_HOLD + 1)) / (TRAVEL_HOLD - 1), 0, 1))
    const lean = bends.reduce((t, q) => t + 0.15 * q.turn * bump(f, q.s, 0.12), 0) * (1 - smoothT(clamp((f - 0.85) / 0.15, 0, 1)))
    const close = Math.max(1, zSig / zAlong(f)) ** (1 - smoothT(clamp((gone - RIDE_CLOSE) / (1 - RIDE_CLOSE), 0, 1)))
    return { at: wayAt(f), zoom: zAlong(f) * close * (zRise / zEnd) ** rise, yaw: travelFrom.yaw + wrap(planYaw - travelFrom.yaw) * smoothT(clamp((b - travel.b0) / 1.5, 0, 1)) + lean }
  }
  if (travel !== undefined && planKind === 'pair' && thingEnd !== undefined) {
    const land = travel.b1 - TRAVEL_HOLD
    const near = Math.min(...flowSegs.flatMap((sg) => [dist(sg.a, hero), dist(sg.b, hero)]))
    const from = d0 - (HEAD_AHEAD * W) / travelFrom.zoom
    const steps = Array.from({ length: 161 }, (_, i) => travel.b0 + ((land - travel.b0) * i) / 160)
    const away = steps.map((bt) => dist(travelCam(bt).at, hero))
    const when = (d: number): number => {
      const want = ((d - near) / Math.max(1e-6, from - near)) * d0
      const i = away.findIndex((c) => c <= want)
      return (i < 0 ? land : steps[i] as number) * B
    }
    const cut = (a: P2, b: P2): P2 | undefined => {
      if ((dist(a, hero) - from) * (dist(b, hero) - from) >= 0) return undefined
      let [lo, hi] = [0, 1]
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2
        const q: P2 = [a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid]
        if ((dist(q, hero) - from) * (dist(a, hero) - from) > 0) lo = mid
        else hi = mid
      }
      return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo]
    }
    if (from > near + ppm) {
      flowSegs.forEach((sg, i) => {
        const [ta, tb] = [when(dist(sg.a, hero)), when(dist(sg.b, hero))]
        flowSegs[i] = ta <= tb ? { ...sg, p0: ta, p1: Math.max(tb, ta + 0.002) } : { ...sg, a: sg.b, b: sg.a, p0: tb, p1: Math.max(ta, tb + 0.002) }
      })
      busStrokes = busStrokes.flatMap((st): PlotStroke[] => {
        const a: P2 = [st.path[0] as number, st.path[1] as number]
        const b: P2 = [st.path[2] as number, st.path[3] as number]
        const [far, close] = dist(a, hero) >= dist(b, hero) ? [a, b] : [b, a]
        if (st.path.length !== 4 || dist(close, hero) >= from) return [st]
        const q = cut(far, close)
        const start = q ?? far
        const led: PlotStroke = { ...(st.accent === true ? { accent: true } : {}), path: [...start, ...close], w: st.w, t0: when(dist(start, hero)), t1: Math.max(when(dist(close, hero)), when(dist(start, hero)) + 0.002) }
        return q === undefined ? [led] : [{ ...st, path: [...far, ...q] }, led]
      })
    }
  }
  const keyStep = 0.125
  const travelKeys: CameraShot[] = travel === undefined ? [] : [...Array.from({ length: Math.round((travel.b1 - travel.b0) / keyStep) + 1 }, (_, i) => Math.min(travel.b1 - 0.004, travel.b0 + keyStep * i)).filter((b) => pairPace.cut === undefined || Math.abs(b - pairPace.cut) > 1e-6), ...(pairPace.cut === undefined ? [] : [pairPace.cut])].sort((x, y) => x - y).map((b): CameraShot => {
    const c = travelCam(b)
    return { t: b * B, ...pt(c.at), zoom: c.zoom, yaw: c.yaw, ...flat, ease: 'linear', ...(b === pairPace.cut ? { cut: true } : {}) }
  })
  const noteH = (FILM_SUB * su) / (squeeze * Math.min(travelFrom.zoom, zEnd, zWide, rideLine !== undefined && zSig > 0 ? zSig : Infinity))
  const level = (q: P2): P2 => [Math.cos(planYaw) * q[0] - Math.sin(planYaw) * q[1], Math.sin(planYaw) * q[0] + Math.cos(planYaw) * q[1]]
  const spread = (c: P2, w: number, h: number, turn: number, grow: number): { x: number; y: number; w: number; h: number } => {
    const hw = 0.5 * (Math.abs(Math.cos(turn)) * w + Math.abs(Math.sin(turn)) * h) + grow
    const hh = 0.5 * (Math.abs(Math.sin(turn)) * w + Math.abs(Math.cos(turn)) * h) + grow
    return { x: level(c)[0] - hw, y: level(c)[1] - hh, w: 2 * hw, h: 2 * hh }
  }
  const solid = inp.parts.filter((q) => q.hero === true || Math.min(q.w, q.h) >= 2.5 * ppm).map((q) => spread([q.x, q.y], q.w, q.h, q.rot + planYaw, 0.6 * noteH))
  const yellow = flowSegs.flatMap((sg) => {
    const n = Math.ceil(dist(sg.a, sg.b) / (0.4 * noteH))
    return Array.from({ length: n + 1 }, (_, i): P2 => level([sg.a[0] + (i / Math.max(1, n)) * (sg.b[0] - sg.a[0]), sg.a[1] + (i / Math.max(1, n)) * (sg.b[1] - sg.a[1])]))
  })
  const corners = (r: { x: number; y: number; w: number; h: number }): P2[] => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]
  const offYellow = (NOTE_HALO / 2) * noteH + 0.5 * Math.max(0, ...flowSegs.map((sg) => sg.w))
  const blocked = (r: { x: number; y: number; w: number; h: number }, parts = true): boolean => (chipName !== undefined && rectHits({ x: Math.min(...chipName.map((q) => q[0])), y: Math.min(...chipName.map((q) => q[1])), w: Math.max(...chipName.map((q) => q[0])) - Math.min(...chipName.map((q) => q[0])), h: Math.max(...chipName.map((q) => q[1])) - Math.min(...chipName.map((q) => q[1])) }, corners(r))) || boxes.some((o) => rectHits({ x: o.x - NOTE_APART * noteH, y: o.y - NOTE_APART * noteH, w: o.w + 2 * NOTE_APART * noteH, h: o.h + 2 * NOTE_APART * noteH }, corners(r))) || (parts && solid.some((o) => rectHits(o, corners(r)))) || yellow.some((q) => q[0] > r.x - offYellow && q[0] < r.x + r.w + offYellow && q[1] > r.y - offYellow && q[1] < r.y + r.h + offYellow)
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = []
  const flatInk = planInk(inp.layers, inp.pads, inp.vias)
  const copper: PlanInk = { lines: flatInk.lines.map((l) => ({ a: level(l.a), b: level(l.b), w: l.w })), discs: flatInk.discs.map((d) => ({ x: level([d.x, d.y])[0], y: level([d.x, d.y])[1], r: d.r })) }
  const cutShot = shotOf('section')
  const chipPart = inp.parts.find((q) => q.hero === true)
  const chipName = ((): P2[] | undefined => {
    if (chipPart === undefined) return undefined
    const wide = chipPart.w >= chipPart.h
    const [u, v] = wide ? [0.45 * chipPart.w, chipPart.h / 4] : [chipPart.w / 4, 0.45 * chipPart.h]
    const co = Math.cos(chipPart.rot)
    const si = Math.sin(chipPart.rot)
    return ([[-u, -v], [u, -v], [u, v], [-u, v]] as P2[]).map(([x, y]) => level([chipPart.x + co * x - si * y, chipPart.y + si * x + co * y]))
  })()
  const cut = ((): { section: PlotSection; held: { at: P2; zoom: number; yaw: number; from: number; to: number }; place: (taken: (poly: P2[]) => boolean) => { line: [number, number]; marks: [boolean, boolean] }; aim: (zoom: number, drop?: number) => P2 } | undefined => {
    if (cutShot === undefined || travel === undefined || chipPart === undefined) return undefined
    const cam = travelCam(travel.b1)
    const z = squeeze * cam.zoom
    const u = Math.min(W, H) / 1080
    const dir: P2 = [Math.cos(cam.yaw), -Math.sin(cam.yaw)]
    const nrm: P2 = [-dir[1], dir[0]]
    const chipLow = 0.5 * (Math.abs(chipPart.w * (Math.cos(chipPart.rot) * nrm[0] + Math.sin(chipPart.rot) * nrm[1])) + Math.abs(chipPart.h * (-Math.sin(chipPart.rot) * nrm[0] + Math.cos(chipPart.rot) * nrm[1]))) * z
    const margin = 0.035 * H
    const tall = (sz: number): number => 2.9 * sz + 7 * u + SECTION_ROW * sz * (stack.length - 1)
    const room = H - margin - (squeeze * H) / 2 - chipLow - margin
    const size = noteH * z > sectionSize(W, H) && tall(noteH * z) <= room ? noteH * z : sectionSize(W, H)
    const along = (q: P2): number => (q[0] - hero[0]) * dir[0] + (q[1] - hero[1]) * dir[1]
    const across = (q: P2): number => (q[0] - hero[0]) * -dir[1] + (q[1] - hero[1]) * dir[0]
    const extent = (w: number, h: number, r: number): number => 0.5 * (Math.abs(w * (Math.cos(r) * dir[0] + Math.sin(r) * dir[1])) + Math.abs(h * (-Math.sin(r) * dir[0] + Math.cos(r) * dir[1])))
    const chipHalf = extent(chipPart.w, chipPart.h, chipPart.rot)
    const label = (Math.max(...stack.map((l) => l.name.length)) * 0.66 + 1.5) * size
    const half = Math.min(SECTION_REACH * chipHalf, (0.46 * W - label) / z)
    const layout = (cols: 1 | 2): { cols: 1 | 2; k: number; apart: boolean; rows: number; ph: number; wide: number; flat0: number } => {
      const colGap = SECTION_COL_GAP * size
      const k = cols === 1 ? 1 : Math.min(1, ((0.92 * W - colGap) / 2 - label - 60 * u) / (2 * half * z))
      const apart = 0.6 * size + textW(SECTION_TITLE.length, size) + 0.5 * size > label + 30 * u + (half - chipHalf) * z * k
      const rows = Math.ceil(stack.length / cols)
      const ph = tall(size) - SECTION_ROW * size * (stack.length - rows) + (apart ? SECTION_ROW * size : 0)
      const wide = cols * (2 * half * z * k + 60 * u + label) + (cols - 1) * colGap
      return { cols, k, apart, rows, ph, wide, flat0: cols === 1 ? -half * z - 30 * u - label : -wide / 2 }
    }
    const lift = (squeeze * H) / 2
    type Place = { side: 'below' | 'above' | 'right' | 'left'; box: [number, number, number, number]; fits: boolean }
    const placesOf = ({ ph, wide, flat0 }: ReturnType<typeof layout>): [Place, ...Place[]] => [
      ((): { side: 'below'; box: [number, number, number, number]; fits: boolean } => {
        const y0 = Math.max(chipLow + margin, H - margin - ph - lift)
        return { side: 'below', box: [flat0, y0, flat0 + wide, y0 + ph], fits: y0 + ph <= H - lift - margin / 2 }
      })(),
      ((): { side: 'above'; box: [number, number, number, number]; fits: boolean } => {
        const y1 = Math.min(-chipLow - margin, -lift + margin + ph)
        return { side: 'above', box: [flat0, y1 - ph, flat0 + wide, y1], fits: y1 - ph >= -lift + margin / 2 }
      })(),
      { side: 'right', box: [W / 2 - margin - wide, -ph / 2, W / 2 - margin, ph / 2], fits: W / 2 - margin - wide >= chipHalf * z + margin },
      { side: 'left', box: [-W / 2 + margin, -ph / 2, -W / 2 + margin + wide, ph / 2], fits: -W / 2 + margin + wide <= -chipHalf * z - margin }
    ]
    const one = layout(1)
    const lastRow = placesOf(one)[0].box[1] + (one.apart ? 2 + SECTION_ROW : 2) * size + 7 * u + SECTION_ROW * size * (one.rows - 1)
    const lay = placesOf(one).some((q) => q.fits) || lastRow + CAP * size <= H - lift ? one : layout(2)
    const { apart } = lay
    const places = placesOf(lay)
    const accent: P2[] = [...busStrokes.flatMap((st) => Array.from({ length: st.path.length / 2 }, (_, i): P2 => [st.path[2 * i] as number, st.path[2 * i + 1] as number])), ...flowSegs.flatMap((g) => [g.a, g.b])]
    const accentSegs: Array<[P2, P2]> = [...busStrokes.flatMap((st) => Array.from({ length: Math.max(0, st.path.length / 2 - 1) }, (_, i): [P2, P2] => [[st.path[2 * i] as number, st.path[2 * i + 1] as number], [st.path[2 * i + 2] as number, st.path[2 * i + 3] as number]])), ...flowSegs.map((g): [P2, P2] => [g.a, g.b])]
    const accentPts: P2[] = [...accent, ...accentSegs.flatMap(([a, b]) => {
      const n = Math.ceil((dist(a, b) * z) / (4 * u))
      return Array.from({ length: Math.max(0, n - 1) }, (_, k): P2 => [a[0] + ((k + 1) / n) * (b[0] - a[0]), a[1] + ((k + 1) / n) * (b[1] - a[1])])
    })].map((q): P2 => [((q[0] - hero[0]) * dir[0] + (q[1] - hero[1]) * dir[1]) * z, ((q[0] - hero[0]) * nrm[0] + (q[1] - hero[1]) * nrm[1]) * z])
    const keep = PANEL_CLEAR * u
    const under = (b: [number, number, number, number]): number => accentPts.filter((q) => q[0] > b[0] - keep && q[0] < b[2] + keep && q[1] > b[1] - keep && q[1] < b[3] + keep).length
    const fitting = places.filter((q) => q.fits)
    const chosen = fitting.find((q) => under(q.box) === 0) ?? fitting.reduce<Place | undefined>((x, y) => (x === undefined || under(y.box) < under(x.box) ? y : x), undefined) ?? places[0]
    const panelBox = chosen.box.map((v) => v / z) as [number, number, number, number]
    const over = under(chosen.box) > 0
    const towards = ((): number => {
      const [a0, s0, a1, s1] = panelBox
      if (chosen.side === 'below') return (H + 2 * u - SECTION_HERO * H) / (squeeze * s0)
      if (chosen.side === 'above') return ((1 - SECTION_HERO) * H + 2 * u) / (squeeze * -s1)
      if (chosen.side === 'right') return (W + 2 * u - SECTION_HERO * W) / (squeeze * a0)
      return ((1 - SECTION_HERO) * W + 2 * u) / (squeeze * -a1)
    })()
    const zoom = Math.max(cam.zoom, towards)
    const aim = (zm: number, drop = 0): P2 => {
      const [a0, s0, a1, s1] = panelBox
      const k = squeeze * zm
      if (chosen.side === 'below' || chosen.side === 'above') {
        const y = chosen.side === 'below' ? H + 2 * u + drop - k * s0 : -2 * u - drop - k * s1
        const off = (y - lift) / k
        return [hero[0] - off * nrm[0], hero[1] - off * nrm[1]]
      }
      const x = chosen.side === 'right' ? W + 2 * u + drop - k * a0 : -2 * u - drop - k * a1
      const off = (x - W / 2) / k
      return [hero[0] - off * dir[0], hero[1] - off * dir[1]]
    }
    const stand = cutShot.b1 - (cutShot.b0 + SECTION_DRAW)
    const held = { at: aim(zoom), zoom, yaw: cam.yaw, from: cutShot.b0 + SECTION_DRAW + SECTION_MOVE[0] * stand, to: cutShot.b0 + SECTION_DRAW + SECTION_MOVE[1] * stand }
    const feet = inp.parts.map((q) => ({ t: along([q.x, q.y]), a: extent(q.w, q.h, q.rot), s: across([q.x, q.y]), c: 0.5 * (Math.abs(q.w * (Math.cos(q.rot) * nrm[0] + Math.sin(q.rot) * nrm[1])) + Math.abs(q.h * (-Math.sin(q.rot) * nrm[0] + Math.cos(q.rot) * nrm[1]))) }))
    const markBox = (t: number, out: number, mark = true): { lo: number; hi: number; up: number; down: number } => {
      if (!mark) return { lo: t - ((END_STROKE / 4 + MARK_CLEAR) * u) / z, hi: t + ((END_STROKE / 4 + MARK_CLEAR) * u) / z, up: -((END_STROKE / 4 + MARK_CLEAR) * u) / z, down: ((END_STROKE + MARK_CLEAR) * u) / z }
      const [lo, hi] = [t + (out * (10 * u + MARK_CLEAR * u)) / z, t - (out * (1.25 * size + MARK_CLEAR * u)) / z].sort((x, y) => x - y) as [number, number]
      return { lo, hi, up: -(1.05 * size + MARK_CLEAR * u) / z, down: (52 * u + MARK_CLEAR * u) / z }
    }
    const poster = viewOf(beats.pull[1])
    const risen = inp.parts.map((q) => convex(bodyCorners(q).flatMap((c) => [axoPoint(poster, c, 0), axoPoint(poster, c, q.z)])))
    const signal = flowSegs.map((g) => Object.assign([axoPoint(poster, g.a, 0), axoPoint(poster, g.b, 0)], { w: dist(axoPoint(poster, hero, 0), axoPoint(poster, [hero[0] + (g.w / 2) * dir[0], hero[1] + (g.w / 2) * dir[1]], 0)) }))
        const quad = (m: { lo: number; hi: number; up: number; down: number }): P2[] => ([[m.lo, m.up], [m.hi, m.up], [m.hi, m.down], [m.lo, m.down]] as P2[]).map(([a, s]): P2 => [hero[0] + a * dir[0] + s * nrm[0], hero[1] + a * dir[1] + s * nrm[1]])
    const near = (q: P2, h: P2[], d: number): boolean => h.some((a, k) => {
      const b = h[(k + 1) % h.length] as P2
      const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
      const f = l2 === 0 ? 0 : clamp(((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / l2, 0, 1)
      return dist(q, [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]) < d
    })
    const amongParts = (t: number, out: number, mark = true): boolean => {
      const ink: P2[] = mark ? [...Array.from({ length: 5 }, (_, i): P2 => [t, (13 * u * i) / z]), ...[-0.35, 0, 0.35].map((dx): P2 => [t - (out * 0.75 * size) / z + (dx * size) / z, (-0.45 * size) / z])] : Array.from({ length: 4 }, (_, i): P2 => [t, (END_STROKE * u * i) / (3 * z)])
      const d = (0.5 * size) / z
      return ink.map(([a, s2]) => axoPoint(poster, [hero[0] + a * dir[0] + s2 * nrm[0], hero[1] + a * dir[1] + s2 * nrm[1]], 0)).some((q) => {
        if (q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > H || risen.some((h) => insideConvex(q, h))) return false
        const k = dist(axoPoint(poster, hero, 0), axoPoint(poster, [hero[0] + d * dir[0], hero[1] + d * dir[1]], 0))
        return risen.some((h) => near(q, h, k)) || signal.some((g) => near(q, g, k + g.w))
      })
    }
    const framed = (t: number, mark = true): boolean => Math.abs(t) * z + (mark ? 1.25 * size : END_STROKE * u) + MARK_CLEAR * u <= W / 2
    const place = (taken: (poly: P2[]) => boolean): { line: [number, number]; marks: [boolean, boolean] } => {
      const bare = (t: number, out: number, mark: boolean): boolean => {
        const m = markBox(t, out, mark)
        return !feet.some((q) => q.t + q.a > m.lo && q.t - q.a < m.hi && q.s + q.c > m.up && q.s - q.c < m.down) && !accentPts.some((q) => q[0] / z > m.lo && q[0] / z < m.hi && q[1] / z > m.up && q[1] / z < m.down) && !taken(quad(m))
      }
      const from = (out: number): [number, boolean] => {
        const ts = Array.from({ length: Math.ceil(W / (2 * u)) }, (_, i) => out * (half + (2 * u * i) / z)).filter((t) => framed(t, false))
        const mark = ts.find((t) => framed(t) && bare(t, out, true) && !amongParts(t, out))
        if (mark !== undefined) return [mark, true]
        return [ts.find((t) => bare(t, out, false) && !amongParts(t, out, false)) ?? ts.find((t) => bare(t, out, false)) ?? out * half, false]
      }
      const [l, r] = [from(-1), from(1)]
      return { line: [l[0], r[0]], marks: [l[1], r[1]] }
    }
    const inside = (t: number): boolean => Math.abs(t) <= half
    const cutsOf = (li: number): Array<[number, number]> => {
      const l = inp.layers[li]
      if (l === undefined) return []
      const out: Array<[number, number]> = []
      for (let i = 0; i + 6 < l.segs.length; i += 7) {
        const a: P2 = [l.segs[i] as number, l.segs[i + 1] as number]
        const b: P2 = [l.segs[i + 2] as number, l.segs[i + 3] as number]
        const [sa, sb] = [across(a), across(b)]
        if (sa * sb > 0 || sa === sb) continue
        const k = sa / (sa - sb)
        const t = along([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k])
        if (inside(t)) out.push([t, Math.max(l.segs[i + 4] as number, (4 * u) / z)])
      }
      return out
    }
    const pads = inp.pads.filter((pd) => pd.side !== 'B' && Math.abs(across([pd.x, pd.y])) <= 0.5 * Math.max(pd.w, pd.h) && inside(along([pd.x, pd.y]))).map((pd): [number, number] => [along([pd.x, pd.y]), Math.min(pd.w, pd.h)])
    const posts: number[] = []
    for (const t of inp.vias.filter((v) => Math.abs(across([v.x, v.y])) <= v.r + 0.25 * ppm).map((v) => along([v.x, v.y])).filter(inside).sort((a, b) => a - b)) {
      if (posts.length === 0 || (t - (posts.at(-1) as number)) * z >= POST_APART * u) posts.push(t)
    }
    const f0 = Math.round(plotFrame(cutShot.b0 * B, filmFrames))
    const draw = (SECTION_DRAW * filmFrames) / 24
    const at = (n: number): number => plotClock(f0 + Math.round((n * draw) / 24), filmFrames)
    const section: PlotSection = {
      at: hero, dir, ...place(() => false), half, apart, cols: lay.cols, scale: lay.k, chip: [-chipHalf, chipHalf], size, panel: panelBox, side: chosen.side, over,
      layers: stack.map((l, i) => ({ name: l.name, plane: l.zones.length > 0 && l.layer < 0, cuts: l.layer >= 0 ? cutsOf(l.layer) : [], t: at(10 + (10 * i) / Math.max(1, stack.length - 1)) })),
      pads, posts,
      t: { line: [at(0), at(6)], arrows: at(6), panel: at(8), posts: at(16), pads: at(18), chip: at(19), title: at(20), whole: at(24), gone: held.to * B }
    }
    return { section, held, place, aim }
  })()
  const section = cut?.section
  let panelBox: { x: number; y: number; w: number; h: number } | undefined
  if (section !== undefined) {
    const [a0, s0, a1, s1] = section.panel
    const corners = ([[a0, s0], [a1, s0], [a1, s1], [a0, s1]] as P2[]).map(([a, b]) => level([hero[0] + a * section.dir[0] - b * section.dir[1], hero[1] + a * section.dir[1] + b * section.dir[0]]))
    const xs = corners.map((q) => q[0])
    const ys = corners.map((q) => q[1])
    panelBox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }
  const lastFlat = cut?.held.from ?? travel?.b1 ?? 0
  const wholeIn = (r: { x: number; y: number; w: number; h: number }, cam: { at: P2; zoom: number }): boolean => {
    const c = level(cam.at)
    const m = FILM_TEXT * su * CAP
    const hw = (W / 2 - m) / (squeeze * cam.zoom)
    const hh = ((squeeze * H) / 2 - m) / (squeeze * cam.zoom)
    return r.x > c[0] - hw && r.x + r.w < c[0] + hw && r.y > c[1] - hh && r.y + r.h < c[1] + hh
  }
  const wholeOut = (r: { x: number; y: number; w: number; h: number }, cam: { at: P2; zoom: number }): boolean => {
    const c = level(cam.at)
    const hw = W / (2 * squeeze * cam.zoom)
    const hh = H / (2 * cam.zoom)
    return r.x + r.w < c[0] - hw || r.x > c[0] + hw || r.y + r.h < c[1] - hh || r.y > c[1] + hh
  }
  const inFrame = (r: { x: number; y: number; w: number; h: number }, b: number): boolean => wholeIn(r, travelCam(b))
  const outOfFrame = (r: { x: number; y: number; w: number; h: number }, b: number): boolean => wholeOut(r, travelCam(b))
  const clean = (r: { x: number; y: number; w: number; h: number }, b: number, lift = Infinity): boolean => {
    for (let q = Math.max(b, travel === undefined ? b : travel.b1 - TRAVEL_HOLD); q < Math.min(lastFlat, lift); q += 0.25) if (!inFrame(r, q) && !outOfFrame(r, q)) return false
    return lift <= lastFlat || inFrame(r, lastFlat) || outOfFrame(r, lastFlat)
  }
  const lettering: Array<{ x: number; y: number; w: number; h: number }> = []
  const placeText = (on: P2, lines: string[], b: number, from: number, stay?: number, gone = false, hold = 1, size = noteH, parts = true, seen = b, fill = false, lift = Infinity): P2 | undefined => {
    const anchor = level(on)
    const w = textW(Math.max(...lines.map((l) => l.length)), size)
    const h = size * (1.3 + 1.5 * (lines.length - 1))
    const holds = Array.from({ length: Math.ceil(hold / 0.125) + 1 }, (_, i) => b + Math.min(hold, i * 0.125)).filter((q) => q >= seen)
    const fits = (box: { x: number; y: number; w: number; h: number }): boolean => holds.every((q) => inFrame(box, q)) && (stay === undefined || (gone ? outOfFrame(box, stay) : inFrame(box, stay))) && (travel === undefined || clean(box, b, lift)) && !blocked(box, parts)
    let best: { box: { x: number; y: number; w: number; h: number }; n: number } | undefined
    const take = (box: { x: number; y: number; w: number; h: number }): void => {
      if (!fits(box)) return
      const n = 1e4 * wiped(box, b + 0.75) + inkAcross(box, copper, NOTE_CLEAR * size)
      if (best === undefined || n < best.n) best = { box, n }
    }
    for (let r = 1; r <= NOTE_RINGS && best?.n !== 0; r++) {
      for (let i = 0; i < 16; i++) {
        const a = (i * Math.PI) / 8
        const dx = Math.cos(a)
        const dy = Math.sin(a)
        const reach = from + r * 1.2 * size
        take({ x: anchor[0] + dx * (reach + 0.5 * w * Math.abs(dx)) - w / 2, y: anchor[1] + dy * (reach + 0.5 * h * Math.abs(dy)) - h / 2, w, h })
      }
    }
    if (best === undefined && fill && holds.length > 0) {
      const views = holds.map((q) => {
        const c = travelCam(q)
        const l = level(c.at)
        const [hw, hh] = [W / (2 * squeeze * c.zoom), H / (2 * c.zoom)]
        return [l[0] - hw, l[0] + hw, l[1] - hh, l[1] + hh] as const
      })
      const [x0, x1, y0, y1] = [Math.max(...views.map((v) => v[0])), Math.min(...views.map((v) => v[1])) - w, Math.max(...views.map((v) => v[2])), Math.min(...views.map((v) => v[3])) - h]
      if (x1 >= x0 && y1 >= y0) for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) take({ x: x0 + ((x1 - x0) * i) / 8, y: y0 + ((y1 - y0) * j) / 8, w, h })
    }
    if (best === undefined) return undefined
    boxes.push(best.box)
    lettering.push(best.box)
    return [best.box.x, best.box.y]
  }
  const nearestB = (q: P2): number => {
    if (travel === undefined) return 0
    return Array.from({ length: 41 }, (_, i) => travel.b0 + ((travel.b1 - travel.b0) * i) / 40).reduce((x, y) => (dist(travelCam(y).at, q) < dist(travelCam(x).at, q) ? y : x))
  }
  const reachOut = Math.max(1, ...inp.parts.map((q) => dist([q.x, q.y], hero)))
  const risen = inp.parts.map((q) => {
    const t0 = q.hero === true ? beats.pull[0] - BODY_DRAW : beats.tilt[0] + 0.25 + (dist([q.x, q.y], hero) / reachOut) * Math.max(0, beats.pull[1] - 1 - beats.tilt[0] - 0.25)
    return { x: q.x, y: q.y, t0, t1: t0 + BODY_DRAW }
  })
  const ink = ((): PlotInk | undefined => {
    if (travel === undefined) return undefined
    const reachV = (z: number, ride = false): number => ((planKind === 'pair' ? PAIR_SPREAD : ride ? RIDE_SPREAD : 0.15) * Math.hypot(W, H)) / (2 * z * B)
    const src: number[] = []
    const lay = (path: number[], t0: number, t1: number, z: number, cap?: () => number): void => {
      const pts = Array.from({ length: path.length / 2 }, (_, i): P2 => [path[2 * i] as number, path[2 * i + 1] as number])
      const cum = pts.reduce<number[]>((c, q, i) => [...c, i === 0 ? 0 : (c[i - 1] as number) + dist(pts[i - 1] as P2, q)], [])
      const L = cum.at(-1) ?? 0
      const n = Math.max(1, Math.ceil(L / (W / z / 40)))
      for (let k = 0; k <= n; k++) {
        const sv = (k / n) * L
        const i = Math.max(1, cum.findIndex((c) => c >= sv))
        const a = pts[i - 1] as P2
        const b = pts[Math.min(i, pts.length - 1)] as P2
        const f = clamp((sv - (cum[i - 1] as number)) / Math.max(1e-9, (cum[i] as number) - (cum[i - 1] as number)), 0, 1)
        src.push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, t0 + ((t1 - t0) * k) / n, cap === undefined ? reachV(z) : Math.min(reachV(z, true), cap()))
      }
    }
    if (travel.b0 <= 0 && ridePath === undefined) src.push(...travelCam(0).at, -OPEN_INK * B, reachV(travelCam(0).zoom))
    for (const st of busStrokes) lay(st.path, st.t0, st.t1, planKind === 'pair' ? pairBack : z2)
    for (const sg of flowSegs) lay([...sg.a, ...sg.b], sg.p0, sg.p1, travelCam(sg.p0 / B).zoom, ridePath === undefined ? undefined : () => (RIDE_WAKE * dist(sg.a, sg.b)) / Math.max(1e-9, sg.p1 - sg.p0))
    const drawn = src.length
    const reached = (q: P2): number => {
      let at = Infinity
      for (let i = 0; i < drawn; i += 4) at = Math.min(at, (src[i + 2] as number) + dist(q, [src[i] as number, src[i + 1] as number]) / (src[i + 3] as number))
      return at
    }
    for (let b = travel.b0; ridePath === undefined && b <= travel.b1 - TRAVEL_HOLD; b += 0.25) {
      const c = travelCam(b)
      if (reached(c.at) > b * B) src.push(c.at[0], c.at[1], (b - INK_AHEAD) * B, reachV(c.zoom))
    }
    const land = (travel.b1 - TRAVEL_HOLD) * B
    const hold: [number, number] = [land, land + B]
    const r0 = 0.5 * heroSize
    const r = Math.max(r0 + 1, Math.hypot(W, H) / (2 * zRise))
    const farD = Math.max(1, ...outlinePts.map((q) => dist(q, hero)))
    const pin = flowSegs.flatMap((sg) => [sg.a, sg.b]).reduce<P2 | undefined>((best, q) => (best === undefined || dist(q, hero) < dist(best, hero) ? q : best), undefined)
    const base: PlotInk = { src, hold, fan: { t: hold[1], v: (r - r0) / (FAN_GROW * B), r0, r, round: FAN_ROUND * B, from: pin === undefined ? 0 : Math.atan2(pin[1] - hero[1], pin[0] - hero[0]) }, far: { x: hero[0], y: hero[1], t: hold[0], v: farD / Math.max(B, (beats.sheet - 0.5) * B - hold[1]) }, lead: 0.6 * B }
    const open = travelCam(travel.b1 - TRAVEL_HOLD)
    const k = (nameStrip(W, H).y - 0.012 * minWH) / H
    const z = k * open.zoom
    const [co, si] = [Math.cos(open.yaw), Math.sin(open.yaw)]
    const onFrame = (q: P2): P2 => [W / 2 + z * (co * (q[0] - open.at[0]) - si * (q[1] - open.at[1])), (k * H) / 2 + z * (si * (q[0] - open.at[0]) + co * (q[1] - open.at[1]))]
    let up = 0
    let low = 0
    for (const q of fanInk(inp.layers, inp.groups, inp.parts.find((pt) => pt.hero === true), base).rest) {
      const [x, y] = onFrame([(q.a[0] + q.b[0]) / 2, (q.a[1] + q.b[1]) / 2])
      if (x < 0 || x > W || y < 0 || y > k * H || inkTime(base, (q.a[0] + q.b[0]) / 2, (q.a[1] + q.b[1]) / 2) > hold[0]) continue
      if (y < (k * H) / 2) up += z * dist(q.a, q.b)
      else low += z * dist(q.a, q.b)
    }
    if (Math.min(up, low) >= OPEN_BARE * (W * k * H) / 2) return base
    const last = travelCam(travel.b1)
    const views = [
      ...Array.from({ length: 4 * TRAVEL_HOLD + 1 }, (_, i) => travelCam(travel.b1 - TRAVEL_HOLD + i / 4)),
      ...(cut === undefined ? [] : Array.from({ length: 9 }, (_, i) => { const u = i / 8; return { at: [last.at[0] + (cut.held.at[0] - last.at[0]) * u, last.at[1] + (cut.held.at[1] - last.at[1]) * u] as P2, zoom: last.zoom + (cut.held.zoom - last.zoom) * u, yaw: last.yaw + wrap(cut.held.yaw - last.yaw) * u } }))
    ]
    const corners = views.flatMap((v) => {
      const [vc, vs] = [Math.cos(v.yaw), Math.sin(v.yaw)]
      const vz = k * v.zoom
      return [[0, 0], [W, 0], [W, k * H], [0, k * H]].map(([x, y]): P2 => [v.at[0] + (vc * ((x as number) - W / 2) + vs * ((y as number) - (k * H) / 2)) / vz, v.at[1] + (-vs * ((x as number) - W / 2) + vc * ((y as number) - (k * H) / 2)) / vz])
    })
    const [x0, x1, y0, y1] = [Math.min(...corners.map((q) => q[0])), Math.max(...corners.map((q) => q[0])), Math.min(...corners.map((q) => q[1])), Math.max(...corners.map((q) => q[1]))]
    const at: P2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    const reach = Math.max(...at.map((q) => dist(q, hero)))
    const t = hold[0] - STAND_EARLY
    const t0 = hold[0] - STAND_DRAFT * B
    return { ...base, stand: { at, t, from: hero, t0, v: reach / (t - t0) } }
  })()
  const order = ink === undefined ? undefined : fanInk(inp.layers, inp.groups, inp.parts.find((q) => q.hero === true), ink)
  const timed = order === undefined || ink === undefined ? [] : [
    ...order.fan.map((q) => ({ a: q.a, b: q.b, w: q.w, at: (): number => q.t0 })),
    ...order.rest.map((q) => ({ a: q.a, b: q.b, w: q.w, at: (x: number, y: number): number => inkTime(ink, x, y) }))
  ].map((q) => ({ ...q, la: level(q.a), lb: level(q.b) }))
  const wiped = (box: { x: number; y: number; w: number; h: number }, b: number): number => {
    if (ink === undefined) return 0
    const keep = (NOTE_HALO / 2) * noteH
    const inside = (x: number, y: number, r: number): boolean => x > box.x - keep - r && x < box.x + box.w + keep + r && y > box.y - keep - r && y < box.y + box.h + keep + r
    const lines = timed.filter((q) => {
      const r = q.w / 2
      if (Math.max(q.la[0], q.lb[0]) < box.x - keep - r || Math.min(q.la[0], q.lb[0]) > box.x + box.w + keep + r || Math.max(q.la[1], q.lb[1]) < box.y - keep - r || Math.min(q.la[1], q.lb[1]) > box.y + box.h + keep + r) return false
      const n = Math.max(1, Math.ceil(dist(q.a, q.b) / (0.25 * noteH)))
      for (let k = 0; k <= n; k++) {
        const f = k / n
        if (inside(q.la[0] + (q.lb[0] - q.la[0]) * f, q.la[1] + (q.lb[1] - q.la[1]) * f, r) && q.at(q.a[0] + (q.b[0] - q.a[0]) * f, q.a[1] + (q.b[1] - q.a[1]) * f) < b * B) return true
      }
      return false
    }).length
    return lines + flatInk.discs.filter((d, i) => inside((copper.discs[i] as PlanInk['discs'][number]).x, (copper.discs[i] as PlanInk['discs'][number]).y, d.r) && inkTime(ink, d.x, d.y) < b * B).length
  }
  if (travel !== undefined && busText.length > 0) {
    const zs = travelFrom.zoom
    const w = textW(busText.length, FILM_TEXT * su) / zs
    const h = (1.4 * FILM_TEXT * su) / zs
    const c: P2 = [(busA[0] + busB[0]) / 2, (busA[1] + busB[1]) / 2]
    boxes.push(spread(c, 2.2 * w, 8 * h, planYaw - travelFrom.yaw, 0))
  }
  if (travel !== undefined) {
    const landed = travel.b1 - TRAVEL_HOLD
    let rideBox: { x: number; y: number; w: number; h: number } | undefined
    const openAt = Array.from({ length: Math.ceil((landed + TRAVEL_HOLD - travel.b0) * 15) }, (_, i) => travel.b0 + i / 15).find((x) => travelCam(x).zoom < (1 - RIDE_SHRINK) * travelCam(travel.b0).zoom)
    const opens = openAt !== undefined
    if (panelBox !== undefined && !opens) boxes.push(panelBox)
    if (ridePath !== undefined && busText.length === 0) {
      const first = [...thingNets].find((id) => heroNetIds.has(id)) ?? [...thingNets][0]
      const name = bareName(nameOf.get(first ?? -1) ?? '').toUpperCase()
      const chip = ((heroFp?.value ?? '').split(/[-\s/]/)[0] ?? '').toUpperCase()
      const from = rideStart?.name ?? ''
      const lines = [`${name} · ${((rideS0 + rideCut) / ppm).toFixed(1)} MM`, `${from.length > 0 ? `${from} ` : ''}TO ${chip}`]
      const tries = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25, 0, -0.25, -0.5, -0.75].map((k) => travel.b0 + k).flatMap((b) => {
        const headAt = (x: number): P2 => (rideLine === undefined ? hero : lineAt(rideLine, rideS0 - rideDone(rideS0, ridePre, x)))
        return [headAt(b), headAt(b - 0.5), headAt(b + 0.5), headAt(b - 1), headAt(b + 1), headAt(b - 1.5), headAt(b - 2)].map((on) => ({ b, on }))
      })
      for (const { b, on, away } of [true, false].flatMap((away) => tries.map((q) => ({ ...q, away })))) {
        if (rideBox !== undefined) break
        const size = (FILM_SUB * su) / (squeeze * travelCam(b).zoom)
        const at = name.length > 0 && !/^NET-/.test(name) ? [0, 0.1, 0.2, 0.3, 0.4].reduce<P2 | undefined>((got, k) => got ?? placeText(on, lines, b, (k * W) / (squeeze * travelCam(b).zoom), away ? landed - 3 : undefined, true, Math.max(RIDE_NOTE, travel.b0 - b + RIDE_SEEN_FOR), size, false, travel.b0, true, openAt), undefined) : undefined
        if (at === undefined) continue
        rideBox = lettering.at(-1)
        break
      }
    }
    if (panelBox !== undefined && opens) boxes.push(panelBox)
    const bends = flowSegs.flatMap((x) => flowSegs.filter((y) => y !== x && dist(x.b, y.a) < 0.05 * ppm).map((y) => ({ at: x.b, turn: Math.abs(wrap(Math.atan2(y.b[1] - y.a[1], y.b[0] - y.a[0]) - Math.atan2(x.b[1] - x.a[1], x.b[0] - x.a[0]))) / D, len: Math.min(dist(x.a, x.b), dist(y.a, y.b)) })))
      .filter((q) => q.turn >= 30 && q.len >= 1.5 * ppm && dist(q.at, hero) < d0)
      .map((q) => ({ ...q, t: Math.max(travel.b0 + 1.5, nearestB(q.at) - 1, ...flowSegs.filter((sg) => dist(sg.b, q.at) < 0.05 * ppm).map((sg) => sg.p1 / B)) }))
      .filter((q) => q.t <= landed - 3)
      .sort((x, y) => x.t - y.t)
    const chipT = landed
    const gone = (r: { x: number; y: number; w: number; h: number } | undefined, b0: number, b1: number): boolean => r === undefined || Array.from({ length: Math.ceil((b1 - b0) / 0.125) + 1 }, (_, i) => Math.min(b1, b0 + i * 0.125)).every((b) => outOfFrame(r, b))
    const bendNote = bends.flatMap((bend) => Array.from({ length: 13 }, (_, i) => bend.t + 0.25 * i).filter((tb) => tb <= chipT - 1).map((tb) => ({ bend, tb })))
    for (const { bend, tb } of bendNote) {
      if (!gone(rideBox, tb, landed)) continue
      const text = `${Math.round(bend.turn)}° BEND`
      const placed = placeText(bend.at, [text], tb, 0, chipT, true)
      if (placed === undefined) continue
      if (!gone(lettering.at(-1), chipT, landed)) {
        boxes.pop()
        lettering.pop()
        continue
      }
      break
    }
  }
  if (cut !== undefined) {
    Object.assign(cut.section, cut.place((poly) => boxes.some((o) => rectHits(o, poly.map(level)))))
  }
  if (cut !== undefined) {
    const m = FILM_TEXT * su * CAP
    const clean = ([zm, drop]: [number, number]): boolean => {
      const cam = { at: cut.aim(zm, drop), zoom: zm }
      const g = m / (squeeze * zm)
      return lettering.every((r) => wholeIn(r, cam) || wholeOut({ x: r.x - g, y: r.y - g, w: r.w + 2 * g, h: r.h + 2 * g }, cam))
    }
    const steps = Array.from({ length: 2 * SECTION_ZOOM_TRIES + 1 }, (_, i) => i - SECTION_ZOOM_TRIES)
    const tries = steps.flatMap((k) => steps.filter((d) => d >= 0).map((d) => ({ k, d }))).sort((x, y) => Math.abs(x.k) + x.d - (Math.abs(y.k) + y.d) || y.k - x.k).map(({ k, d }): [number, number] => [cut.held.zoom * SECTION_ZOOM_STEP ** k, (d * H) / (2 * SECTION_ZOOM_TRIES)])
    const pick = tries.find(clean)
    if (pick !== undefined) Object.assign(cut.held, { zoom: pick[0], at: cut.aim(pick[0], pick[1]) })
  }
  if (ink !== undefined) {
    busSweep.splice(0, busSweep.length, ...busSweep.map((st): PlotStroke => {
      const pts = Array.from({ length: st.path.length / 2 }, (_, i): P2 => [st.path[2 * i] as number, st.path[2 * i + 1] as number])
      const [ta, tb] = [pts[0] as P2, pts.at(-1) as P2].map((q) => inkTime(ink, q[0], q[1])) as [number, number]
      const t0 = Math.min(ta, tb)
      return { ...st, path: (ta <= tb ? pts : [...pts].reverse()).flat(), t0, t1: t0 + polyLen(pts) / ((0.15 * Math.hypot(W, H)) / (2 * z2 * B)) }
    }))
  }
  const flatKeys: CameraShot[] = [
    ...plan.flatMap((q): CameraShot[] => {
      const chip = opening?.chip
      if (q.kind === 'open' && chip !== undefined) {
        const zc = Math.max(open1.zoom, ((W > 1.15 * H ? 0.95 : 0.8) * Math.min(W, H - strip)) / chip.size)
        const mid1 = nb0 + 0.45 * (nb1 - nb0)
        return [{ t: nb0 * B, ...pt(chip.at), zoom: zc, yaw: yaw1, ...flat, ease: 'linear' }, { t: mid1 * B, ...pt(chip.at), zoom: zc * 1.04, yaw: yaw1, ...flat, ease: 'inout' }, { t: nb1 * B - E, ...pt(open1.look), zoom: open1.zoom, yaw: yaw1, ...flat }]
      }
      if (q.kind === 'open') return [{ t: nb0 * B, ...pt(open1.look), zoom: open1.zoom, yaw: yaw1, ...flat, ease: 'inout' }, { t: nb1 * B - E, ...pt(open1.look), zoom: open1.zoom * 1.05, yaw: yaw1, ...flat }]
      if (q.kind === 'signature' && planKind === 'pair') return [
        { t: bu0 * B, ...pt(centred(look2Start, z2)), zoom: z2, yaw: yaw2, ...flat, cut: true, ease: 'linear' },
        { t: busLanded > bu0 * B ? busLanded : (bu0 + 0.6 * (bu1 - bu0)) * B, ...pt(centred(look2, z2 * 1.03)), zoom: z2 * 1.03, yaw: yaw2, ...flat, ease: 'inout' },
        { t: bu1 * B - E, ...pt(travelFrom.at), zoom: pairBack, yaw: yaw2, ...flat }
      ]
      if (q.kind === 'macro') return [
        { t: bu0 * B, ...pt(look2Start), zoom: z2, yaw: yaw2, ...flat, cut: true, ease: 'inout' },
        { t: (bu0 + Math.min(0.7 * (bu1 - bu0), MACRO_SLIDE)) * B, ...pt(look2), zoom: z2 * 1.01, yaw: yaw2, ...flat, ease: 'inout' },
        { t: bu1 * B - E, ...pt([look2[0] + drift[0], look2[1] + drift[1]]), zoom: z2 * 1.03, yaw: yaw2, ...flat }
      ]
      if (q.kind === 'outline') return travelKeys
      if (q.kind === 'section' && travel !== undefined && cut !== undefined) {
        const c = travelCam(travel.b1)
        const hd = cut.held
        return [{ t: q.b0 * B, ...pt(c.at), zoom: c.zoom, yaw: c.yaw, ...flat, ease: 'linear' }, { t: hd.from * B, ...pt(c.at), zoom: c.zoom, yaw: c.yaw, ...flat, ease: 'inout' }, { t: Math.min(hd.to * B, q.b1 * B - E), ...pt(hd.at), zoom: hd.zoom, yaw: hd.yaw, ...flat }]
      }
      if (q.kind !== 'signature') return []
      const L = sg1 - sg0
      const g = sigData
      if (g.kind === 'travel') return [{ t: sg0 * B, ...pt(g.from), zoom: g.zoom, yaw: g.yaw, ...flat, cut: true, ease: 'land' }, { t: sg1 * B - E, ...pt(g.to), zoom: g.zoom, yaw: g.yaw, ...flat }]
      if (g.kind === 'fingers') {
        const row = g.pads.reduce<P2>((t, q2) => [t[0] + q2[0] / g.pads.length, t[1] + q2[1] / g.pads.length], [0, 0])
        const pitchPx = g.pitchMm * ppm || 2.54 * ppm
        const zf = (0.8 * Math.min(W, H - strip)) / (8 * pitchPx)
        return [
          { t: sg0 * B, ...pt(row), zoom: zf, yaw: g.yaw, ...flat, cut: true, ease: 'inout' },
          { t: (sg0 + 0.45 * L) * B, ...pt(row), zoom: zf * 1.03, yaw: g.yaw, ...flat, ease: 'inout' },
          { t: (sg0 + 0.6 * L) * B, ...pt(g.from), zoom: g.zoom, yaw: g.yaw, ...flat, ease: 'land' },
          { t: sg1 * B - E, ...pt(g.to), zoom: g.zoom, yaw: g.yaw, ...flat }
        ]
      }
      if (g.kind === 'escape') return [{ t: sg0 * B, ...pt(g.centre), zoom: g.zoom, yaw: 0, ...flat, cut: true, ease: 'inout' }, { t: sg1 * B - E, ...pt(g.centre), zoom: g.zoom * 1.04, yaw: 0, ...flat }]
      return [{ t: sg0 * B, ...pt(optical(z3)), zoom: z3, yaw: 0, ...flat, cut: true, ease: 'inout' }, { t: sg1 * B - E, ...pt(optical(z3)), zoom: z3, yaw: 0, ...flat }]
    })
  ]
  const heroSheet = axoPoint(viewOf(beats.pull[1]), hero, 0)
  const turnKeys: CameraShot[] = [ob0, ...Array.from({ length: Math.round((beats.pull[1] - beats.tilt[1]) / 0.25) }, (_, i) => beats.tilt[1] + 0.25 * i)].map((b): CameraShot => {
    const f = smoothT(clamp((b - beats.tilt[1]) / Math.max(1e-6, beats.pull[1] - beats.tilt[1]), 0, 1))
    const v = viewOf(b)
    const zA = travelCam(travel?.b1 ?? b).zoom / v.k
    const zoom = zA ** (1 - f)
    const h = axoPoint(v, hero, 0)
    const target: P2 = [W / 2 + (heroSheet[0] - W / 2) * f, H / 2 + (heroSheet[1] - H / 2) * f]
    return { t: b * B, x: h[0] - (target[0] - W / 2) / zoom, y: h[1] - (target[1] - H / 2) / zoom, zoom, yaw: 0, ...flat, ease: 'linear' }
  })
  const zoom9 = Math.min(Math.max((0.95 * z3 * 1.03 * bw) / box.w, longUp ? (0.95 * z3 * 1.03 * bh) / box.h : 0), (0.86 * H) / box.h, (0.92 * W) / box.w)
  const shots: CameraShot[] = [
    ...flatKeys,
    ...(travel !== undefined ? turnKeys : [
      { t: ob0 * B, x: cx, y: cy, zoom: zoom9, yaw: 0, ...flat, ease: 'inout' as const },
      ...(stacked ? [
        { t: (beats.lift[1] + 0.5) * B, x: cx + column / (2 * zoom), y: cy - lift, zoom, yaw: 0, ...flat, ease: 'inout' as const },
        { t: (TA - 0.25) * B, x: cx + column / (2 * zoom * 1.03), y: cy - lift, zoom: zoom * 1.03, yaw: 0, ...flat, ease: 'inout' as const }
      ] : []),
      ...[...Array.from({ length: Math.floor((keyEnd - camFrom) / 0.25) + 1 }, (_, i) => camFrom + 0.25 * i), keyEnd]
        .filter((b, i, all) => b <= keyEnd && all.indexOf(b) === i)
        .map((b): CameraShot => ({ t: b * B, ...drawCam(b), yaw: 0, ...flat, ...(b < keyEnd ? {} : { ease: 'inout' as const }) })),
    ]),
    { t: beats.pull[1] * B, x: W / 2, y: H / 2, zoom: 1, yaw: 0, ...flat, ease: 'linear' },
    { t: 1, x: W / 2, y: H / 2, zoom: 1, yaw: 0, ...flat }
  ]

  const below = ((): PlotHidden[] | undefined => {
    if (travel === undefined) return undefined
    const from = (beats.tilt[0] - 0.5) * B
    const r0 = HIDDEN_CLEAR * heroSize
    const picked = stack.flatMap((l, i) => {
      const tl = inp.layers[l.layer]
      if (i === 0 || tl === undefined) return []
      const len = new Map<number, number>()
      const segs: Array<{ a: P2; b: P2; g: number }> = []
      for (let k = 0; k + 6 < tl.segs.length; k += 7) {
        const g = tl.groups[k / 7] as number
        const grp = inp.groups[g]
        const a: P2 = [tl.segs[k] as number, tl.segs[k + 1] as number]
        const b: P2 = [tl.segs[k + 2] as number, tl.segs[k + 3] as number]
        if (grp?.hero !== true || grp.kind === 'ground' || grp.kind === 'power' || Math.max(dist(a, hero), dist(b, hero)) < r0) continue
        segs.push(dist(a, hero) <= dist(b, hero) ? { a, b, g } : { a: b, b: a, g })
        len.set(g, (len.get(g) ?? 0) + dist(a, b))
      }
      const keep = new Set([...len.entries()].sort((x, y) => y[1] - x[1]).slice(0, HIDDEN_NETS).map(([g]) => g))
      return [{ layer: l.name, depth: (thick * i) / Math.max(1, stack.length - 1), segs: segs.filter((q) => keep.has(q.g)) }]
    })
    const far = Math.max(r0 + 1, ...picked.flatMap((h) => h.segs.map((q) => dist(q.b, hero))))
    const when = (q: P2): number => from + ((Math.max(0, dist(q, hero) - r0) / (far - r0)) * HIDDEN_GROW * B)
    return picked.map((h) => ({ layer: h.layer, depth: h.depth, segs: h.segs.flatMap((q) => [...q.a, ...q.b, when(q.a), Math.max(when(q.b), when(q.a) + 1e-4)]) }))
  })()
  const plot: PlotScore = {
    events: [],
    beats,
    film: { archetype: arch, plan: planKind, signature: sigData, shots: plan.map((q) => ({ kind: q.kind, t0: q.b0 * B, t1: q.b1 * B })), stations, sentence },
    shots: { nib: [nb0 * B, nb1 * B], bus: [bu0 * B, bu1 * B], outline: [ou0 * B, ou1 * B], object: [ob0 * B, ob1 * B], sheet: [sh0 * B, 1] },
    nib: { strokes: nibStrokes, ...(lidMark !== undefined ? { mark: lidMark } : {}) },
    bus: { strokes: busStrokes, sweep: busSweep, line: busLine, kind: busKind },
    hero: { pin1, pitch, label: heroLabel, subject: detailSubject },
    round,
    bodies: drawnBodies,
    stack,
    vias,
    marks,
    ...(ridePath !== undefined && rideStart !== undefined ? { signal: { nets: [...thingNets].map((id) => nameOf.get(id) ?? ''), mm: (rideStart.s0 + rideStart.cut) / ppm, longest: ridePath.far.d / ppm, from: rideStart.name, beside: [...thingNets].reduce((t, id) => t + besideShare(board, id) * copperOf(id), 0) / Math.max(1e-9, [...thingNets].reduce((t, id) => t + copperOf(id), 0)) } } : {}),
    ...(ink !== undefined ? { ink } : {}),
    ...(section !== undefined ? { section } : {}),
    ...(below !== undefined ? { hidden: below } : {}),
    features,
    tier: [],
    flow: { path: flowSegs, vias: flowVias, pins: flowPins, end: flEnd, ends: flowEnds },
    object: { x: cx, y: cy, zoom, lift, psi: [psiAt(TA), ridePsi], scale: rideScale, ...(turnSpan !== undefined ? { turn: turnSpan } : {}), e: CLOSE_E, planYaw, gap, hull, hullBoard: 2 * convex(outlinePts).length, callouts: placed, push, pull: 0, wave: travel === undefined ? wave.draws : risen, trail, route: routeEnds },
    sheet: {
      at: beats.sheet,
      frame: lay.frame,
      title: lay.title,
      ...R,
      iso,
      planAt,
      detailAt,
      elevationAt,
      detailR,
      board: callBoard,
      callouts: sheetPlan,
      cells: [stripCells(fields, R.block.w, su)],
      name: nameAt
    },
    facts: {
      name,
      title: fileTitle,
      issued: [tb?.company, tb?.date].filter((v): v is string => v !== undefined),
      sheet: sheetSize(Math.max(bw, bh) / inp.pxPerMm),
      version,
      date: tb?.date,
      ...facts0,
      detail: dk,
      vert: elevationAt.v,
      back: inp.back,
      rotated: turnPlan,
      turned,
      measured: inp.measured,
      holes: holeSchedule(board)
    }
  }
  plot.events = plotEvents(plot, filmFrames, W, H)
  if (power && trail.length > 0) return plotScore(inp, true, face, read, avoid)
  const chip = inp.parts.find((q) => q.hero === true)
  const naming = read === undefined && chip !== undefined ? nameRead(plot, shots, chip) : undefined
  if (naming?.turns === true) {
    const turned = plotScore(inp, signal, -1, naming.read, avoid)
    return { ...turned, moved: turned.moved || moved }
  }
  if (avoid && face === 1 && read === undefined && lidHidden > CHIP_HIDE) {
    const other = plotScore(inp, signal, -1, undefined, avoid)
    if (other.hidden <= CHIP_HIDE) return { ...other, moved: true }
  }
  const lettered = read ?? naming?.read
  if (lettered !== undefined) plot.hero.read = lettered
  return { shots, plot, hidden: lidHidden, moved }
}
