import { describe, expect, it } from 'vitest'
import { compileTimeline, hypeCut, POSTER, RELEASE, STOP } from '@silk-reel/choreo'
import type { FilmConfig, GlyphTimeline, Timeline, TraceTimeline } from '@silk-reel/choreo'
import { parseKicadPcb } from '@silk-reel/ingest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeWav, loudness, ownMusic, powerCues, scoreAudio, truePeak } from './score-audio.js'
import { boardSound, LIBRARY, measured, pickTrack } from './sound-board.js'
import type { MusicStyle } from './sound-board.js'
import { decode, SOUND, SR } from './sound-kit.js'
import { SET_FILMS, setTimeline } from './scripts/sound-set.js'
import { spawnSync } from 'node:child_process'
import type { Score } from './score-audio.js'

const STYLES = ['trace', 'plot', 'montage', 'glyph'] as const
const DEMOS = ['glasgow', 'icebreaker', 'kit-dev-coldfire-xilinx_5213']
const timeline = (name: string, style: MusicStyle, file = `${name}.kicad_pcb`): Timeline => {
  const board = parseKicadPcb(readFileSync(join(import.meta.dirname, '..', '..', '..', 'fixtures', 'boards', `${name}.kicad_pcb`), 'utf8'), file)
  const cfg: FilmConfig = { style, knobs: {}, seed: 42, duration: 'auto', output: { width: 540, height: 675, fps: 30 } }
  return compileTimeline(board, cfg)
}
const measures = (tl: Timeline): ReturnType<typeof boardSound> => tl.style === 'glyph' ? measured({ ...tl.board, cls: 'mcu', heroPins: 0 }) : boardSound(tl)

const films = new Map<string, { tl: Timeline; score: Score }>()
const film = (name: string, style: MusicStyle): { tl: Timeline; score: Score } => {
  const key = `${style}:${name}`
  let f = films.get(key)
  if (f === undefined) {
    const tl = timeline(name, style)
    f = { tl, score: scoreAudio(tl) }
    films.set(key, f)
  }
  return f
}
const trace = (name: string): { tl: TraceTimeline; score: Score } => film(name, 'trace') as { tl: TraceTimeline; score: Score }

const rms = (a: { left: Float32Array; right: Float32Array }, t0: number, t1: number): number => {
  let e = 0
  const i0 = Math.max(0, Math.round(t0 * SR))
  const i1 = Math.min(a.left.length, Math.round(t1 * SR))
  for (let i = i0; i < i1; i++) e += (a.left[i] as number) ** 2 + (a.right[i] as number) ** 2
  return Math.sqrt(e / Math.max(1, 2 * (i1 - i0)))
}

const slice = (x: Float32Array, t0: number, t1: number): Float32Array => x.subarray(Math.max(0, Math.round(t0 * SR)), Math.min(x.length, Math.round(t1 * SR)))
const butterHighpass = (x: Float32Array, fc: number): Float32Array => {
  const w = (2 * Math.PI * fc) / SR
  const al = Math.sin(w) / Math.SQRT2
  const a0 = 1 + al
  const [b0, b1, b2, a1, a2] = [(1 + Math.cos(w)) / 2 / a0, -(1 + Math.cos(w)) / a0, (1 + Math.cos(w)) / 2 / a0, (-2 * Math.cos(w)) / a0, (1 - al) / a0]
  const y = new Float32Array(x.length)
  let [x1, x2, y1, y2] = [0, 0, 0, 0]
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    ;[x2, x1, y2, y1] = [x1, v, y1, o]
    y[i] = o
  }
  return y
}

/** cook/audit/arc.py's weighting: a 100 Hz Butterworth high-pass plus 0.58 of a first-order 1.5 kHz high-pass on top */
const arcWeight = (x: Float32Array): Float32Array => {
  const y = butterHighpass(x, 100)
  const k = Math.tan((Math.PI * 1500) / SR)
  const [b0, a1] = [1 / (1 + k), (k - 1) / (k + 1)]
  const out = new Float32Array(y.length)
  let [x1, y1] = [0, 0]
  for (let i = 0; i < y.length; i++) {
    const v = y[i] as number
    y1 = b0 * (v - x1) - a1 * y1
    x1 = v
    out[i] = v + 0.58 * y1
  }
  return out
}

