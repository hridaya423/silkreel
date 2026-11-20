// Draws the README banner from Glasgow's own front copper: `npx tsx .github/assets/banner.mts` from the repo root.
// Writes banner-light.webp and banner-dark.webp beside this file. Needs Chrome and img2webp (brew install webp).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { heroPart } from '@silk-reel/choreo'
import { parseKicadPcb } from '@silk-reel/ingest'
import { chromium } from 'playwright'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const W = 1760
const H = 550
const FRAMES = 96
const FPS = 24

const board = parseKicadPcb(readFileSync(here('../../fixtures/boards/glasgow.kicad_pcb'), 'utf8'), 'glasgow')
const hero = heroPart(board)!
const front = board.copper['F.Cu']
const key = (p: { x: number; y: number }) => `${Math.round(p.x * 200)},${Math.round(p.y * 200)}`

const nodes = new Map<string, number>()
const spots: { x: number; y: number }[] = []
const node = (p: { x: number; y: number }) => {
  const k = key(p)
  let n = nodes.get(k)
  if (n === undefined) {
    n = spots.length
    nodes.set(k, n)
    spots.push({ x: p.x, y: p.y })
  }
  return n
}
const links: number[][][] = []
const link = (a: number, b: number, length: number) => {
  ;(links[a] ??= []).push([b, length])
  ;(links[b] ??= []).push([a, length])
}

const segments: { a: number; b: number; width: number }[] = []
for (const t of front.traces) {
  for (let k = 1; k < t.points.length; k++) {
    const a = node(t.points[k - 1])
    const b = node(t.points[k])
    segments.push({ a, b, width: t.width })
    link(a, b, Math.hypot(spots[b].x - spots[a].x, spots[b].y - spots[a].y))
  }
}
const ends = [...spots]
const pads = front.pads.map((p) => {
  const n = node({ x: p.pos.x + 1e-3, y: p.pos.y + 1e-3 })
  const a = (p.rot * Math.PI) / 180
  ends.forEach((e, i) => {
    const dx = e.x - p.pos.x
    const dy = e.y - p.pos.y
    const u = Math.abs(dx * Math.cos(a) + dy * Math.sin(a))
    const v = Math.abs(dy * Math.cos(a) - dx * Math.sin(a))
    if (u <= p.size.x / 2 + 0.01 && v <= p.size.y / 2 + 0.01) link(n, i, Math.hypot(dx, dy))
  })
  return { n, x: p.pos.x, y: p.pos.y, w: p.size.x, h: p.size.y, rot: p.rot, round: p.shape === 'circle' || p.shape === 'oval', chip: p.footprintRef === hero.ref }
})
const vias = front.vias.map((v) => {
  const n = node(v.pos)
  return { n, x: v.pos.x, y: v.pos.y, d: v.dia }
})

const dist = new Float64Array(spots.length).fill(Infinity)
const open: number[] = []
for (const p of pads) if (p.chip) { dist[p.n] = 0; open.push(p.n) }
while (open.length) {
  let best = 0
  for (let i = 1; i < open.length; i++) if (dist[open[i]] < dist[open[best]]) best = i
  const n = open.splice(best, 1)[0]
  for (const [m, length] of links[n] ?? []) {
    if (dist[n] + length < dist[m]) {
      if (dist[m] === Infinity) open.push(m)
      dist[m] = dist[n] + length
    }
  }
}
let far = 0
for (const d of dist) if (d < Infinity) far = Math.max(far, d)
const wired = Array.from(dist, (d) => d < Infinity)
spots.forEach((s, i) => {
  if (dist[i] === Infinity) dist[i] = 0.25 * far + Math.hypot(s.x - hero.pos.x, s.y - hero.pos.y) * 1.6
})
const last = Math.max(...dist)

const scene = {
  W,
  H,
  frames: FRAMES,
  hero: hero.pos,
  far,
  last,
  spots: spots.map((s, i) => [s.x, s.y, dist[i], wired[i] ? 1 : 0]),
  segments: segments.map((s) => [s.a, s.b, s.width]),
  pads: pads.map((p) => [p.x, p.y, p.w, p.h, p.rot, p.round ? 1 : 0, p.chip ? 1 : 0, dist[p.n]]),
  vias: vias.map((v) => [v.x, v.y, v.d, dist[v.n]]),
  font: readFileSync(here('../../packages/site/public/fonts/martian-mono-var.woff2')).toString('base64')
}

const themes = {
  light: { paper: '#ecede9', ink: '#0b0b0b', copper: '#2a2a27', muted: '#4a4a46', red: '#c4221a' },
  dark: { paper: '#0b0b0b', ink: '#f4f4f0', copper: '#d9d9d3', muted: '#a9a9a3', red: '#ff4a3d' }
}

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
await page.setContent('<script>window.__name = (f) => f</script><canvas></canvas>')
await page.evaluate(async (s) => {
  const face = new FontFace('Martian Mono', `url(data:font/woff2;base64,${s.font})`, { weight: '100 800' })
  document.fonts.add(await face.load())
  Object.assign(window, { scene: s })
}, scene)

