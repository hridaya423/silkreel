import { describe, expect, it } from 'vitest'
import { compileTimeline } from '../compile'
import { ASPECT_SIZE } from '../layout'
import type { Aspect, FilmConfig } from '../index'
import { boardModel } from '../../test/helpers'
import { lightAt, makeCam, project, sampleShot } from '../trace/camera'
import type { Cam } from '../trace/camera'
import type { PartBodies, TraceScene } from '../types'
import { heroPart } from '../acts'
import { BEHIND_KEEP, boardCover, bodyOutline, CLEAR_TEXT, copperStack, CROWN, DIM_LABEL, drawnBody, EMPTY_VALUE, heroCovered, hypeCut, PLAIN_MOST, plainMost, bodyRaster, boardWords, countedWords, FLIPPED, MARK_LEAN, turnsFor, WORD_LEAST, LABEL, measuredBox, POSTER, printBand, printKept, printMarks, RELEASE, SEEN, SETTLE, silkBox, silkInBand, silkWhole, STOP, touches, WHOLE } from './hype'
import type { HypeCut, Seg, TextBox } from './hype'

const cutOf = (name: string, aspect: Aspect, bodies?: PartBodies): { s: TraceScene; h: HypeCut; W: number; H: number } => {
  const config: FilmConfig = { style: 'montage', aspect, knobs: {}, seed: 7, duration: 'auto', title: { name: 'Board', version: 'C3' }, output: { ...ASPECT_SIZE[aspect], fps: 30 } }
  const tl = compileTimeline(boardModel(name), config, bodies)
  if (tl.style !== 'montage' || tl.scene.montage === undefined) throw new Error('expected a montage timeline')
  return { s: tl.scene, h: hypeCut(tl.scene, tl.scene.montage, tl.width, tl.height), W: tl.width, H: tl.height }
}

const camAt = (h: HypeCut, f: number, W: number, H: number): Cam => makeCam(sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total), W, H)

const seen = (cam: Cam, x: number, y: number): boolean => {
  const v = project(cam, x, y)
  return v.w > 0 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1
}

const area = (s: TraceScene): Array<[number, number]> => {
  const rim = s.board.reduce<number[]>((a, l) => (l.length > a.length ? l : a), [])
  const poly = Array.from({ length: rim.length / 2 }, (_, i): [number, number] => [rim[2 * i] as number, rim[2 * i + 1] as number])
  const xs = poly.map(([x]) => x)
  const ys = poly.map(([, y]) => y)
  const inside = (x: number, y: number): boolean => {
    let c = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[i] as [number, number]
      const [bx, by] = poly[j] as [number, number]
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) c = !c
    }
    return c
  }
  const pts: Array<[number, number]> = []
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 40; j++) {
      const x = Math.min(...xs) + ((i + 0.5) / 40) * (Math.max(...xs) - Math.min(...xs))
      const y = Math.min(...ys) + ((j + 0.5) / 40) * (Math.max(...ys) - Math.min(...ys))
      if (inside(x, y)) pts.push([x, y])
    }
  }
  return pts
}

const motion = (pts: Array<[number, number]>, a: Cam, b: Cam, W: number, H: number): { x: number; y: number } => {
  let x = 0
  let y = 0
  let n = 0
  for (const [px, py] of pts) {
    const u = project(a, px, py)
    const v = project(b, px, py)
    if (u.w <= 0 || v.w <= 0 || Math.abs(u.x) > 1 || Math.abs(u.y) > 1) continue
    x += ((v.x - u.x) * W) / 2
    y += ((u.y - v.y) * H) / 2
    n++
  }
  return n === 0 ? { x: 0, y: 0 } : { x: x / n, y: y / n }
}

describe('the glint on a chip with leads', () => {
  it('spans the flat top of the model the chip wears, not the footprint its leads reach, and the body of a chip that wears none', () => {
    const ref = heroPart(boardModel('StickHub.kicad_pcb'))?.ref ?? ''
    const corners = (half: number, z: number): number[] => [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([u, v]) => [(u as number) * half, (v as number) * half, z])
    const leaded = { pos: Buffer.from(new Float32Array([...corners(3, 1.4), ...corners(4.5, 0.2)]).buffer).toString('base64'), nor: '', col: '', idx: '', min: [-4.5, -4.5, 0] as [number, number, number], max: [4.5, 4.5, 1.4] as [number, number, number] }
    const share = (bodies?: PartBodies): number => {
      const { s, h } = cutOf('StickHub.kicad_pcb', '16:9', bodies)
      const hero = s.parts.find((q) => q.hero === true)
      if (hero === undefined) throw new Error('no main chip')
      expect(hero.mesh === undefined, 'the chip wears the model it is given').toBe(bodies === undefined)
      return h.glint.along / Math.max(hero.w, hero.h)
    }
    expect(share()).toBeCloseTo(1, 6)
    expect(share({ meshes: [leaded], byRef: { [ref]: 0 } })).toBeCloseTo(6 / 9, 6)
  })
})

describe('one marking per chip', { timeout: 600_000 }, () => {
  for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
    it(`${name}: in every frame of every aspect, the main chip carries only its own printed marking, bare only in a print, and no word is lettered on its lid`, () => {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
        const { s, h, W, H } = cutOf(name, aspect)
        const hero = s.parts.find((q) => q.hero === true)
        if (hero?.label === undefined) throw new Error('no marking on the main chip')
        const marking = hero.label.toUpperCase()
        for (const w of h.words.filter((x) => x.name !== true)) expect(marking.includes(w.text.toUpperCase()) && w.text.length > 2, `${aspect}: "${w.text}" repeats part of the marking ${hero.label}`).toBe(false)
        for (const w of h.words.filter((x) => x.name === true)) for (let f = w.f0; f < w.f1; f++) expect(h.plan[f]?.bare, `${aspect} f${f}: the name stands only in a print`).toBe(true)
        for (let f = 0; f < h.frames; f++) {
          const pf = h.plan[f]
          if (pf === undefined) throw new Error(`no frame ${f}`)
          expect(pf.bare === true, `${aspect} ${f}: the marking is left out only in a print`).toBe(pf.look === 'blueprint')
          if (pf.state !== 'lit' || pf.look !== 'lit') continue
          const cam = camAt(h, f, W, H)
          const lid = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => project(cam, hero.x + (Math.cos(hero.rot) * (u as number) * hero.w - Math.sin(hero.rot) * (v as number) * hero.h) / 2, hero.y + (Math.sin(hero.rot) * (u as number) * hero.w + Math.cos(hero.rot) * (v as number) * hero.h) / 2, hero.z)).map((q) => ({ x: (q.x + 1) / 2, y: (1 - q.y) / 2 }))
          const box = { x0: Math.min(...lid.map((q) => q.x)), x1: Math.max(...lid.map((q) => q.x)), y0: Math.min(...lid.map((q) => q.y)), y1: Math.max(...lid.map((q) => q.y)) }
          for (const w of h.words.filter((x) => f >= x.f0 && f < x.f1 && x.follow === undefined && x.crown !== true && x.small !== true)) {
            expect(w.x < box.x0 || w.x > box.x1 || w.y < box.y0 || w.y > box.y1, `${aspect} ${f}: "${w.text}" is lettered on the main chip's lid`).toBe(true)
          }
        }
      }
    })
  }
})

