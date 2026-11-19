import path from 'node:path'
import { renderFilm as renderWithBundler } from '../../../render-api/src/render-film.js'
import type { RenderFilmOptions, RenderFilmResult } from '../../../render-api/src/render-film.js'
import { withBundledFfmpeg } from './ffmpeg.js'
import { prebuiltRender } from './prebuilt.js'

export * from '../../../render-api/src/index.js'

const render = prebuiltRender(renderWithBundler, path.resolve(import.meta.dirname, '../bundle'), (message) => process.stderr.write(`${message}\n`))

export const renderFilm = (options: RenderFilmOptions): Promise<RenderFilmResult> => withBundledFfmpeg(() => render(options))
