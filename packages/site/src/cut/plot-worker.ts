import type { TraceTimeline } from '@silk-reel/choreo'
import { drawPlotFrame } from '@silk-reel/render/film'

type Msg = { json: string; font: string } | { frame: number; w: number } | { strip: number; w: number }

const canvas = new OffscreenCanvas(1, 1)
const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
let take: (json: string, font: string) => void = () => {}
const plot = new Promise<TraceTimeline>((ok) => { take = (json, font) => { ok(load(json, font)) } })

const load = async (json: string, font: string) => {
  const face = new FontFace('SilkMono', `url(${font})`, { weight: '500' })
  ;(self as unknown as { fonts: FontFaceSet }).fonts.add(face)
  await face.load().catch(() => face)
  return JSON.parse(json) as TraceTimeline
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data
  if ('json' in m) { take(m.json, m.font); return }
  const tl = await plot
  if ('strip' in m) {
    const h = Math.round((m.w * tl.height) / tl.width)
    const sheet = new OffscreenCanvas(m.w * m.strip, h)
    const tile = new OffscreenCanvas(m.w, h)
    const t = tile.getContext('2d') as unknown as CanvasRenderingContext2D
    const c = sheet.getContext('2d')
    for (let j = 0; j < m.strip; j++) {
      drawPlotFrame(t, tl, Math.round((j / (m.strip - 1)) * (tl.totalFrames - 1)), m.w / tl.width)
      c?.drawImage(tile, j * m.w, 0)
    }
    ;(self as unknown as Worker).postMessage({ strip: await sheet.convertToBlob({ type: 'image/webp', quality: 0.85 }) })
    return
  }
  const h = Math.round((m.w * tl.height) / tl.width)
  if (canvas.width !== m.w || canvas.height !== h) { canvas.width = m.w; canvas.height = h }
  drawPlotFrame(ctx, tl, m.frame, m.w / tl.width)
  const bitmap = canvas.transferToImageBitmap()
  ;(self as unknown as Worker).postMessage({ frame: m.frame, w: m.w, bitmap }, [bitmap])
}