describe('the copper stack', () => {
  it('is the front, the inner layers in name order and the back: four layers on Glasgow, two on StickHub', () => {
    expect(copperStack(cutOf('glasgow.kicad_pcb', '4:5').s).map((l) => l.id ?? l.side)).toEqual(['F', 'In1.Cu', 'In2.Cu', 'B'])
    expect(copperStack(cutOf('StickHub.kicad_pcb', '4:5').s).map((l) => l.side)).toEqual(['F', 'B'])
  })
})

describe('hype cut', { timeout: 300_000 }, () => {
  it('keeps the stop, the release and the poster on their frames', () => {
    expect([STOP, RELEASE, POSTER]).toEqual([135, 165, 300])
    expect((360 - POSTER - SETTLE) / 30, 'the poster stands 1.5 s or more').toBeGreaterThanOrEqual(1.5)
  })

  it('cuts to a pin row away from the main chip when the release finds no lettering to cut to', () => {
    const { h } = cutOf('kit-dev-coldfire-xilinx_5213.kicad_pcb', '16:9')
    expect(h.cuts.filter((c) => c > 200 && c < 285)).toEqual([225, 255])
  })

  for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
    for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
      it(`builds in three materials with a new one at every cut, stops on the main chip in the dark, turns the light on in one frame, shows the whole board once, and ends low on the chip with the name behind it: ${name} ${aspect}`, () => {
        const { s, h, W, H } = cutOf(name, aspect)
        expect(h.frames).toBe(360)
        expect(h.events.filter((e) => e.kind === 'stop').map((e) => e.f)).toEqual([STOP])
        expect(h.events.filter((e) => e.kind === 'hit').map((e) => e.f)).toEqual([RELEASE])
        expect(h.events.filter((e) => e.kind === 'poster').map((e) => e.f)).toEqual([POSTER])

        const build = h.plan.slice(0, STOP)
        const starts = [0, ...h.cuts.filter((c) => c < STOP)]
        const runs = starts.map((c) => (build[c]?.state === 'draw' ? 'draw' : build[c]?.state !== 'lit' ? 'copper' : build[c].look === 'blueprint' ? 'print' : build[c].look === 'xray' ? 'xray' : 'lit'))
        expect(new Set(runs.map((r) => (r === 'draw' ? 'copper' : r))).size, 'the build shows copper, the print, the X-ray and the lit board').toBe(4)
        for (const [i, r] of runs.entries()) if (i > 0) expect(r, `build cut ${i} changes the material`).not.toBe(runs[i - 1])
        for (const [i, c] of starts.entries()) for (let f = c; f < (starts[i + 1] ?? STOP); f++) expect(build[f]?.look, `${f} keeps its shot's material`).toBe(runs[i] === 'print' ? 'blueprint' : runs[i] === 'xray' ? 'xray' : 'lit')
        const xi = runs.indexOf('xray')
        expect(runs.filter((r) => r === 'xray').length, 'the build is seen through once').toBe(1)
        expect(runs[xi - 1], 'the X-ray comes straight after the finished copper').toBe('copper')
        expect((starts[xi + 1] ?? STOP) - (starts[xi] as number), 'the X-ray holds long enough to read').toBeGreaterThanOrEqual(8)
        const xcut = starts[xi] as number
        const pose = (f: number): ReturnType<typeof sampleShot> => sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total)
        const [p2, p1, p0] = [pose(xcut - 2), pose(xcut - 1), pose(xcut)]
        for (const key of ['x', 'y', 'tilt', 'yaw', 'roll', 'fov', 'shift'] as const) expect(p0[key] ?? 0, `the X-ray keeps the copper shot's ${key}`).toBeCloseTo(2 * (p1[key] ?? 0) - (p2[key] ?? 0), 5)
        expect(p0.zoom / p1.zoom, 'the X-ray keeps the copper shot\'s push').toBeCloseTo(p1.zoom / p2.zoom, 3)
        for (let f = STOP; f < RELEASE; f++) {
          const pf = h.plan[f]
          expect([pf?.state, pf?.grade], `${f}`).toEqual(['lit', 'stop'])
          expect(lightAt(h.shots, (pf?.clone ?? 0) / h.total), `${f} the stop is dark`).toBe('rim')
        }
        for (const [f, pf] of h.plan.entries()) if (pf.state === 'lit' && pf.grade !== 'stop') expect((pf.clone - (h.plan[RELEASE - 1]?.clone ?? 0)) / h.total, `${f} stands past the stretch the renderer eases the stop's light over, so the light is on in one frame`).toBeGreaterThanOrEqual(0.05)
        expect(Math.max(...h.plan.map((pf) => pf.clone)), 'every frame is inside the clone').toBeLessThan(h.total)
        for (let f = RELEASE; f < h.frames; f++) {
          const pf = h.plan[f]
          expect([pf?.state, pf?.look, pf?.grade], `${f}`).toEqual(['lit', f >= SEEN[0] && f < SEEN[1] ? 'xray' : 'lit', 'release'])
          expect(lightAt(h.shots, (pf?.clone ?? 0) / h.total), `${f}`).toBe('poster')
        }

        const pts = area(s)
        const outline = s.board.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i): [number, number] => [l[2 * i] as number, l[2 * i + 1] as number]))
        for (let f = 0; f < h.frames; f++) {
          const cam = camAt(h, f, W, H)
          const whole = outline.every(([x, y]) => seen(cam, x, y))
          if (f < WHOLE[0] || f >= POSTER + SETTLE) expect(whole, `${f} holds the whole outline`).toBe(false)
          if (f >= WHOLE[1] && f < WHOLE[2]) expect(whole, `${f} shows the board whole, once`).toBe(true)
          if (f < STOP || (f >= RELEASE && f < WHOLE[0])) expect(pts.filter(([x, y]) => seen(cam, x, y)).length / pts.length, `${f} board share`).toBeLessThanOrEqual(0.34)
        }
        expect(WHOLE[2] - WHOLE[1], 'the whole board stands 15 frames or more').toBeGreaterThanOrEqual(15)
        const through = h.plan.flatMap((pf, f) => (f >= RELEASE && pf.look === 'xray' ? [f] : []))
        expect([through.length >= 8, (through[0] ?? 0) > WHOLE[1], (through.at(-1) ?? WHOLE[2]) < WHOLE[2]], 'the whole board is seen through inside its still hold, long enough to read, and cuts back as the camera drops').toEqual([true, true, true])
        const shown = through.map((f) => h.plan[f]?.layers ?? 0)
        const arrivals = through.filter((f, i) => i === 0 || shown[i] !== shown[i - 1])
        expect(shown[0], 'the front copper arrives first, alone').toBe(1)
        expect(shown.every((n, i) => i === 0 || n === (shown[i - 1] as number) || n === (shown[i - 1] as number) + 1), 'the layers arrive one at a time').toBe(true)
        expect(arrivals.length, 'every copper layer arrives').toBe(copperStack(s).length)
        expect((arrivals.at(-1) ?? 0) - SEEN[0], 'the last layer arrives with time left to see the stack').toBeLessThanOrEqual(10)
        expect(new Set(arrivals.slice(1).map((f, i) => f - (arrivals[i] as number))).size, 'the layers arrive on one beat').toBeLessThanOrEqual(1)
        for (let f = 0; f < STOP; f++) if (h.plan[f]?.look === 'xray') expect(h.plan[f]?.layers, `${f} the build sees through every layer at once`).toBeUndefined()
        const lit = starts.flatMap((c, i) => (runs[i] === 'lit' ? [[c, starts[i + 1] ?? STOP] as const] : []))
        for (const [, end] of lit.slice(0, -1)) expect(STOP - end, 'a lit build shot before the last ends a second clear of the stop, so the build never pulses twice in one second').toBeGreaterThanOrEqual(30)
        expect(lit.at(-1)?.[1], 'the build lights the chip last, just before the stop').toBe(STOP)
        expect(SEEN.map((f) => h.events.find((e) => e.f === f && e.kind === 'cut') !== undefined), 'each look change at the hold is a cut for the score').toEqual([true, true])

        const hero = s.parts.find((p) => p.hero === true) ?? s.parts[0]
        if (hero === undefined) throw new Error('no parts')
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [hero.x + (Math.cos(hero.rot) * (u as number) * hero.w) / 2 - (Math.sin(hero.rot) * (v as number) * hero.h) / 2, hero.y + (Math.sin(hero.rot) * (u as number) * hero.w) / 2 + (Math.cos(hero.rot) * (v as number) * hero.h) / 2] as const)
        const box = (f: number): [number, number, number] => {
          const cam = camAt(h, f, W, H)
          const pts = corners.map(([x, y]) => project(cam, x, y))
          const xs = pts.map((q) => ((q.x + 1) / 2) * W)
          const ys = pts.map((q) => ((1 - q.y) / 2) * H)
          return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(...xs) - Math.min(...xs)]
        }
        const buildCuts = [0, ...h.cuts.filter((c) => c > 0 && c < STOP), STOP]
        expect(buildCuts.length).toBeGreaterThanOrEqual(8)
        const lengths = buildCuts.slice(1).map((c, i) => c - (buildCuts[i] as number))
        for (let i = 1; i < lengths.length; i++) expect(lengths[i], `shot ${i} grows`).toBeLessThanOrEqual(lengths[i - 1] as number)
        for (const c of buildCuts) expect(c % 3 === 0 || c % 5 === 0, `${c} off the grid`).toBe(true)
        for (const c of buildCuts.slice(1, -1)) {
          const [ax, ay, aw] = box(c - 1)
          const [bx, by, bw] = box(c)
          expect(Math.hypot(bx - ax, by - ay), `${c} chip moves across the cut`).toBeLessThan(0.025 * Math.min(W, H))
          expect(Math.abs(bw / aw - 1), `${c} the chip keeps its size across the cut`).toBeLessThan(0.03)
        }
        const [, , w0] = box(1)
        const [, , w1] = box(STOP - 1)
        expect(w1 / w0, 'the build pushes in').toBeGreaterThan(1.2)

        const rest = sampleShot(h.shots, (h.plan[POSTER + SETTLE]?.clone ?? 0) / h.total)
        expect(rest.tilt, 'the end looks low across the board').toBeGreaterThanOrEqual(1)
        const [ex, ey, ew] = box(h.frames - 1)
        expect([Math.abs(ex / W - 0.5) < 0.12, ey / H > 0.55 && ey / H < 0.8, ew > 0.5 * Math.min(W, H)], `the end holds the chip large, below the middle (${(ex / W).toFixed(2)}, ${(ey / H).toFixed(2)}, ${(ew / Math.min(W, H)).toFixed(2)})`).toEqual([true, true, true])
        for (let f = STOP; f < RELEASE; f++) {
          const p = sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total)
          expect([p.x, p.y, p.yaw, p.tilt].map((v) => v.toFixed(6)), `${f} the stop stands where the film ends`).toEqual([rest.x, rest.y, rest.yaw, rest.tilt].map((v) => v.toFixed(6)))
        }
        for (let f = POSTER + SETTLE; f < h.frames; f++) {
          const p = sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total)
          const before = sampleShot(h.shots, (h.plan[f - 1]?.clone ?? 0) / h.total)
          expect([p.x, p.y, p.yaw, p.tilt].map((v) => v.toFixed(6)), `${f} poster holds its place`).toEqual([rest.x, rest.y, rest.yaw, rest.tilt].map((v) => v.toFixed(6)))
          if (f > POSTER + SETTLE) expect(p.zoom, `${f} poster pushes in`).toBeGreaterThan(before.zoom)
        }
        const push = sampleShot(h.shots, (h.plan[h.frames - 1]?.clone ?? 0) / h.total).zoom / rest.zoom
        expect(push, 'the poster push is slow').toBeGreaterThan(1.01)
        expect(push).toBeLessThan(1.03)

        const title = h.words.find((w) => w.follow !== undefined && w.small !== true)
        if (title?.follow === undefined) throw new Error('no name behind the chip')
        expect(h.words.filter((w) => w.small !== true).map((w) => w.text.toUpperCase()).sort(), 'past the print lines of the build, the film letters the name and the revision, nothing else').toEqual(['BOARD', 'REV C3'])
        const far = project(camAt(h, h.frames - 1, W, H), title.follow.x, title.follow.y)
        const mid = [(far.x + 1) / 2 + title.x, (1 - far.y) / 2 + title.y] as const
        const cap = title.maxCap ?? 1
        expect(Math.abs(mid[0] - 0.5), 'the name is centred').toBeLessThan(0.01)
        expect(mid[1] - cap / 2, 'the name stands whole under the top edge, with room for the revision above it').toBeGreaterThan(0.06)
        expect((cap * H * 390) / W, 'the name reads at 390 px wide').toBeGreaterThanOrEqual(12)
        const crown = h.words.find((w) => w.crown === true)?.maxCap ?? 1
        expect(crown, 'the revision stands smaller than the name').toBeLessThanOrEqual(CROWN.most * cap)
        expect(mid[1] - cap / 2 - CROWN.rise * crown, 'at least 4% of the frame is clear above the revision').toBeGreaterThanOrEqual(0.04)
        if (W > H) expect(cap, 'in a landscape frame the name stands at most 0.14 of the frame high').toBeLessThanOrEqual(0.14)
        if (title.behind === true) expect(title.cover, 'behind the skyline, no letter of the name is more than 30% covered').toBeLessThanOrEqual(0.3)
        expect((mid[1] + cap / 2) * H, 'the name stands above the chip').toBeLessThan(ey - ew / 4)

        const streak = (f: number): number => {
          const pf = h.plan[f]
          if (pf === undefined) return 0
          const a = makeCam(sampleShot(h.shots, pf.clone / h.total), W, H)
          const b = makeCam(sampleShot(h.shots, (pf.clone + 0.5 * (pf.shut ?? 1)) / h.total), W, H)
          return Math.max(0, ...pts.map(([x, y]) => {
            const u = project(a, x, y)
            const v = project(b, x, y)
            return u.w > 0 && v.w > 0 && Math.abs(u.x) < 1 && Math.abs(u.y) < 1 ? Math.hypot(((u.x - v.x) * W) / 2, ((u.y - v.y) * H) / 2) : 0
          }))
        }
        for (let f = RELEASE; f < h.frames; f++) expect(streak(f), `${f} smears`).toBeLessThan(0.1 * W)
        for (const f of Array.from({ length: WHOLE[2] - WHOLE[1] }, (_, i) => WHOLE[1] + i)) expect(streak(f), `${f} the whole board is crisp`).toBeLessThan(0.004 * W)
        const g = h.glint
        expect([g.f0 > title.f0 + SETTLE, h.frames - g.f0 <= 21, (g.f0 - RELEASE) % 30 === 0, g.f1 <= h.frames, g.f1 - g.f0 >= 6], 'the end changes once: the highlight crosses the lid after the name is whole, in the last 0.7 s, a whole number of seconds after the hit').toEqual([true, true, true, true, true])
        expect([g.x, g.y, g.z], 'the highlight crosses the main chip\'s own lid').toEqual([hero.x, hero.y, hero.z])
        expect(Math.max(g.along, g.across)).toBeLessThanOrEqual(Math.max(hero.w, hero.h) + 1e-9)
        expect([g.peak >= 0.4, g.peak <= 0.5], 'the glint reads at 390 px and stays short of a flash (stills: 0.26 unread, 0.6 whitens the marking)').toEqual([true, true])
        const titled = title.f0
        expect(titled).toBeGreaterThanOrEqual(POSTER)
        expect(titled).toBeLessThanOrEqual(POSTER + SETTLE)
        expect(streak(titled), 'the name lands on a board that has resolved').toBeLessThan(0.03 * W)

        for (const c of h.cuts.filter((f) => f > RELEASE && f < POSTER)) {
          const before = motion(pts, camAt(h, c - 2, W, H), camAt(h, c - 1, W, H), W, H)
          const after = motion(pts, camAt(h, c, W, H), camAt(h, c + 1, W, H), W, H)
          const speed = Math.hypot(after.x, after.y)
          expect(speed, `${c} starts from rest`).toBeGreaterThan(0.004 * Math.min(W, H))
          expect((before.x * after.x + before.y * after.y) / Math.max(1e-9, Math.hypot(before.x, before.y) * speed), `${c} turns the motion`).toBeGreaterThan(0.5)
        }
      })
    }
  }
})

