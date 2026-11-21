import type { Timeline } from '@silk-reel/choreo'
import { WORDMARK } from './font'

/** how long the --credit end card stands after the film */
export const CARD_SECONDS = 1.5
const STOCK = '#050505'
const INK = '#ecebe6'
const MUTED = '#8d8d87'
const RING = '#ffc46b'
const URL = 'silkreel.hridya.tech'

/** every frame a render draws: the film, then the end card when the film carries the credit */
export const filmFrames = (tl: Pick<Timeline, 'totalFrames' | 'fps' | 'credit'>): number => tl.totalFrames + (tl.credit ? Math.round(CARD_SECONDS * tl.fps) : 0)

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * The end card: the site's mark and wordmark on black, "made with" over them
 * and the address under them. The mark draws in stroke by stroke as the
 * site's loader decodes it, its middle ring lights in the film's accent, then
 * the words come up and hold.
 */
export function drawEndCard(ctx: CanvasRenderingContext2D, tl: Timeline, frame: number): void {
  const { width: W, height: H } = tl
  const f = (frame - tl.totalFrames) * (30 / tl.fps)
  const u = Math.min(W, H)
  const M = 0.15 * u
  const s = M / 64
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  if (tl.transparent) ctx.clearRect(0, 0, W, H)
  else {
    ctx.fillStyle = STOCK
    ctx.fillRect(0, 0, W, H)
  }

  const size = 0.52 * M
  ctx.font = `600 ${size}px ${WORDMARK}`
  ctx.fontStretch = 'semi-condensed'
  ctx.letterSpacing = `${-0.02 * size}px`
  const word = ctx.measureText('silk reel').width
  const gap = 0.2 * M
  const x0 = (W - (M + gap + word) - 17 * s) / 2
  const cy = H / 2
  const at = (x: number, y: number): [number, number] => [x0 + x * s, cy + (y - 32) * s]

  ctx.lineCap = 'round'
  ctx.lineWidth = 3.2 * s
  ctx.strokeStyle = INK
  const line = (x1: number, y1: number, x2: number, y2: number, k: number): void => {
    if (k <= 0) return
    const [ax, ay] = at(x1, y1)
    const [bx, by] = at(x2, y2)
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(ax + (bx - ax) * k, ay + (by - ay) * k)
    ctx.stroke()
  }
  ;[20, 32, 44].forEach((y, i) => { line(17, y, 47, y, ease((f - 2 * i) / 6)) })
  ;[[24, 14, 26], [40, 26, 38], [24, 38, 50]].forEach(([x, y1, y2], i) => { line(x as number, y1 as number, x as number, y2 as number, ease((f - 4 - 2 * i) / 5)) })
  const lit = tl.palette.id === 'custom' ? tl.palette.head : RING
  ;[[24, 20], [40, 32], [24, 44]].forEach(([x, y], i) => {
    const k = ease((f - 7 - 2 * i) / 4)
    if (k <= 0) return
    const [px, py] = at(x as number, y as number)
    const r = 4 * s * k
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.arc(px, py, r + 1.6 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    if (!tl.transparent) {
      ctx.fillStyle = STOCK
      ctx.fill()
    }
    const on = i === 1 ? ease((f - 12) / 4) : 0
    ctx.strokeStyle = on > 0 ? lit : INK
    ctx.beginPath()
    ctx.arc(px, py, r, 0, Math.PI * 2)
    ctx.stroke()
    if (on > 0) {
      ctx.fillStyle = lit
      ctx.globalAlpha = on
      ctx.fill()
      ctx.globalAlpha = 1
    }
  })

  const rise = (k: number): number => (1 - k) * 0.08 * M
  const kw = ease((f - 6) / 8)
  ctx.globalAlpha = kw
  ctx.fillStyle = INK
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('silk reel', x0 + M + gap, cy + 0.02 * M + rise(kw))

  const small = 0.03 * u
  const ks = ease((f - 10) / 8)
  ctx.font = `400 ${small}px ${WORDMARK}`
  ctx.letterSpacing = `${0.04 * small}px`
  ctx.textAlign = 'center'
  ctx.fillStyle = MUTED
  ctx.globalAlpha = ks
  ctx.fillText('made with', W / 2, cy - 0.95 * M + rise(ks))
  ctx.fillText(URL, W / 2, cy + 0.95 * M + rise(ks))
  ctx.restore()
}
