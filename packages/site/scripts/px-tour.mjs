// node scripts/px-tour.mjs <url> <out> <y,...> [--width w --height h] [--reduced]; each y is in viewport heights
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const [url, out, ys] = process.argv.slice(2)
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 1440), height: +opt('--height', 900) }, reducedMotion: process.argv.includes('--reduced') ? 'reduce' : 'no-preference' })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/504|Outdated/.test(m.text())) console.log('console', m.text()) })
await page.goto(url)
await page.waitForTimeout(3500)
let i = 0
for (const y of ys.split(',')) {
  await page.evaluate((v) => { window.scrollTo(0, v * innerHeight) }, Number(y))
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/top-${String(i++)}-y${y}.png` })
}
await browser.close()
