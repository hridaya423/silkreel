import { blinkAlpha, decodeAlpha, flareTone, safeArea } from '@silk-reel/choreo'
import type { AtomState, GlyphLabel, GlyphTimeline, Timeline } from '@silk-reel/choreo'
import { drawPlotFrame } from './plot-draw'
export { drawPlotFrame }
import { drawTraceFrame } from './trace-draw'
import { drawTitle } from './title'
import { FONT } from './font'

export interface GlyphRender {
  path: Path2D | undefined
  text: string | undefined
  labels: GlyphLabel[]
  filled: boolean
}

export interface Scene {
  glyphs: Map<string, GlyphRender>
}

export function buildScene(timeline: Timeline): Scene {
  const glyphs = new Map<string, GlyphRender>()
  if (timeline.style !== 'glyph') return { glyphs }
  for (const glyph of timeline.cast) {
    let path: Path2D | undefined
    if (glyph.strokes.length > 0) {
      path = new Path2D()
      for (const stroke of glyph.strokes) {
        const first = stroke[0]
        if (first === undefined) continue
        path.moveTo(first.x, first.y)
        for (const p of stroke.slice(1)) path.lineTo(p.x, p.y)
      }
    }
    glyphs.set(glyph.id, { path, text: glyph.text, labels: glyph.labels ?? [], filled: glyph.filled === true })
  }
  return { glyphs }
}

function drawAtom(
  ctx: CanvasRenderingContext2D,
  glyph: GlyphRender,
  atom: AtomState,
  cx: number,
  cy: number,
  stagePx: number,
  inkPx: number
): void {
  ctx.save()
  ctx.translate(cx + atom.x * stagePx, cy + atom.y * stagePx)
  ctx.rotate(atom.rot)
  const sizePx = atom.scale * stagePx
  const fx = atom.flipX === true ? -1 : 1
  const fy = atom.flipY === true ? -1 : 1
  ctx.scale(sizePx * fx, sizePx * fy)
  if (glyph.text !== undefined) {
    ctx.font = `1px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(glyph.text, 0, 0)
  } else {
    if (glyph.path !== undefined) {
      if (glyph.filled) {
        ctx.fill(glyph.path)
      } else {
        ctx.lineWidth = inkPx / sizePx
        ctx.stroke(glyph.path)
      }
    }
    // silkscreen labels ride inside the outline at their mirrored spot but
    // counter-flip so the word still reads. below 9px they smear into noise —
    // drop them instead
    for (const label of glyph.labels) {
      if (label.size * sizePx < 9) continue
      ctx.save()
      ctx.translate(label.x, label.y)
      ctx.scale(fx, fy)
      ctx.rotate(label.rot * fx * fy)
      ctx.font = `${label.size}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label.text, 0, 0)
      ctx.restore()
    }
  }
  ctx.restore()
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  timeline: Timeline,
  scene: Scene,
  frame: number
): number {
  if (timeline.style === 'plot') return drawPlotFrame(ctx, timeline, frame)
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

/** wrap a rotation into (−π/2, π/2] — the upright reading of a word */
function uprightRot(rot: number): number {
  const m = ((rot % Math.PI) + Math.PI) % Math.PI
  return m > Math.PI / 2 + 1e-9 ? m - Math.PI : m
}

/** extra controls for callers that draw the film under their own camera */
export interface GlyphDrawOptions {
  /** multiplies each placement's visibility, by placement index */
  alpha?: (index: number) => number
  /** multiplies the hairline width, so a zoomed camera keeps thin ink */
  inkScale?: number
}

export function drawGlyphFrame(
  ctx: CanvasRenderingContext2D,
  timeline: GlyphTimeline,
  scene: Scene,
  frame: number,
  opts: GlyphDrawOptions = {}
): number {
  // the decode grid runs at 15 steps a second regardless of output fps —
  // at 30fps 'twos' holds each step for exactly 2 frames (the spec's
  // floor(frame/2)); 'smooth' interpolates between them
  const smooth = timeline.cadence === 'smooth'
  const s = (frame * 15) / timeline.fps
  const step = smooth ? s : Math.floor(s)

  // stage [-1,1] maps to half the safe area's short side around its center
  const safe = safeArea(timeline.width, timeline.height, timeline.title !== undefined)
  const stagePx = Math.min(safe.w, safe.h) * 0.5
  const cx = safe.x + safe.w / 2
  const cy = safe.y + safe.h / 2
  const ink = timeline.palette.silk
  const head = timeline.palette.head
  /** the reference's crisp 2px hairline, scaled to this frame's size */
  const inkPx = ((2 * Math.min(timeline.width, timeline.height)) / 1080) * (opts.inkScale ?? 1)
  ctx.lineJoin = 'miter'
  ctx.lineCap = 'butt'
  ctx.miterLimit = 4

  let drawn = 0
  for (const [index, placement] of timeline.placements.entries()) {
    const glyph = scene.glyphs.get(placement.glyphId)
    if (glyph === undefined) continue
    const base =
      decodeAlpha(step, placement.inStep, placement.outStep, placement.pattern, timeline.steps, smooth) *
      blinkAlpha(step, placement.blinks, timeline.steps) *
      (opts.alpha?.(index) ?? 1)
    if (base <= 0.004) continue
    const c = placement.role === 'hero' ? head : ink
    ctx.strokeStyle = c
    ctx.fillStyle = c
    const weight = inkPx * (placement.weight ?? 1)
    for (const [i, atom] of placement.atoms.entries()) {
      const alpha = base * flareTone(step, placement.inStep, placement.flare, placement.tones[i] ?? 1, timeline.steps)
      if (alpha <= 0.004) continue
      // words always read: every copy is rotated upright and never mirrored
      const a = glyph.text !== undefined ? { ...atom, rot: uprightRot(atom.rot), flipX: false, flipY: false } : atom
      ctx.globalAlpha = alpha
      drawAtom(ctx, glyph, a, cx, cy, stagePx, weight)
      drawn += 1
    }
  }

  ctx.globalAlpha = 1
  drawTitle(ctx, timeline, frame / timeline.totalFrames, 1)
  return drawn
}
