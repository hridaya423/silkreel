import { describe, expect, it } from 'vitest'
import { place } from './models.js'

const raw = { pos: [0, 1, 0], nor: [0, 1, 0], col: [1, 1, 1], idx: [0, 0, 0] }
const ref = (rotate = { x: 0, y: 0, z: 0 }, offset = { x: 0, y: 0, z: 0 }) => ({ path: 'm.step', offset, scale: { x: 1, y: 1, z: 1 }, rotate })
const near = (a: number[], b: number[]): void => {
  for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i] as number, 6)
}

describe('placing a model in its footprint', () => {
  it('turns the model y-up into the footprint y-down', () => {
    near(place(raw, ref(), false).pos, [0, -1, 0])
  })

  it('stands a y-up model upright under KiCad rotate x -90', () => {
    const out = place(raw, ref({ x: -90, y: 0, z: 0 }), false)
    near(out.pos, [0, 0, 1])
    near(out.nor, [0, 0, 1])
  })

  it('turns a positive z rotation clockwise seen from above, then offsets', () => {
    near(place({ ...raw, pos: [1, 0, 0] }, ref({ x: 0, y: 0, z: 90 }, { x: 2, y: 0, z: 0.5 }), false).pos, [2, 1, 0.5])
  })

  it('lays a 1x02 socket model along its pads under rotate z -90', () => {
    near(place({ ...raw, pos: [0, -2.54, 0] }, ref({ x: 0, y: 0, z: -90 }), false).pos, [2.54, 0, 0])
  })

  it('mirrors y on the back, where KiCad stores the footprint flipped', () => {
    near(place(raw, ref(), true).pos, [0, 1, 0])
  })
})
