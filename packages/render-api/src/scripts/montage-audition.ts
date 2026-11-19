import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ASPECT_SIZE, compileTimeline, hypeCut } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, HypeCut, TraceTimeline } from '@silk-reel/choreo'
import { defaultFilmConfig, loadDemoBoard } from '../boards.js'
import { encodeWav, montageScore } from '../score-audio.js'

const root = path.resolve(import.meta.dirname, '../../../..')
const [outArg, ...films] = process.argv.slice(2)
if (outArg === undefined || films.length === 0) throw new Error('usage: montage-audition.ts out board,aspect[,cuts.json[,film.mp4]] ...')
const out = path.resolve(root, outArg)
mkdirSync(out, { recursive: true })
for (const spec of films) {
  const [board, aspect, cutsFile, film] = spec.split(',') as [string, Aspect, string | undefined, string | undefined]
  const base = defaultFilmConfig(board)
  const config = { ...base, style: 'montage', aspect, output: { ...base.output, ...ASPECT_SIZE[aspect] } } as unknown as FilmConfig
  const tl = compileTimeline(await loadDemoBoard(board), config) as TraceTimeline
  const m = tl.scene.montage
  if (m === undefined) throw new Error(`${board} did not compile to a montage`)
  const events = cutsFile === undefined ? hypeCut(tl.scene, m, tl.width, tl.height).events : (JSON.parse(readFileSync(path.resolve(root, cutsFile), 'utf8')) as { events: HypeCut['events'] }).events
  const a = montageScore(tl, events)
  const stem = `${board}-${aspect.replace(':', 'x')}`
  const wav = path.join(out, `${stem}.wav`)
  writeFileSync(wav, encodeWav(a.left, a.right, a.sampleRate))
  writeFileSync(path.join(out, `${stem}.cues.json`), JSON.stringify({ fps: tl.fps, events, sounds: a.cues.map((c) => ({ t: Number(c.t.toFixed(4)), f: Number((c.t * tl.fps).toFixed(2)), kind: c.kind })) }, null, 1))
  if (film !== undefined && existsSync(path.resolve(root, film))) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.resolve(root, film), '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', path.join(out, `${stem}.mp4`)])
  console.log(`${stem}: ${tl.totalFrames} frames, weight ${m.weight}, music ${a.music.title}, ${a.cues.length} sounds`)
}
