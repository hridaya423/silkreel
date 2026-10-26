import type { Connect, Plugin } from 'vite'
import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DEMO_IDS, demoOutline, isDemoId, loadDemoBoard, parseKicadText } from './board-server.js'

const DEFAULT_RENDER_API_URL = 'http://127.0.0.1:3102'
const DEFAULT_STUDIO_PORT = 3101

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024 * 1024) throw new Error('payload too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface ParseBody {
  kind?: string
  fileName?: string
  contents?: string
}

async function proxyToRenderApi(req: Connect.IncomingMessage, res: ServerResponse, targetPath: string, renderApiUrl: string): Promise<void> {
  const controller = new AbortController()
  const disconnect = (): void => {
    controller.abort()
  }
  res.once('close', disconnect)
  try {
    const method = req.method ?? 'GET'
    const requestBody = ['POST', 'PUT'].includes(method) ? await readBody(req) : undefined
    const body = requestBody === '' ? undefined : requestBody
    const upstream = await fetch(`${renderApiUrl.replace(/\/$/, '')}${targetPath}`, {
      method,
      signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body })
    })
    res.statusCode = upstream.status
    const contentType = upstream.headers.get('content-type') ?? 'application/json'
    res.setHeader('content-type', contentType)
    if (upstream.headers.get('content-disposition')) {
      res.setHeader('content-disposition', upstream.headers.get('content-disposition') ?? '')
    }
    if (upstream.body === null) res.end()
    else await pipeline(Readable.from(upstream.body), res)
  } catch (err) {
    if (res.destroyed) return
    if (res.headersSent) {
      res.destroy()
      return
    }
    json(res, 502, { error: `render-api unreachable: ${err instanceof Error ? err.message : String(err)}` })
  } finally {
    res.off('close', disconnect)
  }
}

function requestUrl(req: Connect.IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://studio')
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/outlines' || pathname === '/api/demos' || pathname.startsWith('/api/demo/') || pathname === '/api/parse' || pathname === '/api/export' || pathname.startsWith('/api/job/') || pathname.startsWith('/api/download/')
}

const PROXY_MAP: Array<{ match: RegExp; target: (pathname: string) => string }> = [
  { match: /^\/api\/health$/, target: () => '/health' },
  { match: /^\/api\/export$/, target: () => '/render' },
  { match: /^\/api\/job\//, target: (pathname) => pathname.replace('/api/job/', '/job/') },
  { match: /^\/api\/download\//, target: (pathname) => pathname.replace('/api/download/', '/download/') }
]

function proxyTarget(pathname: string, search: string): string | undefined {
  for (const rule of PROXY_MAP) {
    if (rule.match.test(pathname)) return `${rule.target(pathname)}${search}`
  }
  return undefined
}

async function handle(req: Connect.IncomingMessage, res: ServerResponse, renderApiUrl: string): Promise<void> {
  const url = requestUrl(req)
  const pathname = url.pathname
  if (pathname === '/api/demos' && req.method === 'GET') {
    json(res, 200, { demos: DEMO_IDS })
    return
  }
  if (pathname === '/api/outlines' && req.method === 'GET') {
    json(res, 200, Object.fromEntries(await Promise.all(DEMO_IDS.map(async (id) => [id, await demoOutline(id)] as const))))
    return
  }
  if (pathname.startsWith('/api/demo/') && req.method === 'GET') {
    const demoId = decodeURIComponent(pathname.slice('/api/demo/'.length))
    if (!isDemoId(demoId)) {
      json(res, 404, { error: `unknown demo board ${demoId}` })
      return
    }
    const board = await loadDemoBoard(demoId)
    json(res, 200, board)
    return
  }
  if (pathname === '/api/parse' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as ParseBody
    if (body.kind !== 'kicad' || typeof body.contents !== 'string' || typeof body.fileName !== 'string') {
      json(res, 400, { error: 'expected { kind: "kicad", fileName, contents }' })
      return
    }
    const board = parseKicadText(body.fileName, body.contents)
    json(res, 200, board)
    return
  }
  const target = proxyTarget(pathname, url.search)
  if (target !== undefined) {
    await proxyToRenderApi(req, res, target, renderApiUrl)
    return
  }
  json(res, 405, { error: `method ${req.method ?? 'UNKNOWN'} not allowed for ${pathname}` })
}

function createMiddleware(renderApiUrl: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const pathname = requestUrl(req).pathname
    const isApi = isApiPath(pathname)
    if (!isApi) {
      next()
      return
    }
    void handle(req, res, renderApiUrl).catch((err: unknown) => {
      if (!res.writableEnded) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      }
    })
  }
}

function renderApiUrl(): string {
  return process.env.RENDER_API_URL || DEFAULT_RENDER_API_URL
}

export function studioPort(): number {
  const rawPort = process.env.STUDIO_PORT ?? process.env.PORT
  if (rawPort === undefined || rawPort.trim() === '') return DEFAULT_STUDIO_PORT
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('STUDIO_PORT must be an integer between 1 and 65535')
  }
  return port
}

const middleware = createMiddleware(renderApiUrl())

export const studioApiPlugin: Plugin = {
  name: 'silk-reel-studio-api',
  configureServer(server) {
    server.middlewares.use(middleware)
  },
  configurePreviewServer(server) {
    server.middlewares.use(middleware)
  }
}
