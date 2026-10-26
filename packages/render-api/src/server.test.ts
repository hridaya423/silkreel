import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { buildApp } from './server.js'
import type { RenderJob, RenderQueuePort, RenderSubmission } from './queue.js'
import type { OutputFormat } from './render-film.js'

interface JobResponse {
  jobId: string
  status: string
}

interface DemosResponse {
  demos: string[]
}

interface JobStatusResponse {
  status: string
}

const testExports = path.resolve(import.meta.dirname, '../../../exports/render-api-tests')

function completedJob(id: string, downloadPath: string, format: OutputFormat = 'mp4'): RenderJob {
  const now = new Date().toISOString()
  return {
    id,
    format,
    status: 'done',
    progress: 100,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    downloadPath
  }
}

class StubQueue implements RenderQueuePort {
  readonly submissions: RenderSubmission[] = []
  private readonly jobs = new Map<string, RenderJob>()

  prepare(): Promise<void> {
    return Promise.resolve()
  }

  submit(input: RenderSubmission): RenderJob {
    this.submissions.push(input)
    const job: RenderJob = {
      id: `job-${this.submissions.length}`,
      format: input.format ?? 'mp4',
      status: 'pending',
      progress: 0,
      createdAt: new Date().toISOString()
    }
    this.jobs.set(job.id, job)
    return { ...job }
  }

  cancel(id: string): RenderJob | undefined {
    const job = this.jobs.get(id)
    if (job === undefined || job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      return job ? { ...job } : undefined
    }
    const cancelled: RenderJob = { ...job, status: 'cancelled', finishedAt: new Date().toISOString() }
    this.jobs.set(id, cancelled)
    return { ...cancelled }
  }

  get(id: string): RenderJob | undefined {
    const job = this.jobs.get(id)
    return job ? { ...job } : undefined
  }

  snapshot(): Map<string, RenderJob> {
    return new Map([...this.jobs.entries()].map(([id, job]) => [id, { ...job }]))
  }

  add(job: RenderJob): void {
    this.jobs.set(job.id, job)
  }
}

