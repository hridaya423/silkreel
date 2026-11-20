import { PALETTES } from '@silk-reel/choreo'
import type { Aspect, PaletteId, Timeline } from '@silk-reel/choreo'
import { createPreview } from '@silk-reel/render/preview'
import { drawStill } from '../world/world'
import { filmOf, filmOwnBoard } from '../world/films'
import { boards } from '../data/site'
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
  type Style = 'glyph' | 'trace' | 'plot' | 'montage'
  const monitorStage = $('[data-monitor]')
  const monitorCanvas = document.querySelector<HTMLCanvasElement>('[data-monitor-film]')
  const monitorVideo = document.querySelector<HTMLVideoElement>('[data-monitor-video]')
  const preview = createPreview(monitorCanvas ?? document.createElement('canvas'))
  const STILL = 240
  const state: { board: string; style: Style; aspect: Aspect; ink: PaletteId } = { board: 'glasgow', style: 'trace', aspect: '16:9', ink: 'mono' }
  try { const s = localStorage.getItem('sr-ink'); if (s && s in PALETTES) state.ink = s as PaletteId } catch { /* private mode */ }
  const names = new Map<string, { name: string; file: string; own?: true }>(boards.map((b) => [b.id, { name: b.name, file: `${b.id}.kicad_pcb` }]))

  const filmed = () => state.style === 'trace' || state.style === 'montage'
  // the site ships plot films, and trace and montage films of every board but Glasgow, at 16:9 only; the command still renders the chosen aspect
  const shown = (): Aspect => (state.style === 'plot' || (filmed() && state.board !== 'glasgow') ? '16:9' : state.aspect)
  const monitorNote = $('[data-monitor-note]')
  const fitStage = () => {
    if (monitorStage) monitorStage.dataset.style = state.style
    monitorStage?.style.setProperty('--ar', shown().replace(':', ' / '))
    monitorStage?.style.setProperty('--film-bg', filmed() ? '#0b0b0b' : PALETTES[state.style === 'plot' ? 'cyanotype' : state.ink].bg)
    if (monitorNote) {
      monitorNote.hidden = shown() === state.aspect
      monitorNote.textContent = `${state.style.charAt(0).toUpperCase()}${state.style.slice(1)} previews at 16:9 here. The command renders ${state.aspect}.`
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
  const plots = new Map<string, Promise<Timeline>>()
  const plotOf = (id: string) => {
    let p = plots.get(id)
    if (!p) { p = fetch(`/films/plot/${id}-16x9.json`).then((r) => r.json() as Promise<Timeline>); plots.set(id, p) }
    return p
  }
  const drawnOf = (): Promise<Timeline> => (state.style === 'plot' ? plotOf(state.board) : filmOf(state.board, state.aspect).then((f) => ({ ...f.tl, palette: PALETTES[state.ink] })))
  let drawn: Timeline | null = null
  let drawnRun = false
  let drawnF = 0
  let drawnPrev = 0
  let drawnLast = -1
  const drawNow = () => {
    if (!drawn) return
    const f = Math.floor(drawnF)
    if (f === drawnLast) return
    preview.draw(drawn, f)
    drawnLast = f
  }
  const drawnTick = (now: number) => {
    if (!drawnRun || !drawn) return
    requestAnimationFrame(drawnTick)
    drawnF = (drawnF + ((now - drawnPrev) / 1000) * drawn.fps) % drawn.totalFrames
    drawnPrev = now
    drawNow()
  }
  const drawnPlay = (on: boolean) => {
    if (on === drawnRun) return
    drawnRun = on
    if (on) { drawnPrev = performance.now(); requestAnimationFrame(drawnTick) }
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
  const progress = () => {
    if (filmed()) return monitorVideo?.duration ? monitorVideo.currentTime / monitorVideo.duration : 0
    return drawn ? drawnF / drawn.totalFrames : 0
  }
  const paintSeek = () => {
    if (!seekBar || seekBar.matches(':active')) return
    const v = Math.min(1, Math.max(0, progress()))
    seekBar.value = String(Math.round(v * 1000))
    seekBar.style.setProperty('--v', v.toFixed(4))
  }
  const run = () => {
    const on = playing()
    if (filmed()) { if (on) void monitorVideo?.play().catch(() => { /* the poster stays */ }); else monitorVideo?.pause() }
    else drawnPlay(on)
  }
  const loop = () => { paintSeek(); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  playBtn?.addEventListener('click', () => { held = !held; paintPlay(); run() })
  seekBar?.addEventListener('input', () => {
    const v = Number(seekBar.value) / 1000
    seekBar.style.setProperty('--v', v.toFixed(4))
    if (filmed()) { if (monitorVideo?.duration) monitorVideo.currentTime = v * monitorVideo.duration * 0.999 }
    else if (drawn) { drawnF = v * (drawn.totalFrames - 1); drawNow() }
  })
  paintPlay()

  const filmSrc = () => {
    const name = `/films/${state.style}/${state.board}-${shown().replace(':', 'x')}`
    return { src: `${name}.mp4`, poster: `${name}-poster.webp` }
  }
  const showMonitor = () => {
    const video = filmed()
    fitStage()
    paintCmd()
    const board = boards.find((b) => b.id === state.board)
    if (monitorCredit) monitorCredit.textContent = board ? `${board.name}, ${board.maker}` : ''
    if (monitorCanvas) monitorCanvas.hidden = video
    if (monitorVideo) {
      monitorVideo.hidden = !video
      if (video) {
        const { src, poster } = filmSrc()
        if (!monitorVideo.src.endsWith(src)) { monitorVideo.poster = poster; monitorVideo.src = src }
        if (playing()) void monitorVideo.play().catch(() => { /* the poster stays */ })
      } else monitorVideo.pause()
    }
    drawnPlay(false)
    if (video) return
    const want = `${state.style}:${state.board}:${state.aspect}`
    void drawnOf().then((tl) => {
      if (`${state.style}:${state.board}:${state.aspect}` !== want) return
      drawn = tl
      drawnF = reduced ? tl.totalFrames - 1 : 0
      drawnLast = -1
      drawNow()
      drawnPlay(playing())
    })
  }
  looks?.addEventListener('lookchange', (event) => { pick('style', (event as CustomEvent<string>).detail) })
  showMonitor()
  new IntersectionObserver(() => { run() }).observe(monitorStage ?? document.body)
  $$('[data-rail]').forEach((o) => { o.addEventListener('click', () => { pick('aspect', o.dataset.rail ?? '16:9') }) })

  const pick = (k: string, v: string) => {
    const elsewhere = (style: string, id: string) => `${style.charAt(0).toUpperCase()}${style.slice(1)} for ${names.get(id)?.name ?? id} renders on your machine. It plays as Glyph here.`
    if (k === 'board') {
      if (v === state.board) return
      state.board = v
      if (state.style !== 'glyph' && names.get(v)?.own) { toast(elsewhere(state.style, v)); state.style = 'glyph' }
    } else if (k === 'style') {
      if (v === state.style) return
      if (v !== 'glyph' && names.get(state.board)?.own) { toast(elsewhere(v, state.board)); return }
      state.style = v as Style
    }
    else if (k === 'aspect') { if (v === state.aspect) return; state.aspect = v as Aspect }
    else if (k === 'palette') {
      if (v === state.ink) return
      state.ink = v as PaletteId
      try { localStorage.setItem('sr-ink', v) } catch { /* private mode */ }
      if (drawn && state.style === 'glyph') { drawn = { ...drawn, palette: PALETTES[state.ink] }; drawnLast = -1; drawNow() }
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
