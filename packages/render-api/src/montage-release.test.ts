import { describe, expect, it } from 'vitest'
import { ASPECT_SIZE, compileTimeline, hypeCut, makeCam, MARK_LEAN, project, sampleShot } from '@silk-reel/choreo'
import type { Aspect, HypeCut, TraceTimeline } from '@silk-reel/choreo'
import { DEMO_TITLES, defaultFilmConfig, loadDemoBoard } from './boards.js'
import { loadPartBodies } from './models.js'

const shipped = async (board: string, aspect: Aspect): Promise<{ tl: TraceTimeline; h: HypeCut }> => {
  const model = await loadDemoBoard(board)
  const { bodies } = await loadPartBodies(model, { boardDir: 'fixtures/boards', dirs: [] })
  const cast = defaultFilmConfig(board)
  const tl = compileTimeline(model, { ...cast, style: 'montage', aspect, title: { name: DEMO_TITLES[board] as string }, output: { ...cast.output, ...ASPECT_SIZE[aspect] } }, bodies) as TraceTimeline
  if (tl.scene.montage === undefined) throw new Error('expected a montage timeline')
  return { tl, h: hypeCut(tl.scene, tl.scene.montage, tl.width, tl.height) }
}

const poseAt = (h: HypeCut, f: number) => sampleShot(h.shots, (h.plan[f]?.clone ?? 0) / h.total)

const READS_R7: Record<string, Array<[number, number, number, number]>> = {
  'glasgow 16:9': [[195, 1169.36, 687.38, 1.6208], [224, 1173.03, 401.89, 1.6854], [225, 1480.71, 569.56, 1.5708], [234, 1480.71, 521.07, 1.5708], [235, 451.32, 544.23, -1.5708], [244, 451.32, 591.95, -1.5708], [245, 511.09, 776.98, 0.0000], [254, 558.82, 776.98, 0.0000]],
  'glasgow 4:5': [[195, 675.97, 774.09, 1.6208], [224, 668.85, 575.24, 1.6854], [225, 861.51, 698.95, 1.5708], [234, 861.51, 659.66, 1.5708], [235, 391.68, 870.20, 1.5708], [244, 391.68, 838.78, 1.5708], [245, 941.18, 618.23, 1.5708], [254, 941.18, 601.66, 1.5708]],
  'glasgow 9:16': [[195, 683.86, 1041.20, 1.6208], [224, 682.03, 840.13, 1.6854], [225, 798.64, 964.75, 1.5708], [234, 798.64, 925.46, 1.5708], [235, 391.68, 1136.00, 1.5708], [244, 391.68, 1104.58, 1.5708], [245, 941.18, 881.70, 1.5708], [254, 941.18, 868.95, 1.5708]],
  'glasgow 1:1': [[195, 669.89, 642.27, 1.6208], [224, 668.51, 440.41, 1.6854], [225, 861.51, 563.95, 1.5708], [234, 861.51, 524.66, 1.5708], [235, 438.32, 682.39, 1.5708], [244, 438.32, 650.96, 1.5708], [245, 298.78, 779.72, 0.0000], [254, 312.97, 779.72, 0.0000]],
  'icebreaker 16:9': [[225, 392.24, 285.70, 0.0000], [234, 437.43, 285.70, 0.0000], [245, 889.79, 285.70, 0.0000], [254, 934.98, 285.70, 0.0000]],
  'icebreaker 4:5': [[195, 229.23, 671.61, 0.0900], [224, 401.54, 674.09, -0.0392], [225, 508.38, 557.84, 0.0000], [234, 530.27, 557.84, 0.0000], [235, 167.61, 574.10, 0.0000], [244, 183.22, 574.10, 0.0000], [245, 567.96, 789.01, -1.5708], [254, 567.96, 810.89, -1.5708]],
  'icebreaker 9:16': [[195, 229.71, 947.80, 0.0900], [224, 398.96, 950.53, -0.0392], [225, 517.82, 867.57, 0.0000], [234, 539.71, 867.57, 0.0000], [235, 167.61, 839.90, 0.0000], [244, 183.22, 839.90, 0.0000], [245, 567.96, 1054.81, -1.5708], [254, 567.96, 1076.69, -1.5708]],
  'icebreaker 1:1': [[195, 231.21, 529.08, 0.0900], [224, 398.98, 536.24, -0.0392], [225, 215.55, 393.55, 0.0000], [239, 238.91, 393.55, 0.0000], [240, 502.09, 393.55, 0.0000], [254, 525.45, 393.55, 0.0000]],
  'kit-dev-coldfire-xilinx_5213 16:9': [[195, 865.83, 423.75, 0.0900], [224, 1332.52, 421.55, 0.0254], [240, 1031.96, 672.74, 0.0000], [254, 1072.21, 672.74, 0.0000]],
  'kit-dev-coldfire-xilinx_5213 4:5': [[195, 548.93, 727.97, 0.0900], [224, 727.56, 642.41, 0.0254], [225, 453.85, 583.58, 0.0000], [234, 476.62, 583.58, 0.0000], [245, 757.29, 592.71, 0.0000], [254, 783.48, 592.71, 0.0000]],
  'kit-dev-coldfire-xilinx_5213 9:16': [[195, 679.14, 1012.21, 0.0900], [224, 875.46, 977.21, -0.0392], [225, 308.45, 852.94, 1.5708], [234, 308.45, 824.13, 1.5708], [235, 596.93, 872.21, 1.5708], [244, 596.93, 847.40, 1.5708], [245, 284.30, 980.59, 1.5708], [254, 284.30, 951.78, 1.5708]],
  'kit-dev-coldfire-xilinx_5213 1:1': [[225, 785.81, 440.57, 0.0000], [234, 812.00, 440.57, 0.0000], [245, 646.57, 715.99, 1.5708], [254, 646.57, 689.80, 1.5708]],
}