const boxMesh = (boxes: Array<[number, number, number, number, number, number]>): PartBodies['meshes'][number] => {
  const pos: number[] = []
  const idx: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const o = pos.length / 3
    for (const z of [z0, z1]) for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) pos.push(x, y, z)
    for (const t of [[4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]) idx.push(...t.map((k) => o + k))
  }
  const b64 = (a: ArrayBufferLike): string => Buffer.from(a).toString('base64')
  return { pos: b64(new Float32Array(pos).buffer), idx: b64(new Uint32Array(idx).buffer), nor: '', col: '', min: [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), 0], max: [Math.max(...boxes.map((b) => b[3])), Math.max(...boxes.map((b) => b[4])), Math.max(...boxes.map((b) => b[5]))] }
}

describe('the body the film draws', { timeout: 300_000 }, () => {
  it('is the model placed as the mesh shader places it at rest, else the part\'s box', () => {
    const mesh = boxMesh([[-1, -1, 0, 1, 1, 0.2], [0.6, 0.6, 0, 1, 1, 3]])
    const refs = boardModel('glasgow.kicad_pcb').footprints.map((f) => f.ref)
    const { s } = cutOf('glasgow.kicad_pcb', '4:5', { meshes: [mesh], byRef: Object.fromEntries(refs.map((r) => [r, 0])) })
    const worn = s.parts.find((p) => p.mesh !== undefined)
    if (worn?.mesh === undefined) throw new Error('no part wears the model')
    const [a, b, c, d] = worn.mesh.m
    const tris = drawnBody(s, worn)
    expect(tris.length, 'every triangle of the model').toBe(2 * 10 * 3)
    const top = tris.reduce((p, q) => (q[2] > p[2] ? q : p))
    expect(top[2], 'its top stands at the model\'s height').toBeCloseTo(3 * Math.hypot(a, b), 6)
    expect([top[0], top[1]].map((v) => v.toFixed(4)), 'the post stands where the shader puts it').toEqual([worn.x + a * 0.6 + c * 0.6, worn.y + b * 0.6 + d * 0.6].map((v) => v.toFixed(4)))
    const plain = cutOf('glasgow.kicad_pcb', '4:5').s.parts.find((p) => p.z > 0 && p.mesh === undefined)
    if (plain === undefined) throw new Error('no box part')
    const box = drawnBody(s, plain)
    expect([box.length, Math.max(...box.map((v) => v[2]))], 'a part with no model draws its box').toEqual([30, plain.z])
  })

  it('a name behind parts tucks against the bodies drawn, not their boxes: a thin post on a low slab does not hold the name up as a full-height box would', () => {
    const mesh = boxMesh([[-1, -1, 0, 1, 1, 0.2], [0.6, 0.6, 0, 1, 1, 3]])
    const refs = boardModel('glasgow.kicad_pcb').footprints.map((f) => f.ref)
    const { s, h, W, H } = cutOf('glasgow.kicad_pcb', '9:16', { meshes: [mesh], byRef: Object.fromEntries(refs.map((r) => [r, 0])) })
    const title = h.words.find((w) => w.follow !== undefined && w.small !== true)
    const hero = s.parts.find((p) => p.hero === true)
    if (title?.follow === undefined || hero === undefined) throw new Error('no name')
    const cam = makeCam(sampleShot(h.shots, (h.plan[POSTER + SETTLE]?.clone ?? 0) / h.total), W, H)
    const far = project(cam, title.follow.x, title.follow.y)
    const foot = (1 - far.y) / 2 + title.y + (title.maxCap ?? 0) / 2
    const near = project(cam, hero.x, hero.y).w / 2
    const tops = s.parts.filter((p) => p.z > 0).flatMap((p) => {
      const v = [0, p.z].flatMap((z) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, w]) => project(cam, p.x + (Math.cos(p.rot) * (u as number) * p.w - Math.sin(p.rot) * (w as number) * p.h) / 2, p.y + (Math.sin(p.rot) * (u as number) * p.w + Math.cos(p.rot) * (w as number) * p.h) / 2, z))).filter((q) => q.w > near)
      return v.length === 0 ? [] : [{ x0: Math.min(...v.map((q) => (q.x + 1) / 2)), x1: Math.max(...v.map((q) => (q.x + 1) / 2)), y0: Math.min(...v.map((q) => (1 - q.y) / 2)) }]
    })
    const xs = Array.from({ length: 41 }, (_, i) => 0.5 + (i / 40 - 0.5) * title.size)
    const deepest = Math.max(...xs.map((x) => foot - Math.min(1, ...tops.filter((t) => x >= t.x0 && x <= t.x1).map((t) => t.y0))))
    expect(deepest / (title.maxCap ?? 1), 'somewhere the name stands lower than the full-height boxes would let it').toBeGreaterThan(0.35)
  })
})

