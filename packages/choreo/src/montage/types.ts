import type { HypeCut } from './hype'
import type { BoardArchetype, PartKind } from '../types'

export type MontageShotKind =
  | 'title'
  | 'fall'
  | 'field'
  | 'ruler'
  | 'chip'
  | 'ride'
  | 'arrival'
  | 'fire'
  | 'print'
  | 'name'
  | 'drive'
  | 'layer'
  | 'drill'
  | 'ascii'
  | 'count'
  | 'matrix'
  | 'ring'
  | 'fingers'
  | 'select'
  | 'wall'
  | 'hero'
  | 'power'
  | 'poster'
  | 'pad'
  | 'run'
  | 'wave'
  | 'port'
  | 'plug'
  | 'whip'
  | 'fan'
  | 'rush'
  | 'step'
  | 'hold'
  | 'lamp'
  | 'stack'
  | 'copper'
  | 'pins'
  | 'parts'

export type MontageGround = 'paper' | 'spot' | 'black'

export type MontageCarry = 'dot' | 'number' | 'name' | 'move' | 'seam'

export type MontageMove = 'wipe' | 'rise' | 'weight' | 'crop' | 'roll'

export interface MontageWord {
  role: 'fact' | 'part' | 'layer' | 'net' | 'reached' | 'name'
  text: string
  f0: number
  move: MontageMove
  crop: boolean
}

export interface MontageShot {
  kind: MontageShotKind
  f0: number
  f1: number
  ground: MontageGround
  carry: MontageCarry
  index?: number
  layer?: string
  hit?: MontageHit
}

export type MontageJoin = 'dots' | 'dither' | 'ascii'

export type MontageInto = 'cut' | 'iris' | 'word' | 'whip' | 'zoom'

export type MontageAct = 'stack' | 'copper' | 'pins' | 'parts'

export type MontageClimax = 'lamp' | 'city' | 'split'

export interface MontageTally {
  total: number
  digits: number
  suffix: string
}

export interface MontageHit {
  from: MontageView
  to: MontageView
  whip: boolean
  word: string | undefined
  into: MontageInto
  at: { x: number; y: number }
  r: number
  frames: number
  out: number
  follow: boolean
  pin: boolean
  ease: boolean
  invert: number
  spot: { x: number; y: number } | undefined
  unit: string | undefined
  clear: boolean
  join: MontageJoin | undefined
  flood: boolean
  layer: string
  route: [number, number]
  path: 'route' | 'feed'
  clock: [number, number]
  count: [number, number] | undefined
  tally: MontageTally | undefined
  act: MontageAct | undefined
  plug: boolean
  ruler: boolean
  dot: 'head' | { x: number; y: number }
  light: boolean
  climax: MontageClimax | undefined
}

export interface MontageView {
  cx: number
  cy: number
  k: number
  rot: number
}

export interface MontageInk {
  paper: string
  black: string
  spot: string
}

export interface MontageDot {
  x: number
  y: number
  r: number
  mm: { x: number; y: number }
  drill: number | undefined
  net: string | undefined
}

export interface MontageRect {
  x: number
  y: number
  w: number
  h: number
  rot: number
}

export interface MontageRoute {
  net: string
  path: number[]
  length: number
  layers: string[]
  breaks: number[]
  ride: { f0: number; f1: number }
  zoom: number
  start: { x: number; y: number; r: number }
  end: { x: number; y: number; ref: string; label: string; kind: PartKind; pads: MontageRect[]; body: MontageRect | undefined; light: { x: number; y: number } }
}

export type MontageWeight = 'route' | 'density' | 'object'

export interface MontagePulse {
  path: number[]
  length: number
  f0: number
  dur: number
  bold: boolean
}

export interface MontagePart {
  ref: string
  tag: string | undefined
  quad: number[]
  box: { x0: number; y0: number; x1: number; y1: number }
  hero: boolean
  at: number
}

export interface MontageType {
  unit: number
  min: number
  margin: number
}

export interface MontageBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type MontageFact =
  | { kind: 'field'; centre: { x: number; y: number }; k: number }
  | { kind: 'ruler'; from: { x: number; y: number }; to: { x: number; y: number }; mm: number; view: MontageView; line: number; tick: number; baseline: number; cap: number; dot: { x: number; y: number }; right: number }

export interface MontageScore {
  ink: MontageInk
  base: 'paper' | 'black'
  archetype: BoardArchetype
  weight: MontageWeight
  fan: number
  beat: number
  contacts: MontageRect[]
  ports: MontageRect[][]
  facePorts: MontageRect[][]
  portAt: number[]
  feeds: MontageRect[]
  feed: number[]
  glyphs: string
  home: { x: number; y: number }
  lightR: number
  name: string
  version: string | undefined
  lines: string[]
  footer: [string, string]
  unit: 'via' | 'pad'
  count: number
  countWord: string
  dot: MontageDot
  dotPx: number
  dots: Array<{ x: number; y: number; r: number }>
  layers: Array<{ id: string; label: string }>
  route: MontageRoute
  pulses: MontagePulse[]
  energised: number[][]
  parts: MontagePart[]
  blocks: MontageRect[][]
  pins: MontageRect[]
  pours: Record<string, number[][]>
  netCount: number
  hero: { label: string; ref: string; x: number; y: number; w: number; h: number; rot: number }
  fact: MontageFact | undefined
  density: number
  shots: MontageShot[]
  words: MontageWord[]
  stop: { x: number; y: number; r: number; baseline: number }
  rot: number
  board: MontageBox
  fallK: number
  region: MontageBox
  aside: number | undefined
  wordsTop: boolean
  views: { fit: MontageView; close: MontageView; arrival: MontageView; poster: MontageView; count0: MontageView }
  landing: { x: number; y: number }
  type: MontageType
  hype?: HypeCut | undefined
}

export interface MontageEvent {
  kind: 'cut' | 'card' | 'roll' | 'land' | 'flood' | 'ride' | 'snap' | 'wipe' | 'screen' | 'power' | 'converge' | 'set' | 'signature' | 'word' | 'join' | 'climax'
  frame: number
  text?: string
}