const work = mkdtempSync(join(tmpdir(), 'silk-banner-'))
for (const [name, theme] of Object.entries(themes)) {
  const files: string[] = []
  for (let f = 0; f < FRAMES; f++) {
    const png: string = await page.evaluate(({ t, c }) => {
      const s = (window as unknown as { scene: typeof scene }).scene
      const canvas = document.querySelector('canvas')!
      canvas.width = s.W
      canvas.height = s.H
      const g = canvas.getContext('2d')!
      const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
      const reach = s.last * 1.01 * ease(t / 0.58)
      const head = s.far * 0.035
      const power = t < 0.6 ? -1 : s.far * 1.6 * ((t - 0.6) / 0.22)
      const fade = t < 0.9 ? 1 : 1 - ease((t - 0.9) / 0.1)
      const scale = s.H / 23
      const ox = s.W * 0.83
      const oy = s.H * 0.5
      const X = (x: number) => (x - s.hero.x) * scale + ox
      const Y = (y: number) => (y - s.hero.y) * scale + oy

      g.fillStyle = c.paper
      g.fillRect(0, 0, s.W, s.H)

      const layer = document.createElement('canvas')
      layer.width = s.W
      layer.height = s.H
      const l = layer.getContext('2d')!
      l.lineCap = 'round'
      l.lineJoin = 'round'
      const stroke = (from: number, to: number, colour: string, wiredOnly = false) => {
        for (const [a, b, width] of s.segments) {
          const [ax, ay, da, wa] = s.spots[a]
          const [bx, by, db, wb] = s.spots[b]
          if (wiredOnly && !(wa && wb)) continue
          const length = Math.hypot(bx - ax, by - ay) || 1e-6
          const part = (d0: number, x0: number, y0: number, x1: number, y1: number) => {
            const start = Math.max(0, from - d0)
            const end = Math.min(length, to - d0)
            if (end <= start) return
            l.moveTo(X(x0 + ((x1 - x0) * start) / length), Y(y0 + ((y1 - y0) * start) / length))
            l.lineTo(X(x0 + ((x1 - x0) * end) / length), Y(y0 + ((y1 - y0) * end) / length))
          }
          l.beginPath()
          l.lineWidth = Math.max(1.4, width * scale)
          l.strokeStyle = colour
          part(da, ax, ay, bx, by)
          part(db, bx, by, ax, ay)
          l.stroke()
        }
      }
      const pad = (p: number[], colour: string) => {
        const [x, y, w, h, rot, round] = p
        l.save()
        l.translate(X(x), Y(y))
        l.rotate((-rot * Math.PI) / 180)
        l.fillStyle = colour
        l.beginPath()
        if (round) l.ellipse(0, 0, (w * scale) / 2, (h * scale) / 2, 0, 0, Math.PI * 2)
        else l.roundRect((-w * scale) / 2, (-h * scale) / 2, w * scale, h * scale, Math.min(w, h) * scale * 0.15)
        l.fill()
        l.restore()
      }

      stroke(-1, reach - head, c.copper)
      for (const p of s.pads) if (p[7] <= reach) pad(p, p[6] && power >= 0 ? c.red : c.copper)
      for (const [x, y, d, dv] of s.vias) {
        if (dv > reach) continue
        l.fillStyle = c.copper
        l.beginPath()
        l.arc(X(x), Y(y), (d * scale) / 2, 0, Math.PI * 2)
        l.fill()
        l.fillStyle = c.paper
        l.beginPath()
        l.arc(X(x), Y(y), (d * scale) / 5, 0, Math.PI * 2)
        l.fill()
      }
      stroke(reach - head, reach, c.red)
      if (power >= 0) stroke(power - s.far * 0.12, power, c.red, true)

      const edge = l.createRadialGradient(ox, oy, s.H * 0.45, ox, oy, s.W * 0.42)
      edge.addColorStop(0, 'rgba(0,0,0,1)')
      edge.addColorStop(1, 'rgba(0,0,0,0)')
      l.globalCompositeOperation = 'destination-in'
      l.fillStyle = edge
      l.fillRect(0, 0, s.W, s.H)
      const side = l.createLinearGradient(s.W * 0.54, 0, s.W * 0.6, 0)
      side.addColorStop(0, 'rgba(0,0,0,0)')
      side.addColorStop(1, 'rgba(0,0,0,1)')
      l.fillStyle = side
      l.fillRect(0, 0, s.W, s.H)

      g.globalAlpha = fade
      g.drawImage(layer, 0, 0)
      g.globalAlpha = 1

      const size = s.H * 0.2
      g.font = `600 ${size}px "Martian Mono"`
      g.letterSpacing = `${-0.02 * size}px`
      g.fillStyle = c.ink
      g.textBaseline = 'alphabetic'
      g.fillText('silk reel', s.W * 0.06, s.H * 0.53)
      const line = s.H * 0.052
      g.font = `400 ${line}px "Martian Mono"`
      g.letterSpacing = '0px'
      g.fillStyle = c.muted
      g.fillText('KiCad board in. Launch film out.', s.W * 0.062, s.H * 0.53 + line * 2.4)
      return canvas.toDataURL('image/png').slice(22)
    }, { t: f / FRAMES, c: theme })
    const file = join(work, `${name}-${String(f).padStart(3, '0')}.png`)
    writeFileSync(file, Buffer.from(png, 'base64'))
    files.push(file)
  }
  const out = here(`banner-${name}.webp`)
  execFileSync('img2webp', ['-loop', '0', '-lossy', '-q', '82', '-m', '6', '-d', String(Math.round(1000 / FPS)), ...files, '-o', out], { stdio: 'ignore' })
}
await browser.close()
rmSync(work, { recursive: true })
