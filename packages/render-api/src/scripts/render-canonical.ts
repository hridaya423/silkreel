import { rm } from 'node:fs/promises'
import path from 'node:path'
import { loadDemoBoard, compileFilm, defaultFilmConfig } from '../boards.js'
import { renderFilm } from '../render-film.js'
import type { FilmConfig } from '@silk-reel/choreo'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const outPath = path.join(repoRoot, 'fixtures', 'canonical.mp4')

const board = await loadDemoBoard('icebreaker')
const config: FilmConfig = { ...defaultFilmConfig('icebreaker'), style: 'glyph', knobs: { texts: 1 } }
const { timeline, inputProps } = compileFilm(board, config)

console.log(
  `compiling done: ${timeline.totalFrames} frames @ ${timeline.fps}fps ` +
    (timeline.style === 'glyph' ? `cast=${timeline.cast.length} placements=${timeline.placements.length}` : 'trace scene')
)
for (const w of timeline.warnings) console.log(`  warn[${w.code}] ${w.message}`)
let bundleLocation: string | undefined
try {
  const result = await renderFilm({
    inputProps,
    outputLocation: outPath,
    onProgress: ({ pct }) => {
      console.log(`render ${pct}%`)
    }
  })
  bundleLocation = result.bundleLocation
  console.log('canonical render complete:', result.outputLocation)
} finally {
  if (bundleLocation !== undefined) await rm(bundleLocation, { recursive: true, force: true })
}
