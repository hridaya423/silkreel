import { GLYPH_INK_SCALE, type GlyphTimeline } from '@silk-reel/choreo'
import { glyphDepth, glyphPose, glyphScreen } from './glyph-cam'
import { drawGlyphFrame } from './glyph-draw'
import { glyphLight } from './glyph-light'
import type { GlyphLight } from './glyph-light'
import { solveLead } from './glyph-lead'
import type { Scene } from './glyph-draw'
import { drawTitle } from './title'

const ACCENT = '#ffb46a'
const LAYERS = [-1, 0, 0.4, 1]
const WORD_EDGE_FADE = 0.03
const VIGNETTE_CLEAR = 0.35
const VIGNETTE_FAR = 0.6
const VIGNETTE_DARK = 0.6
/** the vignette keeps this share of its dark under the name, so letters near the frame's edge keep their light */
const VIGNETTE_UNDER_NAME = 0.25

const nameShown = (tl: GlyphTimeline, frame: number): number => {
  const start = tl.events.find((e) => e.kind === 'letter')?.at
  const whole = tl.events.find((e) => e.kind === 'name')?.at
  if (start === undefined || whole === undefined) return 0
  return Math.min(1, Math.max(0, (frame - start) / Math.max(1, whole - start)))
}
const smooth = (u: number): number => {
  const t = Math.min(1, Math.max(0, u))
  return t * t * (3 - 2 * t)
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function noiseTile(): HTMLCanvasElement {
  const c = canvas(256, 256)
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  const img = ctx.createImageData(256, 256)
  let s = 1234567
  for (let i = 0; i < img.data.length; i += 4) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0
    const v = (s >>> 24) & 255
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

function formationRanks(timeline: GlyphTimeline): number[] {
  const seen = new Map<number, number>()
  const of = timeline.placements.map((p) => {
    const k = seen.get(p.formation) ?? 0
    seen.set(p.formation, k + 1)
    return k
  })
  return of.map((k, i) => k / (seen.get((timeline.placements[i] as GlyphTimeline['placements'][number]).formation) as number))
}

export type GlyphFilmDraw = (out: CanvasRenderingContext2D, timeline: GlyphTimeline, scene: Scene, frame: number) => void

/**
 * The glyph film: the composer's placements in four depth layers by role,
 * with parallax, a slow drift and roll, short trails, a copper pulse that
 * travels through the parts, the field's build, one peak of light on the named formation's
 * lock, glow, haze, a vignette and grain, under one
 * camera that opens close on the main chip, pulls back through the three
 * formations and dives back in for the loop.
 */
export function createGlyphFilm(W: number, H: number): GlyphFilmDraw {
  const noise = noiseTile()
  const layer = canvas(W, H)
  const sum = canvas(W, H)
  const glow = canvas(W, H)
  const lctx = layer.getContext('2d') as CanvasRenderingContext2D
  const sctx = sum.getContext('2d') as CanvasRenderingContext2D
  const gctx = glow.getContext('2d') as CanvasRenderingContext2D
  const lights = new WeakMap<GlyphTimeline, GlyphLight>()
  const ranks = new WeakMap<GlyphTimeline, number[]>()
  const leads = new WeakMap<GlyphTimeline, Map<string, number>>()
  const paint = (out: CanvasRenderingContext2D, timeline: GlyphTimeline, scene: Scene, frame: number, lead: Map<string, number>): void => {
    const light = lights.get(timeline) ?? glyphLight(timeline)
    lights.set(timeline, light)
    const lift = light.lift(frame)
    const flash = light.flash(frame)
    const bare = { ...timeline, title: undefined }
    const lit = { ...bare, palette: { ...bare.palette, silk: ACCENT, head: ACCENT } }
    const p = frame / timeline.totalFrames
    const sec = frame / timeline.fps
    const { view, driftX, driftY, roll } = glyphPose(timeline, frame)
    const { scale, dx, dy } = view
    const last = timeline.placements.find((p) => p.stage !== undefined)?.formation
    const shown = (i: number): boolean => !view.scene || timeline.placements[i]?.formation === last
    const dim = timeline.placements.map((pl) => (pl.stage !== undefined && pl.role !== 'hero' && pl.group !== undefined ? lead.get(pl.group) ?? 1 : 1))
    const rank = ranks.get(timeline) ?? formationRanks(timeline)
    ranks.set(timeline, rank)
    const depth = (i: number): number => glyphDepth(timeline.placements[i] as GlyphTimeline['placements'][number])
    const staged = (i: number): boolean => timeline.placements[i]?.stage !== undefined
    const wave = (i: number): number => staged(i) ? light.raise(frame, i) : Math.max(0, Math.cos(2 * Math.PI * (sec / 2.8 - (rank[i] as number)))) ** 6
    const warm = (i: number): number => staged(i) ? light.shine(frame, i) : Math.max(wave(i), 0.75 * light.sweep(frame, i))

    sctx.setTransform(1, 0, 0, 1, 0, 0)
    sctx.clearRect(0, 0, W, H)
    gctx.setTransform(1, 0, 0, 1, 0, 0)
    gctx.clearRect(0, 0, W, H)
    for (const z of LAYERS) {
      const s = scale * (1 + 0.09 * z)
      const ox = driftX * (1 + 0.9 * z)
      const oy = driftY * (1 + 0.9 * z)
      const far = z < 0
      const pass = (tl: GlyphTimeline, at: number, alpha: (i: number) => number, target: CanvasRenderingContext2D, gain: number, blur: number): void => {
        const place = (across: number): void => {
          lctx.setTransform(1, 0, 0, 1, 0, 0)
          lctx.translate(W / 2 + ox + across, H / 2 + oy)
          lctx.rotate(roll)
          lctx.scale(s, s)
          lctx.translate(-W / 2 - dx, -H / 2 - dy)
        }
        lctx.setTransform(1, 0, 0, 1, 0, 0)
        lctx.clearRect(0, 0, W, H)
        place(0)
        const cos = Math.cos(roll) * s
        const sin = Math.sin(roll) * s
        const whole = (x: number, y: number, hw: number, hh: number): number => {
          const ux = x - W / 2 - dx
          const uy = y - H / 2 - dy
          const sx = W / 2 + ox + cos * ux - sin * uy
          const sy = H / 2 + oy + sin * ux + cos * uy
          const ex = Math.abs(cos) * hw + Math.abs(sin) * hh
          const ey = Math.abs(sin) * hw + Math.abs(cos) * hh
          return smooth(Math.min(sx - ex, W - sx - ex, sy - ey, H - sy - ey) / (WORD_EDGE_FADE * W))
        }
        const drawn = (i: number): number => (depth(i) === z && shown(i) ? alpha(i) * (dim[i] as number) : 0)
        drawGlyphFrame(lctx, tl, scene, at, { alpha: drawn, inkScale: GLYPH_INK_SCALE / s, grow: (i) => light.swell(frame, i), whole })
        target.globalAlpha = gain
        target.filter = blur > 0 ? `blur(${blur}px)` : 'none'
        target.globalCompositeOperation = 'lighter'
        target.drawImage(layer, 0, 0)
        target.filter = 'none'
        target.globalAlpha = 1
      }
      const rest = far ? 0.42 : z === 0 ? 0.72 : 1
      const base = rest + (1 - rest) * 0.5 * lift
      const hero = (i: number): boolean => timeline.placements[i]?.role === 'hero'
      pass(bare, Math.max(0, frame - 4), () => 1, sctx, 0.12 * base, 3)
      pass(bare, Math.max(0, frame - 2), () => 1, sctx, 0.22 * base, 1.5)
      pass(bare, frame, (i) => 0.62 + 0.38 * Math.max(wave(i), lift, light.sweep(frame, i)), sctx, base, far ? 2.2 : 0)
      pass(lit, frame, (i) => Math.max(warm(i), (hero(i) ? 1 : 0.4) * lift), gctx, far ? 0.5 : 1, 0)
    }

    out.setTransform(1, 0, 0, 1, 0, 0)
    out.globalCompositeOperation = 'source-over'
    out.globalAlpha = 1
    out.filter = 'none'
    const haze = out.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2)
    haze.addColorStop(0, '#0d0e11')
    haze.addColorStop(1, '#020202')
    out.fillStyle = haze
    out.fillRect(0, 0, W, H)
    out.globalCompositeOperation = 'lighter'
    out.drawImage(sum, 0, 0)
    out.filter = `blur(${0.006 * W}px)`
    out.globalAlpha = 0.5
    out.drawImage(sum, 0, 0)
    out.filter = `blur(${0.03 * W}px)`
    out.globalAlpha = Math.min(1, 0.3 + 0.4 * lift + 0.3 * flash)
    out.drawImage(sum, 0, 0)
    out.filter = 'none'
    out.globalAlpha = 0.9
    out.drawImage(glow, 0, 0)
    out.filter = `blur(${0.012 * W}px)`
    out.globalAlpha = 0.9
    out.drawImage(glow, 0, 0)
    out.filter = `blur(${0.05 * W}px)`
    out.globalAlpha = 0.6
    out.drawImage(glow, 0, 0)
    out.filter = 'none'
    out.globalAlpha = 1
    out.globalCompositeOperation = 'source-over'
    const edge = out.createRadialGradient(W / 2, H / 2, Math.min(W, H) * VIGNETTE_CLEAR, W / 2, H / 2, Math.hypot(W, H) * VIGNETTE_FAR)
    edge.addColorStop(0, 'rgba(0,0,0,0)')
    edge.addColorStop(1, `rgba(0,0,0,${VIGNETTE_DARK * (1 - (1 - VIGNETTE_UNDER_NAME) * smooth(nameShown(timeline, frame)))})`)
    out.fillStyle = edge
    out.fillRect(0, 0, W, H)
    out.globalCompositeOperation = 'overlay'
    out.globalAlpha = 0.1
    const nx = (frame * 97) % 256
    const ny = (frame * 57) % 256
    for (let y = -ny; y < H; y += 256) for (let x = -nx; x < W; x += 256) out.drawImage(noise, x, y)
    out.globalCompositeOperation = 'source-over'
    out.globalAlpha = 1
    drawTitle(out, timeline, p)
  }

  // the held field is measured as a phone shows it: its last whole frame at 390 px wide, each pad's 3×3-pixel mean, averaged over its part
  const PHONE = 390
  const ph = Math.round((PHONE * H) / W)
  let probe: { full: CanvasRenderingContext2D; small: CanvasRenderingContext2D } | undefined
  const leadOf = (timeline: GlyphTimeline, scene: Scene): Map<string, number> => {
    const leaves = timeline.placements.filter((pl) => pl.stage !== undefined && pl.role !== 'hero').map((pl) => Math.round((pl.outStep * timeline.fps) / 15))
    const lastFrame = Math.min(timeline.totalFrames, ...leaves) - 1
    const pads = timeline.placements.filter((pl) => pl.stage !== undefined && pl.group !== undefined)
    if (!pads.some((pl) => pl.role === 'hero') || !pads.some((pl) => pl.role !== 'hero')) return new Map()
    probe ??= { full: canvas(W, H).getContext('2d') as CanvasRenderingContext2D, small: canvas(PHONE, ph).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D }
    const { full, small } = probe
    const sites = pads.map((pl) => {
      const a = pl.atoms[0] as GlyphTimeline['placements'][number]['atoms'][number]
      const [x, y] = glyphScreen(timeline, lastFrame, glyphDepth(pl)).at(a.x, a.y)
      return { group: pl.role === 'hero' ? undefined : pl.group, x: Math.round((x * PHONE) / W), y: Math.round((y * ph) / H) }
    })
    return solveLead((lead) => {
      paint(full, timeline, scene, lastFrame, lead)
      small.imageSmoothingEnabled = true
      small.imageSmoothingQuality = 'high'
      small.clearRect(0, 0, PHONE, ph)
      small.drawImage(full.canvas, 0, 0, PHONE, ph)
      const px = small.getImageData(0, 0, PHONE, ph).data
      const level = (x: number, y: number): number => {
        let sum = 0
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            const k = 4 * (Math.min(ph - 1, Math.max(0, y + j)) * PHONE + Math.min(PHONE - 1, Math.max(0, x + i)))
            sum += 0.299 * (px[k] as number) + 0.587 * (px[k + 1] as number) + 0.114 * (px[k + 2] as number)
          }
        }
        return sum / 9
      }
      const sums = new Map<string | undefined, [number, number]>()
      for (const site of sites) {
        const [t, n] = sums.get(site.group) ?? [0, 0]
        sums.set(site.group, [t + level(site.x, site.y), n + 1])
      }
      const mean = ([t, n]: [number, number]): number => t / n
      const groups = new Map([...sums].filter((e): e is [string, [number, number]] => e[0] !== undefined).map(([g, v]) => [g, mean(v)]))
      return { hero: mean(sums.get(undefined) ?? [0, 1]), groups }
    })
  }

  return (out, timeline, scene, frame) => {
    const lead = leads.get(timeline) ?? leadOf(timeline, scene)
    leads.set(timeline, lead)
    paint(out, timeline, scene, frame, lead)
  }
}
