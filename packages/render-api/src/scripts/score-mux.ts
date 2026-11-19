import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Timeline } from '@silk-reel/choreo'
import { encodeWav, scoreAudio } from '../score-audio.js'

const [silent, props, out, flag, music] = process.argv.slice(2)
if (silent === undefined || props === undefined || out === undefined || (flag !== undefined && (flag !== '--music' || music === undefined))) {
  console.error('usage: npx tsx packages/render-api/src/scripts/score-mux.ts <film.silent.mp4> <props.json from scripts/film-props.mts> <film.mp4> [--music <track>]')
  process.exit(1)
}
const { timeline } = JSON.parse(readFileSync(props, 'utf8')) as { timeline: Timeline }
const score = scoreAudio(timeline, music)
const wav = `${out}.score.wav`
writeFileSync(wav, encodeWav(score.left, score.right, score.sampleRate))
try {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out])
} finally {
  rmSync(wav, { force: true })
}
console.log(`${out}: ${timeline.style} score under ${silent}, music "${score.music.title}"${score.music.author === '' ? '' : ` by ${score.music.author}`}`)
