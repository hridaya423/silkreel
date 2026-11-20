import { centreOn, fitZoom, makeCam, project, sheetUnit } from '@silk-reel/choreo'
import type { CameraShot, GlyphTimeline, TraceTimeline } from '@silk-reel/choreo'
import { buildScene } from '../../../render/src/film'
import { loadFont } from '../../../render/src/font'
import { createGlyphFilm } from '../../../render/src/glyph-film'
import { createMontage } from '../../../render/src/montage-draw'
import { sheetInk, signalInk } from '../../../render/src/plot-draw'
import { drawGrid, drawPlan } from '../../../render/src/plot-plan'
import type { Aff, Pen } from '../../../render/src/plot-plan'
import { createTraceGL } from '../../../render/src/trace-gl'

const QUALITY = { subframes: 1, mapScale: 1.6 }
const get = <T>(name: string): Promise<T> => fetch(`/${name}.json`).then((r) => r.json() as Promise<T>)
const canvas = (w: number, h: number): HTMLCanvasElement => Object.assign(document.createElement('canvas'), { width: w, height: h })

/** one camera straight above the board, the board filling the card: every look is drawn through it */
const above = (tl: TraceTimeline): CameraShot => {
  const pts = tl.scene.board.flatMap((loop) => Array.from({ length: loop.length / 2 }, (_, i): [number, number, number] => [loop[i * 2] as number, loop[i * 2 + 1] as number, 0]))
  let shot: CameraShot = { t: 0, x: 0, y: 0, zoom: 1, tilt: 0.02, yaw: 0, aperture: 0, fov: 0.2, roll: 0, shift: 0, light: 'poster' }
  shot = { ...shot, ...centreOn(shot, pts, tl.width, tl.height) }
  shot.zoom = fitZoom(shot, pts, tl.width, tl.height, 0.94, 0.9)
  return { ...shot, ...centreOn(shot, pts, tl.width, tl.height) }
}
const toPx = (shot: CameraShot, W: number, H: number) => {
  const cam = makeCam(shot, W, H)
  return (x: number, y: number): [number, number] => { const q = project(cam, x, y, 0); return [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H] }
}
const outline = (ctx: CanvasRenderingContext2D, tl: TraceTimeline, px: (x: number, y: number) => [number, number]): void => {
  ctx.beginPath()
  for (const loop of tl.scene.board) {
    for (let i = 0; i < loop.length; i += 2) { const [x, y] = px(loop[i] as number, loop[i + 1] as number); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) }
    ctx.closePath()
  }
}

async function cards(): Promise<Record<string, string>> {
  await loadFont()
  const trace = await get<TraceTimeline>('trace')
  const shot = above(trace)
  const W = trace.width
  const H = trace.height
  const px = toPx(shot, W, H)
  const out: Record<string, HTMLCanvasElement> = {}

  const plot = await get<TraceTimeline>('plot')
  out.plot = canvas(W, H)
  {
    const ctx = out.plot.getContext('2d') as CanvasRenderingContext2D
    const [ox, oy] = px(0, 0)
    const [ax, ay] = px(1000, 0)
    const [bx, by] = px(0, 1000)
    const m: Aff = [(ax - ox) / 1000, (ay - oy) / 1000, (bx - ox) / 1000, (by - oy) / 1000, ox, oy]
    const pal = plot.palette
    outline(ctx, trace, px)
    ctx.fillStyle = pal.bg
    ctx.fill('evenodd')
    ctx.clip('evenodd')
    const pen: Pen = { ctx, k: 1, u: Math.min(W, H) / 1080, su: sheetUnit(W, H), W, H, stock: pal.bg, ink: sheetInk(pal), accent: signalInk(pal), transparent: false }
    drawGrid(pen, m, plot.scene.material.pxPerMm, 0.6)
    drawPlan(pen, plot.scene, m, { edge: 0, back: 1, drills: 3, hatch: 0, parts: 1, fine: 0.66, lead: 0.94, weight: 1 })
  }

  const glyph = await get<GlyphTimeline>('glyph')
  out.glyph = canvas(W, H)
  {
    const field = canvas(glyph.width, glyph.height)
    createGlyphFilm(glyph.width, glyph.height)(field.getContext('2d') as CanvasRenderingContext2D, glyph, buildScene(glyph), 360)
    const ctx = out.glyph.getContext('2d') as CanvasRenderingContext2D
    outline(ctx, trace, px)
    ctx.fillStyle = glyph.palette.bg
    ctx.fill('evenodd')
    ctx.clip('evenodd')
    ctx.drawImage(field, 0, 0, W, H)
  }

  out.trace = canvas(W, H)
  {
    const gl = createTraceGL(W, H, QUALITY)
    if (!gl) throw new Error('no WebGL2')
    ;(out.trace.getContext('2d') as CanvasRenderingContext2D).drawImage(gl.render({ ...trace, transparent: true, scene: { ...trace.scene, shots: [shot] } }, trace.totalFrames - 1), 0, 0)
  }

  const montage = await get<TraceTimeline>('montage')
  out.montage = canvas(W, H)
  {
    const hype = montage.scene.montage?.hype
    if (!hype) throw new Error('montage has no trailer cut')
    const film = createMontage(W, H, QUALITY)
    const ctx = out.montage.getContext('2d') as CanvasRenderingContext2D
    outline(ctx, trace, px)
    ctx.clip('evenodd')
    ctx.drawImage(film.render({ ...montage, scene: { ...montage.scene, montage: { ...montage.scene.montage, hype: { ...hype, shots: [shot] } } } } as TraceTimeline, 100), 0, 0)
  }

  const files: Record<string, string> = {}
  for (const [look, c] of Object.entries(out)) {
    files[`glasgow-${look}.webp`] = c.toDataURL('image/webp', 0.86)
    const half = canvas(W / 2, H / 2)
    const hx = half.getContext('2d') as CanvasRenderingContext2D
    hx.imageSmoothingQuality = 'high'
    hx.drawImage(c, 0, 0, W / 2, H / 2)
    files[`glasgow-${look}-1x.webp`] = half.toDataURL('image/webp', 0.86)
  }
  return files
}

;(window as unknown as { cards: Promise<Record<string, string>> }).cards = cards()