const energy = (l: Float32Array, r: Float32Array): number => {
  let e = 0
  for (const x of [arcWeight(l), arcWeight(r)]) for (const v of x) e += v * v
  return -0.691 + 10 * Math.log10(Math.max(1e-12, e / l.length))
}
const level = (a: { left: Float32Array; right: Float32Array }, t0: number, t1: number): number => energy(slice(a.left, t0, t1), slice(a.right, t0, t1))

const momentary = (a: { left: Float32Array; right: Float32Array }, t: number): number => loudness(slice(a.left, t, t + 0.4), slice(a.right, t, t + 0.4))

/** whether the film peaks on its turn, in BS.1770 momentary loudness: no 0.4 s before it louder than the loudest 0.4 s from 0.3 s before the turn to `end`, and none after `end` more than 1 dB over it */
const loudestAt = (a: { left: Float32Array; right: Float32Array }, turn: number, end: number): boolean => {
  let [before, near, after] = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t + 0.4 <= a.left.length / SR; t += 0.1) {
    const v = momentary(a, t)
    const c = t + 0.2
    if (c < turn - 0.3) before = Math.max(before, v)
    else if (c <= end) near = Math.max(near, v)
    else after = Math.max(after, v)
  }
  return near > before && near >= after - 1
}
const peakIn = (a: { left: Float32Array; right: Float32Array }, t0: number, t1: number): number => {
  let best = -Infinity
  for (let t = t0; t + 0.4 <= t1; t += 0.1) best = Math.max(best, momentary(a, t))
  return best
}
const cue = (a: Score, kind: string): number => (a.cues.find((c) => c.kind === kind) as Score['cues'][number]).t

describe('the music library', () => {
  const credits = readFileSync(join(SOUND, 'CREDITS.md'), 'utf8')

  it.each(STYLES)('holds at least eight %s tracks, each one decoding to sound and credited with its own page', (style) => {
    const tracks = LIBRARY.filter((t) => t.style === style)
    expect(tracks.length).toBeGreaterThanOrEqual(8)
    for (const t of tracks) {
      const m = decode(join(SOUND, 'music', t.file), { from: t.drop, seconds: 1 })
      expect(rms({ left: m.l, right: m.r }, 0, 1), t.id).toBeGreaterThan(0.01)
      expect(credits, t.id).toContain(`\`music/${t.file}\``)
      expect(credits, t.id).toContain(`(${t.url})`)
    }
  })

  it('credits every recording bundled beside it, and bundles nothing it does not credit', () => {
    const files = readdirSync(SOUND).filter((f) => f.endsWith('.wav'))
    for (const f of files) expect(credits, f).toContain(`\`${f}\``)
    for (const m of credits.matchAll(/^\| `([\w-]+\.wav)`/gm)) expect(files).toContain(m[1])
    expect(readdirSync(join(SOUND, 'music')).filter((f) => f.endsWith('.opus')).sort()).toEqual(LIBRARY.map((t) => t.file).sort())
  })
})

describe.each(STYLES)('%s track pick', (style) => {
  it('gives Glasgow, iCEBreaker and the dev kit three different tracks, and a renamed copy of a board the same track', { timeout: 120_000 }, () => {
    const picks = DEMOS.map((name) => pickTrack(style, measures(timeline(name, style))).id)
    expect(new Set(picks).size, picks.join()).toBe(3)
    expect(pickTrack(style, measures(timeline('glasgow', style, 'my-board-rev2.kicad_pcb'))).id).toBe(picks[0])
  })
})

describe.each(STYLES)('%s score', (style) => {
  it('is the same waveform every time for the same board', { timeout: 120_000 }, () => {
    const a = film('glasgow', style).score
    const b = scoreAudio(timeline('glasgow', style))
    expect(Buffer.from(b.left.buffer).equals(Buffer.from(a.left.buffer))).toBe(true)
    expect(b.cues).toEqual(a.cues)
  })

  it.each(DEMOS)('masters %s to −14 LUFS under −1 dBTP, starting and ending in silence', { timeout: 120_000 }, (name) => {
    const { tl, score: a } = film(name, style)
    expect(a.left.length).toBe(Math.round(tl.durationSeconds * SR))
    expect(loudness(a.left, a.right)).toBeGreaterThan(-14.5)
    expect(loudness(a.left, a.right)).toBeLessThan(-13.5)
    expect(20 * Math.log10(truePeak(a.left, a.right))).toBeLessThanOrEqual(-1)
    expect(20 * Math.log10(rms(a, 0, 0.005) + 1e-12)).toBeLessThan(-50)
    expect(20 * Math.log10(rms(a, tl.durationSeconds - 0.05, tl.durationSeconds) + 1e-12)).toBeLessThan(-50)
  })
})

