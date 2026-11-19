// glyph look-loop: stills at chosen frames, one sheet per board
// usage: npx tsx scripts/glyph-stills.mts glasgow 4:5 0,15,29,30,31,32,34 [out]
import { execFileSync } from 'node:child_process'
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
const [boardsArg = 'glasgow', aspect = '4:5', framesArg = '0,30,60,120,200,300,359', outArg = 'review/glyph-stills'] = process.argv.slice(2)
const out = path.resolve(root, outArg)
mkdirSync(out, { recursive: true })
const chromiumOptions = { gl: (process.env.SILK_REEL_GL ?? 'angle') as OpenGlRenderer }
const serveUrl = await bundle({ entryPoint: path.join(root, 'packages/render/src/remotion-entry.tsx'), onProgress: () => undefined, enableCaching: false })
try {
  for (const board of boardsArg.split(',')) {
    const config = { ...defaultFilmConfig(board), style: 'glyph', aspect, title: { name: DEMO_TITLES[board] ?? board }, output: { ...defaultFilmConfig(board).output, ...ASPECT_SIZE[aspect as Aspect] } } as unknown as FilmConfig
    const model = await loadDemoBoard(board)
    const bodies = (await loadPartBodies(model, { boardDir: path.join(root, 'fixtures/boards'), dirs: [] })).bodies
    const inputProps = { timeline: compileTimeline(model, config, bodies), quality: process.env.DRAFT === '1' ? 'draft' : 'final' }
    const composition = await selectComposition({ serveUrl, id: 'film', inputProps })
    const files: string[] = []
    for (const frame of framesArg.split(',').map(Number)) {
      const file = path.join(out, `${board}-${aspect.replace(':', 'x')}-f${String(frame).padStart(3, '0')}.jpg`)
      await renderStill({ composition, serveUrl, inputProps, frame, output: file, imageFormat: 'jpeg', jpegQuality: 92, chromiumOptions })
      files.push(file)
    }
    const sheet = path.join(out, `${board}-${aspect.replace(':', 'x')}-sheet.jpg`)
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `${files.map((_, i) => `[${i}]scale=-1:600[s${i}]`).join(';')};${files.map((_, i) => `[s${i}]`).join('')}hstack=${files.length}`, sheet])
    console.log(path.relative(root, sheet))
  }
} finally {
  rmSync(serveUrl, { recursive: true, force: true })
}
