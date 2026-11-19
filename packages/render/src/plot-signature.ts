import { plotFrame, SHEET_TEXT } from '@silk-reel/choreo'
import type { PlotRect, PlotScore, PlotSigData, TraceScene } from '@silk-reel/choreo'
import { ID, apply, clamp01, dimension, drawPlan, easeInOut, knockout, lettered, setT, weights } from './plot-plan'
import type { Aff, Pen, Pt } from './plot-plan'

const textW = (n: number, size: number): number => n * size * 0.66

/** the stage the film draws its subject in: the frame above the name strip, inside the margins */
export function stageBox(pen: Pen): { x: number; y: number; w: number; h: number } {
  const m = 0.05 * Math.min(pen.W, pen.H)
  return { x: m, y: m, w: pen.W - 2 * m, h: pen.H - 2 * m }
}

/** a label landing whole: it fades in over four frames, kept inside the frame */
export function wiped(pen: Pen, text: string, x: number, y: number, size: number, frames: number, opts: { align?: CanvasTextAlign; color?: string; alpha?: number } = {}): void {
  if (frames < 0) return
  const k = clamp01((frames + 1) / 4)
  const w = textW(text.length, size)
  const edge = 0.015 * pen.W
  const want = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x
  const x0 = Math.max(edge, Math.min(pen.W - edge - w, want))
  x += x0 - want
  y = Math.max(edge + size, Math.min(stageBox(pen).y + stageBox(pen).h - 0.5 * size, y))
  lettered(pen, text, x, y, size, { ...opts, alpha: k * (opts.alpha ?? 1), free: true })
}

const line = (pen: Pen, pts: Pt[], width: number, color = pen.ink, k = 1): void => {
  if (k <= 0 || pts.length < 2) return
  const ctx = pen.ctx
  const lens = pts.slice(1).map((q, i) => Math.hypot(q[0] - (pts[i] as Pt)[0], q[1] - (pts[i] as Pt)[1]))
  let left = clamp01(k) * lens.reduce((a, b) => a + b, 0)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo((pts[0] as Pt)[0], (pts[0] as Pt)[1])
  for (let i = 1; i < pts.length && left > 0; i++) {
    const a = pts[i - 1] as Pt
    const b = pts[i] as Pt
    const q = Math.min(1, left / Math.max(1e-6, lens[i - 1] as number))
    left -= lens[i - 1] as number
    ctx.lineTo(a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q)
  }
  ctx.stroke()
}

const hatch = (pen: Pen, x: number, y: number, w: number, h: number, step: number, k = 1): void => {
  const ctx = pen.ctx
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w * clamp01(k), h)
  ctx.clip()
  ctx.strokeStyle = pen.ink
  ctx.lineWidth = weights(pen.u).f
  ctx.beginPath()
  for (let t = -h; t < w + h; t += step) {
    ctx.moveTo(x + t, y + h)
    ctx.lineTo(x + t + h, y)
  }
  ctx.stroke()
  ctx.restore()
}

/** where the finished section stands: px a millimetre, its centre line, and the board's top edge, for the cut to the standing valve to land on */
export function sectionFrame(pen: Pen, g: Extract<PlotSigData, { kind: 'section' }>): { s: number; cx: number; boardY: number } {
  const box = stageBox(pen)
  const lead = 3
  const total = g.heightMm + 0.14 * g.heightMm + g.boardMm + lead
  const s = Math.min((0.72 * box.h) / total, (0.4 * box.w) / g.diaMm) * 1.03
  const bot = box.y + 0.5 * box.h + (total * s) / 2
  return { s, cx: box.x + Math.max(0.36 * box.w, 0.72 * g.diaMm * s + 2.6 * SHEET_TEXT * pen.su), boardY: bot - lead * s - Math.max(g.boardMm * s, 6 * pen.u) }
}

/** the finished section, bare of its labels and dimensions, standing in a sheet panel's drawing area */
export function sectionPanel(pen: Pen, g: Extract<PlotSigData, { kind: 'section' }>, box: PlotRect): void {
  section(pen, g, 1, 0, 3, box)
}

