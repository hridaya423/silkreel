import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderFilmOptions } from '../../../render-api/src/render-film.js'
import { prebuiltRender } from './prebuilt.js'

const missingFfmpeg = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT', path: 'ffmpeg' })

describe('prebuiltRender', () => {
  let dir: string
  let options: RenderFilmOptions
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'prebuilt-test-'))
    options = { inputProps: {} as RenderFilmOptions['inputProps'], outputLocation: path.join(dir, 'film.mp4') }
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('renders from the prebuilt bundle and never hands it back to be removed', async () => {
    const render = vi.fn().mockResolvedValue({ bundleLocation: '/ignored', outputLocation: options.outputLocation, posterLocation: 'p.png' })
    const result = await prebuiltRender(render, '/pkg/bundle', vi.fn())(options)
    expect(render).toHaveBeenCalledWith({ ...options, bundleLocationOverride: '/pkg/bundle' })
    expect(result.bundleLocation).not.toBe('/pkg/bundle')
    expect(result.posterLocation).toBe('p.png')
  })

  it('keeps the silent film and says so when ffmpeg cannot run', async () => {
    await writeFile(options.outputLocation, 'film')
    const warn = vi.fn()
    const result = await prebuiltRender(vi.fn().mockRejectedValue(missingFfmpeg), '/pkg/bundle', warn)(options)
    expect(result.outputLocation).toBe(options.outputLocation)
    expect(result.posterLocation).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without sound'))
  })

  it('does not hide an ffmpeg failure when no film was written', async () => {
    await expect(prebuiltRender(vi.fn().mockRejectedValue(missingFfmpeg), '/pkg/bundle', vi.fn())(options)).rejects.toBe(missingFfmpeg)
  })

  it('does not hide any other failure', async () => {
    await writeFile(options.outputLocation, 'film')
    const boom = new Error('Chrome crashed')
    await expect(prebuiltRender(vi.fn().mockRejectedValue(boom), '/pkg/bundle', vi.fn())(options)).rejects.toBe(boom)
  })
})
