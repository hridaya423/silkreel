import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { TraceTimeline } from '@silk-reel/choreo'
import { SOUND } from './sound-kit.js'

/** what the hero part is, read from its structure: pin count, the board's pairs, its connectors */
export type HeroClass = 'logic' | 'interface' | 'mcu' | 'card' | 'valve'

/**
 * A board's measures as the sound reads them, computed from the board file as
 * the timeline carries it (never from its name).
 */
export interface BoardSound {
  cls: HeroClass
  widthMm: number
  heightMm: number
  layers: number
  parts: number
  nets: number
  heroPins: number
  /** 0 = the largest board, 1 = the smallest */
  small: number
  /** outline diagonal, mm */
  diag: number
  /** parts and nets per cm² of board */
  density: number
  /** the mask's own luma, whatever the style shows */
  mask: number
}

const luma = (hex: string): number => {
  const v = Number.parseInt(hex.replace('#', ''), 16)
  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255
}

export function boardSound(tl: TraceTimeline): BoardSound {
  const s = tl.scene
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const loop of s.board) {
    for (let i = 0; i + 1 < loop.length; i += 2) {
      x0 = Math.min(x0, loop[i] as number)
      x1 = Math.max(x1, loop[i] as number)
      y0 = Math.min(y0, loop[i + 1] as number)
      y1 = Math.max(y1, loop[i + 1] as number)
    }
  }
  const mm = s.material.pxPerMm
  const plotFacts = s.plot?.facts
  const size = s.facts.map((f) => /([\d.]+)\s*×\s*([\d.]+)\s*mm/.exec(f)).find((m) => m !== null)
  const widthMm = size != null ? Number(size[1]) : plotFacts?.widthMm ?? Math.max(x1 - x0, y1 - y0) / mm
  const heightMm = size != null ? Number(size[2]) : plotFacts?.heightMm ?? Math.min(x1 - x0, y1 - y0) / mm
  const layersFact = s.facts.map((f) => /(\d+)\s+layers?/.exec(f)?.[1]).find((v) => v !== undefined)
  const layers = plotFacts?.copperLayers ?? (layersFact !== undefined ? Number(layersFact) : new Set(s.layers.map((l) => l.side)).size)
  const parts = s.parts.length
  const nets = s.groups.length
  const heroPins = s.pads.filter((p) => p.hero === true).length
  const hero = s.parts.find((p) => p.hero === true)
  const pinShare = s.parts.filter((p) => p.kind === 'pin' || p.kind === 'conn').length / Math.max(1, parts)
  const pairs = s.groups.filter((g) => g.kind === 'diff').length
  const cls: HeroClass = hero?.kind === 'valve' ? 'valve' : pinShare >= 0.4 ? 'card' : heroPins >= 100 ? 'logic' : pairs > 0 ? 'interface' : 'mcu'
  return measured({ cls, widthMm, heightMm, layers, parts, nets, heroPins, mask: s.material.mask })
}

/** the measures that follow from the counted ones: size, density and the mask's luma */
export function measured(m: Omit<BoardSound, 'small' | 'diag' | 'density' | 'mask'> & { mask: string }): BoardSound {
  const diag = Math.hypot(m.widthMm, m.heightMm)
  const small = Math.max(0, Math.min(1, (Math.log2(330) - Math.log2(diag)) / (Math.log2(330) - Math.log2(40))))
  const density = (m.parts + m.nets) / Math.max(1, (m.widthMm * m.heightMm) / 100)
  return { ...m, small, diag, density, mask: luma(m.mask) }
}

export type MusicStyle = 'trace' | 'plot' | 'montage' | 'glyph'

/** one excerpt of a human-made CC0 track, cut and tempo-locked for the films (how in assets/sound/CREDITS.md) */
export interface Track {
  id: string
  style: MusicStyle
  file: string
  title: string
  author: string
  url: string
  /** the grid the excerpt was stretched onto; 0 for a track with no pulse */
  bpm: number
  /** seconds into the excerpt of the downbeat that lands on the film's turn */
  drop: number
  /** measured on the six seconds after the drop: attacks a second, spectral centroid (Hz), level (dBFS RMS) */
  traits: { onsets: number; centroid: number; level: number }
}

export const LIBRARY: Track[] = JSON.parse(readFileSync(path.join(SOUND, 'music', 'library.json'), 'utf8')) as Track[]

const clamp = (x: number): number => Math.max(0, Math.min(1, x))

const ranks = (tracks: Track[], trait: (t: Track) => number): Map<Track, number> => {
  const order = [...tracks].sort((a, b) => trait(a) - trait(b) || a.id.localeCompare(b.id))
  return new Map(order.map((t, i) => [t, i / Math.max(1, order.length - 1)]))
}

/** where each main chip's class sits on the brightness axis of a style that does not show the mask: an FPGA's lattice brightest, a valve warmest */
const CLASS_LIGHT: Record<HeroClass, number> = { logic: 1, interface: 0.75, mcu: 0.5, card: 0.25, valve: 0 }

/**
 * The board picks its track. Three things a viewer sees meet three things a
 * listener hears: how crowded the board is (parts and nets) meets how busy the
 * track is (attacks a second); the mask's lightness, where the film shows the
 * mask (trace, montage), else the main chip's class, meets the track's
 * brightness; the board's size meets the track's weight (a large board gets a
 * loud, heavy one). The nearest track wins, so one board always gets the same
 * track and a renamed copy does too.
 */
export function pickTrack(style: MusicStyle, b: BoardSound, library: Track[] = LIBRARY): Track {
  const tracks = library.filter((t) => t.style === style)
  if (tracks.length === 0) throw new Error(`no ${style} music in the library`)
  const busy = ranks(tracks, (t) => t.traits.onsets)
  const bright = ranks(tracks, (t) => t.traits.centroid)
  const heavy = ranks(tracks, (t) => t.traits.level)
  const want = [clamp((Math.log2(b.parts + b.nets) - Math.log2(30)) / (Math.log2(600) - Math.log2(30))), style === 'plot' ? CLASS_LIGHT[b.cls] : clamp(b.mask), 1 - b.small]
  const [crowd, light, size] = want as [number, number, number]
  const dist = (t: Track): number => (crowd - (busy.get(t) as number)) ** 2 + (light - (bright.get(t) as number)) ** 2 + (size - (heavy.get(t) as number)) ** 2
  return tracks.reduce((best, t) => (dist(t) < dist(best) ? t : best))
}
