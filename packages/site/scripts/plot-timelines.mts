// Precompiles the plot film of each board the home page cuts against its trace film, in the same config the CLI renders that trace film with
// (scripts/trace-films.sh), part models included, so the two register frame for frame. Run from the repo root: npx tsx packages/site/scripts/plot-timelines.mts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { ASPECT_SIZE, compileTimeline, DEMO_CAST_HINTS } from '@silk-reel/choreo'
import type { Aspect, FilmConfig } from '@silk-reel/choreo'
import { parseKicadPcb } from '@silk-reel/ingest'
import { loadPartBodies } from '../../render-api/src/models'

const out = 'packages/site/public/films/plot'
mkdirSync(out, { recursive: true })
const round = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v)
for (const id of ['icebreaker', 'glasgow', 'StickHub', 'ecc83-pp', 'kit-dev-coldfire-xilinx_5213', 'video']) {
  const board = parseKicadPcb(readFileSync(`fixtures/boards/${id}.kicad_pcb`, 'utf8'), `${id}.kicad_pcb`)
  const { bodies } = await loadPartBodies(board, { boardDir: 'fixtures/boards', dirs: [] })
  for (const aspect of (id === 'glasgow' ? ['16:9', '9:16'] : ['16:9']) as Aspect[]) {
    const cast = DEMO_CAST_HINTS[id]
    const config: FilmConfig = { style: 'plot', aspect, knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[aspect], fps: 30 }, ...(cast ? { cast } : {}) }
    const tl = compileTimeline(board, config, bodies)
    if (tl.style !== 'plot') throw new Error('expected a plot timeline')
    const json = JSON.stringify({ ...tl, scene: { ...tl.scene, meshes: [] } }, round)
    const file = `${out}/${id}-${aspect.replace(':', 'x')}.json`
    writeFileSync(file, json)
    console.log(file, (json.length / 1024).toFixed(0), 'KB', (gzipSync(json).length / 1024).toFixed(0), 'KB gz')
  }
}
