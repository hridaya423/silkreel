import path from 'node:path'
import { access, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { RenderFilmOptions, RenderFilmResult } from './render-film.js'
import { RenderQueue } from './queue.js'
import type { RenderJob } from './queue.js'

const outputPaths = new Set<string>()

afterEach(async () => {
  await Promise.all([...outputPaths].map((outputPath) => rm(outputPath, { force: true })))
  outputPaths.clear()
})

function doneJob(queue: RenderQueue, id: string): Extract<RenderJob, { status: 'done' }> {
  const job = queue.get(id)
  expect(job?.status).toBe('done')
  if (job === undefined || job.status !== 'done') throw new Error(`job ${id} did not finish successfully`)
  return job
}

describe('render queue execution', () => {
  it('runs FIFO with no overlap, reuses the bundle, and keeps every download', async () => {
    const events: string[] = []
    const bundleLocations: string[] = []
    let active = 0
    let maxActive = 0
    let bundleCalls = 0
    const render = async (options: RenderFilmOptions): Promise<RenderFilmResult> => {
      const jobId = path.basename(options.outputLocation, '.mp4')
      expect(active).toBe(0)
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push(`start:${jobId}`)
      outputPaths.add(options.outputLocation)
      bundleLocations.push(options.bundleLocationOverride ?? '')
      try {
        options.onProgress?.({ pct: 40, etaSeconds: 3 })
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
        await writeFile(options.outputLocation, 'test video')
      } finally {
        active -= 1
        events.push(`finish:${jobId}`)
      }
      return { bundleLocation: options.bundleLocationOverride ?? '', outputLocation: options.outputLocation }
    }
    const queue = new RenderQueue({
      renderFilm: render,
      bundle: () => {
        bundleCalls += 1
        return Promise.resolve('test-bundle')
      }
    })

    await queue.prepare()

    const first = queue.submit({ demoId: 'ecc83-pp' })
    const second = queue.submit({ demoId: 'ecc83-pp' })
    const third = queue.submit({ demoId: 'ecc83-pp' })
    const ids = [first.id, second.id, third.id]
    await queue.waitForIdle()

    expect(events).toEqual([
      `start:${first.id}`,
      `finish:${first.id}`,
      `start:${second.id}`,
      `finish:${second.id}`,
      `start:${third.id}`,
      `finish:${third.id}`
    ])
    expect(maxActive).toBe(1)
    expect(bundleCalls).toBe(1)
    expect(bundleLocations).toEqual(['test-bundle', 'test-bundle', 'test-bundle'])

    const completed = ids.map((id) => doneJob(queue, id))
    expect(completed.map((job) => job.downloadPath)).toEqual([...outputPaths])
    expect(completed.every((job) => job.progress === 100)).toBe(true)
  })

  it('compiles alpha jobs transparent and names the file by format', async () => {
    const seen: RenderFilmOptions[] = []
    const render = async (options: RenderFilmOptions): Promise<RenderFilmResult> => {
      seen.push(options)
      outputPaths.add(options.outputLocation)
      await writeFile(options.outputLocation, 'test video')
      return { bundleLocation: 'test-bundle', outputLocation: options.outputLocation }
    }
    const queue = new RenderQueue({
      renderFilm: render,
      bundle: () => Promise.resolve('test-bundle')
    })
    const webm = queue.submit({ demoId: 'ecc83-pp', format: 'webm-alpha' })
    const mov = queue.submit({ demoId: 'ecc83-pp', format: 'prores-alpha' })
    const gif = queue.submit({ demoId: 'ecc83-pp', format: 'gif' })
    await queue.waitForIdle()
    const [w, m, g] = seen
    expect(w?.inputProps.timeline.transparent).toBe(true)
    expect(w?.outputLocation.endsWith(`${webm.id}.webm`)).toBe(true)
    expect(m?.inputProps.timeline.transparent).toBe(true)
    expect(m?.outputLocation.endsWith(`${mov.id}.mov`)).toBe(true)
    expect(g?.inputProps.timeline.transparent).toBe(false)
    expect(g?.outputLocation.endsWith(`${gif.id}.gif`)).toBe(true)
    expect(doneJob(queue, gif.id).format).toBe('gif')
  })

  it('serializes rendering across queue instances', async () => {
    const events: string[] = []
    let active = 0
    const render = async (options: RenderFilmOptions): Promise<RenderFilmResult> => {
      const jobId = path.basename(options.outputLocation, '.mp4')
      expect(active).toBe(0)
      active += 1
      events.push(`start:${jobId}`)
      outputPaths.add(options.outputLocation)
      await new Promise<void>((resolve) => setTimeout(resolve, 2))
      await writeFile(options.outputLocation, 'test video')
      active -= 1
      events.push(`finish:${jobId}`)
      return { bundleLocation: 'test-bundle', outputLocation: options.outputLocation }
    }
    const options = {
      renderFilm: render,
      bundle: () => Promise.resolve('test-bundle')
    }
    const firstQueue = new RenderQueue(options)
    const secondQueue = new RenderQueue(options)
    const first = firstQueue.submit({ demoId: 'ecc83-pp' })
    const second = secondQueue.submit({ demoId: 'ecc83-pp' })

    await Promise.all([firstQueue.waitForIdle(), secondQueue.waitForIdle()])

    expect(events).toEqual([`start:${first.id}`, `finish:${first.id}`, `start:${second.id}`, `finish:${second.id}`])
  })

  it('keeps reported progress finite, bounded, and monotonic', async () => {
    const observed: number[] = []
    const render = async (options: RenderFilmOptions): Promise<RenderFilmResult> => {
      const id = path.basename(options.outputLocation, '.mp4')
      outputPaths.add(options.outputLocation)
      for (const progress of [50, 20, Number.NaN, 140]) {
        options.onProgress?.({ pct: progress, etaSeconds: null })
        observed.push(queue.get(id)?.progress ?? -1)
      }
      await writeFile(options.outputLocation, 'test video')
      return { bundleLocation: 'test-bundle', outputLocation: options.outputLocation }
    }
    const queue = new RenderQueue({
      renderFilm: render,
      bundle: () => Promise.resolve('test-bundle')
    })
    queue.submit({ demoId: 'ecc83-pp' })
    await queue.waitForIdle()

    expect(observed).toEqual([50, 50, 50, 100])
  })

  it('cancels queued jobs before they start', async () => {
    const started: string[] = []
    let releaseFirst: (() => void) | undefined
    let resolveFirstStarted: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve
    })
    const render = async (options: RenderFilmOptions): Promise<RenderFilmResult> => {
      const id = path.basename(options.outputLocation, '.mp4')
      started.push(id)
      outputPaths.add(options.outputLocation)
      resolveFirstStarted?.()
      if (started.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      await writeFile(options.outputLocation, 'test video')
      return { bundleLocation: 'test-bundle', outputLocation: options.outputLocation }
    }
    const queue = new RenderQueue({
      renderFilm: render,
      bundle: () => Promise.resolve('test-bundle')
    })
    const first = queue.submit({ demoId: 'ecc83-pp' })
    const second = queue.submit({ demoId: 'ecc83-pp' })

    await firstStarted
    const cancelled = queue.cancel(second.id)
    expect(cancelled?.status).toBe('cancelled')
    expect(started).toEqual([first.id])

    releaseFirst?.()
    await queue.waitForIdle()

    expect(started).toEqual([first.id])
    expect(queue.get(second.id)?.status).toBe('cancelled')
  })

  it('cancels an active render and discards its artifact', async () => {
    let releaseRender: (() => void) | undefined
    let renderStarted: (() => void) | undefined
    let outputLocation: string | undefined
    const started = new Promise<void>((resolve) => {
      renderStarted = resolve
    })
    const render = async (options: RenderFilmOptions): Promise<RenderFilmResult> => {
      outputLocation = options.outputLocation
      outputPaths.add(options.outputLocation)
      renderStarted?.()
      await new Promise<void>((resolve) => {
        releaseRender = resolve
      })
      await writeFile(options.outputLocation, 'test video')
      return { bundleLocation: 'test-bundle', outputLocation: options.outputLocation }
    }
    const queue = new RenderQueue({
      renderFilm: render,
      bundle: () => Promise.resolve('test-bundle')
    })
    const submitted = queue.submit({ demoId: 'ecc83-pp' })

    await started
    const cancelled = queue.cancel(submitted.id)
    expect(cancelled?.status).toBe('cancelled')
    releaseRender?.()
    await queue.waitForIdle()

    expect(queue.get(submitted.id)?.status).toBe('cancelled')
    expect(outputLocation).toBeDefined()
    await expect(access(outputLocation as string)).rejects.toThrow()
  })
})
