// Scrolls to a selector, then moves the pointer along a path and screenshots each stop: node scripts/sweep.mjs <url> <outdir> <selector@fraction> <x,y;x,y;...> [--width w --height h] [--wait ms] [--click]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const [url, out, where, stops] = process.argv.slice(2)
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 1440), height: +opt('--height', 900) }, hasTouch: process.argv.includes('--touch') })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/504|Outdated/.test(m.text())) console.log('console', m.text()) })
await page.goto(url)
await page.waitForTimeout(2500)
const [sel, f] = where.split('@')
await page.evaluate(([s, fr]) => { const el = document.querySelector(s); const top = el.getBoundingClientRect().top + scrollY; window.scrollTo(0, top + Math.max(0, el.offsetHeight - innerHeight) * Number(fr)) }, [sel, f ?? '0'])
await page.waitForTimeout(+opt('--settle', 2400))
let i = 0
for (const stop of stops.split(';')) {
  if (stop !== 'none') { const [x, y] = stop.split(',').map(Number); await page.mouse.move(x, y, { steps: 3 }); if (process.argv.includes('--click')) await page.mouse.click(x, y) }
  await page.waitForTimeout(+opt('--wait', 900))
  await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}.jpg`, type: 'jpeg', quality: 86 })
}
await browser.close()
