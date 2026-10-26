import { useCallback, useEffect, useRef, useState } from 'react'
import type { FilmConfig } from '@silk-reel/choreo'
import type { BoardModel } from '@silk-reel/ingest'
import type { ExportFormat } from './film-config'

export interface BoardSummary {
  board: BoardModel
  fileName: string
  layerCount: number
  layerNames: string[]
  elementCount: number
  footprintCount: number
  padCount: number
  traceCount: number
  viaCount: number
  zoneCount: number
  silkMarkCount: number
  drillCount: number
  netCount: number
}

const API = ''

export function useBoardSources() {
  const [loadingDemo, setLoadingDemo] = useState<string | null>(null)
  const [parsingFile, setParsingFile] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const loadDemo = useCallback(async (demoId: string): Promise<BoardModel | undefined> => {
    setLoadingDemo(demoId)
    setError(null)
    try {
      const res = await fetch(`${API}/api/demo/${encodeURIComponent(demoId)}`)
      if (!res.ok) throw new Error(`demo board ${demoId} failed to load (${res.status})`)
      return (await res.json()) as BoardModel
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return undefined
    } finally {
      setLoadingDemo(null)
    }
  }, [])

  const parseFile = useCallback(async (file: File): Promise<BoardModel | undefined> => {
    setParsingFile(true)
    setError(null)
    try {
      if (/\.(kicad_pcb|kicad_mod)$/i.test(file.name)) {
        const text = await file.text()
        const res = await fetch(`${API}/api/parse`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'kicad', fileName: file.name, contents: text })
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `parse failed (${res.status})`)
        }
        return (await res.json()) as BoardModel
      }
      if (/\.(gtl|gbl|gml|gko|gts|gbs|gto|gbo|gtp|gbp|drl|drd|xln|cmp|sol|gpi)$/i.test(file.name)) {
        throw new Error('Gerber import is not supported yet; drop a .kicad_pcb')
      }
      throw new Error('unsupported file; drop a .kicad_pcb')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return undefined
    } finally {
      setParsingFile(false)
    }
  }, [])

  return { loadingDemo, parsingFile, error, loadDemo, parseFile, clearError }
}

export function summarize(board: BoardModel, fileName: string): BoardSummary {
  const copperLayers = Object.keys(board.copper)
  const silkLayers = Object.keys(board.silkscreen)
  let padCount = 0
  let traceCount = 0
  let viaCount = 0
  let zoneCount = 0
  let silkMarkCount = 0
  let elements = board.outline.length + board.drill.length
  for (const c of Object.values(board.copper)) {
    padCount += c.pads.length
    traceCount += c.traces.length
    viaCount += c.vias.length
    zoneCount += c.zones.length
    elements += c.traces.length + c.pads.length + c.vias.length + c.zones.length
  }
  for (const s of Object.values(board.silkscreen)) {
    silkMarkCount += s.lines.length + s.texts.length
    elements += s.lines.length + s.texts.length
  }
  return {
    board,
    fileName,
    layerCount: copperLayers.length + silkLayers.length,
    layerNames: [...copperLayers, ...silkLayers],
    elementCount: elements,
    footprintCount: board.footprints.length,
    padCount,
    traceCount,
    viaCount,
    zoneCount,
    silkMarkCount,
    drillCount: board.drill.length,
    netCount: board.nets.length
  }
}

export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): (...args: A) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => () => {
    clearTimeout(timer.current)
  }, [])
  return useCallback(
    (...args: A) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        fnRef.current(...args)
      }, delayMs)
    },
    [delayMs]
  )
}

interface JobResponse {
  jobId: string
}

interface RenderJobResponse {
  status: JobPhase
  progress: number
  error?: string
  etaSeconds?: number | null
}

type JobPhase = 'pending' | 'rendering' | 'done' | 'error' | 'cancelled'

export interface ExportJob {
  jobId: string
  status: JobPhase
  progress: number
  etaSeconds: number | null
  error: string | null
}

export function toExportJob(jobId: string, response: RenderJobResponse): ExportJob {
  return {
    jobId,
    status: response.status,
    progress: response.progress,
    etaSeconds: response.etaSeconds ?? null,
    error: response.error ?? null
  }
}

export interface ExportPayload {
  boardJson: BoardModel
  filmConfig: FilmConfig
  format: ExportFormat
}

export async function submitExport(payload: ExportPayload, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${API}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal === undefined ? {} : { signal })
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `export rejected (${res.status})`)
  }
  const body = (await res.json()) as JobResponse
  return body.jobId
}

export async function cancelJob(jobId: string): Promise<ExportJob> {
  const res = await fetch(`${API}/api/job/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `job cancellation failed (${res.status})`)
  }
  return toExportJob(jobId, (await res.json()) as RenderJobResponse)
}

export interface PollJobOptions {
  signal?: AbortSignal
  intervalMs?: number
  maxAttempts?: number
  onUpdate?: (job: ExportJob) => void
}

const DEFAULT_POLL_INTERVAL_MS = 1200
// thirty minutes: a slow trace render on a CPU-only machine can take several
const DEFAULT_MAX_POLL_ATTEMPTS = 1500

function createAbortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}

function waitForPoll(intervalMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, intervalMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function pollJob(jobId: string, options: PollJobOptions = {}): Promise<ExportJob> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await waitForPoll(intervalMs, options.signal)
    const res = await fetch(`${API}/api/job/${jobId}`, options.signal === undefined ? {} : { signal: options.signal })
    if (!res.ok) throw new Error(`job poll failed (${res.status})`)
    const response = (await res.json()) as RenderJobResponse
    const job = toExportJob(jobId, response)
    options.onUpdate?.(job)
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job
  }
  throw new Error('job polling timed out')
}

export type DemoOutlines = Record<string, { w: number; h: number; d: string; holes: Array<[number, number, number]> }>

export function useDemoOutlines(): DemoOutlines | null {
  const [outlines, setOutlines] = useState<DemoOutlines | null>(null)
  useEffect(() => {
    void fetch(`${API}/api/outlines`).then(async (r) => {
      if (r.ok) setOutlines((await r.json()) as DemoOutlines)
    }, () => undefined)
  }, [])
  return outlines
}

/** whether the render API answers; rechecked every few seconds while it does not */
export function useRenderApi(): boolean | null {
  const [up, setUp] = useState<boolean | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let live = true
    const check = (): void => {
      void fetch(`${API}/api/health`).then((r) => r.ok, () => false).then((ok) => {
        if (!live) return
        setUp(ok)
        timer = setTimeout(check, ok ? 15000 : 3000)
      })
    }
    check()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [])
  return up
}

export function downloadUrl(jobId: string): string {
  return `${API}/api/download/${jobId}`
}
