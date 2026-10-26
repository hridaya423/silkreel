import { gsap } from 'gsap'
import { ASPECT_SIZE, DEMO_CAST_HINTS } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, MaskColor, PaletteId, StyleId, Timeline } from '@silk-reel/choreo'
import { createPreview } from '@silk-reel/render/preview'
import { prefersReducedMotion } from '../engine/env'
import { aspects, boards, formats, site } from '../data/site'
import { rollTo } from '../motion/site'
import type { BoardStats, FromWorker, ToWorker } from './studio.worker'

type Format = 'mp4' | 'gif' | 'webm-alpha' | 'prores-alpha'
interface State {
  board: string; style: StyleId; aspect: Aspect; palette: PaletteId; accent: string; useAccent: boolean
  title: string; version: string; tempo: number; seed: number; format: Format
  /** '' lets the film pick */
  hero: string; mask: MaskColor | ''
}
interface Own { id: string; file: string; name: string }
interface Job { id: string; status: string; progress: number; format: string; error?: string; etaSeconds?: number | null }

/** the live monitor compiles at two thirds of the release size: the same layout, a lighter frame */
const PREVIEW = 2 / 3
const API_KEY = 'sr-api'
const ACCENT = '#ff4a3d'
const $ = (s: string, root: ParentNode = document) => root.querySelector<HTMLElement>(s)
const pad = (v: number, n = 2) => String(Math.max(0, Math.floor(v))).padStart(n, '0')
const tc = (s: number) => `${pad(s / 60)}:${pad(s % 60)}.${pad((s % 1) * 100)}`
const even = (v: number) => Math.round(v / 2) * 2
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const why = (e: unknown) => {
  const t = (e instanceof Error ? e.message : String(e)).trim().replace(/\s+/g, ' ')
  return t.length > 240 ? `${t.slice(0, 240)}…` : t
}

