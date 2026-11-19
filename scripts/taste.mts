#!/usr/bin/env tsx
// Taste lab: side-by-side synced playback of a rendered video against the
// private reference, with shared scrub, frame step, A/B flip, and a loupe.
// usage: npx tsx scripts/taste.mts <video.mp4> [--ref review/<dir>/reference.mp4] [--out <dir>]
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ref: { type: 'string', default: '' },
    out: { type: 'string', default: '' }
  }
})
const video = positionals[0]
if (!video) {
  console.error('usage: npx tsx scripts/taste.mts <video.mp4> [--ref <ref.mp4>] [--out <dir>]')
  process.exit(1)
}
const videoAbs = path.resolve(video)
if (!existsSync(videoAbs)) throw new Error(`no such video: ${videoAbs}`)
const out = values.out ? path.resolve(values.out) : path.dirname(videoAbs)
mkdirSync(out, { recursive: true })

// bring both videos inside `out` so taste.html refers to them by basename
const oursName = `ours-${path.basename(videoAbs)}`
const oursPath = path.join(out, oursName)
if (oursPath !== videoAbs) copyFileSync(videoAbs, oursPath)

let ref = values.ref ? path.resolve(values.ref) : ''
if (!ref || !existsSync(ref)) {
  const local = path.join(path.dirname(videoAbs), 'reference.mp4')
  if (existsSync(local)) ref = local
}
const refName = 'reference.mp4'
const refPath = path.join(out, refName)
if (ref && ref !== refPath) copyFileSync(ref, refPath)
if (!existsSync(refPath)) {
  const fixture = path.join(root, 'fixtures/reference/pcbanimation.mp4')
  if (!existsSync(fixture)) throw new Error(`no reference: pass --ref, or put the private reference at ${fixture}`)
  copyFileSync(fixture, refPath)
}

writeFileSync(path.join(out, 'taste.html'), `<!doctype html><meta charset=utf-8>
<title>taste: ${oursName}</title>
<style>
body{background:#111;color:#ccc;font:12px ui-monospace;margin:24px}
#bar{display:flex;gap:10px;align-items:center;margin-bottom:10px}
button{background:#1c1c1c;color:#ccc;border:1px solid #444;font:inherit;padding:4px 12px;cursor:pointer}
button:hover{border-color:#888}
input[type=range]{flex:1;accent-color:#ccc}
#stage{display:flex;gap:10px;align-items:flex-start}
figure{margin:0;position:relative}
video{max-height:70vh;background:#000;display:block;cursor:crosshair}
figcaption{padding-top:4px;color:#888}
#stage.ab video{max-height:70vh}
#stage.ab{position:relative;display:inline-block}
#stage.ab figure{margin:0}
#stage.ab #b{position:absolute;inset:0}
#stage.ab.flipped #b{display:none}
#stage.ab #a{visibility:visible}
#stage.ab.flipped #a{visibility:hidden}
#loupe{position:fixed;width:240px;height:240px;border:1px solid #666;background:#000;display:none;pointer-events:none;z-index:9}
#hud{color:#888}
</style>
<div id=bar>
<button id=play>play</button>
<input id=scrub type=range min=0 max=1 step=any value=0>
<button id=flip>flip (f)</button>
<span id=hud>space: play · arrows: frame · f: flip</span>
</div>
<div id=stage>
<figure id=a><video src="${refName}" muted playsinline></video><figcaption>reference</figcaption></figure>
<figure id=b><video src="${oursName}" muted playsinline></video><figcaption>ours</figcaption></figure>
</div>
<canvas id=loupe width=240 height=240></canvas>
<script>
const ref = document.querySelector('#a video')
const ours = document.querySelector('#b video')
const stage = document.getElementById('stage')
const playBtn = document.getElementById('play')
const scrub = document.getElementById('scrub')
const loupe = document.getElementById('loupe')
const lctx = loupe.getContext('2d')
const STEP = 1 / 30 // arrow keys step both videos at 30fps increments
let playing = false

function sync() {
  if (ours.duration) {
    const t = ref.currentTime % ours.duration
    if (Math.abs(ours.currentTime - t) > 0.04) ours.currentTime = t
  }
  scrub.value = ref.duration ? ref.currentTime / ref.duration : 0
  if (playing) requestAnimationFrame(sync)
}
function setPlaying(on) {
  playing = on
  if (on) { ref.play(); ours.play(); requestAnimationFrame(sync) }
  else { ref.pause(); ours.pause() }
  playBtn.textContent = on ? 'pause' : 'play'
}
playBtn.onclick = () => setPlaying(!playing)
document.getElementById('flip').onclick = () => {
  if (!stage.classList.contains('ab')) stage.classList.add('ab')
  stage.classList.toggle('flipped')
}
scrub.oninput = () => {
  const f = Number(scrub.value)
  ref.currentTime = f * ref.duration
  ours.currentTime = f * (ours.duration || 0)
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing) }
  else if (e.key === 'f') {
    if (!stage.classList.contains('ab')) stage.classList.add('ab')
    stage.classList.toggle('flipped')
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const d = e.key === 'ArrowRight' ? STEP : -STEP
    setPlaying(false)
    ref.currentTime = Math.max(0, Math.min(ref.duration || 0, ref.currentTime + d))
    ours.currentTime = Math.max(0, Math.min(ours.duration || 0, ours.currentTime + d))
    scrub.value = ref.duration ? ref.currentTime / ref.duration : 0
  }
})

// loupe: 240px of native pixels around the cursor
document.querySelectorAll('video').forEach((v) => {
  v.addEventListener('mousemove', (e) => {
    if (!v.videoWidth) return
    const r = v.getBoundingClientRect()
    const nx = ((e.clientX - r.left) / r.width) * v.videoWidth
    const ny = ((e.clientY - r.top) / r.height) * v.videoHeight
    const s = 240
    const sx = Math.max(0, Math.min(v.videoWidth - s, nx - s / 2))
    const sy = Math.max(0, Math.min(v.videoHeight - s, ny - s / 2))
    lctx.drawImage(v, sx, sy, s, s, 0, 0, 240, 240)
    loupe.style.display = 'block'
    loupe.style.left = (e.clientX + 20) + 'px'
    loupe.style.top = Math.max(8, e.clientY - 120) + 'px'
  })
  v.addEventListener('mouseleave', () => { loupe.style.display = 'none' })
})
</script>`)
console.log(`taste -> ${path.join(out, 'taste.html')}`)
