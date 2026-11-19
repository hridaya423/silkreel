import { describe, expect, it } from 'vitest'
import { sampleShot } from './camera'
import { compileTimeline } from '../compile'
import type { FilmConfig, PlotScore, TraceTimeline } from '../types'
import { boardModel } from '../../test/helpers'
import { ASPECT_SIZE } from '../layout'
import { RIDE_CLOSE, SIGNAL_WIDE, nameFloor, TURN_AT, SHEET_PUSH, inkAcross, nameStrip, entryOf, frequency, headerPins, keyLines, keySize, planDims, pairedRun, panelArea, plotClock, plotPlanOf, signalPins, SHEET_KEY, SHEET_TEXT, sheetUnit, sheetTitleSpan, stackTitle, axoPoint, nameSet, stampBox, CLOSE_E, CHIP_HIDE, POSTER_E, POSTER_SLACK, chipCover, CAP, NAME_SPACING, stripCells, titleLines, TITLE_READ, SECTION_TITLE, END_STROKE, plotFrame } from './plot-shots'
import type { PlanInk } from './plot-shots'
import type { BoardModel } from '@silk-reel/ingest'

const film = (name: string, extra: Partial<FilmConfig> = {}): TraceTimeline => {
  const tl = compileTimeline(boardModel(name), { style: 'plot', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, ...extra })
  if (tl.style === 'glyph') throw new Error('expected a plot timeline')
  return tl
}

const score = (tl: TraceTimeline): PlotScore => {
  if (tl.scene.plot === undefined) throw new Error('plot score missing')
  return tl.scene.plot
}

const cutHeld = (p: PlotScore): number => (p.section?.t.gone ?? 0) - (p.section === undefined ? 0 : (p.section.t.gone - p.section.t.whole) / 2)

const BOARDS = ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'StickHub.kicad_pcb', 'ecc83-pp.kicad_pcb', 'video.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']

const ASPECTS = ['4:5', '1:1', '9:16', '16:9'] as const

