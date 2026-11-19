// one-frame pops, the critics' way: a frame whose change from the previous frame (mean absolute pixel difference, 0-255) is more than 3× the median change of the three frames either side and over 2.0, away from the cuts; steady motion and smooth ramps are not pops. The block column is the worst 8×8 cell's change in that frame.
// Frozen runs: before the end hold (beat 21, where the crane settles), any run of more than 6 frames whose mean absolute pixel difference from the previous frame is under 0.3
// usage: npx tsx scripts/pops.mts video.mp4 [more.mp4 ...]
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const W = 270
const FLOOR = 2.0
const STANDS = 3
const CUT_BEATS = [5, 7, 12]
const HOLD_BEAT = 21
const STILL = 0.3
const LONGEST = 6

for (const file of process.argv.slice(2)) {
  const [w0, h0, count] = execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_packets', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number) as [number, number, number]
  const H = Math.round((h0 * W) / w0 / 2) * 2
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 })
  const n = Math.min(count, Math.floor(raw.length / (W * H)))
  const cuts = new Set(CUT_BEATS.map((b) => Math.round((n * b) / 24)))
  const bw = 8
  const bh = 8
  const stats = (f: number): { mean: number; blocks: Float64Array } => {
    const blocks = new Float64Array(bw * bh)
    let sum = 0
    const o = f * W * H
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = raw[o + y * W + x] as number
        sum += v
        const k = Math.floor((y * bh) / H) * bw + Math.floor((x * bw) / W)
        blocks[k] = (blocks[k] as number) + (v / 255) * ((bw * bh) / (W * H))
      }
    }
    return { mean: sum / (W * H), blocks }
  }
  const frames = Array.from({ length: n }, (_, f) => stats(f))
  const diff = (f: number): number => {
    const a = (f - 1) * W * H
    const b = f * W * H
    let d = 0
    for (let i = 0; i < W * H; i++) d += Math.abs((raw[b + i] as number) - (raw[a + i] as number))
    return d / (W * H)
  }
  const steps = Array.from({ length: n }, (_, f) => (f === 0 ? 0 : diff(f)))
  const block = (f: number): number => {
    let worst = 0
    for (let i = 0; i < bw * bh; i++) worst = Math.max(worst, Math.abs(((frames[f] as { blocks: Float64Array }).blocks[i] as number) - ((frames[f - 1] as { blocks: Float64Array }).blocks[i] as number)))
    return worst
  }
  const near = (f: number): number[] => [-3, -2, -1, 1, 2, 3].map((d) => f + d).filter((g) => g >= 1 && g < n && !cuts.has(g) && !cuts.has(g - 1))
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length === 0 ? 0 : s.length % 2 === 1 ? (s[(s.length - 1) / 2] as number) : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2
  }
  const rows: string[] = []
  for (let f = 1; f < n; f++) {
    if (cuts.has(f)) continue
    const around = near(f).map((g) => steps[g] as number)
    if (around.length === 0) continue
    const d = steps[f] as number
    const m = median(around)
    if (d > FLOOR && d > STANDS * m) rows.push(`  f${f} ${(f / 30).toFixed(2)}s step ${d.toFixed(2)} vs ${m.toFixed(2)} block ${block(f).toFixed(3)}`)
  }
  const still: string[] = []
  let run = 0
  const hold = Math.round((n * HOLD_BEAT) / 24)
  for (let f = 1; f <= hold; f++) {
    let d = 0
    if (f < hold) {
      const a = (f - 1) * W * H
      const b = f * W * H
      for (let i = 0; i < W * H; i++) d += Math.abs((raw[b + i] as number) - (raw[a + i] as number))
      d /= W * H
    }
    if (f < hold && d < STILL) run++
    else {
      if (run > LONGEST) still.push(`f${f - run}-${f - 1} (${run})`)
      run = 0
    }
  }
  console.log(`${path.basename(file)}: ${rows.length} pops, frozen runs: ${still.length === 0 ? 'none' : still.join(' ')}`)
  for (const r of rows) console.log(r)
}
