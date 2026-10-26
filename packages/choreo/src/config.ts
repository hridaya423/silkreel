import { ChoreoConfigError } from './errors'
import { clamp } from './curves'
import { ASPECT_SIZE } from './layout'
import { PALETTES, resolvePalette } from './palette'
import type { Aspect, CastHints, FilmConfig, Knobs, MaskColor, Palette, PaletteId, StyleId, TitleCard } from './types'

export const MASK_COLORS: readonly MaskColor[] = ['green', 'black', 'white', 'blue', 'red', 'yellow', 'purple']

interface ResolvedKnobs {
  texts: number
  tempo: number
}

export interface ResolvedConfig {
  style: StyleId
  aspect: Aspect | undefined
  palette: Palette
  title: TitleCard | undefined
  transparent: boolean
  knobs: ResolvedKnobs
  seed: number | null
  cadence: 'twos' | 'smooth'
  durationSeconds: number | 'auto'
  width: number
  height: number
  fps: number
  cast?: CastHints | undefined
  hero?: string | undefined
  mask?: MaskColor | undefined
  knobWarnings: Array<{ code: string; message: string }>
}

export interface DurationPlan {
  durationSeconds: number
  totalFrames: number
  warnings: Array<{ code: string; message: string }>
}

const MIN_FILM_SECONDS = 6
const MAX_FILM_SECONDS = 20

function bounded(
  field: string,
  value: number | undefined,
  lo: number,
  hi: number,
  fallback: number
): { value: number; requested: number | undefined } {
  if (value === undefined) return { value: fallback, requested: undefined }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ChoreoConfigError(`knobs.${field}`, value, 'expected a finite number')
  }
  if (value < lo || value > hi) return { value: clamp(value, lo, hi), requested: value }
  return { value, requested: value }
}

