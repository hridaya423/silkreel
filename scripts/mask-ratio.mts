// Mask-ratio check for trace films: on every frame from 6.0 s to the end it reads the bare mask (inside the board, off
// every body, more than 14 px at 1080 from any copper, so lit nets and their glow are left out) and the bare floor (more
// than 16 px outside the board and bodies, off the title), as mean display luma and chroma (max - min of RGB), and divides
// each by the same reading at the plan (5.0 s). Rule: mask luma >= 0.45, mask chroma >= 0.60, and mask luma ratio >= the
// floor's luma ratio, on every frame (chroma only where the plan's mask chroma is 10 or more of 255: a white or black
// mask has no hue to keep). Prints the worst frame per film.
// usage: npx tsx scripts/mask-ratio.mts <video.mp4> [<video.mp4> ...]   (files named trace-<board>-<W>x<H>.mp4)
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { compileTimeline, makeCam, project, sampleShot } from '../packages/choreo/src/index.ts'
import type { Aspect, TraceTimeline } from '../packages/choreo/src/index.ts'
import { parseKicadPcb } from '../packages/ingest/src/index.ts'
import { DEMO_TITLES } from '../packages/render-api/src/boards.ts'
import { loadPartBodies } from '../packages/render-api/src/models.ts'
import { parseCliArgs } from '../packages/cli/src/args.ts'

