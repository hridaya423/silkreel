import type { Vec2 } from '@silk-reel/ingest'
import type { MontageScore } from './montage/types'

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
  /** writes in without falling back once lit (`steadyAlpha`): the name, and an act grown faster than one write-in */
  steady?: true
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
  /** the field's marks: distance from the main chip, 0 at the chip to 1 at the farthest mark */
  reach?: number | undefined
  /** the field's marks on the main chip's signal nets, and the connector pads where those nets leave the board */
  link?: 'net' | 'exit' | undefined
  /** the field's marks of one part's pads share the part's reference */
  group?: string | undefined
  /** the field's build stage: 1 the smallest marks with the main chip, 2 the next size, 3 the largest, 4 the marks that close the picture */
  stage?: number | undefined
}

/** the acts: the hero's routes, the folded board plan, the connectors' diagonal, the cluster round the main chip, the field */
export type FormationId = 'route' | 'plan' | 'diagonal' | 'cluster' | 'field' | 'name'
export type GlyphEnding = 'parts' | 'routes'

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
  /** the part the trace and plot films are about, when it is not the first preferred IC */
  hero?: string
}

export type StyleId = 'trace' | 'glyph' | 'plot' | 'montage'
export type Aspect = '4:5' | '1:1' | '9:16' | '16:9'
export type PaletteId = 'mono' | 'copper' | 'blueprint' | 'phosphor' | 'paper' | 'cyanotype'

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
  /** the designer's own lines, up to three, set small in a montage's build */
  lines?: string[] | undefined
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
  /** a small "made with silk reel" line on the held frame; off unless asked */
  credit?: boolean
  /** trace power-on: 'lamps' (the default) is a macro of the board's own LED cluster, the lamps coming on one after another, power lamp first; 'pulse' keeps the room lit and runs a brief pulse along the real routes, waking each LED it reaches; 'routes' lights the nets in a dimmed room and holds them; 'leds' wakes only the board's own LEDs */
  power?: 'lamps' | 'pulse' | 'leds' | 'routes'
  /** glyph's last shot: 'parts' (the default) spells the name in the board's own part outlines; 'routes' strips the field to the main chip, which routes the name */
  ending?: GlyphEnding
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
  credit: boolean
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
  /** the film's events in frames, for the sound: the open, each formation writing in and the frame its last mark has decoded (its lock), the board's name, the drop, the dive back into the opening */
  events: GlyphEvent[]
  /** the camera's pulls, one for each formation in the order they write in: the frame it starts writing and the frame its last mark has decoded, where the pull ends */
  pulls: Array<[number, number]>
  /** the board as the score reads it: the outline in mm, copper layers, the components on the main chip's side, the net groups, the mask's colour */
  board: { widthMm: number; heightMm: number; layers: number; parts: number; nets: number; mask: string }
}

/** `stage` is the frame the last scene's stage (1 to 4) starts to write; `button` the frame its ring leaves the main chip */
export interface GlyphEvent { at: number; kind: 'open' | 'form' | 'lock' | 'name' | 'letter' | 'turn' | 'stage' | 'button'; stage?: number }

