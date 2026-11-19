// flash safety: mean luma per frame; a full-frame light↔dark change is a run of frames whose mean luma moves 0.2 or more one way;
// fails a film with more than three such changes in any one second, the loop seam included
// usage: npx tsx scripts/flash-check.mts film.mp4 [--step 0.2] [--max 3]
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (file === undefined) throw new Error('usage: flash-check.mts film.mp4 [--step 0.2] [--max 3]')
const opt = (name: string, fallback: number): number => {
  const i = args.indexOf(name)
  return i < 0 ? fallback : Number(args[i + 1])
}
const step = opt('--step', 0.2)
const max = opt('--max', 3)
const [num = 30, den = 1] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]).toString().trim().split('/').map(Number)
const fps = num / den
const W = 64
const H = 64
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 })
const n = Math.floor(raw.length / (W * H))
const luma = Array.from({ length: n }, (_, f) => {
  let s = 0
  for (let i = 0; i < W * H; i++) s += raw[f * W * H + i] as number
  return s / (W * H * 255)
})
const changes: Array<{ frame: number; from: number; to: number }> = []
let i = 0
while (i < n) {
  const a = luma[i] as number
  const b = luma[(i + 1) % n] as number
  const dir = Math.sign(b - a)
  if (dir === 0 || Math.abs(b - a) < 0.02) {
    i++
    continue
  }
  let j = i + 1
  while (j < i + n - 1 && Math.sign((luma[(j + 1) % n] as number) - (luma[j % n] as number)) === dir && Math.abs((luma[(j + 1) % n] as number) - (luma[j % n] as number)) >= 0.02) j++
  const to = luma[j % n] as number
  if (Math.abs(to - a) >= step) changes.push({ frame: i + 1, from: a, to })
  i = j
}
const window = Math.round(fps)
let worst = 0
let worstAt = 0
for (let f = 0; f < n; f++) {
  const count = changes.filter((c) => ((c.frame - f + n) % n) < window).length
  if (count > worst) {
    worst = count
    worstAt = f
  }
}
console.log(`${file}: ${n} frames @ ${fps} fps, luma ${Math.min(...luma).toFixed(2)}..${Math.max(...luma).toFixed(2)}`)
for (const c of changes) console.log(`  change at frame ${c.frame} (${(c.frame / fps).toFixed(2)}s): ${c.from.toFixed(2)} → ${c.to.toFixed(2)}`)
console.log(`most changes in one second: ${worst} (window from frame ${worstAt}); limit ${max}`)
console.log(worst <= max ? 'PASS' : 'FAIL')
if (worst > max) process.exitCode = 1
