import { bundle } from '@remotion/bundler'
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer'
import type { OpenGlRenderer } from '@remotion/renderer'
import type { FilmInputProps } from '@silk-reel/render'
import type { TraceTimeline } from '@silk-reel/choreo'
import { execFile } from 'node:child_process'
import { rename, rm, writeFile } from 'node:fs/promises'
import { encodeWav, traceScore } from './score-audio.js'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type OutputFormat = 'mp4' | 'gif' | 'webm-alpha' | 'prores-alpha'
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['mp4', 'gif', 'webm-alpha', 'prores-alpha']
export const FORMAT_EXT: Record<OutputFormat, string> = { mp4: 'mp4', gif: 'gif', 'webm-alpha': 'webm', 'prores-alpha': 'mov' }
export const FORMAT_MIME: Record<OutputFormat, string> = {
  mp4: 'video/mp4',
  gif: 'image/gif',
  'webm-alpha': 'video/webm',
  'prores-alpha': 'video/quicktime'
}
export const isAlphaFormat = (format: OutputFormat): boolean => format === 'webm-alpha' || format === 'prores-alpha'

function codecOptions(format: OutputFormat) {
  switch (format) {
    // a 12 s film with its score stays under a 10 MB chat upload limit
    case 'mp4': return { codec: 'h264' as const, videoBitrate: '5.5M', pixelFormat: 'yuv420p' as const, imageFormat: 'png' as const }
    case 'gif': return { codec: 'gif' as const, everyNthFrame: 2, imageFormat: 'png' as const }
    case 'webm-alpha': return { codec: 'vp9' as const, pixelFormat: 'yuva420p' as const, imageFormat: 'png' as const }
    case 'prores-alpha': return { codec: 'prores' as const, proResProfile: '4444' as const, pixelFormat: 'yuva444p10le' as const, imageFormat: 'png' as const }
  }
}

export const RENDER_ENTRY = new URL('../../render/src/remotion-entry.tsx', import.meta.url).pathname

export interface RenderFilmOptions {
  entryPoint?: string
  bundleLocationOverride?: string
  inputProps: FilmInputProps
  outputLocation: string
  format?: OutputFormat
  /** output scale factor; GIFs default to a 720px-wide cap */
  scale?: number
  /** the synthesised score under a trace film (default on; GIFs never carry audio) */
  audio?: boolean
  onProgress?: (progress: RenderProgress) => void
  /** the first render downloads a headless Chrome; this reports it once */
  onBrowserDownload?: (megabytes: number) => void
  /** also write a trace film's last frame, the held poster, as <name>.poster.png for a cover image */
  poster?: boolean
}

export interface RenderProgress {
  pct: number
  /** null until enough frames are done to estimate */
  etaSeconds: number | null
}

export interface RenderFilmResult {
  bundleLocation: string
  outputLocation: string
  posterLocation?: string
}

