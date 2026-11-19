import React from 'react'
import { AbsoluteFill, cancelRender, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion'
import type { Timeline } from '@silk-reel/choreo'
import { drawFrame, buildScene, postOptionsFor } from './film'
import type { Scene } from './film'
import { createPost } from './post'
import type { Post } from './post'
import { createTraceGL } from './trace-gl'
import type { TraceGL, TraceQuality } from './trace-gl'
import { drawTitle } from './title'
import { useFont } from './font'
import { createMontage } from './montage-draw'
import type { Montage } from './montage-draw'
import { createGlyphFilm } from './glyph-film'
import type { GlyphFilmDraw } from './glyph-film'

export type RenderQuality = 'draft' | 'final'

export interface FilmProps {
  timeline: Timeline
  grain?: boolean
  /** final: full motion blur and map resolution; draft: one sample, lighter maps (studio preview, quick renders) */
  quality?: RenderQuality
  /** final trace renders: accumulation samples per frame (lens, light, sky and shutter jittered together) */
  samples?: number
  /** look tests: tone curve and studio, passed to the trace renderer */
  look?: Pick<TraceQuality, 'tonemap' | 'studio'>
  /** trace only: draw the board-and-parts matte (alpha coverage, red height) in place of the picture */
  matte?: boolean
  children?: React.ReactNode
}

/** final trace renders accumulate this many samples a frame unless the render asks for another count */
export const FINAL_SAMPLES = 32

const QUALITY: Record<RenderQuality, TraceQuality> = {
  final: { subframes: 5, mapScale: 1.6 },
  draft: { subframes: 1, mapScale: 1.25 }
}

export const Film: React.FC<FilmProps> = ({ timeline, grain = true, quality, samples, look, matte = false, children }) => {
  const fonts = useFont()
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const postRef = React.useRef<Post | null>(null)
  const traceRef = React.useRef<TraceGL | null>(null)
  const montageRef = React.useRef<Montage | null>(null)
  const glyphRef = React.useRef<GlyphFilmDraw | null>(null)
  const readyRef = React.useRef(false)
  const traceQueue = React.useRef<Promise<unknown>>(Promise.resolve())

  const scene = React.useMemo<Scene>(() => buildScene(timeline), [timeline])
  const offscreen = React.useMemo(() => {
    const c = document.createElement('canvas')
    c.width = timeline.width
    c.height = timeline.height
    return c
  }, [timeline])
  // the live preview is always draft; renders default to final
  const level: RenderQuality = getRemotionEnvironment().isRendering ? (quality ?? 'final') : 'draft'

  // pick the pipeline once per mounted canvas: the lit trace renderer, else
  // the flat 2d draw through the webgl2 post pass, else plain 2d
  React.useLayoutEffect(() => {
    if (timeline.style === 'trace') traceRef.current = createTraceGL(timeline.width, timeline.height, level === 'final' ? { ...QUALITY.final, samples: samples ?? FINAL_SAMPLES, ...look } : QUALITY[level]) ?? null
    if (timeline.style === 'montage') montageRef.current = createMontage(timeline.width, timeline.height, QUALITY[level])
    if (timeline.style === 'glyph') glyphRef.current = createGlyphFilm(timeline.width, timeline.height)
    else if (traceRef.current === null) postRef.current = createPost() ?? null
    if (timeline.style === 'trace' && traceRef.current === null && getRemotionEnvironment().isRendering) {
      cancelRender(new Error('The trace look needs WebGL2, and the headless browser has none. Run again with SILK_REEL_GL=swangle (slower, CPU only), or use --style glyph.'))
    }
    readyRef.current = true
    return () => {
      postRef.current?.dispose()
      postRef.current = null
      traceRef.current?.dispose()
      traceRef.current = null
      montageRef.current?.dispose()
      montageRef.current = null
      glyphRef.current = null
      readyRef.current = false
    }
  }, [timeline.style, timeline.width, timeline.height, level, samples, look?.tonemap, look?.studio])

  React.useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !readyRef.current) return
    const target = canvas.getContext('2d')
    if (!target) return
    if (timeline.style === 'glyph' && glyphRef.current !== null) {
      glyphRef.current(target, timeline, scene, frame)
      return
    }
    if (timeline.style === 'montage' && montageRef.current !== null) {
      target.drawImage(montageRef.current.render(timeline, frame), 0, 0)
      return
    }
    if (timeline.style === 'trace' && traceRef.current !== null) {
      const show = (out: HTMLCanvasElement): void => {
        target.clearRect(0, 0, canvas.width, canvas.height)
        target.drawImage(out, 0, 0)
        if (!matte) drawTitle(target, timeline, frame / timeline.totalFrames)
      }
      if (matte || !getRemotionEnvironment().isRendering) {
        show(matte ? traceRef.current.matte(timeline, frame) : traceRef.current.render(timeline, frame))
        return
      }
      const hold = delayRender(`trace frame ${frame}`)
      let live = true
      const gl = traceRef.current
      const job = traceQueue.current.then(() => gl.renderAsync(timeline, frame))
      traceQueue.current = job.catch(() => undefined)
      job.then((out) => {
        if (live) show(out)
        continueRender(hold)
      }, (err: unknown) => cancelRender(err instanceof Error ? err : new Error(String(err))))
      return () => {
        live = false
      }
    }
    const ctx = offscreen.getContext('2d')
    if (!ctx) return
    drawFrame(ctx, timeline, scene, frame)
    const out = postRef.current?.render(offscreen, { ...postOptionsFor(timeline, grain), frame }) ?? offscreen
    target.clearRect(0, 0, canvas.width, canvas.height)
    target.drawImage(out, 0, 0)
  }, [frame, timeline, scene, offscreen, grain, fonts, matte])

  return React.createElement(
    AbsoluteFill,
    { style: { backgroundColor: timeline.transparent ? 'transparent' : timeline.palette.bg } },
    React.createElement('canvas', {
      ref: canvasRef,
      width,
      height,
      style: { width, height, display: 'block' }
    }),
    children
  )
}

