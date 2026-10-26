import type { Vec2 } from '@silk-reel/ingest'

export type GlyphKind = 'package' | 'text' | 'mark'

/** text rendered inside a package glyph, in normalized glyph space */
export interface GlyphLabel {
  text: string
  x: number
  y: number
  /** height as a fraction of the glyph's unit span */
  size: number
  /** rotation in glyph space, radians */
  rot: number
}

/** a cast glyph: unit-normalized strokes centered at origin, or a text string */
export interface Glyph {
  id: string
  kind: GlyphKind
  /** polylines in normalized space, max dimension = 1 */
  strokes: Vec2[][]
  /** text glyphs draw this instead of strokes */
  text?: string
  /** package glyphs may carry silkscreen labels drawn inside the outline */
  labels?: GlyphLabel[]
  /** the dot marks fill rather than stroke */
  filled?: boolean
}

/** one rendered instance of a glyph (a primary slot or a symmetry copy) */
export interface AtomState {
  x: number
  y: number
  rot: number
  scale: number
  /** mirrored copies flip the glyph itself so asymmetric outlines/text render mirrored */
  flipX?: boolean | undefined
  flipY?: boolean | undefined
}

/** ink weight: heroes take palette.head, the rest ride on silk tones */
export type Tone = 'hero' | 'support' | 'punct' | 'text'

/** one slot's whole symmetry group — all copies flicker in unison; nothing moves */
export interface Placement {
  glyphId: string
  /** static pose of every symmetry copy (x,y,rot,scale,flipX,flipY) */
  atoms: AtomState[]
  /** per-copy tone multiplier, same length as atoms (set by the cell's role) */
  tones: number[]
  role: Tone
  /** loop steps (1 step = 1/15 s) where decode-in starts and where decode-out starts; may wrap */
  inStep: number
  outStep: number
  /** index into the decode pattern banks */
  pattern: number
  /** act index; matches FormationEvent.beat (formations[] is sorted by phase) */
  formation: number
  /** hold breaths: loop steps where this unit blinks out for two steps */
  blinks?: number[] | undefined
  /** hairline multiplier: heavy copper draws heavier (default 1) */
  weight?: number | undefined
  /** steps after decode-in finishes that the unit stays at full ink before settling to its tone */
  flare?: number | undefined
}

/** the three acts: the hero's routes (C2), the folded board plan (D2), the board-core frame */
export type FormationId = 'route' | 'plan' | 'frame'

export interface FormationEvent {
  id: FormationId
  /** hold region on the loop; transitions happen between holds */
  startPhase: number
  endPhase: number
  /** act index in score order */
  beat: number
}

/** per-board cast curation: listed refs/texts are preferred as hero glyphs */
export interface CastHints {
  preferRefs?: string[]
  preferTexts?: string[]
}

export type StyleId = 'trace' | 'glyph'
export type Aspect = '4:5' | '1:1' | '9:16' | '16:9'
export type PaletteId = 'mono' | 'copper' | 'blueprint' | 'phosphor'

export interface Palette {
  id: PaletteId | 'custom'
  bg: string
  /** main copper/ink */
  copper: string
  /** back-side / inner copper, zones */
  copperDim: string
  silk: string
  /** growing trace heads, flashes — the bloom source */
  head: string
  /** 0..1 bloom strength for the post pass */
  bloom: number
}

export interface TitleCard {
  name: string
  version?: string | undefined
}

export interface Knobs {
  /** silkscreen text glyphs on/off, 0 or 1 */
  texts?: number
  /** playback speed, 0.75-1.5; duration = base / tempo */
  tempo?: number
}

export type MaskColor = 'green' | 'black' | 'white' | 'blue' | 'red' | 'yellow' | 'purple'

export interface FilmConfig {
  style?: StyleId
  aspect?: Aspect
  palette?: PaletteId
  /** #rrggbb — overrides palette.head and tints copper */
  accent?: string
  title?: TitleCard
  /** alpha-capable output: no background, no vignette/grain */
  transparent?: boolean
  /** glyph cadence: 'twos' holds each 15fps step for 2 frames; 'smooth' interpolates */
  cadence?: 'twos' | 'smooth'
  knobs: Knobs
  seed: number | null
  duration: 'auto' | number
  output: { width: number; height: number; fps: number }
  cast?: CastHints
  /** footprint reference of the hero part; replaces the automatic pick */
  hero?: string
  /** solder mask colour; replaces the colour the board file declares */
  mask?: MaskColor
}

export interface TimelineWarning {
  code: string
  message: string
}

interface TimelineBase {
  fps: number
  totalFrames: number
  durationSeconds: number
  width: number
  height: number
  output: { width: number; height: number; fps: number }
  palette: Palette
  title?: TitleCard | undefined
  transparent: boolean
  warnings: TimelineWarning[]
  seedUsed: number
}

export interface GlyphTimeline extends TimelineBase {
  style: 'glyph'
  cast: Glyph[]
  placements: Placement[]
  formations: FormationEvent[]
  /** loop length in decode steps (1 step = 1/15 s) */
  steps: number
  cadence: 'twos' | 'smooth'
  /** safeArea w/h — formations widen on wide frames, deepen on tall ones */
  stageAspect: number
}

export interface TraceTimeline extends TimelineBase {
  style: 'trace'
  scene: TraceScene
}

export type Timeline = GlyphTimeline | TraceTimeline

/** closed polyline, flat [x0,y0,x1,y1,...] */
export type FlatPath = number[]

