import path from 'node:path'
import { hypeCut, POSTER, RELEASE, STOP } from '@silk-reel/choreo'
import type { GlyphTimeline, HypeCut, MontageWeight, Timeline, TraceTimeline } from '@silk-reel/choreo'
import { boardSound, measured, pickTrack } from './sound-board.js'
import type { BoardSound, MusicStyle } from './sound-board.js'
import { Bus, decode, highpass, loudness, lowpass, master, resample, room, shape, sound, SOUND, SR, sustain } from './sound-kit.js'

export { encodeWav, loudness, truePeak } from './sound-kit.js'

/** one sound the score placed on a picture event: when its attack lands (s), and what it follows */
export interface Cue { t: number; kind: string }

/** a music track ready to cut: stereo at SR, already on the film's tempo grid, with the downbeat that lands on the turn */
export interface Music {
  l: Float32Array
  r: Float32Array
  /** seconds into l/r of the downbeat that lands on the turn */
  drop: number
  /** the grid it was locked to; 0 when it has no pulse */
  bpm: number
  title: string
  author: string
  file: string
}

export interface Score {
  left: Float32Array
  right: Float32Array
  sampleRate: number
  board: BoardSound
  music: Omit<Music, 'l' | 'r'>
  cues: Cue[]
}

const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/** a deterministic 0..1 from an integer, so repeated sounds vary without randomness */
const hash = (i: number): number => {
  let x = (i + 0x9e3779b9) | 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

/** the blueprint's drop-out before the stamp, seconds */
const DROP = 0.3

/** how far an effect strays from the centre at most: effects are dry and central, width belongs to the music */
const EFFECT_WIDTH = 0.3

/** the shortest gap between two strokes of one repeated action that a listener hears as two, seconds */
const APART = 0.09

/** how long before a film's last frame its last sound has rung out, seconds */
const TAIL = 0.15

/** how far the music before the turn sits under the music after it, LU, at least and at most: tension before, release after, and never so far under that the build is lost */
const BUILD_UNDER: [number, number] = [6, 10]
const SETTLE = 3

/** how long the drop's hit lasts as the film's loudest moment, seconds */
const HIT = 0.9

/** the grids a track may be locked to, BPM: the film's 120, half of it, and two thirds of it (three beats of 80 span two bars of 120) */
const GRIDS = [60, 80, 120, 240]

/** the furthest a track is stretched to lock it, as a fraction of its tempo: past this a listener hears the stretch */
const STRETCH = 0.06

const decoded = new Map<string, Music>()

/** a library track, read once */
function libraryMusic(style: MusicStyle, b: BoardSound): Music {
  const t = pickTrack(style, b)
  let m = decoded.get(t.id)
  if (m === undefined) {
    const file = path.join(SOUND, 'music', t.file)
    m = { ...decode(file), drop: t.drop, bpm: t.bpm, title: t.title, author: t.author, file }
    decoded.set(t.id, m)
  }
  return m
}

/**
 * A listener's own track, cut by the library's rules: its tempo found from
 * the attacks, locked to the film's grid when it lies within STRETCH of one,
 * and its biggest step up in level (a section starting, a drop) chosen as the
 * downbeat that lands on the turn.
 */
export function ownMusic(file: string): Music {
  const whole = decode(file, { seconds: 360 })
  const hop = 512
  const fr = SR / hop
  const frames = Math.floor(whole.l.length / hop)
  if (frames < fr * 4) throw new Error(`${file} is shorter than four seconds`)
  const level = new Float32Array(frames)
  for (let k = 0; k < frames; k++) {
    let e = 0
    for (let i = k * hop; i < (k + 1) * hop; i++) e += (((whole.l[i] as number) + (whole.r[i] as number)) / 2) ** 2
    level[k] = 10 * Math.log10(e / hop + 1e-10)
  }
  const step0 = Float32Array.from(level, (v, k) => (k === 0 ? 0 : Math.max(0, v - (level[k - 1] as number))))
  const rise = Float32Array.from(step0, (v, k) => 0.5 * v + 0.25 * ((step0[k - 1] ?? v) + (step0[k + 1] ?? v)))
  const mean = rise.reduce((a, v) => a + v, 0) / frames
  const ac = (lag: number): number => {
    let s = 0
    for (let k = lag; k < frames; k++) s += ((rise[k] as number) - mean) * ((rise[k - lag] as number) - mean)
    return s / (frames - lag)
  }
  let lag = 0
  let best = -Infinity
  for (let l = Math.floor((60 / 180) * fr); l <= Math.ceil(fr); l++) {
    const v = ac(l) * Math.exp(-0.5 * Math.log2(60 * fr / l / 120) ** 2)
    if (v > best) {
      best = v
      lag = l
    }
  }
  const [a, c, d] = [ac(lag - 1), ac(lag), ac(lag + 1)]
  const period = lag + (a - d) / (2 * (a - 2 * c + d) || 1)
  const pulse = c / Math.max(1e-12, ac(0)) > 0.1
  const found = (60 * fr) / period
  const grid = pulse ? GRIDS.find((g) => Math.abs(found / g - 1) <= STRETCH) : undefined
  const tempo = grid === undefined ? 1 : grid / found
  const step = pulse ? period : fr / 4
  let phase = 0
  let strongest = -Infinity
  for (let p = 0; p < step; p++) {
    let s = 0
    for (let k = p; k < frames; k += step) s += rise[Math.round(k)] ?? 0
    if (s > strongest) {
      strongest = s
      phase = p
    }
  }
  const span = (k0: number, k1: number): number => {
    let s = 0
    for (let k = Math.max(0, Math.round(k0)); k < Math.min(frames, Math.round(k1)); k++) s += level[k] as number
    return s / Math.max(1, Math.round(k1) - Math.round(k0))
  }
  const reach = 8 * fr
  const halves: number[] = []
  for (let k = 0; k + reach / 2 <= frames; k += step) halves.push(span(k, k + reach / 2))
  const loud = halves.sort((x, y) => x - y)[Math.floor(halves.length / 2)] as number
  let drop = phase + Math.ceil((reach - phase) / step) * step
  let jump = -Infinity
  for (let k = drop; k < frames - reach; k += step) {
    const j = span(k, k + fr) - span(k - fr, k)
    if (span(k, k + reach / 2) >= loud && j > jump) {
      jump = j
      drop = k
    }
  }
  let edge = -Infinity
  let onset = drop
  for (let k = Math.round(drop - step / 2); k <= Math.round(drop + step / 2); k++) {
    const e = span(k, k + fr / 4) - span(k - fr / 4, k)
    if (e > edge) {
      edge = e
      onset = k
    }
  }
  const dropAt = (onset * hop) / SR
  const from = Math.max(0, dropAt - 14 * tempo)
  const cut = decode(file, { from, seconds: 28 * tempo, tempo })
  return { ...cut, drop: (dropAt - from) / tempo, bpm: grid ?? 0, title: path.basename(file), author: '', file }
}

interface MusicCut {
  /** the frame's time the drop lands on, seconds */
  turn: number
  /** when the music has fallen silent before the turn; the silence is half of the drop */
  breath: number
  /** when it has faded out at the end */
  gone: number
  fadeOut: number
  /** a room on the last bars that rings on after the fade, to the film's last frame */
  ring: boolean
}

/**
 * The track edited to the film: its drop on the turn, the bars before it 6 to
 * 10 LU under the release, its loudest moment 3 dB under the drop's, gone by
 * the breath, back on the drop's first
 * sample, settling 3 dB under the hit, faded out at the end with its room
 * ringing on. It starts where its excerpt reaches back to, faded in over a
 * second so it never starts mid-note.
 */
function lay(m: Music, n: number, c: MusicCut): Bus {
  const bus = new Bus(n)
  const off = Math.round((m.drop - c.turn) * SR)
  const start = Math.max(0, -off / SR)
  const gone = Math.min(c.gone, (m.l.length - off) / SR - 0.05)
  const before = c.breath - start >= 1.5
  const fadeIn = 1
  const env = (t: number): number => {
    if (t < c.turn - 0.002) return before ? smooth((t - start) / fadeIn) * (1 - smooth((t - (c.breath - 0.25)) / 0.25)) : 0
    const floor = Math.pow(10, -SETTLE / 20)
    const hit = floor + (1 - floor) * Math.exp(-(t - c.turn) / 1.2)
    return Math.min(1, (t - c.turn + 0.002) / 0.002) * hit * (1 - smooth((t - (gone - c.fadeOut)) / c.fadeOut))
  }
  for (let i = 0; i < n; i++) {
    const j = i + off
    if (j < 0 || j >= m.l.length) continue
    const g = env(i / SR)
    bus.l[i] = (m.l[j] as number) * g
    bus.r[i] = (m.r[j] as number) * g
  }
  const win = (t0: number, t1: number): number => loudness(bus.l.subarray(Math.round(t0 * SR), Math.round(t1 * SR)), bus.r.subarray(Math.round(t0 * SR), Math.round(t1 * SR)))
  const peak = (t0: number, t1: number): number => {
    let p = -Infinity
    for (let t = t0; t + 0.4 <= t1; t += 0.1) p = Math.max(p, win(t, t + 0.4))
    return p
  }
  const hit = peak(c.turn, Math.min(gone, c.turn + HIT + 0.4))
  if (before) {
    const gap = win(c.turn, Math.min(gone, c.turn + 3)) - win(start, c.breath)
    const over = peak(start, c.breath) - hit + SETTLE
    const shift = Math.min(gap < BUILD_UNDER[0] ? gap - BUILD_UNDER[0] : gap > BUILD_UNDER[1] ? gap - BUILD_UNDER[1] : 0, -over)
    if (shift !== 0) {
      const k = Math.pow(10, shift / 20)
      for (let i = 0; i < Math.round(c.turn * SR); i++) {
        bus.l[i] = (bus.l[i] as number) * k
        bus.r[i] = (bus.r[i] as number) * k
      }
    }
  }
  if (c.ring) {
    const r = room(bus, 0.9, 2.6, 0.5, 0.6)
    const end = n / SR - TAIL
    const f0 = Math.round((gone - c.fadeOut) * SR)
    const k = Math.pow(10, (win(f0 / SR - 1, f0 / SR) - 12 - loudness(r.l.subarray(f0 - SR, f0), r.r.subarray(f0 - SR, f0))) / 20)
    for (let i = f0; i < n; i++) {
      const t = i / SR
      const g = k * smooth((t - (gone - c.fadeOut)) / c.fadeOut) * Math.max(0, Math.min(1, (end - t) / 0.4))
      bus.l[i] = (bus.l[i] as number) + g * (r.l[i] as number)
      bus.r[i] = (bus.r[i] as number) + g * (r.r[i] as number)
    }
  }
  return bus
}

const momentaryPeak = (bus: Bus, t0: number, t1: number): number => {
  let p = -Infinity
  for (let t = Math.max(0, t0); t + 0.4 <= Math.min(t1, bus.n / SR); t += 0.1) {
    const a = Math.round(t * SR)
    const z = a + Math.round(0.4 * SR)
    p = Math.max(p, loudness(bus.l.subarray(a, z), bus.r.subarray(a, z)))
  }
  return p
}

/**
 * Masters the mix so its loudest moment is the turn as heard after the
 * limiter: the limiter takes more off a drop's transients than off the
 * sustained bars around it, so whatever outshines the hit once mastered is
 * ridden down by the difference, and the mix mastered again.
 */
function masterOnTurn(mix: Bus, turn: number, from = turn + HIT, under = 1.5): void {
  for (let pass = 0; pass < 10; pass++) {
    const out = new Bus(mix.n)
    out.mix(mix)
    master(out)
    const hit = momentaryPeak(out, turn - 0.1, turn + HIT + 0.4)
    const before = momentaryPeak(out, 0, turn - 0.1) - (hit - 1)
    const after = momentaryPeak(out, from, mix.n / SR) - (hit - under)
    if ((before <= 0 && after <= 0) || pass === 9) {
      mix.l.set(out.l)
      mix.r.set(out.r)
      return
    }
    const kb = Math.pow(10, (-1.5 * Math.max(0, before)) / 20)
    const ka = Math.pow(10, (-1.5 * Math.max(0, after)) / 20)
    for (let i = 0; i < mix.n; i++) {
      const t = i / SR
      const g = t < turn - 0.1 ? kb + (1 - kb) * smooth((t - turn + 0.4) / 0.3) : 1 - (1 - ka) * smooth((t - from + 0.3) / 0.3)
      mix.l[i] = (mix.l[i] as number) * g
      mix.r[i] = (mix.r[i] as number) * g
    }
  }
}

/** the physical sounds set against the music, dry and close (a room on a scratch or a click rings like metal), their loudness `under` LU below the music's from t0 to t1 (by default the first three seconds after the drop) */
function against(music: Bus, fx: Bus, turn: number, under: number, t1 = turn + 3): Bus {
  const a = Math.round(turn * SR)
  const z = Math.min(music.n, Math.round(t1 * SR))
  const lm = loudness(music.l.subarray(a, z), music.r.subarray(a, z))
  const lf = loudness(fx.l, fx.r)
  const mix = new Bus(music.n)
  mix.mix(music)
  if (Number.isFinite(lf)) mix.mix(fx, Math.pow(10, (lm - under - lf) / 20))
  return mix
}

/** the airs a film's hard cuts take, in order: never the same recording twice in one film */
const AIRS = ['air-1', 'air-2', 'air-3', 'air-4', 'air-5']
/** how far an air stands over the mix around its cut, LU */
const AIR_OVER = 0

const apexOf = (x: Float32Array): number => {
  let best = 0
  let at = 0
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i] as number)
    if (v > best) {
      best = v
      at = i
    }
  }
  return at / SR
}

