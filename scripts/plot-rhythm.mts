import { loadDemoBoard, defaultFilmConfig } from '../packages/render-api/src/boards.ts'
import { ASPECT_SIZE, compileTimeline, plotFrame } from '../packages/choreo/src/index.ts'
import type { FilmConfig, TraceTimeline } from '../packages/choreo/src/index.ts'

const boards = (process.argv[2] ?? 'glasgow,icebreaker,StickHub,ecc83-pp,video,kit-dev-coldfire-xilinx_5213').split(',')
const aspect = (process.argv[3] ?? '4:5') as keyof typeof ASPECT_SIZE

for (const name of boards) {
  const base = defaultFilmConfig(name)
  const cfg: FilmConfig = { ...base, style: 'plot', aspect, output: { ...base.output, ...ASPECT_SIZE[aspect] } }
  const tl = compileTimeline(await loadDemoBoard(name), cfg) as TraceTimeline
  const plot = tl.scene.plot
  if (plot === undefined) continue
  const fps = tl.fps
  const events: Array<[string, number, string]> = []
  const beat = (b: number, what: string, why = ''): void => { events.push([what, b, why]) }
  const live = plot.nib.strokes.filter((s) => s.t0 >= 0 && s.t0 < 1)
  for (const s of live) beat(s.t1 * 24, 'nib lift', 'constant pencil speed: lifts fall where the copper ends')
  for (const [i, s] of plot.bus.strokes.entries()) beat(s.t0 * 24, `bus line ${i + 1} starts`, 'a bundle over 10 lines staggers by 2.6 beats / n')
  for (const s of plot.bus.sweep.filter((q) => q.t0 >= 0)) beat(s.t0 * 24, 'neighbour sweep line')
  beat(6, 'outline (cut)')
  beat(6.5, 'drills + parts')
  beat(7, 'width dimension')
  beat(7.5, 'height dimension + turn note')
  beat(8, 'tip-up starts, bodies fade in over 7 frames')
  beat(9, 'stack lifts')
  beat(9.25, 'stack labels write on')
  beat(10, 'projection lines')
  for (let j = 0; j < plot.stack.length - 1; j++) beat(11.5 - (0.5 * j) / Math.max(1, plot.stack.length - 2), `layer gap ${j + 1} lands`)
  beat(12, 'parts land, stack closed, hero turn begins')
  for (const m of plot.marks) beat(m.t * 24, `callout ${m.text}`)
  beat((plot.flow.path[0]?.p0 ?? 0) * 24, 'power path starts')
  beat(plot.flow.end * 24, 'power path reaches the hero pins (ticks)')
  beat(17, 'pull-back: one transform carries board and callouts into the hero panel')
  beat(17.7, 'pencil returns')
  beat(18, 'pencil rules the sheet border')
  beat(18.3, 'hero panel border; hero panel and extra callouts fill')
  beat(18.5, 'plan border, then content')
  beat(19, 'stack border, then content')
  beat(19.5, 'detail border, then content')
  beat(20, 'elevation border, then content')
  beat(20.15, 'title block border, then content')
  beat(20.3, 'title stamps; pencil leaves')
  beat(20.5, 'sheet held; only the supply pulse moves')
  console.log(`\n${name} ${aspect} (${fps} fps, ${fps / 2} frames a beat)`)
  for (const [what, b, why] of events.sort((x, y) => x[1] - y[1])) {
    const frame = plotFrame(b / 24, tl.totalFrames)
    const ok = Math.abs(frame - Math.round(frame)) < 1e-6 ? 'on a frame' : `BETWEEN FRAMES${why.length > 0 ? `: ${why}` : ''}`
    console.log(`  beat ${b.toFixed(2).padStart(5)}  frame ${frame.toFixed(1).padStart(6)}  ${what.padEnd(36)} ${ok}`)
  }
}
