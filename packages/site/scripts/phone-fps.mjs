// The jury's phone scroll probe (390×844 at 2×, 4× CPU slowdown, scrollBy 6 px a frame for 2.5 s), on hardware GL
// instead of SwiftShader, from the top, inside the gate and at the foot. node scripts/phone-fps.mjs <url>
import { chromium } from 'playwright'
const url = process.argv[2]
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await page.goto(url); await page.waitForTimeout(4000)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
const probe = () => page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now(); let worst = 0; let last = t0
  const f = (t) => { n++; worst = Math.max(worst, t - last); last = t; scrollBy(0, 6); if (t - t0 < 2500) requestAnimationFrame(f); else res({ fps: Math.round((n * 1000) / (t - t0)), worstFrameMs: Math.round(worst) }) }
  requestAnimationFrame(f)
}))
console.log('top', JSON.stringify(await probe()))
await page.evaluate(() => { const a = document.querySelector('#film'); scrollTo(0, a.offsetTop + (a.offsetHeight - innerHeight) * 0.5) }); await page.waitForTimeout(2500)
console.log('gate', JSON.stringify(await probe()))
await page.evaluate(() => { const g = document.querySelector('#get'); scrollTo(0, g.offsetTop - innerHeight * 0.5) }); await page.waitForTimeout(2500)
console.log('finale', JSON.stringify(await probe()))
await browser.close()