export interface TraceTimeline extends TimelineBase {
  style: 'trace' | 'plot' | 'montage'
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
 * segs light at one speed through [t, t + d].
 */
export interface TraceGroup {
  kind: 'ground' | 'power' | 'clock' | 'diff' | 'bus' | 'signal'
  t: number
  d: number
  /** a net on the hero's own pins: it holds the brightest glow */
  hero?: boolean
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
  /** the floor the finished board stands on, and the ink its name is set in */
  ground: string
  ink: string
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
  /** a key inside a shot, where the move a cut carried in has eased into the shot's own drift */
  carry?: boolean | undefined
  /** a hard cut lands on this key: no move is drawn into it */
  cut?: boolean | undefined
  /** vertical field of view, radians (30° when absent) */
  fov?: number | undefined
  /** rotation of the picture about the lens axis, radians */
  roll?: number | undefined
  /** the plane point held in focus (the look-at point when absent); focus racks between keys */
  focus?: { x: number; y: number } | undefined
  /** how the move leaving this key runs: at constant speed, decelerating into the next key, starting and settling, or at constant speed between a sixth-long start and settle (a monotone cubic when absent) */
  ease?: 'linear' | 'out' | 'inout' | 'land' | 'rise' | undefined
  /** the light state from this key on; it changes on the cut */
  light?: TraceLight | undefined
}

/** each trace shot's own light: what the studio holds while that shot plays */
export type TraceLight = 'spark' | 'route' | 'coat' | 'place' | 'breath' | 'skyline' | 'rim' | 'ride' | 'power' | 'poster' | 'sheen' | 'hero' | 'stage' | 'alone'

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
  /** how long its descent onto its pads lasts, as a share of the film (the hero's when absent) */
  fall?: number | undefined
  /** how high above its pads its descent starts, px: enough that its first drawn frame touches a frame edge (the shot's own fall height when absent) */
  lift?: number | undefined
  /** where in the plane its descent starts, px from its pads; it slides in along a straight line as it falls (straight down when absent) */
  enter?: { x: number; y: number } | undefined
  /** when the reflow passes it: a sound cue only, the part does not move */
  settle: number
  /** laser-etched marking on the top face (ICs) */
  label?: string | undefined
  /** the marking turns half a turn so it reads upright from the end camera */
  turn?: boolean | undefined
  hero?: boolean | undefined
  /** a connector drawn as a steel shell with a mouth (USB, HDMI, RJ45) */
  socket?: boolean | undefined
  /** pin pitch, px (connectors: the pins drawn on top) */
  pitch?: number | undefined
  /** a header pin: the height of the housing it stands in, px; it falls with the housing */
  seat?: number | undefined
  /** an LED's light: its colour, a gain that drops where LEDs crowd, the phase it switches on (−1: it stays dark), and the phase it goes out again (a fault lamp after its test) */
  led?: { color: string; gain: number; at: number; off?: number } | undefined
  /** the part's real body: an index into scene.meshes, drawn through m (local mm → px: x = m0·u + m2·v + m4, y = m1·u + m3·v + m5) */
  mesh?: { id: number; m: [number, number, number, number, number, number] } | undefined
}

/**
 * A part body tessellated from its 3D model, in footprint-local mm (y down,
 * z up off the board), as base64 little-endian arrays.
 */
export interface PartMesh {
  /** Float32 xyz per vertex */
  pos: string
  /** Int8 xyz per vertex, unit normal × 127 */
  nor: string
  /** Uint8 sRGB per vertex */
  col: string
  /** Uint32 triangle indices */
  idx: string
  min: [number, number, number]
  max: [number, number, number]
}

/** real part bodies for a board: the meshes, and which footprint wears which */
export interface PartBodies {
  meshes: PartMesh[]
  byRef: Record<string, number>
}