export function resolveConfig(config: FilmConfig): ResolvedConfig {
  if (typeof config !== 'object') {
    throw new ChoreoConfigError('config', config, 'expected a FilmConfig object')
  }
  const styleRaw: unknown = config.style
  if (styleRaw !== undefined && styleRaw !== 'trace' && styleRaw !== 'glyph') {
    throw new ChoreoConfigError('style', styleRaw, "expected 'trace' or 'glyph'")
  }
  const style: StyleId = styleRaw ?? 'trace'

  const aspectRaw: unknown = config.aspect
  if (aspectRaw !== undefined && !Object.hasOwn(ASPECT_SIZE, aspectRaw as string)) {
    throw new ChoreoConfigError('aspect', aspectRaw, "expected '4:5', '1:1', '9:16' or '16:9'")
  }
  const aspect = aspectRaw as Aspect | undefined

  const paletteIdRaw: unknown = config.palette
  if (paletteIdRaw !== undefined && !Object.hasOwn(PALETTES, paletteIdRaw as string)) {
    throw new ChoreoConfigError('palette', paletteIdRaw, "expected 'mono', 'copper', 'blueprint' or 'phosphor'")
  }

  if (config.accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(config.accent)) {
    throw new ChoreoConfigError('accent', config.accent, 'expected a #rrggbb hex color')
  }

  const titleRaw: unknown = config.title
  let title: TitleCard | undefined
  if (titleRaw !== undefined) {
    if (typeof titleRaw !== 'object' || titleRaw === null) {
      throw new ChoreoConfigError('title', titleRaw, 'expected a { name, version? } object')
    }
    const name = (titleRaw as TitleCard).name
    const version = (titleRaw as TitleCard).version
    if (typeof name !== 'string' || name.length < 1 || name.length > 40) {
      throw new ChoreoConfigError('title.name', name, 'expected 1-40 characters')
    }
    if (version !== undefined && (typeof version !== 'string' || version.length > 24)) {
      throw new ChoreoConfigError('title.version', version, 'expected 0-24 characters')
    }
    title = config.title
  }

  if (config.transparent !== undefined && typeof config.transparent !== 'boolean') {
    throw new ChoreoConfigError('transparent', config.transparent, 'expected a boolean')
  }
  const transparent = config.transparent ?? false

  const cadenceRaw: unknown = config.cadence
  if (cadenceRaw !== undefined && cadenceRaw !== 'twos' && cadenceRaw !== 'smooth') {
    throw new ChoreoConfigError('cadence', cadenceRaw, "expected 'twos' or 'smooth'")
  }
  const cadence = cadenceRaw ?? 'twos'

  if (config.seed !== null && (typeof config.seed !== 'number' || !Number.isFinite(config.seed))) {
    throw new ChoreoConfigError('seed', config.seed, 'expected a finite number or null')
  }

  const knobs: Knobs = config.knobs
  if (typeof knobs !== 'object') throw new ChoreoConfigError('knobs', knobs, 'expected a knobs object')

  const texts = bounded('texts', knobs.texts, 0, 1, 1)
  const tempo = bounded('tempo', knobs.tempo, 0.75, 1.5, 1)

  const knobWarnings: Array<{ code: string; message: string }> = []
  for (const [field, result] of Object.entries({ texts, tempo })) {
    if (result.requested !== undefined && result.value !== result.requested) {
      knobWarnings.push({
        code: 'knob-clamped',
        message: `knobs.${field}=${result.requested} out of range; clamped to ${result.value}`
      })
    }
  }

  const durationRaw: 'auto' | number = config.duration
  if (durationRaw !== 'auto') {
    if (typeof durationRaw !== 'number' || !Number.isFinite(durationRaw)) {
      throw new ChoreoConfigError('duration', durationRaw, "expected 'auto' or a finite number of seconds")
    }
    if (durationRaw <= 0) {
      throw new ChoreoConfigError('duration', durationRaw, 'duration must be positive')
    }
  }

  const output = config.output
  if (typeof output !== 'object' || !Number.isInteger(output.width) || output.width <= 0 || output.width > 8192) {
    throw new ChoreoConfigError('output.width', output.width, 'expected an integer in [1, 8192]')
  }
  if (!Number.isInteger(output.height) || output.height <= 0 || output.height > 8192) {
    throw new ChoreoConfigError('output.height', output.height, 'expected an integer in [1, 8192]')
  }
  if (!Number.isFinite(output.fps) || output.fps <= 0 || output.fps > 240) {
    throw new ChoreoConfigError('output.fps', output.fps, 'expected fps in (0, 240]')
  }

  let width = output.width
  let height = output.height
  const aspectSize = aspect === undefined ? undefined : ASPECT_SIZE[aspect]
  if (aspectSize !== undefined && (aspectSize.width !== width || aspectSize.height !== height)) {
    knobWarnings.push({
      code: 'aspect-overrides-output',
      message: `aspect ${aspect} sets ${aspectSize.width}x${aspectSize.height}; overriding output ${width}x${height}`
    })
    width = aspectSize.width
    height = aspectSize.height
  }

  const cast: unknown = config.cast
  if (cast !== undefined) {
    if (typeof cast !== 'object' || cast === null || Array.isArray(cast)) {
      throw new ChoreoConfigError('cast', cast, 'expected a CastHints object')
    }
    for (const [key, list] of Object.entries(cast)) {
      if (key !== 'preferRefs' && key !== 'preferTexts') {
        throw new ChoreoConfigError(`cast.${key}`, list, 'expected preferRefs or preferTexts')
      }
      if (!Array.isArray(list) || list.some((v) => typeof v !== 'string' || v.length === 0) || list.length > 32) {
        throw new ChoreoConfigError(`cast.${key}`, list, 'expected an array of up to 32 non-empty strings')
      }
    }
  }

  const hero: unknown = config.hero
  if (hero !== undefined && (typeof hero !== 'string' || hero.trim() === '' || hero.length > 64)) {
    throw new ChoreoConfigError('hero', hero, 'expected a footprint reference such as U1')
  }

  const mask: unknown = config.mask
  if (mask !== undefined && !MASK_COLORS.includes(mask as MaskColor)) {
    throw new ChoreoConfigError('mask', mask, `expected one of ${MASK_COLORS.join(', ')}`)
  }

  return {
    style,
    aspect,
    palette: resolvePalette(style, paletteIdRaw as PaletteId | undefined, config.accent),
    title,
    transparent,
    knobs: { texts: texts.value, tempo: tempo.value },
    seed: config.seed,
    cadence,
    durationSeconds: durationRaw,
    width,
    height,
    fps: output.fps,
    cast: cast,
    hero: hero?.trim(),
    mask: mask as MaskColor | undefined,
    knobWarnings
  }
}

/** the loop's content doesn't scale with board size — a fixed 11.2s glyph cycle, 12s for trace */
function autoDurationSeconds(style: StyleId): number {
  return style === 'glyph' ? 11.2 : 12
}

export function planDuration(resolved: Pick<ResolvedConfig, 'durationSeconds' | 'fps' | 'style' | 'knobs'>): DurationPlan {
  const warnings: DurationPlan['warnings'] = []
  let seconds: number
  if (resolved.durationSeconds === 'auto') {
    seconds = clamp(autoDurationSeconds(resolved.style) / resolved.knobs.tempo, MIN_FILM_SECONDS, MAX_FILM_SECONDS)
  } else {
    seconds = resolved.durationSeconds
    if (seconds < MIN_FILM_SECONDS) {
      warnings.push({
        code: 'duration-clamped',
        message: `requested duration ${seconds}s is below the ${MIN_FILM_SECONDS}s minimum film length; clamped to ${MIN_FILM_SECONDS}s`
      })
      seconds = MIN_FILM_SECONDS
    }
    if (seconds > MAX_FILM_SECONDS) {
      warnings.push({
        code: 'duration-clamped',
        message: `requested duration ${seconds}s exceeds the ${MAX_FILM_SECONDS}s cap; clamped to ${MAX_FILM_SECONDS}s`
      })
      seconds = MAX_FILM_SECONDS
    }
  }
  seconds = Math.round(seconds * resolved.fps) / resolved.fps
  return { durationSeconds: seconds, totalFrames: Math.round(seconds * resolved.fps), warnings }
}