type P = [number, number]
const run = (cmd: string, args: string[]): Promise<Buffer> => new Promise((resolve, reject) => {
  const p = spawn(cmd, args)
  const chunks: Buffer[] = []
  p.stdout.on('data', (c: Buffer) => chunks.push(c))
  p.on('error', reject)
  p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${cmd} exited ${code}`))))
})
const hull = (pts: P[]): P[] => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: P, a: P, b: P): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: P[]): P[] => {
    const out: P[] = []
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2] as P, out[out.length - 1] as P, q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half([...p].reverse())]
}

console.log('| film | worst mask luma (frame) | worst mask chroma (frame) | worst mask − floor luma (frame) | failing frames |')
console.log('|---|---|---|---|---|')
for (const video of process.argv.slice(2)) {
  const m = /trace-(.+)-(\d+)x(\d+)\.mp4$/.exec(basename(video))
  if (m === null) throw new Error(`name ${video} as trace-<board>-<W>x<H>.mp4`)
  const board = m[1] as string
  const aspect = `${m[2]}:${m[3]}` as Aspect
  const file = `fixtures/boards/${board}.kicad_pcb`
  const model = parseKicadPcb(await readFile(file, 'utf8'), `${board}.kicad_pcb`)
  const cli = parseCliArgs([file, '--aspect', aspect, '--title', DEMO_TITLES[board] ?? board, '-o', 'unused.mp4'])
  const bodies = (await loadPartBodies(model, { boardDir: 'fixtures/boards', dirs: cli.models ?? [] })).bodies
  const tl = compileTimeline(model, cli.config, bodies) as TraceTimeline
  const s = tl.scene
  const VW = 360
  const k = VW / tl.width
  const VH = Math.round((tl.height * k) / 2) * 2
  const all = await run('ffmpeg', ['-v', 'error', '-i', video, '-vf', `scale=${VW}:${VH}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  const segs: Array<[number, number, number, number]> = []
  for (const layer of s.layers) for (let i = 0; i + 6 < layer.segs.length; i += 7) segs.push([layer.segs[i] as number, layer.segs[i + 1] as number, layer.segs[i + 2] as number, layer.segs[i + 3] as number])
  const read = (f: number): { luma: number; chroma: number; floor: number } => {
    const p = f / tl.totalFrames
    const cam = makeCam(sampleShot(s.shots, p), tl.width, tl.height)
    const px = (x: number, y: number, z = 0): P => {
      const q = project(cam, x, y, z)
      return [(q.x * 0.5 + 0.5) * VW, (0.5 - q.y * 0.5) * VH]
    }
    const boards = s.board.map((loop) => {
      const out: P[] = []
      for (let i = 0; i + 1 < loop.length; i += 2) out.push(px(loop[i] as number, loop[i + 1] as number))
      return out
    })
    const shapes: P[][] = []
    for (const pt of s.parts) {
      if (pt.kind === 'pin' || pt.t > p) continue
      const c = Math.cos(pt.rot)
      const sn = Math.sin(pt.rot)
      const box: P[] = []
      for (const z of [0, pt.z]) for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) box.push(px(pt.x + ((u * pt.w) / 2) * c - ((v * pt.h) / 2) * sn, pt.y + ((u * pt.w) / 2) * sn + ((v * pt.h) / 2) * c, z))
      shapes.push(hull(box))
    }
    const fill = (poly: P[], into: Uint8Array, or = false): void => {
      if (poly.length < 3) return
      const ys = poly.map((q) => q[1])
      const y0 = Math.max(0, Math.ceil(Math.min(...ys)))
      const y1 = Math.min(VH - 1, Math.floor(Math.max(...ys)))
      for (let y = y0; y <= y1; y++) {
        const xs: number[] = []
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i] as P
          const [xj, yj] = poly[j] as P
          if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi))
        }
        xs.sort((a, b) => a - b)
        for (let n = 0; n + 1 < xs.length; n += 2) {
          for (let x = Math.max(0, Math.ceil(xs[n] as number)); x <= Math.min(VW - 1, Math.floor(xs[n + 1] as number)); x++) into[y * VW + x] = or ? 1 : into[y * VW + x] ^ 1
        }
      }
    }
    const dilate = (src: Uint8Array, r: number): Uint8Array => {
      const a = new Uint8Array(VW * VH)
      const b = new Uint8Array(VW * VH)
      for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
        if (src[y * VW + x] !== 1) continue
        for (let d = Math.max(0, x - r); d <= Math.min(VW - 1, x + r); d++) a[y * VW + d] = 1
      }
      for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
        if (a[y * VW + x] !== 1) continue
        for (let d = Math.max(0, y - r); d <= Math.min(VH - 1, y + r); d++) b[d * VW + x] = 1
      }
      return b
    }
    const onBoardM = new Uint8Array(VW * VH)
    for (const b of boards) fill(b, onBoardM)
    const onBodyM = new Uint8Array(VW * VH)
    for (const b of shapes) fill(b, onBodyM, true)
    const lines = new Uint8Array(VW * VH)
    const dot = (x: number, y: number): void => {
      const ix = Math.round(x)
      const iy = Math.round(y)
      if (ix >= 0 && iy >= 0 && ix < VW && iy < VH) lines[iy * VW + ix] = 1
    }
    for (const [x0, y0, x1, y1] of segs) {
      const a = px(x0, y0)
      const b = px(x1, y1)
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])))
      for (let j = 0; j <= n; j++) dot(a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n)
    }
    for (const pad of s.pads) {
      const q = px(pad.x, pad.y)
      const r = Math.round(Math.max(pad.w, pad.h) * cam.zoom * k * 0.5)
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) dot(q[0] + dx, q[1] + dy)
    }
    const busy = dilate(lines, Math.max(1, Math.round(14 * (VW / 1080))))
    const edgeM = new Uint8Array(VW * VH)
    for (let i = 0; i < edgeM.length; i++) edgeM[i] = onBoardM[i] === 1 || onBodyM[i] === 1 ? 1 : 0
    const near = dilate(edgeM, Math.max(1, Math.round(16 * (VW / 1080))))
    const L = p >= 20 / 24 ? s.lockup?.box : undefined
    const img = all.subarray(f * VW * VH * 3, (f + 1) * VW * VH * 3)
    let ml = 0
    let mc = 0
    let mn = 0
    let fl = 0
    let fn = 0
    for (let y = 0; y < VH; y += 2) {
      for (let x = 0; x < VW; x += 2) {
        const o = y * VW + x
        const i = o * 3
        const r = img[i] as number
        const g = img[i + 1] as number
        const b = img[i + 2] as number
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if (onBoardM[o] === 1 && onBodyM[o] !== 1 && busy[o] !== 1) {
          ml += l
          mc += Math.max(r, g, b) - Math.min(r, g, b)
          mn++
        } else if (near[o] !== 1 && !(L !== undefined && x > L.x0 * k - 8 && x < L.x1 * k + 8 && y > L.y0 * k - 8 && y < L.y1 * k + 8)) {
          fl += l
          fn++
        }
      }
    }
    return { luma: mn < 30 ? NaN : ml / mn, chroma: mn < 30 ? NaN : mc / mn, floor: fn < 30 ? NaN : fl / fn }
  }
  const plan = read(Math.round(5 * 30))
  const rows: Array<{ f: number; luma: number; chroma: number; gap: number }> = []
  for (let f = 180; f < tl.totalFrames && (f + 1) * VW * VH * 3 <= all.length; f++) {
    const r = read(f)
    if (!Number.isFinite(r.luma)) continue
    const luma = r.luma / plan.luma
    const floor = r.floor / plan.floor
    rows.push({ f, luma, chroma: plan.chroma < 10 ? 1 : r.chroma / plan.chroma, gap: Number.isFinite(floor) ? luma - floor : 0 })
  }
  const worst = (key: 'luma' | 'chroma' | 'gap'): string => {
    const w = rows.reduce((a, b) => (b[key] < a[key] ? b : a))
    return `${w[key].toFixed(2)} (f${w.f})`
  }
  const bad = rows.filter((r) => r.luma < 0.45 || r.chroma < 0.6 || r.gap < 0).map((r) => r.f)
  const name = `${board} ${aspect}`
  console.log(`| ${name} | ${worst('luma')} | ${worst('chroma')} | ${worst('gap')} | ${bad.length === 0 ? 'PASS' : `${bad.length}: ${bad.slice(0, 12).join(' ')}${bad.length > 12 ? ' …' : ''}`} |`)
}
