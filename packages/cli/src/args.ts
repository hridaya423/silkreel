import path from 'node:path'
import { parseArgs } from 'node:util'
import { ASPECT_SIZE, MASK_COLORS, PALETTES } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, MaskColor, PaletteId, StyleId } from '@silk-reel/choreo'
import { FORMAT_EXT, OUTPUT_FORMATS, defaultFilmConfig, isAlphaFormat } from '@silk-reel/render-api'
import type { OutputFormat } from '@silk-reel/render-api'

export const HELP = `usage: npm run reel -- <board.kicad_pcb> [options]

Renders a film of a KiCad board (KiCad 4 or later).

  --style trace|glyph|plot   trace: the lit board (default); glyph: parts set as type;
                             plot: the board drawn in pen on paper
  --aspect 4:5|1:1|9:16|16:9 frame (default 4:5)
  --palette copper|mono|blueprint|phosphor|paper
  --accent #rrggbb           hero highlight colour
  --hero REF                 the part the film is about, e.g. U3 (default: the biggest IC)
  --mask ${MASK_COLORS.join('|')}
                             solder mask colour (default: the board file's, else green)
  --title "Name"             title card; --version v1.0 adds a line under it
  --format mp4|gif|webm-alpha|prores-alpha
  --seed N                   each number gives a different variation (default 42)
  --tempo 0.75-1.5           pace (default 1)
  --draft                    fast preview quality
  --no-audio                 leave the score out of a trace film
  --models DIR               another folder of STEP models (repeatable); trace films show each
                             part's own 3D model from the board's paths, the KiCad library and these
  --no-models                estimated part bodies only
  -o PATH                    output file (default: <board>-<style>-<aspect>.<ext> beside the input)
  -h, --help                 this help`

const OPTIONS = {
  out: { type: 'string', short: 'o' },
  style: { type: 'string' },
  aspect: { type: 'string' },
  palette: { type: 'string' },
  accent: { type: 'string' },
  hero: { type: 'string' },
  mask: { type: 'string' },
  title: { type: 'string' },
  version: { type: 'string' },
  seed: { type: 'string' },
  tempo: { type: 'string' },
  format: { type: 'string' },
  draft: { type: 'boolean' },
  'no-audio': { type: 'boolean' },
  models: { type: 'string', multiple: true },
  'no-models': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
} as const

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j] as number
      row[j] = Math.min(cur + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length] as number
}

/** node's parse error, reworded with the nearest real flag */
function unknownOption(err: unknown): Error {
  const flag = err instanceof Error ? /'(-[^']+)'/.exec(err.message)?.[1] : undefined
  if (flag === undefined) return err instanceof Error ? err : new Error(String(err))
  const name = flag.replace(/^-+/, '')
  const near = Object.keys(OPTIONS).map((o) => ({ o, d: distance(name, o) })).sort((a, b) => a.d - b.d)[0]
  const hint = near !== undefined && near.d <= 2 ? ` Did you mean --${near.o}?` : ''
  return new Error(`Unknown option ${flag}.${hint} Run with --help to see every option.`)
}

export interface CliArgs {
  input: string
  out: string
  config: FilmConfig
  format: OutputFormat
  /** one motion-blur sample and lighter maps: a fast look, not a release */
  draft: boolean
  audio: boolean
  /** folders searched for part models; undefined: no models */
  models: string[] | undefined
  help: boolean
}

function oneOf<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value as T)) throw new Error(`--${flag} must be one of ${allowed.join(', ')} (got ${value})`)
  return value as T
}

function num(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`--${flag} must be a number (got ${value})`)
  return n
}

export function parseCliArgs(argv: string[]): CliArgs {
  let parsed: ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  } catch (err) {
    throw unknownOption(err)
  }
  const { values, positionals } = parsed
  const input = positionals[0]
  if (values.help === true) return { input: input ?? '', out: '', config: defaultFilmConfig(), format: 'mp4', draft: false, audio: true, models: undefined, help: true }
  if (input === undefined || positionals.length > 1) throw new Error(HELP)

  const style = oneOf<StyleId>('style', values.style, ['trace', 'glyph', 'plot']) ?? 'trace'
  const aspect = oneOf<Aspect>('aspect', values.aspect, Object.keys(ASPECT_SIZE) as Aspect[]) ?? '4:5'
  const palette = oneOf<PaletteId>('palette', values.palette, Object.keys(PALETTES) as PaletteId[])
  const format = oneOf<OutputFormat>('format', values.format, OUTPUT_FORMATS) ?? 'mp4'
  const mask = oneOf<MaskColor>('mask', values.mask, MASK_COLORS)
  if (values.accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(values.accent)) {
    throw new Error(`--accent must be a #rrggbb hex color (got ${values.accent})`)
  }
  if (values.version !== undefined && values.title === undefined) throw new Error('--version needs --title')

  // same base as the studio/render-api: fixture boards pick up their curated cast hints
  const base = defaultFilmConfig(path.basename(input, '.kicad_pcb'))
  const seed = num('seed', values.seed)
  const tempo = num('tempo', values.tempo)
  const config: FilmConfig = {
    ...base,
    style,
    aspect,
    output: { ...base.output, ...ASPECT_SIZE[aspect] },
    knobs: tempo !== undefined ? { tempo } : {},
    ...(seed !== undefined ? { seed } : {}),
    ...(palette !== undefined ? { palette } : {}),
    ...(values.accent !== undefined ? { accent: values.accent } : {}),
    ...(values.hero !== undefined ? { hero: values.hero } : {}),
    ...(mask !== undefined ? { mask } : {}),
    ...(values.title !== undefined
      ? { title: { name: values.title, ...(values.version !== undefined ? { version: values.version } : {}) } }
      : {}),
    ...(isAlphaFormat(format) ? { transparent: true } : {})
  }
  const out =
    values.out ??
    path.join(path.dirname(input), `${path.basename(input, '.kicad_pcb')}-${style}-${aspect.replace(':', 'x')}.${FORMAT_EXT[format]}`)
  return { input, out, config, format, draft: values.draft === true, audio: values['no-audio'] !== true, models: values['no-models'] === true ? undefined : values.models ?? [], help: false }
}
