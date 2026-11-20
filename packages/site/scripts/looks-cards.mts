// Draws the home page's Looks cards: Glasgow in each style through one camera straight above the board, so the bands of the shutter register.
// Writes packages/site/public/films/looks/glasgow-<look>.webp (3052 × 1856) and -1x.webp. Run from the repo root: npx tsx packages/site/scripts/looks-cards.mts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { compileTimeline, DEMO_CAST_HINTS } from '@silk-reel/choreo'
import { parseKicadPcb } from '@silk-reel/ingest'
import { loadPartBodies } from '../../render-api/src/models'
import { boards } from '../src/data/site'

const here = import.meta.dirname
const out = path.join(here, '../public/films/looks')
const data = mkdtempSync(path.join(tmpdir(), 'looks-cards-'))
const board = parseKicadPcb(readFileSync('fixtures/boards/glasgow.kicad_pcb', 'utf8'), 'glasgow.kicad_pcb')
const { bodies } = await loadPartBodies(board, { boardDir: 'fixtures/boards', dirs: [] })
const title = boards.find((b) => b.id === 'glasgow')?.title
for (const style of ['trace', 'plot', 'montage', 'glyph'] as const) {
  const tl = compileTimeline(board, { style, knobs: {}, seed: 42, duration: 'auto', output: { width: 3052, height: 1856, fps: 30 }, ...(DEMO_CAST_HINTS.glasgow ? { cast: DEMO_CAST_HINTS.glasgow } : {}), ...(title ? { title } : {}) }, bodies)
  writeFileSync(path.join(data, `${style}.json`), JSON.stringify(tl))
}
const server = await createServer({ root: path.join(here, 'looks-cards'), publicDir: data, logLevel: 'error', server: { port: 0 } })
await server.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => { console.error(e.message) })
  await page.goto(server.resolvedUrls?.local[0] ?? '')
  await page.waitForFunction(() => 'cards' in window)
  const files = await page.evaluate(() => (window as unknown as { cards: Promise<Record<string, string>> }).cards)
  for (const [name, url] of Object.entries(files)) {
    writeFileSync(path.join(out, name), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
    console.log(path.join('packages/site/public/films/looks', name))
  }
} finally {
  await browser.close()
  await server.close()
  rmSync(data, { recursive: true, force: true })
}
