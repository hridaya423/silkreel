import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../config'
import type { FilmConfig, PartBodies, PartMesh } from '../types'
import { buildTraceScene } from './scene'
import { boardModel } from '../../test/helpers'

const config: FilmConfig = { style: 'trace', aspect: '4:5', knobs: {}, seed: 1, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } }
const box: PartMesh = { pos: '', nor: '', col: '', idx: '', min: [-1, -0.5, 0], max: [3, 0.5, 2] }

describe('parts wearing their own models', () => {
  const board = boardModel('icebreaker.kicad_pcb')
  const plain = buildTraceScene(board, resolveConfig(config), 1).scene
  const header = board.footprints.find((fp) => fp.model?.startsWith('PinHeader_') === true && fp.layer === 'F.Cu')
  const bodies: PartBodies = { meshes: [box, box], byRef: { [header?.ref ?? '']: 1 } }
  const { scene } = buildTraceScene(board, resolveConfig(config), 1, bodies)
  const worn = scene.parts.filter((pt) => pt.mesh !== undefined)

  it('carries only the meshes a shown part wears', () => {
    expect(header).toBeDefined()
    expect(worn).toHaveLength(1)
    expect(scene.meshes).toEqual([box])
    expect(worn[0]?.mesh?.id).toBe(0)
  })

  it('maps the footprint origin to where its pads are drawn, at the board scale', () => {
    const m = worn[0]?.mesh?.m as number[]
    const scale = scene.material.pxPerMm
    expect(Math.hypot(m[0] as number, m[1] as number)).toBeCloseTo(scale, 6)
    expect(Math.hypot(m[2] as number, m[3] as number)).toBeCloseTo(scale, 6)
    const pin1 = scene.pads.find((p) => Math.hypot(p.x - (m[4] as number), p.y - (m[5] as number)) < 0.01 * scale)
    expect(pin1).toBeDefined()
  })

  it('sizes the body from the mesh and drops the drawn header pins', () => {
    expect(worn[0]?.z).toBeCloseTo(2 * scene.material.pxPerMm, 6)
    expect(scene.parts.filter((pt) => pt.kind === 'pin').length).toBeLessThan(plain.parts.filter((pt) => pt.kind === 'pin').length)
  })
})
