import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { compileTimeline } from '../packages/choreo/src/index.ts'
import { parseKicadPcb } from '../packages/ingest/src/index.ts'
import { loadPartBodies } from '../packages/render-api/src/models.ts'
import { parseCliArgs } from '../packages/cli/src/args.ts'

const { input, out, config: parsed, draft, models } = parseCliArgs(process.argv.slice(2))
const ending = process.env.SILK_ENDING
if (ending !== undefined && ending !== 'parts' && ending !== 'routes') throw new Error(`SILK_ENDING must be parts or routes (got ${ending})`)
const config = ending === undefined ? parsed : { ...parsed, ending }
const board = parseKicadPcb(await readFile(input, 'utf8'), path.basename(input))
const wearsModels = models !== undefined && (config.style === 'trace' || config.style === 'montage' || config.style === 'glyph')
const loaded = wearsModels ? await loadPartBodies(board, { boardDir: path.dirname(path.resolve(input)), dirs: models }) : undefined
const timeline = compileTimeline(board, config, loaded?.bodies)
await writeFile(path.resolve(out), JSON.stringify({ timeline, quality: draft ? 'draft' : 'final' }))
console.log(`${out}: ${timeline.style} ${timeline.width}x${timeline.height} ${timeline.totalFrames}f`)
