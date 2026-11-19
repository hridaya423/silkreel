import { calloutSize, placeCallouts, SHEET_SUB } from '@silk-reel/choreo'
import type { PlotCallout, PlotRect, PlotScore, TraceScene } from '@silk-reel/choreo'
import { apply, bleed, geo, knockout, layerPaths, lettered, mul, scaleOf, setT, weights } from './plot-plan'
import { body, drawCallouts } from './plot-object'
import type { Aff, Pen, Pt } from './plot-plan'

const C30 = Math.cos(Math.PI / 6)
const S30 = 0.5

interface Iso {
  at: (z: number) => Aff
  gap: number
  sig: number
}


/** the stack panel's label rows top down, one line a layer, its name then its plain role; the parts count leads when the panel is tall enough */
export const stackRows = (plot: PlotScore, area: { w: number; h: number }, u: number): Array<{ text: string; sub: string; layer: number }> => {
  const layers = plot.stack.map((l, i) => {
    const name = l.name.toUpperCase()
    const role = l.role.replace(/ COPPER$| PLANE$/, '')
    return { text: name.includes(role) ? name : `${name} ${role}`, sub: '', layer: i }
  })
  const all = [{ text: `${plot.facts.parts} PARTS`, sub: '', layer: -1 }, ...layers]
  return all.length * STACK_ROW * SHEET_SUB * u + (all.length - 1) * STACK_GAP * u <= 0.92 * area.h ? all : layers
}

const STACK_ROW = 1.05
const STACK_GAP = 2
/** below this share of the panel left beside the label column, the labels list under the drawing */
const STACK_NARROW = 0.25

