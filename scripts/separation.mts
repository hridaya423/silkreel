// End-frame separation probe: how the board stands off the floor on the last frame of a trace film.
// It projects the board and its bodies with the film's own camera, then reads the decoded last frame's 8-bit luma in
// bands: just inside the silhouette (inner), just outside it (outer), the pool under the board (under) and the
// frame's far corners (far). pool_stops is log2(under / far): how much light the pool lifts around the board.
// At beat 14 (the breath, at power-on) it also reads the mask: the mean luma of board pixels no body covers, against
// the floor beyond the silhouette; breath_ratio is mask / floor.
// Power-on: over beats 13–17 it finds the frame where the hero's lit nets are brightest and reads them against the bare
// mask 6–20 px away from any copper; power_ratio is net / mask there.
// Mask truth: on bare mask (inside the board, off every body, more than 14 px at 1080 from any copper, so lit nets and
// their glow are left out) it reads mean luma and chroma (max − min of RGB) at the plan (5.0 s), the deepest dim (the
// darkest such frame in 6.0–8.5 s) and the end, and the floor (more than 16 px outside the silhouette, off the title) at
// the same frames. mask_dim / mask_plan should stay at 0.45 or more for luma and chroma, and the mask should not dim more
// than the floor: mask_dim_luma ≥ floor_dim_luma (both as ratios to the plan).
// Void: every frame scaled to 390 px wide, cut into 10×10 blocks; void is the share of blocks whose mean luma is under 14,
// reported for the worst frame (void_max, void_frame). The target is 25% or less in every frame.
// usage: npx tsx scripts/separation.mts <board> <aspect> <video.mp4> [title]
import { spawn } from 'node:child_process'
import { compileTimeline, makeCam, project, sampleShot } from '../packages/choreo/src/index.ts'
import type { Aspect, TraceTimeline } from '../packages/choreo/src/index.ts'
import { readFile } from 'node:fs/promises'
import { parseKicadPcb } from '../packages/ingest/src/index.ts'
import { DEMO_TITLES } from '../packages/render-api/src/boards.ts'
import { loadPartBodies } from '../packages/render-api/src/models.ts'
import { parseCliArgs } from '../packages/cli/src/args.ts'