function section(pen: Pen, g: Extract<PlotSigData, { kind: 'section' }>, k: number, frames: number, seconds: number, panelBox?: PlotRect): void {
  const box = panelBox ?? stageBox(pen)
  const { f, m, h } = weights(pen.u)
  const L = SHEET_TEXT * pen.su
  const ctx = pen.ctx
  const lead = 3
  const seatMm = 0.14 * g.heightMm
  const total = g.heightMm + seatMm + g.boardMm + lead
  const s = Math.min(((panelBox === undefined ? 0.72 : 0.8) * box.h) / total, (0.4 * box.w) / g.diaMm) * (1 + 0.03 * easeInOut(k))
  const dia = g.diaMm * s
  const cx = box.x + (panelBox === undefined ? Math.max(0.36 * box.w, 0.72 * dia + 2.6 * L) : 0.5 * box.w)
  const bot = box.y + 0.5 * box.h + (total * s) / 2
  const boardY = bot - lead * s - Math.max(g.boardMm * s, 6 * pen.u)
  const boardH = Math.max(g.boardMm * s, 6 * pen.u)
  const seatY = boardY - seatMm * s
  const top = seatY - g.heightMm * s
  const shoulder = top + dia / 2
  const u = 0.2 + 0.8 * clamp01((k * seconds) / 2.4)
  const step = (a: number, b: number): number => easeInOut((u - a) / (b - a))
  setT(pen, ID)
  const bw = Math.min(0.62 * box.w, 2.2 * dia)
  line(pen, [[cx - bw / 2, boardY], [cx + bw / 2, boardY], [cx + bw / 2, boardY + boardH], [cx - bw / 2, boardY + boardH], [cx - bw / 2, boardY]], m, pen.ink, 1)
  hatch(pen, cx - bw / 2, boardY, bw, boardH, 7 * pen.u, 1)
  const sw = 1.3 * dia
  line(pen, [[cx - sw / 2, boardY], [cx - sw / 2, seatY], [cx + sw / 2, seatY], [cx + sw / 2, boardY]], m, pen.ink, 1)
  for (const sd of [-1, 1]) hatch(pen, sd < 0 ? cx - sw / 2 : cx + dia / 2, seatY, sw / 2 - dia / 2, boardY - seatY, 7 * pen.u, 1)
  const pins = Math.max(2, g.pins)
  const xs = Array.from({ length: pins }, (_, i) => cx + 0.36 * dia * Math.cos(Math.PI * (i + 0.5) / pins - Math.PI))
  ctx.strokeStyle = pen.ink
  xs.forEach((x) => { line(pen, [[x, seatY + 0.3 * (boardY - seatY)], [x, boardY + boardH + 0.8 * lead * s]], m, pen.ink, 1) })
  const wall = 0.045 * dia
  const arc = (r: number): Pt[] => [[cx - r, seatY], [cx - r, shoulder], ...Array.from({ length: 25 }, (_, i): Pt => [cx - r * Math.cos((Math.PI * i) / 24), shoulder - r * Math.sin((Math.PI * i) / 24)]), [cx + r, shoulder], [cx + r, seatY]]
  line(pen, arc(dia / 2), h, pen.ink, step(0, 0.3))
  line(pen, arc(dia / 2 - wall), m, pen.ink, step(0.1, 0.36))
  const lo = seatY - 0.16 * g.heightMm * s
  const hi = shoulder + 0.06 * g.heightMm * s
  const km = step(0.3, 0.42)
  for (const y of [lo, hi]) line(pen, [[cx - 0.42 * dia, y], [cx + 0.42 * dia, y]], m, pen.ink, km)
  const units = [cx - 0.21 * dia, cx + 0.21 * dia]
  const ka = step(0.34, 0.5)
  const kg = step(0.44, 0.6)
  const kc = step(0.52, 0.66)
  const gap = 0.045 * g.heightMm * s
  const pw = 0.04 * dia
  ctx.fillStyle = pen.ink
  for (const ux of units) {
    for (const sd of [-1, 1]) {
      const x = ux + sd * 0.15 * dia
      line(pen, [[x - pw / 2, lo], [x - pw / 2, hi], [x + pw / 2, hi], [x + pw / 2, lo], [x - pw / 2, lo]], m, pen.ink, ka)
      hatch(pen, x - pw / 2, hi, pw, lo - hi, 5 * pen.u, ka)
      for (let y = hi + gap; y < lo; y += gap) {
        if ((y - hi) / (lo - hi) > kg) continue
        ctx.beginPath()
        ctx.arc(ux + sd * 0.09 * dia, y, Math.max(1.2 * pen.u, 0.01 * dia), 0, Math.PI * 2)
        ctx.fill()
      }
      line(pen, [[ux + sd * 0.04 * dia, lo + 0.04 * (lo - hi)], [ux + sd * 0.04 * dia, hi - 0.04 * (lo - hi)]], m, pen.ink, kc)
    }
  }
  const right = units[1] as number
  const parts: Array<{ name: string; x: number; y: number }> = [
    { name: 'ANODE', x: right + 0.15 * dia, y: hi },
    { name: 'GRID', x: right + 0.09 * dia, y: hi + gap },
    { name: 'CATHODE', x: right + 0.04 * dia, y: hi - 0.04 * (lo - hi) },
    { name: 'HEATER', x: right + 0.015 * dia, y: hi }
  ]
  const kh = step(0.6, 0.8)
  const a = xs[0] as number
  const b = xs[pins - 1] as number
  const band = 0.008 * pen.W
  const leg = (ux: number): Pt[] => [[ux - 0.015 * dia, lo], [ux - 0.015 * dia, hi], [ux + 0.015 * dia, hi], [ux + 0.015 * dia, lo]]
  const heater: Pt[] = [[a, boardY + boardH + 0.8 * lead * s], [a, seatY], ...leg(units[0] as number), ...leg(right), [b, seatY], [b, boardY + boardH + 0.8 * lead * s]]
  line(pen, heater, band, pen.accent, kh)
  if (panelBox !== undefined) return
  const order = ['HEATER', 'CATHODE', 'GRID', 'ANODE']
  const tx = cx + dia / 2 + 0.16 * box.w
  order.forEach((name, i) => {
    const q = parts.find((r) => r.name === name)
    const kl = step(0.62 + 0.08 * i, 0.7 + 0.08 * i)
    if (q === undefined || kl <= 0) return
    const level = hi - (0.9 + 1.5 * (order.length - 1 - i)) * L
    const ty = level + 0.3 * L
    line(pen, [[q.x, q.y], [q.x, level], [tx - 0.3 * L, level]], f, name === 'HEATER' ? pen.accent : pen.ink, kl)
    if (kl >= 1) wiped(pen, name, tx, ty, L, Math.round((u - 0.7 - 0.08 * i) * 1.6 * 30), name === 'HEATER' ? { color: pen.accent } : {})
  })
  const kd = step(0.86, 1)
  if (kd > 0) {
    dimension(pen, [cx - dia / 2, seatY], [cx - dia / 2, top], -(0.22 * dia + 1.4 * L), g.heightMm.toFixed(1), { size: L, grow: kd })
    dimension(pen, [cx - dia / 2, shoulder], [cx + dia / 2, shoulder], -(dia / 2 + 1.4 * L), `Ø${g.diaMm.toFixed(1)}`, { size: L, grow: kd })
  }
}

