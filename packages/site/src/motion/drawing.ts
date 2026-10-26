import { prefersReducedMotion } from '../engine/env'
import type { Board } from '../blueprint/draw'

type Rect = [number, number, number, number]

// plot order on the sheet: [group, start s, span s]; a group's strokes start one after another across its span
const PLOT: [string, number, number][] = [
  ['frame', 0, 0.7], ['outline', 0.35, 0.9], ['parts', 0.8, 1.5], ['copper', 1.3, 1.4], ['dims', 2.1, 1],
  ['elevation', 2.3, 1], ['numerals', 2.7, 0.8], ['cut', 3, 0.4], ['section', 3.1, 0.9], ['detail', 3.4, 0.8], ['blocks', 2.9, 1.4]
]
const STROKE = 0.45
// each camera stop holds for the first part of its stretch, then travels to the next
const HOLD = 0.32
// after the last stop the drawing hands over to the film: the scroll beyond the camera's stops, in stop units
const FILM = 0.8
// where the board's plan sits in the glyph film's frame during its plan act, as fractions of the frame (measured on glasgow-16x9.json)
const IN_FRAME = { x: 0.209, y: 0.186, w: 0.582 }
// the header's height: the pin sits under it
const TOP = 72

const clamp = (v: number) => Math.min(1, Math.max(0, v))
const lerp = (p: number, q: number, t: number) => p + (q - p) * t

/** the drawing sheet: plotted in when it arrives, a camera that travels it on scroll, and a section cut that follows the pointer */
export function setupDrawing() {
  const root = document.querySelector<HTMLElement>('[data-dwg]')
  if (!root) return
  const near = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return
    near.disconnect()
    void Promise.all([import('../blueprint/draw'), import('../blueprint/glasgow.json')]).then(([D, data]) => { mount(root, D, data.default as Board) })
  }, { rootMargin: '120% 0px' })
  near.observe(root)
}

function plot(svg: SVGSVGElement): { end: number; anims: Animation[] } {
  const anims: Animation[] = []
  const timing = (at: number, d: number): KeyframeAnimationOptions => ({ delay: at * 1000, duration: d * 1000, easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'backwards' })
  for (const [group, start, span] of PLOT) {
    const els = [...svg.querySelectorAll<SVGElement>(`[data-plot="${group}"] :is(path, rect, circle, ellipse)`)]
    els.forEach((el, i) => {
      const at = start + (span * i) / Math.max(1, els.length)
      if (!el.hasAttribute('pathLength')) { anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], timing(at, 0.4))); return }
      el.style.strokeDasharray = '1'
      const a = el.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], timing(at, STROKE))
      anims.push(a)
      void a.finished.then(() => el.style.removeProperty('stroke-dasharray'))
    })
  }
  return { end: Math.max(...PLOT.map(([, s, d]) => s + d)) + STROKE, anims }
}