export interface TracePad {
  x: number; y: number; w: number; h: number; rot: number
  shape: 'rect' | 'round' | 'circle'
  /** pop-in time */
  t: number
  side: 'F' | 'B' | 'both'
  /** mounting holes and oversized pads draw as rings, never filled blobs */
  ring?: boolean | undefined
  /** one of the hero's own pads: it lights when the hero wakes */
  hero?: boolean | undefined
}
export interface TraceVia { x: number; y: number; r: number; t: number }
export interface TraceZone {
  fill: FlatPath; side: 'F' | 'B' | 'inner'; t0: number; t1: number
  /** a power pour glows from e0 (−1: never) */
  e0: number
  /** the copper layer it was poured on (F.Cu, In1.Cu, ...) */
  layer?: string | undefined
}
export interface TraceText {
  text: string; x: number; y: number; size: number; rot: number; t: number
  /** which end sits on x, y (centred when absent), and which edge of a multi-line block */
  align?: 'left' | 'right' | undefined
  valign?: 'top' | 'bottom' | undefined
}
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
  /** hard-gold edge fingers: plane px boxes [x0, y0, x1, y1], at most four */
  gold?: Array<[number, number, number, number]> | undefined
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
  meshes: PartMesh[]
  /** facts from the file for the poster's title lockup: size, layers, parts, nets */
  facts: string[]
  /** how the board powers on: 'lamps' lights its own LED cluster lamp by lamp in a macro, 'pulse' runs a brief pulse along the routes to its LEDs in a lit room, 'leds' wakes only its own LEDs, 'routes' lights and holds its nets in a dimmed room (when absent) */
  power?: 'lamps' | 'pulse' | 'leds' | 'routes' | undefined
  /** the first sign of life after power-on, seen close in the power shot: an LED, the valve's heater, or the power connector's pins */
  sign?: TraceSign | undefined
  /** the one LED that blinks while the film holds its ending: the phase it came on, which names it, and the phase the blinking starts */
  blink?: { at: number; from: number } | undefined
  /** the phases between which the hero's lid carries no marking, because the film letters it itself, and the phase its marking starts to return, full again at the second */
  bareLid?: [number, number, number] | undefined
  /** the trace film's own studio: a dark field under a low ring while the copper draws, gloss on the lids, haze on the ride, a band that flips the main chip's marking, the whole board lit from straight above. Montage's clones leave it out */
  film?: true | undefined
  /** the trace film's seat: the phase the main chip comes to rest on its pads */
  seat?: number | undefined
  /** the trace film's last pulse: it leaves the main chip on the second beat after the poster's revision lands and runs its outbound nets (energised from the wake to `reach`) in `span` */
  pulse?: { at: number; span: number; reach: number } | undefined
  /** the trailer cut's own stage for the lit board, in place of the poster's soft overhead light: how far the nets glow (0: not at all), one key at az from the lens's heading and el above the board, the share of fill left, the main chip's own gain, the stops the light falls from it to the board's far corners, and the floor's colour */
  stage?: { energy: number; key: { az: number; el: number; size: number; gain: number }; fill: number; hero: number; fall: number; ground: string } | undefined
  /** when the hero wakes: the supply's light has reached it along the copper from where power enters */
  wake?: number | undefined
  /** the part the drawing starts from when it is not the hero: its centre in plane px and its net groups, drawn first; edge: when the part has a large plain pad kept off the first frame, the middle of its densest edge, which that frame holds instead */
  opening?: { x: number; y: number; groups: number[]; edge?: { x: number; y: number } | undefined } | undefined
  /** the board's archetype and the opening it sets */
  character?: TraceCharacter | undefined
  /** the end frame's title lockup in screen px, laid out against the board's silhouette */
  lockup?: TraceLockup | undefined
  /** the blueprint film's score and sheet; only style 'plot' carries it */
  plot?: PlotScore | undefined
  montage?: MontageScore | undefined
}

/** what kind of board the file describes, from its data: it sets where the film opens and its signature */
export type BoardArchetype = 'valve' | 'card' | 'stick' | 'leds' | 'dense'

export interface TraceCharacter {
  archetype: BoardArchetype
  /** where the opening shot starts, plane px */
  opening: { x: number; y: number }
  /** the point the opening travels toward, plane px */
  toward: { x: number; y: number }
}

/** the first sign of life: where it is, what it is, and when it lights */
export interface TraceSign {
  kind: 'led' | 'heater' | 'pins'
  x: number; y: number; t: number
  /** the connector's pads, for kind 'pins' */
  pads: Array<{ x: number; y: number; w: number; h: number; rot: number }>
}

/** the end frame's title block, screen px: name lines centred on x at their baselines, the version after the last line, the facts below */
export interface TraceLockup {
  side: 'below' | 'above' | 'beside'
  /** 'grotesk': the name in heavy caps set into the picture over the main chip, the revision small after it (the mono poster block when absent) */
  face?: 'grotesk' | undefined
  size: number
  lines: Array<{ text: string; x: number; y: number }>
  version: { text: string; size: number; y: number } | undefined
  /** lead: how many first lines are set without tracking (the hero part, or all of a narrow column) */
  facts: { text: string; size: number; x: number; y: number; lead?: number | undefined } | undefined
  box: { x0: number; y0: number; x1: number; y1: number }
  /** the name stands in front of the scene on its own dark field, where no layout keeps every part off its letters */
  front?: true | undefined
  /** how the name is built, in film phase: its letters, spaces and line breaks start one `step` apart from t0, each landing over `land`; the version lands as one mark at `version`; `words` are the phases each word (the version last) has landed; the name reads whole from `readable`; the facts rise as one quieter move from `facts` and are up at `up` */
  build?: TitleBuild | undefined
}

export interface TitleBuild {
  t0: number
  step: number
  land: number
  version: number | undefined
  words: number[]
  readable: number
  facts: number | undefined
  up: number
}

export interface PlotRect { x: number; y: number; w: number; h: number }

/** a board px → sheet px similarity: s · R(r) · p + (x, y) */
export interface PlotPlace { s: number; x: number; y: number; r?: number | undefined }

