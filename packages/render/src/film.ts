import type { Timeline } from '@silk-reel/choreo'
import { drawPlotFrame } from './plot-draw'
export { drawPlotFrame }
import { drawTraceFrame } from './trace-draw'
import { drawMontageFrame } from './montage-draw'
import { drawGlyphFrame } from './glyph-draw'
import type { Scene } from './glyph-draw'
export { buildScene, drawGlyphFrame } from './glyph-draw'
export type { GlyphDrawOptions, GlyphRender, Scene } from './glyph-draw'

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  timeline: Timeline,
  scene: Scene,
  frame: number
): number {
  if (timeline.style === 'plot') return drawPlotFrame(ctx, timeline, frame)
  if (timeline.style === 'montage') return drawMontageFrame(ctx, timeline, frame)
  if (timeline.style !== 'glyph') return drawTraceFrame(ctx, timeline, frame)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = timeline.palette.bg
  ctx.fillRect(0, 0, timeline.width, timeline.height)
  return drawGlyphFrame(ctx, timeline, scene, frame)
}

/** post-pass settings per style — glyph and plot are flat: no bloom, no vignette */
export function postOptionsFor(timeline: Timeline, grain = true): {
  bloom: number
  grain: boolean
  vignette: boolean
  transparent: boolean
} {
  const flat = timeline.style !== 'trace'
  return {
    bloom: flat ? 0 : timeline.palette.bloom,
    grain: grain && !timeline.transparent,
    vignette: !flat && !timeline.transparent,
    transparent: timeline.transparent
  }
}
