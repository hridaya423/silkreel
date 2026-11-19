// Screenshots a burst after an action, to read motion frame by frame: node scripts/burst.mjs <url> <outdir> <x,y|idle> <count> <gapMs> [--width w --height h] [--first ms] [--scroll px]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const [url, out, at, count, gap] = process.argv.slice(2)
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 1440), height: +opt('--height', 900) } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/504|Outdated/.test(m.text())) console.log('console', m.text()) })
await page.goto(url)
await page.waitForTimeout(+opt('--first', 3200))
if (+opt('--scroll', 0)) { await page.evaluate((y) => window.scrollTo(0, y), +opt('--scroll', 0)); await page.waitForTimeout(600) }
if (at !== 'idle') { const [x, y] = at.split(',').map(Number); await page.mouse.move(x - 40, y - 30); await page.waitForTimeout(300); await page.mouse.move(x, y, { steps: 2 }) }
const t0 = Date.now()
for (let i = 0; i < +count; i++) {
  await page.screenshot({ path: `${out}/${String(i).padStart(2, '0')}-${String(Date.now() - t0).padStart(5, '0')}ms.jpg`, type: 'jpeg', quality: 80 })
  await page.waitForTimeout(+gap)
}
await browser.close()
