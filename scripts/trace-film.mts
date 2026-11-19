// Renders a trace film with the power-on chosen: `lamps` (the board's LED cluster in a macro, lamp by lamp), `pulse` (a pulse runs from the supply pin and each LED it reaches stays on), `routes` (the nets light from the hero in a dimmed room) or `leds`
// (the room stays lit and only the board's own LEDs wake). Takes the reel CLI's arguments after the power word.
// usage: npx tsx scripts/trace-film.mts lamps|pulse|leds|routes board.kicad_pcb [reel flags] -o out.mp4
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { compileTimeline } from '../packages/choreo/src/index.ts'
import { parseKicadPcb } from '../packages/ingest/src/index.ts'
import { loadPartBodies, renderFilm } from '../packages/render-api/src/index.ts'
import { parseCliArgs } from '../packages/cli/src/args.ts'

const [power, ...rest] = process.argv.slice(2)
if (power !== 'lamps' && power !== 'pulse' && power !== 'leds' && power !== 'routes') throw new Error('first argument: lamps, pulse, leds or routes')
const { input, out, config, format, draft, audio, models } = parseCliArgs(rest)
const board = parseKicadPcb(await readFile(input, 'utf8'), path.basename(input))
const loaded = await loadPartBodies(board, { boardDir: path.dirname(path.resolve(input)), dirs: models ?? [] })
const timeline = compileTimeline(board, { ...config, power }, loaded.bodies)
const started = Date.now()
await renderFilm({
  inputProps: { timeline, quality: draft ? 'draft' : 'final' },
  outputLocation: path.resolve(out),
  format,
  audio,
  poster: false,
  onProgress: ({ pct }) => { if (pct % 25 === 0) console.log(`${pct}%`) }
})
console.log(`${out} in ${Math.round((Date.now() - started) / 1000)} s`)
