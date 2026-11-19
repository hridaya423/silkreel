import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The mixing desk the scores share: CC0 recordings and music from
 * assets/sound (sources in its CREDITS.md) read once, re-pitched by
 * resampling, placed on a stereo bus, sent to a room, and mastered. Code
 * never generates a sound.
 */
export const SR = 48000
export const SOUND = path.resolve(import.meta.dirname, '../assets/sound')

function readWav(file: string): Float32Array {
  const buf = readFileSync(path.join(SOUND, file))
  let at = 12
  let channels = 1
  let rate = SR
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(at + 10)
      rate = buf.readUInt32LE(at + 12)
    }
    if (id === 'data') {
      const frames = Math.floor(size / (2 * channels))
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let v = 0
        for (let c = 0; c < channels; c++) v += buf.readInt16LE(at + 8 + (i * channels + c) * 2)
        out[i] = v / channels / 32768
      }
      return resample(out, rate / SR)
    }
    at += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${file}`)
}

const cache = new Map<string, Float32Array>()
export const sound = (name: string): Float32Array => {
  let s = cache.get(name)
  if (s === undefined) {
    s = readWav(`${name}.wav`)
    cache.set(name, s)
  }
  return s
}

/** any file ffmpeg reads as stereo at SR: `seconds` of it from `from`, played `tempo` times as fast at the same pitch */
export function decode(file: string, { from = 0, seconds, tempo = 1 }: { from?: number; seconds?: number; tempo?: number } = {}): { l: Float32Array; r: Float32Array } {
  const args = ['-v', 'error', '-ss', String(from), ...(seconds === undefined ? [] : ['-t', String(seconds)]), '-i', file, ...(tempo === 1 ? [] : ['-af', `atempo=${tempo}`]), '-ac', '2', '-ar', String(SR), '-f', 'f32le', 'pipe:1']
  const out = spawnSync('ffmpeg', args, { maxBuffer: 1 << 30 })
  if (out.status !== 0) throw new Error(`cannot read ${file}: ${out.stderr.toString().trim() || 'ffmpeg failed'}`)
  const all = new Float32Array(out.stdout.buffer, out.stdout.byteOffset, out.stdout.byteLength / 4)
  const n = all.length >> 1
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    l[i] = all[2 * i] as number
    r[i] = all[2 * i + 1] as number
  }
  return { l, r }
}

/** play x at rate r: above 1 it runs faster and higher (4-point cubic interpolation, so the top end survives) */
export function resample(x: Float32Array, r: number): Float32Array {
  if (Math.abs(r - 1) < 1e-6) return x
  const out = new Float32Array(Math.floor(x.length / r))
  for (let i = 0; i < out.length; i++) {
    const f = i * r
    const j = Math.floor(f)
    const u = f - j
    const p0 = x[j - 1] ?? 0
    const p1 = x[j] ?? 0
    const p2 = x[j + 1] ?? 0
    const p3 = x[j + 2] ?? 0
    out[i] = p1 + 0.5 * u * (p2 - p0 + u * (2 * p0 - 5 * p1 + 4 * p2 - p3 + u * (3 * (p1 - p2) + p3 - p0)))
  }
  return out
}

/** the sample index where the attack reaches a third of the peak */
export function attackOf(x: Float32Array): number {
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i] as number) >= peak / 3) return i
  return 0
}

/** a held note of any length from a sustained recording: its body repeated with equal-power crossfades */
export function sustain(x: Float32Array, seconds: number, from = 0.25): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const x0 = Math.round(from * SR)
  const body = x.length - x0
  const fade = Math.min(Math.round(0.6 * SR), Math.floor(body / 2))
  const stride = body - fade
  let at = 0
  let k = 0
  while (at < n) {
    const head = k === 0 ? 0 : x0
    const len = k === 0 ? x.length : body
    for (let i = 0; i < len && at + i < n; i++) {
      const v = x[head + i] as number
      let g = 1
      if (k > 0 && i < fade) g = Math.sin(((i / fade) * Math.PI) / 2)
      if (i >= len - fade) g *= Math.cos((((i - (len - fade)) / fade) * Math.PI) / 2)
      out[at + i] = (out[at + i] as number) + v * g
    }
    at += k === 0 ? x.length - fade : stride
    k++
  }
  return out
}

/** one-pole lowpass at fc Hz, run twice (12 dB/oct) */
export function lowpass(x: Float32Array, fc: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR)
  const y = new Float32Array(x.length)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < x.length; i++) {
    s1 += a * ((x[i] as number) - s1)
    s2 += a * (s1 - s2)
    y[i] = s2
  }
  return y
}

/** one-pole highpass at fc Hz */
export function highpass(x: Float32Array, fc: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR)
  const y = new Float32Array(x.length)
  let s = 0
  for (let i = 0; i < x.length; i++) {
    s += a * ((x[i] as number) - s)
    y[i] = (x[i] as number) - s
  }
  return y
}

/** multiply a voice by an envelope given in seconds from its start */
export function shape(x: Float32Array, env: (t: number) => number): Float32Array {
  return Float32Array.from(x, (v, i) => v * env(i / SR))
}

export class Bus {
  readonly l: Float32Array
  readonly r: Float32Array
  /** origin: seconds of lead-in before t = 0, so a loop's sounds can start before its first frame */
  constructor(readonly n: number, readonly origin = 0) {
    this.l = new Float32Array(n)
    this.r = new Float32Array(n)
  }

  /** add a mono voice starting at t seconds, panned −1..1 */
  add(t: number, voice: Float32Array, gain: number, pan = 0): void {
    const s0 = Math.round((t + this.origin) * SR)
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4)
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4)
    const i0 = Math.max(0, -s0)
    const i1 = Math.min(voice.length, this.n - s0)
    for (let i = i0; i < i1; i++) {
      const v = voice[i] as number
      this.l[s0 + i] = (this.l[s0 + i] as number) + v * gl
      this.r[s0 + i] = (this.r[s0 + i] as number) + v * gr
    }
  }

  /** add a voice so its attack lands on t */
  hit(t: number, voice: Float32Array, gain: number, pan = 0): void {
    this.add(t - attackOf(voice) / SR, voice, gain, pan)
  }

  mix(other: Bus, gain = 1): void {
    for (let i = 0; i < this.n; i++) {
      this.l[i] = (this.l[i] as number) + (other.l[i] as number) * gain
      this.r[i] = (this.r[i] as number) + (other.r[i] as number) * gain
    }
  }

  /** zero everything in [t0, t1) seconds, with short ramps so the cut never clicks */
  silence(t0: number, t1: number, ramp = 0.03): void {
    const a = Math.round(t0 * SR)
    const b = Math.round(t1 * SR)
    const rr = Math.round(ramp * SR)
    for (let i = Math.max(0, a - rr); i < Math.min(this.n, b + rr); i++) {
      const g = i < a ? (a - i) / rr : i >= b ? (i - b) / rr : 0
      this.l[i] = (this.l[i] as number) * g
      this.r[i] = (this.r[i] as number) * g
    }
  }
}

/**
 * Freeverb: eight damped combs and four allpasses per side, its tank scaled
 * by size. Returns the wet signal of a send bus, its two sides drawn toward
 * the middle by width (1: as wide as the two tanks are apart).
 */
export function room(send: Bus, size: number, decay: number, damp: number, width = 1): Bus {
  const out = new Bus(send.n)
  const k = (SR / 44100) * size
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
  const passes = [556, 441, 341, 225]
  for (const [side, src, dst, spread] of [[0, send.l, out.l, 0], [1, send.r, out.r, 23]] as Array<[number, Float32Array, Float32Array, number]>) {
    void side
    const acc = new Float32Array(send.n)
    for (const c of combs) {
      const len = Math.max(8, Math.round((c + spread) * k))
      const fb = Math.pow(10, (-3 * len) / (decay * SR))
      const buf = new Float32Array(len)
      let p = 0
      let low = 0
      for (let i = 0; i < send.n; i++) {
        const y = buf[p] as number
        low = y * (1 - damp) + low * damp
        buf[p] = (src[i] as number) + low * fb
        acc[i] = (acc[i] as number) + y
        p = p + 1 === len ? 0 : p + 1
      }
    }
    for (const a of passes) {
      const len = Math.max(4, Math.round((a + spread) * k))
      const buf = new Float32Array(len)
      let p = 0
      for (let i = 0; i < send.n; i++) {
        const b = buf[p] as number
        const x = acc[i] as number
        buf[p] = x + b * 0.5
        acc[i] = b - x
        p = p + 1 === len ? 0 : p + 1
      }
    }
    for (let i = 0; i < send.n; i++) dst[i] = (acc[i] as number) * 0.06
  }
  if (width < 1) {
    for (let i = 0; i < send.n; i++) {
      const m = ((out.l[i] as number) + (out.r[i] as number)) / 2
      const d = (((out.l[i] as number) - (out.r[i] as number)) / 2) * width
      out.l[i] = m + d
      out.r[i] = m - d
    }
  }
  return out
}

/**
 * BS.1770 integrated loudness at 48 kHz: K-weighting, 400 ms blocks with
 * 75% overlap, absolute and relative gates. Returns LUFS.
 */
export function loudness(l: Float32Array, r: Float32Array): number {
  const kw = (x: Float32Array): Float32Array => {
    let src = x
    for (const [b0, b1, b2, a1, a2] of [
      [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
      [1, -2, 1, -1.99004745483398, 0.99007225036621]
    ] as Array<[number, number, number, number, number]>) {
      const y = new Float32Array(src.length)
      let x1 = 0
      let x2 = 0
      let y1 = 0
      let y2 = 0
      for (let i = 0; i < src.length; i++) {
        const v = src[i] as number
        const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1
        x1 = v
        y2 = y1
        y1 = o
        y[i] = o
      }
      src = y
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

/** the four-times-oversampled peak (BS.1770 true peak): a 32-tap Hann-windowed sinc between samples, evaluated only where a sample is within 6 dB of the largest one */
export function truePeak(l: Float32Array, r: Float32Array): number {
  const half = 16
  const taps = [0.25, 0.5, 0.75].map((f) => Array.from({ length: 2 * half }, (_, k) => {
    const x = k - half + 1 - f
    const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (half + 0.5))
    return Math.abs(x) < 1e-9 ? 1 : (w * Math.sin(Math.PI * x)) / (Math.PI * x)
  }))
  let top = 0
  for (const x of [l, r]) for (const v of x) top = Math.max(top, Math.abs(v))
  let peak = top
  for (const x of [l, r]) {
    for (let i = half; i + half < x.length; i++) {
      if (Math.max(Math.abs(x[i] as number), Math.abs(x[i + 1] as number)) < top / 2) continue
      for (const h of taps) {
        let v = 0
        for (let k = 0; k < 2 * half; k++) v += (x[i - half + 1 + k] as number) * (h[k] as number)
        peak = Math.max(peak, Math.abs(v))
      }
    }
  }
  return peak
}

/** a 2 ms look-ahead peak limiter: gain falls before any sample would pass ceiling, and recovers over 80 ms */
function limit(bus: Bus, ceiling: number): void {
  const look = Math.round(0.002 * SR)
  const rel = Math.exp(-1 / (0.08 * SR))
  const need = new Float32Array(bus.n)
  for (let i = 0; i < bus.n; i++) {
    const p = Math.max(Math.abs(bus.l[i] as number), Math.abs(bus.r[i] as number))
    need[i] = p > ceiling ? ceiling / p : 1
  }
  const hold = new Float32Array(bus.n)
  const q = new Int32Array(bus.n)
  let head = 0
  let tail = 0
  for (let j = bus.n - 1; j >= 0; j--) {
    while (tail > head && (need[q[tail - 1] as number] as number) >= (need[j] as number)) tail--
    q[tail++] = j
    while ((q[head] as number) > j + look) head++
    hold[j] = need[q[head] as number] as number
  }
  let g = 1
  for (let i = 0; i < bus.n; i++) {
    const h = hold[i] as number
    g = h < g ? h : h - (h - g) * rel
    bus.l[i] = (bus.l[i] as number) * g
    bus.r[i] = (bus.r[i] as number) * g
  }
}

/** to −14 LUFS integrated with true peak under −1.5 dBTP, faded in and out over a few ms so neither end clicks; a loop keeps its ends, which already meet */
export function master(bus: Bus, loop = false): void {
  const side = Float32Array.from(bus.l, (v, i) => (v - (bus.r[i] as number)) / 2)
  const sub = lowpass(lowpass(side, 120), 120)
  for (let i = 0; i < bus.n; i++) {
    if (bus.l[i] === 0 && bus.r[i] === 0) continue
    bus.l[i] = (bus.l[i] as number) - (sub[i] as number)
    bus.r[i] = (bus.r[i] as number) + (sub[i] as number)
  }
  if (!loop) edges(bus)
  const ceiling = Math.pow(10, -2 / 20)
  let sampleCeiling = ceiling * Math.pow(10, -0.5 / 20)
  for (let pass = 0; pass < 30; pass++) {
    const err = -14 - loudness(bus.l, bus.r)
    if (pass > 0 && Math.abs(err) < 0.05) break
    const g = Math.pow(10, err / 20)
    for (let i = 0; i < bus.n; i++) {
      bus.l[i] = (bus.l[i] as number) * g
      bus.r[i] = (bus.r[i] as number) * g
    }
    limit(bus, sampleCeiling)
    let tp = truePeak(bus.l, bus.r)
    for (let tries = 0; tp > ceiling && tries < 4; tries++) {
      sampleCeiling *= ceiling / tp
      limit(bus, sampleCeiling)
      tp = truePeak(bus.l, bus.r)
    }
    if (tp > ceiling) {
      const k = ceiling / tp
      for (let i = 0; i < bus.n; i++) {
        bus.l[i] = (bus.l[i] as number) * k
        bus.r[i] = (bus.r[i] as number) * k
      }
    }
  }
  if (!loop) edges(bus)
}

/** a film's first 20 ms ease in, so no sound starts inside the encoder's first frame at full level, and its last 150 ms ease out as a safety under a tail that has already rung away */
function edges(bus: Bus): void {
  const fin = Math.round(0.02 * SR)
  const fout = Math.round(0.15 * SR)
  for (let i = 0; i < fin; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fin)
    bus.l[i] = (bus.l[i] as number) * g
    bus.r[i] = (bus.r[i] as number) * g
  }
  for (let i = 0; i < fout; i++) {
    const j = bus.n - 1 - i
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fout)
    bus.l[j] = (bus.l[j] as number) * g
    bus.r[j] = (bus.r[j] as number) * g
  }
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
