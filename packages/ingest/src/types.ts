export interface Vec2 {
  x: number
  y: number
}

export interface BBox {
  min: Vec2
  max: Vec2
}

export type LayerKind = 'copper' | 'silk' | 'mask' | 'drill' | 'outline'

export type LayerSide = 'F' | 'B' | 'inner' | null

export interface Layer {
  id: string
  name: string
  kind: LayerKind
  side: LayerSide
}

export type PadShape = 'rect' | 'circle' | 'oval' | 'roundrect' | 'trapezoid' | 'custom' | 'teardrop'

export interface Pad {
  id: string
  pos: Vec2
  size: Vec2
  shape: PadShape
  rot: number
  netId?: number | undefined
  footprintRef?: string | undefined
}

export interface Trace {
  id: string
  points: Vec2[]
  width: number
  netId?: number | undefined
}

export interface Via {
  id: string
  pos: Vec2
  dia: number
  drill: number
  netId?: number | undefined
}

export interface Zone {
  id: string
  outline: Vec2[]
  /** filled_polygon pour geometry — the actual rendered copper, keepouts already subtracted */
  fills: Vec2[][]
  netId?: number | undefined
}

export interface Text {
  id: string
  value: string
  refdes?: string | undefined
  pos: Vec2
  rot: number
  height: number
  mirrored: boolean
  footprintRef?: string | undefined
}

export interface Footprint {
  ref: string
  value?: string | undefined
  pos: Vec2
  rot: number
  layer: string
  padRefs: string[]
  silkRefs: string[]
  /** file name of the first 3D model, without folder or extension, e.g. PinHeader_1x07_P2.54mm_Vertical */
  model?: string | undefined
  /** the visible 3D models, as written in the file: path, then offset (mm), scale and rotation (degrees) */
  models: ModelRef[]
}

export interface ModelRef {
  path: string
  offset: Vec3
  scale: Vec3
  rotate: Vec3
}

export interface Vec3 {
  x: number
  y: number
  z: number
}


export interface DrillHit {
  id: string
  pos: Vec2
  dia: number
  plated: boolean
}

export interface NetNodeRef {
  elementKind: 'trace' | 'pad' | 'via' | 'zone'
  elementId: string
  footprintRef?: string | undefined
}

export interface Net {
  id: number
  name: string
  nodeRefs: NetNodeRef[]
}

export interface BoardStats {
  traces: number
  pads: number
  vias: number
  zones: number
  texts: number
  drills: number
}

export interface CopperLayers {
  traces: Trace[]
  pads: Pad[]
  vias: Via[]
  zones: Zone[]
}

export interface SilkLayer {
  lines: Trace[]
  texts: Text[]
}

export interface BoardSource {
  format: 'kicad'
  files: string[]
  boardName: string
}

/** the physical build, from (general) and (setup (stackup)) when declared */
export interface Stackup {
  /** board thickness, mm */
  thickness: number
  /** solder mask colour as declared ("Green", "Black", "White", or a #hex) */
  maskColor?: string | undefined
  /** surface finish ("ENIG", "HAL lead-free", "None") */
  finish?: string | undefined
}

export interface BoardModel {
  source: BoardSource
  stackup: Stackup
  bbox: BBox
  outline: Path[]
  layers: Layer[]
  copper: Record<string, CopperLayers>
  silkscreen: Record<string, SilkLayer>
  footprints: Footprint[]
  drill: DrillHit[]
  nets: Net[]
  stats: BoardStats
  warnings: IngestWarning[]
}

export interface Path {
  id: string
  points: Vec2[]
  closed: boolean
  layerId: string
}

export interface IngestWarning {
  code: string
  message: string
}