describe('a print\'s label', { timeout: 300_000 }, () => {
  for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
    it(`${name}: on every frame it shows, it stands whole inside the frame with a margin, or it is not drawn`, () => {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
        const { h, W, H } = cutOf(name, aspect)
        for (const w of h.words.filter((x) => x.small === true && x.inside !== true)) {
          const tall = (w.size * W) / H
          for (let f = w.f0; f < w.f1; f++) {
            expect([w.y - LABEL.over * tall >= LABEL.margin, w.y + LABEL.under * tall <= 1 - LABEL.margin], `${aspect} ${f}: "${w.text}" at ${w.y.toFixed(3)}`).toEqual([true, true])
          }
        }
      }
    })
  }
})

describe('a seat behind the parts', { timeout: 300_000 }, () => {
  it('is taken only where the name keeps 0.9 of the width it has in front; else the name stands in front at full width', () => {
    const mesh = boxMesh([[-1, -1, 0, 1, 1, 0.2], [0.6, 0.6, 0, 1, 1, 3]])
    const seats: string[] = []
    for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      const refs = boardModel(name).footprints.map((f) => f.ref)
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
        for (const bodies of [undefined, { meshes: [mesh], byRef: Object.fromEntries(refs.map((r) => [r, 0])) }]) {
          const title = cutOf(name, aspect, bodies).h.words.find((w) => w.follow !== undefined && w.small !== true)
          if (title === undefined) throw new Error('no name')
          seats.push(`${name} ${aspect} ${bodies === undefined ? 'boxes' : 'models'}: ${title.behind === true ? 'behind' : 'front'} ${title.size}`)
          expect(title.behind === true ? title.size >= BEHIND_KEEP * 0.92 : title.size === 0.92, seats.at(-1)).toBe(true)
        }
      }
    }
    expect(seats.some((s) => s.includes('behind')), 'some seats are still behind').toBe(true)
  })
})