function mount(root: HTMLElement, D: typeof import('../blueprint/draw'), b: Board) {
  const reduced = prefersReducedMotion()
  const section = root.closest<HTMLElement>('.dwg')
  root.innerHTML = D.sheet(b)
  const svg = root.querySelector<SVGSVGElement>('svg')
  const cutG = svg?.querySelector<SVGGElement>('[data-cut]')
  const secG = svg?.querySelector<SVGGElement>('[data-section]')
  if (!section || !svg || !cutG || !secG) return
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  const L = D.layout(b)
  const V = D.views(b)
  const { bb } = L.plan
  // the camera's stops, in scroll order. A portrait phone cannot read the whole sheet, so it opens on the plan and closes in on the hero
  const hx = L.plan.x + (L.hero.x - bb.x0) * L.plan.s
  const hy = L.plan.y + (L.hero.y - bb.y0) * L.plan.s
  const portrait = innerWidth < 760 && innerWidth < innerHeight
  const stops: Rect[] = portrait ? [V.plan, [hx - 60, hy - 60, 120, 120], V.section, V.detail, V.title, V.plan] : [V.sheet, V.plan, V.section, V.detail, V.title, V.plan]
  const film = document.querySelector<HTMLCanvasElement>('[data-look-film]')

  // plotted once, the first time the sheet is on screen
  let idle = false
  let plotted = reduced
  let plotting: { end: number; anims: Animation[] } | null = null
  if (!reduced) svg.style.visibility = 'hidden'

  // the cut, in board mm
  let cy = L.hero.y
  let cx = L.hero.x
  let shown = { cy: NaN, cx: NaN }
  const drawCut = () => {
    if (Math.abs(shown.cy - cy) < 0.01 && Math.abs(shown.cx - cx) < 0.01) return
    shown = { cy, cx }
    cutG.innerHTML = D.planCut(b, L, cy, cx)
    secG.innerHTML = D.section(b, L, cy, cx)
  }
  const toBoard = (e: PointerEvent) => {
    const m = svg.getScreenCTM()
    if (!m) return null
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return { x: bb.x0 + (p.x - L.plan.x) / L.plan.s, y: bb.y0 + (p.y - L.plan.y) / L.plan.s }
  }
  const inside = (p: { x: number; y: number }) => p.x > bb.x0 - 2 && p.x < bb.x1 + 2 && p.y > bb.y0 && p.y < bb.y1
  svg.addEventListener('pointermove', (e) => {
    const p = toBoard(e)
    const on = !!p && inside(p)
    svg.classList.toggle('is-cutting', on)
    if (!p || !on) return
    idle = false
    lastInput = performance.now()
    cy = p.y
    cx = Math.min(Math.max(p.x, bb.x0 + 5), bb.x1 - 5)
  })
  svg.addEventListener('pointerleave', () => { svg.classList.remove('is-cutting') })
  root.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 2 : 0.4
    const k: Record<string, [number, number]> = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }
    const d = k[e.key]
    if (!d) return
    e.preventDefault()
    idle = false
    lastInput = performance.now()
    cy = Math.min(Math.max(cy + d[1], bb.y0 + 0.2), bb.y1 - 0.2)
    cx = Math.min(Math.max(cx + d[0], bb.x0 + 5), bb.x1 - 5)
  })

  // idle: the plane sweeps a band either side of the hero, where the board is densest
  const PERIOD = 16000
  const reach = Math.min(9, (bb.y1 - bb.y0) / 2 - 1)
  const phaseOf = (y: number) => (Math.asin(Math.min(1, Math.max(-1, (y - L.hero.y) / reach))) / (2 * Math.PI)) * PERIOD
  let t0 = performance.now() - phaseOf(cy)
  // the sweep takes over again a few seconds after the last pointer or key input
  let lastInput = -Infinity

  // the camera: scroll through the section moves the viewBox from stop to stop, zooming in log space
  // under reduced motion the camera cuts between stops instead of travelling
  const ease = (t: number) => (reduced ? (t < 0.5 ? 0 : 1) : t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
  const view = (u: number): Rect => {
    const i = Math.min(stops.length - 2, Math.floor(u))
    const t = ease(clamp((u - i - HOLD) / (1 - HOLD)))
    const a = stops[i] ?? V.sheet
    const c = stops[i + 1] ?? a
    const w = Math.exp(lerp(Math.log(a[2]), Math.log(c[2]), t))
    const h = Math.exp(lerp(Math.log(a[3]), Math.log(c[3]), t))
    const mx = lerp(a[0] + a[2] / 2, c[0] + c[2] / 2, t)
    const my = lerp(a[1] + a[3] / 2, c[1] + c[3] / 2, t)
    return [mx - w / 2, my - h / 2, w, h]
  }
  let lastView = ''
  // the film is the glyph look's own canvas. It lies over the plan, its plan act placed onto the drawn outline,
  // opens out to a centred frame once the drawing has faded, then zooms out into its frame in the looks below
  const slot = film?.parentElement
  const ground = (video: HTMLElement) => {
    video.classList.remove('is-flying')
    for (const k of ['transform', 'opacity', '--fe']) video.style.removeProperty(k)
  }
  const place = (video: HTMLElement, frame: HTMLElement, handover: number, r: DOMRect) => {
    // the landing starts as the pin lets go and ends with the frame settled on screen
    const s = frame.getBoundingClientRect()
    const settle = Math.max(TOP + 40, innerHeight - s.height - 160)
    const land = clamp((innerHeight - r.bottom) / Math.max(1, innerHeight + s.top - r.bottom - settle))
    section.style.setProperty('--land', land.toFixed(3))
    const m = svg.getScreenCTM()
    if (handover === 0 || land === 1 || !m) { ground(video); return }
    const a = new DOMPoint(L.plan.x, L.plan.y).matrixTransform(m)
    const c = new DOMPoint(L.plan.x + (bb.x1 - bb.x0) * L.plan.s, L.plan.y).matrixTransform(m)
    const k0 = (c.x - a.x) / IN_FRAME.w / 1280
    const x0 = a.x - IN_FRAME.x * 1280 * k0
    const y0 = a.y - IN_FRAME.y * 720 * k0
    const h = innerHeight - TOP
    const k1 = Math.min(innerWidth / 1280, (h * 0.86) / 720) * 1.08
    const x1 = (innerWidth - 1280 * k1) / 2
    const y1 = TOP + (h * 0.88 - 720 * k1) / 2
    const t = ease(clamp((handover - 0.35) / 0.65))
    const l = ease(land)
    const x = lerp(lerp(x0, x1, t), s.left, l)
    const y = lerp(lerp(y0, y1, t), s.top, l)
    const k = lerp(lerp(k0, k1, t), s.width / 1280, l)
    video.classList.add('is-flying')
    video.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${k.toFixed(4)})`
    video.style.opacity = handover.toFixed(3)
    video.style.setProperty('--fe', (1 - l).toFixed(3))
  }
  // the looks section owns the film's player: it starts the plan act when the hand-off begins and rewinds it when the reader scrolls back
  let rolling = false
  const roll = (canvas: HTMLCanvasElement, handover: number) => {
    const on = handover > 0.02 || (rolling && handover > 0)
    if (on === rolling) return
    rolling = on
    canvas.dispatchEvent(new CustomEvent('handover', { detail: on }))
  }
  // the tick runs while the drawing or the film's frame is on screen
  const seen = new Set<Element>()
  const io = new IntersectionObserver((entries) => { for (const e of entries) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target) } })
  io.observe(section)
  if (slot) io.observe(slot)
  const tick = (now: number) => {
    if (seen.size > 0) {
      const r = section.getBoundingClientRect()
      const u = clamp(-r.top / Math.max(1, r.height - innerHeight)) * (stops.length - 1 + FILM)
      const v = view(Math.min(u, stops.length - 1)).map((n) => n.toFixed(2)).join(' ')
      if (v !== lastView) { svg.setAttribute('viewBox', v); lastView = v }
      const handover = clamp((u - (stops.length - 1)) / (FILM * 0.7))
      if (!reduced) section.style.setProperty('--film', handover.toFixed(3))
      if (film && slot && !reduced) {
        place(film, slot, handover, r)
        if (u > stops.length - 2) roll(film, handover)
      }
      if (!plotted && r.top < innerHeight * 0.75) {
        plotted = true
        svg.style.removeProperty('visibility')
        plotting = plot(svg)
        lastInput = performance.now() + plotting.end * 1000 - 3000
      }
      // a fast scroller never sees a half-drawn sheet: the plot is complete before the camera leaves the first view
      if (plotting) {
        const due = plotting.end * 1000 * clamp(u / (HOLD * 0.8))
        let done = true
        for (const a of plotting.anims) {
          const t = Number(a.currentTime ?? 0)
          if (t < due) a.currentTime = due
          if (a.playState !== 'finished') done = false
        }
        if (done) plotting = null
      }
      if (plotted && !reduced && !idle && now - lastInput > 3000) { idle = true; t0 = now - phaseOf(cy) }
      if (idle) {
        const a = ((now - t0) / PERIOD) * 2 * Math.PI
        cy = Math.min(bb.y1 - 1, Math.max(bb.y0 + 1, L.hero.y + reach * Math.sin(a)))
        cx = Math.min(bb.x1 - 5, Math.max(bb.x0 + 5, L.hero.x + 9 * Math.sin(a * 0.37)))
      }
      drawCut()
    } else if (film?.classList.contains('is-flying')) ground(film)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