function header(pen: Pen, g: Extract<PlotSigData, { kind: 'header' }>, k: number, frames: number, len: number): void {
  const box = stageBox(pen)
  const { f, m, h } = weights(pen.u)
  const L = SHEET_TEXT * pen.su
  const ctx = pen.ctx
  const n = g.pads.length
  if (n === 0) return
  const cx0 = g.pads.reduce((t, q) => t + q[0], 0) / n
  const cy0 = g.pads.reduce((t, q) => t + q[1], 0) / n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const q of g.pads) {
    sxx += (q[0] - cx0) ** 2
    syy += (q[1] - cy0) ** 2
    sxy += (q[0] - cx0) * (q[1] - cy0)
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const along = (q: [number, number, number, number]): number => Math.cos(th) * (q[0] - cx0) + Math.sin(th) * (q[1] - cy0)
  const across = (q: [number, number, number, number]): number => -Math.sin(th) * (q[0] - cx0) + Math.cos(th) * (q[1] - cy0)
  const ts = g.pads.map(along)
  const gaps = ts.flatMap((t, a) => ts.filter((_, b) => b !== a).map((o) => Math.abs(o - t))).filter((d) => d > 1e-3).sort((a, b) => a - b)
  const pitch = gaps[0] ?? 1
  const cols = Math.round((Math.max(...ts) - Math.min(...ts)) / pitch) + 1
  const cs = g.pads.map(across)
  const lines = Math.max(1, Math.min(2, g.lines))
  const top = Math.min(...cs)
  const lineOf = (i: number): number => (lines > 1 && (cs[i] as number) - top > 0.5 * pitch ? 1 : 0)
  const colOf = (i: number): number => Math.round(((ts[i] as number) - Math.min(...ts)) / pitch)
  const chars = Math.min(9, Math.max(3, ...g.rows.map((r) => r.net.length)))
  const LT = textW(chars, L) + 0.6 * L
  const elevUnits = g.male ? (2.5 + 6 + 3) / 2.54 : (8.5 + 3) / 2.54
  const head = 1.8 * L
  const room = box.h
  const sp = Math.min((0.86 * box.w) / (cols + 0.4), (room - head - lines * LT - 1.2 * L) / (lines + 0.4 + elevUnits)) * (0.97 + 0.03 * easeInOut(k))
  const wd = (cols + 0.4) * sp
  const x0 = box.x + (box.w - wd) / 2
  const planY = box.y + head + LT
  const planH = (lines + 0.4) * sp
  const pinX = (c: number): number => x0 + (c + 0.7) * sp
  const pinY = (l: number): number => planY + (l + 0.7) * sp
  setT(pen, ID)
  ctx.strokeStyle = pen.ink
  line(pen, [[x0, planY], [x0 + wd, planY], [x0 + wd, planY + planH], [x0, planY + planH], [x0, planY]], h, pen.ink, 1)
  ctx.lineWidth = m
  for (let i = 0; i < n; i++) {
    const r = 0.22 * sp
    const x = pinX(colOf(i))
    const y = pinY(lineOf(i))
    ctx.beginPath()
    ctx.rect(x - r, y - r, 2 * r, 2 * r)
    if (g.male) {
      ctx.fillStyle = (g.rows[i]?.supply ?? false) ? pen.accent : pen.ink
      ctx.fill()
    } else ctx.stroke()
    if (g.rows[i]?.num === '1') {
      ctx.beginPath()
      ctx.moveTo(x - 0.5 * sp, y - 0.5 * sp + 0.25 * sp)
      ctx.lineTo(x - 0.5 * sp + 0.25 * sp, y - 0.5 * sp)
      ctx.stroke()
    }
  }
  const elevTop = planY + planH + (lines > 1 ? LT : 0) + 1.2 * L
  const house = (g.male ? 2.5 : 8.5) / 2.54 * sp
  const postUp = g.male ? 6 / 2.54 * sp : 0
  const tail = 3 / 2.54 * sp
  const base = elevTop + postUp + house
  line(pen, [[x0, base - house], [x0 + wd, base - house], [x0 + wd, base], [x0, base], [x0, base - house]], h, pen.ink, 1)
  ctx.fillStyle = pen.ink
  for (let c = 0; c < cols; c++) {
    const x = pinX(c)
    const r = 0.11 * sp
    ctx.fillRect(x - r, base, 2 * r, tail)
    if (g.male) ctx.fillRect(x - r, elevTop, 2 * r, postUp)
  }
  line(pen, [[x0 - 0.3 * sp, base], [x0 + wd + 0.3 * sp, base]], f, pen.ink, 1)
  wiped(pen, `${g.ref} · ${g.value.split(/[-\s/]/)[0] ?? ''}`.replace(/ · $/, ''), box.x + 0.4 * L, box.y + 1.4 * L, L, frames)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lineOf(a) - lineOf(b) || colOf(a) - colOf(b))
  const span = Math.max(1, len - 12)
  order.forEach((i, rank) => {
    const r = g.rows[i]
    if (r === undefined) return
    const at = Math.round((rank * span) / n)
    const since = frames - at
    if (since < 0) return
    const l = lineOf(i)
    const x = pinX(colOf(i))
    const y1 = l === 0 ? planY - 0.3 * L : planY + planH + 0.3 * L
    const color = r.supply ? pen.accent : pen.ink
    line(pen, [[x, l === 0 ? pinY(0) - 0.25 * sp : pinY(1) + 0.25 * sp], [x, y1]], f, color, clamp01((since + 1) / 3))
    if (since < 3) return
    const text = r.net.slice(0, chars)
    const w = textW(text.length, L)
    ctx.save()
    setT(pen, [0, -1, 1, 0, x + 0.36 * L, y1])
    ctx.beginPath()
    ctx.rect(l === 0 ? -2 : -w - 2, -1.2 * L, (w + 4) * clamp01((since - 2) / 4), 1.6 * L)
    ctx.clip()
    lettered(pen, text, 0, 0, L, { align: l === 0 ? 'left' : 'right', color, free: true })
    ctx.restore()
    setT(pen, ID)
  })
}