/** a callout: a board point, its label, and the phase it lands on */
export interface PlotMark { x: number; y: number; text: string; sub: string; t: number; z?: number | undefined; accent?: boolean | undefined }


/** one stroke of the nib along real copper, board px; it is inked from t0 to t1 (t0 < 0: inked before the shot opens) */
/** an inked line: its path, width and film times; pen marks the ones the pencil's tip lays, one after another with no gap */
/** `accent` marks the one line of a bus that is the film's signal, inked in the signal's yellow */
export interface PlotStroke { path: FlatPath; w: number; t0: number; t1: number; pen?: boolean | undefined; accent?: boolean | undefined }

/** what the title block prints, all read from the board file or the config */
export interface PlotFacts {
  name: string
  /** the file's own title_block title, when it names something else than the board */
  title?: string | undefined
  /** who the file says the board is for and when it was drawn, as its title block writes them */
  issued: string[]
  /** the ISO sheet size the drawing is made on, from the board's size */
  sheet: string
  /** the config version, else the file's title_block rev; absent when neither exists */
  version?: string | undefined
  date?: string | undefined
  /** the outline's extent as laid out in the file */
  widthMm: number
  heightMm: number
  thicknessMm: number
  copperLayers: number
  parts: number
  nets: number
  /** the detail's magnification over the plan */
  detail: number
  /** the elevation's vertical exaggeration */
  vert: number
  /** the plan is drawn from the board's bottom side */
  back: boolean
  /** the plan is turned 90° on the sheet */
  rotated: boolean
  /** the film's board px run the file's y along x: every view drawn at yaw 0 is turned 90° from the file */
  turned: boolean
  /** the tallest part's height comes from a real 3D model */
  measured: boolean
  /** the board's drilled holes, one row per diameter (mm, to 0.01) with its count, smallest first */
  holes: Array<{ dia: number; count: number }>
}

/** one piece of the supply path, board px: copper it runs along, or a dashed straight link across a plane or a part */
export interface PlotFlowSeg { a: [number, number]; b: [number, number]; w: number; p0: number; p1: number; kind: 'trace' | 'link'; label?: string | undefined; plane?: boolean }

/**
 * An axonometric view in sheet px: a board point p at height z lands on
 * (x, y) + k·(cos ψ·dx − sin ψ·dy, sin e·(sin ψ·dx + cos ψ·dy) − cos e·z), d = p − (mx, my).
 */
export interface PlotAxo { psi: number; e: number; k: number; x: number; y: number; mx: number; my: number }

/**
 * The blueprint film on the 24-beat grid: the nib draws the hero's pin fan,
 * then a bundle or pair; the outline is dimensioned; the plate tips up into
 * the axonometric view, the stack lifts and closes, parts land, callouts draw
 * on and the supply traces to the hero; the camera pulls back into the sheet.
 */
/** a film callout's place in the margins around the hero: which mark (marks.length is the supply link label), side (0 top, 1 right, 2 bottom, 3 left), row outward and order along */
/** a planned callout: the margin side, row and order it packs in, or a fixed box (a corner of the sheet's hero panel) */
export interface PlotCallout {
  item: number
  side: 0 | 1 | 2 | 3
  row: number
  order: number
  rect?: PlotRect | undefined
  /** whether the sheet draws it: its leader stays clear of the object and of the leaders kept before it */
  drawn?: boolean | undefined
}

/**
 * One thing the blueprint film does that a sound can land on, in film time (0..1; `plotFrame` turns it into a frame):
 * cut (a hard cut), stroke (the pencil draws one line: shot 1's fan and each supply segment), ink (lines that appear without the pencil: the macro's lines and the outline), letter (one piece of lettering from its first glyph to its last; `text` is what it spells), tilt (the plan tips up into the oblique), lift (the layers part), land (a layer, then the parts, set down; t0 = t1 is the contact), push and pull (the camera moves onto the supply route and back), rule (a sheet border is plotted), fill (a panel draws in), stamp (the title block is complete) and title (the sheet title letters on and underlines)
 */
export interface PlotEvent {
  kind: 'cut' | 'stroke' | 'ink' | 'letter' | 'tilt' | 'lift' | 'land' | 'push' | 'pull' | 'rule' | 'fill' | 'stamp' | 'title'
  t0: number
  t1: number
  /** the lettering's text, the panel's name, or the stroke's source (nib, route) */
  text?: string
}

