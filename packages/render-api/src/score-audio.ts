import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { TraceTimeline } from '@silk-reel/choreo'

/**
 * The sound of a trace film, mixed from real CC0 recordings (assets/sound,
 * sources in its CREDITS.md) placed on the events the picture already plays:
 * the music under the build, parts clicking down, the hero chip seating, the
 * reflow sizzle and every part snapping, a held breath, then the switch and
 * the music's drop at power-on. Code only places, levels, pans and
 * re-pitches by resampling. Deterministic: the same timeline makes the same
 * waveform.
 */
const SR = 48000
const SOUND = path.resolve(import.meta.dirname, '../assets/sound')
/** the music edit is cut to 24 beats at 120 BPM: twelve seconds */
const MUSIC_SECONDS = 12

/** a 16-bit PCM WAV at 48 kHz, as float channels */
function readWav(file: string): Float32Array[] {
  const buf = readFileSync(path.join(SOUND, file))
  let at = 12
  let channels = 1
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    if (id === 'fmt ') channels = buf.readUInt16LE(at + 10)
    if (id === 'data') {
      const frames = Math.floor(size / (2 * channels))
      const out = Array.from({ length: channels }, () => new Float32Array(frames))
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) (out[c] as Float32Array)[i] = buf.readInt16LE(at + 8 + (i * channels + c) * 2) / 32768
      }
      return out
    }
    at += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${file}`)
}

const cache = new Map<string, Float32Array[]>()
const sound = (file: string): Float32Array[] => {
  let s = cache.get(file)
  if (s === undefined) {
    s = readWav(file)
    cache.set(file, s)
  }
  return s
}

/** play x at rate r: above 1 it runs faster and higher */
function resample(x: Float32Array, r: number): Float32Array {
  if (Math.abs(r - 1) < 1e-6) return x
  const out = new Float32Array(Math.floor(x.length / r))
  for (let i = 0; i < out.length; i++) {
    const f = i * r
    const j = Math.floor(f)
    const a = x[j] ?? 0
    out[i] = a + ((x[j + 1] ?? a) - a) * (f - j)
  }
  return out
}

class Bus {
  readonly l: Float32Array
  readonly r: Float32Array
  constructor(readonly n: number) {
    this.l = new Float32Array(n)
    this.r = new Float32Array(n)
  }
  /** add a mono voice starting at t seconds, panned −1..1 */
  add(t: number, voice: Float32Array, gain: number, pan = 0): void {
    const s0 = Math.round(t * SR)
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4)
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4)
    for (let i = 0; i < voice.length; i++) {
      const j = s0 + i
      if (j < 0 || j >= this.n) continue
      this.l[j] = (this.l[j] as number) + (voice[i] as number) * gl
      this.r[j] = (this.r[j] as number) + (voice[i] as number) * gr
    }
  }
}

/**
 * BS.1770 integrated loudness at 48 kHz: K-weighting, 400 ms blocks with
 * 75% overlap, absolute and relative gates. Returns LUFS.
 */
export function loudness(l: Float32Array, r: Float32Array): number {
  const kw = (x: Float32Array): Float32Array => {
    const y = new Float32Array(x.length)
    const stages = [
      [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
      [1, -2, 1, -1.99004745483398, 0.99007225036621]
    ]
    let src = x
    for (const [b0, b1, b2, a1, a2] of stages as Array<[number, number, number, number, number]>) {
      let x1 = 0
      let x2 = 0
      let y1 = 0
      let y2 = 0
      for (let i = 0; i < src.length; i++) {
        const v = src[i] as number
        const out = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1
        x1 = v
        y2 = y1
        y1 = out
        y[i] = out
      }
      src = y.slice()
    }
    return src
  }
  const kl = kw(l)
  const kr = kw(r)
  const block = Math.round(0.4 * SR)
  const hop = Math.round(0.1 * SR)
  const z: number[] = []
  for (let s = 0; s + block <= kl.length; s += hop) {
    let e = 0
    for (let i = s; i < s + block; i++) e += (kl[i] as number) ** 2 + (kr[i] as number) ** 2
    z.push(e / block)
  }
  const lufs = (e: number): number => -0.691 + 10 * Math.log10(Math.max(1e-12, e))
  const abs = z.filter((e) => lufs(e) > -70)
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const rel = lufs(mean(abs)) - 10
  return lufs(mean(abs.filter((e) => lufs(e) > rel)))
}

/** loudness to the web delivery target (−14 LUFS), then a soft ceiling under −1 dBTP */
function master(bus: Bus): void {
  for (let pass = 0; pass < 6; pass++) {
    const g = Math.pow(10, (-14 - loudness(bus.l, bus.r)) / 20)
    for (let i = 0; i < bus.n; i++) {
      bus.l[i] = Math.tanh((bus.l[i] as number) * g / 0.85) * 0.85
      bus.r[i] = Math.tanh((bus.r[i] as number) * g / 0.85) * 0.85
    }
  }
}

export function traceScore(tl: TraceTimeline): { left: Float32Array; right: Float32Array; sampleRate: number } {
  const dur = tl.durationSeconds
  const n = Math.round(dur * SR)
  const bus = new Bus(n)
  const s = tl.scene
  const a = s.acts
  const T = (p: number): number => p * dur
  const panOf = (x: number): number => Math.max(-0.7, Math.min(0.7, (x / tl.width) * 2 - 1))
  const clicks = ['click-1.wav', 'click-2.wav', 'click-3.wav', 'click-4.wav']

  // the music, re-pitched so its bars stay on the film's beat grid; it sits back
  // under the build, holds its breath before power-on, and drops on it
  const rate = MUSIC_SECONDS / dur
  const [ml, mr] = sound('music.wav').map((ch) => resample(ch, rate)) as [Float32Array, Float32Array]
  const smooth = (x: number): number => {
    const t = Math.min(1, Math.max(0, x))
    return t * t * (3 - 2 * t)
  }
  const level = (p: number): number => {
    if (p >= a.power[0]) return (1 - 0.3 * smooth((p - a.hold[0]) / (a.hold[1] - a.hold[0]))) * (1 - 0.85 * smooth((p - 23.4 / 24) / (0.6 / 24)))
    const breath = smooth((p - a.reflow[1]) / (a.power[0] - a.reflow[1] - 0.01))
    return 0.7 - 0.62 * breath
  }
  for (let i = 0; i < Math.min(n, ml.length); i++) {
    const g = level(i / n)
    bus.l[i] = (bus.l[i] as number) + (ml[i] as number) * g
    bus.r[i] = (bus.r[i] as number) + (mr[i] as number) * g
  }

  // object: parts click down as they are set, the hero seats with weight
  // a header's pins land with its housing: one part, one sound
  const bodies = s.parts.filter((p) => p.kind !== 'pin')
  const parts = [...bodies].sort((x, y) => x.t - y.t)
  let last = -Infinity
  parts.forEach((p, i) => {
    const at = T(p.t)
    if (p.hero === true) {
      bus.add(at, sound('seat.wav')[0] as Float32Array, 0.55, panOf(p.x))
      return
    }
    // a run of tiny parts stays a texture, not a machine gun: at most twelve a second
    if (at - last < 1 / 12) return
    last = at
    const small = Math.min(1, Math.max(0, 1 - p.z / 30))
    bus.add(at, resample(sound(clicks[i % 4] as string)[0] as Float32Array, 0.9 + 0.3 * small), 0.32, panOf(p.x))
  })
  // reflow: the oven's sizzle, and every part snapping square on its melting paste
  const [rf0, rf1] = a.reflow
  const sizzle = (sound('sizzle.wav')[0] as Float32Array).subarray(0, Math.round(T(rf1 - rf0 + 0.01) * SR))
  const fade = Math.round(0.25 * SR)
  const sz = Float32Array.from(sizzle, (v, i) => v * Math.min(1, i / fade, (sizzle.length - i) / fade))
  bus.add(T(rf0) - 0.1, sz, 0.22)
  last = -Infinity
  for (const p of [...bodies].sort((x, y) => x.settle - y.settle)) {
    const at = T(p.settle)
    if (at - last < 1 / 16) continue
    last = at
    bus.add(at, resample(sound(clicks[Math.round(p.x) % 4] as string)[0] as Float32Array, 1.35), 0.12, panOf(p.x))
  }

  // alive: the switch, on the frame the board powers
  bus.add(T(a.power[0]) - 0.01, sound('switch.wav')[0] as Float32Array, 0.6)

  master(bus)
  return { left: bus.l, right: bus.r, sampleRate: SR }
}

/** 16-bit stereo PCM WAV */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Buffer {
  const n = left.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 4, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i] as number)) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i] as number)) * 32767), 46 + i * 4)
  }
  return buf
}