describe('a print\'s dimensions and size line', { timeout: 300_000 }, () => {
  for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
    it(`${name}: on every frame each stands on clear paper, half its own height from every other mark and inside the frame's margin, measured from the box the print draws, or it is not drawn`, () => {
      let shown = 0
      const refs = boardModel(name).footprints.map((f) => f.ref)
      const wide = { meshes: [boxMesh([[-1.2, -1.2, 0, 1.2, 1.2, 0.3]])], byRef: Object.fromEntries(refs.map((r) => [r, 0])) }
      for (const [aspect, bodies] of (['16:9', '4:5', '9:16', '1:1'] as Aspect[]).flatMap((a) => [[a, undefined], [a, wide]] as const)) {
        const { s, h, W, H } = cutOf(name, aspect, bodies)
        const hero = s.parts.find((p) => p.hero === true) as TraceScene['parts'][number]
        const drawn = drawnBody(s, hero)
        const font = DIM_LABEL.size * Math.min(W, H)
        const inside = (b: TextBox): boolean => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([u, v]) => {
          const x = b.x + (u as number) * b.along * b.ux - (v as number) * b.across * b.uy
          const y = b.y + (u as number) * b.along * b.uy + (v as number) * b.across * b.ux
          return x >= LABEL.margin * W - 1e-6 && x <= (1 - LABEL.margin) * W + 1e-6 && y >= LABEL.margin * H - 1e-6 && y <= (1 - LABEL.margin) * H + 1e-6
        })
        for (const d of h.dims) {
          for (let f = d.f0; f < d.f1; f++) {
            if (h.plan[f]?.bare !== true) continue
            const cam = makeCam(sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total), W, H)
            const px = measuredBox(bodyOutline(h.glint, drawn, cam, W, H), d.corners.map((c) => ((q) => ({ x: ((q.x + 1) / 2) * W, y: ((1 - q.y) / 2) * H }))(project(cam, c.x, c.y))))
            const mid = { x: px.reduce((a, p) => a + p.x, 0) / 4, y: px.reduce((a, p) => a + p.y, 0) / 4 }
            const marks = printMarks(s, cam, W, H, printBand(px, W))
            for (const k of [0, 1]) {
              const at = d.shift[k]
              if (at === null || at === undefined) continue
              shown++
              const a = px[k] as { x: number; y: number }
              const b = px[k + 1] as { x: number; y: number }
              const len = Math.hypot(b.x - a.x, b.y - a.y)
              const cx = (a.x + b.x) / 2
              const cy = (a.y + b.y) / 2
              const nl = Math.hypot(cx - mid.x, cy - mid.y)
              const box: TextBox = { x: cx + ((b.x - a.x) / len) * at.along * len + ((cx - mid.x) / nl) * (DIM_LABEL.gap * W + at.out * font), y: cy + ((b.y - a.y) / len) * at.along * len + ((cy - mid.y) / nl) * (DIM_LABEL.gap * W + at.out * font), ux: (b.x - a.x) / len, uy: (b.y - a.y) / len, along: (CLEAR_TEXT.letter * font * (d.labels[k] as string).length) / 2 + 0.5 * font, across: font / 2 + 0.5 * font }
              expect(inside(box), `${aspect} f${f}: "${d.labels[k]}" inside the frame's margin`).toBe(true)
              expect(marks.filter((sg) => touches(sg, box)).length, `${aspect} f${f}: "${d.labels[k]}" clear of every mark`).toBe(0)
            }
            for (const w of h.words.filter((x) => x.small === true && x.inside !== true && f >= x.f0 && f < x.f1)) {
              shown++
              const size = Math.min(LABEL.size * W, (0.86 * W) / (CLEAR_TEXT.letter * w.text.length))
              const box: TextBox = { x: w.x * W, y: w.y * H, ux: 1, uy: 0, along: (CLEAR_TEXT.letter * size * w.text.length) / 2 + 0.5 * size, across: size / 2 + 0.5 * size }
              const chip = px.map((p, j): Seg => { const q = px[(j + 1) % 4] as { x: number; y: number }; return [p.x, p.y, q.x, q.y] })
              expect(inside(box), `${aspect} f${f}: "${w.text}" inside the frame's margin`).toBe(true)
              expect([...marks, ...chip].filter((sg) => touches(sg, box)).length, `${aspect} f${f}: "${w.text}" clear of every mark`).toBe(0)
            }
          }
        }
      }
      expect(shown, 'some are drawn').toBeGreaterThan(0)
    })
  }

  it('a silk word whole in the frame stays a mark even where the band touches it, so labels dodge it; a word the frame cuts is cleared whole', () => {
    const { s, h, W, H } = cutOf('glasgow.kicad_pcb', '4:5')
    const f = h.plan.findIndex((p) => p.bare === true)
    const cam = makeCam(sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total), W, H)
    const d = h.dims.find((x) => f >= x.f0 && f < x.f1) as HypeCut['dims'][number]
    const px = d.corners.map((c) => ((q) => ({ x: ((q.x + 1) / 2) * W, y: ((1 - q.y) / 2) * H }))(project(cam, c.x, c.y)))
    const inBand = printBand(px, W)
    const touched = s.texts.filter((t) => silkInBand(t, cam, W, H, inBand))
    expect(touched.filter((t) => silkWhole(t, cam)).map((t) => t.text), 'the words beside the chip').toEqual(expect.arrayContaining(['FPGA']))
    const marks = printMarks(s, cam, W, H, inBand).map((sg) => sg.map((v) => v.toFixed(3)).join(','))
    for (const t of touched) {
      const c = silkBox(t).map(([x, y]) => ((q) => [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H])(project(cam, x, y)))
      const edges = c.map((p, j): string => { const q = c[(j + 1) % 4] as number[]; return [p[0], p[1], q[0], q[1]].map((v) => (v as number).toFixed(3)).join(',') })
      expect(edges.every((e) => marks.includes(e)), `${t.text} is a mark`).toBe(silkWhole(t, cam))
    }
  })
})

