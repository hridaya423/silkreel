// Writes public/og.png (1200×630): the home hero without the header and buttons.
// usage: node scripts/og.mjs [url of the built site]
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const [url = 'http://localhost:4400/'] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 })
await page.goto(url)
await page.addStyleTag({ content: '[data-header], .shot__acts { visibility: hidden !important }' })
await page.waitForTimeout(5000)
const y = await page.evaluate(() => Math.round(document.querySelector('[data-header]').getBoundingClientRect().bottom))
await page.screenshot({ path: `${root}public/og.png`, clip: { x: 0, y, width: 1200, height: 630 } })
await browser.close()
