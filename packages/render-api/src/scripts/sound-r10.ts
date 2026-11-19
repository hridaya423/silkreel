import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { encodeWav, scoreAudio } from '../score-audio.js'
import { SET_FILMS, setTimeline } from './sound-set.js'

const root = path.resolve(import.meta.dirname, '../../../..')
const out = path.resolve(root, process.argv[2] ?? 'review/sound-r10')
const only = process.argv[3]
for (const f of SET_FILMS) {
  if (only !== undefined && !`${f.style}/${f.name}`.includes(only)) continue
  const tl = await setTimeline(f)
  const a = scoreAudio(tl)
  const dir = path.join(out, f.style === 'plot' ? 'blueprint' : f.style)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${f.name}.wav`), encodeWav(a.left, a.right, a.sampleRate))
  writeFileSync(path.join(dir, `${f.name}.cues.json`), JSON.stringify({ fps: tl.fps, cues: a.cues.map((c) => ({ t: Number(c.t.toFixed(4)), kind: c.kind })) }))
  console.log(`${f.style}/${f.name}`)
}