/** a short air on the hard cut at t, its loudest instant on the cut's frame; false once the film has used every recording */
function air(cues: Cue[], t: number): boolean {
  if (cues.filter((c) => c.kind === 'air').length >= AIRS.length) return false
  cues.push({ t, kind: 'air' })
  return true
}

/** each cut's air set `over` LU against the finished mix in the 0.35 s around its loudest instant, so a loud passage never buries it, and never within 12 LU of the turn, so a quiet opening stays quiet */
function airs(mix: Bus, cues: Cue[], over: number, turn: number): void {
  const ceiling = loudness(mix.l.subarray(Math.round(turn * SR), Math.round((turn + 1) * SR)), mix.r.subarray(Math.round(turn * SR), Math.round((turn + 1) * SR))) - 12
  const win = (bus: Bus, t: number): number => loudness(bus.l.subarray(Math.round((t - 0.25) * SR), Math.round((t + 0.1) * SR)), bus.r.subarray(Math.round((t - 0.25) * SR), Math.round((t + 0.1) * SR)))
  const placed = cues.filter((c) => c.kind === 'air').map((c, k) => {
    const one = new Bus(mix.n)
    const v = sound(AIRS[k] as string)
    one.add(c.t - apexOf(v), v, 1)
    return { one, gain: Math.pow(10, (Math.min(win(mix, c.t) + over, ceiling) - win(one, c.t)) / 20) }
  })
  for (const { one, gain } of placed) mix.mix(one, gain)
}

