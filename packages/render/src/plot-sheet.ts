import { NAME_SPACING, plotFrame, plotSnap, sheetTitleSpan, stampBox } from '@silk-reel/choreo'
import type { PlotAxo, PlotScore, TraceTimeline } from '@silk-reel/choreo'
import { BAND, CAP, ID, band, bleed, clamp01, lettered, setT, weights } from './plot-plan'
import type { Pen } from './plot-plan'
import { DRAFT } from './font'
import { axoAff, drawObject, inkDensity } from './plot-object'
import type { ObjectState } from './plot-object'

const STAMP_TURN = (-6 * Math.PI) / 180
/** the name's lettering: the drafting face, each stroke thickened by a pen 4% of the letter height so it holds at the size of a title */
const NAME_PEN = 0.04

/** the ending: the board drawn large and low, its name lettered large on the paper beside it as the pull lands, and the stamp struck last in the palette's own accent, a step under the signal's lifted one */
export function drawSheet(pen: Pen, tl: TraceTimeline, plot: PlotScore, rel: number, view: PlotAxo, st: ObjectState, under?: () => number): number {
  const ctx = pen.ctx
  const s = tl.scene
  const sh = plot.sheet
  const F = plot.facts
  const S0 = 24 * plot.shots.sheet[0]
  const R = (b: number): number => 24 * plotSnap(b / 24, tl.totalFrames) - S0
  const drawn = drawObject(pen, s, plot, view, st, under)
  inkDensity(pen, s, axoAff(view, 0))

  const [n0, n1] = sheetTitleSpan(sh).map(R) as [number, number]
  const lettering = clamp01((rel - n0) / Math.max(1e-6, n1 - n0))
  const total = sh.name.lines.reduce((t, l) => t + l.length, 0)
  setT(pen, ID)
  bleed(pen, false)
  ctx.font = `${sh.name.size}px ${DRAFT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.letterSpacing = `${NAME_SPACING * sh.name.size}px`
  ctx.fillStyle = pen.ink
  ctx.strokeStyle = pen.ink
  ctx.lineJoin = 'round'
  ctx.lineWidth = NAME_PEN * sh.name.size
  if (rel > n0) sh.name.lines.forEach((ln, i) => {
    const set = ln.slice(0, Math.max(0, Math.ceil(lettering * total) - sh.name.lines.slice(0, i).join('').length))
    if (set.length === 0) return
    const y = sh.name.y + 1.2 * i * sh.name.size
    band(pen, sh.name.x, y - 0.8 * sh.name.size, sh.name.x + ctx.measureText(set).width, y + 0.25 * sh.name.size, BAND * CAP * sh.name.size)
    ctx.fillStyle = pen.ink
    ctx.strokeStyle = pen.ink
    ctx.fillText(set, sh.name.x, sh.name.y + 1.2 * i * sh.name.size)
    ctx.strokeText(set, sh.name.x, sh.name.y + 1.2 * i * sh.name.size)
  })
  ctx.letterSpacing = '0px'

  const mark = F.version !== undefined ? `REV ${F.version.replace(/^rev\.?\s*/i, '').toUpperCase()}` : F.date
  const struck = plot.events.find((e) => e.kind === 'stamp')
  const since = struck === undefined ? -1 : Math.round(plotFrame((S0 + rel) / 24, tl.totalFrames) - plotFrame(struck.t0, tl.totalFrames))
  if (mark !== undefined && since >= 0) {
    const K = sh.name.stampSize
    const { w, h } = stampBox(mark, K)
    const co = Math.cos(STAMP_TURN)
    const si = Math.sin(STAMP_TURN)
    setT(pen, [co, si, -si, co, sh.name.stamp[0], sh.name.stamp[1]])
    bleed(pen, false)
    ctx.globalAlpha = 0.92
    ctx.strokeStyle = tl.palette.head
    ctx.lineWidth = weights(pen.u).m
    ctx.strokeRect(-w / 2, -h / 2, w, h)
    ctx.lineWidth = weights(pen.u).f
    ctx.strokeRect(-w / 2 + 0.16 * K, -h / 2 + 0.16 * K, w - 0.32 * K, h - 0.32 * K)
    ctx.globalAlpha = 1
    lettered(pen, mark, 0, 0, K, { align: 'center', base: 'middle', weight: '600', spacing: 0.15, color: tl.palette.head, alpha: 0.92 })
  }

  setT(pen, ID)
  bleed(pen, false)
  return drawn
}
