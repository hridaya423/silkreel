import type { BoardModel } from '@silk-reel/ingest'
import { planDuration, resolveConfig } from './config'
import { composeFilm } from './composer'
import { safeArea } from './layout'
import { organicSeed } from './rng'
import { buildTraceScene, MASK_ALBEDO } from './trace/scene'
import { boardFacts, isComponent } from './trace/facts'
import { groupNets } from './trace/nets'
import { heroPart } from './acts'
import { DEMO_MASKS } from './hints'
import { boardTitle } from './board-title'
import { buildMontage } from './montage/score'
import type { FilmConfig, PartBodies, Timeline } from './types'

function withPasteOpenings(board: BoardModel): BoardModel {
  const openings = board.footprints.flatMap((f) => f.pasteOpenings ?? [])
  if (openings.length === 0) return board
  const order = (id: string): number => Number(id.slice(2))
  const copper = { ...board.copper }
  for (const { pad, layers } of openings) {
    for (const layer of layers) {
      const c = copper[layer] ?? { traces: [], pads: [], vias: [], zones: [] }
      copper[layer] = { ...c, pads: [...c.pads, pad].sort((a, b) => order(a.id) - order(b.id)) }
    }
  }
  const footprints = board.footprints.map((f) => f.pasteOpenings === undefined
    ? f
    : { ...f, padRefs: [...f.padRefs, ...f.pasteOpenings.map((o) => o.pad.id)].sort((a, b) => order(a) - order(b)) })
  return { ...board, copper, footprints }
}

export function compileTimeline(board: BoardModel, config: FilmConfig, bodies?: PartBodies): Timeline {
  const resolved = resolveConfig(config)
  const seed = resolved.seed ?? organicSeed()
  const duration = planDuration(resolved)
  const base = {
    fps: resolved.fps,
    totalFrames: duration.totalFrames,
    durationSeconds: duration.durationSeconds,
    width: resolved.width,
    height: resolved.height,
    output: { width: resolved.width, height: resolved.height, fps: resolved.fps },
    palette: resolved.palette,
    title: resolved.title,
    credit: resolved.credit,
    transparent: resolved.transparent,
    seedUsed: seed
  }
  const heroWarnings = resolved.hero !== undefined && !board.footprints.some((f) => f.ref === resolved.hero)
    ? [{ code: 'hero-not-found', message: `no part ${resolved.hero} on this board; the hero is picked automatically` }]
    : []
  if (resolved.style !== 'glyph') {
    const t = resolved.style === 'montage' ? buildMontage(board, resolved, seed, bodies) : buildTraceScene(board, resolved.style === 'trace' && resolved.title === undefined ? { ...resolved, title: { name: boardTitle(board, resolved).name } } : resolved, seed, bodies)
    return { ...base, style: resolved.style, scene: t.scene, warnings: [...duration.warnings, ...resolved.knobWarnings, ...heroWarnings, ...t.warnings] }
  }
  const glyphBoard = withPasteOpenings(board)
  const film = composeFilm(glyphBoard, resolved, seed, duration.durationSeconds)
  const facts = boardFacts(glyphBoard)
  const hero = heroPart(glyphBoard, resolved.hero ?? resolved.cast?.hero, resolved.cast)
  const mask = resolved.mask ?? board.stackup.maskColor?.toLowerCase() ?? DEMO_MASKS[board.source.boardName] ?? 'green'
  const safe = safeArea(resolved.width, resolved.height, resolved.title !== undefined)
  return {
    ...base,
    style: 'glyph',
    ...film,
    board: {
      widthMm: facts.widthMm,
      heightMm: facts.heightMm,
      layers: facts.copperLayers,
      parts: glyphBoard.footprints.filter((f) => isComponent(f) && f.layer === hero?.layer).length,
      nets: groupNets(glyphBoard.nets).groups.length,
      mask: mask.startsWith('#') ? mask : MASK_ALBEDO[mask] ?? '#0d3b22'
    },
    stageAspect: safe.w / safe.h,
    warnings: [...duration.warnings, ...resolved.knobWarnings, ...heroWarnings, ...film.warnings]
  }
}