/**
 * The rise that travels with a fast move into the turn: the impact's own
 * recording played backwards, so it swells out of its sub tail into its
 * strike, under a reversed cymbal's swell, both cut dead on the turn's frame,
 * where the impact itself lands.
 */
function rise(bus: Bus, cues: Cue[], t0: number, t1: number, gain: number): void {
  const len = Math.min(3, t1 - t0)
  if (len < 0.4) return
  const boom = sound('boom')
  const k = Math.round(len * SR)
  const back = shape(boom.subarray(0, k).slice().reverse(), (t) => Math.min(smooth(t / (0.4 * len)), (len - t) / 0.003))
  bus.add(t1 - len, back, gain)
  const swell = sound('swell')
  bus.add(t1 - swell.length / SR, swell, 0.6 * gain)
  cues.push({ t: t1 - len, kind: 'rise' })
}

/** the impact on the turn: one strike with a sub tail, on the same sample as the music's drop */
function impact(bus: Bus, cues: Cue[], t: number, gain: number): void {
  bus.hit(t, sound('boom'), gain)
  cues.push({ t, kind: 'impact' })
}

/** a deep, soft air whose loudest instant meets the held last frame and whose tail rings out under it */
function tail(bus: Bus, cues: Cue[], t: number, gain: number): void {
  const v = sound('deep-air')
  bus.add(t - apexOf(v), v, gain)
  cues.push({ t, kind: 'tail' })
}

/** the designed sound laid against the music: `over` LU against the music in the second after the turn, its sample peak at most half the music's there, since a sub-heavy impact weighs little in LUFS but its peaks would make the limiter flatten the drop */
function design(mix: Bus, fx: Bus, turn: number, over: number): void {
  const a = Math.round(turn * SR)
  const z = Math.min(mix.n, a + SR)
  const lm = loudness(mix.l.subarray(a, z), mix.r.subarray(a, z))
  const lf = loudness(fx.l.subarray(a, z), fx.r.subarray(a, z))
  if (!Number.isFinite(lf)) return
  const top = (x: Bus): number => {
    let p = 0
    for (let i = a; i < z; i++) p = Math.max(p, Math.abs(x.l[i] as number), Math.abs(x.r[i] as number))
    return p
  }
  mix.mix(fx, Math.min(Math.pow(10, (lm + over - lf) / 20), (0.5 * top(mix)) / Math.max(1e-9, top(fx))))
}

