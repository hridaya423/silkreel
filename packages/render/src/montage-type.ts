import type { MontageBox, MontageScore } from '@silk-reel/choreo'
import { FONT } from './font'

export const GROTESK = '"SilkGrotesk", "Helvetica Neue", Arial, sans-serif'
export const CAP = 0.74

export type Stretch = 'normal' | 'semi-expanded' | 'expanded' | 'condensed' | 'semi-condensed' | 'extra-condensed'

export function heavy(ctx: CanvasRenderingContext2D, size: number, stretch: Stretch = 'semi-expanded', weight = 900): void {
  ctx.font = `${Math.round(weight)} ${size}px ${GROTESK}`
  ctx.fontStretch = stretch
}

export function hairline(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.font = `100 ${size}px ${GROTESK}`
  ctx.fontStretch = 'normal'
}

export function mono(ctx: CanvasRenderingContext2D, size: number, bold = false): void {
  ctx.font = `${bold ? 700 : 500} ${size}px ${FONT}`
  ctx.fontStretch = 'normal'
}

export const advance = (ctx: CanvasRenderingContext2D, text: string): number => Array.from(text).reduce((a, ch) => a + ctx.measureText(ch).width, 0)

export interface NameLayout {
  size: number
  stretch: Stretch
  turn: boolean
  origin: { x: number; y: number }
  lines: Array<{ text: string; x: number; baseline: number; first: number }>
  dot: { x: number; y: number; r: number }
  block: MontageBox
  clear: MontageBox
}

const LEAD = 0.9
const DOT = 0.13
export const DESC = /[gjpqy,;_()[\]{}|]/

export function nameSplits(name: string): string[][] {
  const chars = Array.from(name)
  const lower = (c: string): boolean => c !== c.toUpperCase() && c === c.toLowerCase()
  const upper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase()
  const digit = (c: string): boolean => /\d/.test(c)
  const word = (c: string): boolean => /\w/.test(c)
  const cuts: number[] = []
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1] as string
    const b = chars[i] as string
    const n = chars[i + 1] ?? ''
    if ((lower(a) && upper(b)) || (upper(a) && upper(b) && lower(n)) || a === ' ' || a === '-' || a === '_' || (word(a) && word(b) && digit(a) !== digit(b))) cuts.push(i)
  }
  const use = cuts.slice(0, 8)
  const out: string[][] = []
  for (let mask = 0; mask < 1 << use.length; mask++) {
    const at = use.filter((_, i) => (mask & (1 << i)) !== 0)
    const lines = [0, ...at].map((s, i) => chars.slice(s, at[i] ?? chars.length).join('').trim()).filter((l) => l.length > 0)
    if (lines.length <= 4 && (lines.length === 1 || lines.every((l) => Array.from(l).length > 1))) out.push(lines)
  }
  return out
}

