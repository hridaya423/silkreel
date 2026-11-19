// montage look-loop: chosen frames of the montage film at full size, one sheet per board
// usage: npx tsx scripts/montage-stills.mts icebreaker,glasgow 4:5 [key|0,20,44,...] [out]
// key: the middle frame of every shot; part models: SILK_REEL_MODELS=dir1:dir2, or none
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition } from '@remotion/renderer'
import type { OpenGlRenderer } from '@remotion/renderer'
import { ASPECT_SIZE, compileTimeline } from '../packages/choreo/src/index.ts'
import type { Aspect, FilmConfig } from '../packages/choreo/src/index.ts'
import { parseKicadPcb } from '../packages/ingest/src/index.ts'
import { DEMO_TITLES, loadDemoBoard, defaultFilmConfig } from '../packages/render-api/src/boards.ts'
import { loadPartBodies } from '../packages/render-api/src/models.ts'

const root = path.resolve(import.meta.dirname, '..')
const [boardsArg = 'icebreaker', aspect = '4:5', atArg = 'key', outArg = 'review/montage-stills'] = process.argv.slice(2)
const out = path.resolve(root, outArg)
mkdirSync(out, { recursive: true })
const chromiumOptions = { gl: (process.env.SILK_REEL_GL ?? 'angle') as OpenGlRenderer }
const serveUrl = await bundle({ entryPoint: path.join(root, 'packages/render/src/remotion-entry.tsx'), onProgress: () => undefined, enableCaching: false })
try {
  for (const arg of boardsArg.split(',')) {
    const own = arg.endsWith('.kicad_pcb')
    const board = own ? path.basename(arg, '.kicad_pcb') : arg
    const size = ASPECT_SIZE[aspect as Aspect]
    const title = DEMO_TITLES[board]
    const config = { ...defaultFilmConfig(board), style: 'montage', aspect, ...(title === undefined ? {} : { title: { name: title } }), output: { ...defaultFilmConfig(board).output, ...size } } as unknown as FilmConfig
    const model = own ? parseKicadPcb(readFileSync(arg, 'utf8'), path.basename(arg)) : await loadDemoBoard(board)
    const dirs = process.env.SILK_REEL_MODELS?.split(path.delimiter) ?? []
    const bodies = dirs[0] === 'none' ? undefined : (await loadPartBodies(model, { boardDir: own ? path.dirname(path.resolve(arg)) : path.join(root, 'fixtures/boards'), dirs })).bodies
    const timeline = compileTimeline(model, config, bodies)
    if (timeline.style !== 'montage') throw new Error('expected a montage timeline')
    const shots = timeline.scene.montage?.shots ?? []
    const frames = atArg === 'key' ? shots.map((s) => Math.floor((s.f0 + s.f1) / 2)) : atArg.split(',').map(Number)
    const inputProps = { timeline, quality: 'draft' }
    const composition = await selectComposition({ serveUrl, id: 'film', inputProps })
    const files: string[] = []
    for (const frame of frames) {
      const kind = shots.find((s) => frame >= s.f0 && frame < s.f1)?.kind ?? 'end'
      const file = path.join(out, `${board}-${aspect.replace(':', 'x')}-${String(frame).padStart(3, '0')}-${kind}.png`)
      const t0 = Date.now()
      await renderStill({ composition, serveUrl, inputProps, frame, output: file, imageFormat: 'png', chromiumOptions })
      console.log(path.relative(root, file), `${Date.now() - t0}ms`)
      files.push(file)
    }
    const sheet = path.join(out, `${board}-${aspect.replace(':', 'x')}-sheet.png`)
    const cols = Math.min(6, files.length)
    if (files.length > 1) execFileSync('ffmpeg', ['-v', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `${files.map((_, i) => `[${i}]scale=-1:450[s${i}]`).join(';')};${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${files.length}:layout=${files.map((_, i) => `${i % cols === 0 ? '0' : Array.from({ length: i % cols }, (_, j) => `w${j}`).join('+')}_${Math.floor(i / cols) === 0 ? '0' : Array.from({ length: Math.floor(i / cols) }, (_, j) => `h${j * cols}`).join('+')}`).join('|')}:fill=gray`, sheet])
    console.log(path.relative(root, sheet))
  }
} finally {
  rmSync(serveUrl, { recursive: true, force: true })
}
