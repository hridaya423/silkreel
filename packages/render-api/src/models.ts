import { readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { BoardModel, Footprint, ModelRef, Vec2 } from '@silk-reel/ingest'
import type { PartBodies, PartMesh } from '@silk-reel/choreo'

export interface ModelOptions {
  /** the board file's folder: ${KIPRJMOD} and relative model paths resolve against it */
  boardDir?: string | undefined
  /** more folders to search, by the model's path under the KiCad library and then by file name */
  dirs?: string[] | undefined
}

export interface LoadedBodies {
  bodies: PartBodies
  /** model paths that named no readable STEP file; those parts keep their estimated bodies */
  missing: string[]
  /** parts whose model does not sit over their pads (a wrong file or transform); they keep their estimated bodies */
  misplaced: string[]
}

const KICAD_LIBRARIES = [
  '/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels',
  '/usr/share/kicad/3dmodels',
  '/usr/local/share/kicad/3dmodels',
  path.join(os.homedir(), '.var/app/org.kicad.KiCad/data/kicad/3dmodels'),
  ...['9.0', '8.0', '7.0', '6.0'].map((v) => `C:\\Program Files\\KiCad\\${v}\\share\\kicad\\3dmodels`)
]

interface Occt {
  ReadStepFile(content: Uint8Array, params: object): {
    success: boolean
    meshes: Array<{
      color?: [number, number, number]
      brep_faces: Array<{ first: number; last: number; color: [number, number, number] | null }>
      attributes: { position: { array: number[] }; normal?: { array: number[] } }
      index: { array: number[] }
    }>
  }
}

let occt: Promise<Occt> | undefined
const tessellated = new Map<string, Promise<Raw | undefined>>()

export interface Raw { pos: number[]; nor: number[]; col: number[]; idx: number[] }

export async function loadPartBodies(board: BoardModel, options: ModelOptions = {}): Promise<LoadedBodies> {
  const byName = options.dirs === undefined ? undefined : await indexByName(options.dirs)
  const meshes: PartMesh[] = []
  const byKey = new Map<string, number>()
  const byRef: Record<string, number> = {}
  const missing = new Set<string>()
  const misplaced: string[] = []
  const padsOf = new Map<string, Vec2[]>()
  for (const copper of Object.values(board.copper)) {
    for (const pad of copper.pads) if (pad.footprintRef !== undefined) padsOf.set(pad.footprintRef, [...(padsOf.get(pad.footprintRef) ?? []), pad.pos])
  }
  for (const fp of board.footprints) {
    if (fp.models.length === 0) continue
    const back = fp.layer.startsWith('B.')
    const key = JSON.stringify([fp.models, back])
    let id = byKey.get(key)
    if (id === undefined) {
      const parts: Raw[] = []
      for (const ref of fp.models) {
        const file = await locate(ref.path, options, byName)
        const raw = file === undefined ? undefined : await tessellate(file)
        if (raw === undefined) missing.add(ref.path)
        else parts.push(place(raw, ref, back))
      }
      if (parts.length === 0) continue
      id = meshes.push(encode(merge(parts))) - 1
      byKey.set(key, id)
    }
    if (covers(meshes[id] as PartMesh, fp, padsOf.get(fp.ref) ?? [])) byRef[fp.ref] = id
    else misplaced.push(fp.ref)
  }
  return { bodies: { meshes, byRef }, missing: [...missing], misplaced }
}

function covers(mesh: PartMesh, fp: Footprint, pads: Vec2[]): boolean {
  const a = (fp.rot * Math.PI) / 180
  const inside = pads.filter((p) => {
    const dx = p.x - fp.pos.x
    const dy = p.y - fp.pos.y
    const u = dx * Math.cos(a) - dy * Math.sin(a)
    const v = dx * Math.sin(a) + dy * Math.cos(a)
    return u > mesh.min[0] - 0.6 && u < mesh.max[0] + 0.6 && v > mesh.min[1] - 0.6 && v < mesh.max[1] + 0.6
  })
  return inside.length >= 0.75 * pads.length
}

async function indexByName(dirs: string[]): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const dir of dirs) {
    const files = await readdir(dir, { recursive: true }).catch(() => [] as string[])
    for (const f of files) if (/\.stp$|\.step$/i.test(f)) index.set(stem(f), path.join(dir, f))
  }
  return index
}

const stem = (file: string): string => path.basename(file).replace(/\.[^.]*$/, '').toLowerCase()