/** the film's last sound ringing on in a room at `under` of its level over its first second, falling to nothing TAIL before the last frame */
function ringOut(mix: Bus, src: Bus, at: number, size: number, decay: number, under: number): void {
  const r = room(src, size, decay, 0.5, 0.5)
  const end = mix.n / SR - TAIL
  const lvl = (x: Bus): number => {
    let e = 0
    for (let i = Math.round(at * SR); i < Math.min(x.n, Math.round((at + 1) * SR)); i++) e += (x.l[i] as number) ** 2 + (x.r[i] as number) ** 2
    return Math.sqrt(e)
  }
  const gain = (under * lvl(src)) / Math.max(1e-9, lvl(r))
  for (let i = 0; i < mix.n; i++) {
    const g = Math.max(0, Math.min(1, (end - i / SR) / 0.3))
    mix.l[i] = (mix.l[i] as number) + gain * g * (r.l[i] as number)
    mix.r[i] = (mix.r[i] as number) + gain * g * (r.r[i] as number)
  }
}

const about = (m: Music): Score['music'] => ({ drop: m.drop, bpm: m.bpm, title: m.title, author: m.author, file: m.file })

/**
 * When the power-on happens. The picture's cut into the last take, the light
 * entering at the power connector, the hero's wake, the pulse front and the
 * LED times are read here and nowhere else, so the score follows the film
 * when those times move: the cut is the frame the power act starts, the light
 * enters when the copper from the supply first lights, the wake is when that
 * light reaches the hero, the front is when the current reaches each copper
 * segment, and each LED fires as it lights.
 */
export function powerCues(tl: TraceTimeline): { dim: number; hush: number; cut: number; enter: number; wake: number; entry: number; front: number[]; leds: Array<{ t: number; x: number; chase: boolean }>; up: number; land: number } {
  const s = tl.scene
  const dur = tl.durationSeconds
  const cut = s.acts.power[0] * dur
  const keys = s.shots.filter((k) => k.t * dur < cut - 1e-6)
  const lit = [...keys].reverse().find((k) => k.light !== undefined && k.light !== 'power')
  const dim = lit?.light === 'breath' ? lit.t * dur : cut - dur / 24
  const hush = cut - 7 / tl.fps
  const front: number[] = []
  let first = Infinity
  let entry = tl.width / 2
  for (const layer of s.layers) {
    for (let i = 0; i + 1 < layer.energy.length; i += 2) {
      const e = (layer.energy[i] as number) * dur
      if (e < 0 || e <= cut) continue
      front.push(e)
      if (e < first) {
        first = e
        entry = layer.segs[(i / 2) * 7] as number
      }
    }
  }
  front.sort((a, b) => a - b)
  const wake = s.wake === undefined ? cut : s.wake * dur
  const enter = s.wake === undefined ? cut : Math.min(wake, first)
  const near = (a: number, b: number | undefined): boolean => b !== undefined && Math.abs(a - b) < 1e-6
  const leds = s.parts.flatMap((p) => {
    const at = p.led?.at ?? -1
    if (at < 0) return []
    return [{ t: Math.max(enter, at * dur), x: p.x / tl.width, chase: !near(at, s.acts.power[1]) && !near(at, s.sign?.t) }]
  })
  leds.sort((a, b) => a.t - b.t)
  const up = (s.lockup?.build?.readable ?? s.acts.hold[0]) * dur
  return { dim: Math.min(dim, hush - 0.25), hush, cut, enter, wake, entry, front, leds, up, land: s.acts.power[1] * dur }
}

/**
 * The trace film: its track's build under the real foley of routing, the
 * coat's cure, parts landing and the oven, each cut marked by a relay. The
 * parts say what they are: a crowd landing in one run is one paper sweep, a
 * heavy connector lands with weight, the second chip and the hero seat with a
 * contact. Everything falls away into a true silence across the cut into the
 * last take; the switch closes where the light enters; the track's drop lands
 * on the wake; a tick for each LED; the track fades under the held frame and
 * its room rings on.
 */
