// hype-cut look-loop: the trace scene under the trailer cut's own camera, phases and light
// usage: npx tsx scripts/montage-hype.mts board aspect stills|film [out] [frames]
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition } from '@remotion/renderer'
import type { OpenGlRenderer } from '@remotion/renderer'
import { ASPECT_SIZE, compileTimeline, hypeCut } from '../packages/choreo/src/index.ts'
import type { Aspect, FilmConfig } from '../packages/choreo/src/index.ts'
import { DEMO_TITLES, loadDemoBoard, defaultFilmConfig } from '../packages/render-api/src/boards.ts'
import { loadPartBodies } from '../packages/render-api/src/models.ts'
import { renderFilm } from '../packages/render-api/src/render-film.ts'

const root = path.resolve(import.meta.dirname, '..')
const [board = 'glasgow', aspect = '9:16', mode = 'stills', outArg = 'review/montage-r17', framesArg] = process.argv.slice(2)
const out = path.resolve(root, outArg)
mkdirSync(out, { recursive: true })
const size = ASPECT_SIZE[aspect as Aspect]
const title = DEMO_TITLES[board]
const cast = defaultFilmConfig(process.env.HYPE_HINTS === 'none' ? undefined : board)
const config = { ...cast, style: 'montage', aspect, ...(title === undefined ? {} : { title: { name: title } }), output: { ...cast.output, ...size } } as unknown as FilmConfig
const model = await loadDemoBoard(board)
const bodies = (await loadPartBodies(model, { boardDir: path.join(root, 'fixtures/boards'), dirs: process.env.SILK_REEL_MODELS?.split(path.delimiter) ?? [] })).bodies
const base = compileTimeline(model, config, bodies)
if (base.style !== 'montage' || base.scene.montage === undefined) throw new Error('expected a montage timeline')
const hype = base.scene.montage.hype ?? hypeCut(base.scene, base.scene.montage, base.width, base.height, Number(framesArg ?? 360) || 360)
const timeline = { ...base, totalFrames: hype.frames, scene: { ...base.scene, montage: { ...base.scene.montage, hype } } }
const stem = `${board}-${aspect.replace(':', 'x')}`
const chromiumOptions = { gl: (process.env.SILK_REEL_GL ?? 'angle') as OpenGlRenderer }
const inputProps = { timeline, quality: (process.env.HYPE_QUALITY ?? (mode === 'film' ? 'final' : 'draft')) as 'draft' | 'final' }
writeFileSync(path.join(out, 'cuts.json'), JSON.stringify({ fps: timeline.fps, events: hype.events }, null, 1))
const serveUrl = await bundle({ entryPoint: path.join(root, 'packages/render/src/remotion-entry.tsx'), onProgress: () => undefined, enableCaching: false })
try {
  if (mode === 'film') {
    const film = path.join(out, `${stem}.mp4`)
    await renderFilm({ bundleLocationOverride: serveUrl, inputProps, outputLocation: film, audio: false })
    for (let a = 0; a < hype.frames; a += 60) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', film, '-vf', `select='not(mod(n\\,2))*between(n\\,${a}\\,${a + 59})',scale=195:-1,tile=10x3:padding=4:color=gray`, '-frames:v', '1', '-fps_mode', 'passthrough', '-q:v', '3', path.join(out, `${stem}-f${String(a).padStart(3, '0')}-every-2nd.jpg`)])
    }
    console.log(path.relative(root, film))
  } else {
    const frames = (process.env.HYPE_AT ?? '10,30,41,60,88,110,150,170,190,230,270,340').split(',').map(Number)
    const composition = await selectComposition({ serveUrl, id: 'film', inputProps })
    const files: string[] = []
    for (const frame of frames) {
      const file = path.join(out, `${stem}-still-${String(frame).padStart(3, '0')}.jpeg`)
      const t0 = Date.now()
      await renderStill({ composition, serveUrl, inputProps, frame, output: file, imageFormat: 'jpeg', jpegQuality: 85, chromiumOptions })
      console.log(path.relative(root, file), `${Date.now() - t0}ms`)
      files.push(file)
    }
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', `${files.map((_, i) => `[${i}]scale=390:-1[s${i}]`).join(';')};${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % 6) * 390}_${Math.floor(i / 6) * Math.round((390 * timeline.height) / timeline.width)}`).join('|')}`, '-q:v', '3', path.join(out, `${stem}-stills.jpg`)])
  }
} finally {
  rmSync(serveUrl, { recursive: true, force: true })
}