describe('the band removes nothing the board owns', { timeout: 300_000 }, () => {
  it('every part, pad and word whole in the frame is kept and stays a mark however far the band reaches; one the frame cuts is not kept', () => {
    const { s, h, W, H } = cutOf('icebreaker.kicad_pcb', '9:16')
    const f = 122
    expect(h.plan[f]?.bare, 'f122 is a print').toBe(true)
    const cam = makeCam(sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total), W, H)
    const kept = printKept(s, cam, W, H)
    const parts = kept.filter((k) => k.kind === 'part')
    const inFrame = s.parts.filter((p) => p.z > 0 && p.hero !== true).filter((p) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([u, v]) => ((q) => Math.abs(q.x) <= 0.98 && Math.abs(q.y) <= 0.98)(project(cam, p.x + ((u as number) * p.w) / 2, p.y + ((v as number) * p.h) / 2))))
    expect(parts.length, 'the parts above the chip and the rest').toBeGreaterThanOrEqual(2)
    expect(parts.length).toBeLessThanOrEqual(inFrame.length + 2)
    for (const k of kept) expect(k.shape.every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H), 'whole in the frame').toBe(true)
    const marks = new Set(printMarks(s, cam, W, H, () => true).map((sg) => sg.join(',')))
    for (const k of kept) expect(k.segs.every((sg) => marks.has(sg.join(','))), 'a kept thing is a mark under any band').toBe(true)
    for (const box of kept.filter((k) => k.kind === 'word' || k.kind === 'pad')) {
      const [cx, cy] = box.shape.reduce(([a, b], [x, y]) => [a + x / box.shape.length, b + y / box.shape.length], [0, 0])
      expect(box.segs.some((sg) => touches(sg, { x: cx, y: cy, ux: 1, uy: 0, along: 0.5, across: 0.5 })), 'a label wholly inside a kept box still meets its marks').toBe(true)
    }
    expect(kept.some((k) => k.kind === 'stroke'), 'silk strokes are kept too').toBe(true)
    expect(kept.length, 'other pads are kept too').toBeGreaterThan(s.pads.filter((p) => p.hero !== true && seen(cam, p.x, p.y)).length / 2)
  })
})

describe('a kept word\'s letters', { timeout: 300_000 }, () => {
  it('are its box less half a letter all round, on the same centre', () => {
    const { s, h, W, H } = cutOf('glasgow.kicad_pcb', '4:5')
    const f = h.plan.findIndex((p) => p.bare === true)
    const cam = makeCam(sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total), W, H)
    const words = printKept(s, cam, W, H).filter((k) => k.kind === 'word')
    expect(words.length, 'FPGA and the rest').toBeGreaterThan(0)
    const whole = s.texts.filter((t) => silkWhole(t, cam))
    const area = (c: Array<[number, number]>): number => Math.abs(c.reduce((a, p, i) => { const q = c[(i + 1) % c.length] as [number, number]; return a + p[0] * q[1] - q[0] * p[1] }, 0)) / 2
    words.forEach((k, i) => {
      const t = whole[i] as TraceScene['texts'][number]
      const core = k.core as Array<[number, number]>
      expect(area(core) / area(k.shape), t.text).toBeCloseTo(t.text.length / (t.text.length + 1) / 1.8, 2)
      const mid = (c: Array<[number, number]>): number[] => c.reduce(([x, y], p) => [x + p[0] / 4, y + p[1] / 4], [0, 0])
      expect(Math.hypot((mid(core)[0] as number) - (mid(k.shape)[0] as number), (mid(core)[1] as number) - (mid(k.shape)[1] as number)), t.text).toBeLessThan(1e-6)
    })
  })
})

describe('every print names its chip and keeps one measure', { timeout: 300_000 }, () => {
  it('each print carries the chip\'s name and its size line, both in the chip\'s body, riding with the chip at its lid; the name makes no sound', () => {
    for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
        const { s, h } = cutOf(name, aspect)
        const hero = s.parts.find((p) => p.hero === true)
        if (hero?.label === undefined) throw new Error('no marking on the main chip')
        for (const d of h.dims) {
          const at = h.words.filter((w) => w.small === true && w.f0 < d.f1 && w.f1 > d.f0)
          const lines = at.filter((w) => w.name !== true)
          const names = at.filter((w) => w.name === true)
          expect([lines.length, names.length], `${name} ${aspect} print at f${d.f0}: one size line and one name`).toEqual([1, 1])
          const n = names[0] as HypeCut['words'][number]
          expect(n.text, 'the name is the chip\'s marking').toBe(hero.label)
          expect(n.size, 'larger than the size line').toBeGreaterThan((lines[0] as HypeCut['words'][number]).size)
          for (const w of [...lines, ...names]) expect([w.inside, w.follow?.x, w.follow?.y, w.follow?.z, w.x, w.y], `${name} ${aspect} f${d.f0}: "${w.text}" on the chip, at its lid`).toEqual([true, hero.x, hero.y, hero.z, 0, 0])
        }
        const typed = h.events.filter((e) => e.kind === 'type').map((e) => e.f).sort((a, b) => a - b)
        expect(typed, `${name} ${aspect}: one type for each word but the names`).toEqual(h.words.filter((w) => w.name !== true).map((w) => w.f0).sort((a, b) => a - b))
      }
    }
  })
})

describe('the main chip stands clear in the dark second and on the poster', { timeout: 600_000 }, () => {
  it('counts a body in front of the chip by its drawn triangles: a post over the lid covers it, the same post under the board or out at the frame\'s edge does not', () => {
    const { s, h, W, H } = cutOf('glasgow.kicad_pcb', '4:5')
    const hero = s.parts.find((q) => q.hero === true)
    if (hero === undefined) throw new Error('no main chip')
    const cam = camAt(h, 150, W, H)
    const post = (x: number, y: number, z0: number, z1: number): Array<[number, number, number]> => {
      const r = 0.08 * Math.max(hero.w, hero.h)
      const k = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
      const at = (i: number, z: number): [number, number, number] => [x + r * (k[i % 4] as readonly [number, number])[0], y + r * (k[i % 4] as readonly [number, number])[1], z]
      return [0, 1, 2, 3].flatMap((i) => [at(i, z0), at(i + 1, z0), at(i + 1, z1), at(i, z0), at(i + 1, z1), at(i, z1)])
    }
    const body = drawnBody(s, hero)
    expect(heroCovered(body, [post(hero.x, hero.y, hero.z * 1.2, hero.z * 6)], cam, W, H), 'a post over the lid').toBeGreaterThan(0)
    expect(heroCovered(body, [post(hero.x, hero.y, -6 * hero.z, -hero.z)], cam, W, H), 'the post under the board').toBe(0)
    expect(heroCovered(body, [post(hero.x + 40 * hero.w, hero.y, 0, hero.z * 6)], cam, W, H), 'the post far off').toBe(0)
  })

  it('kit-dev-coldfire 9:16, 1:1 and 4:5: no other body stands in front of the chip through the stop and the held poster', () => {
    for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
      const { s, h, W, H } = cutOf('kit-dev-coldfire-xilinx_5213.kicad_pcb', aspect)
      const hero = s.parts.find((q) => q.hero === true)
      if (hero === undefined) throw new Error('no main chip')
      const body = drawnBody(s, hero)
      const others = s.parts.filter((q) => q !== hero && q.z > 0).map((q) => drawnBody(s, q))
      const frames = h.plan.flatMap((p, f) => (p.grade === 'stop' && f % 5 === 0 ? [f] : [])).concat([POSTER, POSTER + 30, 300, 330, h.frames - 1])
      for (const f of frames) expect(heroCovered(body, others, camAt(h, f, W, H), W, H, 4), `${aspect} f${f}`).toBe(0)
    }
  })
})

