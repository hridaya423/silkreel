import { PALETTES } from '@silk-reel/choreo'
import type { Aspect, PaletteId, TraceTimeline } from '@silk-reel/choreo'
import { drawPlotFrame } from '@silk-reel/render/film'
import { World, drawStill } from '../world/world'
import { filmOf, filmOwnBoard } from '../world/films'
import { boards, traceFilms } from '../data/site'
import { prefersReducedMotion } from '../engine/env'
import { setupStage } from '../cut/stage'
import { setupFrames, setupLooks, setupLanding } from './sections'
import { rollTo } from './site'

const $ = (s: string, r: ParentNode = document) => r.querySelector<HTMLElement>(s)
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T[] => [...r.querySelectorAll<T>(s)]
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

export function setupHome() {
  const reduced = prefersReducedMotion()
  const html = document.documentElement
  const film = $('[data-stage]')
  const cut = film ? setupStage(film, reduced) : undefined
  const frames = $('[data-frames]')
  if (frames) setupFrames(frames, reduced)
  const looks = $('[data-looks]')
  if (looks) setupLooks(looks, reduced)

  setupLanding(reduced)

  const input = document.querySelector<HTMLInputElement>('[data-file]')
  $('[data-try]')?.addEventListener('click', () => input?.click())

  /* ---------- one command: each word picks a value, the monitor plays the film the line would render ---------- */
  type Style = 'glyph' | 'trace' | 'plot'
  const monitorStage = $('[data-monitor]')
  const monitorCanvas = document.querySelector<HTMLCanvasElement>('[data-monitor-film]')
  const monitorVideo = document.querySelector<HTMLVideoElement>('[data-monitor-video]')
  const monitor = new World(monitorCanvas ?? document.createElement('canvas'), { reduced })
  const STILL = 240
  const state: { board: string; style: Style; aspect: Aspect; ink: PaletteId } = { board: 'glasgow', style: 'trace', aspect: '16:9', ink: 'mono' }
  try { const s = localStorage.getItem('sr-ink'); if (s && s in PALETTES) state.ink = s as PaletteId } catch { /* private mode */ }
  const names = new Map<string, { name: string; file: string; own?: true }>(boards.map((b) => [b.id, { name: b.name, file: `${b.id}.kicad_pcb` }]))
  monitor.setPalette(state.ink, { instant: true })

  const frameRect = () => ({ x: 0, y: 0, w: monitorCanvas?.clientWidth ?? 0, h: monitorCanvas?.clientHeight ?? 0 })
  // the site ships plot films, and trace films of every board but Glasgow, at 16:9 only; the command still renders the chosen aspect
  const shown = (): Aspect => (state.style === 'plot' || (state.style === 'trace' && state.board !== 'glasgow') ? '16:9' : state.aspect)
  const monitorNote = $('[data-monitor-note]')
  const fitStage = () => {
    if (monitorStage) monitorStage.dataset.style = state.style
    monitorStage?.style.setProperty('--ar', shown() === '16:9' ? '2 / 1' : shown().replace(':', ' / '))
    monitorStage?.style.setProperty('--film-bg', state.style === 'trace' ? '#0b0b0b' : state.style === 'plot' ? '#ecede9' : PALETTES[state.ink].bg)
    if (monitorNote) {
      monitorNote.hidden = shown() === state.aspect
      monitorNote.textContent = `${state.style === 'plot' ? 'Plot' : 'Trace'} previews at 16:9 here. The command renders ${state.aspect}.`
    }
  }
  const monitorCredit = $('[data-monitor-credit]')
  const tokVal = (k: string) => $(`[data-tok="${k}"] [data-tok-v]`)
  const tokens = () => {
    const b = names.get(state.board)
    const out = [b?.file ?? 'board.kicad_pcb', '--style', state.style, '--aspect', state.aspect]
    if (state.style === 'glyph') out.push('--palette', state.ink)
    return out
  }
  const paintCmd = () => {
    const b = names.get(state.board)
    const vals: Record<string, string> = { board: b?.file ?? 'board.kicad_pcb', style: state.style, aspect: state.aspect, palette: state.ink }
    for (const [k, v] of Object.entries(vals)) {
      const el = tokVal(k)
      if (el) rollTo(el, v)
    }
    const pal = $('[data-tok="palette"]')
    if (pal) pal.hidden = state.style !== 'glyph'
    const copy = $('[data-cmd-copy]')
    const line = ['npm run reel --', ...tokens()].join(' ')
    if (copy) copy.dataset.copy = line
    for (const [k, v] of [['board', state.board], ['style', state.style], ['aspect', state.aspect], ['palette', state.ink]] as const) {
      $$(`[data-pick="${k}"] [data-v]`).forEach((o) => { o.setAttribute('aria-checked', String(o.dataset.v === v)) })
    }
    $$('[data-rail]').forEach((o) => { o.setAttribute('aria-pressed', String(o.dataset.rail === state.aspect)) })
  }
  const monitorOn = () => { const r = monitorStage?.getBoundingClientRect(); return !!r && r.bottom > 0 && r.top < innerHeight }
  const plotCanvas = document.querySelector<HTMLCanvasElement>('[data-monitor-plot]')
  const plotCtx = plotCanvas?.getContext('2d')
  const plots = new Map<string, Promise<TraceTimeline>>()
  const plotOf = (id: string) => {
    let p = plots.get(id)
    if (!p) { p = fetch(`/films/plot/${id}-16x9.json`).then((r) => r.json() as Promise<TraceTimeline>); plots.set(id, p) }
    return p
  }
  let plotTl: TraceTimeline | null = null
  let plotRun = false
  let plotF = 0
  let plotPrev = 0
  let plotLast = -1
  const plotDraw = () => {
    if (!plotTl || !plotCanvas || !plotCtx) return
    const f = Math.floor(plotF)
    const w = Math.round(plotCanvas.clientWidth * Math.min(2, devicePixelRatio || 1))
    if (f === plotLast && plotCanvas.width === w) return
    if (plotCanvas.width !== w) { plotCanvas.width = w; plotCanvas.height = Math.round((w * plotTl.height) / plotTl.width) }
    drawPlotFrame(plotCtx, plotTl, f, w / plotTl.width)
    plotLast = f
  }
  const plotTick = (now: number) => {
    if (!plotRun || !plotTl) return
    requestAnimationFrame(plotTick)
    plotF = (plotF + ((now - plotPrev) / 1000) * plotTl.fps) % plotTl.totalFrames
    plotPrev = now
    plotDraw()
  }
  const plotPlay = (on: boolean) => {
    if (on === plotRun) return
    plotRun = on
    if (on) { plotPrev = performance.now(); requestAnimationFrame(plotTick) }
  }

  /* the monitor's own transport: play, pause and a seek line over whichever film is showing */
  const playBtn = document.querySelector<HTMLButtonElement>('[data-monitor-play]')
  const seekBar = document.querySelector<HTMLInputElement>('[data-monitor-seek]')
  let held = reduced
  const playing = () => !held && monitorOn()
  const paintPlay = () => {
    if (!playBtn) return
    playBtn.toggleAttribute('data-playing', !held)
    playBtn.setAttribute('aria-label', held ? 'Play' : 'Pause')
  }
  let glyphTotal = 1
  monitor.onFrame((info) => { glyphTotal = info.film.tl.totalFrames })
  const progress = () => {
    if (state.style === 'trace') return monitorVideo?.duration ? monitorVideo.currentTime / monitorVideo.duration : 0
    if (state.style === 'plot') return plotTl ? plotF / plotTl.totalFrames : 0
    return monitor.frameNow() / Math.max(1, glyphTotal - 1)
  }
  const paintSeek = () => {
    if (!seekBar || seekBar.matches(':active')) return
    const v = Math.min(1, Math.max(0, progress()))
    seekBar.value = String(Math.round(v * 1000))
    seekBar.style.setProperty('--v', v.toFixed(4))
  }
  const run = () => {
    const on = playing()
    if (state.style === 'trace') { if (on) void monitorVideo?.play().catch(() => { /* the poster stays */ }); else monitorVideo?.pause() }
    else if (state.style === 'plot') plotPlay(on)
    else if (on) monitor.play()
    else monitor.pause()
  }
  const loop = () => { paintSeek(); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  playBtn?.addEventListener('click', () => { held = !held; paintPlay(); run() })
  seekBar?.addEventListener('input', () => {
    const v = Number(seekBar.value) / 1000
    seekBar.style.setProperty('--v', v.toFixed(4))
    if (state.style === 'trace') { if (monitorVideo?.duration) monitorVideo.currentTime = v * monitorVideo.duration * 0.999 }
    else if (state.style === 'plot') { if (plotTl) { plotF = v * (plotTl.totalFrames - 1); plotDraw() } }
    else {
      const f = Math.round(v * (glyphTotal - 1))
      if (held) monitor.scrub(f)
      else monitor.seek(f)
    }
  })
  paintPlay()

  const traceSrc = () => {
    const b = state.board
    if (shown() !== '16:9') { const a = state.aspect.replace(':', 'x'); return { src: `/films/trace/${b}-${a}.mp4`, poster: `/films/trace/${b}-${a}-poster.webp` } }
    if (b === 'glasgow') return { src: '/films/cut/glasgow-16x9.mp4', poster: '/films/cut/glasgow-16x9-poster.webp' }
    return { src: `/films/trace/${b}-540.mp4`, poster: `/films/trace/${b}-poster.webp` }
  }
  const showMonitor = (instant = false) => {
    const trace = state.style === 'trace'
    const plot = state.style === 'plot'
    fitStage()
    const board = boards.find((b) => b.id === state.board)
    if (monitorCredit) monitorCredit.textContent = board ? `${board.name}, ${board.maker}` : ''
    if (monitorCanvas) monitorCanvas.hidden = trace || plot
    if (plotCanvas) plotCanvas.hidden = !plot
    if (plot) {
      monitor.pause()
      const id = state.board
      void plotOf(id).then((tl) => {
        if (state.board !== id || state.style !== 'plot') return
        plotTl = tl
        plotLast = -1
        plotRun = false
        if (reduced) plotF = tl.totalFrames - 1
        plotDraw()
        plotPlay(playing())
      })
    } else plotPlay(false)
    if (monitorVideo) {
      monitorVideo.hidden = !trace
      if (trace) {
        const { src, poster } = traceSrc()
        if (!monitorVideo.src.endsWith(src)) { monitorVideo.poster = poster; monitorVideo.src = src }
        if (playing()) void monitorVideo.play().catch(() => { /* the poster stays */ })
        monitor.pause()
      } else monitorVideo.pause()
    }
    if (!trace && !plot) {
      void filmOf(state.board, state.aspect).then((film) => {
        monitor.show(film, { decode: !instant })
        monitor.setView({ rect: frameRect(), zoom: 1.45, cx: 0.5, cy: 0.5, fx: 0.5, fy: 0.5 }, { instant: true })
        if (reduced) monitor.scrub(STILL)
        else { monitor.seek(182); if (playing()) monitor.play() }
      })
    }
    paintCmd()
  }
  looks?.addEventListener('lookchange', (event) => { pick('style', (event as CustomEvent<string>).detail) })
  showMonitor(true)
  new IntersectionObserver(() => { run() }).observe(monitorStage ?? document.body)
  if (monitorCanvas) new ResizeObserver(() => { monitor.setView({ rect: frameRect() }, { instant: true }) }).observe(monitorCanvas)
  $$('[data-rail]').forEach((o) => { o.addEventListener('click', () => { pick('aspect', o.dataset.rail ?? '16:9') }) })

  const pick = (k: string, v: string) => {
    const noTrace = (id: string) => `Trace for ${names.get(id)?.name ?? id} renders on your machine. It plays as Glyph here.`
    const noPlot = (id: string) => `Plot for ${names.get(id)?.name ?? id} renders on your machine. It plays as Glyph here.`
    if (k === 'board') {
      if (v === state.board) return
      state.board = v
      if (state.style === 'trace' && !traceFilms.includes(v)) { state.style = 'glyph'; if (!names.get(v)?.own) toast(noTrace(v)) }
      if (state.style === 'plot' && names.get(v)?.own) { state.style = 'glyph'; toast(noPlot(v)) }
    } else if (k === 'style') {
      if (v === state.style) return
      if (v === 'trace' && !traceFilms.includes(state.board)) { toast(noTrace(state.board)); return }
      if (v === 'plot' && names.get(state.board)?.own) { toast(noPlot(state.board)); return }
      state.style = v as Style
    }
    else if (k === 'aspect') { if (v === state.aspect) return; state.aspect = v as Aspect }
    else if (k === 'palette') {
      if (v === state.ink) return
      state.ink = v as PaletteId
      try { localStorage.setItem('sr-ink', v) } catch { /* private mode */ }
      monitor.setPalette(state.ink)
      fitStage()
      paintCmd()
      return
    }
    showMonitor()
  }

  // each palette tile shows the monitor's film, at the still reduced motion holds, in that palette
  $('[data-pick="palette"]')?.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return
    void filmOf(state.board, state.aspect).then((film) => {
      for (const c of $$<HTMLCanvasElement>('[data-still]')) {
        const dpr = Math.min(2, devicePixelRatio)
        c.width = Math.round(c.clientWidth * dpr)
        c.height = Math.round(c.clientHeight * dpr)
        const fit = Math.min(1, c.height / c.width / (film.tl.height / film.tl.width))
        drawStill(c, film, STILL, PALETTES[c.dataset.still as PaletteId], 2.4 * fit)
      }
    })
  })

  /* the pickers are native popovers; they open under their word and close on a pick, Escape or a click away */
  $$('[data-pick]').forEach((pop) => {
    const key = pop.dataset.pick ?? ''
    const opener = $(`[popovertarget="${pop.id}"]`)
    const items = () => $$<HTMLButtonElement>('.pick__o', pop)
    pop.addEventListener('toggle', (e) => {
      opener?.setAttribute('aria-expanded', String(e.newState === 'open'))
      if (e.newState !== 'open' || !opener) return
      const r = opener.getBoundingClientRect()
      const w = pop.offsetWidth, h = pop.offsetHeight
      const below = r.bottom + 10 + h < innerHeight
      pop.style.left = `${clamp(r.left - 6, 16, innerWidth - w - 16)}px`
      pop.style.top = `${below ? r.bottom + 10 : Math.max(16, r.top - 10 - h)}px`
      ;(items().find((o) => o.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus()
    })
    pop.addEventListener('keydown', (e) => {
      // in a grid of boards, up and down move a row
      const row = getComputedStyle(pop.firstElementChild ?? pop).gridTemplateColumns.split(' ').length
      const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -row, ArrowDown: row } as Record<string, number>)[e.key]
      if (!step) return
      e.preventDefault()
      const list = items()
      const i = list.findIndex((o) => o === document.activeElement)
      list[Math.min(list.length - 1, Math.max(0, i + step))]?.focus()
    })
    pop.addEventListener('click', (e) => {
      const o = (e.target as Element).closest<HTMLButtonElement>('.pick__o')
      if (!o) return
      pop.hidePopover()
      opener?.focus()
      if (o.dataset.own !== undefined) { input?.click(); return }
      pick(key, o.dataset.v ?? '')
    })
  })
  addEventListener('wheel', () => { $$('.pick:popover-open').forEach((p) => { p.hidePopover() }) }, { passive: true })

  /* ---------- notices ---------- */
  const toastEl = $('[data-toast]')
  let toastT = 0
  const toast = (msg: string) => {
    if (!toastEl) return
    toastEl.textContent = msg
    toastEl.dataset.on = ''
    clearTimeout(toastT)
    toastT = window.setTimeout(() => { delete toastEl.dataset.on }, 4200)
  }
  /* ---------- your own board: open it or drop it anywhere ---------- */
  const takeFile = (file: File | undefined) => {
    if (!file) return
    if (!/\.kicad_pcb$/i.test(file.name)) { toast('Use a .kicad_pcb file.'); return }
    if (file.size > 40e6) { toast('That file is over 40 MB. Use the command.'); return }
    toast(`Reading ${file.name}…`)
    filmOwnBoard(file, cut?.aspect ?? '16:9').then(async (b) => {
      names.set(b.id, { name: b.name, file: file.name, own: true })
      const own = $('[data-pick="board"] [data-own]')
      if (own && !$(`[data-pick="board"] [data-v="${CSS.escape(b.id)}"]`)) {
        const o = document.createElement('button')
        o.type = 'button'
        o.className = 'pick__o pick__tile'
        o.setAttribute('role', 'menuitemradio')
        o.dataset.v = b.id
        const id = document.createElement('span')
        const n = document.createElement('span')
        const k = document.createElement('span')
        id.className = 'pick__id'
        n.textContent = b.name
        k.className = 'silk'
        k.textContent = `${b.footprints.toLocaleString('en-US')} parts`
        id.append(n, k)
        o.append(id)
        own.before(o)
      }
      pick('board', b.id)
      const hero = film?.querySelector<HTMLElement>('.shot--hero')?.inert === false
      const turned = hero && cut ? await cut.own(file.name.replace(/\.kicad_pcb$/i, ''), b.still, b.nets) : false
      if (!turned) $('#make')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' })
      toast(`Loaded ${b.name}: ${b.footprints.toLocaleString('en-US')} parts, ${b.nets.facts.nets.toLocaleString('en-US')} nets, ${(b.nets.facts.copperMm / 1000).toFixed(2)} m of copper.`)
    }, (err: unknown) => { toast(`Could not read that board: ${err instanceof Error ? err.message : String(err)}`) })
  }
  input?.addEventListener('change', () => { takeFile(input.files?.[0]); input.value = '' })
  let depth = 0
  const files = (e: DragEvent) => e.dataTransfer?.types.includes('Files') === true
  addEventListener('dragenter', (e) => { if (!files(e)) return; e.preventDefault(); depth++; html.classList.add('dragging') })
  addEventListener('dragover', (e) => { if (files(e)) e.preventDefault() })
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) html.classList.remove('dragging') })
  addEventListener('drop', (e) => { if (!files(e)) return; e.preventDefault(); depth = 0; html.classList.remove('dragging'); takeFile(e.dataTransfer?.files[0]) })

}
