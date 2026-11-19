import type { Vec2 } from '@silk-reel/ingest'
import type { BoardArchetype, TraceCharacter, TracePart } from '../types'

/**
 * What kind of board this is, read from its data alone, and what the film does
 * because of it: where the opening starts and which way it travels. A tall
 * through-hole hero makes a valve board; gold edge fingers a card; a long,
 * narrow board a stick, opening at its plug end (or the end farthest from the hero); a board where LEDs
 * are one part in twenty or more an LED board; anything else is dense digital,
 * opening on its largest IC.
 */
export function boardCharacter(parts: TracePart[], loops: number[][], gold: Array<[number, number, number, number]>, hero: Vec2): TraceCharacter {
  const xs = loops.flatMap((l) => l.filter((_, i) => i % 2 === 0))
  const ys = loops.flatMap((l) => l.filter((_, i) => i % 2 === 1))
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const long = Math.max(x1 - x0, y1 - y0)
  const short = Math.max(1e-6, Math.min(x1 - x0, y1 - y0))
  const alongX = x1 - x0 >= y1 - y0
  const bodies = parts.filter((pt) => pt.kind !== 'pin')
  const heroPart = bodies.find((pt) => pt.hero === true)
  const leds = bodies.filter((pt) => pt.kind === 'led')
  const at = (archetype: BoardArchetype, from: Vec2, to: Vec2): TraceCharacter => ({ archetype, opening: from, toward: to })

  if (heroPart?.kind === 'valve') return at('valve', hero, hero)
  if (gold.length > 0) {
    const g = gold.reduce((a, b) => ((b[2] - b[0]) * (b[3] - b[1]) > (a[2] - a[0]) * (a[3] - a[1]) ? b : a))
    return at('card', { x: (g[0] + g[2]) / 2, y: (g[1] + g[3]) / 2 }, hero)
  }
  if (long / short >= 2.2) {
    const endOf = (pt: TracePart): number => {
      const u = alongX ? (pt.x - x0) / (x1 - x0) : (pt.y - y0) / (y1 - y0)
      return Math.min(u, 1 - u)
    }
    const plug = bodies.filter((pt) => pt.kind === 'conn' && endOf(pt) < 0.15).sort((a, b) => endOf(a) - endOf(b))[0]
    if (plug !== undefined) return at('stick', { x: plug.x, y: plug.y }, hero)
    const ends: Vec2[] = alongX ? [{ x: x0 + 0.06 * long, y: (y0 + y1) / 2 }, { x: x1 - 0.06 * long, y: (y0 + y1) / 2 }] : [{ x: (x0 + x1) / 2, y: y0 + 0.06 * long }, { x: (x0 + x1) / 2, y: y1 - 0.06 * long }]
    const far = ends.reduce((a, e) => (Math.hypot(e.x - hero.x, e.y - hero.y) > Math.hypot(a.x - hero.x, a.y - hero.y) ? e : a))
    return at('stick', far, hero)
  }
  if (leds.length >= 8 && leds.length >= 0.05 * bodies.length) {
    const reach = 0.2 * long
    const crowd = (pt: TracePart): number => leds.filter((q) => Math.hypot(q.x - pt.x, q.y - pt.y) <= reach).length
    const centre = [...leds].sort((a, b) => crowd(b) - crowd(a) || a.x - b.x || a.y - b.y)[0] as TracePart
    const near = leds.filter((q) => Math.hypot(q.x - centre.x, q.y - centre.y) <= reach)
    return at('leds', { x: near.reduce((s, q) => s + q.x, 0) / near.length, y: near.reduce((s, q) => s + q.y, 0) / near.length }, hero)
  }
  return at('dense', hero, { x: (x0 + x1) / 2, y: (y0 + y1) / 2 })
}

/** a dark studio grey leaning a little toward the mask's complement, so each board's floor is its own without competing with it */
export function groundFor(mask: string): string {
  const c = [0, 1, 2].map((i) => Number.parseInt(mask.slice(1 + 2 * i, 3 + 2 * i), 16) / 255) as [number, number, number]
  const max = Math.max(...c)
  const min = Math.min(...c)
  const base = 0x21 / 255
  if (max - min < 0.04) return '#202124'
  const hue = c.map((v) => 1 - (v - min) / (max - min))
  const mean = hue.reduce((a, v) => a + v, 0) / 3
  const lean = 0.03 * Math.min(1, (max - min) / 0.3)
  return `#${hue.map((v) => Math.round(Math.min(1, Math.max(0, base + lean * (v - mean))) * 255).toString(16).padStart(2, '0')).join('')}`
}
