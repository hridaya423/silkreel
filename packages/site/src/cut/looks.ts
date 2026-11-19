import { LooksGL } from './looks-gl'

const LOOKS = ['plot', 'glyph', 'trace'] as const
const WIDE: Array<[number, number]> = [[0.62, 0.82], [0.16, 0.84], [0.14, 0.3]]
const REST: Array<[number, number]> = [[0.38, 0.7], [0.27, 0.7], [0.27, 0.6]]

const seams = (p: number): [number, number] => {
  const x = Math.min(1, Math.max(0, p)) * 2
  const a = WIDE[x < 1 ? 0 : 1] as [number, number]
  const b = WIDE[x < 1 ? 1 : 2] as [number, number]
  const t = x < 1 ? x : x - 1
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

export interface LooksStage {
  select(look: string): void
  /** widens a look's band while its selector is pointed at or focused; null lets it settle */
  peek(look: string | null): void
}

/** the three looks as bands of one board: the band under the pointer widens, a click keeps it */
export function setupLooksStage(root: HTMLElement, reduced: boolean, choose: (look: string) => void): LooksStage | undefined {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-looks-gl]')
  const frame = root.querySelector<HTMLElement>('[data-looks-frame]')
  if (!canvas || !frame) return
  const gl = LooksGL.create(canvas)
  if (!gl) return
  let look = Math.max(0, LOOKS.indexOf((root.dataset.look ?? 'trace') as (typeof LOOKS)[number]))
  const rest = (): [number, number] => [...(REST[look] as [number, number])]
  let target = rest()
  const s = rest()
  const v: [number, number] = [0, 0]
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
    gl.draw({ x: (f.left - c.left) * dpr, y: (f.top - c.top) * dpr, w: f.width * dpr, h: f.height * dpr }, f.width < 520 ? 30 : 46, s[0], s[1], dpr)
  }
  const tick = (now: number) => {
    const dt = Math.min(0.032, (now - prev) / 1000)
    prev = now
    let moving = false
    for (const i of [0, 1] as const) {
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
  const aim = (next: [number, number]) => { target = next; wake() }

  const at = (e: PointerEvent) => { const r = frame.getBoundingClientRect(); return (e.clientX - r.left) / r.width }
  frame.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; hover = true; overture = false; aim(seams(at(e))) })
  frame.addEventListener('pointerleave', () => { hover = false; aim(rest()) })
  frame.addEventListener('click', (e) => { const p = at(e); choose(LOOKS[p < s[0] ? 0 : p < s[1] ? 1 : 2]) })

  let overture = !reduced
  const play = () => {
    if (!overture || !ready) return
    aim(seams(0))
    window.setTimeout(() => { if (overture) aim(seams(1)) }, 620)
    window.setTimeout(() => { if (overture) { overture = false; aim(rest()) } }, 1300)
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
        gl.upload(i as 0 | 1 | 2, img)
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