export function traceScore(tl: TraceTimeline, music?: Music): Score {
  const dur = tl.durationSeconds
  const n = Math.round(dur * SR)
  const b = boardSound(tl)
  const s = tl.scene
  const a = s.acts
  const T = (p: number): number => p * dur
  const place = (x: number): number => EFFECT_WIDTH * Math.max(-0.8, Math.min(0.8, (x / tl.width) * 2 - 1))
  const cues: Cue[] = []
  const P = powerCues(tl)
  const build = new Bus(n)
  const lit = new Bus(n)

  const clicks = ['click-1', 'click-2', 'click-3', 'click-4']
  const contact = (k: number): Float32Array => highpass(sound(k % 2 === 0 ? 'relay-2' : 'relay-1'), 1500)
  const tick = 0.92 + 0.16 * Math.min(1, b.density / 10)
  const starts: Array<[number, number]> = []
  for (const layer of s.layers) {
    for (let i = 0; i + 6 < layer.segs.length; i += 7) {
      const t0 = layer.segs[i + 5] as number
      if (t0 >= 0 && t0 < a.draw[1] - 0.5 / 24) starts.push([t0, layer.segs[i] as number])
    }
  }
  starts.sort((x, y) => x[0] - y[0])
  let last = -Infinity
  starts.forEach(([t0, x], i) => {
    const at = T(t0)
    if (at - last < (b.density > 2.5 ? 1 / 4 : 1 / 5)) return
    last = at
    build.hit(at, lowpass(resample(sound(clicks[i % 4] as string), tick * (1 + 0.03 * (i % 3))), 6000), 0.25, place(x))
    cues.push({ t: at, kind: 'route' })
  })

  const fx = new Bus(n)
  for (const c of s.shots.filter((x) => x.cut === true && (x.t * dur < P.hush - 0.15 || x.t * dur > P.wake + 0.25)).map((x) => x.t * dur)) {
    if (air(cues, c)) cues.push({ t: c, kind: 'cut' })
  }

  build.hit(T(a.silk[0]), sound('click-3'), 0.3)
  cues.push({ t: T(a.silk[0]), kind: 'silk' })

  const bodies = s.parts.filter((p) => p.kind !== 'pin').sort((x, y) => x.t - y.t)
  const hero = bodies.find((p) => p.hero === true)
  const frame = 1 / tl.fps
  const tall = 3 * (hero?.z ?? Math.max(1, ...bodies.filter((p) => p.kind === 'ic').map((p) => p.z)))
  const heavy = new Set(bodies.filter((p) => p.kind === 'conn' && p.z >= tall && p.hero !== true))
  const alone = (p: (typeof bodies)[number]): boolean => !bodies.some((q) => q !== p && Math.abs(T(q.t - p.t)) < 2 * frame)
  const second = bodies.filter((p) => p.kind === 'ic' && p.hero !== true && alone(p)).sort((x, y) => y.w * y.h - x.w * x.h)[0]
  let thud = -Infinity
  for (const p of bodies) {
    const at = T(p.t)
    if (p.hero === true) {
      build.hit(at, sound('seat'), 0.7, place(p.x))
      build.hit(at, contact(0), 0.4, place(p.x))
      fx.hit(at, sound('thud'), 0.5)
      cues.push({ t: at, kind: 'hero' })
    } else if (p === second) {
      build.hit(at, resample(sound('seat'), 1.15), 0.5, place(p.x))
      build.hit(at, contact(1), 0.3, place(p.x))
      cues.push({ t: at, kind: 'second' })
    } else if (heavy.has(p)) {
      if (at - thud < APART) continue
      thud = at
      const k = cues.filter((c) => c.kind === 'heavy').length
      build.hit(at, resample(sound('seat'), k % 2 === 0 ? 0.8 : 0.74), 0.7, place(p.x))
      build.hit(at, contact(k), 0.3, place(p.x))
      cues.push({ t: at, kind: 'heavy' })
    }
  }
  const crowd = bodies.filter((p) => p.hero !== true && p !== second && !heavy.has(p))
  const rows: Array<typeof crowd> = []
  for (const p of crowd) {
    const row = rows[rows.length - 1]
    const prev = row?.[row.length - 1]
    if (row !== undefined && prev !== undefined && T(p.t - prev.t) <= 1.5 * frame) row.push(p)
    else rows.push([p])
  }
  last = -Infinity
  for (const row of rows) {
    if (row.length >= 6) {
      const t0 = T((row[0] as (typeof row)[number]).t)
      const t1 = T((row[row.length - 1] as (typeof row)[number]).t)
      const peak = row.reduce((sum, p) => sum + T(p.t), 0) / row.length
      const x = row.reduce((sum, p) => sum + p.x, 0) / row.length
      const span = Math.max(0.2, t1 - t0 + 0.12)
      if (t0 - last < APART) {
        last = t1
        continue
      }
      const paper = sound('paper')
      const rate = Math.max(0.7, Math.min(1.6, paper.length / SR / (span + 0.1)))
      const top = peak - t0 + 0.06
      const swish = shape(resample(paper, rate), (t) => (t < top ? smooth(t / Math.max(0.05, top)) : Math.max(0, 1 - (t - top) / Math.max(0.08, span - (peak - t0)))))
      build.add(t0 - 0.06, highpass(swish, 300), 0.3 + 0.05 * Math.min(4, Math.log2(row.length / 6 + 1)), place(x))
      build.hit(t1, resample(sound('click-2'), 0.9), 0.3, place(x))
      cues.push({ t: t0, kind: 'row' })
      last = t1
      continue
    }
    for (const [i, p] of row.entries()) {
      const at = T(p.t)
      if (at - last < 1 / 6) continue
      last = at
      const small = Math.min(1, Math.max(0, 1 - p.z / 30))
      if (p.z > 8) build.hit(at, resample(sound('seat'), 1 + 0.15 * small), 0.35, place(p.x))
      else build.hit(at, lowpass(resample(sound(clicks[(i + 1) % 4] as string), (0.9 + 0.1 * small) * tick), 6000), 0.38, place(p.x))
      cues.push({ t: at, kind: 'part' })
    }
  }

  const [rf0, rf1] = a.reflow
  const sz = resample(sound('sizzle'), 0.8 + 0.4 * b.small).subarray(0, Math.round(Math.max(0.1, Math.min(T(rf1 - rf0) + 0.01, P.hush - T(rf0))) * SR))
  build.add(T(rf0) - 0.1, shape(sz, (t) => Math.min(1, t / 0.25, (sz.length / SR - t) / 0.25)), 0.08)
  cues.push({ t: T(rf0), kind: 'reflow' })
  build.silence(P.hush, n / SR, 0.012)

  lit.hit(P.enter, sound('switch'), 0.9)
  lit.hit(P.enter, highpass(sound('relay-1'), 1500), 0.5)
  cues.push({ t: P.enter, kind: 'enter' })
  let chased = -Infinity
  const chase = P.leds.filter((l) => {
    if (!l.chase || l.t - chased < APART) return false
    chased = l.t
    return true
  })
  chase.forEach((l, i) => {
    const out = i / Math.max(1, chase.length - 1)
    lit.hit(l.t, lowpass(resample(sound(`click-${(i % 4) + 1}`), 1 + 0.08 * out), 6000), 0.18 - 0.05 * out, EFFECT_WIDTH * Math.max(-0.7, Math.min(0.7, l.x * 2 - 1)))
    cues.push({ t: l.t, kind: 'chase' })
  })
  let ledLast = -Infinity
  P.leds.filter((l) => !l.chase).forEach((l, i) => {
    if (l.t - ledLast < 0.12) return
    ledLast = l.t
    lit.hit(l.t, lowpass(sound(`click-${(i % 4) + 1}`), 6000), 0.22, EFFECT_WIDTH * Math.max(-0.7, Math.min(0.7, l.x * 2 - 1)))
    cues.push({ t: l.t, kind: 'led' })
  })

  const m = music ?? libraryMusic('trace', b)
  const bed = lay(m, n, { turn: P.wake, breath: P.hush, gone: dur - TAIL, fadeOut: Math.min(2.5, Math.max(0.6, dur - TAIL - P.up)), ring: true })
  cues.push({ t: P.hush, kind: 'breath' }, { t: P.wake, kind: 'wake' })
  const foley = new Bus(n)
  foley.mix(build)
  foley.mix(lit)
  rise(fx, cues, P.enter, P.wake, 0.5)
  impact(fx, cues, P.wake, 1)
  tail(fx, cues, P.up, 0.35)
  const mix = against(bed, foley, P.wake, 10)
  design(mix, fx, P.wake, -2)
  airs(mix, cues, AIR_OVER, P.wake)
  mix.silence(P.hush, P.enter - 0.002, 0.04)
  masterOnTurn(mix, P.wake)
  cues.sort((x, y) => x.t - y.t)
  return { left: mix.l, right: mix.r, sampleRate: SR, board: b, music: about(m), cues }
}

