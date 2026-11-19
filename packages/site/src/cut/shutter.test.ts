import { describe, expect, it } from 'vitest'
import { activeSlat, orbit, project, slatAngles } from './shutter'

const angles = (front: number, fan: number, back: number) => {
  const s = slatAngles(48, { front, fan, reach: 0.13, settle: 0.03, back }, 30)
  return Array.from({ length: 48 }, (_, i) => s[i * 3 + 1] ?? NaN)
}

describe('shutter', () => {
  it('lies flat on the drawing before the intro, so the plot reads whole', () => {
    for (const a of angles(1.12, 0, 0)) expect(a).toBeCloseTo(0, 6)
  })

  it('lands every slat on the film, so the hand-off to the flat film has no seam', () => {
    for (const a of angles(-0.5, 1, 0)) expect(Math.abs(a - Math.PI)).toBeLessThan(0.01)
  })

  it('turns every slat back to the drawing once the second turn is done', () => {
    for (const a of angles(-0.5, 1, 1.02)) expect(Math.abs(a - 2 * Math.PI)).toBeLessThan(0.01)
  })

  it('puts the red edge on the slat standing edge-on', () => {
    const at = angles(0.46, 1, 0)
    const i = Math.round(activeSlat(48, { front: 0.46, fan: 1, reach: 0.13, settle: 0.03, back: 0 }))
    expect(Math.abs((at[i] ?? 0) - Math.PI / 2)).toBeLessThan(0.5)
  })

  it('projects the flat film onto its own rectangle when the camera faces it', () => {
    const film = { x: 200, y: 100, w: 1600, h: 900 }
    const [x, y] = project(0.25, 0.75, film, orbit(0, 0), 1920, 1080)
    expect(x).toBeCloseTo(600, 6)
    expect(y).toBeCloseTo(775, 6)
  })
})
