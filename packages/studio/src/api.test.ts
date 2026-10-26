import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boardModel } from '../../choreo/test/helpers.js'
import { cancelJob, pollJob, submitExport, summarize, toExportJob } from './api.js'

describe('studio board summary', () => {
  it('reports board layers and element counts', () => {
    const board = boardModel('ecc83-pp.kicad_pcb')
    const summary = summarize(board, 'ecc83-pp.kicad_pcb')

    expect(summary.fileName).toBe('ecc83-pp.kicad_pcb')
    expect(summary.layerCount).toBeGreaterThan(0)
    expect(summary.elementCount).toBeGreaterThan(0)
    expect(summary.layerNames).toEqual(expect.arrayContaining(['F.Cu', 'F.SilkS']))
    expect(summary.footprintCount).toBe(board.footprints.length)
    expect(summary.padCount).toBeGreaterThan(0)
    expect(summary.traceCount).toBeGreaterThan(0)
    expect(summary.silkMarkCount).toBeGreaterThan(0)
    expect(summary.netCount).toBe(board.nets.length)
  })
})

describe('studio export response mapping', () => {
  it('keeps the submitted id and the time left', () => {
    const job = toExportJob('job-1', { status: 'rendering', progress: 40, etaSeconds: 31 })

    expect(job).toMatchObject({ jobId: 'job-1', status: 'rendering', progress: 40, etaSeconds: 31 })
    expect(toExportJob('job-2', { status: 'pending', progress: 0 }).etaSeconds).toBeNull()
  })
})

describe('studio job polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stops after the configured number of attempts', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ status: 'pending', progress: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })))
    vi.stubGlobal('fetch', fetchMock)
    const polling = pollJob('job-1', { intervalMs: 10, maxAttempts: 2 })
    const assertion = expect(polling).rejects.toThrow('job polling timed out')

    await vi.advanceTimersByTimeAsync(30)

    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects with an abort error while waiting for the next attempt', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'rendering', progress: 10 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const polling = pollJob('job-1', { intervalMs: 1000, maxAttempts: 2, signal: controller.signal })
    const assertion = expect(polling).rejects.toMatchObject({ name: 'AbortError' })

    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()

    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats cancellation as a terminal job state', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'cancelled', progress: 24 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const polling = pollJob('job-1', { intervalMs: 10, maxAttempts: 2 })

    await vi.advanceTimersByTimeAsync(10)

    await expect(polling).resolves.toMatchObject({ jobId: 'job-1', status: 'cancelled', progress: 24 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('studio export submission', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the board, the full style-engine config and the format', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ jobId: 'job-9' }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const board = boardModel('ecc83-pp.kicad_pcb')
    const filmConfig = {
      style: 'trace' as const, aspect: '9:16' as const, palette: 'phosphor' as const, accent: '#ff00aa', title: { name: 'ECC83', version: 'v2' },
      knobs: { tempo: 1.2 }, seed: 7, duration: 'auto' as const, output: { width: 1080, height: 1920, fps: 30 }
    }
    await expect(submitExport({ boardJson: board, filmConfig, format: 'webm-alpha' })).resolves.toBe('job-9')
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/export')
    const body = JSON.parse(init?.body as string) as { filmConfig: unknown; format: string }
    expect(body.format).toBe('webm-alpha')
    expect(body.filmConfig).toEqual(filmConfig)
  })
})

describe('studio job cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts to the job cancellation endpoint and maps the terminal response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'cancelled', progress: 32 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(cancelJob('job/1')).resolves.toMatchObject({ jobId: 'job/1', status: 'cancelled', progress: 32 })
    expect(fetchMock).toHaveBeenCalledWith('/api/job/job%2F1/cancel', { method: 'POST' })
  })
})