export function setupStudio() {
  const root = $('[data-studio]')
  if (!root) return
  const reduced = prefersReducedMotion()
  const canvas = root.querySelector<HTMLCanvasElement>('[data-out]')
  const stage = $('[data-stage]', root)
  const monitor = $('[data-monitor]', root)
  if (!canvas || !stage || !monitor) return
  const busy = $('[data-busy]', root)
  const busySay = $('[data-busy-say]', root)

  const preview = createPreview(canvas)
  const worker = new Worker(new URL('./studio.worker.ts', import.meta.url), { type: 'module' })
  const send = (m: ToWorker) => { worker.postMessage(m) }

  /* ---------- state, from the form and the address bar ---------- */
  const q = new URLSearchParams(location.search)
  const sample = boards.find((b) => b.id === q.get('board'))
  const state: State = {
    board: sample?.id ?? 'icebreaker',
    style: q.get('style') === 'trace' ? 'trace' : 'glyph',
    aspect: (['4:5', '1:1', '9:16', '16:9'] as const).find((a) => a === q.get('aspect')) ?? '16:9',
    palette: (['mono', 'copper', 'blueprint', 'phosphor'] as const).find((p) => p === q.get('palette')) ?? 'mono',
    accent: /^#[0-9a-f]{6}$/i.test(q.get('accent') ?? '') ? q.get('accent') ?? ACCENT : ACCENT,
    useAccent: /^#[0-9a-f]{6}$/i.test(q.get('accent') ?? ''),
    title: (q.get('title') ?? '').slice(0, 32),
    version: (q.get('version') ?? '').slice(0, 12),
    tempo: Math.min(1.5, Math.max(0.75, Number(q.get('tempo') ?? 1) || 1)),
    seed: Number.isInteger(Number(q.get('seed'))) && q.get('seed') !== null ? Number(q.get('seed')) : 42,
    format: (['mp4', 'gif', 'webm-alpha', 'prores-alpha'] as const).find((f) => f === q.get('format')) ?? 'mp4',
    hero: (q.get('hero') ?? '').slice(0, 64),
    mask: (['green', 'black', 'white', 'blue', 'red', 'yellow', 'purple'] as const).find((c) => c === q.get('mask')) ?? ''
  }
  /** the board the visitor dropped; it stays selectable after they try a sample */
  let own: Own | null = null
  const isOwn = () => own?.id === state.board
  const boardName = () => (isOwn() ? own?.name : boards.find((b) => b.id === state.board)?.name) ?? state.board

  const field = <T extends HTMLInputElement>(name: string) => [...root.querySelectorAll<T>(`[name="${name}"]`)]
  const writeForm = () => {
    for (const name of ['style', 'aspect', 'palette', 'format'] as const) for (const el of field(name)) el.checked = el.value === state[name]
    const set = (name: string, v: string) => { const el = field(name)[0]; if (el) el.value = v }
    set('title', state.title); set('version', state.version); set('accent', state.accent)
    set('tempo', String(state.tempo)); set('seed', String(state.seed))
    set('hero', state.hero); set('mask', state.mask)
  }
  const readForm = () => {
    const pick = (name: string) => field(name).find((el) => el.checked)?.value
    state.style = (pick('style') as StyleId | undefined) ?? state.style
    state.aspect = (pick('aspect') as Aspect | undefined) ?? state.aspect
    state.palette = (pick('palette') as PaletteId | undefined) ?? state.palette
    state.format = (pick('format') as Format | undefined) ?? state.format
    const val = (name: string) => field(name)[0]?.value ?? ''
    state.title = val('title').trim(); state.version = val('version').trim()
    state.accent = val('accent')
    state.tempo = Number(val('tempo')) || 1
    state.hero = val('hero')
    state.mask = val('mask') as MaskColor | ''
    const seed = Number(val('seed'))
    state.seed = Number.isFinite(seed) ? Math.max(0, Math.min(99999, Math.round(seed))) : 42
  }

  const config = (scale: number, style: StyleId = state.style): FilmConfig => {
    const size = ASPECT_SIZE[state.aspect]
    const cast = DEMO_CAST_HINTS[state.board]
    return {
      style, aspect: state.aspect, seed: state.seed, duration: 'auto',
      knobs: { tempo: state.tempo },
      output: { width: even(size.width * scale), height: even(size.height * scale), fps: 30 },
      ...(cast !== undefined ? { cast } : {}),
      ...(state.style === 'glyph' ? { palette: state.palette } : {}),
      ...(state.useAccent ? { accent: state.accent } : {}),
      ...(state.hero ? { hero: state.hero } : {}),
      ...(style === 'trace' && state.mask ? { mask: state.mask } : {}),
      ...(state.title ? { title: { name: state.title, ...(state.version ? { version: state.version } : {}) } } : {})
    }
  }

  /* ---------- the copied command mirrors every control ---------- */
  const cmdEl = $('[data-cmd]', root)
  const command = () => {
    const file = isOwn() ? own?.file ?? 'board.kicad_pcb' : `fixtures/boards/${state.board}.kicad_pcb`
    const quote = (s: string) => (/^[\w./#:-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`)
    const parts = ['npm run reel --', quote(file), '--style', state.style, '--aspect', state.aspect]
    if (state.style === 'glyph') parts.push('--palette', state.palette)
    if (state.useAccent) parts.push('--accent', state.accent)
    if (state.hero) parts.push('--hero', quote(state.hero))
    if (state.style === 'trace' && state.mask) parts.push('--mask', state.mask)
    if (state.title) parts.push('--title', quote(state.title))
    if (state.title && state.version) parts.push('--version', quote(state.version))
    if (state.seed !== 42) parts.push('--seed', String(state.seed))
    if (state.tempo !== 1) parts.push('--tempo', String(state.tempo))
    if (state.format !== 'mp4') parts.push('--format', state.format)
    return parts.join(' ')
  }

  /* ---------- first-time setup on the visitor's machine, as commands or as a prompt for their coding agent ---------- */
  const setupCmd = $('[data-setup-cmd]', root)
  const setupAgent = $('[data-setup-agent]', root)
  const paintSetup = () => {
    const dir = site.repo.split('/').pop() ?? 'silkreel'
    const cmd = [`git clone ${site.repo}`, `cd ${dir}`, 'npm ci', command()]
    if (setupCmd) setupCmd.textContent = ['# needs Node.js 22 or later, ffmpeg and ffprobe', ...cmd.map((c) => `$ ${c}`)].join('\n')
    const find = isOwn() ? [`My board file is ${own?.file ?? 'board.kicad_pcb'}. Find it on this machine, or ask me for its path, and use that path in the command.`] : []
    const prompt = [
      'Set up silk reel on this machine and render a film of my KiCad board.',
      '',
      '1. Check that Node.js 22 or later, ffmpeg and ffprobe are installed. Install any that are missing.',
      `2. Clone ${site.repo} and run npm ci in it.`,
      ...find.map((l) => `   ${l}`),
      `3. From the repo root, run: ${command()}`,
      '4. If the render fails with a GPU or WebGL error, run it again with SILK_REEL_GL=swangle in front of the command.',
      '5. Tell me the path of the finished video.'
    ].join('\n')
    if (setupAgent) setupAgent.textContent = prompt
    for (const b of root.querySelectorAll<HTMLElement>('[data-copy-setup]')) b.dataset.copy = b.dataset.copySetup === 'agent' ? prompt : cmd.join('\n')
  }

  /* ---------- messages: a live region for the screen reader, a toast for the eye, a held error for what failed ---------- */
  const statusEl = $('[data-status]', root)
  const say = (text: string) => {
    if (!statusEl) return
    statusEl.textContent = ''
    window.setTimeout(() => { statusEl.textContent = text }, 60)
  }
  const toastEl = $('[data-toast]', root)
  let toastTimer = 0
  const toast = (text: string, hold = 4200) => {
    say(text)
    if (!toastEl) return
    toastEl.textContent = text
    toastEl.dataset.on = ''
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => { delete toastEl.dataset.on }, hold)
  }
  const errEl = $('[data-err]', root)
  const fail = (text: string) => { if (errEl) { errEl.textContent = text; errEl.hidden = false } }
  const clearFail = () => { if (errEl) errEl.hidden = true }

  /* ---------- boards: samples fetched, yours read from disk; both parsed in the worker ---------- */
  const loaded = new Map<string, Promise<BoardStats>>()
  const waiting = new Map<string, (s: BoardStats) => void>()
  const failing = new Map<string, (e: Error) => void>()
  const load = (id: string, text?: Promise<string>, name = id) => {
    let p = loaded.get(id)
    if (!p) {
      p = new Promise<BoardStats>((resolve, reject) => {
        waiting.set(id, resolve); failing.set(id, reject)
        void (text ?? fetch(`/boards/${id}.kicad_pcb`).then((r) => { if (!r.ok) throw new Error(`no board file for ${id}`); return r.text() }))
          .then((t) => { send({ type: 'load', id, text: t, name }) }, reject)
      })
      loaded.set(id, p)
      p.catch(() => { loaded.delete(id) })
    }
    return p
  }

  let req = 0
  let tl: Timeline | null = null
  /** announced once the next film is on the monitor */
  let ready: string | null = null
  const boardWaits = new Map<number, (b: unknown) => void>()
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data
    if (m.type === 'loaded') { waiting.get(m.id)?.(m.stats); waiting.delete(m.id) }
    else if (m.type === 'timeline') { if (m.req === req) takeTimeline(m.timeline) }
    else if (m.type === 'board') { boardWaits.get(m.req)?.(m.board); boardWaits.delete(m.req) }
    else if (m.req === undefined) { failing.get(m.id)?.(new Error(m.error)); failing.delete(m.id) }
    else if (m.req === req) {
      showBusy(false)
      fail(`The film could not be built from ${boardName()}. Try the other look, or another board.`)
    }
  }

  /* ---------- the busy veil ---------- */
  let busyTimer = 0
  const showBusy = (on: boolean, text = 'Building the film…') => {
    clearTimeout(busyTimer)
    if (!on) { if (busy) busy.hidden = true; stage.classList.remove('is-busy'); return }
    busyTimer = window.setTimeout(() => { if (busy) busy.hidden = false; if (busySay) busySay.textContent = text; stage.classList.add('is-busy') }, 140)
  }

  /* ---------- compile on every change, keeping the playhead's place in the film ---------- */
  let compileTimer = 0
  const recompile = (now = false) => {
    clearTimeout(compileTimer)
    const go = () => {
      const id = state.board
      showBusy(true, loaded.has(id) ? 'Building the film…' : isOwn() ? 'Reading your board…' : 'Loading the sample…')
      void load(id).then(() => {
        req += 1
        send({ type: 'compile', req, id, config: config(PREVIEW) })
      }, () => {
        showBusy(false)
        fail(`Could not load ${boardName()}. Check your connection and pick it again.`)
      })
    }
    if (now) go(); else compileTimer = window.setTimeout(go, 160)
  }

  /* ---------- playback ---------- */
  let frame = 0
  let playing = !reduced
  let drawn = -1
  let dirty = true
  const playBtn = root.querySelector<HTMLButtonElement>('[data-play]')
  const recBtn = root.querySelector<HTMLButtonElement>('[data-record]')
  const stillBtn = root.querySelector<HTMLButtonElement>('[data-still]')
  const tcEl = $('[data-tc]', root), durEl = $('[data-dur]', root)
  const track = $('[data-track]', root), fill = $('[data-fill]', root), head = $('[data-head]', root)
  const setPlaying = (on: boolean) => {
    playing = on
    playBtn?.setAttribute('aria-pressed', String(on))
    playBtn?.setAttribute('aria-label', on ? 'Pause' : 'Play')
  }
  setPlaying(playing)

  const takeTimeline = (next: Timeline) => {
    // held still (reduced motion), the monitor parks on the film's hold, where the board is lit, not on its first frame
    const p = tl ? frame / tl.totalFrames : reduced ? 0.96 : 0
    tl = next
    frame = Math.min(next.totalFrames - 1, p * next.totalFrames)
    monitor.style.setProperty('--ar', `${String(next.width)} / ${String(next.height)}`)
    monitor.style.setProperty('--arn', String(next.width / next.height))
    stage.style.setProperty('--film-bg', next.palette.bg)
    track?.setAttribute('aria-valuemax', String(next.totalFrames - 1))
    if (durEl) durEl.textContent = tc(next.durationSeconds)
    if (recBtn) recBtn.disabled = false
    if (stillBtn) stillBtn.disabled = false
    dirty = true
    showBusy(false)
    if (ready) { say(ready); ready = null }
  }

  const paintRead = (t: Timeline, f: number) => {
    const p = f / t.totalFrames
    if (tcEl) tcEl.textContent = tc(f / t.fps)
    // the gate's sprockets advance one hole for every two frames, as the film is held on twos
    monitor.style.setProperty('--roll', `${String(-(Math.floor(f / 2) % 1000) * 24)}px`)
    const pc = `${(p * 100).toFixed(3)}%`
    fill?.style.setProperty('width', pc)
    head?.style.setProperty('left', pc)
    track?.setAttribute('aria-valuenow', String(f))
    track?.setAttribute('aria-valuetext', tc(f / t.fps))
  }

  let onScreen = true
  new IntersectionObserver(([e]) => { onScreen = e?.isIntersecting ?? true }).observe(stage)
  gsap.ticker.add((_t, dms) => {
    if (!tl || !onScreen || document.hidden) return
    if (playing) { frame = (frame + (Math.min(dms, 100) / 1000) * tl.fps) % tl.totalFrames; dirty = true }
    const f = Math.floor(frame)
    if (!dirty && f === drawn) return
    dirty = false
    drawn = f
    preview.draw(tl, f)
    paintRead(tl, f)
  })

  /* the playhead: drag or click to scrub, keys to step */
  const seekAt = (x: number) => {
    if (!tl || !track) return
    const r = track.getBoundingClientRect()
    frame = Math.max(0, Math.min(tl.totalFrames - 1, ((x - r.left) / r.width) * tl.totalFrames))
    dirty = true
  }
  let wasPlaying = false
  track?.addEventListener('pointerdown', (e) => {
    wasPlaying = playing; setPlaying(false)
    track.setPointerCapture(e.pointerId); seekAt(e.clientX)
    track.classList.add('is-held')
  })
  track?.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) seekAt(e.clientX) })
  const letGo = () => { track?.classList.remove('is-held'); if (wasPlaying) setPlaying(true); wasPlaying = false }
  track?.addEventListener('pointerup', letGo)
  track?.addEventListener('pointercancel', letGo)
  const step = (d: number) => { if (!tl) return; setPlaying(false); frame = (Math.floor(frame) + d + tl.totalFrames) % tl.totalFrames; dirty = true }
  track?.addEventListener('keydown', (e) => {
    if (!tl) return
    if (e.key === 'Home') { e.preventDefault(); setPlaying(false); frame = 0; dirty = true }
    else if (e.key === 'End') { e.preventDefault(); setPlaying(false); frame = tl.totalFrames - 1; dirty = true }
    else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); step((e.key === 'PageUp' ? 1 : -1) * Math.round(tl.totalFrames / 24)) }
  })
  addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable]') && !(t instanceof HTMLInputElement && (t.type === 'radio' || t.type === 'range' || t.type === 'checkbox'))) return
    if (e.key === ' ' && !t.closest('button, a, label, summary')) { e.preventDefault(); setPlaying(!playing) }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (t === document.body || t === track)) { e.preventDefault(); step(e.key === 'ArrowRight' ? 1 : -1) }
  })
  playBtn?.addEventListener('click', () => { setPlaying(!playing) })

  /* ---------- source: nothing loaded yet shows the drop zone, then a slim bar ---------- */
  const film = $('[data-film]', root)
  const sampleSel = root.querySelector<HTMLSelectElement>('[data-sample]')
  const wide = matchMedia('(min-width: 961px)')
  let mode: 'empty' | 'ready' = sample ? 'ready' : 'empty'
  const paintSample = () => { if (sampleSel) sampleSel.value = mode === 'empty' ? '' : state.board }
  const setMode = (m: 'empty' | 'ready') => {
    mode = m
    root.dataset.mode = m
    if (film) film.inert = m === 'empty' && wide.matches
    paintSample()
  }
  wide.addEventListener('change', () => { setMode(mode) })

  const pickBoard = (id: string) => {
    clearFail()
    const same = id === state.board
    setMode('ready')
    if (same) return
    state.board = id
    state.hero = ''
    ready = `${boardName()} is ready.`
    paintControls(); paintParts(); recompile(true)
  }
  sampleSel?.addEventListener('change', () => { if (sampleSel.value) pickBoard(sampleSel.value) })

  const fileInput = root.querySelector<HTMLInputElement>('[data-file]')
  const takeFile = (file: File | undefined) => {
    if (!file) return
    if (!/\.kicad_pcb$/i.test(file.name)) { fail('That is not a .kicad_pcb file. Save the board from KiCad and drop that file.'); return }
    const id = `own-${String(Date.now())}`
    clearFail(); setMode('ready'); showBusy(true, 'Reading your board…'); say('Reading your board.')
    void load(id, file.text(), file.name.replace(/\.kicad_pcb$/i, '')).then((stats) => {
      own = { id, file: file.name, name: stats.name }
      sampleSel?.querySelector('[data-own]')?.remove()
      const opt = new Option(`${stats.name} (yours)`, id)
      opt.dataset.own = ''
      sampleSel?.options[0]?.after(opt)
      state.board = id
      state.hero = ''
      ready = `${stats.name} is ready.`
      paintControls(); paintParts(); recompile(true)
    }, (err: unknown) => {
      showBusy(false); setMode('empty')
      const detail = why(err)
      fail(detail || `Could not read ${file.name}.`)
    })
  }
  for (const b of root.querySelectorAll('[data-pick]')) b.addEventListener('click', () => { fileInput?.click() })
  fileInput?.addEventListener('change', () => { takeFile(fileInput.files?.[0]); fileInput.value = '' })
  addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('is-over') })
  addEventListener('dragleave', (e) => { if (e.relatedTarget === null) root.classList.remove('is-over') })
  addEventListener('drop', (e) => { e.preventDefault(); root.classList.remove('is-over'); takeFile(e.dataTransfer?.files[0]) })

  /* ---------- controls ---------- */
  const outs = [...root.querySelectorAll<HTMLOutputElement>('[data-out-for]')]
  const accentSay = $('[data-accent-v]', root)
  const accentReset = $('[data-accent-reset]', root)
  const liveNote = $('[data-live-note]', root)
  const paletteName = $('[data-palette-name]', root)
  const aspectUse = $('[data-aspect-use]', root)
  const titleIn = root.querySelector<HTMLInputElement>('[data-title]')
  /** the hero and mask pickers name this board's own parts and colour */
  const heroSel = root.querySelector<HTMLSelectElement>('[name="hero"]')
  const maskSel = root.querySelector<HTMLSelectElement>('[name="mask"]')
  const paintParts = () => {
    const id = state.board
    void load(id).then((stats) => {
      if (id !== state.board) return
      const label = (h: { ref: string; value: string }) => (h.value ? `${h.ref} · ${h.value}` : h.ref)
      const auto = stats.heroes.find((h) => h.ref === stats.autoHero)
      heroSel?.replaceChildren(
        new Option(`Automatic${auto ? ` (${label(auto)})` : ''}`, ''),
        ...stats.heroes.map((h) => new Option(label(h), h.ref))
      )
      if (heroSel) heroSel.value = stats.heroes.some((h) => h.ref === state.hero) ? state.hero : ''
      const first = maskSel?.options[0]
      if (first) first.text = `From the board file (${stats.mask ? stats.mask.toLowerCase() : 'none set, so green'})`
    }, () => undefined)
  }

  const paintControls = () => {
    for (const el of root.querySelectorAll<HTMLElement>('[data-only]')) el.hidden = el.dataset.only !== state.style
    for (const o of outs) o.textContent = `${state.tempo.toFixed(2)}×`
    if (accentSay) accentSay.textContent = state.useAccent ? state.accent : 'Default'
    if (accentReset) accentReset.hidden = !state.useAccent
    if (liveNote) {
      liveNote.hidden = state.style !== 'trace'
      liveNote.textContent = 'A draft preview. The full trace film, with its sound, renders on your machine.'
    }
    if (paletteName) paletteName.textContent = cap(state.palette)
    if (aspectUse) aspectUse.textContent = aspects.find((a) => a.id === state.aspect)?.use ?? ''
    if (titleIn) titleIn.placeholder = boardName()
    paintSample()
    // each flag wraps with its value, never between them; the board file wraps on its own
    cmdEl?.replaceChildren(...command().split(/ (?=--\w)|(?<=^npm run reel --) /).flatMap((part, i) => {
      const span = document.createElement('span')
      span.className = 'st__flag'
      span.textContent = part
      return i ? [' ', span] : [span]
    }))
    paintSetup()
    const u = new URL(location.href)
    u.search = ''
    const p = u.searchParams
    if (!isOwn()) p.set('board', state.board)
    p.set('style', state.style); p.set('aspect', state.aspect)
    if (state.style === 'glyph') p.set('palette', state.palette)
    if (state.useAccent) p.set('accent', state.accent)
    if (state.title) p.set('title', state.title)
    if (state.version) p.set('version', state.version)
    if (state.seed !== 42) p.set('seed', String(state.seed))
    if (state.tempo !== 1) p.set('tempo', String(state.tempo))
    if (state.format !== 'mp4') p.set('format', state.format)
    if (state.hero) p.set('hero', state.hero)
    if (state.mask) p.set('mask', state.mask)
    history.replaceState(history.state, '', u)
  }

  root.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement
    if (!t.name) return
    readForm()
    if (t.name === 'setup') return
    if (t.name === 'accent') state.useAccent = true
    paintControls()
    if (t.name !== 'format') recompile(t.type === 'radio')
  })
  root.addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).name === 'seed') { readForm(); paintControls(); recompile(true) }
  })
  $('[data-dice]', root)?.addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 99999)
    writeForm(); paintControls(); recompile(true)
  })
  accentReset?.addEventListener('click', () => {
    state.useAccent = false; state.accent = ACCENT
    writeForm(); paintControls(); recompile(true)
  })

  /* ---------- output: a take recorded here, a still, the command, a render on this machine ---------- */
  const download = (blob: Blob, name: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = name
    a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href) }, 4000)
  }
  const fileBase = () => `${boardName().replace(/[^\w.-]+/g, '-')}-${state.style}-${state.aspect.replace(':', 'x')}`

  stillBtn?.addEventListener('click', () => {
    if (!tl) return
    preview.draw(tl, Math.floor(frame))
    const name = `${fileBase()}.png`
    canvas.toBlob((b) => { if (b) { download(b, name); toast(`Saved ${name}.`) } }, 'image/png')
  })

  const copyBtn = root.querySelector<HTMLButtonElement>('[data-copy-cmd]')
  copyBtn?.addEventListener('click', () => {
    void navigator.clipboard.writeText(command()).then(() => {
      const label = copyBtn.querySelector<HTMLElement>('[data-roll]')
      if (label) { rollTo(label, 'Copied'); setTimeout(() => { rollTo(label, 'Copy command') }, 1600) }
      say('Command copied.')
    }, () => { toast('The clipboard is blocked. Select the command and copy it by hand.') })
  })

  const recLabel = $('[data-record-label]', root)
  let recording: MediaRecorder | null = null
  recBtn?.addEventListener('click', () => {
    if (!tl) return
    if (recording) { recording.stop(); return }
    if (typeof MediaRecorder === 'undefined' || !('captureStream' in canvas)) { toast('This browser cannot record the monitor. Copy the command and render in a terminal.'); return }
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
    const rec = new MediaRecorder(canvas.captureStream(30), { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 12_000_000 })
    const chunks: Blob[] = []
    const t = tl
    const name = `${fileBase()}.webm`
    const was = playing
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = () => {
      recording = null
      gsap.ticker.remove(watch)
      recBtn.style.removeProperty('--p')
      if (recLabel) recLabel.textContent = 'Record WebM'
      setPlaying(was)
      const blob = new Blob(chunks, { type: 'video/webm' })
      if (!blob.size) { toast('Nothing was recorded. Try again.'); return }
      download(blob, name)
      toast(`Saved ${name}, one loop.`)
    }
    let last = 0
    const watch = () => {
      const p = frame / t.totalFrames
      recBtn.style.setProperty('--p', p.toFixed(3))
      if (recLabel) recLabel.textContent = `Stop recording · ${String(Math.round(p * 100))}%`
      if (frame < last) rec.stop()
      last = frame
    }
    frame = 0; dirty = true; setPlaying(true)
    rec.start(250)
    recording = rec
    say('Recording one loop.')
    gsap.ticker.add(watch)
  })

  /* the render API runs on the visitor's own machine; Render appears only while it answers /health */
  const apiBase = (() => { try { return localStorage.getItem(API_KEY) } catch { return null } })()
  const apiURL = apiBase ?? 'http://127.0.0.1:3102'
  const renderBox = $('[data-render-box]', root)
  const setupBox = $('[data-setup]', root)
  const renderBtn = root.querySelector<HTMLButtonElement>('[data-render]')
  const jobsEl = $('[data-jobs]', root)
  let seen = false
  const ping = async () => {
    let on = false
    try { on = (await fetch(`${apiURL}/health`, { signal: AbortSignal.timeout(1500) })).ok } catch { on = false }
    if (renderBox) renderBox.hidden = !on
    if (setupBox) setupBox.hidden = on
    if (on && !seen) void pollQueue()
    seen = on
  }
  // a public visitor is never asked by the browser to reach their local network: the probe runs on a local site, or once a custom API address is set
  if (apiBase || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    void ping()
    addEventListener('focus', () => { void ping() })
  }

  const jobs = new Map<string, Job & { label: string }>()
  const fmtName = (id: string) => formats.find((f) => f.id === id)?.name.split(' ')[0] ?? id
  const paintJobs = () => {
    if (!jobsEl) return
    jobsEl.replaceChildren(...[...jobs.values()].reverse().map((j) => {
      const el = (tag: string, cls: string, text: string) => Object.assign(document.createElement(tag), { className: cls, textContent: text })
      const li = el('li', `st__job is-${j.status}`, '')
      li.style.setProperty('--p', String(j.progress / 100))
      li.append(el('span', 'st__job-n', j.label))
      if (j.status === 'done') {
        const a = el('a', 'st__job-dl', `Download ${fmtName(j.format)}`) as HTMLAnchorElement
        a.href = `${apiURL}/download/${encodeURIComponent(j.id)}`; a.download = ''
        li.append(a)
      } else if (j.status === 'pending' || j.status === 'rendering') {
        const x = el('button', 'st__job-x', 'Cancel')
        x.dataset.cancel = j.id
        const eta = j.etaSeconds != null ? ` · about ${String(j.etaSeconds)} s left` : ''
        li.append(x, el('span', 'st__job-p', j.status === 'pending' ? 'Queued' : `Rendering · ${String(Math.round(j.progress))}%${eta}`))
      } else li.append(el('span', 'st__job-p', j.status === 'error' ? 'Failed' : 'Cancelled'))
      if (j.error) li.append(el('span', 'st__job-e', j.error))
      li.append(el('i', 'st__job-bar', ''))
      return li
    }))
  }
  const pollQueue = async () => {
    try {
      const body = (await (await fetch(`${apiURL}/queue`)).json()) as { jobs: Job[] }
      for (const j of body.jobs) jobs.set(j.id, { ...j, label: jobs.get(j.id)?.label ?? `Job ${j.id.slice(0, 6)} · ${fmtName(j.format)}` })
      paintJobs()
      if ([...jobs.values()].some((j) => j.status === 'pending' || j.status === 'rendering')) setTimeout(() => { void pollQueue() }, 900)
    } catch { /* the next ping hides Render */ }
  }
  jobsEl?.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-cancel]')?.dataset.cancel
    if (id) void fetch(`${apiURL}/job/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then(() => pollQueue())
  })

  renderBtn?.addEventListener('click', () => {
    const id = state.board
    const label = `${boardName()} · ${state.style} · ${state.aspect} · ${fmtName(state.format)}`
    const body = isOwn()
      ? new Promise<unknown>((resolve) => { const r = Date.now(); boardWaits.set(r, resolve); send({ type: 'board', req: r, id }) }).then((board) => ({ boardJson: board }))
      : Promise.resolve({ demoId: id })
    const l = renderBtn.querySelector<HTMLElement>('[data-render-label]')
    if (l) rollTo(l, 'Queued')
    void body.then((src) => fetch(`${apiURL}/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...src as object, filmConfig: config(1, state.style), format: state.format })
    })).then(async (r) => {
      const res = (await r.json()) as { jobId?: string; status?: string; error?: string }
      if (!r.ok || !res.jobId) throw new Error(res.error ?? `The render did not start (${String(r.status)}).`)
      jobs.set(res.jobId, { id: res.jobId, status: res.status ?? 'pending', progress: 0, format: state.format, label })
      paintJobs()
      void pollQueue()
    }).catch((err: unknown) => { toast(why(err)) })
      .finally(() => { setTimeout(() => { if (l) rollTo(l, 'Render') }, 1200) })
  })

  /* ---------- go ---------- */
  writeForm()
  setMode(mode)
  paintControls()
  paintParts()
  recompile(true)
}