function escape(pen: Pen, g: Extract<PlotSigData, { kind: 'escape' }>, m: Aff, k: number, frames: number): void {
  const { m: c } = weights(pen.u)
  const L = SHEET_TEXT * pen.su
  setT(pen, ID)
  const n = g.pins.length
  g.pins.forEach((pn, i) => {
    const kk = clamp01((k * 1.15 * n - i) / 1.5)
    if (kk <= 0) return
    const pts = Array.from({ length: pn.path.length / 2 }, (_, j) => apply(m, pn.path[2 * j] as number, pn.path[2 * j + 1] as number))
    line(pen, pts, pn.supply ? 2.5 * c : c, pn.supply ? pen.accent : pen.ink, kk)
  })
  const a = g.pins[0]
  const b = g.pins[1]
  if (a !== undefined && b !== undefined && g.pitchMm > 0 && k > 0.5) {
    const pa = apply(m, a.at[0], a.at[1])
    const pb = apply(m, b.at[0], b.at[1])
    const end = dimension(pen, pa, pb, 3 * L, '', { size: L, grow: (k - 0.5) / 0.2 })
    if (end !== undefined) wiped(pen, `PITCH ${g.pitchMm.toFixed(2)} MM`, end[0], end[1], L, frames)
  }
}

function fingers(pen: Pen, g: Extract<PlotSigData, { kind: 'fingers' }>, m: Aff, k: number, frames: number): void {
  const L = SHEET_TEXT * pen.su
  const sp = g.pads[g.supply]
  setT(pen, ID)
  if (sp !== undefined) {
    const corners: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, y]) => apply(m, sp[0] + ((x as number) * sp[2]) / 2, sp[1] + ((y as number) * sp[3]) / 2))
    line(pen, corners, weights(pen.u).m, pen.accent, clamp01(k / 0.3))
  }
  const a = g.pads[0]
  const b = g.pads[1]
  if (a !== undefined && b !== undefined && k < 0.6) {
    const pa = apply(m, a[0], a[1])
    const pb = apply(m, b[0], b[1])
    const end = dimension(pen, pa, pb, 4 * L, '', { size: L, grow: k / 0.15 })
    if (end !== undefined) wiped(pen, `${g.pads.length} × ${g.pitchMm.toFixed(2)} MM`, end[0], end[1], L, frames - 4)
  }
}

