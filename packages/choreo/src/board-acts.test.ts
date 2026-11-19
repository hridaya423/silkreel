import { describe, expect, it } from 'vitest'
import { boardModel } from '../test/helpers'
import { compileTimeline } from './compile'
import { DECODE_IN, decodeAlpha, steadyAlpha } from './decode'
import { DEMO_CAST_HINTS } from './hints'
import { ASPECT_SIZE } from './layout'
import { heroChip, isBallGrid, classify } from './cells'
import { HERO_SIZE, heroPart, padCounts, partKind, partsOnNets, RAIL_PARTS } from './acts'
import { GLYPH_CUT_EARLY } from './composer'
import type { Aspect, GlyphTimeline } from './types'

const BOARDS = [
  ['glasgow.kicad_pcb', 'glasgow'],
  ['icebreaker.kicad_pcb', 'icebreaker'],
  ['kit-dev-coldfire-xilinx_5213.kicad_pcb', 'kit-dev-coldfire-xilinx_5213']
] as const
const ASPECTS: Aspect[] = ['4:5', '9:16', '16:9', '1:1']
const DECODED = DECODE_IN[0]?.length ?? 5
const PITCH = 0.085
const MOST_FRAMES = 34 * 14

const films = new Map<string, GlyphTimeline>()
function glyph(file: string, hints: string, aspect: Aspect): GlyphTimeline {
  const key = `${file} ${aspect}`
  const known = films.get(key)
  if (known !== undefined) return known
  const cast = DEMO_CAST_HINTS[hints]
  const tl = compileTimeline(boardModel(file), { style: 'glyph', knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, title: { name: 'Board' }, ...(cast === undefined ? {} : { cast }) })
  if (tl.style !== 'glyph') throw new Error('expected a glyph timeline')
  films.set(key, tl)
  return tl
}
const chipFrame = (pads: Array<{ pos: { x: number; y: number }; num?: string | undefined }>, rot: number): Array<{ x: number; y: number; num?: string | undefined }> => {
  const r = (rot * Math.PI) / 180
  return pads.map((p) => ({ x: p.pos.x * Math.cos(r) - p.pos.y * Math.sin(r), y: p.pos.x * Math.sin(r) + p.pos.y * Math.cos(r), num: p.num }))
}
const frame = (tl: GlyphTimeline, step: number): number => Math.round((step * tl.fps) / 15)
const of = (tl: GlyphTimeline, id: string): GlyphTimeline['placements'] => tl.placements.filter((p) => tl.formations.find((f) => f.beat === p.formation)?.id === id)
const stand = (tl: GlyphTimeline, id: string): number => {
  const mine = of(tl, id)
  const lock = Math.max(...mine.map((p) => p.inStep)) + DECODED
  return frame(tl, Math.min(...mine.map((p) => p.outStep)) - lock)
}
const parts = (tl: GlyphTimeline, id: string): GlyphTimeline['placements'] => of(tl, id).filter((p) => p.group !== undefined)
const lit = (tl: GlyphTimeline, p: GlyphTimeline['placements'][number], f: number): boolean => (p.steady === true ? steadyAlpha : decodeAlpha)(Math.floor((f * 15) / tl.fps) % tl.steps, p.inStep, p.outStep, p.pattern, tl.steps) > 0

