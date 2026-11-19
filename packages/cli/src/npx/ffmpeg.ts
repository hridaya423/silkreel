import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RenderInternals } from '@remotion/renderer'

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Runs `run` with the ffmpeg that ships inside Remotion's compositor first on PATH, so a machine without ffmpeg can still mux the score. */
export async function withBundledFfmpeg<T>(run: () => Promise<T>, binary?: string): Promise<T> {
  const ffmpeg = binary ?? bundledFfmpeg()
  if (ffmpeg === undefined) return await run()
  const previous = process.env.PATH
  const scratch = process.platform === 'win32' ? undefined : await mkdtemp(path.join(os.tmpdir(), 'silk-reel-ffmpeg-'))
  try {
    if (scratch !== undefined) {
      const dir = path.dirname(ffmpeg)
      const wrapper = path.join(scratch, 'ffmpeg')
      await writeFile(wrapper, `#!/bin/sh\nDYLD_LIBRARY_PATH=${quote(dir)} LD_LIBRARY_PATH=${quote(dir)} exec ${quote(ffmpeg)} "$@"\n`)
      await chmod(wrapper, 0o755)
    }
    process.env.PATH = [scratch ?? path.dirname(ffmpeg), previous].filter((p) => p !== undefined).join(path.delimiter)
    return await run()
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  }
}

function bundledFfmpeg(): string | undefined {
  try {
    return RenderInternals.getExecutablePath({ type: 'ffmpeg', indent: false, logLevel: 'error', binariesDirectory: null })
  } catch {
    return undefined
  }
}
