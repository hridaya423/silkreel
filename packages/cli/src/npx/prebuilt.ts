import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RenderFilmOptions, RenderFilmResult } from '../../../render-api/src/render-film.js'

type RenderFilm = (options: RenderFilmOptions) => Promise<RenderFilmResult>

const NOTHING_TO_REMOVE = path.join(os.tmpdir(), 'silk-reel-prebuilt-bundle-is-not-removable')

function ffmpegFailed(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const { code, path: binary } = err as Error & { code?: unknown; path?: unknown }
  return (code === 'ENOENT' && binary === 'ffmpeg') || err.message.startsWith('Command failed: ffmpeg')
}

/**
 * Renders from a bundle made at pack time. The caller removes the returned bundle location,
 * so the prebuilt one is never handed back. When ffmpeg cannot run, the silent film is kept and a warning says so.
 */
export function prebuiltRender(render: RenderFilm, bundleLocation: string, warn: (message: string) => void): RenderFilm {
  return async (options) => {
    try {
      const result = await render({ ...options, bundleLocationOverride: bundleLocation })
      return { ...result, bundleLocation: NOTHING_TO_REMOVE }
    } catch (err) {
      if (!ffmpegFailed(err) || (await stat(options.outputLocation).catch(() => undefined))?.isFile() !== true) throw err
      warn(`warning: ffmpeg could not run, so ${path.basename(options.outputLocation)} was written without sound and without a poster. Install ffmpeg (https://ffmpeg.org) and render again for the score.`)
      return { bundleLocation: NOTHING_TO_REMOVE, outputLocation: options.outputLocation }
    }
  }
}
