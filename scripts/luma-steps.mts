// lists single-frame mean-luma steps above a threshold, away from given cut frames
// usage: npx tsx scripts/luma-steps.mts <video.mp4>... [--over 2] [--cuts 45,90]
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name)
  return i >= 0 ? (args.splice(i, 2)[1] ?? fallback) : fallback
}
const over = Number(flag('--over', '2'))
const cuts = flag('--cuts', '45,90').split(',').map(Number)
for (const video of args) {
  const log = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const luma = [...log.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  const steps = luma.slice(1).map((y, i) => ({ frame: i + 1, step: y - (luma[i] as number) }))
  const bad = steps.filter((s) => Math.abs(s.step) > over && !cuts.some((c) => Math.abs(s.frame - c) <= 1))
  const max = Math.max(...steps.filter((s) => !cuts.some((c) => Math.abs(s.frame - c) <= 1)).map((s) => Math.abs(s.step)))
  console.log(`${path.basename(video)}\t${luma.length}f\tmax ${max.toFixed(2)}\t${bad.length === 0 ? 'clean' : bad.map((s) => `f${s.frame} ${s.step.toFixed(2)}`).join(' ')}`)
}