/** the drawing each kind of board's signature shot makes */
export type PlotSignature = 'section' | 'travel' | 'fingers' | 'header' | 'pair' | 'escape'
/** the blueprint film's own plan for a board, read from the file: it sets the opening, the signature and the order of the shots */
export type PlotPlan = 'stick' | 'valve' | 'header' | 'pair' | 'card' | 'dense'
export type PlotShotKind = 'open' | 'macro' | 'signature' | 'outline' | 'section' | 'tilt' | 'stack' | 'assembly' | 'detail' | 'pull' | 'sheet' | 'hold'
/** one shot of the blueprint film, film phase */
export interface PlotShot { kind: PlotShotKind; t0: number; t1: number }
/** a stop on the power path: its tag, its board px point, how far along the path it sits (board px) and the phase the ink reaches it */
export interface PlotStation { text: string; x: number; y: number; at: number; t: number }
/** what the signature shot draws, from the file */
export type PlotSigData =
  | { kind: 'section'; heightMm: number; diaMm: number; pins: number; boardMm: number; supply: string }
  | { kind: 'travel'; from: [number, number]; to: [number, number]; lengthMm: number; zoom: number; yaw: number; datum: [number, number]; dir: [number, number]; half: number; marks: Array<{ at: number; mm: number }> }
  | { kind: 'fingers'; pads: Array<[number, number, number, number]>; pitchMm: number; supply: number; from: [number, number]; to: [number, number]; zoom: number; yaw: number }
  | { kind: 'header'; ref: string; value: string; pads: Array<[number, number, number, number]>; rows: Array<{ num: string; net: string; supply: boolean }>; pitchMm: number; lines: number; male: boolean; rot: number }
  | { kind: 'pair'; lengthsMm: [number, number] }
  | { kind: 'escape'; centre: [number, number]; pins: Array<{ at: [number, number]; path: number[]; supply: boolean }>; pitchMm: number; zoom: number }

/** how the blueprint draws a part's body: its leads, lands, posts, shell or glass */
export type PlotBodyStyle = 'gull' | 'lands' | 'header' | 'socket' | 'usb' | 'passive' | 'elec' | 'valve' | 'block'

/** a part body as the blueprint draws it, matched to a scene part by its centre (board px): its footprint's pads, its pin 1 and what its lid says */
export interface PlotBody {
  x: number; y: number
  ref: string
  value: string
  /** no other part on its side shares its value, so its lid may carry it */
  lone: boolean
  style: PlotBodyStyle
  /** its pads, board px: x, y, w, h each */
  pads: Array<[number, number, number, number]>
  pin1?: [number, number] | undefined
  /** the unit direction its opening faces, board px (a USB socket's mouth at the board edge) */
  open?: [number, number] | undefined
}

/** the object's moves in beats, from the board's own shot plan */
export interface PlotBeats { tilt: [number, number]; lift: [number, number]; lands: number[]; parts: number; push: [number, number]; pull: [number, number]; sheet: number; done: number }