function travel(pen: Pen, k: number, frames: number, lengthMm: number): void {
  const box = stageBox(pen)
  const L = SHEET_TEXT * pen.su
  const portrait = pen.H > 1.15 * pen.W
  const a: Pt = portrait ? [box.x + 1.2 * L, box.y + 0.06 * box.h] : [box.x + 0.06 * box.w, box.y + box.h - 1.2 * L]
  const b: Pt = portrait ? [a[0], box.y + 0.94 * box.h] : [box.x + 0.94 * box.w, a[1]]
  const head: Pt = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
  setT(pen, ID)
  line(pen, [a, head], weights(pen.u).f)
  const ctx = pen.ctx
  ctx.fillStyle = pen.ink
  ctx.beginPath()
  ctx.arc(head[0], head[1], 3 * pen.u, 0, Math.PI * 2)
  ctx.fill()
  const text = `${(lengthMm * k).toFixed(1)} MM`
  const at: Pt = portrait ? [head[0] + 0.6 * L, Math.min(head[1] + 0.4 * L, box.y + box.h - 0.3 * L)] : [Math.min(head[0], box.x + box.w - textW(text.length, L)), head[1] - 0.6 * L]
  knockout(pen, () => { ctx.fillRect(at[0] - 4 * pen.u, at[1] - 1.05 * L, textW(text.length, L) + 8 * pen.u, 1.35 * L) })
  wiped(pen, text, at[0], at[1], L, frames)
}

