// trace frames at native size: renders chosen frames of one trace film to PNG and prints the time each took
// usage: [POWER=leds] [NOPULSE=1] [QUALITY=draft] [SAMPLES=32] [LOOK=key=value,...] npx tsx scripts/trace-frames.mts icebreaker 4:5 0,69,150,220-240:2 [out]
// frames: a list of frame numbers and ranges a-b or a-b:step; LOOK passes renderer look overrides (tonemap=neutral|agx|aces, studio=high)
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition } from '@remotion/renderer'
import type { OpenGlRenderer } from '@remotion/renderer'
import { ASPECT_SIZE, compileTimeline } from '../packages/choreo/src/index.ts'
import type { Aspect, FilmConfig } from '../packages/choreo/src/index.ts'
import { DEMO_TITLES, loadDemoBoard, defaultFilmConfig } from '../packages/render-api/src/boards.ts'
import { loadPartBodies } from '../packages/render-api/src/models.ts'

const root = path.resolve(import.meta.dirname, '..')
const [board = 'icebreaker', aspect = '4:5', framesArg = '0', outArg = 'review/trace-frames'] = process.argv.slice(2)
const out = path.resolve(root, outArg)
mkdirSync(out, { recursive: true })
const frames = framesArg.split(',').flatMap((part) => {
  const m = /^(\d+)-(\d+)(?::(\d+))?$/.exec(part)
  if (m === null) return [Number(part)]
  const step = Number(m[3] ?? 1)
  const list: number[] = []
  for (let f = Number(m[1]); f <= Number(m[2]); f += step) list.push(f)
  return list
})
const look = Object.fromEntries((process.env.LOOK ?? '').split(',').filter((s) => s.includes('=')).map((s) => s.split('=') as [string, string]))
const samples = process.env.SAMPLES === undefined ? undefined : Number(process.env.SAMPLES)
const chromiumOptions = { gl: (process.env.SILK_REEL_GL ?? 'angle') as OpenGlRenderer }
const serveUrl = await bundle({ entryPoint: path.join(root, 'packages/render/src/remotion-entry.tsx'), onProgress: () => undefined, enableCaching: false })
try {
  const size = ASPECT_SIZE[aspect as Aspect]
  const config = { ...defaultFilmConfig(board), style: 'trace', aspect, title: { name: DEMO_TITLES[board] ?? board }, output: { ...defaultFilmConfig(board).output, ...size } } as unknown as FilmConfig
  const model = await loadDemoBoard(board)
  const bodies = (await loadPartBodies(model, { boardDir: path.join(root, 'fixtures/boards'), dirs: [] })).bodies
  const timeline = compileTimeline(model, { ...config, ...(process.env.MATTE === undefined ? {} : { transparent: true }), ...(process.env.POWER === undefined ? {} : { power: process.env.POWER as FilmConfig['power'] }) }, bodies)
  if (process.env.NOPULSE !== undefined && timeline.style === 'trace') {
    const from = timeline.scene.acts.power[0]
    for (const layer of timeline.scene.layers) for (let i = 0; i < layer.energy.length; i++) if ((layer.energy[i] as number) >= from) layer.energy[i] = (layer.energy[i] as number) + 2
  }
  const inputProps = { timeline, ...(samples === undefined ? {} : { samples }), ...(Object.keys(look).length === 0 ? {} : { look }), ...(process.env.QUALITY === 'draft' ? { quality: 'draft' as const } : {}), ...(process.env.MATTE === undefined ? {} : { matte: true }) }
  const composition = await selectComposition({ serveUrl, id: 'film', inputProps, chromiumOptions })
  for (const frame of frames) {
    const file = path.join(out, `${board}-${aspect.replace(':', 'x')}-f${String(frame).padStart(3, '0')}.png`)
    const t0 = Date.now()
    await renderStill({ composition, serveUrl, inputProps, frame, output: file, imageFormat: 'png', chromiumOptions, timeoutInMilliseconds: 600000, onBrowserLog: (l) => { if (process.env.LOG !== undefined) console.log('[browser]', l.type, l.text.slice(0, 400)) } })
    console.log(path.relative(root, file), `${Date.now() - t0}ms`)
  }
} finally {
  rmSync(serveUrl, { recursive: true, force: true })
}
