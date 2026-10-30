import { ASPECT_SIZE, PALETTES } from '@silk-reel/choreo'
import type { Aspect, PaletteId, TraceTimeline } from '@silk-reel/choreo'
import { drawPlotFrame } from '@silk-reel/render/film'
import { World, drawStill } from '../world/world'
import { filmOf, filmOwnBoard } from '../world/films'
import { boards, traceFilms } from '../data/site'
import { prefersReducedMotion } from '../engine/env'
import { setupStage } from '../cut/stage'
import { rollTo } from './site'

const $ = (s: string, r: ParentNode = document) => r.querySelector<HTMLElement>(s)
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T[] => [...r.querySelectorAll<T>(s)]
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const pad = (v: number, n = 2) => String(Math.floor(v)).padStart(n, '0')
const tc = (frame: number) => `${pad(frame / 30 / 60)}:${pad((frame / 30) % 60)}.${pad(((frame / 30) % 1) * 100)}`

export function setupHome() {
  const reduced = prefersReducedMotion()
  const html = document.documentElement
  const film = $('[data-stage]')
  if (film) setupStage(film, reduced)

  const input = document.querySelector<HTMLInputElement>('[data-file]')

  /* ---------- one command: each word picks a value, the monitor plays the film the line would render ---------- */
  type Style = 'glyph' | 'trace' | 'plot'
  const monitorStage = $('[data-monitor]')
  const monitorCanvas = document.querySelector<HTMLCanvasElement>('[data-monitor-film]')
  const monitorVideo = document.querySelector<HTMLVideoElement>('[data-monitor-video]')
  const monitor = new World(monitorCanvas ?? document.createElement('canvas'), { reduced })
  const STILL = 240
  const state: { board: string; style: Style; aspect: Aspect; ink: PaletteId } = { board: 'icebreaker', style: 'trace', aspect: '16:9', ink: 'mono' }
  try { const s = localStorage.getItem('sr-ink'); if (s && s in PALETTES) state.ink = s as PaletteId } catch { /* private mode */ }
  const names = new Map<string, { name: string; file: string; own?: true }>(boards.map((b) => [b.id, { name: b.name, file: `${b.id}.kicad_pcb` }]))
  monitor.setPalette(state.ink, { instant: true })

  const stage = $('[data-monitor-stage]')
  const frameRect = () => ({ x: 0, y: 0, w: stage?.clientWidth ?? 0, h: stage?.clientHeight ?? 0 })
  // the site ships each trace film at 16:9 only; the command still renders the chosen aspect
  const shown = (): Aspect => (state.style === 'glyph' ? state.aspect : '16:9')
  const monitorNote = $('[data-monitor-note]')
  const fitStage = () => {
    monitorStage?.style.setProperty('--ar', shown().replace(':', ' / '))
    monitorStage?.style.setProperty('--film-bg', state.style === 'trace' ? '#0b0b0b' : state.style === 'plot' ? '#ecede9' : PALETTES[state.ink].bg)
    if (monitorNote) {
      monitorNote.hidden = shown() === state.aspect
      monitorNote.textContent = `${state.style === 'plot' ? 'Plot' : 'Trace'} previews at 16:9 here. The command renders ${state.aspect}.`
    }
    const px = ASPECT_SIZE[shown()]
    const [w, h] = [$('[data-dim-w]'), $('[data-dim-h]')]
    if (w) w.textContent = `${px.width} px`
    if (h) h.textContent = `${px.height} px`
  }
  const monitorTc = $('[data-monitor-tc]')
  const monitorCredit = $('[data-monitor-credit]')
  monitor.onFrame((info) => { if (monitorTc && state.style === 'glyph') monitorTc.textContent = tc(info.frame) })
  monitorVideo?.addEventListener('timeupdate', () => { if (monitorTc) monitorTc.textContent = tc(monitorVideo.currentTime * 30) })
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
    if (pal) pal.hidden = state.style === 'trace'
    const copy = $('[data-cmd-copy]')
    if (copy) copy.dataset.copy = ['npm run reel --', ...tokens()].join(' ')
    for (const [k, v] of [['board', state.board], ['style', state.style], ['aspect', state.aspect], ['palette', state.ink]] as const) {
      $$(`[data-pick="${k}"] [data-v]`).forEach((o) => { o.setAttribute('aria-checked', String(o.dataset.v === v)) })
    }
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
  let plotLast = -1
  let plotT0 = 0
  const plotTick = (now: number) => {
    if (!plotRun || !plotTl || !plotCanvas || !plotCtx) return
    requestAnimationFrame(plotTick)
    const f = reduced ? plotTl.totalFrames - 1 : Math.floor(((now - plotT0) / 1000) * plotTl.fps) % plotTl.totalFrames
    const w = Math.round(plotCanvas.clientWidth * Math.min(2, devicePixelRatio || 1))
    if (f === plotLast && plotCanvas.width === w) return
    if (plotCanvas.width !== w) { plotCanvas.width = w; plotCanvas.height = Math.round((w * plotTl.height) / plotTl.width) }
    drawPlotFrame(plotCtx, plotTl, f, w / plotTl.width)
    plotLast = f
    if (monitorTc) monitorTc.textContent = tc(f)
  }
  const plotPlay = (on: boolean) => {
    if (on === plotRun) return
    plotRun = on
    if (on) { plotT0 = performance.now(); requestAnimationFrame(plotTick) }
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
      void plotOf(id).then((tl) => { if (state.board !== id || state.style !== 'plot') return; plotTl = tl; plotLast = -1; plotRun = false; plotPlay(monitorOn() || reduced) })
    } else plotPlay(false)
    if (monitorVideo) {
      monitorVideo.hidden = !trace
      if (trace) {
        const src = `/films/trace/${state.board}-540.mp4`
        if (!monitorVideo.src.endsWith(src)) { monitorVideo.poster = `/films/trace/${state.board}-poster.webp`; monitorVideo.src = src }
        if (!reduced && monitorOn()) void monitorVideo.play().catch(() => { /* the poster stays */ })
        monitor.pause()
      } else monitorVideo.pause()
    }
    if (!trace && !plot) {
      void filmOf(state.board, state.aspect).then((film) => {
        monitor.show(film, { decode: !instant })
        monitor.setView({ rect: frameRect(), zoom: 1.45, cx: 0.5, cy: 0.5, fx: 0.5, fy: 0.5 }, { instant })
        if (reduced) monitor.scrub(STILL)
        else { monitor.seek(182); if (monitorOn()) monitor.play() }
      })
    }
    paintCmd()
  }
  showMonitor(true)
  new IntersectionObserver(([e]) => {
    const on = e?.isIntersecting === true && !reduced
    if (state.style === 'trace') { if (on) void monitorVideo?.play().catch(() => { /* the poster stays */ }); else monitorVideo?.pause() }
    else if (state.style === 'plot') plotPlay(on)
    else if (on) monitor.play()
    else monitor.pause()
  }).observe(monitorStage ?? document.body)
  addEventListener('resize', () => { monitor.setView({ rect: frameRect() }, { instant: true }) })

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
    filmOwnBoard(file).then((b) => {
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
      $('#make')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' })
      toast(`Loaded ${b.name}: ${b.footprints.toLocaleString('en-US')} parts.`)
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
