// Moves the pointer across the hero and screenshots each stop: node scripts/hover.mjs <url> <outdir> <x,y;x,y;...> [--width w --height h] [--wait ms]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const [url, out, stops] = process.argv.slice(2)
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 1440), height: +opt('--height', 900) } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/504|Outdated/.test(m.text())) console.log('console', m.text()) })
await page.goto(url)
await page.waitForTimeout(+opt('--first', 3200))
let i = 0
for (const stop of stops.split(';')) {
  const [x, y] = stop.split(',').map(Number)
  await page.mouse.move(x - 6, y - 4)
  await page.mouse.move(x, y, { steps: 4 })
  await page.waitForTimeout(+opt('--wait', 900))
  await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}-${x}-${y}.jpg`, type: 'jpeg', quality: 88 })
}
await browser.close()