const TURNED_R7: Record<string, Array<[number, number, number, number, number]>> = {
  'icebreaker 16:9': [[195, 489.9, 540.0, 0.0900, -0.3927], [224, 489.9, 540.0, -0.0392, -0.3927], [235, 669.4, 746.8, 1.5708, -1.9635], [244, 669.4, 746.8, 1.5708, -1.9635]],
  'kit-dev-coldfire-xilinx_5213 16:9': [[225, 605.5, 508.6, -3.1416, -1.9635], [239, 605.5, 508.6, -3.1416, -1.9635]],
  'kit-dev-coldfire-xilinx_5213 4:5': [[235, 288.7, 652.8, -3.1416, -1.9635], [244, 288.7, 652.8, -3.1416, -1.9635]],
  'kit-dev-coldfire-xilinx_5213 1:1': [[195, 477.5, 459.2, 0.0900, 1.1781], [224, 810.8, 459.2, 0.0254, 1.1781], [235, 288.7, 517.8, -3.1416, -1.9635], [244, 288.7, 517.8, -3.1416, -1.9635]],
}

describe('the release with the real part models', { timeout: 900_000 }, () => {
  it('every release shot that reads in round 7 stands as round 7 at its first and last frame: its place, heading and direction', async () => {
    for (const [film, frames] of Object.entries(READS_R7)) {
      const [board, aspect] = film.split(' ') as [string, Aspect]
      const { h } = await shipped(board, aspect)
      for (const [f, x, y, yaw] of frames) {
        const p = poseAt(h, f)
        expect([Math.abs(p.x - x) < 0.1, Math.abs(p.y - y) < 0.1, Math.abs(p.yaw - yaw) < 1e-3], `${film} f${f}`).toEqual([true, true, true])
      }
    }
  })

  it('a release shot that reads upside down in round 7 turns about round 7\'s own target (the point the shot is built on) by the turn the rules give it, whichever way it pans', async () => {
    for (const [film, shots] of Object.entries(TURNED_R7)) {
      const [board, aspect] = film.split(' ') as [string, Aspect]
      const { h } = await shipped(board, aspect)
      for (const [f, x, y, yaw, turn] of shots) {
        const p = poseAt(h, f)
        expect([Math.abs(p.focus.x - x) < 0.1, Math.abs(p.focus.y - y) < 0.1, Math.abs(p.yaw - (yaw + turn)) < 1e-3], `${film} f${f}`).toEqual([true, true, true])
      }
    }
  })

  it('kit 16:9: the pull-back opens with the main chip\'s marking within 80° of level, where round 7 opened at 101°', async () => {
    const { tl, h } = await shipped('kit-dev-coldfire-xilinx_5213', '16:9')
    const hero = tl.scene.parts.find((q) => q.hero === true)
    if (hero === undefined) throw new Error('no main chip')
    const cam = makeCam(poseAt(h, 255), tl.width, tl.height)
    const d = h.late.turns[tl.scene.parts.indexOf(hero)] === true ? -1 : 1
    const m = hero.w >= hero.h ? { x: Math.cos(hero.rot), y: Math.sin(hero.rot) } : { x: -Math.sin(hero.rot), y: Math.cos(hero.rot) }
    const c = project(cam, hero.x, hero.y, hero.z)
    const q = project(cam, hero.x + d * m.x, hero.y + d * m.y, hero.z)
    expect(Math.abs(Math.atan2((q.y - c.y) * tl.height, (q.x - c.x) * tl.width))).toBeLessThanOrEqual(MARK_LEAN + 1e-9)
  })
})