/** the stack drawing and its labels in a panel: the drawing beside one column of labels the margin planner places */
export function stackLayout(s: TraceScene, plot: PlotScore, area: PlotRect, u: number): Iso & { drawing: PlotRect; rows: Array<{ text: string; sub: string; at: Pt; rect: PlotRect | undefined }>; section?: { x: number; w: number; y0: number; rowH: number; layers: number[] } } {
  const { x0, y0, x1, y1 } = geo(s).bounds
  const mx = (x0 + x1) / 2
  const my = (y0 + y1) / 2
  const phi = y1 - y0 > 1.2 * (x1 - x0) ? Math.PI / 2 : 0
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const base: Aff = [C30 * (cp - sp), S30 * (cp + sp), C30 * (-sp - cp), S30 * (cp - sp), 0, 0]
  const centred = (z: number): Aff => [base[0], base[1], base[2], base[3], -(base[0] * mx + base[2] * my), -z - (base[1] * mx + base[3] * my)]
  const n = plot.stack.length
  const span = Math.max(x1 - x0, y1 - y0)
  const tall = Math.max(0, ...s.parts.map((p) => p.z))
  const wideRows = stackRows(plot, area, u)
  const rows = area.w - Math.max(...wideRows.map((r) => calloutSize(r.text, r.sub, u, SHEET_SUB, SHEET_SUB).w)) - 30 * u < STACK_NARROW * area.w ? stackRows(plot, { w: area.w, h: 0.55 * area.h }, u) : wideRows
  const sized = rows.map((r) => ({ ...r, w: calloutSize(r.text, r.sub, u, SHEET_SUB, SHEET_SUB).w, h: STACK_ROW * SHEET_SUB * u }))
  const wide = Math.max(...sized.map((r) => r.w)) + 30 * u
  const narrow = area.w - wide < STACK_NARROW * area.w
  const listH = narrow ? sized.length * STACK_ROW * SHEET_SUB * u + (sized.length - 1) * STACK_GAP * u : 0
  const column = narrow ? 0 : wide
  const room = area.w - column
  const dh = area.h - listH - (narrow ? 1.2 * SHEET_SUB * u : 0)
  const flat = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => apply(centred(0), x as number, y as number))
  const fw = Math.max(...flat.map((c) => c[0])) - Math.min(...flat.map((c) => c[0]))
  const fh = Math.max(...flat.map((c) => c[1])) - Math.min(...flat.map((c) => c[1]))
  const gap = narrow ? 0.2 * span : Math.min(1.2 * span, Math.max(span * (n > 2 ? 0.36 : 0.5), ((dh / Math.max(1, room)) * fw - fh - tall) / Math.max(1, n)))
  const top = n * gap
  const corners: Pt[] = []
  for (const z of [0, top + tall]) for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) corners.push(apply(centred(z), x, y))
  const ix0 = Math.min(...corners.map((c) => c[0]))
  const ix1 = Math.max(...corners.map((c) => c[0]))
  const iy0 = Math.min(...corners.map((c) => c[1]))
  const iy1 = Math.max(...corners.map((c) => c[1]))
  const sig = Math.min(room / (ix1 - ix0), dh / (iy1 - iy0))
  const ox = area.x + (room - sig * (ix1 - ix0)) / 2 - sig * ix0
  const oy = area.y + (dh - sig * (iy1 - iy0)) / 2 - sig * iy0
  const at = (z: number): Aff => {
    const c = centred(z)
    return [sig * c[0], sig * c[1], sig * c[2], sig * c[3], sig * c[4] + ox, sig * c[5] + oy]
  }
  const zOf = (i: number): number => (n * gap) / 2 + (n - 1 - i - n / 2) * gap
  const zParts = zOf(0) + 0.6 * gap
  const drawing = { x: ox + sig * ix0, y: oy + sig * iy0, w: sig * (ix1 - ix0), h: sig * (iy1 - iy0) }
  const items = sized.map((r) => {
    const m = at(r.layer < 0 ? zParts : zOf(r.layer))
    let best: Pt = [-Infinity, 0]
    for (const loop of s.board) for (let j = 0; j + 1 < loop.length; j += 2) {
      const q = apply(m, loop[j] as number, loop[j + 1] as number)
      if (q[0] > best[0]) best = q
    }
    return { ...r, at: best }
  })
  if (narrow) {
    const short = items.map((it) => {
      const text = it.text.replace(/^IN(\d+)\.CU /, 'IN$1 ').replace(/ (TOP|BOTTOM)$/, '')
      return { ...it, text, w: calloutSize(text, it.sub, u, SHEET_SUB, SHEET_SUB).w }
    })
    const lw = Math.max(...short.map((it) => it.w))
    const barW = Math.max(0.2 * area.w, area.w - lw - 2.2 * SHEET_SUB * u)
    const rowH = Math.min(area.h / short.length, 2.4 * SHEET_SUB * u)
    const y0 = area.y + (area.h - rowH * short.length) / 2
    return {
      at, gap, sig, drawing: { x: area.x, y: y0, w: barW, h: rowH * short.length },
      section: { x: area.x, w: barW, y0, rowH, layers: short.map((it) => it.layer) },
      rows: short.map((it, i) => ({ text: it.text, sub: it.sub, at: [area.x + barW + 0.3 * SHEET_SUB * u, y0 + (i + 0.5) * rowH] as Pt, rect: { x: area.x + barW + 1.1 * SHEET_SUB * u, y: y0 + (i + 0.5) * rowH - it.h / 2, w: it.w, h: it.h } }))
    }
  }
  const plan: PlotCallout[] = items.map((_, i) => ({ item: i, side: 1, row: 0, order: i }))
  const rects = placeCallouts(items, plan, drawing, { x0: area.x, y0: area.y, x1: area.x + area.w, y1: area.y + area.h }, u, STACK_GAP)
  return { at, gap, sig, drawing, rows: items.map((it, i) => ({ text: it.text, sub: it.sub, at: it.at, rect: rects[i] })) }
}

