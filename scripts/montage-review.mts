// montage review: a 10 fps flip-book of 390 px tiles, a phone sheet, every-frame native strips, the shot table and the numbers for every frame
// usage: npx tsx scripts/montage-review.mts film.mp4 board 4:5 [title] [out]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ASPECT_SIZE, compileTimeline, shotOf } from '../packages/choreo/src/index.ts'
import type { Aspect, FilmConfig, MontageScore, MontageShot } from '../packages/choreo/src/index.ts'
import { loadDemoBoard, defaultFilmConfig } from '../packages/render-api/src/boards.ts'

const [film, board = 'icebreaker', aspect = '4:5', title, outArg] = process.argv.slice(2)
if (film === undefined) throw new Error('usage: montage-review.mts film.mp4 board aspect [title] [out]')
const stem = path.basename(film, '.mp4')
const out = path.resolve(outArg ?? path.dirname(film))
const strips = path.join(out, `${stem}-strips`)
rmSync(strips, { recursive: true, force: true })
mkdirSync(strips, { recursive: true })
const size = ASPECT_SIZE[aspect as Aspect]
const config = { ...defaultFilmConfig(board), style: 'montage', aspect, ...(title === undefined ? {} : { title: { name: title } }), output: { ...defaultFilmConfig(board).output, ...size } } as unknown as FilmConfig
const tl = compileTimeline(await loadDemoBoard(board), config)
if (tl.style !== 'montage' || tl.scene.montage === undefined) throw new Error('expected a montage timeline')
const m: MontageScore = tl.scene.montage
const shots = m.shots
const total = tl.totalFrames
const W = tl.width
const H = tl.height
const ff = (args: string[]): void => {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', film, ...args])
}

const step = tl.fps / 10
const frames = Math.ceil(total / step)
const cols = W > H ? 4 : 6
const per = cols * 5
for (let s = 0; s * per < frames; s++) {
  const n = Math.min(per, frames - s * per)
  ff(['-vf', `select='not(mod(n\\,${step}))*between(n\\,${s * per * step}\\,${(s * per + n) * step - 1})',scale=390:-1,tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=gray`, '-frames:v', '1', '-fps_mode', 'passthrough', '-q:v', '3', path.join(out, `${stem}-flip10-${s + 1}.jpg`)])
}
const phone = Array.from({ length: 12 }, (_, i) => Math.round((i * (total - 1)) / 11))
ff(['-vf', `select='${phone.map((f) => `eq(n\\,${f})`).join('+')}',scale=390:-1,tile=6x2:padding=6:color=gray`, '-frames:v', '1', '-fps_mode', 'passthrough', '-q:v', '3', path.join(out, `${stem}-phone.jpg`)])

const range = (a: number, b: number): number[] => Array.from({ length: Math.max(0, Math.min(total, b) - Math.max(0, a)) }, (_, i) => Math.max(0, a) + i)
const strip = (name: string, list: number[], scale = ''): void => {
  const cols = Math.min(W > H ? 4 : 6, list.length)
  const run = list.every((f, i) => i === 0 || f === (list[i - 1] as number) + 1)
  const pick = run ? `between(n\\,${list[0] as number}\\,${list.at(-1) as number})` : list.map((f) => `eq(n\\,${f})`).join('+')
  ff(['-vf', `select='${pick}',${scale}tile=${cols}x${Math.ceil(list.length / cols)}:padding=8:color=red`, '-frames:v', '1', '-fps_mode', 'passthrough', '-q:v', '4', path.join(strips, `${name}.jpg`)])
}
const print = shotOf(m, 'print') as MontageShot
strip('01-first-20', range(0, 20))
const hold = shots.find((s) => s.kind === 'hold') ?? print
strip('02-hold-into-landing-every-frame', range(hold.f1 - 8, print.f1 + 4))
const seen = new Set<string>()
for (const s of shots) {
  const into = s.hit?.into
  if (into === undefined || (s.hit?.frames ?? 0) === 0 || seen.has(into)) continue
  seen.add(into)
  strip(`join-${into}-into-${s.kind}-every-frame`, range(s.f0 - (s.hit?.frames ?? 0) - 2, s.f0 + 3))
}
strip('03-seam-last-12-then-0', [...range(total - 12, total), 0])
const climax = shots.find((s) => s.hit?.climax !== undefined && s.hit.act === undefined) ?? hold
const passage = [Number(process.env.PASSAGE_FROM ?? climax.f0 - 2), Number(process.env.PASSAGE_TO ?? climax.f1 + 2)] as const
strip(`04-changed-${passage[0]}-${passage[1]}-every-frame`, range(passage[0], passage[1]), 'scale=240:-1,')

