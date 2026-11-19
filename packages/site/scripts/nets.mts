// Writes the net geometry the hero lights under the pointer, registered to the committed shutter faces.
// The faces were rendered from the timelines kept in .context/copper-repair/assets (see public/films/shutter/CREDITS.md),
// so this reads the same timelines and rebuilds the same camera. Run from the repo root: npx tsx packages/site/scripts/nets.mts [timeline dir]
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { centreOn, fitZoom, makeCam } from '@silk-reel/choreo'
import type { CameraShot, TraceTimeline } from '@silk-reel/choreo'
import { parseKicadPcb } from '@silk-reel/ingest'
import { netsOf } from '../src/cut/nets'

const dir = process.argv[2] ?? '.context/copper-repair/assets'
const board = parseKicadPcb(readFileSync('fixtures/boards/glasgow.kicad_pcb', 'utf8'), 'glasgow.kicad_pcb')
for (const slug of ['16x9', '9x16']) {
  const tl = JSON.parse(readFileSync(`${dir}/glasgow-${slug}.json`, 'utf8')) as TraceTimeline
  const last = tl.scene.shots.at(-1) as CameraShot
  let shot = last
  if (slug === '16x9') {
    const pts = tl.scene.board.flatMap((loop) => Array.from({ length: loop.length / 2 }, (_, i): [number, number, number] => [loop[i * 2] ?? 0, loop[i * 2 + 1] ?? 0, 0]))
    shot = { ...last, t: 0, tilt: 0.91, yaw: -0.13, aperture: 0.04, zoom: 0.9 }
    shot = { ...shot, ...centreOn(shot, pts, tl.width, tl.height) }
    shot.zoom = fitZoom(shot, pts, tl.width, tl.height, 0.88, 0.85)
    shot = { ...shot, ...centreOn(shot, pts, tl.width, tl.height) }
  }
  const data = { ...netsOf(board, tl), vp: [...makeCam(shot, tl.width, tl.height).vp].map((v) => Math.round(v * 1e6) / 1e6) }
  const json = JSON.stringify(data)
  const file = `packages/site/public/films/shutter/glasgow-${slug}-nets.json`
  writeFileSync(file, json)
  console.log(file, data.nets.length, 'nets', data.parts.length, 'parts', (json.length / 1024).toFixed(0), 'KB', (gzipSync(json).length / 1024).toFixed(0), 'KB gz', data.facts)
}
