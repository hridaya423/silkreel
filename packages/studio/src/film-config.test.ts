import { describe, expect, it } from 'vitest'
import { compileTimeline } from '@silk-reel/choreo'
import { boardModel } from '../../choreo/test/helpers'
import { compileStudioFilm, DEFAULT_KNOBS, studioFilmConfig } from './film-config'
import type { StudioState } from './film-config'

const state = (patch: Partial<StudioState> = {}): StudioState => ({
  style: 'trace',
  aspect: '4:5',
  palette: undefined,
  accent: undefined,
  title: { name: '', version: '' },
  hero: undefined,
  mask: undefined,
  knobs: DEFAULT_KNOBS,
  seed: 42,
  duration: 'auto',
  ...patch
})

describe('preview and export identity', () => {
  it('exports the same seed the preview used', () => {
    const board = boardModel('ecc83-pp.kicad_pcb')
    const config = studioFilmConfig(state({ style: 'glyph', seed: 9 }))
    const preview = compileStudioFilm(board, config)

    expect(preview.config.seed).toBe(9)
    expect(preview.timeline.seedUsed).toBe(9)
    expect(JSON.stringify(compileTimeline(board, preview.config))).toBe(JSON.stringify(preview.timeline))
  })

  it('passes the hero to both styles and the mask only to trace', () => {
    expect(studioFilmConfig(state({ hero: 'U2', mask: 'black' }))).toMatchObject({ hero: 'U2', mask: 'black' })
    const glyph = studioFilmConfig(state({ style: 'glyph', hero: 'U2', mask: 'black' }))
    expect(glyph.hero).toBe('U2')
    expect(glyph.mask).toBeUndefined()
  })

  it('compiles a 9:16 trace state to a 1080x1920 trace timeline', () => {
    const tl = compileStudioFilm(boardModel('ecc83-pp.kicad_pcb'), studioFilmConfig(state({ aspect: '9:16' }))).timeline
    expect(tl.style).toBe('trace')
    expect([tl.width, tl.height]).toEqual([1080, 1920])
    expect(tl.warnings.map((w) => w.code)).not.toContain('aspect-overrides-output')
  })

  it('maps palette, accent and title; an empty name means no card', () => {
    const c = studioFilmConfig(state({ palette: 'blueprint', accent: '#ff00aa', title: { name: ' Glasgow ', version: 'revC3' } }))
    expect(c).toMatchObject({ palette: 'blueprint', accent: '#ff00aa', title: { name: 'Glasgow', version: 'revC3' } })
    expect(studioFilmConfig(state({ title: { name: '  ', version: 'v1' } })).title).toBeUndefined()
  })

  it('fixture boards get the curated cast hints the CLI uses', () => {
    const film = compileStudioFilm(boardModel('glasgow.kicad_pcb'), studioFilmConfig(state()))
    expect(film.config.cast?.preferRefs).toContain('U1')
  })
})
