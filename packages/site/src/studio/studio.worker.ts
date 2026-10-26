import { parseKicadPcb } from '@silk-reel/ingest'
import type { BoardModel } from '@silk-reel/ingest'
import { compileTimeline, DEMO_CAST_HINTS, heroChoices, heroPart } from '@silk-reel/choreo'
import type { FilmConfig } from '@silk-reel/choreo'

export type ToWorker =
  | { type: 'load'; id: string; text: string; name: string }
  | { type: 'compile'; req: number; id: string; config: FilmConfig }
  | { type: 'board'; req: number; id: string }

export interface BoardStats {
  name: string
  /** parts worth offering as the hero, best first */
  heroes: Array<{ ref: string; value: string }>
  /** the part the film picks when the visitor picks none */
  autoHero: string | undefined
  /** the mask colour the board file declares */
  mask: string | undefined
}

export type FromWorker =
  | { type: 'loaded'; id: string; stats: BoardStats }
  | { type: 'timeline'; req: number; timeline: ReturnType<typeof compileTimeline>; ms: number }
  | { type: 'board'; req: number; board: BoardModel }
  | { type: 'error'; id: string; req?: number; error: string }

const boards = new Map<string, BoardModel>()
const post = (m: FromWorker) => { self.postMessage(m) }

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  try {
    if (m.type === 'load') {
      const board = parseKicadPcb(m.text, m.name)
      if (!board.footprints.length && !board.stats.traces) throw new Error('it holds no parts or traces')
      boards.set(m.id, board)
      post({
        type: 'loaded',
        id: m.id,
        stats: {
          name: board.source.boardName || m.name,
          heroes: heroChoices(board).map((f) => ({ ref: f.ref, value: f.value ?? '' })),
          autoHero: heroPart(board, undefined, DEMO_CAST_HINTS[m.id])?.ref,
          mask: board.stackup.maskColor
        }
      })
      return
    }
    const board = boards.get(m.id)
    if (!board) throw new Error(`board ${m.id} is not loaded`)
    if (m.type === 'compile') {
      const t0 = performance.now()
      const timeline = compileTimeline(board, m.config)
      post({ type: 'timeline', req: m.req, timeline, ms: performance.now() - t0 })
    } else post({ type: 'board', req: m.req, board })
  } catch (err) {
    post({ type: 'error', id: m.id, ...('req' in m ? { req: m.req } : {}), error: err instanceof Error ? err.message : String(err) })
  }
}
