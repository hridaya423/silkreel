import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const [url = 'http://localhost:4321', output = '.shots/scroll'] = process.argv.slice(2)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'no-preference', recordVideo: { dir: output, size: { width, height } } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.goto(url)
    await page.waitForSelector('.journey--ready', { timeout: 12000 }).catch(() => assert.fail(`Motion did not initialize: ${errors.join('; ')}`))
    const wheelTo = async y => {
      await page.evaluate(() => new Promise(resolve => {
        let previous = scrollY
        let still = 0
        const settled = () => {
          still = Math.abs(scrollY - previous) < 0.1 ? still + 1 : 0
          previous = scrollY
          if (still >= 8) resolve()
          else requestAnimationFrame(settled)
        }
        requestAnimationFrame(settled)
      }))
      await page.mouse.move(width / 2, height / 2)
      await page.mouse.wheel(0, y - await page.evaluate(() => scrollY))
      await page.waitForFunction(y => Math.abs(scrollY - y) < 2, y, { timeout: 10000 }).catch(async error => {
        console.error(JSON.stringify({ name, target: y, ...await page.evaluate(() => ({ scroll: scrollY, viewport: innerHeight, height: document.documentElement.scrollHeight, classes: document.documentElement.className, frames: document.querySelector('#frames').getBoundingClientRect().toJSON() })) }))
        await page.screenshot({ path: path.join(output, `${name}-failed.png`) })
        throw error
      })
    }
    const turn = () => page.locator('#film').evaluate(el => Number(el.style.getPropertyValue('--turn')))
    await page.screenshot({ path: path.join(output, `${name}-start.png`) })
    const start = await turn()
    await wheelTo(height * 0.65)
    const turned = await turn()
    assert.ok(turned > start + 0.15, `${name}: copper did not turn with wheel scrolling`)
    assert.equal(await page.locator('.cut__still').evaluate(el => getComputedStyle(el).visibility), 'hidden')
    await page.screenshot({ path: path.join(output, `${name}-turn.png`) })
    await page.locator('[data-frames-film]').evaluate(video => {
      const decoded = (_, metadata) => { video.dataset.decodedTime = String(metadata.mediaTime); video.requestVideoFrameCallback(decoded) }
      video.requestVideoFrameCallback(decoded)
    })
    const frames = await page.locator('#frames').evaluate(el => ({ top: el.getBoundingClientRect().top + scrollY, span: el.offsetHeight - innerHeight }))
    await wheelTo(frames.top - height * 0.15)
    await page.screenshot({ path: path.join(output, `${name}-arrival.png`) })
    const readings = []
    for (const progress of [0.2, 0.65, 0.9, 0.2]) {
      await wheelTo(frames.top + frames.span * progress)
      await page.waitForFunction(() => {
        const video = document.querySelector('[data-frames-film]')
        return !video.seeking && video.dataset.decodedTime !== undefined && Math.abs(Number(video.dataset.decodedTime) - video.currentTime) < 0.1
      })
      const reading = await page.locator('[data-frames-film]').evaluate(video => ({ time: video.currentTime, decoded: Number(video.dataset.decodedTime) }))
      readings.push(reading)
      await page.screenshot({ path: path.join(output, `${name}-film-${progress}.png`) })
    }
    assert.ok(readings[1].decoded - readings[0].decoded > 2, `${name}: the displayed film did not advance`)
    assert.ok(readings[2].decoded - readings[1].decoded > 1, `${name}: the displayed film stopped before its end`)
    assert.ok(Math.abs(readings[3].decoded - readings[0].decoded) < 0.1, `${name}: reverse scroll did not return to the same frame`)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ name, start, turned, readings }))
    const video = page.video()
    await context.close()
    await video.saveAs(path.join(output, `${name}-scroll.webm`))
  }
} finally {
  await browser.close()
}