type P = [number, number]

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    const chunks: Buffer[] = []
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${cmd} exited ${code}`))))
  })
}

function hull(pts: P[]): P[] {
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

function signedDistance(poly: P[], x: number, y: number): number {
  let d = Infinity
  let inside = true
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as P
    const b = poly[(i + 1) % poly.length] as P
    const ex = b[0] - a[0]
    const ey = b[1] - a[1]
    if (ex * (y - a[1]) - ey * (x - a[0]) < 0) inside = false
    const t = Math.min(1, Math.max(0, ((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey)))
    d = Math.min(d, Math.hypot(x - a[0] - t * ex, y - a[1] - t * ey))
  }
  return inside ? -d : d
}

const [board = 'glasgow', aspect = '4:5', video, title] = process.argv.slice(2) as [string, Aspect, string | undefined, string | undefined]
if (video === undefined) throw new Error('usage: separation.mts <board> <aspect> <video.mp4> [title]')
const file = `fixtures/boards/${board}.kicad_pcb`
const cli = parseCliArgs([file, '--aspect', aspect, '--title', title ?? DEMO_TITLES[board] ?? board, '-o', 'unused.mp4'])
const model = parseKicadPcb(await readFile(file, 'utf8'), `${board}.kicad_pcb`)
const bodies = (await loadPartBodies(model, { boardDir: 'fixtures/boards', dirs: cli.models ?? [] })).bodies
const tl = compileTimeline(model, cli.config, bodies) as TraceTimeline
const s = tl.scene
const W = tl.width
const H = tl.height
const geometry = (p: number): { shape: P[]; boards: P[][]; bodies: P[][]; pts: P[] } => {
  const cam = makeCam(sampleShot(s.shots, p), W, H)
  const px = (x: number, y: number, z: number): P => {
    const q = project(cam, x, y, z)
    return [(q.x * 0.5 + 0.5) * W, (0.5 - q.y * 0.5) * H]
  }
  const pts: P[] = []
  const boards: P[][] = s.board.map((loop) => {
    const out: P[] = []
    for (let i = 0; i + 1 < loop.length; i += 2) out.push(px(loop[i] as number, loop[i + 1] as number, 0))
    return out
  })
  pts.push(...boards.flat())
  const bodies: P[][] = []
  for (const p of s.parts) {
    if (p.kind === 'pin') continue
    const c = Math.cos(p.rot)
    const sn = Math.sin(p.rot)
    const box: P[] = []
    for (const z of [0, p.z]) for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) box.push(px(p.x + ((u * p.w) / 2) * c - ((v * p.h) / 2) * sn, p.y + ((u * p.w) / 2) * sn + ((v * p.h) / 2) * c, z))
    pts.push(...box)
    bodies.push(hull(box))
  }
  return { shape: hull(pts), boards, bodies, pts }
}
const inside = (poly: P[], x: number, y: number): boolean => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as P
    const [xj, yj] = poly[j] as P
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
const frameAt = (args: string[]): Promise<Buffer> => run('ffmpeg', ['-v', 'error', ...args, '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
const breathFrame = Math.round((14 / 24) * (tl.totalFrames - 1))
const breathRaw = await run('ffmpeg', ['-v', 'error', '-i', video, '-vf', `select=eq(n\\,${breathFrame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
const bg = geometry(breathFrame / (tl.totalFrames - 1))
let maskSum = 0
let maskN = 0
let floorSum = 0
let floorN = 0
for (let y = 0; y < H; y += 2) {
  for (let x = 0; x < W; x += 2) {
    const v = breathRaw[y * W + x] as number
    if (bg.boards.some((b) => inside(b, x, y)) && !bg.bodies.some((b) => inside(b, x, y))) {
      maskSum += v
      maskN++
    } else if (signedDistance(bg.shape, x, y) > (12 * W) / 1080) {
      floorSum += v
      floorN++
    }
  }
}
const front = s.layers.find((l) => l.side === (s.layers.some((q) => q.side === 'F') ? 'F' : l.side))
const heroSegs: Array<[number, number, number, number]> = []
const allSegs: Array<[number, number, number, number]> = []
for (const layer of s.layers) {
  for (let i = 0; i + 6 < layer.segs.length; i += 7) {
    const seg: [number, number, number, number] = [layer.segs[i] as number, layer.segs[i + 1] as number, layer.segs[i + 2] as number, layer.segs[i + 3] as number]
    allSegs.push(seg)
    if (layer === front && s.groups[layer.groups[i / 7] as number]?.hero === true && (layer.energy[(i / 7) * 2] as number) >= 0) heroSegs.push(seg)
  }
}
const f0 = Math.round((13 / 24) * (tl.totalFrames - 1))
const f1 = Math.round((17 / 24) * (tl.totalFrames - 1))
const span = await run('ffmpeg', ['-v', 'error', '-i', video, '-vf', `select=between(n\\,${f0}\\,${f1})`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
let power = { frame: -1, net: 0, mask: 0 }
for (let f = f0; f <= f1; f += 2) {
  const img = span.subarray((f - f0) * W * H, (f - f0 + 1) * W * H)
  if (img.length < W * H) break
  const cam = makeCam(sampleShot(s.shots, f / (tl.totalFrames - 1)), W, H)
  const px = (x: number, y: number): P => {
    const q = project(cam, x, y, 0)
    return [(q.x * 0.5 + 0.5) * W, (0.5 - q.y * 0.5) * H]
  }
  const g = geometry(f / (tl.totalFrames - 1))
  const lit: number[] = []
  for (const [x0, y0, x1, y1] of heroSegs) {
    const a = px(x0, y0)
    const b = px(x1, y1)
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3))
    for (let k = 0; k <= n; k++) {
      const x = Math.round(a[0] + ((b[0] - a[0]) * k) / n)
      const y = Math.round(a[1] + ((b[1] - a[1]) * k) / n)
      if (x < 0 || y < 0 || x >= W || y >= H || g.bodies.some((q) => inside(q, x, y))) continue
      lit.push(img[y * W + x] as number)
    }
  }
  if (lit.length < 20) continue
  lit.sort((p, q) => q - p)
  const net = lit.slice(0, Math.ceil(lit.length / 2)).reduce((p, q) => p + q, 0) / Math.ceil(lit.length / 2)
  if (net <= power.net) continue
  const near = new Uint8Array(W * H)
  const far = new Uint8Array(W * H)
  for (const [x0, y0, x1, y1] of allSegs) {
    const a = px(x0, y0)
    const b = px(x1, y1)
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4))
    for (let k = 0; k <= n; k++) {
      const cx = a[0] + ((b[0] - a[0]) * k) / n
      const cy = a[1] + ((b[1] - a[1]) * k) / n
      for (let dy = -20; dy <= 20; dy += 2) {
        for (let dx = -20; dx <= 20; dx += 2) {
          const x = Math.round(cx + dx)
          const y = Math.round(cy + dy)
          if (x < 0 || y < 0 || x >= W || y >= H) continue
          const d = Math.hypot(dx, dy)
          if (d < 6) near[y * W + x] = 1
          else far[y * W + x] = 1
        }
      }
    }
  }
  let ms = 0
  let mn = 0
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = y * W + x
      if (far[i] !== 1 || near[i] === 1 || !g.boards.some((q) => inside(q, x, y)) || g.bodies.some((q) => inside(q, x, y))) continue
      ms += img[i] as number
      mn++
    }
  }
  if (mn > 50) power = { frame: f, net, mask: ms / mn }
}
const breathMask = maskSum / Math.max(1, maskN)
const breathFloor = floorSum / Math.max(1, floorN)
const { shape, pts } = geometry(1)
const raw = await frameAt(['-sseof', '-0.04'])
const band = (12 * W) / 1080
const pool = 0.06 * W
const clear = 0.12 * W
const corner = 0.1 * Math.min(W, H)
const box = s.lockup?.box
const midY = pts.reduce((a, p) => a + p[1], 0) / pts.length
const sums = { inner: [0, 0], outer: [0, 0], under: [0, 0], far: [0, 0], corner: [0, 0] }
for (let y = 0; y < H; y += 2) {
  for (let x = 0; x < W; x += 2) {
    const v = raw[y * W + x] as number
    const d = signedDistance(shape, x, y)
    const add = (k: keyof typeof sums): void => {
      sums[k][0] = (sums[k][0] as number) + v
      sums[k][1] = (sums[k][1] as number) + 1
    }
    if (d <= 0 && d > -band) add('inner')
    if (d > 0 && d <= band) add('outer')
    if (d > 0 && d <= pool && y > midY) add('under')
    const titled = box !== undefined && x > box.x0 - 20 && x < box.x1 + 20 && y > box.y0 - 20 && y < box.y1 + 20
    if (d > clear && !titled) {
      add('far')
      if ((x < corner || x > W - corner) && (y < corner || y > H - corner)) add('corner')
    }
  }
}
const mean = (k: keyof typeof sums): number => (sums[k][0] as number) / Math.max(1, sums[k][1] as number)
const far = (sums.corner[1] as number) > 25 ? mean('corner') : mean('far')
const r = (x: number): number => Math.round(x * 100) / 100
const rgbAt = (f: number): Promise<Buffer> => run('ffmpeg', ['-v', 'error', '-i', video, '-vf', `select=eq(n\\,${f})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
const truth = async (f: number): Promise<{ luma: number; chroma: number; floor: number }> => {
  const img = await rgbAt(f)
  const g = geometry(f / (tl.totalFrames - 1))
  const cam = makeCam(sampleShot(s.shots, f / (tl.totalFrames - 1)), W, H)
  const px = (x: number, y: number): P => {
    const q = project(cam, x, y, 0)
    return [(q.x * 0.5 + 0.5) * W, (0.5 - q.y * 0.5) * H]
  }
  const busy = new Uint8Array(W * H)
  const rad = Math.round((14 * W) / 1080)
  const stamp = (cx: number, cy: number, r: number): void => {
    for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
      const x = Math.round(cx + dx)
      const y = Math.round(cy + dy)
      if (x >= 0 && y >= 0 && x < W && y < H) busy[y * W + x] = 1
    }
  }
  for (const [x0, y0, x1, y1] of allSegs) {
    const a = px(x0, y0)
    const b = px(x1, y1)
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4))
    for (let k = 0; k <= n; k++) stamp(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, rad)
  }
  for (const pad of s.pads) {
    const q = px(pad.x, pad.y)
    stamp(q[0], q[1], rad + Math.round(Math.max(pad.w, pad.h) * cam.zoom))
  }
  const L = s.lockup?.box
  let ml = 0
  let mc = 0
  let mn = 0
  let fl = 0
  let fn = 0
  for (let y = 1; y < H; y += 3) {
    for (let x = 1; x < W; x += 3) {
      const i = (y * W + x) * 3
      const r = img[i] as number
      const gg = img[i + 1] as number
      const b = img[i + 2] as number
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b
      if (g.boards.some((q) => inside(q, x, y)) && !g.bodies.some((q) => inside(q, x, y)) && busy[y * W + x] !== 1) {
        ml += l
        mc += Math.max(r, gg, b) - Math.min(r, gg, b)
        mn++
      } else if (signedDistance(g.shape, x, y) > (16 * W) / 1080 && !(L !== undefined && x > L.x0 - 30 && x < L.x1 + 30 && y > L.y0 - 30 && y < L.y1 + 30)) {
        fl += l
        fn++
      }
    }
  }
  return { luma: ml / Math.max(1, mn), chroma: mc / Math.max(1, mn), floor: fn < 200 ? NaN : fl / fn }
}
const plan = await truth(Math.round((5 / 12) * (tl.totalFrames - 1)))
let dim = { luma: Infinity, chroma: 0, floor: NaN, frame: -1 }
for (let f = Math.round((6 / 12) * (tl.totalFrames - 1)); f <= Math.round((8.5 / 12) * (tl.totalFrames - 1)); f += 6) {
  const t = await truth(f)
  if (t.luma < dim.luma) dim = { ...t, frame: f }
}
const end = await truth(tl.totalFrames - 1)
const VW = 390
const VH = Math.round((H * VW) / W / 2) * 2
const all = await run('ffmpeg', ['-v', 'error', '-i', video, '-vf', `scale=${VW}:${VH},format=gray`, '-f', 'rawvideo', '-'])
const bx = Math.floor(VW / 10)
const by = Math.floor(VH / 10)
let voidMax = 0
let voidFrame = 0
for (let f = 0; (f + 1) * VW * VH <= all.length; f++) {
  const o = f * VW * VH
  let dark = 0
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      let sum = 0
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) sum += all[o + (j * 10 + y) * VW + i * 10 + x] as number
      if (sum < 14 * 100) dark++
    }
  }
  const share = dark / (bx * by)
  if (share > voidMax) {
    voidMax = share
    voidFrame = f
  }
}
console.log(JSON.stringify({ board, aspect, inner: r(mean('inner')), outer: r(mean('outer')), contrast: r(Math.abs(mean('inner') - mean('outer'))), under: r(mean('under')), far: r(far), pool_stops: r(Math.log2(Math.max(mean('under'), 1e-3) / Math.max(far, 1e-3))), breath_mask: r(breathMask), breath_floor: maskN === 0 ? null : r(breathFloor), breath_ratio: floorN === 0 ? null : r(breathMask / Math.max(1e-3, breathFloor)), power_frame: power.frame, power_net: r(power.net), power_mask: r(power.mask), power_ratio: r(power.net / Math.max(1e-3, power.mask)), void_max: r(voidMax), void_frame: voidFrame, mask_plan: [r(plan.luma), r(plan.chroma)], mask_dim: [r(dim.luma), r(dim.chroma)], dim_frame: dim.frame, mask_end: [r(end.luma), r(end.chroma)], dim_luma: r(dim.luma / plan.luma), dim_chroma: r(dim.chroma / Math.max(1e-3, plan.chroma)), end_luma: r(end.luma / plan.luma), end_chroma: r(end.chroma / Math.max(1e-3, plan.chroma)), floor_dim: r(dim.floor / plan.floor), floor_end: r(end.floor / plan.floor) }))
