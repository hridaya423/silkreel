import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import type { FilmConfig } from '../types'
import { buildTraceScene } from './scene'
import { boardModel } from '../../test/helpers'

// regression guard only: pins the approved glasgow 4:5 schedule so later
// changes that drift the growth timings fail loudly. Not a quality claim.
describe('approved trace schedule', () => {
  const config: FilmConfig = {
    style: 'trace',
    aspect: '4:5',
    knobs: {},
    seed: 42,
    duration: 'auto',
    output: { width: 1080, height: 1350, fps: 30 }
  }
  const { scene } = buildTraceScene(boardModel('glasgow.kicad_pcb'), resolveConfig(config), 42)

  it('pins seg/pad counts and the earliest growth times', () => {
    const segCount = scene.layers.reduce((n, l) => n + l.segs.length / 7, 0)
    expect(segCount).toMatchInlineSnapshot(`4715`)
    expect(scene.pads.length).toMatchInlineSnapshot(`1137`)
    expect(scene.beats).toMatchInlineSnapshot(`
      {
        "growth": [
          0,
          0.20833333333333331,
        ],
        "hold": [
          0.8333333333333333,
          1,
        ],
        "outline": [
          0,
          0.041666666666666664,
        ],
        "pads": [
          0,
          0.041666666666666664,
        ],
        "silk": [
          0.29166666666666663,
          0.31249999999999994,
        ],
        "zones": [
          0.14583333333333331,
          0.1847222222222222,
        ],
      }
    `)
    const t0s = scene.layers
      .flatMap((l) => l.segs.filter((_, i) => i % 7 === 5))
      .sort((a, b) => a - b)
      .slice(0, 5)
      .map((t) => Math.round(t * 1e4) / 1e4)
    expect(t0s).toMatchInlineSnapshot(`
      [
        -0.3362,
        -0.3361,
        -0.3359,
        -0.3357,
        -0.3356,
      ]
    `)
  })
})
