import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ASPECT_SIZE, PALETTES } from '@silk-reel/choreo'
import type { Aspect, PaletteId } from '@silk-reel/choreo'
import { World, drawStill } from '../world/world'
import type { Film } from '../world/world'
import { filmOf, filmOwnBoard, fixtureFilm } from '../world/films'
import { ROOM } from '../world/room'
import { boards, traceFilms } from '../data/site'
import { prefersReducedMotion } from '../engine/env'
import { ReelGL } from '../reel/reel-gl'
import type { ReelPose } from '../reel/reel-gl'
import { N, RED, buildAtlas, buildHead, drawDrawing, isHero } from '../reel/strip'
import { rollTo } from './site'

gsap.registerPlugin(ScrollTrigger)

const $ = (s: string, r: ParentNode = document) => r.querySelector<HTMLElement>(s)
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T[] => [...r.querySelectorAll<T>(s)]
const stacked = () => matchMedia('(max-width: 1100px)').matches
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const pad = (v: number, n = 2) => String(Math.floor(v)).padStart(n, '0')
const tc = (frame: number) => `${pad(frame / 30 / 60)}:${pad((frame / 30) % 60)}.${pad(((frame / 30) % 1) * 100)}`
const dprOf = () => Math.min(2, devicePixelRatio || 1)
const FRAMES = 336
const GROUND = '#ecede9'

/** where the coil sits in the hero: the Paper comp at 1440 × 900, scaled by the viewport */
function heroPose(): Omit<ReelPose, 'ex'> {
  if (stacked()) {
    const say = document.querySelector<HTMLElement>('.hero__say')
    // a tablet held wide keeps the coil large enough to fill the width under the words
    const k = clamp(innerWidth / 1600, 0.45, 0.68)
    return { k, cx: -84, ly: Math.max(356, say ? say.offsetTop + say.offsetHeight + 80 + 40 * k : 0), leader: innerWidth + 200 }
  }
  const k = clamp(innerWidth / 1440, 0.6, 1.3)
  return { k, cx: innerWidth * 0.05, ly: 78 + 91 * k, leader: innerWidth * 1.1 }
}

