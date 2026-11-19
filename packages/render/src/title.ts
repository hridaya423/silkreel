import { FACT_LEAD, safeArea } from '@silk-reel/choreo'
import type { Timeline, TraceTimeline } from '@silk-reel/choreo'
import { FONT } from './font'

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/** the window the card lives in: the trace hold beat. glyph draws no title —
 *  the name decodes in as a word under the frame act */
function titleWindow(tl: Timeline): readonly [number, number] | undefined {
  if (tl.style === 'glyph') return undefined
  return tl.scene.beats.hold
}

/** Release title card, bottom-left of the safe-area title band; it fades in whole on the hold beat. The trace film sets it large, under its poster. */
export function drawTitle(ctx: CanvasRenderingContext2D, tl: Timeline, p: number): void {
  if (tl.credit) drawCredit(ctx, tl, p)
  const win = titleWindow(tl)
  if (win === undefined) return
  if (tl.style === 'trace') {
    drawLockup(ctx, tl, p, win[0])
    return
  }
  const card = tl.title
  if (card === undefined) return
  const alpha = ease((p - win[0]) / 0.06)
  if (alpha <= 0.002) return

  const a = safeArea(tl.width, tl.height, true)
  const bandTop = a.y + a.h
  const nameSize = 0.048 * Math.min(tl.width, tl.height)

  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  try {
    ctx.letterSpacing = '0.08em'
  } catch { /* older canvas impls */ }

  // keep the maker's casing: a mixed-case name is never uppercased
  const name = card.name
  const nameY = bandTop + 0.045 * tl.height
  ctx.font = `${nameSize}px ${FONT}`
  ctx.fillStyle = tl.palette.silk
  ctx.globalAlpha = alpha
  ctx.fillText(name, a.x, nameY)

  if (card.version !== undefined && card.version.length > 0) {
    const ruleY = nameY + 0.018 * tl.height
    ctx.strokeStyle = tl.palette.copperDim
    ctx.lineWidth = 1
    ctx.globalAlpha = alpha * 0.9
    ctx.beginPath()
    ctx.moveTo(a.x, ruleY)
    ctx.lineTo(a.x + 0.12 * tl.width, ruleY)
    ctx.stroke()
    ctx.font = `${nameSize * 0.55}px ${FONT}`
    ctx.globalAlpha = alpha * 0.75
    ctx.fillText(card.version, a.x, ruleY + 0.032 * tl.height)
  }
  ctx.restore()
}

/**
 * The end frame's lockup, laid out by the score against the board's
 * silhouette: the name in bold, centred in the negative space beside the
 * board, the version after it, and one line of facts from the file. The name
 * is built letter by letter on its schedule (`build`): each letter rises a
 * little into place and is still once it lands; the version lands as one mark
 * and the facts rise as one quieter move.
 */
/** where a part would stand across the name, the name stands in front of the scene: a dark field from the frame's top to this many letter sizes below the name, this dark at the top and under the letters, rising over these frames as the name starts */
export const FRONT = { below: 0.8, top: 0.8, under: 0.62, frames: 12 }

