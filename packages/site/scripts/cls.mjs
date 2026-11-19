// Lists layout shifts with their sources: node scripts/cls.mjs <url> [--width w --height h]
import { chromium } from 'playwright'
const url = process.argv[2]
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 390), height: +opt('--height', 844) }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await page.addInitScript(() => {
  window.__cls = []
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__cls.push({ t: Math.round(e.startTime), v: +e.value.toFixed(4), y: Math.round(scrollY), src: e.sources.map((s) => `${s.node?.nodeName}.${s.node?.className?.baseVal ?? s.node?.className ?? ''} ${JSON.stringify(s.previousRect.toJSON())} -> ${JSON.stringify(s.currentRect.toJSON())}`) })
  }).observe({ type: 'layout-shift', buffered: true })
})
const cdp = await page.context().newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: +opt('--cpu', 4) })
await page.goto(url)
await page.waitForTimeout(4000)
const h = await page.evaluate(() => document.documentElement.scrollHeight)
for (let y = 0; y < h; y += 400) { await page.evaluate((v) => scrollTo(0, v), y); await page.waitForTimeout(350) }
await page.waitForTimeout(1200)
for (const e of await page.evaluate(() => window.__cls)) console.log(JSON.stringify(e))
await browser.close()
