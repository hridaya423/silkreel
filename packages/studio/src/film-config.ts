import { ASPECT_SIZE, compileTimeline, DEMO_CAST_HINTS, PALETTES } from '@silk-reel/choreo'
import type { Aspect, CastHints, FilmConfig, Knobs, MaskColor, Palette, PaletteId, StyleId } from '@silk-reel/choreo'
import type { BoardModel } from '@silk-reel/ingest'

export function castHints(board: BoardModel): CastHints | undefined {
  return DEMO_CAST_HINTS[board.source.boardName]
}

/** fixture boards pick up the same curated cast hints the CLI and render-api use */
export function compileStudioFilm(board: BoardModel, config: FilmConfig) {
  const cast = config.cast ?? castHints(board)
  const resolved: FilmConfig = { ...config, ...(cast !== undefined ? { cast } : {}) }
  const timeline = compileTimeline(board, resolved)
  return {
    timeline,
    config: { ...resolved, seed: timeline.seedUsed },
    warnings: timeline.warnings.map((warning) => warning.message)
  }
}

export const KNOB_RANGES = {
  tempo: { min: 0.75, max: 1.5, step: 0.05 }
} as const

export const STYLES: ReadonlyArray<{ id: StyleId; label: string }> = [
  { id: 'trace', label: 'Trace Growth' },
  { id: 'glyph', label: 'Glyph Loop' },
  { id: 'plot', label: 'Plot' }
]
export const ASPECTS = Object.keys(ASPECT_SIZE) as Aspect[]
export const PALETTE_LIST: readonly Palette[] = Object.values(PALETTES)

export type ExportFormat = 'mp4' | 'gif' | 'webm-alpha' | 'prores-alpha'
export const FORMATS: ReadonlyArray<{ id: ExportFormat; label: string }> = [
  { id: 'mp4', label: 'MP4' },
  { id: 'gif', label: 'GIF' },
  { id: 'webm-alpha', label: 'WebM alpha' },
  { id: 'prores-alpha', label: 'ProRes alpha' }
]

export const DEMO_BOARDS = [
  { id: 'icebreaker', label: 'iCEBreaker', detail: 'iCE40 FPGA dev board, 4 layers' },
  { id: 'glasgow', label: 'Glasgow', detail: 'digital interface explorer, 4 layers' },
  { id: 'StickHub', label: 'StickHub', detail: 'compact USB hub stick' },
  { id: 'ecc83-pp', label: 'ECC83 preamp', detail: '159 KB, through-hole valve preamp' },
  { id: 'kit-dev-coldfire-xilinx_5213', label: 'ColdFire dev kit', detail: '2.8 MB, through-hole + FPGA' },
  { id: 'video', label: 'Video board', detail: '5.8 MB, 4 copper layers, the stress test' }
] as const

export type StudioKnobs = Knobs

export interface StudioState {
  style: StyleId
  aspect: Aspect
  palette: PaletteId | undefined
  accent: string | undefined
  title: { name: string; version: string }
  knobs: StudioKnobs
  hero: string | undefined
  mask: MaskColor | undefined
  seed: number
  duration: 'auto' | number
}

export const DEFAULT_KNOBS: StudioKnobs = {
  tempo: 1,
  texts: 1
}

const STUDIO_FPS = 30

/** studio controls → FilmConfig; an empty title name means no card, palette undefined means the style's default */
export function studioFilmConfig(s: StudioState): FilmConfig {
  const name = s.title.name.trim()
  const version = s.title.version.trim()
  return {
    style: s.style,
    aspect: s.aspect,
    knobs: s.knobs,
    seed: s.seed,
    duration: s.duration,
    output: { ...ASPECT_SIZE[s.aspect], fps: STUDIO_FPS },
    ...(s.palette !== undefined ? { palette: s.palette } : {}),
    ...(s.accent !== undefined ? { accent: s.accent } : {}),
    ...(s.hero !== undefined ? { hero: s.hero } : {}),
    ...(s.mask !== undefined && s.style === 'trace' ? { mask: s.mask } : {}),
    ...(name !== '' ? { title: { name, ...(version !== '' ? { version } : {}) } } : {})
  }
}