describe('blueprint score', () => {
  const compileBoard = (board: BoardModel): TraceTimeline => {
    const tl = compileTimeline(board, { style: 'plot', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, title: { name: 'Board' } })
    if (tl.style === 'glyph') throw new Error('expected a plot timeline')
    return tl
  }

  it('reads a board from its file, never its name: a renamed copy compiles to the identical timeline', () => {
    for (const name of BOARDS) {
      const board = boardModel(name)
      const renamed: BoardModel = { ...structuredClone(board), source: { ...board.source, boardName: 'renamed-copy.kicad_pcb' } }
      expect(JSON.stringify(compileBoard(renamed).scene.plot), name).toBe(JSON.stringify(compileBoard(board).scene.plot))
    }
  }, 600000)

  it('names a valve socket, found by its pins on a circle, from its value and description', () => {
    const board = boardModel('ecc83-pp.kicad_pcb')
    expect(score(compileBoard(board)).marks[0]).toMatchObject({ text: 'ECC83', sub: 'U1 · VALVE' })
    const other: BoardModel = { ...structuredClone(board), footprints: board.footprints.map((f) => (f.ref === 'U1' ? { ...f, value: '12AU7', descr: undefined } : f)) }
    expect(score(compileBoard(other)).marks[0]).toMatchObject({ text: '12AU7', sub: 'U1 · SOCKET' })
    expect(score(compileBoard(board)).hero.subject).toMatch(/^9 PINS ON Ø\d+\.\d MM$/)
  }, 60000)

  it('gives every board a sheet of its own, chosen from its data: the macro subject, the detail subject, the copper panel, the sheet size and the title-block fields', () => {
    const seen = BOARDS.map((name) => {
      const p = score(film(name))
      const fields = p.sheet.cells.flat().map(([k]) => k).join('/')
      const sheet = p.facts.sheet
      return [p.bus.kind, p.hero.subject?.replace(/[\d.Ø]+/g, '#') ?? '', stackTitle(p), sheet, fields].join(' | ')
    })
    expect(new Set(seen).size, seen.join('\n')).toBe(BOARDS.length)
  }, 600000)

  it('opens on a drawing in progress: some of the first shot already inked, never more than half, and the hand moving in it', () => {
    const bad: string[] = []
    for (const name of BOARDS) {
      for (const aspect of ASPECTS) {
        const tl = film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const p = score(tl)
        if (p.film.shots[0]?.kind !== 'open') continue
        const pts = (st: { path: number[] }): Array<[number, number]> => Array.from({ length: st.path.length / 2 }, (_, i) => [st.path[2 * i] as number, st.path[2 * i + 1] as number])
        const end = (p.film.shots[0] as { t1: number }).t1
        const shot = p.nib.strokes.filter((st) => st.t0 <= end)
        const len = (st: { path: number[] }): number => pts(st).slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - (pts(st)[i] as [number, number])[0], q[1] - (pts(st)[i] as [number, number])[1]), 0)
        const inked = p.nib.strokes.filter((st) => st.t0 < 0)
        const cover = inked.reduce((a, st) => a + len(st), 0) / p.nib.strokes.reduce((a, st) => a + len(st), 0)
        if (inked.length === 0 || cover > 0.5) bad.push(`${name} ${aspect} frame 0 inks ${(cover * 100).toFixed(0)}% of the opening`)
        if (!shot.some((st) => st.t0 >= 0 && st.t0 < end)) bad.push(`${name} ${aspect} the hand never moves in shot 1`)
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('draws every parallel trace the bus frame holds', () => {
    const bad: string[] = []
    for (const name of BOARDS) {
      for (const aspect of ASPECTS) {
        const size = ASPECT_SIZE[aspect]
        const tl = film(name, { aspect, output: { ...size, fps: 30 } })
        const p = score(tl)
        const macro = p.film.shots.find((q) => q.kind === 'macro')
        if (p.bus.kind !== 'bundle' || macro === undefined) continue
        const f = p.bus.strokes[0]
        if (f === undefined) continue
        const dl = Math.hypot((f.path[2] as number) - (f.path[0] as number), (f.path[3] as number) - (f.path[1] as number))
        const d = [((f.path[2] as number) - (f.path[0] as number)) / dl, ((f.path[3] as number) - (f.path[1] as number)) / dl] as const
        const off = (x: number, y: number): number => -d[1] * x + d[0] * y
        const drawn = p.bus.strokes.map((st) => off(st.path[0] as number, st.path[1] as number))
        const across = [...drawn].sort((a, b) => a - b)
        const gaps = across.slice(1).map((q, i) => q - (across[i] as number)).sort((a, b) => a - b)
        const pitch = gaps[Math.floor(gaps.length / 2)] ?? 0
        const c = sampleShot(tl.scene.shots, macro.t1 - 0.5 / 24)
        const inFrame = (x: number, y: number): boolean => {
          const sx = c.zoom * (Math.cos(c.yaw) * (x - c.x) - Math.sin(c.yaw) * (y - c.y))
          const sy = c.zoom * (Math.sin(c.yaw) * (x - c.x) + Math.cos(c.yaw) * (y - c.y))
          return Math.abs(sx) < size.width / 2 && Math.abs(sy) < size.height / 2
        }
        const side = tl.scene.layers.some((l) => l.side === 'F' && l.segs.length > 0) ? 'F' : 'B'
        for (const l of tl.scene.layers.filter((k) => k.side === side)) {
          for (let i = 0; i + 6 < l.segs.length; i += 7) {
            const [ax, ay, bx, by, w] = l.segs.slice(i, i + 5) as [number, number, number, number, number]
            const L = Math.hypot(bx - ax, by - ay)
            if (L < 0.25 * dl || Math.abs((bx - ax) * d[0] + (by - ay) * d[1]) / L < 0.9976) continue
            if (!inFrame(ax, ay) || !inFrame(bx, by)) continue
            const al = (x: number, y: number): number => d[0] * x + d[1] * y
            const span = p.bus.strokes.flatMap((st) => [al(st.path[0] as number, st.path[1] as number), al(st.path[2] as number, st.path[3] as number)])
            const overlap = Math.min(Math.max(...span), Math.max(al(ax, ay), al(bx, by))) - Math.max(Math.min(...span), Math.min(al(ax, ay), al(bx, by)))
            const o = off((ax + bx) / 2, (ay + by) / 2)
            if (overlap < Math.max(0.25 * dl, 2.5 * tl.scene.material.pxPerMm) || o < Math.min(...drawn) - 5 * pitch || o > Math.max(...drawn) + 5 * pitch) continue
            if (!drawn.some((q) => Math.abs(q - o) < Math.max(w, 0.5))) bad.push(`${name} ${aspect} misses a parallel trace at ${o.toFixed(1)}`)
          }
        }
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('starts every half-beat on a whole frame and runs the clock forward', () => {
    for (const total of [360, 300, 361]) {
      for (let k = 0; k <= 48; k++) {
        const f = Math.floor((k * total) / 48 + 0.5)
        expect(plotClock(f, total) * 48, `${total} half-beat ${k}`).toBeCloseTo(k, 9)
      }
      for (let f = 1; f <= total; f++) expect(plotClock(f, total)).toBeGreaterThan(plotClock(f - 1, total))
    }
  }, 60000)

  it('draws every hero as a box except the ECC83 valve, which is a cylinder', () => {
    for (const name of BOARDS) {
      const tl = film(name)
      const plot = score(tl)
      const hero = tl.scene.parts.find((p) => p.hero === true)
      if (hero === undefined) throw new Error(`${name}: no hero part`)
      const round = hero.kind === 'valve' || hero.kind === 'can' || plot.round.some(([x, y]) => Math.hypot(x - hero.x, y - hero.y) < 0.3 * Math.min(hero.w, hero.h))
      expect(round, name).toBe(name.startsWith('ecc83'))
    }
  }, 60000)

  it('takes its revision from the config, else the silk, else the title block, and invents none', () => {
    expect(score(film('glasgow.kicad_pcb')).facts.version).toBe('C3')
    expect(score(film('glasgow.kicad_pcb', { title: { name: 'Glasgow', version: 'revD' } })).facts.version).toBe('revD')
    expect(score(film('icebreaker.kicad_pcb')).facts.version).toBe('V1.0e')
    expect(score(film('kit-dev-coldfire-xilinx_5213.kicad_pcb')).facts.version).toBe('2')
    expect(score(film('StickHub.kicad_pcb')).facts.version).toBe('v1.4.0')
    expect(score(film('ecc83-pp.kicad_pcb')).facts.version).toBeUndefined()
    expect(score(film('icebreaker.kicad_pcb')).facts.name).toBe('iCEBreaker')
    expect(score(film('kit-dev-coldfire-xilinx_5213.kicad_pcb')).facts.name).toBe('kit dev coldfire xilinx 5213')
  }, 60000)

  it('names every layer the same normalised way, with its plain role, and reads a plane by its pour', () => {
    const glasgow = score(film('glasgow.kicad_pcb')).stack
    expect(glasgow.map((l) => l.name)).toEqual(['F.CU', 'IN1.CU', 'IN2.CU', 'B.CU'])
    expect(glasgow[1]?.role).toBe('GND PLANE')
    expect(score(film('StickHub.kicad_pcb')).stack.map((l) => l.name)).toEqual(['B.CU', 'F.CU'])
    for (const name of BOARDS) {
      for (const l of score(film(name)).stack) {
        expect(l.name, name).toMatch(/^(F|B|IN\d+)\.CU$/)
        expect(l.role, name).not.toMatch(/_/)
      }
    }
  }, 60000)

  it('finds power where it comes in: the USB host plug, the USB connector, the jack', () => {
    expect(entryOf(boardModel('StickHub.kicad_pcb'), undefined)?.ref).toBe('J1')
    expect(entryOf(boardModel('icebreaker.kicad_pcb'), undefined)?.ref).toBe('P1')
    expect(entryOf(boardModel('glasgow.kicad_pcb'), undefined)?.ref).toBe('J1')
    expect(entryOf(boardModel('kit-dev-coldfire-xilinx_5213.kicad_pcb'), undefined)?.ref).toBe('J201')
  })

  it('lands the film callouts one a half-beat apart once the parts are down, all of them sheet callouts', () => {
    for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'StickHub.kicad_pcb']) {
      const p = score(film(name))
      expect(p.marks.length).toBeGreaterThanOrEqual(1)
      expect(p.marks.length).toBeLessThanOrEqual(6)
      const first = (p.marks[0] as { t: number }).t * 24
      expect(first).toBeGreaterThanOrEqual(p.beats.parts)
      p.marks.forEach((m, i) => { expect(m.t * 24).toBeCloseTo(first + 0.5 * i, 9) })
      const onSheet = p.sheet.callouts.map((c) => p.features[c.item])
      for (const m of p.marks) expect(onSheet.some((f) => f !== undefined && f.text === m.text && f.sub === m.sub && f.x === m.x && f.y === m.y && f.z === m.z), m.text).toBe(true)
    }
  }, 600000)

  it('opens mid-stroke where a film opens on its fan-out: the hand is on a stroke at frame 0, at most 30% of the routing round the hero already inked, and the hand inks only shot 1', () => {
    const len = (path: number[]): number => Array.from({ length: path.length / 2 - 1 }, (_, i) => Math.hypot((path[2 * i + 2] as number) - (path[2 * i] as number), (path[2 * i + 3] as number) - (path[2 * i + 1] as number))).reduce((a, b) => a + b, 0)
    for (const name of BOARDS) {
      const { nib, bus, film: f } = score(film(name))
      if (f.shots[0]?.kind !== 'open' || f.plan === 'stick') continue
      const drawn = nib.strokes.filter((st) => st.t1 < 0).reduce((t, st) => t + len(st.path), 0)
      const all = nib.strokes.reduce((t, st) => t + len(st.path), 0)
      expect(drawn / all, name).toBeLessThanOrEqual(0.3)
      const hand = nib.strokes.filter((st) => st.pen === true).sort((a, b) => a.t0 - b.t0)
      expect(hand[0]?.t0, name).toBeLessThan(0)
      expect(hand[0]?.t1, name).toBeGreaterThan(0)
      expect(Math.max(...hand.map((st) => st.t1)) * 24, name).toBeLessThanOrEqual((f.shots[0] as { t1: number }).t1 * 24)
      expect([...bus.strokes, ...bus.sweep].some((st) => st.pen === true), name).toBe(false)
    }
  }, 600000)

  it('opens on a drawing in progress: a stroke of the first shot mid-way on frame 0, and a travelling film never opens on the chip', () => {
    for (const name of ['video.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb', 'glasgow.kicad_pcb']) {
      const p = score(film(name))
      expect(p.film.shots[0]?.kind, name).not.toBe('open')
      if (p.film.shots[0]?.kind === 'outline' && p.film.signature.kind !== 'pair') expect(p.flow.path.some((s) => s.p0 <= 0 && s.p1 > 0), name).toBe(true)
      else if (p.film.shots[0]?.kind !== 'signature' || p.film.signature.kind === 'pair') expect(p.bus.strokes.some((s) => s.t0 < 0 && s.t1 > 0), name).toBe(true)
    }
  }, 60000)

  it('reads a crystal by its frequency', () => {
    expect(frequency('12MHz 50ppm 16pF')).toBe('12 MHZ')
    expect(frequency('24M')).toBe('24 MHZ')
    expect(frequency('32.768kHz')).toBe('32.768 KHZ')
    expect(frequency('ABM8 crystal')).toBe('ABM8')
  })

  it('schedules every drilled hole by diameter, the counts summing to the board\'s drill hits', () => {
    for (const name of BOARDS) {
      const board = boardModel(name)
      const holes = score(film(name)).facts.holes
      expect(holes.reduce((t, h) => t + h.count, 0), name).toBe(board.drill.length)
      for (const h of holes) expect(board.drill.filter((d) => Math.abs(Math.round(d.dia * 100) / 100 - h.dia) < 1e-9).length, `${name} Ø${h.dia}`).toBe(h.count)
      expect([...holes].sort((a, b) => a.dia - b.dia), name).toEqual(holes)
    }
    expect(score(film('glasgow.kicad_pcb')).facts.holes.find((h) => h.dia === 1)?.count).toBe(43)
  }, 60000)

  it('counts a connector\'s pins as its distinct signal pad numbers, mounting and shield pads left out', () => {
    for (const name of BOARDS) {
      const board = boardModel(name)
      const plot = score(film(name))
      const pads = Object.values(board.copper).flatMap((c) => c.pads)
      for (const m of plot.features) {
        const n = /(\d+) PINS/.exec(m.sub)?.[1]
        if (n === undefined) continue
        const first = m.text.split(' ')[0] ?? ''
        const ref = board.footprints.find((f) => f.ref === first)?.ref ?? board.footprints.find((f) => f.value === m.text)?.ref ?? ''
        expect(Number(n), `${name} ${m.text}`).toBe(signalPins(pads.filter((p) => p.footprintRef === ref)))
      }
    }
    const video = boardModel('video.kicad_pcb')
    const pads = Object.values(video.copper).flatMap((c) => c.pads)
    const j4 = pads.filter((p) => p.footprintRef === 'J4')
    expect(signalPins(j4)).toBeLessThanOrEqual(9)
    expect(signalPins([{ ...j4[0], num: 'MH', netId: 1 }, { ...j4[0], num: '1', netId: 1 }, { ...j4[0], num: '1', netId: 1 }, { ...j4[0], num: '2', netId: undefined }] as typeof j4)).toBe(1)
  }, 60000)

  it('draws the plan over 60% of its panel\'s drawing area along the limiting side, on every aspect whose panel draws one (the renderer letters one fact in a panel under 2.2 times the sheet\'s floor)', () => {
    for (const name of BOARDS) {
      for (const aspect of ASPECTS) {
        const size = ASPECT_SIZE[aspect]
        const tl = film(name, { aspect, output: { ...size, fps: 30 } })
        const { sheet } = score(tl)
        const at = sheet.planAt
        const r = at.r ?? 0
        const xs: number[] = []
        const ys: number[] = []
        for (const l of tl.scene.board) for (let i = 0; i + 1 < l.length; i += 2) {
          const x = l[i] as number
          const y = l[i + 1] as number
          xs.push(at.s * (Math.cos(r) * x - Math.sin(r) * y) + at.x)
          ys.push(at.s * (Math.sin(r) * x + Math.cos(r) * y) + at.y)
        }
        const pa = panelArea(sheet.plan, size.width, size.height, titleLines('PLAN', Math.abs(Math.cos(r + (score(tl).facts.turned ? Math.PI / 2 : 0))) < 0.1 ? ['TURNED 90°'] : [], sheet.plan.w, size.width, size.height).length)
        if (!planDims(pa, 2.2 * sheetUnit(size.width, size.height))) continue
        const fill = Math.max((Math.max(...xs) - Math.min(...xs)) / pa.w, (Math.max(...ys) - Math.min(...ys)) / pa.h)
        expect(fill, `${name} ${aspect}`).toBeGreaterThanOrEqual(0.6)
      }
    }
  }, 600000)

  it('keeps the sheet\'s callout dots apart', () => {
    for (const name of BOARDS) {
      const tl = film(name)
      const plot = score(tl)
      const sheet = plot.sheet
      const features = sheet.callouts.map((c) => plot.features[c.item]).filter((f) => f !== undefined)
      expect(features.length, `${name} ${plot.features.map((f) => f.text).join(', ')}`).toBe(plot.features.length)
      const v = sheet.iso
      const proj = (f: { x: number; y: number; z?: number | undefined }): [number, number] => {
        const dx = f.x - v.mx
        const dy = f.y - v.my
        return [v.x + v.k * (Math.cos(v.psi) * dx - Math.sin(v.psi) * dy), v.y + v.k * (Math.sin(v.e) * (Math.sin(v.psi) * dx + Math.cos(v.psi) * dy) - Math.cos(v.e) * (f.z ?? 0))]
      }
      const ha = panelArea(sheet.hero, 1080, 1350)
      for (let i = 0; i < features.length; i++) for (let j = i + 1; j < features.length; j++) {
        const a = proj(features[i] as PlotScore['features'][number])
        const b = proj(features[j] as PlotScore['features'][number])
        expect(Math.hypot(a[0] - b[0], a[1] - b[1]), `${name} ${features[i]?.text} / ${features[j]?.text}`).toBeGreaterThanOrEqual(0.04 * Math.min(ha.w, ha.h) - 1e-6)
      }
    }
  }, 600000)

  it('defaults to cyanotype stock and leaves the trace film without a plot score', () => {
    expect(film('glasgow.kicad_pcb').palette.id).toBe('cyanotype')
    expect(film('glasgow.kicad_pcb', { palette: 'paper' }).palette.id).toBe('paper')
    const trace = compileTimeline(boardModel('glasgow.kicad_pcb'), { style: 'trace', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } })
    if (trace.style === 'glyph') throw new Error('expected trace')
    expect(trace.scene.plot).toBeUndefined()
  }, 30000)

})

describe('blueprint round 11: one film per board', () => {
  const kinds = (p: PlotScore): string => p.film.shots.map((s) => s.kind).join(' ')
  it('reads the archetype the trace film reads, and gives each archetype its own signature and its own order of middle shots', () => {
    const seen = new Map<string, PlotScore>()
    for (const name of BOARDS) {
      const plot = score(film(name))
      const trace = compileTimeline(boardModel(name), { style: 'trace', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } })
      expect(plot.film.archetype, name).toBe('scene' in trace ? trace.scene.character?.archetype : undefined)
      seen.set(plot.film.archetype, plot)
    }
    expect(seen.size).toBe(5)
    const list = [...seen.values()]
    for (const [i, a] of list.entries()) {
      for (const b of list.slice(i + 1)) {
        expect(a.film.signature.kind, `${a.film.archetype} ${b.film.archetype}`).not.toBe(b.film.signature.kind)
        if (a.film.shots[0]?.kind !== 'outline' || b.film.shots[0]?.kind !== 'outline') expect(kinds(a), `${a.film.archetype} ${b.film.archetype}`).not.toBe(kinds(b))
      }
    }
  }, 300000)

  it('makes the travel the longest shot of a film that travels, else the object, and opens it on a shot of at least 0.9 s, no two neighbouring shots the same length, and holds the end at most 1.5 s', () => {
    for (const name of BOARDS) {
      for (const aspect of ASPECTS) {
        const tl = film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const shots = score(tl).film.shots
        const len = (s: { t0: number; t1: number }): number => (s.t1 - s.t0) * (tl.totalFrames / 30)
        const sig = shots.find((s) => s.kind === 'outline') ?? shots.find((s) => s.kind === 'assembly')
        if (sig === undefined) throw new Error('no longest shot')
        expect(len(shots[0] as typeof sig), `${name} ${aspect} opening`).toBeGreaterThanOrEqual(0.9)
        for (const s of shots) if (s !== sig) expect(len(s), `${name} ${aspect} ${s.kind}`).toBeLessThan(len(sig))
        shots.slice(1).forEach((s, i) => { expect(Math.abs(len(s) - len(shots[i] as typeof s)), `${name} ${aspect} ${s.kind}`).toBeGreaterThan(0.01) })
        expect(len(shots.at(-1) as typeof sig), `${name} ${aspect} hold`).toBeLessThanOrEqual(1.5)
      }
    }
  }, 600000)

  it('letters the name once, complete at least 1 s before the end, and stamps the sheet last, on a beat, with at most 1.5 s after it', () => {
    for (const name of BOARDS) {
      for (const aspect of ASPECTS) {
        const tl = film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const p = score(tl)
        const secs = tl.totalFrames / 30
        const title = p.events.find((e) => e.kind === 'title')
        const stamp = p.events.find((e) => e.kind === 'stamp')
        if (title === undefined || stamp === undefined) throw new Error('no title or stamp')
        expect(p.events.filter((e) => e.kind === 'title'), `${name} ${aspect} one title`).toHaveLength(1)
        expect(title.t0 * 24, `${name} ${aspect} the name waits for the pull`).toBeGreaterThanOrEqual(p.beats.pull[1])
        sheetTitleSpan(p.sheet).forEach((b, i) => { expect(Math.abs((i === 0 ? title.t0 : title.t1) * 24 - b), `${name} ${aspect} span ${i}`).toBeLessThanOrEqual(24 / tl.totalFrames) })
        expect((1 - title.t1) * secs, `${name} ${aspect} title`).toBeGreaterThanOrEqual(TITLE_READ - 1e-6)
        expect(Math.max(...p.events.map((e) => e.t1)), `${name} ${aspect} last`).toBeLessThanOrEqual(stamp.t0 + 1e-9)
        expect(Math.abs(stamp.t0 * 24 - Math.round(stamp.t0 * 24)), `${name} ${aspect} on a beat`).toBeLessThan(0.02)
        expect((1 - stamp.t0) * secs, `${name} ${aspect} after the stamp`).toBeLessThanOrEqual(1.5)
      }
    }
  }, 600000)

  it('ends close and low on every board: the view at the close elevation (raised to one of POSTER_E only when a pin covers more of the main chip\'s lid there than CHIP_HIDE and POSTER_SLACK), the board cropped by the frame unless the main chip stands over a quarter of the frame high, the whole main chip in frame, and the name and the stamp on paper the board does not reach', () => {
    for (const name of BOARDS) {
      for (const aspect of ASPECTS) {
        const tl = film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const p = score(tl)
        const { width: W, height: H } = ASPECT_SIZE[aspect]
        const v = p.sheet.iso
        const coveredLow = chipCover({ ...v, e: CLOSE_E }, tl.scene.parts, 40) > CHIP_HIDE + POSTER_SLACK
        if (coveredLow) expect(POSTER_E.some((e) => Math.abs(e - v.e) < 1e-9), `${name} ${aspect} raised elevation`).toBe(true)
        else expect(v.e, `${name} ${aspect} elevation`).toBeCloseTo(CLOSE_E, 9)
        const edge = tl.scene.board.flatMap((l) => Array.from({ length: l.length / 2 }, (_, i) => axoPoint(v, [l[2 * i] as number, l[2 * i + 1] as number], 0)))
        const chip = tl.scene.parts.find((q) => q.hero === true)
        if (chip === undefined) throw new Error('no main chip')
        const [cx, cy] = axoPoint(v, [chip.x, chip.y], 0)
        const lid = axoPoint(v, [chip.x, chip.y], chip.z)[1]
        expect(edge.some(([x, y]) => x < 0 || x > W || y < 0 || y > H) || cy - lid > 0.25 * H, `${name} ${aspect} cropped`).toBe(true)
        expect(cx > 0.1 * W && cx < 0.9 * W && cy < 0.9 * H && lid > 0, `${name} ${aspect} chip in frame`).toBe(true)
        const set = { lines: p.sheet.name.lines, size: p.sheet.name.size, w: Math.max(...p.sheet.name.lines.map((l) => l.length)) * p.sheet.name.size * (0.66 + NAME_SPACING) }
        expect(p.sheet.name.lines, `${name} ${aspect} lines`).toEqual(nameSet(p.facts.name, W, H).lines)
        const top = p.sheet.name.y - CAP * set.size
        const mark = p.facts.version !== undefined ? `REV ${p.facts.version.replace(/^rev\.?\s*/i, '').toUpperCase()}` : p.facts.date
        const box = mark === undefined ? { w: 0, h: 0 } : stampBox(mark, p.sheet.name.stampSize)
        const right = Math.max(p.sheet.name.x + set.w, p.sheet.name.stamp[0] + box.w / 2)
        expect(p.sheet.name.x, `${name} ${aspect} left`).toBeGreaterThan(0)
        expect(right, `${name} ${aspect} right`).toBeLessThan(W)
        expect(p.sheet.name.y, `${name} ${aspect} bottom`).toBeLessThan(H)
        expect(edge.filter(([x, y]) => x > p.sheet.name.x && x < right && y > top && y < H), `${name} ${aspect} board under the name`).toHaveLength(0)
      }
    }
  }, 600000)

  it('sets a name large: one line of at least 9% of the short side and at most 20%, else two lines broken between words, never wider than 60% of the frame or the room it is given', () => {
    const short = nameSet('Glasgow', 1920, 1080)
    expect(short.lines).toEqual(['GLASGOW'])
    expect(short.size).toBeCloseTo(0.2 * 1080, 6)
    expect(nameSet('Glasgow', 1920, 1080, 600).w).toBeCloseTo(600, 6)
    const long = nameSet('KIT DEV COLDFIRE XILINX 5213', 1080, 1350)
    expect(long.lines).toHaveLength(2)
    expect(long.lines.join(' ')).toBe('KIT DEV COLDFIRE XILINX 5213')
    expect(Math.abs((long.lines[0] as string).length - (long.lines[1] as string).length)).toBeLessThanOrEqual(8)
    for (const set of [short, long]) expect(set.w).toBeLessThanOrEqual(0.6 * (set === short ? 1920 : 1080) + 1e-6)
  })

  it('tells one story: a board with a signal route has no supply stations; otherwise the power path stops at two to six stations from the file, reaches one a shot from the entry, and times boards with different station counts differently', () => {
    const sheets = new Map<number, string>()
    for (const name of BOARDS) {
      const p = score(film(name))
      const st = p.film.stations
      if ((p.film.plan !== 'card' && p.film.plan !== 'dense') || p.object.trail.length > 0) {
        expect(st, name).toEqual([])
        continue
      }
      if (st.length === 0) {
        expect(p.film.shots.map((s) => s.kind), `${name} finds no supply path in its file`).not.toContain('detail')
        continue
      }
      expect(st.length, name).toBeGreaterThanOrEqual(2)
      expect(st.length, name).toBeLessThanOrEqual(6)
      expect(st[0]?.text.startsWith('POWER IN'), name).toBe(true)
      const shotAt = (t: number): number => p.film.shots.findIndex((s) => t >= s.t0 && t < s.t1)
      st.slice(1).forEach((s, i) => { expect(shotAt(s.t), `${name} ${s.text}`).toBeGreaterThan(shotAt((st[i] as typeof s).t)) })
      expect(p.film.shots[shotAt(st.at(-1)?.t ?? 0)]?.kind, name).toBe('detail')
      sheets.set(st.length, p.film.shots.map((s) => s.t0.toFixed(4)).join(','))
    }
    const counts = [...sheets]
    counts.forEach(([n, sheet], i) => { for (const [m, other] of counts.slice(i + 1)) expect(sheet, `${n} and ${m} stations`).not.toBe(other) })
  }, 300000)
})

describe('blueprint round 12: no template', () => {
  it('opens each slice film on its one thing: the pair, the section, the headers\' travel, the chip', () => {
    const first: Record<string, string> = { 'glasgow.kicad_pcb': 'signature', 'ecc83-pp.kicad_pcb': 'signature', 'icebreaker.kicad_pcb': 'outline', 'StickHub.kicad_pcb': 'open' }
    for (const [name, kind] of Object.entries(first)) {
      const p = score(film(name))
      expect(p.film.shots[0]?.kind, name).toBe(kind)
      expect(p.film.sentence.length, name).toBeGreaterThan(0)
      expect(p.film.stations, name).toEqual([])
    }
    expect(score(film('glasgow.kicad_pcb')).film.sentence).toBe('A PAIR TO J5. 16 SIGNALS TO J2, J3.')
    expect(score(film('ecc83-pp.kicad_pcb')).film.sentence).toMatch(/9 PINS/)
    expect(score(film('ecc83-pp.kicad_pcb')).film.shots.map((q) => q.kind)).not.toContain('outline')
  }, 600000)

  it('rides the main part\'s widest connector bus only when a route stop is reached through two or more chips, and says what the ride shows', () => {
    const ride = (name: string): [string, string] => ((p) => [p.object.route.join('>'), p.film.sentence] as [string, string])(score(film(name)))
    expect(ride('glasgow.kicad_pcb')).toEqual(['J5>U17>RN10>J2>U27>RN3>J3', 'A PAIR TO J5. 16 SIGNALS TO J2, J3.'])
    expect(ride('kit-dev-coldfire-xilinx_5213.kicad_pcb')).toEqual(['MCU_PORT201', '51 SIGNALS FROM MCF5213 TO MCU_PORT201.'])
    expect(ride('video.kicad_pcb')).toEqual(['BUS1', '51 SIGNALS FROM BUS1 TO S5933.'])
  }, 600000)

  it('counts a pin header footprint as a connector, and leaves a bus another chip drives off the main part\'s ride', () => {
    const p = score(film('kit-dev-coldfire-xilinx_5213.kicad_pcb'))
    expect(p.object.route).toContain('MCU_PORT201')
    expect(p.object.route.some((r) => /^U\d/.test(r) && r !== 'U102')).toBe(false)
    expect(p.film.sentence).not.toMatch(/P30[123]/)
  }, 600000)

  const SLICE = [['icebreaker.kicad_pcb', '4:5'], ['glasgow.kicad_pcb', '16:9'], ['StickHub.kicad_pcb', '9:16'], ['ecc83-pp.kicad_pcb', '4:5']] as const
  const body = (tl: TraceTimeline): number[] => score(tl).film.shots.slice(1).filter((s) => s.t0 < score(tl).beats.pull[0] / 24 && s.kind !== 'tilt' && s.kind !== 'assembly').map((s) => Math.round(s.t0 * tl.totalFrames))

  it('before the shared pull to the sheet, shares at most one cut within 3 frames between any two slice films', () => {
    const films = SLICE.map(([name, aspect]) => ({ name, tl: film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } }) }))
    for (const [i, a] of films.entries()) {
      for (const b of films.slice(i + 1)) {
        const tag = `${a.name} ${b.name}`
        const ca = body(a.tl)
        const cb = body(b.tl)
        expect(ca.filter((f) => cb.some((g) => Math.abs(f - g) <= 3)).length, tag).toBeLessThanOrEqual(1)
      }
    }
  }, 300000)

  it('films a header board\'s pairs only when they run longer than its largest header\'s row, read from the copper', () => {
    expect(plotPlanOf('leds', 100, 20)).toBe('pair')
    expect(plotPlanOf('leds', 40, 20)).toBe('header')
    const glasgow = boardModel('glasgow.kicad_pcb')
    const ice = boardModel('icebreaker.kicad_pcb')
    expect(pairedRun(glasgow)).toBeGreaterThan(2.54 * headerPins(glasgow))
    expect(pairedRun(ice)).toBeLessThanOrEqual(2.54 * headerPins(ice))
    expect(score(film('glasgow.kicad_pcb')).film.plan).toBe('pair')
    expect(score(film('icebreaker.kicad_pcb')).film.plan).toBe('header')
  }, 300000)

  it('draws the object straight after the tilt, with no layer stack in any film', () => {
    for (const name of BOARDS) {
      const kinds = score(film(name)).film.shots.map((s) => s.kind)
      expect(kinds, name).not.toContain('stack')
      expect(kinds[kinds.indexOf('tilt') + 1], name).toBe('assembly')
    }
  }, 300000)
})

