import type { Aspect, GlyphTimeline, TraceTimeline } from '@silk-reel/choreo'
import { filmFrom } from './world'
import type { Film } from './world'
import type { NetData } from '../cut/nets'

const ASPECTS: Aspect[] = ['4:5', '1:1', '9:16', '16:9']
const slug = (a: Aspect) => a.replace(':', 'x')

const cache = new Map<string, Promise<Film>>()

/** a fixture board's film, precompiled by scripts/timelines.mts (about 4 KB gzipped) */
export function fixtureFilm(board: string, aspect: Aspect): Promise<Film> {
  const key = `${board}@${aspect}`
  let p = cache.get(key)
  if (!p) {
    p = fetch(`/films/glyph/${board}-${slug(aspect)}.json`)
      .then((r) => { if (!r.ok) throw new Error(`no film for ${key}`); return r.json() as Promise<GlyphTimeline> })
      .then((tl) => filmFrom(key, tl))
    cache.set(key, p)
  }
  return p
}

export interface OwnBoard { id: string; name: string; traces: number; pads: number; vias: number; layers: number; glyphs: number; footprints: number; hero: string; still: TraceTimeline; nets: NetData }

/** parse and film a visitor's board in a worker; it never leaves the machine */
export function filmOwnBoard(file: File, stage: Aspect): Promise<OwnBoard> {
  return file.text().then((text) => new Promise<OwnBoard>((resolve, reject) => {
    const worker = new Worker(new URL('./film.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ ok: true; stats: Omit<OwnBoard, 'id' | 'still' | 'nets'>; films: Record<Aspect, GlyphTimeline>; still: TraceTimeline; nets: NetData } | { ok: false; error: string }>) => {
      worker.terminate()
      if (!e.data.ok) { reject(new Error(e.data.error)); return }
      const id = `own-${String(Date.now())}`
      for (const a of ASPECTS) cache.set(`${id}@${a}`, Promise.resolve(filmFrom(`${id}@${a}`, e.data.films[a])))
      resolve({ id, ...e.data.stats, still: e.data.still, nets: e.data.nets })
    }
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)) }
    worker.postMessage({ text, name: file.name.replace(/\.kicad_pcb$/i, ''), stage })
  }))
}

/** the film for a board id, fixture or own */
export function filmOf(board: string, aspect: Aspect): Promise<Film> {
  const own = cache.get(`${board}@${aspect}`)
  return own ?? fixtureFilm(board, aspect)
}