/**
 * The blueprint film, one drawing completed under its track. The drawing is
 * a soft, quiet texture of ink on paper well under the music, one sustained
 * span for each run of strokes, so it never reads as scratching; a letter
 * tick for each fact written, a tap where the parts land and on each stop of
 * the camera's route. The track breathes at the turn into the drawing and
 * lands on its end, with paper moved on the table for the turn and the pull;
 * the stamp is the last event. Where the film holds a beat before the chip's
 * signals are drawn out, the beat is silent and the one pen becomes six.
 */
export function plotScore(tl: TraceTimeline, music?: Music): Score {
  const plot = tl.scene.plot
  if (plot === undefined) throw new Error('plotScore needs a plot timeline')
  const dur = tl.durationSeconds
  const n = Math.round(dur * SR)
  const b = boardSound(tl)
  const B = dur / 24
  const cues: Cue[] = []
  const desk = new Bus(n)
  const ev = plot.events
  const stamp = (ev.find((e) => e.kind === 'stamp') ?? ev.find((e) => e.kind === 'title'))?.t0 ?? 19 / 24
  const stampAt = stamp * dur
  const tilt = ev.find((e) => e.kind === 'tilt')
  const ride0 = (tilt?.t0 ?? plot.shots.object[0]) * dur
  const ride1 = (tilt?.t1 ?? plot.shots.object[0]) * dur
  const turn = ride1
  const pull = ev.find((e) => e.kind === 'pull')
  const pullAt = (pull?.t0 ?? plot.shots.sheet[0]) * dur
  const hushed = (t: number): boolean => (t > stampAt - DROP && t < stampAt) || (t > turn - DROP && t < turn)

  const pen = lowpass(sound('pencil'), 3000)
  const spans: Array<{ t0: number; t1: number }> = []
  for (const e of ev.filter((x) => (x.kind === 'stroke' || x.kind === 'ink' || x.kind === 'rule') && x.t1 > x.t0 && x.t1 > 0).sort((x, y) => x.t0 - y.t0)) {
    const t0 = Math.max(0, e.t0) * dur
    const t1 = e.t1 * dur
    const prev = spans[spans.length - 1]
    if (prev !== undefined && t0 <= prev.t1 + 0.2) prev.t1 = Math.max(prev.t1, t1)
    else spans.push({ t0, t1 })
  }
  spans.forEach((m, i) => {
    const end = m.t0 < turn ? Math.min(m.t1, turn - DROP) : Math.min(m.t1, stampAt - DROP)
    const len = end - m.t0
    if (len < 0.25 || hushed(m.t0)) return
    const off = Math.round(hash(i) * Math.max(0, pen.length - len * SR - 1))
    const take = len * SR < pen.length - off ? pen.subarray(off, off + Math.round(len * SR)) : sustain(pen, len, 0)
    desk.add(m.t0, shape(take, (t) => Math.min(1, t / 0.08, (len - t) / 0.12)), 0.4, (hash(i + 7) - 0.5) * 0.2)
    cues.push({ t: m.t0, kind: 'line' })
  })

  const fan = plot.ink === undefined ? undefined : { hold: plot.ink.hold[0] * dur, at: plot.ink.fan.t * dur, len: Math.max(0.3, ((plot.ink.fan.r - plot.ink.fan.r0) / plot.ink.fan.v) * dur) }
  if (fan !== undefined) {
    for (let k = 0; k < 6; k++) {
      const take = resample(pen, 0.8 + 0.12 * k)
      const off = Math.round(hash(k + 40) * Math.max(0, take.length - fan.len * SR - 1))
      desk.add(fan.at + (plot.ink?.fan.round ?? 0) * dur * (k / 5), shape(take.subarray(off, off + Math.round(fan.len * SR)), (t) => Math.min(1, t / 0.02, (fan.len - t) / 0.15)), 0.5, (k / 5 - 0.5) * 1.2)
    }
    cues.push({ t: fan.at, kind: 'fan' })
  }

  const letters = ['letter-1', 'letter-2', 'letter-3']
  const ticks: number[] = []
  for (const e of ev.filter((x) => x.kind === 'letter' || x.kind === 'title')) {
    const chars = (e.text ?? 'TITLE').replace(/\s+/g, '').length
    const count = Math.max(1, Math.min(8, Math.ceil(chars / 4)))
    for (let i = 0; i < count; i++) ticks.push((e.t0 + ((e.t1 - e.t0) * i) / count) * dur)
  }
  ticks.sort((x, y) => x - y)
  let last = -Infinity
  ticks.forEach((t, i) => {
    if (t - last < 1 / 9 || hushed(t)) return
    last = t
    desk.hit(t, resample(sound(letters[i % 3] as string), 1.05 + 0.1 * hash(i)), 0.25, (hash(i + 3) - 0.5) * 0.4)
    cues.push({ t, kind: 'letter' })
  })

  if (tilt !== undefined) {
    const len = Math.max(0.4, ride1 - ride0 + 0.15)
    desk.add(ride0, shape(sound('paper').subarray(0, Math.round(len * SR)), (x) => Math.min(1, x / 0.008, (len - x) / 0.12)), 0.45, -0.1)
    cues.push({ t: ride0, kind: 'paper:tilt' })
  }
  if (pull !== undefined) {
    const rules = ev.filter((e) => e.kind === 'rule')
    const end = Math.min(stampAt - DROP, Math.max(pull.t1 * dur, ...rules.map((e) => e.t1 * dur)))
    const top = pull.t1 * dur - pullAt
    const len = Math.max(0.6, end - pullAt)
    const paper = sound('paper')
    const slide = shape(paper.subarray(0, Math.min(paper.length, Math.round(len * SR))), (t) => (t < top ? smooth(t / Math.max(0.1, top)) : Math.max(0, 1 - (t - top) / Math.max(0.1, Math.min(len, paper.length / SR) - top)) ** 1.5))
    desk.add(pullAt, slide, 0.5, 0.1)
    cues.push({ t: pullAt, kind: 'paper:pull' })
  }
  const stops = new Set(plot.object.route.flatMap((ref) => plot.bodies.filter((bd) => bd.ref === ref).map((bd) => `${Math.round(bd.x)},${Math.round(bd.y)}`)))
  const stands = [...plot.object.wave].map((w) => ({ t: w.t0 * B, x: w.x, stop: stops.has(`${Math.round(w.x)},${Math.round(w.y)}`) })).filter((w) => w.t >= ride1 - 0.05 && w.t < Math.min(pullAt, turn - DROP)).sort((x, y) => x.t - y.t)
  let reached = 0
  let stopped = -Infinity
  const unmatched = !stands.some((w) => w.stop)
  stands.forEach((w) => {
    const pn = Math.max(-0.6, Math.min(0.6, (w.x / tl.width) * 2 - 1))
    if (hushed(w.t)) return
    if ((w.stop && w.t - stopped >= APART) || (unmatched && w.t - stopped >= 2 * B)) {
      stopped = w.t
      desk.hit(w.t, sound(reached % 2 === 0 ? 'tap-1' : 'tap-2'), 0.4, pn)
      cues.push({ t: w.t, kind: 'stop' })
      reached++
    }
  })
  ev.filter((e) => e.kind === 'land' && !hushed(e.t0 * dur)).forEach((e, i) => {
    const t = e.t0 * dur
    desk.hit(t, sound(i % 2 === 0 ? 'tap-1' : 'tap-2'), e.text === 'parts' ? 0.45 : 0.3)
    cues.push({ t, kind: 'land' })
  })

  const m = music ?? libraryMusic('plot', b)
  const swell = (t: number): number => { const i = Math.round((m.drop + t) * SR); return loudness(m.l.subarray(i, i + 0.4 * SR), m.r.subarray(i, i + 0.4 * SR)) }
  const reach = Array.from({ length: 26 }, (_, k) => k / 10)
  const full = Math.max(...reach.map(swell))
  const enter = turn - (reach.find((t) => swell(t) >= full - 1) ?? 0)
  const breath = Math.min(ride1 - ride0 >= 0.2 ? ride0 : ride1 - 0.5, enter - 0.5)
  const bed = lay(m, n, { turn: enter, breath, gone: stampAt - DROP, fadeOut: Math.min(1.5, Math.max(0.4, stampAt - DROP - pullAt)), ring: false })
  cues.push({ t: breath, kind: 'breath' }, { t: turn, kind: 'turn' })
  const mix = against(bed, desk, turn, 8)
  mix.silence(stampAt - DROP + 0.02, n / SR, 0.02)
  if (fan !== undefined) mix.silence(fan.hold + 0.03, fan.at - 0.005, 0.03)

  const seal = new Bus(n)
  const thump = lowpass(resample(sound('stamp'), 0.85 + 0.3 * b.small), 5000)
  const rest = Math.max(0.3, dur - TAIL - stampAt)
  seal.hit(stampAt, shape(thump, (t) => Math.max(0, Math.min(1, (rest - t) / (0.5 * rest)))), 1)
  const a0 = Math.round(turn * SR)
  const peak = loudness(mix.l.subarray(a0, a0 + SR), mix.r.subarray(a0, a0 + SR))
  const s0 = Math.round(stampAt * SR)
  const own = loudness(seal.l.subarray(s0, s0 + SR), seal.r.subarray(s0, s0 + SR))
  const room4 = Math.pow(10, (momentaryPeak(mix, turn, stampAt - 0.3) - 5) / 10) - Math.pow(10, momentaryPeak(mix, stampAt, stampAt + 0.4) / 10)
  const fits = Math.sqrt(Math.max(0.1 * Math.pow(10, (peak - 9) / 10), room4) / Math.pow(10, momentaryPeak(seal, stampAt, stampAt + 0.4) / 10))
  const gain = Math.min(Math.pow(10, (peak - 4 - own) / 20), fits)
  mix.mix(seal, gain)
  ringOut(mix, seal, stampAt, 0.3, 10, 0.03 * gain)
  cues.push({ t: stampAt, kind: 'stamp' })
  masterOnTurn(mix, turn, Math.max(turn + HIT, stampAt), 4)
  cues.sort((x, y) => x.t - y.t)
  return { left: mix.l, right: mix.r, sampleRate: SR, board: b, music: about(m), cues }
}