export interface TraceLayer {
  id: string
  side: 'F' | 'B' | 'inner'
  /** stride 7: x0,y0,x1,y1,widthPx,t0,t1 — (x0,y0) is where growth starts; sorted by t0 */
  segs: number[]
  /** per seg: e0,e1 — when its energy front crosses it after power-on; −1,−1 when it stays dark */
  energy: number[]
  /** per seg (segs.length / 7): index into TraceScene.groups, −1 when the seg has no net */
  groups: number[]
}

/**
 * One casting unit of the score (a bus, a pair, a clock, a lone net). Its
 * segs grow at one speed through [t, t + d]; pulses replay that growth front
 * at `pulseSpeed`× speed starting at each time in `pulses`.
 */
export interface TraceGroup {
  kind: 'ground' | 'power' | 'clock' | 'diff' | 'bus' | 'signal'
  t: number
  d: number
  pulses: number[]
  pulseSpeed: number
}

/** the board's physical build, resolved to colours */
export interface TraceMaterial {
  /** bare copper reflectance (#rrggbb) */
  copper: string
  /** solder mask albedo (#rrggbb) */
  mask: string
  /** exposed-pad finish albedo */
  finish: string
  /** finish roughness 0..1 */
  finishRough: number
  /** bare laminate albedo */
  substrate: string
  /** silkscreen ink: white on dark masks, near-black on white mask */
  silk: string
  /** energy hues: warm for power and pours, cool for clocks and data */
  energyWarm: string
  energyCool: string
  /** px per mm at zoom 1 */
  pxPerMm: number
  /** board thickness, px */
  thicknessPx: number
}

/**
 * A 3D camera key. The board lies in its zoom-1 frame px; (x,y) is the point
 * looked at, zoom 1 at tilt 0 reproduces the flat framing. tilt pitches the
 * camera down toward the board's bottom edge, yaw spins about the board
 * normal, aperture 0..1 is depth of field (0 = everything sharp).
 */
export interface CameraShot {
  t: number; x: number; y: number; zoom: number; tilt: number; yaw: number; aperture: number
  /** vertical lens shift in NDC: the image moves up without changing the perspective (clears a title band) */
  shift?: number | undefined
  /** a hard cut lands on this key: no move is drawn into it */
  cut?: boolean | undefined
}

/** p-ranges of the film's set pieces, on the 24-beat grid */
export interface TraceActs {
  /** copper routes out from the hero, seen from above */
  draw: [number, number]
  /** the pours fill once the routing is done */
  pour: [number, number]
  mask: [number, number]
  silk: [number, number]
  /** the parts are set down on wet paste, the hero first */
  place: [number, number]
  /** the oven front crosses the board and every part snaps square */
  reflow: [number, number]
  /** first power-on: rails, then the clock, then data */
  power: [number, number]
  hold: [number, number]
}

export type PartKind = 'ic' | 'res' | 'cap' | 'ind' | 'diode' | 'led' | 'xtal' | 'conn' | 'switch' | 'can' | 'valve' | 'pin' | 'other'

/** a component body, plane px; z is its height */
export interface TracePart {
  x: number; y: number; w: number; h: number; rot: number; z: number
  kind: PartKind
  /** lands at t (drops in just before) */
  t: number
  /** when the reflow front reaches it and it snaps square */
  settle: number
  /** how far off square it sits on the wet paste: dx, dy px, rotation rad */
  skew: [number, number, number]
  /** laser-etched marking on the top face (ICs) */
  label?: string | undefined
  hero?: boolean | undefined
  /** pin pitch, px (connectors: the pins drawn on top) */
  pitch?: number | undefined
  /** a header pin: the height of the housing it stands in, px; it falls with the housing */
  seat?: number | undefined
  /** an LED's light at power-on: its colour, and a gain that drops where LEDs crowd */
  led?: { color: string; gain: number } | undefined
}

/** a screen-space caption pinned to a board point */
export interface TraceCallout { t0: number; t1: number; x: number; y: number; text: string; sub?: string | undefined }

export interface TracePad {
  x: number; y: number; w: number; h: number; rot: number
  shape: 'rect' | 'round' | 'circle'
  /** pop-in time */
  t: number
  side: 'F' | 'B' | 'both'
  /** mounting holes and oversized pads draw as rings, never filled blobs */
  ring?: boolean | undefined
}
export interface TraceVia { x: number; y: number; r: number; t: number }
export interface TraceZone {
  fill: FlatPath; side: 'F' | 'B' | 'inner'; t0: number; t1: number
  /** a power pour glows from e0 (−1: never) */
  e0: number
}
export interface TraceText { text: string; x: number; y: number; size: number; rot: number; t: number }
export interface CameraKey { t: number; cx: number; cy: number; zoom: number }
export interface TraceBeats {
  outline: [number, number]
  pads: [number, number]
  growth: [number, number]
  zones: [number, number]
  silk: [number, number]
  hold: [number, number]
}
export interface TraceScene {
  outline: FlatPath[]
  layers: TraceLayer[]          // draw order: back → front
  pads: TracePad[]
  vias: TraceVia[]
  /** drilled holes (pads, vias, mounts) — the constellation that fades in with the outline */
  drills: Array<{ x: number; y: number; r: number }>
  zones: TraceZone[]
  silkStrokes: Array<{ path: FlatPath; t: number }>
  texts: TraceText[]
  /** growth origin (hero footprint center), px — used by zone wipe + glint */
  origin: { x: number; y: number }
  /** camera keys (px, ascending t), smoothstep-sampled: frame center (cx,cy) looks at, zoom about it */
  camera: CameraKey[]
  beats: TraceBeats
  groups: TraceGroup[]
  /** closed board-outline loops (evenodd fill = the board's area) */
  board: FlatPath[]
  material: TraceMaterial
  shots: CameraShot[]
  acts: TraceActs
  parts: TracePart[]
  callouts: TraceCallout[]
}