export function nameLayout(ctx: CanvasRenderingContext2D, m: MontageScore, box: MontageBox): NameLayout {
  const probe = 100
  const BW = box.x1 - box.x0
  const BH = box.y1 - box.y0
  const splits = BW > 1.2 * BH ? [[m.name]] : nameSplits(m.name)
  const turn = splits.length === 1 && BH > 1.15 * BW
  const bw = turn ? BH : BW
  const bh = turn ? BW : BH
  let best = { score: -1, size: 0, stretch: 'normal' as Stretch, lines: [m.name] }
  for (const stretch of ['extra-condensed', 'condensed', 'semi-condensed', 'normal', 'semi-expanded'] as Stretch[]) {
    heavy(ctx, probe, stretch)
    for (const lines of splits) {
      const widths = lines.map((l, i) => advance(ctx, l) + 0.4 * CAP * probe + (i === lines.length - 1 ? probe * (0.05 + 2 * DOT) : 0))
      const size = Math.min((bw * probe) / Math.max(...widths), bh / ((lines.length - 1) * LEAD + 1.4 * CAP + (DESC.test(lines.at(-1) ?? '') ? 0.24 : 0)))
      const w = (Math.max(...widths) * size) / probe / bw
      const h = (((lines.length - 1) * LEAD + CAP) * size) / bh
      const score = w * h + (Math.max(1 - w, 1 - h) <= 0.35 ? 1 : 0)
      if (score > best.score * 1.04) best = { score, size, stretch, lines }
    }
  }
  const { size, stretch } = best
  heavy(ctx, size, stretch)
  const height = (best.lines.length - 1) * LEAD * size + CAP * size
  const top = (bh - height - (DESC.test(best.lines.at(-1) ?? '') ? 0.24 * size : 0)) / 2
  let first = 0
  const lines = best.lines.map((text, i) => {
    const line = { text, x: 0.2 * CAP * size, baseline: top + CAP * size + i * LEAD * size, first }
    first += Array.from(text).length
    return line
  })
  const last = lines.at(-1) as NameLayout['lines'][number]
  const r = DOT * size
  const width = 0.2 * CAP * size + Math.max(...lines.map((l) => advance(ctx, l.text))) + 0.05 * size + 2 * r
  const local = { x: last.x + advance(ctx, last.text) + 0.05 * size + r, y: last.baseline - r }
  const origin = turn ? { x: box.x0, y: box.y1 } : { x: box.x0, y: box.y0 }
  const toScreen = (p: { x: number; y: number }): { x: number; y: number } => (turn ? { x: origin.x + p.y, y: origin.y - p.x } : { x: origin.x + p.x, y: origin.y + p.y })
  const a = toScreen({ x: 0, y: top })
  const z = toScreen({ x: width, y: top + height })
  const pad = 0.2 * CAP * size
  const ca = toScreen({ x: 0, y: top - pad })
  const cz = toScreen({ x: width + pad, y: top + height + (DESC.test(last.text) ? 0.24 * size : 0) + pad })
  return {
    size,
    stretch,
    turn,
    origin,
    lines,
    dot: { ...toScreen(local), r },
    block: { x0: Math.min(a.x, z.x), y0: Math.min(a.y, z.y), x1: Math.max(a.x, z.x), y1: Math.max(a.y, z.y) },
    clear: { x0: Math.min(ca.x, cz.x), y0: Math.min(ca.y, cz.y), x1: Math.max(ca.x, cz.x), y1: Math.max(ca.y, cz.y) }
  }
}

export function drawName(ctx: CanvasRenderingContext2D, L: NameLayout, ink: string, reveal: (i: number) => number = () => 1): void {
  ctx.save()
  ctx.translate(L.origin.x, L.origin.y)
  if (L.turn) ctx.rotate(-Math.PI / 2)
  heavy(ctx, L.size, L.stretch)
  ctx.fillStyle = ink
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  for (const line of L.lines) {
    let x = line.x
    for (const [j, ch] of Array.from(line.text).entries()) {
      const w = ctx.measureText(ch).width
      const u = reveal(line.first + j)
      if (u >= 1) ctx.fillText(ch, x, line.baseline)
      else if (u > 0) {
        ctx.save()
        const top = line.baseline - L.size
        const bottom = line.baseline + 0.25 * L.size
        ctx.beginPath()
        ctx.rect(x - 2, top, w + 4, bottom - top)
        ctx.clip()
        ctx.fillText(ch, x, line.baseline + (1 - u) * (bottom - top))
        ctx.restore()
      }
      x += w
    }
  }
  ctx.restore()
}

export function footerTop(m: MontageScore, H: number): number {
  return H - m.type.margin - 1.6 * m.type.min
}

export function stopRight(m: MontageScore): number {
  return m.stop.x - m.stop.r - 0.35 * m.stop.r
}

export function fitLine(ctx: CanvasRenderingContext2D, text: string, width: number, cap: number, stretches: Stretch[] = ['semi-expanded', 'normal', 'condensed', 'extra-condensed']): { size: number; stretch: Stretch } {
  let best = { size: 0, stretch: stretches[0] as Stretch }
  for (const stretch of stretches) {
    heavy(ctx, 100, stretch)
    const size = Math.min((width * 100) / Math.max(1, advance(ctx, text)), cap / CAP)
    if (size > best.size * 1.02) best = { size, stretch }
  }
  return best
}
