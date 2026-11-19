#!/usr/bin/env tsx
// Taste lab: dump styled stills at chosen phases next to the same-phase stills
// of the private reference video, plus optional half-size animatics. The point
// is to compare our frames against the reference without rendering a full film.
// usage: npx tsx scripts/styleframes.mts --style glyph --boards icebreaker,glasgow
//        --aspect 4:5 --at 0.02,0.3,0.62,0.8 [--animatic] [--smooth]
//        [--palette mono] [--seed 42] [--out review/styleframes/<style>-<stamp>]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition } from '@remotion/renderer'
import type { OpenGlRenderer } from '@remotion/renderer'
import { ASPECT_SIZE, compileTimeline } from '../packages/choreo/src/index.js'
import type { Aspect, FilmConfig } from '../packages/choreo/src/index.js'
import { renderFilm } from '../packages/render-api/src/render-film.js'
import { DEMO_BOARDS, loadDemoBoard, defaultFilmConfig } from '../packages/render-api/src/boards.js'

const root = path.resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    style: { type: 'string', default: 'glyph' },
    boards: { type: 'string', default: 'all' },
    aspect: { type: 'string', default: '4:5' },
    at: { type: 'string', default: '0.02,0.3,0.62,0.8' },
    animatic: { type: 'boolean', default: false },
    smooth: { type: 'boolean', default: false },
    palette: { type: 'string', default: '' },
    seed: { type: 'string', default: '42' },
    out: { type: 'string', default: '' }
  }
})
const boards = values.boards === 'all' ? [...DEMO_BOARDS] : values.boards.split(',')
const phases = values.at.split(',').map(Number)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)
const out = values.out
  ? path.resolve(values.out)
  : path.join(root, 'review', 'styleframes', `${values.style}-${stamp}`)
mkdirSync(out, { recursive: true })

// same GL selection as renderFilm: angle uses the GPU, swangle for GPU-less CI
const chromiumOptions = { gl: (process.env.SILK_REEL_GL ?? 'angle') as OpenGlRenderer }
const entryPoint = path.join(root, 'packages/render/src/remotion-entry.tsx')
const bundleLocation = await bundle({ entryPoint, onProgress: () => undefined, enableCaching: false })

// private reference: copied per-run into review/ (gitignored), never committed elsewhere
const referencePath = path.join(out, 'reference.mp4')
const referenceSource = path.join(root, 'fixtures/reference/pcbanimation.mp4')
if (existsSync(referenceSource)) copyFileSync(referenceSource, referencePath)
else console.warn(`no reference video at ${referenceSource}; skipping reference stills`)
const refDuration = existsSync(referencePath)
  ? Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', referencePath]).toString().trim())
  : 0
if (refDuration) {
  for (const at of phases) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at * refDuration), '-i', referencePath,
      '-frames:v', '1', path.join(out, `reference-${at}.png`)])
  }
}

interface BoardResult { board: string; stills: Map<number, string>; animatics: string[] }
const results: BoardResult[] = []
try {
  for (const board of boards) {
    const size = ASPECT_SIZE[values.aspect as Aspect]
    const config = {
      ...defaultFilmConfig(board), style: values.style, aspect: values.aspect,
      output: { ...defaultFilmConfig(board).output, ...size },
      ...(values.palette ? { palette: values.palette } : {}),
      seed: Number(values.seed)
    } as unknown as FilmConfig
    const boardModel = await loadDemoBoard(board)
    const timeline = compileTimeline(boardModel, config)
    const inputProps = { timeline }
    const composition = await selectComposition({ serveUrl: bundleLocation, id: 'film', inputProps })
    const stills = new Map<number, string>()
    for (const at of phases) {
      const file = `${board}-${at}.png`
      await renderStill({
        composition, serveUrl: bundleLocation, inputProps,
        frame: Math.round(at * (timeline.totalFrames - 1)),
        output: path.join(out, file),
        imageFormat: 'png',
        chromiumOptions
      })
      stills.set(at, file)
      console.log(`${file} (frame ${Math.round(at * (timeline.totalFrames - 1))})`)
    }
    const animatics: string[] = []
    if (values.animatic) {
      const anim = `${board}-animatic.mp4`
      await renderFilm({
        entryPoint, bundleLocationOverride: bundleLocation, inputProps,
        outputLocation: path.join(out, anim), scale: 0.5
      })
      animatics.push(anim)
      console.log(anim)
      // the smooth A/B variant — same placements, interpolated decode ramps
      if (values.smooth) {
        const smoothTimeline = compileTimeline(boardModel, { ...config, cadence: 'smooth' })
        const smooth = `${board}-animatic-smooth.mp4`
        await renderFilm({
          entryPoint, bundleLocationOverride: bundleLocation,
          inputProps: { timeline: smoothTimeline },
          outputLocation: path.join(out, smooth), scale: 0.5
        })
        animatics.push(smooth)
        console.log(smooth)
      }
    }
    results.push({ board, stills, animatics })
  }
} finally {
  rmSync(bundleLocation, { recursive: true, force: true })
}

const img = (file: string, label: string) =>
  `<figure><img src="${file}"><figcaption>${label}</figcaption></figure>`
const rows = phases.map((at) => {
  const cells = refDuration ? [img(`reference-${at}.png`, 'reference')] : []
  for (const r of results) {
    const file = r.stills.get(at)
    if (file) cells.push(img(file, r.board))
  }
  return `<h2>phase ${at}</h2><div class=row>${cells.join('')}</div>`
})
const vids: string[] = []
if (refDuration) vids.push(`<figure><video src="reference.mp4" autoplay loop muted playsinline controls></video><figcaption>reference</figcaption></figure>`)
for (const r of results) for (const a of r.animatics) {
  vids.push(`<figure><video src="${a}" autoplay loop muted playsinline controls></video><figcaption>${a}</figcaption></figure>`)
}
if (vids.length) rows.push(`<h2>animatics</h2><div class=row>${vids.join('')}</div>`)
writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset=utf-8><style>
body{background:#111;color:#ccc;font:12px ui-monospace;margin:24px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
figure{margin:0}figcaption{padding:4px 0}
img,video{height:60vh;background:#000;display:block}
</style><h1>${values.style} styleframes · ${values.aspect}</h1>${rows.join('\n')}`)

writeFileSync(path.join(out, 'intent.md'),
  `# ${values.style} @ ${values.aspect} — intent\n\n` +
  phases.map((at) => `## phase ${at}\n\nIntent:\n`).join('\n'))

console.log(`styleframes -> ${out}`)