function drawLockup(ctx: CanvasRenderingContext2D, tl: TraceTimeline, p: number, t0: number): void {
  const L = tl.scene.lockup
  const b = L?.build
  if (L === undefined || p < (b?.t0 ?? t0)) return
  const landed = (at: number): number => {
    if (b === undefined) return ease(((p - t0) * tl.totalFrames) / 10)
    const u = Math.min(1, Math.max(0, (p - at) / b.land))
    return 1 - (1 - u) * (1 - u) * (1 - u)
  }
  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = tl.scene.material.ink
  try {
    ctx.letterSpacing = '-0.03em'
  } catch { /* older canvas impls */ }
  if (L.face === 'grotesk') {
    if (L.front === true) {
      const k = ease(((p - (b?.t0 ?? t0)) * tl.totalFrames) / FRONT.frames)
      const reach = L.box.y1 + FRONT.below * L.size
      const field = ctx.createLinearGradient(0, 0, 0, reach)
      field.addColorStop(0, `rgba(0,0,0,${(FRONT.top * k).toFixed(3)})`)
      field.addColorStop(L.box.y1 / reach, `rgba(0,0,0,${(FRONT.under * k).toFixed(3)})`)
      field.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = field
      ctx.fillRect(0, 0, tl.width, reach)
    }
    const heavy = `900 ${L.size}px "SilkGrotesk", "Helvetica Neue", Arial, sans-serif`
    const small = `600 ${L.version?.size ?? 0}px "SilkGrotesk", "Helvetica Neue", Arial, sans-serif`
    const rev = L.version?.text.toUpperCase() ?? ''
    try {
      ctx.fontStretch = 'semi-expanded'
      ctx.letterSpacing = '0px'
    } catch { /* older canvas impls */ }
    ctx.font = small
    const vw = L.version === undefined ? 0 : 0.22 * L.size + ctx.measureText(rev).width
    ctx.font = heavy
    const rows = L.lines.map((line, i) => ({ ...line, text: line.text.toUpperCase(), w: ctx.measureText(line.text.toUpperCase()).width + (i === L.lines.length - 1 ? vw : 0) }))
    const last = rows.at(-1) ?? { text: '', x: 0, y: 0, w: 0 }
    const fit = Math.min(1, (L.box.x1 - L.box.x0) / Math.max(1, ...rows.map((r) => r.w)))
    ctx.translate(last.x, last.y)
    ctx.scale(fit, fit)
    ctx.fillStyle = '#f3f0e8'
    let slot = 0
    for (const row of rows) {
      for (let j = 0; j < row.text.length; j++, slot++) {
        const k = landed(b === undefined ? 0 : b.t0 + slot * b.step)
        if (k <= 0.002 || row.text[j] === ' ') continue
        ctx.globalAlpha = k
        ctx.fillText(row.text[j] as string, -row.w / 2 + ctx.measureText(row.text.slice(0, j)).width, (row.y - last.y) / fit + (1 - k) * 0.12 * L.size)
      }
      slot++
    }
    if (L.version !== undefined) {
      const k = landed(b?.version ?? 0)
      ctx.font = small
      ctx.globalAlpha = 0.8 * k
      if (k > 0.002) ctx.fillText(rev, last.w / 2 - vw + 0.22 * L.size, (1 - k) * 0.12 * L.size)
    }
    ctx.restore()
    return
  }
  const bold = `700 ${L.size}px ${FONT}`
  let slot = 0
  L.lines.forEach((line, i) => {
    ctx.font = bold
    const w = ctx.measureText(line.text).width
    const last = i === L.lines.length - 1 && L.version !== undefined
    let vw = 0
    if (last && L.version !== undefined) {
      ctx.font = `${L.version.size}px ${FONT}`
      vw = 0.25 * L.size + ctx.measureText(L.version.text).width
    }
    const x = line.x - (w + vw) / 2
    ctx.font = bold
    for (let j = 0; j < line.text.length; j++, slot++) {
      const k = landed(b === undefined ? 0 : b.t0 + slot * b.step)
      if (k <= 0.002 || line.text[j] === ' ') continue
      ctx.globalAlpha = k
      ctx.fillText(line.text[j] as string, x + ctx.measureText(line.text.slice(0, j)).width, line.y + (1 - k) * 0.12 * L.size)
    }
    slot++
    if (last && L.version !== undefined) {
      const k = landed(b?.version ?? 0)
      ctx.font = `${L.version.size}px ${FONT}`
      ctx.globalAlpha = 0.7 * k
      if (k > 0.002) ctx.fillText(L.version.text, x + w + 0.25 * L.size, L.version.y + (1 - k) * 0.12 * L.size)
    }
  })
  if (L.facts !== undefined) {
    const k = b === undefined ? ease(((p - t0) * tl.totalFrames - 4) / 10) : b.facts === undefined ? 1 : ease((p - b.facts) / (b.up - b.facts))
    try {
      ctx.letterSpacing = '0.1em'
    } catch { /* older canvas impls */ }
    ctx.font = `${L.facts.size}px ${FONT}`
    ctx.fillStyle = '#ffffff'
    ctx.globalAlpha = 0.92 * k
    ctx.textAlign = 'center'
    const rise = (1 - k) * 0.4 * L.facts.size
    if (k > 0.002) {
      L.facts.text.split('\n').forEach((line, i) => {
        try {
          ctx.letterSpacing = i < (L.facts?.lead ?? 0) ? '0px' : '0.1em'
        } catch { /* older canvas impls */ }
        ctx.fillText(line, L.facts?.x ?? 0, (L.facts?.y ?? 0) + i * FACT_LEAD * (L.facts?.size ?? 0) + rise)
      })
    }
  }
  ctx.restore()
}

/** "made with silk reel", bottom-right: in on the hold beat, or held for the whole glyph loop so the seam stays clean */
function drawCredit(ctx: CanvasRenderingContext2D, tl: Timeline, p: number): void {
  const win = titleWindow(tl)
  const alpha = (win === undefined ? 1 : ease((p - win[0]) / 0.06)) * 0.6
  if (alpha <= 0.002) return
  const hasTitle = tl.title !== undefined
  const a = safeArea(tl.width, tl.height, hasTitle)
  const bandTop = a.y + a.h
  const y = hasTitle ? bandTop + 0.045 * tl.height : bandTop + 0.55 * (tl.height - bandTop)
  ctx.save()
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  try {
    ctx.letterSpacing = '0.08em'
  } catch { /* older canvas impls */ }
  ctx.font = `${0.02 * Math.min(tl.width, tl.height)}px ${FONT}`
  ctx.fillStyle = tl.palette.silk
  ctx.globalAlpha = alpha
  ctx.fillText('made with silk reel', a.x + a.w, y)
  ctx.restore()
}