function ordinates(pen: Pen, g: Extract<PlotSigData, { kind: 'travel' }>, m: Aff, k: number, frames: number, len: number): void {
  const L = SHEET_TEXT * pen.su
  const w = weights(pen.u)
  const total = Math.max(1, ...g.marks.map((q) => q.at))
  const nrm: Pt = [-g.dir[1], g.dir[0]]
  const at = (t: number, n: number): Pt => apply(m, g.datum[0] + g.dir[0] * t + nrm[0] * n, g.datum[1] + g.dir[1] * t + nrm[1] * n)
  const a = at(0, g.half)
  const far = at(0, -g.half)
  const ol = Math.hypot(a[0] - far[0], a[1] - far[1]) || 1
  const o: Pt = [(a[0] - far[0]) / ol, (a[1] - far[1]) / ol]
  const gut = 2.2 * L
  setT(pen, ID)
  const s = easeInOut(clamp01((k - 0.06) / 0.6)) * total
  const rail = 0.6 * gut
  const onRail = (t: number, n = 0): Pt => {
    const e = at(t, g.half)
    return [e[0] + o[0] * (rail + n), e[1] + o[1] * (rail + n)]
  }
  const tick = (t: number, label: string, since: number): void => {
    const e = at(t, g.half)
    line(pen, [[e[0] + o[0] * 0.3 * L, e[1] + o[1] * 0.3 * L], onRail(t, 0.45 * L)], w.f, pen.ink, clamp01((since + 1) / 5))
    if (since >= 3) wiped(pen, label, onRail(t, 0.9 * L)[0], onRail(t, 0.9 * L)[1] + 0.35 * L, L, since - 3, { align: o[0] < 0 ? 'right' : 'left' })
  }
  const r0 = onRail(0)
  pen.ctx.fillStyle = pen.ink
  pen.ctx.beginPath()
  pen.ctx.arc(r0[0], r0[1], 0.22 * L, 0, 2 * Math.PI)
  pen.ctx.fill()
  if (s > 0) line(pen, [r0, onRail(s)], w.m, pen.ink)
  tick(0, '0', frames)
  const pos = at(s, g.half)
  if (k > 0.06 && s < total - 1e-6) {
    const q = at(s, -g.half - 0.4)
    line(pen, [q, [pos[0] + o[0] * gut * 0.9, pos[1] + o[1] * gut * 0.9]], w.f, pen.ink)
  }
  g.marks.forEach((q) => {
    if (s < q.at - 1e-6) return
    const reach = (q.at / total) * 0.6 + 0.06
    tick(q.at, q.mm.toFixed(1), frames - Math.round(reach * len))
  })
}

/** the signature shot: the drawing the board's archetype calls for, k of the way through the shot */
export function drawSignature(pen: Pen, s: TraceScene, plot: PlotScore, m: Aff, p: number, frames: number): number {
  const sig = plot.film.shots.find((q) => q.kind === 'signature')
  if (sig === undefined) return 0
  const k = clamp01((p - sig.t0) / (sig.t1 - sig.t0))
  const since = Math.round(plotFrame(p, frames) - plotFrame(sig.t0, frames))
  const len = plotFrame(sig.t1, frames) - plotFrame(sig.t0, frames)
  const g = plot.film.signature
  if (g.kind === 'section') {
    section(pen, g, k, since, len / 30)
    return 1
  }
  if (g.kind === 'header') {
    header(pen, g, k, since, len)
    return 1
  }
  const drawn = drawPlan(pen, s, m, g.kind === 'escape' ? { construction: true } : { edge: 1, back: 1, drills: 3, hatch: 1, parts: 1, fine: 0.75, weight: 1.6 })
  if (g.kind === 'escape') escape(pen, g, m, k, since)
  else if (g.kind === 'fingers') {
    fingers(pen, g, m, k, since)
    if (k > 0.6) travel(pen, (k - 0.6) / 0.4, since - Math.round(0.6 * len), Math.max(plot.facts.widthMm, plot.facts.heightMm))
  } else if (g.kind === 'travel') ordinates(pen, g, m, k, since, len)
  return drawn + 1
}

