import { ASPECT_SIZE, compileTimeline } from '@silk-reel/choreo'
import type { Aspect, FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import { boardsRoot, defaultFilmConfig, DEMO_TITLES, loadDemoBoard } from '../boards.js'
import { loadPartBodies } from '../models.js'

export type SetStyle = 'trace' | 'plot' | 'montage'

export interface SetFilm { style: SetStyle; board: string; aspect: Aspect; name: string }

const SHORT: Record<string, string> = { 'kit-dev-coldfire-xilinx_5213': 'devkit', StickHub: 'stickhub', glasgow: 'glasgow', icebreaker: 'icebreaker' }

const film = (style: SetStyle, board: string, aspect: Aspect): SetFilm => ({ style, board, aspect, name: `${SHORT[board] ?? board}-${aspect.replace(':', 'x')}` })

/** the 21 films the owner approved on 2026-11-12, as review/approved-1112 names them */
export const SET_FILMS: SetFilm[] = [
  film('trace', 'kit-dev-coldfire-xilinx_5213', '16:9'),
  film('trace', 'glasgow', '16:9'),
  film('trace', 'glasgow', '4:5'),
  film('trace', 'glasgow', '9:16'),
  film('trace', 'icebreaker', '4:5'),
  film('trace', 'icebreaker', '9:16'),
  film('trace', 'StickHub', '16:9'),
  film('plot', 'kit-dev-coldfire-xilinx_5213', '4:5'),
  film('plot', 'glasgow', '16:9'),
  film('plot', 'glasgow', '4:5'),
  film('plot', 'glasgow', '9:16'),
  film('plot', 'icebreaker', '4:5'),
  film('plot', 'icebreaker', '9:16'),
  film('plot', 'StickHub', '9:16'),
  film('montage', 'kit-dev-coldfire-xilinx_5213', '16:9'),
  film('montage', 'kit-dev-coldfire-xilinx_5213', '1:1'),
  film('montage', 'glasgow', '16:9'),
  film('montage', 'glasgow', '4:5'),
  film('montage', 'glasgow', '9:16'),
  film('montage', 'icebreaker', '4:5'),
  film('montage', 'icebreaker', '9:16')
]

/** the film's timeline as the render path builds it: the demo board, its title, and part models for trace and montage */
export async function setTimeline(f: SetFilm): Promise<TraceTimeline> {
  const base = defaultFilmConfig(f.board)
  const title = DEMO_TITLES[f.board]
  const config = { ...base, style: f.style, aspect: f.aspect, output: { ...base.output, ...ASPECT_SIZE[f.aspect] }, ...(title === undefined ? {} : { title: { name: title } }) } as FilmConfig
  const model = await loadDemoBoard(f.board)
  const bodies = f.style === 'plot' ? undefined : (await loadPartBodies(model, { boardDir: boardsRoot })).bodies
  return compileTimeline(model, config, bodies) as TraceTimeline
}