describe('trace score', () => {
  it.each(DEMOS)('holds a true silence from the breath to the light entering %s, sounds the light on its frame, and is loudest on the wake', { timeout: 120_000 }, (name) => {
    const { score: a, tl } = trace(name)
    const P = powerCues(tl)
    expect(rms(a, P.hush + 0.045, P.enter - 0.006)).toBe(0)
    let first = -1
    for (let i = Math.round((P.enter - 0.006) * SR); i < a.left.length; i++) {
      if (Math.abs(a.left[i] as number) + Math.abs(a.right[i] as number) > 0.002) {
        first = i / SR
        break
      }
    }
    expect(Math.abs(first - P.enter)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(cue(a, 'wake') - P.wake)).toBeLessThan(1e-6)
    expect(loudestAt(a, P.wake, P.wake + 0.9)).toBe(true)
  })

  it('places its parts, cuts and LEDs on their frames', { timeout: 120_000 }, () => {
    const { tl, score: a } = trace('glasgow')
    const dur = tl.durationSeconds
    const P = powerCues(tl)
    for (const c of a.cues.filter((x) => x.kind === 'led' || x.kind === 'chase')) expect(P.leds.some((l) => Math.abs(l.t - c.t) <= 0.02)).toBe(true)
    for (const c of a.cues.filter((x) => x.kind === 'part' || x.kind === 'hero')) expect(tl.scene.parts.some((p) => Math.abs(p.t * dur - c.t) <= 0.02)).toBe(true)
    const cuts = tl.scene.shots.filter((s) => s.cut === true && (s.t * dur < P.hush - 0.15 || s.t * dur > P.wake + 0.25)).map((s) => s.t * dur)
    for (const t of cuts.slice(0, 5)) expect(a.cues.some((c) => c.kind === 'air' && Math.abs(c.t - t) <= 0.02)).toBe(true)
    expect(a.cues.filter((c) => c.kind === 'air').length).toBeLessThanOrEqual(5)
  })

  it.each(DEMOS)('rises with %s\'s light from where it enters to the wake, and strikes the impact on the wake with the drop', { timeout: 120_000 }, (name) => {
    const { score: a, tl } = trace(name)
    const P = powerCues(tl)
    expect(cue(a, 'impact')).toBe(P.wake)
    if (P.wake - P.enter >= 0.4) expect(cue(a, 'rise')).toBeCloseTo(Math.max(P.enter, P.wake - 3), 6)
    expect(a.cues.some((c) => c.kind === 'rise' && c.t < P.enter - 1e-6)).toBe(false)
  })
})

describe('blueprint score', () => {
  it.each(DEMOS)('turns %s into the drawing on the end of its tilt, starts a line under each run of ink, slides paper for the sheet, and ends on the stamp', { timeout: 120_000 }, (name) => {
    const { tl, score: a } = film(name, 'plot') as { tl: TraceTimeline; score: Score }
    const plot = tl.scene.plot
    if (plot === undefined) throw new Error('no plot')
    const ev = plot.events
    const dur = tl.durationSeconds
    const tilt = ev.find((e) => e.kind === 'tilt')
    if (tilt === undefined) throw new Error('no tilt')
    const turn = tilt.t1 * dur
    const stamp = ((ev.find((e) => e.kind === 'stamp') ?? ev.find((e) => e.kind === 'title'))?.t0 ?? 0) * dur
    expect(cue(a, 'turn')).toBe(turn)
    expect(cue(a, 'paper:tilt')).toBe(tilt.t0 * dur)
    expect(a.cues.some((c) => c.kind === 'paper:pull')).toBe(true)
    expect(Math.abs(cue(a, 'stamp') - stamp)).toBeLessThan(1e-6)
    expect(Math.max(...a.cues.map((c) => c.t))).toBe(cue(a, 'stamp'))
    expect(a.cues.filter((c) => c.kind === 'switch' || c.kind === 'pen' || c.kind === 'pen-change')).toEqual([])
    const starts = ev.filter((e) => e.kind === 'stroke' || e.kind === 'ink' || e.kind === 'rule').map((e) => Math.max(0, e.t0) * dur)
    const lines = a.cues.filter((x) => x.kind === 'line')
    expect(lines.length).toBeGreaterThan(0)
    for (const c of lines) expect(starts.some((t) => Math.abs(t - c.t) <= 0.02)).toBe(true)
  })

  it('encodes to a 16-bit stereo WAV', { timeout: 120_000 }, () => {
    const a = film('glasgow', 'plot').score
    const wav = encodeWav(a.left, a.right, SR)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.length).toBe(44 + a.left.length * 4)
  })
})

