// Draws every fixture board's plan for the board picker: `npx tsx packages/site/figure/outlines.mts` from the repo root.
// Writes src/blueprint/outlines.json: per board its size in mm and SVG paths (mm, origin at the outline's corner)
// for the outline, the front parts, the hero part, and the holes.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseKicadPcb } from '@silk-reel/ingest'
import { extractParts } from '../../choreo/src/trace/parts'
import { boards } from '../src/data/site'

const boxOf = (p: { x: number; y: number; w: number; h: number; rot: number }) => {
  const a = (-p.rot * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([u, v]) => {
    const x = (u * p.w) / 2
    const y = (v * p.h) / 2
    return { x: p.x + x * c - y * s, y: p.y + x * s + y * c }
  })
}
const r = (n: number) => Math.round(n * 10) / 10
const out = Object.fromEntries(boards.map((info) => {
  const board = parseKicadPcb(readFileSync(`fixtures/boards/${info.id}.kicad_pcb`, 'utf8'), info.id)
  const all = board.outline.flatMap((o) => o.points)
  const x0 = Math.min(...all.map((p) => p.x))
  const y0 = Math.min(...all.map((p) => p.y))
  const w = Math.max(...all.map((p) => p.x)) - x0
  const h = Math.max(...all.map((p) => p.y)) - y0
  const path = (pts: { x: number; y: number }[], close: boolean) => pts.map((p, i) => `${i ? 'L' : 'M'}${r(p.x - x0)} ${r(p.y - y0)}`).join('') + (close ? 'Z' : '')
  const parts = extractParts(board)
  // a hero on the back copper means the board is shown from the back, as the films show it
  const back = parts.find((p) => p.ref === info.hero.ref)?.back === true
  const box = (p: (typeof parts)[number]) => path(boxOf({ ...p, ...p.pos }), true)
  const face = parts.filter((p) => p.back === back)
  const mirror = (d: string) => (back ? d.replace(/([ML])([\d.-]+)/g, (_, k: string, x: string) => `${k}${r(w - Number(x))}`) : d)
  return [info.id, {
    w: r(w),
    h: r(h),
    outline: mirror(board.outline.map((o) => path(o.points, o.closed)).join('')),
    parts: mirror(face.filter((p) => p.ref !== info.hero.ref).map(box).join('')),
    hero: mirror(face.filter((p) => p.ref === info.hero.ref).map(box).join('')),
    holes: board.drill.filter((d) => d.dia >= 2).map((d) => [r(back ? w - (d.pos.x - x0) : d.pos.x - x0), r(d.pos.y - y0), r(d.dia / 2)]),
  }]
}))
writeFileSync('packages/site/src/blueprint/outlines.json', JSON.stringify(out))
for (const [id, b] of Object.entries(out)) console.log(id, b.w, '×', b.h, 'mm', JSON.stringify(b).length, 'B')