const label = (s: MontageShot): string => s.kind
const beatOf = (f: number): string => {
  const b = f / m.beat
  return Number.isInteger(b) ? String(b) : b.toFixed(2)
}
const table = ['| hit | frame | beat | beat frame | word | arrives by | join frames | texture |', '|---|---|---|---|---|---|---|---|', ...shots.map((s) => `| ${s.kind}${s.hit?.flood === true ? ' (flood)' : ''} | ${s.f0} | ${beatOf(s.f0)} | ${Math.round(Math.round(s.f0 / (m.beat / 2)) * (m.beat / 2))} | ${s.hit?.word ?? (s.hit?.count !== undefined && s.hit.count[1] > s.hit.count[0] ? '(count)' : '')} | ${s.hit?.into ?? ''} | ${s.hit === undefined || s.hit.frames === 0 ? '' : `${s.f0 - s.hit.frames}–${s.f0 - 1}`} | ${s.hit?.join ?? ''} |`)]

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
const inks = [rgb(m.ink.paper), rgb(m.ink.black), rgb(m.ink.spot)]
const bytes = W * H * 3
const GW = Math.floor(W / 4)
const GH = Math.floor(H / 4)
const offShare: number[] = []
const changed: Uint8Array[] = []
let first: Buffer | undefined
let last: Buffer | undefined
let prev: Buffer | undefined
const off = new Uint8Array(W * H)
await new Promise<void>((resolve, reject) => {
  const p = spawn('ffmpeg', ['-v', 'error', '-i', film, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  let pending = Buffer.alloc(0)
  const frame = (buf: Buffer): void => {
    for (let i = 0, j = 0; i < bytes; i += 3, j++) {
      const r = buf[i] as number
      const g = buf[i + 1] as number
      const b = buf[i + 2] as number
      off[j] = inks.every((k) => Math.abs(r - k[0]) + Math.abs(g - k[1]) + Math.abs(b - k[2]) > 48) ? 1 : 0
    }
    let bad = 0
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const j = y * W + x
        if (off[j] === 0) continue
        if (off[j - 1] && off[j + 1] && off[j - W] && off[j + W] && off[j - W - 1] && off[j - W + 1] && off[j + W - 1] && off[j + W + 1]) bad++
      }
    }
    offShare.push(bad / (W * H))
    const mask = new Uint8Array(GW * GH)
    if (prev !== undefined) {
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const i = ((4 * y + 2) * W + 4 * x + 2) * 3
          mask[y * GW + x] = Math.abs((buf[i] as number) - (prev[i] as number)) + Math.abs((buf[i + 1] as number) - (prev[i + 1] as number)) + Math.abs((buf[i + 2] as number) - (prev[i + 2] as number)) > 24 ? 1 : 0
        }
      }
    }
    changed.push(mask)
    first ??= Buffer.from(buf)
    prev = Buffer.from(buf)
    last = prev
  }
  p.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= bytes) {
      frame(pending.subarray(0, bytes))
      pending = pending.subarray(bytes)
    }
  })
  p.on('error', reject)
  p.on('close', () => resolve())
})