export interface PlotScore {
  /** the film's shape: the board's archetype, its shot list and the stations the accent ink reaches one shot at a time */
  /** the board's plan, its signature drawing, its shots, the power path's stations (only in a film about power), and the one true thing the film shows, as the line the sheet letters under the name */
  film: { archetype: BoardArchetype; plan: PlotPlan; signature: PlotSigData; shots: PlotShot[]; stations: PlotStation[]; sentence: string }
  /** when the object's moves fall, in beats: the tilt, the stack's lift, each gap closing, the parts setting down, the push, the pull, the sheet's first beat and the beat its last callout has lettered */
  beats: PlotBeats
  /** every event a score can follow, in time order */
  events: PlotEvent[]
  shots: { nib: [number, number]; bus: [number, number]; outline: [number, number]; object: [number, number]; sheet: [number, number] }
  /** shot 1's strokes, and when the opening grows out of the hero, the phase the pen letters the hero's marking on its lid */
  nib: { strokes: PlotStroke[]; mark?: number | undefined }
  /** what the second shot draws and measures: a named pair, a bundle, or the hero's pins on a sparse board */
  /** the macro: its subject's lines and the neighbours already inked and swept in on beats 4 to 5 */
  /** `line`: the film's signal where it is no line of the bus, a net of the main chip in the bus's view, inked in yellow with the bus */
  bus: { strokes: PlotStroke[]; sweep: PlotStroke[]; line: PlotStroke[]; kind: 'pair' | 'bundle' | 'pins' | 'none' }
  /** the hero's pin 1, the pitch between it and its neighbour, and what the detail panel notes about it (its pitch, or a socket's pin circle) */
  /** read: the direction the main chip's name runs along the chip's own axes, chosen once for the whole film */
  hero: { pin1?: [number, number] | undefined; pitch?: { a: [number, number]; b: [number, number]; mm: number } | undefined; label: string; subject?: string | undefined; read?: [number, number] | undefined }
  /** copper layers top to bottom as filmed: their names in the file, their role, an index into scene.layers (−1: no tracks) and their pours */
  stack: Array<{ name: string; role: string; layer: number; zones: number[] }>
  /** the vias the stack projects: the power net's and the hero's, board px pairs */
  vias: FlatPath
  /** the film's callouts on the assembled board */
  marks: PlotMark[]
  /** the net or nets a ride follows to the main chip, how far it rides (mm), the named place it starts from, and the share of its copper that runs beside a parallel neighbour */
  signal?: { nets: string[]; mm: number; longest: number; from: string; beside: number } | undefined
  /** the centres of round footprints (pads on a circle, radial cans, valves): their bodies draw as cylinders */
  round: Array<[number, number]>
  /** every part body the object and sheet draw, with its pads and pin 1 */
  bodies: PlotBody[]
  /** what the sheet's hero view labels */
  features: PlotMark[]
  /** the next most significant parts the sheet's callouts leave out, most significant first */
  tier: PlotMark[]
  /** the one supply path from the entry to the hero's power pins, its layer changes, and the pins it ends on */
  flow: { path: PlotFlowSeg[]; vias: Array<[number, number]>; pins: Array<[number, number]>; end: number; ends: Array<{ x: number; y: number; text: string; t: number }> }
  /**
   * the object shot: the sheet camera that frames the exploded stack, the hero's yaw on beat 13 and on beat 20 and its elevation (it eases back to the sheet's view by 20.5),
   * the stack's exploded gap, the board's silhouette points (x, y, z triples, board px), the planned callouts, how far the camera pushes in on the power path (0.145 at most, less where the hero's and POWER IN labels would leave the safe margin), and how far it first eases out over beats 14.5 to 15 (0 or negative) to keep them in
   */
  object: { x: number; y: number; zoom: number; lift: number; psi: [number, number]; e: number; planYaw: number; gap: number; hull: number[]; hullBoard: number; callouts: PlotCallout[]; push: number; pull: number
    /** each body's drawing window, beats, keyed by its board position */
    wave: Array<{ x: number; y: number; t0: number; t1: number }>
    /** the film's signal path inked in the accent as the camera rides it, film time */
    trail: PlotFlowSeg[]
    /** the ride's scale over the sheet's: a board the sheet stands up is ridden at the size it had lying on the diagonal */
    scale?: number
    /** the beats the board turns and scales from the ride's view to the sheet's: from the ride's pull-back to the sheet */
    turn?: [number, number]
    /** the refs the camera's route visits after the hero, in order */
    route: string[] }
  sheet: {
    /** the beat the pull lands and the sheet's panels start to rule */
    at: number
    frame: PlotRect
    title: PlotRect
    hero: PlotRect
    plan: PlotRect
    /** the elevation and detail panels: only a tall sheet has them */
    elevation?: PlotRect | undefined
    stack?: PlotRect
    detail?: PlotRect | undefined
    block: PlotRect
    iso: PlotAxo
    planAt: PlotPlace
    detailAt: PlotPlace
    /** s: px per board px along the board; v: the vertical exaggeration; y: the board's top line */
    elevationAt: PlotPlace & { v: number }
    /** the detail's circle radius in sheet px */
    detailR: number
    /** the hero panel's callouts, over features; the film shows the first of them */
    callouts: PlotCallout[]
    /** a count of like parts, printed on the hero panel's title line instead of pointing at one of them */
    note?: string | undefined
    /** the hero panel's callouts print in bands above and below the board, not in columns beside it */
    /** the box the hero panel's callouts pack against: the board's screen box, drawn in where the board's corners leave paper free */
    board: PlotRect
    /** the title block's cells, row by row: caption, value */
    cells: Array<Array<[string, string]>>
    /** the board's name as the ending letters it: its lines, their left edge and first baseline in frame px, the letter size, and the stamp's centre and letter height beside it */
    name: { lines: string[]; x: number; y: number; size: number; stamp: [number, number]; stampSize: number }
  }
  facts: PlotFacts
  /** when a film that travels its signal inks each point of the board: see PlotInk */
  ink?: PlotInk | undefined
  /** the section through the main chip a film that travels draws after the fan-out */
  section?: PlotSection | undefined
  /** the main chip's wiring on the layers below the top, drawn dashed from the last half beat before the turn */
  hidden?: PlotHidden[] | undefined
}

