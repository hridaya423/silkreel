// usage: node scripts/probe.mjs <url> [--shot out.png] [--wait ms] [--width w] [--height h] [--eval js]
import { chromium } from 'playwright'
const args = process.argv.slice(2)
const url = args[0]
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1] }
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: +opt('--width', 1440), height: +opt('--height', 900) }, deviceScaleFactor: +opt('--dpr', 1) })
const logs = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
await page.goto(url, { waitUntil: 'load' })
await page.waitForTimeout(+opt('--wait', 4000))
const ev = opt('--eval', null)
if (ev) console.log('eval:', JSON.stringify(await page.evaluate(ev), null, 1))
const shot = opt('--shot', null)
if (shot) await page.screenshot({ path: shot, fullPage: args.includes('--full') })
console.log(logs.slice(0, 30).join('\n'))
await browser.close()