const windows = shots.flatMap((s) => {
  const out: Array<{ shot: MontageShot; f: number; share: number }> = []
  for (let f = s.f0 + 6; f + 6 <= s.f1; f++) {
    const union = new Uint8Array(GW * GH)
    for (let k = f + 1; k < f + 6; k++) changed[k]?.forEach((v, i) => { if (v === 1) union[i] = 1 })
    out.push({ shot: s, f, share: union.reduce((a, b) => a + b, 0) / (GW * GH) })
  }
  return out
})
const holds: Array<[number, number]> = []
let held = 0
for (let t = 1; t * step < total; t++) {
  const union = new Uint8Array(GW * GH)
  for (let k = (t - 1) * step + 1; k <= t * step; k++) changed[k]?.forEach((v, i) => { if (v === 1) union[i] = 1 })
  const still = union.reduce((a, b) => a + b, 0) / (GW * GH) < 0.01
  if (still) held++
  if ((!still || (t + 1) * step >= total) && held >= 5) holds.push([(t - held) * step, held + 1])
  if (!still) held = 0
}
const slowest = windows.reduce((a, b) => (b.share < a.share ? b : a), windows[0] as (typeof windows)[number])
const slow = windows.filter((w) => w.share < 0.04)
let seam = 0
if (first !== undefined && last !== undefined) for (let i = 0; i < bytes; i += 3) if (Math.abs((first[i] as number) - (last[i] as number)) + Math.abs((first[i + 1] as number) - (last[i + 1] as number)) + Math.abs((first[i + 2] as number) - (last[i + 2] as number)) > 24) seam++
const flash = ((): string => {
  try {
    return execFileSync('npx', ['tsx', path.join(import.meta.dirname, 'flash-check.mts'), film, '--max', '2'], { encoding: 'utf8' })
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? e)
  }
})()
const shotAt = (f: number): string => {
  const s = shots.find((x) => f >= x.f0 && f < x.f1)
  return s === undefined ? '' : label(s)
}
const worst = offShare.reduce((a, b, i) => (b > (offShare[a] as number) ? i : a), 0)
const numbers = [
  `- route: ${m.route.net} from ${m.hero.ref} to ${m.route.end.label} (${m.route.end.kind}); layers ${m.route.layers.join(' > ')}; fact ${m.fact?.kind ?? 'none'}`,
  `- words and moves: ${m.words.map((w) => `${w.text.length > 18 ? `${w.text.slice(0, 18)}…` : w.text} (${w.move}${w.crop ? ', cropped' : ''})`).join(' · ')}`,
  `- frames measured: ${offShare.length} of ${total}`,
  `- non-ink pixels (more than 48 from all three inks, with all 8 neighbours also off, so a 1 px anti-aliased edge is excluded): max ${((offShare[worst] as number) * 100).toFixed(3)}% at frame ${worst} (${shotAt(worst)}); frames at 1% or more: ${offShare.filter((v) => v >= 0.01).length}`,
  `- smallest share of pixels changing in a 6-frame window after a shot's first 6 frames: ${(slowest.share * 100).toFixed(1)}% (${label(slowest.shot)}, frames ${slowest.f}–${slowest.f + 5}); windows under 4%: ${slow.length}${slow.length > 0 ? ` (${[...new Set(slow.map((w) => label(w.shot)))].map((l) => `${l}: windows from ${slow.filter((w) => label(w.shot) === l).map((w) => `${w.f} ${(w.share * 100).toFixed(1)}%`).join(', ')}`).join('; ')})` : ''}`,
  `- weight: ${m.weight}; fan routes: ${m.fan}; pulses: ${m.pulses.length}`,
  `- holds (more than five 10 fps tiles in a row with under 1% of pixels changing): ${holds.length === 0 ? 'none' : holds.map(([f, n]) => `${n} tiles from frame ${f} (${shotAt(f)})`).join('; ')}`,
  `- last frame against frame 0: ${((seam / (W * H)) * 100).toFixed(3)}% of pixels differ`,
  '- flash check at a limit of 2:',
  ...flash.trim().split('\n').map((l) => `    ${l}`)
]
writeFileSync(path.join(out, `${stem}-report.md`), [`# ${stem}`, '', ...table, '', ...numbers, ''].join('\n'))
console.log([...table, '', ...numbers].join('\n'))
