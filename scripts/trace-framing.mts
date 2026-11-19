// Framing check for trace films: on every 5th frame it reads, from the film's own camera, how much of the frame the
// board covers and what is left. subject is the board's on-screen span along the frame's short side as a share of it
// (the board clipped to the frame); floor is the share of the frame that is bare floor (off the board, off every body,
// off the title block once the lockup is up); edge is the share where the floor ends (looking at or above the horizon).
// Rule: subject >= 0.60 and edge = 0 on every frame; floor <= 0.45 on every frame before the crane's landing (the
// second half of the crane and the titled hold are the poster's composition: lit ground behind the type). It prints the worst frame per film and FAIL lines.
// usage: npx tsx scripts/trace-framing.mts [boards,...|all] [aspects,...] [--every N] [--rows]
import { readFile } from 'node:fs/promises'
import { compileTimeline, makeCam, project, sampleShot, TRACE_ACTS } from '../packages/choreo/src/index.ts'
import type { Aspect, TraceTimeline } from '../packages/choreo/src/index.ts'
import { parseKicadPcb } from '../packages/ingest/src/index.ts'
import { DEMO_TITLES } from '../packages/render-api/src/boards.ts'
import { loadPartBodies } from '../packages/render-api/src/models.ts'
import { parseCliArgs } from '../packages/cli/src/args.ts'

type P = [number, number]
const ALL = ['glasgow', 'icebreaker', 'StickHub', 'ecc83-pp', 'video', 'kit-dev-coldfire-xilinx_5213']
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const plain = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--every'))
const boards = plain[0] === undefined || plain[0] === 'all' ? ALL : plain[0].split(',')
const aspects = (plain[1] ?? '4:5,1:1,9:16,16:9').split(',') as Aspect[]
const every = Number(flag('--every') ?? 5)
const rows = argv.includes('--rows')

const inside = (poly: P[], x: number, y: number): boolean => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as P
    const [xj, yj] = poly[j] as P
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
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

interface FrameRead { frame: number; subject: number; floor: number; edge: number; posed: boolean }

function readFraming(tl: TraceTimeline, frame: number): FrameRead {
  const s = tl.scene
  const W = tl.width
  const H = tl.height
  const p = frame / tl.totalFrames
  const cam = makeCam(sampleShot(s.shots, p), W, H)
  const px = (x: number, y: number, z: number): P | undefined => {
    const q = project(cam, x, y, z)
    return q.w <= 0 ? undefined : [(q.x * 0.5 + 0.5) * W, (0.5 - q.y * 0.5) * H]
  }
  const plane: P[][] = s.board.map((loop) => {
    const poly: P[] = []
    for (let i = 0; i + 1 < loop.length; i += 2) poly.push([loop[i] as number, loop[i + 1] as number])
    return poly
  })
  const bodies: P[][] = []
  for (const pt of s.parts) {
    if (pt.kind === 'pin' || pt.t > p) continue
    const c = Math.cos(pt.rot)
    const sn = Math.sin(pt.rot)
    const box: P[] = []
    for (const z of [0, pt.z]) for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const q = px(pt.x + ((u * pt.w) / 2) * c - ((v * pt.h) / 2) * sn, pt.y + ((u * pt.w) / 2) * sn + ((v * pt.h) / 2) * c, z)
      if (q !== undefined) box.push(q)
    }
    if (box.length >= 3) bodies.push(hull(box))
  }
  const box = p >= TRACE_ACTS.hold[0] ? s.lockup?.box : undefined
  const NX = 64
  const NY = Math.round((NX * H) / W)
  let floor = 0
  let edge = 0
  let bx0 = Infinity
  let bx1 = -Infinity
  let by0 = Infinity
  let by1 = -Infinity
  for (let gy = 0; gy < NY; gy++) {
    for (let gx = 0; gx < NX; gx++) {
      const x = ((gx + 0.5) / NX) * W
      const y = ((gy + 0.5) / NY) * H
      const nx = (x / W) * 2 - 1
      const ny = 1 - (y / H) * 2
      const dz = cam.f[2] + cam.r[2] * nx * cam.tanX + cam.u[2] * (ny - cam.shift) * cam.tanY
      const t = dz < -1e-6 ? -cam.pos[2] / dz : -1
      const dx = cam.f[0] + cam.r[0] * nx * cam.tanX + cam.u[0] * (ny - cam.shift) * cam.tanY
      const dy = cam.f[1] + cam.r[1] * nx * cam.tanX + cam.u[1] * (ny - cam.shift) * cam.tanY
      const hit = t > 0 && plane.filter((q) => inside(q, cam.pos[0] + t * dx, -(cam.pos[1] + t * dy))).length % 2 === 1
      const onBoard = hit || bodies.some((b) => inside(b, x, y))
      if (onBoard) {
        bx0 = Math.min(bx0, x)
        bx1 = Math.max(bx1, x)
        by0 = Math.min(by0, y)
        by1 = Math.max(by1, y)
        continue
      }
      if (box !== undefined && x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) continue
      if (dz > -0.02) edge++
      else floor++
    }
  }
  const n = NX * NY
  const short = Math.min(W, H)
  const span = bx1 < bx0 ? 0 : W <= H ? (bx1 - bx0 + W / NX) / short : (by1 - by0 + H / NY) / short
  const poster = s.shots.findIndex((k) => k.light === 'poster')
  const posed = poster > 0 && p >= (s.shots[poster - 1]?.t ?? 1)
  return { frame, subject: Math.min(1, span), floor: floor / n, edge: edge / n, posed }
}

const FRAMING = { subject: 0.6, floor: 0.45 }

const fails = (r: FrameRead): boolean => r.subject < FRAMING.subject || (!r.posed && r.floor > FRAMING.floor) || r.edge > 0

{
  console.log('| film | worst subject (frame) | worst floor (frame) | edge frames | failing frames |')
  console.log('|---|---|---|---|---|')
  for (const board of boards) {
    const file = `fixtures/boards/${board}.kicad_pcb`
    const model = parseKicadPcb(await readFile(file, 'utf8'), `${board}.kicad_pcb`)
    for (const aspect of aspects) {
      const cli = parseCliArgs([file, '--aspect', aspect, '--title', DEMO_TITLES[board] ?? board, '-o', 'unused.mp4'])
      const bodies = (await loadPartBodies(model, { boardDir: 'fixtures/boards', dirs: cli.models ?? [] })).bodies
      const tl = compileTimeline(model, cli.config, bodies) as TraceTimeline
      const reads: FrameRead[] = []
      for (let f = 0; f < tl.totalFrames; f += every) reads.push(readFraming(tl, f))
      const ws = reads.reduce((a, b) => (b.subject < a.subject ? b : a))
      const wf = reads.filter((r) => !r.posed).reduce((a, b) => (b.floor > a.floor ? b : a))
      const edges = reads.filter((r) => r.edge > 0).map((r) => r.frame)
      const bad = reads.filter(fails).map((r) => r.frame)
      console.log(`| ${board} ${aspect} | ${ws.subject.toFixed(2)} (f${ws.frame}) | ${wf.floor.toFixed(2)} (f${wf.frame}) | ${edges.length === 0 ? '–' : edges.join(' ')} | ${bad.length === 0 ? 'PASS' : `${bad.length}: ${bad.join(' ')}`} |`)
      if (rows) for (const r of reads) console.log(`  f${r.frame} subject ${r.subject.toFixed(2)} floor ${r.floor.toFixed(2)} edge ${r.edge.toFixed(2)}${fails(r) ? ' FAIL' : ''}`)
    }
  }
}
