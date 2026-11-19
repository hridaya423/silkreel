// Scroll a page top to bottom and screenshot each stop: node scripts/walk.mjs <url> <outdir> [--width w --height h] [--sel a,b,c]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const [url, out] = process.argv.slice(2)
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1] }
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 1440), height: +opt('--height', 900) }, deviceScaleFactor: +opt('--dpr', 1) })
if (args.includes('--reduced')) await page.emulateMedia({ reducedMotion: 'reduce' })
const logs = []
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') logs.push(`console: ${m.text()}`) })
await page.goto(url, { waitUntil: 'load' })
await page.waitForTimeout(4500)
const sels = opt('--sel', '#main > section, footer').split(',')
const targets = await page.evaluate((sels) => sels.flatMap((s) => [...document.querySelectorAll(s)]).map((el, i) => ({ i, top: el.getBoundingClientRect().top + scrollY, h: el.offsetHeight, id: el.id || el.className.split(' ')[0] })), sels)
let k = 0
for (const t of targets) {
  const stops = t.h > 1.6 * (+opt('--height', 900)) ? [0, 0.5, 0.99] : [0]
  for (const s of stops) {
    await page.evaluate((y) => window.scrollTo(0, y), t.top + (t.h - (s ? +opt('--height', 900) : 0)) * s)
    await page.waitForTimeout(1600)
    await page.screenshot({ path: `${out}/${String(k++).padStart(2, '0')}-${t.id}.png` })
  }
}
console.log(logs.join('\n') || 'no errors')
await browser.close()
