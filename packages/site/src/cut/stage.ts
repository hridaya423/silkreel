import type { Aspect, TraceTimeline } from '@silk-reel/choreo'
import { drawPlotFrame } from '@silk-reel/render/film'
import { CutGL } from './cut-gl'
import type { CutLine } from './cut-gl'
import { activeSlat, orbit, project, slatAngles } from './shutter'
import { makeCam } from '@silk-reel/choreo'
import { drawSource, heroShot } from './faces'
import type { Box } from './faces'
import { lettering } from '../blueprint/lettering'
import { plot as plotLettering } from '../motion/plot'
import { Probe } from './probe'
import type { ProbeHit } from './probe'
import type { NetData } from './nets'

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (t: number) => { const x = clamp(t); return x * x * (3 - 2 * x) }

interface Cut { x: number; y: number; deg: number }

const line = (c: Cut, W: number, H: number): CutLine => {
  const r = (c.deg * Math.PI) / 180
  const nx = -Math.sin(r)
  const ny = Math.cos(r)
  return { nx, ny, d: nx * c.x * W + ny * c.y * H }
}

export interface Stage {
  aspect: Aspect
  /** rebuilds the hero's turn around a visitor's board; false when the stage cannot show it */
  own(name: string, trace: TraceTimeline, nets?: NetData): Promise<boolean>
}