/** the click that speaks for the film's weight (a route, a dense field, the object) on each flash burst */
const BURST: Record<MontageWeight, [string, string]> = {
  route: ['relay-1', 'click-1'],
  density: ['relay-2', 'click-3'],
  object: ['switch', 'click-2']
}

/**
 * The montage as a trailer: build, stop, release, end. The track's build runs
 * under the opening holds and each flash burst gets one small sharp click. At
 * the stop the music is cut dead; the silence holds until the release, where
 * the track's drop lands on the hit and carries the cuts to the poster, under
 * which it fades and its room rings on. The release's first cut, hidden in a
 * pan, takes an air; each short detail cut takes a small click on its frame;
 * a deep air meets the poster and rings out under it.
 */
export function montageScore(tl: TraceTimeline, events?: HypeCut['events'], music?: Music): Score {
  const mo = tl.scene.montage
  if (mo === undefined) throw new Error('montageScore needs a montage timeline')
  const ev = events ?? hypeCut(tl.scene, mo, tl.width, tl.height).events
  const dur = tl.durationSeconds
  const n = Math.round(dur * SR)
  const b = boardSound(tl)
  const F = (f: number): number => f / tl.fps
  const cues: Cue[] = []
  const kit = new Bus(n)
  const voice = BURST[mo.weight]
  for (const f of ev.filter((e) => e.kind === 'burst' && e.f < STOP).map((e) => e.f)) {
    const t = F(f)
    kit.hit(t, sound(voice[0]), 0.5, 0.2)
    kit.hit(t, highpass(sound(voice[1]), 1500), 0.4, -0.2)
    cues.push({ t, kind: 'burst' })
  }
  const stop = F(STOP)
  const release = F(RELEASE)
  const flashes = ev.filter((e) => e.kind === 'burst' && e.f < STOP).map((e) => e.f)
  const tighten = flashes.findIndex((f, i) => i > 0 && f - (flashes[i - 1] as number) <= 15)
  if (tighten > 0) rise(kit, cues, F(flashes[tighten - 1] as number), stop, 0.6)
  const m = music ?? libraryMusic('montage', b)
  const bed = lay(m, n, { turn: release, breath: stop, gone: dur - TAIL, fadeOut: Math.min(2.5, Math.max(0.6, dur - TAIL - F(POSTER))), ring: true })
  cues.push({ t: stop, kind: 'stop' }, { t: release, kind: 'hit' }, { t: F(POSTER), kind: 'poster' })
  const cuts = ev.filter((x) => x.kind === 'cut' && x.f > RELEASE && x.f < POSTER).map((x) => x.f)
  cuts.forEach((f, i) => {
    cues.push({ t: F(f), kind: 'cut' })
    if (i === 0) air(cues, F(f))
    else if (((cuts[i + 1] ?? POSTER) - f) <= 12) {
      kit.hit(F(f), highpass(sound(voice[1]), 1500), 0.3, i % 2 === 0 ? 0.25 : -0.25)
      cues.push({ t: F(f), kind: 'tick' })
    }
  })
  const fx = new Bus(n)
  impact(fx, cues, release, 1)
  tail(fx, cues, F(POSTER), 0.35)
  const mix = against(bed, kit, release, 9)
  design(mix, fx, release, -2)
  airs(mix, cues, AIR_OVER, release)
  mix.silence(stop, release - 0.002, 0.012)
  masterOnTurn(mix, release)
  cues.sort((x, y) => x.t - y.t)
  return { left: mix.l, right: mix.r, sampleRate: SR, board: b, music: about(m), cues }
}

