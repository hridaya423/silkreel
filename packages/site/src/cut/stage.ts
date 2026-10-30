import type { GlyphTimeline, TraceTimeline } from '@silk-reel/choreo'
import { buildScene, drawGlyphFrame, drawPlotFrame } from '@silk-reel/render/film'
import { CutGL } from './cut-gl'
import type { CutLine } from './cut-gl'

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (t: number) => { const x = clamp(t); return x * x * (3 - 2 * x) }

interface Cut { x: number; y: number; deg: number }
interface Shot { at: number; frame: (u: number) => number; zoom: number; dx: number; dy: number; a: Cut; b: Cut; three: number }

const line = (c: Cut, W: number, H: number): CutLine => {
  const r = (c.deg * Math.PI) / 180
  const nx = -Math.sin(r)
  const ny = Math.cos(r)
  return { nx, ny, d: nx * c.x * W + ny * c.y * H }
}
const mixCut = (a: Cut, b: Cut, t: number): Cut => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), deg: lerp(a.deg, b.deg, t) })

export function setupStage(root: HTMLElement, reduced: boolean) {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-cut]')
  const video = root.querySelector<HTMLVideoElement>('[data-cut-video]')
  if (!canvas || !video) return
  const gl = CutGL.create(canvas)
  if (!gl) { root.classList.add('cut--flat'); return }
  root.classList.add('cut--live')

  const tall = () => innerHeight > innerWidth * 1.15
  const slug = tall() ? '9x16' : '16x9'
  const plotCanvas = document.createElement('canvas')
  const plotCtx = plotCanvas.getContext('2d')
  const glyphCanvas = document.createElement('canvas')
  const glyphCtx = glyphCanvas.getContext('2d')
  let plot: TraceTimeline | null = null
  let glyph: { tl: GlyphTimeline; scene: ReturnType<typeof buildScene> } | null = null
  const plotJson = fetch(`/films/plot/glasgow-${slug}.json`).then((r) => r.text())
  const loadPlot = () => { void plotJson.then((text) => { plot = JSON.parse(text) as TraceTimeline; plotFrame = -1 }) }
  const STRIP = tall() ? 6 : 8
  const pool = typeof OffscreenCanvas === 'undefined' ? 0 : clamp(Math.floor((navigator.hardwareConcurrency || 2) / 3), 1, 3)
  let workers = Array.from({ length: pool }, () => ({ w: new Worker(new URL('./plot-worker.ts', import.meta.url), { type: 'module' }), busy: 0 }))
  let asked = { frame: -1, w: 0 }
  let seq = 0
  let shownSeq = 0
  let plotShown = false
  let traceShown = false
  for (const [j, wk] of workers.entries()) {
    void plotJson.then((json) => {
      wk.w.postMessage({ json, font: '/fonts/jetbrains-mono-500-normal.woff2' })
      if (j === 0) wk.w.postMessage({ strip: STRIP, w: 288 })
    })
    wk.w.onmessage = (e: MessageEvent<{ frame: number; w: number; bitmap: ImageBitmap } | { strip: Blob }>) => {
      if ('strip' in e.data) { if (strip) strip.style.backgroundImage = `url(${URL.createObjectURL(e.data.strip)})`; return }
      const mine = wk.busy
      wk.busy = 0
      if (mine > shownSeq) {
        shownSeq = mine
        plotShown = true
        gl.upload(0, e.data.bitmap)
        plotFrame = e.data.frame
        plotRect = { w: e.data.w, h: 0 }
      }
      e.data.bitmap.close()
    }
    wk.w.onerror = () => { for (const x of workers) x.w.terminate(); workers = []; loadPlot() }
  }
  if (!workers.length) loadPlot()
  void fetch(`/films/glyph/glasgow-${slug}.json`).then((r) => r.json() as Promise<GlyphTimeline>).then((tl) => {
    glyph = { tl, scene: buildScene(tl) }
  })

  const poster = new Image()
  poster.src = `/films/cut/glasgow-${slug}-poster.webp`
  poster.onload = () => { if (!videoReady) gl.upload(1, poster); traceShown = true }
  let videoReady = false
  let videoFrame = 359
  const FRAMES = 360
  const HOLD = FRAMES - 1

  const bandTrace = root.querySelector<HTMLElement>('.band--trace')
  const bandGlyph = root.querySelector<HTMLElement>('.band--glyph')
  let glyphLast = -1
  const strip = root.querySelector<HTMLElement>('[data-strip]')
  const head = root.querySelector<HTMLElement>('[data-strip-head]')
  const fnEl = root.querySelector<HTMLElement>('[data-fn]')
  const shots = [...root.querySelectorAll<HTMLElement>('[data-shot]')]
  strip?.style.setProperty('--n', String(STRIP))
  strip?.style.setProperty('aspect-ratio', String(STRIP * (slug === '16x9' ? 16 / 9 : 9 / 16)))

  const wide = !tall()
  const aspect = innerWidth / innerHeight
  const narrow = clamp((16 / 9 - aspect) / (16 / 9 - 1.3))
  const square = clamp((1.3 - aspect) / (1.3 - 1 / 1.15))
  const REW = 0.16
  const REVEAL = 0.3
  const rewind = (u: number) => HOLD * (1 - smooth(u / REW))
  const SHOTS: Shot[] = [
    { at: 0, frame: () => HOLD, zoom: wide ? lerp(lerp(0.8, 0.62, narrow), 0.5, square) : 1.08, dx: wide ? lerp(lerp(0.11, 0.25, narrow), 0.06, square) : 0, dy: wide ? lerp(lerp(0.09, 0.17, narrow), 0.24, square) : 0.12,
      a: wide ? { x: lerp(0.64, 0.74, narrow), y: 0.6, deg: -58 } : { x: 0.5, y: 0.66, deg: -32 }, b: { x: 1.4, y: 0.5, deg: -58 }, three: 0 },
    { at: 0.2, frame: (u) => (u < REW ? rewind(u) : HOLD), zoom: wide ? 0.8 : 0.84, dx: wide ? 0.1 : 0, dy: wide ? 0.06 : 0.16,
      a: wide ? { x: 0.6, y: 0.6, deg: -62 } : { x: 0.5, y: 0.6, deg: -28 }, b: { x: 1.4, y: 0.5, deg: -66 }, three: 0 },
    { at: 0.7, frame: () => HOLD, zoom: wide ? 0.98 : 1.04, dx: 0, dy: 0.1,
      a: wide ? { x: 0.4, y: 0.6, deg: -66 } : { x: 0.5, y: 0.47, deg: -16 }, b: wide ? { x: 0.68, y: 0.6, deg: -66 } : { x: 0.5, y: 0.72, deg: -16 }, three: 1 }
  ]
  const BLEND = 0.05

  let plotFrame = -1
  let plotRect = { w: 0, h: 0 }
  let plotCost = 0
  let plotAt = 0
  let W = 0
  let H = 0
  let dpr = 1
  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1)
    W = Math.round(canvas.clientWidth * dpr)
    H = Math.round(canvas.clientHeight * dpr)
    canvas.width = W
    canvas.height = H
    glyphCanvas.width = W
    glyphCanvas.height = H
    plotFrame = -1
    glyphLast = -1
  }
  resize()
  addEventListener('resize', resize)

  let progress = 0
  const measure = () => {
    const r = root.getBoundingClientRect()
    progress = clamp(-r.top / Math.max(1, r.height - innerHeight))
  }
  measure()

  const drawPlot = (frame: number, fw: number) => {
    const w = Math.round(Math.min(fw, 3200))
    if (workers.length) {
      if (frame === asked.frame && w === asked.w) return
      const idle = workers.find((x) => !x.busy)
      if (!idle) return
      asked = { frame, w }
      idle.busy = ++seq
      idle.w.postMessage({ frame, w })
      return
    }
    if (!plot || !plotCtx) return
    const h = Math.round((w * plot.height) / plot.width)
    if (frame === plotFrame && w === plotRect.w) return
    const now = performance.now()
    if (w === plotRect.w && now - plotAt < plotCost * 2) return
    if (w !== plotRect.w) { plotCanvas.width = w; plotCanvas.height = h; plotRect = { w, h } }
    drawPlotFrame(plotCtx, plot, frame, w / plot.width)
    const t = performance.now()
    plotCost = lerp(plotCost, t - now, 0.3)
    plotAt = t
    gl.upload(0, plotCanvas)
    plotShown = true
    plotFrame = frame
  }

  let want = HOLD
  let seeking = false
  const seekTo = (frame: number) => {
    want = frame
    if (!videoReady || seeking) return
    const t = Math.min(video.duration - 0.01, (frame + 0.5) / 30)
    if (Math.abs(video.currentTime - t) < 0.5 / 30) return
    seeking = true
    video.currentTime = t
  }
  const onVideoFrame = () => {
    videoFrame = Math.min(HOLD, Math.round(video.currentTime * 30 - 0.5))
    gl.upload(1, video)
    traceShown = true
    seeking = false
    if (Math.abs(videoFrame - want) > 0) seekTo(want)
  }
  video.addEventListener('seeked', onVideoFrame)
  video.addEventListener('loadeddata', () => { videoReady = true; seekTo(want) })

  const t0 = performance.now()
  let tIn = reduced ? 0 : -1
  const tick = (now: number) => {
    requestAnimationFrame(tick)
    const time = (now - t0) / 1000
    const r = root.getBoundingClientRect()
    if (r.bottom < 0 || r.top > innerHeight) return
    measure()
    if (progress > 0.02 && !video.src) { video.src = `/films/cut/glasgow-${slug}.mp4`; video.load() }

    let i = 0
    while (i + 1 < SHOTS.length && (SHOTS[i + 1] as Shot).at <= progress) i++
    const s = SHOTS[i] as Shot
    const n = SHOTS[i + 1]
    const end = n?.at ?? 1
    const u = clamp((progress - s.at) / Math.max(1e-6, end - s.at))
    const k = n ? smooth((progress - (end - BLEND)) / BLEND) : 0
    const nx = n ?? s
    const frame = Math.round(clamp(s.frame(u), 0, HOLD))
    seekTo(frame)

    const fit = Math.max(W / (16 * (slug === '16x9' ? 1 : 9 / 16)), H / (9 * (slug === '16x9' ? 1 : 16 / 9)))
    const zoom = lerp(s.zoom, nx.zoom, k)
    const fw = (slug === '16x9' ? 16 : 9) * fit * zoom
    const fh = (slug === '16x9' ? 9 : 16) * fit * zoom
    const fx = (W - fw) / 2 + lerp(s.dx, nx.dx, k) * W
    const fy = (H - fh) / 2 + lerp(s.dy, nx.dy, k) * H

    const off = (c: Cut, w: number) => (wide ? { ...c, x: lerp(c.x, 1.5, w) } : { ...c, y: lerp(c.y, 1.5, w) })
    const reveal = (v: number, from: number) => smooth((v - from) / REVEAL)
    const wipe = (c: Cut, j: number, v: number) => (j === 1 ? off(c, smooth(v / REW)) : j === 2 ? off(c, 1 - reveal(v, 0)) : c)
    const traceIn = i === 2 ? reveal(u, 0) : 0
    const glyphIn = i === 2 ? reveal(u, REVEAL * 0.9) : 0
    if (tIn < 0 && ((plotShown && traceShown) || time > 4)) tIn = time
    const plotIn = reduced ? 1 : tIn < 0 ? 0 : smooth((time - tIn) / 1.2)
    const cutIn = reduced ? 1 : tIn < 0 ? 0 : smooth((time - tIn - 0.3) / 1.3)
    const a0 = mixCut(wipe(s.a, i, u), wipe(nx.a, i + 1, 0), k)
    const a = wide ? { ...a0, x: lerp(1.5, a0.x, cutIn) } : { ...a0, y: lerp(1.5, a0.y, cutIn) }
    const b = i === 2 ? off(s.b, 1 - glyphIn) : mixCut(s.b, off(nx.b, 1), k)
    const three = lerp(s.three, nx.three, k)
    const scrub = Math.round(u < REW ? rewind(u) : clamp((u - REW) / (0.94 - REW)) * HOLD)

    drawPlot(i === 1 ? scrub : videoFrame, fw)
    const glyphFrame = glyph ? (reduced ? 182 : Math.floor(time * glyph.tl.fps) % glyph.tl.totalFrames) : -1
    if (three > 0.001 && glyph && glyphCtx && glyphFrame !== glyphLast) {
      glyphLast = glyphFrame
      const g = glyph.tl
      const gw = glyphCanvas.width
      const gh = glyphCanvas.height
      const scale = wide ? (0.87 * gw) / g.width : 1.1 * Math.max(gw / g.width, gh / g.height)
      const [cx, cy] = wide ? [0.87 * gw, 0.5 * gh] : [0.5 * gw, 0.86 * gh]
      glyphCtx.setTransform(1, 0, 0, 1, 0, 0)
      glyphCtx.fillStyle = g.palette.bg
      glyphCtx.fillRect(0, 0, gw, gh)
      glyphCtx.setTransform(scale, 0, 0, scale, cx - (g.width * scale) / 2, cy - (g.height * scale) / 2)
      drawGlyphFrame(glyphCtx, g, glyph.scene, glyphFrame)
      gl.upload(2, glyphCanvas)
    }

    gl.draw({
      film: { x: fx, y: fy, w: fw, h: fh },
      a: line(a, W, H),
      b: line(b, W, H),
      three,
      plotIn,
      time: reduced ? 0 : time
    }, dpr)

    for (const [j, el] of shots.entries()) {
      const on = j === i ? smooth(1 - k * 2) : j === i + 1 ? smooth(k * 2 - 1) : 0
      el.style.setProperty('--o', String(on))
      el.toggleAttribute('inert', on < 0.5)
    }
    bandTrace?.style.setProperty('--r', String(traceIn))
    bandGlyph?.style.setProperty('--r', String(glyphIn))
    if (strip && head && i === 1) {
      const f = (scrub / HOLD).toFixed(4)
      head.style.setProperty('--f', f)
      strip.style.setProperty('--f', f)
      if (fnEl) fnEl.textContent = `frame ${scrub + 1} of ${FRAMES}`
    }
  }
  requestAnimationFrame(tick)
}
