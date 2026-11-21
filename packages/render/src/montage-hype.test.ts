import './test-recorder'
import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, BODY_LOW, bodyOutline, compileTimeline, drawnBody, makeCam, measuredBox, project, sampleShot } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, HypeCut, MontageScore, PartBodies, TraceTimeline } from '@silk-reel/choreo'
import { clearBand, drawBody, drawDims, drawPads, fillKept, gradeBuild, holdStop, KEEP_GROW, markSpot, nameBlock, OUTLINE_CLEAR, shoulder, STOP_LEVEL, DRAW_KNEE, INSIDE_FIT, insideAt, OUTLINE_INK, SEEN_EDGE, SNAP, unseenColumns } from './montage-hype'
import { asCtx, RecordingCtx } from './test-recorder'
import { boardModel } from '../../choreo/test/helpers'

const stepped = (): PartBodies['meshes'][number] => {
  const pos: number[] = []
  const idx: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of [[-1, -1, 0, 1, 1, 1.5], [-0.7, -0.7, 0, 0.7, 0.7, 3]] as const) {
    const o = pos.length / 3
    for (const z of [z0, z1]) for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) pos.push(x, y, z)
    for (const t of [[4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]) idx.push(...t.map((k) => o + k))
  }
  const b64 = (a: ArrayBufferLike): string => Buffer.from(a).toString('base64')
  return { pos: b64(new Float32Array(pos).buffer), idx: b64(new Uint32Array(idx).buffer), nor: '', col: '', min: [-1, -1, 0], max: [1, 1, 3] }
}

const film = (name: string, aspect: Aspect, models = false): TraceTimeline => {
  const config: FilmConfig = { style: 'montage', aspect, knobs: {}, seed: 3, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 } }
  const board = boardModel(name)
  const bodies = models ? { meshes: [stepped()], byRef: Object.fromEntries(board.footprints.map((f) => [f.ref, 0])) } : undefined
  return compileTimeline(board, config, bodies) as TraceTimeline
}