/** a glyph board's measures, counted from the board file the timeline was compiled from */
function glyphBoard(tl: GlyphTimeline): BoardSound {
  return measured({ ...tl.board, cls: 'mcu', heroPins: 0 })
}

/**
 * The glyph film: data being read. It opens in near silence; each formation
 * writing in is a click and a short run of very quiet ticks, one a decode step
 * (15 a second); a formation's last mark locks on a switch; the track drops
 * on the turn; the name lands on a soft seat;
 * the track rings on under the held field to the film's end.
 */
export function glyphScore(tl: GlyphTimeline, music?: Music): Score {
  const dur = tl.durationSeconds
  const n = Math.round(dur * SR)
  const b = glyphBoard(tl)
  const F = (f: number): number => f / tl.fps
  const at = (kind: GlyphTimeline['events'][number]['kind']): number[] => tl.events.filter((e) => e.kind === kind).map((e) => F(e.at))
  const turn = at('turn')[0] ?? 0
  const end = dur - 1
  const cues: Cue[] = []
  const kit = new Bus(n)
  const fx = new Bus(n)
  const step = 1 / 15
  const lettered = at('letter')
  at('form').forEach((t, k) => {
    kit.hit(t, resample(sound('click-3'), 0.9), 0.5, (hash(k) - 0.5) * 0.4)
    cues.push({ t, kind: 'form' })
    for (let i = 1; i <= (lettered.some((u) => Math.abs(u - t) < 1e-6) ? 0 : 12); i++) {
      const u = t + i * step
      if (u >= end) break
      kit.hit(u, lowpass(resample(sound(`click-${(i % 4) + 1}`), 1 + 0.1 * hash(i + 31 * k)), 5000), 0.12 * (1 - i / 13), (hash(i + 7 * k) - 0.5) * 0.6)
      cues.push({ t: u, kind: 'decode' })
    }
  })
  for (const t of at('lock')) {
    kit.hit(t, resample(sound('switch'), 1.2), 0.3)
    cues.push({ t, kind: 'lock' })
  }
  lettered.forEach((t, k) => {
    kit.hit(t, lowpass(resample(sound(`click-${(k % 4) + 1}`), 1.15 + 0.08 * hash(k + 101)), 6000), 0.24, (hash(k + 53) - 0.5) * 0.7)
    cues.push({ t, kind: 'letter' })
  })
  for (const t of at('name')) {
    kit.hit(t, resample(sound('seat'), 1.1), 0.5)
    cues.push({ t, kind: 'name' })
  }
  const m = music ?? libraryMusic('glyph', b)
  const bed = lay(m, n, { turn, breath: Math.max(0, turn - 0.6), gone: dur - TAIL, fadeOut: Math.min(2.5, Math.max(0.6, dur - TAIL - end)), ring: true })
  cues.push({ t: turn, kind: 'turn' })
  const built = Math.max(...at('form').filter((t) => t < turn - 0.4), 0)
  rise(fx, cues, Math.max(built, turn - 2.5), turn, 0.5)
  impact(fx, cues, turn, 1)
  tail(fx, cues, end, 0.35)
  const mix = against(bed, kit, turn, 10)
  design(mix, fx, turn, -2)
  airs(mix, cues, AIR_OVER, turn)
  masterOnTurn(mix, turn)
  cues.sort((x, y) => x.t - y.t)
  return { left: mix.l, right: mix.r, sampleRate: SR, board: b, music: about(m), cues }
}

/** the score of a film of any style; `music` is a listener's own track, cut by the same rules as the library's */
export function scoreAudio(tl: Timeline, music?: string): Score {
  const own = music === undefined ? undefined : ownMusic(music)
  if (tl.style === 'glyph') return glyphScore(tl, own)
  if (tl.style === 'montage') return montageScore(tl, undefined, own)
  return tl.style === 'plot' ? plotScore(tl, own) : traceScore(tl, own)
}