describe('montage score', () => {
  it.each(DEMOS)('builds under the bursts of %s, stops dead, and is loudest on the release hit', { timeout: 120_000 }, (name) => {
    const { tl, score: a } = film(name, 'montage') as { tl: TraceTimeline; score: Score }
    const m = tl.scene.montage
    if (m === undefined) throw new Error('no montage')
    const F = (f: number): number => f / tl.fps
    const ev = hypeCut(tl.scene, m, tl.width, tl.height).events
    for (const e of ev.filter((x) => x.kind === 'burst' && x.f < STOP)) expect(a.cues.some((c) => c.kind === 'burst' && Math.abs(c.t - F(e.f)) < 1e-6)).toBe(true)
    const [stop, release] = [F(STOP), F(RELEASE)]
    expect(rms(a, stop + 0.02, release - 0.01)).toBe(0)
    expect(rms(a, 0, stop)).toBeGreaterThan(0.005)
    expect(Math.abs(cue(a, 'hit') - release)).toBeLessThan(1e-6)
    expect(cue(a, 'impact')).toBe(release)
    expect(loudestAt(a, release, release + 0.9)).toBe(true)
    const cuts = ev.filter((x) => x.kind === 'cut' && x.f > RELEASE && x.f < POSTER).map((x) => x.f)
    expect(a.cues.filter((c) => c.kind === 'air').map((c) => c.t)).toEqual(cuts.slice(0, 1).map(F))
    const short = cuts.filter((f, i) => i > 0 && (cuts[i + 1] ?? POSTER) - f <= 12)
    expect(a.cues.filter((c) => c.kind === 'tick').map((c) => c.t)).toEqual(short.map(F))
    expect(cue(a, 'tail')).toBe(F(POSTER))
  })
})

describe('glyph score', () => {
  it.each(['glasgow', 'icebreaker'])('scores %s from its events: the music entering on the turn and peaking before the end, a click on each formation and the name', { timeout: 120_000 }, (name) => {
    const { tl, score: a } = film(name, 'glyph') as { tl: GlyphTimeline; score: Score }
    const at = (kind: string): number[] => tl.events.filter((e) => e.kind === kind).map((e) => e.at / tl.fps)
    expect(Math.abs(cue(a, 'turn') - (at('turn')[0] as number))).toBeLessThan(1e-6)
    expect(cue(a, 'impact')).toBe(cue(a, 'turn'))
    for (const t of at('form')) expect(a.cues.some((c) => c.kind === 'form' && Math.abs(c.t - t) < 1e-6)).toBe(true)
    for (const t of at('name')) expect(a.cues.some((c) => c.kind === 'name' && Math.abs(c.t - t) < 1e-6)).toBe(true)
    expect(at('lock').length).toBeGreaterThan(0)
    for (const t of at('lock')) expect(a.cues.some((c) => c.kind === 'lock' && Math.abs(c.t - t) < 1e-6)).toBe(true)
    const turn = cue(a, 'turn')
    const rise = a.cues.find((c) => c.kind === 'rise')
    const lead = rise === undefined ? turn - 0.5 : rise.t
    let quiet = Infinity
    for (let t = Math.max(0, lead - 2.5); t + 0.45 <= lead; t += 0.05) quiet = Math.min(quiet, level(a, t, t + 0.45))
    expect(level(a, turn, turn + 1) - quiet).toBeGreaterThan(8)
    expect(loudestAt(a, turn, tl.durationSeconds)).toBe(true)
  })

  it('lays no sound on the last scene\'s stage and button events: the score is the same without them', { timeout: 120_000 }, () => {
    const { tl, score: a } = film('glasgow', 'glyph') as { tl: GlyphTimeline; score: Score }
    expect(tl.events.filter((e) => e.kind === 'stage').length).toBe(4)
    const b = scoreAudio({ ...tl, events: tl.events.filter((e) => e.kind !== 'stage' && e.kind !== 'button') })
    expect(a.cues).toEqual(b.cues)
    expect(a.left.length).toBe(b.left.length)
    expect(a.left.every((v, i) => v === b.left[i]) && a.right.every((v, i) => v === b.right[i])).toBe(true)
  })
})

