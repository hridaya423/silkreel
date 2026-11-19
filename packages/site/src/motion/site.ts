import { gsap } from 'gsap'
import { DECODE_IN } from '@silk-reel/choreo'
import { initScroll, onScroll } from '../engine/scroll'
import { prefersReducedMotion } from '../engine/env'
import { plotHeadings } from './plot'

const STEP = 1 / 15

/** the header mark decodes on twos, unit by unit, the same way the film's glyphs do */
function decodeMark() {
  const units = [...document.querySelectorAll<SVGElement>('.hd__mark [data-unit], .hd__mark [data-ring]')]
  if (prefersReducedMotion()) return
  const tl = gsap.timeline({ delay: 0.15 })
  units.forEach((u, i) => {
    const steps = DECODE_IN[i % DECODE_IN.length] ?? [1]
    const at = ((i * 3) % 8) * STEP
    tl.set(u, { opacity: 0 }, 0)
    steps.forEach((a, k) => { tl.set(u, { opacity: a }, at + k * STEP) })
  })
}

/** a label rolls up one line under the pointer, like the strip advancing a frame; the copy below it is for the eye only */
function roll(el: HTMLElement, text?: string) {
  const label = text ?? el.querySelector('.roll__a')?.textContent ?? el.textContent
  const a = document.createElement('span')
  const b = document.createElement('span')
  a.className = 'roll__a'
  b.className = 'roll__b'
  a.textContent = label
  b.textContent = label
  b.setAttribute('aria-hidden', 'true')
  el.classList.add('roll')
  el.replaceChildren(a, b)
}

/** a new value arrives the same way: the next frame pulls up into the window */
export function rollTo(el: HTMLElement, text: string) {
  const a = el.querySelector<HTMLElement>('.roll__a')
  const b = el.querySelector<HTMLElement>('.roll__b')
  if (!a || !b || prefersReducedMotion()) { roll(el, text); return }
  if (a.textContent === text) return
  b.textContent = text
  el.classList.add('is-pulling')
  window.setTimeout(() => {
    el.classList.add('is-set')
    roll(el, text)
    el.classList.remove('is-pulling')
    requestAnimationFrame(() => { el.classList.remove('is-set') })
  }, 380)
}

/** on the home page the nav marks the section in view */
function navState() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-nav]')].filter((a) => a.dataset.nav === 'film')
  const sections = links.map((a) => document.getElementById(a.dataset.nav ?? '')).filter((s): s is HTMLElement => s !== null)
  if (!sections.length) return
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      links.forEach((a) => {
        if (a.dataset.nav === e.target.id) a.setAttribute('aria-current', 'location')
        else a.removeAttribute('aria-current')
      })
    }
  }, { rootMargin: '-45% 0px -50% 0px' })
  sections.forEach((s) => { io.observe(s) })
  // above the first chapter and past the last, no chapter link is current
  const clear = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) links.forEach((a) => { a.removeAttribute('aria-current') })
  }, { rootMargin: '-45% 0px -50% 0px' })
  const footer = document.querySelector('footer')
  if (footer) clear.observe(footer)
}

function copyButtons(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => {
    const label = b.querySelector<HTMLElement>('[data-copy-label]')
    b.addEventListener('click', () => {
      const was = label?.querySelector('.roll__a')?.textContent ?? label?.textContent ?? ''
      navigator.clipboard.writeText(b.dataset.copy ?? '').then(() => {
        if (label) rollTo(label, 'Copied')
        setTimeout(() => { if (label) rollTo(label, was) }, 1600)
      }, () => { /* the command stays selectable in the page */ })
    })
  })
}

export function boot() {
  initScroll()
  const pos = [...document.querySelectorAll<HTMLElement>('.pos')]
  onScroll((s) => {
    const html = document.documentElement
    html.classList.toggle('scrolled', s.y > 24)
    // the header turns dark only over stock that spans the page under its midline
    html.classList.toggle('hd-pos', pos.some((el) => { const r = el.getBoundingClientRect(); return r.top <= 34 && r.bottom >= 34 && r.width >= innerWidth * 0.9 }))
  })
  decodeMark()
  if (!prefersReducedMotion()) plotHeadings()
  document.querySelectorAll<HTMLElement>('[data-roll]').forEach((el) => { roll(el) })
  navState()
  copyButtons()
}