export function setupHome() {
  const reduced = prefersReducedMotion()
  const html = document.documentElement
  const heroFilm = fixtureFilm('icebreaker', '16:9')

  /* ---------- the loader: first visit to home only. Its strip fills with the real load: fonts, film data, atlas, reel ---------- */
  const loader = $('[data-load]')
  const loading = !reduced && !html.classList.contains('seen') && loader !== null
  if (!loading) loader?.remove()
  else { html.classList.add('loading'); try { sessionStorage.setItem('sr-seen', '1') } catch { /* private mode */ } }
  const load = { fonts: 0, film: 0, atlas: 0, reel: 0 }
  const loaded = () => load.fonts * 0.1 + load.film * 0.3 + load.atlas * 0.5 + load.reel * 0.1
  const done = (k: keyof typeof load) => () => { load[k] = 1 }
  void document.fonts.ready.then(done('fonts'), done('fonts'))
  void heroFilm.then(done('film'), done('film'))

  /* ---------- the reel: one fixed GL canvas behind the hero ---------- */
  const glCanvas = document.querySelector<HTMLCanvasElement>('[data-reel]')
  const hero = $('#top')
  let reel: ReelGL | null = null
  let ex = 0
  let exTarget = 0
  const idle = reduced ? 0 : 0.12
  const atlasT = Math.min(1.49, heroPose().k * dprOf() * 1.1)

  const atlasReady = heroFilm.then(async (film) => {
    await document.fonts.ready
    // while the loader runs, the atlas works in short slices so the strip never drops a frame
    const atlas = await buildAtlas(film, atlasT, (p) => { load.atlas = p }, loading ? 6 : 40)
    return { film, atlas }
  })

  const startReel = (canvas: HTMLCanvasElement, atlas: HTMLCanvasElement) => {
    const ht = Math.min(2.4, heroPose().k * dprOf())
    try {
      const head = buildHead(ht)
      return new ReelGL(canvas, { canvas: atlas, t: atlasT }, { canvas: head, t: ht }, GROUND)
    } catch {
      return null
    }
  }

  const reelReady = atlasReady.then(async ({ atlas }) => {
    if (glCanvas) reel = startReel(glCanvas, atlas)
    if (!reel) html.classList.remove('gl')
    if (reel && glCanvas) {
      // draw once now and let two frames pass: the GPU does its first-draw work here, under the loader
      drawReel()
      await new Promise((r) => { requestAnimationFrame(() => { requestAnimationFrame(r) }) })
      html.classList.add('reel-live')
      gsap.ticker.add(drawReel)
    }
  }, () => { html.classList.remove('gl') }).finally(() => { load.atlas = 1; load.reel = 1 })

  let drawn = ''
  function drawReel() {
    if (!reel || !hero) return
    const dt = gsap.ticker.deltaRatio(60) / 60
    exTarget += idle * dt
    ex += (exTarget - ex) * (1 - Math.exp(-6 * dt))
    const hr = hero.getBoundingClientRect()
    let pose: ReelPose | null = null
    if (hr.bottom > 0) {
      const base = heroPose()
      const scrolled = reduced ? 0 : clamp(-hr.top / Math.max(1, hr.height), 0, 1)
      pose = { ...base, ly: base.ly + hr.top, ex: clamp(ex + scrolled * 9, 0, N - 1) }
    }
    /* off screen the canvas would keep its last frame; hide it instead */
    if (glCanvas) glCanvas.style.visibility = pose ? '' : 'hidden'
    if (!pose) return
    const key = `${pose.k.toFixed(3)},${pose.cx.toFixed(1)},${pose.ly.toFixed(1)},${pose.ex.toFixed(4)},${innerWidth},${innerHeight}`
    if (key === drawn) return
    drawn = key
    reel.draw(pose, dprOf())
  }

  /* the mark draws, the strip fills as the work finishes, then the mark lands in the header while the stock lifts */
  if (loading) {
    const stock = $('[data-load-stock]', loader)
    const strip = $('[data-load-strip]', loader)
    const mark = loader.querySelector<SVGSVGElement>('.load__mark')
    const frames = $$('[data-load-strip] i', loader)
    const parts = [...(mark?.querySelectorAll<SVGGeometryElement>('path, circle') ?? [])]
    const strokes = parts.slice(0, 6)
    const rings = parts.slice(6)
    const tl = gsap.timeline()
    gsap.set(mark ?? [], { opacity: 1, transformOrigin: '0 0' })
    gsap.set(rings, { scale: 0, transformOrigin: '50% 50%' })
    strokes.forEach((p, i) => {
      const len = p.getTotalLength()
      const at = i < 3 ? i * 0.08 : 0.3 + (i - 3) * 0.06
      gsap.set(p, { strokeDasharray: len, strokeDashoffset: len, opacity: 0 })
      tl.set(p, { opacity: 1 }, at)
      tl.to(p, { strokeDashoffset: 0, duration: i < 3 ? 0.36 : 0.24, ease: 'power3.out' }, at)
    })
    rings.forEach((r, i) => { tl.to(r, { scale: 1, duration: 0.2, ease: 'power3.out' }, 0.46 + i * 0.06) })
    const drawEnd = tl.duration()

    let shown = 0
    let lit = -1
    const meter = () => {
      const target = Math.min(loaded(), tl.time() / drawEnd)
      shown += (target - shown) * (1 - Math.pow(0.65, gsap.ticker.deltaRatio(60)))
      if (target - shown < 0.004) shown = target
      const n = Math.min(frames.length, Math.floor(shown * frames.length + 1e-6))
      if (n === lit) return
      lit = n
      frames.forEach((f, i) => { f.classList.toggle('is-lit', i < n); f.classList.toggle('is-now', i === n) })
    }
    gsap.ticker.add(meter)

    let ended = false
    let flight: gsap.core.Timeline | null = null
    const inputs = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const
    const finish = () => {
      if (ended) return
      ended = true
      gsap.ticker.remove(meter)
      tl.kill()
      flight?.kill()
      loader.remove()
      html.classList.remove('loading')
      for (const t of inputs) removeEventListener(t, finish)
    }
    for (const t of inputs) addEventListener(t, finish, { passive: true })

    const handoff = () => {
      if (ended) return
      gsap.ticker.remove(meter)
      const from = mark?.getBoundingClientRect()
      const to = $('.hd__mark')?.getBoundingClientRect()
      flight = gsap.timeline({ onComplete: finish })
      flight.to(strip ?? [], { opacity: 0, duration: 0.2, ease: 'power1.in' }, 0)
      if (mark && from && to && to.width > 0) {
        flight.to(mark, { x: to.left - from.left, y: to.top - from.top, scale: to.width / from.width, duration: 0.6, ease: 'power3.inOut' }, 0)
        flight.fromTo(mark, { color: '#ecede9', '--mark-fill': '#0b0b0b' }, { color: '#0b0b0b', '--mark-fill': '#ecede9', duration: 0.3, ease: 'none' }, 0.3)
      } else flight.to(mark ?? [], { opacity: 0, duration: 0.2, ease: 'power1.in' }, 0)
      flight.to(stock ?? [], { clipPath: 'inset(0% 0% 100% 0%)', duration: 0.5, ease: 'power2.inOut' }, 0.15)
    }
    const wait = (s: number) => new Promise<void>((r) => { setTimeout(r, s * 1000) })
    void Promise.all([wait(drawEnd + 0.12), Promise.race([reelReady, wait(1.3)])]).then(handoff)
  }

  /* ---------- the gate: scroll pulls the strip through; the screen shows what is in it ---------- */
  const gate = $('[data-gate]')
  const strip = document.querySelector<HTMLCanvasElement>('[data-strip]')
  const screenCanvas = document.querySelector<HTMLCanvasElement>('[data-screen-film]')
  const screen = new World(screenCanvas ?? document.createElement('canvas'), { reduced })
  screen.setPalette(ROOM, { instant: true })
  screen.setView({ zoom: 1920 / 1092, fx: 0.5, fy: 0.5, cx: 0.5, cy: 0.5 }, { instant: true })
  let frameNow = 240
  let playing = false
  let stripFilm: Film | null = null
  const readTc = $('[data-g-tc]')

  const paintStrip = (f: number) => {
    if (!strip || !stripFilm) return
    const dpr = dprOf()
    const w = strip.clientWidth, h = strip.clientHeight
    if (strip.width !== Math.round(w * dpr) || strip.height !== Math.round(h * dpr)) { strip.width = Math.round(w * dpr); strip.height = Math.round(h * dpr) }
    const ctx = strip.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#0b0b0b'
    ctx.fillRect(0, 0, strip.width, strip.height)
    /* the strip steps a whole drawing at a time, like a projector's claw, so the gate always holds one frame */
    const dCur = Math.round(f / 2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    /* a vertical strip on desktop (next frames above), a horizontal one on a phone (next frames to the right) */
    const across = w > h
    const sv = across ? (h * dpr) / 494 : (w * dpr) / 738
    const fw = 546 * sv, fh = 302 * sv, edge = 96 * sv, pitch = (across ? 568 : 324) * sv
    const mid = (across ? strip.width : strip.height) / 2
    const reach = Math.ceil(mid / pitch) + 1
    ctx.font = `500 ${Math.round(22 * sv)}px 'JetBrains Mono', monospace`
    for (let d = Math.floor(dCur) - reach; d <= Math.ceil(dCur) + reach; d++) {
      const dd = ((d % N) + N) % N
      const c = across ? mid + (d - dCur) * pitch : mid + (dCur - d) * pitch
      const fx = across ? c - fw / 2 : edge, fy = across ? edge : c - fh / 2
      drawDrawing(ctx, stripFilm, dd, fx, fy, fw, fh)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const hot = isHero(dd)
      ctx.strokeStyle = hot ? RED : '#303030'
      ctx.lineWidth = (hot ? 3 : 1.5) * sv
      ctx.strokeRect(fx, fy, fw, fh)
      ctx.fillStyle = '#ffffff'
      for (let i = 0; i < 4; i++) {
        const along = c - pitch / 2 + (i + 0.5) * (pitch / 4)
        const sides = across ? [edge / 2 - 6 * sv, strip.height - edge / 2 + 6 * sv] : [edge / 2 + 6 * sv, strip.width - edge / 2 - 6 * sv]
        for (const side of sides) {
          ctx.beginPath()
          if (across) ctx.roundRect(along - 17 * sv, side - 13 * sv, 34 * sv, 26 * sv, 5 * sv)
          else ctx.roundRect(side - 13 * sv, along - 17 * sv, 26 * sv, 34 * sv, 5 * sv)
          ctx.fill()
        }
      }
      ctx.fillStyle = hot ? RED : '#8a8a84'
      if (across) {
        ctx.fillText(pad(dd * 2, 3), c, strip.height - 12 * sv)
      } else {
        ctx.save()
        ctx.translate(strip.width - 14 * sv, c)
        ctx.rotate(-Math.PI / 2)
        ctx.fillText(pad(dd * 2, 3), 0, 0)
        ctx.restore()
      }
    }
  }

  const screenEl = document.querySelector<HTMLElement>('[data-screen]')
  const showFrame = (f: number) => {
    frameNow = ((Math.round(f) % FRAMES) + FRAMES) % FRAMES
    paintStrip(f)
    screenEl?.setAttribute('aria-valuenow', String(frameNow))
    screenEl?.setAttribute('aria-valuetext', `Frame ${frameNow} of ${FRAMES}`)
    if (readTc) readTc.textContent = tc(frameNow)
  }

  void heroFilm.then((film) => {
    stripFilm = film
    screen.show(film, { decode: false })
    screen.scrub(frameNow)
    showFrame(frameNow)
  })

  screen.onFrame((info) => { if (playing) showFrame(info.frame) })
  const stopPlay = () => {
    if (!playing) return
    playing = false
    screen.pause()
    screen.scrub(frameNow)
    gate?.classList.remove('is-playing')
  }

  const beam = () => {
    const box = $('.gate__box')?.getBoundingClientRect()
    const sc = $('[data-screen]')?.getBoundingClientRect()
    const svg = document.querySelector<SVGSVGElement>('[data-beam]')
    const pin = $('.gate__pin')?.getBoundingClientRect()
    if (!box || !sc || !svg || !pin) return
    const o = (x: number, y: number) => `${(x - pin.left).toFixed(1)},${(y - pin.top).toFixed(1)}`
    /* the light leaves the gate toward the screen: to the right on desktop, upward on a phone */
    const up = sc.bottom <= box.top
    const g1 = up ? [box.left + 6, box.top] : [box.right, box.top + 6]
    const g2 = up ? [box.right - 6, box.top] : [box.right, box.bottom - 6]
    const s1 = up ? [sc.left, sc.bottom] : [sc.left, sc.top]
    const s2 = up ? [sc.right, sc.bottom] : [sc.left, sc.bottom]
    const pts = [g1, s1, s2, g2].map(([x, y]) => o(x ?? 0, y ?? 0))
    $('[data-beam-poly]', svg)?.setAttribute('points', pts.join(' '))
    const line = (el: HTMLElement | null, p: number[], q: number[]) => {
      el?.setAttribute('x1', String((p[0] ?? 0) - pin.left)); el?.setAttribute('y1', String((p[1] ?? 0) - pin.top))
      el?.setAttribute('x2', String((q[0] ?? 0) - pin.left)); el?.setAttribute('y2', String((q[1] ?? 0) - pin.top))
    }
    line($('[data-beam-a]', svg), g1, s1)
    line($('[data-beam-b]', svg), g2, s2)
    const grad = svg.querySelector('linearGradient')
    grad?.setAttribute('x2', up ? '0' : '1'); grad?.setAttribute('y1', up ? '1' : '0')
  }

  if (gate && !reduced) {
    ScrollTrigger.create({
      trigger: gate,
      start: 'top top',
      end: () => `+=${innerHeight * 2.6}`,
      pin: '.gate__pin',
      invalidateOnRefresh: true,
      onUpdate: (st) => {
        if (playing) return
        const f = st.progress * (FRAMES - 1)
        screen.scrub(f)
        showFrame(f)
      },
      onRefresh: beam
    })
  }
  addEventListener('resize', () => { beam(); showFrame(frameNow) })
  requestAnimationFrame(beam)

  const gateInView = () => {
    const r = gate?.getBoundingClientRect()
    return !!r && r.top < innerHeight * 0.5 && r.bottom > innerHeight * 0.5
  }
  addEventListener('keydown', (e) => {
    if (!gateInView() || (e.target instanceof HTMLElement && e.target.closest('input, textarea, button, a, [role="radio"]'))) return
    if (e.key === ' ') {
      e.preventDefault()
      if (playing) { stopPlay(); return }
      playing = true
      gate?.classList.add('is-playing')
      screen.seek(frameNow)
      screen.play()
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      stopPlay()
      const f = frameNow + (e.key === 'ArrowRight' ? 2 : -2)
      screen.scrub(((f % FRAMES) + FRAMES) % FRAMES)
      showFrame(f)
    }
  })
  addEventListener('wheel', stopPlay, { passive: true })
  addEventListener('touchmove', stopPlay, { passive: true })

  /* ---------- two looks: the trace render and the live glyph film play while they are on screen ---------- */
  const lookCanvas = document.querySelector<HTMLCanvasElement>('[data-look-film]')
  const lookVideo = document.querySelector<HTMLVideoElement>('[data-look-video]')
  if (lookCanvas) {
    const look = new World(lookCanvas, { reduced })
    look.setPalette(ROOM, { instant: true })
    look.setView({ zoom: 1920 / 1092, fx: 0.5, fy: 0.5, cx: 0.5, cy: 0.5 }, { instant: true })
    void fixtureFilm('glasgow', '16:9').then((film) => { look.show(film, { decode: false }); if (reduced) look.scrub(182); else look.seek(182) })
    // the drawing hands over to this film on its plan act, the beat where its parts sit on the board's own outline
    const PLAN = (5 / 24) * FRAMES
    lookCanvas.addEventListener('handover', (e) => {
      if ((e as CustomEvent<boolean>).detail) { look.seek(PLAN); look.play() } else { look.pause(); look.seek(PLAN) }
    })
    // each film's steps run under its frame: the playhead marks the beat, a click plays on from a step
    const traceActs = $('[data-look="trace"] [data-acts]') ?? undefined
    const glyphActs = $('[data-look="glyph"] [data-acts]') ?? undefined
    const mark = (el: HTMLElement | undefined, beat: number) => {
      el?.style.setProperty('--p', (beat / 24).toFixed(4))
      for (const li of el ? $$('li', el) : []) li.classList.toggle('is-now', beat >= Number(li.dataset.at) && beat < Number(li.dataset.end))
    }
    const onAct = (el: HTMLElement | undefined, play: (beat: number) => void) => {
      el?.addEventListener('click', (e) => {
        const li = (e.target as Element).closest<HTMLElement>('[data-at]')
        if (li) play(Number(li.dataset.at))
      })
    }
    let glyphTotal = FRAMES
    look.onFrame((info) => { glyphTotal = info.film.tl.totalFrames; mark(glyphActs, info.beat) })
    onAct(glyphActs, (beat) => { const f = (beat / 24) * glyphTotal; if (reduced) look.scrub(f); else look.seek(f) })
    const traceBeat = () => (lookVideo && lookVideo.duration > 0 ? (lookVideo.currentTime / lookVideo.duration) * 24 : 0)
    onAct(traceActs, (beat) => { if (lookVideo && lookVideo.duration > 0) lookVideo.currentTime = (beat / 24) * lookVideo.duration })
    lookVideo?.addEventListener('timeupdate', () => { mark(traceActs, traceBeat()) })
    let lookOn = false
    const follow = () => { mark(traceActs, traceBeat()); if (lookOn) requestAnimationFrame(follow) }
    mark(traceActs, 0)
    new IntersectionObserver(([e]) => {
      const on = e?.isIntersecting === true && !reduced
      if (on) { look.play(); void lookVideo?.play().catch(() => { /* the poster stays */ }) } else { look.pause(); look.seek(182); lookVideo?.pause() }
      if (on && !lookOn) { lookOn = true; requestAnimationFrame(follow) } else if (!on) lookOn = false
    }, { threshold: 0.25 }).observe(lookCanvas)
  }
  if (reduced && lookVideo) lookVideo.controls = true

  const input = document.querySelector<HTMLInputElement>('[data-file]')

  /* ---------- one command: each word picks a value, the monitor plays the film the line would render ---------- */
  type Style = 'glyph' | 'trace'
  const monitorStage = $('[data-monitor]')
  const monitorCanvas = document.querySelector<HTMLCanvasElement>('[data-monitor-film]')
  const monitorVideo = document.querySelector<HTMLVideoElement>('[data-monitor-video]')
  const monitor = new World(monitorCanvas ?? document.createElement('canvas'), { reduced })
  const STILL = 240
  const state: { board: string; style: Style; aspect: Aspect; ink: PaletteId } = { board: 'icebreaker', style: 'glyph', aspect: '16:9', ink: 'mono' }
  try { const s = localStorage.getItem('sr-ink'); if (s && s in PALETTES) state.ink = s as PaletteId } catch { /* private mode */ }
  const names = new Map<string, { name: string; file: string; own?: true }>(boards.map((b) => [b.id, { name: b.name, file: `${b.id}.kicad_pcb` }]))
  monitor.setPalette(state.ink, { instant: true })

  const stage = $('[data-monitor-stage]')
  const frameRect = () => ({ x: 0, y: 0, w: stage?.clientWidth ?? 0, h: stage?.clientHeight ?? 0 })
  // the site ships each trace film at 16:9 only; the command still renders the chosen aspect
  const shown = (): Aspect => (state.style === 'trace' ? '16:9' : state.aspect)
  const monitorNote = $('[data-monitor-note]')
  const fitStage = () => {
    monitorStage?.style.setProperty('--ar', shown().replace(':', ' / '))
    monitorStage?.style.setProperty('--film-bg', state.style === 'trace' ? '#0b0b0b' : PALETTES[state.ink].bg)
    if (monitorNote) {
      monitorNote.hidden = shown() === state.aspect
      monitorNote.textContent = `Trace previews at 16:9 here. The command renders ${state.aspect}.`
    }
    const px = ASPECT_SIZE[shown()]
    const [w, h] = [$('[data-dim-w]'), $('[data-dim-h]')]
    if (w) w.textContent = `${px.width} px`
    if (h) h.textContent = `${px.height} px`
  }
  const monitorTc = $('[data-monitor-tc]')
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
      $(`[data-tok="${k}"]`)?.setAttribute('aria-label', `${k[0]?.toUpperCase()}${k.slice(1)}: ${v}. Change the ${k}`)
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
  const showMonitor = (instant = false) => {
    const trace = state.style === 'trace'
    fitStage()
    if (monitorCanvas) monitorCanvas.hidden = trace
    if (monitorVideo) {
      monitorVideo.hidden = !trace
      if (trace) {
        const src = `/films/trace/${state.board}-540.mp4`
        if (!monitorVideo.src.endsWith(src)) { monitorVideo.poster = `/films/trace/${state.board}-poster.webp`; monitorVideo.src = src }
        if (!reduced && monitorOn()) void monitorVideo.play().catch(() => { /* the poster stays */ })
        monitor.pause()
      } else monitorVideo.pause()
    }
    if (!trace) {
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
    else if (on) monitor.play()
    else monitor.pause()
  }).observe(monitorStage ?? document.body)
  addEventListener('resize', () => { monitor.setView({ rect: frameRect() }, { instant: true }) })

  const pick = (k: string, v: string) => {
    const noTrace = (id: string) => `Trace for ${names.get(id)?.name ?? id} renders on your machine. It plays as Glyph here.`
    if (k === 'board') {
      if (v === state.board) return
      state.board = v
      if (state.style === 'trace' && !traceFilms.includes(v)) { state.style = 'glyph'; if (!names.get(v)?.own) toast(noTrace(v)) }
    } else if (k === 'style') {
      if (v === state.style) return
      if (v === 'trace' && !traceFilms.includes(state.board)) { toast(noTrace(state.board)); return }
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