describe('a print of the main chip', { timeout: 120_000 }, () => {
  for (const [name, aspect, models] of [['glasgow.kicad_pcb', '4:5', false], ['glasgow.kicad_pcb', '4:5', true], ['icebreaker.kicad_pcb', '9:16', false], ['kit-dev-coldfire-xilinx_5213.kicad_pcb', '16:9', true]] as const) {
    it(`${name} ${aspect}${models ? ' with a stepped model' : ''}: on every print frame the outline is the body the film draws, convex with straight edges, filled with one clean tone and drawn in one even line`, () => {
      const tl = film(name, aspect, models)
      const h = (tl.scene.montage as MontageScore).hype as HypeCut
      const hero = tl.scene.parts.find((p) => p.hero === true)
      if (hero === undefined) throw new Error('no main chip')
      const body = drawnBody(tl.scene, hero)
      const high = Math.max(...body.map((v) => v[2]))
      const prints = h.plan.flatMap((p, f) => (p.bare === true ? [f] : []))
      expect(prints.length, 'the build has prints').toBeGreaterThan(0)
      for (const f of prints) {
        const cam = makeCam(sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total), tl.width, tl.height)
        const outline = bodyOutline(h.glint, body, cam, tl.width, tl.height)
        const turns = outline.map((p, i) => {
          const q = outline[(i + 1) % outline.length] as { x: number; y: number }
          const r = outline[(i + 2) % outline.length] as { x: number; y: number }
          return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x)
        })
        expect(turns.every((t) => t >= -1e-6) || turns.every((t) => t <= 1e-6), `${f}: the hull turns one way only`).toBe(true)
        const side = Math.sign(turns.find((t) => Math.abs(t) > 1e-6) ?? 1)
        for (const v of body.filter((x) => x[2] >= BODY_LOW * high)) {
          const q = project(cam, v[0], v[1], v[2])
          const p = { x: ((q.x + 1) / 2) * tl.width, y: ((1 - q.y) / 2) * tl.height }
          const out = outline.some((a, i) => {
            const b = outline[(i + 1) % outline.length] as { x: number; y: number }
            return side * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < -0.5 * Math.hypot(b.x - a.x, b.y - a.y)
          })
          expect(out, `${f}: a point of the drawn body lies outside its hull`).toBe(false)
        }
        const d = h.dims.find((x) => f >= x.f0 && f < x.f1)
        if (d === undefined) throw new Error(`${f}: a print with no measured box`)
        const given = d.corners.map((c) => ((q) => ({ x: ((q.x + 1) / 2) * tl.width, y: ((1 - q.y) / 2) * tl.height }))(project(cam, c.x, c.y)))
        const box = measuredBox(outline, given)
        for (const [k, a] of box.entries()) {
          const b = box[(k + 1) % 4] as { x: number; y: number }
          const g0 = given[k] as { x: number; y: number }
          const g1 = given[(k + 1) % 4] as { x: number; y: number }
          const l = Math.hypot(b.x - a.x, b.y - a.y)
          expect(Math.abs(((b.x - a.x) * (g1.y - g0.y) - (b.y - a.y) * (g1.x - g0.x)) / (l * Math.hypot(g1.x - g0.x, g1.y - g0.y))), `${f}: edge ${k} runs along the measured box`).toBeLessThan(1e-6)
          const dist = outline.map((o) => ((b.x - a.x) * (o.y - a.y) - (b.y - a.y) * (o.x - a.x)) / l)
          const inward = Math.sign(dist.reduce((x, y) => (Math.abs(y) > Math.abs(x) ? y : x), 0))
          expect(Math.min(...dist.map((x) => x * inward)), `${f}: edge ${k} holds the outline`).toBeGreaterThan(-0.01)
          expect(Math.min(...dist.map((x) => Math.abs(x))), `${f}: edge ${k} touches the outline, so the box is the outline and no second line stands beside it`).toBeLessThan(0.01)
        }
      }
      const rec = new RecordingCtx(tl.width, tl.height)
      drawBody(asCtx(rec), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], tl.width, { dark: '#071633' })
      expect([rec.calls.filter((c) => c.method === 'fill').length, rec.calls.filter((c) => c.method === 'stroke').length], 'one flat fill and one line').toEqual([1, 1])
      const widths = rec.calls.filter((c) => c.method === 'set:lineWidth').map((c) => c.args[0] as number)
      expect(widths, 'one line weight').toHaveLength(1)
      expect((widths[0] as number) * (390 / tl.width), 'at least 2 px on a 390 px phone').toBeGreaterThanOrEqual(2)
      expect(widths[0] as number, 'heavier than the dimension lines').toBeGreaterThan(Math.max(1.5, 0.0016 * tl.width))
      expect(rec.calls.some((c) => c.method === 'putImageData' || c.method === 'drawImage'), 'no texture on the body').toBe(false)
    })
  }

  it('draws the chip\'s outline at least as bright as the size line', () => {
    const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b
    const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number]
    expect(luma(...hex(OUTLINE_INK))).toBeGreaterThanOrEqual(luma(240, 241, 244))
  })

  it('stands the measured box on the outline once it has closed to within SNAP of the frame: no second line beside it', () => {
    const tl = film('glasgow.kicad_pcb', '4:5')
    const h = (tl.scene.montage as MontageScore).hype as HypeCut
    const d = h.dims[0] as HypeCut['dims'][number]
    const box = [{ x: 300, y: 300 }, { x: 700, y: 300 }, { x: 700, y: 700 }, { x: 300, y: 700 }]
    const near = d.at + 26
    expect((1 - (near - d.at) / 34) ** 3 * 0.35, 'the box is still closing, inside SNAP').toBeLessThan(SNAP)
    expect((1 - (near - d.at) / 34) ** 3 * 0.35, 'not yet closed').toBeGreaterThan(0)
    const rec = new RecordingCtx(tl.width, tl.height)
    drawDims(asCtx(rec), d, box, near, tl.width, tl.height)
    const firstMove = rec.calls.find((c) => c.method === 'moveTo')?.args as [number, number]
    const firstLine = rec.calls.find((c) => c.method === 'lineTo')?.args as [number, number]
    expect(Math.abs((firstLine[0] - firstMove[0]) * (300 - firstMove[1]) - (firstLine[1] - firstMove[1]) * (300 - firstMove[0])) / Math.hypot(firstLine[0] - firstMove[0], firstLine[1] - firstMove[1]), `f${near}: the first edge's line passes through the box's corner`).toBeLessThan(1e-6)
  })

  it('clears the band to the paper itself, takes a small mark the band touches whole, cuts a large one hard at the band, and leaves the rest at full strength', () => {
    const w = 40
    const h = 10
    const paper = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : ((i >> 2) % w) % 8 === 0 ? 60 : 10))
    const rgba = paper.slice()
    const zone = new Uint8ClampedArray(w * h).map((_, i) => (i % w < 10 ? 255 : 0))
    const ink = (x: number, y: number): void => {
      for (let c = 0; c < 3; c++) rgba[4 * (y * w + x) + c] = 230
    }
    for (let x = 0; x < 15; x++) ink(x, 1)
    for (let x = 8; x < 14; x++) ink(x, 7)
    for (let x = 30; x < 34; x++) ink(x, 8)
    for (let y = 0; y < h; y++) ink(2, y)
    const before = rgba.slice()
    clearBand(rgba, paper, zone, w, h, 9)
    const px = (x: number, y: number): number => rgba[4 * (y * w + x)] as number
    for (let y = 0; y < h; y++) for (let x = 0; x < 10; x++) expect(px(x, y), `zone ${x},${y} is the paper`).toBe(paper[4 * (y * w + x)])
    for (let x = 10; x < 14; x++) expect(px(x, 7), `the small mark at ${x},7 the band touched is taken whole`).toBe(paper[4 * (7 * w + x)])
    for (let x = 10; x < 15; x++) expect(px(x, 1), `the large mark is cut at the band, ${x},1 stays whole strength`).toBe(before[4 * (1 * w + x)])
    for (let x = 30; x < 34; x++) expect(px(x, 8), 'a mark away from the band stays').toBe(230)
  })

  it('never clears a kept pixel: a silk word the band touches stays at full strength', () => {
    const w = 30
    const h = 6
    const paper = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : 10))
    const rgba = paper.slice()
    for (let x = 4; x < 12; x++) for (let c = 0; c < 3; c++) rgba[4 * (2 * w + x) + c] = 230
    const zone = new Uint8ClampedArray(w * h).map((_, i) => (i % w < 8 ? 255 : 0))
    const keep = new Uint8ClampedArray(w * h).map((_, i) => (Math.floor(i / w) === 2 && i % w >= 4 && i % w < 12 ? 255 : 0))
    clearBand(rgba, paper, zone, w, h, 20, 24, 2, keep)
    for (let x = 4; x < 12; x++) expect(rgba[4 * (2 * w + x)], `the word at ${x},2 stays`).toBe(230)
  })

  it('fills every kept shape clear of the chip into the keep mask, grown past its outline; clears whole a part, pad or stroke that reaches the strip beside the outline, and a word only when its letters lie under the body or across the outline; clears that strip but never a kept word', () => {
    const rec = new RecordingCtx(390, 390)
    const zone = new RecordingCtx(390, 390)
    const box = [{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 300 }, { x: 200, y: 300 }]
    const far: [number, number][] = [[10, 10], [40, 10], [40, 30]]
    const touching: [number, number][] = [[302, 250], [330, 250], [330, 270]]
    const beside: [number, number][] = [[200, 200 - (OUTLINE_CLEAR * 390) / 2], [240, 150], [260, 150]]
    fillKept(asCtx(rec), asCtx(zone), [{ shape: far, kind: 'part' }, { shape: touching, kind: 'pad' }, { shape: beside, kind: 'part' }, { shape: [[100, 100], [120, 100], [120, 140], [100, 140]], kind: 'pad' }, { shape: touching, kind: 'word', core: [[318, 250], [328, 250], [328, 260], [318, 260]] }, { shape: touching, kind: 'word', core: [[290, 250], [310, 250], [310, 260], [290, 260]] }, { shape: touching, kind: 'word', core: [[303, 270], [312, 270], [312, 280], [303, 280]] }, { shape: [[10, 300], [60, 300], [60, 360]], kind: 'stroke' }, { shape: [[250, 196], [250, 150]], kind: 'stroke' }, { shape: [[150, 304], [350, 304]], kind: 'stroke' }, { shape: [[210, 313], [290, 313]], kind: 'stroke' }], box, 390)
    const out = rec.calls.findIndex((c) => c.method === 'set:globalCompositeOperation' && c.args[0] === 'destination-out')
    expect(out, 'the strip is cleared').toBeGreaterThan(0)
    expect(rec.calls.slice(0, out).filter((c) => c.method === 'fill').length, 'the two clear of the chip and the two words beside it, one inside the strip but off the outline\'s stroke, are filled; a silk stroke is a line, not filled').toBe(4)
    expect(rec.calls.slice(0, out).filter((c) => c.method === 'stroke').length, 'and grown, with the stroke clear of the chip').toBe(5)
    const back = rec.calls.findIndex((c, i) => i > out && c.method === 'set:globalCompositeOperation' && c.args[0] === 'source-over')
    expect(back, 'after the strip the kept words are drawn again').toBeGreaterThan(out)
    expect(rec.calls.slice(back).filter((c) => c.method === 'fill').length, 'both kept words, so the strip never cuts one').toBe(2)
    expect(rec.calls.find((c) => c.method === 'set:lineWidth')?.args[0], 'by KEEP_GROW each side').toBeCloseTo(2 * KEEP_GROW * 390)
    expect(rec.calls.slice(out).find((c) => c.method === 'set:lineWidth')?.args[0], 'the strip').toBeCloseTo(2 * OUTLINE_CLEAR * 390)
    expect(KEEP_GROW * 390, 'a few pixels at phone size').toBeGreaterThanOrEqual(2)
    expect(zone.calls.filter((c) => c.method === 'fill').length, 'the two by the chip and the word whose letters reach under it are cleared whole').toBe(3)
    expect(zone.calls.filter((c) => c.method === 'stroke').length, 'grown as the kept are, with the stroke that reaches the chip, the one that runs along its edge past both corners, and the chip\'s own silk line wholly inside the band').toBe(6)
  })

  it('holds the stop under the rim: an LED off the rim is dimmed under the rim\'s level and greyed to the colour of the rim\'s lit line, not of the gold leads beside it, which grey with it; the rim keeps its own', () => {
    const w = 20
    const h = 4
    const rgba = new Uint8ClampedArray(w * h * 4)
    const ring = new Uint8ClampedArray(w * h)
    const set = (x: number, y: number, c: number[]): void => { for (let k = 0; k < 3; k++) rgba[4 * (y * w + x) + k] = c[k] as number }
    for (let x = 0; x < 10; x++) { set(x, 1, [200, 200, 196]); ring[w + x] = 255 }
    for (let x = 0; x < 14; x++) { set(x, 2, [200, 150, 40]); ring[2 * w + x] = 255 }
    set(15, 1, [250, 40, 30])
    set(16, 1, [60, 200, 70])
    set(17, 1, [30, 30, 30])
    holdStop(rgba, ring)
    const at = (x: number, y: number): number[] => [0, 1, 2].map((k) => rgba[4 * (y * w + x) + k] as number)
    const luma = (c: number[]): number => 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number)
    const colour = (c: number[]): number => Math.max(...c) - Math.min(...c)
    expect(at(3, 1), 'the rim is untouched').toEqual([200, 200, 196])
    for (const x of [15, 16]) {
      expect(luma(at(x, 1)), `the LED at ${x} under the rim`).toBeLessThanOrEqual(STOP_LEVEL * luma([200, 200, 196]) + 1)
      expect(colour(at(x, 1)), `the LED at ${x} no more colourful than the rim`).toBeLessThanOrEqual(colour([200, 200, 196]) + 1)
    }
    expect(colour(at(12, 2)), 'gold leads inside the ring but under the rim\'s lit line are greyed too').toBeLessThanOrEqual(colour([200, 200, 196]) + 1)
    expect(at(17, 1), 'a dark grey stays').toEqual([30, 30, 30])
  })

  it('lights the rim in the accent when one is given, at the rim\'s own brightness, and greys the rest as before', () => {
    const w = 12
    const rgba = new Uint8ClampedArray(w * 4)
    const ring = new Uint8ClampedArray(w)
    for (let x = 0; x < 6; x++) { rgba.set([200, 200, 196], 4 * x); ring[x] = 255 }
    rgba.set([250, 40, 30], 4 * 8)
    holdStop(rgba, ring, '#2f8cff')
    const at = (x: number): number[] => [0, 1, 2].map((k) => rgba[4 * x + k] as number)
    const luma = (c: number[]): number => 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number)
    const [r, g, b] = at(2) as [number, number, number]
    expect(b > g && g > r, 'the rim takes the accent\'s hue').toBe(true)
    expect(Math.abs(luma(at(2)) - luma([200, 200, 196])), 'at the rim\'s brightness').toBeLessThan(3)
    expect(Math.max(...at(8)) - Math.min(...at(8)), 'the LED off the rim greys to the rim\'s measured colour').toBeLessThanOrEqual(5)
  })

  it('rolls a draw shot\'s white-hot copper back to copper, keeps the light\'s fall across a pad, and leaves a pixel whose smallest channel is low', () => {
    const px = [[250, 250, 240], [200, 200, 192], [240, 150, 30], [60, 50, 30]]
    const rgba = new Uint8ClampedArray(px.flatMap((c) => [...c, 255]))
    shoulder(rgba)
    const at = (i: number): number[] => [0, 1, 2].map((k) => rgba[4 * i + k] as number)
    for (const i of [0, 1]) {
      const [r, g, b] = at(i) as [number, number, number]
      expect(r > g && g > b, `pixel ${i} reads as copper, red over green over blue`).toBe(true)
      expect(b / r, `pixel ${i} far from white`).toBeLessThan(0.75)
    }
    expect((at(0)[0] as number) > (at(1)[0] as number), 'the brighter spot of a pad stays the brighter').toBe(true)
    expect(at(2), 'gold, its blue under the knee, untouched').toEqual([240, 150, 30])
    expect(at(3), 'dark copper untouched').toEqual([60, 50, 30])
    expect(Math.min(...at(0)) > DRAW_KNEE, 'the knee is above the copper it leaves').toBe(true)
  })

  it('names the chip on the lit marking\'s first line, the size line under it; the size line goes when the two are not whole in the body, the name too when it is not', () => {
    const box = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }]
    const width = (px: number, text: string): number => 0.6 * px * text.length
    const both = nameBlock(box, { x: 200, y: 190 }, width, 'ICE40UP5K', 40, '7.3 × 7.3 MM', 20)
    expect(both.name !== undefined && both.size !== undefined, 'both fit').toBe(true)
    expect((both.size?.y as number) > (both.name?.y as number), 'the size line under the name').toBe(true)
    expect((both.size?.px as number) < (both.name?.px as number), 'smaller than the name').toBe(true)
    expect(width(both.name?.px as number, 'ICE40UP5K'), 'the name within the body').toBeLessThanOrEqual(0.8 * 200 + 1e-6)
    const low = nameBlock(box, { x: 200, y: 285 }, width, 'ICE40UP5K', 40, '7.3 × 7.3 MM', 20)
    expect([low.name !== undefined, low.size !== undefined], 'near the lower edge the size line goes, the name stays').toEqual([true, false])
    const off = nameBlock(box, { x: 200, y: 310 }, width, 'ICE40UP5K', 40, '7.3 × 7.3 MM', 20)
    expect([off.name, off.size], 'a name that is not whole goes').toEqual([undefined, undefined])
  })

  it('puts the marking\'s first line where the lit shot draws it: above the lid\'s centre across the long side, on the other side when the part is turned, at the centre for a one-line marking', () => {
    const part = { x: 0, y: 0, w: 10, h: 10, rot: 0 }
    const [, y0] = markSpot(part, 'ICE40UP5K-SG48')
    expect(y0, 'two lines: the first above the centre').toBeLessThan(0)
    expect(markSpot({ ...part, turn: true }, 'ICE40UP5K-SG48')[1], 'turned: below').toBeCloseTo(-y0, 9)
    expect(markSpot(part, 'ATMEGA328P'), 'one line: the centre').toEqual([0, 0])
    const [x1, y1] = markSpot({ ...part, w: 6, h: 10 }, 'ICE40UP5K-SG48')
    expect([Math.abs(y1) < 1e-9, x1 > 0], 'a tall part reads along its long side: the first line sits off centre across it').toEqual([true, true])
  })

  it('draws the main chip\'s own pads in the print\'s line, thinner than the body\'s, one path', () => {
    const tl = film('kit-dev-coldfire-xilinx_5213.kicad_pcb', '16:9')
    const h = (tl.scene.montage as MontageScore).hype as HypeCut
    const pads = tl.scene.pads.filter((p) => p.hero === true)
    expect(pads.length, 'an LQFP100').toBe(100)
    const cam = makeCam(sampleShot(h.shots, (h.plan[122]?.clone ?? 0) / h.total), tl.width, tl.height)
    const rec = new RecordingCtx(tl.width, tl.height)
    drawPads(asCtx(rec), pads, cam, tl.width, tl.height, { light: '#c9dbf7' })
    expect(rec.calls.filter((c) => c.method === 'closePath').length, 'every pad outlined').toBe(100)
    expect(rec.calls.filter((c) => c.method === 'moveTo' || c.method === 'lineTo').length, 'each pad has at least four corners').toBeGreaterThanOrEqual(4 * 100)
    expect(rec.calls.filter((c) => c.method === 'stroke').length, 'one stroke').toBe(1)
    const width = rec.calls.find((c) => c.method === 'set:lineWidth')?.args[0] as number
    expect(width * (390 / tl.width), 'at least 1 px on a 390 px phone').toBeGreaterThanOrEqual(1)
    expect(rec.calls.find((c) => c.method === 'set:strokeStyle')?.args[0], 'in the ink of the neighbouring parts\' marks').toBe('#c9dbf7')
    const pad = rec.calls.find((c) => c.method === 'set:lineWidth')?.args[0] as number
    const body = new RecordingCtx(tl.width, tl.height)
    drawBody(asCtx(body), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], tl.width, { dark: '#000' })
    expect(pad, 'thinner than the body line').toBeLessThan(body.calls.find((c) => c.method === 'set:lineWidth')?.args[0] as number)
  })

  it('stands a size line inside the chip at the body\'s centre at its own size, smaller only where it would not fit', () => {
    const box = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }]
    expect(insideAt(box, 120, 30)).toEqual({ x: 200, y: 200, scale: 1 })
    expect(insideAt(box, 320, 30).scale, 'a line wider than the body shrinks to INSIDE_FIT of it').toBeCloseTo((INSIDE_FIT * 200) / 320, 9)
  })

  it('lays grain only on a lit build frame', () => {
    const tl = film('glasgow.kicad_pcb', '4:5')
    const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown }
    proto.getContext = function (this: HTMLCanvasElement): CanvasRenderingContext2D {
      const c = asCtx(new RecordingCtx(this.width, this.height)) as unknown as Record<string, unknown>
      c.createImageData = (w: number, hh: number): { data: Uint8ClampedArray } => ({ data: new Uint8ClampedArray(w * hh * 4) })
      return c as unknown as CanvasRenderingContext2D
    }
    for (const grained of [false, true]) {
      const g = new RecordingCtx(tl.width, tl.height)
      const gc = asCtx(g) as unknown as Record<string, unknown>
      gc.createPattern = (): object => ({})
      gradeBuild(gc as unknown as CanvasRenderingContext2D, 120, tl.width, tl.height, grained)
      expect(g.calls.some((c) => c.method === 'set:globalCompositeOperation' && c.args[0] === 'overlay'), `grained ${grained}`).toBe(grained)
    }
  })
})

describe('a name behind parts', () => {
  it('is cut only where the covering part shows an edge against the ground; where it does not, the name stands in front', () => {
    const w = 3
    const h = 12
    const cover = new Float32Array(w * h)
    const luma = new Float32Array(w * h).fill(0.02)
    for (let y = 6; y < h; y++) {
      cover[y * w] = 1
      cover[y * w + 1] = 1
      luma[y * w] = 0.02 + SEEN_EDGE / 2
      luma[y * w + 1] = 0.5
    }
    expect(unseenColumns(cover, luma, w, h), 'a dark part on the dark ground: in front; a lit edge: behind; no part: nothing to do').toEqual([true, false, false])
  })
})