async function locate(modelPath: string, options: ModelOptions, byName: Map<string, string> | undefined): Promise<string | undefined> {
  const variable = /^\$[{(]([^})]+)[})][\\/]*/.exec(modelPath)
  const tail = (variable === null ? modelPath : modelPath.slice(variable[0].length)).replace(/\\/g, '/')
  const boardDir = options.boardDir === undefined ? [] : [options.boardDir]
  const roots = variable === null
    ? path.isAbsolute(tail) ? [''] : [...boardDir, ...KICAD_LIBRARIES]
    : variable[1] === 'KIPRJMOD' ? boardDir : [process.env[variable[1] as string] ?? '', ...KICAD_LIBRARIES].filter(Boolean)
  const bases = [...roots, ...(options.dirs ?? [])].map((root) => path.join(root, tail))
  for (const base of bases) {
    const noExt = base.replace(/\.[^./\\]*$/, '')
    for (const file of [base, ...['.step', '.stp', '.STEP', '.STP'].map((ext) => noExt + ext)]) {
      if (!/\.stp$|\.step$/i.test(file)) continue
      if ((await stat(file).catch(() => undefined))?.isFile() === true) return file
    }
  }
  return byName?.get(stem(tail))
}

async function tessellate(file: string): Promise<Raw | undefined> {
  let job = tessellated.get(file)
  if (job === undefined) {
    job = (async () => {
      occt ??= (createRequire(import.meta.url)('occt-import-js') as () => Promise<Occt>)()
      const result = (await occt).ReadStepFile(new Uint8Array(await readFile(file)), {
        linearUnit: 'millimeter',
        linearDeflectionType: 'absolute_value',
        linearDeflection: 0.02,
        angularDeflection: 0.4
      })
      if (!result.success || result.meshes.length === 0) return undefined
      const raw: Raw = { pos: [], nor: [], col: [], idx: [] }
      for (const mesh of result.meshes) {
        const base = raw.pos.length / 3
        const pos = mesh.attributes.position.array
        const nor = mesh.attributes.normal?.array
        const n = pos.length / 3
        const col = new Array<number>(n * 3)
        const fallback = mesh.color ?? [0.6, 0.6, 0.6]
        for (let i = 0; i < n * 3; i++) col[i] = fallback[i % 3] as number
        for (const face of mesh.brep_faces) {
          if (face.color === null) continue
          for (let i = face.first * 3; i < face.last * 3 + 3; i++) {
            const v = mesh.index.array[i] as number
            for (let k = 0; k < 3; k++) col[v * 3 + k] = face.color[k] as number
          }
        }
        for (let i = 0; i < n * 3; i++) {
          raw.pos.push(pos[i] as number)
          raw.nor.push(nor?.[i] ?? 0)
          raw.col.push(col[i] as number)
        }
        for (const i of mesh.index.array) raw.idx.push(base + i)
      }
      return raw
    })().catch(() => undefined)
    tessellated.set(file, job)
  }
  return await job
}

/** KiCad's model transform (offset · Rz · Ry · Rx · scale, angles negated), then into the footprint's y-down frame; a back footprint's frame is already mirrored in y */
export function place(raw: Raw, ref: ModelRef, back: boolean): Raw {
  const r = (deg: number): [number, number] => [Math.cos((-deg * Math.PI) / 180), Math.sin((-deg * Math.PI) / 180)]
  const [cx, sx] = r(ref.rotate.x)
  const [cy, sy] = r(ref.rotate.y)
  const [cz, sz] = r(ref.rotate.z)
  const turn = (x: number, y: number, z: number): [number, number, number] => {
    const y1 = y * cx - z * sx
    const z1 = y * sx + z * cx
    const x2 = x * cy + z1 * sy
    const z2 = -x * sy + z1 * cy
    return [x2 * cz - y1 * sz, x2 * sz + y1 * cz, z2]
  }
  const down = back ? 1 : -1
  const out: Raw = { pos: [], nor: [], col: raw.col, idx: raw.idx }
  for (let i = 0; i < raw.pos.length; i += 3) {
    const [x, y, z] = turn((raw.pos[i] as number) * ref.scale.x, (raw.pos[i + 1] as number) * ref.scale.y, (raw.pos[i + 2] as number) * ref.scale.z)
    out.pos.push(x + ref.offset.x, down * (y + ref.offset.y), z + ref.offset.z)
    const [nx, ny, nz] = turn(raw.nor[i] as number, raw.nor[i + 1] as number, raw.nor[i + 2] as number)
    out.nor.push(nx, down * ny, nz)
  }
  return out
}

function merge(parts: Raw[]): Raw {
  const out: Raw = { pos: [], nor: [], col: [], idx: [] }
  for (const p of parts) {
    const base = out.pos.length / 3
    for (let i = 0; i < p.pos.length; i++) {
      out.pos.push(p.pos[i] as number)
      out.nor.push(p.nor[i] as number)
      out.col.push(p.col[i] as number)
    }
    for (const i of p.idx) out.idx.push(base + i)
  }
  return out
}

function encode(raw: Raw): PartMesh {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  raw.pos.forEach((v, i) => {
    min[i % 3] = Math.min(min[i % 3] as number, v)
    max[i % 3] = Math.max(max[i % 3] as number, v)
  })
  const b64 = (a: ArrayBufferView): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64')
  return {
    pos: b64(new Float32Array(raw.pos)),
    nor: b64(Int8Array.from(raw.nor, (v) => Math.round(v * 127))),
    col: b64(Uint8Array.from(raw.col, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255))),
    idx: b64(new Uint32Array(raw.idx)),
    min,
    max
  }
}
