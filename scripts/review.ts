#!/usr/bin/env tsx
// Render every style x board x aspect into review/<stamp>/ with dense contact
// sheets (5 fps => the sheets cover the whole video), a gallery index.html,
// and a notes.md rubric. Quality gate: a human reads every sheet.
// usage: npm run review -- [--styles glyph] [--boards glasgow,video|all] [--aspects 4:5] [--palette copper] [--seed 42] [--out review/<stamp>] [--no-reference]
// --out resumes into an existing run: videos already there are kept
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { bundle } from '@remotion/bundler'
import { ASPECT_SIZE, compileTimeline } from '../packages/choreo/src/index.js'
import type { Aspect, FilmConfig } from '../packages/choreo/src/index.js'
import { renderFilm } from '../packages/render-api/src/render-film.js'
import { DEMO_BOARDS, DEMO_TITLES, loadDemoBoard, defaultFilmConfig } from '../packages/render-api/src/boards.js'

const root = path.resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  allowNegative: true,
  options: {
    styles: { type: 'string', default: 'glyph' },
    boards: { type: 'string', default: 'all' },
    aspects: { type: 'string', default: '4:5' },
    palette: { type: 'string', default: '' },
    seed: { type: 'string', default: '42' },
    out: { type: 'string', default: '' },
    titles: { type: 'boolean', default: false },
    reference: { type: 'boolean', default: true }
  }
})
const styles = values.styles.split(',')
const boards = values.boards === 'all' ? [...DEMO_BOARDS] : values.boards.split(',')
const aspects = values.aspects.split(',')
const out = values.out ? path.resolve(values.out) : path.join(root, 'review', new Date().toISOString().replace(/[:.]/g, '-'))
const stamp = path.basename(out)
mkdirSync(out, { recursive: true })

const entryPoint = path.join(root, 'packages/render/src/remotion-entry.tsx')
const bundleLocation = await bundle({ entryPoint, onProgress: () => undefined, enableCaching: false })
const rows: string[] = []
const notes: string[] = [`# Review ${stamp}\n`,
  'Pre-filter: no clipping, dead air, seam pop, or illegible text. Score each line 1-5; pass requires every line >=4.\n']
try {
  for (const style of styles) for (const board of boards) for (const aspect of aspects) {
    const name = `${style}-${board}-${aspect.replace(':', 'x')}`
    const config = {
      ...defaultFilmConfig(board), style, aspect,
      output: { ...defaultFilmConfig(board).output, ...ASPECT_SIZE[aspect as Aspect] },
      ...(values.palette ? { palette: values.palette } : {}),
      seed: Number(values.seed),
      ...(values.titles ? { title: { name: DEMO_TITLES[board] ?? board } } : {})
    } as unknown as FilmConfig
    const t0 = Date.now()
    const timeline = compileTimeline(await loadDemoBoard(board), config)
    const compileMs = Date.now() - t0
    const video = path.join(out, `${name}.mp4`)
    const render = () => renderFilm({ entryPoint, bundleLocationOverride: bundleLocation, inputProps: { timeline }, outputLocation: video })
    // heavy boards occasionally time out Chromium's page pool; one retry clears it
    if (!existsSync(video)) await render().catch((err: unknown) => { console.warn(`${name}: retrying after ${String(err)}`); return render() })
    const sheetDir = path.join(out, name)
    mkdirSync(sheetDir, { recursive: true })
    // 5 fps sampling, 4x4 tiles => every second of the film is on a sheet
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf',
      'fps=5,scale=360:-1,tile=4x4:padding=4:color=0x303030', path.join(sheetDir, 'sheet-%02d.png')])
    rows.push(`<figure><video src="${name}.mp4" autoplay loop muted playsinline></video><figcaption>${name} · ${timeline.durationSeconds}s · compile ${compileMs}ms</figcaption></figure>`)
    notes.push(`\n## ${name}\nsheets: ${name}/sheet-*.png\n` +
      ['First frame', 'Reading path', 'Rhythm', 'Breath', 'Restraint', 'Material', 'Signature moment', 'Resolve', 'Screenshot test', 'Board truth']
        .map((r) => `- [ ] ${r} (1-5): `).join('\n'))
    console.log(`${name}: ${timeline.totalFrames}f compile=${compileMs}ms warnings=${timeline.warnings.length}`)
  }
} finally {
  rmSync(bundleLocation, { recursive: true, force: true })
}
const reference = path.join(root, 'fixtures/reference/pcbanimation.mp4')
if (values.reference && existsSync(reference)) {
  copyFileSync(reference, path.join(out, 'reference.mp4'))
  rows.unshift('<figure><video src="reference.mp4" autoplay loop muted playsinline></video><figcaption>reference</figcaption></figure>')
}
writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset=utf-8><style>body{background:#111;color:#ccc;font:12px ui-monospace;display:flex;flex-wrap:wrap;gap:12px}video{height:420px;background:#000}</style>${rows.join('\n')}`)
writeFileSync(path.join(out, 'notes.md'), notes.join('\n'))
console.log(`review -> ${out}`)
