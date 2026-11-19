import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compileTimeline } from '@silk-reel/choreo'
import type { FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import { parseKicadPcb } from '@silk-reel/ingest'
import { encodeWav, scoreAudio } from '../score-audio.js'

const root = path.resolve(import.meta.dirname, '../../../..')
const [outArg, traceDir, plotDir, boardList, styleList] = process.argv.slice(2)
const out = path.resolve(outArg ?? 'review/sound')
const boards = (boardList ?? 'glasgow,icebreaker,StickHub,ecc83-pp,video,kit-dev-coldfire-xilinx_5213').split(',')
mkdirSync(out, { recursive: true })
const summary: unknown[] = []
for (const name of boards) {
  const board = parseKicadPcb(readFileSync(path.join(root, 'fixtures/boards', `${name}.kicad_pcb`), 'utf8'), `${name}.kicad_pcb`)
  for (const style of (styleList ?? 'trace,plot,montage').split(',') as Array<'trace' | 'plot' | 'montage'>) {
    const cfg: FilmConfig = { style, knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } }
    const tl = compileTimeline(board, cfg) as TraceTimeline
    const t0 = Date.now()
    const a = scoreAudio(tl)
    const ms = Date.now() - t0
    const tag = `${style}-${name}`
    const wav = path.join(out, `${tag}.wav`)
    writeFileSync(wav, encodeWav(a.left, a.right, a.sampleRate))
    writeFileSync(path.join(out, `${tag}.cues.json`), JSON.stringify({ fps: tl.fps, events: a.cues.map((c) => ({ t: Number(c.t.toFixed(4)), kind: c.kind })) }))
    const film = path.join(root, (style === 'trace' ? traceDir : plotDir) ?? '', `${style}-${name}-4x5.mp4`)
    if (style !== 'montage') try {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', film, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', path.join(out, `${tag}.mp4`)])
    } catch {
      console.error(`no film at ${film}`)
    }
    const { cls, small, mask, nets, parts, heroPins, layers, widthMm, heightMm, density } = a.board
    const row = { tag, ms, music: a.music.title, cls, small: +small.toFixed(2), mask: +mask.toFixed(2), nets, parts, heroPins, layers, size: `${widthMm}x${heightMm}`, density: +density.toFixed(1), cues: a.cues.length }
    summary.push(row)
    console.log(JSON.stringify(row))
  }
}
writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1))
