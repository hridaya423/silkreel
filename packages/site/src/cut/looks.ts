import { LooksGL } from './looks-gl'

type Seams = [number, number, number]
const LOOKS = ['plot', 'glyph', 'trace', 'montage'] as const
const WIDE: Seams[] = [[0.58, 0.72, 0.86], [0.14, 0.72, 0.86], [0.14, 0.28, 0.86], [0.14, 0.28, 0.42]]
const REST: Seams[] = [[0.34, 0.56, 0.78], [0.22, 0.56, 0.78], [0.22, 0.44, 0.78], [0.22, 0.44, 0.66]]

const seams = (p: number): Seams => {
  const x = Math.min(1, Math.max(0, p)) * (LOOKS.length - 1)
  const k = Math.min(LOOKS.length - 2, Math.floor(x))
  const a = WIDE[k] as Seams
  const b = WIDE[k + 1] as Seams
  const t = x - k
  return a.map((v, i) => v + ((b[i] as number) - v) * t) as Seams
}

export interface LooksStage {
  select(look: string): void
  /** widens a look's band while its selector is pointed at or focused; null lets it settle */
  peek(look: string | null): void
}

/** the four looks as bands of one board: the band under the pointer widens, a click keeps it */
export function setupLooksStage(root: HTMLElement, reduced: boolean, choose: (look: string) => void): LooksStage | undefined {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-looks-gl]')
  const frame = root.querySelector<HTMLElement>('[data-looks-frame]')
  if (!canvas || !frame) return
  const gl = LooksGL.create(canvas)
  if (!gl) return
  let look = Math.max(0, LOOKS.indexOf((root.dataset.look ?? 'trace') as (typeof LOOKS)[number]))
  const rest = (): Seams => [...(REST[look] as Seams)]
  let target = rest()
  const s = rest()
  const v: Seams = [0, 0, 0]
  let hover = false
  let ready = false
  let awake = false
  let prev = 0
  let dpr = 1
  const size = () => {
    dpr = Math.min(2, devicePixelRatio || 1)
    canvas.width = Math.round(canvas.clientWidth * dpr)
    canvas.height = Math.round(canvas.clientHeight * dpr)
  }
  const paint = () => {
    const c = canvas.getBoundingClientRect()
    const f = frame.getBoundingClientRect()
    gl.draw({ x: (f.left - c.left) * dpr, y: (f.top - c.top) * dpr, w: f.width * dpr, h: f.height * dpr }, f.width < 520 ? 32 : 48, s, dpr)
  }
  const tick = (now: number) => {
    const dt = Math.min(0.032, (now - prev) / 1000)
    prev = now
    let moving = false
    for (const i of [0, 1, 2] as const) {
      if (reduced) { s[i] = target[i]; continue }
      v[i] = (v[i] + (target[i] - s[i]) * 95 * dt) * Math.exp(-15 * dt)
      s[i] += v[i] * dt
      if (Math.abs(v[i]) > 0.0015 || Math.abs(target[i] - s[i]) > 0.0008) moving = true
    }
    paint()
    awake = moving
    if (moving) requestAnimationFrame(tick)
  }
  const wake = () => {
    if (awake || !ready) return
    awake = true
    prev = performance.now()
    requestAnimationFrame(tick)
  }
  const aim = (next: Seams) => { target = next; wake() }

  const at = (e: PointerEvent) => { const r = frame.getBoundingClientRect(); return (e.clientX - r.left) / r.width }
  frame.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; hover = true; overture = false; aim(seams(at(e))) })
  frame.addEventListener('pointerleave', () => { hover = false; aim(rest()) })
  frame.addEventListener('click', (e) => { const p = at(e); choose(LOOKS[s.filter((x) => p >= x).length] ?? 'trace') })

  let overture = !reduced
  const play = () => {
    if (!overture || !ready) return
    aim(seams(0))
    window.setTimeout(() => { if (overture) aim(seams(1)) }, 820)
    window.setTimeout(() => { if (overture) { overture = false; aim(rest()) } }, 1600)
  }
  let seen = false
  new IntersectionObserver(([e], io) => { if (e?.isIntersecting) { seen = true; io.disconnect(); play() } }, { threshold: 0.55 }).observe(frame)

  new IntersectionObserver(([e], io) => {
    if (!e?.isIntersecting) return
    io.disconnect()
    const big = canvas.clientWidth * Math.min(2, devicePixelRatio || 1) > 1700
    let left = LOOKS.length
    LOOKS.forEach((id, i) => {
      const img = new Image()
      img.onload = () => {
        gl.upload(i, img)
        if (--left) return
        ready = true
        size()
        root.classList.add('looks--live')
        wake()
        if (seen) play()
      }
      img.src = `/films/looks/glasgow-${id}${big ? '' : '-1x'}.webp`
    })
  }, { rootMargin: '100% 0px' }).observe(root)
  new ResizeObserver(() => { size(); if (ready && !awake) paint() }).observe(canvas)

  return {
    select(next) { look = Math.max(0, LOOKS.indexOf(next as (typeof LOOKS)[number])); if (!hover) aim(rest()) },
    peek(next) {
      const wide = next === null ? undefined : WIDE[LOOKS.indexOf(next as (typeof LOOKS)[number])]
      hover = !!wide
      if (wide) overture = false
      aim(wide ? [...wide] : rest())
    }
  }
}
