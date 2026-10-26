import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseKicadPcb, UnsupportedFormatError } from '@silk-reel/ingest'
import type { BoardModel } from '@silk-reel/ingest'

const DEMO_IDS = ['ecc83-pp', 'kit-dev-coldfire-xilinx_5213', 'video', 'StickHub', 'icebreaker', 'glasgow'] as const
export type DemoId = (typeof DEMO_IDS)[number]

export function isDemoId(value: string): value is DemoId {
  return (DEMO_IDS as readonly string[]).includes(value)
}

const boardsRoot = path.resolve(import.meta.dirname, '../../../fixtures/boards')
const cache = new Map<string, BoardModel>()

export async function loadDemoBoard(demoId: DemoId): Promise<BoardModel> {
  const cached = cache.get(demoId)
  if (cached) return cached
  const text = await readFile(path.join(boardsRoot, `${demoId}.kicad_pcb`), 'utf8')
  const board = parseKicadPcb(text, `${demoId}.kicad_pcb`)
  cache.set(demoId, board)
  return board
}

export function parseKicadText(fileName: string, contents: string): BoardModel {
  if (/\.kicad_mod$/i.test(fileName)) {
    throw new UnsupportedFormatError(
      fileName,
      'standalone .kicad_mod footprint files are not board inputs and cannot be represented faithfully as BoardModel; upload a .kicad_pcb board'
    )
  }
  return parseKicadPcb(contents, fileName)
}

/** a demo board's real outline and big holes as SVG, scaled into a 100-unit-wide box */
export async function demoOutline(demoId: DemoId): Promise<{ w: number; h: number; d: string; holes: Array<[number, number, number]> }> {
  const board = await loadDemoBoard(demoId)
  const pts = board.outline.flatMap((o) => o.points)
  const x0 = Math.min(...pts.map((p) => p.x))
  const y0 = Math.min(...pts.map((p) => p.y))
  const k = 100 / Math.max(1e-6, Math.max(...pts.map((p) => p.x)) - x0)
  const r = (n: number): number => Math.round(n * 10) / 10
  const d = board.outline.map((o) => o.points.map((p, i) => `${i ? 'L' : 'M'}${r((p.x - x0) * k)} ${r((p.y - y0) * k)}`).join('') + (o.closed ? 'Z' : '')).join('')
  const holes = board.drill.filter((h) => h.dia >= 2).map((h): [number, number, number] => [r((h.pos.x - x0) * k), r((h.pos.y - y0) * k), r((h.dia / 2) * k)])
  return { w: 100, h: r((Math.max(...pts.map((p) => p.y)) - y0) * k), d, holes }
}

export { DEMO_IDS }