export async function renderFilm(options: RenderFilmOptions): Promise<RenderFilmResult> {
  const entryPoint = options.entryPoint ?? RENDER_ENTRY
  const bundleLocation = options.bundleLocationOverride ?? (await bundle({ entryPoint, onProgress: () => undefined }))
  const format = options.format ?? 'mp4'
  if (isAlphaFormat(format) && !options.inputProps.timeline.transparent) {
    throw new Error(`${format} needs a transparent timeline (compile with transparent: true)`)
  }
  let lastPct = -1
  let firstAt: { t: number; p: number } | undefined
  let announced = false
  const onBrowserDownload = () => ({
    version: null,
    onProgress: ({ alreadyAvailable, totalSizeInBytes }: { alreadyAvailable: boolean; totalSizeInBytes: number }) => {
      if (alreadyAvailable || announced) return
      announced = true
      options.onBrowserDownload?.(Math.round(totalSizeInBytes / 1e6))
    }
  })
  const inputProps = (format === 'gif' ? { ...options.inputProps, grain: false } : options.inputProps) as unknown as Record<string, unknown>
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'film',
    inputProps,
    onBrowserDownload
  })
  const chromiumOptions = { gl: (process.env.SILK_REEL_GL ?? 'angle') as OpenGlRenderer }
  const render = () => renderMedia({
    composition,
    serveUrl: bundleLocation,
    inputProps,
    ...codecOptions(format),
    outputLocation: options.outputLocation,
    scale: options.scale ?? (format === 'gif' ? Math.min(1, 720 / options.inputProps.timeline.width) : 1),
    concurrency: Number(process.env.SILK_REEL_CONCURRENCY) || Math.max(1, Math.floor(os.cpus().length / 2)),
    // angle uses the real GPU for the WebGL2 post pass; SILK_REEL_GL=swangle for GPU-less CI/servers
    chromiumOptions,
    onBrowserDownload,
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100)
      if (pct === lastPct) return
      lastPct = pct
      const now = Date.now()
      if (firstAt === undefined && progress > 0) firstAt = { t: now, p: progress }
      const done = firstAt === undefined ? 0 : progress - firstAt.p
      const etaSeconds = firstAt !== undefined && done > 0.05 ? Math.round(((now - firstAt.t) / done) * (1 - progress) / 1000) : null
      options.onProgress?.({ pct, etaSeconds })
    }
  })
  for (let attempt = 1; ; attempt++) {
    try {
      await render()
      break
    } catch (err) {
      // Remotion 4.0.539 does not retry a tab whose first page load returns no response; it happens on about one render in eight at concurrency > 1
      if (attempt === 3 || !(err instanceof Error) || !err.message.includes('but got no response')) throw err
    }
  }
  if (format === 'mp4') await normalizeMp4(options.outputLocation)
  const timeline = options.inputProps.timeline
  if (format !== 'gif' && timeline.style === 'trace' && options.audio !== false) await muxScore(options.outputLocation, format, timeline)
  if (options.poster !== true || timeline.style !== 'trace') return { bundleLocation, outputLocation: options.outputLocation }
  const posterLocation = options.outputLocation.replace(/\.[^./\\]*$/, '') + '.poster.png'
  await renderStill({ composition, serveUrl: bundleLocation, inputProps, frame: timeline.totalFrames - 1, output: posterLocation, imageFormat: 'png', chromiumOptions })
  return { bundleLocation, outputLocation: options.outputLocation, posterLocation }
}

const AUDIO_CODEC: Record<Exclude<OutputFormat, 'gif'>, string[]> = {
  mp4: ['-c:a', 'aac', '-b:a', '192k'],
  'webm-alpha': ['-c:a', 'libopus', '-b:a', '160k'],
  'prores-alpha': ['-c:a', 'pcm_s16le']
}

/** lay the film's synthesised score under the picture, replacing any silent track */
async function muxScore(outputLocation: string, format: Exclude<OutputFormat, 'gif'>, timeline: TraceTimeline): Promise<void> {
  const wav = `${outputLocation}.score.wav`
  const ext = outputLocation.slice(outputLocation.lastIndexOf('.'))
  const muxed = `${outputLocation}.muxed${ext}`
  try {
    const { left, right, sampleRate } = traceScore(timeline)
    await writeFile(wav, encodeWav(left, right, sampleRate))
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', outputLocation, '-i', wav,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...AUDIO_CODEC[format], '-shortest',
      ...(format === 'mp4' ? ['-movflags', '+faststart'] : []),
      muxed
    ])
    await rename(muxed, outputLocation)
  } finally {
    await rm(wav, { force: true })
    await rm(muxed, { force: true })
  }
}

async function normalizeMp4(outputLocation: string): Promise<void> {
  const normalized = `${outputLocation}.normalized.mp4`
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      outputLocation,
      '-map',
      '0:v:0',
      '-an',
      '-c',
      'copy',
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      '-movflags',
      '+faststart',
      normalized
    ])
    await rename(normalized, outputLocation)
  } finally {
    await rm(normalized, { force: true })
  }
}
