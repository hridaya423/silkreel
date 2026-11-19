import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const [base = 'http://localhost:4321'] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
try {
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base)
    await page.evaluate(() => document.fonts.ready)
    const hero = await page.evaluate(() => {
      const heading = document.querySelector('h1').getBoundingClientRect()
      const header = document.querySelector('header').getBoundingClientRect()
      const lede = document.querySelector('.shot__lede').getBoundingClientRect()
      const actions = document.querySelector('.shot__acts').getBoundingClientRect()
      return { top: heading.top - header.bottom, copy: lede.top - heading.bottom, actions: actions.top - lede.bottom, overflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.ok(hero.top >= 32, `${width}px hero has only ${hero.top}px below the header`)
    assert.ok(hero.copy >= 24, `${width}px hero copy needs more space`)
    assert.ok(hero.actions >= 20, `${width}px hero actions need more space`)
    assert.equal(hero.overflow, false, `${width}px home overflows`)
    await page.goto(new URL('/studio/', base).href)
    await page.waitForFunction(() => !document.querySelector('[data-still]').disabled)
    const studio = await page.evaluate(() => {
      const bar = document.querySelector('.st__bar').getBoundingClientRect()
      const monitor = document.querySelector('.st__monitor').getBoundingClientRect()
      const controls = [...document.querySelectorAll('.st__looks label, .st__aspects label, .st__actions button')].map(el => el.getBoundingClientRect().height)
      return { gap: monitor.top - bar.bottom, left: monitor.left, right: innerWidth - monitor.right, controls, overflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.ok(studio.gap >= 24, `${width}px studio preview needs space below its bar`)
    assert.ok(Math.min(studio.left, studio.right) >= 16, `${width}px studio preview needs side padding`)
    assert.ok(studio.controls.every(height => height >= 44), `${width}px studio controls are too small`)
    assert.equal(studio.overflow, false, `${width}px studio overflows`)
    await page.locator('.st__adv summary').click()
    await page.locator('.st__local summary').click()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px expanded inspector overflows`)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ width, hero, studio }))
    await page.close()
  }
} finally {
  await browser.close()
}
