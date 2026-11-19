// Landing check for trace films. Per part: its first drawn frame and whether its screen box then touches a frame edge.
// Per frame from beat 8: the share of the hero (grown to its pin rows) that any body hides from the lens, resting or
// falling, and the largest share of the frame a falling body covers.
// usage: npx tsx scripts/trace-landing.mts board[,board] aspect[,aspect] [--parts] [--frames]
import { readFile } from 'node:fs/promises'
import { compileTimeline, heroOcclusion, makeCam, pinReach, project, sampleShot } from '../packages/choreo/src/index.ts'
import type { Aspect, TimelineWarning, TraceTimeline } from '../packages/choreo/src/index.ts'
import { parseKicadPcb } from '../packages/ingest/src/index.ts'
import { DEMO_TITLES } from '../packages/render-api/src/boards.ts'
import { loadPartBodies } from '../packages/render-api/src/models.ts'
import { parseCliArgs } from '../packages/cli/src/args.ts'

type P = [number, number]
type Part = TraceTimeline['scene']['parts'][number]
const argv = process.argv.slice(2)
const plain = argv.filter((a) => !a.startsWith('--'))
const boards = (plain[0] ?? 'icebreaker').split(',')
const aspects = (plain[1] ?? '4:5').split(',') as Aspect[]
const HERO_FALL = 11.5 / 360

const hullArea = (pts: P[]): number => {
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
  const h = [...half(p), ...half([...p].reverse())]
  let a = 0
  for (let i = 0; i < h.length; i++) {
    const u = h[i] as P
    const v = h[(i + 1) % h.length] as P
    a += u[0] * v[1] - v[0] * u[1]
  }
  return Math.abs(a) / 2
}

const inHull = (pts: P[], x: number, y: number): boolean => {
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
  const h = [...half(p), ...half([...p].reverse())]
  for (let i = 0; i < h.length; i++) if (cross(h[i] as P, h[(i + 1) % h.length] as P, [x, y]) < 0) return false
  return true
}

function fallHeight(tl: TraceTimeline): number {
  const shots = tl.scene.shots
  const least = 6 * tl.scene.material.pxPerMm
  const place = shots.findIndex((k) => k.light === 'place')
  if (place < 0) return least
  const a = (shots[place] as (typeof shots)[number]).t
  const b = shots.slice(place + 1).find((k) => k.cut === true)?.t ?? 1
  const cam = makeCam(sampleShot(shots, (a + b) / 2), tl.width, tl.height)
  const sinE = Math.min(1, Math.max(0, cam.pos[2] / cam.dist))
  const cosE = Math.sqrt(1 - sinE * sinE)
  return Math.max(least, (0.15 * 2 * cam.focus * cam.tanY) / Math.max(0.35, cosE))
}

const heightAt = (pt: Part, p: number, uFall: number): number | undefined => {
  const u = (pt.t - p) / (pt.fall ?? HERO_FALL)
  if (u > 1) return undefined
  if (u <= 0) return 0
  return u * u * (pt.lift ?? uFall)
}

const cornersAt = (cam: ReturnType<typeof makeCam>, pt: Part, base: number): Array<{ x: number; y: number; w: number }> => {
  const c = Math.cos(pt.rot)
  const s = Math.sin(pt.rot)
  return [-1, 1].flatMap((u) => [-1, 1].flatMap((v) => [base, base + pt.z].map((z) => project(cam, pt.x + (c * u * pt.w - s * v * pt.h) / 2, pt.y + (s * u * pt.w + c * v * pt.h) / 2, z))))
}

