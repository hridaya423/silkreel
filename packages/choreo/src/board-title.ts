import type { BoardModel } from '@silk-reel/ingest'
import type { TitleCard } from './types'

/** a board's name and revision, and where each came from */
export interface BoardTitle {
  name: string
  nameFrom: 'user' | 'title-block' | 'file'
  revision: string | undefined
  revisionFrom: 'user' | 'silk' | 'title-block' | undefined
}

const WHOLE = /^v?\d+(\.\d+)+[a-z]?$/i
const TOKEN = /(?:^|[^a-z0-9])(?:rev\s?([a-z]?\d+(?:\.\d+)*[a-z]?)|(v\d+(?:\.\d+)+[a-z]?))(?![a-z0-9.])/i

/** the revision the board's silk prints: a text that is a version on its own, else a version after "v" or "rev" inside a longer text */
export function silkRevision(board: BoardModel): string | undefined {
  const texts = Object.values(board.silkscreen).flatMap((l) => l.texts.map((t) => t.value.trim()))
  const whole = texts.find((v) => WHOLE.test(v))
  if (whole !== undefined) return whole
  for (const v of texts) {
    const m = TOKEN.exec(v)
    if (m !== null) return m[1] ?? m[2]
  }
  return undefined
}

/**
 * The board's name and revision for every style: the name the user passes,
 * else the file name with its separators as spaces, cased as the file's title
 * block when that block names the same board; the revision the user passes,
 * else the one the board's silk prints, else the title block's.
 */
export function boardTitle(board: BoardModel, config: { title?: TitleCard | undefined }): BoardTitle {
  const file = board.source.boardName.replace(/\.kicad_pcb$/i, '')
  const own = board.titleBlock?.title
  const user = config.title
  const name = user?.name !== undefined
    ? { name: user.name, nameFrom: 'user' as const }
    : own !== undefined && own.toLowerCase() === file.toLowerCase()
      ? { name: own, nameFrom: 'title-block' as const }
      : { name: file.replace(/[-_]+/g, ' ').trim(), nameFrom: 'file' as const }
  if (user?.version !== undefined) return { ...name, revision: user.version, revisionFrom: 'user' }
  const silk = silkRevision(board)
  if (silk !== undefined) return { ...name, revision: silk, revisionFrom: 'silk' }
  const block = board.titleBlock?.rev
  return { ...name, revision: block, revisionFrom: block === undefined ? undefined : 'title-block' }
}

/** the revision as a person reads one: as written when it already says rev or v, else after "rev" ("C3" reads "rev C3", "2" reads "rev 2") */
export function revisionLabel(revision: string | undefined): string | undefined {
  if (revision === undefined || revision.length === 0) return undefined
  return /^(rev|v\d)/i.test(revision) ? revision : `rev ${revision}`
}
