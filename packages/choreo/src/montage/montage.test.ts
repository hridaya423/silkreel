import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardModel } from '@silk-reel/ingest'
import { compileTimeline } from '../compile'
import { ASPECT_SIZE } from '../layout'
import type { Aspect, FilmConfig, MontageScore, Timeline } from '../index'
import { boardModel } from '../../test/helpers'
import { corners, hitTally, montageEvents, viewPoint } from './score'
import { FAN_START, NAME_BEAT, PRINT_BEAT } from './hits'

const config = (aspect: Aspect = '4:5', fps = 30): FilmConfig => ({ style: 'montage', aspect, knobs: {}, seed: 7, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps } })

const montage = (tl: Timeline): MontageScore => {
  if (tl.style !== 'montage' || tl.scene.montage === undefined) throw new Error('expected a montage timeline')
  return tl.scene.montage
}

const boards = ['icebreaker.kicad_pcb', 'glasgow.kicad_pcb', 'StickHub.kicad_pcb']
const cache = new Map(boards.map((b) => [b, boardModel(b)]))
const board = (name: string): BoardModel => cache.get(name) as BoardModel

describe('montage score', { timeout: 180_000 }, () => {
  const films = new Map(boards.map((b) => [b, compileTimeline(board(b), config())]))
  const film = (name: string): Timeline => films.get(name) as Timeline

  it('follows one route from a pin of the hero to a part worth reaching, never a ground', () => {
    const reached = boards.map((b) => montage(film(b)).route)
    expect(reached.map((r) => r.end.kind)).toEqual(['led', 'conn', 'conn'])
    for (const [i, r] of reached.entries()) {
      const m = montage(film(boards[i] as string))
      expect(r.net).not.toMatch(/GND/)
      expect(Math.hypot(r.start.x - m.hero.x, r.start.y - m.hero.y)).toBeLessThan(Math.hypot(m.hero.w, m.hero.h))
      expect(r.end.ref).not.toBe(m.hero.ref)
      for (let j = 1; j < r.layers.length; j++) expect(r.layers[j]).not.toBe(r.layers[j - 1])
    }
  })

  it.each(boards)('phrases the edit on a 120 bpm grid: hits on half beats, quick hits beside held ones, no picture slow for more than a second and a half, no word parked over two beats but the ride and the held one, the landing on 18 and the name on 19: %s', (name) => {
    for (const aspect of ['4:5', '9:16', '16:9'] as Aspect[]) {
      const m = montage(compileTimeline(board(name), config(aspect)))
      const half = m.beat / 2
      const hits = m.shots.filter((s) => s.hit !== undefined)
      for (const s of hits) expect(Math.abs(s.f0 / half - Math.round(s.f0 / half)), `${aspect} ${s.kind} ${s.f0}`).toBeLessThan(0.07)
      const sentence = hits.filter((s) => s.kind !== 'step' && s.kind !== 'hold' && s.kind !== 'print').map((s) => Math.round(((s.f1 - s.f0) / m.beat) * 2) / 2)
      expect(Math.min(...sentence)).toBe(0.5)
      expect(Math.max(...sentence)).toBeGreaterThanOrEqual(1.5)
      const print = m.shots.find((s) => s.kind === 'print') as MontageScore['shots'][number]
      const named = m.shots.find((s) => s.kind === 'name') as MontageScore['shots'][number]
      expect([print.f0, named.f0]).toEqual([PRINT_BEAT, NAME_BEAT].map((b) => b * m.beat))
      const hold = m.shots.find((s) => s.kind === 'hold')
      if (hold !== undefined) {
        expect(hold.f1).toBe(PRINT_BEAT * m.beat)
        expect(hold.f1 - hold.f0).toBeLessThanOrEqual(3.5 * m.beat)
        expect(Math.abs((hold.hit?.to.k ?? 0) / (hold.hit?.from.k ?? 1) - 1)).toBeLessThan(0.03)
        expect(hold.hit?.word).toBeDefined()
      }
      for (const s of hits) {
        if (s.f1 - s.f0 <= 3 * m.beat || s.kind === 'print') continue
        const moves = Math.abs(Math.log((s.hit?.to.k ?? 1) / (s.hit?.from.k ?? 1))) > 0.1 || (s.hit?.count !== undefined && (s.hit.count[1] - s.hit.count[0]) > 0) || s.hit?.climax === 'split'
        expect(moves, `${aspect} ${s.kind} ${s.f0} is slow for ${((s.f1 - s.f0) / (2 * m.beat)).toFixed(1)} s`).toBe(true)
      }
      for (const [i, s] of hits.entries()) {
        if (s.hit?.word === undefined || s.kind === 'hold' || s.kind === 'step' || s.kind === 'print' || s.hit.word === hits[i - 1]?.hit?.word) continue
        let f1 = s.f1
        for (let j = i + 1; hits[j]?.hit?.word === s.hit.word && hits[j]?.kind !== 'hold'; j++) f1 = hits[j]?.f1 ?? f1
        const room = s.hit.climax !== undefined ? 6 : s.hit.act === 'stack' ? 4 : s.hit.act !== undefined ? 2.5 : 2
        expect(f1 - s.f0, `${aspect} "${s.hit.word}" parks`).toBeLessThanOrEqual(Math.ceil(room * m.beat))
      }
      const steps = hits.filter((s) => s.kind === 'step')
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i]?.hit?.from).toEqual(steps[i - 1]?.hit?.to)
        expect(steps[i]?.hit?.clock[0]).toBeCloseTo(steps[i - 1]?.hit?.clock[1] ?? 0, 6)
      }
      if (steps.length > 0) expect((steps[0]?.hit?.from.k ?? 0) / (steps.at(-1)?.hit?.to.k ?? 1)).toBeGreaterThan(2.5)
      expect(print.hit?.clock[1]).toBe(100)
    }
  })

  it.each(boards)('never brings a close view from nowhere: every jump in scale of 1.5 times or more arrives by a join made from the board, except the count, whose number carries the eye: %s', (name) => {
    const m = montage(film(name))
    const hits = m.shots.filter((s) => s.hit !== undefined)
    for (const [i, s] of hits.entries()) {
      const before = i === 0 ? m.views.fit : (hits[i - 1]?.hit?.to as MontageScore['views']['fit'])
        if ((s.hit?.from.k ?? 1) / before.k >= 1.5 && s.hit?.whip !== true && s.hit?.count === undefined && !(s.kind === 'print' && hits[i - 1]?.hit?.flood === true)) expect(s.hit?.into !== 'cut' && (s.hit?.frames ?? 0) > 0, `${s.kind} ${s.f0}`).toBe(true)
    }
    for (const s of hits.filter((x) => x.hit?.into === 'iris')) expect((s.hit?.frames ?? 0)).toBeGreaterThan(0)
    const textured = hits.filter((s) => s.hit?.join !== undefined && s.kind !== 'chip')
    for (let i = 1; i < textured.length; i++) expect((textured[i]?.f0 ?? 0) - (textured[i - 1]?.f0 ?? 0)).toBeGreaterThanOrEqual(2 * m.beat)
  })

  it.each(boards)('ends the route on the reached part, large: its pads span a third of the picture and sit inside it: %s', (name) => {
    for (const aspect of ['4:5', '9:16', '16:9'] as Aspect[]) {
      const tl = compileTimeline(board(name), config(aspect))
      const m = montage(tl)
      if (m.weight !== 'route') continue
      const pts = m.route.end.pads.flatMap(corners).map((p) => viewPoint(m.views.arrival, p.x, p.y, tl.width, tl.height))
      const r = m.region
      for (const p of pts) expect(p.x >= 0 && p.x <= tl.width && p.y >= 0 && p.y <= tl.height, aspect).toBe(true)
      const span = Math.max(Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)))
      expect(span / Math.min(r.x1 - r.x0, r.y1 - r.y0), aspect).toBeGreaterThan(0.3)
    }
  })

  it('weighs each film by its board and gives each one climax of its own', () => {
    expect(boards.map((b) => montage(film(b)).weight)).toEqual(['route', 'density', 'object'])
    const said = (b: string): string[] => montage(film(b)).shots.flatMap((s) => (s.hit?.word === undefined ? [] : [s.hit.word]))
    const climaxes = boards.map((b) => montage(film(b)).shots.filter((s) => s.hit?.climax !== undefined && s.hit.act === undefined))
    expect(climaxes.map((c) => c[0]?.hit?.climax)).toEqual(['lamp', 'city', 'split'])
    const ice = montage(film(boards[0] as string))
    const led = said(boards[0] as string).indexOf('LED.')
    expect(led).toBeGreaterThan(0)
    expect(said(boards[0] as string)[led - 1]).toMatch(/^[A-Z]+$/)
    const ride = ice.shots.filter((s) => s.kind === 'step')
    expect(ride.length).toBeGreaterThan(1)
    for (const s of ride) expect(s.hit?.word).toBe('LED.')
    expect(ride.every((s) => (s.hit?.invert ?? 0) === 0)).toBe(true)
    expect(ride.every((s) => s.hit?.light === false)).toBe(true)
    const lamp = climaxes[0]?.[0]
    expect(ice.shots[ice.shots.indexOf(lamp as never) - 1]?.kind).toBe('step')
    expect(lamp?.hit?.word).toBe(`${said(boards[0] as string)[led - 1] ?? ''} LED.`)
    expect(lamp?.hit?.light && lamp.hit.into === 'cut' && lamp.ground === 'black').toBe(true)
    const pull = ice.shots[ice.shots.indexOf(lamp as never) + 1]
    expect(pull?.hit?.act).toBe('copper')
    expect(pull?.hit?.unit).toMatch(/^(METRES?|CENTIMETRES) OF COPPER\.$/)
    expect(pull?.f1).toBe(PRINT_BEAT * ice.beat)
    const glasgow = montage(film(boards[1] as string))
    const city = climaxes[1]?.[0]
    expect(city?.kind).toBe('count')
    expect(city?.ground).toBe('black')
    expect(city?.hit?.count?.[0]).toBeGreaterThan(0)
    expect(city?.hit?.count?.[0]).toBeLessThan(0.1)
    expect(city?.hit?.count?.[1]).toBe(1)
    expect(city?.hit?.tally?.total).toBe(glasgow.count)
    expect(((city?.f1 ?? 0) - (city?.f0 ?? 0)) / glasgow.beat).toBeGreaterThanOrEqual(4)
    const held = glasgow.shots.find((s) => s.kind === 'hold')
    expect(held?.hit?.flood && held.hit.into === 'cut' && held.f0 === Math.max(city?.f1 ?? 0, ...glasgow.shots.filter((s) => s.hit?.act === 'stack').map((s) => s.f1))).toBe(true)
    expect(glasgow.shots.filter((s) => s.hit?.act === 'stack').every((s) => s.f0 >= (city?.f1 ?? 0) && s.hit?.climax === 'city')).toBe(true)
    expect(said(boards[1] as string).at(-1)).toBe(`${glasgow.count} VIAS.`)
    const hub = montage(film(boards[2] as string))
    const split = climaxes[2]?.[0]
    expect(split?.kind).toBe('fan')
    expect(hub.shots.some((s) => s.kind === 'port')).toBe(false)
    const middle = hub.shots.filter((s) => s.hit?.climax === 'split')
    expect(split?.hit?.clock[0]).toBe(0)
    expect(middle.map((s) => s.hit?.act ?? s.kind)).toEqual(['fan', 'pins', 'fan', 'hold'])
    expect(middle[1]?.hit?.clock).toEqual([FAN_START, FAN_START])
    expect(middle[2]?.hit?.clock[1]).toBeGreaterThanOrEqual(Math.max(...hub.portAt))
    expect((middle.at(-1)?.f1 ?? 0) - (middle[0]?.f0 ?? 0)).toBeGreaterThanOrEqual(10 * hub.beat)
    for (const s of middle) expect(s.hit?.to.k ?? 0, s.kind).toBeGreaterThanOrEqual((middle[0]?.hit?.from.k ?? 0) * 0.99)
    expect(said(boards[2] as string)).toEqual(expect.arrayContaining(['1 PLUG.']))
    const wide = hub.shots.find((s) => s.kind === 'hold')
    expect(wide?.hit?.into).toBe('cut')
    expect(wide?.hit?.word).toBe(`${hub.fan} PORTS.`)
    expect(said(boards[2] as string).filter((w) => w === '1 PLUG.')).toHaveLength(1)
    expect(said(boards[2] as string).some((w) => w.endsWith(' PARTS.'))).toBe(false)
    expect(wide?.hit?.clock[0]).toBeGreaterThanOrEqual(Math.max(...hub.portAt))
    const fan = hub.pulses.filter((p) => p.bold).slice(-hub.fan)
    expect(new Set(fan.map((p) => p.f0)).size).toBe(hub.fan)
  })

  it('tells at most two facts beside the story, never two counters in a row, and never counts from nothing', () => {
    for (const b of boards) {
      const m = montage(film(b))
      const acts = m.shots.filter((s) => s.hit?.act !== undefined)
      expect(new Set(acts.map((s) => s.hit?.act)).size, b).toBeLessThanOrEqual(2)
      const counters = m.shots.map((s) => s.hit?.count !== undefined && s.hit.count[1] > s.hit.count[0])
      for (let i = 1; i < counters.length; i++) expect(counters[i] === true && counters[i - 1] === true, `${b} ${m.shots[i]?.kind}`).toBe(false)
      for (const s of m.shots.filter((_, i) => counters[i] === true)) expect(hitTally(m, s.f0), `${b} ${s.kind}`).toBeGreaterThan(0)
      for (const s of acts.filter((x) => x.hit?.act === 'pins')) expect(s.hit?.word).toBeUndefined()
      for (const s of acts.filter((x) => x.hit?.act === 'parts')) expect(s.hit?.word).toBe(String(m.blocks.length))
      for (const s of m.shots) expect(s.hit?.word ?? '').not.toMatch(/^0\.\d+ MM\.$/)
      const stack = acts.filter((s) => s.hit?.act === 'stack')
      if (stack.length > 0) expect(stack[0]?.hit?.word).toBe(`${stack.length} LAYERS.`)
      for (const s of stack) expect(Math.abs((s.f1 - s.f0) / m.beat - (stack[0]?.hit?.climax === 'city' ? 1.5 : 1))).toBeLessThan(0.1)
    }
    expect(montage(film('StickHub.kicad_pcb')).pins.length).toBe(48)
    expect(montage(film('icebreaker.kicad_pcb')).pins.length).toBe(48)
    expect(montage(film('glasgow.kicad_pcb')).pins.length).toBe(121)
  })


  it.each(boards)('shows the whole board by one second, along the frame, and the print spans 60%% of the limiting side: %s', (name) => {
    for (const aspect of Object.keys(ASPECT_SIZE) as Aspect[]) {
      const tl = compileTimeline(board(name), config(aspect))
      const m = montage(tl)
      const W = tl.width
      const H = tl.height
      const fall = m.shots.find((s) => s.kind === 'fall') as MontageScore['shots'][number]
      expect(fall.f1).toBeLessThanOrEqual(34)
      const a = viewPoint(m.views.fit, m.board.x0, m.board.y0, W, H)
      const z = viewPoint(m.views.fit, m.board.x1, m.board.y1, W, H)
      if (Math.abs(W - H) > 1) expect(Math.abs(z.x - a.x) >= Math.abs(z.y - a.y), `${aspect} long axis`).toBe(W > H)
      expect(Math.max(Math.abs(z.x - a.x) / W, Math.abs(z.y - a.y) / H), `${aspect} print`).toBeGreaterThanOrEqual(0.6)
    }
  })

  it.each([24, 30, 60])('lays the shots end to end with none under 4 frames at %i fps', (fps) => {
    for (const name of boards) {
      const tl = compileTimeline(board(name), config('9:16', fps))
      const m = montage(tl)
      expect(m.shots[0]?.f0).toBe(0)
      expect(m.shots.at(-1)?.f1).toBe(tl.totalFrames)
      for (const [i, s] of m.shots.entries()) {
        expect(s.f1 - s.f0).toBeGreaterThanOrEqual(4)
        if (i > 0) expect(s.f0).toBe(m.shots[i - 1]?.f1)
      }
    }
  })

  it('cuts each film down to its own acts: the route film rides and crosses its layers, the density film counts, the object film measures and counts ports, and each film type opens and closes its own way', () => {
    const kinds = boards.map((b) => new Set(montage(film(b)).shots.map((s) => s.kind)))
    for (const k of ['pad', 'chip', 'run', 'layer', 'arrival', 'step', 'lamp', 'print']) expect(kinds[0]?.has(k as never), k).toBe(true)
    for (const k of ['field', 'ruler', 'port', 'wave', 'rush', 'hold']) expect(kinds[0]?.has(k as never), k).toBe(false)
    for (const k of ['chip', 'run', 'arrival', 'count', 'hold']) expect(kinds[1]?.has(k as never), k).toBe(true)
    for (const k of ['ruler', 'port', 'lamp', 'fan', 'step', 'wave', 'rush']) expect(kinds[1]?.has(k as never), k).toBe(false)
    for (const k of ['ruler', 'plug', 'fan', 'pins', 'hold']) expect(kinds[2]?.has(k as never), k).toBe(true)
    for (const k of ['run', 'field', 'wave', 'rush', 'port', 'lamp', 'whip', 'parts']) expect(kinds[2]?.has(k as never), k).toBe(false)
    expect(boards.map((b) => montage(film(b)).shots[2]?.kind)).toEqual(['pad', 'chip', 'ruler'])
    expect(boards.map((b) => montage(film(b)).shots[0]?.ground === 'spot')).toEqual([false, true, false])
    expect(montage(film('StickHub.kicad_pcb')).shots[2]?.hit?.into).toBe('cut')
  })

  it.each(boards)('says words a person says: no net names, plain layer names, and one or two words a hit: %s', (name) => {
    const m = montage(film(name))
    for (const w of m.words) {
      expect(w.text).not.toBe(m.route.net)
      expect(w.text).not.toMatch(/\.CU|[A-Z]\d+[A-Z]?[+-]$/)
      if (w.role !== 'part') expect(w.text.split(' ').length).toBeLessThanOrEqual(2)
    }
    for (const w of m.words.filter((x) => x.role === 'layer')) expect(w.text).toMatch(/^(FRONT COPPER|BACK COPPER|INNER \d+)\.$/)
  })

  it('compiles the same timeline from the same board, config and seed', () => {
    const a = compileTimeline(board('icebreaker.kicad_pcb'), config())
    const b = compileTimeline(board('icebreaker.kicad_pcb'), config())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('takes every word from the file: a renamed board and nets change every word', () => {
    const src = board('icebreaker.kicad_pcb')
    const renamed: BoardModel = {
      ...src,
      source: { ...src.source, boardName: 'quokka.kicad_pcb' },
      silkscreen: Object.fromEntries(Object.entries(src.silkscreen).map(([k, l]) => [k, { ...l, texts: l.texts.map((t) => ({ ...t, value: t.value.replace(/^V\d.*$/i, 'R9') })) }])),
      titleBlock: { ...src.titleBlock, title: 'Quokka', rev: 'R9' },
      nets: src.nets.map((n) => ({ ...n, name: n.name.length === 0 ? n.name : `/Q${n.id}` }))
    }
    const b = montage(compileTimeline(renamed, config()))
    expect(b.name).toBe('Quokka')
    expect(b.footer[0]).toBe('Quokka R9')
    expect(b.route.net).toMatch(/^Q\d+$/)
    for (const w of [...b.footer, b.name, b.route.net, ...b.words.map((x) => x.text), b.hero.label]) expect(w.toLowerCase()).not.toContain('icebreaker')
  })

  it('reads the version from the silk when it differs from the title block, and the chip from its value without a library prefix', () => {
    expect(montage(film('icebreaker.kicad_pcb')).footer[0]).toBe('iCEBreaker V1.0e')
    expect(montage(film('StickHub.kicad_pcb')).hero.label).toBe('XR22417-48')
  })

  it('names no demo board in its source', () => {
    const files = [
      ...readdirSync(import.meta.dirname).filter((f) => !f.endsWith('.test.ts')).map((f) => path.join(import.meta.dirname, f)),
      ...readdirSync(path.join(import.meta.dirname, '../../../render/src')).filter((f) => f.startsWith('montage-') && !f.endsWith('.test.ts')).map((f) => path.join(import.meta.dirname, '../../../render/src', f))
    ]
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/icebreaker|glasgow|stickhub|ecc83|coldfire|ice40|ft2232/i)
  })

  it('counts pads when the board has no vias, and compiles a one-net board', () => {
    const src = board('glasgow.kicad_pcb')
    const bare: BoardModel = { ...src, copper: Object.fromEntries(Object.entries(src.copper).map(([k, c]) => [k, { ...c, vias: [] }])) }
    const m = montage(compileTimeline(bare, config()))
    expect(m.unit).toBe('pad')
    expect(m.count).toBeGreaterThan(50)
    const ice = board('icebreaker.kicad_pcb')
    const first = ice.nets.find((n) => n.name.length > 0) as BoardModel['nets'][number]
    const one: BoardModel = { ...ice, nets: [first], copper: Object.fromEntries(Object.entries(ice.copper).map(([k, c]) => [k, { ...c, traces: c.traces.filter((t) => t.netId === first.id) }])) }
    expect(montage(compileTimeline(one, config('1:1'))).route.path.length).toBeGreaterThanOrEqual(4)
  })

  it('exposes a cut on every hit, its floods and its landings in frame order for the score', () => {
    for (const name of boards) {
      const tl = film(name)
      const m = montage(tl)
      const ev = montageEvents(tl)
      for (const s of m.shots.slice(1)) expect(ev.some((e) => e.kind === 'cut' && e.frame === s.f0), `${name} ${s.kind} ${s.f0}`).toBe(true)
      expect(ev.filter((e) => e.kind === 'flood').length).toBe(m.shots.filter((s) => s.hit?.flood === true).length)
      expect(ev.filter((e) => e.kind === 'land' && e.text?.startsWith('port') === true).length).toBe(m.shots.some((s) => s.hit?.climax === 'split') ? m.portAt.length : 0)
      expect(ev.map((e) => e.frame)).toEqual([...ev.map((e) => e.frame)].sort((a, b) => a - b))
      const climax = m.shots.find((s) => s.hit?.climax !== undefined)
      expect(ev.filter((e) => e.kind === 'climax').map((e) => e.frame)).toEqual([climax?.f0])
    }
  })
})