for (const board of boards) {
  const file = `fixtures/boards/${board}.kicad_pcb`
  const model = parseKicadPcb(await readFile(file, 'utf8'), `${board}.kicad_pcb`)
  for (const aspect of aspects) {
    const cli = parseCliArgs([file, '--aspect', aspect, '--title', DEMO_TITLES[board] ?? board, '-o', 'unused.mp4'])
    const bodies = (await loadPartBodies(model, { boardDir: 'fixtures/boards', dirs: cli.models ?? [] })).bodies
    const tl = compileTimeline(model, cli.config, bodies) as TraceTimeline & { warnings?: TimelineWarning[] }
    const s = tl.scene
    const W = tl.width
    const H = tl.height
    const N = tl.totalFrames
    const uFall = fallHeight(tl)
    const hero = s.parts.find((pt) => pt.hero === true)
    if (hero === undefined) continue
    const reach = pinReach(hero, s.pads.filter((pd) => pd.hero === true))
    const others = s.parts.filter((pt) => pt.hero !== true && (pt.kind !== 'pin' || Math.hypot(pt.x - hero.x, pt.y - hero.y) > Math.max(hero.w, hero.h) / 2))
    console.log(`## ${board} ${aspect}  (fall height ${uFall.toFixed(0)} px)`)
    let edgeMiss = 0
    const partRows: string[] = []
    for (const pt of s.parts) {
      if (pt.hero === true || pt.kind === 'pin') continue
      const first = Math.ceil((pt.t - (pt.fall ?? HERO_FALL)) * N - 1e-9)
      const p = first / N
      const base = heightAt(pt, p, uFall) ?? 0
      const qs = cornersAt(makeCam(sampleShot(s.shots, p), W, H), pt, base)
      const seen = qs.some((q) => q.w > 0 && Math.abs(q.x) < 1 && Math.abs(q.y) < 1)
      const edge = qs.some((q) => q.w <= 0 || Math.abs(q.x) >= 1 || Math.abs(q.y) >= 1)
      const landCam = makeCam(sampleShot(s.shots, pt.t), W, H)
      const landsSeen = cornersAt(landCam, pt, 0).some((q) => q.w > 0 && Math.abs(q.x) < 1 && Math.abs(q.y) < 1)
      if (landsSeen && seen && !edge) edgeMiss++
      partRows.push(`  ${pt.kind.padEnd(6)} f${first} → f${Math.round(pt.t * N)}  lift ${(pt.lift ?? uFall).toFixed(0)}  ${!landsSeen ? 'off-frame' : edge ? 'edge' : 'INSIDE'}`)
    }
    if (argv.includes('--parts')) for (const r of partRows) console.log(r)
    console.log(`parts that first appear inside the frame: ${edgeMiss}`)
    const heroFirst = Math.ceil((hero.t - (hero.fall ?? HERO_FALL)) * N - 1e-9)
    const stretches: Array<[string, number, number]> = [['before the hero', 120, heroFirst], ['hero in, place', heroFirst, 180], ['reflow', 180, 210], ['take', 210, 255], ['crane', 255, 315], ['hold', 315, N]]
    const worstBy = stretches.map(() => ({ cover: 0, frame: -1 }))
    let worstCover = 0
    let worstFrame = -1
    let worstShare = 0
    let shareFrame = -1
    const frameRows: string[] = []
    for (let f = 120; f < N; f++) {
      const cuts = s.shots.filter((k) => k.cut === true).map((k) => k.t)
      for (const off of [-0.25, 0, 0.25]) {
        const p = (f + off) / N
        if (cuts.some((c) => (c > p && c <= f / N) || (c > f / N && c <= p))) continue
        const cam = makeCam(sampleShot(s.shots, p), W, H)
        const resting = others.filter((pt) => heightAt(pt, p, uFall) === 0)
        const rest = heroOcclusion(cam, W, H, hero, resting, reach).covered
        const falling = others.flatMap((pt) => {
          const h = heightAt(pt, p, uFall)
          return h === undefined || h === 0 ? [] : [{ pt, qs: cornersAt(cam, pt, h) }]
        })
        let hidden = 0
        let total = 0
        const c = Math.cos(hero.rot)
        const sn = Math.sin(hero.rot)
        const heroDepth = Math.hypot(hero.x - cam.pos[0], -hero.y - cam.pos[1], hero.z - cam.pos[2])
        for (let i = 0; i < 16; i++) {
          for (let j = 0; j < 16; j++) {
            const lx = ((i + 0.5) / 16 - 0.5) * reach
            const ly = ((j + 0.5) / 16 - 0.5) * reach
            const z = Math.abs(lx) <= 0.5 && Math.abs(ly) <= 0.5 ? hero.z : 0
            const q = project(cam, hero.x + c * lx * hero.w - sn * ly * hero.h, hero.y + sn * lx * hero.w + c * ly * hero.h, z)
            if (q.w <= 0 || Math.abs(q.x) > 1 || Math.abs(q.y) > 1) continue
            total++
            if (falling.some(({ pt, qs }) => qs.every((r) => r.w > 0) && Math.hypot(pt.x - cam.pos[0], -pt.y - cam.pos[1], (heightAt(pt, p, uFall) ?? 0) - cam.pos[2]) < heroDepth && inHull(qs.map((r): P => [r.x, r.y]), q.x, q.y))) hidden++
          }
        }
        const cover = Math.max(rest, total === 0 ? 0 : hidden / total)
        const share = Math.max(0, ...falling.map(({ qs }) => (qs.some((r) => r.w <= 0) ? 1 : hullArea(qs.map((r): P => [Math.max(-1, Math.min(1, r.x)), Math.max(-1, Math.min(1, r.y))])) / 4)))
        if (cover > worstCover) [worstCover, worstFrame] = [cover, f]
        const k = stretches.findIndex(([, a, b]) => f >= a && f < b)
        const wb = worstBy[k]
        if (wb !== undefined && cover > wb.cover) [wb.cover, wb.frame] = [cover, f]
        if (share > worstShare) [worstShare, shareFrame] = [share, f]
        if (off === 0) frameRows.push(`  f${f} hero covered ${(cover * 100).toFixed(1)}%  largest falling ${(share * 100).toFixed(1)}%`)
      }
    }
    if (argv.includes('--frames')) for (const r of frameRows) console.log(r)
    console.log(`hero covered from f120: worst ${(worstCover * 100).toFixed(1)}% at f${worstFrame}`)
    console.log(stretches.map(([name, a, b], i) => `  ${name} f${a}–${b - 1}: ${((worstBy[i]?.cover ?? 0) * 100).toFixed(1)}%${(worstBy[i]?.frame ?? -1) >= 0 ? ` (f${worstBy[i]?.frame})` : ''}`).join('\n'))
    console.log(`largest falling body: ${(worstShare * 100).toFixed(1)}% of the frame at f${shareFrame}`)
  }
}