describe('a listener\'s own track', () => {
  it('finds its tempo and its drop, and lands the drop on the film\'s turn', { timeout: 120_000 }, () => {
    const track = LIBRARY.find((t) => t.id === 'trace-memory-fragments')
    if (track === undefined) throw new Error('no Memory Fragments')
    const m = ownMusic(join(SOUND, 'music', track.file))
    expect(Math.abs(m.bpm - track.bpm)).toBeLessThan(0.5)
    expect(Math.abs(m.drop - track.drop)).toBeLessThan(60 / track.bpm)
    const tl = timeline('glasgow', 'montage')
    const a = scoreAudio(tl, join(SOUND, 'music', track.file))
    expect(a.music.title).toBe(track.file)
    expect(loudestAt(a, RELEASE / tl.fps, RELEASE / tl.fps + 0.9)).toBe(true)
  })
})

const decoded = (a: Score): { left: Float32Array; right: Float32Array } => {
  const aac = spawnSync('ffmpeg', ['-v', 'error', '-f', 'wav', '-i', 'pipe:0', '-c:a', 'aac', '-b:a', '256k', '-f', 'adts', 'pipe:1'], { input: encodeWav(a.left, a.right, a.sampleRate), maxBuffer: 1 << 28 })
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-f', 'aac', '-i', 'pipe:0', '-f', 'f32le', '-ac', '2', '-ar', String(SR), 'pipe:1'], { input: aac.stdout, maxBuffer: 1 << 28 })
  const all = new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.byteLength / 4)
  return { left: all.filter((_, i) => i % 2 === 0), right: all.filter((_, i) => i % 2 === 1) }
}

const losses = (l: Float32Array, r: Float32Array): { phone: number; mono: number } => {
  const all = energy(l, r)
  const mono = l.map((v, i) => (v + (r[i] as number)) / 2)
  const phone = butterHighpass(mono, 300)
  return { phone: all - energy(phone, phone), mono: all - energy(mono, mono) }
}

describe('release gates on the approved films', () => {
  it.each(SET_FILMS.map((f) => [`${f.style} ${f.name}`, f] as const))('%s', { timeout: 300_000 }, async (_, f) => {
    const a = scoreAudio(await setTimeline(f))
    const dur = a.left.length / SR
    const turn = f.style === 'trace' ? cue(a, 'wake') : f.style === 'montage' ? cue(a, 'hit') : cue(a, 'turn')
    const own = losses(a.left, a.right)
    const used = decode(a.music.file, { from: Math.max(0, a.music.drop - turn), seconds: dur })
    const track = losses(used.l, used.r)
    const out = decoded(a)
    expect(20 * Math.log10(truePeak(out.left, out.right)), 'decoded true peak').toBeLessThanOrEqual(-1)
    expect(20 * Math.log10(rms(a, dur - 0.05, dur) + 1e-12), 'last 50 ms').toBeLessThanOrEqual(-50)
    expect(own.phone - track.phone, 'phone loss over the track\'s own').toBeLessThanOrEqual(1)
    expect(own.mono - track.mono, 'mono loss over the track\'s own').toBeLessThanOrEqual(1)
    expect(loudestAt(a, turn, turn + 0.9), 'loudest 0.4 s at the turn').toBe(true)
    if (f.style === 'plot') expect(peakIn(a, turn, cue(a, 'stamp') - 0.3) - momentary(a, cue(a, 'stamp')), 'the stamp under the drop').toBeGreaterThan(3)
  })
})
