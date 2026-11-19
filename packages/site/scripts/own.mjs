// Drops a board file into the home page and screenshots the hero while hovering: node scripts/own.mjs <url> <outdir> <board.kicad_pcb> <x,y;x,y;...> [--width w --height h]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const [url, out, board, stops] = process.argv.slice(2)
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 1440), height: +opt('--height', 900) } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/504|Outdated/.test(m.text())) console.log('console', m.text()) })
await page.goto(url)
await page.waitForTimeout(2500)
await page.setInputFiles('[data-file]', board)
await page.waitForTimeout(+opt('--wait', 7000))
let i = 0
for (const stop of stops.split(';')) {
  if (stop !== 'none') { const [x, y] = stop.split(',').map(Number); await page.mouse.move(x - 5, y - 5); await page.mouse.move(x, y, { steps: 3 }) }
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}.jpg`, type: 'jpeg', quality: 86 })
}
await browser.close()