const inPoly = (q: Pt, poly: Pt[]): boolean => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Pt
    const b = poly[j] as Pt
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

const boxHits = (r: { x: number; y: number; w: number; h: number }, poly: Pt[]): boolean => {
  const pts: Pt[] = []
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) pts.push([r.x + (r.w * i) / 4, r.y + (r.h * j) / 2])
  return pts.some((q) => inPoly(q, poly)) || poly.some((q) => q[0] > r.x && q[0] < r.x + r.w && q[1] > r.y && q[1] < r.y + r.h)
}

/**
 * The station tags: each stop on the power path is named in an accent pill
 * as the ink reaches it, the last three on screen at once, each outside the
 * subject's silhouette on a hairline leader to its point.
 */
export function stationPills(pen: Pen, plot: PlotScore, p: number, frames: number, at: ((x: number, y: number) => Pt) | undefined, sil: Pt[], avoid: Array<{ x: number; y: number; w: number; h: number }> = []): void {
  const reached = plot.film.stations.filter((st) => st.t <= p)
  const show = reached.slice(-3)
  if (show.length === 0) return
  const L = SHEET_TEXT * pen.su
  const box = stageBox(pen)
  const ctx = pen.ctx
  const { f } = weights(pen.u)
  const c: Pt = sil.length > 0 ? [sil.reduce((t, q) => t + q[0], 0) / sil.length, sil.reduce((t, q) => t + q[1], 0) / sil.length] : [box.x + box.w / 2, box.y + box.h / 2]
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [...avoid]
  setT(pen, ID)
  show.forEach((st, i) => {
    const w = textW(st.text.length, L) + 0.9 * L
    const h = 1.45 * L
    const q = at?.(st.x, st.y)
    const clear = (r: { x: number; y: number; w: number; h: number }): boolean => r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h && (sil.length < 3 || !boxHits({ x: r.x - 0.3 * L, y: r.y - 0.3 * L, w: r.w + 0.6 * L, h: r.h + 0.6 * L }, sil)) && placed.every((o) => r.x > o.x + o.w + 0.3 * L || o.x > r.x + r.w + 0.3 * L || r.y > o.y + o.h + 0.3 * L || o.y > r.y + r.h + 0.3 * L)
    let rect: { x: number; y: number; w: number; h: number } | undefined
    if (q !== undefined) {
      const d0 = Math.atan2(q[1] - c[1], q[0] - c[0])
      for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, Math.PI]) {
        const d: Pt = [Math.cos(d0 + turn), Math.sin(d0 + turn)]
        for (let t = 0.6 * L; t < Math.max(pen.W, pen.H) && rect === undefined; t += 0.5 * L) {
          const r = { x: q[0] + d[0] * t - w / 2, y: q[1] + d[1] * t - h / 2, w, h }
          if (clear(r)) rect = r
        }
        if (rect !== undefined) break
      }
    } else {
      const r = { x: box.x + box.w - w - 0.4 * L, y: box.y + box.h - (show.length - i) * (h + 0.4 * L), w, h }
      if (clear(r)) rect = r
    }
    if (rect === undefined) return
    placed.push(rect)
    const since = Math.round(plotFrame(p, frames) - plotFrame(st.t, frames))
    knockout(pen, () => { ctx.fillRect(rect.x, rect.y, rect.w, rect.h) })
    ctx.strokeStyle = pen.accent
    ctx.lineWidth = f
    if (q !== undefined) {
      const e: Pt = [Math.min(rect.x + rect.w, Math.max(rect.x, q[0])), Math.min(rect.y + rect.h, Math.max(rect.y, q[1]))]
      ctx.beginPath()
      ctx.moveTo(q[0], q[1])
      ctx.lineTo(e[0], e[1])
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 0.3 * rect.h)
    ctx.stroke()
    lettered(pen, st.text, rect.x + 0.45 * L, rect.y + 1.05 * L, L, { color: pen.accent, chars: 2 * (since + 1), free: true })
  })
}