/** a two-layer board's copper, each side flat and the bottom seen from below, side by side or one over the other, whichever draws them larger, each named under it */
function copperSides(pen: Pen, s: TraceScene, plot: PlotScore, base: Aff, area: PlotRect): number {
  const ctx = pen.ctx
  const g = geo(s)
  const { f, h } = weights(pen.u)
  const T = SHEET_SUB * pen.su
  const bw = g.bounds.x1 - g.bounds.x0
  const bh = g.bounds.y1 - g.bounds.y0
  const gap = 1.2 * T
  const name = 1.8 * T
  const across = Math.min((area.w - gap) / (2 * bw), (area.h - name) / bh)
  const down = Math.min(area.w / bw, (area.h - 2 * name - gap) / (2 * bh))
  const side = across >= down
  const k = Math.max(0, side ? across : down)
  const cells = plot.stack.map((_, i): Pt => (side ? [area.x + (area.w - 2 * k * bw - gap) / 2 + i * (k * bw + gap), area.y + (area.h - name - k * bh) / 2] : [area.x + (area.w - k * bw) / 2, area.y + (area.h - 2 * (k * bh + name) - gap) / 2 + i * (k * bh + name + gap)]))
  const tight = side && Math.max(...plot.stack.map((l) => l.name.length)) * 0.72 * T > k * bw + 0.8 * gap
  plot.stack.forEach((layer, i) => {
    const [x, y] = cells[i] as Pt
    const below = i === plot.stack.length - 1
    const m: Aff = below ? [-k, 0, 0, k, x + k * g.bounds.x1, y - k * g.bounds.y0] : [k, 0, 0, k, x - k * g.bounds.x0, y - k * g.bounds.y0]
    const at = mul(base, m)
    const lp = layerPaths(s, layer.name, layer.layer, layer.zones)
    const px = (v: number): number => v / (scaleOf(at) || 1)
    setT(pen, at)
    ctx.strokeStyle = pen.ink
    ctx.globalAlpha = 0.9
    ctx.lineWidth = px(f)
    ctx.stroke(lp.lines)
    ctx.globalAlpha = 1
    ctx.lineWidth = px(h)
    ctx.stroke(g.outline)
    setT(pen, base)
    const full = `${layer.name.toUpperCase()} · FROM BELOW`
    const text = below && full.length * 0.72 * T <= k * bw + gap ? full : layer.name.toUpperCase()
    if (!tight) lettered(pen, text, x + (k * bw) / 2, y + k * bh + 1.3 * T, T, { align: 'center', spacing: 0.06 })
  })
  if (tight) {
    const [x, y] = cells[0] as Pt
    setT(pen, base)
    lettered(pen, plot.stack.map((l) => l.name.toUpperCase()).join(' | '), x + k * bw + gap / 2, y + k * bh + 1.3 * T, T, { align: 'center', spacing: 0.06 })
  }
  bleed(pen, false)
  return 2 * plot.stack.length
}

