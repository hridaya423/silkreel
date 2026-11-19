import { centreOn, fitZoom, makeCam, project } from '@silk-reel/choreo'
import type { CameraShot, TraceTimeline } from '@silk-reel/choreo'

export interface Box { x: number; y: number; w: number; h: number }

type Pt = [number, number, number]

const outline = (tl: TraceTimeline): Pt[] => tl.scene.board.flatMap((loop) => Array.from({ length: loop.length / 2 }, (_, i): Pt => [loop[i * 2] ?? 0, loop[i * 2 + 1] ?? 0, 0]))

/** one held camera for both hero faces: the board centred and fitted, lying the way that fills the frame */
export function heroShot(tl: TraceTimeline): CameraShot {
  const last = tl.scene.shots.at(-1)
  const pts = outline(tl)
  const { width: W, height: H } = tl
  const my = H > W ? 0.6 : 0.85
  const fit = (yaw: number): CameraShot => {
    let shot: CameraShot = { t: 0, x: last?.x ?? 0, y: last?.y ?? 0, zoom: 0.9, tilt: 0.91, yaw, aperture: 0.04, fov: last?.fov, light: 'poster' }
    shot = { ...shot, ...centreOn(shot, pts, W, H) }
    shot.zoom = fitZoom(shot, pts, W, H, 0.88, my)
    return { ...shot, ...centreOn(shot, pts, W, H) }
  }
  const a = fit(-0.13)
  const b = fit(-0.13 + Math.PI / 2)
  return a.zoom >= b.zoom ? a : b
}

/** the board's routes, pads and silk drawn flat-colour through the film's camera, and where the board sits in that frame */
export function drawSource(tl: TraceTimeline, shot: CameraShot): { face: HTMLCanvasElement; bounds: Box } {
  const { width: W, height: H } = tl
  const face = document.createElement('canvas')
  face.width = W
  face.height = H
  const ctx = face.getContext('2d')
  const cam = makeCam(shot, W, H)
  const at = (x: number, y: number): [number, number] => {
    const q = project(cam, x, y)
    return [(q.x * 0.5 + 0.5) * W, (0.5 - q.y * 0.5) * H]
  }
  const pts = outline(tl).map(([x, y]) => at(x, y))
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const bounds = { x: x0 / W, y: y0 / H, w: (Math.max(...xs) - x0) / W, h: (Math.max(...ys) - y0) / H }
  if (!ctx) return { face, bounds }
  const s = tl.scene
  const unit = (x: number, y: number) => { const [ax, ay] = at(x, y); const [bx, by] = at(x + 1, y); return Math.hypot(bx - ax, by - ay) }
  const trace = (path: number[]) => {
    for (let i = 0; i + 1 < path.length; i += 2) {
      const [x, y] = at(path[i] ?? 0, path[i + 1] ?? 0)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
  }
  ctx.beginPath()
  for (const loop of s.board) { trace(loop); ctx.closePath() }
  ctx.fillStyle = '#06121d'
  ctx.fill('evenodd')
  ctx.save()
  ctx.clip('evenodd')
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const layer of s.layers) {
    ctx.strokeStyle = layer.side === 'F' ? '#e9443b' : 'rgba(233, 68, 59, 0.22)'
    for (let i = 0; i + 6 < layer.segs.length; i += 7) {
      const ax = layer.segs[i] ?? 0
      const ay = layer.segs[i + 1] ?? 0
      ctx.lineWidth = Math.max(1, (layer.segs[i + 4] ?? 1) * unit(ax, ay))
      ctx.beginPath()
      ctx.moveTo(...at(ax, ay))
      ctx.lineTo(...at(layer.segs[i + 2] ?? 0, layer.segs[i + 3] ?? 0))
      ctx.stroke()
    }
  }
  ctx.strokeStyle = 'rgba(222, 217, 185, 0.7)'
  ctx.lineWidth = Math.max(1, W / 1400)
  for (const stroke of s.silkStrokes) {
    ctx.beginPath()
    trace(stroke.path)
    ctx.stroke()
  }
  ctx.fillStyle = '#ded9b9'
  ctx.strokeStyle = '#ded9b9'
  for (const pad of s.pads) {
    if (pad.side === 'B') continue
    const c = Math.cos(pad.rot)
    const sn = Math.sin(pad.rot)
    const round = pad.shape === 'circle' || pad.ring === true
    const n = round ? 14 : 4
    ctx.beginPath()
    for (let k = 0; k < n; k++) {
      const a = round ? (k / n) * Math.PI * 2 : 0
      const lx = round ? Math.cos(a) * pad.w / 2 : (k === 0 || k === 3 ? -1 : 1) * pad.w / 2
      const ly = round ? Math.sin(a) * pad.h / 2 : (k < 2 ? -1 : 1) * pad.h / 2
      const [x, y] = at(pad.x + lx * c - ly * sn, pad.y + lx * sn + ly * c)
      if (k === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    if (pad.ring === true) { ctx.lineWidth = Math.max(1, W / 900); ctx.stroke() }
    else ctx.fill()
  }
  ctx.fillStyle = '#02070c'
  for (const d of s.drills) {
    const [x, y] = at(d.x, d.y)
    const r = d.r * unit(d.x, d.y)
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * Math.cos(shot.tilt), 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
  return { face, bounds }
}