/**
 * Section A–A: a cutting line through the main chip, level on the screen the
 * camera holds, and the section it cuts drawn below it. Places are board px
 * along `dir` from `at`; times are film time. The line runs over `line`, the
 * section over ±`half`.
 */
export interface PlotSection {
  at: [number, number]
  dir: [number, number]
  line: [number, number]
  half: number
  /** whether each end's mark (its "A" and arrow) is drawn: only a mark the frame the section is drawn in holds whole; the line runs to its end either way */
  marks: [boolean, boolean]
  /** the title has a row of its own above the chip, because on the chip's row it would run into the chip's outline */
  apart: boolean
  /** the chip's body along the cut */
  chip: [number, number]
  /** the letter size, px on the screen the camera holds over the section, and the panel's box (along the cut, down the screen, along, down: its corners) in board px from the chip's centre */
  size: number
  panel: [number, number, number, number]
  /** the panel's rows in one column, or in two where one column would not fit under the held chip; the second column takes the lower layers */
  cols: 1 | 2
  /** the panel's drawing along the cut, as a share of the board's scale: under 1 only in two columns */
  scale: number
  /** which side of the chip the panel lies on: the first of below, above, right and left that the frame holds with none of the yellow signal under it, else the one with the least */
  side: 'below' | 'above' | 'right' | 'left'
  /** the signal lies under the panel wherever it goes: the panel is then drawn over it */
  over: boolean
  /** each copper layer from the top: its name in the file, whether it is a plane, its copper crossing the cut (place, width) and the film time its line starts */
  layers: Array<{ name: string; plane: boolean; cuts: Array<[number, number]>; t: number }>
  /** the top pads the cut passes through: place, width */
  pads: Array<[number, number]>
  /** the vias on the cut, each far enough from the last to be told apart on a phone: place */
  posts: number[]
  /** the cutting line's span, then the starts of its arrows and letters, the panel, the posts, the pads, the chip and the title, the time the drawing is whole, and the time the camera has left the panel: from then on only the cutting line and its letters are drawn */
  t: { line: [number, number]; arrows: number; panel: number; posts: number; pads: number; chip: number; title: number; whole: number; gone: number }
}

/** one layer's hidden copper: its name, its depth below the top copper in board px, and its segments (x0, y0, x1, y1, t0, t1; each grows from its first end) */
export interface PlotHidden { layer: string; depth: number; segs: number[] }

/**
 * The order a travelling blueprint inks its board in, film time. Ink spreads
 * from the yellow signal as it is drawn: from each source x, y it starts at t
 * and runs out at v board px per unit of film time. Nothing new is drawn over
 * the still beat `hold`: whatever would start in it waits, with everything
 * after it, one beat. The chip's own signals near it (`fan`) are held back
 * and drawn outward from the chip after that beat, at fan.v from fan.r0 out
 * to fan.r, their starts going once round the chip from angle fan.from over
 * fan.round; `far` inks what is left, from the chip outward, by the
 * sheet. Pencil runs `lead` ahead of the ink.
 */
export interface PlotInk {
  src: number[]
  hold: [number, number]
  fan: { t: number; v: number; r0: number; r: number; round: number; from: number }
  far: { x: number; y: number; t: number; v: number }
  lead: number
  /** a box on the board (four corners) holding every frame from the ride's arrival to the held view, on a film whose arrival would otherwise open half bare: its copper drafts in as a ring from board point from, leaving at film time t0 at v board px a unit of film time, and every line in it is whole by film time t */
  stand?: { at: Array<[number, number]>; t: number; from: [number, number]; t0: number; v: number } | undefined
}