export function drawStack(pen: Pen, s: TraceScene, plot: PlotScore, base: Aff, area: PlotRect): number {
  if (plot.stack.length === 2) return copperSides(pen, s, plot, base, area)
  const ctx = pen.ctx
  const iso = stackLayout(s, plot, area, pen.su)
  const { f, m, h } = weights(pen.u)
  const n = plot.stack.length
  const zOf = (i: number): number => (n * iso.gap) / 2 + (n - 1 - i - n / 2) * iso.gap
  const zTop = zOf(0)
  const zParts = zTop + 0.6 * iso.gap
  const px = (v: number): number => v / (iso.sig * 0.8)
  const g = geo(s)
  let drawn = 0
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const sec = iso.section
  if (sec !== undefined) {
    setT(pen, base)
    ctx.strokeStyle = pen.ink
    sec.layers.forEach((layer, i) => {
      const y = sec.y0 + (i + 0.5) * sec.rowH
      if (layer < 0) {
        ctx.lineWidth = m
        for (const k of [0.12, 0.42, 0.7]) ctx.strokeRect(sec.x + k * sec.w, y - 0.15 * sec.rowH, 0.18 * sec.w, 0.45 * sec.rowH)
        return
      }
      const t = 0.36 * sec.rowH
      ctx.lineWidth = layer === 0 ? h : m
      ctx.strokeRect(sec.x, y - t / 2, sec.w, t)
      ctx.save()
      ctx.beginPath()
      ctx.rect(sec.x, y - t / 2, sec.w, t)
      ctx.clip()
      ctx.lineWidth = f
      ctx.globalAlpha = layer === 0 ? 0.7 : 0.4
      ctx.beginPath()
      for (let x = sec.x - t; x < sec.x + sec.w; x += (layer === 0 ? 5 : 9) * pen.u) {
        ctx.moveTo(x, y + t / 2)
        ctx.lineTo(x + t, y - t / 2)
      }
      ctx.stroke()
      ctx.restore()
      ctx.globalAlpha = 1
    })
    const ys = sec.layers.map((l, i) => (l < 0 ? undefined : sec.y0 + (i + 0.5) * sec.rowH)).filter((y): y is number => y !== undefined)
    ctx.lineWidth = f
    ctx.setLineDash([6 * pen.u, 4 * pen.u])
    ctx.beginPath()
    for (const k of [0.3, 0.75]) {
      ctx.moveTo(sec.x + k * sec.w, Math.min(...ys))
      ctx.lineTo(sec.x + k * sec.w, Math.max(...ys))
    }
    ctx.stroke()
    ctx.setLineDash([])
    const k = scaleOf(base)
    drawCallouts(pen, iso.rows.flatMap((r) => {
      if (r.rect === undefined) return []
      const p0 = apply(base, r.rect.x, r.rect.y)
      return [{ at: apply(base, r.at[0], r.at[1]), rect: { x: p0[0], y: p0[1], w: r.rect.w * k, h: r.rect.h * k }, text: r.text, sub: r.sub, grow: Infinity, alpha: 1 }]
    }), SHEET_SUB * pen.su * k, SHEET_SUB * pen.su * k)
    bleed(pen, false)
    return sec.layers.length + iso.rows.length
  }

  for (let i = n - 1; i >= 0; i--) {
    const layer = plot.stack[i]
    if (layer === undefined) continue
    const at = mul(base, iso.at(zOf(i)))
    setT(pen, at)
    knockout(pen, () => {
      ctx.globalAlpha = pen.transparent ? 1 : 0.86
      ctx.fill(g.outline, 'evenodd')
      ctx.globalAlpha = 1
    })
    const lp = layerPaths(s, layer.name, layer.layer, layer.zones)
    ctx.strokeStyle = pen.ink
    ctx.setLineDash([])
    setT(pen, at)
    ctx.strokeStyle = pen.ink
    ctx.globalAlpha = i === 0 ? 0.5 : 0.26
    ctx.lineWidth = px(f)
    ctx.stroke(lp.zones)
    ctx.globalAlpha = i === 0 ? 0.95 : 0.3
    ctx.lineWidth = px(i === 0 ? 1.2 * f : f)
    ctx.stroke(lp.lines)
    ctx.globalAlpha = 1
    ctx.lineWidth = px(i === 0 ? h : m)
    ctx.stroke(g.outline)
    drawn += 4
  }

  const zBot = zOf(n - 1)
  {
    setT(pen, base)
    ctx.strokeStyle = pen.ink
    ctx.lineWidth = f
    ctx.globalAlpha = 0.9
    ctx.setLineDash([6 * pen.u, 4 * pen.u])
    const top = iso.at(zTop)
    const bot = iso.at(zBot)
    ctx.beginPath()
    for (let j = 0; j + 1 < plot.vias.length; j += 2) {
      const vx = plot.vias[j] as number
      const vy = plot.vias[j + 1] as number
      const a = apply(top, vx, vy)
      const b = apply(bot, vx, vy)
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    drawn += 1
  }

  const parts = s.parts.filter((p) => p.kind !== 'pin')
  const ground = iso.at(0)
  const order = parts.map((p) => ({ p, d: apply(ground, p.x, p.y)[1] })).sort((a, b) => a.d - b.d)
  setT(pen, base)
  {
    const at = mul(base, iso.at(zParts))
    setT(pen, at)
    ctx.strokeStyle = pen.ink
    ctx.globalAlpha = 0.45
    ctx.lineWidth = px(f)
    ctx.setLineDash([px(5 * pen.u), px(4 * pen.u)])
    ctx.stroke(g.outline)
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    setT(pen, base)
  }
  for (const { p } of order) drawn += body(pen, plot, (z) => mul(base, iso.at(z)), zParts, p, 1, s)
  setT(pen, base)

  const k = scaleOf(base)
  drawCallouts(pen, iso.rows.flatMap((r) => {
    if (r.rect === undefined) return []
    const p0 = apply(base, r.rect.x, r.rect.y)
    return [{ at: apply(base, r.at[0], r.at[1]), rect: { x: p0[0], y: p0[1], w: r.rect.w * k, h: r.rect.h * k }, text: r.text, sub: r.sub, grow: Infinity, alpha: 1 }]
  }), SHEET_SUB * pen.su * k, SHEET_SUB * pen.su * k)
  drawn += iso.rows.length
  bleed(pen, false)
  return drawn
}
