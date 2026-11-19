import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withBundledFfmpeg } from './ffmpeg.js'

describe.skipIf(process.platform === 'win32')('withBundledFfmpeg', () => {
  it('puts a runnable ffmpeg wrapper first on PATH, then restores PATH and removes it', async () => {
    const before = process.env.PATH
    let wrapper = ''
    await withBundledFfmpeg(async () => {
      wrapper = path.join((process.env.PATH ?? '').split(path.delimiter)[0] ?? '', 'ffmpeg')
      expect((await stat(wrapper)).mode & 0o111).not.toBe(0)
      const text = await readFile(wrapper, 'utf8')
      expect(text).toContain("exec '/opt/ff mpeg/bin/ffmpeg'")
      expect(text).toContain("DYLD_LIBRARY_PATH='/opt/ff mpeg/bin'")
    }, '/opt/ff mpeg/bin/ffmpeg')
    expect(process.env.PATH).toBe(before)
    await expect(stat(wrapper)).rejects.toThrow()
  })

  it('restores PATH when the render throws', async () => {
    const before = process.env.PATH
    await expect(withBundledFfmpeg(() => Promise.reject(new Error('boom')), '/x/ffmpeg')).rejects.toThrow('boom')
    expect(process.env.PATH).toBe(before)
  })
})
