import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, compileTimeline, FENCE_DEPTH, FENCE_MOST, makeCam, nearShare, sampleShot } from '@silk-reel/choreo'
import type { FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import path from 'node:path'
import { DEMO_TITLES, defaultFilmConfig, loadDemoBoard } from './boards'
import { loadPartBodies } from './models'

describe('the held poster of a demo film', () => {
  it('turns to a heading whose out-of-focus foreground covers at most FENCE_MOST of the frame where one keeps the main chip as clear', async () => {
    const board = 'icebreaker'
    const config = { ...defaultFilmConfig(board), style: 'trace', aspect: '9:16', title: { name: DEMO_TITLES[board] }, output: { ...defaultFilmConfig(board).output, ...ASPECT_SIZE['9:16'] } } as unknown as FilmConfig
    const { width: W, height: H } = ASPECT_SIZE['9:16']
    const model = await loadDemoBoard(board)
    const { bodies } = await loadPartBodies(model, { boardDir: path.resolve(__dirname, '../../../fixtures/boards'), dirs: [] })
    const s = (compileTimeline(model, config, bodies) as TraceTimeline).scene
    const hero = s.parts.find((pt) => pt.hero === true)
    if (hero === undefined) throw new Error('no main chip')
    const cam = makeCam(sampleShot(s.shots, 1), W, H)
    const depth = (hero.x - cam.pos[0]) * cam.f[0] + (-hero.y - cam.pos[1]) * cam.f[1] + (hero.z / 2 - cam.pos[2]) * cam.f[2]
    const blockers = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
    expect(nearShare(cam, W, H, blockers, FENCE_DEPTH * depth)).toBeLessThanOrEqual(FENCE_MOST)
  }, 120_000)
})