describe('blueprint round 20: a long name', () => {
  it('letters the dev kit\'s full name on its sheet in every aspect', () => {
    for (const aspect of ASPECTS) {
      const p = score(film('kit-dev-coldfire-xilinx_5213.kicad_pcb', { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } }))
      const { width: W, height: H } = ASPECT_SIZE[aspect]
      const room = p.sheet.title.w - 2 * Math.max(0.018 * Math.min(W, H), 0.8 * SHEET_TEXT * sheetUnit(W, H))
      expect(keyLines(p.facts.name, room, W, H, p.sheet.title.h).join(' '), aspect).toBe(p.facts.name.toUpperCase())
    }
  }, 600000)

  it('wraps a long name onto two lines at the key size, shrinks only when two lines will not fit, never below the label size', () => {
    const su = sheetUnit(1080, 1350)
    expect(keySize('GLASGOW', 400, 1080, 1350)).toBe(SHEET_KEY * su)
    for (const [name, w] of [['COLDFIRE XILINX DEV KIT', 400], ['KIT DEV COLDFIRE XILINX 5213', 400], ['A VERY LONG BOARD NAME WITH MANY WORDS', 320]] as const) {
      const lines = keyLines(name, w, 1080, 1350)
      const size = keySize(name, w, 1080, 1350)
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.join(' ')).toBe(name)
      expect(size).toBeGreaterThanOrEqual(SHEET_TEXT * su)
      if (lines.length > 2) expect(size).toBe(SHEET_TEXT * su)
    }
    expect(keyLines('COLDFIRE XILINX DEV KIT', 640, 1080, 1350)).toEqual(['COLDFIRE', 'XILINX DEV KIT'])
    expect(keySize('COLDFIRE XILINX DEV KIT', 640, 1080, 1350)).toBe(SHEET_KEY * su)
    expect(keyLines('COLDFIRE XILINX DEV KIT', 530, 1080, 1350)).toHaveLength(2)
    expect(keySize('COLDFIRE XILINX DEV KIT', 530, 1080, 1350)).toBeLessThan(SHEET_KEY * su)
  })

  it('keeps SIDE and REV in the strip by cutting the name at a word break first', () => {
    const fields: Array<[string, string]> = [['DRAWING', 'KIT DEV COLDFIRE XILINX 5213'], ['SIDE', 'TOP'], ['REV', '2']]
    const row = stripCells(fields, 1000, 1)
    expect(row.map(([c]) => c)).toEqual(['DRAWING', 'SIDE', 'REV'])
    expect('KIT DEV COLDFIRE XILINX 5213'.startsWith(row[0]?.[1] ?? '-')).toBe(true)
    expect(row[0]?.[1]).not.toBe('KIT DEV COLDFIRE XILINX 5213')
    expect(stripCells([['DRAWING', 'GLASGOW'], ['SIDE', 'TOP'], ['REV', 'C3']], 1000, 1)).toEqual([['DRAWING', 'GLASGOW'], ['SIDE', 'TOP'], ['REV', 'C3']])
  })
})

