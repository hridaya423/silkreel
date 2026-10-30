import type { BoardModel } from '@silk-reel/ingest'
import { planDuration, resolveConfig } from './config'
import { composeFilm } from './composer'
import { safeArea } from './layout'
import { organicSeed } from './rng'
import { buildTraceScene } from './trace/scene'
import type { FilmConfig, PartBodies, Timeline } from './types'

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
    transparent: resolved.transparent,
    seedUsed: seed
  }
  const heroWarnings = resolved.hero !== undefined && !board.footprints.some((f) => f.ref === resolved.hero)
    ? [{ code: 'hero-not-found', message: `no part ${resolved.hero} on this board; the hero is picked automatically` }]
    : []
  if (resolved.style !== 'glyph') {
    const t = buildTraceScene(board, resolved, seed, bodies)
    return { ...base, style: resolved.style, scene: t.scene, warnings: [...duration.warnings, ...resolved.knobWarnings, ...heroWarnings, ...t.warnings] }
  }
  const film = composeFilm(board, resolved, seed, duration.durationSeconds)
  const safe = safeArea(resolved.width, resolved.height, resolved.title !== undefined)
  return {
    ...base,
    style: 'glyph',
    ...film,
    stageAspect: safe.w / safe.h,
    warnings: [...duration.warnings, ...resolved.knobWarnings, ...heroWarnings, ...film.warnings]
  }
}