describe('the release places', { timeout: 600_000 }, () => {
  it('a low close view whose far board edge runs behind the lens still counts as board when the outline is clipped at the camera', () => {
    const { h, W, H } = cutOf('icebreaker.kicad_pcb', '16:9')
    const cam = camAt(h, 230, W, H)
    const at = cam.pos
    const big = 1e5
    const rim = [at[0] - big, -at[1] - big, at[0] + big, -at[1] - big, at[0] + big, -at[1] + big, at[0] - big, -at[1] + big]
    expect(rim.some((_, i) => i % 2 === 0 && project(cam, rim[i] as number, rim[i + 1] as number).w <= 0), 'part of the outline lies behind the camera').toBe(true)
    expect(boardCover(rim, cam, true), 'clipped: the frame is all board').toBeGreaterThanOrEqual(0.9)
    expect(boardCover(rim, cam, false), 'unclipped: read as none').toBe(0)
  })

  it('glasgow: no detail place of the release shows silk whose words are an empty value (its maker\'s name is NULL)', () => {
    for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
      const { s, h, W, H } = cutOf('glasgow.kicad_pcb', aspect)
      const blanks = s.texts.filter((t) => EMPTY_VALUE.test(t.text))
      expect(blanks.map((t) => t.text), 'the board holds one').toContain('NULL')
      const from = h.cuts.find((f) => f > 200) ?? WHOLE[0]
      for (let f = from; f < WHOLE[0]; f++) for (const t of blanks) expect(seen(camAt(h, f, W, H), t.x, t.y), `${aspect} f${f} shows ${t.text}`).toBe(false)
    }
    for (const word of ['NULL', 'n/a', 'TBD', '?', 'mfr. by NULL']) expect(EMPTY_VALUE.test(word), word).toBe(true)
    for (const word of ['NULLA', 'ANALOG', 'FPGA', 'Rev ?A']) expect(EMPTY_VALUE.test(word), word).toBe(false)
  })
})

const ROUND7: Record<string, Array<[number, number, number]>> = {
  'glasgow.kicad_pcb 16:9': [[165, 854.9, 540], [194, 824.2, 593.2], [195, 1032.7, 582.0], [224, 1162.2, 396.0], [225, 1480.7, 569.9], [234, 1480.7, 520.9], [235, 445.3, 543.4], [244, 445.3, 592.5], [245, 510.3, 777.0], [254, 559.3, 777.0]],
  'glasgow.kicad_pcb 4:5': [[165, 475.1, 675], [194, 494.1, 715.8], [195, 672.5, 775.4], [224, 599.0, 638.5], [225, 861.5, 699.0], [234, 861.5, 659.7], [235, 391.7, 876.4], [244, 391.7, 847.9], [245, 941.2, 618.5], [254, 941.2, 601.5]],
  'glasgow.kicad_pcb 9:16': [[165, 475.1, 940.8], [194, 480.2, 998.6], [195, 682.1, 1041.3], [224, 673.7, 843.4], [225, 798.6, 964.8], [234, 798.6, 925.5], [235, 391.7, 1142.2], [244, 391.7, 1113.7], [245, 941.2, 881.9], [254, 941.2, 868.8]],
  'glasgow.kicad_pcb 1:1': [[165, 475.1, 540], [194, 480.3, 599.5], [195, 667.7, 642.3], [224, 666.2, 440.4], [225, 861.5, 564.0], [234, 861.5, 524.7], [235, 883.8, 425.8], [244, 905.6, 425.8]],
  'icebreaker.kicad_pcb 16:9': [[225, 851.9, 788.1], [239, 913.0, 788.1], [240, 463.4, 749.0], [254, 511.6, 749.0]],
  'icebreaker.kicad_pcb 4:5': [[165, 493, 675], [194, 515.4, 652.6], [195, 229.2, 671.6], [224, 401.5, 674.1], [225, 568.0, 789.0], [239, 568.0, 812.4], [240, 362.0, 794.1], [254, 380.7, 794.1]],
  'icebreaker.kicad_pcb 9:16': [[165, 493, 940.8], [194, 517.6, 916.2], [195, 229.7, 947.8], [224, 399.0, 950.5], [225, 517.8, 867.6], [234, 539.7, 867.6], [235, 502.3, 1012.2], [244, 535.2, 1012.2], [245, 609.6, 1090.1], [254, 609.6, 1108.4]],
  'icebreaker.kicad_pcb 1:1': [[165, 493, 540], [194, 514.9, 518.1], [195, 231.2, 529.1], [224, 399.0, 536.2], [225, 362.0, 659.1], [254, 382.0, 659.1]],
  'kit-dev-coldfire-xilinx_5213.kicad_pcb 16:9': [[165, 848.0, 612.3], [194, 848.0, 522.2], [195, 849.1, 425.1], [224, 1342.4, 424.9]],
  'kit-dev-coldfire-xilinx_5213.kicad_pcb 4:5': [[165, 460.6, 726.3], [194, 453.2, 706.0], [195, 548.7, 728.4], [224, 718.0, 663.2], [225, 717.2, 918.1], [234, 717.2, 889.3], [235, 415.8, 620.3], [244, 415.8, 594.2], [245, 757.3, 592.7], [254, 783.5, 592.7]],
  'kit-dev-coldfire-xilinx_5213.kicad_pcb 9:16': [[165, 460.6, 992.1], [194, 460.6, 956.2], [195, 689.4, 1031.9], [224, 885.0, 1030.0], [225, 308.4, 852.9], [234, 308.4, 824.1], [235, 401.4, 872.2], [244, 401.4, 846.1], [245, 284.3, 980.6], [254, 284.3, 951.8]],
  'kit-dev-coldfire-xilinx_5213.kicad_pcb 1:1': [[225, 785.8, 440.6], [239, 813.8, 440.6], [240, 461.8, 440.6], [254, 489.7, 440.6]]
}

