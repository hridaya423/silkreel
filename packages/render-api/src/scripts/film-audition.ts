import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ASPECT_SIZE, compileTimeline } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import { boardsRoot, defaultFilmConfig, loadDemoBoard } from '../boards.js'
import { loadPartBodies } from '../models.js'
import { encodeWav, scoreAudio } from '../score-audio.js'

const root = path.resolve(import.meta.dirname, '../../../..')
const [style, outArg, pictureDir, ...films] = process.argv.slice(2)
if (style === undefined || outArg === undefined || pictureDir === undefined || films.length === 0) throw new Error('usage: film-audition.ts trace|plot|montage out pictureDir board,aspect,film.mp4[,title] ...')
const out = path.resolve(root, outArg)
mkdirSync(out, { recursive: true })
for (const spec of films) {
  const [board, aspect, file, title] = spec.split(',') as [string, Aspect, string, string | undefined]
  const base = defaultFilmConfig(board)
  const config = { ...base, style, aspect, output: { ...base.output, ...ASPECT_SIZE[aspect] }, ...(title === undefined ? {} : { title: { name: title } }) } as unknown as FilmConfig
  const model = await loadDemoBoard(board)
  const bodies = style !== 'plot' ? (await loadPartBodies(model, { boardDir: boardsRoot, dirs: process.env.SILK_REEL_MODELS?.split(path.delimiter) })).bodies : undefined
  const tl = compileTimeline(model, config, bodies) as TraceTimeline
  const a = scoreAudio(tl)
  const stem = path.basename(file, '.mp4')
  const wav = path.join(out, `${stem}.wav`)
  writeFileSync(wav, encodeWav(a.left, a.right, a.sampleRate))
  const shown = new Set(['row', 'heavy', 'second', 'hero', 'cut', 'enter', 'wake', 'led', 'chase', 'resolve', 'paper:cut', 'paper:tilt', 'paper:pull', 'land', 'trail', 'stop', 'mark', 'stamp', 'burst', 'hit', 'poster'])
  const cues = a.cues.filter((c) => shown.has(c.kind)).map((c) => ({ t: Number(c.t.toFixed(4)), f: Number((c.t * tl.fps).toFixed(1)), id: `${c.kind}@${(c.t * tl.fps).toFixed(1)}`, kind: c.kind }))
  writeFileSync(path.join(out, `${stem}.cues.json`), JSON.stringify({ fps: tl.fps, cues, sounds: a.cues.map((c) => ({ t: Number(c.t.toFixed(4)), f: Number((c.t * tl.fps).toFixed(1)), kind: c.kind })) }, null, 1))
  if (process.env.SILK_REEL_NOMUX !== '1') execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(root, pictureDir, file), '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', path.join(out, file)])
  console.log(`${stem}: ${tl.totalFrames} frames, music ${a.music.title}, ${a.cues.length} sounds; ${cues.map((c) => c.id).join(' ')}`)
}
