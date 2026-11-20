import type { Timeline } from '@silk-reel/choreo'
import { buildScene, drawFrame, postOptionsFor } from './film'
import { createGlyphFilm } from './glyph-film'
import type { GlyphFilmDraw } from './glyph-film'
import type { Scene } from './film'
import { loadFont } from './font'
import { createMontage } from './montage-draw'
import type { Montage } from './montage-draw'
import { createPost } from './post'
import type { Post } from './post'
import { createTraceGL } from './trace-gl'
import type { TraceGL, TraceQuality } from './trace-gl'
import { drawTitle } from './title'

export interface Preview {
  /** draws one frame of `tl` onto the canvas, resizing it to the timeline's size */
  draw(tl: Timeline, frame: number): void
  dispose(): void
}

/** the render pipeline without Remotion: the same frames Film draws, for a live page */
export function createPreview(canvas: HTMLCanvasElement, quality: TraceQuality = { subframes: 1, mapScale: 1.25 }): Preview {
  void loadFont()
  let post: Post | null | undefined
  let trace: { gl: TraceGL; w: number; h: number } | null = null
  let glyph: { tl: Timeline; scene: Scene; off: HTMLCanvasElement } | null = null
  let film: { draw: GlyphFilmDraw; w: number; h: number } | null = null
  let montage: { film: Montage; w: number; h: number } | null = null

  const traceFor = (w: number, h: number) => {
    if (trace?.w === w && trace.h === h) return trace.gl
    trace?.gl.dispose()
    const gl = createTraceGL(w, h, quality)
    trace = gl ? { gl, w, h } : null
    return gl
  }

  return {
    draw(tl, frame) {
      if (canvas.width !== tl.width || canvas.height !== tl.height) { canvas.width = tl.width; canvas.height = tl.height }
      const target = canvas.getContext('2d')
      if (!target) return
      if (tl.style === 'trace') {
        const gl = traceFor(tl.width, tl.height)
        if (gl) {
          target.clearRect(0, 0, tl.width, tl.height)
          target.drawImage(gl.render(tl, frame), 0, 0)
          drawTitle(target, tl, frame / tl.totalFrames)
          return
        }
      }
      if (tl.style === 'montage') {
        if (montage?.w !== tl.width || montage.h !== tl.height) {
          montage?.film.dispose()
          montage = { film: createMontage(tl.width, tl.height, quality), w: tl.width, h: tl.height }
        }
        target.clearRect(0, 0, tl.width, tl.height)
        target.drawImage(montage.film.render(tl, frame), 0, 0)
        return
      }
      if (glyph?.tl !== tl) {
        const off = glyph?.off ?? document.createElement('canvas')
        off.width = tl.width
        off.height = tl.height
        glyph = { tl, scene: buildScene(tl), off }
      }
      if (tl.style === 'glyph') {
        if (film?.w !== tl.width || film.h !== tl.height) film = { draw: createGlyphFilm(tl.width, tl.height), w: tl.width, h: tl.height }
        film.draw(target, tl, glyph.scene, frame)
        return
      }
      const ctx = glyph.off.getContext('2d')
      if (!ctx) return
      drawFrame(ctx, tl, glyph.scene, frame)
      if (post === undefined) post = createPost() ?? null
      const out = post?.render(glyph.off, { ...postOptionsFor(tl, true), frame }) ?? glyph.off
      target.clearRect(0, 0, tl.width, tl.height)
      target.drawImage(out, 0, 0)
    },
    dispose() {
      trace?.gl.dispose()
      montage?.film.dispose()
      post?.dispose()
      trace = null
      montage = null
      post = undefined
    }
  }
}
