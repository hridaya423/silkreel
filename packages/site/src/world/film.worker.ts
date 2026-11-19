import { parseKicadPcb } from '@silk-reel/ingest'
import { ASPECT_SIZE, compileTimeline, heroPart } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, GlyphTimeline, TraceTimeline } from '@silk-reel/choreo'
import { netsOf } from '../cut/nets'

self.onmessage = (e: MessageEvent<{ text: string; name: string; stage: Aspect }>) => {
  try {
    const board = parseKicadPcb(e.data.text, e.data.name)
    const films = {} as Record<Aspect, GlyphTimeline>
    for (const aspect of Object.keys(ASPECT_SIZE) as Aspect[]) {
      films[aspect] = compileTimeline(board, {
        style: 'glyph', aspect, knobs: { tempo: 1, texts: 1 }, duration: 'auto', seed: 42,
        output: { ...ASPECT_SIZE[aspect], fps: 30 }
      } as never) as GlyphTimeline
    }
    const f = films['16:9']
    const trace: FilmConfig = { style: 'trace', aspect: e.data.stage, knobs: {}, seed: 42, duration: 'auto', output: { ...ASPECT_SIZE[e.data.stage], fps: 30 } }
    const hero = heroPart(board)
    const still = compileTimeline(board, trace) as TraceTimeline
    self.postMessage({
      ok: true,
      films,
      still,
      nets: netsOf(board, still),
      stats: { name: board.source.boardName || e.data.name, traces: board.stats.traces, pads: board.stats.pads, vias: board.stats.vias, layers: Object.keys(board.copper).length, glyphs: f.placements.length, footprints: board.footprints.length, hero: hero === undefined ? '' : `${hero.ref} ${hero.value}`.trim() }
    })
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
