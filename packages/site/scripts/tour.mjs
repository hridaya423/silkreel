// Screenshots points inside sections: node scripts/tour.mjs <url> <outdir> <#id@fraction,...> [--width w --height h] [--reduced]
// fraction 0 = the section's top at the viewport top, 1 = its bottom at the viewport bottom
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const [url, out, stops] = process.argv.slice(2)
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 1440), height: +opt('--height', 900) }, reducedMotion: process.argv.includes('--reduced') ? 'reduce' : 'no-preference' })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/504|Outdated/.test(m.text())) console.log('console', m.text()) })
await page.goto(url)
await page.waitForTimeout(3000)
let i = 0
for (const stop of stops.split(',')) {
  const [sel, f] = stop.split('@')
  await page.evaluate(([s, fr]) => {
    const el = document.querySelector(s)
    const top = el.getBoundingClientRect().top + scrollY
    const span = Math.max(0, el.offsetHeight - innerHeight)
    window.scrollTo(0, top + span * Number(fr))
  }, [sel, f ?? '0'])
  await page.waitForTimeout(1800)
  await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}-${sel.replace('#', '')}-${f ?? 0}.png` })
}
await browser.close()
