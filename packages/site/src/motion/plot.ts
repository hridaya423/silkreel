import { gsap } from 'gsap'

const NS = 'http://www.w3.org/2000/svg'
const SPEED = 95
const TRAVEL = 2.6

interface Stroke { el: SVGPathElement; pts: number[]; len: number; from: number; to: number }

const along = (pts: number[], d: number): [number, number] => {
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const l = Math.hypot((pts[i + 2] ?? 0) - (pts[i] ?? 0), (pts[i + 3] ?? 0) - (pts[i + 1] ?? 0))
    if (d <= l || i + 5 >= pts.length) { const t = l ? Math.min(1, d / l) : 0; return [(pts[i] ?? 0) + ((pts[i + 2] ?? 0) - (pts[i] ?? 0)) * t, (pts[i + 1] ?? 0) + ((pts[i + 3] ?? 0) - (pts[i + 1] ?? 0)) * t] }
    d -= l
  }
  return [pts[0] ?? 0, pts[1] ?? 0]
}

/** a heading's stroke lettering drawn by one pen, stroke by stroke, the pen lifting and travelling between them */
export function plot(lt: HTMLElement): void {
  const svg = lt.querySelector('svg')
  if (!svg || lt.dataset.plotted !== undefined || lt.dataset.plotting !== undefined) return
  const lines = [...svg.querySelectorAll<SVGPathElement>('path.t')]
  const layer = document.createElementNS(NS, 'g')
  const strokes: Stroke[] = []
  let clock = 0
  let pen: [number, number] | null = null
  for (const line of lines) {
    for (const part of (line.getAttribute('d') ?? '').split('M').filter(Boolean)) {
      const pts = part.split(/[L ]/).map(Number)
      let len = 0
      for (let i = 0; i + 3 < pts.length; i += 2) len += Math.hypot((pts[i + 2] ?? 0) - (pts[i] ?? 0), (pts[i + 3] ?? 0) - (pts[i + 1] ?? 0))
      const el = document.createElementNS(NS, 'path')
      el.setAttribute('d', `M${part}`)
      el.setAttribute('stroke-width', line.getAttribute('stroke-width') ?? '0.08')
      el.setAttribute('stroke-dasharray', `${String(len + 0.01)} ${String(len + 1)}`)
      el.style.visibility = 'hidden'
      if (line.closest('.lt--accent')) el.style.color = 'var(--c-red)'
      layer.append(el)
      if (pen) clock += Math.hypot((pts[0] ?? 0) - pen[0], (pts[1] ?? 0) - pen[1]) / TRAVEL
      strokes.push({ el, pts, len, from: clock, to: clock + Math.max(len, 0.02) })
      clock += Math.max(len, 0.02)
      pen = [pts.at(-2) ?? 0, pts.at(-1) ?? 0]
    }
  }
  if (!strokes.length) { lt.dataset.plotted = ''; return }
  const head = document.createElementNS(NS, 'circle')
  head.setAttribute('r', '0.05')
  head.setAttribute('class', 'lt__pen')
  layer.append(head)
  svg.append(layer)
  lt.dataset.plotting = ''
  const state = { d: 0 }
  let i = 0
  gsap.to(state, {
    d: clock,
    duration: Math.min(1.35, Math.max(0.45, clock / SPEED)),
    ease: 'power1.out',
    onUpdate: () => {
      while (i < strokes.length - 1 && state.d >= (strokes[i]?.to ?? 0)) { const s = strokes[i]; if (s) { s.el.style.visibility = 'visible'; s.el.removeAttribute('stroke-dasharray') } i++ }
      const s = strokes[i]
      if (!s) return
      const prev = strokes[i - 1]
      if (state.d < s.from) {
        const a = prev ? [prev.pts.at(-2) ?? 0, prev.pts.at(-1) ?? 0] : [s.pts[0] ?? 0, s.pts[1] ?? 0]
        const t = prev ? (state.d - prev.to) / Math.max(1e-6, s.from - prev.to) : 1
        head.setAttribute('cx', String((a[0] ?? 0) + ((s.pts[0] ?? 0) - (a[0] ?? 0)) * t))
        head.setAttribute('cy', String((a[1] ?? 0) + ((s.pts[1] ?? 0) - (a[1] ?? 0)) * t))
        return
      }
      const drawn = Math.min(s.len, state.d - s.from)
      s.el.style.visibility = 'visible'
      s.el.setAttribute('stroke-dashoffset', String(s.len - drawn))
      s.el.setAttribute('stroke-dasharray', `${String(s.len + 0.01)} ${String(s.len + 1)}`)
      const [x, y] = along(s.pts, drawn)
      head.setAttribute('cx', String(x))
      head.setAttribute('cy', String(y))
    },
    onComplete: () => {
      delete lt.dataset.plotting
      lt.dataset.plotted = ''
      gsap.to(head, { attr: { r: 0 }, duration: 0.32, ease: 'power2.in', onComplete: () => { layer.remove() } })
      for (const s of strokes) s.el.remove()
    }
  })
}

/** every heading plots once, as it comes into view */
export function plotHeadings(): void {
  const root = document.documentElement
  const late = root.classList.contains('plot-off')
  root.dataset.plot = ''
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      io.unobserve(e.target)
      plot(e.target as HTMLElement)
    }
  }, { threshold: 0.4 })
  document.querySelectorAll<HTMLElement>(':is(h1, h2):not([data-plot-hold]) .lt').forEach((lt) => {
    if (late && lt.getBoundingClientRect().top < innerHeight) lt.dataset.plotted = ''
    else io.observe(lt)
  })
  root.classList.remove('plot-off')
}
