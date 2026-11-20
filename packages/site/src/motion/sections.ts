import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { setupLooksStage } from '../cut/looks'

gsap.registerPlugin(ScrollTrigger)

const FPS = 30
const LAST = 359
const ACTS = [
  { name: 'Copper', a: 0, b: 75 },
  { name: 'Mask', a: 75, b: 105 },
  { name: 'Silk', a: 105, b: 112 },
  { name: 'Place', a: 112, b: 180 },
  { name: 'Power', a: 180, b: 299 },
  { name: 'Hold', a: 299, b: LAST }
]
const CELL = 100
const CAPTIONS = ['Copper routes from your board file.', 'Solder mask reveals the copper.', 'Your silkscreen, in place.', 'Components settle onto their pads.', 'The board comes to life.', 'A final frame worth sharing.']
const NONE = { name: '', a: 0, b: 1 }

const toFrame = (pos: number) => {
  const i = Math.min(ACTS.length - 1, Math.floor(pos / CELL))
  const act = ACTS[i] ?? NONE
  return { i, frame: Math.round(act.a + ((pos - i * CELL) / CELL) * (act.b - act.a)) }
}
const toPos = (frame: number) => {
  const i = Math.max(0, ACTS.findIndex((a) => frame < a.b || a.b === LAST))
  const act = ACTS[i] ?? NONE
  return i * CELL + (Math.min(frame, act.b) - act.a) / (act.b - act.a) * CELL
}

export function setupFrames(root: HTMLElement, reduced: boolean) {
  const video = root.querySelector<HTMLVideoElement>('[data-frames-film]')
  const range = root.querySelector<HTMLInputElement>('[data-frames-range]')
  const film = root.querySelector<HTMLElement>('.strip__film')
  const labels = [...root.querySelectorAll<HTMLElement>('[data-act]')]
  if (!video || !range || !film) return

  const caption = root.querySelector<HTMLElement>('[data-frame-caption]')
  let act = -1
  const paint = (pos: number, frame: number) => {
    film.style.setProperty('--p', String(pos / (CELL * ACTS.length)))
    const i = Math.min(ACTS.length - 1, Math.floor(pos / CELL))
    range.setAttribute('aria-valuetext', `${ACTS[i]?.name ?? ''}, frame ${frame + 1} of ${LAST + 1}`)
    if (i === act) return
    act = i
    if (caption) caption.textContent = CAPTIONS[i] ?? ''
    labels.forEach((l, k) => { l.toggleAttribute('data-on', k === i) })
  }

  let want = -1
  const seek = (frame: number) => {
    want = frame
    if (video.readyState < 1 || video.seeking) return
    video.currentTime = (frame + 0.5) / FPS
    want = -1
  }
  video.addEventListener('seeked', () => { if (want >= 0) seek(want) })
  video.addEventListener('loadedmetadata', () => { if (want >= 0) seek(want) })

  const load = () => { if (video.preload !== 'auto') { video.preload = 'auto'; video.load() } }
  const take = () => {
    video.pause()
    load()
    const pos = Number(range.value)
    const { frame } = toFrame(pos)
    paint(pos, frame)
    seek(frame)
  }
  range.addEventListener('input', take)
  range.addEventListener('pointerdown', () => { video.pause() })

  const rest = toPos(270)
  range.value = String(rest)
  paint(rest, 270)
  seek(270)

  new IntersectionObserver(([e], io) => { if (e?.isIntersecting) { load(); io.disconnect() } }, { rootMargin: '0px 0px 50% 0px' }).observe(root)
  if (reduced) return
  root.classList.add('frames--scroll')
  const lede = root.querySelector<HTMLElement>('.frames__lede')
  if (lede) lede.textContent = 'Your scroll builds the film.'
  const render = (progress: number) => {
    const pos = Math.min(1, Math.max(0, (progress - 0.04) / 0.88)) * CELL * ACTS.length
    const { frame } = toFrame(pos)
    range.value = String(pos)
    paint(pos, frame)
    seek(frame)
  }
  ScrollTrigger.create({
    trigger: root,
    start: 'top top',
    end: 'bottom bottom',
    invalidateOnRefresh: true,
    onUpdate: self => { render(self.progress) },
    onRefresh: self => { render(self.progress) }
  })
  render(0)

}

export function setupLooks(root: HTMLElement, reduced: boolean) {
  const picks = [...root.querySelectorAll<HTMLButtonElement>('[data-look-pick]')]
  const choose = (look: string) => {
    root.dataset.look = look
    picks.forEach((o) => { o.setAttribute('aria-pressed', String(o.dataset.lookPick === look)) })
    root.dispatchEvent(new CustomEvent('lookchange', { detail: look, bubbles: true }))
    stage?.select(look)
  }
  const stage = setupLooksStage(root, reduced, choose)
  picks.forEach((b) => {
    b.addEventListener('click', () => { choose(b.dataset.lookPick ?? 'trace') })
    b.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') stage?.peek(b.dataset.lookPick ?? null) })
    b.addEventListener('pointerleave', () => { stage?.peek(null) })
    b.addEventListener('focus', () => { if (b.matches(':focus-visible')) stage?.peek(b.dataset.lookPick ?? null) })
    b.addEventListener('blur', () => { stage?.peek(null) })
  })
}

export function setupLanding(reduced: boolean) {
  if (reduced) return
  const looks = document.querySelector<HTMLElement>('[data-looks]')
  const make = document.querySelector<HTMLElement>('#make')
  if (looks) {
    gsap.matchMedia().add('(min-width: 901px)', () => {
      gsap.from('.looks__arrival--plot', { x: 110, y: 60, opacity: 0, ease: 'none', scrollTrigger: { trigger: looks, start: 'top 85%', end: 'top 15%', scrub: true } })
      gsap.from('.looks__arrival--glyph', { y: 90, opacity: 0, ease: 'none', scrollTrigger: { trigger: looks, start: 'top 85%', end: 'top 15%', scrub: true } })
      gsap.from('.looks__arrival--montage', { x: -110, y: 60, opacity: 0, ease: 'none', scrollTrigger: { trigger: looks, start: 'top 85%', end: 'top 15%', scrub: true } })
      gsap.from('.looks__arrival--trace', { y: 60, ease: 'none', scrollTrigger: { trigger: looks, start: 'top 85%', end: 'top 15%', scrub: true } })
    })
  }
  if (make) gsap.from('.make__run', { y: 48, opacity: 0.35, ease: 'none', scrollTrigger: { trigger: make, start: 'top 85%', end: 'top 15%', scrub: true } })
  void document.fonts.ready.then(() => { ScrollTrigger.refresh() })
}