export function setupStage(root: HTMLElement, reduced: boolean): Stage | undefined {
  const journey = root.closest<HTMLElement>('[data-journey]')
  const canvas = journey?.querySelector<HTMLCanvasElement>('[data-cut]')
  if (!canvas) return
  const gl = CutGL.create(canvas)
  if (!gl) return
  root.classList.add('cut--live')
  journey?.classList.add('journey--rendered')
  if (!reduced) journey?.classList.add('journey--live')

  const tall = () => innerHeight > innerWidth * 1.15
  const slug = tall() ? '9x16' : '16x9'
  let shutterReady = false
  const faces = [new Image(), new Image()]
  const faceLoads = faces.map((img, i) => new Promise<void>((resolve, reject) => {
    img.onload = () => { if (!shutterReady) gl.upload(i === 0 ? 3 : 4, img); resolve() }
    img.onerror = reject
    img.src = `/films/shutter/glasgow-${slug}-${i === 0 ? 'source' : 'trace'}.webp`
  }))
  const probe = new Probe()
  const glowWide = innerWidth <= 760 ? 960 : 1280
  let stock = true
  void Promise.all(faceLoads).then(() => {
    shutterReady = true
    void fetch(`/films/shutter/glasgow-${slug}-nets.json`).then((r) => r.json() as Promise<NetData>).then((data) => { if (stock && data.vp) probe.load(data, data.vp, glowWide) }).catch(() => { /* the board stays a picture */ })
  }).catch(() => { startPlot() })
  const plotCanvas = document.createElement('canvas')
  const plotCtx = plotCanvas.getContext('2d')
  let plot: TraceTimeline | null = null
  let workers: { w: Worker; busy: number }[] = []
  let asked = { frame: -1, w: 0 }
  let seq = 0
  let shownSeq = 0
  let plotShown = false
  let traceShown = false
  let plotStarted = false
  const startPlot = () => {
    if (plotStarted) return
    plotStarted = true
    const plotJson = fetch(`/films/plot/glasgow-${slug}.json`).then((r) => r.text())
    const loadPlot = () => { void plotJson.then((text) => { plot = JSON.parse(text) as TraceTimeline; plotFrame = -1 }) }
    const pool = typeof OffscreenCanvas === 'undefined' ? 0 : clamp(Math.floor((navigator.hardwareConcurrency || 2) / 3), 1, 3)
    workers = Array.from({ length: pool }, () => ({ w: new Worker(new URL('./plot-worker.ts', import.meta.url), { type: 'module' }), busy: 0 }))
    for (const wk of workers) {
      void plotJson.then((json) => { wk.w.postMessage({ json, font: '/fonts/jetbrains-mono-500-normal.woff2' }) })
      wk.w.onmessage = (e: MessageEvent<{ frame: number; w: number; bitmap: ImageBitmap }>) => {
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

    const poster = new Image()
    poster.src = `/films/cut/glasgow-${slug}-poster.webp`
    poster.onload = () => { gl.upload(1, poster); traceShown = true }
  }
  const HOLD = 359

  const srcLabel = root.querySelector<HTMLElement>('[data-src-label]')
  const outLabel = root.querySelector<HTMLElement>('[data-out-label]')
  let slats = new Float32Array(0)
  let ownBounds: Box | null = null
  const srcName = root.querySelector<HTMLElement>('[data-src-name]')
  const outName = root.querySelector<HTMLElement>('[data-out-name]')

  const wide = !tall()
  const aspect = innerWidth / innerHeight
  const narrow = clamp((16 / 9 - aspect) / (16 / 9 - 1.3))
  const square = clamp((1.3 - aspect) / (1.3 - 1 / 1.15))
  const REST = wide ? { zoom: lerp(lerp(1.06, 0.93, narrow), 0.8, square), dx: lerp(lerp(-0.035, -0.005, narrow), 0.0, square), dy: lerp(lerp(0.31, 0.32, narrow), 0.3, square), front: 0.72 }
    : { zoom: 0.8, dx: 0, dy: 0.14, front: 0.70 }
  const rot = orbit(0, 0)
  const CUT = { zoom: wide ? lerp(lerp(0.8, 0.62, narrow), 0.5, square) : 1.08, dx: wide ? lerp(lerp(0.11, 0.25, narrow), 0.06, square) : 0, dy: wide ? lerp(lerp(0.09, 0.17, narrow), 0.24, square) : 0.12,
    a: wide ? { x: lerp(0.64, 0.74, narrow), y: 0.6, deg: -58 } : { x: 0.5, y: 0.66, deg: -32 } }
  const AWAY = { x: 1.4, y: 0.5, deg: -58 }

  let plotFrame = -1
  let plotRect = { w: 0, h: 0 }
  let plotCost = 0
  let plotAt = 0
  const hero = root.querySelector<HTMLElement>('.shot--hero')
  const heroActs = root.querySelector<HTMLElement>('.shot--hero .shot__acts')
  const visual = journey?.querySelector<HTMLElement>('.cut__visual')
  const frames = journey?.querySelector<HTMLElement>('[data-frames]')
  const framesPin = frames?.querySelector<HTMLElement>('.frames__pin')
  const macro = frames?.querySelector<HTMLVideoElement>('[data-frames-film]')
  const frameCopy = frames?.querySelector<HTMLElement>('.frames__copy')
  const frameCaption = frames?.querySelector<HTMLElement>('.frames__act')
  const frameTitle = frames?.querySelector<HTMLElement>('.frames__title .lt')
  const strip = frames?.querySelector<HTMLElement>('.strip')
  const t0 = performance.now()
  let safeTop = 350
  let W = 0
  let H = 0
  let dpr = 1
  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1)
    W = Math.round(canvas.clientWidth * dpr)
    H = Math.round(canvas.clientHeight * dpr)
    canvas.width = W
    canvas.height = H
    safeTop = (heroActs?.offsetTop ?? 234) + (heroActs?.offsetHeight ?? 44) + 112
    root.style.setProperty('--tag-y', `${safeTop - 64}px`)
    plotFrame = -1
  }
  resize()
  addEventListener('resize', resize)
  void document.fonts.ready.then(resize)

  const netTag = root.querySelector<HTMLElement>('[data-net]')
  const netName = netTag?.querySelector<HTMLElement>('[data-net-name]')
  const netMeta = netTag?.querySelector<HTMLElement>('[data-net-meta]')
  const ptr = { x: -1, y: -1, at: -10, free: false, touch: false }
  const track = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    ptr.x = e.clientX - r.left
    ptr.y = e.clientY - r.top
    ptr.at = (performance.now() - t0) / 1000
    ptr.free = !(e.target instanceof Element && e.target.closest('a, button, input, header, [popover]'))
    ptr.touch = e.pointerType === 'touch'
  }
  addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') track(e) }, { passive: true })
  addEventListener('pointerdown', track, { passive: true })
  document.documentElement.addEventListener('mouseleave', () => { ptr.free = false })
  let shown = ''
  let pulseAt = -1
  let pulsed: ProbeHit | null = null
  let seed = 7
  let last = 0
  const tag = (hit: ProbeHit | null, film: { x: number; y: number; w: number; h: number }) => {
    if (!netTag) return
    if (!hit) { if (shown) { delete netTag.dataset.on; shown = '' } return }
    if (shown !== hit.key) {
      shown = hit.key
      if (netName) netName.innerHTML = lettering([hit.title], { weight: 0.1 })
      if (netMeta) netMeta.textContent = hit.meta
      netTag.dataset.on = ''
    }
    const x = (film.x + hit.u * film.w) / dpr
    const y = (film.y + hit.v * film.h) / dpr
    const half = (netTag.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0
    netTag.style.setProperty('--x', `${x.toFixed(1)}px`)
    netTag.style.setProperty('--y', `${y.toFixed(1)}px`)
    netTag.style.setProperty('--lx', `${clamp(half / 2, x + half - innerWidth + 16, x - 16).toFixed(1)}px`)
    netTag.toggleAttribute('data-low', y < safeTop + 40)
  }

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

  let tIn = reduced ? 0 : -1
  const tick = (now: number) => {
    requestAnimationFrame(tick)
    const time = (now - t0) / 1000
    const r = journey?.getBoundingClientRect() ?? root.getBoundingClientRect()
    if (r.bottom < 0 || r.top > innerHeight) return
    measure()
    const fit = Math.max(W / (16 * (slug === '16x9' ? 1 : 9 / 16)), H / (9 * (slug === '16x9' ? 1 : 16 / 9)))
    const inShutter = shutterReady
    journey?.classList.toggle('journey--ready', shutterReady && tIn >= 0 && (reduced || time - tIn > 1.15))
    if (tIn < 0 && (shutterReady || (plotShown && traceShown) || time > 4)) tIn = time
    const intro = reduced ? 1 : tIn < 0 ? 0 : smooth((time - tIn) / 1.15)
    const turn = reduced ? 0 : smooth((progress - 0.12) / 0.48)
    const arrive = reduced || !frames ? 0 : clamp(1 - frames.getBoundingClientRect().top / (innerHeight * 0.8))
    const move = smooth(arrive)
    const rotation = slug === '9x16' ? smooth((arrive - 0.3) / 0.6) * Math.PI / 2 : 0
    rot[0] = Math.cos(rotation)
    rot[1] = Math.sin(rotation)
    rot[3] = -Math.sin(rotation)
    rot[4] = Math.cos(rotation)
    const blend = smooth((arrive - 0.9) / 0.1)
    const reading = smooth((arrive - 0.75) / 0.25)
    if (framesPin && frames && !reduced) {
      framesPin.style.transform = `translateY(${-Math.max(0, frames.getBoundingClientRect().top)}px)`
      framesPin.style.pointerEvents = arrive < 1 ? 'none' : ''
      framesPin.style.visibility = arrive > 0 ? '' : 'hidden'
    }
    if (!reduced) for (const el of [frameCopy, frameCaption, strip]) if (el) el.style.opacity = String(reading)
    if (!reduced && reading > 0.05 && frameTitle) plotLettering(frameTitle)
    if (visual) visual.style.opacity = String(1 - blend)
    if (hero) { hero.style.opacity = String(1 - smooth(arrive / 0.28)); hero.inert = arrive > 0.28 }
    if (macro && !reduced) macro.style.opacity = String(blend)
    const portraitZoom = clamp(Math.min(1.08, (H - (safeTop + 32) * dpr) / (0.624 * 16 * fit), 0.96 * W / (0.945 * 9 * fit)), 0.66, 1.08)
    const rest = wide ? REST : { ...REST, zoom: portraitZoom, dy: (safeTop * dpr - 0.212 * 16 * fit * portraitZoom - (H - 16 * fit * portraitZoom) / 2) / H }
    const view = inShutter ? rest : CUT
    let fw = (slug === '16x9' ? 16 : 9) * fit * view.zoom
    let fh = (slug === '16x9' ? 9 : 16) * fit * view.zoom
    let fx = (W - fw) / 2 + view.dx * W
    let fy = (H - fh) / 2 + view.dy * H
    if (inShutter && (slug === '9x16' || innerWidth <= 900 || tall())) {
      const bounds = ownBounds ?? (slug === '16x9' ? { x: 0.06, y: 0.10, w: 0.88, h: 0.72 } : { x: 0.0275, y: 0.212, w: 0.945, h: 0.624 })
      const ratio = slug === '16x9' ? 16 / 9 : 9 / 16
      fw = Math.min(W * 0.96 / bounds.w, Math.max(120 * dpr, H - (safeTop + 32) * dpr) / bounds.h * ratio)
      fh = fw / ratio
      fx = (W - fw * bounds.w) / 2 - fw * bounds.x
      fy = safeTop * dpr - fh * bounds.y
    }
    if (macro && framesPin && arrive > 0) {
      const target = macro.getBoundingClientRect()
      const pin = framesPin.getBoundingClientRect()
      const boxW = target.width * dpr
      const boxH = target.height * dpr
      const portrait = slug === '9x16'
      const w = portrait ? Math.min(boxH * 0.86 / 0.945, boxW * 0.85 * fw / fh / 0.624) : Math.min(boxW * 0.70, boxH * fw / fh * 0.78)
      const h = w * fh / fw
      const push = 1 + smooth((arrive - 0.8) / 0.2) * 0.2
      const tw = w * push
      const th = h * push
      fx = lerp(fx, target.left * dpr + boxW * (portrait ? 0.45 : 0.38) - tw * (portrait ? 0.5 : 0.30), move)
      fy = lerp(fy, (target.top - pin.top) * dpr + boxH * 0.50 - th * (portrait ? 0.5 : 0.45), move)
      fw = lerp(fw, tw, move)
      fh = lerp(fh, th, move)
    }

    const plotIn = reduced ? 1 : tIn < 0 ? 0 : smooth((time - tIn) / 1.2)
    const cutIn = reduced ? 1 : tIn < 0 ? 0 : smooth((time - tIn - 0.3) / 1.3)
    const a = wide ? { ...CUT.a, x: lerp(1.5, CUT.a.x, cutIn) } : { ...CUT.a, y: lerp(1.5, CUT.a.y, cutIn) }
    drawPlot(HOLD, fw)

    const front = lerp(lerp(1.12, REST.front, intro), -0.18, turn)
    const dt = Math.min(0.1, time - last)
    last = time
    const film = { x: fx, y: fy, w: fw, h: fh }
    const reach = lerp(0.19, 0.12, turn)
    const side = (u: number, v: number) => (u - (v - 0.5) * 0.24 * fh / fw - front) / reach
    const live = probe.ready && inShutter && tIn >= 0 && time - tIn > 1.3 && arrive < 0.04
    let hit: ProbeHit | null = null
    if (live) {
      const u = (ptr.x * dpr - fx) / fw
      const v = (ptr.y * dpr - fy) / fh
      const k = side(u, v)
      const held = ptr.free && (!ptr.touch || time - ptr.at < 2.2)
      if (held && u > 0 && u < 1 && v > 0 && v < 1 && (k > 0.3 || k < -1.05)) hit = probe.point(u, v, (9 * dpr) / fw, k > 0, time)
      else if (!pulsed) probe.leave(time)
      if (hit) { pulsed = null; pulseAt = time }
      else if (!reduced && !document.hidden && time - ptr.at > 3 && time - pulseAt > (pulseAt < 0 ? 0 : 5.4)) {
        seed = (seed * 16807) % 2147483647
        const seen = (u2: number, v2: number) => {
          const x = (fx + u2 * fw) / dpr
          const y = (fy + v2 * fh) / dpr
          const k2 = side(u2, v2)
          return x > 48 && x < innerWidth - 48 && y > safeTop + 30 && y < innerHeight - 56 && (k2 > 0.4 || k2 < -1.15)
        }
        pulsed = probe.pulse(time, pulseAt < 0 ? -1 : seed / 2147483647, seen)
        pulseAt = time
      }
      if (pulsed && time - pulseAt > 1.7) { probe.leave(time); pulsed = null }
    } else { probe.leave(time); pulsed = null }
    root.style.cursor = hit ? 'crosshair' : ''
    tag(hit ?? pulsed, film)
    if (probe.frame(time, dt, reduced)) gl.upload(5, probe.canvas)
    const glow = inShutter ? 1 - smooth(arrive / 0.2) : 0
    gl.draw({
      film: { x: fx, y: fy, w: fw, h: fh },
      a: line(a, W, H),
      b: line(AWAY, W, H),
      three: 0,
      blank: inShutter ? 1 : 0,
      front,
      dark: smooth(arrive / 0.35),
      under: slug === '9x16' ? 1 - smooth((arrive - 0.15) / 0.15) : 1,
      plotIn,
      time: reduced ? 0 : time,
      glow,
      dim: probe.level
    }, dpr)
    if (inShutter) {
      const n = clamp(Math.round((slug === '16x9' ? 16 : 9) * fit / dpr / 20), 26, 90)
      const sw = fw / n
      const wave = {
        front,
        fan: intro,
        reach,
        settle: 0.045,
        back: 0
      }
      if (slats.length !== n * 3) slats = new Float32Array(n * 3)
      slatAngles(n, wave, sw, slats)
      const red = intro * smooth((wave.front + 0.04) / 0.12)
      gl.shutter({ film, axis: 0, slats, thick: Math.max(1.5 * dpr, sw * 0.05), rot, shift: [0, 0, 0], active: activeSlat(n, wave), red, plotIn: intro > 0 ? 1 : 0, time: reduced ? 0 : time, glow, dim: probe.level }, dpr)
      const [sx] = project(0.235, 0.42, film, rot, W, H)
      const [ox] = project(0.79, 0.25, film, rot, W, H)
      srcLabel?.style.setProperty('--x', `${clamp(sx / dpr, srcLabel.offsetWidth + 36, innerWidth - 36).toFixed(1)}px`)
      srcLabel?.style.setProperty('--y', `${(innerHeight * 0.55).toFixed(1)}px`)
      outLabel?.style.setProperty('--x', `${Math.min(innerWidth - 36, ox / dpr + 160).toFixed(1)}px`)
      outLabel?.style.setProperty('--y', `${((heroActs?.offsetTop ?? 234) + (heroActs?.offsetHeight ?? 44) + 70).toFixed(1)}px`)
      root.style.setProperty('--intro', intro.toFixed(3))
      root.style.setProperty('--turn', turn.toFixed(3))
    }

  }
  requestAnimationFrame(tick)

  return {
    aspect: slug === '16x9' ? '16:9' : '9:16',
    async own(name, traceTl, nets) {
      try {
        const { createPreview } = await import('@silk-reel/render/preview')
        const lit = document.createElement('canvas')
        const preview = createPreview(lit, { subframes: 1, mapScale: 1.6 })
        await document.fonts.load('16px "SilkMono"')
        const shot = heroShot(traceTl)
        const source = drawSource(traceTl, shot)
        preview.draw({ ...traceTl, transparent: true, scene: { ...traceTl.scene, shots: [shot], lockup: undefined } }, traceTl.totalFrames - 1)
        gl.upload(3, source.face)
        gl.upload(4, lit)
        ownBounds = source.bounds
        shutterReady = true
        stock = false
        pulseAt = -1
        if (nets) probe.load(nets, makeCam(shot, traceTl.width, traceTl.height).vp, glowWide)
        preview.dispose()
      } catch {
        return false
      }
      root.setAttribute('aria-label', `${name}: circuit routes transformed into an assembled board`)
      if (srcName) srcName.textContent = `${name}.kicad_pcb`
      if (outName) outName.textContent = `${name}.mp4`
      root.scrollIntoView({ behavior: 'instant' })
      tIn = (performance.now() - t0) / 1000
      return true
    }
  }
}
