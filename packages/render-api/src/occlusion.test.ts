import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseKicadPcb } from '@silk-reel/ingest'
import { compileTimeline, DEMO_CAST_HINTS, heroOcclusion, makeCam, pinReach, sampleShot } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import { loadPartBodies } from './models.js'

const SIZE: Record<Aspect, [number, number]> = { '4:5': [1080, 1350], '1:1': [1080, 1080], '9:16': [1080, 1920], '16:9': [1920, 1080] }

describe('the breath with STEP bodies', () => {
  it('glasgow: no part model covers the hero or its pin rows from the breath through power-on, in every aspect', async () => {
    const board = parseKicadPcb(await readFile('fixtures/boards/glasgow.kicad_pcb', 'utf8'), 'glasgow.kicad_pcb')
    const { bodies } = await loadPartBodies(board, { boardDir: 'fixtures/boards', dirs: [] })
    for (const aspect of Object.keys(SIZE) as Aspect[]) {
      const [width, height] = SIZE[aspect]
      const config: FilmConfig = { style: 'trace', aspect, knobs: {}, seed: 42, duration: 'auto', output: { width, height, fps: 30 }, title: { name: 'Glasgow' }, ...(DEMO_CAST_HINTS.glasgow === undefined ? {} : { cast: DEMO_CAST_HINTS.glasgow }) }
      const s = (compileTimeline(board, config, bodies) as TraceTimeline).scene
      const hero = s.parts.find((pt) => pt.hero === true)
      expect(hero).toBeDefined()
      if (hero === undefined) continue
      const reach = pinReach(hero, s.pads.filter((pd) => pd.hero === true))
      const others = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
      for (let b = 12; b <= 15.5; b += 0.25) {
        const covered = heroOcclusion(makeCam(sampleShot(s.shots, b / 24), width, height), width, height, hero, others, reach).covered
        expect(covered, `${aspect} beat ${b}`).toBe(0)
      }
    }
  }, 120_000)
})