describe('blueprint fix round 1: the approved drawing, a camera that stays close', () => {
  const glasgow = (): { tl: TraceTimeline; p: PlotScore } => {
    const tl = film('glasgow.kicad_pcb', { aspect: '16:9', output: { ...ASPECT_SIZE['16:9'], fps: 30 } })
    return { tl, p: score(tl) }
  }

  it('carries no pen, lamp or ride in any board\'s score, and no pen or lamp event', () => {
    for (const name of BOARDS) {
      const p = score(film(name))
      expect(Object.keys(p), name).not.toContain('ride')
      expect(Object.keys(p), name).not.toContain('lamp')
      expect(p.events.map((e) => e.kind as string), name).not.toContain('pen')
      expect(p.events.map((e) => e.kind as string), name).not.toContain('lamp')
    }
  }, 600000)

  it('starts every stroke inside the film and ends none: strokes only grow to their end', () => {
    const { p } = glasgow()
    const strokes = [...p.nib.strokes, ...p.bus.strokes, ...p.bus.sweep]
    for (const st of strokes) expect(st.t1).toBeGreaterThanOrEqual(st.t0)
    for (const sg of [...p.flow.path, ...p.object.trail]) expect(sg.p1).toBeGreaterThanOrEqual(sg.p0)
  })

  it('keeps the camera flat (tilt 0) on every key, with one turn into the drawing, late', () => {
    const { tl, p } = glasgow()
    expect(tl.scene.shots.every((k) => k.tilt === 0)).toBe(true)
    expect(p.film.shots.filter((q) => q.kind === 'tilt')).toHaveLength(1)
    const section = p.film.shots.find((q) => q.kind === 'section')
    expect(section?.t0 ?? 0).toBeLessThanOrEqual(TURN_AT / 24)
    expect(p.beats.tilt[0]).toBeCloseTo((section?.t1 ?? 0) * 24, 9)
    expect(p.beats.tilt[0]).toBeGreaterThanOrEqual(TURN_AT - 1)
    expect((p.beats.tilt[1] - p.beats.tilt[0]) * (tl.totalFrames / 30 / 24)).toBeGreaterThanOrEqual(1)
    expect(p.events.filter((e) => e.kind === 'tilt').map((e) => [e.t0 * 24, e.t1 * 24])).toEqual([p.beats.tilt])
  })

  it('draws section A–A after the fan-out of every film that travels: each copper layer of the file in order, drawn on over about 0.8 s, whole at least 1.2 s before the turn, its sounds inside that span, and its via posts far enough apart for a phone', () => {
    for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ASPECTS) {
        const tl = film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const p = score(tl)
        const sc = p.section
        const ink = p.ink
        if (sc === undefined || ink === undefined) throw new Error(`${name} ${aspect}: no section`)
        const secs = tl.totalFrames / 30
        const fanned = ink.fan.t + ink.fan.round + (ink.fan.r - ink.fan.r0) / ink.fan.v
        const tag = `${name} ${aspect}`
        expect(sc.layers.map((l) => l.name), tag).toEqual(p.stack.map((l) => l.name))
        expect(sc.t.line[0], tag).toBeGreaterThanOrEqual(fanned - 1e-9)
        expect((sc.t.whole - sc.t.line[0]) * secs, tag).toBeGreaterThanOrEqual(0.7)
        expect((sc.t.whole - sc.t.line[0]) * secs, tag).toBeLessThanOrEqual(0.9)
        expect((p.beats.tilt[0] / 24 - sc.t.whole) * secs, tag).toBeGreaterThanOrEqual(1.2 - 1e-6)
        const own = p.events.filter((e) => e.text === 'section' || e.text === SECTION_TITLE || sc.layers.some((l) => l.name === e.text))
        expect(own.length, tag).toBeGreaterThanOrEqual(sc.layers.length + 3)
        for (const e of own) expect(e.t0 >= sc.t.line[0] - 1e-9 && e.t1 <= sc.t.whole + 1e-9, `${tag} ${e.kind} ${e.text ?? ''}`).toBe(true)
        const W = tl.width
        const H = tl.height
        const z = ((nameStrip(W, H).y - 0.012 * Math.min(W, H)) / H) * sampleShot(tl.scene.shots, sc.t.line[0]).zoom
        sc.posts.slice(1).forEach((t, i) => { expect((t - (sc.posts[i] as number)) * z, tag).toBeGreaterThanOrEqual(26 * (Math.min(W, H) / 1080) - 1e-6) })
      }
    }
  }, 600000)

  it('ends the cutting line inside the frame the section is drawn in, outside the section\'s span, with its "A" and arrow where they fit and a short end stroke turned toward the view where they do not, and no part\'s footprint nor the yellow signal under either', () => {
    for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ASPECTS) {
        const tl = film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const p = score(tl)
        const sc = p.section
        if (sc === undefined) throw new Error(`${name} ${aspect}: no section`)
        const u = Math.min(tl.width, tl.height) / 1080
        const z = ((nameStrip(tl.width, tl.height).y - 0.012 * Math.min(tl.width, tl.height)) / tl.height) * sampleShot(tl.scene.shots, sc.t.line[0]).zoom
        const nrm = [-sc.dir[1], sc.dir[0]]
        const parts = tl.scene.parts.filter((q) => q.kind !== 'pin')
        const yellow = [...p.bus.strokes.flatMap((st) => Array.from({ length: st.path.length / 2 }, (_, i): [number, number] => [st.path[2 * i] as number, st.path[2 * i + 1] as number])), ...p.flow.path.flatMap((g) => Array.from({ length: 9 }, (_, i): [number, number] => [g.a[0] + (i / 8) * (g.b[0] - g.a[0]), g.a[1] + (i / 8) * (g.b[1] - g.a[1])]))]
        sc.line.forEach((end, k) => {
          const out = k === 0 ? -1 : 1
          const mark = sc.marks[k] === true
          const tag = `${name} ${aspect} end ${out}${mark ? ' mark' : ' stroke'}`
          expect(Math.abs(end), tag).toBeGreaterThanOrEqual(sc.half - 1e-9)
          expect(Math.abs(end) * z + (mark ? 1.25 * sc.size : END_STROKE * u), tag).toBeLessThanOrEqual(tl.width / 2 + 1e-6)
          const ink: Array<[number, number]> = mark ? [
            ...Array.from({ length: 9 }, (_, i): [number, number] => [end, (52 * u * i) / 8 / z]),
            ...[-10, 10].map((dx): [number, number] => [end + (dx * u) / z, (30 * u) / z]),
            ...[-0.35, 0, 0.35].flatMap((dx) => [-0.8, -0.45, -0.1].map((dy): [number, number] => [end - (out * 0.75 * sc.size) / z + (dx * sc.size) / z, (dy * sc.size) / z]))
          ] : Array.from({ length: 7 }, (_, i): [number, number] => [end, (END_STROKE * u * i) / 6 / z])
          for (const [a, s2] of ink) {
            const x = sc.at[0] + a * sc.dir[0] + s2 * (nrm[0] as number)
            const y = sc.at[1] + a * sc.dir[1] + s2 * (nrm[1] as number)
            const under = parts.find((q) => {
              const [dx, dy] = [x - q.x, y - q.y]
              return Math.abs(Math.cos(q.rot) * dx + Math.sin(q.rot) * dy) <= q.w / 2 && Math.abs(-Math.sin(q.rot) * dx + Math.cos(q.rot) * dy) <= q.h / 2
            })
            expect(under === undefined, `${tag}: a part lies under it`).toBe(true)
            expect(yellow.some((q) => Math.hypot(q[0] - x, q[1] - y) * z < 2 * u), `${tag}: the signal lies on it`).toBe(false)
          }
        })
      }
    }
  }, 900000)

  it('lays the section\'s panel where the frame holds it beside the chip with none of the yellow signal under it, when such a place exists, and keeps the push moving on every frame until the turn', () => {
    for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ASPECTS) {
        const tl = film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } })
        const p = score(tl)
        const sc = p.section
        if (sc === undefined) throw new Error(`${name} ${aspect}: no section`)
        const tag = `${name} ${aspect}`
        const [a0, s0, a1, s1] = sc.panel
        const local = (q: [number, number]): [number, number] => [(q[0] - sc.at[0]) * sc.dir[0] + (q[1] - sc.at[1]) * sc.dir[1], -(q[0] - sc.at[0]) * sc.dir[1] + (q[1] - sc.at[1]) * sc.dir[0]]
        const yellow = [...p.bus.strokes.flatMap((st) => Array.from({ length: st.path.length / 2 }, (_, i): [number, number] => [st.path[2 * i] as number, st.path[2 * i + 1] as number])), ...p.flow.path.flatMap((g) => Array.from({ length: 33 }, (_, i): [number, number] => [g.a[0] + (i / 32) * (g.b[0] - g.a[0]), g.a[1] + (i / 32) * (g.b[1] - g.a[1])]))].map(local)
        if (!sc.over) expect(yellow.filter(([a, b]) => a > a0 && a < a1 && b > s0 && b < s1).length, `${tag}: the signal under the panel`).toBe(0)
        const f0 = Math.ceil(plotFrame(sc.t.whole, tl.totalFrames))
        const f1 = Math.round(plotFrame(p.shots.object[0], tl.totalFrames))
        const still: number[] = []
        for (let f = f0 + 1; f < f1; f++) {
          const [x, y] = [sampleShot(tl.scene.shots, plotClock(f - 1, tl.totalFrames)), sampleShot(tl.scene.shots, plotClock(f, tl.totalFrames))]
          if ((Math.abs(x.x - y.x) + Math.abs(x.y - y.y)) * y.zoom + (Math.abs(x.zoom - y.zoom) / y.zoom) * tl.width < 0.05) still.push(f)
        }
        expect(still.filter((f) => f >= Math.round(plotFrame(cutHeld(p), tl.totalFrames)) + 2), `${tag}: the push stops before the turn`).toEqual([])
      }
    }
  }, 900000)

  it('gives a film with a section the end of a film without one: the name stands at least 1.5 s and the stamp at least 0.9 s, and Glasgow\'s tilt still on beat 16', () => {
    for (const name of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      const tl = film(name, { aspect: '16:9', output: { ...ASPECT_SIZE['16:9'], fps: 30 } })
      const p = score(tl)
      const secs = tl.totalFrames / 30
      const title = p.events.find((e) => e.kind === 'title')
      const stamp = p.events.find((e) => e.kind === 'stamp')
      if (title === undefined || stamp === undefined) throw new Error(`${name}: no title or stamp`)
      expect((1 - title.t1) * secs, name).toBeGreaterThanOrEqual(1.5)
      expect((1 - stamp.t0) * secs, name).toBeGreaterThanOrEqual(0.9)
      expect(Math.max(...p.events.map((e) => e.t0)), name).toBe(stamp.t0)
      if (name === 'glasgow.kicad_pcb') expect(p.beats.tilt[0], name).toBe(16)
    }
  }, 300000)

  it('cuts a two-layer board with no via on the cut into its two layers and no posts, and hides only its back copper', () => {
    const b = boardModel('icebreaker.kicad_pcb')
    const two = { ...b, copper: Object.fromEntries(Object.entries(b.copper).filter(([k]) => k === 'F.Cu' || k === 'B.Cu').map(([k, c]) => [k, { ...c, vias: [] }])), layers: b.layers.filter((l) => !/^In\d/.test(l.id)) }
    const p = score(compileTimeline(two, { style: 'plot', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, title: { name: 'Board' } }) as TraceTimeline)
    expect(p.stack.map((l) => l.name)).toEqual(['F.CU', 'B.CU'])
    expect(p.section?.layers.map((l) => l.name)).toEqual(['F.CU', 'B.CU'])
    expect(p.section?.posts).toEqual([])
    expect(p.hidden?.map((h) => h.layer)).toEqual(['B.CU'])
  }, 120000)

  it('sinks the main chip\'s hidden wiring by each layer\'s true depth, every line starting in the last half beat before the turn and growing out from the chip into it', () => {
    const { tl, p } = glasgow()
    const hidden = p.hidden ?? []
    expect(hidden.map((h) => h.layer)).toEqual(p.stack.slice(1).filter((l) => l.layer >= 0).map((l) => l.name))
    hidden.slice(1).forEach((h, i) => { expect(h.depth).toBeGreaterThan((hidden[i] as typeof h).depth) })
    expect(Math.max(...hidden.map((h) => h.depth))).toBeCloseTo(tl.scene.material.thicknessPx, 3)
    const t0s = hidden.flatMap((h) => h.segs.filter((_, i) => i % 6 === 4))
    const t1s = hidden.flatMap((h) => h.segs.filter((_, i) => i % 6 === 5))
    expect(t0s.length).toBeGreaterThan(0)
    expect(Math.min(...t0s) * 24).toBeCloseTo(p.beats.tilt[0] - 0.5, 5)
    expect(Math.max(...t1s) * 24).toBeGreaterThan(p.beats.tilt[0])
    expect(p.events.filter((e) => e.text === 'hidden')).toHaveLength(1)
  })

  it('names the main chip by its part number', () => {
    expect(glasgow().p.hero.label).toBe('ICE40HX8K')
  })

  it('fans the chip\'s signals out one after another round the chip for 1.5 to 2 s, after one still beat and up to the turn', () => {
    const { p } = glasgow()
    const ink = p.ink
    if (ink === undefined) throw new Error('expected an ink clock')
    const grow = (ink.fan.r - ink.fan.r0) / ink.fan.v
    expect((ink.hold[1] - ink.hold[0]) * 24).toBeCloseTo(1, 5)
    expect(ink.fan.round).toBeGreaterThan(grow)
    expect((ink.fan.round + grow) * 12).toBeGreaterThanOrEqual(1.5)
    expect((ink.fan.round + grow) * 12).toBeLessThanOrEqual(2)
    expect((ink.fan.t + ink.fan.round + grow) * 24).toBeLessThanOrEqual(p.beats.tilt[0] + 1e-9)
  })

  it('names the main chip by its part number alone, in a wide frame and in a tall one', () => {
    for (const [name, part] of [['kit-dev-coldfire-xilinx_5213.kicad_pcb', 'MCF5213'], ['video.kicad_pcb', 'S5933']] as const) {
      for (const aspect of ['16:9', '4:5'] as const) {
        const p = score(film(name, { aspect, output: { ...ASPECT_SIZE[aspect], fps: 30 } }))
        expect(p.hero.label, `${name} ${aspect}`).toBe(part)
      }
    }
  }, 600000)

  it('draws the pair toward the chip while the camera travels, its tip landing as the camera lands, and opens with its first lines mostly drawn', () => {
    const { p } = glasgow()
    const ink = p.ink
    const travel = p.film.shots.find((q) => q.kind === 'outline')
    if (ink === undefined || travel === undefined) throw new Error('expected a travel with an ink clock')
    const inTravel = p.bus.strokes.filter((st) => st.t0 >= travel.t0)
    expect(inTravel.length, 'strokes the travel draws').toBeGreaterThan(10)
    expect(Math.max(...p.bus.strokes.map((st) => st.t1)) * 24).toBeCloseTo(ink.hold[0] * 24, 0)
    for (const tl of [film('glasgow.kicad_pcb', { aspect: '16:9', output: { ...ASPECT_SIZE['16:9'], fps: 30 } })]) {
      const first = score(tl).bus.strokes.reduce((x, y) => (y.t0 < x.t0 ? y : x))
      expect(-first.t0 / (first.t1 - first.t0), 'drawn at frame 0').toBeGreaterThanOrEqual(0.6)
    }
  })

  it('counts the ink that crosses a box: a line through it or within the margin, a disc that reaches it, and nothing that passes clear', () => {
    const ink = { lines: [{ a: [0, 5], b: [20, 5], w: 1 }, { a: [0, 30], b: [20, 30], w: 1 }, { a: [-4, -10], b: [-4, 40], w: 2 }] as PlanInk['lines'], discs: [{ x: 15, y: 15, r: 3 }, { x: 40, y: 40, r: 3 }] }
    expect(inkAcross({ x: 2, y: 2, w: 10, h: 10 }, ink, 0)).toBe(1)
    expect(inkAcross({ x: 2, y: 2, w: 10, h: 10 }, ink, 2)).toBe(2)
    expect(inkAcross({ x: 2, y: 2, w: 10, h: 10 }, ink, 6)).toBe(3)
    expect(inkAcross({ x: 2, y: 12, w: 10, h: 10 }, { lines: ink.lines, discs: [] }, 0)).toBe(0)
  })

  it('draws its ending to within a second of the last frame, the stamp last', () => {
    const { p } = glasgow()
    const stamp = p.events.find((e) => e.kind === 'stamp')
    expect(p.events.at(-1)?.kind).toBe('stamp')
    expect((1 - (stamp?.t0 ?? 0)) * 12).toBeLessThanOrEqual(1.05)
    expect((1 - (stamp?.t0 ?? 0)) * 12).toBeGreaterThanOrEqual(0.5 - 1e-9)
    expect(SHEET_PUSH).toBeGreaterThan(1.005)
    expect(SHEET_PUSH).toBeLessThanOrEqual(1.06)
  })

  it('sets the title sheet\'s name at least 40% of the frame\'s width in 9:16 and 4:5 and 30% in 16:9 and 1:1, larger than the stamp, with the stamp beside or under it', () => {
    const NAMES: Record<string, string> = { 'glasgow.kicad_pcb': 'Glasgow', 'icebreaker.kicad_pcb': 'iCEBreaker', 'kit-dev-coldfire-xilinx_5213.kicad_pcb': 'ColdFire Xilinx Dev Kit' }
    for (const [file, name] of Object.entries(NAMES)) {
      for (const aspect of ASPECTS) {
        const { width: W, height: H } = ASPECT_SIZE[aspect]
        const n = score(film(file, { aspect, output: { width: W, height: H, fps: 30 }, title: { name, version: 'v1.0' } })).sheet.name
        const wide = Math.max(...n.lines.map((l) => l.length)) * n.size * 0.74
        expect(wide, `${file} ${aspect}`).toBeGreaterThanOrEqual(nameFloor(W, H) * W - 1)
        expect(n.size, `${file} ${aspect}`).toBeGreaterThanOrEqual(n.stampSize)
        const lastBase = n.y + 1.2 * (n.lines.length - 1) * n.size
        const beside = n.stamp[0] > n.x + wide
        const under = n.stamp[1] > lastBase
        expect(beside || under, `${file} ${aspect}`).toBe(true)
        expect(n.stamp[1] < H && lastBase < H).toBe(true)
      }
    }
  }, 600000)

  it('gives a board with no matched pair one signal in yellow from its opening, real copper of a net of the main chip, that the flow carries on to the chip', () => {
    for (const aspect of ASPECTS) {
      const { width: W, height: H } = ASPECT_SIZE[aspect]
      const tl = film('kit-dev-coldfire-xilinx_5213.kicad_pcb', { aspect, output: { width: W, height: H, fps: 30 } })
      const p = score(tl)
      expect(p.flow.path.length, aspect).toBeGreaterThan(0)
      expect(Math.min(...p.flow.path.map((sg) => sg.p0)), aspect).toBeLessThanOrEqual(1 / 24 / 15)
      const hero = tl.scene.parts.find((q) => q.hero === true)
      expect(hero).toBeDefined()
      const reach = Math.hypot(hero?.w ?? 0, hero?.h ?? 0)
      const near = Math.min(...p.flow.path.flatMap((sg) => [sg.a, sg.b]).map((q) => Math.hypot(q[0] - (hero?.x ?? 0), q[1] - (hero?.y ?? 0))))
      expect(near, aspect).toBeLessThanOrEqual(reach)
    }
  }, 600000)

  it('rides the signal close: from the ride\'s start until it eases out to land on the chip, every yellow line is at least 1% of the frame\'s width, on twelve films', () => {
    const bad: string[] = []
    for (const file of ['glasgow.kicad_pcb', 'icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ASPECTS) {
        const { width: W, height: H } = ASPECT_SIZE[aspect]
        const tl = film(file, { aspect, output: { width: W, height: H, fps: 30 } })
        const p = score(tl)
        const ws = (p.film.signature.kind === 'pair' ? p.bus.strokes.map((st) => st.w) : p.flow.path.filter((sg) => sg.plane !== true).map((sg) => sg.w)).filter((w) => w > 0)
        if (ws.length === 0 || p.ink === undefined) { bad.push(`${file} ${aspect}: no signal`); continue }
        const from = Math.ceil(plotFrame(p.shots.outline[0], tl.totalFrames))
        const to = Math.floor(from + RIDE_CLOSE * (plotFrame(p.ink.hold[0], tl.totalFrames) - from)) - 1
        for (let f = from; f <= to; f++) {
          const wide = (Math.min(...ws) * sampleShot(tl.scene.shots, plotClock(f, tl.totalFrames)).zoom) / W
          if (wide < SIGNAL_WIDE - 1e-6) { bad.push(`${file} ${aspect} f${f}: ${(100 * wide).toFixed(2)}%`); break }
        }
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('rides a chip net that runs beside parallel neighbours and ends at a connector or another chip, never an LED\'s, a button\'s or a test point\'s net, where the board has one', () => {
    for (const aspect of ASPECTS) {
      const { width: W, height: H } = ASPECT_SIZE[aspect]
      const ride = score(film('icebreaker.kicad_pcb', { aspect, output: { width: W, height: H, fps: 30 } })).signal
      expect(ride, aspect).toBeDefined()
      expect(ride?.nets.join(' '), aspect).not.toMatch(/LED|BUTTON|BTN/i)
      expect(ride?.beside ?? 0, aspect).toBeGreaterThanOrEqual(0.5)
    }
  }, 600000)

  it('starts a ride too long for the pace part way, at a place a viewer can name, and says so', () => {
    for (const file of ['icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ASPECTS) {
        const { width: W, height: H } = ASPECT_SIZE[aspect]
        const ride = score(film(file, { aspect, output: { width: W, height: H, fps: 30 } })).signal
        expect(ride?.from ?? '', `${file} ${aspect}`).toMatch(/^([A-Z]+\d+|VIA|BUS)$/)
        expect(ride?.mm ?? 0, `${file} ${aspect}`).toBeGreaterThan(5)
      }
    }
  }, 600000)

  it('inks the ride\'s neighbours as a wake: the ink spreads only from the yellow the head has already drawn, and never faster than the head moved there, on the films that ride a net', () => {
    const bad: string[] = []
    for (const file of ['icebreaker.kicad_pcb', 'kit-dev-coldfire-xilinx_5213.kicad_pcb']) {
      for (const aspect of ASPECTS) {
        const { width: W, height: H } = ASPECT_SIZE[aspect]
        const tl = film(file, { aspect, output: { width: W, height: H, fps: 30 } })
        const p = score(tl)
        const ink = p.ink
        if (ink === undefined) { bad.push(`${file} ${aspect}: no ink`); continue }
        const segs = p.flow.path.filter((sg) => sg.plane !== true)
        for (let i = 0; i + 3 < ink.src.length; i += 4) {
          const [x, y, t, v] = ink.src.slice(i, i + 4) as [number, number, number, number]
          if (t < p.shots.outline[0] || t >= ink.hold[0]) continue
          const on = segs.filter((sg) => {
            const dx = sg.b[0] - sg.a[0]
            const dy = sg.b[1] - sg.a[1]
            const k = ((x - sg.a[0]) * dx + (y - sg.a[1]) * dy) / Math.max(1e-9, dx * dx + dy * dy)
            return k >= -1e-6 && k <= 1 + 1e-6 && Math.hypot(sg.a[0] + k * dx - x, sg.a[1] + k * dy - y) < 0.5 && sg.p0 + k * (sg.p1 - sg.p0) <= t + 1e-9
          })
          if (on.length === 0) { bad.push(`${file} ${aspect}: ink spreads from (${x.toFixed(0)}, ${y.toFixed(0)}) at f${(t * tl.totalFrames).toFixed(1)}, where no yellow is drawn yet`); break }
          const head = Math.max(...on.map((sg) => Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) / Math.max(1e-9, sg.p1 - sg.p0)))
          if (v > head * 1.0001) { bad.push(`${file} ${aspect}: ink spreads ${(v / head).toFixed(2)}× the head's speed`); break }
        }
      }
    }
    expect(bad).toEqual([])
  }, 600000)

  it('has the ride\'s yellow already drawing on frame 0 of a film that opens on its ride', () => {
    for (const aspect of ASPECTS) {
      const { width: W, height: H } = ASPECT_SIZE[aspect]
      const tl = film('icebreaker.kicad_pcb', { aspect, output: { width: W, height: H, fps: 30 } })
      const p = score(tl)
      expect(p.shots.outline[0], aspect).toBe(0)
      expect(plotFrame(Math.min(...p.flow.path.map((sg) => sg.p0)), tl.totalFrames), aspect).toBeLessThan(0)
    }
  }, 600000)
})