describe('the diagonal and the cluster', () => {
  for (const [file, hints] of BOARDS) {
    for (const aspect of ASPECTS) {
      it(`${hints} ${aspect}: the film runs routes, plan, diagonal, cluster, field, name in at most 34 beats; the diagonal and the cluster each stand whole 1.3 s, the plan at least 80% of round 17's 54 frames`, () => {
        const tl = glyph(file, hints, aspect)
        expect([...tl.formations].sort((a, b) => a.startPhase - b.startPhase).map((f) => f.id)).toEqual(['plan', 'diagonal', 'cluster', 'field', 'name', 'route'])
        expect(tl.totalFrames).toBeLessThanOrEqual(MOST_FRAMES)
        expect(stand(tl, 'diagonal')).toBeGreaterThanOrEqual(1.3 * tl.fps)
        expect(stand(tl, 'cluster')).toBeGreaterThanOrEqual(1.3 * tl.fps)
        expect(stand(tl, 'plan')).toBeGreaterThanOrEqual(0.8 * 54)
      })

      it(`${hints} ${aspect}: from the field's first stage to its exit the events are round 18b's, shifted`, () => {
        const tl = glyph(file, hints, aspect)
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        const exit = Math.round((Math.min(...tl.placements.filter((p) => p.stage !== undefined && p.role !== 'hero').map((p) => p.outStep)) * tl.fps) / 15)
        const after = tl.events.filter((e) => e.at >= turn && e.at < exit && e.kind !== 'form' && e.kind !== 'turn').map((e) => `${e.kind}+${e.at - turn}`)
        expect(after).toEqual(['stage+0', 'stage+28', 'stage+42', 'stage+60', 'lock+70', 'button+84'])
      })

      it(`${hints} ${aspect}: one formation leaves before the next writes: no diagonal mark is lit, trail included, from 4 frames before the cluster's first lit frame, and no plan mark once the diagonal writes`, () => {
        const tl = glyph(file, hints, aspect)
        for (const [before, next] of [['plan', 'diagonal'], ['diagonal', 'cluster']] as const) {
          const start = frame(tl, Math.min(...of(tl, next).map((p) => p.inStep)))
          for (let f = start - 4; f < start + tl.fps; f++) {
            const on = of(tl, before).filter((p) => lit(tl, p, f))
            expect(on.length, `${before} lit at frame ${f}, the ${next} writes from ${start}`).toBe(0)
          }
        }
      })

      it(`${hints} ${aspect}: no mark stands alone in the dark before the cut to the field`, () => {
        const tl = glyph(file, hints, aspect)
        const turn = tl.events.find((e) => e.kind === 'turn')?.at as number
        for (let f = 0; f < turn - GLYPH_CUT_EARLY; f++) {
          const s = Math.floor((f * 15) / tl.fps) % tl.steps
          const n = tl.placements.filter((p) => p.stage === undefined && (p.steady === true ? steadyAlpha : decodeAlpha)(s, p.inStep, p.outStep, p.pattern, tl.steps) > 0.05).reduce((k, p) => k + p.atoms.length, 0)
          expect(n === 0 || n > 2, `frame ${f} shows ${n}`).toBe(true)
        }
      })

      it(`${hints} ${aspect}: the diagonal is the connectors and the parts on their nets, a band turned half round about the centre that runs corner to corner`, () => {
        const tl = glyph(file, hints, aspect)
        const model = boardModel(file)
        const mine = parts(tl, 'diagonal')
        expect(mine.length).toBeGreaterThanOrEqual(8)
        const conns = new Set(model.footprints.filter((f) => classify(f.ref, f.value) === 'conn').map((f) => f.ref))
        const onConn = new Set<string>(conns)
        for (const refs of partsOnNets(model).values()) if (refs.size >= 2 && refs.size < RAIL_PARTS && [...refs].some((r) => conns.has(r))) for (const r of refs) onConn.add(r)
        for (const p of mine) expect(onConn.has(p.group as string), `${p.group} is a connector or on a connector's net`).toBe(true)
        const pts = mine.flatMap((p) => p.atoms)
        for (const p of mine) {
          expect(p.atoms).toHaveLength(2)
          const a = p.atoms[0] as { x: number; y: number }
          const b = p.atoms[1] as { x: number; y: number }
          expect(Math.hypot(a.x + b.x, a.y + b.y)).toBeLessThan(1e-9)
        }
        const sxx = pts.reduce((s, q) => s + q.x * q.x, 0)
        const syy = pts.reduce((s, q) => s + q.y * q.y, 0)
        const sxy = pts.reduce((s, q) => s + q.x * q.y, 0)
        const angle = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI
        expect(Math.abs(Math.abs(angle) - 45), `the band runs at ${angle.toFixed(1)}°`).toBeLessThan(15)
        const u = { x: Math.cos((angle * Math.PI) / 180), y: Math.sin((angle * Math.PI) / 180) }
        const along = pts.map((q) => q.x * u.x + q.y * u.y)
        const across = pts.map((q) => -q.x * u.y + q.y * u.x)
        expect(Math.max(...across.map(Math.abs)) / Math.max(...along.map(Math.abs)), 'a narrow band').toBeLessThan(0.55)
      })

      it(`${hints} ${aspect}: the cluster is the main chip at HERO_SIZE among mixed kinds of the parts near it, mirrored four ways, its corner ticks inside it, and its parts a different group from the diagonal's`, () => {
        const tl = glyph(file, hints, aspect)
        const model = boardModel(file)
        const cluster = of(tl, 'cluster')
        const chip = cluster.find((p) => p.role === 'hero')
        expect(chip?.atoms[0]?.scale).toBeCloseTo(HERO_SIZE * PITCH, 9)
        const mine = parts(tl, 'cluster')
        const pads = padCounts(model)
        const kinds = new Map<string, number>()
        for (const p of mine) {
          const f = model.footprints.find((g) => g.ref === p.group)
          if (f === undefined) throw new Error(`no part ${p.group}`)
          kinds.set(partKind(f, pads), (kinds.get(partKind(f, pads)) ?? 0) + 1)
        }
        expect(kinds.size, 'kinds in the cluster').toBeGreaterThanOrEqual(3)
        expect(Math.max(...kinds.values()) / mine.length, 'the share of the commonest kind').toBeLessThanOrEqual(0.6)
        for (const p of mine) {
          const a = p.atoms[0] as { x: number; y: number }
          const want = [[a.x, a.y], [-a.x, a.y], [a.x, -a.y], [-a.x, -a.y]].filter(([x, y], i, all) => all.findIndex(([u, v]) => Math.hypot((u as number) - (x as number), (v as number) - (y as number)) < 1e-9) === i)
          expect(p.atoms).toHaveLength(want.length)
        }
        const c = chip?.atoms[0] as { x: number; y: number }
        const around = mine.flatMap((p) => p.atoms).map((q) => Math.atan2(q.y - c.y, q.x - c.x))
        for (let k = 0; k < 4; k++) expect(around.some((t) => Math.abs(Math.sin((t - (k * Math.PI) / 2) / 2)) < Math.sin(Math.PI / 8)), `parts on the chip's side ${k}`).toBe(true)
        const xs = mine.flatMap((p) => p.atoms.map((q) => Math.abs(q.x)))
        const ys = mine.flatMap((p) => p.atoms.map((q) => Math.abs(q.y)))
        const X = Math.max(...xs)
        const Y = Math.max(...ys)
        const ticks = cluster.filter((p) => p.group === undefined && p.role !== 'hero' && p.glyphId.startsWith('cell:'))
        expect(ticks.length).toBeGreaterThan(0)
        for (const t of ticks) for (const q of t.atoms) expect(Math.abs(q.x) <= X + 2 * PITCH && Math.abs(q.y) <= Y + 2 * PITCH, `a tick at ${q.x.toFixed(3)},${q.y.toFixed(3)} stands outside the parts (${X.toFixed(3)}, ${Y.toFixed(3)})`).toBe(true)
        const drawn = (p: GlyphTimeline['placements'][number]): Array<{ x: number; y: number }> => {
          const pts = tl.cast.find((g) => g.id === p.glyphId)?.strokes.flat() ?? []
          return p.atoms.flatMap((q) => pts.map((r) => ({ x: q.x + (r.x * Math.cos(q.rot) - r.y * Math.sin(q.rot)) * q.scale * (q.flipX === true ? -1 : 1), y: q.y + (r.x * Math.sin(q.rot) + r.y * Math.cos(q.rot)) * q.scale * (q.flipY === true ? -1 : 1) })))
        }
        const tickInk = ticks.flatMap(drawn)
        for (const p of mine) {
          const near = Math.min(...drawn(p).flatMap((q) => tickInk.map((t) => Math.hypot(q.x - t.x, q.y - t.y))))
          expect(near / PITCH, `a corner tick touches ${p.group}`).toBeGreaterThan(0.15)
        }
        const diagonal = new Set(parts(tl, 'diagonal').map((p) => p.group))
        const shared = mine.filter((p) => diagonal.has(p.group)).length
        expect(shared / Math.max(1, Math.min(mine.length, diagonal.size)), 'parts the cluster shares with the diagonal').toBeLessThanOrEqual(0.25)
      })
    }
  }

  it('a QFN with split paste pads is no ball grid: the iCEBreaker chip draws its pads round the edge and its exposed pad', () => {
    const model = boardModel('icebreaker.kicad_pcb')
    const hero = heroPart(model, DEMO_CAST_HINTS.icebreaker?.hero, DEMO_CAST_HINTS.icebreaker)
    if (hero === undefined) throw new Error('no main chip')
    const pads = Object.values(model.copper).flatMap((l) => l.pads).filter((p) => p.footprintRef === hero.ref)
    expect(isBallGrid(chipFrame(pads, hero.rot))).toBe(false)
    const strokes = heroChip(model, hero.ref, hero.rot)?.strokes ?? []
    const closed = strokes.filter((s) => s.length === 5 && Math.hypot((s[0]?.x ?? 0) - (s[4]?.x ?? 1), (s[0]?.y ?? 0) - (s[4]?.y ?? 1)) < 1e-9)
    expect(closed, 'the exposed pad').toHaveLength(1)
    expect(strokes.filter((s) => s.length === 9).length, 'no balls, only the pin-1 dot').toBe(1)
    const glasgow = boardModel('glasgow.kicad_pcb')
    const fpga = heroPart(glasgow, DEMO_CAST_HINTS.glasgow?.hero, DEMO_CAST_HINTS.glasgow)
    expect(isBallGrid(chipFrame(Object.values(glasgow.copper).flatMap((l) => l.pads).filter((p) => p.footprintRef === fpga?.ref), fpga?.rot ?? 0)), 'a BGA stays a ball grid').toBe(true)
  })
})