describe('no word reads upside down in a release cut-in', { timeout: 900_000 }, () => {
  it('counts a word only whole in frame, in front of every body, and at least 14 px tall; a turned marking reads the other way', () => {
    const { s, h, W, H } = cutOf('glasgow.kicad_pcb', '4:5')
    const hero = s.parts.find((q) => q.hero === true)
    if (hero === undefined) throw new Error('no main chip')
    const at = s.parts.indexOf(hero)
    const cam = camAt(h, 150, W, H)
    const mark = boardWords(s).filter((w) => w.part === at)
    const open = bodyRaster([], cam, W, H)
    const plain = countedWords(mark, () => false, open, cam, W, H)
    const turned = countedWords(mark, () => true, open, cam, W, H)
    expect(plain.length, 'the marking counts on its own').toBe(1)
    expect(Math.abs(Math.abs((plain[0]?.lean ?? 0) - (turned[0]?.lean ?? 0)) - Math.PI), 'turned, it reads half a turn round').toBeLessThan(1e-9)
    const lid = (z: number): Array<[number, number, number]> => {
      const r = Math.max(hero.w, hero.h)
      const c: Array<[number, number, number]> = [[hero.x - r, hero.y - r, z], [hero.x + r, hero.y - r, z], [hero.x + r, hero.y + r, z], [hero.x - r, hero.y + r, z]]
      return [c[0], c[1], c[2], c[0], c[2], c[3]] as Array<[number, number, number]>
    }
    expect(countedWords(mark, () => false, bodyRaster([lid(3 * hero.z)], cam, W, H), cam, W, H), 'a body in front hides it').toEqual([])
    expect(countedWords(mark.map((w) => ({ ...w, tall: w.tall * (WORD_LEAST - 1) / (plain[0]?.tall ?? 1) })), () => false, open, cam, W, H), 'letters under 14 px do not count').toEqual([])
  })

  it('keeps a view that reads; else takes the turn with the most level word area, half a turn first on a tie', () => {
    expect(turnsFor(() => ({ ok: true, level: 0 }))).toEqual([0])
    expect(turnsFor((k) => ({ ok: k !== 0, level: Math.abs(k - Math.PI / 4) < 1e-9 ? 5 : 1 }))[0]).toBeCloseTo(Math.PI / 4, 9)
    expect(turnsFor((k) => ({ ok: k !== 0, level: 1 }))[0]).toBe(Math.PI)
    expect(turnsFor((k) => ({ ok: k === 0 ? false : Math.abs(k) < Math.PI / 4, level: 1 }))).toEqual([Math.PI / 8, -Math.PI / 8])
    expect(turnsFor(() => ({ ok: false, level: 1 }))).toEqual([])
  })

  for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
    it(`${name}: at the first, middle and last frame of every cut-in from f195 to the pull-back, no counted word leans more than 120° from level, and the main chip's marking, where its lid is in frame, no more than 80°`, () => {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
        const { s, h, W, H } = cutOf(name, aspect)
        const hero = s.parts.find((q) => q.hero === true)
        if (hero === undefined) throw new Error('no main chip')
        const at = s.parts.indexOf(hero)
        const words = boardWords(s)
        const solids = s.parts.filter((q) => q.z > 0).map((q) => drawnBody(s, q))
        const cuts = [...h.cuts.filter((f) => f >= 195 && f < WHOLE[0]), WHOLE[0]]
        for (const [i, f0] of cuts.slice(0, -1).entries()) {
          const f1 = (cuts[i + 1] as number) - 1
          for (const f of [f0, Math.round((f0 + f1) / 2), f1]) {
            const cam = camAt(h, f, W, H)
            const got = countedWords(words, (k) => h.turns[k] === true, bodyRaster(solids, cam, W, H), cam, W, H)
            expect(got.filter((g) => Math.abs(g.lean) > FLIPPED).map((g) => g.word.text), `${aspect} f${f}`).toEqual([])
            const c = project(cam, hero.x, hero.y, hero.z)
            if (c.w > 0 && Math.abs(c.x) < 1 && Math.abs(c.y) < 1) {
              const d = h.turns[at] === true ? -1 : 1
              const m = hero.w >= hero.h ? { x: Math.cos(hero.rot), y: Math.sin(hero.rot) } : { x: -Math.sin(hero.rot), y: Math.cos(hero.rot) }
              const q = project(cam, hero.x + d * m.x, hero.y + d * m.y, hero.z)
              expect(Math.abs(Math.atan2((q.y - c.y) * H, (q.x - c.x) * W)), `${aspect} f${f} marking`).toBeLessThanOrEqual(MARK_LEAN + 1e-9)
            }
          }
        }
      }
    })
  }

  it('leaves every release shot that reads where it stood: the first and last frame of each, as cut before the rule (box bodies)', () => {
    for (const [film, frames] of Object.entries(ROUND7)) {
      const [name, aspect] = film.split(' ') as [string, Aspect]
      const { h } = cutOf(name, aspect)
      for (const [f, x, y] of frames) {
        const p = sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total)
        expect([Math.abs(p.x - x) < 0.1, Math.abs(p.y - y) < 0.1], `${film} f${f}`).toEqual([true, true])
      }
    }
  })
})

describe('no release place stands on one plain block', { timeout: 900_000 }, () => {
  it('counts the frame the largest body with no model and no marking fills in front: a block over the view counts, the same block with a marking does not, a marked part in front of it hides it, and two plain blocks count only the larger', () => {
    const { s: sc, h, W, H } = cutOf('glasgow.kicad_pcb', '4:5')
    const cam = camAt(h, 150, W, H)
    const hero = sc.parts.find((q) => q.hero === true)
    if (hero === undefined) throw new Error('no main chip')
    const box = (r: number, z0: number, z1: number, dx = 0): Array<[number, number, number]> => {
      const k = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
      const at = (i: number, z: number): [number, number, number] => [hero.x + dx + r * (k[i % 4] as readonly [number, number])[0], hero.y + r * (k[i % 4] as readonly [number, number])[1], z]
      return [at(0, z1), at(1, z1), at(2, z1), at(0, z1), at(2, z1), at(3, z1), ...[0, 1, 2, 3].flatMap((i) => [at(i, z0), at(i + 1, z0), at(i + 1, z1), at(i, z0), at(i + 1, z1), at(i, z1)])]
    }
    const block = box(Math.max(hero.w, hero.h), 0, hero.z)
    expect(plainMost([{ body: block, plain: true }], cam, W, H), 'a plain block across the view').toBeGreaterThan(0.1)
    expect(plainMost([{ body: block, plain: false }], cam, W, H), 'the same block, marked').toBe(0)
    expect(plainMost([{ body: block, plain: true }, { body: box(1.1 * Math.max(hero.w, hero.h), 0, 2 * hero.z), plain: false }], cam, W, H), 'a marked body in front').toBe(0)
    const apart = box(0.4 * Math.max(hero.w, hero.h), 0, hero.z, 1.6 * Math.max(hero.w, hero.h))
    const alone = [plainMost([{ body: block, plain: true }], cam, W, H), plainMost([{ body: apart, plain: true }], cam, W, H)]
    expect(Math.min(...alone), 'the second block is in view').toBeGreaterThan(0)
    expect(plainMost([{ body: block, plain: true }, { body: apart, plain: true }], cam, W, H), 'two plain blocks apart: the larger alone, not their sum').toBe(Math.max(...alone))
  })

  for (const name of ['glasgow.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
    it(`${name}: no detail place of the release but round 7's own has one plain block over PLAIN_MOST of its frame at its first or last frame`, () => {
      for (const aspect of ['16:9', '4:5', '9:16', '1:1'] as Aspect[]) {
        const { s, h, W, H } = cutOf(name, aspect)
        const bodies = s.parts.filter((q) => q.z > 0).map((q) => ({ body: drawnBody(s, q), plain: q.mesh === undefined && q.label === undefined }))
        const cuts = [...h.cuts.filter((f) => f >= 225 && f < WHOLE[0]), WHOLE[0]]
        for (const [i, f0] of cuts.slice(0, -1).entries()) {
          if (ROUND7[`${name} ${aspect}`]?.some(([f]) => f === f0) === true) continue
          for (const f of [f0, (cuts[i + 1] as number) - 1]) expect(plainMost(bodies, camAt(h, f, W, H), W, H), `${aspect} f${f}`).toBeLessThanOrEqual(PLAIN_MOST + 0.01)
        }
      }
    })
  }
})

describe('the poster keeps its clock', { timeout: 900_000 }, () => {
  it('holds the light under the poster where the unturned cut put it, however many places the release cuts to: the same clock as before the turns on every demo film', () => {
    const seen = ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb'].flatMap((name) => (['16:9', '4:5', '9:16', '1:1'] as Aspect[]).map((aspect) => `${name} ${aspect} ${cutOf(name, aspect).h.plan[POSTER]?.clone}`))
    expect(seen).toEqual([
      'glasgow.kicad_pcb 16:9 4982', 'glasgow.kicad_pcb 4:5 7149', 'glasgow.kicad_pcb 9:16 4982', 'glasgow.kicad_pcb 1:1 9576',
      'icebreaker.kicad_pcb 16:9 4981', 'icebreaker.kicad_pcb 4:5 4981', 'icebreaker.kicad_pcb 9:16 4982', 'icebreaker.kicad_pcb 1:1 4980',
      'kit-dev-coldfire-xilinx_5213.kicad_pcb 16:9 4980', 'kit-dev-coldfire-xilinx_5213.kicad_pcb 4:5 4982', 'kit-dev-coldfire-xilinx_5213.kicad_pcb 9:16 4982', 'kit-dev-coldfire-xilinx_5213.kicad_pcb 1:1 4981'
    ])
  })
})