async function withApp(queue: RenderQueuePort, run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app: FastifyInstance = buildApp({ queue })
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

describe('render-api contract', () => {
  it('reports health and demo list', async () => {
    await withApp(new StubQueue(), async (app) => {
      const health = await app.inject({ method: 'GET', url: '/health' })
      expect(health.statusCode).toBe(200)
      expect(health.json()).toMatchObject({ ok: true, service: 'render-api' })
      const demos = await app.inject({ method: 'GET', url: '/demos' })
      const demosBody = demos.json<Partial<DemosResponse>>()
      expect(demosBody.demos).toContain('ecc83-pp')
    })
  })

  it('lets local pages call it cross-origin, and nobody else', async () => {
    await withApp(new StubQueue(), async (app) => {
      const pre = await app.inject({ method: 'OPTIONS', url: '/render', headers: { origin: 'http://127.0.0.1:4400', 'access-control-request-method': 'POST' } })
      expect(pre.statusCode).toBe(204)
      expect(pre.headers['access-control-allow-origin']).toBe('http://127.0.0.1:4400')
      const local = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:4321' } })
      expect(local.headers['access-control-allow-origin']).toBe('http://localhost:4321')
      const remote = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://example.com' } })
      expect(remote.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  it('rejects malformed render bodies before queue admission', async () => {
    const queue = new StubQueue()
    await withApp(queue, async (app) => {
      for (const payload of [
        null,
        [],
        { demoId: 42 },
        { demoId: '' },
        { boardJson: null },
        { boardJson: [] },
        { boardJson: {} },
        { demoId: 'ecc83-pp', filmConfig: [] },
        { demoId: 'ecc83-pp', filmConfig: { output: null } },
        { demoId: 'ecc83-pp', filmConfig: { mystery: true } },
        { demoId: 'ecc83-pp', filmConfig: { knobs: { palette: 'rainbow' } } },
        { demoId: 'ecc83-pp', filmConfig: { output: { width: -1 } } },
        { demoId: 'ecc83-pp', filmConfig: { cast: { hero: ['U1'] } } },
        { demoId: 'ecc83-pp', filmConfig: { cast: { preferRefs: 'U1' } } }
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/render',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify(payload)
        })
        expect(response.statusCode).toBe(400)
      }
      const neither = await app.inject({ method: 'POST', url: '/render', payload: {} })
      expect(neither.statusCode).toBe(400)
      const both = await app.inject({
        method: 'POST',
        url: '/render',
        payload: { demoId: 'ecc83-pp', boardJson: {} }
      })
      expect(both.statusCode).toBe(400)
      const unknown = await app.inject({ method: 'POST', url: '/render', payload: { demoId: 'nope' } })
      expect(unknown.statusCode).toBe(400)
      expect(queue.submissions).toHaveLength(0)
    })
  })

  it('normalizes partial output metadata at the request boundary', async () => {
    const queue = new StubQueue()
    await withApp(queue, async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/render',
        payload: { demoId: 'ecc83-pp', filmConfig: { output: { fps: 24 } } }
      })
      expect(response.statusCode).toBe(202)
      expect(queue.submissions[0]?.config?.output).toEqual({ width: 1080, height: 1350, fps: 24 })
    })
  })

  it('accepts style engine fields and rejects a bad aspect', async () => {
    const queue = new StubQueue()
    await withApp(queue, async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/render',
        payload: {
          demoId: 'glasgow',
          filmConfig: { knobs: {}, seed: 1, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 }, style: 'glyph', aspect: '1:1', palette: 'mono' }
        }
      })
      expect(response.statusCode).toBe(202)
      const bad = await app.inject({
        method: 'POST',
        url: '/render',
        payload: { demoId: 'glasgow', filmConfig: { aspect: '3:2' } }
      })
      expect(bad.statusCode).toBe(400)
    })
  })

  it('accepts the four output formats and rejects anything else', async () => {
    const queue = new StubQueue()
    await withApp(queue, async (app) => {
      const gif = await app.inject({ method: 'POST', url: '/render', payload: { demoId: 'glasgow', format: 'gif' } })
      expect(gif.statusCode).toBe(202)
      expect(queue.submissions.at(-1)?.format).toBe('gif')
      const avi = await app.inject({ method: 'POST', url: '/render', payload: { demoId: 'glasgow', format: 'avi' } })
      expect(avi.statusCode).toBe(400)
    })
  })

  it('serves non-mp4 downloads with the matching type and extension', async () => {
    await mkdir(testExports, { recursive: true })
    const downloadPath = path.join(testExports, 'gif-job.gif')
    await writeFile(downloadPath, 'tiny gif')
    const queue = new StubQueue()
    queue.add(completedJob('gif-job', downloadPath, 'gif'))
    try {
      await withApp(queue, async (app) => {
        const response = await app.inject({ method: 'GET', url: '/download/gif-job' })
        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toBe('image/gif')
        expect(response.headers['content-disposition']).toContain('silk-reel-gif-job.gif')
      })
    } finally {
      await rm(testExports, { recursive: true, force: true })
    }
  })

  it('accepts a valid submission and exposes job lifecycle endpoints', async () => {
    const queue = new StubQueue()
    await withApp(queue, async (app) => {
      const submitted = await app.inject({
        method: 'POST',
        url: '/render',
        payload: { demoId: 'ecc83-pp', filmConfig: { knobs: { tempo: 1.2 } } }
      })
      expect(submitted.statusCode).toBe(202)
      const submittedBody: JobResponse = submitted.json()
      expect(submittedBody.status).toBe('pending')
      expect(queue.submissions).toHaveLength(1)
      const jobId = submittedBody.jobId
      const polled = await app.inject({ method: 'GET', url: `/job/${jobId}` })
      expect(polled.statusCode).toBe(200)
      expect(polled.json<JobStatusResponse>().status).toBe('pending')
      const missing = await app.inject({ method: 'GET', url: '/job/does-not-exist' })
      expect(missing.statusCode).toBe(404)
    })
  })

  it('cancels queued jobs and rejects cancellation after completion', async () => {
    const queue = new StubQueue()
    await withApp(queue, async (app) => {
      const submitted = await app.inject({ method: 'POST', url: '/render', payload: { demoId: 'ecc83-pp' } })
      const jobId = submitted.json<JobResponse>().jobId
      const cancelled = await app.inject({ method: 'POST', url: `/job/${jobId}/cancel` })
      expect(cancelled.statusCode).toBe(200)
      expect(cancelled.json<JobStatusResponse>().status).toBe('cancelled')
      const repeated = await app.inject({ method: 'POST', url: `/job/${jobId}/cancel` })
      expect(repeated.statusCode).toBe(200)
      expect(repeated.json<JobStatusResponse>().status).toBe('cancelled')
      const missing = await app.inject({ method: 'POST', url: '/job/does-not-exist/cancel' })
      expect(missing.statusCode).toBe(404)

      queue.add(completedJob('done-job', path.join(testExports, 'done-job.mp4')))
      const completed = await app.inject({ method: 'POST', url: '/job/done-job/cancel' })
      expect(completed.statusCode).toBe(409)
      expect(completed.json<{ job: RenderJob }>().job.status).toBe('done')
    })
  })

  it('download refuses jobs that are not done', async () => {
    const queue = new StubQueue()
    await withApp(queue, async (app) => {
      const submitted = await app.inject({
        method: 'POST',
        url: '/render',
        payload: { demoId: 'ecc83-pp' }
      })
      const jobId = submitted.json<JobResponse>().jobId
      const early = await app.inject({ method: 'GET', url: `/download/${jobId}` })
      expect([409, 410]).toContain(early.statusCode)
      const unknown = await app.inject({ method: 'GET', url: '/download/does-not-exist' })
      expect(unknown.statusCode).toBe(404)
    })
  })

  it('downloads completed renders when the advisory is unavailable', async () => {
    await mkdir(testExports, { recursive: true })
    const downloadPath = path.join(testExports, 'done-job.mp4')
    await writeFile(downloadPath, 'tiny video')
    const queue = new StubQueue()
    queue.add(completedJob('done-job', downloadPath))
    try {
      await withApp(queue, async (app) => {
        const response = await app.inject({ method: 'GET', url: '/download/done-job' })
        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toBe('video/mp4')
        expect(response.body).toBe('tiny video')
      })
    } finally {
      await rm(testExports, { recursive: true, force: true })
    }
  })

  it('refuses completed-job paths outside exports and symlinks that escape it', async () => {
    await mkdir(testExports, { recursive: true })
    const escapedLink = path.join(testExports, 'escaped.mp4')
    await symlink('/etc/passwd', escapedLink)
    const queue = new StubQueue()
    queue.add(completedJob('outside', '/etc/passwd'))
    queue.add(completedJob('symlink', escapedLink))
    try {
      await withApp(queue, async (app) => {
        const outside = await app.inject({ method: 'GET', url: '/download/outside' })
        const symlinked = await app.inject({ method: 'GET', url: '/download/symlink' })
        expect(outside.statusCode).toBe(410)
        expect(symlinked.statusCode).toBe(410)
      })
    } finally {
      await rm(testExports, { recursive: true, force: true })
    }
  })
})
